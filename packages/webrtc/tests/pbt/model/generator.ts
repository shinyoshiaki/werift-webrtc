import {
  type BundleCandidates,
  MediaStreamTrack,
  type RTCPeerConnection,
  type RTCRtpTransceiver,
  type TransceiverPairing,
  useH264,
  useNACK,
  useOPUS,
  usePCMU,
  usePLI,
  useREMB,
  useRepairedRtpStreamId,
  useSdesMid,
  useSdesRTPStreamId,
  useTransportWideCC,
  useTWCC,
  useVP8,
} from "../../../src";
import {
  type CaseMeta,
  NegotiationCase,
} from "../../negotiation/harness/negotiationCase";
import {
  assertNegotiationInvariants,
  createDuplexSession,
  createPeerPair,
  createSplitOffer,
  rtxCodec,
} from "../../negotiation/harness/negotiationTransactionUtils";
import { type SeededRandom, seededRandom } from "../shared/random";
import { ModelOracles } from "./oracles";
import {
  injectRidPacket,
  ridReceivers,
  ssrcLessReceivers,
  switchRemoteSsrc,
} from "./ssrcLessTraffic";
import {
  remapsCurrentKeys,
  WIRE_MUTATION_NAMES,
  WIRE_MUTATIONS,
} from "./wireMutations";

/**
 * Scenes of the model property: a start state and a list of operations
 * (data, so a failing scene can be shrunk and a regression written in a few
 * lines). `runScene` applies them through the case harness, which checks the
 * invariants, the traffic property and the oracles of `model/oracles.ts`
 * after every description operation; `generateScene` draws the operations
 * from a seed, one applicable operation at a time.
 */
export type Side = "a" | "b";
/**
 * The configuration of both peers: VP8 with NACK, PLI, REMB and transport-cc,
 * its RTX, H264 with NACK and PLI, Opus and PCMU, and the MID and
 * transport-cc header extensions, so codec, feedback, RTX and extension
 * rewrites on the wire have something to change.
 */
export const modelConfig = (
  transceiverPairing: TransceiverPairing = "standard",
  bundlePolicy: ModelBundlePolicy = "max-bundle",
) => ({
  transceiverPairing,
  bundlePolicy,
  codecs: {
    video: [
      useVP8({ rtcpFeedback: [useNACK(), usePLI(), useREMB(), useTWCC()] }),
      rtxCodec(),
      useH264({ rtcpFeedback: [useNACK(), usePLI()] }),
    ],
    audio: [useOPUS(), usePCMU()],
  },
  headerExtensions: {
    video: [
      useSdesMid(),
      useTransportWideCC(),
      useSdesRTPStreamId(),
      useRepairedRtpStreamId(),
    ],
    audio: [useSdesMid()],
  },
});

/**
 * The configuration of peer b in an asymmetric scene: the codecs of
 * `modelConfig` in another form, so the codecs negotiation commits are in the
 * remote's form on one side (issue 818): VP8 on another payload type (110) with
 * NACK and PLI only, H264 of another level (42e00d), and Opus with other fmtp.
 */
export const asymmetricModelConfig = (
  transceiverPairing: TransceiverPairing = "standard",
  bundlePolicy: ModelBundlePolicy = "max-bundle",
) => ({
  ...modelConfig(transceiverPairing, bundlePolicy),
  codecs: {
    video: [
      // 120 is the free payload type the `codecRenumbered` wire mutation
      // moves H264 to, so VP8 takes another one.
      useVP8({ payloadType: 110, rtcpFeedback: [useNACK(), usePLI()] }),
      rtxCodec(),
      useH264({
        rtcpFeedback: [useNACK(), usePLI()],
        parameters:
          "profile-level-id=42e00d;packetization-mode=1;level-asymmetry-allowed=1",
      }),
    ],
    audio: [useOPUS({ parameters: "stereo=1" }), usePCMU()],
  },
});

/**
 * `connected`: a duplex session (video both ways and a DataChannel);
 * `unnegotiated`: a sends video and has a DataChannel; `media`: a sends
 * video only (the first SCTP transport comes during a negotiation).
 */
