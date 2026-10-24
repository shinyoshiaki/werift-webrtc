# RTCPeerConnection should not implicitly use Google STUN when iceServers is empty or TURN-only

## 1. 目的と背景

### 問題

werift は、アプリケーションが STUN URL を明示しないと `stun.l.google.com:19302` を暗黙に使う。TURN のみの `RTCConfiguration.iceServers` を設定した場合も同じ（`werift@0.25.1` で再現する）。

```ts
new RTCPeerConnection();                       // Google STUN を使う
new RTCPeerConnection({ iceServers: [] });     // Google STUN を使う
new RTCPeerConnection({                        // TURN に加えて Google STUN も使う
  iceServers: [{ urls: "turn:turn.example.com:3478", username: "u", credential: "p" }],
});
```

- 下流での確認: Georgetown MDI / Alcove PR #2331 (https://github.com/georgetown-mdi/alcove/pull/2331)。実際の DNS lookup 経路をフックし、TURN のみの設定でも `stun.l.google.com` が名前解決されることを確かめている。
- 関連 issue: #755（STUN/TURN URL を複数指定すると 2 件目以降が黙って無視される問題）。原因は同じ `parseIceServers` 周辺だが、別の問題として扱う。

### 仕様との差異

- W3C WebRTC: `RTCConfiguration.iceServers` の既定値は空シーケンス `[]` (https://www.w3.org/TR/webrtc/#dom-rtcconfiguration-iceservers)
- JSEP (RFC 8829 §4.1.1): PeerConnection は **アプリケーションが指定した** STUN/TURN サーバを使う (https://www.rfc-editor.org/rfc/rfc8829.html#section-4.1.1)

### 影響

- アプリケーションが設定していない Google へ DNS / STUN の通信が発生する
- 設定していないサーバにパブリック IP やセッションのメタデータが渡る
- TURN のみの構成やプライバシー重視の構成で、意図したポリシーを表現できない
- host 候補だけで動かすには、到達不能な STUN をわざと指定して、そのタイムアウト（既定 5 秒）を待つしかない

コンテンツの漏洩ではなく、CVE 扱いもしない。設定・プライバシー・仕様互換性の問題である。

## 2. 調査結果: Google STUN を注入している箇所

暗黙の注入は **2 層** にある。片方だけ直しても解決しない。

| # | 場所 | 内容 | 該当ケース |
|---|------|------|-----------|
| A | `packages/webrtc/src/api/peerConfig.ts` `generateDefaultPeerConfig()`（215 行目付近） | `iceServers: [{ urls: "stun:stun.l.google.com:19302" }]` が既定値 | `new RTCPeerConnection()`（`iceServers` 未指定）。`getConfiguration().iceServers` も Google STUN を返す |
| B | `packages/ice/src/ice.ts` `DEFAULT_STUN_SERVER`（44 行目）と `applyStunTurnServersFromOptions()`（173 行目付近） | `validateAddress(options.stunServer) ?? DEFAULT_STUN_SERVER` | `iceServers: []` と TURN のみの構成。`parseIceServers` が `stunServer: undefined` を返すと B で補われる。constructor と `setIceServers()`（`setConfiguration` / ICE restart の経路）の両方で通る |
| C | `packages/ice/src/utils.ts` `getGlobalIp()`（24 行目） | 引数を省略すると `["stun.l.google.com", 19302]` を使う | `werift-ice` の単体ユーティリティ。RTCPeerConnection の経路では使われない |

### 関連する処理の流れ

```
RTCPeerConnection(config)
  └ mergePeerConfiguration(defaultPeerConfig, config)       // A: iceServers 未指定なら Google STUN が残る
      └ deepMerge: undefined の値は上書きしない。[] は配列ごと置き換わる
SecureTransportManager.resolveIceServerOptions()          // packages/webrtc/src/secureTransportManager.ts:104
  └ parseIceServers(config.iceServers)                     // packages/webrtc/src/utils.ts:113
      → { stunServer?: Address, turnServer?: Address, ... }  // STUN が無ければ stunServer: undefined
  └ new RTCIceGatherer(options) → new Connection(false, options)
      └ applyStunTurnServersFromOptions()                  // B: undefined → DEFAULT_STUN_SERVER
setConfiguration({ iceServers })                           // peerConnection.ts:496
  └ secureManager.updateIceServers()
      └ gatheringState === "new" なら iceTransport.setIceServers(), それ以外は deferIceServers()（次の ICE restart で適用）
          └ Connection.setIceServers() → applyStunTurnServersFromOptions()  // B
```

### `stunServer` が無い場合の既存処理（変更不要の見込み）

- `Connection.gatherCandidates`（`ice.ts:1108` 付近）は `if (... && stunServer)` で srflx 収集を丸ごと飛ばす。STUN の待ち（`stunGatherTimeout`）も発生しない。
- TURN の収集（`ice.ts:1179` 付近）は `turnServer && turnUsername && turnPassword` を条件にしており、STUN とは独立している。
- `Connection.gathersFromServers`（`ice.ts:801`）は `!!stunServer || !!turnServer` を返す。webrtc 側の `stagedGatherPending()`（`packages/webrtc/src/transport/ice.ts:234`）がこれを参照する。修正後は `iceServers: []` で `false` になる（意図どおりだが、ICE restart の staged 処理に影響が出ないかテストで確認する）。

## 3. 実装内容

### 3.1 webrtc 層（必須）

1. **`generateDefaultPeerConfig()` の `iceServers` 既定値を `[]` にする**（A を除去）
   - `getConfiguration().iceServers` が既定で `[]` を返すようになり、W3C の既定値と一致する。
2. **RTCPeerConnection の経路で Google STUN が補われないようにする**（B の除去）
   - §3.2 で ice 層の補完そのものを廃止するので、webrtc 層で新しいフラグを渡す必要はない。`resolveIceServerOptions()` は今と同じく `stunServer: undefined` を渡せばよい（§4 の決定事項を参照）。
   - constructor（`createTransport` → `new RTCIceGatherer`）、`setConfiguration` → `updateIceServers` → `setIceServers`、`deferIceServers` → ICE restart 時の `setIceServers` の **3 経路すべて** で同じ意味になることをテストで確かめる。
3. Google STUN を使い続けたい利用者は、`iceServers: [{ urls: "stun:stun.l.google.com:19302" }]` を明示的に指定して使う（オプトイン）。専用の非標準フラグは基本的に追加しない（必要なら別チケットで検討）。

### 3.2 ice 層（決定: 補完を廃止する。`werift-ice` の破壊的変更）

1. `packages/ice/src/ice.ts`
   - 定数 `DEFAULT_STUN_SERVER` とそのコメントを削除する。
   - `applyStunTurnServersFromOptions()` を `this.stunServer = validateAddress(this.options.stunServer);` に変える。JSDoc の「default identically」を「`stunServer` を省略したら STUN を使わない」という説明に直す。
2. `packages/ice/src/iceBase.ts` の `IceOptions.stunServer`（289 行目）に JSDoc を付ける: 「省略した場合は STUN を使わず、srflx 候補を収集しない。既定の公開 STUN サーバは無い」。
3. テストの回避コードを片付ける（既定値をなくせば不要になる）
   - `packages/ice/tests/utils.ts` の `createTestConnection()` で、直後に `connection.stunServer = options.stunServer;` を代入して既定値を打ち消している行を削除する。
   - `packages/ice/tests/ice/consent-restart.test.ts:25,27` の `a.stunServer = undefined` / `b.stunServer = undefined` を削除する。
4. `getGlobalIp()`（C）は変更しない。「公開 IP を STUN で問い合わせる」と明示的に呼ぶユーティリティであり、`Connection` の暗黙の通信とは性質が違うため。ただし JSDoc に「`stunServer` を省略すると `stun.l.google.com:19302` を使う」と明記する。
5. バージョン: `werift-ice` は 0.x なので、破壊的変更は minor を上げて `0.2.3` → `0.3.0` とする。`werift` 本体も既定の挙動が変わるので minor を上げる（`0.25.x` → `0.26.0`）。実際のリリース作業はこのチケットの対象外とし、CHANGELOG に方針を書くまでにとどめる。

### 3.3 ドキュメント・CHANGELOG

- `changelog.md` の `## Unreleased` → `### ⚠️ Breaking changes` に次の 2 項目を追記する。
  - **`werift`**: `iceServers` を指定しない場合、`[]` の場合、TURN のみの場合に、Google STUN を暗黙に使わなくなった。`getConfiguration().iceServers` の既定値も `[]` になった。移行方法: 従来の挙動に戻すには `iceServers: [{ urls: "stun:stun.l.google.com:19302" }]` を明示する。
  - **`werift-ice`**: `Connection` は、`stunServer` を省略したときに `stun.l.google.com:19302` で補わなくなった。`setIceServers({ stunServer: undefined })` も STUN なしを意味する。移行方法: `stunServer: ["stun.l.google.com", 19302]` を明示する。
  - あわせて `### 📦 Packaging / versions` に、§3.2 で決めたバージョンの方針を書く。
- `PeerConfig.iceServers` / `RTCConfiguration.iceServers` の JSDoc に既定値 `[]` を明記する（`npm run doc` で `doc/interfaces/PeerConfig.md` などを再生成する）。
- `docs/browser-api-compatibility.md` の `RTCConfiguration` の項目に、既定値の扱いが W3C に準拠したことを必要に応じて追記する。
- `website/docs/doc1.md` に古い `iceConfig: { stunServer: [...] }` の記述がある。今回の対象外だが、ついでに直すかどうか判断する。
- 外部ネットワーク越しに疎通する examples（ブラウザとの接続で srflx が要るもの）は `iceServers` を明示する。`iceServers` 指定なしの `new RTCPeerConnection(` を含む examples は約 72 ファイルあるが、多くはローカル（localhost / LAN）で host 候補だけで足りる。`examples/e2e` カタログに入っているデモへの影響は `npm run examples:e2e` で確認する。

## 4. 技術的な方針

### 決定事項: ice 層の既定値を廃止する（方針 1 を採用）

| 方針 | 内容 | 判定 |
|------|------|------|
| **1. ice 層の既定値を廃止** | `DEFAULT_STUN_SERVER` を削除し、`stunServer` を省略したら STUN なしにする | **採用** |
| 2. ice 層に既定値を残し、オプトアウトを追加 | `IceOptions` に `useDefaultStunServer?: boolean` か `stunServer: null` を追加し、webrtc 層は常にオプトアウトする | 不採用 |

採用の根拠（コードベースの調査結果）:

1. **`stunServer: undefined` は既に「STUN なし」の意味で使われていて、既定値はそれと矛盾している。**
   - `packages/ice/tests/utils.ts` の `createTestConnection()` は、構築した直後に `connection.stunServer = options.stunServer` を代入して既定値を打ち消している。
   - `consent-restart.test.ts:25,27` も「外部 STUN 不要」として `a.stunServer = undefined` を手で代入している。
   - `turn.test.ts`、`turn-late-candidate.test.ts`、`pion-turn.integration.test.ts`、`ice.test.ts:808,881`、`setIceServers.test.ts` は `stunServer: undefined` を明示して渡しているが、実際は Google STUN に置き換わっている。
   - webrtc 層の `setIceServers()` のコメントも、「サーバ関連のフィールドは undefined でも明示的に代入して置き換える（W3C の setConfiguration は置き換えで、マージしない）」としている。undefined を既定値に戻すのはこの意図と食い違う。
2. **プライバシー上の問題は `werift-ice` を直接使う利用者にも同じようにある。** webrtc 層だけを直して ice 層に暗黙の外部通信を残すと、問題が半分しか解決しない。
3. **方針 2 は状態と経路が増える。** `setIceServers()` はサーバ関連のフィールドを丸ごと置き換えるので、新しいフラグも置き換え対象に加え、constructor、`updateIceServers()`、`deferIceServers()` → restart の 3 経路すべてで渡す必要がある。`null` を使う案は `Address | null` の型変更が `validateAddress` などに広がる。方針 1 は実質 1 行の変更で、webrtc 層で新しいフラグを受け渡す必要もない（webrtc 層の変更は §3.1 の `PeerConfig` の既定値だけ）。
4. **互換性の影響は限定的で、semver でも許容できる。**
   - `werift-ice` は `0.2.3`（0.x）であり、CHANGELOG にも過去に lower-level パッケージの挙動変更を記載した例がある。
   - リポジトリ内の利用箇所（`packages/ice/examples/*`、`packages/dtls/examples/ice/*`、`packages/dtls/tests/e2e/ice.test.ts`）は srflx が必要な所ではすべて `stunServer` を明示している。
   - `ice_turn.ts` は `forceTurn: true` なので STUN を使わない。
   - `createConsentHarness` / `createTcpCheckHarness` の `new Connection(true)` は収集をしないので影響しない。
   - 外部の利用者は `stunServer` を明示するだけで移行できる（CHANGELOG に書く）。
5. issue でも「低レベル API は既定値を残してもよい」とあるだけで必須ではない。webrtc 層の意味がそろうことが主な要求であり、方針 1 はそれを満たす。

### `deepMerge` の挙動（確認済み）

`packages/webrtc/src/utils.ts:322` の `deepMerge` は、`undefined` の値は上書きせず、配列は置き換える。

- `{ iceServers: [] }` は既定値を `[]` で置き換える → 正しい。
- `{ iceServers: undefined }` / 未指定は既定値を残す → 既定値を `[]` にすれば問題ない。
- `setConfiguration({})`（`iceServers` 未指定）は既存の値を残す。W3C の `setConfiguration` は辞書全体を置き換えるので、厳密には未指定は `[]` 扱いになる。ただし werift の既存の部分 merge の挙動（convenience）を変えるのは今回の対象外とする（AGENTS.md の Do #14 に従い、W3C の厳格な挙動は WPT ラッパー側に閉じる）。

## 5. 制約・注意点

- **破壊的変更**: 既定で srflx 候補が出なくなる。NAT 越しにインターネット経由で接続していて、`iceServers` を指定していなかった利用者は疎通できなくなる可能性がある。CHANGELOG の Breaking changes に移行方法を必ず書く。
- **既存テストへの影響**:
  - `packages/webrtc/tests` には `new RTCPeerConnection()` / `new RTCPeerConnection({ iceServers: [] })` を使うテストが多い（`tests/utils.ts:21`、`tests/issue/705.helpers.ts` など）。現在は `[]` でも裏で Google STUN を引いているので、修正後は外部通信と STUN の待ちがなくなる。gather 完了のタイミングが早くなり、タイミングに依存したテストの結果が変わる可能性がある。
  - `packages/ice/tests/utils.ts:243,443` の `new Connection(true)`（STUN 未指定）は STUN なしになる。どちらも収集をしない consent / TCP 用のハーネスなので影響はない見込み。srflx を期待するテスト（`restart-gather.test.ts` など）はローカルの STUN を明示しているので影響しない。
  - `stunServer: undefined` を渡していた ice のテスト（`turn.test.ts`、`turn-late-candidate.test.ts`、`ice.test.ts:808,881` など）は、本当に STUN なしで動くようになる。今まで裏で Google STUN を待っていた分のタイミングが変わるので、全件通ることを確認する。
  - `packages/ice/tests/ice/setIceServers.test.ts` は `stunServer: undefined` での構築を含む。修正後は `connection.stunServer` が `undefined` になることを assert に加える。
- **`werift-ice` の破壊的変更**: `Connection` を直接使い、`stunServer` を省略して srflx を得ていた外部の利用者は、srflx 候補を得られなくなる。CHANGELOG に移行方法を書き、minor を上げる（§3.2）。
  - e2e（`e2e/tests/**`）は多くが `iceServers: [{ urls: "stun:stun.l.google.com:19302" }]` を明示しているので影響は小さい見込み。それでも最終確認として `npm run e2e` を実行する。
- **`iceTransportPolicy: "relay"` との関係**: relay のみの構成は `gatherRelayOnly` で STUN を飛ばしている。今回の変更でこの挙動は変わらないことを確認する。
- **ICE restart / `deferIceServers`**: gather 済みのトランスポートは `nextGatherIceServers` を次の restart で適用する。restart 後も「STUN なし」が保たれ、Google STUN に戻らないことを確認する。
- **ICE lite**（`iceLite: true`）はサーバを使わないので影響はない。
- 修正は webrtc の公開 API とプロトコルの挙動の変更にあたる。AGENTS.md の Validation に従い、`npm run type` と `npm run test:small` を実行する。ice / webrtc の両パッケージにまたがるなら `npm run ci` も実行する。
- **#755（STUN/TURN を複数指定したときの扱い）は別チケット**。`parseIceServers` の「最初の 1 件だけ採用する」挙動は今回変えない。

## 6. テスト計画

AGENTS.md の規約（Arrange / Act / Assert の 3 フェーズ、Act と Assert には日本語コメント、Arrange のユーティリティは共通ファイルに置く）に従う。DNS の観測には既存の `stubLookup`（`packages/ice/tests/utils.ts:684`、`dns.promises.lookup` を spy する）を使い、ローカルの TURN には `createLocalTurnServer`（同 333 行目）を使う。外部ネットワークに依存しないこと。

| # | テスト | 置き場所の候補 | 主な Assert |
|---|--------|----------------|-------------|
| 1 | `new RTCPeerConnection()` の既定値 | `packages/webrtc/tests/transport/ice.test.ts`（`setConfiguration iceServers` の describe 付近） | `getConfiguration().iceServers` が `[]`、`ice.connection.stunServer` が `undefined` |
| 2 | `iceServers: []` で gather | 同上 | gather が完了し、`stun.l.google.com` の DNS lookup が 0 回、host 候補だけが出る |
| 3 | TURN のみの `iceServers` | 同上（ローカル TURN を使う） | relay 候補が出る（Allocate が成功）。`stunServer` が `undefined`。Google STUN は lookup されない |
| 4 | STUN を明示 | 同上 | `connection.stunServer` が指定したアドレスになる。指定したホストだけが lookup される |
| 5 | `setConfiguration()` で TURN のみに変更（gather 前） | 既存の `gathering 前の setConfiguration が Connection に TURN を反映する` を拡張 | `ice.connection.stunServer` が `undefined` のまま |
| 6 | ICE restart 後も同じ扱い | 既存の `ICE restart 後 gatheringState が new なら…` を拡張 | restart 後の `stunServer` が `undefined`。`getConfiguration().iceServers` と実際の挙動が一致する |
| 7 | ice 層: `new Connection(true)` / `new Connection(true, { stunServer: undefined })` / STUN あり → `setIceServers({ stunServer: undefined })` | `packages/ice/tests/ice/setIceServers.test.ts` | いずれも `connection.stunServer` が `undefined` |
| 8 | ice 層: STUN なしで gather | `packages/ice/tests/ice/`（新規または既存のファイル） | `stubLookup` で DNS lookup が 0 回。host 候補だけで収集が完了し、`stunGatherTimeout` を待たない |

- 任意: WPT の `webrtc/RTCConfiguration-iceServers.html` は現在 `packages/webrtc/wpt/allowlist.json` に入っていない。既定値 `[]` を検証できるか確認し、通るなら allowlist に追加して `npm run wpt --workspace packages/webrtc` を実行する（追加しない場合は理由を残す）。

## 7. 完了条件

- [ ] `new RTCPeerConnection()` / `{ iceServers: [] }` のとき、`getConfiguration().iceServers` が `[]` で、STUN の DNS lookup と Binding request が発生しない
- [ ] TURN のみの `iceServers` で、設定した TURN だけを使い（Allocate が発生）、Google STUN を名前解決も通信もしない
- [ ] STUN を明示したとき、そのエンドポイントだけを使う
- [ ] constructor、`setConfiguration()`（gather 前）、ICE restart（`deferIceServers` 経由）のすべてで同じ扱いになる
- [ ] ice 層の `DEFAULT_STUN_SERVER` を削除し、`stunServer` を省略・`undefined` にしたら STUN なしになる。`IceOptions.stunServer` の JSDoc にそう明記する
- [ ] テストの回避コード（`createTestConnection` の再代入、`consent-restart.test.ts` の手動 `undefined` 代入）を削除しても ice のテストが通る
- [ ] `getGlobalIp()` の JSDoc に、省略時は Google STUN を使うことを明記する（挙動は変えない）
- [ ] §6 のテストを Arrange / Act / Assert と日本語コメント付きで追加し、外部ネットワークに依存せずに通る
- [ ] `changelog.md` の Unreleased / Breaking changes に移行方法付きで追記する。JSDoc と生成ドキュメント（`npm run doc`）を更新する
- [ ] `npm run type` と `npm run test:small` が通る。ice / webrtc にまたがる変更なので `npm run ci` も通る
- [ ] `npm run e2e` が通る（examples に変更があれば `npm run examples:e2e` も）
- [ ] 外部ネットワークが要る examples に `iceServers` を明示するか、不要であることを確認する
