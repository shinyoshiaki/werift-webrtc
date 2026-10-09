/**
 * SDP mutations that model what other peers send (NEGOTIATION_TRANSACTION.md
 * "Peer-diversity mutations"). Each one is a pure string rewrite of a werift
 * description, so the same library drives the integration tests and the
 * develop differential runner (run.ts) against any werift revision.
 *
 * `breaksMedia` marks mutations after which RTP is not expected to arrive even
 * when the description is accepted (the remote said it will not send, or
 * announced SSRCs it does not use). `breaksData` does the same for the
 * DataChannel. `misdescribesPeer` marks rewrites the real werift peer on the
 * other end does not follow (its BUNDLE, ICE, DTLS setup, SCTP port, MID,
 * SSRC, extension IDs or acceptance of an m-line): accepting them is
 * legitimate, but the session is not expected to keep working afterwards,
 * unless `renegotiates` says that both peers must still negotiate cleanly
 * after it (a rejected or inactive m-line is a state either peer can offer
 * from). `stopsMedia` marks mutations after which the video m-line stays
 * stopped through the next negotiation.
 *
 * The per-kind mutations are generated from a table of kinds (audio, video,
 * application) and attributes (port 0, inactive, out of BUNDLE, own ICE
 * credentials) instead of being picked by hand, so every kind gets every
 * attribute that applies to it.
 */

export type Mutation = {
  description: string;
  apply: (sdp: string) => string;
  breaksMedia?: boolean;
  breaksData?: boolean;
  misdescribesPeer?: boolean;
  renegotiates?: boolean;
  stopsMedia?: boolean;
};

const EOL = "\r\n";

const sections = (sdp: string) => sdp.split(/(?=^m=)/m);

/** Rewrite the m-sections of `kind` (`video` / `application`). */
const mapKind =
  (kind: string, rewrite: (section: string) => string) => (sdp: string) =>
    sections(sdp)
      .map((section) =>
        section.startsWith(`m=${kind} `) ? rewrite(section) : section,
      )
      .join("");

/** Drop every line matching `pattern` in the sections of `kind`. */
const dropLines = (kind: string, pattern: RegExp) =>
  mapKind(kind, (section) =>
    section
      .split(EOL)
      .filter((line) => !pattern.test(line))
      .join(EOL),
  );

const payloadTypes = (section: string) =>
  section.split(EOL)[0].split(" ").slice(3);

const withPayloadTypes = (section: string, pts: string[]) => {
  const [mLine, ...rest] = section.split(EOL);
  return [[...mLine.split(" ").slice(0, 3), ...pts].join(" "), ...rest].join(
    EOL,
  );
};

/** Session-level lines (before the first m-line). */
const mapSession = (rewrite: (session: string) => string) => (sdp: string) => {
  const [session, ...rest] = sections(sdp);
  return [rewrite(session), ...rest].join("");
};

const bundleMids = (sdp: string) =>
  /^a=group:BUNDLE (.*)$/m.exec(sdp)?.[1].trim().split(" ") ?? [];