export type Start = "connected" | "unnegotiated" | "media";
/** One operation: the peer that takes it, its name and the choices it made. */
export type Op = [Side, string, Record<string, unknown>?];
/**
 * `bundleCandidates`: the `bundleCandidates` of both peers (default `"legacy"`; a generated
 * scene draws `"compatible"` on even seeds). Each property varies
 * independently so the model checks both configuration axes.
 * `pairing`: the `transceiverPairing` of both peers (default `"standard"`, the
 * JSEP 5.10 rules the oracles check; a generated scene draws `"byKind"`, the
 * werift default, sometimes, #816). `asymmetric`: peer b has
 * `asymmetricModelConfig` (a generated scene draws it sometimes, #818).
 */
/**
 * `bundlePolicy` of both peers (default `"max-bundle"`, one transport). A
 * generated scene sometimes draws `"disable"` (a transport per m-line) or
 * `"max-compat"`, so the same SSRC may live in several RTP sessions (#356).
 */
export type ModelBundlePolicy = "max-bundle" | "max-compat" | "disable";
export type Scene = {
  start: Start;
  ops: Op[];
  bundleCandidates?: BundleCandidates;
  pairing?: TransceiverPairing;
  bundle?: ModelBundlePolicy;
  /** a also sends a simulcast video (RIDs "high" / "low", #356 3.12). */
  simulcast?: boolean;
  asymmetric?: boolean;
};

type World = {
  c: NegotiationCase;
  oracles: ModelOracles;
  /** Offers created and not applied, per peer (for `applyStale`). */
  saved: Map<RTCPeerConnection, { type: "offer"; sdp: string }>;
  /** Transceivers `pc.addTrack()` attached a track to (`detachTrack` takes it off again). */
  addTracked: WeakSet<RTCRtpTransceiver>;
  created: number;
  /** The scene has a simulcast sender (see `Scene.simulcast`). */
  simulcast?: boolean;
  /** That simulcast sender's transceiver (on a). */
  simulcastSender?: RTCRtpTransceiver;
};
type Peers = { pc: RTCPeerConnection; other: RTCPeerConnection };
type Step = {
  weight: number;
  applies: (p: Peers, w: World) => boolean;
  /** Draw the choices of the operation (stored in the Op, used on replay). */
  draw?: (rng: SeededRandom, p: Peers, w: World) => Record<string, unknown>;
  run: (p: Peers, w: World, args: Record<string, unknown>) => Promise<void>;
};

const stable = (...pcs: RTCPeerConnection[]) =>
  pcs.every((pc) => pc.signalingState === "stable");
const offering = (pc: RTCPeerConnection) =>
  ["have-local-offer", "have-remote-pranswer"].includes(pc.signalingState);
const answering = (pc: RTCPeerConnection) =>
  ["have-remote-offer", "have-local-pranswer"].includes(pc.signalingState);
const kinds = ["audio", "video"] as const;
/** Transceivers on an m-line that are not stopped, except the session's first one. */
const negotiated = (pc: RTCPeerConnection) =>
  pc
    .getTransceivers()
    .filter((t, index) => index > 0 && t.mid != undefined && !t.stopping);
/** Transceivers on an m-line that are not stopped (the session's first one too). */
const associated = (pc: RTCPeerConnection) =>
  pc.getTransceivers().filter((t) => t.mid != undefined && !t.stopping);
/**
 * The application changes transceivers while both peers are stable, or on
 * the answerer while a remote offer is pending (a rollback then keeps only
 * the transceivers it attached a track to).
 */
const applicationTurn = (pc: RTCPeerConnection, other: RTCPeerConnection) =>
  stable(pc, other) || pc.signalingState === "have-remote-offer";
/** What the application changes: while a remote offer is pending, also the transceivers it created. */
const targets = (pc: RTCPeerConnection) =>
  pc.signalingState === "have-remote-offer" ? associated(pc) : negotiated(pc);
const bundled = (pc: RTCPeerConnection) =>
  pc.currentLocalDescription?.sdp
    .match(/^a=group:BUNDLE ([^\r\n]+)/m)?.[1]
    .split(" ") ?? [];
const splittable = (pc: RTCPeerConnection) =>
  negotiated(pc)
    .map((t) => t.mid!)
    .filter((mid) => bundled(pc).includes(mid) && bundled(pc)[0] !== mid);
/** A transceiver by its index (a replayed scene may no longer have it). */
const byIndex = (pc: RTCPeerConnection, index: unknown) =>
  pc.getTransceivers()[index as number] as RTCRtpTransceiver | undefined;
/** A transceiver whose track `pc.addTrack()` attached and the application can take off. */
const detachable = (t: RTCRtpTransceiver, w: World) =>
  w.addTracked.has(t) && !t.stopping && !!t.sender.track;
