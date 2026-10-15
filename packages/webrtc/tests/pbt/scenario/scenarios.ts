import { expect } from "vitest";

import { MediaStreamTrack, type RTCPeerConnection } from "../../../src";
import {
  assertNegotiationInvariants,
  createDuplexSession,
  createRewrittenOffer,
  expectDataAlive,
  expectSessionContinues,
  mungeSection,
  negotiationInternals,
  negotiationSnapshot,
  reverseSetupRole,
  sdpCandidates,
  sendAndExpectRtp,
  waitForCommittedNomination,
  withMaxMessageSize,
} from "../../negotiation/harness/negotiationTransactionUtils";
import { type SeededRandom, seededRandom } from "../shared/random";

export { seededRandom };

/**
 * Scenario property test of the negotiation transaction, separate from the
 * episode fuzzer of fuzz/negotiationTransactionProperty.test.ts. A scenario is a
 * list of operations on a connected duplex session (`createDuplexSession`:
 * video sendrecv both ways and a DataChannel), written as text (`scenario`)
 * by the fixed cases and the random generators alike. Every operation is
 * followed by the base checks of `runOp`; a property adds the judgement of
 * its one claim.
 */
export type Side = "a" | "b";
type DescriptionType = "offer" | "answer" | "pranswer";
type Description = { type: DescriptionType; sdp: string };
const VIDEO = "0";
const APPLICATION = "1";

/** Named SDP edits: a remote peer's choice on the wire, or (`createOffer edit=`) a local policy. */
const EDITS: Record<string, (sdp: string) => string> = {
  recvonly: (sdp) =>
    mungeSection(sdp, VIDEO, (s) => s.replace("a=sendrecv", "a=recvonly")),
  inactive: (sdp) =>
    mungeSection(sdp, VIDEO, (s) => s.replace("a=sendrecv", "a=inactive")),
  /** the current VP8 payload type renamed to H264 (RFC 3264 8.3.2) */
  ptRemap: (sdp) =>
    mungeSection(sdp, VIDEO, (s) =>
      s.replace(/a=rtpmap:(\d+) VP8\/90000/, "a=rtpmap:$1 H264/90000"),
    ),
  fingerprint: (sdp) =>
    sdp.replace(
      /a=fingerprint:(\S+) [0-9A-Fa-f:]+/g,
      `a=fingerprint:$1 ${Array(32).fill("AB").join(":")}`,
    ),
  sctpPort: (sdp) => sdp.replace("a=sctp-port:5000", "a=sctp-port:5001"),
  flipSetup: reverseSetupRole,
  midSuffix: (sdp) => sdp.replace("a=mid:0", "a=mid:0_extra"),
  bundleSuffix: (sdp) =>
    sdp.replace(/^a=group:BUNDLE 0\b/m, "a=group:BUNDLE 0_extra"),
  midWrong: (sdp) =>
    sdp
      .replace(/a=mid:([^\r\n]+)/, "a=mid:wrong")
      .replace(/a=group:BUNDLE [^\r\n]+/, "a=group:BUNDLE wrong"),
  /** no BUNDLE group: SCTP would move to another DTLS transport */
  noBundle: (sdp) => sdp.replace(/a=group:BUNDLE [^\r\n]+\r\n/, ""),
  /** the other m-lines split off the video m-line's BUNDLE group */
  videoBundle: (sdp) =>
    sdp.replace(/^a=group:BUNDLE [^\r\n]+/m, `a=group:BUNDLE ${VIDEO}`),
  noCandidates: (sdp) =>
    sdp
      .replace(/^a=candidate:[^\r\n]+\r?\n/gm, "")
      .replace(/^a=end-of-candidates\r?\n/gm, ""),
};
/** An EDITS name, `mms:<n>` (application max-message-size) or `ufrag:<u>` (new ICE credentials). */
type Edit = string;
function applyEdit(sdp: string, edit?: Edit) {
  const [name, value] = (edit ?? "").split(":");
  if (!edit) return sdp;
  if (name === "mms") return withMaxMessageSize(sdp, APPLICATION, +value);
  if (name === "ufrag") {
    return sdp
      .replace(/a=ice-ufrag:[^\r\n]+/g, `a=ice-ufrag:${value}`)
      .replace(/a=ice-pwd:[^\r\n]+/g, `a=ice-pwd:${value}password1234567890`);
  }
  return EDITS[name](sdp);
}
const withoutCandidates = (sdp?: string | null) =>
  sdp ? EDITS.noCandidates(sdp) : sdp;
const ufragOf = (sdp?: string) => sdp?.match(/^a=ice-ufrag:(\S+)/m)?.[1];

/**
 * One operation. `desc` names a description saved by `createOffer` /
 * `createAnswer` / `save` (default "offer" / "answer"), `local:<side>` /
 * `remote:<side>` (what a peer has at that moment) or "rollback"; for
 * `addTransceiver` it is the kind. `reject` is the expected error name
 * (alternatives joined by "|"), "any", or "either" (both outcomes allowed).
 */
export type Op = {
  op: string;
  by?: Side;
  desc?: string;
  type?: DescriptionType;
  edit?: Edit;
  as?: string;
  /** createOffer({ iceRestart: true }) */
  restart?: boolean;
  /** addTransceiver(kind) without track; otherwise a sendonly track */
  bare?: boolean;
  /** trickle the same candidates / end-of-candidates again */
  twice?: boolean;
  /** one made-up candidate of the description's ufrag instead of its own */
  synthetic?: string;
  /** alive: a stream that does not flow delivers nothing */
  silent?: boolean;
  reject?: string;
  /** regular expression the rejection's message matches */
  message?: string;
};
export const other = (side: Side): Side => (side === "a" ? "b" : "a");

