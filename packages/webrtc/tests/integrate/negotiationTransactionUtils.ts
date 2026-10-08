import { expect } from "vitest";

import type { Address } from "../../../common/src";
import { getHostAddresses } from "../../../ice/src/utils";
import {
  TURN_TEST_PASSWORD,
  TURN_TEST_USERNAME,
  createHeldUdpProxy,
  createLocalTurnServer,
} from "../../../ice/tests/utils";
import {
  MediaStreamTrack,
  type RTCDataChannel,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  type RTCRtpReceiver,
  type RTCRtpSender,
  type RTCRtpTransceiver,
  RtpHeader,
  RtpPacket,
  useAbsSendTime,
  useH264,
  useOPUS,
  useSdesMid,
  useSdesRTPStreamId,
  useVP8,
} from "../../src";
import type { RTCIceCandidate } from "../../src";
import { ridRouteKey } from "../../src/negotiation/internalState";
import { SessionDescription } from "../../src/sdp";

/** Shared Arrange setup for negotiation transaction regression tests. */
export async function createConnectedVideoPeers(
  config: ConstructorParameters<typeof RTCPeerConnection>[0] = {},
  {
    trickleOpen = false,
    withAudio = false,
  }: { trickleOpen?: boolean; withAudio?: boolean } = {},
) {
  const offerer = new RTCPeerConnection(config);
  const answerer = new RTCPeerConnection(config);
  const outgoing = new MediaStreamTrack({ kind: "video" });
  let incoming: MediaStreamTrack | undefined;
  answerer.onRemoteTransceiverAdded.subscribe((transceiver) => {
    if (transceiver.kind !== "video") return;
    transceiver.onTrack.subscribe((track) => {
      incoming = track;
    });
  });
  offerer.addTransceiver(outgoing, { direction: "sendonly" });
  // withAudio: a second (non-tag) m-line in the same BUNDLE group.
  if (withAudio) offerer.addTransceiver("audio", { direction: "sendonly" });
  await offerer.setLocalDescription(await offerer.createOffer());
  // trickleOpen: the answerer's current remote generation has no
  // end-of-candidates yet, so later trickle candidates still belong to it.
  const offer = offerer.localDescription!;
  await answerer.setRemoteDescription(
    trickleOpen
      ? {
          type: "offer",
          sdp: offer.sdp.replace(/^a=end-of-candidates\r?\n/gm, ""),
        }
      : offer,
  );
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(answerer.localDescription!);
  await Promise.race([
    Promise.all([
      waitForIce(offerer),
      waitForIce(answerer),
      waitForConnection(offerer),
      waitForConnection(answerer),
    ]),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("ICE did not connect")), 3000),
    ),
  ]);
  if (!incoming) throw new Error("Remote video track was not delivered");
  return { offerer, answerer, outgoing, incoming };
}

/** VP8 without RTCP feedback, for sessions that renegotiate NACK / PLI later. */
export const videoWithoutFeedback = {
  codecs: { video: [useVP8({ rtcpFeedback: [] })] },
};

/** Rewrite the VP8 `a=rtcp-fb` lines of an SDP: remove them, or add NACK and PLI. */
export function rewriteVideoFeedback(sdp: string, mode: "add" | "remove") {
  if (mode === "remove") {
    return sdp.replace(/^a=rtcp-fb:\d+ nack(?: pli)?\r?\n/gm, "");
  }
  return sdp.replace(
    /^(a=rtpmap:(\d+) VP8\/90000)\r?$/m,
    "$1\r\na=rtcp-fb:$2 nack\r\na=rtcp-fb:$2 nack pli",
  );
}

/**
 * Request a PLI from `receiver` for `sender`'s SSRC and report whether it
 * actually reached `sender` (a real RTCP packet over the session).
 */
export async function pliReaches(
  receiver: RTCRtpReceiver,
  sender: RTCRtpSender,
  waitMs = 500,
) {
  let received = false;
  const { unSubscribe } = sender.onPictureLossIndication.subscribe(() => {
    received = true;
  });
  try {
    await receiver.sendRtcpPLI(sender.ssrc);
    const deadline = Date.now() + waitMs;
    while (!received && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return received;
  } finally {
    unSubscribe();
  }
}

/** Connected video + DataChannel session whose SCTP association is established. */
export async function createConnectedMediaAndDataPeers() {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  const outgoing = new MediaStreamTrack({ kind: "video" });
  let incoming: MediaStreamTrack | undefined;
  answerer.onRemoteTransceiverAdded.subscribe((transceiver) => {
    transceiver.onTrack.subscribe((track) => {
      incoming = track;
    });
  });
  const channel = offerer.createDataChannel("transaction");
  const remoteChannel = answerer.onDataChannel.asPromise().then(([c]) => c);
  offerer.addTransceiver(outgoing, { direction: "sendonly" });
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription!);
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(answerer.localDescription!);
  if (channel.readyState !== "open") {
    await withTimeout(
      channel.stateChanged.watch((state) => state === "open"),
      "DataChannel did not open",
    );
  }
  const received = await withTimeout(remoteChannel, "No remote DataChannel");
  if (!incoming) throw new Error("Remote video track was not delivered");
  return { offerer, answerer, outgoing, incoming, channel, received };
}

export async function sendAndExpectData(
  from: RTCDataChannel,
  to: RTCDataChannel,
  text: string,
) {
  const message = to.onMessage.watch((data) => data.toString() === text);
  from.send(Buffer.from(text));
  await withTimeout(message, `DataChannel message was not received: ${text}`);
}

type ProvisionalIce = {
  connection: {
    nominated?: unknown;
    remoteUsername: string;
    provisionalNominated?: { localCandidate: { ufrag?: string } };
  };
};

/**
 * Shared Arrange: a connected session with an ICE restart offer answered by a
 * pranswer (without end-of-candidates yet), so the offerer's transport holds a
 * provisional generation for the pranswer's credentials. Returns the
 * pranswer ufrag and its MID.
 */
export async function createIceRestartPranswer() {
  const peers = await createConnectedVideoPeers();
  const { offerer, answerer } = peers;
  await offerer.setLocalDescription(
    await offerer.createOffer({ iceRestart: true }),
  );
  await answerer.setRemoteDescription(offerer.localDescription!);
  const answer = await answerer.createAnswer();
  await answerer.setLocalDescription({ type: "pranswer", sdp: answer.sdp });
  // The pranswer is signalled while its candidates are still trickling, so
  // the offerer receives end-of-candidates later through addIceCandidate.
  await offerer.setRemoteDescription({
    type: "pranswer",
    sdp: answerer.localDescription!.sdp.replace(/a=end-of-candidates\r\n/g, ""),
  });
  const pending = offerer.pendingRemoteDescription!.sdp;
  const ufrag = pending.match(/^a=ice-ufrag:([^\r\n]+)/m)![1];
  const mid = pending.match(/^a=mid:([^\r\n]+)/m)![1];
  return { ...peers, ufrag, mid };
}

type ProvisionalInternals = {
  connection: {
    provisional?: {
      remoteCandidates: { port: number }[];
      remoteCandidatesEnd: boolean;
      pairs: { remoteCandidate: { port: number } }[];
    };
    lookup?: { lookup: (host: string) => Promise<string>; close: () => void };
  };
};

/** Test-only observation of the provisional ICE generation of `pc`'s first transport. */
export function provisionalIce(pc: RTCPeerConnection) {
  return (pc.iceTransports[0] as unknown as ProvisionalInternals).connection
    .provisional;
}

/**
 * Arrange: replace the mDNS lookup of `pc`'s first ICE transport with one the
 * test resolves, so a `.local` candidate can stay resolving while other
 * operations run.
 */
export function stubIceMdns(pc: RTCPeerConnection) {
  const pending: ((address: string) => void)[] = [];
  let requested = 0;
  (pc.iceTransports[0] as unknown as ProvisionalInternals).connection.lookup = {
    lookup: () =>
      new Promise<string>((resolve) => {
        requested++;
        pending.push(resolve);
      }),
    close: () => undefined,
  };
  return {
    get requested() {
      return requested;
    },
    resolveAll: (address = "127.0.0.1") => {
      for (const resolve of pending.splice(0)) resolve(address);
    },
  };
}

