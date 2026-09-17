# installPolyfill / MediaRegister / RTCPeerConnection Codec Integration

## 0. この詳細化の要約

`installPolyfill()` が生成する `RTCPeerConnection` に既定 codec config を適用できるようにし、`MediaRegister` 由来の fixed encoded source を **PeerConnection capability とは独立した hard constraint** として扱い、`RTCRtpTransceiver.setCodecPreferences()` を application preference として実装する。

コードベース調査の結果、現状は次の 2 点が仕様と逆になっている。

1. `installPolyfill()` には PeerConnection 既定 config を渡す口が無く、mediasoup-client の内部 probe/transport PC に codec を設定できない。integration fixture は `installInteropPeerConnection()` というローカル wrapper で H264 を後付けしている（`integration/werift-mediasoup-interop/test/helpers/polyfill.ts:82`）。
2. `adoptSenderTrackCodec()` が track の codec を `pc.config.codecs` に **暗黙追加/並べ替え** しており（`packages/webrtc/src/peerConnection.ts:1335`）、source codec が PeerConnection-global capability を mutate している。

本チケットは Phase 1〜3 を実装対象、Phase 4（公開型分離・`MediaRegister.sourceCodecs`・`track.codec` 非推奨化）はフォローアップとする。Phase 4 を除いても §6 の受け入れ条件はすべて満たせる。

---

## 1. タスクの目的と背景

### 1.1 目的

PeerConnection capability / source codec constraint / codec preference の 3 層を分離し、送信側 transceiver の有効 codec を次で決定する。

```text
effective codecs
    =
PeerConnection capabilities          (config.codecs, install defaults, built-in)
    ∩
Source codec constraints             (MediaRegister が生成した fixed codec track)
    ∩
Codec preferences                    (RTCRtpTransceiver.setCodecPreferences)
```

未指定の層は「全候補を許容」として扱う。source ∩ capability が空なら **明示的に失敗** させ、暗黙に capability を拡張しない。

### 1.2 現状の挙動（調査結果）

- 既定 codec は `packages/webrtc/src/peerConnection.ts:1444` の `generateDefaultPeerConfig()`:
  `audio: [useOPUS(), usePCMU()]`, `video: [useVP8()]`
- `RTCPeerConnection.setConfiguration()` は `deepMerge()`（`packages/webrtc/src/utils.ts:322`）で config を適用する。`deepMerge` は再帰 merge ではなく、`codecs` オブジェクトを丸ごと差し替える。そのため「kind 単位 replacement」は wrapper 側で明示的に実装する必要がある。
- `setConfiguration()` は `assignDynamicPayloadTypes()`（`peerConnection.ts:1363`）で codec インスタンスの `payloadType` を **in-place mutate** する。install 既定 config の codec インスタンスを PC 間で共有してはならない。
- `TransceiverManager.assignTransceiverCodecs()`（`packages/webrtc/src/transceiverManager.ts:247`）は先頭で `adoptSenderTrackCodec(this.config, transceiver.sender.track)` を呼び、`config.codecs[kind]` 自体を書き換えている。
- `setRemoteRTP()`（`transceiverManager.ts:333`）でも再度 `adoptSenderTrackCodec()` を呼び、remote codec を `this.config.codecs` の MIME 一致だけで filter している。
- track の source codec は各 register が `track.codec` に設定する:
  `createCallbackRegister`（`packages/webrtc/src/polyfill/registers/callback.ts:44`）、`createMp4WebmRegister`（`registers/mp4Webm.ts:299`）、`createRtpRtcpRegister` / `createEncodedBinaryRegister`（`registers/rtpRtcp.ts:50,116`）、`createEmptyRegister` は codec 未設定（= raw）。
- `createFileMediaPlayer` の H264 source codec は container の `profile-level-id` を反映する（`packages/webrtc/src/nonstandard/userMedia.ts:455`）。テスト fixture の H264 は `42e01f`（`tests/nonstandard/userMediaTestUtils.ts:290`）、e2e asset は `42c00a` で、e2e は config 側も同じ profile を明示している（`tests/nonstandard/userMedia.e2e.test.ts:14`）。
- `RTCRtpTransceiver` に `setCodecPreferences` は未実装（`packages/webrtc/src/media/rtpTransceiver.ts:22`）。
- mediasoup-client（3.22.0）は `new RTCPeerConnection({ iceServers, iceTransportPolicy, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' })` を capability probe と transport の両方で生成し、probe 用 PC にはアプリから設定を渡す手段が無い。`setCodecPreferences` は呼ばない。`codecs` も渡さない。
- `adoptSenderTrackCodec` / `findCodecByMimeType` は `src/index.ts` の `export * from "./peerConnection"` で公開 API になっている（削除は破壊的変更）。