/**
 * Parse scenario text: one step per line or ";", `[side] name [arg] [flag]
 * [key=value]`. Steps are the Op names (`a createOffer restart as=saved`,
 * `b setRemote local:a edit=noCandidates`, `a addTransceiver audio bare`,
 * `b addCandidate local:a twice`, `save local:a as=old`, `alive silent`,
 * `nominated`) and the macros
 *   `a offer [restart] [edit=] [remote=] [as=]`: createOffer, apply, deliver
 *   `b reply [pranswer] [reuse] [edit=] [remote=]`: createAnswer (unless
 *     reuse), apply as answer / pranswer, deliver (`remote=` edits the copy)
 *   `a rollback`: local rollback on a, remote rollback on the peer
 *   `a negotiate [offer keys]`: `a offer` + `b reply`.
 */
const FLAGS = new Set([
  "restart",
  "bare",
  "twice",
  "silent",
  "pranswer",
  "reuse",
]);
export function scenario(text: string): Op[] {
  return text
    .split(/[;\n]/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const words = line.split(/\s+/);
      const by = /^[ab]$/.test(words[0]) ? (words.shift() as Side) : undefined;
      const name = words.shift()!;
      const o: Record<string, string | boolean | undefined> = {};
      for (const word of words) {
        const [key, value] = word.split(/=(.*)/);
        if (value !== undefined) o[key] = value;
        else if (FLAGS.has(word)) o[word] = true;
        else o.desc = word;
      }
      const to = by && other(by);
      const offer = [
        `${by} createOffer as=${o.as ?? "offer"}${o.restart ? " restart" : ""}${o.edit ? ` edit=${o.edit}` : ""}`,
        `${by} setLocal ${o.as ?? "offer"}`,
        `${to} setRemote local:${by}${o.remote ? ` edit=${o.remote}` : ""}`,
      ];
      const type = o.pranswer ? "pranswer" : "answer";
      const reply = (side = by, edit = o.edit, remote = o.remote) => [
        ...(o.reuse ? [] : [`${side} createAnswer`]),
        `${side} setLocal answer type=${type}${edit ? ` edit=${edit}` : ""}`,
        `${other(side!)} setRemote answer type=${type}${(remote ?? edit) ? ` edit=${remote ?? edit}` : ""}`,
      ];
      const macros: Record<string, string[]> = {
        offer,
        reply: reply(),
        rollback: [`${by} setLocal rollback`, `${to} setRemote rollback`],
        negotiate: [...offer, ...reply(to, undefined, undefined)],
      };
      if (macros[name]) return scenario(macros[name].join("\n"));
      return [{ op: name, by, ...o } as Op];
    });
}
/** One operation as scenario text (for the failure report). */
const format = (op: Op) =>
  Object.entries(op)
    .filter(([key, value]) => value !== undefined && key !== "op")
    .reduce(
      (text, [key, value]) =>
        key === "by" || key === "desc"
          ? text
          : `${text} ${value === true ? key : `${key}=${value}`}`,
      [op.by, op.op, op.desc].filter(Boolean).join(" "),
    );

/** What one peer exposes to the properties (compared with toEqual). */
function peerWorld(ctx: ScenarioContext, pc: RTCPeerConnection) {
  const { transceivers: _, ...snapshot } = negotiationSnapshot(pc);
  return {
    ...snapshot,
    phase: negotiationInternals(pc).negotiation.inspect().phase,
    generation: pc.iceGeneration,
    remoteIce: pc.iceTransports.map(
      (t) => t.getRemoteParameters()?.usernameFragment,
    ),
    /** ICE generation (local / remote ufrag) of each selected pair */
    pairs: pc.iceTransports.map((t) => {
      const pair = t.getSelectedCandidatePair();
      return (
        pair && [pair.local.usernameFragment, pair.remote.usernameFragment]
      );
    }),
    dtls: pc.dtlsTransports.map((t) => [ctx.id(t), t.role]),
    sctp: {
      transport: ctx.id(pc.sctpTransport?.dtlsTransport),
      port: pc.sctpRemotePort,
      maxMessageSize: pc.sctpTransport?.remoteMaxMessageSize,
    },
    transceivers: pc.getTransceivers().map((t) => ({
      id: ctx.id(t),
      mid: t.mid,
      index: t.mLineIndex,
      currentDirection: t.currentDirection,
      stopped: t.stopped,
      track: t.sender.track?.id,
      receive: t.receiver.snapshotReceiveTables(),
    })),
  };
}
type PeerWorld = ReturnType<typeof peerWorld>;
type World = Record<Side, PeerWorld>;
const world = (ctx: ScenarioContext): World => ({
  a: peerWorld(ctx, ctx.pc("a")),
  b: peerWorld(ctx, ctx.pc("b")),
});
/**
 * A world without candidate and end-of-candidates lines: gathering and
 * trickle add them within one generation (the invariants and the trickle
 * property judge them).
 */
const settled = (w: PeerWorld) => ({
  ...w,
  currentLocal: withoutCandidates(w.currentLocal),
  currentRemote: withoutCandidates(w.currentRemote),
  pendingLocal: withoutCandidates(w.pendingLocal),
  pendingRemote: withoutCandidates(w.pendingRemote),
});

/** Per-peer record of one negotiation episode (from stable to stable). */
type Episode = {
  start: PeerWorld;
  /** transceivers the application added during the episode */
  added: Set<number>;
  /** a pranswer reached the offerer */
  pranswerDelivered: boolean;
};
type Stream = {
  side: Side;
  out: MediaStreamTrack;
  transceiver: ReturnType<RTCPeerConnection["addTransceiver"]>;
};

