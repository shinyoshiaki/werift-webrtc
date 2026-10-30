import { createHook } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";

import type { Candidate } from "../../../../ice/src/candidate";
import {
  createLocalStunServer,
  createSilentUdpServer,
} from "../../../../ice/tests/utils";
import {
  MediaStreamTrack,
  type RTCDataChannel,
  type RTCIceServer,
  RTCPeerConnection,
} from "../../../src";
import { Event } from "../../../src/imports/common";
import {
  gcFunction,
  type MemorySample,
  sampleMemory,
} from "../../memleak/heapUtils";
import {
  type CaseMeta,
  NegotiationCase,
  type Observer,
} from "../../negotiation/harness/negotiationCase";
import {
  arrangeCloseTimingOperation,
  CLOSE_TIMING_OPERATIONS,
  type CloseTimingOperation,
  closeAfter,
  createDuplexSession,
  createLocalTurnIceServer,
  createPeerPair,
  heldTransports,
  holdDtlsStart,
  releaseContinuationRecords,
  waitForDtlsHandshake,
} from "../../negotiation/harness/negotiationTransactionUtils";
import {
  generateScene,
  modelConfig,
  type Op,
  runScene,
  type Scene,
  type Side,
  STEPS,
} from "../model/generator";
import { ModelOracles } from "../model/oracles";
import { type SeededRandom, seededRandom } from "../shared/random";

/**
 * Arrange and measurement of the leak property (`negotiationLeakProperty.test.ts`):
 * - L1 (retention after close): `LeakTracker` holds every object a scene
 *   created through a `WeakRef`; after close and GC none may survive.
 * - L2 (OS resources after close): `activeResources` counts
 *   `process.getActiveResourcesInfo()` by type; after close no type may
 *   exceed its count from before the scene.
 * - L3 (growth inside a session): `leakFootprint(pc)` reads the sizes of the
 *   internal tables, lists and subscriptions of a peer (test-only reads of
 *   internal fields, like `assertNegotiationInvariants`).
 * Every check is deterministic: no heap slope or statistical threshold.
 */

/** Why the leak property cannot run on this Node (undefined when it can). */
export function leakSupport() {
  if (typeof WeakRef !== "function") return "WeakRef needs Node 14.6+";
  if (typeof process.getActiveResourcesInfo !== "function") {
    return "process.getActiveResourcesInfo needs Node 17+";
  }
  return undefined;
}

// --- GC ---------------------------------------------------------------------

/**
 * Force full GCs with macrotasks between them, so finalizers, closures freed
 * by settled promises and timers that just fired are collected too.
 */
export async function collectGarbage(rounds = 3) {
  const gc = gcFunction();
  for (let i = 0; i < rounds; i++) {
    gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await delay(0);
  }
}

// --- L1: objects that must be collected after close -----------------------------

type Tracked = { ref: WeakRef<object>; kind: string; op: string };
/** An object that survived close and GC: its kind and the operation that created it. */
export type Survivor = { kind: string; op: string };

/**
 * L1: records objects of a scene by `WeakRef` (never a strong reference),
 * with the operation they first appeared after.
 */
export class LeakTracker {
  private readonly tracked: Tracked[] = [];
  private readonly seen = new WeakSet<object>();
  /** The operation the next registered objects are attributed to. */
  op = "arrange";

  track(object: object | undefined | null, kind: string) {
    if (!object || this.seen.has(object)) return;
    this.seen.add(object);
    this.tracked.push({ ref: new WeakRef(object), kind, op: this.op });
  }

  /**
   * Register everything `pc` holds: itself, its transports (live, proposed,
   * pending-only, BUNDLE owners) with their ICE transports and agents, SCTP,
   * transceivers with sender, receiver and tracks, and DataChannels (created
   * by the application or announced by `datachannel`).
   */
  trackPeer(pc: RTCPeerConnection) {
    const internal = pc as unknown as PeerInternals;
    this.track(pc, "RTCPeerConnection");
    const transports = new Set([
      ...pc.dtlsTransports,
      ...(pc.signalingState === "closed" ? [] : heldTransports(pc)),
    ]);
    for (const transport of transports) {
      this.track(transport, "RTCDtlsTransport");
      this.track(transport.iceTransport, "RTCIceTransport");
      this.track(transport.iceTransport.connection, "ice Connection");
    }
    for (const transport of pc.iceTransports) {
      this.track(transport, "RTCIceTransport");
      this.track(transport.connection, "ice Connection");
    }
    const sctp = pc.sctpTransport;
    if (sctp) {
      this.track(sctp, "RTCSctpTransport");
      this.track(sctp.sctp, "SCTP association");
      for (const channel of Object.values(sctp.dataChannels)) {
        this.track(channel, "RTCDataChannel");
      }
    }
    for (const channel of internal.sctpManager.dataChannels) {
      this.track(channel, "RTCDataChannel");
    }
    for (const t of pc.getTransceivers()) {
      this.track(t, "RTCRtpTransceiver");
      this.track(t.sender, "RTCRtpSender");
      this.track(t.receiver, "RTCRtpReceiver");
      for (const track of t.receiver.tracks) {
        this.track(track, "remote MediaStreamTrack");
      }
    }
    for (const transport of internal.negotiation.inspect().createdTransports) {
      this.track(transport, "RTCDtlsTransport (created by negotiation)");
    }
  }

  get size() {
    return this.tracked.length;
  }

  /** Objects still alive (call after `collectGarbage`). */
  alive(): Survivor[] {
    return this.tracked
      .filter((entry) => entry.ref.deref() !== undefined)
      .map(({ kind, op }) => ({ kind, op }));
  }

  /**
   * Assert helper: collect garbage until every tracked object is gone or
   * `ms` passes (asynchronous cleanup after close: DTLS alert, SCTP ABORT,
   * a timer that holds a closure); returns the survivors.
   */
  async survivors(ms = 2000) {
    const deadline = Date.now() + ms;
    for (;;) {
      await collectGarbage();
      const alive = this.alive();
      if (!alive.length || Date.now() > deadline) return alive;
      await delay(50);
    }
  }
}

// --- L2: OS resources -------------------------------------------------------------