const pickIndex = (
  rng: SeededRandom,
  pc: RTCPeerConnection,
  from: RTCRtpTransceiver[],
) => pc.getTransceivers().indexOf(rng.pick(from));

/**
 * 範囲外: simulcast (RID) の m-line を止めてから、その m-line を新しい transceiver が
 * 再利用すると、answer が "No compatible codec remains after remote negotiation" で失敗する
 * (develop にもある既存の不具合、チケット e4bfc125)。simulcast のシーンでは RID を持つ transceiver
 * を止めない。
 */
const stoppable = (w: World, t: RTCRtpTransceiver) =>
  !w.simulcast ||
  (Object.keys(t.receiver.trackByRID).length === 0 && t !== w.simulcastSender);

export const STEPS: Record<string, Step> = {
  addTrack: {
    weight: 2,
    applies: ({ pc }) => pc.getTransceivers().length < 6,
    draw: (rng) => ({ kind: rng.pick(kinds) }),
    run: async ({ pc }, w, { kind }) => {
      const track = new MediaStreamTrack({ kind: kind as "audio" });
      w.oracles.application(
        pc.addTransceiver(track, { direction: "sendrecv" }),
      );
    },
  },
  takeTrack: {
    weight: 1,
    // pc.addTrack() は同じ kind の空いた transceiver (remote offer が作ったものを含む)
    // を再利用する。pending 中に再利用したものは rollback で残る (W3C)。
    applies: ({ pc, other }) =>
      applicationTurn(pc, other) && pc.getTransceivers().length < 6,
    draw: (rng, { pc }) => {
      const free = targets(pc).filter((t) => !t.sender.track);
      return { kind: free.length ? rng.pick(free).kind : rng.pick(kinds) };
    },
    run: async ({ pc }, w, { kind }) => {
      const sender = pc.addTrack(
        new MediaStreamTrack({ kind: kind as "audio" }),
      );
      const t = pc.getTransceivers().find((each) => each.sender === sender)!;
      w.addTracked.add(t);
      w.oracles.application(t);
    },
  },
  // #816: a transceiver addTrack() creates (or the one it reuses) may pair
  // with a remote offer; one addTransceiver() creates never does (JSEP 5.10).
  addTrackApi: {
    weight: 1,
    applies: ({ pc }) => pc.getTransceivers().length < 6,
    draw: (rng) => ({ kind: rng.pick(kinds) }),
    run: async ({ pc }, w, { kind }) => {
      const sender = pc.addTrack(
        new MediaStreamTrack({ kind: kind as "audio" }),
      );
      const t = pc.getTransceivers().find((each) => each.sender === sender)!;
      w.addTracked.add(t);
      w.oracles.application(t);
    },
  },
  detachTrack: {
    weight: 1,
    // addTrack で付けた track を replaceTrack(null) か removeTrack で外す。外しても
    // addTrack で使った transceiver は rollback で残る (#817)。
    applies: ({ pc, other }, w) =>
      applicationTurn(pc, other) &&
      pc.getTransceivers().some((t) => detachable(t, w)),
    draw: (rng, { pc }, w) => ({
      index: pickIndex(
        rng,
        pc,
        pc.getTransceivers().filter((t) => detachable(t, w)),
      ),
      how: rng.pick(["replaceTrack", "removeTrack"]),
    }),
    run: async ({ pc }, w, { index, how }) => {
      const t = byIndex(pc, index);
      if (!t || !detachable(t, w)) return;
      if (how === "removeTrack") pc.removeTrack(t.sender);
      else await t.sender.replaceTrack(null);
    },
  },
  addSendonly: {
    weight: 1,
    applies: ({ pc }) => pc.getTransceivers().length < 6,
    draw: (rng) => ({ kind: rng.pick(kinds) }),
    run: async ({ pc }, w, { kind }) => {
      const track = new MediaStreamTrack({ kind: kind as "audio" });
      w.oracles.application(
        pc.addTransceiver(track, { direction: "sendonly" }),
      );
    },
  },
  addRecvonly: {
    weight: 1,
    applies: ({ pc }) => pc.getTransceivers().length < 6,
    draw: (rng) => ({ kind: rng.pick(kinds) }),
    run: async ({ pc }, w, { kind }) => {
      w.oracles.application(
        pc.addTransceiver(kind as "audio", { direction: "recvonly" }),
      );
    },
  },
  dataChannel: {
    weight: 1,
    applies: () => true,
    run: async ({ pc }, w) => {
      w.oracles.channel(pc.createDataChannel(`dc${++w.created}`), pc);
    },
  },
  attachTrack: {
    weight: 1,
    applies: ({ pc, other }) =>
      applicationTurn(pc, other) && targets(pc).some((t) => !t.sender.track),
    draw: (rng, { pc }) => ({
      index: pickIndex(
        rng,
        pc,
        targets(pc).filter((t) => !t.sender.track),
      ),
    }),
    run: async ({ pc }, w, { index }) => {
      const t = byIndex(pc, index);
      if (!t || t.stopping || t.sender.track) return;
      await t.sender.replaceTrack(new MediaStreamTrack({ kind: t.kind }));
      t.setDirection("sendrecv");
      w.oracles.application(t);
    },
  },
  // removeTrack(): sendrecv becomes recvonly and sendonly becomes inactive;
  // the next offer keeps the negotiated codecs (issue 818).
  removeTrack: {
    weight: 1,
    applies: ({ pc, other }) =>
      applicationTurn(pc, other) &&
      targets(pc).some((t) => !!t.sender.track && !t.stopping),
    draw: (rng, { pc }) => ({
      index: pickIndex(
        rng,
        pc,
        targets(pc).filter((t) => !!t.sender.track && !t.stopping),
      ),
    }),
    run: async ({ pc }, _w, { index }) => {
      const t = byIndex(pc, index);
      if (!t || t.stopping || !t.sender.track) return;
      pc.removeTrack(t.sender);
    },
  },
  direction: {
    weight: 1,
    applies: ({ pc, other }) =>
      applicationTurn(pc, other) && targets(pc).length > 0,
    draw: (rng, { pc }) => ({
      index: pickIndex(rng, pc, targets(pc)),
      direction: rng.pick(["sendrecv", "sendonly", "recvonly", "inactive"]),
    }),
    run: async ({ pc }, _w, { index, direction }) => {
      const t = byIndex(pc, index);
      if (t && !t.stopping) t.setDirection(direction as "sendrecv");
    },
  },
  codecPreferences: {
    weight: 1,
    applies: ({ pc, other }) =>
      applicationTurn(pc, other) && associated(pc).length > 0,
    // 先頭の codec だけ、または全 codec の逆順を選ぶ (両 peer の preferences が
    // 必ず先頭の codec を共有する)。
    draw: (rng, { pc }) => {
      const index = pickIndex(rng, pc, associated(pc));
      const kind = pc.getTransceivers()[index].kind;
      if (rng.chance(0.5)) return { index, reversed: true };
      return { index, codec: pc.config.codecs[kind]?.[0]?.mimeType };
    },
    run: async ({ pc }, _w, { index, codec, reversed }) => {
      const t = byIndex(pc, index);
      const codecs = (t && pc.config.codecs[t.kind]) ?? [];
      const chosen = reversed
        ? [...codecs].reverse()
        : codecs.filter((each) => each.mimeType === codec);
      if (t && !t.stopping && chosen.length) t.setCodecPreferences(chosen);
    },
  },
  stop: {
    weight: 1,
    applies: ({ pc, other }, w) =>
      applicationTurn(pc, other) && targets(pc).some((t) => stoppable(w, t)),
    draw: (rng, { pc }, w) => ({
      index: pickIndex(
        rng,
        pc,
        targets(pc).filter((t) => stoppable(w, t)),
      ),
    }),
    run: async ({ pc }, w, { index }) => {
      const t = byIndex(pc, index);
      if (t && !t.stopping && stoppable(w, t)) t.stop();
    },
  },
  settle: {
    weight: 1,
    // 交渉済みの stream の transport が確立するのを待って通信を確かめる (以降の
    // 操作の後の通信検査が、確立前で飛ばされない)。
    applies: ({ pc, other }) =>
      stable(pc, other) && !!pc.currentRemoteDescription,
    run: async (_p, w) => {
      await w.c.expectTraffic({ final: true });
    },
  },
  restartIce: {
    weight: 1,
    applies: ({ pc, other }) => stable(pc, other),
    run: async ({ pc }) => pc.restartIce(),
  },
  offer: {
    weight: 4,
    applies: ({ pc, other }) => stable(pc, other),
    draw: (rng) => ({ iceRestart: rng.chance(0.2) }),
    run: async ({ pc }, w, { iceRestart }) => {
      await w.c.offer(pc, { iceRestart: !!iceRestart });
    },
  },
  splitOffer: {
    weight: 1,
    applies: ({ pc, other }) => stable(pc, other) && splittable(pc).length > 0,
    draw: (rng, { pc }) => ({ mid: rng.pick(splittable(pc)) }),
    run: async ({ pc, other }, w, { mid }) => {
      if (!splittable(pc).includes(mid as string)) return;
      await w.c.setLocal(pc, await createSplitOffer(pc, mid as string));
      await w.c.setRemote(other, pc.localDescription);
    },
  },
  glare: {
    weight: 1,
    applies: ({ pc, other }) => stable(pc, other),
    run: async ({ pc, other }, w) => {
      // 双方が offer を出し、pc が相手の offer を受けて暗黙に rollback する。
      await w.c.offer(pc, { hold: true });
      await w.c.offer(other, { hold: true });
      await w.c.setRemote(pc, other.localDescription);
    },
  },
  replacementOffer: {
    weight: 1,
    // 範囲外: simulcast の m-line は置き換えの offer で ontrack を同じ stream でもう一度
    // 通知する (develop にもある既存の不具合、チケット e4bfc125)。simulcast のシーンでは引かない。
    applies: ({ pc, other }, w) =>
      offering(pc) && answering(other) && !w.simulcast,
    draw: (rng) => ({ iceRestart: rng.chance(0.2) }),
    run: async ({ pc }, w, { iceRestart }) => {
      await w.c.offer(pc, { iceRestart: !!iceRestart });
    },
  },
  wireOffer: {
    weight: 2,
    applies: ({ pc, other }) => stable(pc, other),
    draw: (rng) => ({
      iceRestart: rng.chance(0.15),
      mutation: rng.pick(WIRE_MUTATION_NAMES),
    }),
    run: async ({ pc, other }, w, { iceRestart, mutation }) => {
      await w.c.setLocal(
        pc,
        await pc.createOffer({ iceRestart: !!iceRestart }),
      );
      await deliver(w, pc, other, mutation as string);
    },
  },
  wireReply: {
    weight: 2,
    applies: ({ pc }) => answering(pc),
    draw: (rng) => ({
      type: rng.pick(["pranswer", "answer"]),
      mutation: rng.pick(WIRE_MUTATION_NAMES),
    }),
    run: async ({ pc, other }, w, { type, mutation }) => {
      const answer = await pc.createAnswer();
      await w.c.setLocal(pc, { type: type as "answer", sdp: answer.sdp });
      await deliver(w, pc, other, mutation as string);
    },
  },
  pranswer: {
    weight: 2,
    applies: ({ pc }) => answering(pc),
    run: async ({ pc }, w) => {
      await w.c.pranswer(pc);
    },
  },
  answer: {
    weight: 4,
    applies: ({ pc }) => answering(pc),
    run: async ({ pc }, w) => {
      await w.c.answer(pc);
    },
  },
  lateAnswer: {
    weight: 1,
    applies: ({ pc }) => answering(pc) && associated(pc).length > 0,
    draw: (rng, { pc }) => ({
      index: pickIndex(rng, pc, associated(pc)),
      change: rng.pick(["preferences", "track"]),
    }),
    run: async ({ pc, other }, w, { index, change }) => {
      // createAnswer の後、適用する前にアプリが codec preferences か track を変える
      // (適用する answer の codec で確定する)。
      const answer = await pc.createAnswer();
      const t = byIndex(pc, index);
      if (t && !t.stopping && change === "preferences") {
        t.setCodecPreferences([...(pc.config.codecs[t.kind] ?? [])].reverse());
      } else if (t && !t.stopping && !t.sender.track) {
        await t.sender.replaceTrack(new MediaStreamTrack({ kind: t.kind }));
        t.setDirection("sendrecv");
        w.oracles.application(t);
      }
      await w.c.setLocal(pc, answer);
      await w.c.setRemote(other, pc.localDescription);
    },
  },
  rollback: {
    weight: 2,
    applies: ({ pc }) => offering(pc) || answering(pc),
    run: async ({ pc }, w) => {
      await w.c.rollback(pc);
    },
  },
  reapplyRemote: {
    weight: 1,
    applies: ({ pc }) => !!pc.pendingRemoteDescription,
    run: async ({ pc }, w) => {
      // 同じ remote description の再適用は何も変えない (拒否されても変えない)。
      w.oracles.idempotent = true;
      await w.c.setRemote(pc, pc.pendingRemoteDescription, { mayReject: true });
      w.oracles.idempotent = false;
    },
  },
  createOnly: {
    weight: 1,
    applies: ({ pc }) =>
      ["stable", "have-local-offer"].includes(pc.signalingState) ||
      answering(pc),
    run: async ({ pc }, w) => {
      // offer / answer を作るだけでは何も変わらない。作った offer は後で古い offer になる。
      if (answering(pc)) {
        await w.oracles.unchanged(pc, () => pc.createAnswer());
      } else {
        let offer: { type: "offer"; sdp: string } | undefined;
        await w.oracles.unchanged(pc, async () => {
          offer = (await pc.createOffer()) as never;
        });
        w.oracles.offerCapability(pc, offer!);
        w.saved.set(pc, offer!);
      }
    },
  },
  applyStale: {
    weight: 1,
    applies: ({ pc, other }, w) => w.saved.has(pc) && stable(pc, other),
    run: async ({ pc, other }, w) => {
      // 保存しておいた offer の適用は受理されるか、何も変えずに拒否される。
      const offer = w.saved.get(pc);
      w.saved.delete(pc);
      if (!offer || !stable(pc, other)) return;
      await w.c.setLocal(pc, offer, { mayReject: true });
      if (pc.signalingState === "have-local-offer") {
        await w.c.setRemote(other, pc.localDescription, { mayReject: true });
      }
    },
  },
  // #356: SSRC も RID もない m-line で、相手のストリームが SSRC を切り替え、旧 SSRC の
  // 遅延パケットが続く (どの signaling state でも。保留中の交渉と重なる)。
  remoteSsrcSwitch: {
    weight: 2,
    applies: ({ pc }) => ssrcLessReceivers(pc).length > 0,
    draw: (rng, { pc }) => ({
      index: pickIndex(rng, pc, ssrcLessReceivers(pc)),
      withMid: rng.chance(0.5),
      late: rng.chance(0.7),
    }),
    run: async ({ pc }, w, { index, withMid, late }) => {
      const t = byIndex(pc, index);
      if (!t || !ssrcLessReceivers(pc).includes(t)) return;
      w.c.note(switchRemoteSsrc(pc, t, { withMid: !!withMid, late: !!late }));
      assertNegotiationInvariants(pc);
    },
  },
  // #356 3.12: simulcast の m-line に、その transport と別 transport から RID パケットが届く
  // (どの signaling state でも)。識別子はパケットの RTP session の中でだけ解決する。
  remoteRidPacket: {
    weight: 6,
    applies: ({ pc }) => ridReceivers(pc).length > 0,
    draw: (rng, { pc }) => ({
      index: pickIndex(rng, pc, ridReceivers(pc)),
      withMid: rng.chance(0.5),
    }),
    run: async ({ pc }, w, { index, withMid }) => {
      const t = byIndex(pc, index);
      if (!t || !ridReceivers(pc).includes(t)) return;
      w.c.note(injectRidPacket(pc, t, { withMid: !!withMid }));
      assertNegotiationInvariants(pc);
    },
  },
  trickle: {
    weight: 1,
    applies: ({ pc, other }) =>
      !!pc.remoteDescription &&
      /^a=candidate:/m.test(other.localDescription?.sdp ?? ""),
    draw: (rng) => ({
      twice: rng.chance(0.5),
      end: rng.chance(0.3),
      existing: rng.chance(0.25),
    }),
    run: async ({ pc, other }, w, { twice, end, existing }) => {
      // 相手の候補を元に、同じ generation の新しい候補 (別 port) か、description に
      // ある候補そのもの (existing) を (重複を含めて) trickle し、ときどき
      // end-of-candidates を送る。
      const sections = (other.localDescription?.sdp ?? "").split(/(?=^m=)/m);
      for (const section of sections.slice(1)) {
        const mid = section.match(/^a=mid:(\S+)/m)?.[1];
        const line = section.match(/^a=(candidate:[^\r\n]+)/m)?.[1];
        if (!mid || !line) continue;
        const parts = line.split(" ");
        if (!existing) {
          parts[0] = `${parts[0]}9`;
          parts[5] = String(40000 + ++w.created);
        }
        const candidate = parts.join(" ");
        for (let i = twice ? 2 : 1; i > 0; i--) {
          await w.c.addCandidate(
            pc,
            { candidate, sdpMid: mid },
            { mayReject: true },
          );
        }
        if (end) {
          await w.c.addCandidate(
            pc,
            { candidate: "", sdpMid: mid },
            { mayReject: true },
          );
        }
        return;
      }
    },
  },
};