---

## 2. 実装すべき具体的な機能や変更内容

### 2.1 Phase 1: `installPolyfill.peerConnectionConfig`

#### 2.1.1 API

`InstallPolyfillOptions`（`packages/webrtc/src/polyfill/install.ts:39`）に追加する。

```ts
export interface InstallPolyfillOptions {
  mediaRegister: MediaRegister[]; // 必須のまま（親チケットで確定済み）
  /**
   * Default configuration applied to every RTCPeerConnection created
   * through this polyfill. Explicit options passed to
   * new RTCPeerConnection(config) take precedence per field.
   */
  peerConnectionConfig?: RTCPeerConnectionConfig;
  existingMediaDevices?: ExistingMediaDevicesMode;
  target?: object;
  userAgent?: string;
}
```

- `mediaRegister` の必須チェックと空配列デフォルト（`[createEmptyRegister()]`）は現行のまま維持する（`install.ts:51-70`）。
- `peerConnectionConfig` が指定され、object でない場合はインストール前に `TypeError("peerConnectionConfig must be an object")` を投げる。深い検証は `RTCPeerConnection` constructor に委ねる。
- `peerConnectionConfig` 省略時は **wrapper class を生成せず**、現行どおり `RTCPeerConnection` をそのまま assign する。`target.RTCPeerConnection === RTCPeerConnection` を assert している既存テスト（`tests/nonstandard/polyfill.test.ts:471,550,928`）を維持するため。
- 指定時のみ wrapper class を assign する。`INSTALLED_KEYS` snapshot / rollback / uninstall の既存経路にそのまま乗せる。

#### 2.1.2 wrapper と merge

新規 `packages/webrtc/src/polyfill/peerConnectionConfig.ts` を追加する。

```ts
export function createPolyfillRTCPeerConnection(
  installConfig?: RTCPeerConnectionConfig,
): typeof RTCPeerConnection {
  if (installConfig == undefined) return RTCPeerConnection;
  return class PolyfillRTCPeerConnection extends RTCPeerConnection {
    constructor(config: RTCPeerConnectionConfig = {}) {
      super(mergePeerConnectionConfig(installConfig, config));
    }
  };
}

export function mergePeerConnectionConfig(
  installConfig: RTCPeerConnectionConfig,
  config: RTCPeerConnectionConfig,
): RTCPeerConnectionConfig;
```

merge ルール（§5 の確定事項）:

- スカラ・オブジェクトフィールドは constructor の値（`undefined` でないもの）が install 値を上書きする。`iceServers` 等は constructor 側の explicit 値（mediasoup-client の `[]` など）が勝つ。
- `codecs` / `headerExtensions` は **kind 単位 replacement**。append / deep-merge はしない。

```ts
effective.codecs.audio =
  config.codecs?.audio ?? install.codecs?.audio ?? builtin.audio;
effective.codecs.video =
  config.codecs?.video ?? install.codecs?.video ?? builtin.video;
```

- どちらか一方でも kind を指定した場合、両 kind 分を materialize する（片方を install、他方を builtin で補う）。どちらも未指定なら `codecs` は触らない（base の built-in に任せる）。
- `codecs` の codec インスタンスは PC ごとに clone する。`assignDynamicPayloadTypes()` が `payloadType` を in-place 書き換えするため、install config のインスタンスを複数 PC で共有してはならない。
- `packages/webrtc/src/peerConnection.ts` の private `cloneCodecParameters()`（`:1392`）を export するか、`media/codec.ts` へ移して共用する。
- built-in 既定は `generateDefaultPeerConfig()` に埋め込む代わりに `media/codec.ts` へ `defaultCodecs()`（`{ audio: [useOPUS(), usePCMU()], video: [useVP8()] }` を毎回新規生成）を切り出し、`generateDefaultPeerConfig()` と merge の両方から使う。
- `headerExtensions` も同じ kind 単位 replacement + clone とする（integration fixture の `rtp-stream-id` を install config で表現するため）。

#### 2.1.3 mediasoup-client への適用

`installPolyfill` が assign する `RTCPeerConnection` は wrapper 経由になるため、mediasoup-client の capability probe / send / recv transport が生成する全 PC に install config が適用される。constructor 側の `bundlePolicy: 'max-bundle'` 等は constructor 優先で維持される。

### 2.2 Phase 2: source codec constraint

#### 2.2.1 source metadata