/** A remote host candidate of generation `ufrag` for `sdpMid`. */
export function trickleCandidate(
  port: number,
  ufrag: string,
  sdpMid: string,
  host = "127.0.0.1",
) {
  return {
    candidate: `candidate:${port} 1 udp 2130706431 ${host} ${port} typ host ufrag ${ufrag}`,
    sdpMid,
    usernameFragment: ufrag,
  };
}

/** Wait until the provisional ICE generation of every transport nominates a pair. */
export async function waitForProvisionalNomination(pc: RTCPeerConnection) {
  const transports = pc.iceTransports as unknown as ProvisionalIce[];
  await withTimeout(
    (async () => {
      while (
        !transports.every(
          (transport) => transport.connection.provisionalNominated,
        )
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })(),
    "Provisional ICE generation was not nominated",
  );
  return transports.map((transport) => transport.connection);
}

async function withTimeout<T>(promise: Promise<T>, message: string, ms = 3000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForIce(pc: RTCPeerConnection) {
  if (["connected", "completed"].includes(pc.iceConnectionState)) return;
  await pc.iceConnectionStateChange.watch((state) =>
    ["connected", "completed"].includes(state),
  );
}

export async function waitForConnection(pc: RTCPeerConnection) {
  if (pc.connectionState === "connected") return;
  await pc.connectionStateChange.watch((state) => state === "connected");
}

/** Wait for the pending ICE/DTLS association while live media stays bound. */

export async function sendAndExpectRtp(
  outgoing: MediaStreamTrack,
  incoming: MediaStreamTrack,
  text: string,
) {
  const received = incoming.onReceiveRtp.watch(
    (packet) => packet.payload.toString() === text,
  );
  outgoing.writeRtp(
    new RtpPacket(new RtpHeader(), Buffer.from(text)).serialize(),
  );
  await Promise.race([
    received,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`RTP was not received: ${text}`)),
        2000,
      ),
    ),
  ]);
}

function assertDescriptionBindings(pc: RTCPeerConnection) {
  const internal = pc as unknown as {
    router: { ssrcTable: Record<number, unknown> };
    negotiation: {
      inspect: () => {
        phase: string;
        currentLocal?: SessionDescription;
        currentRemote?: SessionDescription;
        pendingLocal?: unknown;
        pendingRemote?: unknown;
        pendingTransports: number;
      };
    };
  };
  const snapshot = internal.negotiation.inspect();
  const mids = pc
    .getTransceivers()
    .map((t) => t.mid)
    .filter(Boolean);
  expect(new Set(mids).size).toBe(mids.length);
  expect(new Set(pc.dtlsTransports.map((t) => t.id)).size).toBe(
    pc.dtlsTransports.length,
  );
  if (pc.signalingState === "stable") {
    expect(snapshot.phase).toBe("idle");
    expect(snapshot.pendingLocal).toBeUndefined();
    expect(snapshot.pendingRemote).toBeUndefined();
    expect(snapshot.pendingTransports).toBe(0);
  }
  if (snapshot.currentLocal && pc.signalingState === "stable") {
    for (const media of snapshot.currentLocal.media) {
      if (media.port === 0) continue;
      // An offer can advertise a fallback ICE transport for a non-tag m-line.
      // The answer's BUNDLE group chooses the transport actually used.
      const acceptedBundle = snapshot.currentRemote?.group.find(
        (group) =>
          group.semantic === "BUNDLE" &&
          group.items.includes(media.rtp.muxId ?? ""),
      );
      if (
        snapshot.currentLocal.type === "offer" &&
        acceptedBundle &&
        acceptedBundle.items[0] !== media.rtp.muxId
      )
        continue;
      const transport =
        media.kind === "application"
          ? pc.sctpTransport?.dtlsTransport
          : pc.getTransceivers().find((t) => t.mid === media.rtp.muxId)
              ?.dtlsTransport;
      if (!transport || !media.iceParams) continue;
      // live generation のローカル資格情報は current SDP のもの (未適用の createOffer が
      // stage した restart 資格情報は SDP 作成用で、live 接続には入らない)。
      expect(transport.iceTransport.connection.localUsername).toBe(
        media.iceParams.usernameFragment,
      );
    }
  }
  if (snapshot.currentRemote && pc.signalingState === "stable") {
    for (const media of snapshot.currentRemote.media) {
      if (media.port === 0) continue;
      const acceptedBundle = snapshot.currentLocal?.group.find(
        (group) =>
          group.semantic === "BUNDLE" &&
          group.items.includes(media.rtp.muxId ?? ""),
      );
      const bundledNonTagFallback =
        snapshot.currentRemote.type === "offer" &&
        acceptedBundle &&
        acceptedBundle.items[0] !== media.rtp.muxId;
      const transceiver = pc
        .getTransceivers()
        .find((t) => t.mid === media.rtp.muxId);
      if (!transceiver || transceiver.stopped || !media.iceParams) continue;
      // m-line rejected by the current local SDP carries no route.
      const localMedia = snapshot.currentLocal?.media.find(
        (m) => m.rtp.muxId === media.rtp.muxId,
      );
      if (localMedia?.port === 0) continue;
      if (!bundledNonTagFallback) {
        expect(
          transceiver.dtlsTransport.iceTransport.getRemoteParameters()
            ?.usernameFragment,
        ).toBe(media.iceParams.usernameFragment);
      }
      // app の stop() は pipeline をその場で解放する (port 0 は次の自分の offer で交渉)。
      if (
        !transceiver.stopping &&
        ["sendonly", "sendrecv"].includes(media.direction ?? "inactive") &&
        ["recvonly", "sendrecv"].includes(transceiver.direction) &&
        media.ssrc[0]
      ) {
        expect(internal.router.ssrcTable[media.ssrc[0].ssrc]).toBe(
          transceiver.receiver,
        );
      }
      const remoteDtls = (
        transceiver.dtlsTransport as unknown as {
          remoteParameters?: typeof media.dtlsParams;
        }
      ).remoteParameters;
      if (media.dtlsParams && remoteDtls && !bundledNonTagFallback) {
        expect(remoteDtls.fingerprints).toEqual(media.dtlsParams.fingerprints);
      }
    }
    for (const group of snapshot.currentRemote.group.filter(
      (group) => group.semantic === "BUNDLE",
    )) {
      const owners = group.items
        .map((mid) =>
          snapshot.currentRemote!.media.find(
            (media) => media.rtp.muxId === mid,
          ),
        )
        .filter(
          (media): media is NonNullable<typeof media> =>
            !!media && media.port !== 0,
        )
        .map((media) =>
          media.kind === "application"
            ? pc.sctpTransport?.dtlsTransport
            : pc
                .getTransceivers()
                .find((transceiver) => transceiver.mid === media.rtp.muxId)
                ?.dtlsTransport,
        )
        .filter(Boolean);
      if (owners.length > 1) {
        expect(new Set(owners).size).toBe(1);
      }
    }
    const application = snapshot.currentRemote.media.find(
      (media) => media.kind === "application" && media.port !== 0,
    );
    if (application && pc.sctpTransport) {
      expect(pc.sctpRemotePort).toBe(application.sctpPort);
      expect(pc.sctpTransport.remoteMaxMessageSize).toBe(
        application.sctpCapabilities?.maxMessageSize,
      );
    }
  }
  return snapshot;
}

/**
 * Test-only observation; no PeerConnection public API is added.
 * Checks that live RTP/router, BUNDLE owner/MID/mLineIndex, ICE generation
 * (credentials, candidates, EOC, checklist, selected pair), DTLS
 * role/fingerprint, SCTP binding/parameters and transport lifetime agree with
 * the current descriptions, in every signaling state.
 */
