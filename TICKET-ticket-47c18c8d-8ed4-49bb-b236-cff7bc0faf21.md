# ポリフィルインストーラーのレジスター無指定時にメディアデバイス取得を可能にし、プレーンな空トラックを返す

## 1. 目的と背景

`werift/polyfill` の `installPolyfill()` は、ブラウザ向けライブラリを Node.js 上で動かすためのオプトインアダプタである。インストール時に `navigator.mediaDevices.getUserMedia` を差し込み、アプリケーションが渡した `mediaRegister` から `MediaStreamTrack` を供給する。

現状の契約は次のとおりである。

- `InstallPolyfillOptions.mediaRegister` は必須。省略・`undefined` は `TypeError: mediaRegister is required`。
- 空配列 `mediaRegister: []` はインストール自体は成功するが、`getUserMedia({ video: true })` などは `NotFoundError`、空制約 `{}` は `TypeError`。
- 実メディアが要らない場合でも、呼び出し側は空配列か `createDummyRegister()` を明示する必要がある。
- `createDummyRegister()` は VP8 / ダミー音声の **定期 RTP を生成する** テスト用ソースであり、「トラックオブジェクトだけ欲しい」用途とは違う。

本タスクの目的は、**レジスターを指定しなくても** `getUserMedia` でメディアデバイス取得ができるようにし、その場合は **ダミー RTP も codec 付与もないプレーンな空 `MediaStreamTrack`** を返すことである。ブラウザライブラリが `getUserMedia` → `addTrack` するだけでトランシーバを立てたい、あとから `writeRtp` したい、recvonly に近いローカルトラックが欲しい、といった用途を、ダミーメディアなしで満たす。

「追加設定なし」で mediasoup-client の Handler 自動選択が通る、という既存の User-Agent 補完とは別レイヤである。今回は **メディアレジスター省略時の GUM 経路** を扱う。

## 2. 実装すべき具体的な機能・変更内容

### 2.1 API

- `InstallPolyfillOptions.mediaRegister` を任意にする（`mediaRegister?: MediaRegister[]`）。
- `installPolyfill()` の引数自体も省略可能にする（`options: InstallPolyfillOptions = {}`）。`null` / 非オブジェクトは現行どおり `TypeError`。
- 非配列の `mediaRegister`（オブジェクトなど）は現行どおり `TypeError: mediaRegister must be an array`。

省略とみなす入力:

- `installPolyfill()`
- `installPolyfill({})`
- `installPolyfill({ mediaRegister: undefined, ...他オプション })`

これらでは `navigator.mediaDevices` が入り、`getUserMedia({ audio: true })` / `{ video: true }` / 両方で解決する。

### 2.2 省略時のトラック

要求 kind ごとに `new MediaStreamTrack({ kind })` 相当のトラックを 1 本返す。

| 項目 | 期待 |
| --- | --- |
| `kind` | 要求どおり `audio` / `video` |
| `readyState` | `"live"` |
| `muted` | `true`（RTP 未流入の現行デフォルト） |
| `codec` | 未設定。`createCallbackRegister` 経由の mimeType → codec 付与をしない |
| RTP | 送出しない。`createDummyRegister` / `dummyMedia.ts` のタイマーソースを使わない |
| 後からの注入 | 既存の `track.writeRtp` はそのまま使える |

空制約 `getUserMedia({})` は仕様どおり `TypeError` のまま（audio / video のいずれか必須）。

`getDisplayMedia` は現行どおり `getUserMedia` のエイリアスなので、省略時デフォルトも同じ空トラック経路になる。

### 2.3 空配列との区別（推奨）

`mediaRegister: []` は **明示的にデバイスなし** として現行挙動を維持する。

- グローバル（`RTCPeerConnection` 等）は入る
- `getUserMedia({ video: true })` は `NotFoundError`
- ドキュメントの「空配列は globals のみ」を壊さない

省略（無指定）だけが空トラック供給。空配列まで同じにするかは未確定事項（後述）。実装の既定方針は「空配列は現状維持」。

### 2.4 実装の置き場所

推奨は組み込み register を 1 つ用意し、省略時だけ `bindRegisters` に渡す。

