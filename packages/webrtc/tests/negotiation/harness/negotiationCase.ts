import { describe, expect, test, vi } from "vitest";

import {
  type MediaStreamTrack,
  type RTCDataChannel,
  RTCPeerConnection,
} from "../../../src";
import {
  type DuplexSession,
  assertNegotiationInvariants,
  enforceSessionContinuation,
  exemptFromContinuation,
  expectSessionAlive,
  expectSessionContinues,
  negotiationSnapshot,
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
 */
export type CaseMeta = {
  /** Spec IDs of NEGOTIATION_SPEC_COVERAGE.md and, for a regression, `origin: ...`. */
  ref: string;
  /** Why the peers do not reach expectSessionContinues. */
  exempt?: string;
  /** Check the invariants only at `c.invariants()`, not after each operation. */
  explicitInvariants?: boolean;
  timeout?: number;
};

type Description = { type: string; sdp: string };
type DescriptionInput = Description | string | "rollback" | null | undefined;
type OperationOptions = {
  /** Expected error name (`A|B`), or a message fragment with a space or punctuation. */
  rejects?: string;
  /** Description type of an SDP string (default: from the signaling state). */
  type?: "offer" | "answer" | "pranswer";
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

/** The state of one running case; the body receives it as `c`. */
export class NegotiationCase {
  private readonly peers = new Map<RTCPeerConnection, string>();
  private readonly cleanup: (() => unknown)[] = [];
  private readonly operations: string[] = [];
  private session?: DuplexSession;
  private exemptReason?: string;

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

  /** Act: `setLocalDescription` of a description, an SDP string or `"rollback"`. */
  async setLocal(
    pc: RTCPeerConnection,
    description: DescriptionInput,
    options: OperationOptions = {},
  ) {
    const d = this.description(pc, description, "local", options.type);
    await this.apply(
      pc,
      `setLocal(${this.label(pc)}, ${d.type})`,
      () => pc.setLocalDescription(d as never),
      options.rejects,
    );
  }

  /** Act: `setRemoteDescription` of a description, an SDP string or `"rollback"`. */
  async setRemote(
    pc: RTCPeerConnection,
    description: DescriptionInput,
    options: OperationOptions = {},
  ) {
    const d = this.description(pc, description, "remote", options.type);
    await this.apply(
      pc,
      `setRemote(${this.label(pc)}, ${d.type})`,
      () => pc.setRemoteDescription(d as never),
      options.rejects,
    );
  }

  /** Act: `addIceCandidate`. */
  async addCandidate(
    pc: RTCPeerConnection,
    candidate: Parameters<RTCPeerConnection["addIceCandidate"]>[0],
    options: Pick<OperationOptions, "rejects"> = {},
  ) {
    await this.apply(
      pc,
      `addCandidate(${this.label(pc)})`,
      () => pc.addIceCandidate(candidate),
      options.rejects,
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

  // --- internals -------------------------------------------------------------

  /** Run the body, then the continuation; close everything afterwards. */
  async run(body: () => Promise<void>) {
    try {
      await body();
      if (!this.exemptReason) {
        const a = this.peerNamed("a");
        const b = this.peerNamed("b");
        this.log("expectSessionContinues(a, b)");
        await expectSessionContinues(a, b, "continue");
      }
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
    const e = error instanceof Error ? error : new Error(String(error));
    const last = this.operations.length;
    e.message = [
      `case "${this.name}" (${this.meta.ref})`,
      last
        ? `after operation #${last}: ${this.operations[last - 1]}`
        : "before the first operation",
      e.message,
      `operations:\n${this.operations
        .map((op, i) => `  #${i + 1} ${op}`)
        .slice(-10)
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
    operation: string,
    run: () => Promise<unknown>,
    rejects: string | undefined,
  ) {
    this.log(rejects ? `${operation} rejects ${rejects}` : operation);
    if (!rejects) {
      await run();
    } else {
      const before = negotiationSnapshot(pc);
      const error = await run().then(
        () => undefined,
        (e: Error) => e,
      );
      this.expectRejection(error, rejects, operation);
      if (pc.signalingState !== "closed") {
        expect(
          negotiationSnapshot(pc),
          `${operation}: a rejected operation changed state`,
        ).toEqual(before);
      }
    }
    if (!this.meta.explicitInvariants) this.invariants();
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