export function assertNegotiationInvariants(pc: RTCPeerConnection) {
  const snapshot = assertDescriptionBindings(pc);
  assertRouterAndCodecs(pc, snapshot);
  assertRouteTables(pc, snapshot);
  assertIceGenerations(pc, snapshot);
  assertDtlsBindings(pc, snapshot);
  assertSctpBinding(pc, snapshot);
  assertNoOrphanTransports(pc);
  return snapshot;
}

type Snapshot = ReturnType<typeof assertDescriptionBindings>;
type DtlsTransport = RTCPeerConnection["dtlsTransports"][number];
type IceInternals = {
  localUsername: string;
  remoteUsername: string;
  remoteCandidatesEnd: boolean;
  remoteCandidates: {
    host: string;
    port: number;
    transport: string;
    type: string;
    ufrag?: string;
  }[];
  checkList: unknown[];
  nominated?: unknown;
  provisional?: unknown;
};

/** Live owner transport of a current MID, as bound by transceiver or SCTP. */
function liveTransportForMid(pc: RTCPeerConnection, mid?: string) {
  if (!mid) return undefined;
  if (pc.sctpTransport?.mid === mid) return pc.sctpTransport.dtlsTransport;
  return pc
    .getTransceivers()
    .find((transceiver) => transceiver.mid === mid && !transceiver.stopped)
    ?.dtlsTransport;
}

/** The accepted BUNDLE groups come from the current answer. */
function acceptedBundles(snapshot: Snapshot) {
  const answer =
    snapshot.currentLocal?.type === "answer"
      ? snapshot.currentLocal
      : snapshot.currentRemote;
  return (answer?.group ?? []).filter((group) => group.semantic === "BUNDLE");
}

/** Current m-lines grouped by the live transport that carries them. */
function currentMediaByTransport(
  pc: RTCPeerConnection,
  description: SessionDescription | undefined,
) {
  const byTransport = new Map<DtlsTransport, SessionDescription["media"]>();
  for (const media of description?.media ?? []) {
    if (media.port === 0) continue;
    const transport = liveTransportForMid(pc, media.rtp.muxId);
    if (!transport) continue;
    byTransport.set(transport, [...(byTransport.get(transport) ?? []), media]);
  }
  return byTransport;
}

/**
 * The live routing tables keep the current session's keys in every signaling
 * state: SSRC and RTX pairing, MID+RID and extmap ID all resolve as the
 * current SDP says, while a pending proposal can only add keys (conflicting
 * ones stay staged until commit).
 */
function assertRouteTables(pc: RTCPeerConnection, snapshot: Snapshot) {
  const internal = pc as unknown as {
    router: {
      ssrcTable: Record<number, unknown>;
      ridTable: Record<string, unknown>;
      extIdUriMap: Record<number, string>;
      staged: { ssrc: unknown[]; rid: unknown[] };
    };
  };
  const { router } = internal;
  // stable では staged route は残らない (commit か rollback で解消済み)。
  if (pc.signalingState === "stable") {
    expect(router.staged.ssrc).toEqual([]);
    expect(router.staged.rid).toEqual([]);
  }
  const current = snapshot.currentRemote;
  const local = snapshot.currentLocal;
  if (!current || !local) return;
  // extmap: router が知る ID は current SDP と同じ URI を指す (再割当てなし)。
  for (const media of current.media) {
    if (media.port === 0) continue;
    for (const extension of media.rtp.headerExtensions) {
      const live = router.extIdUriMap[extension.id];
      if (live !== undefined) expect(live).toBe(extension.uri);
    }
  }
  for (const [index, media] of current.media.entries()) {
    if (media.port === 0 || media.kind === "application") continue;
    const localDirection = local.media[index]?.direction;
    const remoteSends = ["sendonly", "sendrecv"].includes(
      media.direction ?? "",
    );
    const localReceives = ["recvonly", "sendrecv"].includes(
      localDirection ?? "",
    );
    if (!remoteSends || !localReceives) continue;
    const transceiver = pc
      .getTransceivers()
      .find((t) => t.mid === media.rtp.muxId && !t.stopped);
    // app の stop() は pipeline をその場で解放し、port 0 は次の自分の offer で交渉する。
    if (!transceiver || transceiver.stopping) continue;
    const receiver = transceiver.receiver;
    const tables = receiver.snapshotReceiveTables();
    const rtxSsrcs = new Set<number>();
    for (const group of media.ssrcGroup) {
      if (group.semantic !== "FID") continue;
      const [mediaSsrc, rtxSsrc] = group.items.map(Number);
      rtxSsrcs.add(rtxSsrc);
      // RTX の対応は current SDP の FID のまま。
      expect(tables.ssrcByRtx[rtxSsrc]).toBe(mediaSsrc);
    }
    for (const { ssrc } of media.ssrc) {
      // current SDP の SSRC は current の receiver に届く。
      expect(router.ssrcTable[ssrc]).toBe(receiver);
      if (rtxSsrcs.has(ssrc)) continue;
      // その SSRC の track は receiver の tracks に属する。
      const track = receiver.trackBySSRC[ssrc];
      expect(track).toBeDefined();
      expect(receiver.tracks).toContain(track);
    }
    for (const { rid } of media.simulcastParameters) {
      // RID は MID と組で current の receiver に届く。
      expect(router.ridTable[ridRouteKey(media.rtp.muxId ?? "", rid)]).toBe(
        receiver,
      );
      expect(receiver.tracks).toContain(receiver.trackByRID[rid]);
    }
  }
}

function assertRouterAndCodecs(pc: RTCPeerConnection, snapshot: Snapshot) {
  const internal = pc as unknown as {
    router: {
      ssrcTable: Record<number, unknown>;
      ridTable: Record<string, unknown>;
    };
  };
  // router は peer に残る sender/receiver だけを参照する (orphan route なし)。
  const endpoints = new Set<unknown>(
    pc.getTransceivers().flatMap((t) => [t.sender, t.receiver]),
  );
  for (const endpoint of [
    ...Object.values(internal.router.ssrcTable),
    ...Object.values(internal.router.ridTable),
  ]) {
    expect(endpoints.has(endpoint)).toBe(true);
  }
  // 停止していない sender は、交渉状態によらず自分の SSRC で RTCP を受け取れる
  // (アプリが pending 中に追加し、rollback 後も残る sender を含む)。
  for (const transceiver of pc.getTransceivers()) {
    if (transceiver.stopped || transceiver.stopping) continue;
    expect(internal.router.ssrcTable[transceiver.sender.ssrc]).toBe(
      transceiver.sender,
    );
  }
  for (const [index, media] of (
    snapshot.currentRemote?.media ?? []
  ).entries()) {
    if (media.port === 0 || media.kind === "application") continue;
    const transceiver = pc
      .getTransceivers()
      .find((t) => t.mid === media.rtp.muxId && !t.stopped);
    if (!transceiver) continue;
    if (pc.signalingState === "stable") {
      expect(transceiver.mLineIndex).toBe(index);
    }
    // app の stop() で解放した pipeline は受信設定を検査しない。
    if (transceiver.stopping) continue;
    // current SDP の payload type は pending 中も current の codec・fmtp・RTCP feedback
    // で解釈される (final answer と実際の受信設定が一致する)。
    const table = transceiver.receiver.snapshotReceiveTables().codecs;
    for (const codec of transceiver.codecs) {
      const live = table[codec.payloadType];
      if (
        !live ||
        !media.rtp.codecs.some((c) => c.payloadType === codec.payloadType)
      )
        continue;
      const committed = media.rtp.codecs.find(
        (c) => c.payloadType === codec.payloadType,
      )!;
      expect(receiveCodecKey(live)).toEqual(receiveCodecKey(committed));
    }
    // stable の受信側は確定した codec (current の local と remote の両方にある
    // payload type) だけを持ち、remote track の codec もその中にある。
    if (
      pc.signalingState === "stable" &&
      ["recvonly", "sendrecv"].includes(transceiver.currentDirection ?? "")
    ) {
      const localMedia = snapshot.currentLocal?.media.find(
        (m) => m.rtp.muxId === media.rtp.muxId,
      );
      const negotiated = media.rtp.codecs.filter((codec) =>
        localMedia?.rtp.codecs.some((c) => c.payloadType === codec.payloadType),
      );
      for (const payloadType of Object.keys(table).map(Number)) {
        expect(negotiated.map((c) => c.payloadType)).toContain(payloadType);
      }
      // 確定後に pending の staged 値は残らない (commit で受信表へ戻らない)。
      const staged = transceiver.receiver.snapshotReceiveTables();
      expect(staged.stagedCodecs).toEqual({});
      expect(staged.stagedSsrcByRtx).toEqual({});
      const mimeTypes = negotiated.map((c) => c.mimeType.toLowerCase());
      for (const track of transceiver.receiver.tracks) {
        if (!track.codec) continue;
        expect(mimeTypes).toContain(track.codec.mimeType.toLowerCase());
      }
    }
    // stable の送信側は、確定した SDP (current の local と remote の両方) にある
    // codec で送る (未適用の offer の解決結果は送信 codec にならない)。
    const sender = transceiver.sender;
    if (
      pc.signalingState === "stable" &&
      ["sendonly", "sendrecv"].includes(transceiver.currentDirection ?? "") &&
      sender.codec
    ) {
      const localMedia = snapshot.currentLocal?.media.find(
        (m) => m.rtp.muxId === media.rtp.muxId,
      );
      const negotiated = media.rtp.codecs.filter((codec) =>
        localMedia?.rtp.codecs.some((c) => c.payloadType === codec.payloadType),
      );
      const sent = negotiated.find(
        (c) => c.payloadType === sender.codec!.payloadType,
      );
      expect(sent?.mimeType.toLowerCase()).toBe(
        sender.codec.mimeType.toLowerCase(),
      );
    }
    // 実際の PLI 送信判定も、その SSRC の current SDP の codec の RTCP feedback に従う。
    for (const { ssrc } of media.ssrc) {
      if (!transceiver.receiver.trackBySSRC[ssrc]) continue;
      const { payloadType, allowed } =
        transceiver.receiver.pliNegotiation(ssrc);
      const committed = media.rtp.codecs.find(
        (c) => c.payloadType === payloadType,
      );
      if (!committed) continue;
      expect(allowed).toBe(
        // werift は nack 系 feedback (nack / nack pli) の交渉で PLI を送る。
        committed.rtcpFeedback.some((f) => f.type === "nack"),
      );
    }
  }
}

