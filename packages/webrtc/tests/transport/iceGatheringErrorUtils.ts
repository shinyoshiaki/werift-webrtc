import {
  stubNetworkInterfaces,
  trackUncaught,
} from "../../../ice/tests/ice/interfaceEnumerationUtils";
import { createFixedMappingStunServer } from "../../../ice/tests/utils";
import {
  type IceGatheringErrorDetails,
  type RTCIceCandidate,
  type RTCIceGatheringErrorEvent,
  type RTCIceTransport,
  RTCPeerConnection,
  type RTCPeerConnectionConfig,
  type RTCPeerConnectionIceErrorEvent,
} from "../../src";

/**
 * Shared Arrange for the gathering error tests (iceGatheringError.test.ts):
 * `os.networkInterfaces()` is stubbed for werift and multicast-dns alike
 * (see the ICE package's interfaceEnumerationUtils.ts).
 */
export { createFixedMappingStunServer, stubNetworkInterfaces, trackUncaught };

/**
 * An IPv4-only peer connection without the built-in STUN server, recording
 * `onIceGatheringError`, every `icecandidateerror` (through all three paths)
 * and every `onIceCandidate` (undefined is end-of-candidates).
 */
export function createGatheringRecordingPeer(
  config: Partial<RTCPeerConnectionConfig> = {},
) {
  const pc = new RTCPeerConnection({
    iceUseIpv6: false,
    iceServers: [],
    iceUseDefaultStunServer: false,
    ...config,
  });
  const gatheringErrors: RTCIceGatheringErrorEvent[] = [];
  pc.onIceGatheringError.subscribe((event) => gatheringErrors.push(event));
  const candidateErrors: RTCPeerConnectionIceErrorEvent[] = [];
  pc.onIceCandidateError.subscribe((event) => candidateErrors.push(event));
  pc.onicecandidateerror = (event) => candidateErrors.push(event);
  pc.addEventListener("icecandidateerror", (event) =>
    candidateErrors.push(event as RTCPeerConnectionIceErrorEvent),
  );
  const candidates: (RTCIceCandidate | undefined)[] = [];
  pc.onIceCandidate.subscribe((candidate) => candidates.push(candidate));
  return { pc, gatheringErrors, candidateErrors, candidates };
}

/** Every `onGatheringError` of `transport`, in order. */
export function recordTransportGatheringErrors(transport: RTCIceTransport) {
  const errors: IceGatheringErrorDetails[] = [];
  transport.onGatheringError.subscribe((details) => errors.push(details));
  return errors;
}

/** The reasons of `events`, in order. */
export const reasonsOf = (events: { reason: string }[]) =>
  events.map(({ reason }) => reason);

/**
 * Resolves when `pc.iceGatheringState` is "complete" (end-of-candidates of a
 * server query may follow setLocalDescription).
 */
export async function gatheringComplete(pc: RTCPeerConnection) {
  while (pc.iceGatheringState !== "complete") {
    await pc.iceGatheringStateChange.asPromise();
  }
}

/** Apply a local offer with an audio transceiver and wait for the gathering. */
export async function offerAndGather(pc: RTCPeerConnection) {
  if (pc.getTransceivers().length === 0) pc.addTransceiver("audio");
  await pc.setLocalDescription(await pc.createOffer());
  await gatheringComplete(pc);
}
