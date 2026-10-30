import { expect } from "vitest";
import type {
  RTCDataChannel,
  RTCDtlsTransport,
  RTCIceTransport,
  RTCPeerConnection,
  RTCRtpReceiver,
  RTCRtpTransceiver,
} from "../../../src";
import { SessionDescription } from "../../../src";
import type {
  AppliedStep,
  NegotiationCase,
  Observer,
} from "../../negotiation/harness/negotiationCase";
import {
  type NegotiationEvents,
  negotiationSnapshot,
  recordNegotiationEvents,
  registeredDataChannels,
  waitUntil,
} from "../../negotiation/harness/negotiationTransactionUtils";

/**
 * The oracles of the model property: claims of the negotiation transaction
 * that hold after every description operation of any scene, so a scene needs
 * no expectations of its own. The case harness runs them through
 * `c.observe()` next to the invariants of both peers and the traffic
 * property (`c.expectTraffic()`).
 *
 * - jsep: an accepted operation moves the peer to the JSEP state of its type
 *   (offer / pranswer / answer / rollback), sets the pending or current
 *   description it applied and keeps the other ones; the other peer is
 *   untouched.
 * - rollback: an explicit rollback returns the peer to the state the
 *   transaction started from (descriptions, ICE credentials, MIDs and
 *   m-line indexes, router tables); a transceiver the application added
 *   meanwhile stays, without a MID.
 * - events: a state change fires `signalingstatechange` ending in the new
 *   state, no change fires none; rollback and an idempotent re-application
 *   fire no track, transceiver or DataChannel event.
 * - idempotent: re-applying the pending description, or creating an offer or
 *   answer, changes nothing.
 * - trickle: a trickled candidate is in the remote description at most once.
 * - commit: once both peers have the same current session, the
 *   `currentDirection` of every m-line mirrors the other peer's and every
 *   sending codec is in the other peer's receive table.
 * - channels: a DataChannel open on a committed session stays open; a
 *   remote channel is announced once.
 * - feedback: after a packet of payload type P reached a receiver, a PLI
 *   request leaves it exactly when P's effective `a=rtcp-fb` has `nack pli`,
 *   and transport-cc feedback runs when it has `transport-cc`. The effective
 *   feedback of P is the receiver's current remote description's when the
 *   current session has P on that m-line (a pending change is staged until
 *   the final answer), else the pending remote description's (an added
 *   payload type applies at once). An operation that commits nothing never
 *   starts transport-cc feedback for a packet whose codec lacks it, and
 *   rollback returns it to the start of the transaction.
 * - ice: an operation that commits nothing keeps the selected pair of every
 *   connected ICE transport (a restart checks its new generation beside it).
 * - continuity: at a commit, an m-line of the previous and the new current
 *   session that keeps its BUNDLE transport (same tag, or unbundled in
 *   both) keeps its DTLS transport object (no new handshake, RFC 8843).
 * (A rejected operation changing nothing is checked by the harness.)
 */
type World = ReturnType<typeof world>;

const bare = (sdp?: string | null) =>
  sdp?.replace(/^a=(candidate:|end-of-candidates).*\r?\n/gm, "");
/** An applied SDP as the peer stores it (parsed and written again), without candidates. */
const stored = (sdp?: string) =>
  sdp === undefined ? undefined : bare(SessionDescription.parse(sdp).string);

function world(pc: RTCPeerConnection) {
  const snapshot = negotiationSnapshot(pc);
  return {
    ...snapshot,
    currentLocal: bare(snapshot.currentLocal),
    currentRemote: bare(snapshot.currentRemote),
    pendingLocal: bare(snapshot.pendingLocal),
    pendingRemote: bare(snapshot.pendingRemote),
    objects: [...pc.getTransceivers()],
    sendParams: pc.getTransceivers().map((t) => liveSendParams(t)),
    receiveTables: pc
      .getTransceivers()
      .map((t) => t.receiver.snapshotReceiveTables()),
    iceObjects: [...pc.iceTransports],
    routes: routes(pc, pc.getTransceivers()),
    twcc: pc.getTransceivers().map((t) => !!t.receiver.receiverTWCC),
    transports: transportsByMid(pc),
  };
}

