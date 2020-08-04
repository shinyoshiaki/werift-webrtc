# werift 

werift (**We**b**r**tc **I**mplementation **f**or **T**ypeScript)

werift is a WebRTC Implementation for TypeScript (Node.js)


| feature      | progress  |
| ------------ | --------- |
| DataChannel  | supported |
| MediaChannel | WIP       |

# install 
```npm install werift``` 

# examples 
https://github.com/shinyoshiaki/werift-webrtc/tree/master/examples 

# demo
run
```sh
yarn ts-node --files examples/datachannel/offer.ts
```
open
https://shinyoshiaki.github.io/werift-webrtc/examples/datachannel/answer

see console & chrome://webrtc-internals/

# components

- ICE  https://github.com/shinyoshiaki/werift-ice
- DTLS https://github.com/shinyoshiaki/werift-dtls
- SCTP https://github.com/shinyoshiaki/werift-sctp
- RTP,RTCP,SRTP,SRTCP https://github.com/shinyoshiaki/werift-rtp

# reference

- aiortc https://github.com/aiortc/aiortc 
- pion/webrtc https://github.com/pion/webrtc 
- etc ....