/** `process.getActiveResourcesInfo()` counted by type (`UDPWrap`, `TCPWrap`, `Timeout`, ...). */
export function activeResources() {
  const counts: Record<string, number> = {};
  for (const type of process.getActiveResourcesInfo()) {
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

/**
 * Where each live timer was created. `process.getActiveResourcesInfo()` only
 * counts timers, so a surplus one is reported with its creation stack to tell
 * a client's timer (TURN refresh, retransmission) from the test's own.
 */
const timerOrigins = new Map<
  number,
  { timer: WeakRef<object>; stack: string }
>();
createHook({
  init(asyncId, type, _trigger, resource) {
    if (type !== "Timeout") return;
    const stack = (new Error().stack ?? "")
      .split("\n")
      .slice(2)
      .filter(
        (line) =>
          !line.includes("node:internal") && !line.includes("leakProbe"),
      )
      .slice(0, 4)
      .map((line) => line.trim().replace(/^at /, ""))
      .join(" <- ");
    timerOrigins.set(asyncId, { timer: new WeakRef(resource), stack });
  },
  destroy(asyncId) {
    timerOrigins.delete(asyncId);
  },
}).enable();

/** Creation stacks of the timers that keep the event loop alive, grouped. */
export function liveTimerOrigins() {
  const grouped = new Map<string, number>();
  for (const { timer, stack } of timerOrigins.values()) {
    const resource = timer.deref() as { hasRef?: () => boolean } | undefined;
    if (!resource?.hasRef?.()) continue;
    grouped.set(stack, (grouped.get(stack) ?? 0) + 1);
  }
  return [...grouped].map(([stack, count]) => `${count}x ${stack}`);
}

/** The resource types with more instances than in `before`, by how many. */
export function resourceExcess(
  before: Record<string, number>,
  after = activeResources(),
) {
  const excess: Record<string, number> = {};
  for (const [type, count] of Object.entries(after)) {
    if (count > (before[type] ?? 0)) excess[type] = count - (before[type] ?? 0);
  }
  return excess;
}

/**
 * Assert helper: poll until no resource type exceeds `before` (sockets and
 * timers that close asynchronously after `close()`), at most `ms`; returns
 * what is still in excess.
 */
export async function leftoverResources(
  before: Record<string, number>,
  ms = 2000,
  allowance: () => Record<string, number> = () => ({}),
) {
  const deadline = Date.now() + ms;
  for (;;) {
    const allowed = { ...before };
    for (const [type, count] of Object.entries(allowance())) {
      allowed[type] = (allowed[type] ?? 0) + count;
    }
    const excess = resourceExcess(allowed);
    if (!Object.keys(excess).length || Date.now() > deadline) return excess;
    await delay(50);
  }
}

// --- L3: structural size of a session -------------------------------------------

type PeerInternals = {
  sdpManager: { seenMid: Set<string> } & Record<string, unknown>;
  transceiverManager: Record<string, unknown>;
  sctpManager: { dataChannels: object[] } & Record<string, unknown>;
  secureManager: Record<string, unknown>;
  negotiation: {
    resources: {
      remoteCreated: Set<unknown>;
      displaced: Set<unknown>;
      prepared: Map<string, unknown>;
      pendingOnly: Set<unknown>;
      owners: Set<unknown>;
      emittedCandidates: Set<string>;
    };
    retiredRemoteUfrags: Set<string>;
    createdTransports: Set<unknown>;
    inspect: () => { createdTransports: object[] };
  };
  remoteCandidates: { queued: unknown[] } & Record<string, unknown>;
  router: {
    ssrcTable: Record<number, unknown>;
    ridTable: Record<string, unknown>;
    stagedSsrc: Map<number, unknown>;
    stagedRid: Map<string, unknown>;
    provisionalSsrc: Map<number, unknown>;
    learnedSsrcs: Set<number>;
    extIdUriMap: Record<number, string>;
  };
  topology: object;
  activation: object;
  remoteMedia: object;
  validator: object;
};
type IceTransportInternals = {
  localGenerations: Map<string, unknown>;
  heldCandidateEvents?: unknown[];
  iceGather: object;
  connection: {
    checkList: { localCandidate: Candidate; remoteCandidate: Candidate }[];
    localCandidates: unknown[];
    remoteCandidates: Candidate[];
    userHistory: Record<string, string>;
    protocols: object[];
    earlyChecks: unknown[];
  };
};
type EventInternals = {
  event: { stack: unknown[]; promiseStack: unknown[] };
};

/** A candidate by what identifies it within a generation. */
function candidateKey(candidate: Candidate) {
  const { host, port, transport, component, type, tcptype, ufrag } = candidate;
  return [host, port, transport, component, type, tcptype, ufrag].join("/");
}

/** Subscriptions of the `Event`s an object holds (own fields, and one level of plain objects). */
function subscriptions(object: object | undefined) {
  if (!object) return 0;
  let count = 0;
  const add = (value: unknown) => {
    if (value instanceof Event) {
      const { stack, promiseStack } = (value as unknown as EventInternals)
        .event;
      count += stack.length + promiseStack.length;
    }
  };
  for (const value of Object.values(object)) {
    add(value);
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
      for (const inner of Object.values(value)) add(inner);
    }
  }
  return count;
}

const lines = (sdp: string | undefined, pattern: RegExp) =>
  sdp?.match(pattern)?.length ?? 0;
const mLines = (sdp?: string) => lines(sdp, /^m=/gm);
const candidateLines = (sdp?: string) => lines(sdp, /^a=candidate:/gm);

/** The metrics of `leakFootprint` (keys are stable, values are counts). */
export type Footprint = Record<string, number>;

/**
 * L3: the structural size of a peer: tables, lists and subscriptions that
 * grow with the state a negotiation keeps. Read through internal fields
 * (test-only; no public API).
 */
export function leakFootprint(pc: RTCPeerConnection): Footprint {
  const internal = pc as unknown as PeerInternals;
  const { router, negotiation, sctpManager } = internal;
  const transceivers = pc.getTransceivers();
  const held = heldTransports(pc);
  const ice = new Set(
    [...held].map((t) => t.iceTransport as unknown as IceTransportInternals),
  );
  for (const t of pc.iceTransports) {
    ice.add(t as unknown as IceTransportInternals);
  }
  const sum = <T>(items: Iterable<T>, size: (item: T) => number) =>
    [...items].reduce((total, item) => total + size(item), 0);
  const sctp = pc.sctpTransport;
  const channels = new Set<object>([
    ...(sctpManager.dataChannels as object[]),
    ...Object.values(sctp?.dataChannels ?? {}),
  ]);
  const media = new Set<object>();
  for (const t of transceivers) {
    media.add(t);
    media.add(t.sender);
    media.add(t.receiver);
    for (const track of t.receiver.tracks) media.add(track);
    if (t.sender.track) media.add(t.sender.track);
  }
  return {
    transceivers: transceivers.length,
    dtlsTransports: pc.dtlsTransports.length,
    heldTransports: held.size,
    iceTransports: pc.iceTransports.length,
    "router.ssrcTable": Object.keys(router.ssrcTable).length,
    "router.ridTable": Object.keys(router.ridTable).length,
    "router.stagedSsrc": router.stagedSsrc.size,
    "router.stagedRid": router.stagedRid.size,
    "router.provisionalSsrc": router.provisionalSsrc.size,
    "router.learnedSsrcs": router.learnedSsrcs.size,
    "router.extIdUriMap": Object.keys(router.extIdUriMap).length,
    "ice.localGenerations": sum(ice, (t) => t.localGenerations.size),
    "ice.heldCandidateEvents": sum(
      ice,
      (t) => t.heldCandidateEvents?.length ?? 0,
    ),
    // 同じ候補の重複 (同じ description の再適用) は数えない。develop から同じ挙動で、
    // 次の restart で消える (ice の Connection.addRemoteCandidate の既知の制約)。
    // 交渉で知らされた candidate の pair。prflx は下の ice.prflxPairs で数える。
    "ice.checkList": sum(
      ice,
      (t) =>
        new Set(
          t.connection.checkList
            .filter((pair) => pair.remoteCandidate.type !== "prflx")
            .map(
              (pair) =>
                `${candidateKey(pair.localCandidate)}>${candidateKey(pair.remoteCandidate)}`,
            ),
        ).size,
    ),
    "ice.prflxPairs": sum(
      ice,
      (t) =>
        new Set(
          t.connection.checkList
            .filter((pair) => pair.remoteCandidate.type === "prflx")
            .map(
              (pair) =>
                `${candidateKey(pair.localCandidate)}>${candidateKey(pair.remoteCandidate)}`,
            ),
        ).size,
    ),
    "ice.localCandidates": sum(ice, (t) => t.connection.localCandidates.length),
    "ice.remoteCandidates": sum(
      ice,
      (t) =>
        new Set(
          t.connection.remoteCandidates
            .filter((c) => c.type !== "prflx")
            .map(candidateKey),
        ).size,
    ),
    "ice.prflxCandidates": sum(
      ice,
      (t) =>
        new Set(
          t.connection.remoteCandidates
            .filter((c) => c.type === "prflx")
            .map(candidateKey),
        ).size,
    ),
    "ice.userHistory": sum(
      ice,
      (t) => Object.keys(t.connection.userHistory).length,
    ),
    "ice.protocols": sum(ice, (t) => t.connection.protocols.length),
    "ice.earlyChecks": sum(ice, (t) => t.connection.earlyChecks.length),
    "sctp.dataChannels": sctpManager.dataChannels.length,
    "sctp.routedChannels": Object.keys(sctp?.dataChannels ?? {}).length,
    "negotiation.remoteCreated": negotiation.resources.remoteCreated.size,
    "negotiation.displaced": negotiation.resources.displaced.size,
    "negotiation.prepared": negotiation.resources.prepared.size,
    "negotiation.pendingOnly": negotiation.resources.pendingOnly.size,
    "negotiation.owners": negotiation.resources.owners.size,
    "negotiation.emittedCandidates":
      negotiation.resources.emittedCandidates.size,
    "negotiation.createdTransports": negotiation.createdTransports.size,
    "negotiation.retiredRemoteUfrags": negotiation.retiredRemoteUfrags.size,
    "sdp.seenMid": internal.sdpManager.seenMid.size,
    "remoteCandidates.queued": internal.remoteCandidates.queued.length,
    "description.mLines":
      mLines(pc.currentLocalDescription?.sdp) +
      mLines(pc.currentRemoteDescription?.sdp) +
      mLines(pc.pendingLocalDescription?.sdp) +
      mLines(pc.pendingRemoteDescription?.sdp),
    "description.candidates":
      candidateLines(pc.currentLocalDescription?.sdp) +
      candidateLines(pc.currentRemoteDescription?.sdp) +
      candidateLines(pc.pendingLocalDescription?.sdp) +
      candidateLines(pc.pendingRemoteDescription?.sdp),
    // 閉じた (rollback・BUNDLE 置換・close で停止した) DTLS transport を状態購読の
    // 表に残さない。
    "secure.dtlsStateDisposers": (
      internal.secureManager.dtlsStateDisposers as Map<unknown, unknown>
    ).size,
    "events.peer": sum(
      [
        pc,
        internal.sdpManager,
        internal.transceiverManager,
        internal.sctpManager,
        internal.secureManager,
        internal.negotiation,
        internal.remoteCandidates,
        internal.router,
        internal.topology,
        internal.activation,
        internal.remoteMedia,
        internal.validator,
      ],
      subscriptions,
    ),
    "events.media": sum(media, subscriptions),
    "events.dtls": sum(held, (t) => subscriptions(t) + subscriptions(t.dtls)),
    "events.ice": sum(
      ice,
      (t) =>
        // 実行中の start() の完了待ち (waitStart) は一時的なもの。ICE restart に追い越された
        // connect() は結果を待ち続ける (develop から。ice の Connection.checkListState の既知の制約)。
        subscriptions({ ...t, waitStart: undefined }) +
        subscriptions(t.iceGather) +
        subscriptions(t.connection) +
        sum(t.connection.protocols, subscriptions),
    ),
    "events.sctp": subscriptions(sctp) + subscriptions(sctp?.sctp),
    "events.channels": sum(channels, subscriptions),
    // プロセス全体の timer 数 (L2 と同じ計測)。両 peer に同じ値が入る。
    "process.timers": activeResources().Timeout ?? 0,
  };
}

/** The metrics of `after` that differ from `before` (`name: before -> after`). */
export function footprintChanges(before: Footprint, after: Footprint) {
  return Object.keys({ ...before, ...after })
    .filter((key) => before[key] !== after[key])
    .map((key) => `${key}: ${before[key]} -> ${after[key]}`);
}

/**
 * Assert helper: wait until the footprint of `pcs` stops changing (closes
 * that finish asynchronously, a DataChannel's stream reset), at most `ms`.
 */
export async function settledFootprint(pcs: RTCPeerConnection[], ms = 3000) {
  const read = () => pcs.map((pc) => leakFootprint(pc));
  const deadline = Date.now() + ms;
  let last = read();
  for (;;) {
    await delay(100);
    const next = read();
    const same = next.every(
      (footprint, i) => !footprintChanges(last[i], footprint).length,
    );
    if (same || Date.now() > deadline) return next;
    last = next;
  }
}

/**
 * The fewest timers alive across a short window: a transient timer (a STUN
 * retransmission, a consent check in flight) comes and goes, a leaked one
 * stays in every sample.
 */
async function quietTimerCount(samples = 6, gapMs = 40) {
  let fewest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < samples; i++) {
    fewest = Math.min(fewest, activeResources().Timeout ?? 0);
    await delay(gapMs);
  }
  return fewest;
}