/**
 * The send parameters a negotiation decides. The codec a pending remote
 * offer proposes for the answer (`proposedPrimaryCodec`) is not live (a
 * createOffer while the offer is pending may resolve it again, 2.5-17), and
 * the track is the application's (a rollback keeps a replaced track).
 */
function liveSendParams(t: RTCRtpTransceiver) {
  const {
    proposedPrimaryCodec: _proposed,
    track: _track,
    trackCodec: _trackCodec,
    ...live
  } = t.sender.snapshotSendParams();
  return live;
}

/** The DTLS transport each MID of `pc` uses (transceivers and SCTP). */
function transportsByMid(pc: RTCPeerConnection) {
  const map = new Map<string, RTCDtlsTransport>();
  for (const t of pc.getTransceivers()) {
    if (t.mid != undefined && !t.stopped) map.set(t.mid, t.dtlsTransport);
  }
  if (pc.sctpTransport?.mid != undefined) {
    map.set(pc.sctpTransport.mid, pc.sctpTransport.dtlsTransport);
  }
  return map;
}

/** The transport key of `mid` in `sdp`: its BUNDLE tag, or itself when unbundled. */
function transportKey(sdp: string | undefined, mid: string) {
  const sections = sdp?.split(/(?=^m=)/m) ?? [];
  const section = sections.find((s) => s.includes(`a=mid:${mid}\r`));
  if (!section || /^m=\S+ 0 /.test(section)) return undefined;
  for (const [, group] of sdp!.matchAll(/^a=group:BUNDLE ([^\r\n]+)/gm)) {
    const mids = group.trim().split(" ");
    if (mids.includes(mid)) return `bundle:${mids[0]}`;
  }
  return `own:${mid}`;
}

/** The `a=rtcp-fb` values of payload type `pt` in an m-section. */
function feedbackOf(section: string, pt: number) {
  return section
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.startsWith(`a=rtcp-fb:${pt} `) || line.startsWith("a=rtcp-fb:* "),
    )
    .map((line) => line.slice(line.indexOf(" ") + 1));
}

/**
 * The effective `a=rtcp-fb` of payload type `pt` for the receiver of `mid`:
 * the current remote description's if the current session has `pt` on that
 * m-line, else the pending remote description's (undefined: neither has it).
 */
function effectiveFeedback(pc: RTCPeerConnection, mid: string, pt: number) {
  const section = (sdp?: string) =>
    sdp
      ?.split(/(?=^m=)/m)
      .find((s) => s.includes(`a=mid:${mid}\r`) && !/^m=\S+ 0 /.test(s));
  const hasPt = (s?: string) =>
    !!s && s.split(/\r?\n/)[0].split(" ").slice(3).includes(String(pt));
  const current = section(pc.currentRemoteDescription?.sdp);
  if (hasPt(current)) return feedbackOf(current!, pt);
  const pending = section(pc.pendingRemoteDescription?.sdp);
  if (hasPt(pending)) return feedbackOf(pending!, pt);
  return undefined;
}

/** Whether `action` makes `receiver` send an RTCP packet of `type` / `count` (FMT). */
async function rtcpSent(
  receiver: RTCRtpReceiver,
  type: number,
  count: number,
  action: () => Promise<unknown>,
) {
  const transport = receiver.dtlsTransport;
  const original = transport.sendRtcp;
  let sent = false;
  transport.sendRtcp = (packets) => {
    for (const packet of packets as {
      type: number;
      feedback?: { count: number };
    }[]) {
      if (packet.type === type && packet.feedback?.count === count) sent = true;
    }
    return original.call(transport, packets);
  };
  try {
    await action();
  } finally {
    transport.sendRtcp = original;
  }
  return sent;
}

/**
 * The descriptions and ICE credentials an explicit rollback restores: the
 * credentials of the transports that existed when the transaction started,
 * except a restart only a created offer staged (rollback drops it); a
 * transport created meanwhile for an object the application keeps stays.
 */