/**
 * Act: deliver `from`'s local description to `to`, rewritten on the wire by
 * `name` (`model/wireMutations.ts`). A rewrite that remaps a key of `to`'s current
 * session must be rejected; any other may be accepted, or rejected without a
 * change. After a rejection the original description is delivered.
 */
async function deliver(
  w: World,
  from: RTCPeerConnection,
  to: RTCPeerConnection,
  name: string,
) {
  const description = from.localDescription!;
  const mutation = WIRE_MUTATIONS[name];
  const current = to.currentRemoteDescription?.sdp;
  // final answer を書き換えると answerer は自分の answer と違う session を持ち続ける
  // (実在の peer 同士では起きない)。final answer には同じ session を表す書き換えだけを使う。
  const skip =
    (mutation.renegotiation && !current) ||
    (description.type === "answer" && !mutation.same);
  let sdp = skip ? description.sdp : mutation.apply(description.sdp);
  const remaps =
    !!current &&
    remapsCurrentKeys(sdp, {
      remote: current,
      local: to.currentLocalDescription?.sdp,
    });
  if (mutation.remapOnly && !remaps) sdp = description.sdp;
  if (sdp === description.sdp) {
    w.c.note(`  ${name} does not apply: delivered as created`);
    await w.c.setRemote(to, description);
    return;
  }
  if (mutation.same) w.c.equivalent(sdp, description.sdp);
  // current の payload type や header extension ID を付け替える書き換えは
  // 適用前に拒否される (RFC 3264 / RFC 8285)。他は受理か、何も変えない拒否。
  const rewritten = { type: description.type, sdp };
  const error = await w.c.setRemote(
    to,
    rewritten,
    remaps ? { rejects: "InvalidModificationError" } : { mayReject: true },
  );
  if (error) await w.c.setRemote(to, description);
}