/** 受信設定の比較キー: MIME type、clock rate、channels、fmtp、RTCP feedback の集合。 */
function receiveCodecKey(codec: RTCRtpCodecParameters) {
  return {
    mimeType: codec.mimeType.toLowerCase(),
    clockRate: codec.clockRate,
    channels: codec.channels ?? 1,
    parameters: codec.parameters ?? "",
    rtcpFeedback: codec.rtcpFeedback
      .map((feedback) => `${feedback.type} ${feedback.parameter ?? ""}`.trim())
      .sort(),
  };
}

function assertIceGenerations(pc: RTCPeerConnection, snapshot: Snapshot) {
  if (!snapshot.currentRemote || !snapshot.currentLocal) return;
  const remoteByTransport = currentMediaByTransport(pc, snapshot.currentRemote);
  const localByTransport = currentMediaByTransport(pc, snapshot.currentLocal);
  for (const [transport, remoteMedia] of remoteByTransport) {
    const connection = transport.iceTransport
      .connection as unknown as IceInternals;
    if (transport.iceTransport.state === "closed") continue;
    const remoteUfrags = new Set(
      remoteMedia.map((media) => media.iceParams?.usernameFragment),
    );
    const localMedia = localByTransport.get(transport);
    // A transport left only under m-lines rejected by the current local SDP
    // carries no current generation.
    if (!localMedia) continue;
    const localUfrags = new Set(
      localMedia.map((media) => media.iceParams?.usernameFragment),
    );
    // live generation の資格情報は current SDP のもの (pending 中も切り替えない)。
    expect(remoteUfrags.has(connection.remoteUsername)).toBe(true);
    expect(localUfrags.has(connection.localUsername)).toBe(true);
    // live checklist の remote candidate は current generation のものだけ。
    const sdpCandidates = remoteMedia.flatMap((media) => media.iceCandidates);
    for (const candidate of connection.remoteCandidates) {
      if (candidate.ufrag) {
        expect(candidate.ufrag).toBe(connection.remoteUsername);
      }
      if (candidate.type === "prflx") continue;
      expect(
        sdpCandidates.some(
          (c) =>
            // mDNS 候補は SDP では名前のまま、checklist では解決後のアドレスになる。
            (c.ip === candidate.host || c.ip.endsWith(".local")) &&
            c.port === candidate.port &&
            c.protocol.toLowerCase() === candidate.transport.toLowerCase(),
        ),
      ).toBe(true);
    }
    // EOC は current SDP に記録された generation にだけ反映され、完了した
    // transport・世代を共有する m-line (BUNDLE group) は current/pending SDP
    // のどちらでも全て完了扱いになる。
    if (connection.remoteCandidatesEnd) {
      expect(remoteMedia.some((media) => media.iceCandidatesComplete)).toBe(
        true,
      );
      const pendingRemote = pc.pendingRemoteDescription
        ? SessionDescription.parse(pc.pendingRemoteDescription.sdp)
        : undefined;
      for (const media of [
        ...remoteMedia,
        ...(pendingRemote?.media ?? []).filter(
          (m) => liveTransportForMid(pc, m.rtp.muxId) === transport,
        ),
      ]) {
        if (media.port === 0) continue;
        if (media.iceParams?.usernameFragment !== connection.remoteUsername)
          continue;
        expect(media.iceCandidatesComplete).toBe(true);
      }
    }
    // selected pair は live checklist に属する。
    if (connection.nominated) {
      expect(connection.checkList).toContain(connection.nominated);
    }
    if (pc.signalingState === "stable") {
      // stable では provisional generation も staged restart も残らない。
      expect(connection.provisional).toBeUndefined();
      expect(transport.iceTransport.hasStagedRestart).toBe(false);
    }
  }
}

function assertDtlsBindings(pc: RTCPeerConnection, snapshot: Snapshot) {
  if (pc.signalingState !== "stable" || !snapshot.currentLocal) return;
  const localByTransport = currentMediaByTransport(pc, snapshot.currentLocal);
  const remoteByTransport = currentMediaByTransport(pc, snapshot.currentRemote);
  for (const [transport, localMedia] of localByTransport) {
    if (transport.state !== "connected") continue;
    // 接続済み DTLS の role は current answer の a=setup と一致する。
    const answerRole =
      snapshot.currentLocal.type === "answer"
        ? localMedia[0].dtlsParams?.role
        : ({ client: "server", server: "client" } as const)[
            (remoteByTransport.get(transport)?.[0]?.dtlsParams?.role ??
              "auto") as "client" | "server"
          ];
    expect(transport.role).not.toBe("auto");
    if (answerRole && answerRole !== "auto") {
      expect(transport.role).toBe(answerRole);
    }
    // local fingerprint は current local SDP が広告したもの。
    const advertised = localMedia.flatMap(
      (media) => media.dtlsParams?.fingerprints ?? [],
    );
    for (const fingerprint of transport.localParameters.fingerprints) {
      expect(
        advertised.some(
          (f) =>
            f.algorithm === fingerprint.algorithm &&
            f.value.toLowerCase() === fingerprint.value.toLowerCase(),
        ),
      ).toBe(true);
    }
  }
}