const SESSION_MUTATIONS = {
  noBundle: {
    description: "no BUNDLE group (each m-line its own transport)",
    apply: mapSession((session) =>
      session.replace(/^a=group:BUNDLE.*\r\n/m, ""),
    ),
    misdescribesPeer: true,
  },
  splitBundleGroups: {
    description: "one BUNDLE group per m-line",
    apply: (sdp) => {
      const mids = bundleMids(sdp);
      return sdp.replace(
        /^a=group:BUNDLE.*$/m,
        mids.map((mid) => `a=group:BUNDLE ${mid}`).join(EOL),
      );
    },
    misdescribesPeer: true,
  },
  iceLite: {
    description: "ICE-lite peer",
    apply: mapSession((session) =>
      session.replace(/^(t=.*)$/m, `$1${EOL}a=ice-lite`),
    ),
    misdescribesPeer: true,
  },
  setupReversed: {
    description: "DTLS setup active and passive swapped",
    apply: (sdp) =>
      sdp.replace(/^a=setup:(active|passive)$/gm, (_, role) =>
        role === "active" ? "a=setup:passive" : "a=setup:active",
      ),
    misdescribesPeer: true,
  },
  setupActpass: {
    description: "a=setup:actpass in every m-line",
    apply: (sdp) => sdp.replace(/^a=setup:\w+$/gm, "a=setup:actpass"),
    misdescribesPeer: true,
  },
  maxMessageSize: {
    description: "max-message-size 262144",
    apply: (sdp) =>
      sdp.replace(/^a=max-message-size:\d+$/gm, "a=max-message-size:262144"),
  },
  sctpPort: {
    description: "sctp-port 5001",
    apply: (sdp) => sdp.replace(/^a=sctp-port:\d+$/gm, "a=sctp-port:5001"),
    breaksData: true,
    misdescribesPeer: true,
  },
  noNack: {
    description: "video without nack feedback",
    apply: dropLines("video", /^a=rtcp-fb:\d+ nack$/),
  },
  noPli: {
    description: "video without nack pli feedback",
    apply: dropLines("video", /^a=rtcp-fb:\d+ nack pli$/),
  },
  fmtpChanged: {
    description: "an fmtp parameter added to the first video codec",
    apply: mapKind("video", (section) => {
      const [pt] = payloadTypes(section);
      const fmtp = new RegExp(`^a=fmtp:${pt} (.*)$`, "m");
      return fmtp.test(section)
        ? section.replace(fmtp, `a=fmtp:${pt} $1;max-fr=30`)
        : section.replace(
            new RegExp(`^(a=rtpmap:${pt} .*)$`, "m"),
            `$1${EOL}a=fmtp:${pt} max-fr=30`,
          );
    }),
  },
  codecSubset: {
    description: "only the first video codec",
    apply: mapKind("video", (section) => {
      const [first, ...rest] = payloadTypes(section);
      const dropped = new RegExp(
        `^a=(rtpmap|fmtp|rtcp-fb):(${rest.join("|") || "x"}) `,
      );
      return withPayloadTypes(section, [first])
        .split(EOL)
        .filter((line) => !dropped.test(line))
        .join(EOL);
    }),
  },
  codecReordered: {
    description: "video payload types in reverse order",
    apply: mapKind("video", (section) =>
      withPayloadTypes(section, payloadTypes(section).reverse()),
    ),
  },
  midRenamed: {
    description: "the video MID renamed (#142)",
    apply: (sdp) => {
      const video = sections(sdp).find((s) => s.startsWith("m=video "));
      const mid = video && /^a=mid:(.*)$/m.exec(video)?.[1].trim();
      if (!mid) return sdp;
      const renamed = `${mid}x`;
      return sdp
        .replace(new RegExp(`^a=mid:${mid}$`, "m"), `a=mid:${renamed}`)
        .replace(
          /^a=group:BUNDLE (.*)$/m,
          (_, mids: string) =>
            `a=group:BUNDLE ${mids
              .split(" ")
              .map((m) => (m === mid ? renamed : m))
              .join(" ")}`,
        );
    },
    misdescribesPeer: true,
  },
  extmapSwapped: {
    description: "the IDs of the first two video header extensions swapped",
    apply: mapKind("video", (section) => {
      const ids = [...section.matchAll(/^a=extmap:(\d+) /gm)].map((m) => m[1]);
      if (ids.length < 2) return section;
      const [a, b] = ids;
      return section.replace(/^a=extmap:(\d+) /gm, (line, id) =>
        id === a ? `a=extmap:${b} ` : id === b ? `a=extmap:${a} ` : line,
      );
    }),
    misdescribesPeer: true,
  },
  ssrcChanged: {
    description: "video SSRCs the peer does not send with",
    apply: mapKind("video", (section) =>
      section.replace(
        /(a=ssrc(?:-group:FID)?:?)([\d ]+)/g,
        (_, head, ssrcs) =>
          `${head}${ssrcs.replace(/\d+/g, (s: string) => String((Number(s) + 7) % 2 ** 32))}`,
      ),
    ),
    breaksMedia: true,
    misdescribesPeer: true,
  },
  noEndOfCandidates: {
    description: "no end-of-candidates in the body",
    apply: (sdp) => sdp.replace(/^a=end-of-candidates\r\n/gm, ""),
  },
} satisfies Record<string, Mutation>;

const KINDS = ["audio", "video", "application"] as const;
type Kind = (typeof KINDS)[number];

/** The MID of the first m-section of `kind`. */
const midOf = (sdp: string, kind: Kind) => {
  const section = sections(sdp).find((s) => s.startsWith(`m=${kind} `));
  return section && /^a=mid:(.*)$/m.exec(section)?.[1].trim();
};

/** Drop the first m-section of `kind` from the BUNDLE group (RFC 8843). */
const leaveBundle = (kind: Kind) => (sdp: string) => {
  const mid = midOf(sdp, kind);
  return sdp.replace(
    /^a=group:BUNDLE (.*)$/m,
    (_, mids: string) =>
      `a=group:BUNDLE ${mids
        .split(" ")
        .filter((m) => m !== mid)
        .join(" ")}`,
  );
};

/** The ICE ufrag `SeparateCredentials` gives each kind. */
const UFRAGS: Record<Kind, string> = {
  audio: "muta",
  video: "mutv",
  application: "mutd",
};

