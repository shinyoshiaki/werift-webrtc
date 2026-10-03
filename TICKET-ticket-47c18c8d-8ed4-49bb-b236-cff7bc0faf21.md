# ポリフィルインストーラーのレジスター無指定時にメディアデバイス取得を可能にし、プレーンな空トラックを返す

## 1. 目的と背景

`werift/polyfill` の `installPolyfill()` は、ブラウザ向けライブラリを Node.js 上で動かすためのオプトインアダプタである。インストール時に `navigator.mediaDevices.getUserMedia` を差し込み、アプリケーションが渡した `mediaRegister` から `MediaStreamTrack` を供給する。

現状の契約は次のとおりである。

- `InstallPolyfillOptions.mediaRegister` は必須。省略・`undefined` は `TypeError: mediaRegister is required`。**この契約は変更しない。**
- 空配列 `mediaRegister: []` はインストール自体は成功するが、`getUserMedia({ video: true })` などは `NotFoundError`、空制約 `{}` は `TypeError`。
- 実メディアが要らない場合でも、呼び出し側は中身のある register（例: `createDummyRegister()`）を明示する必要がある。
- `createDummyRegister()` は VP8 / ダミー音声の **定期 RTP を生成する** テスト用ソースであり、「トラックオブジェクトだけ欲しい」用途とは違う。

本タスクの「レジスター無指定」は **オプション自体の省略ではなく、空配列 `mediaRegister: []`** を指す。空配列でも `getUserMedia` でメディアデバイス取得ができるようにし、その場合は **ダミー RTP も codec 付与もないプレーンな空 `MediaStreamTrack`** を返す。同じ挙動を **明示的に指定できる公開レジスター**（`createEmptyRegister()`）も追加する。他のソースと並べて登録したり、空配列に頼らず意図をコードに残したりできるようにする。ブラウザライブラリが `getUserMedia` → `addTrack` するだけでトランシーバを立てたい、あとから `writeRtp` したい、recvonly に近いローカルトラックが欲しい、といった用途を、ダミーメディアなしで満たす。

codec は空トラックへ載せない。SDP 交渉は PeerConnection の既定 codec に任せる。

「追加設定なし」で mediasoup-client の Handler 自動選択が通る、という既存の User-Agent 補完とは別レイヤである。今回は **空の `mediaRegister` の GUM 経路** を扱う。

## 2. 実装すべき具体的な機能・変更内容

### 2.1 API（必須契約は維持）

- `InstallPolyfillOptions.mediaRegister` は **引き続き必須**（`mediaRegister: MediaRegister[]`）。
- `installPolyfill()` の options オブジェクトも現行どおり必須。`null` / 非オブジェクトは `TypeError`。
- キー欠如・`undefined` は現行どおり `TypeError: mediaRegister is required`。
- 非配列（オブジェクトなど）は現行どおり `TypeError: mediaRegister must be an array`。

空配列 `installPolyfill({ mediaRegister: [] })` では `navigator.mediaDevices` が入り、`getUserMedia({ audio: true })` / `{ video: true }` / 両方で解決する。同じ空トラック供給を明示するときは `installPolyfill({ mediaRegister: [createEmptyRegister()] })` を使う。他の明示 register（MP4 / RTP / dummy 等）がある場合の選択・エラーは変えない。

### 2.2 空配列時のトラック

要求 kind ごとに `new MediaStreamTrack({ kind })` 相当のトラックを 1 本返す。

| 項目 | 期待 |
| --- | --- |
| `kind` | 要求どおり `audio` / `video` |
| `readyState` | `"live"` |
| `muted` | `true`（RTP 未流入の現行デフォルト） |
| `codec` | **未設定**。register の mimeType 由来 codec を付けない。SDP は PC 既定 codec に任せる |
| RTP | 送出しない。`createDummyRegister` / `dummyMedia.ts` のタイマーソースを使わない |
| 後からの注入 | 既存の `track.writeRtp` はそのまま使える |

空制約 `getUserMedia({})` は仕様どおり `TypeError` のまま（audio / video のいずれか必須）。

`getDisplayMedia` は現行どおり `getUserMedia` のエイリアスなので、空配列時も同じ空トラック経路になる。

### 2.3 空配列と明示レジスター（確定）

`mediaRegister: []` は **プレーン空トラックを供給する**。同じ供給を公開 factory で明示できる。

- グローバル（`RTCPeerConnection` 等）は入る（現行どおり）
- `getUserMedia({ video: true })` などは空トラック付き `MediaStream` を返す（現行の `NotFoundError` から変更）
- `createEmptyRegister()` のトラック特性は空配列デフォルトと同一（§2.2）
- オプション省略 / `undefined` は従来どおり TypeError（変更しない）

### 2.4 実装の置き場所

組み込みの空トラック register を 1 つ実装し、**公開 factory として出し、空配列時のデフォルトにも使う**。

