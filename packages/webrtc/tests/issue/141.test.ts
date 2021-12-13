import { RTCPeerConnection } from "../../src";

const offer = `v=0
o=- 0 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0 2 1
a=msid-semantic: WMS 17156406933747196835/3212739396 virtual-6666
a=ice-lite
m=audio 19305 UDP/TLS/RTP/SAVPF 96
c=IN IP4 <redacted>
a=rtcp:9 IN IP4 0.0.0.0
a=candidate: 1 udp 2113939711 2607:f8b0:400e:c03::7f 19305 typ host generation 0
a=candidate: 1 tcp 2113939710 2607:f8b0:400e:c03::7f 19305 typ host tcptype passive generation 0
a=candidate: 1 ssltcp 2113939709 2607:f8b0:400e:c03::7f 443 typ host generation 0
a=candidate: 1 udp 2113932031 74.125.197.127 19305 typ host generation 0
a=candidate: 1 tcp 2113932030 74.125.197.127 19305 typ host tcptype passive generation 0
a=candidate: 1 ssltcp 2113932029 74.125.197.127 443 typ host generation 0
a=ice-ufrag:ZYYVZ8WXE65U5BKY
a=ice-pwd:TII1ZWXJ56MILBHWDVZTELNA
a=fingerprint:sha-256 F3:67:F7:32:B9:1D:E5:41:F2:DF:1B:05:89:5E:5C:8D:A3:B3:23:16:97:2D:EF:89:C9:BA:23:63:E1:27:04:86
a=setup:passive
a=mid:0
a=sendrecv
a=msid:virtual-6666 virtual-6666
a=rtcp-mux
a=rtpmap:96 opus/48000/2
a=fmtp:96 minptime=10;useinbandfec=1
a=ssrc:6666 cname:6666
m=video 9 UDP/TLS/RTP/SAVPF 97
c=IN IP4 0.0.0.0
a=rtcp:9 IN IP4 0.0.0.0
a=ice-ufrag:ZYYVZ8WXE65U5BKY
a=ice-pwd:TII1ZWXJ56MILBHWDVZTELNA
a=fingerprint:sha-256 F3:67:F7:32:B9:1D:E5:41:F2:DF:1B:05:89:5E:5C:8D:A3:B3:23:16:97:2D:EF:89:C9:BA:23:63:E1:27:04:86
a=setup:passive
a=mid:1
a=sendrecv
a=msid:17156406933747196835/3212739396 17156406933747196835/3212739396
a=rtcp-mux
a=rtpmap:97 VP8/90000
a=rtcp-fb:97 ccm fir
a=rtcp-fb:97 nack
a=rtcp-fb:97 nack pli
a=rtcp-fb:97 goog-remb
a=ssrc:3212739396 cname:3212739396
m=application 9 DTLS/SCTP 5000
c=IN IP4 0.0.0.0
a=ice-ufrag:ZYYVZ8WXE65U5BKY
a=ice-pwd:TII1ZWXJ56MILBHWDVZTELNA
a=fingerprint:sha-256 F3:67:F7:32:B9:1D:E5:41:F2:DF:1B:05:89:5E:5C:8D:A3:B3:23:16:97:2D:EF:89:C9:BA:23:63:E1:27:04:86
a=setup:passive
a=mid:2
a=sctpmap:5000 webrtc-datachannel 1024
`;

test("https://github.com/shinyoshiaki/werift-webrtc/issues/141", async () => {
  const pc = new RTCPeerConnection();
  await pc.setRemoteDescription({ type: "offer", sdp: offer });
  await pc.close();
});