`packages/webrtc/src/media/track.ts` に、`track.codec` とは独立した source codec metadata を持たせる。

```ts
const sourceCodecsByTrack = new WeakMap<MediaStreamTrack, readonly RTCRtpCodecParameters[]>();

export function setTrackSourceCodecs(
  track: MediaStreamTrack,
  codecs: readonly RTCRtpCodecParameters[] | undefined,
): void;
export function getTrackSourceCodecs(
  track: MediaStreamTrack | undefined | null,
): readonly RTCRtpCodecParameters[] | undefined;
/** sender へ attach された時点の track.codec を source constraint として確定する */
export function captureTrackSourceCodecs(track: MediaStreamTrack): void;
```

- `captureTrackSourceCodecs()` は「まだ metadata が無く、`track.codec != undefined`」のときだけ `[track.codec]` を保存する。既に保存済みなら何もしない。
- capture は `RTCRtpSender.registerTrack()`（`packages/webrtc/src/media/rtpSender.ts:359`）で呼ぶ。sender constructor（`:216`）、`addTrack` の既存 transceiver 再利用、`replaceTrack()` はすべてここを通る。
- `track.codec` は既存互換のため残す。`rtpSender.prepareSend()` が negotiated codec を `track.codec` に上書きしても（`rtpSender.ts:264-267`）、metadata は capture 済みのため影響しない。`track.codec` を source capability の authoritative source として read しない。
- `MediaStreamTrack.clone()`（`track.ts:173`）は metadata を引き継ぐ（`setTrackSourceCodecs(cloned, getTrackSourceCodecs(this))`）。
- metadata が無い track = raw source。`createEmptyRegister` の track は codec 未設定のため raw のまま。
- `createMp4WebmRegister` で明示 codec hint を適用する箇所（`registers/mp4Webm.ts:299-328`）は、最終的に track に載る codec を `setTrackSourceCodecs()` で明示更新する（inspected → explicit の差し替えを metadata に反映するため）。

#### 2.2.2 compatibility 判定

新規 `packages/webrtc/src/media/codecCompatibility.ts`:

```ts
export function isCodecCompatible(source, configured): boolean;
export function intersectCodecs(
  configured: RTCRtpCodecParameters[],
  source: readonly RTCRtpCodecParameters[],
): RTCRtpCodecParameters[];
export function resolveCodecs(
  configured: RTCRtpCodecParameters[],
  source: readonly RTCRtpCodecParameters[] | undefined,
  preferences: readonly RTCRtpCodecParameters[] | undefined,
): RTCRtpCodecParameters[];
```

`isCodecCompatible(sourceCodec, configuredCodec)` のルール:

- `mimeType` は case-insensitive 一致。
- `clockRate` は一致必須。
- `channels` は **両方 specified のときだけ** 比較。
- H264 は `parameters`（fmtp 文字列）を `codecParametersFromString()`（`packages/webrtc/src/sdp`）で parse し、`packetization-mode` と `profile-level-id` を **両方 specified のときだけ** 比較する。片方しか指定が無い場合は互換扱い（判定不能のため許容）。`level-asymmetry-allowed` 等その他 fmtp は比較しない。
- mimeType 以外の fmtp を厳密比較しない理由: remote との SDP 相互運用（後述 §3.5）では既存の MIME 一致 filter を維持するため。source-vs-capability のみ strict にする。

`intersectCodecs()` は `configured` の順序を保持し、`source` のいずれかと互換な configured 要素だけを返す。RTX / RED などの補助 codec は次の規則で保持する（`assignDynamicPayloadTypes` 済みの `payloadType` を使う）。

- `rtx`: `parameters` の `apt` が kept codec の payloadType を指す場合だけ保持。
- `red`: `parameters`（`a/b` 形式）が kept codec の payloadType を参照する場合だけ保持。

#### 2.2.3 transceiver codec resolution

`packages/webrtc/src/transceiverManager.ts` を変更する。

- import から `adoptSenderTrackCodec` を削除し、`getTrackSourceCodecs` / `captureTrackSourceCodecs` / `resolveCodecs` を使う。
- `assignTransceiverCodecs(transceiver)` の新実装:

```ts
assignTransceiverCodecs(transceiver: RTCRtpTransceiver): void {
  const configured = filterCodecsByDirection(
    this.config.codecs[transceiver.kind] ?? [],
    transceiver.direction,
  );
  const source = getTrackSourceCodecs(transceiver.sender.track);
  const sourceCompatible = source
    ? withAuxiliaryCodecs(this.config.codecs[transceiver.kind] ?? [], intersectCodecs(configured, source))
    : configured;
  const effective = applyCodecPreferences(sourceCompatible, transceiver.codecPreferences);

  if (effective.length === 0) {
    throw createCodecNotSupportedError({ kind: transceiver.kind, source, configured, preferences: transceiver.codecPreferences });
  }
  // 既存 direction filter の挙動は維持する
  transceiver.codecs = effective;
}
```

