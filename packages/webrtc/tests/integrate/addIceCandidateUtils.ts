import type { RTCPeerConnection } from "../../src";

/**
 * Shared Arrange for addIceCandidate routing tests: a remote offer with two
 * m-lines (`a1` / `v1`) whose ICE ufrags differ, in a BUNDLE group or not,
 * Pion-shaped candidates (`sdpMid: ""` + `sdpMLineIndex`, as Pion's
 * `ICECandidate.ToJSON()` sends them) and helpers telling which m-line /
 * ICE transport a candidate reached.
 */
export const addIceCandidateMediaLine1 = "m=audio";
export const addIceCandidateMediaLine2 = "m=video";
export const addIceCandidateSdpMid1 = "a1";
export const addIceCandidateSdpMLineIndex1 = 0;
export const addIceCandidateSdpMid2 = "v1";
export const addIceCandidateSdpMLineIndex2 = 1;
export const addIceCandidateUsernameFragment1 = "ETEn";
export const addIceCandidateUsernameFragment2 = "BGKk";
export const addIceCandidateLine1 =
  "candidate:1 1 udp 2113929471 203.0.113.100 10100 typ host";
export const addIceCandidateLine2 =
  "candidate:1 2 udp 2113929470 203.0.113.100 10101 typ host";
export const addIceCandidateEndOfCandidatesLine = "a=end-of-candidates";
export const addIceCandidateWptSdp = `v=0
o=- 4962303333179871722 1 IN IP4 0.0.0.0
s=-
t=0 0
a=ice-options:trickle
a=group:BUNDLE a1 v1
a=group:LS a1 v1
m=audio 10100 UDP/TLS/RTP/SAVPF 96 0 8 97 98
c=IN IP4 203.0.113.100
a=mid:a1
a=sendrecv
a=rtpmap:96 opus/48000/2
a=rtpmap:0 PCMU/8000
a=rtpmap:8 PCMA/8000
a=rtpmap:97 telephone-event/8000
a=rtpmap:98 telephone-event/48000
a=maxptime:120
a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid
a=extmap:2 urn:ietf:params:rtp-hdrext:ssrc-audio-level
a=msid:47017fee-b6c1-4162-929c-a25110252400 f83006c5-a0ff-4e0a-9ed9-d3e6747be7d9
a=ice-ufrag:ETEn
a=ice-pwd:OtSK0WpNtpUjkY4+86js7ZQl
a=fingerprint:sha-256 19:E2:1C:3B:4B:9F:81:E6:B8:5C:F4:A5:A8:D8:73:04:BB:05:2F:70:9F:04:A9:0E:05:E9:26:33:E8:70:88:A2
a=setup:actpass
a=dtls-id:1
a=rtcp:10101 IN IP4 203.0.113.100
a=rtcp-mux
a=rtcp-rsize
m=video 10102 UDP/TLS/RTP/SAVPF 100 101
c=IN IP4 203.0.113.100
a=mid:v1
a=sendrecv
a=rtpmap:100 VP8/90000
a=rtpmap:101 rtx/90000
a=fmtp:101 apt=100
a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid
a=rtcp-fb:100 ccm fir
a=rtcp-fb:100 nack
a=rtcp-fb:100 nack pli
a=msid:47017fee-b6c1-4162-929c-a25110252400 f30bdb4a-5db8-49b5-bcdc-e0c9a23172e0
a=ice-ufrag:BGKk
a=ice-pwd:mqyWsAjvtKwTGnvhPztQ9mIf
a=fingerprint:sha-256 19:E2:1C:3B:4B:9F:81:E6:B8:5C:F4:A5:A8:D8:73:04:BB:05:2F:70:9F:04:A9:0E:05:E9:26:33:E8:70:88:A2
a=setup:actpass
a=dtls-id:1
a=rtcp:10103 IN IP4 203.0.113.100
a=rtcp-mux
a=rtcp-rsize
`;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isCandidateLineBetween(
  sdp: string,
  beforeMediaLine: string,
  candidateLine: string,
  afterMediaLine: string,
) {
  const line1 = escapeRegExp(beforeMediaLine);
  const line2 = escapeRegExp(candidateLine);
  const line3 = escapeRegExp(afterMediaLine);
  return new RegExp(`${line1}[^]+${line2}[^]+${line3}`).test(sdp);
}

export function isCandidateLineAfter(
  sdp: string,
  beforeMediaLine: string,
  candidateLine: string,
) {
  const line1 = escapeRegExp(beforeMediaLine);
  const line2 = escapeRegExp(candidateLine);
  return new RegExp(`${line1}[^]+${line2}`).test(sdp);
}

/** The same offer without `a=group:BUNDLE`: each m-line gets its own transport. */
export const addIceCandidateNonBundleSdp = addIceCandidateWptSdp
  .split("\n")
  .filter((line) => !line.startsWith("a=group:"))
  .join("\n");

/** An RTP (component 1) host candidate with a distinct port per test. */
export function pionCandidateLine(port: number) {
  return `candidate:7 1 udp 2130706431 198.51.100.7 ${port} typ host`;
}

/** A candidate as Pion sends it: an empty `sdpMid` and an m-line index. */
export function pionCandidate(
  sdpMLineIndex: number | undefined,
  port: number,
  extra: { usernameFragment?: string } = {},
) {
  return {
    candidate: pionCandidateLine(port),
    sdpMid: "",
    sdpMLineIndex,
    ...extra,
  };
}

/** Indices of the m-sections of `sdp` that contain `line`. */
export function mediaSectionsWithLine(sdp: string, line: string) {
  return sdp
    .split(/\r?\n(?=m=)/)
    .slice(1)
    .flatMap((section, index) =>
      section.split(/\r?\n/).includes(line) ? [index] : [],
    );
}

/** Ports of the remote candidates the ICE transport of each m-line received. */
export function remoteCandidatePortsByMLine(pc: RTCPeerConnection) {
  return pc
    .getTransceivers()
    .map((transceiver) =>
      transceiver.dtlsTransport.iceTransport.connection.remoteCandidates.map(
        (candidate) => candidate.port,
      ),
    );
}

/** Whether two m-lines share one ICE transport (BUNDLE). */
export function sharesIceTransport(pc: RTCPeerConnection) {
  const [first, second] = pc.getTransceivers();
  return first.dtlsTransport.iceTransport === second.dtlsTransport.iceTransport;
}