- 新規: `packages/webrtc/src/polyfill/registers/empty.ts`（名前は既存 `callback.ts` / `dummy` に合わせてよい）
- `kinds: ["audio", "video"]` の単一 register（`createDummyRegister` と同じ列挙モデル。同一 `deviceId` で `audioinput` + `videoinput`）
- `createTracks` は `request.kind` に応じたプレーン `MediaStreamTrack` を返すだけ。codec を触らない
- `mimeType` は `MediaRegister` 契約上必須。選択・列挙用のプレースホルダでよい（例: dummy と同様 `video/VP8`）。**トラックへ codec をコピーしない**ことがプレーン空の条件
- `createCallbackRegister` は kind 一致時に codec を付けるため、空トラック工場の実装に使わない

公開 factory（推奨）:

- `createEmptyRegister(options?: MediaRegisterCommonOptions): MediaRegister`
- `packages/webrtc/src/polyfill/api.ts` から re-export
- 省略時デフォルトは内部でこの factory を使う。テストや「明示的に空トラックだけ登録したい」用途にも使える

`install.ts` の変更方針:

```ts
const registers = options.mediaRegister ?? [createEmptyRegister()];
```

`mediaRegister` キー欠如と `undefined` の両方を `??` で拾う。空配列は `??` を通らないので現状の NotFound 経路が残る。

現行の必須チェック:

```50:55:packages/webrtc/src/polyfill/install.ts
  if (!("mediaRegister" in options) || options.mediaRegister == undefined) {
    throw new TypeError("mediaRegister is required");
  }
  if (!Array.isArray(options.mediaRegister)) {
    throw new TypeError("mediaRegister must be an array");
  }
```

省略を許したうえで、値が来たときだけ `Array.isArray` を見る。

### 2.5 テスト

主対象: `packages/webrtc/tests/nonstandard/polyfill.test.ts`

- 現行 `rejects missing or non-array mediaRegister` を分割する
  - 非配列は引き続き throw
  - 省略 / `{}` / `undefined` は throw しない
- 省略時:
  - `getUserMedia({ video: true })` が 1 本の video track を返す
  - audio も同様
  - `{ audio: true, video: true }` で両 kind
  - `enumerateDevices()` に audioinput / videoinput が出る
  - track は `MediaStreamTrack`、`readyState === "live"`、`muted === true`、`codec == undefined`
  - 一定時間待っても `onReceiveRtp` が発火しない（dummy との回帰防止）
- `mediaRegister: []` は現行テストを維持（PeerConnection 可、GUM は NotFound / TypeError）
- 明示 `createDummyRegister` やファイル / RTP register の挙動は変えない
- `polyfillNodeCompile/consumer.ts` は `installPolyfill()` または `installPolyfill({})` でも型が通ることを確認してよい

Act / Assert には日本語コメントを付ける（`packages/webrtc/AGENTS.md`）。

### 2.6 ドキュメント

公開 API・プロトコル挙動の変更なので、実装と同時に更新する。

| ファイル | 内容 |
| --- | --- |
| `docs/polyfill/README.md` | 「`mediaRegister` は必須」「空配列は NotFound」の記述を、省略時デフォルト空トラックに合わせて更新 |
| `docs/polyfill/guide.md` | オプション表で `mediaRegister` を任意に。factory 表に空トラック register を追加。dummy との差（RTP 有無 / codec）を一文で書く |
| `website/docs/doc1.md` / `website/i18n/ja/.../doc1.md` | 「`mediaRegister` は引き続き必要」の表現を、省略時は空トラックになる旨へ |
| `packages/webrtc/AGENTS.md` | polyfill の 1 行説明に省略時デフォルトを足す |
| `changelog.md` Unreleased Features | 破壊的ではない追加として記載 |

WPT runner（`createDummyRegister()` 明示）は変更しない。

## 3. 技術的な実装アプローチ（調査結果）

現行フローは次のとおり。

