# Epic 2: WebRTC DTLS 1.3 opt-in and Chromium interoperability を実施する

- 親 Issue: [shinyoshiaki/werift-webrtc#659](https://github.com/shinyoshiaki/werift-webrtc/issues/659) Epic 2
- 仕様ベース: リポジトリ直下 `epic2-webrtc-dtls13-detailed.md`
- 背景調査: `docs/plan/research-warp.txt`、Epic 1 完了報告 `docs/plan/TICKET-277e0dc5-epic1-final-report.md`
- ベースブランチ: `warp`（worktree `ticket/918602e9-dbe0-43ff-8ac5-ed16b52fd06b`）
- 主対象パッケージ: **`packages/webrtc`**（opt-in / transport / stats / self E2E）と **`e2e/`**（Chromium parameterized interop）
- 前提: Epic 1（`packages/dtls` の DTLS 1.3 endpoint）は完了済み。本 Epic はそれを WebRTC 通常経路へ載せる。

---

## 1. タスクの目的と背景

### 目的

Epic 1 で完成した DTLS 1.3 endpoint を `RTCPeerConnection` から明示 opt-in し、**SPED / ICE-DTLS 並列起動を入れない通常の WebRTC 接続経路**で DTLS 1.3 を成立させる。

維持する接続シーケンス:

```text
SDP negotiation
  → ICE connectivity
  → selected candidate pair
  → DTLS (1.2 or 1.3)
  → SDP fingerprint validation
  → DTLS-SRTP / SCTP
  → DataChannel / RTP / RTCP
```

完了時点で、後続 Epic 3（SPED）・Epic 4（WARP coordinated startup）の障害切り分けが「WebRTC-DTLS 1.3 統合」と「ICE/SPED」に分離できる状態にする。

### 背景（本ワークツリーで確認した現状）

Epic 1 により `packages/dtls` は次を既に持つ。

- `DtlsVersion` / `Options.protocolVersions`（未指定は `[V1_2]`、1.3 は明示 opt-in）
- `[V1_3]` / `[V1_3, V1_2]` / `[V1_2]`、mismatch は `ProtocolVersionError`
- `extractSessionKeys` / `remoteCertificate` は 1.3 engine へ分岐済み
- `addressValidation: "ice-authenticated"` と `peerIdentityMode: "authenticated-single-peer"`
- BoringSSL DTLS 1.3 / OpenSSL DTLS 1.2 / werift self 1.3 が endpoint 層で成立

一方 `packages/webrtc` はまだ DTLS 1.2 固定のままである。

| 箇所 | 現状 | Epic 2 で埋めるギャップ |
| --- | --- | --- |
| `PeerConfig.dtls` | `{ keys?: DtlsKeys }` のみ | `protocolVersions` を追加 |
| `clonePeerConfiguration` | `dtls: { ...config.dtls }` の shallow copy | `protocolVersions` 配列の defensive copy |
| `SecureTransportManager.createTransport()` | `new RTCDtlsTransport(this.config, ...)`。version policy を渡さない | 必要な DTLS 設定だけを伝播 |
| `RTCDtlsTransport.start()` | `DtlsClient`/`DtlsServer` に `protocolVersions` 未指定。既に `addressValidation: "ice-authenticated"` / `peerIdentityMode: "authenticated-single-peer"` は設定済み | **同じ version policy を両 role へ渡す**（ICE 認証モデルは変えない） |
| `formatDtlsVersion()` | `0xfefd` → `"DTLS 1.2"` のみ。入力は `this.dtls?.dtls.version`（1.2 用 `DtlsContext`、既定 `0xfefd`） | 1.3 接続で `"DTLS 1.3"` を返す。`DtlsContext.version` を読んではいけない |
| `dtlsCipher` stats | `this.dtls?.cipher.cipher?.name`（1.2 `CipherContext`）。1.3 engine は未設定 | 1.3 では `TLS_AES_128_GCM_SHA256` |
| `peerConnection.connect()` | `await iceTransport.start(); await dtlsTransport.start();` | **この順序を維持** |
| `e2e/` | Chromium 単一 launch。DTLS version の parameterized ではない。stats で version を assert しない | 1.2/1.3 共通テスト + Chromium field trial 差分を fixture に閉じ込める |

`e2e/server/index.ts` は `export * from "../../packages/webrtc/src"` で **repository-local source** を import している（`e2e/package.json` の published `werift` は本経路では使っていない）。Epic 仕様どおりこの構造を維持する。

### Epic 境界（何をやらないか）

Issue #659 の公式分割に従う。**本チケットは Epic 2 のみ**。

| 対象外 | 担当 |
| --- | --- |
| SPED / DTLS-in-STUN / nomination 前 handshake | Epic 3 |
| ICE / DTLS coordinated startup、external retransmission、ICE RTT と DTLS RTO 同期 | Epic 3/4 |
| SPED L1/L2 queue、early server application data の WebRTC 公開、directional early SRTP、early RTP/RTCP buffer、SNAP | Epic 4 |
| `addressValidation` / `peerIdentityMode` / WarpOptions を WebRTC Public API にする | しない（内部固定） |
| `e2e/package.json` の `werift` dependency を `file:` や `npm pack` に切り替え | しない |

Epic 1 チケット文面の「SPED = Epic 2」は古い番号であり、**Issue #659 と `epic2-webrtc-dtls13-detailed.md` を正とする**。

---

## 2. 実装すべき具体的な機能や変更内容

推奨分割は仕様書 Task A–E。実装もこの順で、各段階でテストを通してから次へ進む。

### 2.1 Task A: WebRTC DTLS version configuration

対象:

- `packages/webrtc/src/peerConnection.ts`
- `packages/webrtc/src/secureTransportManager.ts`
- `packages/webrtc/src/transport/dtls.ts`

#### Public config

`PeerConfig.dtls` に `protocolVersions` を追加する。`DtlsVersion` は `packages/dtls` の既存 enum を re-export して使う（WebRTC 用に別 enum を作らない。既に `packages/webrtc/src/imports/dtls.ts` が `export * from "../../../dtls/src"`）。

```ts
dtls: Partial<{
  keys: DtlsKeys;
  protocolVersions: readonly DtlsVersion[];
}>;
```

利用例:

```ts
new RTCPeerConnection({
  dtls: { protocolVersions: [DtlsVersion.V1_3] },
});

new RTCPeerConnection({
  dtls: {
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
  },
});
```

| 設定 | 動作 |
| --- | --- |
| `dtls: {}` / 未指定 | DTLS 1.2 only（現状互換） |
| `[V1_2]` | DTLS 1.2 only |
| `[V1_3]` | DTLS 1.3 only |
| `[V1_3, V1_2]` | DTLS 1.3 preferred + 1.2 fallback |

追加要件:

- DTLS 1.3 は明示 opt-in。default は 1.2 のまま
- SPED 有無と version selection を独立させる（本 Epic では SPED オプション自体を追加しない）
- `addressValidation` は WebRTC Public API に出さない
- ICE-selected path では内部的に `ice-authenticated` を使い続ける（既に `RTCDtlsTransport.start()` にある）
- `peerIdentityMode` も WebRTC 側では `"authenticated-single-peer"` 固定（既にある）
- `getConfiguration()` / clone / round-trip で `protocolVersions` 配列を defensive copy する

`clonePeerConfiguration` の現状は `dtls: { ...config.dtls }` のため、配列参照が共有される。次のように copy する。

```ts
dtls: {
  ...config.dtls,
  protocolVersions: config.dtls.protocolVersions
    ? [...config.dtls.protocolVersions]
    : undefined,
},
```

`deepMerge`（`setConfiguration`）は実質 top-level 代入である。`setConfiguration({ dtls: { protocolVersions } })` は既存どおり `dtls` オブジェクト全体を置き換える。本 Epic で merge 意味を変えない。opt-in はコンストラクタ引数を主経路とする。

#### 伝播

`RTCDtlsTransport` に `PeerConfig` 全体を渡す現状を、必要な DTLS 設定だけに寄せる。

```ts
interface DtlsTransportConfig {
  debug?: DebugConfig;
  protocolVersions?: readonly DtlsVersion[];
}
```

`SecureTransportManager.createTransport()`:

```ts
const dtlsTransport = new RTCDtlsTransport(
  {
    debug: this.config.debug,
    protocolVersions: this.config.dtls.protocolVersions,
  },
  iceTransport,
  this.certificate,
  srtpProfiles,
);
```

既存テストの `new RTCDtlsTransport(defaultPeerConfig, ...)` は `debug` を持つため互換を維持できる。`protocolVersions` は `defaultPeerConfig.dtls` には置かず、opt-in 時だけ `DtlsTransportConfig` 経由で渡す。

`RTCDtlsTransport.start()` で client / server の両方へ同じ policy を渡す。

```ts
new DtlsClient({
  cert, key, signatureHash, transport, srtpProfiles,
  extendedMasterSecret: true,
  protocolVersions: this.config.protocolVersions,
  addressValidation: "ice-authenticated",
  peerIdentityMode: "authenticated-single-peer",
});
```

server も同じ。既存の `certificateRequest: true`（server）は残す。

必須:

- 両 role に同じ version policy
- `[V1_3]` で 1.3 engine、未指定で 1.2 engine
- `[V1_3, V1_2]` は peer capability に応じて選択（選択ロジックは dtls 層の既存 `selectVersion` / dual association）
- ICE transport の認証モデルを変えない（`IceTransport.peerAuthenticated = true` を維持）
- `start()` の開始タイミングを変えない（ICE 完了後。client の既存 100ms delay も触らない）

### 2.2 Task B: DTLS 1.3 WebRTC transport integration

対象: `transport/dtls.ts`、stats、SRTP setup。handshake 完了後の一括 SRTP/SRTCP 構築を維持する。

#### Fingerprint

既存順序を変えない。

```text
DTLS handshake complete (onConnect)
  → remote certificate available
  → SDP fingerprint validation
  → SRTP start
  → state = connected
```

異常系: mismatch → `RTCDtlsTransport = failed`、`dtls.close()`、SCTP を open しない、RTP/RTCP を application へ出さない。既存 `verifyRemoteCertificateFingerprint()` を 1.3 でも使う。`remoteCertificate` getter は 1.3 engine 分岐済みなので、handshake さえ通れば追加の fingerprint アルゴリズム実装は不要な見込み。1.3 経路で `remoteCertificate` が空なら root cause を dtls 側で直す（catch-and-ignore 禁止）。

#### DTLS-SRTP

Epic 1 の `EXTRACTOR-dtls_srtp` を既存 `updateSrtpSession()` に接続する。`extractSessionKeys` は既に `engine13` 分岐済み。Epic 2 で確認すること:

- `use_srtp` negotiation
- selected SRTP profile 一致（既存 prefer `SRTP_AEAD_AES_128_GCM` then `SRTP_AES128_CM_HMAC_SHA1_80`）
- client write = server read、その逆
- RTP / RTCP 双方向
- SRTP authentication failure は drop（既存 `SrtpAuthenticationError` 処理を維持）
- 1.2 SRTP 経路の regression なし

early SRTP readiness / fingerprint 前 media queue は実装しない。

#### Stats

`formatDtlsVersion(this.dtls?.dtls.version)` は **1.3 では誤って `"DTLS 1.2"` になる**。`DtlsContext.version` は 1.2 engine 用で `{ major: 254, minor: 253 }` 固定だからである。

推奨（dtls Public API を増やしすぎない）:

```ts
function formatDtlsVersion(socket?: DtlsSocket) {
  if (!socket) return;
  if (socket.isDtls13) return "DTLS 1.3";
  const version = socket.dtls.version;
  if (version.major === 0xfe && version.minor === 0xfd) return "DTLS 1.2";
  if (version.major === 0xfe && version.minor === 0xff) return "DTLS 1.0";
}

function formatDtlsCipher(socket?: DtlsSocket) {
  if (!socket) return;
  if (socket.isDtls13) return "TLS_AES_128_GCM_SHA256";
  return socket.cipher.cipher?.name;
}
```

1.3 の必須 cipher は現状 `TLS_AES_128_GCM_SHA256 (0x1301)` のみ。stats は接続成功の間接判定を禁止し、self E2E / browser E2E の両方で negotiated version を明示 assert する。

werift stats は人間可読 `"DTLS 1.3"`。Chromium `getStats()` の `tlsVersion` は hex `"FEFC"` / `"FEFD"`。両者を混同しない。

### 2.3 Task C: werift ↔ werift WebRTC E2E

新規: `packages/webrtc/tests/integrate/dtls13.test.ts`

共通 Arrange は `packages/webrtc/tests/fixture.ts` と `tests/utils.ts`（`createDataChannelPair` / offer-answer 交換）へ集約し、テストファイル間で複製しない。Act / Assert には日本語コメントを付ける。

#### Version matrix

| Case | Peer A | Peer B | Expected |
| --- | --- | --- | --- |
| 1 | `[V1_3]` | `[V1_3]` | DTLS 1.3 |
| 2 | `[V1_3, V1_2]` | `[V1_3]` | DTLS 1.3 |
| 3 | `[V1_3, V1_2]` | `[V1_2]` | DTLS 1.2 |
| 4 | `[V1_2]` | `[V1_2]` | DTLS 1.2 |
| 5 | `[V1_3]` | `[V1_2]` | `ProtocolVersionError`（timeout を合格にしない） |

成功ケースで確認:

- handshake、negotiated version（stats `tlsVersion`）、cipher、DTLS role
- fingerprint authentication
- DataChannel ping/pong（複数メッセージ順序）
- RTP 双方向、RTCP send/receive
- SRTP profile、connection state、close

#### JSEP / DTLS role

offerer/answerer だけでなく、実際の DTLS client/server の両方向を含める。

既定（現行コード）:

- offer SDP: `a=setup:actpass`（`role === "auto"`）
- answer SDP: `sdpManager` が `role === "auto"` なら **常に `client`（`setup:active`）**
- answer 適用時、offerer は remote role の逆（answerer=client → offerer=server）

つまり既定は **offerer = DTLS server / answerer = DTLS client**。

逆方向（offerer = DTLS client / answerer = DTLS server）は Public API を増やさず、テストから answer 前に `dtlsTransport.role = "server"`（`setup:passive`）を設定するか、offer 側を `role = "client"`（`setup:active`）にする。

#### ICE restart

現行 `connect()` は `dtlsTransport.state === "connected"` なら **DTLS を再 start しない**。JSEP 上 ICE restart は DTLS 再 handshake を必須としない。既存 e2e `tests/ice/restart.test.ts` も DTLS 再利用前提。

Epic 文言の「新しい DTLS association」は、**新 ICE pair 上で期待バージョンの DTLS が DataChannel/media に使えること**と解釈する。DTLS 再 handshake を強制すると既存 ICE restart 回帰を壊す。本 Epic では:

- ICE restart 後も期待 DTLS version のまま DataChannel / media が使える
- SPED state reset は対象外
- `RTCDtlsTransport.start()` が `state === "new"` 以外で throw する既存制約を、restart のために緩めない

#### Default regression

```ts
const pc = new RTCPeerConnection();
```

は DTLS 1.2（`tlsVersion === "DTLS 1.2"`）。opt-in なしで FEFC にならないこと。

fingerprint mismatch は既存 `tests/transport/dtls.test.ts` に 1.2 がある。1.3 でも同等ケースを追加する（handshake 成功後に mismatch → failed、SCTP/media 非公開）。

### 2.4 Task D: Browser E2E parameterization

Browser E2E は DTLS 1.3 専用ファイルを複製しない。**signaling / ICE / media ロジックを共有**し、version 差分は launch/config と werift `protocolVersions` に閉じ込める。

禁止する構造:

```text
datachannel-dtls12.test.ts
datachannel-dtls13.test.ts
```

推奨:

```text
e2e/tests/dtls/
  fixture.ts
  datachannel.test.ts
  media.test.ts
  fingerprint.test.ts
```

既存 `datachannel` / `mediachannel` / `bundle` / `turn` スイート全体を 1.3 で二重実行しない。既存スイートは **DTLS 1.2 default regression** として残す。

Vitest browser `instances` に 1.3 用 Chromium を足すと **全 e2e が二重実行**される。そのため:

- 既存 `e2e/vitest.config.mts` は現状のまま（1.2 default regression）
- DTLS parameterized 用に **別 vitest project / config**（例: `e2e/vitest.dtls.config.mts`）を追加し、`tests/dtls/**` だけを走らせる
- Chromium mode ごとに project を分ける（launch args はプロセス単位）

共通 case model（仕様どおり）:

```ts
type BrowserDtlsTestCase = {
  name: string;
  weriftVersions: readonly DtlsVersion[];
  chromiumMode: "dtls12" | "dtls13";
  expectedWeriftVersion: "DTLS 1.2" | "DTLS 1.3";
  expectedChromiumVersion: "FEFD" | "FEFC";
};
```

最低 matrix:

| Case | werift | Chromium | Expected |
| --- | --- | --- | --- |
| DTLS 1.2 baseline | `[V1_2]` | DTLS 1.2 | FEFD |
| DTLS 1.3 opt-in | `[V1_3]` | DTLS 1.3 only | FEFC |
| 1.3 preferred | `[V1_3, V1_2]` | DTLS 1.3 only | FEFC |
| 1.2 fallback | `[V1_3, V1_2]` | DTLS 1.2 only | FEFD |

Chromium 差分は helper に集約する。仕様の例:

```text
DTLS 1.3: WebRTC-ForceDtls13/Only/
SPED 無効: WebRTC-IceHandshakeDtls/Disabled/
```

Playwright 起動例:

```text
--force-fieldtrials=WebRTC-ForceDtls13/Only/WebRTC-IceHandshakeDtls/Disabled/
```

**実装時に現行 Chromium revision で field trial 名と挙動を実測して helper にピンする。** `WebRTC-ForceDtls13` の登録 end date は 2024-09-01 であり、Playwright / システムの Chrome では trial が消えている、または DTLS 1.3 が default max になっている可能性がある。1.2-only 固定の手段が見つからない場合は、その revision で実際に negotiated される version を stats で確認し、helper に「使ったフラグと実測結果」をコメントする。未確認のまま接続成功だけで pass にしない。

werift 側 version は protoo request payload（または server の env）で `peerConfig` に載せる。`e2e/server/fixture.ts` の `peerConfig` は現状 `dtls: { keys }` のみ。handler が `protocolVersions` を受け取れるようにする。既存 handler の default は 1.2 のまま（keys のみ）とし、全既存 e2e を変えない。

`e2e/package.json` の `werift` dependency はこの目的では変更しない。source import（`e2e/server/index.ts`）を維持する。

### 2.5 Task E: Chromium interoperability

DTLS 1.2 / 1.3 の双方で:

```text
Chromium offerer → werift answerer
werift offerer   → Chromium answerer
```

これにより offerer/answerer と DTLS client/server の両側を browser 経路でも検証する（Chromium answerer は通常 `setup:active` = DTLS client）。

#### DataChannel

同一 test logic を 1.2/1.3 で実行。

- DataChannel open
- Chromium → werift `ping`、werift → Chromium `pong`
- negotiated DTLS version（双方 stats）
- fingerprint validation
- SCTP association success

#### Media

DataChannel だけでは完了としない。

- Chromium fake audio/video → werift decrypt → RTP receive（packet count > 0、SSRC/PT、version）
- werift RTP → Chromium inbound-rtp `packetsReceived > 0`
- RTCP: 少なくとも片方向（werift が Chromium RTCP を受信、または Chromium remote-inbound / RTT）

既存 `waitVideoPlay` を再利用してよいが、**version assert を必ず付ける**。

#### Fingerprint failure

```text
DTLS 1.2 + fingerprint mismatch → failed
DTLS 1.3 + fingerprint mismatch → failed
```

確認: DataChannel が open しない、RTP を application へ出さない、`RTCDtlsTransport.state` が `connected` にならない、failure reason が診断可能。

接続成功だけでは pass にしない。

- DTLS 1.2: werift `"DTLS 1.2"` / Chromium `"FEFD"`
- DTLS 1.3: werift `"DTLS 1.3"` / Chromium `"FEFC"`

### 2.6 ドキュメント

Public API を変えるため、少なくとも次を更新する。

- `packages/webrtc/README.md`: DTLS 1.3 opt-in 例と「default は 1.2、SPED とは独立」
- Typedoc が追従するなら `npm run doc` / `npm run doc:check`（`PeerConfig.dtls`）
- e2e helper に Chromium field trial / 実測 revision を記載
- `packages/webrtc/AGENTS.md` は scripts が増えたときだけ更新

WARP 全体説明の完成は Epic 5 でも可だが、Epic 2 の使い方は README に最低限書く。

---

## 3. 技術的な実装アプローチ（調査結果サマリ）

### 3.1 推奨実装順序

仕様書 E2-1〜E2-11 に対応する。

1. **E2-1/E2-2/E2-3** Public config → SecureTransportManager → `DtlsClient`/`DtlsServer` 伝播。default 1.2 の既存 `tests/transport/dtls.test.ts` / integrate を先に通す。
2. **E2-4** stats（`isDtls13` で FEFC/`DTLS 1.3`、cipher 名）。接続成功の間接判定を禁止する土台。
3. **E2-5** fingerprint + DTLS-SRTP。既存 `start()` 順序を維持したまま 1.3 handshake を通す。
4. **E2-6/E2-7** werift self DataChannel / RTP/RTCP + version/role matrix。
5. **E2-8** browser E2E を別 vitest project で parameterized。
6. **E2-9/E2-10** Chromium DataChannel / media（1.2 と 1.3）。
7. **E2-11** fallback / mismatch / fingerprint / ICE restart regression。
8. Epic 1 の dtls self / BoringSSL / OpenSSL を回帰確認。

### 3.2 現行コードを再利用する判断

| 再利用（触らない / 薄い接続） | 本 Epic で新規 |
| --- | --- |
| `DtlsClient`/`DtlsServer` + `protocolVersions` + dual fallback | `PeerConfig.dtls.protocolVersions` と defensive copy |
| `extractSessionKeys` の 1.3 分岐、`use_srtp` | WebRTC 経路での profile/key 方向の E2E assert |
| `remoteCertificate` 1.3 分岐、既存 fingerprint matcher | 1.3 での mismatch テスト |
| `addressValidation: "ice-authenticated"`（既に start にある） | 設定を Public API に出さない |
| `IceTransport.peerAuthenticated`、`isDtls()` demux（20–63） | ICE→DTLS 順序の維持 |
| `createDataChannelPair` / `dtlsTransportPair` / media integrate | `tests/integrate/dtls13.test.ts` の matrix |
| `e2e/server/index.ts` の source re-export、protoo signaling | `e2e/tests/dtls/*` + Chromium launch helper |
| 既存 `e2e/vitest.config.mts` の 1.2 regression | 別 vitest config で 1.3 project を分離 |

dtls エンジン内部（`engine/v1_3`、carrier、ACK、KeyUpdate）は **WebRTC 統合のバグが dtls 側 root cause のときだけ**直す。WebRTC 層で version を再実装しない。

### 3.3 stats の読み取り口

`DtlsSocket.isDtls13` は既に public。`engine13.negotiatedVersion` は engine 内部。WebRTC stats は `isDtls13` で足りる。cipher も 1.3 は suite が 0x1301 固定なので、socket に新 Public getter を足す必要は原則ない。後で suite が増えるなら dtls 側に `cipherSuiteName` を足してもよいが、Epic 2 の完了条件ではない。

### 3.4 Chromium / SPED

- `WebRTC-IceHandshakeDtls` は SPED（DTLS-in-STUN）。`IsEnabled()` なので **未指定でも default off**。Epic 2 では明示 `Disabled/` を付け、SDP に `ice-option: goog-sped-v1` が出ないことを必要なら確認する。
- `WebRTC-ForceDtls13/Enabled/` は max=1.3（1.2 互換残）、`/Only/` は min=max=1.3。1.3-only ケースは `Only/` を使う。
- 1.2-only Chromium は revision 依存。helper に実測を固定する。

Issue #659 は「pinned Chromium」。既存 e2e は Playwright browsers + `ensure-browser.js`（root `scripts/install-playwright-browsers.js`）。**新しい Chromium 配布パイプラインは作らない。** Playwright の pin を完了条件の再現手段とし、helper に実行 Chromium の確認方法を書く。

### 3.5 JSEP role と ICE controlling

`RTCDtlsTransport.start()` の auto role は ICE controlling → DTLS server。`setLocalRole` は offerer を ICE controlling にする。answer の `setup:active` で offerer は DTLS server に確定する。browser E2E の両 offerer 方向で、werift は自然に client と server の両方になる。self E2E の逆 role だけテストから `role` を固定する。

### 3.6 失敗の扱い

`RTCDtlsTransport.start()` は既に `onError` → `failed`。`ProtocolVersionError` は dtls が `onError` に載せる。WebRTC 側で timeout 待ちにしない。case 5 は `connectionState === "failed"` / `dtlsState === "failed"` と error 内容（`protocol_version`）を assert する。

---

## 4. 考慮すべき制約や注意点

### プロトコル / セキュリティ

- fingerprint validation 前に `connected` にしない。既存 `start()` の順序を崩さない。
- fingerprint 前に application data / media を公開しない。1.3 の epoch-3 early app data は dtls 内部バッファ（`maxEarlyAppDataRecords`）に留まり、`onConnect` 前の `onData` を WebRTC が SCTP/RTP に流さないこと。Epic 2 では early delivery を実装しない。
- CID / PSK 0-RTT / SNAP / SPED を有効化しない。

### 互換

- default `new RTCPeerConnection()` は DTLS 1.2。既存 integrate / e2e / WPT を 1.3 既定にしない。
- `packages/dtls` の dual normalize（`[V1_2, V1_3]` → `[V1_3, V1_2]`）に WebRTC 層で逆の順序意味を持たせない。
- ICE restart で DTLS を作り直さない（§2.3）。
- client `connect()` 前の 100ms delay は既存挙動。本 Epic のスコープ外。
- `e2e/package.json` の `werift` をこの目的で変えない。

### テスト規約（root `AGENTS.md`）

- Arrange / Act / Assert。
- 再利用 Arrange は単一 utility（`packages/webrtc/tests/fixture.ts` / `tests/utils.ts`、`e2e/tests/dtls/fixture.ts`）。
- Act / Assert に日本語コメント。
- 失敗を catch-and-ignore しない。version mismatch を timeout 合格にしない。

### 検証コマンド

パッケージ優先。

```bash
cd packages/webrtc && npm run type && npm test
cd packages/dtls && npm run type && npm test
```

| コマンド | 用途 |
| --- | --- |
| `cd packages/webrtc && npm run type && npm test` | WebRTC unit / integrate（dtls13.test.ts 含む） |
| `cd packages/dtls && npm run type && npm test` | Epic 1 回帰 |
| `cd packages/dtls && npm run test:boringssl` | BoringSSL DTLS 1.3 回帰 |
| `npm run install:browsers`（repo root、初回） | Playwright Chromium |
| `npm run e2e` / parameterized dtls e2e | Chromium interop |
| `npm run doc:check` | `PeerConfig` / Typedoc 表面が変わったとき |
| `npm run test:small` | webrtc 以外へ波及したとき |

Browser E2E は `npm run install:browsers` のあと、既存 e2e と dtls parameterized の両方を対象にする。インフラ依存パスは既存どおり opt-in flag があればそれを使う。

### スコープ漏れ防止

- `packages/ice` に SPED attribute を入れない。
- `external` retransmission を WebRTC から有効化しない。
- `DtlsInternalOptions` / carrier を `packages/webrtc/src` の安定 API に出さない（dtls `index.ts` も内部のまま）。
- 既存 e2e 全件の 1.3 二重実行で CI 時間を溶かさない。

### 実装時に小さく決めてよいこと

| 項目 | 推奨デフォルト |
| --- | --- |
| `protocolVersions` 未指定 | dtls 層の default（`[V1_2]`）。WebRTC は渡さない |
| 1.3 stats cipher 文字列 | `"TLS_AES_128_GCM_SHA256"` |
| 逆 DTLS role の出し方 | テストから `RTCDtlsTransport.role` を SDP 前に設定。Public config は増やさない |
| Chromium 1.2-only フラグ | 実装時に実測して `e2e/tests/dtls/fixture.ts` にピン |
| ICE restart | 既存 association 継続 + version/media assert |

### リスク

1. **stats の読み取り口を間違えると 1.3 E2E が全部偽陽性/偽陰性になる。** 最初に `isDtls13` 経路の unit を書く。
2. **Chromium field trial が revision で消えている。** helper に実測を残し、assert は stats の `FEFC`/`FEFD` を正とする。
3. **Vitest browser instances の安易な追加で既存 e2e が倍増する。** 別 config / 別 include glob を使う。
4. **fingerprint 前の 1.3 early data。** WebRTC は `onConnect` 後にだけ `dataReceiver` / SRTP を進める現状を維持する。

---

## 5. 完了条件

仕様書 §22 を実装チケット向けに再掲する。チェックは実装完了時に埋める。

### Public API / compatibility

- [ ] `packages/webrtc` から `[DtlsVersion.V1_3]` を明示 opt-in できる
- [ ] `[DtlsVersion.V1_3, DtlsVersion.V1_2]` を指定できる
- [ ] opt-in なしでは DTLS 1.2 のまま
- [ ] DTLS version selection と SPED が独立している（本 Epic で SPED を追加・有効化していない）
- [ ] config clone / `getConfiguration()` round-trip で `protocolVersions` 配列を defensive copy している
- [ ] 既存 ICE → DTLS sequential startup を変更していない
- [ ] `addressValidation` / `peerIdentityMode` を WebRTC Public API に出していない
- [ ] `DtlsVersion` を WebRTC 用に複製していない

### werift ↔ werift

- [ ] DTLS 1.3 が両 DTLS role で成立する
- [ ] DTLS 1.3 only が成立する
- [ ] DTLS 1.3 preferred + DTLS 1.2 fallback が成立する
- [ ] DTLS 1.3 only vs DTLS 1.2 only が protocol-version error になる（timeout ではない）
- [ ] DataChannel が双方向に通る
- [ ] RTP が双方向に通る
- [ ] RTCP が双方向に通る
- [ ] DTLS 1.3 exporter から SRTP / SRTCP session が構築される
- [ ] fingerprint mismatch が WebRTC 接続を失敗させる
- [ ] ICE restart 後も期待 DTLS version で DataChannel / media が使える
- [ ] werift stats が `tlsVersion === "DTLS 1.3"`（1.3 時）/ `"DTLS 1.2"`（1.2 時）を返す
- [ ] 1.3 成功時 `dtlsCipher === "TLS_AES_128_GCM_SHA256"` を assert できる

### Browser E2E structure

- [ ] Browser E2E harness が DTLS version parameterized になっている
- [ ] DTLS 1.2 と 1.3 が同じ test implementation を共有する
- [ ] 1.2/1.3 用に signaling / media テストファイルを複製していない
- [ ] Chromium launch の version 差分を helper / fixture に集約している
- [ ] Epic 2 browser test で SPED を無効化している
- [ ] repository-local werift source import を維持している
- [ ] `e2e/package.json` の werift dependency をこの目的では変更していない
- [ ] 既存 e2e 全件を 1.3 で二重実行していない

### Chromium interoperability

- [ ] Chromium offerer → werift answerer を DTLS 1.2 で確認
- [ ] Chromium offerer → werift answerer を DTLS 1.3 で確認
- [ ] werift offerer → Chromium answerer を DTLS 1.2 で確認
- [ ] werift offerer → Chromium answerer を DTLS 1.3 で確認
- [ ] DTLS 1.2 で Chromium `tlsVersion === "FEFD"`
- [ ] DTLS 1.3 で Chromium `tlsVersion === "FEFC"`
- [ ] werift 側も `DTLS 1.2` / `DTLS 1.3` を stats で確認
- [ ] DataChannel が DTLS 1.2 / 1.3 双方で双方向
- [ ] RTP が DTLS 1.2 / 1.3 双方で通る
- [ ] RTCP 経路が DTLS 1.2 / 1.3 双方で成立する
- [ ] fingerprint mismatch を DTLS 1.2 / 1.3 双方で拒否する
- [ ] `[V1_3, V1_2]` × Chromium DTLS 1.3 で DTLS 1.3 が選択される
- [ ] `[V1_3, V1_2]` × Chromium DTLS 1.2 で DTLS 1.2 fallback が成立する

### Regression

- [ ] Epic 1 の DTLS 1.3 self tests が成功する（`cd packages/dtls && npm test`）
- [ ] BoringSSL DTLS 1.3 interop が成功する（`npm run test:boringssl`）
- [ ] OpenSSL DTLS 1.2 interop が成功する（dtls 既存 e2e）
- [ ] DTLS 1.2 WebRTC browser E2E に regression がない（既存 `npm run e2e`）
- [ ] default WebRTC behavior に regression がない（`cd packages/webrtc && npm test`）

### 検証実行

- [ ] `cd packages/webrtc && npm run type && npm test`
- [ ] `cd packages/dtls && npm run type && npm test`
- [ ] 必要なら workspace `npm run type` / `npm run test:small`
- [ ] parameterized Chromium E2E が成功
- [ ] Public API / Typedoc 変更時は `npm run doc:check`

### ドキュメント

- [ ] `packages/webrtc` 近傍に DTLS 1.3 opt-in と default 1.2 が記載されている
- [ ] Chromium field trial / 確認方法が e2e helper または近傍 docs にある

---

## 参考

- Issue #659 Epic 2: WebRTC DTLS 1.3 opt-in and Chromium interoperability
- `epic2-webrtc-dtls13-detailed.md`
- `docs/plan/research-warp.txt`
- [RFC 9147](https://www.rfc-editor.org/rfc/rfc9147.html) / [RFC 8446](https://www.rfc-editor.org/rfc/rfc8446.html) / [RFC 5764](https://www.rfc-editor.org/rfc/rfc5764.html)
- JSEP DTLS role: RFC 9429
- 現行実装: `packages/webrtc/src/{peerConnection,secureTransportManager,transport/dtls}.ts`
- 現行 dtls 入口: `packages/dtls/src/{socket,client,server,index}.ts`（`DtlsVersion`, `isDtls13`, `extractSessionKeys`）
- 現行 self tests: `packages/webrtc/tests/{fixture,utils,integrate,transport/dtls.test}.ts`
- 現行 browser E2E: `e2e/{vitest.config.mts,server/index.ts,server/fixture.ts,tests}`