const restored = (w: World, baseline: World, after: World) => ({
  signalingState: w.signalingState,
  currentLocal: w.currentLocal,
  currentRemote: w.currentRemote,
  ice: baseline.iceObjects
    .filter(
      (transport, i) =>
        !baseline.ice[i].staged && after.iceObjects.includes(transport),
    )
    .map((transport) => w.ice[w.iceObjects.indexOf(transport)].ufrag),
});
/** Router entries that point at `objects` (by position), for comparing routes. */
function routes(pc: RTCPeerConnection, objects: RTCRtpTransceiver[]) {
  const router = (
    pc as unknown as {
      router: {
        ssrcTable: Record<string, unknown>;
        ridTable: Record<string, unknown>;
      };
    }
  ).router;
  const endpoints = objects.flatMap((t) => [t.sender, t.receiver]) as unknown[];
  const table = (entries: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(entries)
        .map(([key, value]) => [key, endpoints.indexOf(value)] as const)
        .filter(([, index]) => index >= 0),
    );
  return { ssrc: table(router.ssrcTable), rid: table(router.ridTable) };
}
/** The m-line structure of an SDP (kind and MID per m-line), for local descriptions. */
const structure = (sdp?: string | null) =>
  sdp
    ?.split(/(?=^m=)/m)
    .slice(1)
    .map((s) => `${s.split(" ")[0]} ${s.match(/^a=mid:(\S+)/m)?.[1]}`);
const described = (w: World) => ({
  signalingState: w.signalingState,
  currentLocal: w.currentLocal,
  currentRemote: w.currentRemote,
  pendingLocal: w.pendingLocal,
  pendingRemote: w.pendingRemote,
  sendParams: w.sendParams,
  receiveTables: w.receiveTables,
});

const STATE: Record<string, Record<string, string>> = {
  setLocal: {
    offer: "have-local-offer",
    pranswer: "have-local-pranswer",
    answer: "stable",
    rollback: "stable",
  },
  setRemote: {
    offer: "have-remote-offer",
    pranswer: "have-remote-pranswer",
    answer: "stable",
    rollback: "stable",
  },
};
const MIRROR: Record<string, string> = {
  sendrecv: "sendrecv",
  sendonly: "recvonly",
  recvonly: "sendonly",
  inactive: "inactive",
};

type Before = {
  self: World;
  other?: World;
  counts: number[];
  signaling: number;
  /** Receivers whose transport-cc feedback ran (both peers). */
  twcc: Set<RTCRtpReceiver>;
  /** The selected pair of every connected ICE transport (both peers). */
  pairs: Map<RTCIceTransport, unknown>;
};

export class ModelOracles implements Observer {
  private readonly events = new Map<RTCPeerConnection, NegotiationEvents>();
  /** The world a peer's open transaction started from. */
  private readonly baselines = new Map<RTCPeerConnection, World>();
  /** DataChannel pairs open on a committed session. */
  private readonly committed = new Set<[RTCDataChannel, RTCDataChannel]>();
  /** The next operation must change nothing (an idempotent re-application). */
  idempotent = false;
  /** Transceivers and DataChannels the application created. */
  private readonly applicationTransceivers = new Set<RTCRtpTransceiver>();
  /** DataChannels the application created, with the peer that created them. */
  private readonly applicationChannels = new Map<
    RTCDataChannel,
    RTCPeerConnection
  >();
  /** The streams of the last track event per receiver. */
  private readonly lastStreams = new Map<unknown, string>();
  /** Receivers that stopped receiving (or were rolled back) since their last track event. */
  private readonly receivingReset = new Set<unknown>();

  /** Arrange: a transceiver the application created (it must survive negotiation). */
  application(object: RTCRtpTransceiver) {
    this.applicationTransceivers.add(object);
  }

  /** Arrange: a DataChannel the application created on `pc` (it never closes). */
  channel(channel: RTCDataChannel, pc: RTCPeerConnection) {
    this.applicationChannels.set(channel, pc);
  }

  constructor(private readonly c: NegotiationCase) {}

  /** Arrange: observe the two peers of the scene from now on. */
  watch(a: RTCPeerConnection, b: RTCPeerConnection) {
    for (const pc of [a, b]) this.events.set(pc, recordNegotiationEvents(pc));
    this.c.observe(this);
  }