/** Arrange helper: drop the strong references the negotiation harness keeps across a case. */
export function releaseHarness() {
  releaseContinuationRecords();
}

// --- scene runners ----------------------------------------------------------------

/**
 * An operation `close()` interrupts at the end of a scene (the operations of
 * `CLOSE_TIMING_OPERATIONS`), on the stable connected session: the peer
 * starts it and closes after `ticks` microtasks or one macrotask.
 */
export type Interrupt = {
  side: Side;
  operation: CloseTimingOperation;
  ticks: number | "macrotask";
};
/** A scene of the model property, optionally ended by an interrupting close. */
export type LeakScene = Scene & {
  interrupt?: Interrupt;
  /**
   * Close both peers where the operations left them (a pending offer or
   * pranswer and its proposal's transports included), without the
   * continuation or an interrupt.
   */
  asIs?: true;
};

/** Draw how a seeded scene ends: closed as it is, by an interrupting close, or after the continuation. */
export function drawEnding(
  rng: SeededRandom,
): Pick<LeakScene, "asIs" | "interrupt"> {
  if (rng.chance(0.3)) return { asIs: true };
  if (rng.chance(0.4)) return {};
  return {
    interrupt: {
      side: rng.pick(["a", "b"] as const),
      operation: rng.pick(CLOSE_TIMING_OPERATIONS),
      ticks: rng.pick([0, 1, 2, 5, 20, "macrotask"] as const),
    },
  };
}

