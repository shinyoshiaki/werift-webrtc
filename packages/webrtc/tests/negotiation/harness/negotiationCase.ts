import { describe, expect, test, vi } from "vitest";

import {
  type MediaStreamTrack,
  type RTCDataChannel,
  type RTCDtlsTransport,
  RTCPeerConnection,
  type RTCRtpTransceiver,
  RtpHeader,
  RtpPacket,
  SessionDescription,
} from "../../../src";
import {
  assertNegotiationInvariants,
  type DuplexSession,
  enforceSessionContinuation,
  exemptFromContinuation,
  expectSessionAlive,
  expectSessionContinues,
  negotiationSnapshot,
  registeredDataChannels,
  sendAndExpectData,
  sendAndExpectRtp,
  waitUntil,
} from "./negotiationTransactionUtils";

/**
 * Harness of the deterministic negotiation cases (`tests/negotiation/cases`).
 * A case is a TypeScript test written in Arrange / Act / Assert; the harness
 * owns what every case shares:
 * - `c.given(...)` turns an Arrange helper's value into named peers (`a`, `b`)
 *   and closes them after the case;
 * - every description operation (`c.offer`, `c.setRemote`, ...) checks
 *   `assertNegotiationInvariants` on every open peer afterwards, and with
 *   `rejects` also the error name and an unchanged `negotiationSnapshot`;
 * - real traffic (`c.rtp`, `c.data`, `c.alive`), polling (`c.waitFor`);
 * - `expectSessionContinues(a, b)` after the body unless `exempt`;
 * - a failure names the case, its `ref`, the number and text of the last
 *   operation and the operations before it (vitest adds expected / actual).
 *
 * Rules for a case:
 * - Expected values are literals or values the case saved before the
 *   operation, never computed by the code under test, and a case keeps the
 *   operation sequence of the regression it records (no split into
 *   independent cases).
 * - A case uses only descriptions and candidates werift creates itself (an
 *   offer under another local policy through `createRewrittenOffer`
 *   included); another implementation's SDP shapes and candidates (mDNS) are
 *   the end-to-end tests' responsibility (`e2e/`).
 * - A verdict that is only invariants, an unchanged state, continued traffic
 *   or a baseline match belongs to a property in `tests/pbt` (a fixed scene),
 *   not to a case; cases keep concrete ICE / DTLS / BUNDLE / RFC codec
 *   values, timing, concurrency and special environments.
 * - Tests whose control flow is a matrix stay table-driven with the
 *   `negotiationTest` fixtures (the interrupt and close-timing matrices).
 *   Helpers several cases of a file share sit at the top of that file;
 *   Arrange helpers belong in `negotiationTransactionUtils.ts`.
 */
export type CaseMeta = {
  /**
   * Requirement IDs of the negotiation transaction ticket (section and item,
   * e.g. `2.1-T4`; the test name states the requirement) and, for a
   * regression, `origin: ...`.
   */
  ref: string;
  /** Why the peers do not reach expectSessionContinues. */
  exempt?: string;
  /** Check the invariants only at `c.invariants()`, not after each operation. */
  explicitInvariants?: boolean;
  /**
   * Check the traffic property (`c.expectTraffic()`) after each description
   * operation and after the body (the model property,
   * tests/pbt/model/negotiationModelProperty.test.ts).
   */
  traffic?: boolean;
  timeout?: number;
};

type Description = { type: string; sdp: string };
type DescriptionInput = Description | string | "rollback" | null | undefined;
type OperationOptions = {
  /** Expected error name (`A|B`), or a message fragment with a space or punctuation. */
  rejects?: string;
  /** The operation may be rejected (a generated scene): if it is, nothing changed. */
  mayReject?: boolean;
  /** Description type of an SDP string (default: from the signaling state). */
  type?: "offer" | "answer" | "pranswer";
};

/** A description operation the harness applied (for an `Observer`). */
export type AppliedStep = {
  pc: RTCPeerConnection;
  kind: "setLocal" | "setRemote" | "addCandidate";
  type?: string;
  sdp?: string;
  candidate?: unknown;
  /** The rejection of an operation run with `mayReject`. */
  error?: Error;
};
/** Checks around every description operation: `before` runs first, `after` gets its value. */
export type Observer = {
  before(pc: RTCPeerConnection): unknown;
  after(step: AppliedStep, before: unknown): Promise<void> | void;
};

