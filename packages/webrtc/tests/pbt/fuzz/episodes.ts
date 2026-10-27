import { expect } from "vitest";

import {
  MediaStreamTrack,
  RTCRtpCodecParameters,
  type RTCRtpTransceiver,
  useAbsSendTime,
  useOPUS,
  useSdesMid,
  useVP8,
} from "../../../src";
import {
  assertNegotiationInvariants,
  createDuplexSession,
  createRewrittenOffer,
  type DuplexSession,
  expectSessionAlive,
  leaveBundle,
  mungeSection,
  negotiationSnapshot,
  type Peer,
  sectionOf,
  sendAndExpectRtp,
  step,
  waitForCommittedNomination,
  waitForDtlsConnected,
} from "../../negotiation/harness/negotiationTransactionUtils";
import { type SeededRandom, seededRandom } from "../shared/random";

export { type SeededRandom, seededRandom } from "../shared/random";

/**
 * Shared Arrange for the negotiation property test: a duplex session whose
 * video uses RTX and header extensions (MID, abs-send-time), so routing-table
 * mutations (RTX pairing, extmap IDs) are available to the operations.
 */
export async function createFuzzSession() {
  const session = await createDuplexSession({
    codecs: {
      audio: [useOPUS()],
      video: [
        useVP8(),
        new RTCRtpCodecParameters({ mimeType: "video/rtx", clockRate: 90000 }),
      ],
    },
    headerExtensions: {
      video: [useSdesMid(), useAbsSendTime()],
      audio: [useSdesMid()],
    },
  });
  return { session, audio: [] as FuzzAudio[], log: [] as string[] };
}
type FuzzAudio = {
  out: MediaStreamTrack;
  sender: Peer;
  transceiver: RTCRtpTransceiver;
};
/**
 * Audio lines the committed session sends (a rolled-back one is not yet, and
 * one the answer made inactive carries no RTP).
 */
const negotiatedAudio = (ctx: FuzzContext) =>
  ctx.audio.filter(
    ({ transceiver }) =>
      !!transceiver.mid &&
      ["sendonly", "sendrecv"].includes(transceiver.currentDirection ?? ""),
  );
export type FuzzContext = Awaited<ReturnType<typeof createFuzzSession>>;

/** Real traffic of every committed stream: video + DataChannel both ways, and each audio. */
export async function expectFuzzSessionAlive(ctx: FuzzContext, label: string) {
  await expectSessionAlive(ctx.session, label);
  for (const [index, audio] of negotiatedAudio(ctx).entries()) {
    const receiver = (
      audio.sender === ctx.session.a ? ctx.session.b : ctx.session.a
    ).pc
      .getTransceivers()
      .find((t) => t.mid === audio.transceiver.mid)!.receiver;
    await sendAndExpectRtp(
      audio.out,
      receiver.track,
      `${label}-audio-${index}`,
    );
  }
}

const audioSplit = (sdp: string, mid: string, split: boolean) => {
  const group = sdp.match(/^a=group:BUNDLE ([^\r\n]+)/m)![1].split(" ");
  const items = split
    ? group.filter((item) => item !== mid)
    : [...group.filter((item) => item !== mid), mid];
  return sdp.replace(
    /^a=group:BUNDLE [^\r\n]+/m,
    `a=group:BUNDLE ${items.join(" ")}`,
  );
};

/**
 * One committed or rolled-back negotiation episode chosen by `rng`: offer
 * variants (plain, ICE restart, new audio m-line, audio BUNDLE split/merge),
 * then pranswer / replacement offer / end-of-candidates, then answer or
 * rollback (an ICE restart answer is created twice, an unapplied restart
 * offer follows, and the first answer is applied). Invariants of both peers are checked after every operation.
 */
