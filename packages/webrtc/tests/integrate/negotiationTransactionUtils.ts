import { expect } from "vitest";

import {
  MediaStreamTrack,
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
export async function waitForPendingTransport(pc: RTCPeerConnection) {
  const negotiation = pc as unknown as {
    negotiation: {
      transportByMid: Map<string, RTCPeerConnection["dtlsTransports"][number]>;
    };
  };
  const pending = [
    ...new Set(negotiation.negotiation.transportByMid.values()),
  ].filter((transport) => !pc.dtlsTransports.includes(transport));
  expect(pending.length).toBeGreaterThan(0);
  await Promise.race([
    Promise.all(
      pending.map(async (transport) => {
        if (transport.state !== "connected") {
          await transport.onStateChange.watch((state) => state === "connected");
        }
      }),
    ),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Pending DTLS did not connect")), 3000),
    ),
  ]);
  for (const transport of pending) {
    expect(transport.iceTransport.getSelectedCandidatePair()).not.toBeNull();
  }
}

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

/** Test-only observation; no PeerConnection public API is added. */
export function assertNegotiationInvariants(pc: RTCPeerConnection) {
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