type ScenarioContext = Awaited<ReturnType<typeof createScenarioContext>>;
async function createScenarioContext() {
  const session = await createDuplexSession();
  const ids = new WeakMap<object, number>();
  let next = 0;
  return {
    session,
    pc: (side: Side) => session[side].pc,
    saved: new Map<string, Description>(),
    /** tracks the scenario sends: the session's video, then `addTransceiver` */
    streams: [
      { side: "a", out: session.a.out, transceiver: session.a.video },
      { side: "b", out: session.b.out, transceiver: session.b.video },
    ] as Stream[],
    episodes: {} as Partial<Record<Side, Episode>>,
    /** a candidate reached this peer's remote description since it was set */
    trickled: { a: false, b: false } as Record<Side, boolean>,
    /** a later description of a trickled generation may carry its candidates again */
    anyTrickle: false,
    /** offers rewritten by a local policy (setLocalDescription re-describes split m-lines) */
    rewritten: new Set<string>(),
    /** the committed answer chose a direction on the wire */
    directionEdited: false,
    /** remote description and candidate count after the first of a `twice` trickle */
    once: undefined as { sdp?: string; count: number } | undefined,
    memo: {} as Record<string, unknown>,
    log: [] as string[],
    /** Stable small number of an object, so worlds compare by identity. */
    id: (object: object | undefined) => {
      if (object && !ids.has(object)) ids.set(object, ++next);
      return object && ids.get(object);
    },
  };
}

function resolve(ctx: ScenarioContext, name: string): Description {
  const [kind, side] = name.split(":") as [string, Side];
  const description =
    kind === "local"
      ? ctx.pc(side).localDescription
      : kind === "remote"
        ? ctx.pc(side).remoteDescription
        : ctx.saved.get(name);
  if (!description) throw new Error(`no description ${name}`);
  return { type: description.type as DescriptionType, sdp: description.sdp };
}
/** Description argument of a setLocal / setRemote operation. */
function argument(ctx: ScenarioContext, op: Op) {
  if (op.desc === "rollback") return { type: "rollback", sdp: "" };
  const description = resolve(ctx, op.desc!);
  return {
    type: op.type ?? description.type,
    sdp: applyEdit(description.sdp, op.edit),
  };
}
/** Candidates an `addCandidate` trickles (of the video m-line). */
function candidatesOf(ctx: ScenarioContext, op: Op) {
  const sdp = resolve(ctx, op.desc!).sdp;
  if (!op.synthetic) return sdpCandidates(sdp, VIDEO);
  const candidate = `candidate:${op.synthetic} 1 udp 2113937151 192.0.2.10 12345 typ host`;
  return [{ candidate, sdpMid: VIDEO, usernameFragment: ufragOf(sdp) }];
}
const remoteCandidateCount = (pc: RTCPeerConnection) =>
  pc.iceTransports.reduce((n, t) => n + t.getRemoteCandidates().length, 0);

/** Execute one operation (no checks); returns the error of a rejected one. */
async function execute(ctx: ScenarioContext, op: Op): Promise<unknown> {
  const pc = op.by && ctx.pc(op.by);
  const trickle = async () => {
    ctx.trickled[op.by!] = ctx.anyTrickle = true;
    if (op.op === "endOfCandidates") return pc!.addIceCandidate(null as never);
    for (const candidate of candidatesOf(ctx, op)) {
      await pc!.addIceCandidate(candidate);
    }
  };
  const run = async () => {
    switch (op.op) {
      case "createOffer": {
        const options = { iceRestart: op.restart };
        const created = op.edit
          ? await createRewrittenOffer(
              pc!,
              (sdp) => applyEdit(sdp, op.edit),
              options,
            )
          : await pc!.createOffer(options);
        ctx.saved.set(op.as ?? "offer", created as Description);
        if (op.edit) ctx.rewritten.add(created.sdp);
        return;
      }
      case "createAnswer":
        ctx.saved.set(op.as ?? "answer", await pc!.createAnswer());
        return;
      case "setLocal":
        return await pc!.setLocalDescription(argument(ctx, op) as never);
      case "setRemote":
        return await pc!.setRemoteDescription(argument(ctx, op) as never);
      case "save":
        ctx.saved.set(op.as!, resolve(ctx, op.desc!));
        return;
      case "restartIce":
        return pc!.restartIce();
      case "addTransceiver": {
        const kind = op.desc as "audio" | "video";
        const out = new MediaStreamTrack({ kind });
        const transceiver = op.bare
          ? pc!.addTransceiver(kind)
          : pc!.addTransceiver(out, { direction: "sendonly" });
        if (!op.bare) ctx.streams.push({ side: op.by!, out, transceiver });
        ctx.episodes[op.by!]?.added.add(ctx.id(transceiver)!);
        return;
      }
      case "addCandidate":
      case "endOfCandidates": {
        ctx.once = undefined;
        await trickle();
        if (!op.twice) return;
        const sdp = pc!.remoteDescription?.sdp;
        ctx.once = { sdp, count: remoteCandidateCount(pc!) };
        return await trickle();
      }
      case "alive":
        return await expectTraffic(ctx, op.silent);
      case "nominated":
        await waitForCommittedNomination(ctx.pc("a"));
        return await waitForCommittedNomination(ctx.pc("b"));
    }
  };
  if (!KNOWN.has(op.op)) throw new TypeError(`unknown operation ${op.op}`);
  // 成功は undefined、拒否はその error を返す。
  return run().then(
    () => undefined,
    (error) => error ?? new Error("rejected"),
  );
}
const KNOWN = new Set(
  "createOffer createAnswer setLocal setRemote save restartIce addTransceiver addCandidate endOfCandidates alive nominated".split(
    " ",
  ),
);

const bothStable = (ctx: ScenarioContext) =>
  ctx.pc("a").signalingState === "stable" &&
  ctx.pc("b").signalingState === "stable";