/** Rows of a case that ends its transaction by the final answer or by rollback. */
export const ANSWER_OR_ROLLBACK = [
  { finish: "answer" },
  { finish: "rollback" },
] as const;

/** The scope a duplex session (`createDuplexSession`) gives a case. */
export type DuplexScope = {
  session: DuplexSession;
  a: RTCPeerConnection;
  b: RTCPeerConnection;
  aOut: MediaStreamTrack;
  bOut: MediaStreamTrack;
  aVideo: DuplexSession["a"]["video"];
  bVideo: DuplexSession["b"]["video"];
  aChannel: RTCDataChannel;
  bChannel: RTCDataChannel;
};
/** What `c.given(value)` returns: `offerer` / `answerer` become `a` / `b`. */
export type Given<T> = T extends {
  peers: unknown;
  a: { pc: RTCPeerConnection };
}
  ? DuplexScope
  : T extends { offerer: RTCPeerConnection; answerer: RTCPeerConnection }
    ? Omit<T, "offerer" | "answerer" | "close"> & {
        a: RTCPeerConnection;
        b: RTCPeerConnection;
      }
    : Omit<T, "close">;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An SDP without its candidate and end-of-candidates lines. */
const bare = (sdp?: string | null) =>
  sdp?.replace(/^a=(candidate:|end-of-candidates).*\r?\n/gm, "");

/** A stream the last traffic check delivered (for the oracles of a property). */
export type DeliveredStream = {
  from: RTCPeerConnection;
  to: RTCPeerConnection;
  sender: RTCRtpTransceiver;
  receiver: RTCRtpTransceiver;
  /** The payload type the sender wrote the packet with. */
  payloadType?: number;
};

/**
 * A transport that carries traffic now: DTLS connected and a nominated pair
 * of the current ICE generation (an ICE restart commit drops the old pair
 * until the new generation nominates).
 */
function settled(transport: RTCDtlsTransport) {
  const connection = transport.iceTransport.connection;
  return (
    transport.state === "connected" &&
    connection.nominated?.localCandidate.ufrag === connection.localUsername
  );
}

/** Send once and expect `event` to deliver it within 2 s (a lost packet fails). */
async function flows<T>(
  event: {
    subscribe: (fn: (value: T) => void) => { unSubscribe: () => void };
  },
  match: (value: T) => boolean,
  send: () => void,
  message: string,
) {
  let received = false;
  let wake = () => {};
  const { unSubscribe } = event.subscribe((value) => {
    if (match(value)) {
      received = true;
      wake();
    }
  });
  try {
    const deadline = Date.now() + 2000;
    send();
    while (!received && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 100);
      });
    }
  } finally {
    unSubscribe();
  }
  expect(received, message).toBe(true);
}

/** The state of one running case; the body receives it as `c`. */
export class NegotiationCase {
  private readonly peers = new Map<RTCPeerConnection, string>();
  private readonly cleanup: (() => unknown)[] = [];
  private readonly operations: string[] = [];
  private session?: DuplexSession;
  private exemptReason?: string;
  private observer?: Observer;
  private ended = false;
  /** SDPs (without candidates) rewritten on the wire that describe the same session as their original. */
  private readonly equivalents = new Map<string, string>();
  /** The streams the last traffic check delivered. */
  delivered: DeliveredStream[] = [];

  constructor(
    readonly name: string,
    readonly meta: CaseMeta,
  ) {
    this.exemptReason = meta.exempt;
  }

  // --- Arrange ---------------------------------------------------------------