/**
 * Act: start `operation` on `pc` (after the description steps it needs,
 * which `other` provides) and close `pc` while it runs.
 */
async function interruptByClose(
  pc: RTCPeerConnection,
  other: RTCPeerConnection,
  { operation, ticks }: Interrupt,
) {
  const remoteOffer = async () => {
    await other.setLocalDescription(await other.createOffer());
    return other.localDescription!;
  };
  let run: () => Promise<unknown>;
  switch (operation) {
    case "createOffer":
      run = () => pc.createOffer();
      break;
    case "createAnswer":
      await pc.setRemoteDescription(await remoteOffer());
      run = () => pc.createAnswer();
      break;
    case "setLocalDescription(offer)": {
      const offer = await pc.createOffer({ iceRestart: true });
      run = () => pc.setLocalDescription(offer);
      break;
    }
    case "setLocalDescription(answer)": {
      await pc.setRemoteDescription(await remoteOffer());
      const answer = await pc.createAnswer();
      run = () => pc.setLocalDescription(answer);
      break;
    }
    case "setRemoteDescription(offer)": {
      const offer = await remoteOffer();
      run = () => pc.setRemoteDescription(offer);
      break;
    }
    case "setRemoteDescription(answer)": {
      await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
      await other.setRemoteDescription(pc.localDescription!);
      await other.setLocalDescription(await other.createAnswer());
      const answer = other.localDescription!;
      run = () => pc.setRemoteDescription(answer);
      break;
    }
    case "setRemoteDescription(glare offer)": {
      await pc.setLocalDescription(await pc.createOffer());
      const offer = await remoteOffer();
      run = () => pc.setRemoteDescription(offer);
      break;
    }
    case "setLocalDescription(rollback)":
      await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
      run = () => pc.setLocalDescription({ type: "rollback" });
      break;
    case "setRemoteDescription(rollback)":
      await pc.setRemoteDescription(await remoteOffer());
      run = () => pc.setRemoteDescription({ type: "rollback" });
      break;
    case "addIceCandidate": {
      const line = other.localDescription?.sdp.match(
        /^a=(candidate:[^\r\n]+)/m,
      )?.[1];
      const mid = pc.getTransceivers().find((t) => t.mid)?.mid ?? "0";
      run = () =>
        pc.addIceCandidate({
          candidate:
            line ?? "candidate:1 1 udp 2130706431 127.0.0.1 9 typ host",
          sdpMid: mid,
        });
      break;
    }
  }
  const work = run!().catch(() => undefined);
  await Promise.allSettled([work, closeAfter(pc, ticks)]);
}

/** What a closed scene leaves for the L1 / L2 checks (no reference to a peer). */
export type ClosedScene = {
  tracker: LeakTracker;
  scene: LeakScene;
  /** The rejection of the scene itself (its oracles), if any. */
  error?: Error;
};

const leakMeta: CaseMeta = { ref: "property: leak", traffic: true };

/**
 * Act: run `scene` (or draw `steps` operations from `seed` into it) through
 * the model property's runner, end it with `expectSessionContinues` and the
 * interrupting close, and let the harness close both peers. Every object the
 * peers hold is registered after each description operation (the position
 * of `c.observe()`), at the end and after the interrupt. The case, its
 * oracles and world stay inside this function: what it returns references
 * no peer.
 */
export async function runClosedScene(
  name: string,
  input:
    | { scene: LeakScene; lenient?: boolean }
    | { seed: number; steps: number },
): Promise<ClosedScene> {
  const tracker = new LeakTracker();
  const scene: LeakScene =
    "scene" in input ? input.scene : { start: "connected", ops: [] };
  let error: Error | undefined;
  {
    const c = new NegotiationCase(name, leakMeta);
    const observe = c.observe.bind(c);
    // 記述操作ごとのフック (c.observe と同じ位置) で両 peer の保持物を登録する。
    c.observe = (observer: Observer) =>
      observe({
        before: (pc) => observer.before(pc),
        after: async (step, before) => {
          await observer.after(step, before);
          for (const side of ["a", "b"]) {
            const pc = c.maybeNamed(side);
            if (pc) tracker.trackPeer(pc);
          }
        },
      });
    const note = c.note.bind(c);
    const trackBoth = () => {
      for (const side of ["a", "b"]) {
        const pc = c.maybeNamed(side);
        if (pc) tracker.trackPeer(pc);
      }
    };
    c.note = (step: string) => {
      note(step);
      // 開始状態ができた時点 (start:) と各操作の前に、それまでの保持物を登録する。
      if (step.startsWith("start:")) trackBoth();
      if (/^op \d+/.test(step)) {
        trackBoth();
        tracker.op = step.replace(/ \{\}$/, "");
      }
    };
    await c
      .run(async () => {
        if ("seed" in input) {
          await generateScene(c, input.seed, input.steps, scene);
          Object.assign(scene, drawEnding(seededRandom(input.seed + 0x5eed)));
        } else {
          await runScene(c, scene, { lenient: input.lenient });
        }
        trackBoth();
        if (scene.asIs) {
          // 継続確認をせず、操作列が残した状態 (pending の提案を含む) のまま閉じる。
          c.exempt(
            "the leak property closes the peers where the scene left them",
          );
          return;
        }
        await c.end();
        tracker.op = "expectSessionContinues";
        trackBoth();
        const interrupt = scene.interrupt;
        if (interrupt) {
          tracker.op = `interrupt ${JSON.stringify(interrupt)}`;
          const pc = c.named(interrupt.side);
          const other = c.named(interrupt.side === "a" ? "b" : "a");
          await interruptByClose(pc, other, interrupt);
          trackBoth();
        }
      })
      .catch((e: Error) => {
        error = e;
      });
  }
  releaseHarness();
  return { tracker, scene, error };
}

