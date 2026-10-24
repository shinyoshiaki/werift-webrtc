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
2. **RTCPeerConnection から ICE 層へ「STUN なし」を明示的に渡す**（B を webrtc 経路で無効化）
   - `iceServers` に STUN URL が無いときに、`Connection` が Google STUN で補わない仕組みが要る。方針は §4 で比較し、方針 1 を推奨する。
   - constructor（`createTransport` → `new RTCIceGatherer`）、`setConfiguration` → `updateIceServers` → `setIceServers`、`deferIceServers` → ICE restart 時の `setIceServers` の **3 経路すべて** で同じ意味になること。
3. Google STUN を使い続けたい利用者は、`iceServers: [{ urls: "stun:stun.l.google.com:19302" }]` を明示的に指定して使う（オプトイン）。専用の非標準フラグは基本的に追加しない（必要なら別チケットで検討）。

### 3.2 ice 層（方針によって変わる）

- 推奨の方針 1 では、`Connection` の `DEFAULT_STUN_SERVER` による補完をやめる（`werift-ice` の破壊的変更）。
- `getGlobalIp()`（C）は呼び出し側が明示的に呼ぶユーティリティなので、対象外にしてよい。ただし方針をそろえるなら、引数を必須にするか、既定値を JSDoc に明記するかを判断する。

### 3.3 ドキュメント・CHANGELOG

- `changelog.md` の `## Unreleased` → `### ⚠️ Breaking changes` に追記する。「`iceServers` 未指定・`[]`・TURN のみの場合に Google STUN を暗黙に使わなくなった。従来の挙動に戻すには `iceServers: [{ urls: "stun:stun.l.google.com:19302" }]` を明示する」と移行方法も書く（方針 1 なら `werift-ice` の `Connection` の既定値変更も書く）。
- `PeerConfig.iceServers` / `RTCConfiguration.iceServers` の JSDoc に既定値 `[]` を明記する（`npm run doc` で `doc/interfaces/PeerConfig.md` などを再生成する）。
- `docs/browser-api-compatibility.md` の `RTCConfiguration` の項目に、既定値の扱いが W3C に準拠したことを必要に応じて追記する。
- `website/docs/doc1.md` に古い `iceConfig: { stunServer: [...] }` の記述がある。今回の対象外だが、ついでに直すかどうか判断する。
- 外部ネットワーク越しに疎通する examples（ブラウザとの接続で srflx が要るもの）は `iceServers` を明示する。`iceServers` 指定なしの `new RTCPeerConnection(` を含む examples は約 72 ファイルあるが、多くはローカル（localhost / LAN）で host 候補だけで足りる。`examples/e2e` カタログに入っているデモへの影響は `npm run examples:e2e` で確認する。

## 4. 技術的な方針

### 「STUN なし」の伝え方の比較

| 方針 | 内容 | 長所 | 短所 |
|------|------|------|------|
| **1. ice 層の既定値を廃止（推奨）** | `applyStunTurnServersFromOptions()` を `this.stunServer = validateAddress(this.options.stunServer)` にし、`DEFAULT_STUN_SERVER` を削除する | 最小の変更。2 層の意味がそろう。`setIceServers()` の「undefined を明示的に代入して置き換える」という既存の方針（コメントあり）とも整合する | `werift-ice` を直接使い、`stunServer` を省略していた利用者には破壊的変更になる。ice のテストや examples で既定値に頼っている箇所を確認する必要がある |
| 2. ice 層に既定値を残し、オプトアウトを追加 | `IceOptions` に `useDefaultStunServer?: boolean`（既定 `true`）か `stunServer: null`（「なし」の明示）を追加し、webrtc 層は常にオプトアウトして渡す | `werift-ice` 単体の互換性を保てる（issue でも「低レベル ICE API は既定値を残してもよい」とされている） | オプション経路が増える。`setIceServers()` はサーバ関連のフィールドを丸ごと置き換えるので、新しいフラグも置き換え対象に含めないと状態が残る。`null` を使う場合は `Address \| null` の型変更が `validateAddress` などに波及する |

