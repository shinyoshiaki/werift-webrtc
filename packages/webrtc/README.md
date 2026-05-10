# werift

werift (**We**b**r**tc **I**mplementation **f**or **T**ypeScript)

werift is a WebRTC Implementation for TypeScript (Node.js)

# install

`npm install werift`

# Documentation (WIP)

- [Website](https://shinyoshiaki.github.io/werift-webrtc/website/build/)
- [API Reference](https://shinyoshiaki.github.io/werift-webrtc/website/build/docs/api)

# examples

https://github.com/shinyoshiaki/werift-webrtc/tree/master/examples

### SFU

https://github.com/shinyoshiaki/node-sfu

# demo

## MediaChannel

```sh
yarn media
```

open
https://shinyoshiaki.github.io/werift-webrtc/examples/mediachannel/pubsub/answer

see console & chrome://webrtc-internals/

## DataChannel

run

```sh
yarn datachannel
```

open
https://shinyoshiaki.github.io/werift-webrtc/examples/datachannel/answer

see console & chrome://webrtc-internals/

# RoadMap

## Work in Progress Towards 1.0

- [x] STUN
- [x] TURN
  - [x] UDP
- [x] ICE
  - [x] Vanilla ICE
  - [x] Trickle ICE
- [x] DTLS
  - [x] DTLS-SRTP
  - [x] Curve25519
  - [x] P-256
- [x] DataChannel
- [x] MediaChannel
  - [x] sendonly
  - [x] recvonly
  - [x] sendrecv
  - [x] multi track
- [x] RTP
- [x] RTCP
  - [x] SR/RR
  - [x] Picture Loss Indication
  - [x] ReceiverEstimatedMaxBitrate
  - [x] GenericNack
  - [x] TransportWideCC
- [x] SRTP
- [x] SRTCP
- [x] SDP
- [x] PeerConnection
- [x] Simulcast
  - [x] recv
- [x] BWE
  - [x] sender side BWE
- [ ] Documentation
- [x] Compatibility
  - [x] Chrome
  - [x] FireFox
  - [x] Pion
  - [x] aiortc
  - [x] sipsorcery
- [x] Interop E2E test
  - [x] Chrome
  - ↓↓↓ https://github.com/sipsorcery/webrtc-echoes
  - [x] Pion
  - [x] aiortc
  - [x] sipsorcery
- [ ] Unit Tests
  - [ ] follow [Web Platform Tests](https://github.com/web-platform-tests/wpt)

## Road Map Towards 2.0

- [ ] API compatible with browser RTCPeerConnection
- [ ] ICE
  - [ ] ICE restart
- [ ] SDP
  - [ ] reuse inactive m-line
- [ ] Simulcast
  - [ ] send
- [ ] support more cipher suites

## RTCPeerConnection W3C compatibility notes

| Status | API | Notes |
| --- | --- | --- |
| Added | `currentLocalDescription`, `pendingLocalDescription`, `currentRemoteDescription`, `pendingRemoteDescription`, `canTrickleIceCandidates`, `sctp` | Public getters now follow W3C-style pending/current description visibility and expose SCTP/canTrickle state. |
| Added | `setLocalDescription()` input compatibility | Accepts omitted `type`, empty `sdp`, and provisional `pranswer`. |
| Added | `setRemoteDescription()` input compatibility | Accepts `pranswer` and `rollback`, updating pending/current descriptions accordingly. |
| Added | `addIceCandidate()` input compatibility | Accepts omitted input and `{ candidate: "" }` as end-of-candidates. |
| Added | `RTCConfiguration` compatibility | Accepts `iceServers`, `iceTransportPolicy`, `bundlePolicy`, `rtcpMuxPolicy: "require"`, `iceCandidatePoolSize: 0`, and `certificates`; `setConfiguration(getConfiguration())` round-trips without changing certificates. |
| Added | `RTCIceServer.urls: string \| string[]` | Arrays are accepted and parsed in order. |
| Added | Standard event names | `signalingstatechange`, `iceconnectionstatechange`, `icegatheringstatechange`, `connectionstatechange`, `negotiationneeded`, `icecandidate`, `track`, and `datachannel` are emitted for `addEventListener`. |
| Not implemented | Legacy callback overloads | Kept out of scope because they are legacy browser APIs. |
| Not implemented | `addStream`, `removeStream`, `createDTMFSender` | These are obsolete; use `addTrack`, `removeTrack`, and transceiver/sender APIs instead. |
| Deferred | `close()` return type | Remains async for backward compatibility even though W3C defines synchronous `undefined`. |
| Deferred | `setLocalDescription()` / `setRemoteDescription()` return type | They still return the applied `SessionDescription` instead of `Promise<void>` for backward compatibility. |
| Deferred | `RTCPeerConnection.generateCertificate()` | `RTCCertificate` and `RTCConfiguration.certificates` are supported, but the static W3C helper is still optional work. |

# reference

- aiortc https://github.com/aiortc/aiortc
- pion/webrtc https://github.com/pion/webrtc
- etc ....