- source constraint の解決のために **内部から `setCodecPreferences()` を呼ばない**。preference は application 入力の保存値のみを参照する。
- `setRemoteRTP()` の `adoptSenderTrackCodec()` 呼び出しを削除し、remote codec filter の候補集合を `resolveCodecs(this.config.codecs[kind], source, transceiver.codecPreferences)` の結果に差し替える。remote codec との membership 判定は既存の `findCodecByMimeType()`（MIME 一致）を維持し、RTX の `apt` 解決も `resolveCodecs` 結果を参照する。
- 答え側（`setRemoteRTP`）で effective が空になる場合も `NotSupportedError` を投げる（現行の `throw new Error("negotiate codecs failed.")` を置換）。

#### 2.2.4 早期 validation（addTrack / addTransceiver）

`TransceiverManager.addTransceiver()` / `addTrack()` の先頭で source を capture + validate し、`createOffer()` までエラーを遅延させない。

- `addTransceiver(trackOrKind, ...)`: track のとき `captureTrackSourceCodecs(track)` → configured（direction filter 後）∩ source が空なら `NotSupportedError`。
- `addTrack(track, ...)`: 再利用先 transceiver が決まる場合はその `codecPreferences` も含めて `resolveCodecs()` し、空なら `NotSupportedError`。track 登録後は `transceiver.codecs = []` に invalidate して `createOffer()` で再解決させる（再利用時に古い codec リストが残るのを防ぐ）。
- 例外を投げる場合は transceiver / sender / config を一切 mutate しない。
- `replaceTrack()` は metadata capture のみ行う。codec リストの invalidate は本チケットのスコープ外とし、§4 の既知の制約に記載する。

### 2.3 Phase 3: `RTCRtpTransceiver.setCodecPreferences()`

`packages/webrtc/src/media/rtpTransceiver.ts` に実装する。

```ts
private _codecPreferences?: RTCRtpCodecParameters[];

get codecPreferences(): readonly RTCRtpCodecParameters[] | undefined {
  return this._codecPreferences;
}

setCodecPreferences(codecs: RTCRtpCodecParameters[]): void {
  if (!Array.isArray(codecs)) {
    throw createWebRtcTypeError("codecs must be an array");
  }
  // [] は明示 preference の解除（W3C と同じ）
  this._codecPreferences =
    codecs.length === 0 ? undefined : codecs.map(cloneCodecParameters);
}
```

- 引数型は werift 既存の `RTCRtpCodecParameters[]`（`useH264()` 等がそのまま渡せる）。`RTCRtpCodecCapability` への型分離は Phase 4。
- preference の照合は **MIME type 一致**（case-insensitive、`clockRate` が両方 specified なら一致必須）。`parameters` / `payloadType` は照合に使わない。これにより `useH264()`（profile 42e01f）で config 側 `useH264({ parameters: ...42c00a... })` を選択できる。
- preference は candidate の順序付けと filter の両方を行う。preference に無い codec は候補から外れる（W3C と同じ filter セマンティクス）。補助 codec（RTX / RED）は kept codec に追従して保持する。
- 適用結果が空になる場合のエラーは `setCodecPreferences()` では投げず、`addTrack` / `addTransceiver`（source 判明時）または `createOffer()` / `setRemoteDescription()` で `NotSupportedError` を投げる（transceiver が capability を知らないため）。

§7.2 の Case 対応:

| Case | PC | Source | Preference | 結果 |
| --- | --- | --- | --- | --- |
| A | [VP8,H264] | [H264] | [VP8,H264] | effective [H264] |
| B | [VP8,H264] | [H264] | [H264,VP8] | effective [H264] |
| C | [VP8,H264] | [H264] | [VP8] | effective [] → `NotSupportedError` |
| D | [VP8,H264] | [H264] | [] | preference 解除、[H264] |

### 2.4 Phase 4（本チケットでは必須としない）

以下はフォローアップとする。§6 の受け入れ条件には含まれない。

- `MediaRegister.sourceCodecs` の公開 API 追加と `mimeType` の選択用途への限定。
- `RTCRtpCodecCapability` / `RTCRtpCodecParameters` の公開型分離、payload type の扱い整理。
- `MediaStreamTrack.codec` の deprecated / internal 化。
- H264 互換判定のさらなる厳密化。