/** The L1 / L2 verdict of a closed scene (empty when nothing leaked). */
export async function closedLeaks(
  tracker: LeakTracker,
  resourcesBefore: Record<string, number>,
  /** Resources a fixture of the test (not the peers) holds, read at each poll. */
  allowance?: () => Record<string, number>,
) {
  const survivors = await tracker.survivors();
  const resources = await leftoverResources(resourcesBefore, 2000, allowance);
  const problems: string[] = [];
  const grouped = new Map<string, number>();
  for (const { kind, op } of survivors) {
    const key = `not collected: ${kind} (first seen after ${op})`;
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }
  for (const [key, count] of grouped) {
    problems.push(count > 1 ? `${key} x${count}` : key);
  }
  for (const [type, count] of Object.entries(resources)) {
    problems.push(`active resource left: ${type} +${count}`);
  }
  // 残った Timeout の生成元 (client の timer かテスト側の timer かを区別する)。
  if (resources.Timeout) {
    for (const origin of liveTimerOrigins()) {
      problems.push(`  live timer created at: ${origin}`);
    }
  }
  return problems;
}

/** Arrange + Act + measure: run a scene from scratch and return its L1 / L2 problems. */
export async function closedSceneLeaks(
  name: string,
  input: Parameters<typeof runClosedScene>[1],
) {
  await collectGarbage();
  const before = activeResources();
  const closed = await runClosedScene(name, input);
  const problems = await closedLeaks(closed.tracker, before);
  return {
    scene: closed.scene,
    error: closed.error,
    problems,
    tracked: closed.tracker.size,
  };
}

// --- L3: operation cycles inside one session --------------------------------------

type StepWorld = Parameters<(typeof STEPS)[string]["run"]>[1];
type StepPeers = Parameters<(typeof STEPS)[string]["run"]>[0];
/** Operations of a cycle: the model property's `STEPS` and the leak-only steps below. */
type CycleStep = {
  run: (
    p: StepPeers,
    w: StepWorld,
    args: Record<string, unknown>,
  ) => Promise<void>;
};

/** Leak-only operations (an application that closes what it opened). */
const LEAK_STEPS: Record<string, CycleStep> = {
  /** `pc` opens a DataChannel, the other peer gets it by `datachannel`, then `pc` closes it. */
  channelRoundTrip: {
    run: async ({ pc, other }, w) => {
      const label = `leak-dc${++w.created}`;
      const remote = new Promise<RTCDataChannel>((resolve) => {
        const { unSubscribe } = other.onDataChannel.subscribe((channel) => {
          if (channel.label !== label) return;
          unSubscribe();
          resolve(channel);
        });
      });
      const channel = pc.createDataChannel(label);
      const announced = await remote;
      await w.c.waitFor(
        () => channel.readyState === "open" && announced.readyState === "open",
        10_000,
      );
      channel.close();
      await w.c.waitFor(
        () =>
          channel.readyState === "closed" && announced.readyState === "closed",
        10_000,
      );
    },
  },
  /** `pc` stops the last transceiver a cycle added (index 2 or later). */
  stopAdded: {
    run: async ({ pc }) => {
      const added = pc
        .getTransceivers()
        .slice(2)
        .filter((t) => !t.stopping && !t.stopped);
      added.at(-1)?.stop();
    },
  },
};

/** A cycle template: operations from `stable` back to `stable` (`x` acts, `y` is the other peer). */
type CycleTemplate = {
  name: string;
  ops: (x: Side, y: Side, rng: SeededRandom) => Op[];
  /**
   * Metrics the cycle grows on purpose per repetition (application objects,
   * a new MID per added m-line), per peer side relative to `x`.
   */
  growth?: { x?: Footprint; y?: Footprint };
  /**
   * Used only by a fixed cycle (`LEAK_CYCLES`). Seeds never draw it, so
   * adding one keeps every seed's cycle (and its replay) unchanged.
   */
  fixedOnly?: true;
};

/**
 * The templates the seed composes a cycle of. Each starts and ends with both
 * peers stable on the connected session of `arrangeCycleSession`, which has
 * an added audio m-line (MID 2) to split from BUNDLE.
 */
export const CYCLE_TEMPLATES: CycleTemplate[] = [
  {
    name: "re-offer",
    ops: (x, y) => [
      [x, "offer", { iceRestart: false }],
      [y, "answer"],
    ],
  },
  {
    name: "ICE restart",
    ops: (x, y, rng) =>
      rng.chance(0.5)
        ? [
            [x, "restartIce"],
            [x, "offer", { iceRestart: false }],
            [y, "answer"],
          ]
        : [
            [x, "offer", { iceRestart: true }],
            [y, "answer"],
          ],
  },
  {
    name: "BUNDLE split and merge",
    ops: (x, y) => [
      [x, "splitOffer", { mid: "2" }],
      [y, "answer"],
      [x, "offer", { iceRestart: false }],
      [y, "answer"],
    ],
  },
  {
    name: "pranswer then final answer",
    ops: (x, y, rng) => [
      [x, "offer", { iceRestart: rng.chance(0.5) }],
      [y, "pranswer"],
      [y, "answer"],
    ],
  },
  {
    name: "replacement offer then rollback",
    ops: (x, y, rng) => [
      [x, "offer", { iceRestart: rng.chance(0.5) }],
      [x, "replacementOffer", { iceRestart: rng.chance(0.5) }],
      [x, "rollback"],
    ],
  },
  {
    name: "BUNDLE split offer rolled back on both sides",
    fixedOnly: true,
    ops: (x, y) => [
      [x, "splitOffer", { mid: "2" }],
      [y, "rollback"],
      [x, "rollback"],
    ],
  },
  {
    name: "glare",
    ops: (x) => [
      [x, "glare"],
      [x, "answer"],
    ],
  },
  {
    name: "remote DataChannel opened and closed",
    ops: (x) => [[x, "channelRoundTrip"]],
  },
  {
    name: "transceiver added, stopped and its m-line reused",
    ops: (x, y, rng) => [
      [x, "addTrack", { kind: rng.pick(["audio", "video"]) }],
      [x, "offer", { iceRestart: false }],
      [y, "answer"],
      [x, "stopAdded"],
      [x, "offer", { iceRestart: false }],
      [y, "answer"],
    ],
    // 追加した m-line は毎回新しい MID を持つ (使った MID は再利用しない、RFC 8843)。
    growth: { x: { "sdp.seenMid": 1 }, y: { "sdp.seenMid": 1 } },
  },
  {
    name: "trickle and end-of-candidates",
    ops: (x, y, rng) => [
      [x, "offer", { iceRestart: true }],
      [y, "answer"],
      [
        x,
        "trickle",
        {
          twice: rng.chance(0.5),
          end: rng.chance(0.5),
          existing: rng.chance(0.5),
        },
      ],
    ],
  },
];