/** Arrange: the peers of a scene, observed by the oracles. */
async function arrange(
  c: NegotiationCase,
  start: Start,
  bundleCandidates: BundleCandidates = "legacy",
  pairing: TransceiverPairing = "standard",
  bundle: ModelBundlePolicy = "max-bundle",
  simulcast = false,
  asymmetric = false,
): Promise<World & Peers2> {
  const oracles = new ModelOracles(c);
  const config = { ...modelConfig(pairing, bundle), bundleCandidates };
  let a: RTCPeerConnection;
  let b: RTCPeerConnection;
  const configB = {
    ...(asymmetric ? asymmetricModelConfig : modelConfig)(pairing, bundle),
    bundleCandidates,
  };
  if (start !== "connected") {
    ({ a, b } = await c.given(createPeerPair(config, configB)));
    oracles.application(
      a.addTransceiver(new MediaStreamTrack({ kind: "video" }), {
        direction: "sendrecv",
      }),
    );
    if (start === "unnegotiated") {
      oracles.channel(a.createDataChannel("dc0"), a);
    }
  } else {
    const scope = await c.given(createDuplexSession(config, configB));
    ({ a, b } = scope);
    oracles.application(scope.aVideo);
    oracles.application(scope.bVideo);
    oracles.channel(scope.aChannel, a);
    oracles.channel(scope.bChannel, b);
  }
  let simulcastSender: RTCRtpTransceiver | undefined;
  if (simulcast) {
    simulcastSender = a.addTransceiver(
      new MediaStreamTrack({ kind: "video" }),
      {
        direction: "sendonly",
        sendEncodings: [{ rid: "high" }, { rid: "low" }],
      },
    );
    oracles.application(simulcastSender);
  }
  oracles.watch(a, b);
  if (simulcast && start === "connected") {
    // 接続済みのシーンは simulcast の m-line も交渉済みで始める (RID の操作が引けるように)。
    await c.offer(a);
    await c.answer(b);
  }
  c.note(
    `start: ${start} (bundleCandidates: ${bundleCandidates}${pairing === "standard" ? "" : `, ${pairing}`}${bundle === "max-bundle" ? "" : `, bundlePolicy ${bundle}`}${simulcast ? ", simulcast" : ""}${asymmetric ? ", asymmetric b" : ""})`,
  );
  return {
    c,
    oracles,
    saved: new Map(),
    addTracked: new WeakSet(),
    created: 0,
    a,
    b,
    simulcast,
    simulcastSender,
  };
}
type Peers2 = { a: RTCPeerConnection; b: RTCPeerConnection };