### 2.5 テスト

#### 2.5.1 新規

- `packages/webrtc/tests/nonstandard/polyfillCodec.test.ts`
  - install default / constructor override / kind 単位 replacement（audio は builtin fallback）。
  - mediasoup 相当の probe PC（`{iceServers: [], iceTransportPolicy:'all', bundlePolicy:'max-bundle', rtcpMuxPolicy:'require'}` + audio/video recvonly transceiver）で H264 を advertise し VP8 を advertise しない。
  - transport 相当 PC の `getConfiguration().codecs` が probe と一致する。
  - install default が direct import の `RTCPeerConnection` に漏れない。
  - 複数 target への install / uninstall で他 target に影響しない。
- `packages/webrtc/tests/media/codecResolution.test.ts`（polyfill 非依存）
  - `new MediaStreamTrack({ kind:"video", codec: useH264() })` を VP8-only PC へ `addTrack` / `addTransceiver` → 同期 `NotSupportedError`。
  - `[VP8,H264]` PC + H264 source → `transceiver.codecs` は H264 のみ、offer は H264 のみ。
  - raw track → offer は [VP8,H264]。
  - `setCodecPreferences` Case A〜D。
  - 同一 PC に H264 track と VP8 track → 各 transceiver が H264 / VP8 に制限され、`pc.getConfiguration().codecs.video` が mutate されない。
  - H264 fmtp: source `42c00a` vs configured default `useH264()`（42e01f）→ `NotSupportedError`、configured も `42c00a` なら成功。packetization-mode 相違も同様。
  - RTX が kept codec に追従して残る。

#### 2.5.2 既存テストの更新（必須）

- `packages/webrtc/tests/nonstandard/polyfill.test.ts:582`「callback register の mimeType は PC codecs なしで offer に載る」
  → デフォルト VP8-only PC + H264 track は `NotSupportedError` になる。エラー assertion に書き換え、`{ codecs: { video: [useVP8(), useH264()] } }` を明示した PC で H264 が offer に載るケースを新規テストへ移す。
- `packages/webrtc/tests/nonstandard/polyfill.test.ts:1040`「mp4/webm は mediabunny で検出したコーデックを PC codecs なしで offer する」
  → VP8 WebM + default PC は現行どおり成功。H264 MP4 + default PC の部分は `NotSupportedError` を assert し、H264 config を明示した PC で offer に載ることを別途 assert する。
- `packages/webrtc/tests/nonstandard/polyfillTestUtils.ts:40` の `installTestPolyfill` に `peerConnectionConfig` を渡せる optional 引数を追加する（Arrange はこの 1 ファイルに集約する）。
- `packages/webrtc/tests/nonstandard/polyfillNodeCompile/consumer.ts` / `polyfillDomCompile/consumer.ts` に `peerConnectionConfig` の型が通る利用例を追加する（例: `codecs: { video: [useH264()] }`）。

#### 2.5.3 integration fixture（`integration/werift-mediasoup-interop`）

- `test/helpers/polyfill.ts:82` の `installInteropPeerConnection()` を廃止し、`installPolyfillUnlocked()` が `peerConnectionConfig: { codecs: { audio: [useOPUS(), usePCMU()], video: [useVP8(), useH264()] }, headerExtensions: { video: [{ uri: rtpStreamIdUri }] }, pendingRtp: true }` を `installPolyfill()` に渡す形へ置き換える（`test/helpers/session.ts:39` の wrapper 呼び出しも削除）。
- `test/interop/video.test.ts:18` の `produceVideo(mimeType)` は、`mimeType` に一致する source register を選ぶよう GUM を `{ video: { mimeType: { exact: mimeType } } }` に変更する。VP8 track のまま H264 produce する現行テストは、新しい hard constraint では正しく失敗する（transcoding 非目標のため）。
- 検証: `npm run type` / `npm run test:small`、worker が使える環境では `npm test`（`test:interop`）まで。submodule 側へ commit が必要なため、submodule workflow が使えない場合は fixture 変更をフォローアップとして切り出してよい（package 内テストは必須）。

### 2.6 ドキュメント