/** A cycle: its templates and their operations (repeated identically). */
export type Cycle = {
  templates: string[];
  ops: Op[];
  growth: { a: Footprint; b: Footprint };
};

/** Draw a cycle of 1 to 3 templates from `seed`. */
export function drawCycle(seed: number): Cycle {
  const rng = seededRandom(seed);
  const count = 1 + Math.floor(rng.next() * 3);
  return composeCycle(
    [...Array(count)].map(
      () => rng.pick(CYCLE_TEMPLATES.filter((t) => !t.fixedOnly)).name,
    ),
    rng,
  );
}

/** A cycle of the named templates (sides drawn from `rng`). */
export function composeCycle(names: string[], rng = seededRandom(1)): Cycle {
  const growth = { a: {} as Footprint, b: {} as Footprint };
  const ops: Op[] = [];
  for (const name of names) {
    const template = CYCLE_TEMPLATES.find((t) => t.name === name);
    if (!template) throw new Error(`no cycle template ${name}`);
    const x: Side = rng.chance(0.5) ? "a" : "b";
    const y: Side = x === "a" ? "b" : "a";
    ops.push(...template.ops(x, y, rng));
    for (const [role, side] of [
      ["x", x],
      ["y", y],
    ] as const) {
      for (const [key, value] of Object.entries(
        template.growth?.[role] ?? {},
      )) {
        growth[side][key] = (growth[side][key] ?? 0) + value;
      }
    }
  }
  return { templates: names, ops, growth };
}

/** Timers a repetition may hold beyond those of the first two (see `BOUNDED_METRICS`). */
const TIMER_SLACK = 4;
/** How long a repetition's surplus state may take to go away (a transport's late close, a STUN query's timeout) before it counts as growth. */
const GROWTH_EXPIRY_MS = 8000;

/** The peer's possible check sources: its signaled host IPs × host ports. */
function prflxSources(t: IceTransportInternals) {
  const hosts = t.connection.remoteCandidates.filter((c) => c.type === "host");
  return (
    new Set(hosts.map((c) => c.host)).size *
    new Set(hosts.map((c) => c.port)).size
  );
}

function sumIce(
  pc: RTCPeerConnection,
  size: (t: IceTransportInternals) => number,
) {
  const ice = new Set(
    [...heldTransports(pc)].map(
      (t) => t.iceTransport as unknown as IceTransportInternals,
    ),
  );
  for (const t of pc.iceTransports) {
    ice.add(t as unknown as IceTransportInternals);
  }
  return [...ice].reduce((total, t) => total + size(t), 0);
}

function prflxSourceBound(pc: RTCPeerConnection) {
  return sumIce(pc, prflxSources);
}

/**
 * Metrics allowed to change between repetitions, each with the upper bound
 * that keeps it from growing without limit. Every other metric must equal its
 * value after the second repetition (a lower value becomes the reference).
 *
 * State kept on purpose that P2 sees as steady (each with its bound):
 * - `sdp.seenMid`: one per m-line the application adds (the cycle declares
 *   it); a MID is never reused in a session (RFC 8843).
 * - ICE `userHistory`: current, replaced and staged credentials (3 per
 *   agent), so a check sent before the peer applied a restart is answered.
 * - ICE `localGenerations`: the latest created offer and answer and the
 *   applied one, so applying a created description again restarts to it.
 * - routes of SSRCs a later answer no longer lists, stopped transceivers:
 *   the SSRCs and m-lines negotiated (as in develop; the cycles keep SSRCs).
 * - sent packets awaiting transport-cc feedback: 5 s and 32768 per sender
 *   (`senderBWE.ts`); the cycles carry no RTP, `senderBWE.test.ts` checks it.
 */
export const BOUNDED_METRICS: Record<
  string,
  (context: { pc: RTCPeerConnection; early: number[] }) => number
> = {
  // prflx は相手の check の送信元 (相手のインターフェース IP とソケットの port の組) から
  // 学習する。wildcard に bind したソケットは経路で送信元 IP が変わるので、どの組を学習
  // するかは check の順序で揺れる。restart で破棄され (ice の restart-generation テスト)、
  // 組の数を超えて増えることはない。
  "ice.prflxCandidates": ({ pc }) => prflxSourceBound(pc),
  "ice.prflxPairs": ({ pc }) =>
    sumIce(pc, (t) => prflxSources(t) * t.connection.protocols.length),
  // 退役した remote ufrag は遅れて届く callback を拒否するために最大 64 個保持する。
  "negotiation.retiredRemoteUfrags": () => 64,
  // 周期的な timer (RTCP、consent、SCTP heartbeat) は、流れた traffic と、ICE 再 gather の
  // STUN 問い合わせの timeout (数秒で消える) によって数が揺れる。最初の 2 回の最大に
  // 余裕 (TIMER_SLACK) を足したものを上限にする。残り続ける増加だけを粗く捕まえ、
  // close 後の timer は L2 が決定的に判定する。
  "process.timers": ({ early }) => Math.max(...early) + TIMER_SLACK,
};

/**
 * Metrics of what a pending description holds: 0 whenever both peers are
 * stable (a commit or rollback releases them).
 */
export const STABLE_ZERO_METRICS = [
  "router.stagedSsrc",
  "router.stagedRid",
  "router.provisionalSsrc",
  "negotiation.remoteCreated",
  "negotiation.displaced",
  "negotiation.prepared",
  "negotiation.pendingOnly",
  "negotiation.owners",
  "negotiation.createdTransports",
  "remoteCandidates.queued",
  "ice.heldCandidateEvents",
];

/** The footprint of both peers after each repetition of a cycle. */
export type CycleRun = {
  cycle: Cycle;
  footprints: { a: Footprint; b: Footprint }[];
  /** Bounds of `BOUNDED_METRICS` for each peer. */
  bounds: { a: Footprint; b: Footprint };
};

