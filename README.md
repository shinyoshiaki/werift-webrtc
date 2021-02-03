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
https://shinyoshiaki.github.io/werift-webrtc/examples/mediachannel/sendrecv/answer

see console & chrome://webrtc-internals/

## DataChannel

run

```sh
yarn ts-node --files examples/datachannel/offer.ts
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
- [x] DataChannel
- [x] MediaChannel
  - [x] sendonly
  - [x] recvonly
  - [x] sendrecv
  - [x] multi track
- [x] RTP
- [ ] RTCP
  - [x] SR/RR
  - [x] Picture Loss Indication
  - [x] ReceiverEstimatedMaxBitrate
  - [x] GenericNack
  - [ ] TransportWideCC
- [x] SDP
- [x] PeerConnection
- [x] Simulcast
  - [x] recv
- [ ] BWE
  - [ ] sender side BWE
- [ ] Documentation

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