  /** Arrange: register the value of an Arrange helper as the case's peers. */
  async given<T extends object>(value: T | Promise<T>): Promise<Given<T>> {
    const resolved = (await value) as Record<string, unknown>;
    const { close, ...rest } = resolved;
    if (typeof close === "function") {
      this.cleanup.push(() => close.call(resolved));
    }
    let scope: Record<string, unknown> = rest;
    if (
      (rest.session as { peers?: unknown } | undefined)?.peers !== undefined
    ) {
      this.session = rest.session as DuplexSession;
    }
    if (rest.offerer instanceof RTCPeerConnection) {
      const { offerer, answerer, ...others } = rest;
      scope = { a: offerer, b: answerer, ...others };
    } else if (
      "peers" in rest &&
      (rest.a as { pc?: unknown })?.pc instanceof RTCPeerConnection
    ) {
      const session = resolved as unknown as DuplexSession;
      this.session = session;
      const { a, b } = session;
      scope = {
        session,
        a: a.pc,
        b: b.pc,
        aOut: a.out,
        bOut: b.out,
        aVideo: a.video,
        bVideo: b.video,
        aChannel: a.channel,
        bChannel: b.channel,
      };
    }
    for (const [key, item] of Object.entries(scope)) {
      if (item instanceof RTCPeerConnection) this.peer(item, key);
    }
    return scope as Given<T>;
  }

  /** Arrange: a peer the case creates itself (`name` labels the operation log). */
  peer<T extends RTCPeerConnection>(pc: T, name = `pc${this.peers.size}`) {
    if (!this.peers.has(pc)) this.peers.set(pc, name);
    if (this.exemptReason) exemptFromContinuation(pc, this.exemptReason);
    return pc;
  }

  /** The registered peer named `name` (for parameter rows naming a peer). */
  named(name: string) {
    const found = [...this.peers].find(([, n]) => n === name)?.[0];
    if (!found) throw new Error(`no peer named ${name}`);
    return found;
  }

  /** Arrange: close `value` (anything with `close()`) after the case. */
  closing<T>(value: T): T {
    const close = (value as { close?: () => unknown }).close;
    if (typeof close === "function") this.cleanup.push(() => close.call(value));
    return value;
  }

  /** The case cannot continue the session on purpose (`reason` says why). */
  exempt(reason: string) {
    this.exemptReason = reason;
    exemptFromContinuation([...this.peers.keys()], reason);
  }

  // --- description operations (each followed by the invariants) ---------------

  /**
   * Act: `setLocalDescription` of a description, an SDP string or
   * `"rollback"`. Resolves with the rejection of a `mayReject` operation.
   */
  async setLocal(
    pc: RTCPeerConnection,
    description: DescriptionInput,
    options: OperationOptions = {},
  ) {
    const d = this.description(pc, description, "local", options.type);
    return this.apply(
      pc,
      { kind: "setLocal", type: d.type, sdp: d.sdp },
      () => pc.setLocalDescription(d as never),
      options,
    );
  }

  /** Act: `setRemoteDescription` of a description, an SDP string or `"rollback"`. */
  async setRemote(
    pc: RTCPeerConnection,
    description: DescriptionInput,
    options: OperationOptions = {},
  ) {
    const d = this.description(pc, description, "remote", options.type);
    return this.apply(
      pc,
      { kind: "setRemote", type: d.type, sdp: d.sdp },
      () => pc.setRemoteDescription(d as never),
      options,
    );
  }

  async addCandidate(
    pc: RTCPeerConnection,
    candidate: Parameters<RTCPeerConnection["addIceCandidate"]>[0],
    options: Pick<OperationOptions, "rejects" | "mayReject"> = {},
  ) {
    return this.apply(
      pc,
      { kind: "addCandidate", candidate },
      () => pc.addIceCandidate(candidate),
      options,
    );
  }

  /**
   * Act: createOffer, setLocalDescription, then the other peer's
   * setRemoteDescription (`hold`: not delivered). Returns the created offer.
   */
  async offer(
    pc: RTCPeerConnection,
    options: { iceRestart?: boolean; hold?: boolean } = {},
  ) {
    const offer = await pc.createOffer({ iceRestart: options.iceRestart });
    await this.setLocal(pc, offer);
    if (!options.hold)
      await this.setRemote(this.other(pc), pc.localDescription);
    return offer;
  }

  /** Act: createAnswer, setLocalDescription, then deliver (`hold`: not delivered). */
  async answer(pc: RTCPeerConnection, options: { hold?: boolean } = {}) {
    return this.reply(pc, "answer", options);
  }

  /** Act: createAnswer applied as a pranswer, then deliver (`hold`: not delivered). */
  async pranswer(pc: RTCPeerConnection, options: { hold?: boolean } = {}) {
    return this.reply(pc, "pranswer", options);
  }