  before(pc: RTCPeerConnection): Before {
    const other = this.other(pc);
    const peers = [...this.events.keys()];
    const twcc = new Set<RTCRtpReceiver>();
    const pairs = new Map<RTCIceTransport, unknown>();
    for (const peer of peers) {
      for (const t of peer.getTransceivers()) {
        if (t.receiver.receiverTWCC) twcc.add(t.receiver);
      }
      for (const transport of peer.iceTransports) {
        const nominated = transport.connection?.nominated;
        if (
          transport.state === "connected" ||
          transport.state === "completed"
        ) {
          if (nominated) pairs.set(transport, nominated);
        }
      }
    }
    return {
      self: world(pc),
      other: other && world(other),
      counts: this.counts(pc),
      signaling: this.events.get(pc)!.signaling.length,
      twcc,
      pairs,
    };
  }

  /**
   * The WARP policy `setConfiguration` set reaches every transport that is
   * created and not closed: live, prepared for a pending description, or
   * held by a rollback baseline.
   */
  private warpConfigReachesOpenTransports(
    pc: RTCPeerConnection,
    label: string,
  ) {
    const normalize = (warp?: {
      allowEarlyServerData?: boolean;
      earlyMediaPolicy?: string;
    }) => ({
      allowEarlyServerData: warp?.allowEarlyServerData === true,
      earlyMediaPolicy: warp?.earlyMediaPolicy ?? "drop",
    });
    const expected = normalize(pc.getConfiguration().warp);
    const open = (
      pc as unknown as {
        secureManager: {
          openDtlsTransports: { id: string; config: { warp?: never } }[];
        };
      }
    ).secureManager.openDtlsTransports;
    for (const transport of open) {
      expect(
        normalize(transport.config.warp),
        `${label}: WARP policy of transport ${transport.id}`,
      ).toEqual(expected);
    }
  }

  async after(step: AppliedStep, raw: unknown) {
    const { pc } = step;
    const before = raw as Before;
    if (pc.signalingState === "closed") return;
    const now = world(pc);
    const label = `${step.kind}(${step.type ?? "candidate"})`;
    this.warpConfigReachesOpenTransports(pc, label);
    const other = this.other(pc);
    // jsep: 相手の peer は変わらない (自分の操作だけが自分の状態を変える)。
    if (other && before.other && other.signalingState !== "closed") {
      expect(
        described(world(other)),
        `${label}: the other peer changed`,
      ).toEqual(described(before.other));
    }
    if (step.error) return;
    if (step.kind === "addCandidate") {
      this.trickled(step);
    } else {
      this.transition(step, before.self, now, label);
      this.rollback(step, before.self, now, label);
    }
    this.signalingEvents(pc, before, label);
    this.trackEvents(pc, before, step, label);
    for (const [channel, owner] of this.applicationChannels) {
      // アプリが作った DataChannel は交渉で閉じない (SCTP transport が替わっても)。
      if (owner === pc) {
        expect(
          channel.readyState,
          `${label}: channel ${channel.label}`,
        ).not.toBe("closed");
        // その channel は peer の SCTP transport の上にある (rollback で外れない)。
        expect(pc.sctpTransport, `${label}: SCTP of ${channel.label}`).toBe(
          channel.sctp,
        );
      }
    }
    this.announcedOnce(pc, label);
    for (const t of pc.getTransceivers()) {
      // m-line のない transceiver は (停止したものを除き) currentDirection を持たない。
      if (t.mid == undefined && !t.stopped) {
        expect(
          t.currentDirection ?? null,
          `${label}: a transceiver without an m-line has a direction`,
        ).toBe(null);
      }
    }
    await this.feedback(step, before, label);
    this.selectedPairs(step, before, label);
    if (this.idempotent || step.type === "rollback") {
      // rollback と同じ description の再適用は track・transceiver・channel を通知しない。
      expect(this.counts(pc), `${label}: new events`).toEqual(before.counts);
    }
    if (this.idempotent) {
      expect(
        described(now),
        `${label}: a re-application changed state`,
      ).toEqual(described(before.self));
      this.idempotent = false;
    }
    this.commit(label);
  }