function assertSctpBinding(pc: RTCPeerConnection, snapshot: Snapshot) {
  const sctp = pc.sctpTransport;
  if (!sctp || pc.signalingState !== "stable") return;
  const media = [...(snapshot.currentRemote?.media.entries() ?? [])];
  if (!media.some(([, m]) => m.kind === "application")) {
    // createDataChannel だけの SCTP は未交渉: m-line にも remote port にも束縛されない。
    expect(sctp.mid).toBeUndefined();
    expect(sctp.mLineIndex).toBeUndefined();
    expect(pc.sctpRemotePort).toBeUndefined();
    return;
  }
  const [index, application] =
    media.find(([, m]) => m.kind === "application" && m.port !== 0) ?? [];
  if (!application) return;
  // SCTP は current の application m-line (MID/mLineIndex) に束縛される。
  expect(sctp.mid).toBe(application.rtp.muxId);
  expect(sctp.mLineIndex).toBe(index);
  // BUNDLE されていれば tag の transport 上に association がある。
  const bundle = acceptedBundles(snapshot).find((group) =>
    group.items.includes(application.rtp.muxId ?? ""),
  );
  if (bundle && bundle.items[0] !== application.rtp.muxId) {
    const tagTransport = liveTransportForMid(pc, bundle.items[0]);
    if (tagTransport) expect(sctp.dtlsTransport).toBe(tagTransport);
  }
  const association = (
    sctp as unknown as { sctp?: { associationState: number } }
  ).sctp;
  if (association?.associationState === 4 /* ESTABLISHED */) {
    expect(sctp.dtlsTransport.state).toBe("connected");
  }
}

const seenTransports = new WeakMap<RTCPeerConnection, Set<DtlsTransport>>();

/** Transport identity is remembered per peer so discarded ones must be closed. */
function assertNoOrphanTransports(pc: RTCPeerConnection) {
  const internal = pc as unknown as {
    negotiation: { transportByMid: Map<string, DtlsTransport> };
  };
  const live = new Set(pc.dtlsTransports);
  const prepared = new Set(internal.negotiation.transportByMid.values());
  const seen = seenTransports.get(pc) ?? new Set<DtlsTransport>();
  seenTransports.set(pc, seen);
  for (const transport of [...live, ...prepared]) seen.add(transport);
  for (const transport of seen) {
    if (live.has(transport) || prepared.has(transport)) continue;
    // 使われなくなった transport は ICE/DTLS とも停止している。
    expect(transport.state).toBe("closed");
    expect(transport.iceTransport.state).toBe("closed");
  }
}

/**
 * Two connected peers that both send video and share an established
 * DataChannel, so either side can act as the offerer of a transition.
 */
export async function createDuplexSession(
  config: ConstructorParameters<typeof RTCPeerConnection>[0] = {},
) {
  const a = new RTCPeerConnection(config);
  const b = new RTCPeerConnection(config);
  const aOut = new MediaStreamTrack({ kind: "video" });
  const bOut = new MediaStreamTrack({ kind: "video" });
  const aChannel = a.createDataChannel("matrix");
  const bChannelPromise = b.onDataChannel.asPromise().then(([c]) => c);
  const aVideo = a.addTransceiver(aOut, { direction: "sendrecv" });
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription!);
  const bVideo = b.getTransceivers()[0];
  bVideo.direction = "sendrecv";
  await bVideo.sender.replaceTrack(bOut);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription!);
  await withTimeout(
    Promise.all([
      waitForIce(a),
      waitForIce(b),
      waitForConnection(a),
      waitForConnection(b),
    ]),
    "Duplex session did not connect",
  );
  if (aChannel.readyState !== "open") {
    await withTimeout(
      aChannel.stateChanged.watch((state) => state === "open"),
      "DataChannel did not open",
    );
  }
  const bChannel = await withTimeout(bChannelPromise, "No remote DataChannel");
  const peers = {
    a: { pc: a, out: aOut, video: aVideo, channel: aChannel },
    b: { pc: b, out: bOut, video: bVideo, channel: bChannel },
  };
  return {
    ...peers,
    peers,
    close: () => Promise.allSettled([a.close(), b.close()]),
  };
}
export type DuplexSession = Awaited<ReturnType<typeof createDuplexSession>>;

/** Run one negotiation operation, then check the invariants of both peers. */
export async function step<T>(
  session: DuplexSession,
  operation: () => Promise<T> | T,
) {
  const result = await operation();
  assertNegotiationInvariants(session.a.pc);
  assertNegotiationInvariants(session.b.pc);
  return result;
}

/** Real traffic on the committed session: RTP and DataChannel both ways. */
export async function expectSessionAlive(
  session: DuplexSession,
  label: string,
) {
  await sendAndExpectRtp(
    session.a.out,
    session.b.video.receiver.track,
    `${label}-rtp-a-to-b`,
  );
  await sendAndExpectRtp(
    session.b.out,
    session.a.video.receiver.track,
    `${label}-rtp-b-to-a`,
  );
  await sendAndExpectData(
    session.a.channel,
    session.b.channel,
    `${label}-dc-a-to-b`,
  );
  await sendAndExpectData(
    session.b.channel,
    session.a.channel,
    `${label}-dc-b-to-a`,
  );
}

/** The m-section identified by `mid`. */
export function sectionOf(sdp: string, mid: string) {
  const section = sdp
    .split(/(?=^m=)/m)
    .find((part) => new RegExp(`^a=mid:${mid}\\r?$`, "m").test(part));
  if (!section) throw new Error(`No m-section with MID ${mid}`);
  return section;
}

/** Rewrite the m-section identified by `mid`, leaving the rest of the SDP. */
export function mungeSection(
  sdp: string,
  mid: string,
  rewrite: (section: string) => string,
) {
  const [session, ...sections] = sdp.split(/(?=^m=)/m);
  return [
    session,
    ...sections.map((section) =>
      new RegExp(`^a=mid:${mid}\\r?$`, "m").test(section)
        ? rewrite(section)
        : section,
    ),
  ].join("");
}

type Peer = DuplexSession["a"];

/**
 * Offer/answer between two peers of a duplex session. Invariants are checked
 * after each of the four description operations; SDP can be rewritten on the
 * wire to model a remote peer's choice.
 */
export async function negotiate(
  session: DuplexSession,
  offerer: Peer,
  answerer: Peer,
  options: {
    iceRestart?: boolean;
    localOffer?: (sdp: string) => string;
    remoteAnswer?: (sdp: string) => string;
  } = {},
) {
  const offer = await createRewrittenOffer(
    offerer.pc,
    options.localOffer ?? ((sdp) => sdp),
    { iceRestart: options.iceRestart },
  );
  await step(session, () => offerer.pc.setLocalDescription(offer));
  await step(session, () =>
    answerer.pc.setRemoteDescription(offerer.pc.localDescription!),
  );
  await step(session, async () =>
    answerer.pc.setLocalDescription(await answerer.pc.createAnswer()),
  );
  const answer = answerer.pc.localDescription!.sdp;
  await step(session, () =>
    offerer.pc.setRemoteDescription({
      type: "answer",
      sdp: options.remoteAnswer?.(answer) ?? answer,
    }),
  );
}

/** Wait until every live ICE transport has nominated a pair in its SDP generation. */
export async function waitForCommittedNomination(pc: RTCPeerConnection) {
  await withTimeout(
    (async () => {
      const ready = () =>
        pc.iceTransports.every((transport) => {
          const connection = transport.connection as unknown as IceInternals;
          return (
            !!connection.nominated &&
            transport.getRemoteParameters()?.usernameFragment ===
              connection.remoteUsername
          );
        });
      while (!ready()) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })(),
    "Committed ICE generation was not nominated",
  );
}

/** Trickle candidates advertised for `mid` in an SDP, as addIceCandidate input. */
export function sdpCandidates(sdp: string, mid: string) {
  let section = "";
  mungeSection(sdp, mid, (text) => {
    section = text;
    return text;
  });
  const ufrag = section.match(/^a=ice-ufrag:(\S+)/m)?.[1];
  return [...section.matchAll(/^a=(candidate:[^\r\n]+)/gm)].map(
    ([, candidate]) => ({ candidate, sdpMid: mid, usernameFragment: ufrag }),
  );
}