const sends = (direction?: string | null) =>
  direction === "sendonly" || direction === "sendrecv";
const receives = (direction?: string | null) =>
  direction === "recvonly" || direction === "sendrecv";
/** The peer's transceiver with the same MID. */
const remoteOf = (ctx: ScenarioContext, side: Side, mid: string | null) =>
  ctx
    .pc(other(side))
    .getTransceivers()
    .find((t) => t.mid === mid);

/**
 * Assert (`alive`): the session carries what is negotiated. Settled (both
 * stable, no direction edited on the wire in the committed answer) a
 * negotiated stream flows when both applications want it (sender's
 * direction ∩ receiver's); otherwise when its sender's effective
 * currentDirection sends. The DataChannel carries messages both ways and
 * refuses one over the effective max-message-size. `silent`: a stream that
 * does not flow delivers nothing.
 */
async function expectTraffic(ctx: ScenarioContext, silent = false) {
  const settledSession = bothStable(ctx) && !ctx.directionEdited;
  const label = `alive-${ctx.log.length}`;
  for (const { side, out, transceiver } of ctx.streams) {
    if (!transceiver.mid) continue;
    const remote = remoteOf(ctx, side, transceiver.mid);
    const text = `${label}-${side}-${transceiver.mid}`;
    if (
      settledSession
        ? sends(transceiver.direction) && receives(remote?.direction)
        : sends(transceiver.currentDirection)
    ) {
      // 流れるはずの stream は停止しておらず、相手の同じ MID に RTP が届く。
      expect(transceiver.stopped, text).toBe(false);
      expect(remote, `${text} has no remote transceiver`).toBeDefined();
      await sendAndExpectRtp(out, remote!.receiver.track, text);
    } else if (silent && remote) {
      // 流れない stream からは何も届かない。
      await expect(
        sendAndExpectRtp(out, remote.receiver.track, text),
      ).rejects.toThrow("RTP was not received");
    }
  }
  await expectDataAlive(ctx.session, label);
  for (const { pc, channel } of [ctx.session.a, ctx.session.b]) {
    // 実効の max-message-size を超えるメッセージは送らない。
    const limit = pc.sctpTransport!.remoteMaxMessageSize;
    expect(() => channel.send(Buffer.alloc(limit + 1))).toThrow(
      "max-message-size exceeded",
    );
  }
}

/** The JSEP transition (JSEP 3.2 / W3C 4.4.1.5) of an accepted setLocal / setRemote. */
function expectTransition(
  ctx: ScenarioContext,
  op: Op,
  self: PeerWorld,
  applied: { type: string; sdp: string },
) {
  const now = peerWorld(ctx, ctx.pc(op.by!));
  const local = op.op === "setLocal";
  // local policy で書き換えた offer は、分割した m-line の資格情報と setup が書き直される。
  const sdp =
    local && ctx.rewritten.has(applied.sdp) ? now.pendingLocal : applied.sdp;
  if (!local && applied.type === "offer" && sdp === self.pendingRemote) {
    // byte 単位で同じ remote offer の再適用は何も変えない。
    const state = (w: PeerWorld) => [
      w.signalingState,
      w.pendingLocal,
      w.pendingRemote,
    ];
    expect(state(now)).toEqual(state(self));
    return;
  }
  // trickle や gathering が足した候補行は (local は常に) 比べない。
  const exact = !local && !ctx.trickled[op.by!] && !ctx.anyTrickle;
  const same = (actual?: string, expected?: string) =>
    exact
      ? expect(actual).toBe(expected)
      : expect(withoutCandidates(actual)).toBe(withoutCandidates(expected));
  const current = (w: PeerWorld) =>
    [w.currentLocal, w.currentRemote].map(withoutCandidates);
  const pending = local ? now.pendingLocal : now.pendingRemote;
  const otherPending = local ? now.pendingRemote : now.pendingLocal;
  const answered = local ? self.pendingRemote : self.pendingLocal;
  if (applied.type === "answer") {
    // final answer は適用した description と offer をそのまま current にする。
    expect(now.signalingState).toBe("stable");
    same(local ? now.currentLocal : now.currentRemote, sdp);
    expect(local ? now.currentRemote : now.currentLocal).toBe(answered);
    expect([now.pendingLocal, now.pendingRemote]).toEqual([
      undefined,
      undefined,
    ]);
    return;
  }
  // offer / pranswer / rollback では current は変わらない。
  expect(current(now)).toEqual(current(self));
  if (applied.type === "rollback") {
    // rollback は pending を捨てる。
    expect(now.signalingState).toBe("stable");
    expect([now.pendingLocal, now.pendingRemote]).toEqual([
      undefined,
      undefined,
    ]);
    return;
  }
  const side = local ? "local" : "remote";
  // offer / pranswer は pending になる。offer は反対側の pending を暗黙に rollback し、
  // pranswer は offer の pending を残す。
  expect(now.signalingState).toBe(`have-${side}-${applied.type}`);
  same(pending, sdp);
  expect(otherPending).toBe(applied.type === "offer" ? undefined : answered);
  if (local && applied.type === "offer") {
    // local offer の m-line (application 以外) はどれも transceiver に関連付く。
    const mids = ctx
      .pc(op.by!)
      .getTransceivers()
      .map((t) => t.mid);
    for (const section of applied.sdp.split(/(?=^m=)/m)) {
      const mid = section.match(/^a=mid:(\S+)/m)?.[1];
      if (!/^m=(audio|video) [1-9]/.test(section) || !mid) continue;
      expect(mids, "offered m-line without a transceiver").toContain(mid);
    }
  }
}

/** Per-property judgement, after every operation, with the world before it. */
export type Judge = (
  ctx: ScenarioContext,
  op: Op,
  before: World,
  error: unknown,
) => void | Promise<void>;