- 新規: `packages/webrtc/src/polyfill/registers/empty.ts`（名前は既存 `callback.ts` / dummy に合わせてよい）
- `kinds: ["audio", "video"]` の単一 register（`createDummyRegister` と同じ列挙モデル。同一 `deviceId` で `audioinput` + `videoinput`）
- `createTracks` は `request.kind` に応じたプレーン `MediaStreamTrack` を返すだけ。**codec を触らない**
- `mimeType` は `MediaRegister` 契約上必須。選択・列挙用のプレースホルダでよい（例: dummy と同様 `video/VP8`）。トラックへ codec をコピーしない
- `createCallbackRegister` は kind 一致時に codec を付けるため、空トラック工場の実装に使わない
- 既存の `createDummyRegister` と同様、`MediaRegisterCommonOptions`（`deviceId` / `groupId` / `label`）を受け取る

公開 factory（必須）:

- `createEmptyRegister(options?: MediaRegisterCommonOptions): MediaRegister`
- `packages/webrtc/src/polyfill/api.ts` から `createDummyRegister` と並べて re-export（`werift/polyfill` および `werift/polyfill/dom`）
- 空配列時のデフォルトは内部でこの factory を呼ぶ。呼び出し側は `mediaRegister: [createEmptyRegister()]` で同じ挙動を明示できる
- 他 register と混在してよい。選択は既存の `selectRegisterForKind`（deviceId / mimeType 等）に従う。空トラック側だけを使いたいときは `deviceId` を指定する

`install.ts` の変更方針（必須チェックは残す）:

```ts
if (!("mediaRegister" in options) || options.mediaRegister == undefined) {
  throw new TypeError("mediaRegister is required");
}
if (!Array.isArray(options.mediaRegister)) {
  throw new TypeError("mediaRegister must be an array");
}
const registers =
  options.mediaRegister.length === 0
    ? [createEmptyRegister()]
    : options.mediaRegister;
```

現行の必須チェックは削除しない。

```50:55:packages/webrtc/src/polyfill/install.ts
  if (!("mediaRegister" in options) || options.mediaRegister == undefined) {
    throw new TypeError("mediaRegister is required");
  }
  if (!Array.isArray(options.mediaRegister)) {
    throw new TypeError("mediaRegister must be an array");
  }
```

### 2.5 テスト

主対象: `packages/webrtc/tests/nonstandard/polyfill.test.ts`

- 現行 `rejects missing or non-array mediaRegister` は **維持**（省略 / `undefined` / 非配列は throw）
- 現行 `empty mediaRegister allows PeerConnection but getUserMedia fails with NotFoundError / TypeError` を更新する
  - 空制約 `{}` は引き続き TypeError
  - `{ video: true }` / `{ audio: true }` / 両方は空トラックで成功（NotFoundError ではなくなる）
  - `enumerateDevices()` に audioinput / videoinput が出る
  - track は `MediaStreamTrack`、`readyState === "live"`、`muted === true`、`codec == undefined`
  - 一定時間待っても `onReceiveRtp` が発火しない（dummy との回帰防止）
- `createEmptyRegister()` を明示したとき、空配列時と同じプレーン空トラックになる（audio / video / 両方、`codec == undefined`、RTP なし）
- `createEmptyRegister({ deviceId, label })` が `enumerateDevices()` と `deviceId.exact` に反映される
- 他 register と混在したとき、既存の選択規則で空トラック側も選べる
- 明示 `createDummyRegister` やファイル / RTP register の挙動は変えない
- `polyfillNodeCompile/consumer.ts` は現行どおり `installPolyfill({ mediaRegister: [] })` でよい。`polyfillDomCompile/consumer.ts` に `createEmptyRegister` の import を足して型が通ることを確認する（オプション省略は型エラーのまま）

Act / Assert には日本語コメントを付ける（`packages/webrtc/AGENTS.md`）。

### 2.6 ドキュメント

公開 API・プロトコル挙動の変更なので、実装と同時に更新する。

| ファイル | 内容 |
| --- | --- |
| `docs/polyfill/README.md` | `mediaRegister` は必須のまま。空配列は NotFound ではなくプレーン空トラック、と書き換える。明示 `createEmptyRegister()` の最小例を足す |
| `docs/polyfill/guide.md` | オプション表で `mediaRegister` は必須のまま。空配列の意味を更新。factory 表に `createEmptyRegister()` を追加し、空配列デフォルトと同一であること、dummy との差（RTP 有無 / codec 未設定・PC 既定 codec）を書く |
| `website/docs/doc1.md` / `website/i18n/ja/.../doc1.md` | 空配列でも GUM できること、明示 factory があること。オプション省略は不可 |
| `packages/webrtc/AGENTS.md` | polyfill の 1 行説明に空配列時の空トラックを足す |
| `changelog.md` Unreleased Features | 破壊的ではない追加として記載。空配列の GUM が NotFound から成功に変わる点と、`createEmptyRegister()` の追加に触れる |

WPT runner（`createDummyRegister()` 明示）は変更しない。

## 3. 技術的な実装アプローチ（調査結果）

現行フローは次のとおり。