  /** Assert (idempotent): `action` (createOffer / createAnswer) changes nothing on `pc`. */
  async unchanged(pc: RTCPeerConnection, action: () => Promise<unknown>) {
    const before = world(pc);
    const counts = this.counts(pc);
    await action();
    expect(described(world(pc)), "create changed state").toEqual(
      described(before),
    );
    expect(this.counts(pc), "create fired events").toEqual(counts);
  }

  /**
   * events: a track event fires for a receiver only once until it stops
   * receiving (its remote m-line no longer sends, or a rollback, also an
   * implicit one), unless its streams change.
   */
  private trackEvents(
    pc: RTCPeerConnection,
    before: Before,
    step: AppliedStep,
    label: string,
  ) {
    // 暗黙の rollback (操作の途中で stable を通知した) の後は、rollback と同じく
    // 同じ offer を適用し直せば track をまた通知してよい (W3C)。
    const implicitRollback =
      pc.signalingState !== "stable" &&
      this.events.get(pc)!.signaling.slice(before.signaling).includes("stable");
    if (implicitRollback) {
      for (const t of pc.getTransceivers()) this.receivingReset.add(t.receiver);
    }
    const fired = this.events.get(pc)!.tracks.slice(before.counts[0]);
    for (const event of fired) {
      const streams = event.streams.map((stream) => stream.id).join(",");
      const last = this.lastStreams.get(event.receiver);
      expect(
        last === undefined ||
          this.receivingReset.has(event.receiver) ||
          last !== streams,
        `${label}: track event repeated for ${event.transceiver.mid}`,
      ).toBe(true);
      this.lastStreams.set(event.receiver, streams);
      this.receivingReset.delete(event.receiver);
    }
    const remote = pc.remoteDescription?.sdp.split(/(?=^m=)/m) ?? [];
    for (const t of pc.getTransceivers()) {
      const section = remote.find((s) => s.includes(`a=mid:${t.mid}\r`));
      if (
        step.type === "rollback" ||
        !section ||
        /^m=\S+ 0 /.test(section) ||
        /^a=(recvonly|inactive)\r?$/m.test(section)
      ) {
        this.receivingReset.add(t.receiver);
      }
    }
  }

  /**
   * channels: at the end of a scene, every DataChannel the application
   * created on a negotiated association opens and has its remote channel.
   */
  async finish() {
    const [a, b] = [...this.events.keys()];
    for (const [channel, pc] of this.applicationChannels) {
      const other = pc === a ? b : a;
      const negotiated =
        pc.signalingState === "stable" &&
        other.signalingState === "stable" &&
        pc.sctpTransport?.mid != undefined &&
        !!pc.currentRemoteDescription?.sdp.includes(
          `a=mid:${pc.sctpTransport.mid}\r`,
        ) &&
        !/^m=application 0 /m.test(pc.currentRemoteDescription.sdp);
      if (!negotiated) continue;
      await waitUntil(
        () =>
          channel.readyState === "open" &&
          registeredDataChannels(other).some(
            (c) => c.id === channel.id && c.readyState === "open",
          ),
        `channel ${channel.label} did not open on both peers`,
        10_000,
      );
    }
  }

  private other(pc: RTCPeerConnection) {
    return [...this.events.keys()].find((p) => p !== pc);
  }

  /** Track and remote-transceiver events (a DataChannel arrives asynchronously by DCEP). */
  private counts(pc: RTCPeerConnection) {
    const e = this.events.get(pc)!;
    return [e.tracks.length, e.remoteTransceivers.length];
  }

