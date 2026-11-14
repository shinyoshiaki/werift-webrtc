import type { Connection } from "../../../ice/src/ice";
import { getHostAddresses } from "../../../ice/src/utils";
import {
  createCodelessErrorServer,
  createErrorStunServer,
  createFirstPortOnlyStunServer,
  createRejectingUdpTurnServer,
  createScriptedUdpServer,
  errorResponse,
} from "../../../ice/tests/ice/candidateErrorUtils";
import { createSilentUdpServer } from "../../../ice/tests/utils";
import {
  RTCPeerConnection,
  type RTCPeerConnectionConfig,
  type RTCPeerConnectionIceErrorEvent,
} from "../../src";
import type { RTCIceTransport } from "../../src/transport/ice";

/**
 * Shared Arrange for the `icecandidateerror` tests
 * (iceCandidateError.test.ts).
 */

export const errorTestHost = getHostAddresses(true, false)[0]!;

export {
  createCodelessErrorServer,
  createErrorStunServer,
  createFirstPortOnlyStunServer,
  createRejectingUdpTurnServer,
  createScriptedUdpServer,
  createSilentUdpServer,
  errorResponse,
};

/** A remote peer with one IPv4 UDP host socket and no STUN / TURN server. */
export function createHostOnlyPeer() {
  return new RTCPeerConnection({
    iceUseIpv6: false,
    iceInterfaceAddresses: { udp4: errorTestHost },
    iceUseDefaultStunServer: false,
  });
}

/**
 * A peer connection with one IPv4 UDP host socket, no built-in STUN server
 * and `config`, recording every `icecandidateerror` it dispatches (through
 * `addEventListener`) and every one `onicecandidateerror` receives.
 */
export function createErrorRecordingPeer(
  config: Partial<RTCPeerConnectionConfig> = {},
) {
  const pc = new RTCPeerConnection({
    iceUseIpv6: false,
    iceInterfaceAddresses: { udp4: errorTestHost },
    iceUseDefaultStunServer: false,
    ...config,
  });
  const listened: RTCPeerConnectionIceErrorEvent[] = [];
  const handled: RTCPeerConnectionIceErrorEvent[] = [];
  pc.addEventListener("icecandidateerror", (event) => {
    listened.push(event as RTCPeerConnectionIceErrorEvent);
  });
  pc.onicecandidateerror = (event) => {
    handled.push(event);
  };
  return { pc, listened, handled };
}

/** Start gathering: an audio transceiver and a local offer (awaits gathering). */
export async function gatherWithOffer(pc: RTCPeerConnection) {
  pc.addTransceiver("audio");
  await pc.setLocalDescription(await pc.createOffer());
}

/** Event members of `events` as plain objects sorted by url, for comparison. */
export function errorSummaries(events: RTCPeerConnectionIceErrorEvent[]) {
  return events
    .map(({ url, errorCode, errorText, address, port }) => ({
      url,
      errorCode,
      errorText,
      address,
      port,
    }))
    .sort((a, b) => a.url.localeCompare(b.url));
}

/**
 * A recording peer with `bundlePolicy: "disable"` and an audio and a video
 * transceiver (two ICE transports), whose only STUN server never answers
 * (a 701 after `iceStunGatherTimeout`, 0.3 s).
 */
export async function createUnbundledUnreachablePeer() {
  return createUnbundledPeer(await createSilentUdpServer(errorTestHost));
}

/**
 * Like {@link createUnbundledUnreachablePeer}, but the STUN server answers
 * only the `answered`-th (0-based) socket that asks it: one transport
 * reaches it, one does not.
 */
export async function createUnbundledPartlyReachablePeer(answered = 0) {
  return createUnbundledPeer(await createFirstPortOnlyStunServer(answered));
}

async function createUnbundledPeer(silent: {
  address: readonly [string, number];
  close: () => Promise<void>;
}) {
  const url = `stun:${errorTestHost}:${silent.address[1]}`;
  const recording = createErrorRecordingPeer({
    bundlePolicy: "disable",
    iceServers: [{ urls: url }],
    iceStunGatherTimeout: 0.3,
  });
  recording.pc.addTransceiver("audio");
  recording.pc.addTransceiver("video");
  return { ...recording, url, silent };
}

/**
 * Resolves when `pc.iceGatheringState` is "complete" (an ICE restart's
 * gathering goes on after the negotiation that applied it).
 */
export async function gatheringComplete(pc: RTCPeerConnection) {
  while (pc.iceGatheringState !== "complete") {
    await pc.iceGatheringStateChange.asPromise();
  }
}

/** The port of the (single) UDP host candidate of `transport`. */
export function hostPortOf(transport: RTCIceTransport) {
  return transport.connection.localCandidates.find(
    (candidate) => candidate.type === "host",
  )?.port;
}

/**
 * Hold the gathering of `transport`: it enters "gathering" but queries no
 * server until the returned `release()`. A transport closed meanwhile
 * gathers nothing after the release.
 */
export function holdGathering(transport: RTCIceTransport) {
  const connection = transport.connection as Connection;
  const gatherCandidates = connection.gatherCandidates.bind(connection);
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(connection, "gatherCandidates").mockImplementation(async () => {
    await released;
    if (connection.state === "closed") return;
    return gatherCandidates();
  });
  return release;
}

/**
 * Make `transport` query no STUN / TURN server in its next gathering, as a
 * transport that gathers with another server configuration than the
 * others.
 */
export function useNoIceServers(transport: RTCIceTransport) {
  (transport.connection as Connection).setIceServers({
    stunServers: [],
    stunServerUrls: [],
    turnServers: [],
    useDefaultStunServer: false,
  });
}