/**
 * Run one operation with the base checks of every property: the declared
 * outcome (accepted, or rejected with the declared error), the invariants
 * of both peers, candidate lines without a "candidate:" foundation, the
 * JSEP transition of an accepted description and an untouched other peer.
 * Then the property's `judge`.
 */
async function runOp(ctx: ScenarioContext, op: Op, judge: Judge) {
  // candidate を除いて届けた description には、同じ generation で以前に届いた候補が戻る。
  if (op.edit === "noCandidates") ctx.anyTrickle = true;
  const before = world(ctx);
  const description = op.op === "setLocal" || op.op === "setRemote";
  const applied = description && !op.reject ? argument(ctx, op) : undefined;
  const error = await execute(ctx, op);
  ctx.log.push(`${format(op)} -> ${error ? `rejected ${error}` : "ok"}`);
  if (op.reject && op.reject !== "either") {
    expect(error, "the operation must be rejected").toBeDefined();
    if (op.reject !== "any") {
      expect((error as Error).name).toMatch(new RegExp(`^(${op.reject})$`));
    }
    if (op.message) expect(String(error)).toMatch(new RegExp(op.message));
  } else if (error && !op.reject) {
    throw error;
  }
  for (const side of ["a", "b"] as const) {
    const pc = ctx.pc(side);
    assertNegotiationInvariants(pc);
    for (const sdp of [pc.localDescription?.sdp, pc.remoteDescription?.sdp]) {
      // candidate の foundation に "candidate:" は付かない (RFC 8839 5.1)。
      expect(sdp ?? "").not.toMatch(/^a=candidate:candidate:/m);
    }
  }
  if (applied && !error) {
    if (op.op === "setRemote") ctx.trickled[op.by!] = false;
    if (applied.type === "answer") {
      ctx.directionEdited = op.edit === "recvonly" || op.edit === "inactive";
    }
    expectTransition(ctx, op, before[op.by!], applied);
    // 操作していない peer の description と signaling state は変わらない。
    const peer = other(op.by!);
    const descriptions = (w: PeerWorld) => [
      w.signalingState,
      w.currentLocal,
      w.currentRemote,
      w.pendingLocal,
      w.pendingRemote,
    ];
    expect(descriptions(peerWorld(ctx, ctx.pc(peer)))).toEqual(
      descriptions(before[peer]),
    );
  }
  await judge(ctx, op, before, error);
  // stable を出た peer の episode を始め、stable に戻った peer の episode を閉じる。
  for (const side of ["a", "b"] as const) {
    if (ctx.pc(side).signalingState === "stable") delete ctx.episodes[side];
    else
      ctx.episodes[side] ??= {
        start: before[side],
        added: new Set(),
        pranswerDelivered: false,
      };
  }
  if (!error && op.op === "setRemote" && applied?.type === "pranswer") {
    for (const episode of Object.values(ctx.episodes)) {
      episode.pranswerDelivered = true;
    }
  }
}

/**
 * Run a scenario on a fresh session and end with `expectSessionContinues`.
 * A failure names the seed or fixed case and prints the input operations
 * and the operation log (the same seed replays the same operations).
 */
export async function runScenario(label: string, ops: Op[], judge: Judge) {
  const ctx = await createScenarioContext();
  try {
    for (const op of ops) await runOp(ctx, op, judge);
    // Assert: 最後に次の offer・ICE restart・追加・相手からの再 offer の後も通信できる。
    await expectSessionContinues(ctx.pc("a"), ctx.pc("b"), "scenario");
  } catch (error) {
    // DOMException の message は getter だけなので、入力と操作ログを足した Error で包む。
    const input = ops.map(format).join("\n  ");
    throw new Error(
      `${error}\n${label}\ninput:\n  ${input}\noperations:\n  ${ctx.log.join("\n  ")}`,
      { cause: error },
    );
  } finally {
    await ctx.session.close();
  }
}

// --- judgements (one claim each) ---

const isDescription = (op: Op) => op.op === "setLocal" || op.op === "setRemote";

/**
 * commit: when a final answer brings both peers to stable, every negotiated
 * transceiver's currentDirection is what both applications asked for (its
 * direction ∩ the peer's), unless the committing answer was edited on the
 * wire to another direction.
 */
export const judgeCommit: Judge = (ctx, op, _before, error) => {
  if (error || !isDescription(op) || op.desc === "rollback") return;
  if (!bothStable(ctx) || ctx.directionEdited) return;
  for (const side of ["a", "b"] as const) {
    for (const t of ctx.pc(side).getTransceivers()) {
      const remote = remoteOf(ctx, side, t.mid);
      if (!t.mid || t.stopped || !remote) continue;
      const send = sends(t.direction) && receives(remote.direction);
      const receive = receives(t.direction) && sends(remote.direction);
      const expected = send
        ? receive
          ? "sendrecv"
          : "sendonly"
        : receive
          ? "recvonly"
          : "inactive";
      // 確定した向きは両 application の希望の積。
      expect(t.currentDirection, `${side} mid ${t.mid}`).toBe(expected);
    }
  }
};

/**
 * pending: while a peer is not stable, what its committed session uses is
 * unchanged: current descriptions, DTLS transports and roles, the SCTP
 * association and remote port, remote ICE credentials and (until a
 * pranswer reached the offerer) the ICE generation of selected pairs.
 */