/**
 * Oracles that keep nothing (P3 and memleak): the cycle templates only
 * register application objects and finish.
 */
function bareOracles() {
  return {
    application: () => {},
    channel: () => {},
    watch: () => {},
    finish: async () => {},
  } as unknown as ModelOracles;
}

/**
 * Arrange: the connected session of the model property (`modelConfig`,
 * video both ways and a DataChannel) with an added audio m-line, observed by
 * the model oracles.
 */
async function arrangeCycleSession(c: NegotiationCase, observe: boolean) {
  // observe = false (P3 / memleak): オラクルの記録 (イベント・候補の履歴) は周期ごとに
  // 増えるテスト側の保持なので、heap を見るときは付けない (application の登録だけ受ける)。
  const oracles = observe ? new ModelOracles(c) : bareOracles();
  // STUN server なし: サーバーへの問い合わせの timer (最長 5 s) が周期ごとの timer 数を揺らさない。
  const scope = await c.given(
    createDuplexSession({ ...modelConfig(), iceServers: [] }),
  );
  const { a, b } = scope;
  oracles.application(scope.aVideo);
  oracles.application(scope.bVideo);
  oracles.channel(scope.aChannel, a);
  oracles.channel(scope.bChannel, b);
  if (observe) oracles.watch(a, b);
  const w: StepWorld = { c, oracles, saved: new Map(), created: 0 } as never;
  const audio = a.addTransceiver(new MediaStreamTrack({ kind: "audio" }), {
    direction: "sendrecv",
  });
  oracles.application(audio);
  await c.negotiate(a);
  return { w, a, b, oracles };
}

/**
 * Act: repeat `cycle` `repetitions` times on one session and record the
 * settled footprint of both peers after each repetition (after the traffic
 * of every negotiated stream settled). Runs inside a case, so every
 * description operation keeps the invariants, the traffic and the oracles.
 */
export async function runCycles(
  c: NegotiationCase,
  cycle: Cycle,
  repetitions: number,
): Promise<CycleRun> {
  const session = await openCycleSession(c, cycle);
  const { a, b } = session;
  const footprints: CycleRun["footprints"] = [];
  const measure = async () => {
    const [fa, fb] = await settledFootprint([a, b]);
    // timer 数は計測の瞬間に揺れる。短時間の最小値で、増え続けるものだけを見る。
    fa["process.timers"] = fb["process.timers"] = await quietTimerCount();
    return { a: fa, b: fb };
  };
  const boundsOf = () => {
    const bounds = { a: {} as Footprint, b: {} as Footprint };
    for (const [key, bound] of Object.entries(BOUNDED_METRICS)) {
      for (const [side, pc] of [
        ["a", a],
        ["b", b],
      ] as const) {
        const early = footprints.slice(0, 2).map((f) => f[side][key]);
        bounds[side][key] = bound({ pc, early });
      }
    }
    return bounds;
  };
  for (let round = 1; round <= repetitions; round++) {
    await session.repeat();
    footprints.push(await measure());
    if (round < 3) continue;
    // 解放が遅れているだけのもの (別の transport の close、STUN 問い合わせの timeout) は
    // 数秒で消える。増加が見えたら、消えるのを待ってから判定する。
    const deadline = Date.now() + GROWTH_EXPIRY_MS;
    while (Date.now() < deadline) {
      const grown = cycleGrowth({
        cycle,
        footprints,
        bounds: boundsOf(),
      }).some((problem) =>
        new RegExp(`after cycle ${round}(,| exceeds)`).test(problem),
      );
      if (!grown) break;
      await delay(250);
      footprints[round - 1] = await measure();
    }
  }
  await session.finish();
  return { cycle, footprints, bounds: boundsOf() };
}

/**
 * Arrange: the session of `arrangeCycleSession`; `repeat()` runs `cycle`
 * once more (Act) and waits for the traffic of every negotiated stream to
 * settle, `finish()` runs the oracles' end-of-scene checks.
 */
export async function openCycleSession(
  c: NegotiationCase,
  cycle: Cycle,
  { observe = true } = {},
) {
  const { w, a, b, oracles } = await arrangeCycleSession(c, observe);
  let round = 0;
  return {
    a,
    b,
    async repeat() {
      round++;
      for (const [index, [side, name, args = {}]] of cycle.ops.entries()) {
        const peers = side === "a" ? { pc: a, other: b } : { pc: b, other: a };
        const step: CycleStep = STEPS[name] ?? LEAK_STEPS[name];
        c.note(
          `cycle ${round} op ${index + 1}: ${side} ${name} ${JSON.stringify(args)}`,
        );
        await step.run(peers, w, args);
      }
      if (a.signalingState !== "stable" || b.signalingState !== "stable") {
        throw new Error(`cycle ${round} did not return to stable`);
      }
      await c.expectTraffic({ final: true });
    },
    finish: () => oracles.finish(),
  };
}

/**
 * Act (P3): repeat `cycle` `repetitions` times and sample the memory after
 * a forced GC at the end of each repetition (`sampleMemory` of tests/memleak).
 * The session runs without the oracles' records (`observe: false`); the case
 * should check invariants only explicitly, since the invariants keep a
 * history of every signalled candidate.
 */
export async function heapSamples(
  c: NegotiationCase,
  cycle: Cycle,
  repetitions: number,
) {
  const samples: MemorySample[] = [];
  const started = Date.now();
  const session = await openCycleSession(c, cycle, { observe: false });
  for (let round = 1; round <= repetitions; round++) {
    await session.repeat();
    await collectGarbage();
    samples.push(sampleMemory(round - 1, Date.now() - started));
  }
  return samples;
}

/**
 * Assert helper: from the second repetition on, every metric equals its
 * value after the second one plus the growth the cycle declares; a bounded
 * metric stays within its bound. Returns the differences.
 */
