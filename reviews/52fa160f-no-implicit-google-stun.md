---
ide:
  viewer: review-document
  version: 1
  title: "Google STUN の暗黙利用を廃止"
  dock: right
  baseCommit: 4ccf563959c1f0f24be7cbceb66319c71989f9f4
---
# Google STUN の暗黙利用を廃止（RTCPeerConnection / werift-ice）

## 1. 概要

`RTCPeerConnection` は `iceServers` が未指定・`[]`・TURN のみのとき、アプリケーションが設定していない `stun.l.google.com:19302` を暗黙に使っていました。この変更で暗黙の STUN を 2 層（webrtc 層の既定値と ice 層の補完）とも取り除き、アプリケーションが指定したサーバだけを使うようにしました。W3C の `iceServers` 既定値 `[]` と RFC 8829 §4.1.1 に合わせた変更です。

あわせて、STUN の待ちがなくなったことで表面化した ICE の不具合 2 件（controlling への役割変更後に nominate されない問題と、ICE restart で作った offer が `a=end-of-candidates` を早く宣言する問題）も同じ変更内で直しています。

破壊的変更です。NAT 越しの接続で暗黙の STUN に頼っていた利用者は、`iceServers` に STUN を明示する必要があります。

<div style="display:flex;gap:12px">
  <div style="flex:1;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px">
    <strong>Before</strong><br>
    <code>new RTCPeerConnection()</code> → Google STUN を使う<br>
    <code>iceServers: []</code> → Google STUN を使う<br>
    TURN のみ → TURN に加えて Google STUN も使う
  </div>
  <div style="flex:1;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px">
    <strong>After</strong><br>
    <code>getConfiguration().iceServers</code> の既定値は <code>[]</code><br>
    STUN が無ければ srflx 収集も DNS lookup も行わない<br>
    使いたい場合は <code>iceServers</code> に明示する
  </div>
</div>

## 2. 主要変更

### 2.1 暗黙の STUN の除去（本題）

暗黙の注入は 2 層にあり、片方だけでは解決しません。

<svg viewBox="0 0 640 150" width="100%" role="img" aria-label="暗黙 STUN の 2 層を除去">
  <g fill="none" stroke="var(--review-border)">
    <rect x="8" y="20" width="190" height="60" rx="6" stroke="var(--review-danger)"/>
    <rect x="225" y="20" width="190" height="60" rx="6"/>
    <rect x="442" y="20" width="190" height="60" rx="6" stroke="var(--review-danger)"/>
    <rect x="8" y="100" width="190" height="40" rx="6" stroke="var(--review-muted)" stroke-dasharray="4 3"/>
  </g>
  <g stroke="var(--review-muted)"><line x1="198" y1="50" x2="225" y2="50"/><line x1="415" y1="50" x2="442" y2="50"/></g>
  <g fill="var(--review-fg)" font-size="12" text-anchor="middle">
    <text x="103" y="45">A: webrtc 層</text><text x="103" y="63">既定 iceServers を [] に</text>
    <text x="320" y="45">parseIceServers</text><text x="320" y="63">stunServer: undefined</text>
    <text x="537" y="45">B: ice 層</text><text x="537" y="63">DEFAULT_STUN_SERVER 削除</text>
    <text x="103" y="124">C: getGlobalIp は据え置き（JSDoc のみ）</text>
  </g>
</svg>

- A: [packages/webrtc/src/api/peerConfig.ts:249](review-file:packages/webrtc/src/api/peerConfig.ts:249) の既定値を Google STUN から `[]` に変更。変更の核は [packages/webrtc/src/api/peerConfig.ts:249](review-diff:packages/webrtc/src/api/peerConfig.ts:249)。`PeerConfig.iceServers` / `RTCConfiguration.iceServers` の JSDoc に既定値と明示方法を追記しました。
- B: [packages/ice/src/ice.ts:211](review-file:packages/ice/src/ice.ts:211) の `applyStunTurnServersFromOptions()` が `?? DEFAULT_STUN_SERVER` を使うのをやめ、`DEFAULT_STUN_SERVER` 定数を削除。差分は [packages/ice/src/ice.ts:211](review-diff:packages/ice/src/ice.ts:211)。constructor と `setIceServers()`（`setConfiguration` / ICE restart の経路）の両方がこの関数を通るので、3 経路が同じ意味になります。
- `IceOptions.stunServer` に「省略時は STUN なし、既定の公開 STUN は無い」という JSDoc を追加: [packages/ice/src/iceBase.ts:289](review-diff:packages/ice/src/iceBase.ts:289)
- C: `getGlobalIp()` は挙動を変えず、省略時に Google STUN を使うことを JSDoc に明記: [packages/ice/src/utils.ts:15](review-diff:packages/ice/src/utils.ts:15)