- 推奨理由: このリポジトリは werift 一式（webrtc の公開 API）が主体である。`werift-ice` を直接使う利用者の多くは、examples のように `stunServer` を明示している（`packages/ice/examples/*`、`packages/dtls/examples/ice/*`）。暗黙の外部通信をなくすというプライバシー上の目的とも一貫する。
- 方針 2 を選ぶ場合は、webrtc 側で `resolveIceServerOptions()` が常にオプトアウトのフラグを返すようにし、`updateIceServers()` / `deferIceServers()` の経路でも同じフラグが渡ることをテストで固定する。

### `deepMerge` の挙動（確認済み）

`packages/webrtc/src/utils.ts:322` の `deepMerge` は、`undefined` の値は上書きせず、配列は置き換える。

- `{ iceServers: [] }` は既定値を `[]` で置き換える → 正しい。
- `{ iceServers: undefined }` / 未指定は既定値を残す → 既定値を `[]` にすれば問題ない。
- `setConfiguration({})`（`iceServers` 未指定）は既存の値を残す。W3C の `setConfiguration` は辞書全体を置き換えるので、厳密には未指定は `[]` 扱いになる。ただし werift の既存の部分 merge の挙動（convenience）を変えるのは今回の対象外とする（AGENTS.md の Do #14 に従い、W3C の厳格な挙動は WPT ラッパー側に閉じる）。

## 5. 制約・注意点

- **破壊的変更**: 既定で srflx 候補が出なくなる。NAT 越しにインターネット経由で接続していて、`iceServers` を指定していなかった利用者は疎通できなくなる可能性がある。CHANGELOG の Breaking changes に移行方法を必ず書く。
- **既存テストへの影響**:
  - `packages/webrtc/tests` には `new RTCPeerConnection()` / `new RTCPeerConnection({ iceServers: [] })` を使うテストが多い（`tests/utils.ts:21`、`tests/issue/705.helpers.ts` など）。現在は `[]` でも裏で Google STUN を引いているので、修正後は外部通信と STUN の待ちがなくなる。gather 完了のタイミングが早くなり、タイミングに依存したテストの結果が変わる可能性がある。
  - `packages/ice/tests/utils.ts:243,443` などの `new Connection(true)`（STUN 未指定）は、方針 1 では STUN なしになる。srflx を期待するテストが無いか確認する。
  - `packages/ice/tests/ice/setIceServers.test.ts` は `stunServer: undefined` での構築を含む。修正後は `connection.stunServer` が `undefined` になることを assert に加える。
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
| 7 | ice 層: `new Connection(true)` / `setIceServers({ stunServer: undefined })` | `packages/ice/tests/ice/setIceServers.test.ts` | （方針 1）`stunServer` が `undefined`（方針 2）既定値が残り、オプトアウト時は `undefined` |

- 任意: WPT の `webrtc/RTCConfiguration-iceServers.html` は現在 `packages/webrtc/wpt/allowlist.json` に入っていない。既定値 `[]` を検証できるか確認し、通るなら allowlist に追加して `npm run wpt --workspace packages/webrtc` を実行する（追加しない場合は理由を残す）。

## 7. 完了条件

- [ ] `new RTCPeerConnection()` / `{ iceServers: [] }` のとき、`getConfiguration().iceServers` が `[]` で、STUN の DNS lookup と Binding request が発生しない
- [ ] TURN のみの `iceServers` で、設定した TURN だけを使い（Allocate が発生）、Google STUN を名前解決も通信もしない
- [ ] STUN を明示したとき、そのエンドポイントだけを使う
- [ ] constructor、`setConfiguration()`（gather 前）、ICE restart（`deferIceServers` 経由）のすべてで同じ扱いになる
- [ ] ice 層の方針（既定値の廃止、またはオプトアウトの追加）を決めて実装し、`setIceServers.test.ts` などで挙動を固定する
- [ ] §6 のテストを Arrange / Act / Assert と日本語コメント付きで追加し、外部ネットワークに依存せずに通る
- [ ] `changelog.md` の Unreleased / Breaking changes に移行方法付きで追記する。JSDoc と生成ドキュメント（`npm run doc`）を更新する
- [ ] `npm run type` と `npm run test:small` が通る。ice / webrtc にまたがる変更なので `npm run ci` も通る
- [ ] `npm run e2e` が通る（examples に変更があれば `npm run examples:e2e` も）
- [ ] 外部ネットワークが要る examples に `iceServers` を明示するか、不要であることを確認する