export async function fuzzEpisode(ctx: FuzzContext, rng: SeededRandom) {
  const { session } = ctx;
  const [offerer, answerer] = rng.chance(0.5)
    ? [session.a, session.b]
    : [session.b, session.a];
  const name = offerer === session.a ? "a" : "b";
  const variant = rng.pick([
    "plain",
    "iceRestart",
    ...(ctx.audio.length < 2 ? ["addAudio"] : []),
    ...(negotiatedAudio(ctx).length > 0 ? ["splitAudio", "mergeAudio"] : []),
  ] as const);
  const finish = rng.pick([
    "answer",
    "pranswerAnswer",
    "pranswerRollback",
    "rollback",
    "replacementAnswer",
  ] as const);
  const endOfCandidates = rng.chance(0.3);
  ctx.log.push(
    `episode ${name} ${variant} ${finish}${endOfCandidates ? " eoc" : ""}`,
  );

  if (variant === "addAudio") {
    const out = new MediaStreamTrack({ kind: "audio" });
    const transceiver = offerer.pc.addTransceiver(out, {
      direction: "sendonly",
    });
    // rollback されても transceiver は残り、後の episode で交渉される。
    ctx.audio.push({ out, sender: offerer, transceiver });
  }
  const splitTarget =
    variant === "splitAudio" || variant === "mergeAudio"
      ? rng.pick(negotiatedAudio(ctx)).transceiver.mid!
      : undefined;
  const makeOffer = () =>
    createRewrittenOffer(
      offerer.pc,
      (sdp) =>
        splitTarget && sdp.includes(`a=mid:${splitTarget}`)
          ? audioSplit(sdp, splitTarget, variant === "splitAudio")
          : sdp,
      { iceRestart: variant === "iceRestart" },
    );

  await step(session, async () =>
    offerer.pc.setLocalDescription(await makeOffer()),
  );
  await step(session, () =>
    answerer.pc.setRemoteDescription(offerer.pc.localDescription!),
  );
  if (endOfCandidates) {
    const mid = answerer.pc.getTransceivers()[0].mid!;
    await step(session, () =>
      answerer.pc.addIceCandidate({ candidate: "", sdpMid: mid }),
    );
  }
  if (finish === "replacementAnswer") {
    await step(session, async () =>
      offerer.pc.setLocalDescription(await makeOffer()),
    );
    await step(session, () =>
      answerer.pc.setRemoteDescription(offerer.pc.localDescription!),
    );
  }
  if (finish === "pranswerAnswer" || finish === "pranswerRollback") {
    const pranswer = await answerer.pc.createAnswer();
    await step(session, () =>
      answerer.pc.setLocalDescription({ type: "pranswer", sdp: pranswer.sdp }),
    );
    await step(session, () =>
      offerer.pc.setRemoteDescription({
        type: "pranswer",
        sdp: answerer.pc.localDescription!.sdp,
      }),
    );
  }
  if (finish === "rollback" || finish === "pranswerRollback") {
    await step(session, () =>
      answerer.pc.setRemoteDescription({ type: "rollback" }),
    );
    await step(session, () =>
      offerer.pc.setLocalDescription({ type: "rollback" }),
    );
    return;
  }
  // An ICE restart answer is saved, created again, an unapplied restart
  // offer is created, and the saved answer is applied: answers for the same
  // remote offer stay applicable.
  const saved = await answerer.pc.createAnswer();
  if (variant === "iceRestart") {
    await answerer.pc.createAnswer();
    await answerer.pc.createOffer({ iceRestart: true });
  }
  await step(session, () => answerer.pc.setLocalDescription(saved));
  await step(session, () =>
    offerer.pc.setRemoteDescription(answerer.pc.localDescription!),
  );
  if (variant === "iceRestart") {
    // commit で旧 pair を離れるので、新 generation の nomination を待つ。
    await Promise.all([
      waitForCommittedNomination(offerer.pc),
      waitForCommittedNomination(answerer.pc),
    ]);
  }
  // BUNDLE split などで新しく作られた transport の DTLS 確立を待つ。
  await Promise.all(
    [offerer.pc, answerer.pc].flatMap((pc) =>
      pc.dtlsTransports.map((transport) => waitForDtlsConnected(transport)),
    ),
  );
}

/**
 * A remote-only proposal that reassigns routing keys (RTX pairing, extmap URI
 * moved to a new ID) or remaps an extmap ID. Allowed ones stay pending while
 * the current session must keep flowing, then roll back; a remap must be
 * rejected without any state change.
 */
