import {
  MediaStreamTrack,
  type RTCPeerConnection,
  type RTCRtpTransceiver,
} from "../../src";
import {
  type CaseMeta,
  type NegotiationCase,
  negotiationCase,
} from "../negotiation/harness/negotiationCase";
import {
  createDuplexSession,
  createPeerPair,
  createSplitOffer,
} from "../negotiation/harness/negotiationTransactionUtils";
import { type SeededRandom, seededRandom } from "./propertyUtils";

/**
 * Traffic property of the negotiation transaction, separate from the episode
 * fuzzer and the scenario properties: every stream and DataChannel the peers
 * negotiated carries traffic after every operation (`c.expectTraffic()` of
 * the case harness, run by `traffic: true` after each description operation
 * and after the body). Its fixed scenes are the deterministic cases of
 * `trafficScenes.ts`; `runTrafficEpisode` draws the random scenes from the
 * operations below.
 */
type Body<R> = (c: NegotiationCase, row: R) => Promise<void>;

/** Register a fixed scene of the traffic property (a case with `traffic: true`). */
export function trafficScene(
  name: string,
  meta: CaseMeta,
  body: (c: NegotiationCase) => Promise<void>,
) {
  negotiationCase(name, { ...meta, traffic: true }, body);
}

/** Register a fixed scene per row (`$key` in the name is the row's value). */
trafficScene.for =
  <R extends object>(rows: readonly R[]) =>
  (name: string, meta: CaseMeta, body: Body<R>) =>
    negotiationCase.for(rows)(name, { ...meta, traffic: true }, body);

type World = {
  c: NegotiationCase;
  rng: SeededRandom;
  /** A counter for labels of created tracks and channels. */
  created: number;
};
type Step = {
  name: string;
  weight: number;
  /** Whether `pc` (with the other peer `other`) can take this step now. */
  applies: (pc: RTCPeerConnection, other: RTCPeerConnection) => boolean;
  /** Run it; returns what it did for the operation log. */
  run: (
    w: World,
    pc: RTCPeerConnection,
    other: RTCPeerConnection,
  ) => Promise<string>;
};

const stable = (...pcs: RTCPeerConnection[]) =>
  pcs.every((pc) => pc.signalingState === "stable");
const offering = (pc: RTCPeerConnection) =>
  ["have-local-offer", "have-remote-pranswer"].includes(pc.signalingState);
const answering = (pc: RTCPeerConnection) =>
  ["have-remote-offer", "have-local-pranswer"].includes(pc.signalingState);
const kinds = ["audio", "video"] as const;
/** Transceivers on an m-line that are not stopped (the first one is the session's own). */
const negotiated = (pc: RTCPeerConnection) =>
  pc
    .getTransceivers()
    .filter((t, index) => index > 0 && t.mid != undefined && !t.stopped);
const bundled = (pc: RTCPeerConnection) =>
  pc.currentLocalDescription?.sdp
    .match(/^a=group:BUNDLE ([^\r\n]+)/m)?.[1]
    .split(" ") ?? [];

