import { getHostAddresses } from "../../../ice/src/utils";
import {
  createErrorStunServer,
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

/**
 * Shared Arrange for the `icecandidateerror` tests
 * (iceCandidateError.test.ts).
 */

export const errorTestHost = getHostAddresses(true, false)[0]!;

export {
  createErrorStunServer,
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
  const silent = await createSilentUdpServer(errorTestHost);
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
