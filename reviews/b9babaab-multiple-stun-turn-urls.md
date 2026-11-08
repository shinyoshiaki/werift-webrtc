---
ide:
  viewer: review-document
  version: 1
  title: "複数の STUN / TURN URL 対応のレビュー解説"
  dock: right
  baseCommit: ec5bc2e016138befa7991775766970d160e610f3
---
# 複数の STUN / TURN URL に対応する変更のレビュー解説

## 1. 概要

`RTCPeerConnection({ iceServers })` は、最初の STUN URL と最初の TURN URL だけを使い、残りを警告なしで捨てていました。この変更で、設定されたすべての STUN / TURN URL が ICE gathering に参加するようにしました。TURN は URL ごとに、その URL を含む `RTCIceServer` の `username` / `credential` と、その URL 固有の transport で Allocate します。

単数形の `IceOptions`（`stunServer` / `turnServer` / `turnUsername` / `turnPassword` / `turnTransport`）は deprecated にしつつ動作を維持します。ICE 層の 1 か所（`normalizeIceServerOptions`）で、単数形と複数形を `{ stunServers, turnServers }` にまとめます。

対象は 2 コミットです。実装は `06d2f9dec`、レビュー指摘への修正は `ec5bc2e01`（headCommit）です。

<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:14px">
<div style="border:1px solid #c0392b;border-radius:8px;padding:12px">
<b>変更前</b><br>
<code>parseIceServers</code> は最初の STUN と最初の TURN だけを採用<br>
→ 単数フィールドが webrtc 層から ICE 層まで流れる<br>
→ 後続サーバーには一度も問い合わせない
</div>
<div style="border:1px solid #27ae60;border-radius:8px;padding:12px">
<b>変更後</b><br>
<code>parseIceServers</code> が <code>stunServers[]</code> / <code>turnServers[]</code> を返す<br>
→ <code>normalizeIceServerOptions</code> で正規化<br>
→ STUN は socket × サーバーで並列問い合わせ、TURN はサーバーごとに別 allocation
</div>
</div>

## 2. 主要変更

### 2.1 ICE 層: オプション型と正規化（`packages/ice/src/iceBase.ts`）

- `IceOptions.stunServers` / `IceOptions.turnServers`、型 `TurnServerOptions`（`address` / `username` / `password` / `transport`）を追加しました。単数形は `@deprecated` です。[packages/ice/src/iceBase.ts:298](review-file:packages/ice/src/iceBase.ts:298)
- 変更の核は `normalizeIceServerOptions()` です。[packages/ice/src/iceBase.ts:552](review-diff:packages/ice/src/iceBase.ts:552)
  - 並び順は、単数形が先頭、次に複数形を設定順で並べます。
  - 重複は先頭の位置で 1 件にまとめます。STUN はアドレス単位、TURN はアドレス・transport・credential の組で判定します。
  - 不正なアドレスと、username / password のない TURN は除外します（ログを出します）。
  - TURN の transport が未指定なら `"udp"` にします。
- `mergeIceServerOptions` は複数形のフィールドも完全に置き換えます。そのため、STUN だけの更新で古い TURN が残ることはありません。[packages/ice/src/iceBase.ts:631](review-diff:packages/ice/src/iceBase.ts:631)
- `hasTurnServer` と `isCandidateAllowedByGatherOptions` は正規化結果で判定するように変えました。`iceTransportPolicy: "relay"` の現行挙動は維持しています。

### 2.2 ICE 層: gathering（`packages/ice/src/ice.ts`）

- `Connection.stunServers` / `turnServers` を追加しました。`stunServer` / `turnServer` は先頭要素を返す deprecated な getter / setter として残しています。[packages/ice/src/ice.ts:211](review-diff:packages/ice/src/ice.ts:211)
- STUN: IPv4 の各 UDP socket が、すべての STUN サーバーへ並列に問い合わせます。[packages/ice/src/ice.ts:1355](review-diff:packages/ice/src/ice.ts:1355)
  - 同じ mapping（host と port が同じ）の srflx は 1 件にまとめます（RFC 8445 §5.1.3）。
  - NAT が宛先ごとに異なる mapping を返した場合は、それぞれ srflx 候補にします。
  - 1 台あたりの問い合わせは `stunGatherTimeout` で打ち切ります。応答しないサーバーがあっても他は止まりません。
  - ICE restart で再利用する socket も全サーバーに再問い合わせし、`reflexiveBySocket` は `Candidate[]` に変えました。
- TURN: 旧来の単一 IIFE を `gatherRelayCandidate()` に切り出し、サーバー数分だけ実行します。[packages/ice/src/ice.ts:1431](review-diff:packages/ice/src/ice.ts:1431)
  - 各サーバーは自分の credential と transport で Allocate します。UDP が失敗した場合の TCP フォールバックは、サーバーごとに行います。
  - 1 台が失敗しても他は継続します（`.catch` でログのみ）。
  - stale になった世代の allocation は、従来どおり `close()` で解放します。
- `allowsProvisional` は、保持中の TURN allocation が新世代の `turnServers` のどれかと、address・credential・transport のすべてで一致するときだけ使います。[packages/ice/src/ice.ts:936](review-diff:packages/ice/src/ice.ts:936)
  - `packages/ice/src/turn/protocol.ts` の `StunOverTurnProtocol.configuredTransport` を追加しました。[packages/ice/src/turn/protocol.ts:98](review-diff:packages/ice/src/turn/protocol.ts:98)
  - これは `ec5bc2e01` の修正です。UDP が TCP にフォールバックした allocation を、設定上の transport（`"udp"`）で覚えておくためです。これがないと、TCP だけを残した新世代が古い UDP 由来の allocation を再利用したり、取り残したりします。