export async function fuzzRemoteMutation(ctx: FuzzContext, rng: SeededRandom) {
  const { session } = ctx;
  const [offerer, answerer] = rng.chance(0.5)
    ? [session.a, session.b]
    : [session.b, session.a];
  const mutation = rng.pick([
    "rtxPairing",
    "extmapMove",
    "extmapRemap",
  ] as const);
  ctx.log.push(`mutation ${offerer === session.a ? "a" : "b"} ${mutation}`);
  const offer = (await offerer.pc.createOffer()).sdp;
  const videoMid = offerer.video.mid!;
  let sdp = offer;
  if (mutation === "rtxPairing") {
    const fid = sectionOf(offer, videoMid).match(
      /^a=ssrc-group:FID (\d+) \d+/m,
    );
    if (!fid) return;
    sdp = mungeSection(offer, videoMid, (section) =>
      section.split(fid[1]).join("987654"),
    );
  } else {
    const extmap = sectionOf(offer, videoMid).match(
      /^a=extmap:(\d+) (http:\/\/www\.webrtc\.org\/experiments\/rtp-hdrext\/abs-send-time)/m,
    );
    if (!extmap) return;
    const replacement =
      mutation === "extmapMove"
        ? `a=extmap:13 ${extmap[2]}`
        : `a=extmap:${extmap[1]} urn:ietf:params:rtp-hdrext:toffset`;
    sdp = offer.split(`a=extmap:${extmap[1]} ${extmap[2]}`).join(replacement);
  }
  const before = {
    state: answerer.pc.signalingState,
    current: answerer.pc.currentRemoteDescription!.sdp,
  };
  if (mutation === "extmapRemap") {
    // ID の再割当ては適用前に拒否され、状態は一切変わらない。
    await expect(
      answerer.pc.setRemoteDescription({ type: "offer", sdp }),
    ).rejects.toMatchObject({ name: "InvalidModificationError" });
    expect(answerer.pc.signalingState).toBe(before.state);
    expect(answerer.pc.currentRemoteDescription!.sdp).toBe(before.current);
    assertNegotiationInvariants(answerer.pc);
    return;
  }
  await step(session, () =>
    answerer.pc.setRemoteDescription({ type: "offer", sdp }),
  );
  // pending 中も current の RTP・DataChannel は双方向に流れる。
  await expectFuzzSessionAlive(ctx, `pending-${mutation}`);
  await step(session, () =>
    answerer.pc.setRemoteDescription({ type: "rollback" }),
  );
}

/**
 * The remote peer rejects (port 0, out of BUNDLE) one m-line of a random
 * kind, in the offer it sends or in the answer it applies itself: the DataChannel's
 * application m-line, an audio line, or a video line the offer adds. Every
 * operation keeps the invariants, and the episodes after it keep negotiating
 * (the application m-line is offered again with its MID, as in develop).
 */
export async function fuzzRemoteRejection(ctx: FuzzContext, rng: SeededRandom) {
  const { session } = ctx;
  const [offerer, answerer] = rng.chance(0.5)
    ? [session.a, session.b]
    : [session.b, session.a];
  const where = rng.pick(["offer", "answer"] as const);
  const audio = negotiatedAudio(ctx);
  const kind = rng.pick([
    "application",
    "video",
    ...(audio.length > 0 ? ["audio"] : []),
  ] as const);
  ctx.log.push(
    `rejection ${offerer === session.a ? "a" : "b"} ${kind} in ${where}`,
  );
  const added =
    kind === "video"
      ? offerer.pc.addTransceiver(new MediaStreamTrack({ kind: "video" }), {
          direction: "sendonly",
        })
      : undefined;
  await step(session, async () =>
    offerer.pc.setLocalDescription(await offerer.pc.createOffer()),
  );
  const offer = offerer.pc.localDescription!.sdp;
  const mid =
    kind === "application"
      ? /^m=application[\s\S]*?^a=mid:(\S+)/m.exec(offer)?.[1]
      : kind === "video"
        ? added!.mid!
        : rng.pick(audio).transceiver.mid!;
  if (!mid) throw new Error(`no ${kind} m-line to reject`);
  const reject = (sdp: string) =>
    leaveBundle(
      mungeSection(sdp, mid, (section) =>
        section.replace(/^m=(\w+) \d+/m, "m=$1 0"),
      ),
      mid,
    );
  await step(session, () =>
    answerer.pc.setRemoteDescription({
      type: "offer",
      sdp: where === "offer" ? reject(offer) : offer,
    }),
  );
  // answer での拒否は answerer 自身もその answer を適用する (相手が実際に拒否した状態)。
  const answer = (await answerer.pc.createAnswer()).sdp;
  const applied = where === "answer" ? reject(answer) : answer;
  await step(session, () =>
    answerer.pc.setLocalDescription({ type: "answer", sdp: applied }),
  );
  await step(session, () =>
    offerer.pc.setRemoteDescription({ type: "answer", sdp: applied }),
  );
}

/**
 * Act + Assert helper: run a description operation the contract refuses and
 * check that it rejected and changed nothing on either peer.
 */