  /** jsep: the state of the applied type, with the description it set. */
  private transition(
    step: AppliedStep,
    before: World,
    now: World,
    label: string,
  ) {
    const local = step.kind === "setLocal";
    // バイト単位で同じ remote offer の再適用は何も変えない (idempotent で検査する)。
    if (this.idempotent) return;
    expect(now.signalingState, `${label}: signaling state`).toBe(
      STATE[step.kind][step.type!],
    );
    if (step.type === "answer") {
      expect(
        [now.pendingLocal, now.pendingRemote],
        `${label}: pending`,
      ).toEqual([undefined, undefined]);
      if (local) {
        expect(structure(now.currentLocal), label).toEqual(structure(step.sdp));
      } else expect(now.currentRemote, label).toBe(stored(step.sdp));
      return;
    }
    // offer / pranswer / rollback は current を変えない。
    expect([now.currentLocal, now.currentRemote], `${label}: current`).toEqual([
      before.currentLocal,
      before.currentRemote,
    ]);
    if (step.type === "rollback") {
      expect(
        [now.pendingLocal, now.pendingRemote],
        `${label}: pending`,
      ).toEqual([undefined, undefined]);
    } else if (local) {
      // local の offer は分割した m-line の資格情報などが書き直されうる (m-line の構成は同じ)。
      expect(structure(now.pendingLocal), label).toEqual(structure(step.sdp));
    } else {
      expect(now.pendingRemote, label).toBe(stored(step.sdp));
    }
  }

  /** rollback: back to the world the transaction started from. */
  private rollback(
    step: AppliedStep,
    before: World,
    now: World,
    label: string,
  ) {
    const { pc } = step;
    if (before.signalingState === "stable" && now.signalingState !== "stable") {
      this.baselines.set(pc, before);
    }
    if (now.signalingState !== "stable") return;
    const baseline = this.baselines.get(pc);
    this.baselines.delete(pc);
    if (step.type === "answer" && baseline)
      this.continuity(baseline, now, label);
    if (step.type !== "rollback" || !baseline) return;
    expect(
      restored(now, baseline, now),
      `${label}: rollback did not restore`,
    ).toEqual(restored(baseline, baseline, now));
    for (const t of this.applicationTransceivers) {
      // アプリが足した transceiver は rollback で消えない。
      if (before.objects.includes(t)) {
        expect(
          now.objects,
          `${label}: a ${t.kind} transceiver removed`,
        ).toContain(t);
      }
    }
    // 交渉前からある transceiver の送信パラメータと受信表は交渉前に戻る。
    expect(
      baseline.objects.map((t) => now.sendParams[now.objects.indexOf(t)]),
      `${label}: send parameters`,
    ).toEqual(baseline.sendParams);
    expect(
      baseline.objects.map((t) => now.receiveTables[now.objects.indexOf(t)]),
      `${label}: receive tables`,
    ).toEqual(baseline.receiveTables);
    // 交渉前からある transceiver の経路 (SSRC / RID) は交渉前に戻る。
    expect(
      routes(pc, baseline.objects),
      `${label}: rollback did not restore the routes`,
    ).toEqual(baseline.routes);
    const committed = `${baseline.currentLocal ?? ""}${baseline.currentRemote ?? ""}`;
    for (const [index, t] of baseline.objects.entries()) {
      // 交渉前からある transceiver は残る。確定済みの MID は同じ MID と m-line に戻る
      // (createOffer が予約しただけの MID は外れてよい)。
      const { mid, index: mLineIndex } = baseline.transceivers[index];
      expect(now.objects, `${label}: transceiver ${index} removed`).toContain(
        t,
      );
      if (mid == undefined || !committed.includes(`a=mid:${mid}\r`)) continue;
      expect([t.mid, t.mLineIndex], `${label}: transceiver ${index}`).toEqual([
        mid,
        mLineIndex,
      ]);
    }
    for (const t of now.objects) {
      if (baseline.objects.includes(t)) continue;
      // remote offer が作っただけの transceiver は rollback で消える (W3C)。
      expect(
        this.applicationTransceivers.has(t),
        `${label}: a transceiver the remote offer created stayed`,
      ).toBe(true);
      // pending 中にアプリが足した (または track を付けて残した) transceiver は
      // MID を持たず、作成時の状態 (方向・受信表・受信経路なし) で残る。送信側の
      // SSRC 経路はアプリの状態なので残る (Routing keys)。
      const { ssrc, rid } = routes(pc, [t]);
      const receiving = [...Object.values(ssrc), ...Object.values(rid)].filter(
        (endpoint) => endpoint === 1,
      );
      expect(t.mid, `${label}: a transceiver added meanwhile kept a MID`).toBe(
        null,
      );
      expect(
        [
          t.currentDirection ?? null,
          t.receiver.snapshotReceiveTables().codecs,
          receiving.length,
        ],
        `${label}: a kept transceiver kept negotiated state`,
      ).toEqual([null, {}, 0]);
    }
    if (!pc.currentRemoteDescription) {
      // 確定した session がなければ、接続状態も最初の new に戻る。
      expect(
        [pc.connectionState, pc.iceConnectionState],
        `${label}: connection states without a session`,
      ).toEqual(["new", "new"]);
    }
    // pending 中に始まった transport-cc feedback は止まり、交渉前のものは残る。
    expect(
      baseline.objects.map((t) => now.twcc[now.objects.indexOf(t)]),
      `${label}: transport-cc feedback`,
    ).toEqual(baseline.twcc);
  }