const peersOf = (w: Peers2, side: Side): Peers =>
  side === "a" ? { pc: w.a, other: w.b } : { pc: w.b, other: w.a };

/**
 * Act: run a scene. A fixed scene fails on an operation that does not apply;
 * a scene replayed while shrinking (`lenient`) skips it.
 */
export async function runScene(
  c: NegotiationCase,
  scene: Scene,
  { lenient = false } = {},
) {
  const w = await arrange(
    c,
    scene.start,
    scene.bundleCandidates,
    scene.pairing,
    scene.bundle,
    scene.simulcast,
    scene.asymmetric,
  );
  for (const [index, [side, name, args = {}]] of scene.ops.entries()) {
    const peers = peersOf(w, side);
    const step = STEPS[name];
    if (!step.applies(peers, w)) {
      if (!lenient) {
        throw new Error(`op ${index + 1}: ${side} ${name} does not apply`);
      }
      c.note(`op ${index + 1}: ${side} ${name} (skipped: not applicable)`);
      continue;
    }
    c.note(`op ${index + 1}: ${side} ${name} ${JSON.stringify(args)}`);
    await step.run(peers, w, args);
  }
  await w.oracles.finish();
}

/** Act: draw `steps` operations from `seed` and run them, recording them in `scene`. */
export async function generateScene(
  c: NegotiationCase,
  seed: number,
  steps: number,
  scene: Scene,
) {
  const rng = seededRandom(seed);
  scene.start = rng.pick([
    "connected",
    "connected",
    "connected",
    "unnegotiated",
    "media",
  ] as const);
  // seed の乱数列を変えず、偶数 seed で compatible を選ぶ。
  if (seed % 2 === 0) scene.bundleCandidates = "compatible";
  // Pairing uses a separate stream so it does not shift the operations.
  if (seededRandom(seed ^ 0x816).chance(0.25)) scene.pairing = "byKind";
  // The bundle axis has its own stream too (several RTP sessions, #356).
  const bundleRng = seededRandom(seed ^ 0x356);
  if (bundleRng.chance(0.3)) {
    scene.bundle = bundleRng.pick(["disable", "max-compat"] as const);
  }
  // The simulcast axis has its own stream as well (RID routing, #356 3.12).
  if (seededRandom(seed ^ 0x3512).chance(0.3)) scene.simulcast = true;
  // So has the asymmetric axis (peer b configured in another codec form).
  if (seededRandom(seed ^ 0x818).chance(0.25)) scene.asymmetric = true;
  const w = await arrange(
    c,
    scene.start,
    scene.bundleCandidates,
    scene.pairing,
    scene.bundle,
    scene.simulcast,
    scene.asymmetric,
  );
  for (let index = 1; index <= steps; index++) {
    const side: Side = rng.chance(0.5) ? "a" : "b";
    const peers = peersOf(w, side);
    const choices = Object.entries(STEPS).filter(([, s]) =>
      s.applies(peers, w),
    );
    const total = choices.reduce((sum, [, s]) => sum + s.weight, 0);
    let point = rng.next() * total;
    const [name, step] =
      choices.find(([, s]) => (point -= s.weight) < 0) ?? choices.at(-1)!;
    const args = step.draw?.(rng, peers, w) ?? {};
    scene.ops.push([
      side,
      name,
      ...(Object.keys(args).length ? [args] : []),
    ] as Op);
    c.note(`op ${index}: ${side} ${name} ${JSON.stringify(args)}`);
    await step.run(peers, w, args);
  }
  await w.oracles.finish();
}

/**
 * Shrink a failing scene: drop one operation at a time (last first) while
 * the scene still fails; returns the smallest failing scene found within
 * `budget` ms.
 */
export async function shrinkScene(
  name: string,
  meta: CaseMeta,
  scene: Scene,
  budget: number,
) {
  const deadline = Date.now() + budget;
  let ops = scene.ops;
  const fails = async (candidate: Op[]) => {
    const c = new NegotiationCase(`${name} (shrinking)`, meta);
    return c
      .run(() => runScene(c, { ...scene, ops: candidate }, { lenient: true }))
      .then(
        () => false,
        () => true,
      );
  };
  for (let i = ops.length - 1; i >= 0 && Date.now() < deadline; i--) {
    const candidate = ops.filter((_, j) => j !== i);
    if (await fails(candidate)) ops = candidate;
  }
  return { ...scene, ops };
}
