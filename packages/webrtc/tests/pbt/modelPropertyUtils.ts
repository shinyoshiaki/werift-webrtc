import {
  MediaStreamTrack,
  type RTCPeerConnection,
  type RTCRtpTransceiver,
} from "../../src";
import {
  type CaseMeta,
  NegotiationCase,
} from "../negotiation/harness/negotiationCase";
import {
  createDuplexSession,
  createPeerPair,
  createSplitOffer,
} from "../negotiation/harness/negotiationTransactionUtils";
import { ModelOracles } from "./modelOracles";
import { type SeededRandom, seededRandom } from "./propertyUtils";

/**
 * Scenes of the model property: a start state and a list of operations
 * (data, so a failing scene can be shrunk and a regression written in a few
 * lines). `runScene` applies them through the case harness, which checks the
 * invariants, the traffic property and the oracles of `modelOracles.ts`
 * after every description operation; `generateScene` draws the operations
 * from a seed, one applicable operation at a time.
 */
export type Side = "a" | "b";
/**
 * `connected`: a duplex session (video both ways and a DataChannel);
 * `unnegotiated`: a sends video and has a DataChannel; `media`: a sends
 * video only (the first SCTP transport comes during a negotiation).
 */
export type Start = "connected" | "unnegotiated" | "media";
/** One operation: the peer that takes it, its name and the choices it made. */
export type Op = [Side, string, Record<string, unknown>?];
export type Scene = { start: Start; ops: Op[] };

type World = {
  c: NegotiationCase;
  oracles: ModelOracles;
  /** Offers created and not applied, per peer (for `applyStale`). */
  saved: Map<RTCPeerConnection, { type: "offer"; sdp: string }>;
  created: number;
};
type Peers = { pc: RTCPeerConnection; other: RTCPeerConnection };
type Step = {
  weight: number;
  applies: (p: Peers, w: World) => boolean;
  /** Draw the choices of the operation (stored in the Op, used on replay). */
  draw?: (rng: SeededRandom, p: Peers) => Record<string, unknown>;
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
const pickIndex = (
  rng: SeededRandom,
  pc: RTCPeerConnection,
  from: RTCRtpTransceiver[],
) => pc.getTransceivers().indexOf(rng.pick(from));

/** The operations a scene is made of. */
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
      stable(pc, other) && negotiated(pc).some((t) => !t.sender.track),
    draw: (rng, { pc }) => ({
      index: pickIndex(
        rng,
        pc,
        negotiated(pc).filter((t) => !t.sender.track),
      ),
    }),
    run: async ({ pc }, _w, { index }) => {
      const t = byIndex(pc, index);
      if (!t || t.stopping || t.sender.track) return;
      await t.sender.replaceTrack(new MediaStreamTrack({ kind: t.kind }));
      t.setDirection("sendrecv");
    },
  },
  direction: {
    weight: 1,
    applies: ({ pc, other }) => stable(pc, other) && negotiated(pc).length > 0,
    draw: (rng, { pc }) => ({
      index: pickIndex(rng, pc, negotiated(pc)),
      direction: rng.pick(["sendrecv", "sendonly", "recvonly", "inactive"]),
    }),
    run: async ({ pc }, _w, { index, direction }) => {
      const t = byIndex(pc, index);
      if (t && !t.stopping) t.setDirection(direction as "sendrecv");
    },
  },
  codecPreferences: {
    weight: 1,
    applies: ({ pc, other }) => stable(pc, other) && negotiated(pc).length > 0,
    draw: (rng, { pc }) => {
      const index = pickIndex(rng, pc, negotiated(pc));
      const codecs = pc.config.codecs[pc.getTransceivers()[index].kind] ?? [];
      return { index, codec: rng.pick(codecs.map((codec) => codec.mimeType)) };
    },
    run: async ({ pc }, _w, { index, codec }) => {
      const t = byIndex(pc, index);
      const codecs = (t && pc.config.codecs[t.kind]) ?? [];
      const chosen = codecs.filter((each) => each.mimeType === codec);
      if (t && !t.stopping && chosen.length) t.setCodecPreferences(chosen);
    },
  },
  stop: {
    weight: 1,
    applies: ({ pc, other }) => stable(pc, other) && negotiated(pc).length > 0,
    draw: (rng, { pc }) => ({ index: pickIndex(rng, pc, negotiated(pc)) }),
    run: async ({ pc }, _w, { index }) => {
      const t = byIndex(pc, index);
      if (t && !t.stopping) t.stop();
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
    applies: ({ pc, other }) => offering(pc) && answering(other),
    draw: (rng) => ({ iceRestart: rng.chance(0.2) }),
    run: async ({ pc }, w, { iceRestart }) => {
      await w.c.offer(pc, { iceRestart: !!iceRestart });
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
  trickle: {
    weight: 1,
    applies: ({ pc, other }) =>
      !!pc.remoteDescription &&
      /^a=candidate:/m.test(other.localDescription?.sdp ?? ""),
    draw: (rng) => ({ twice: rng.chance(0.5), end: rng.chance(0.3) }),
    run: async ({ pc, other }, w, { twice, end }) => {
      // 相手の候補を元に、同じ generation の新しい候補 (別 port) を (重複を含めて)
      // trickle し、ときどき end-of-candidates を送る。
      const sections = (other.localDescription?.sdp ?? "").split(/(?=^m=)/m);
      for (const section of sections.slice(1)) {
        const mid = section.match(/^a=mid:(\S+)/m)?.[1];
        const line = section.match(/^a=(candidate:[^\r\n]+)/m)?.[1];
        if (!mid || !line) continue;
        const parts = line.split(" ");
        parts[0] = `${parts[0]}9`;
        parts[5] = String(40000 + ++w.created);
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

/** Arrange: the peers of a scene, observed by the oracles. */
async function arrange(
  c: NegotiationCase,
  start: Start,
): Promise<World & Peers2> {
  const oracles = new ModelOracles(c);
  let a: RTCPeerConnection;
  let b: RTCPeerConnection;
  if (start !== "connected") {
    ({ a, b } = await c.given(createPeerPair()));
    oracles.application(
      a.addTransceiver(new MediaStreamTrack({ kind: "video" }), {
        direction: "sendrecv",
      }),
    );
    if (start === "unnegotiated") {
      oracles.channel(a.createDataChannel("dc0"), a);
    }
  } else {
    const scope = await c.given(createDuplexSession());
    ({ a, b } = scope);
    oracles.application(scope.aVideo);
    oracles.application(scope.bVideo);
    oracles.channel(scope.aChannel, a);
    oracles.channel(scope.bChannel, b);
  }
  oracles.watch(a, b);
  c.note(`start: ${start}`);
  return { c, oracles, saved: new Map(), created: 0, a, b };
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
  const w = await arrange(c, scene.start);
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
  const w = await arrange(c, scene.start);
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
    const args = step.draw?.(rng, peers) ?? {};
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