/** Wait until a (possibly newly split) DTLS transport is connected. */
export async function waitForDtlsConnected(
  transport: RTCPeerConnection["dtlsTransports"][number],
) {
  if (transport.state === "connected") return;
  await withTimeout(
    transport.onStateChange.watch((state) => state === "connected"),
    "DTLS transport did not connect",
  );
}

/** Negotiate an extra sendonly audio m-line from `offerer` on a duplex session. */
export async function addNegotiatedAudio(
  session: DuplexSession,
  offerer: Peer,
  answerer: Peer,
) {
  const out = new MediaStreamTrack({ kind: "audio" });
  const transceiver = offerer.pc.addTransceiver(out, { direction: "sendonly" });
  await negotiate(session, offerer, answerer);
  const mid = transceiver.mid!;
  const remote = () =>
    answerer.pc.getTransceivers().find((t) => t.mid === mid)!;
  return { out, transceiver, mid, remote };
}

/** Local offer SDP whose BUNDLE group leaves `mid` out (a BUNDLE split). */
export async function createSplitOffer(pc: RTCPeerConnection, mid: string) {
  const offer = await createRewrittenOffer(pc, (sdp) => {
    const group = sdp.match(/^a=group:BUNDLE ([^\r\n]+)/m)![1];
    const kept = group.split(" ").filter((item) => item !== mid);
    return sdp.replace(
      /^a=group:BUNDLE [^\r\n]+/m,
      `a=group:BUNDLE ${kept.join(" ")}`,
    );
  });
  return offer.sdp;
}

/**
 * Test-only stand-in for createOffer under another local policy (for example
 * a BUNDLE group that leaves a MID out). Applications cannot munge a local
 * offer: setLocalDescription accepts only the last created offer. This helper
 * records the rewritten SDP as that offer, as createOffer would have.
 */
export async function createRewrittenOffer(
  pc: RTCPeerConnection,
  rewrite: (sdp: string) => string,
  options: { iceRestart?: boolean } = {},
) {
  const offer = await pc.createOffer(options);
  const rewritten = { type: "offer" as const, sdp: rewrite(offer.sdp) };
  const internal = pc as unknown as {
    lastCreatedOffer?: unknown;
    createdOfferSdp?: string;
  };
  internal.lastCreatedOffer = rewritten;
  internal.createdOfferSdp = rewritten.sdp;
  return rewritten;
}

/**
 * Shared Arrange: a connected sendonly simulcast video (RIDs "high" / "low")
 * with MID and RID header extensions. `sendLayer` writes one SRTP packet on
 * the offerer's DTLS transport, with or without the RID extension, so a test
 * can make the answerer learn an SSRC from RID packets and then send RID-less.
 */
export async function createSimulcastPeers() {
  const config = {
    headerExtensions: { video: [useSdesMid(), useSdesRTPStreamId()] },
  };
  const offerer = new RTCPeerConnection(config);
  const answerer = new RTCPeerConnection(config);
  offerer.addTransceiver(new MediaStreamTrack({ kind: "video" }), {
    direction: "sendonly",
    sendEncodings: [{ rid: "high" }, { rid: "low" }],
  });
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription!);
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(answerer.localDescription!);
  await withTimeout(
    Promise.all([waitForConnection(offerer), waitForConnection(answerer)]),
    "Simulcast peers did not connect",
  );
  const sdp = offerer.currentLocalDescription!.sdp;
  const ridExtensionId = Number(
    sdp.match(
      /a=extmap:(\d+) urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id/,
    )![1],
  );
  const payloadType = Number(sdp.match(/a=rtpmap:(\d+) VP8\/90000/)![1]);
  const midExtensionId = Number(
    sdp.match(/a=extmap:(\d+) urn:ietf:params:rtp-hdrext:sdes:mid/)![1],
  );
  let sequenceNumber = 0;
  const firstMid = answerer.getTransceivers()[0].mid!;
  const receiver = (mid: string) =>
    answerer.getTransceivers().find((t) => t.mid === mid)!.receiver;

  /** Send `text` as SSRC `ssrc` and wait until the `rid` layer track gets it. */
  const sendLayer = async (
    rid: "high" | "low",
    ssrc: number,
    text: string,
    { withRid, mid = firstMid }: { withRid: boolean; mid?: string },
  ) => {
    const track = receiver(mid).trackByRID[rid];
    const received = track.onReceiveRtp.watch(
      (packet) => packet.payload.toString() === text,
      2000,
    );
    const header = new RtpHeader({
      ssrc,
      payloadType,
      sequenceNumber: ++sequenceNumber,
      timestamp: sequenceNumber * 3000,
      marker: true,
      // MID は常に載せる (RID は MID と組で解決される)。
      extensions: [
        { id: midExtensionId, payload: Buffer.from(mid) },
        ...(withRid ? [{ id: ridExtensionId, payload: Buffer.from(rid) }] : []),
      ],
    });
    await offerer
      .getTransceivers()[0]
      .dtlsTransport.sendRtp(Buffer.from(text), header);
    await received;
  };
  return {
    offerer,
    answerer,
    sendLayer,
    firstMid,
    ridExtensionId,
    close: () => Promise.allSettled([offerer.close(), answerer.close()]),
  };
}

/** Two peers before their first negotiation, without any transceiver. */
export function createUnnegotiatedPeers() {
  const offerer = new RTCPeerConnection({ iceServers: [] });
  const answerer = new RTCPeerConnection({ iceServers: [] });
  return {
    offerer,
    answerer,
    close: () => Promise.allSettled([offerer.close(), answerer.close()]),
  };
}

/**
 * Two peers before their first negotiation; the offerer sends video so the
 * first offer is not empty.
 */
export function createUnnegotiatedVideoPeers() {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  const outgoing = new MediaStreamTrack({ kind: "video" });
  const incoming = new Promise<MediaStreamTrack>((resolve) => {
    answerer.onRemoteTransceiverAdded.subscribe((transceiver) => {
      transceiver.onTrack.subscribe(resolve);
    });
  });
  offerer.addTransceiver(outgoing, { direction: "sendonly" });
  return {
    offerer,
    answerer,
    outgoing,
    incoming: () =>
      withTimeout(incoming, "Remote video track was not delivered"),
    close: () => Promise.allSettled([offerer.close(), answerer.close()]),
  };
}

/**
 * Negotiate from `offerer` after a rolled-back transaction and expect the
 * application-created `channel` to open and carry data to `answerer`.
 */
export async function negotiateAndExpectChannel(
  offerer: RTCPeerConnection,
  answerer: RTCPeerConnection,
  channel: RTCDataChannel,
) {
  const remote = answerer.onDataChannel.watch((c) => c.label === channel.label);
  const offer = await offerer.createOffer();
  expect(offer.sdp).toContain("m=application");
  await offerer.setLocalDescription(offer);
  await answerer.setRemoteDescription(offerer.localDescription!);
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(answerer.localDescription!);
  if (channel.readyState !== "open") {
    await withTimeout(
      channel.stateChanged.watch((state) => state === "open"),
      `DataChannel ${channel.label} did not open`,
    );
  }
  const [received] = await withTimeout(remote, "No remote DataChannel");
  await sendAndExpectData(channel, received, `${channel.label}-after-rollback`);
  return received;
}

/** Connected sendonly video whose peers also support RTX (VP8 + video/rtx). */
export function createConnectedVideoPeersWithRtx() {
  return createConnectedVideoPeers({
    codecs: {
      video: [
        useVP8(),
        new RTCRtpCodecParameters({ mimeType: "video/rtx", clockRate: 90000 }),
      ],
    },
  });
}

/** Keep only the RTX payload type in the video m-line: its `apt` codec is gone. */
export function keepOnlyRtx(sdp: string) {
  const vp8 = sdp.match(/a=rtpmap:(\d+) VP8\/90000/)![1];
  const rtx = sdp.match(/a=rtpmap:(\d+) rtx\/90000/)![1];
  return sdp
    .replace(/^(m=video \d+ [^ ]+) .*$/m, `$1 ${rtx}`)
    .split(/\r?\n/)
    .filter(
      (line) => !new RegExp(`^a=(rtpmap|fmtp|rtcp-fb):${vp8} `).test(line),
    )
    .join("\r\n");
}