| ファイル | 更新内容 |
| --- | --- |
| `docs/polyfill/guide.md` | オプション表（`:25`）に `peerConnectionConfig` を追加。新セクション「Codec capabilities, fixed-codec sources, and preferences」を追加し、3 層モデル、fixed source の `NotSupportedError` タイミング、`setCodecPreferences`、mediasoup-client の例（capability probe と transport に同じ install default が入る）、codec 配列が kind 単位 replacement であることを説明。factory 表（`:149`）に dummy / callback / MP4 / RTP の source が PC capability を制約することを追記 |
| `docs/polyfill/README.md` | `peerConnectionConfig` と、fixed codec source が PC capability と一致しない場合の明示エラーに短く言及 |
| `website/docs/doc1.md` / `website/i18n/ja/docusaurus-plugin-content-docs/current/doc1.md` | `installPolyfill({ mediaRegister, peerConnectionConfig })` で H264-only 環境を作れること、mediasoup-client の probe/transport に適用されることを追記 |
| `packages/webrtc/AGENTS.md` | polyfill の 1 行説明に `peerConnectionConfig` と source codec constraint を追記 |
| `changelog.md` Unreleased | Features: `peerConnectionConfig` 追加、`setCodecPreferences` 実装、source codec constraint。⚠️ Breaking changes: fixed encoded source が PC capability を暗黙拡張しなくなったこと、`adoptSenderTrackCodec` の削除 |

### 2.7 実装順序

1. Phase 1（`peerConnectionConfig` / wrapper / merge）＋ `createPolyfillRTCPeerConnection` のテスト。
2. Phase 2（metadata / compatibility / resolution / 早期 validation / `adoptSenderTrackCodec` 削除）＋ 既存テスト修正。
3. Phase 3（`setCodecPreferences`）＋ Case テスト。
4. docs / changelog / integration fixture。

---

## 3. 技術的な実装アプローチと調査結果

### 3.1 config merge の疑似コード

```ts
function mergePeerConnectionConfig(install, config) {
  const merged = { ...install };
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) merged[key] = value;
  }
  merged.codecs = mergeKindRecord(install.codecs, config.codecs, defaultCodecs());
  merged.headerExtensions = mergeKindRecord(
    install.headerExtensions,
    config.headerExtensions,
    { audio: [], video: [] },
  );
  return merged;
}
```

- `mergeKindRecord` は kind ごとに `clone(ctor?.[kind] ?? install?.[kind] ?? builtin[kind])` を返す。どちらも `codecs` / `headerExtensions` 全体を未指定なら key 自体を触らない。
- `clone` は `codec` / `headerExtension` インスタンスを新規生成する（payloadType の in-place 更新対策）。

### 3.2 source constraint のライフサイクル

```text
MediaRegister.createTracks()
  -> track.codec = source codec (encoded) / undefined (raw)

RTCRtpSender.registerTrack(track)
  -> captureTrackSourceCodecs(track)   // この時点の codec を WeakMap に固定

createOffer()
  -> assignTransceiverCodecs()
     -> resolveCodecs(config.codecs[kind], sourceMetadata, codecPreferences)
     -> transceiver.codecs = effective   // source constraint で filter/制限

setRemoteDescription(offer)
  -> setRemoteRTP()
     -> resolveCodecs(...) を候補集合に remote codec を MIME 一致で filter
     -> transceiver.codecs = negotiated codecs
     -> sender.prepareSend() -> sender.codec = params.codecs[0]
     -> track.codec = negotiated codec （playback 用。metadata は不変）
```

### 3.3 変更ファイル一覧

| ファイル | 変更 |
| --- | --- |
| `packages/webrtc/src/polyfill/install.ts` | `peerConnectionConfig` option 検証、wrapper の生成・assign |
| `packages/webrtc/src/polyfill/peerConnectionConfig.ts`（新規） | wrapper / merge / validation |
| `packages/webrtc/src/polyfill/api.ts` | `RTCPeerConnectionConfig` の type re-export（推奨） |
| `packages/webrtc/src/peerConnection.ts` | `adoptSenderTrackCodec` 削除、`cloneCodecParameters` export、`defaultCodecs()` 切出し |
| `packages/webrtc/src/media/codec.ts` | `defaultCodecs()` 追加 |
| `packages/webrtc/src/media/codecCompatibility.ts`（新規） | `isCodecCompatible` / `intersectCodecs` / `applyCodecPreferences` / `resolveCodecs` / エラー生成 |
| `packages/webrtc/src/media/track.ts` | source codecs WeakMap と helper、`clone()` の metadata 継承 |
| `packages/webrtc/src/media/rtpSender.ts` | `registerTrack()` で `captureTrackSourceCodecs()` |
| `packages/webrtc/src/media/rtpTransceiver.ts` | `codecPreferences` / `setCodecPreferences()` |
| `packages/webrtc/src/transceiverManager.ts` | source/preference 解決、早期 validation、`adoptSenderTrackCodec` 呼び出し削除 |
| `packages/webrtc/src/polyfill/registers/mp4Webm.ts` | 明示 codec hint 時の metadata 更新 |
| tests / docs / integration | §2.5 / §2.6 |