/** The operations a random scene draws from (the ones the fixed scenes use). */
const STEPS: Step[] = [
  {
    name: "addTrack",
    weight: 2,
    applies: (pc) => pc.getTransceivers().length < 6,
    run: async (w, pc) => {
      const kind = w.rng.pick(kinds);
      pc.addTransceiver(new MediaStreamTrack({ kind }), {
        direction: "sendrecv",
      });
      return `addTransceiver(${kind} track, sendrecv)`;
    },
  },
  {
    name: "addRecvonly",
    weight: 1,
    applies: (pc) => pc.getTransceivers().length < 6,
    run: async (w, pc) => {
      const kind = w.rng.pick(kinds);
      pc.addTransceiver(kind, { direction: "recvonly" });
      return `addTransceiver(${kind}, recvonly)`;
    },
  },
  {
    name: "dataChannel",
    weight: 1,
    applies: () => true,
    run: async (w, pc) => {
      const label = `dc${++w.created}`;
      pc.createDataChannel(label);
      return `createDataChannel(${label})`;
    },
  },
  {
    name: "attachTrack",
    weight: 1,
    applies: (pc, other) =>
      stable(pc, other) && negotiated(pc).some((t) => !t.sender.track),
    run: async (w, pc) => {
      const t = w.rng.pick(negotiated(pc).filter((t) => !t.sender.track));
      await t.sender.replaceTrack(new MediaStreamTrack({ kind: t.kind }));
      t.setDirection("sendrecv");
      return `replaceTrack(${t.mid}) + sendrecv`;
    },
  },
  {
    name: "direction",
    weight: 1,
    applies: (pc, other) => stable(pc, other) && negotiated(pc).length > 0,
    run: async (w, pc) => {
      const t: RTCRtpTransceiver = w.rng.pick(negotiated(pc));
      const direction = w.rng.pick([
        "sendrecv",
        "sendonly",
        "recvonly",
        "inactive",
      ] as const);
      t.setDirection(direction);
      return `direction(${t.mid}) = ${direction}`;
    },
  },
  {
    name: "stop",
    weight: 1,
    applies: (pc, other) => stable(pc, other) && negotiated(pc).length > 0,
    run: async (w, pc) => {
      const t = w.rng.pick(negotiated(pc));
      t.stop();
      return `stop(${t.mid})`;
    },
  },
  {
    name: "restartIce",
    weight: 1,
    applies: (pc, other) => stable(pc, other),
    run: async (_w, pc) => {
      pc.restartIce();
      return "restartIce()";
    },
  },
  {
    name: "offer",
    weight: 4,
    applies: (pc, other) => stable(pc, other),
    run: async (w, pc) => {
      const iceRestart = w.rng.chance(0.2);
      await w.c.offer(pc, { iceRestart });
      return `offer(${iceRestart ? "iceRestart" : ""})`;
    },
  },
  {
    name: "splitOffer",
    weight: 1,
    applies: (pc, other) =>
      stable(pc, other) &&
      negotiated(pc).some(
        (t) => bundled(pc).includes(t.mid!) && bundled(pc)[0] !== t.mid,
      ),
    run: async (w, pc, other) => {
      const mids = negotiated(pc)
        .map((t) => t.mid!)
        .filter((mid) => bundled(pc).includes(mid) && bundled(pc)[0] !== mid);
      const mid = w.rng.pick(mids);
      await w.c.setLocal(pc, await createSplitOffer(pc, mid));
      await w.c.setRemote(other, pc.localDescription);
      return `offer splitting ${mid} off BUNDLE`;
    },
  },
  {
    name: "replacementOffer",
    weight: 1,
    applies: (pc, other) => offering(pc) && answering(other),
    run: async (w, pc) => {
      const iceRestart = w.rng.chance(0.2);
      await w.c.offer(pc, { iceRestart });
      return `replacement offer(${iceRestart ? "iceRestart" : ""})`;
    },
  },
  {
    name: "pranswer",
    weight: 2,
    applies: (pc) => answering(pc),
    run: async (w, pc) => {
      await w.c.pranswer(pc);
      return "pranswer";
    },
  },
  {
    name: "answer",
    weight: 4,
    applies: (pc) => answering(pc),
    run: async (w, pc) => {
      await w.c.answer(pc);
      return "answer";
    },
  },
  {
    name: "rollback",
    weight: 2,
    applies: (pc) => offering(pc) || answering(pc),
    run: async (w, pc) => {
      await w.c.rollback(pc);
      return "rollback";
    },
  },
];

/**
 * A random scene: from a connected duplex session (or, one in three, two
 * peers before their first negotiation) run `steps` operations drawn by the
 * seed. The harness checks the invariants and the traffic property after
 * every description operation and the traffic and continuation at the end.
 */
export async function runTrafficEpisode(
  c: NegotiationCase,
  seed: number,
  steps: number,
) {
  const rng = seededRandom(seed);
  const w: World = { c, rng, created: 0 };
  let a: RTCPeerConnection;
  let b: RTCPeerConnection;
  if (rng.chance(1 / 3)) {
    ({ a, b } = await c.given(createPeerPair()));
    a.addTransceiver(new MediaStreamTrack({ kind: "video" }), {
      direction: "sendrecv",
    });
    a.createDataChannel("dc0");
    c.note("start: unnegotiated peers (a: video sendrecv + DataChannel)");
  } else {
    ({ a, b } = await c.given(createDuplexSession()));
    c.note("start: connected duplex session");
  }
  for (let index = 1; index <= steps; index++) {
    const [pc, other, side] = rng.chance(0.5)
      ? ([a, b, "a"] as const)
      : ([b, a, "b"] as const);
    const choices = STEPS.filter((step) => step.applies(pc, other));
    const total = choices.reduce((sum, step) => sum + step.weight, 0);
    let point = rng.next() * total;
    const step =
      choices.find((s) => (point -= s.weight) < 0) ?? choices.at(-1)!;
    c.note(`step ${index}: ${side} ${step.name}`);
    const done = await step.run(w, pc, other);
    c.note(`step ${index}: ${side} ${done}`);
  }
}