export function cycleGrowth({ cycle, footprints, bounds }: CycleRun) {
  const problems: string[] = [];
  for (const [round, footprint] of footprints.entries()) {
    for (const side of ["a", "b"] as const) {
      for (const key of STABLE_ZERO_METRICS) {
        if (footprint[side][key] !== 0) {
          problems.push(
            `${side} ${key} = ${footprint[side][key]} in stable after cycle ${round + 1}, expected 0`,
          );
        }
      }
    }
  }
  const base = footprints[1];
  if (!base) return problems;
  // 2 回目の値より小さくなるのは、2 回目の時点で解放が遅れていただけ (リークではない)。
  // その値を新しい基準にして、そこからの増加を見る。
  const reference = { a: { ...base.a }, b: { ...base.b } };
  for (const [round, footprint] of footprints.entries()) {
    if (round < 2) continue;
    for (const side of ["a", "b"] as const) {
      for (const [key, value] of Object.entries(footprint[side])) {
        if (key in bounds[side]) {
          if (value > bounds[side][key]) {
            problems.push(
              `${side} ${key} = ${value} after cycle ${round + 1} exceeds its bound ${bounds[side][key]}`,
            );
          }
          continue;
        }
        const growth = cycle.growth[side][key] ?? 0;
        const expected = reference[side][key] + (round - 1) * growth;
        if (value < expected) {
          reference[side][key] -= expected - value;
        } else if (value > expected) {
          problems.push(
            `${side} ${key} = ${value} after cycle ${round + 1}, expected ${expected} (after cycle 2: ${base[side][key]})`,
          );
        }
      }
    }
  }
  return problems;
}

/**
 * Act: an operation of `CLOSE_TIMING_OPERATIONS` (`arrangeCloseTimingOperation`)
 * overtaken by `close()` after `ticks`; both peers closed afterwards. Returns
 * the tracker only (no peer stays referenced by the caller's frame).
 */
async function runClosedOperation(
  operation: CloseTimingOperation,
  ticks: number | "macrotask",
) {
  const tracker = new LeakTracker();
  const { pc, run, close } = await arrangeCloseTimingOperation(operation);
  tracker.trackPeer(pc);
  tracker.op = operation;
  const work = run().catch(() => undefined);
  await Promise.allSettled([work, closeAfter(pc, ticks)]);
  // close に追い越された操作が後から作ったものも登録する。
  tracker.trackPeer(pc);
  await close();
  return tracker;
}

/** Arrange + Act + measure: the L1 / L2 problems of an operation overtaken by close. */
export async function closedOperationLeaks(
  operation: CloseTimingOperation,
  ticks: number | "macrotask",
) {
  await collectGarbage();
  const before = activeResources();
  const tracker = await runClosedOperation(operation, ticks);
  return closedLeaks(tracker, before);
}

/**
 * Act: a first negotiation whose DTLS server (`a`) holds its handshake
 * start, so the client (`b`) keeps retransmitting its first flight; both
 * peers are closed while it waits. Returns the tracker only.
 */
async function runClosedHandshake() {
  const tracker = new LeakTracker();
  const { a, b } = createPeerPair();
  a.addTransceiver("video", { direction: "sendrecv" });
  await a.setLocalDescription(await a.createOffer());
  const held = holdDtlsStart(a);
  await b.setRemoteDescription(a.localDescription!);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription!);
  await waitForDtlsHandshake(b.dtlsTransports[0]);
  // client は ICE の接続から 100 ms 後に最初の flight を送り、応答がないので再送を待つ。
  await delay(300);
  tracker.trackPeer(a);
  tracker.trackPeer(b);
  await Promise.allSettled([a.close(), b.close()]);
  held.release();
  return tracker;
}

/** Arrange + Act + measure: the L1 / L2 problems of closing during a DTLS handshake. */
export async function closedHandshakeLeaks() {
  await collectGarbage();
  const before = activeResources();
  const tracker = await runClosedHandshake();
  return closedLeaks(tracker, before);
}

/**
 * Act: a relay-only peer starts gathering from a local TURN server and is
 * closed after `wait` (ms, or one macrotask) while the allocation runs or
 * after it completed. Returns the tracker only.
 */
async function runClosedTurnGather(
  iceServers: RTCIceServer[],
  wait: number | "macrotask",
) {
  const tracker = new LeakTracker();
  const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: "relay" });
  pc.addTransceiver("audio");
  tracker.trackPeer(pc);
  const work = pc
    .setLocalDescription(await pc.createOffer())
    .catch(() => undefined);
  if (wait === "macrotask") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  } else {
    await delay(wait);
  }
  tracker.trackPeer(pc);
  await pc.close();
  await work;
  return tracker;
}

/**
 * Arrange + Act + measure: the L1 / L2 problems of closing a peer during
 * (or after) its TURN allocation. The TURN server is a fixture in this
 * process: the relay socket it keeps for the client's allocation until the
 * allocation's lifetime ends is the server's, not the peer's, and is not
 * counted (the client does not delete its allocation on close; see
 * `TurnProtocol.close` in packages/ice).
 */
export async function closedTurnGatherLeaks(wait: number | "macrotask") {
  const turn = await createLocalTurnIceServer();
  try {
    await collectGarbage();
    const before = activeResources();
    const tracker = await runClosedTurnGather(turn.iceServers, wait);
    const relaySockets = (
      turn.server as unknown as { relaySockets: Map<string, unknown> }
    ).relaySockets;
    // サーバーの relay socket の分 (close の後に届いた Allocate の分も) を除いて比べる。
    return await closedLeaks(tracker, before, () => ({
      UDPWrap: relaySockets.size,
    }));
  } finally {
    await turn.server.close();
  }
}

/**
 * Arrange + Act + measure: the L1 / L2 problems of closing a relay-only peer
 * while its TURN allocation waits on a server that never answers (the
 * allocation would otherwise retransmit until it times out).
 */
export async function closedSilentTurnLeaks() {
  const server = await createSilentUdpServer();
  try {
    await collectGarbage();
    const before = activeResources();
    const [host, port] = server.address;
    const tracker = await runClosedTurnGather(
      [{ urls: `turn:${host}:${port}`, username: "user", credential: "pass" }],
      50,
    );
    return await closedLeaks(tracker, before);
  } finally {
    await server.close();
  }
}

/**
 * Arrange (whole file): a STUN server in this process, which every peer that
 * names no ICE servers uses instead of the public default
 * (`stun.l.google.com`), so the L1 / L2 verdicts do not depend on the
 * network. It is addressed as `localhost`: a STUN query still resolves its
 * name first (the lookup that close() may overtake). Returns its cleanup.
 */
export async function useLocalStunServer() {
  const server = await createLocalStunServer("127.0.0.1");
  const [, port] = server.address!;
  const original = RTCPeerConnection.prototype.setConfiguration;
  RTCPeerConnection.prototype.setConfiguration = function (
    this: RTCPeerConnection,
    config: Parameters<RTCPeerConnection["setConfiguration"]>[0],
  ) {
    const iceServers = [{ urls: `stun:localhost:${port}` }];
    return original.call(this, { iceServers, ...config });
  } as RTCPeerConnection["setConfiguration"];
  return async () => {
    RTCPeerConnection.prototype.setConfiguration = original;
    await server.close();
  };
}
