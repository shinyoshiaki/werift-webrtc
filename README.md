# werift

werift (**We**b**r**tc **I**mplementation **f**or **T**ypeScript)

werift is a WebRTC Implementation for TypeScript (Node.js), includes ICE/DTLS/SCTP/RTP.

# install

`npm install werift`

requires at least Node.js 14

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
- [ ] getStats
- [ ] Media Engine
- [ ] TURN
  - [ ] TCP

# reference

- aiortc https://github.com/aiortc/aiortc
- pion/webrtc https://github.com/pion/webrtc
- etc ....
