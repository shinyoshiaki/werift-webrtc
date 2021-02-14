# werift

werift (**We**b**r**tc **I**mplementation **f**or **T**ypeScript)

werift is a WebRTC Implementation for TypeScript (Node.js)

# install

`npm install werift`

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
- [ ] DTLS
  - [x] DTLS-SRTP
  - [x] Curve25519
  - [ ] P-256
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
- [ ] Compatibility
  - [x] Chrome
  - [x] FireFox
  - [ ] Pion
  - [ ] aiortc
  - [ ] sipsorcery
- [ ] Interop E2E test
  - [x] Chrome
  - [ ] etc....
  
## Road Map Towards 2.0

- [ ] API compatible with browser RTCPeerConnection
- [ ] SDP
  - [ ] reuse inactive m-line
- [ ] Simulcast
  - [ ] send
- [ ] support more cipher suites

# reference

- aiortc https://github.com/aiortc/aiortc
- pion/webrtc https://github.com/pion/webrtc
- etc ....