type NegotiationInternals = {
  negotiation: {
    inspect(): {
      phase: string;
      createdTransports: { state: string }[];
      hasOfferSnapshot: boolean;
    };
  };
  transceiverManager: { setRemoteRTP: (...args: unknown[]) => void };
};

/** Test-only view of the negotiation transaction owned by `pc`. */
export function negotiationInternals(pc: RTCPeerConnection) {
  return pc as unknown as NegotiationInternals;
}

/**
 * Connected peers where the offerer sends `count` video tracks, each on its
 * own m-line (one BUNDLE group); `incoming[i]` receives `outgoing[i]`.
 */
export async function createConnectedMultiVideoPeers(
  count: number,
  config: ConstructorParameters<typeof RTCPeerConnection>[0] = {},
) {
  const offerer = new RTCPeerConnection(config);
  const answerer = new RTCPeerConnection(config);
  const outgoing = [...Array(count)].map(
    () => new MediaStreamTrack({ kind: "video" }),
  );
  for (const track of outgoing) {
    offerer.addTransceiver(track, { direction: "sendonly" });
  }
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription!);
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(answerer.localDescription!);
  await withTimeout(
    Promise.all([waitForConnection(offerer), waitForConnection(answerer)]),
    "Multi video peers did not connect",
  );
  const incoming = offerer
    .getTransceivers()
    .map(
      (sent) =>
        answerer.getTransceivers().find((t) => t.mid === sent.mid)!.receiver
          .track,
    );
  return {
    offerer,
    answerer,
    outgoing,
    incoming,
    close: () => Promise.allSettled([offerer.close(), answerer.close()]),
  };
}

/**
 * Send one RTP packet on `outgoing` and report the MID of the `pc` transceiver
 * whose receiver delivered it on any of its tracks (undefined when none did).
 */
export async function receivingMid(
  outgoing: MediaStreamTrack,
  pc: RTCPeerConnection,
  text: string,
) {
  const subscriptions: { unSubscribe: () => void }[] = [];
  const received = new Promise<string | null>((resolve) => {
    for (const transceiver of pc.getTransceivers()) {
      for (const track of transceiver.receiver.tracks) {
        subscriptions.push(
          track.onReceiveRtp.subscribe((packet) => {
            if (packet.payload.toString() === text) resolve(transceiver.mid);
          }),
        );
      }
    }
  });
  outgoing.writeRtp(
    new RtpPacket(new RtpHeader(), Buffer.from(text)).serialize(),
  );
  try {
    return await Promise.race([
      received,
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), 1500),
      ),
    ]);
  } finally {
    for (const subscription of subscriptions) subscription.unSubscribe();
  }
}

/** Deterministic PRNG (mulberry32) so a failing fuzz seed replays exactly. */
export function seededRandom(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]) => items[Math.floor(next() * items.length)],
  };
}
export type SeededRandom = ReturnType<typeof seededRandom>;

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
 * rollback. Invariants of both peers are checked after every operation.
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
  await step(session, async () =>
    answerer.pc.setLocalDescription(await answerer.pc.createAnswer()),
  );
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

/** Shared Arrange: a local TURN server and the RTCIceServer entry for it. */
export async function createLocalTurnIceServer() {
  const server = await createLocalTurnServer(getHostAddresses(true, false)[0]!);
  const [host, port] = server.address!;
  return {
    server,
    iceServers: [
      {
        urls: `turn:${host}:${port}`,
        username: TURN_TEST_USERNAME,
        credential: TURN_TEST_PASSWORD,
      },
    ],
  };
}

/** Record `onIceCandidate` events; `undefined` marks end-of-candidates. */
export function recordIceCandidates(pc: RTCPeerConnection) {
  const events: (RTCIceCandidate | undefined)[] = [];
  pc.onIceCandidate.subscribe((candidate) => {
    events.push(candidate);
  });
  return events;
}

export async function waitForEndOfCandidates(
  events: (RTCIceCandidate | undefined)[],
) {
  await withTimeout(
    (async () => {
      while (!events.includes(undefined)) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })(),
    "End-of-candidates was not signalled",
    10000,
  );
}

/**
 * Shared Arrange: a VP8 + H264 capable video session whose current codec is
 * VP8, and a pending re-offer from the offerer that proposes H264 only.
 */
export async function createH264OnlyReoffer() {
  const peers = await createConnectedVideoPeers({
    codecs: { video: [useVP8(), useH264()] },
  });
  const [offererTransceiver] = peers.offerer.getTransceivers();
  offererTransceiver.setCodecPreferences([useH264()]);
  await peers.offerer.setLocalDescription(await peers.offerer.createOffer());
  await peers.answerer.setRemoteDescription(peers.offerer.localDescription!);
  return { ...peers, transceiver: peers.answerer.getTransceivers()[0] };
}

/** Video codec names an SDP offers, in m-line order (RTX excluded). */
export function offeredVideoCodecs(sdp: string) {
  return [...sdp.matchAll(/^a=rtpmap:\d+ ([^/]+)\/90000/gim)]
    .map((match) => match[1].toUpperCase())
    .filter((name) => name !== "RTX");
}

/** Remote ICE ufrag and MID of the first m-line of `pc`'s current remote description. */
export function currentRemoteGeneration(pc: RTCPeerConnection) {
  const sdp = pc.currentRemoteDescription!.sdp;
  return {
    ufrag: sdp.match(/^a=ice-ufrag:(\S+)/m)![1],
    mid: sdp.match(/^a=mid:(\S+)/m)![1],
  };
}

/** Run `operation` and return how long it took in milliseconds. */
export async function elapsedMs(operation: () => Promise<unknown>) {
  const started = performance.now();
  await operation();
  return performance.now() - started;
}

/** Wait until the live ICE agent of `pc`'s first transport knows `port` as a remote candidate. */
export async function waitForRemoteCandidatePort(
  pc: RTCPeerConnection,
  port: number,
) {
  const connection = pc.iceTransports[0].connection;
  await withTimeout(
    (async () => {
      while (!connection.remoteCandidates.some((c) => c.port === port)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })(),
    `Remote candidate ${port} was not added`,
  );
}

/**
 * Offer the codec of payload type `from` under the new payload type `to`
 * instead (the m-line list and its rtpmap / fmtp / rtcp-fb lines).
 */
export function movePayloadType(sdp: string, from: number, to: number) {
  return sdp
    .split("\r\n")
    .map((line) => {
      if (line.startsWith("m=")) {
        return line
          .split(" ")
          .map((token, index) =>
            index >= 3 && token === String(from) ? String(to) : token,
          )
          .join(" ");
      }
      return line.replace(
        new RegExp(`^a=(rtpmap|fmtp|rtcp-fb):${from} `),
        `a=$1:${to} `,
      );
    })
    .join("\r\n");
}

/**
 * Add header extensions the answerer does not support to the `kind` m-line of
 * an offer, on every free one-byte ID (like a browser offering more
 * extensions than werift accepts).
 */
export function addUnsupportedExtmaps(sdp: string, kind: "audio" | "video") {
  const lines = sdp.split("\r\n");
  const start = lines.findIndex((line) => line.startsWith(`m=${kind} `));
  const end = lines.findIndex(
    (line, index) => index > start && line.startsWith("m="),
  );
  const section = lines.slice(start, end < 0 ? undefined : end);
  const used = new Set(
    section
      .map((line) => line.match(/^a=extmap:(\d+)/)?.[1])
      .filter((id): id is string => !!id)
      .map(Number),
  );
  const added: string[] = [];
  for (let id = 1; id <= 14; id++) {
    if (!used.has(id))
      added.push(`a=extmap:${id} urn:example:unsupported-${id}`);
  }
  lines.splice(start + 1, 0, ...added);
  return lines.join("\r\n");
}

/** Offer an extra codec `name` at payload type `payloadType` in the `kind` m-line. */
export function addOfferedCodec(
  sdp: string,
  kind: "audio" | "video",
  payloadType: number,
  name: string,
) {
  const lines = sdp.split("\r\n");
  const start = lines.findIndex((line) => line.startsWith(`m=${kind} `));
  lines[start] = `${lines[start]} ${payloadType}`;
  lines.splice(start + 1, 0, `a=rtpmap:${payloadType} ${name}`);
  return lines.join("\r\n");
}

/** Every DTLS transport `pc` holds: live bindings and what a pending proposal prepared or created. */
export function heldTransports(pc: RTCPeerConnection) {
  const internal = pc as unknown as {
    negotiation: {
      transportByMid: Map<string, DtlsTransport>;
      inspect: () => { createdTransports: DtlsTransport[] };
    };
  };
  return new Set<DtlsTransport>([
    ...pc.dtlsTransports,
    ...internal.negotiation.transportByMid.values(),
    ...internal.negotiation.inspect().createdTransports,
  ]);
}

/** After close, every transport the peer held has stopped its DTLS and ICE (no open socket remains). */
export function assertTransportsClosed(transports: Iterable<DtlsTransport>) {
  for (const transport of transports) {
    expect(transport.state).toBe("closed");
    expect(transport.iceTransport.state).toBe("closed");
  }
}

/**
 * Arrange: hold the next gathering of `pc`'s first ICE transport (as done by
 * an ICE restart commit) until `release()` is called.
 */
export function holdNextGather(pc: RTCPeerConnection) {
  const transport = pc.iceTransports[0];
  const original = transport.gather.bind(transport);
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const reached = new Promise<void>((resolve) => {
    started = resolve;
  });
  transport.gather = async () => {
    transport.gather = original;
    started();
    await released;
    return original();
  };
  return { reached, release };
}

/**
 * Arrange: hold the DTLS handshake start of every transport `pc` has until
 * `release()` is called, so its peer's handshake stays "connecting".
 */
export function holdDtlsStart(pc: RTCPeerConnection) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (const transport of pc.dtlsTransports) {
    const original = transport.start.bind(transport);
    transport.start = async () => {
      transport.start = original;
      await released;
      return original();
    };
  }
  return { release };
}

