import { MediaStreamTrack, RTCPeerConnection } from "../../src";

const answer = `v=0
o=- 0 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0 2 1
a=msid-semantic: WMS 13945094204333313074/3212739396 virtual-6666
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
a=ice-ufrag:KFPTBCP4YKPZTY1Q
a=ice-pwd:VA0L9MQMWS8IYO9NJF+ITE++
a=fingerprint:sha-256 92:D6:06:D6:CB:64:B4:EF:47:76:00:F7:48:E0:ED:DD:9F:3E:DA:16:41:49:47:43:E0:77:DD:C6:D7:83:7E:19
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
a=ice-ufrag:KFPTBCP4YKPZTY1Q
a=ice-pwd:VA0L9MQMWS8IYO9NJF+ITE++
a=fingerprint:sha-256 92:D6:06:D6:CB:64:B4:EF:47:76:00:F7:48:E0:ED:DD:9F:3E:DA:16:41:49:47:43:E0:77:DD:C6:D7:83:7E:19
a=setup:passive
a=mid:1
a=sendrecv
a=msid:13945094204333313074/3212739396 13945094204333313074/3212739396
a=rtcp-mux
a=rtpmap:97 VP8/90000
a=rtcp-fb:97 ccm fir
a=rtcp-fb:97 nack
a=rtcp-fb:97 nack pli
a=rtcp-fb:97 goog-remb
a=ssrc:3212739396 cname:3212739396
m=application 9 DTLS/SCTP 5000
c=IN IP4 0.0.0.0
a=ice-ufrag:KFPTBCP4YKPZTY1Q
a=ice-pwd:VA0L9MQMWS8IYO9NJF+ITE++
a=fingerprint:sha-256 92:D6:06:D6:CB:64:B4:EF:47:76:00:F7:48:E0:ED:DD:9F:3E:DA:16:41:49:47:43:E0:77:DD:C6:D7:83:7E:19
a=setup:passive
a=mid:2
a=sctpmap:5000 webrtc-datachannel 1024
`;

test(`https://github.com/shinyoshiaki/werift-webrtc/issues/142`, async () => {
  const pc = new RTCPeerConnection();
  const audio = new MediaStreamTrack({ kind: "audio" });
  const video = new MediaStreamTrack({ kind: "video" });
  pc.addTrack(audio);
  pc.addTrack(video);
  pc.createDataChannel("dc");
  await pc.setLocalDescription(await pc.createOffer());

  await pc.setRemoteDescription({ type: "answer", sdp: answer });
  expect(pc.sctpRemotePort).toBe(5000);
  await pc.close();
});
