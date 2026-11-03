import {
  Candidate,
  candidateFromIce,
  IceCandidate,
  RTCIceCandidate,
  type RTCIceCandidateFields,
  RTCPeerConnection,
} from "../../src";

/** Candidate a-lines shared by the RTCIceCandidate tests. */
export const candidates = {
  host: "1 1 udp 2130706431 192.168.1.10 50000 typ host",
  srflx:
    "2 1 udp 1694498815 203.0.113.5 61000 typ srflx raddr 192.168.1.10 rport 50000",
  relay:
    "3 2 udp 16777215 198.51.100.7 3478 typ relay raddr 203.0.113.5 rport 61000",
  tcp: "4 1 tcp 1518280447 192.168.1.10 9 typ host tcptype active generation 0 ufrag abcd",
};

export const allNull: RTCIceCandidateFields = {
  foundation: null,
  component: null,
  priority: null,
  address: null,
  protocol: null,
  port: null,
  type: null,
  tcpType: null,
  relatedAddress: null,
  relatedPort: null,
};

/** The paths that produce an RTCIceCandidate from a candidate a-line. */
export type CandidatePath =
  | "constructor"
  | "fromSdp"
  | "fromJSON"
  | "transport";

/**
 * Produce an RTCIceCandidate for `sdp` through `path`.
 * - `fromJSON`: `IceCandidate.fromJSON(init).toJSON()` (addIceCandidate path);
 *   `undefined` when the candidate is rejected.
 * - `transport`: the conversion `RTCIceTransport.getSelectedCandidatePair()` /
 *   `getLocalCandidates()` / `getRemoteCandidates()` apply to the ICE agent's
 *   candidates, fed with the ICE layer's own (lenient) parser.
 */
export function candidateVia(
  path: CandidatePath,
  sdp: string,
): RTCIceCandidate | undefined {
  switch (path) {
    case "constructor":
      return new RTCIceCandidate({ candidate: sdp, sdpMid: "0" });
    case "fromSdp":
      return RTCIceCandidate.fromSdp(sdp);
    case "fromJSON":
      return IceCandidate.fromJSON({ candidate: sdp, sdpMid: "0" })?.toJSON();
    case "transport":
      return candidateFromIce(
        Candidate.fromSdp(sdp.replace(/^candidate:/, "")),
      ).toJSON();
  }
}

/** Pick the parsed fields of a candidate for whole-object comparison. */
export function fieldsOf(candidate: RTCIceCandidate): RTCIceCandidateFields {
  return Object.fromEntries(
    Object.keys(allNull).map((key) => [
      key,
      candidate[key as keyof RTCIceCandidateFields],
    ]),
  ) as unknown as RTCIceCandidateFields;
}

/** A peer connection with a remote offer applied, ready for addIceCandidate. */
export async function peerWithRemoteOffer() {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();
  offerer.createDataChannel("probe");
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription!);
  return {
    answerer,
    close: () => Promise.all([offerer.close(), answerer.close()]),
  };
}