  /** Act: `offer` from `pc` and the other peer's `answer`. */
  async negotiate(
    pc: RTCPeerConnection,
    options: { iceRestart?: boolean } = {},
  ) {
    await this.offer(pc, options);
    await this.answer(this.other(pc));
  }

  /** Act: roll back the pending description of `pc`, then of the other peer. */
  async rollback(pc: RTCPeerConnection) {
    for (const peer of [pc, this.other(pc)]) {
      if (
        ["have-local-offer", "have-remote-pranswer"].includes(
          peer.signalingState,
        )
      ) {
        await this.setLocal(peer, "rollback");
      } else if (
        ["have-remote-offer", "have-local-pranswer"].includes(
          peer.signalingState,
        )
      ) {
        await this.setRemote(peer, "rollback");
      }
    }
  }

  /**
   * Act: end the transaction of `pc`: `"answer"` answers its pending remote
   * offer (delivered when the other peer waits for it), `"rollback"` is `rollback`.
   */
  async finish(pc: RTCPeerConnection, outcome: "answer" | "rollback") {
    if (outcome === "rollback") return this.rollback(pc);
    await this.setLocal(pc, await pc.createAnswer());
    const other = this.other(pc);
    if (other.signalingState === "have-local-offer") {
      await this.setRemote(other, pc.localDescription);
    }
  }

  /** Assert: `assertNegotiationInvariants` on the given (default: every open) peer. */
  invariants(...pcs: RTCPeerConnection[]) {
    for (const pc of pcs.length ? pcs : this.peers.keys()) {
      if (pc.signalingState !== "closed") assertNegotiationInvariants(pc);
    }
  }

  // --- traffic and waits -------------------------------------------------------

  /** Assert: RTP written on `outgoing` reaches `incoming`. */
  async rtp(
    outgoing: MediaStreamTrack,
    incoming: MediaStreamTrack | Promise<MediaStreamTrack>,
  ) {
    const label = this.log("rtp");
    await sendAndExpectRtp(outgoing, await incoming, label);
  }

  /** Assert: a DataChannel message from `from` reaches `to`. */
  async data(from: RTCDataChannel, to: RTCDataChannel) {
    const label = this.log("data");
    await sendAndExpectData(from, to, label);
  }

  /** Assert: RTP and DataChannel both ways on the duplex session of `given`. */
  async alive() {
    if (!this.session) throw new Error("alive() needs a duplex session");
    await expectSessionAlive(this.session, this.log("alive"));
  }

  /** Poll `condition` until it holds (fails after `ms`). */
  async waitFor(condition: () => unknown, ms = 3000) {
    this.log("waitFor");
    await waitUntil(
      () => !!condition(),
      `${this.name}: condition never held`,
      ms,
    );
  }

  sleep(ms: number) {
    return sleep(ms);
  }

  /** Act: start a concurrent operation; await it later (with `c.rejects`). */
  start<T>(promise: Promise<T>) {
    promise.catch(() => undefined);
    return promise;
  }

  /** Assert: `promise` rejects with that error name (`A|B`) or message fragment. */
  async rejects(promise: Promise<unknown> | (() => unknown), expected: string) {
    const error = await Promise.resolve()
      .then(() => (typeof promise === "function" ? promise() : promise))
      .then(
        () => undefined,
        (e: Error) => e,
      );
    this.expectRejection(error, expected, "operation");
  }

  /** Run `observer` around every description operation (the model property). */
  observe(observer: Observer) {
    this.observer = observer;
  }

  /** The peer named `a` or `b`, or undefined. */
  maybeNamed(name: string) {
    return [...this.peers].find(([, n]) => n === name)?.[0];
  }

  /**
   * Assert the end of a case: the traffic property (`traffic: true`) and
   * `expectSessionContinues(a, b)` unless exempt. The harness runs it after
   * the body; a body runs it itself to handle its failure (shrinking).
   */
  async end() {
    this.ended = true;
    if (this.meta.traffic) await this.expectTraffic({ final: true });
    if (!this.exemptReason) {
      const a = this.peerNamed("a");
      const b = this.peerNamed("b");
      this.log("expectSessionContinues(a, b)");
      await expectSessionContinues(a, b, "continue");
    }
  }

