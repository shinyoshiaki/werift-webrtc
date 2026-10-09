import { afterEach, beforeEach, expect } from "vitest";

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
  useTransportWideCC,
  useVP8,
} from "../../src";
import type { RTCIceCandidate } from "../../src";
import { ridRouteKey } from "../../src/negotiation/internalState";
import { SessionDescription } from "../../src/sdp";
import { RTCIceTransport } from "../../src/transport/ice";
export * from "../../tools/negotiation-diff/mutations";

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
        pendingLocal?: SessionDescription;
        pendingRemote?: SessionDescription;
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
      // RFC 8843: a non-tag member of an accepted BUNDLE group (the local
      // answer's group for a remote offer, the remote answer's own group)
      // shares the tag's transport; its own ICE attributes are not used.
      const answerBundle =
        snapshot.currentRemote.type === "offer"
          ? acceptedBundle
          : snapshot.currentRemote.group.find(
              (group) =>
                group.semantic === "BUNDLE" &&
                group.items.includes(media.rtp.muxId ?? ""),
            );
      const bundledNonTagFallback =
        !!answerBundle && answerBundle.items[0] !== media.rtp.muxId;
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
    // 合意した BUNDLE group (answer 側の group) の member は 1 つの transport を共有する。
    const answer =
      snapshot.currentRemote.type === "offer"
        ? snapshot.currentLocal
        : snapshot.currentRemote;
    for (const group of (answer?.group ?? []).filter(
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
    }
  }
  return snapshot;
}

/**
 * Which description decides each negotiated value while a negotiation is
 * pending (ticket 2.10 / NEGOTIATION_TRANSACTION.md "Effective values while
 * pending"): `current` keeps the committed value, `provisional` takes the
 * pranswer's, and before any answer the latest committed one applies.
 */
export function expectedLive(
  snapshot: Snapshot,
  field: "remoteMaxMessageSize" | "direction" | "sendCodec",
) {
  const pranswer =
    snapshot.pendingRemote?.type === "pranswer"
      ? { side: "remote" as const, description: snapshot.pendingRemote }
      : snapshot.pendingLocal?.type === "pranswer"
        ? { side: "local" as const, description: snapshot.pendingLocal }
        : undefined;
  const currentAnswer =
    snapshot.currentLocal?.type === "answer"
      ? { side: "local" as const, description: snapshot.currentLocal }
      : snapshot.currentRemote?.type === "answer"
        ? { side: "remote" as const, description: snapshot.currentRemote }
        : undefined;
  switch (field) {
    // The remote's receive limit: provisional from a pranswer (W3C updates
    // it on answer and pranswer), else the committed remote description.
    case "remoteMaxMessageSize": {
      const description = pranswer
        ? pranswer.side === "remote"
          ? pranswer.description
          : snapshot.pendingRemote
        : snapshot.currentRemote;
      return description && { side: "remote" as const, description };
    }
    // Direction (and so whether the sender sends) is provisional at a
    // pranswer (ticket 2.2), else the committed answer's.
    // Direction and send codec are provisional: the latest pranswer (local
    // or remote) applies until the final answer or a rollback.
    case "direction":
    case "sendCodec":
      return pranswer ?? currentAnswer;
  }
}