/** Per-kind attributes; `applies` limits an attribute to some kinds. */
const ATTRIBUTES = {
  Rejected: {
    applies: () => true,
    describe: (kind: Kind) =>
      `${kind} m-line with port 0, left out of BUNDLE (RFC 8843)`,
    apply: (kind: Kind) => (sdp: string) =>
      leaveBundle(kind)(
        mapKind(kind, (section) => section.replace(/^m=(\w+) \d+/, "m=$1 0"))(
          sdp,
        ),
      ),
    flags: (kind: Kind): Partial<Mutation> => ({
      breaksMedia: kind === "video",
      stopsMedia: kind === "video",
      breaksData: kind === "application",
      misdescribesPeer: true,
      renegotiates: true,
    }),
  },
  Inactive: {
    applies: (kind: Kind) => kind !== "application",
    describe: (kind: Kind) => `${kind} inactive`,
    apply: (kind: Kind) =>
      mapKind(kind, (section) =>
        section.replace(/^a=(sendrecv|sendonly|recvonly)$/m, "a=inactive"),
      ),
    flags: (kind: Kind): Partial<Mutation> => ({
      breaksMedia: kind === "video",
    }),
  },
  OutOfBundle: {
    applies: () => true,
    describe: (kind: Kind) => `${kind} m-line left out of BUNDLE`,
    apply: (kind: Kind) => leaveBundle(kind),
    flags: (): Partial<Mutation> => ({ misdescribesPeer: true }),
  },
  SeparateCredentials: {
    applies: () => true,
    describe: (kind: Kind) => `the ${kind} m-line uses its own ICE credentials`,
    apply: (kind: Kind) =>
      mapKind(kind, (section) =>
        section
          .replace(/^a=ice-ufrag:.*$/m, `a=ice-ufrag:${UFRAGS[kind]}`)
          .replace(/^a=ice-pwd:.*$/m, "a=ice-pwd:mutatedmutatedmutatedmut")
          .replace(/ ufrag \S+/g, ` ufrag ${UFRAGS[kind]}`),
      ),
    flags: (): Partial<Mutation> => ({ misdescribesPeer: true }),
  },
} as const;

type KindMutationName = `${Kind}${keyof typeof ATTRIBUTES}`;

const KIND_MUTATIONS = Object.fromEntries(
  KINDS.flatMap((kind) =>
    Object.entries(ATTRIBUTES)
      .filter(([, attribute]) => attribute.applies(kind))
      .map(([name, attribute]) => [
        `${kind}${name}`,
        {
          description: attribute.describe(kind),
          apply: attribute.apply(kind),
          ...attribute.flags(kind),
        } satisfies Mutation,
      ]),
  ),
) as Partial<Record<KindMutationName, Mutation>>;

export const MUTATIONS: Record<string, Mutation> = {
  ...SESSION_MUTATIONS,
  ...KIND_MUTATIONS,
};

/** Names kept for tests written before the kind table. */
const ALIASES = {
  separateCredentials: "applicationSeparateCredentials",
} as const;

export type MutationName =
  | keyof typeof SESSION_MUTATIONS
  | KindMutationName
  | keyof typeof ALIASES;
export const MUTATION_NAMES = Object.keys(MUTATIONS) as MutationName[];

const lookup = (name: MutationName): Mutation =>
  MUTATIONS[(ALIASES as Record<string, string>)[name] ?? name];

/** Apply mutations in order. */
export function mutate(sdp: string, names: readonly MutationName[]) {
  return names.reduce((value, name) => lookup(name).apply(value), sdp);
}

/** Every unordered pair of distinct mutations, in a fixed order. */
export function mutationPairs(
  names: readonly MutationName[] = MUTATION_NAMES,
): [MutationName, MutationName][] {
  return names.flatMap((a, i) =>
    names.slice(i + 1).map((b) => [a, b] as [MutationName, MutationName]),
  );
}

export const breaksMedia = (names: readonly MutationName[]) =>
  names.some((name) => lookup(name).breaksMedia);
export const breaksData = (names: readonly MutationName[]) =>
  names.some((name) => lookup(name).breaksData);
export const misdescribesPeer = (names: readonly MutationName[]) =>
  names.some((name) => lookup(name).misdescribesPeer);
/** Every mutation that misdescribes the peer still lets both renegotiate. */
export const renegotiates = (names: readonly MutationName[]) =>
  names.every(
    (name) => !lookup(name).misdescribesPeer || lookup(name).renegotiates,
  );
export const stopsMedia = (names: readonly MutationName[]) =>
  names.some((name) => lookup(name).stopsMedia);
/** Data that stays broken after a clean renegotiation. */
export const keepsDataBroken = (names: readonly MutationName[]) =>
  names.some((name) => lookup(name).breaksData && !lookup(name).renegotiates);