  /**
   * continuity: an m-line that keeps its BUNDLE transport across a commit
   * keeps its DTLS transport object.
   */
  private continuity(baseline: World, now: World, label: string) {
    for (const [mid, transport] of baseline.transports) {
      const before = transportKey(baseline.currentLocal, mid);
      const after = transportKey(now.currentLocal, mid);
      if (!before || before !== after || !now.transports.has(mid)) continue;
      // 同じ BUNDLE transport に残る m-line は DTLS をやり直さない。
      expect(
        now.transports.get(mid) === transport,
        `${label}: the DTLS transport of ${mid} was replaced`,
      ).toBe(true);
    }
  }

  /** channels: each remote DataChannel is announced once while it is open. */
  private announcedOnce(pc: RTCPeerConnection, label: string) {
    const open = this.events
      .get(pc)!
      .dataChannels.filter((channel) => channel.readyState !== "closed");
    const ids = open.map((channel) => channel.id);
    expect(
      new Set(ids).size,
      `${label}: a DataChannel was announced twice (${ids})`,
    ).toBe(ids.length);
  }

  /**
   * feedback: PLI and transport-cc follow the effective `a=rtcp-fb` of the
   * payload type each delivered packet had.
   */
  private async feedback(step: AppliedStep, before: Before, label: string) {
    const commits = step.type === "answer" || step.type === "rollback";
    for (const d of this.c.delivered) {
      const { receiver, sender, payloadType } = d;
      if (payloadType == undefined || receiver.mid == undefined) continue;
      if (d.to.signalingState === "closed") continue;
      const fb = effectiveFeedback(d.to, receiver.mid, payloadType);
      if (!fb) continue;
      const what = `${label}: ${receiver.mid} PT ${payloadType} (${fb})`;
      // PLI の要求は、その payload type に nack pli があるときだけ送られる。
      const pli = await rtcpSent(receiver.receiver, 206, 1, () =>
        receiver.receiver.sendRtcpPLI(sender.sender.ssrc),
      );
      expect(pli, `${what}: PLI`).toBe(fb.includes("nack pli"));
      const running = !!receiver.receiver.receiverTWCC;
      if (fb.includes("transport-cc")) {
        // transport-cc を交渉した codec の packet を受けたら feedback が動く。
        expect(running, `${what}: transport-cc not running`).toBe(true);
      } else if (!commits && !before.twcc.has(receiver.receiver)) {
        // 何も確定しない操作は、transport-cc のない packet で feedback を始めない。
        expect(running, `${what}: transport-cc started`).toBe(false);
      }
    }
  }

  /** ice: an operation that commits nothing keeps every selected pair. */
  private selectedPairs(step: AppliedStep, before: Before, label: string) {
    if (step.type === "answer") return;
    for (const [transport, pair] of before.pairs) {
      if (transport.state === "closed") continue;
      // restart の pending 中も、確定済みの選択ペアで通信を続ける。
      expect(
        transport.connection?.nominated === pair,
        `${label}: the selected pair of a connected transport changed`,
      ).toBe(true);
    }
  }