  /** Record a step of a generated scene in the operation log. */
  note(step: string) {
    this.log(step);
  }

  /**
   * Arrange: `rewritten` (an SDP rewritten on the wire) describes the same
   * session as `original`: a peer that applied it agrees with the peer that
   * sent `original` (the traffic property and the commit oracle hold).
   */
  equivalent(rewritten: string, original: string) {
    // peer は description を解析して書き直した形で持つので、その形で対応させる。
    const stored = (sdp: string) => bare(SessionDescription.parse(sdp).string)!;
    this.equivalents.set(stored(rewritten), stored(original));
  }

  /**
   * Whether `a` and `b` have the same session: each one's current local
   * description, without candidates, is the other's current remote
   * description (or a rewrite of it registered with `equivalent`), and so is
   * a pending local description the other peer applied as its pending remote
   * one (a pranswer makes it live provisionally).
   */
  sameSession(a: RTCPeerConnection, b: RTCPeerConnection) {
    const canonical = (sdp?: string) =>
      this.equivalents.get(bare(sdp) ?? "") ?? bare(sdp);
    const pendingAgree = (x: RTCPeerConnection, y: RTCPeerConnection) =>
      !x.pendingLocalDescription ||
      !y.pendingRemoteDescription ||
      canonical(x.pendingLocalDescription.sdp) ===
        canonical(y.pendingRemoteDescription.sdp);
    return (
      canonical(a.currentLocalDescription?.sdp) ===
        canonical(b.currentRemoteDescription?.sdp) &&
      canonical(b.currentLocalDescription?.sdp) ===
        canonical(a.currentRemoteDescription?.sdp) &&
      pendingAgree(a, b) &&
      pendingAgree(b, a)
    );
  }

  /**
   * Assert the traffic property: every stream both peers negotiated (the
   * sender's `currentDirection` sends, the transceiver of the same MID on
   * the other peer receives; a pranswer sets them provisionally) and neither
   * side stopped delivers RTP from the local track to the other peer, and
   * every DataChannel open on both peers delivers a message both ways: one
   * packet arrives within 2 s, so a lost packet fails. Only settled
   * transports count (DTLS connected, a nominated pair of the current ICE
   * generation): after an operation an unsettled one is skipped without
   * waiting, so the check does not move the scene's own check points; at the
   * end (`final`) the check waits 10 s for it to settle. It holds while both peers have the
   * same current session (each one's current local description, without
   * candidates, is the other's current remote description). While a
   * renegotiation is pending, a stream on a transport that is not connected
   * yet is not required: a pranswer stages a new transport's parameters for
   * the final answer (see `src/negotiation/transportActivation.ts`).
   */
  async expectTraffic({ final = false } = {}) {
    const peers = ["a", "b"].map(
      (name) => [...this.peers].find(([, n]) => n === name)?.[0],
    );
    if (peers.some((pc) => !pc || pc.signalingState === "closed")) return;
    const [a, b] = peers as RTCPeerConnection[];
    this.delivered = [];
    // 両 peer が同じ current session を持つ間だけ通信を求める (一方が answer で
    // 確定し、もう一方がまだ適用していない間や、相手が適用していない SDP を
    // 片側だけが確定した場合は、current が食い違う)。
    const agree = this.sameSession(a, b);
    const label = this.log(agree ? "traffic" : "traffic (current differs)");
    if (!agree) return;
    // 再交渉の pending 中、pranswer が parameters を予約した新しい transport は
    // final answer の後に開始する (Connection start)。接続済みの transport 上の
    // stream と、初回交渉の pranswer の stream だけが暫定でも流れる。
    const renegotiating =
      [a, b].some((pc) => pc.signalingState !== "stable") &&
      !!a.currentRemoteDescription;
    for (const [from, to, side] of [
      [a, b, "a"],
      [b, a, "b"],
    ] as const) {
      for (const transceiver of from.getTransceivers()) {
        const track = transceiver.sender.track;
        const direction = transceiver.currentDirection;
        if (
          !transceiver.mid ||
          transceiver.stopping ||
          transceiver.stopped ||
          !track ||
          track.remote
        ) {
          continue;
        }
        if (direction !== "sendrecv" && direction !== "sendonly") continue;
        if (renegotiating && transceiver.dtlsTransport.state !== "connected") {
          continue;
        }
        const remote = to
          .getTransceivers()
          .find((t) => t.mid === transceiver.mid);
        // 相手も同じ description を適用し、受信方向で停止していない stream だけが流れる。
        const receiving = remote?.currentDirection;
        if (
          !remote ||
          remote.stopping ||
          remote.stopped ||
          (receiving !== "sendrecv" && receiving !== "recvonly")
        ) {
          continue;
        }
        const text = `${label}-${side}-${transceiver.mid}`;
        // 1 回送った RTP が 2 s 以内に届く (sendAndExpectRtp と同じ)。transport が
        // まだ確立していなければ、操作の後は待たずに対象外 (シーンの時点を変えない)、
        // 最後は確立を待ってから検査する。
        if (!(await this.ready(transceiver.dtlsTransport, final))) continue;
        this.delivered.push({
          from,
          to,
          sender: transceiver,
          receiver: remote!,
          payloadType: transceiver.sender.codec?.payloadType,
        });
        await flows(
          remote!.receiver.track.onReceiveRtp,
          (packet) => packet.payload.toString() === text,
          () =>
            track.writeRtp(
              new RtpPacket(new RtpHeader(), Buffer.from(text)).serialize(),
            ),
          `RTP was not received: ${text}`,
        );
      }
    }
    for (const channel of registeredDataChannels(a)) {
      const remote = registeredDataChannels(b).find((c) => c.id === channel.id);
      if (channel.readyState !== "open" || remote?.readyState !== "open") {
        continue;
      }
      if (!(await this.ready(a.sctpTransport!.dtlsTransport, final))) continue;
      for (const [from, to] of [
        [channel, remote],
        [remote, channel],
      ]) {
        const text = `${label}-dc-${channel.id}-${from === channel ? "a" : "b"}`;
        await flows(
          to.onMessage,
          (data) => data.toString() === text,
          () => from.send(Buffer.from(text)),
          `DataChannel message was not received: ${text}`,
        );
      }
    }
  }

