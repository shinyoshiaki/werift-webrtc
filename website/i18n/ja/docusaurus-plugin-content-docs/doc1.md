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
コア API はコーデックや OS のカメラ取得を持ちません。ブラウザ向けライブラリを Node で動かす場合は `werift/polyfill` の `installPolyfill({ mediaRegister })` でグローバルと `navigator.mediaDevices.getUserMedia` を差し込み、ファイル / RTP / エンコード済みバイナリ / ユーザ定義 register からメディアを供給します。RTP を `MediaStreamTrack.writeRtp` へ直接渡す経路も従来どおり使えます。非標準の `getUserMedia({ path })` は削除されました。DOM なしの TypeScript は `werift/polyfill` がコンストラクタグローバルを型付けし、`lib.dom` を使う場合は `werift/polyfill/dom` を import します。

Node.js では polyfill のインストールだけで `mediasoup-client` に `handlerName` / `handlerFactory` を渡さず使えます。既存の User-Agent が未設定または `Node.js/<major>` のときだけ Chromium 111 互換値を補完し、非 Node の値は保持します。上書きしたい場合だけ `userAgent` オプションを渡します。uninstall でインストール前の descriptor に戻ります。「追加設定なし」は Handler 自動選択を指し、`mediaRegister` とシグナリングは引き続き必要です。

```ts
import { Device } from "mediasoup-client";
import {
  createCallbackRegister,
  installPolyfill,
} from "werift/polyfill";

const uninstall = installPolyfill({
  // 任意。省略時は Node で Chrome111 互換値が自動設定される。
  // userAgent: "Mozilla/5.0 ... Chrome/120.0.0.0 Safari/537.36",
  mediaRegister: [
    createCallbackRegister({
      mimeType: "audio/opus",
      kinds: ["audio"],
      async createTracks() {
        return [createAudioTrack()];
      },
    }),
  ],
});

const device = await Device.factory();
await device.load({ routerRtpCapabilities });
```

明示 `userAgent` は実ブラウザの値も上書きし、Handler 判定を変えることがあります。`existingMediaDevices: "noop"` でも欠けている / Node の User-Agent は補完します。

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