  private signalingEvents(
    pc: RTCPeerConnection,
    before: Before,
    label: string,
  ) {
    const fired = this.events.get(pc)!.signaling.slice(before.signaling);
    if (pc.signalingState === before.self.signalingState) {
      // 状態が変わらない操作は signalingstatechange を出さない (implicit rollback を除く)。
      if (fired.length) expect(fired.at(-1), label).toBe(pc.signalingState);
    } else {
      expect(fired.at(-1), `${label}: signalingstatechange`).toBe(
        pc.signalingState,
      );
    }
  }

  /** trickle: each candidate line is in the remote description at most once. */
  private trickled(step: AppliedStep) {
    const { candidate, sdpMid } = (step.candidate ?? {}) as {
      candidate?: string;
      sdpMid?: string;
    };
    const section = step.pc.remoteDescription?.sdp
      .split(/(?=^m=)/m)
      .find((s) => s.includes(`a=mid:${sdpMid}\r`));
    if (!candidate || !section) return;
    const line = `a=${candidate.replace(/^a=/, "")}`;
    const count = section.split(/\r?\n/).filter((l) => l === line).length;
    expect(
      count,
      `trickle: ${line} appears ${count} times`,
    ).toBeLessThanOrEqual(1);
    // remote description に入った現在の generation の候補は、稼働中の checklist にも届く。
    const [, , , , host, port] = candidate.replace(/^a=/, "").split(" ");
    const ufrag =
      candidate.match(/ ufrag (\S+)/)?.[1] ??
      section.match(/^a=ice-ufrag:(\S+)/m)?.[1];
    const owner =
      step.pc.getTransceivers().find((t) => t.mid === sdpMid)?.dtlsTransport ??
      (step.pc.sctpTransport?.mid === sdpMid
        ? step.pc.sctpTransport!.dtlsTransport
        : undefined);
    const connection = owner?.iceTransport.connection;
    // end-of-candidates の後の候補は SDP にも checklist にも入らない (count 0)。
    if (connection && count === 1 && ufrag === connection.remoteUsername) {
      expect(
        connection.remoteCandidates.some(
          (c) => c.host === host && c.port === Number(port),
        ),
        `trickle: ${host}:${port} did not reach the live checklist`,
      ).toBe(true);
    }
  }

  /** commit + channels, checked while both peers have the same current session. */
  private commit(label: string) {
    const [a, b] = [...this.events.keys()];
    if (
      [a, b].some((pc) => pc.signalingState !== "stable") ||
      !this.c.sameSession(a, b)
    ) {
      return;
    }
    for (const [x, y] of [
      [a, b],
      [b, a],
    ]) {
      for (const t of x.getTransceivers()) {
        const r = remoteOf(y, t);
        if (!r || !t.currentDirection || t.stopped || r.stopped) continue;
        if (t.currentDirection === "stopped" || !r.currentDirection) continue;
        // 両側の currentDirection は互いに鏡像になる。
        expect(r.currentDirection, `${label}: direction of ${t.mid}`).toBe(
          MIRROR[t.currentDirection],
        );
        const codec = t.sender.codec;
        if (!codec || !["sendrecv", "sendonly"].includes(t.currentDirection)) {
          continue;
        }
        // 送信 codec は相手の受信表にある。
        const received = Object.values(
          r.receiver.snapshotReceiveTables().codecs,
        ).map((c) => c.mimeType.toLowerCase());
        expect(received, `${label}: send codec of ${t.mid}`).toContain(
          codec.mimeType.toLowerCase(),
        );
      }
    }
    for (const [x, y] of this.committed) {
      // 確定した session の DataChannel は開いたまま。
      expect([x.readyState, y.readyState], `${label}: channel ${x.id}`).toEqual(
        ["open", "open"],
      );
    }
    for (const channel of registeredDataChannels(a)) {
      const remote = registeredDataChannels(b).find((c) => c.id === channel.id);
      if (channel.readyState === "open" && remote?.readyState === "open") {
        if (![...this.committed].some(([x]) => x === channel)) {
          this.committed.add([channel, remote]);
        }
      }
    }
  }
}

const remoteOf = (pc: RTCPeerConnection, t: RTCRtpTransceiver) =>
  t.mid == undefined
    ? undefined
    : pc.getTransceivers().find((r) => r.mid === t.mid);
