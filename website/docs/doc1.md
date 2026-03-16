---
id: doc1
title: How to use
sidebar_label: How to use
slug: /
---

# Installation Method

```sh
npm install werift
```

# Design Philosophy

Werift supports DataChannel and MediaChannel.
Werift does not implement media-related features such as codecs, so APIs like getUserMedia cannot be used. Therefore, to send media from werift, you need to directly input RTP packets into the provided API. Similarly, when receiving media, you can directly receive RTP packets.

# Documentation

## RTCPeerConnection

### Constructor

```typescript
new RTCPeerConnection(config?: Partial<PeerConfig>): RTCPeerConnection

export type PeerConfig = {
  privateKey?: string;
  certificate?: string;
  codecs: Partial<{
    audio: RTCRtpCodecParameters[];
    video: RTCRtpCodecParameters[];
  }>;
  headerExtensions: Partial<{
    audio: RTCRtpHeaderExtensionParameters[];
    video: RTCRtpHeaderExtensionParameters[];
  }>;
  iceConfig: Partial<IceOptions>;
};
```

#### codecs

Specify the codecs to be used.
Werift does not implement media-related features such as codecs, so you can input any codecs supported by the peer device here.

```typescript
const pc = new RTCPeerConnection({
  codecs: {
    audio: [
      new RTCRtpCodecParameters({
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
      }),
      new RTCRtpCodecParameters({
        mimeType: "audio/PCMU",
        clockRate: 8000,
        channels: 1,
      }),
    ],
    video: [
      new RTCRtpCodecParameters({
        mimeType: "video/VP8",
        clockRate: 90000,
        rtcpFeedback: [
          { type: "ccm", parameter: "fir" },
          { type: "nack" },
          { type: "nack", parameter: "pli" },
          { type: "goog-remb" },
        ],
      }),
    ],
  },
});
```

#### headerExtensions

Specify the header extensions to be used.
The header extensions supported by werift are as follows:

```typescript
const RTP_EXTENSION_URI = {
  sdesMid: "urn:ietf:params:rtp-hdrext:sdes:mid",
  sdesRTPStreamID: "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id",
  transportWideCC:
    "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
  absSendTime: "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
};
```

##### Specification Method

```typescript
const pc = new RTCPeerConnection({
  headerExtensions: {
    video: [useSdesRTPStreamID(), useAbsSendTime(), useTransportWideCC()],
  },
});
```

If you want to use the simulcast feature, you must specify `useSdesRTPStreamID()`.

#### iceConfig

Specify the ICE configuration.
Werift supports STUN and TURN-UDP.

```typescript
const pc = new RTCPeerConnection({
  iceConfig: { stunServer: ["stun.l.google.com", 19302] },
});

type IceConfig = {
  stunServer?: [string, number];
  turnServer?: [string, number];
  turnUsername?: string;
  turnPassword?: string;
  forceTurn?: boolean;
};
```

### Signaling

#### Vanilla Ice

```typescript
const pcA = new RTCPeerConnection({});
pcA.createDataChannel("chat");
await pcA.setLocalDescription(pcA.createOffer());

const pcB = new RTCPeerConnection({});
await pcB.setRemoteDescription(pcA.localDescription);
await pcB.setLocalDescription(pcB.createAnswer());

await pcA.setRemoteDescription(pcB.localDescription);
```

#### Trickle Ice

```typescript
const pcA = new RTCPeerConnection({});
const pcB = new RTCPeerConnection({});

pcA.onIceCandidate.subscribe((candidate) => {
  pcB.addIceCandidate(candidate.toJSON());
});
pcB.onIceCandidate.subscribe((candidate) => {
  pcA.addIceCandidate(candidate.toJSON());
});

pcA.createDataChannel("chat");
await pcA.setLocalDescription(pcA.createOffer());

await pcB.setRemoteDescription(pcA.localDescription);
await pcB.setLocalDescription(pcB.createAnswer());

await pcA.setRemoteDescription(pcB.localDescription);
```

### MediaChannel

### DataChannel