  // --- internals -------------------------------------------------------------

  /** Whether `transport` is settled; at the end of a scene, wait 10 s for it. */
  private async ready(transport: RTCDtlsTransport, final: boolean) {
    if (settled(transport) || !final) return settled(transport);
    await waitUntil(
      () => settled(transport),
      `${this.name}: the transport did not settle`,
      10_000,
    );
    return true;
  }

  /** Run the body, then the continuation; close everything afterwards. */
  async run(body: () => Promise<void>) {
    try {
      await body();
      if (!this.ended) await this.end();
    } catch (error) {
      throw this.annotate(error);
    } finally {
      vi.restoreAllMocks();
      await Promise.allSettled([
        ...this.cleanup.map((close) => close()),
        ...[...this.peers.keys()].map((pc) => pc.close()),
      ]);
    }
  }

  private peerNamed(name: string) {
    const found = [...this.peers].find(([, n]) => n === name)?.[0];
    if (!found) {
      throw new Error(`continuation needs peers a and b (or exempt: reason)`);
    }
    return found;
  }

  private annotate(error: unknown) {
    const original = error instanceof Error ? error : new Error(String(error));
    // message を書き換えられないエラー (getter だけのもの) は cause に持って包む。
    let e = original;
    try {
      const message = original.message;
      original.message = message;
    } catch {
      e = new Error(`${original.name}: ${original.message}`, {
        cause: original,
      });
    }
    const last = this.operations.length;
    e.message = [
      `case "${this.name}" (${this.meta.ref})`,
      last
        ? `after operation #${last}: ${this.operations[last - 1]}`
        : "before the first operation",
      e.message,
      `operations:\n${this.operations
        .map((op, i) => `  #${i + 1} ${op}`)
        .slice(-40)
        .join("\n")}`,
    ].join("\n");
    return e;
  }

  private log(operation: string) {
    this.operations.push(operation);
    return `op${this.operations.length}`;
  }

  private label(pc: RTCPeerConnection) {
    return this.peers.get(pc) ?? "pc";
  }

  private other(pc: RTCPeerConnection) {
    const others = [...this.peers.keys()].filter((p) => p !== pc);
    if (others.length !== 1) {
      throw new Error("the operation needs exactly two peers");
    }
    return others[0];
  }

  private async reply(
    pc: RTCPeerConnection,
    type: "answer" | "pranswer",
    options: { hold?: boolean },
  ) {
    const answer = await pc.createAnswer();
    await this.setLocal(pc, { type, sdp: answer.sdp });
    if (!options.hold)
      await this.setRemote(this.other(pc), pc.localDescription);
    return answer;
  }

  private description(
    pc: RTCPeerConnection,
    value: DescriptionInput,
    side: "local" | "remote",
    type?: string,
  ): Description {
    if (value === "rollback") return { type: "rollback", sdp: "" };
    if (typeof value === "string") {
      const offering =
        side === "local"
          ? ["stable", "have-local-offer"].includes(pc.signalingState)
          : ["stable", "have-remote-offer"].includes(pc.signalingState);
      return { type: type ?? (offering ? "offer" : "answer"), sdp: value };
    }
    if (!value) throw new Error("no description to apply");
    return { type: type ?? value.type, sdp: value.sdp };
  }

  private async apply(
    pc: RTCPeerConnection,
    step: Omit<AppliedStep, "pc" | "error">,
    run: () => Promise<unknown>,
    { rejects, mayReject }: OperationOptions,
  ) {
    const operation =
      step.kind === "addCandidate"
        ? `addCandidate(${this.label(pc)})`
        : `${step.kind}(${this.label(pc)}, ${step.type})`;
    this.log(rejects ? `${operation} rejects ${rejects}` : operation);
    const observed = this.observer?.before(pc);
    let error: Error | undefined;
    if (!rejects && !mayReject) {
      await run();
    } else {
      const before = negotiationSnapshot(pc);
      error = await run().then(
        () => undefined,
        (e: Error) => e,
      );
      if (rejects) this.expectRejection(error, rejects, operation);
      if (error && pc.signalingState !== "closed") {
        expect(
          negotiationSnapshot(pc),
          `${operation}: a rejected operation changed state`,
        ).toEqual(before);
      }
      if (error && mayReject) this.log(`  rejected: ${error.name}`);
    }
    if (!this.meta.explicitInvariants) this.invariants();
    if (this.meta.traffic) await this.expectTraffic();
    await this.observer?.after({ ...step, pc, error }, observed);
    return error;
  }

  private expectRejection(
    error: Error | undefined,
    expected: string,
    operation: string,
  ) {
    expect(error, `${operation}: expected a rejection`).toBeInstanceOf(Error);
    if (/^[\w|]+$/.test(expected)) {
      expect(error!.name, operation).toMatch(new RegExp(`^(${expected})$`));
    } else expect(error!.message, operation).toContain(expected);
  }
}

const caseName = (name: string, row: object) =>
  name.replace(/\$(\w+)/g, (m, key) =>
    key in row ? String((row as Record<string, unknown>)[key]) : m,
  );

/**
 * Register one case. `body(c)` is the Arrange / Act / Assert of the case;
 * the harness checks the invariants after each operation of `c`, runs the
 * continuation and closes the peers.
 */
export function negotiationCase(
  name: string,
  meta: CaseMeta,
  body: (c: NegotiationCase) => Promise<void>,
) {
  test(name, { timeout: meta.timeout ?? 60_000 }, async () => {
    const c = new NegotiationCase(name, meta);
    await c.run(() => body(c));
  });
}

/** Register one case per row; `$key` in the name is replaced by the row's value. */
negotiationCase.for =
  <R extends object>(rows: readonly R[]) =>
  (
    name: string,
    meta: CaseMeta,
    body: (c: NegotiationCase, row: R) => Promise<void>,
  ) => {
    for (const row of rows) {
      const formatted = caseName(name, row);
      test(formatted, { timeout: meta.timeout ?? 60_000 }, async () => {
        const c = new NegotiationCase(formatted, meta);
        await c.run(() => body(c, row));
      });
    }
  };

/**
 * A describe block of negotiation cases: every negotiated peer must reach
 * `expectSessionContinues` (or be exempt), and a case has 60 s by default.
 */
export function describeCases(title: string, cases: () => void) {
  describe(title, () => {
    enforceSessionContinuation();
    cases();
  });
}
