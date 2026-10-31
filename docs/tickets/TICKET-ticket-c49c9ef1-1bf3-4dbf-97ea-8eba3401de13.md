Found while fixing ticket 340fdd75 (DCEP unordered channel types).

- packages/webrtc/src/transport/sctp.ts dataChannelFlush(): expiry = Date.now() + maxPacketLifeTime / 1000 (ms + seconds mixed)
- packages/sctp/src/sctp.ts (~L1333): chunk.expiry < Date.now() / 1000 compares in seconds
- packages/webrtc/src/dataChannel.ts RTCDataChannelParameters.maxPacketLifeTime comment says '// sec', but the WebRTC spec / RFC 8832 value is milliseconds

Expected: maxPacketLifeTime (ms) abandons chunks after that many ms, with the units consistent end to end. Add a test that a lifetime-limited chunk is abandoned (FORWARD-TSN) after the lifetime.