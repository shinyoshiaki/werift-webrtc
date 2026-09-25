import { expect } from "vitest";

import {
  MediaStreamTrack,
  type RTCDataChannel,
  RTCPeerConnection,
  RtpHeader,
  RtpPacket,
} from "../../src";
import type { SessionDescription } from "../../src/sdp";

/** Shared Arrange setup for negotiation transaction regression tests. */
export async function createConnectedVideoPeers() {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  const outgoing = new MediaStreamTrack({ kind: "video" });
  let incoming: MediaStreamTrack | undefined;
  answerer.onRemoteTransceiverAdded.subscribe((transceiver) => {
    transceiver.onTrack.subscribe((track) => {
      incoming = track;
    });
  });
  offerer.addTransceiver(outgoing, { direction: "sendonly" });
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription!);
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
      expect(transport.iceTransport.localParameters.usernameFragment).toBe(
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
      if (
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
    // current SDP の payload type は pending 中も current の codec で解釈される。
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
      expect(live.mimeType.toLowerCase()).toBe(
        committed.mimeType.toLowerCase(),
      );
    }
  }
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
            c.ip === candidate.host &&
            c.port === candidate.port &&
            c.protocol.toLowerCase() === candidate.transport.toLowerCase(),
        ),
      ).toBe(true);
    }
    // EOC は current SDP に記録された generation にだけ反映される。
    if (connection.remoteCandidatesEnd) {
      expect(remoteMedia.some((media) => media.iceCandidatesComplete)).toBe(
        true,
      );
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
  if (!sctp || pc.signalingState !== "stable" || !snapshot.currentRemote)
    return;
  const [index, application] =
    [...snapshot.currentRemote.media.entries()].find(
      ([, media]) => media.kind === "application" && media.port !== 0,
    ) ?? [];
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
  const offer = await offerer.pc.createOffer({
    iceRestart: options.iceRestart,
  });
  const localOffer = options.localOffer?.(offer.sdp) ?? offer.sdp;
  await step(session, () =>
    offerer.pc.setLocalDescription({ type: "offer", sdp: localOffer }),
  );
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