export const judgePending: Judge = (ctx) => {
  for (const side of ["a", "b"] as const) {
    const episode = ctx.episodes[side];
    if (!episode || ctx.pc(side).signalingState === "stable") continue;
    const { start } = episode;
    const committed = (w: PeerWorld) => ({
      current: [w.currentLocal, w.currentRemote].map(withoutCandidates),
      dtls: w.dtls.slice(0, start.dtls.length),
      sctp: [w.sctp.transport, w.sctp.port],
      remoteIce: w.remoteIce.slice(0, start.remoteIce.length),
      pairs: !episode.pranswerDelivered && w.pairs.slice(0, start.pairs.length),
    });
    // pending 中も確定済み session が使う状態はそのまま。
    expect(committed(peerWorld(ctx, ctx.pc(side))), side).toEqual(
      committed(start),
    );
  }
};

/**
 * rollback: a peer that returns to stable by rollback is as at the start of
 * the episode, except what the proposal only reserved: a MID no current
 * description negotiates (createOffer associates new transceivers) is taken
 * back, a staged ICE restart is dropped (the local credentials are the
 * current ones), a transceiver the application added meanwhile stays (with
 * its track and its sender's SSRC route) without MID or m-line, and no
 * remote-created one stays.
 */
export const judgeRollback: Judge = (ctx, op, _before, error) => {
  if (error || !isDescription(op) || op.desc !== "rollback") return;
  const episode = ctx.episodes[op.by!];
  if (!episode) return;
  const { start } = episode;
  const now = peerWorld(ctx, ctx.pc(op.by!));
  const kept = new Set(start.transceivers.map((t) => t.id));
  const addedSenders = new Set<number>();
  for (const [position, t] of now.transceivers.entries()) {
    if (kept.has(t.id)) continue;
    // pending 中にアプリが足した transceiver だけが残り、MID と m-line を持たない。
    expect(episode.added.has(t.id!), `transceiver ${t.id} kept`).toBe(true);
    expect([t.mid, t.index, t.stopped]).toEqual([null, undefined, false]);
    addedSenders.add(position * 2);
  }
  const values = (pattern: RegExp, ...sdps: (string | undefined)[]) =>
    new Set(
      sdps.flatMap((sdp) =>
        [...(sdp ?? "").matchAll(pattern)].map((m) => m[1]),
      ),
    );
  const negotiated = values(
    /^a=mid:(\S+)/gm,
    now.currentLocal,
    now.currentRemote,
  );
  const ufrags = values(/^a=ice-ufrag:(\S+)/gm, now.currentLocal);
  for (const { ufrag, staged } of now.ice) {
    // staged の restart は捨てられ、local の資格情報は current のもの。
    expect([staged, ufrags.has(ufrag)]).toEqual([false, true]);
  }
  const pairs = (w: PeerWorld) => !episode.pranswerDelivered && w.pairs;
  const ssrcTable = Object.entries(now.ssrcTable).filter(
    ([, endpoint]) => !addedSenders.has(endpoint),
  );
  // それ以外は episode 開始時の状態に戻る。
  expect(
    {
      ...settled(now),
      ice: undefined,
      pairs: pairs(now),
      transceivers: now.transceivers.filter((t) => kept.has(t.id)),
      ssrcTable: Object.fromEntries(ssrcTable),
    },
    `${op.by} rollback`,
  ).toEqual({
    ...settled(start),
    ice: undefined,
    pairs: pairs(start),
    transceivers: start.transceivers.map((t) =>
      t.mid && negotiated.has(t.mid)
        ? t
        : { ...t, mid: null, index: undefined },
    ),
  });
};

/** reject: a rejected operation leaves both peers exactly as before. */
export const judgeReject: Judge = (ctx, op, before, error) => {
  // 拒否された操作は両 peer の状態を一切変えない。
  if (op.reject && error) expect(world(ctx)).toEqual(before);
};

/**
 * create: createOffer / createAnswer only describe. The creating peer keeps
 * its descriptions, MIDs, m-line positions, routes and transports; in stable
 * createOffer may only associate a transceiver that has no MID yet, and the
 * credentials it stages for an ICE restart are not compared.
 */
export const judgeCreate: Judge = (ctx, op, before) => {
  if (op.op !== "createOffer" && op.op !== "createAnswer") return;
  const self = before[op.by!];
  const associates =
    self.signalingState === "stable" && op.op === "createOffer";
  const free = new Set(
    self.transceivers.filter((t) => !t.mid).map((t) => t.id),
  );
  const comparable = (w: PeerWorld) => ({
    ...settled(w),
    ice: undefined,
    transceivers: w.transceivers.map((t) =>
      associates && free.has(t.id) ? { ...t, mid: 0, index: 0 } : t,
    ),
  });
  // description の生成は peer の状態を変えない。
  expect(comparable(peerWorld(ctx, ctx.pc(op.by!)))).toEqual(comparable(self));
};

const videoSection = (sdp = "") =>
  sdp.split(/(?=^m=)/m).find((s) => /^a=mid:0\r?$/m.test(s)) ?? "";
const videoCandidates = (sdp?: string) =>
  [...videoSection(sdp).matchAll(/^a=(candidate:[^\r\n]+)/gm)].map((m) => m[1]);

/**
 * trickle: a trickled candidate joins the remote description (pending if
 * any, else current) of the generation it names, exactly once and only
 * before that generation's end-of-candidates; a repeated candidate or
 * end-of-candidates changes neither the description nor the checklist, and
 * a candidate of another generation joins no description.
 */
