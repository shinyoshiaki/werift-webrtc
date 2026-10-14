import {
  MUTATIONS,
  movePayloadType,
  withoutCodecs,
} from "../negotiation/harness/negotiationTransactionUtils";

/**
 * SDP rewrites the model property applies on the wire to a delivered offer,
 * pranswer or answer (operations `wireOffer` / `wireReply`). They model what
 * another peer sends and what an intermediary changes; the oracles judge the
 * result like any other operation.
 *
 * - `same`: the rewrite describes the same session as the original (fewer
 *   codecs or feedback, another order, an fmtp parameter, a larger
 *   max-message-size, no end-of-candidates): the peers still agree, so the
 *   traffic property and the commit oracle keep holding.
 * - otherwise the rewrite misdescribes the sending peer (inactive or rejected
 *   m-lines, other SSRCs, a new payload type or header extension ID): the
 *   peers disagree until a clean negotiation, which must heal the session.
 * - `renegotiation`: only applied to a peer that has a current session (on
 *   a first negotiation the rewrite would be accepted and could not heal).
 * - `remapOnly`: only applied when it remaps a key of the current session
 *   (`remapsCurrentKeys`), so the peer must reject it; elsewhere it would be
 *   a new mapping a clean description could not take back.
 */
export type WireMutation = {
  apply: (sdp: string) => string;
  same?: boolean;
  renegotiation?: boolean;
  remapOnly?: boolean;
};

const sections = (sdp: string) => sdp.split(/(?=^m=)/m);

/** Rewrite the first m-section that `match` accepts. */
const first =
  (match: (section: string) => boolean, rewrite: (section: string) => string) =>
  (sdp: string) => {
    const all = sections(sdp);
    const index = all.findIndex((s, i) => i > 0 && match(s));
    if (index < 0) return sdp;
    all[index] = rewrite(all[index]);
    return all.join("");
  };

const isVideo = (section: string) => /^m=video [1-9]/.test(section);
const payloadType = (section: string, name: string) =>
  section.match(new RegExp(`^a=rtpmap:(\\d+) ${name}/`, "mi"))?.[1];

/** The first two sending m-sections of one kind trade their SSRC lines. */
function swapSsrcs(sdp: string) {
  const all = sections(sdp);
  for (const kind of ["audio", "video"]) {
    const indexes = all
      .map((section, index) => ({ section, index }))
      .filter(
        ({ section, index }) =>
          index > 0 &&
          section.startsWith(`m=${kind} `) &&
          /^a=ssrc:/m.test(section),
      )
      .map(({ index }) => index);
    if (indexes.length < 2) continue;
    const [x, y] = indexes;
    const ssrcLines = (section: string) =>
      section.split("\r\n").filter((line) => /^a=ssrc(-group)?:/.test(line));
    const replace = (section: string, lines: string[]) => {
      const kept = section
        .split("\r\n")
        .filter((line) => !/^a=ssrc(-group)?:/.test(line));
      const end = kept.at(-1) === "" ? kept.length - 1 : kept.length;
      return [...kept.slice(0, end), ...lines, ...kept.slice(end)].join("\r\n");
    };
    const [sx, sy] = [ssrcLines(all[x]), ssrcLines(all[y])];
    all[x] = replace(all[x], sy);
    all[y] = replace(all[y], sx);
    return all.join("");
  }
  return sdp;
}

/** The media SSRC of the first m-section with SSRCs is renewed; its RTX SSRC (if any) is kept. */
const renewMediaSsrc = first(
  (section) => /^a=ssrc:/m.test(section),
  (section) => {
    const media =
      section.match(/^a=ssrc-group:FID (\d+) \d+/m)?.[1] ??
      section.match(/^a=ssrc:(\d+) /m)![1];
    const renewed = String((Number(media) + 7919) % 2 ** 32);
    return section.replace(new RegExp(`\\b${media}\\b`, "g"), renewed);
  },
);