### 3.4 エラー仕様

`createWebRtcDomException("NotSupportedError", message)`（`packages/webrtc/src/errors.ts:12`）を使う。

source codec unsupported:

```text
Track codec video/H264 is not supported by this RTCPeerConnection.
Configured video codecs: video/VP8
```

preference で source 互換 codec が消える場合:

```text
No codec remains after applying codec preferences.
Source codecs: video/H264
Configured codecs: video/VP8, video/H264
Preferred codecs: video/VP8
```

message 内の codec は `mimeType` の列挙（`", "` 区切り）とする。source ∩ configured が空なら前者、そうでなく preference 適用後に空なら後者を投げる。

### 3.5 remote negotiation の扱い

- remote codec との membership は既存どおり `findCodecByMimeType()`（MIME 一致）を維持する。H264 fmtp の strict 比較は source-vs-capability に限定し、remote SDP 相互運用（Chrome の複数 H264 profile など）を壊さない。
- remote RTX の `apt` 解決は `resolveCodecs()` の結果を参照する。
- remote answer が source と互換でない codec を選んだ場合は `setRemoteRTP()` で `NotSupportedError` を投げる。

---

## 4. 考慮すべき制約や注意点

- **`mediaRegister` 必須と空配列デフォルトは変更しない。** 空配列の `createEmptyRegister()` track は codec 未設定 = raw で、本チケットの影響を受けない。
- **`target.RTCPeerConnection === RTCPeerConnection` を壊さない。** `peerConnectionConfig` 省略時は wrapper を作らない。
- **global static state を作らない。** `RTCPeerConnection.defaultConfig` のようなクラス静的プロパティは追加しない。install ごとの wrapper + descriptor snapshot/restore で完結させる。
- **codec 配列は append / deep-merge しない。** kind 単位 replacement。`installPolyfill` 既定と constructor 明示の両方で守る。
- **`config.codecs` を mutate しない。** `adoptSenderTrackCodec` の削除後も `assignTransceiverCodecs` / `setRemoteRTP` は `this.config` を書き換えない。`assignDynamicPayloadTypes` は constructor 時の config（install から clone 済み）にのみ作用する。
- **source constraint のために `setCodecPreferences()` を内部呼び出ししない。** preference は application 入力の保存値のみ。
- **`setCodecPreferences` の同期 throw をしない。** 互換性エラーは source 判明時（addTrack / addTransceiver）または offer/answer 生成時に投げる。
- **raw track を制約しない。** metadata がある track だけが対象。`createEmptyRegister` / ユーザーが codec 未設定で作った track は全 capability を使える。
- **H264 strict 化の副作用。** `useH264()` 既定は `42e01f` 固定のため、profile が異なる H264 MP4 は config 側に同じ `parameters` を明示しないと `NotSupportedError` になる。e2e asset（`42c00a`）は既に明示済み。テスト fixture（`42e01f`）は既定と一致する。この挙動を docs に明記する。
- **RTX / RED の保持。** source constraint で codec を絞る際、`apt` / RED parameter が kept payload type を指す補助 codec を落とさない。
- **`replaceTrack()` の制約。** source metadata の capture は行うが、既存 transceiver の `codecPreferences` は `prepareSend` で track.codec が negotiated 値に上書きされた後でも metadata を読むため正しく解決できる。ただし renegotiation 前に `transceiver.codecs` を invalidate しない（既知の制約として docs か follow-up に記載）。
- **WPT を触らない。** `tools/wpt-runner` に対象テストは無く、strict 挙動を WPT wrapper へ漏らさない。
- **integration submodule。** `test/helpers/polyfill.ts` の fixture-local wrapper は新 API へ置き換えるが、submodule への commit / pointer 更新は submodule workflow に従う。
- **テスト規約。** Arrange は `polyfillTestUtils.ts` に共有し、Act / Assert に日本語コメントを付ける（`packages/webrtc/AGENTS.md`）。

---

## 5. 完了条件

### 5.1 機能