export async function expectRejectedAtomically(
  session: DuplexSession,
  operation: () => Promise<unknown>,
) {
  const before = [session.a.pc, session.b.pc].map(negotiationSnapshot);
  // 拒否される操作を行う。
  await expect(operation()).rejects.toThrow();
  // 拒否の前後で両 peer の状態は完全に一致する。
  expect([session.a.pc, session.b.pc].map(negotiationSnapshot)).toEqual(before);
  assertNegotiationInvariants(session.a.pc);
  assertNegotiationInvariants(session.b.pc);
}

/**
 * One episode on the description pool: offers and answers are created and
 * kept, and saved ones are applied later or again (an unapplied restart
 * offer, a stale offer, rollback and re-application, a regenerated answer,
 * pranswer then answer). Accepted operations keep the invariants; the ones
 * the reuse contract refuses must change nothing. It ends committed.
 */
export async function fuzzDescriptionPool(ctx: FuzzContext, rng: SeededRandom) {
  const { session } = ctx;
  const [offerer, answerer] = rng.chance(0.5)
    ? [session.a, session.b]
    : [session.b, session.a];
  const iceRestart = rng.chance(0.5);
  ctx.log.push(
    `pool ${offerer === session.a ? "a" : "b"}${iceRestart ? " iceRestart" : ""}`,
  );

  const ufragOf = (sdp?: string) => sdp?.match(/^a=ice-ufrag:(\S+)/m)?.[1];
  const committedUfrag = ufragOf(offerer.pc.currentLocalDescription?.sdp);
  const offers = [await offerer.pc.createOffer({ iceRestart })];
  if (rng.chance(0.5)) {
    // 後から作った (適用しない) offer が最新になり、先の offer は適用できない。
    offers.push(await offerer.pc.createOffer({ iceRestart: rng.chance(0.5) }));
    ctx.log.push("  stale offer refused");
    await expectRejectedAtomically(session, () =>
      offerer.pc.setLocalDescription(offers[0]),
    );
  }
  const offer = offers[offers.length - 1];
  await step(session, () => offerer.pc.setLocalDescription(offer));
  if (rng.chance(0.4)) {
    // rollback して同じ offer を再適用する。
    ctx.log.push("  rollback and re-apply");
    await step(session, () =>
      offerer.pc.setLocalDescription({ type: "rollback" }),
    );
    await step(session, () => offerer.pc.setLocalDescription(offer));
  }
  await step(session, () =>
    answerer.pc.setRemoteDescription(offerer.pc.localDescription!),
  );
  const saved = await answerer.pc.createAnswer();
  if (rng.chance(0.5)) {
    // answer を作り直し、remote offer の保留中に適用しない offer も作る。
    // 順序も入れ替える (未適用の offer の後に answer を作り直す場合を含む)。
    const offerFirst = rng.chance(0.5);
    ctx.log.push(
      `  regenerated answer and unapplied offer${offerFirst ? " (offer first)" : ""}`,
    );
    if (offerFirst) {
      await answerer.pc.createOffer({ iceRestart: rng.chance(0.5) });
      await answerer.pc.createAnswer();
    } else {
      await answerer.pc.createAnswer();
      await answerer.pc.createOffer({ iceRestart: rng.chance(0.5) });
    }
  }
  if (rng.chance(0.3)) {
    ctx.log.push("  pranswer first");
    await step(session, () =>
      answerer.pc.setLocalDescription({ type: "pranswer", sdp: saved.sdp }),
    );
    await step(session, () =>
      offerer.pc.setRemoteDescription({
        type: "pranswer",
        sdp: answerer.pc.localDescription!.sdp,
      }),
    );
  }
  await step(session, () =>
    answerer.pc.setLocalDescription({ type: "answer", sdp: saved.sdp }),
  );
  await step(session, () =>
    offerer.pc.setRemoteDescription(answerer.pc.localDescription!),
  );
  // 適用した offer (古い offer を拒否した場合は後の offer) が ICE restart なら、
  // 新 generation の nomination を待つ。
  if (ufragOf(offer.sdp) !== committedUfrag) {
    await Promise.all([
      waitForCommittedNomination(offerer.pc),
      waitForCommittedNomination(answerer.pc),
    ]);
  }
  await Promise.all(
    [offerer.pc, answerer.pc].flatMap((pc) =>
      pc.dtlsTransports.map((transport) => waitForDtlsConnected(transport)),
    ),
  );
}