### 2.2 STUN の待ちがなくなって見えた ICE の不具合の修正

暗黙の STUN を待たなくなると、ICE の checks が短時間で完了し、これまで隠れていた競合が出ました。negotiation leak property が検出したものです。

1. **controlling への役割変更後に nominate されない。** controlled の間に唯一の pair が成功し、その後で役割衝突の修復や offer/answer で controlling になると、どちらも成功済み pair を再チェックせず、ICE が `checking` のまま止まります。
   - [packages/ice/src/ice.ts:1974](review-diff:packages/ice/src/ice.ts:1974) の `applyIceControlling()` が checklist を再ソートするようにしました。
   - [packages/ice/src/ice.ts:2004](review-diff:packages/ice/src/ice.ts:2004) の `nominateSucceededPair()` を新設しました。UDP pair は USE-CANDIDATE 付きで再チェックし、TCP pair は既存の `nominateTcpPairIfReady()` に任せます。
   - `iceControlling` setter、`switchRole()`、失敗した check の後の `checkComplete()` から呼びます。nominate が失敗したら次の成功済み pair に進みます。
2. **ICE restart で作った offer が早く `a=end-of-candidates` を宣言する。** `setConfiguration()` が `createOffer` と `setLocalDescription` の間に来ると、後から出る TURN の relay 候補を、相手が end-of-candidates 後として拒否します。
   - [packages/webrtc/src/transport/ice.ts:293](review-diff:packages/webrtc/src/transport/ice.ts:293) で `complete` を `staged.emitted` が真のときだけにしました。適用済みの description と null の `icecandidate` イベントは従来どおり end-of-candidates を知らせます。

### 2.3 テストとテストの回避コード

- 回避コードの削除: `createTestConnection()` の `connection.stunServer = options.stunServer` 再代入と、`consent-restart.test.ts` の手動 `undefined` 代入を削除しました。既定値が無くなったため不要です。
- webrtc 層: [packages/webrtc/tests/transport/ice.test.ts:281](review-file:packages/webrtc/tests/transport/ice.test.ts:281) の「既定の公開 STUN を暗黙に使わない」で、既定値、`iceServers: []`、TURN のみ、STUN 明示、restart 後の `[]` を DNS lookup の観測つきで確認します。
- ice 層: [packages/ice/tests/ice/gather-without-stun.test.ts:5](review-file:packages/ice/tests/ice/gather-without-stun.test.ts:5)、[packages/ice/tests/ice/setIceServers.test.ts:118](review-file:packages/ice/tests/ice/setIceServers.test.ts:118)、TCP 側の追加（[packages/ice/tests/ice/tcp.test.ts](review-diff:packages/ice/tests/ice/tcp.test.ts)）。
- 役割変更後の nominate: [packages/ice/tests/ice/role-switch-nomination.test.ts:11](review-file:packages/ice/tests/ice/role-switch-nomination.test.ts:11)（役割切替、offer/answer での割り当て、priority、失敗時の再 nominate の 4 ケース）。
- leak property / negotiation 系: `leakProbe.ts`、`scenes.ts`、`negotiationTransactionCoverageIce.test.ts` などを、Google STUN 待ちに依存しない形に更新しました（[packages/webrtc/tests/pbt/leak/scenes.ts](review-diff:packages/webrtc/tests/pbt/leak/scenes.ts)）。

### 2.4 ドキュメント・examples