/** Wait until `transport`'s DTLS handshake is running (or done). */
export async function waitForDtlsHandshake(
  transport: RTCPeerConnection["dtlsTransports"][number],
) {
  if (["connecting", "connected"].includes(transport.state)) return;
  await withTimeout(
    transport.onStateChange.watch((state) =>
      ["connecting", "connected"].includes(state),
    ),
    "DTLS handshake did not start",
  );
}

/** Payload type → codec name of a receiver's live decode table. */
export function receiveCodecNames(receiver: RTCRtpReceiver) {
  return Object.fromEntries(
    Object.entries(receiver.snapshotReceiveTables().codecs).map(
      ([payloadType, codec]) => [payloadType, codec.name.toUpperCase()],
    ),
  );
}

/** The RTCIceServer entry of a TURN server (or a proxy in front of it) at `address`. */
export function turnIceServers([host, port]: Address) {
  return [
    {
      urls: `turn:${host}:${port}`,
      username: TURN_TEST_USERNAME,
      credential: TURN_TEST_PASSWORD,
    },
  ];
}

/**
 * Shared Arrange: a TURN server the offerer gathered with, plus a held proxy
 * per later ICE restart, so each restart's background TURN allocation
 * completes only when the test releases its proxy.
 */
export async function createHeldTurnRestartPeers(restarts: number) {
  const turn = await createLocalTurnIceServer();
  const proxies = await Promise.all(
    [...Array(restarts)].map(() => createHeldUdpProxy(turn.server.address!)),
  );
  const offerer = new RTCPeerConnection({ iceServers: turn.iceServers });
  const answerer = new RTCPeerConnection();
  const channel = offerer.createDataChannel("turn");
  const received = answerer.onDataChannel.asPromise().then(([c]) => c);
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription!);
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(answerer.localDescription!);
  return {
    offerer,
    answerer,
    channel,
    received,
    proxies,
    /** Negotiate an ICE restart whose TURN allocation goes through `proxies[index]`. */
    async restartThrough(index: number) {
      offerer.setConfiguration({
        iceServers: turnIceServers(proxies[index].address),
      });
      offerer.restartIce();
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
    },
    async close() {
      await Promise.allSettled([offerer.close(), answerer.close()]);
      for (const proxy of proxies) proxy.close();
      await turn.server.close();
    },
  };
}

/**
 * Arrange: put `pc`'s first ICE transport in `state` as its agent would (for
 * example "failed" after consent freshness expired), without touching the
 * selected pair.
 */
export function forceIceState(
  pc: RTCPeerConnection,
  state: RTCPeerConnection["iceConnectionState"],
) {
  (
    pc.iceTransports[0] as unknown as { setState(state: string): void }
  ).setState(state);
}

/** Record the ICE connection states `pc` reports from now on. */
export function recordIceConnectionStates(pc: RTCPeerConnection) {
  const states: string[] = [];
  pc.iceConnectionStateChange.subscribe((state) => {
    states.push(state);
  });
  return states;
}

/**
 * Shared Arrange: a first negotiation connected at its pranswer. The
 * offerer sends video (sendrecv) and the answerer replaces the remote-created
 * transceiver's track before answering, so the application holds it. Both
 * peers are in the pranswer state with ICE and DTLS connected.
 */
export async function createInitialPranswerConnection() {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  offerer.addTransceiver(new MediaStreamTrack({ kind: "video" }), {
    direction: "sendrecv",
  });
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription!);
  const remoteCreated = answerer.getTransceivers()[0];
  await remoteCreated.sender.replaceTrack(
    new MediaStreamTrack({ kind: "video" }),
  );
  const pranswer = (await answerer.createAnswer()).sdp;
  await answerer.setLocalDescription({ type: "pranswer", sdp: pranswer });
  await offerer.setRemoteDescription({ type: "pranswer", sdp: pranswer });
  await withTimeout(
    Promise.all(
      [offerer, answerer].map((pc) =>
        waitForDtlsConnected(pc.dtlsTransports[0]),
      ),
    ),
    "provisional DTLS did not connect",
  );
  return {
    offerer,
    answerer,
    pranswer,
    remoteCreated,
    close: () => Promise.allSettled([offerer.close(), answerer.close()]),
  };
}

/** `sdp` with every `a=setup` role reversed (active ↔ passive). */
export function reverseSetupRole(sdp: string) {
  return sdp.replace(/^a=setup:(active|passive)/gm, (_, role) =>
    role === "active" ? "a=setup:passive" : "a=setup:active",
  );
}

/**
 * Shared Arrange: a first negotiation whose offerer and answerer both send
 * video (VP8 and H264 configured on both sides). The remote offer is applied
 * on the answerer, which has not answered yet.
 */
export async function createVp8H264AnsweringPeers() {
  const config = { codecs: { video: [useVP8(), useH264()] } };
  const offerer = new RTCPeerConnection(config);
  const answerer = new RTCPeerConnection(config);
  const offererOut = new MediaStreamTrack({ kind: "video" });
  const answererOut = new MediaStreamTrack({ kind: "video" });
  const offererTransceiver = offerer.addTransceiver(offererOut, {
    direction: "sendrecv",
  });
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription!);
  const answererTransceiver = answerer.getTransceivers()[0];
  answererTransceiver.direction = "sendrecv";
  await answererTransceiver.sender.replaceTrack(answererOut);
  return {
    offerer,
    answerer,
    offererOut,
    answererOut,
    offererTransceiver,
    answererTransceiver,
    close: () => Promise.allSettled([offerer.close(), answerer.close()]),
  };
}

/** Wait until both peers report a connected (DTLS established) session. */
export async function waitForPeersConnected(...pcs: RTCPeerConnection[]) {
  await withTimeout(
    Promise.all(pcs.map((pc) => waitForDtlsConnected(pc.dtlsTransports[0]))),
    "peers did not connect",
  );
}