- `installPolyfill({ mediaRegister, peerConnectionConfig })` の config が、polyfill 経由で生成した全 `RTCPeerConnection`（mediasoup-client の probe / send / recv を含む）に適用される。
- `new RTCPeerConnection(config)` の明示 config が install default より優先され、codec 配列は kind 単位 replacement になる。
- `peerConnectionConfig` 省略時は `target.RTCPeerConnection === RTCPeerConnection` が維持され、install / uninstall で static state を汚染しない。
- fixed encoded source（H264 MP4 / callback / RTP / encoded binary）は capability を暗黙拡張しない。
- VP8-only PC + H264 source は `addTrack` / `addTransceiver` 時点で `NotSupportedError`。
- `[VP8,H264]` PC + H264 source は transceiver codecs / offer が H264 のみに制限される。
- raw source（空 track）は PC capability をそのまま使う。
- `setCodecPreferences()` が §2.3 の Case A〜D どおり動作し、source constraint と独立に適用される。
- 複数 encoded track を同一 PC に追加しても `config.codecs` が track 単位で mutate されない。
- `adoptSenderTrackCodec` が削除され、changelog の Breaking changes に記載されている。

### 5.2 テスト・検証

- `cd packages/webrtc && npm run type`
- `cd packages/webrtc && npm test`（少なくとも `tests/nonstandard/polyfill.test.ts`、新規 `polyfillCodec.test.ts`、`codecResolution.test.ts`）
- ルートで `npm run test:small`（`adoptSenderTrackCodec` 削除は public API 変更のため）
- integration fixture を変更した場合: `cd integration/werift-mediasoup-interop && npm run type && npm run test:small`（worker がある環境では `npm test`）

### 5.3 ドキュメント

- `docs/polyfill/guide.md` / `docs/polyfill/README.md` / `website/docs/doc1.md` / ja doc1.md が新 API と fixed source の挙動を説明している。
- `changelog.md` Unreleased に Feature と Breaking change が記載されている。
- `packages/webrtc/AGENTS.md` の polyfill 説明が更新されている。

---

## 主な参照

- `packages/webrtc/src/polyfill/install.ts`
- `packages/webrtc/src/polyfill/registers/{empty,callback,mp4Webm,rtpRtcp}.ts`
- `packages/webrtc/src/polyfill/api.ts`
- `packages/webrtc/src/peerConnection.ts`（`adoptSenderTrackCodec` / `generateDefaultPeerConfig` / `setConfiguration`）
- `packages/webrtc/src/transceiverManager.ts`（`assignTransceiverCodecs` / `setRemoteRTP` / `addTrack`）
- `packages/webrtc/src/media/{track,rtpSender,rtpTransceiver,codec,parameters}.ts`
- `packages/webrtc/src/errors.ts`
- `packages/webrtc/tests/nonstandard/polyfill.test.ts`（`:582`, `:1040`）
- `packages/webrtc/tests/nonstandard/polyfillTestUtils.ts`
- `integration/werift-mediasoup-interop/test/helpers/{polyfill,session}.ts`
- `integration/werift-mediasoup-interop/test/interop/video.test.ts`
- `docs/polyfill/{README,guide}.md`
- `changelog.md`

## 確定した判断

1. 本チケットの実装スコープは Phase 1〜3。Phase 4（公開型分離・`MediaRegister.sourceCodecs`・`track.codec` 非推奨化・fmtp 厳密化の追加）はフォローアップとする。
2. `peerConnectionConfig` 省略時は wrapper を生成せず、既存の `target.RTCPeerConnection === RTCPeerConnection` を維持する。
3. install config と constructor config の merge は、トップレベルは constructor 優先、`codecs` / `headerExtensions` は kind 単位 replacement。codec / header extension インスタンスは PC ごとに clone する。
4. source codec constraint は `track.codec` ではなく `WeakMap` metadata として保持し、sender への attach 時に capture する。`track.codec` は互換のため残し、negotiated codec の表示に使う。
5. `addTrack` / `addTransceiver` で source ∩ configured が空なら同期 `NotSupportedError`。`setCodecPreferences` は引数検証のみで、互換性エラーは offer/answer 生成時に投げる。
6. `adoptSenderTrackCodec` は削除する（Breaking change）。`findCodecByMimeType` は remote 交渉用に残す。
7. H264 の compatibility は `packetization-mode` / `profile-level-id` を両方指定時のみ比較する。remote SDP 交渉は従来どおり MIME 一致を維持する。
8. `setCodecPreferences` の引数は `RTCRtpCodecParameters[]`、preference 照合は MIME 一致（`clockRate` は双方指定時のみ）とする。`RTCRtpCodecCapability` 型分離は Phase 4。
9. integration fixture は `installInteropPeerConnection` を廃止して `peerConnectionConfig` に置き換え、H264 produce テストは mimeType 一致の source register を選ぶよう修正する。
