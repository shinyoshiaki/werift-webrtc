---
id: doc1
title: How to use
sidebar_label: How to use
slug: /
---

# インストール方法

```sh
npm install werift
```

# 設計思想

werift は DataChannel と MediaChannel に対応しています。
werift はコーデックなどのメディア周りは実装していないので getUserMedia などの API は利用できません。そのため、werift からメディアを送信する場合は、RTP パケットを直接、用意された API に入力します。また受信する場合には RTP のパケットを直接受け取ることができます。

# ドキュメント

## RTCPeerConnection

### コンストラクタ

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

利用するコーデックを指定します。
werift はコーデックなどのメディアの実装は行われていないので、ここでは対向のデバイスが対応している任意のコーデックを入力します。

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

利用する headerExtensions を指定します。
werift が対応している headerExtensions は以下です。

```typescript
const RTP_EXTENSION_URI = {
  sdesMid: "urn:ietf:params:rtp-hdrext:sdes:mid",
  sdesRTPStreamID: "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id",
  transportWideCC:
    "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
  absSendTime: "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
};
```

##### 指定方法

```typescript
const pc = new RTCPeerConnection({
  headerExtensions: {
    video: [useSdesRTPStreamID(), useAbsSendTime(), useTransportWideCC()],
  },
});
```

サイマルキャスト機能を利用する場合は必ず`useSdesRTPStreamID()`を指定する必要があります。

#### iceConfig

ice の設定を指定します。
werift は STUN と TURN-UDP に対応しています。

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

### シグナリング

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