### 2.3 WebRTC 層（`packages/webrtc/src`）

- `parseIceServers()` が `stunServers` と `turnServers`（`ParsedTurnServer`）を設定順に返し、重複を除きます。TURN の各エントリは、それを含む `RTCIceServer` の `username` / `credential` を持ちます。単数フィールドは先頭要素のコピーとして残し、deprecated にしました。[packages/webrtc/src/utils.ts:140](review-diff:packages/webrtc/src/utils.ts:140)
- `SecureTransportManager.resolveIceServerOptions()` は、TURN の URL ごとに `resolveTurnTransport()`（URL の `?transport=`、`turnTransport`、`forceTurnTCP` の順）を適用します。credential のない TURN URL はログを出して除外します。`InvalidAccessError` は投げません（互換性のため。チケットの範囲外として扱いました）。[packages/webrtc/src/secureTransportManager.ts:121](review-diff:packages/webrtc/src/secureTransportManager.ts:121)
- 単数フィールドは `undefined` として返し、`setIceServers` で残留を防ぎます。

### 2.4 テストとドキュメント

- 新規: [packages/ice/tests/ice/multi-server.test.ts](review-file:packages/ice/tests/ice/multi-server.test.ts) に 12 件のテストを追加しました。
  - 内容は、正規化、STUN / TURN の並列問い合わせ、credential の取り違えが起きないこと、UDP / TCP / TLS の併用、到達不能な 1 台目、restart での置き換えと allocation の解放です。
  - 共通の Arrange は [packages/ice/tests/utils.ts](review-diff:packages/ice/tests/utils.ts) にまとめました。`createLocalTurnServer` はサーバーごとの credential を指定でき、リクエスト数をカウントします。
- 既存テストの移行: [packages/webrtc/tests/utils.test.ts](review-diff:packages/webrtc/tests/utils.test.ts)、[packages/webrtc/tests/transport/ice.test.ts](review-diff:packages/webrtc/tests/transport/ice.test.ts)、[packages/webrtc/tests/transport/iceRestartConfigMatrix.test.ts](review-diff:packages/webrtc/tests/transport/iceRestartConfigMatrix.test.ts)、ハーネスの [negotiationTransactionUtils.ts](review-diff:packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts)（`removeIceAgentServers`）。
- ドキュメント: [changelog.md](review-diff:changelog.md) に追記し、`doc/` 配下の TypeDoc を再生成しています。`website/docs/doc1.md` と日本語版も更新しています。

## 3. 判断理由

| 論点 | 採用 | 採用しなかった案と理由 |
| --- | --- | --- |
| 単数形オプション | deprecated で残し、正規化で複数形へ | 即削除は公開 API の破壊的変更になるため見送り |
| 正規化の置き場所 | `iceBase.ts` の 1 関数 | constructor と `setIceServers` で別々に検証すると挙動がずれるため |
| 資格情報のない TURN | 無視してログを出す | `InvalidAccessError` を投げる案は互換性への影響が大きいため別チケットに回す |
| TURN の transport | URL ごとに解決 | 全 URL で 1 つの transport にすると UDP / TCP / TLS の併記ができない |
| srflx の重複 | host:port が同じなら 1 件 | 重複を残すと冗長な候補がペアに増える |
| 暫定世代での allocation 再利用 | address・credential・transport が一致するときのみ | server と credential だけの比較では、transport を変えた設定でも古い allocation が残る |

## 4. レビュアーが確認すべき点・リスク

1. **公開 API の変更**: ICE 層に `stunServers` / `turnServers` / `TurnServerOptions` / `normalizeIceServerOptions` が増えます。`IceConnection` の新フィールドは optional なので、他の実装はそのままコンパイルできます。
2. **挙動の変化（互換性）**: `RTCPeerConnection` は ICE agent に複数形だけを渡します。そのため `iceTransport.connection.options.turnUsername` などの単数フィールドは `undefined` になります（changelog に記載済み）。外部コードが読んでいる場合は影響を受けます。
3. **gathering の完了時間**: 完了は最も遅いサーバーに依存します。上限は `iceStunGatherTimeout` と `iceTurnConnectTimeout` などです。到達不能なサーバーを多数並べると、end-of-candidates が遅れます。
4. **TURN allocation の増加**: サーバー数分の allocation と refresh タイマーが増えます。stale・close・restart のすべての経路で解放されているかを、[packages/ice/src/ice.ts:1431](review-file:packages/ice/src/ice.ts:1431) の `stale()` 分岐と restart の処理で確認してください。`npm run memleak` は実行していません。
5. **foundation**: `candidateFoundation` にサーバーの IP を含めていません。同じ mapping でも別 mapping でも foundation が同じになり得ます。実害は frozen 制御の粒度程度で、チケットでも任意の改善とされています。
6. **重複判定の違い**: STUN はアドレスだけで、TURN は address・transport・credential の組で重複を判定します。同じ TURN サーバーに異なる credential を設定した場合は、別々に allocation します。
7. **`stunServer` setter の意味**: `Connection.stunServer = x` は一覧全体を置き換えます。これはテストのハーネスが依存しています。

## 5. 検証結果

私（この解説の作成者）が実行して確認したものは次のとおりです。

- `cd packages/ice && npx vitest run tests/ice/multi-server.test.ts`: 12 件すべて成功しました。
- `cd packages/webrtc && npx vitest run tests/utils.test.ts`: 26 件すべて成功しました。

次は実行していません。実装担当の結果は、この文書の作成時点では確認できていません。

- `npm run type`、`npm run test:small`、`npm run e2e`、`npm run wpt`
- `packages/webrtc` の全テスト、`npm run memleak`