1. `installPolyfill` が `mediaRegister` を `bindRegisters` し、`MediaDevices` に渡す（`install.ts`）。
2. `getUserMedia` は kind ごとに `selectRegisterForKind` → `register.createTracks`（`mediaDevices.ts`）。
3. 該当 kind の register が無いと `NotFoundError`（`selectSettings.ts`）。
4. 組み込み工場は `createCallbackRegister` / `createDummyRegister`（`registers/callback.ts`）、MP4/WebM、RTP/RTCP、encoded binary。

`createDummyRegister` は `createDummyAudioTrack` / `createDummyVideoTrack`（`nonstandard/dummyMedia.ts`）でタイマー RTP を書く。本タスクの「プレーンな空」とはこの経路をデフォルトにしない、という意味である。

テスト用 `createVideoCallbackRegister` は既に `new MediaStreamTrack({ kind: "video" })` を返すが、`createCallbackRegister` が mimeType から `track.codec` を埋める。空デフォルトは **その codec 付与もしない**。codec 未設定トラックを `addTrack` した場合、送信側は既存の `rtpSender` が PeerConnection の codec リストから後で載せる（`packages/webrtc/src/media/rtpSender.ts`）。SDP 交渉は PC 既定 codec で成立しうる。

`existingMediaDevices: "noop"` で既存 `getUserMedia` があるときは、現行どおり werift の `mediaDevices` を入れない。省略時デフォルト register もそのときは使われない。

## 4. 制約・注意点

- **dummy をデフォルトにしない。** 定期 RTP は CPU・テストフレーク・意図しない送信の原因になる。タイトルの「プレーンな空」は dummy とは別物。
- **空配列を勝手にデフォルト化しない（推奨）。** ドキュメントと既存テストが「空配列 = デバイスなし」を契約にしている。
- **WPT / 明示 register を壊さない。** runner は `createDummyRegister()` を明示している。
- **仕様の TypeError を緩めない。** `audio`/`video` どちらも無い制約は失敗のまま。
- **uninstall。** 空トラックも `MediaDevices.cleanup` / `track.stop` の既存経路に乗せる。追加 I/O は無いので `stop()` は no-op でよい。
- **公開 API。** `werift/polyfill` のみ。`src/index.ts` へ re-export しない。
- **Windows 非対応** など既存ランタイム制約は変えない。
- テスト規約: Arrange の共有は `polyfillTestUtils.ts`、Act/Assert に日本語コメント。

## 5. 完了条件

- `mediaRegister` 省略時に `installPolyfill` が成功し、`getUserMedia` が要求 kind のプレーン空 `MediaStreamTrack` を返す。
- そのトラックは dummy RTP を出さず、`codec` 未設定である。
- 非配列 `mediaRegister` は従来どおり TypeError。
- `mediaRegister: []` は（推奨方針どおりなら）従来どおり NotFoundError / 空制約 TypeError。
- 明示した MP4 / RTP / callback / dummy register の選択・エラー・クリーンアップは回帰しない。
- 上記ドキュメントと changelog が省略時デフォルトを説明している。
- 検証: `packages/webrtc` で対象テスト（少なくとも `tests/nonstandard/polyfill.test.ts`）と `npm run type`。polyfill に閉じる変更ならワークスペース全体の `ci` は必須ではない。

## 主な参照

- `packages/webrtc/src/polyfill/install.ts`
- `packages/webrtc/src/polyfill/mediaDevices.ts`
- `packages/webrtc/src/polyfill/mediaRegister.ts`
- `packages/webrtc/src/polyfill/registers/callback.ts`（dummy / callback。空デフォルトの反面教師）
- `packages/webrtc/src/nonstandard/dummyMedia.ts`
- `packages/webrtc/src/media/track.ts`
- `packages/webrtc/tests/nonstandard/polyfill.test.ts`
- `docs/polyfill/README.md`
- `docs/polyfill/guide.md`

## 未確定事項

実装の推奨は本文に書いた。次だけプロダクト判断が分かれる。

1. `mediaRegister: []` を省略時と同じ空トラック供給にするか、現行どおりデバイスなし（NotFoundError）のままにするか。
2. 省略時トラックに register の mimeType 由来 codec を載せるか（SDP に register 側 codec を出す）、未設定のままにするか（PC 既定 codec に任せる）。推奨は未設定。