- 破壊的変更 2 件、不具合修正 2 件、`werift` `0.25.x` → `0.26.0` と `werift-ice` `0.2.3` → `0.3.0` の方針を [changelog.md:21](review-diff:changelog.md:21) に追記。実際のリリース作業は対象外です。
- `iceServers` の既定値を [docs/browser-api-compatibility.md:29](review-diff:docs/browser-api-compatibility.md:29) に追記。`doc/` 配下の生成ドキュメントは `npm run doc` の出力で、`doc/_media/` 以下は `docs` と `examples` のコピーです。
- 外部ネットワークが要る examples と e2e の STUN 補助を明示指定に直しました（[examples/untested/google-nest/server.ts](review-diff:examples/untested/google-nest/server.ts)、[examples/e2e/tests/helpers/stunFixture.ts](review-diff:examples/e2e/tests/helpers/stunFixture.ts)）。
- `website/docs/doc1.md`（英語と日本語）の古い `iceConfig: { stunServer }` 記述も合わせて更新しました。

## 3. 判断理由

| 案 | 内容 | 判定 |
| --- | --- | --- |
| 1. ice 層の既定値を廃止 | `DEFAULT_STUN_SERVER` を削除。`stunServer` 省略は STUN なし | 採用 |
| 2. 既定値を残し、オプトアウトのフラグを追加 | `useDefaultStunServer` などを `IceOptions` に追加し、webrtc 層は常にオプトアウト | 不採用 |

- 既存のテストが `stunServer: undefined` を「STUN なし」の意味で使い、既定値を手で打ち消していました。既定値の方が意図と食い違っていました。
- `werift-ice` を直接使う利用者にも同じプライバシー問題があります。webrtc 層だけを直すと半分しか解決しません。
- 案 2 は constructor、`updateIceServers()`、`deferIceServers()` → restart の 3 経路すべてでフラグを渡す必要があり、状態と経路が増えます。
- `getGlobalIp()` は「公開 IP を STUN で問い合わせる」と明示して呼ぶユーティリティなので、既定値を残しました。
- Google STUN を使いたい利用者向けの専用フラグは追加せず、`iceServers` への明示（オプトイン）としました。
- #755（STUN/TURN の複数指定）は別問題として扱い、`parseIceServers` の「最初の 1 件だけ採用する」挙動は変えていません。

## 4. レビュアーが確認すべき点・リスク

- **互換性（最大のリスク）**: 既定で srflx 候補が出なくなります。インターネット越しの NAT 接続で `iceServers` 未指定だった利用者は疎通できなくなる可能性があります。移行方法は changelog に書いてあります。changelog の文言で十分か確認してください。
- **公開 API**: `getConfiguration().iceServers` の既定値が変わります。`werift-ice` では `Connection` の `stunServer` 省略時の意味が変わります。型は変わっていません。
- **同じ変更に 2 件の不具合修正が入っている**: ICE の役割変更時の nominate と `a=end-of-candidates` は STUN 廃止の副産物ですが、独立した挙動変更です。分けるべきかの判断を仰ぎます。特に [packages/ice/src/ice.ts:2004](review-file:packages/ice/src/ice.ts:2004) の `nominateSucceededPair()` は、`iceControlling` setter、`switchRole()`、`checkComplete()` の 3 か所から呼ばれるので、再入や二重 nominate が起きないかを見てください。ガードは `nominated` / `nominating` / `remoteIsLite` / `pair.handle` です。
- **`gathersFromServers`**: `iceServers: []` では `false` になります（意図どおり）。ICE restart の staged 処理（`stagedGatherPending()`）への影響はテストで確認した設計ですが、レビューでも確認してください。
- **範囲外のままにしたもの**: `setConfiguration({})` で `iceServers` 未指定のときは既存値を残す部分 merge（W3C では `[]` 扱い）は変えていません。
- **差分が大きい**: 変更の大半は `doc/` の生成物、`doc/_media` のコピー、テストです。実装の本体は `ice.ts`、`peerConfig.ts`、`transport/ice.ts` の 3 ファイルです。

## 5. 検証結果

この文書の作成担当は、テストやビルドを実行していません。以下は実装側が残したチケットの完了条件と、差分から確認できた範囲です。

- 実行していない（この文書の作成中）: `npm run type`、`npm run test:small`、`npm run ci`、`npm run e2e`、`npm run examples:e2e`、`npm run wpt`。
- 差分から確認した範囲: 上記 2.3 のテストが、AGENTS.md の方針（Arrange / Act / Assert、日本語コメント、共通ユーティリティ `packages/ice/tests/utils.ts`）に沿って追加されていること。
- チケットの完了条件にはチェックボックスの未更新項目があります。実行結果は、レビュー前に CI の結果で確認してください。