1. `installPolyfill` が `mediaRegister` を `bindRegisters` し、`MediaDevices` に渡す（`install.ts`）。
2. `getUserMedia` は kind ごとに `selectRegisterForKind` → `register.createTracks`（`mediaDevices.ts`）。
3. 該当 kind の register が無いと `NotFoundError`（`selectSettings.ts`）。空配列がこの経路に落ちている。
4. 組み込み工場は `createCallbackRegister` / `createDummyRegister`（`registers/callback.ts`）、MP4/WebM、RTP/RTCP、encoded binary。

`createDummyRegister` は `createDummyAudioTrack` / `createDummyVideoTrack`（`nonstandard/dummyMedia.ts`）でタイマー RTP を書く。本タスクの「プレーンな空」とはこの経路を空配列のデフォルトにしない、という意味である。

テスト用 `createVideoCallbackRegister` は既に `new MediaStreamTrack({ kind: "video" })` を返すが、`createCallbackRegister` が mimeType から `track.codec` を埋める。空デフォルトは **その codec 付与もしない**。codec 未設定トラックを `addTrack` した場合、送信側は既存の `rtpSender` が PeerConnection の codec リストから後で載せる（`packages/webrtc/src/media/rtpSender.ts`）。SDP 交渉は PC 既定 codec で成立する。

`existingMediaDevices: "noop"` で既存 `getUserMedia` があるときは、現行どおり werift の `mediaDevices` を入れない。空配列デフォルト / 明示 `createEmptyRegister` もそのときは使われない。

公開面では `createEmptyRegister` を `createDummyRegister` と同じく `api.ts` から出す。空配列分岐は `install.ts` で `[createEmptyRegister()]` に置換し、トラック生成ロジックは factory 側に一箇所だけ置く。

## 4. 制約・注意点

- **`mediaRegister` 必須は維持。** 省略・`undefined` を許可しない。
- **dummy をデフォルトにしない。** 定期 RTP は CPU・テストフレーク・意図しない送信の原因になる。
- **codec は未設定。** mimeType プレースホルダをトラックへコピーしない。SDP は PC 既定 codec。
- **空配列の GUM 成功は既存ドキュメント / テストの契約変更。** README・guide・`polyfill.test.ts` を同時更新する。`createEmptyRegister` 以外の明示 register だけがあり、該当 kind が無い場合の NotFound は残す。
- **空配列と `createEmptyRegister()` は同じトラック特性。** 実装を二重化せず、空配列は factory 呼び出しに寄せる。
- **WPT / 明示 register を壊さない。** runner は `createDummyRegister()` を明示している。
- **仕様の TypeError を緩めない。** `audio`/`video` どちらも無い制約は失敗のまま。
- **uninstall。** 空トラックも `MediaDevices.cleanup` / `track.stop` の既存経路に乗せる。追加 I/O は無いので `stop()` は no-op でよい。
- **公開 API。** `werift/polyfill` のみ。`src/index.ts` へ re-export しない。
- **Windows 非対応** など既存ランタイム制約は変えない。
- テスト規約: Arrange の共有は `polyfillTestUtils.ts`、Act/Assert に日本語コメント。

## 5. 完了条件

- `mediaRegister` 省略 / `undefined` / 非配列は従来どおり TypeError。
- `mediaRegister: []` で `installPolyfill` が成功し、`getUserMedia` が要求 kind のプレーン空 `MediaStreamTrack` を返す。
- `createEmptyRegister()` が `werift/polyfill`（および `/dom`）から公開され、明示指定時も空配列と同じプレーン空トラックを返す。
- そのトラックは dummy RTP を出さず、`codec` 未設定である。SDP は PC 既定 codec に任せる。
- 空制約 `{}` は従来どおり TypeError。
- 明示した MP4 / RTP / callback / dummy register の選択・エラー・クリーンアップは回帰しない。
- 上記ドキュメントと changelog が「必須のまま / 空配列は空トラック / `createEmptyRegister()` で明示」を説明している。
- 検証: `packages/webrtc` で対象テスト（少なくとも `tests/nonstandard/polyfill.test.ts`）と `npm run type`。polyfill に閉じる変更ならワークスペース全体の `ci` は必須ではない。

## 主な参照

- `packages/webrtc/src/polyfill/install.ts`
- `packages/webrtc/src/polyfill/mediaDevices.ts`
- `packages/webrtc/src/polyfill/mediaRegister.ts`
- `packages/webrtc/src/polyfill/registers/callback.ts`（dummy / callback。空デフォルトの反面教師）
- `packages/webrtc/src/nonstandard/dummyMedia.ts`
- `packages/webrtc/src/media/track.ts`
- `packages/webrtc/src/media/rtpSender.ts`
- `packages/webrtc/tests/nonstandard/polyfill.test.ts`
- `docs/polyfill/README.md`
- `docs/polyfill/guide.md`

## 確定した判断

1. `InstallPolyfillOptions.mediaRegister` は必須のまま。省略・`undefined` は TypeError。
2. `mediaRegister: []` はプレーン空トラックを供給する（NotFoundError にしない）。
3. 空トラックの `codec` は未設定。SDP は PC 既定 codec に任せる。
4. 同じ挙動を明示する公開 factory `createEmptyRegister()` を追加する。空配列デフォルトはこの factory を使う。