export const judgeTrickle: Judge = (ctx, op, before, error) => {
  if (op.op !== "addCandidate" && op.op !== "endOfCandidates") return;
  const pc = ctx.pc(op.by!);
  if (ctx.once) {
    // 2 回目の同じ候補 / end-of-candidates は何も足さない。
    expect(pc.remoteDescription?.sdp).toBe(ctx.once.sdp);
    expect(remoteCandidateCount(pc)).toBe(ctx.once.count);
  }
  if (op.op === "endOfCandidates" || error) return;
  const { pendingRemote, currentRemote } = before[op.by!];
  const target = pendingRemote ?? currentRemote;
  for (const [was, now] of [
    [pendingRemote, pc.pendingRemoteDescription?.sdp],
    [currentRemote, pc.currentRemoteDescription?.sdp],
  ]) {
    if (!was) continue;
    const open =
      was === target && !/^a=end-of-candidates/m.test(videoSection(was));
    const joining = candidatesOf(ctx, op)
      .filter((c) => open && c.usernameFragment === ufragOf(was))
      .map((c) => c.candidate);
    const actual = videoCandidates(now);
    // その generation の description に一度だけ加わり、他の description は変わらない。
    expect(actual.length, "a candidate is listed twice").toBe(
      new Set(actual).size,
    );
    expect(new Set(actual)).toEqual(
      new Set([...videoCandidates(was), ...joining]),
    );
  }
};

/**
 * ice: ICE credentials follow the restart requests (W3C restartIce() and
 * [[LocalIceCredentialsToReplace]], JSEP 5.2.1 / 5.3.1). restartIce()
 * marks the current and pending local credentials for replacement. An
 * offer reuses the credentials of a pending local restart offer unless they
 * are marked; otherwise it has new credentials (none of the marked ones)
 * while a restart is requested or `iceRestart` is set, and the committed
 * ones if not. Every answer to one remote restart offer has the same new
 * credentials, used by no offer of that peer. A commit of unmarked local
 * credentials ends the request; a commit that changes credentials makes
 * them the transports' and advances the ICE generation by one.
 */
export const judgeIce: Judge = (ctx, op, before, error) => {
  if (!op.by || error) return;
  type Model = {
    /** [[LocalIceCredentialsToReplace]]; undefined without a restart request */
    replace?: Set<string | undefined>;
    /** ufrags of every offer this peer created */
    offered: string[];
    /** ufrag of the answers to each pending remote offer */
    answers: Map<string, string>;
  };
  const models = (ctx.memo.ice ??= {}) as Partial<Record<Side, Model>>;
  const model = (models[op.by] ??= {
    offered: [],
    answers: new Map(),
  } as Model);
  const self = before[op.by];
  const committed = ufragOf(self.currentLocal);
  const pendingLocal = ufragOf(self.pendingLocal);
  const created = (name: string) => ufragOf(ctx.saved.get(name)?.sdp)!;
  if (op.op === "restartIce") {
    model.replace = new Set([committed, pendingLocal]);
  } else if (op.op === "createOffer") {
    const ufrag = created(op.as ?? "offer");
    model.offered.push(ufrag);
    if (self.pendingRemote) return;
    const pending = pendingLocal !== committed ? pendingLocal : undefined;
    if (pending && !model.replace?.has(pending)) {
      // 置き換え対象でない pending の restart offer の資格情報を再利用する。
      expect(ufrag, "offer while a restart offer is pending").toBe(pending);
    } else if (model.replace || op.restart) {
      // restart の要求中は current とも置き換え対象とも違う資格情報。
      expect([...(model.replace ?? []), committed]).not.toContain(ufrag);
    } else {
      expect(ufrag, "offer without restart").toBe(committed);
    }
  } else if (op.op === "createAnswer" && self.pendingRemote) {
    const ufrag = created(op.as ?? "answer");
    const key = withoutCandidates(self.pendingRemote)!;
    if (model.answers.has(key)) {
      // 同じ remote offer への answer は同じ資格情報。
      expect(ufrag, "answer created again").toBe(model.answers.get(key));
    } else if (ufragOf(self.pendingRemote) !== ufragOf(self.currentRemote)) {
      // remote の restart への answer は current とも、作った offer とも違う新しい資格情報。
      expect([...model.offered, committed]).not.toContain(ufrag);
    } else if (!model.replace) {
      expect(ufrag, "answer without restart").toBe(committed);
    }
    model.answers.set(key, ufrag);
  } else if (isDescription(op) && op.desc !== "rollback") {
    const pc = ctx.pc(op.by);
    if (pc.signalingState !== "stable" || self.signalingState === "stable")
      return;
    model.answers.clear();
    const local = ufragOf(pc.currentLocalDescription?.sdp);
    const remote = ufragOf(pc.currentRemoteDescription?.sdp);
    // 確定した資格情報が ICE transport の local パラメータになる。
    for (const transport of pc.iceTransports) {
      expect(transport.localParameters.usernameFragment).toBe(local);
    }
    if (local !== committed || remote !== ufragOf(self.currentRemote)) {
      // 資格情報の変わる確定で ICE generation は 1 つ進む。
      expect(pc.iceGeneration, "generation after a restart").toBe(
        ctx.episodes[op.by]!.start.generation + 1,
      );
    }
    // 置き換え対象でない資格情報の確定で restart の要求は満たされる。
    if (model.replace && !model.replace.has(local)) model.replace = undefined;
  }
};

// --- random scenarios ---

export type Generator = (rng: SeededRandom, steps: number) => Op[];
/** `steps` episodes of a text generator. */
export const episodes =
  (episode: (rng: SeededRandom) => string[]): Generator =>
  (rng, steps) =>
    scenario([...Array(steps)].flatMap(() => episode(rng)).join("\n"));

const pick = <T>(rng: SeededRandom, chance: number, value: T) =>
  rng.chance(chance) ? value : undefined;
const invalidRemoteOffer = ["ptRemap", "fingerprint", "sctpPort", "midWrong"];
const invalidRemoteAnswer = [
  "flipSetup",
  "midSuffix",
  "bundleSuffix",
  "ptRemap",
];
const errorOf = (edit: string) =>
  /Suffix$/.test(edit)
    ? "InvalidModificationError|OperationError"
    : "InvalidModificationError";