/** Effective negotiated values match `expectedLive` in every signaling state. */
function assertEffectiveValues(pc: RTCPeerConnection, snapshot: Snapshot) {
  const sctpDescription = expectedLive(snapshot, "remoteMaxMessageSize");
  const application = sctpDescription?.description.media.find(
    (media) => media.kind === "application" && media.port !== 0,
  );
  if (application && pc.sctpTransport && pc.sctpRemotePort !== undefined) {
    // 既存 DataChannel の送信上限は、効いている description の合意値。
    expect(pc.sctpTransport.remoteMaxMessageSize).toBe(
      application.sctpCapabilities?.maxMessageSize ?? 65536,
    );
  }
  const directionSource = expectedLive(snapshot, "direction");
  for (const transceiver of pc.getTransceivers()) {
    if (
      !transceiver.mid ||
      transceiver.stopped ||
      transceiver.stopping ||
      transceiver.pendingRejection
    ) {
      continue;
    }
    const media = directionSource?.description.media.find(
      (m) => m.rtp.muxId === transceiver.mid && m.port !== 0,
    );
    if (media && transceiver.currentDirection) {
      // currentDirection は効いている answer / pranswer の向き。
      const direction = media.direction ?? "inactive";
      const expected =
        directionSource!.side === "local"
          ? direction
          : (
              {
                sendonly: "recvonly",
                recvonly: "sendonly",
                sendrecv: "sendrecv",
                inactive: "inactive",
              } as const
            )[direction];
      expect(transceiver.currentDirection).toBe(expected);
    }
    // 送信 codec は最後に適用した pranswer (なければ current の answer) の codec。
    const codecSource = expectedLive(snapshot, "sendCodec");
    const codecMedia = codecSource?.description.media.find(
      (m) => m.rtp.muxId === transceiver.mid && m.port !== 0,
    );
    const sender = transceiver.sender;
    if (codecMedia && sender.codec && !transceiver.stopping) {
      // その description の先頭 (RTX 以外) の codec で送る。
      const first = codecMedia.rtp.codecs.find(
        (c) => c.name.toLowerCase() !== "rtx",
      );
      expect([
        sender.codec.payloadType,
        sender.codec.mimeType.toLowerCase(),
      ]).toEqual([first?.payloadType, first?.mimeType.toLowerCase()]);
    }
    // remote pranswer の SSRC は、current と衝突しなければ即座に、衝突すれば
    // staged として、その receiver に届く。
    const pranswerMedia =
      snapshot.pendingRemote?.type === "pranswer"
        ? snapshot.pendingRemote.media.find(
            (m) => m.rtp.muxId === transceiver.mid && m.port !== 0,
          )
        : undefined;
    if (
      pranswerMedia &&
      ["sendonly", "sendrecv"].includes(pranswerMedia.direction ?? "") &&
      ["recvonly", "sendrecv"].includes(transceiver.direction)
    ) {
      const router = (
        pc as unknown as {
          router: {
            ssrcTable: Record<number, unknown>;
            staged: { ssrc: [number, unknown][] };
          };
        }
      ).router;
      for (const { ssrc } of pranswerMedia.ssrc) {
        expect(
          router.ssrcTable[ssrc] === transceiver.receiver ||
            router.staged.ssrc.some(
              ([staged, receiver]) =>
                staged === ssrc && receiver === transceiver.receiver,
            ),
        ).toBe(true);
      }
    }
    // 送信は currentDirection が送信を含むときだけ (inactive / recvonly では止まる)。
    if (transceiver.currentDirection) {
      expect(
        (transceiver.sender as unknown as { sendSuppressed: boolean })
          .sendSuppressed,
      ).toBe(!["sendonly", "sendrecv"].includes(transceiver.currentDirection));
    }
  }
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
  assertEffectiveValues(pc, snapshot);
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

/** Remote candidates each ICE generation (remote ufrag) was ever given. */
type SdpCandidate =
  SessionDescription["media"][number]["iceCandidates"][number];
const candidateHistory = new WeakMap<
  RTCPeerConnection,
  Map<string, Map<string, SdpCandidate>>
>();
function signalledCandidates(pc: RTCPeerConnection) {
  return new Map(
    [
      ...(candidateHistory.get(pc) ??
        new Map<string, Map<string, SdpCandidate>>()),
    ].map(([ufrag, candidates]) => [ufrag, [...candidates.values()]]),
  );
}
function recordSignalledCandidates(pc: RTCPeerConnection, snapshot: Snapshot) {
  const history = candidateHistory.get(pc) ?? new Map();
  candidateHistory.set(pc, history);
  for (const description of [snapshot.currentRemote, snapshot.pendingRemote]) {
    for (const media of description?.media ?? []) {
      const ufrag = media.iceParams?.usernameFragment;
      if (!ufrag) continue;
      const candidates = history.get(ufrag) ?? new Map<string, SdpCandidate>();
      history.set(ufrag, candidates);
      for (const candidate of media.iceCandidates) {
        candidates.set(candidate.toJSON().candidate, candidate);
      }
    }
  }
}

function assertIceGenerations(pc: RTCPeerConnection, snapshot: Snapshot) {
  recordSignalledCandidates(pc, snapshot);
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
    // 同じ generation の以前の description が伝えた候補も含む (ICE は restart
    // なしに候補を取り消さない)。
    const sdpCandidates = [
      ...remoteMedia.flatMap((media) => media.iceCandidates),
      ...(signalledCandidates(pc).get(connection.remoteUsername) ?? []),
    ];
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
      // BUNDLE owner (group tag, else the m-line itself) of a MID.
      const ownerIn = (description: SessionDescription, mid?: string) =>
        description.group.find(
          (group) =>
            group.semantic === "BUNDLE" && group.items.includes(mid ?? ""),
        )?.items[0] ?? mid;
      const currentAnswer =
        snapshot.currentLocal.type === "answer"
          ? snapshot.currentLocal
          : snapshot.currentRemote;
      const currentOwner = ownerIn(currentAnswer, remoteMedia[0]?.rtp.muxId);
      for (const media of [
        ...remoteMedia,
        // 保留中の提案は、その提案自身の BUNDLE で同じ owner に残る m-line だけ
        // (group から外す m-line には同じ資格情報でも伝わらない)。
        ...(pendingRemote?.media ?? []).filter(
          (m) =>
            liveTransportForMid(pc, m.rtp.muxId) === transport &&
            ownerIn(pendingRemote!, m.rtp.muxId) === currentOwner,
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
      // stable では適用済みの staged restart は残らない。適用していない作成済み
      // offer の restart generation は残ってよいが、remote 側を持たず
      // (check も始まっておらず)、current SDP の資格情報とも異なる。
      const ice = transport.iceTransport as unknown as {
        appliedLocalRestart?: unknown;
      };
      expect(ice.appliedLocalRestart).toBeUndefined();
      const provisional = connection.provisional as
        | { remoteUsername?: string; started?: boolean; localUsername: string }
        | undefined;
      if (provisional) {
        expect(provisional.remoteUsername ?? "").toBe("");
        expect(provisional.started ?? false).toBe(false);
        expect(provisional.localUsername).not.toBe(connection.localUsername);
      }
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
    negotiation: {
      transportByMid: Map<string, DtlsTransport>;
      baseline?: {
        transceivers: {
          states: Map<
            unknown,
            { transceiver: { dtlsTransport: DtlsTransport } }
          >;
        };
        sctp: { dtlsTransport?: DtlsTransport };
      };
    };
  };
  const live = new Set(pc.dtlsTransports);
  const prepared = new Set(internal.negotiation.transportByMid.values());
  // pending 中は rollback baseline が束縛していた transport も保たれる (commit で停止判定)。
  const baseline = internal.negotiation.baseline;
  if (pc.signalingState !== "stable" && baseline) {
    for (const { transceiver } of baseline.transceivers.states.values()) {
      prepared.add(transceiver.dtlsTransport);
    }
    if (baseline.sctp.dtlsTransport) prepared.add(baseline.sctp.dtlsTransport);
  }
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
  await expectMediaAlive(session, label);
  await expectDataAlive(session, label);
}

/** Real RTP on the committed session in both directions. */
export async function expectMediaAlive(session: DuplexSession, label: string) {
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
}

/** DataChannel messages on the committed session in both directions. */
export async function expectDataAlive(session: DuplexSession, label: string) {
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

/**
 * Peers that applied a local description during the current test. Each one
 * must reach `expectSessionContinues` (or be exempted with a reason) before
 * the test ends; `enforceSessionContinuation` checks it after each test.
 */
const negotiatedPeers = new Set<RTCPeerConnection>();
const continuedPeers = new Set<RTCPeerConnection>();
const exemptPeers = new Map<RTCPeerConnection, string>();

/**
 * A peer the test cannot continue on purpose (closed by the operation under
 * test, a peer misdescribed on the wire, or no real remote peer); `reason`
 * documents why.
 */
export function exemptFromContinuation(
  peers: RTCPeerConnection | RTCPeerConnection[],
  reason: string,
) {
  for (const pc of [peers].flat()) exemptPeers.set(pc, reason);
}

/**
 * Register hooks that fail a test in which a peer applied a local
 * description but never reached `expectSessionContinues` and was not
 * exempted. Call it inside the `describe` of a test file.
 */
export function enforceSessionContinuation() {
  const original = RTCPeerConnection.prototype.setLocalDescription;
  beforeEach(() => {
    negotiatedPeers.clear();
    continuedPeers.clear();
    exemptPeers.clear();
    RTCPeerConnection.prototype.setLocalDescription = function (
      this: RTCPeerConnection,
      ...args: Parameters<RTCPeerConnection["setLocalDescription"]>
    ) {
      negotiatedPeers.add(this);
      return original.apply(this, args);
    } as RTCPeerConnection["setLocalDescription"];
  });
  afterEach(() => {
    RTCPeerConnection.prototype.setLocalDescription = original;
    const missing = [...negotiatedPeers].filter(
      (pc) => !continuedPeers.has(pc) && !exemptPeers.has(pc),
    );
    negotiatedPeers.clear();
    expect(
      missing.length,
      "a negotiated peer did not run expectSessionContinues",
    ).toBe(0);
  });
}

/** Return a peer and its remote peer to `stable` (rollback or final answer). */
async function settleForContinuation(
  a: RTCPeerConnection,
  b: RTCPeerConnection,
) {
  for (const [offerer, answerer] of [
    [a, b],
    [b, a],
  ] as const) {
    if (
      offerer.signalingState === "have-remote-pranswer" &&
      answerer.signalingState === "have-local-pranswer"
    ) {
      const answer = await answerer.createAnswer();
      await answerer.setLocalDescription(answer);
      await offerer.setRemoteDescription(answerer.localDescription!);
    }
  }
  for (const pc of [a, b]) {
    if (
      ["have-local-offer", "have-remote-pranswer"].includes(pc.signalingState)
    ) {
      await pc.setLocalDescription({ type: "rollback" } as never);
    }
    if (
      ["have-remote-offer", "have-local-pranswer"].includes(pc.signalingState)
    ) {
      await pc.setRemoteDescription({ type: "rollback" } as never);
    }
    assertNegotiationInvariants(pc);
  }
}

/** One offer/answer between two peers, checking invariants after each step. */
async function continuationNegotiation(
  offerer: RTCPeerConnection,
  answerer: RTCPeerConnection,
  options: { iceRestart?: boolean; beforeAnswer?: () => Promise<void> } = {},
) {
  const offer = await offerer.createOffer({ iceRestart: options.iceRestart });
  await offerer.setLocalDescription(offer);
  assertNegotiationInvariants(offerer);
  await answerer.setRemoteDescription(offerer.localDescription!);
  assertNegotiationInvariants(answerer);
  await options.beforeAnswer?.();
  await answerer.setLocalDescription(await answerer.createAnswer());
  assertNegotiationInvariants(answerer);
  await offerer.setRemoteDescription(answerer.localDescription!);
  assertNegotiationInvariants(offerer);
}

/** RTP from `outgoing` reaches `incoming`, retried until a pair is selected. */
async function expectRtpEventually(
  outgoing: MediaStreamTrack,
  incoming: MediaStreamTrack,
  text: string,
  ms = 10000,
) {
  let received = false;
  const { unSubscribe } = incoming.onReceiveRtp.subscribe((packet) => {
    if (packet.payload.toString() === text) received = true;
  });
  try {
    const deadline = Date.now() + ms;
    while (!received && Date.now() < deadline) {
      outgoing.writeRtp(
        new RtpPacket(new RtpHeader(), Buffer.from(text)).serialize(),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    unSubscribe();
  }
  expect(received, `RTP was not received: ${text}`).toBe(true);
}

/** A DataChannel message from `from` reaches `to`, retried until open. */
async function expectDataEventually(
  from: RTCDataChannel,
  to: RTCDataChannel,
  text: string,
  ms = 10000,
) {
  let received = false;
  const { unSubscribe } = to.onMessage.subscribe((data) => {
    if (data.toString() === text) received = true;
  });
  try {
    const deadline = Date.now() + ms;
    while (!received && Date.now() < deadline) {
      if (from.readyState === "open") from.send(Buffer.from(text));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    unSubscribe();
  }
  expect(received, `DataChannel message was not received: ${text}`).toBe(true);
}

/**
 * Assert: a session is still usable after the operations of a test. From
 * `stable` (a pending description is rolled back, a pranswer is finished
 * with its final answer) it runs, checking invariants after each step: a
 * plain offer from `a`, an ICE restart offer from `a`, an offer from `a` that
 * adds a DataChannel and a transceiver, and an offer from `b`. Then the new
 * DataChannel and the new transceiver carry data and RTP both ways.
 */
export async function expectSessionContinues(
  a: RTCPeerConnection,
  b: RTCPeerConnection,
  label = "continue",
) {
  continuedPeers.add(a);
  continuedPeers.add(b);
  expect(a.signalingState, "continuation needs an open peer").not.toBe(
    "closed",
  );
  expect(b.signalingState, "continuation needs an open peer").not.toBe(
    "closed",
  );
  await settleForContinuation(a, b);

  // Act: 次の offer と ICE restart の offer をそれぞれ交渉する。
  await continuationNegotiation(a, b);
  await continuationNegotiation(a, b, { iceRestart: true });

  // Act: DataChannel と transceiver を足した offer を交渉する。
  // RED は payload を包むので、先頭の codec が RED でない kind を使う。
  const kind = (["video", "audio"] as const).find((k) =>
    [a, b].every(
      (pc) =>
        !!pc.config.codecs[k]?.length &&
        !/\/red$/i.test(pc.config.codecs[k]![0].mimeType),
    ),
  );
  expect(kind, "the peers share no media kind").toBeDefined();
  const aOut = new MediaStreamTrack({ kind: kind! });
  const bOut = new MediaStreamTrack({ kind: kind! });
  const aTransceiver = a.addTransceiver(aOut, { direction: "sendrecv" });
  const aChannel = a.createDataChannel(`${label}-dc`);
  let bChannel: RTCDataChannel | undefined;
  const { unSubscribe } = b.onDataChannel.subscribe((channel) => {
    if (channel.label === `${label}-dc`) bChannel = channel;
  });
  let bTransceiver: RTCRtpTransceiver | undefined;
  try {
    await continuationNegotiation(a, b, {
      beforeAnswer: async () => {
        bTransceiver = b
          .getTransceivers()
          .find((t) => t.mid != undefined && t.mid === aTransceiver.mid);
        expect(
          bTransceiver,
          "added transceiver has no remote side",
        ).toBeDefined();
        bTransceiver!.direction = "sendrecv";
        await bTransceiver!.sender.replaceTrack(bOut);
      },
    });

    // Act: 相手側からの再 offer を交渉する。
    await continuationNegotiation(b, a);

    // Assert: 追加した transceiver で RTP が双方向に届く。
    await expectRtpEventually(
      aOut,
      bTransceiver!.receiver.track,
      `${label}-rtp-a-to-b`,
    );
    await expectRtpEventually(
      bOut,
      aTransceiver.receiver.track,
      `${label}-rtp-b-to-a`,
    );
    // Assert: 追加した DataChannel が両端で開き、双方向に届く。
    const deadline = Date.now() + 10000;
    while (!bChannel && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(bChannel, "added DataChannel did not reach the peer").toBeDefined();
    await expectDataEventually(aChannel, bChannel!, `${label}-dc-a-to-b`);
    await expectDataEventually(bChannel!, aChannel, `${label}-dc-b-to-a`);
  } finally {
    unSubscribe();
  }
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

/** Rewrite the max-message-size of the m-line `mid` (a remote peer's choice). */
export function withMaxMessageSize(sdp: string, mid: string, size: number) {
  return mungeSection(sdp, mid, (section) =>
    section.replace(/a=max-message-size:\d+/, `a=max-message-size:${size}`),
  );
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
    /** Runs after the answerer applied the offer, before createAnswer. */
    beforeAnswer?: () => Promise<void>;
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
  await options.beforeAnswer?.();
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
    createdOffer?: { sdp: string };
  };
  internal.lastCreatedOffer = rewritten;
  // 生成記録 (MID の割り当て) はそのまま、SDP だけを書き換えた offer にする。
  internal.createdOffer = { ...internal.createdOffer!, sdp: rewritten.sdp };
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

/**
 * Everything a rejected description operation must leave untouched: the
 * signaling state, the current / pending descriptions, each transport's
 * public ICE credentials and staged restart, every transceiver's MID and
 * m-line index, and the router tables.
 */
export function negotiationSnapshot(pc: RTCPeerConnection) {
  const router = (
    pc as unknown as {
      router: {
        ssrcTable: Record<string, unknown>;
        ridTable: Record<string, unknown>;
      };
    }
  ).router;
  const endpoints = pc
    .getTransceivers()
    .flatMap((t) => [t.sender, t.receiver]) as unknown[];
  const table = (entries: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(entries).map(([key, value]) => [
        key,
        endpoints.indexOf(value),
      ]),
    );
  return {
    signalingState: pc.signalingState,
    currentLocal: pc.currentLocalDescription?.sdp,
    currentRemote: pc.currentRemoteDescription?.sdp,
    pendingLocal: pc.pendingLocalDescription?.sdp,
    pendingRemote: pc.pendingRemoteDescription?.sdp,
    ice: pc.iceTransports.map((transport) => ({
      ufrag: transport.localParameters.usernameFragment,
      staged: transport.hasStagedRestart,
    })),
    transceivers: pc
      .getTransceivers()
      .map((t) => ({ mid: t.mid, index: t.mLineIndex })),
    ssrcTable: table(router.ssrcTable),
    ridTable: table(router.ridTable),
  };
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

/**
 * Arrange: the next gather of an ICE transport `pc` does not have yet (one
 * a proposal prepares) closes `pc` while it runs. Returns every transport
 * gathered from then on, so a test can check that none is left running.
 */
export function closeDuringNextPreparedGather(pc: RTCPeerConnection) {
  const proto = RTCIceTransport.prototype;
  const original = proto.gather;
  const existing = new Set(pc.iceTransports);
  const gathered: RTCIceTransport[] = [];
  let closing: Promise<void> | undefined;
  proto.gather = async function (this: RTCIceTransport) {
    if (existing.has(this)) return original.call(this);
    gathered.push(this);
    if (!closing) closing = pc.close();
    await original.call(this);
  };
  return {
    gathered,
    closed: () => closing,
    restore: () => {
      proto.gather = original;
    },
  };
}

/**
 * Arrange: a duplex session for SDP mutations (VP8 + H264, two video header
 * extensions, a DataChannel). `renegotiation` starts connected; `initial`
 * starts unnegotiated: `b.video` appears with the remote offer and
 * `b.channel` once the DataChannel opens (see `prepareMutationAnswerer`).
 */
export async function createMutationSession(
  phase: "initial" | "renegotiation",
  { audio = false }: { audio?: boolean } = {},
): Promise<DuplexSession> {
  const config = {
    codecs: {
      video: [useVP8(), useH264()],
      ...(audio ? { audio: [useOPUS()] } : {}),
    },
    headerExtensions: { video: [useSdesMid(), useAbsSendTime()] },
  };
  if (phase === "renegotiation") {
    const session = await createDuplexSession(config);
    if (audio) {
      // audio の m-line (video の後ろ) を足して確定しておく。
      session.a.pc.addTransceiver(new MediaStreamTrack({ kind: "audio" }), {
        direction: "sendrecv",
      });
      await negotiate(session, session.a, session.b);
    }
    return session;
  }
  const a = new RTCPeerConnection(config);
  const b = new RTCPeerConnection(config);
  const aOut = new MediaStreamTrack({ kind: "video" });
  const bOut = new MediaStreamTrack({ kind: "video" });
  const aChannel = a.createDataChannel("matrix");
  const aVideo = a.addTransceiver(aOut, { direction: "sendrecv" });
  if (audio) {
    a.addTransceiver(new MediaStreamTrack({ kind: "audio" }), {
      direction: "sendrecv",
    });
  }
  const peers = {
    a: { pc: a, out: aOut, video: aVideo, channel: aChannel },
    b: {
      pc: b,
      out: bOut,
      get video() {
        return b.getTransceivers()[0];
      },
      channel: undefined as unknown as RTCDataChannel,
    },
  };
  b.onDataChannel.subscribe((channel) => {
    peers.b.channel = channel;
  });
  return {
    ...peers,
    peers,
    close: () => Promise.allSettled([a.close(), b.close()]),
  } as unknown as DuplexSession;
}

/** Arrange: the answerer of an initial mutation session sends video too. */
export async function prepareMutationAnswerer(session: DuplexSession) {
  const video = session.b.pc.getTransceivers()[0];
  if (!video || video.sender.track === session.b.out) return;
  video.direction = "sendrecv";
  await video.sender.replaceTrack(session.b.out);
}

/** Wait until a session's DTLS is connected and its DataChannel is open. */
export async function waitForMutationSession(session: DuplexSession) {
  await waitForPeersConnected(session.a.pc, session.b.pc);
  await withTimeout(
    (async () => {
      while (session.a.channel.readyState !== "open" || !session.b.channel) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })(),
    "DataChannel did not open",
  );
}

/**
 * Act + Assert: run a description operation that may be accepted or
 * rejected. Accepted: every invariant holds. Rejected: both peers are
 * exactly as before. Returns whether it was accepted.
 */
export async function acceptOrRejectAtomically(
  session: DuplexSession,
  operation: () => Promise<unknown>,
) {
  const before = [session.a.pc, session.b.pc].map(negotiationSnapshot);
  const accepted = await operation().then(
    () => true,
    () => false,
  );
  if (!accepted) {
    // 拒否されたら両 peer の状態は操作前と完全に一致する。
    expect([session.a.pc, session.b.pc].map(negotiationSnapshot)).toEqual(
      before,
    );
  }
  // 受理・拒否どちらでも invariant を満たす。
  assertNegotiationInvariants(session.a.pc);
  assertNegotiationInvariants(session.b.pc);
  return accepted;
}

/** Rewrite every candidate to an address nobody answers (STUN checks wait). */
export function unreachableCandidates(sdp: string) {
  return sdp
    .replace(
      /^(a=candidate:\S+ \d+ udp \d+ )\S+ \d+ typ (\w+).*$/gm,
      "$1127.0.0.1 9 typ host",
    )
    .replace(/^a=end-of-candidates\r\n/gm, "");
}

export type InterruptWait = "gather" | "mdns" | "dtls" | "stun";

/**
 * Arrange: a mutation session with a negotiation step held at `wait`.
 * - gather: the offerer's ICE restart commit (remote answer) gathering
 * - mdns: an mDNS candidate of the offerer's provisional (restart pranswer)
 *   generation resolving
 * - dtls: the offerer's DTLS start of a first negotiation's answer
 * - stun: a first negotiation checking candidates nobody answers
 * `pending` is the held operation (settled, never rejected here); `release`
 * lets it go on.
 */
export async function arrangeInterruptWait(wait: InterruptWait) {
  const session = await createMutationSession(
    wait === "gather" || wait === "mdns" ? "renegotiation" : "initial",
  );
  const { a, b } = session;
  const settle = (operation: Promise<unknown>) =>
    operation.then(
      () => "resolved",
      (error: Error) => error.name,
    );
  switch (wait) {
    case "gather": {
      await step(session, async () =>
        a.pc.setLocalDescription(await a.pc.createOffer({ iceRestart: true })),
      );
      await step(session, () =>
        b.pc.setRemoteDescription(a.pc.localDescription!),
      );
      await step(session, async () =>
        b.pc.setLocalDescription(await b.pc.createAnswer()),
      );
      const gather = holdNextGather(a.pc);
      const pending = settle(a.pc.setRemoteDescription(b.pc.localDescription!));
      await gather.reached;
      return { session, pending, release: gather.release };
    }
    case "mdns": {
      await step(session, async () =>
        a.pc.setLocalDescription(await a.pc.createOffer({ iceRestart: true })),
      );
      await step(session, () =>
        b.pc.setRemoteDescription(a.pc.localDescription!),
      );
      const answer = (await b.pc.createAnswer()).sdp;
      await step(session, () =>
        b.pc.setLocalDescription({ type: "pranswer", sdp: answer }),
      );
      await step(session, () =>
        a.pc.setRemoteDescription({ type: "pranswer", sdp: answer }),
      );
      const mdns = stubIceMdns(a.pc);
      const ufrag = /^a=ice-ufrag:(.*)$/m.exec(answer)![1].trim();
      const pending = settle(
        a.pc.addIceCandidate(trickleCandidate(50997, ufrag, "0", "peer.local")),
      );
      await withTimeout(
        (async () => {
          while (mdns.requested === 0) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        })(),
        "mDNS lookup did not start",
      );
      return { session, pending, release: () => mdns.resolveAll() };
    }
    case "dtls":
    case "stun": {
      const wire =
        wait === "stun" ? unreachableCandidates : (sdp: string) => sdp;
      await a.pc.setLocalDescription(await a.pc.createOffer());
      await b.pc.setRemoteDescription({
        type: "offer",
        sdp: wire(a.pc.localDescription!.sdp),
      });
      await prepareMutationAnswerer(session);
      await b.pc.setLocalDescription(await b.pc.createAnswer());
      const dtls = wait === "dtls" ? holdDtlsStart(a.pc) : undefined;
      const pending = settle(
        a.pc.setRemoteDescription({
          type: "answer",
          sdp: wire(b.pc.localDescription!.sdp),
        }),
      );
      await withTimeout(
        (async () => {
          const state = wait === "dtls" ? "connected" : "checking";
          while (a.pc.iceConnectionState !== state) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        })(),
        `ICE did not reach the ${wait} wait`,
      );
      return { session, pending, release: () => dtls?.release() };
    }
  }
}

// --- spec coverage: events ---

/** Poll `condition` until it holds (fails after the shared timeout). */
export async function waitUntil(condition: () => boolean, message: string) {
  await withTimeout(
    (async () => {
      while (!condition()) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })(),
    message,
  );
}

/**
 * Arrange: record the observable negotiation events `pc` delivers from now
 * on, per kind in delivery order: `track` events (with their streams),
 * remote-created transceivers, `datachannel`, ICE candidates (undefined =
 * end-of-candidates), signaling / connection / ICE connection state changes
 * and `negotiationneeded`.
 */
export function recordNegotiationEvents(pc: RTCPeerConnection) {
  const events = {
    tracks: [] as import("../../src").RTCTrackEvent[],
    remoteTransceivers: [] as RTCRtpTransceiver[],
    dataChannels: [] as RTCDataChannel[],
    candidates: [] as (RTCIceCandidate | undefined)[],
    signaling: [] as string[],
    connection: [] as string[],
    iceConnection: [] as string[],
    negotiationNeeded: 0,
  };
  pc.addEventListener("track", (event: import("../../src").RTCTrackEvent) => {
    events.tracks.push(event);
  });
  pc.onRemoteTransceiverAdded.subscribe((transceiver) => {
    events.remoteTransceivers.push(transceiver);
  });
  pc.onDataChannel.subscribe((channel) => {
    events.dataChannels.push(channel);
  });
  pc.onIceCandidate.subscribe((candidate) => {
    events.candidates.push(candidate);
  });
  pc.signalingStateChange.subscribe((state) => {
    events.signaling.push(state);
  });
  pc.connectionStateChange.subscribe((state) => {
    events.connection.push(state);
  });
  pc.iceConnectionStateChange.subscribe((state) => {
    events.iceConnection.push(state);
  });
  pc.onNegotiationneeded.subscribe(() => {
    events.negotiationNeeded++;
  });
  return events;
}
export type NegotiationEvents = ReturnType<typeof recordNegotiationEvents>;

/**
 * Shared Arrange: a first negotiation with only an application m-line,
 * connected at its pranswer. The offerer's channel `local` is open on the
 * provisional SCTP association and the answerer delivered it as `remote`.
 * `offererEvents` / `answererEvents` record from before the offer.
 */
export async function createInitialPranswerDataChannel(label = "provisional") {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  const offererEvents = recordNegotiationEvents(offerer);
  const answererEvents = recordNegotiationEvents(answerer);
  const local = offerer.createDataChannel(label);
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription!);
  const pranswer = (await answerer.createAnswer()).sdp;
  await answerer.setLocalDescription({ type: "pranswer", sdp: pranswer });
  await offerer.setRemoteDescription({ type: "pranswer", sdp: pranswer });
  await waitUntil(
    () => local.readyState === "open" && answererEvents.dataChannels.length > 0,
    "provisional DataChannel did not open",
  );
  return {
    offerer,
    answerer,
    local,
    remote: answererEvents.dataChannels[0],
    pranswer,
    offererEvents,
    answererEvents,
    close: () => Promise.allSettled([offerer.close(), answerer.close()]),
  };
}

/** RFC 8832 payload protocol identifier of DCEP messages. */
const DCEP_PPID = 50;

/**
 * Arrange: hold the DCEP messages `pc`'s current SCTP association receives,
 * modelling a delivery callback still queued when its negotiation is
 * discarded. `release()` hands them to the association's own receive path.
 */
export function holdIncomingDcep(pc: RTCPeerConnection) {
  const receive = pc.sctpTransport!.sctp.onReceive;
  const original = receive.execute;
  const held: Parameters<typeof original>[] = [];
  receive.execute = (...args) => {
    if (args[1] === DCEP_PPID) {
      held.push(args);
      return;
    }
    original(...args);
  };
  return {
    get held() {
      return held.length;
    },
    release: () => {
      receive.execute = original;
      for (const args of held.splice(0)) original(...args);
    },
  };
}

/** The DataChannels `pc`'s SCTP transport currently routes by stream ID. */
export function registeredDataChannels(pc: RTCPeerConnection) {
  return Object.values(pc.sctpTransport?.dataChannels ?? {});
}

/**
 * Shared Arrange: a first remote offer (sendrecv audio) created a
 * transceiver on the answerer, the application attached `localTrack` to it
 * with addTrack, and both peers rolled the offer back, so the answerer keeps
 * `kept` without a MID. Invariants are checked after every operation.
 */
export async function createKeptRemoteTransceiver() {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  const offererEvents = recordNegotiationEvents(offerer);
  const localTrack = new MediaStreamTrack({ kind: "audio" });
  const both = async (operation: () => Promise<unknown>) => {
    await operation();
    assertNegotiationInvariants(offerer);
    assertNegotiationInvariants(answerer);
  };
  offerer.addTransceiver("audio", { direction: "sendrecv" });
  await both(async () =>
    offerer.setLocalDescription(await offerer.createOffer()),
  );
  await both(() => answerer.setRemoteDescription(offerer.localDescription!));
  const kept = answerer.getTransceivers()[0];
  answerer.addTrack(localTrack);
  await both(() => offerer.setLocalDescription({ type: "rollback" }));
  await both(() => answerer.setRemoteDescription({ type: "rollback" }));
  return {
    offerer,
    answerer,
    kept,
    localTrack,
    offererEvents,
    both,
    close: () => Promise.allSettled([offerer.close(), answerer.close()]),
  };
}

// --- spec coverage: ice ---

/**
 * Shared Arrange: `createIceRestartPranswer` on a session whose BUNDLE group
 * also carries a sendonly audio m-line (a non-tag member). The offerer holds
 * a provisional generation for the pranswer's credentials, without
 * end-of-candidates yet. Returns the pranswer ufrag and the MIDs of the
 * video (tag) and audio m-lines.
 */
export async function createBundledIceRestartPranswer() {
  const peers = await createConnectedVideoPeers({}, { withAudio: true });
  const { offerer, answerer } = peers;
  await offerer.setLocalDescription(
    await offerer.createOffer({ iceRestart: true }),
  );
  await answerer.setRemoteDescription(offerer.localDescription!);
  const answer = await answerer.createAnswer();
  await answerer.setLocalDescription({ type: "pranswer", sdp: answer.sdp });
  await offerer.setRemoteDescription({
    type: "pranswer",
    sdp: answerer.localDescription!.sdp.replace(
      /^a=end-of-candidates\r?\n/gm,
      "",
    ),
  });
  const [video, audio] = (["video", "audio"] as const).map(
    (kind) => offerer.getTransceivers().find((t) => t.kind === kind)!.mid!,
  );
  const ufrag = sectionOf(offerer.pendingRemoteDescription!.sdp, video).match(
    /^a=ice-ufrag:(\S+)/m,
  )![1];
  return { ...peers, ufrag, video, audio };
}

/** Record the connection states `pc` reports from now on. */
export function recordConnectionStates(pc: RTCPeerConnection) {
  const states: string[] = [];
  pc.connectionStateChange.subscribe((state) => {
    states.push(state);
  });
  return states;
}

/**
 * `sdp` with the ICE credentials of every m-line replaced, as a peer that
 * restarted its agent again would send them in a replacement pranswer.
 */
export function withIceCredentials(sdp: string, ufrag: string, pwd: string) {
  return sdp
    .replace(/^a=ice-ufrag:\S+/gm, `a=ice-ufrag:${ufrag}`)
    .replace(/^a=ice-pwd:\S+/gm, `a=ice-pwd:${pwd}`);
}

/**
 * Arrange: leave every ICE agent of `pc` without a STUN / TURN server. With
 * `iceServers: []` the ICE agent still falls back to its default STUN
 * server, so a generation that has no server to query is reached this way.
 */
export function removeIceAgentServers(pc: RTCPeerConnection) {
  for (const transport of pc.iceTransports) {
    const connection = transport.connection as unknown as {
      stunServer?: Address;
      turnServer?: Address;
    };
    connection.stunServer = undefined;
    connection.turnServer = undefined;
  }
}

// --- spec coverage: transport ---

/** `sdp` with `mid` left out of its BUNDLE group (the m-line gets its own transport). */
export function leaveBundle(sdp: string, mid: string) {
  return sdp.replace(
    /^a=group:BUNDLE ([^\r\n]+)/m,
    (_, items: string) =>
      `a=group:BUNDLE ${items
        .split(" ")
        .filter((item) => item !== mid)
        .join(" ")}`,
  );
}

/** `sdp` whose m-line `mid` offers only a codec nobody supports, at a fresh payload type. */
export function withOnlyUnsupportedCodec(sdp: string, mid: string) {
  return mungeSection(sdp, mid, (section) =>
    section
      .replace(/^(m=\w+ \S+ \S+) [^\r\n]+/m, "$1 125")
      .replace(/^a=(rtpmap|fmtp|rtcp-fb):\d+ [^\r\n]*\r\n/gm, "")
      .replace(
        /^(a=mid:[^\r\n]+\r\n)/m,
        "$1a=rtpmap:125 x-unsupported/90000\r\n",
      )
      .replace(/^a=ssrc-group:[^\r\n]*\r\n/gm, ""),
  );
}

/**
 * Arrange: hold the DTLS start of every transport `pc` holds that has not
 * started yet (for example a pending BUNDLE split owner) until `release()`.
 */
export function holdNewDtlsStart(pc: RTCPeerConnection) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = [...heldTransports(pc)].filter(
    (transport) => transport.state === "new",
  );
  for (const transport of held) {
    const original = transport.start.bind(transport);
    transport.start = async () => {
      transport.start = original;
      await released;
      return original();
    };
  }
  return { held, release };
}

/**
 * Arrange: `createInitialPranswerConnection`, also returning the offer the
 * offerer created ([[LastCreatedOffer]]; its localDescription carries the
 * gathered candidates on top of it).
 */
export async function createInitialPranswerConnectionWithOffer() {
  const connection = await createInitialPranswerConnection();
  const { sdp } = (
    connection.offerer as unknown as { createdOffer: { sdp: string } }
  ).createdOffer;
  return { ...connection, offer: { type: "offer" as const, sdp } };
}

// --- spec coverage: codecs ---

/** Payload type of the first codec named `name` (rtpmap encoding name, any case) in `sdp`. */
export function payloadTypeOf(sdp: string, name: string) {
  const match = sdp.match(new RegExp(`^a=rtpmap:(\\d+) ${name}/`, "im"));
  if (!match) throw new Error(`No ${name} codec in the SDP`);
  return Number(match[1]);
}

/**
 * `sdp` whose `kind` m-lines no longer list the codecs named `names`, nor an
 * RTX codec whose `apt` pointed at one of them (a remote peer's subset).
 */
export function withoutCodecs(
  sdp: string,
  kind: "audio" | "video",
  names: string[],
) {
  const [session, ...sections] = sdp.split(/(?=^m=)/m);
  return [
    session,
    ...sections.map((section) => {
      if (!section.startsWith(`m=${kind} `)) return section;
      const dropped = new Set<string>();
      for (const [, pt, name] of section.matchAll(
        /^a=rtpmap:(\d+) ([^/\r\n]+)\//gm,
      )) {
        if (names.some((n) => n.toLowerCase() === name.toLowerCase())) {
          dropped.add(pt);
        }
      }
      for (const [, pt, apt] of section.matchAll(/^a=fmtp:(\d+) apt=(\d+)/gm)) {
        if (dropped.has(apt)) dropped.add(pt);
      }
      return section
        .replace(
          /^(m=\S+ \S+ \S+)([^\r\n]*)/m,
          (_, head: string, pts: string) =>
            `${head}${pts
              .split(" ")
              .filter((pt) => !dropped.has(pt))
              .join(" ")}`,
        )
        .split("\r\n")
        .filter((line) => {
          const pt = line.match(/^a=(?:rtpmap|fmtp|rtcp-fb):(\d+) /)?.[1];
          return !pt || !dropped.has(pt);
        })
        .join("\r\n");
    }),
  ].join("");
}

/** `sdp` without the `a=extmap` lines of the header extension `uri`. */
export function withoutExtmap(sdp: string, uri: string) {
  return sdp
    .split("\r\n")
    .filter(
      (line) => !(line.startsWith("a=extmap:") && line.endsWith(` ${uri}`)),
    )
    .join("\r\n");
}

/** `sdp` whose codec `name` also lists the RTCP feedback `type` (for example `transport-cc`). */
export function withRtcpFeedback(sdp: string, name: string, type: string) {
  return sdp.replace(
    new RegExp(`^(a=rtpmap:(\\d+) ${name}/[^\\r\\n]*)`, "gim"),
    `$1\r\na=rtcp-fb:$2 ${type}`,
  );
}

/**
 * Act helper: write one SRTP packet with exactly the header the test chooses
 * (payload type, SSRC, sequence number, extensions) on `transport`, without
 * the sender rewriting it.
 */
export async function sendRawRtp(
  transport: DtlsTransport,
  header: {
    ssrc: number;
    payloadType: number;
    sequenceNumber: number;
    extensions?: { id: number; payload: Buffer }[];
  },
  payload: Buffer,
) {
  await transport.sendRtp(
    payload,
    new RtpHeader({
      timestamp: header.sequenceNumber * 3000,
      marker: true,
      ...header,
    }),
  );
}

/** Resolve with the first RTP packet whose payload is `text` on any of `tracks`, and the track that got it. */
export function watchRtpText(
  tracks: MediaStreamTrack[],
  text: string,
  ms = 2000,
) {
  return withTimeout(
    new Promise<{ track: MediaStreamTrack; packet: RtpPacket }>((resolve) => {
      for (const track of tracks) {
        track.onReceiveRtp.subscribe((packet) => {
          if (packet.payload.toString() === text) resolve({ track, packet });
        });
      }
    }),
    `RTP was not received: ${text}`,
    ms,
  );
}

/** Record the generic NACK feedback (lost sequence numbers) that reaches `sender` over the session. */
export function recordSenderFeedback(sender: RTCRtpSender) {
  const record = { nacks: [] as number[][] };
  const subscription = sender.onGenericNack.subscribe((nack) =>
    record.nacks.push(nack.lost),
  );
  return { record, stop: () => subscription.unSubscribe() };
}

let twccSequenceNumber = 20000;
/**
 * Write `packets` RTP packets on `outgoing` (its sender adds the transport-cc
 * header extension when negotiated) and report whether `receiver` sent
 * transport-wide CC feedback (RTPFB FMT 15) for them on its DTLS transport.
 * The feedback is observed where it leaves the receiving peer: a werift
 * sender cannot parse it yet, because `ReceiverTWCC` writes it without the
 * 32-bit padding (an RTP-layer defect outside the negotiation).
 */
export async function twccFeedbackSent(
  outgoing: MediaStreamTrack,
  receiver: RTCRtpReceiver,
  { packets = 15, waitMs = 700 }: { packets?: number; waitMs?: number } = {},
) {
  const transport = receiver.dtlsTransport;
  const original = transport.sendRtcp;
  let sent = 0;
  transport.sendRtcp = (rtcp) => {
    for (const packet of rtcp as {
      type: number;
      feedback?: { count: number };
    }[]) {
      // RTPFB (205) の FMT 15 が transport-wide CC。
      if (packet.type === 205 && packet.feedback?.count === 15) sent++;
    }
    return original.call(transport, rtcp);
  };
  try {
    for (let i = 0; i < packets; i++) {
      const sequenceNumber = ++twccSequenceNumber;
      outgoing.writeRtp(
        new RtpPacket(
          new RtpHeader({ sequenceNumber, timestamp: sequenceNumber * 3000 }),
          Buffer.from(`twcc-${sequenceNumber}`),
        ).serialize(),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const deadline = Date.now() + waitMs;
    while (sent === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return sent > 0;
  } finally {
    transport.sendRtcp = original;
  }
}

/** Configuration of a video RTX codec; its `apt` is the codec configured just before it. */
export function rtxCodec() {
  return new RTCRtpCodecParameters({ mimeType: "video/rtx", clockRate: 90000 });
}

/**
 * Shared Arrange: connected sendonly video like `createConnectedVideoPeers`,
 * with a separate configuration per peer and optional codec preferences the
 * offerer applies before its first offer.
 */
export async function createConnectedVideoPeersWith({
  offerer: offererConfig,
  answerer: answererConfig = offererConfig,
  offererPreferences,
}: {
  offerer: ConstructorParameters<typeof RTCPeerConnection>[0];
  answerer?: ConstructorParameters<typeof RTCPeerConnection>[0];
  offererPreferences?: RTCRtpCodecParameters[];
}) {
  const offerer = new RTCPeerConnection(offererConfig);
  const answerer = new RTCPeerConnection(answererConfig);
  const outgoing = new MediaStreamTrack({ kind: "video" });
  const transceiver = offerer.addTransceiver(outgoing, {
    direction: "sendonly",
  });
  if (offererPreferences) transceiver.setCodecPreferences(offererPreferences);
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription!);
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(answerer.localDescription!);
  await withTimeout(
    Promise.all([waitForConnection(offerer), waitForConnection(answerer)]),
    "Video peers did not connect",
  );
  const remote = answerer.getTransceivers()[0];
  return {
    offerer,
    answerer,
    outgoing,
    incoming: remote.receiver.track,
    sender: transceiver.sender,
    receiver: remote.receiver,
    transceiver,
    remote,
    close: () => Promise.allSettled([offerer.close(), answerer.close()]),
  };
}

/**
 * Shared Arrange: connected session whose offerer sends video (VP8 + RTX,
 * H264 configured) and audio (RED + Opus), both m-lines with the MID and
 * abs-send-time header extensions, so a description can change the codec,
 * RTX, RED and header extensions a sender uses.
 */
export function createConnectedSendParamPeers() {
  const red = () =>
    new RTCRtpCodecParameters({
      mimeType: "audio/red",
      clockRate: 48000,
      channels: 2,
    });
  const opus = () =>
    new RTCRtpCodecParameters({
      mimeType: "audio/opus",
      clockRate: 48000,
      channels: 2,
    });
  return createConnectedVideoPeers(
    {
      codecs: {
        video: [useVP8(), rtxCodec(), useH264()],
        audio: [red(), opus()],
      },
      headerExtensions: {
        video: [useSdesMid(), useAbsSendTime()],
        audio: [useSdesMid(), useAbsSendTime()],
      },
    },
    { withAudio: true },
  );
}

/**
 * Shared Arrange: both peers send video, configured with VP8 + RTX and
 * H264 (transport-cc) + RTX. The first negotiation commits VP8 + RTX only;
 * then the offerer's re-offer that proposes H264 + RTX only is applied on
 * the answerer, which has not answered yet.
 */
export async function createVp8RtxSessionWithH264Reoffer() {
  const config = () => ({
    codecs: {
      video: [
        useVP8(),
        rtxCodec(),
        useH264({
          rtcpFeedback: [
            { type: "nack" },
            { type: "nack", parameter: "pli" },
            { type: "transport-cc" },
          ],
        }),
        rtxCodec(),
      ],
    },
  });
  const offerer = new RTCPeerConnection(config());
  const answerer = new RTCPeerConnection(config());
  const offererOut = new MediaStreamTrack({ kind: "video" });
  const answererOut = new MediaStreamTrack({ kind: "video" });
  const offererTransceiver = offerer.addTransceiver(offererOut, {
    direction: "sendrecv",
  });
  offererTransceiver.setCodecPreferences([useVP8()]);
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription!);
  const answererTransceiver = answerer.getTransceivers()[0];
  answererTransceiver.direction = "sendrecv";
  await answererTransceiver.sender.replaceTrack(answererOut);
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(answerer.localDescription!);
  await waitForPeersConnected(offerer, answerer);
  offererTransceiver.setCodecPreferences([useH264()]);
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription!);
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

/**
 * Shared Arrange: a VP8 + H264 video session negotiating the transport-cc
 * header extension, where only `twccCodec` carries the transport-cc RTCP
 * feedback. The current codec is VP8; the offerer's re-offer that proposes
 * H264 only is applied on the answerer (no preference change there).
 */
export async function createTwccH264OnlyReoffer(twccCodec: "VP8" | "H264") {
  const feedback = (codec: "VP8" | "H264") => [
    { type: "nack" },
    { type: "nack", parameter: "pli" },
    ...(codec === twccCodec ? [{ type: "transport-cc" }] : []),
  ];
  const config = () => ({
    codecs: {
      video: [
        useVP8({ rtcpFeedback: feedback("VP8") }),
        useH264({ rtcpFeedback: feedback("H264") }),
      ],
    },
    headerExtensions: { video: [useTransportWideCC()] },
  });
  const peers = await createConnectedVideoPeersWith({
    offerer: config(),
    answerer: config(),
  });
  peers.transceiver.setCodecPreferences([useH264()]);
  await peers.offerer.setLocalDescription(await peers.offerer.createOffer());
  await peers.answerer.setRemoteDescription(peers.offerer.localDescription!);
  return peers;
}

/**
 * Shared Arrange: a committed session with one inactive audio m-line (index
 * 0). `inactive` is the answerer's transceiver of that m-line.
 */
export async function createCommittedInactiveAudioPeers() {
  const peers = createUnnegotiatedPeers();
  const { offerer, answerer } = peers;
  offerer.addTransceiver("audio", { direction: "inactive" });
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription!);
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(answerer.localDescription!);
  const [inactive] = answerer.getTransceivers();
  return { ...peers, inactive, inactiveMid: inactive.mid! };
}