export const WIRE_MUTATIONS: Record<string, WireMutation> = {
  maxMessageSize: { apply: MUTATIONS.maxMessageSize.apply, same: true },
  noNack: { apply: MUTATIONS.noNack.apply, same: true },
  noPli: { apply: MUTATIONS.noPli.apply, same: true },
  noTwcc: {
    apply: (sdp) => sdp.replace(/^a=rtcp-fb:\d+ transport-cc\r\n/gm, ""),
    same: true,
  },
  fmtpChanged: { apply: MUTATIONS.fmtpChanged.apply, same: true },
  codecSubset: { apply: MUTATIONS.codecSubset.apply, same: true },
  codecReordered: { apply: MUTATIONS.codecReordered.apply, same: true },
  noEndOfCandidates: { apply: MUTATIONS.noEndOfCandidates.apply, same: true },
  audioInactive: { apply: MUTATIONS.audioInactive.apply },
  videoInactive: { apply: MUTATIONS.videoInactive.apply },
  audioRejected: { apply: MUTATIONS.audioRejected.apply },
  videoRejected: { apply: MUTATIONS.videoRejected.apply },
  /** The video RTX codec is gone (its payload type, `apt` and FID stay unused). */
  noRtx: { apply: (sdp) => withoutCodecs(sdp, "video", ["rtx"]) },
  ssrcSwapped: { apply: swapSsrcs },
  mediaSsrcRenewed: { apply: renewMediaSsrc },
  /** H264 moves to a new payload type (an added key; its old one is gone). */
  codecRenumbered: {
    apply: first(isVideo, (section) => {
      const pt = payloadType(section, "H264");
      return pt ? movePayloadType(section, Number(pt), 120) : section;
    }),
  },
  /** A URI of the first video m-line moves to an unused header extension ID. */
  extmapMoved: {
    apply: first(isVideo, (section) =>
      section.replace(/^a=extmap:\d+ /m, "a=extmap:14 "),
    ),
    renegotiation: true,
  },
  /** VP8 and H264 trade payload types. */
  payloadTypeSwapped: {
    apply: first(isVideo, (section) => {
      const vp8 = payloadType(section, "VP8");
      const h264 = payloadType(section, "H264");
      if (!vp8 || !h264) return section;
      return movePayloadType(
        movePayloadType(movePayloadType(section, +vp8, 1), +h264, +vp8),
        1,
        +h264,
      );
    }),
    remapOnly: true,
  },
  extmapSwapped: { apply: MUTATIONS.extmapSwapped.apply, remapOnly: true },
};

export const WIRE_MUTATION_NAMES = Object.keys(WIRE_MUTATIONS);

/**
 * Whether `sdp` remaps a key the current session negotiated, which a peer
 * must refuse before any change (`InvalidModificationError`). The current
 * session negotiated what both current descriptions carry for an m-line both
 * keep (non-zero port): a payload type mapped to another codec on that m-line
 * (RFC 3264 section 8.3.2; an inactive m-line may be reused, JSEP 5.2.2), or
 * a header extension ID mapped to another URI (RFC 8285 section 7).
 */
export function remapsCurrentKeys(
  sdp: string,
  current: { remote: string; local?: string },
) {
  const pairs = (text: string, pattern: RegExp) =>
    [...text.matchAll(pattern)].map((m) => [m[1], m[2].toLowerCase()]);
  const codecs = (section: string) =>
    pairs(section, /^a=rtpmap:(\d+) ([^/\s]+)/gm);
  const extensions = (section: string) =>
    pairs(section, /^a=extmap:(\d+)(?:\/\w+)? (\S+)/gm);
  const inUse = (section?: string) => !!section && !/^m=\S+ 0 /.test(section);
  const remote = sections(current.remote).slice(1);
  const local = sections(current.local ?? "").slice(1);
  const codecByPt = new Map<number, Map<string, string>>();
  const uriById = new Map<string, string>();
  for (const [index, r] of remote.entries()) {
    const l = local[index];
    if (!inUse(r) || !inUse(l)) continue;
    const both = (list: string[][], other: string[][]) =>
      list.filter(([k, v]) => other.some(([k2, v2]) => k2 === k && v2 === v));
    for (const [id, uri] of both(extensions(r), extensions(l))) {
      uriById.set(id, uri);
    }
    if (/^a=inactive\r?$/m.test(r)) continue;
    const ptKeys = codecs(l).map(([pt]) => pt);
    codecByPt.set(
      index,
      new Map(
        codecs(r).filter(([pt]) => ptKeys.includes(pt)) as [string, string][],
      ),
    );
  }
  for (const [index, section] of sections(sdp).slice(1).entries()) {
    if (!inUse(section)) continue;
    const negotiated = codecByPt.get(index);
    for (const [pt, name] of codecs(section)) {
      if (negotiated?.has(pt) && negotiated.get(pt) !== name) return true;
    }
    for (const [id, uri] of extensions(section)) {
      if (uriById.has(id) && uriById.get(id) !== uri) return true;
    }
  }
  return false;
}