/**
 * One random episode from stable to stable on either peer: optional new
 * audio, restartIce(), glare, ICE restart, edited remote offers, trickle, a
 * transceiver added meanwhile (`addDuring`), replacement offers, pranswers
 * (direction / max-message-size edits), invalid descriptions (`invalid`)
 * and the final answer or rollback.
 */
export function randomEpisode(
  rng: SeededRandom,
  options: {
    audio?: boolean;
    invalid?: number;
    trickle?: number;
    finish?: readonly ("answer" | "rollback")[];
    pendingAlive?: number;
    addDuring?: number;
  } = {},
): string[] {
  const by: Side = rng.pick(["a", "b"]);
  const to = other(by);
  const invalid = () => rng.chance(options.invalid ?? 0);
  const trickle = rng.chance(options.trickle ?? 0);
  const restart = rng.chance(0.25);
  const remoteEdit = trickle
    ? "noCandidates"
    : pick(rng, 0.2, `mms:${rng.pick([32768, 98304, 131072])}`);
  const lines = [
    options.audio && rng.chance(0.3) ? `${by} addTransceiver audio` : "",
    rng.chance(0.15) ? `${by} restartIce` : "",
    // 相手も offer を出していて (glare)、offer の受信で暗黙に rollback する。
    rng.chance(0.1) ? `${to} createOffer; ${to} setLocal offer` : "",
    `${by} createOffer${restart ? " restart" : ""}; ${by} setLocal offer`,
  ];
  if (invalid()) {
    const edit = rng.pick(invalidRemoteOffer);
    lines.push(
      `${to} setRemote local:${by} edit=${edit} reject=${errorOf(edit)}`,
    );
  }
  lines.push(
    `${to} setRemote local:${by}${remoteEdit ? ` edit=${remoteEdit}` : ""}`,
  );
  if (trickle) {
    lines.push(
      `${to} addCandidate local:${by}${rng.chance(0.5) ? " twice" : ""}`,
    );
    if (rng.chance(0.5)) lines.push(`${to} endOfCandidates twice`);
  }
  if (rng.chance(options.addDuring ?? 0)) {
    lines.push(`${by} addTransceiver ${rng.pick(["audio", "video"])} bare`);
  }
  if (rng.chance(0.15))
    lines.push(`${by} offer${rng.chance(0.3) ? " restart" : ""}`);
  if (invalid()) {
    lines.push(
      `${to} setRemote local:${by} edit=noBundle reject=InvalidModificationError`,
    );
  }
  for (let index = rng.pick([0, 0, 1, 2]); index > 0; index--) {
    const edit = pick(rng, 0.3, rng.pick(["recvonly", "inactive"]));
    const remote = pick(rng, 0.2, `mms:${rng.pick([65536, 81920])}`);
    lines.push(
      `${to} reply pranswer${edit ? ` edit=${edit}` : ""}${remote ? ` remote=${remote}` : ""}`,
    );
  }
  if (rng.chance(options.pendingAlive ?? 0.3)) lines.push("alive");
  if (rng.pick(options.finish ?? ["answer", "rollback"]) === "rollback") {
    lines.push(`${by} rollback`);
  } else {
    lines.push(`${to} createAnswer`);
    if (invalid()) {
      lines.push(
        `${to} setLocal answer edit=flipSetup reject=InvalidModificationError`,
      );
    }
    lines.push(`${to} setLocal answer`);
    if (invalid()) {
      const edit = rng.pick(invalidRemoteAnswer);
      lines.push(`${by} setRemote answer edit=${edit} reject=${errorOf(edit)}`);
    }
    const final = pick(rng, 0.2, `mms:${rng.pick([65536, 262144])}`);
    // restartIce() の要求は前の episode から残ることもあるので、毎回 nomination を待つ。
    lines.push(
      `${by} setRemote answer${final ? ` edit=${final}` : ""}`,
      "nominated",
    );
  }
  if (invalid()) {
    lines.push(
      `${rng.pick(["a", "b"])} setLocal rollback reject=InvalidStateError`,
    );
  }
  return [...lines, "alive"].filter(Boolean);
}

/** Random ICE credential episodes: restartIce(), unapplied offers, repeated answers, glare, rollback. */
export function randomIceEpisode(rng: SeededRandom): string[] {
  const by: Side = rng.pick(["a", "b"]);
  const to = other(by);
  const restart = () => (rng.chance(0.5) ? " restart" : "");
  const unapplied = (side: Side) =>
    rng.chance(0.3) ? `${side} createOffer as=unapplied${restart()}` : "";
  const lines = [
    rng.chance(0.5) ? `${by} restartIce` : "",
    unapplied(by),
    `${by} createOffer as=saved${rng.chance(0.4) ? " restart" : ""}`,
    rng.chance(0.3) ? `${by} restartIce` : "",
    `${by} setLocal saved`,
    unapplied(by),
  ];
  if (rng.chance(0.2)) {
    // glare: 相手の offer を受けて暗黙に rollback し、restart しない answer を確定する。
    return [...lines, `${to} offer`, `${by} reply`, "nominated", "alive"];
  }
  if (rng.chance(0.25)) {
    lines.push(`${by} setLocal rollback`);
    // 後から作った offer があると保存した offer は再適用できない。
    if (lines.some((line) => line.includes("unapplied")))
      return [...lines, "alive"];
    lines.push(`${by} setLocal saved`);
  }
  return [
    ...lines,
    `${to} setRemote local:${by}`,
    `${to} createAnswer as=first`,
    unapplied(to),
    rng.chance(0.4) ? `${to} createAnswer` : "",
    `${to} setLocal first`,
    `${by} setRemote local:${to}`,
    "nominated",
    "alive",
  ].filter(Boolean);
}
