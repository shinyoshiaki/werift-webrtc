---
ide:
  viewer: review-document
  version: 1
  title: "TURN: 署名なし 401/438 challenge の処理"
  dock: right
  baseCommit: 195d394cb0e89d881624bed4bfae71ba9e34ae87
---
# TURN: 署名なしの 401/438 を MESSAGE-INTEGRITY 検証より前に処理する

## 1. 概要

認証済みの TURN トランザクション（Refresh / CreatePermission / ChannelBind）は、署名なしの 401/438 を破棄していました。そのため再送が続き、最終的に約 6.7 秒後に `TransactionTimeout` になっていました。この変更では、条件を絞って 401/438 を「challenge」として先に処理します。RFC 8489 §9.2.4 / §9.2.5 の状態遷移（リトライは 1 回まで）に沿って即座に失敗させるか、再署名してリトライします。

あわせて、リトライ request に古い MESSAGE-INTEGRITY / FINGERPRINT が残ったまま再署名され、署名が不正になる潜在バグも直しました。TCP/TLS では、署名検証に失敗したレスポンスでトランザクションを即座に終了させる処理（RFC 8489 §9.2.5）も実装しています。

## 2. 主要変更

### 2.1 受信経路の分岐

[packages/ice/src/turn/protocol.ts:482](review-file:packages/ice/src/turn/protocol.ts:482) の `handleResponse()` が、`integrityKey` を持つトランザクションのレスポンスを次のように振り分けます。変更の核は [packages/ice/src/turn/protocol.ts:482](review-diff:packages/ice/src/turn/protocol.ts:482) です。

| 受信メッセージ | 扱い |
| --- | --- |
| 署名なしの ERROR 401/438 | `challengeReceived()` に渡す（検証より前） |
| 署名が有効なレスポンス | これまで通り `responseReceived()` |
| 上記以外で検証に失敗 | ログを出して破棄。UDP は再送継続。TCP/TLS は `integrityViolated()` で即終了（署名なし 400 だけは破棄） |

<div style="font-family:sans-serif;font-size:13px;line-height:1.5">
<svg viewBox="0 0 640 150" width="100%" role="img" aria-label="受信レスポンスの分岐">
<rect x="10" y="55" width="130" height="40" rx="6" fill="none" stroke="currentColor"/>
<text x="75" y="79" text-anchor="middle" fill="currentColor" font-size="12">レスポンス受信</text>
<rect x="190" y="10" width="200" height="40" rx="6" fill="none" stroke="currentColor"/>
<text x="290" y="34" text-anchor="middle" fill="currentColor" font-size="12">署名なし 401/438 → challenge</text>
<rect x="190" y="55" width="200" height="40" rx="6" fill="none" stroke="currentColor"/>
<text x="290" y="79" text-anchor="middle" fill="currentColor" font-size="12">署名 OK → responseReceived</text>
<rect x="190" y="100" width="200" height="40" rx="6" fill="none" stroke="currentColor"/>
<text x="290" y="124" text-anchor="middle" fill="currentColor" font-size="12">署名 NG → 破棄 / TCP は即終了</text>
<rect x="440" y="10" width="190" height="40" rx="6" fill="none" stroke="currentColor"/>
<text x="535" y="34" text-anchor="middle" fill="currentColor" font-size="12">requestWithRetry で判定</text>
<path d="M140 75 L190 30 M140 75 L190 75 M140 75 L190 120 M390 30 L440 30" stroke="currentColor" fill="none"/>
</svg>
</div>

### 2.2 Transaction の入口を分離

[packages/ice/src/stun/transaction.ts:194](review-file:packages/ice/src/stun/transaction.ts:194) に `challengeReceived()` を追加しました（[差分](review-diff:packages/ice/src/stun/transaction.ts:194)）。受理する条件は、アドレス一致、未終了、署名なしの 401/438、request と同じ method です。成立すると新しい例外 `TransactionChallenge` で失敗させます。`responseReceived()` の MESSAGE-INTEGRITY 確認は多重防御として残しました。ICE の connectivity check や consent の経路（short-term credential）は、この入口を使わないので緩んでいません。

[packages/ice/src/stun/transaction.ts:214](review-file:packages/ice/src/stun/transaction.ts:214) の `integrityViolated()` は、reliable transport で署名検証に失敗したときに `TransactionIntegrityViolation` で終了させます。アドレスチェックは `accepts()` に共通化しました。例外クラスは [packages/ice/src/exceptions.ts:30](review-file:packages/ice/src/exceptions.ts:30) 付近に追加しています。

### 2.3 リトライ判定の切り出し

[packages/ice/src/turn/credential.ts:71](review-file:packages/ice/src/turn/credential.ts:71) の `credentialRetryOf()` が、リトライ可否と使う realm / nonce を決めます（新規ファイル、[差分](review-diff:packages/ice/src/turn/credential.ts:71)）。

- NONCE が無い場合はリトライしません。
- nonce cookie `obMatJos2` の Password-algorithms / Username-anonymity bit（§9.2 と §18.1 の両方の bit 番号を許容）や PASSWORD-ALGORITHMS がある場合は、未実装のためリトライしません。
- 401 で request が未認証なら（初回 Allocate）、レスポンスの REALM / NONCE でリトライします。
- 401 で request が認証済みなら、同じ REALM ではリトライせず、別 REALM のときだけ試します。
- 438 は、現在の realm と新しい NONCE でリトライします。

[packages/ice/src/turn/protocol.ts:727](review-file:packages/ice/src/turn/protocol.ts:727) の `requestWithRetry()` は、これを使ってリトライを 1 回までに制限します。別 REALM でリトライするときは専用の `credentials` で署名し、成功してから `this.nonce` / `this.realm` / `this.integrityKey` を更新します（[差分](review-diff:packages/ice/src/turn/protocol.ts:727)）。リトライしない、または失敗した場合は allocation の認証状態を変えません。

### 2.4 再署名バグの修正

[packages/ice-server/src/stun/attributes.ts:239](review-file:packages/ice-server/src/stun/attributes.ts:239) に `removeAttribute()` を追加しました（[差分](review-diff:packages/ice-server/src/stun/attributes.ts:239)）。これは追加 API のみで、サーバー側の挙動は変わりません。[packages/ice/src/turn/protocol.ts:620](review-file:packages/ice/src/turn/protocol.ts:620) では、署名前に MESSAGE-INTEGRITY / MESSAGE-INTEGRITY-SHA256 / FINGERPRINT を取り除いてから再署名します。

### 2.5 テストとドキュメント

- [packages/ice/tests/ice/turn-long-term-credential.test.ts](review-file:packages/ice/tests/ice/turn-long-term-credential.test.ts)（638 行）に、UDP/TCP の分岐、リトライ判定、werift TURN サーバーでの nonce 失効回復を収めています。
- [packages/ice/tests/turn/credential.test.ts](review-file:packages/ice/tests/turn/credential.test.ts) に、`credentialRetryOf()` と nonce cookie 解析の単体テストがあります。
- [packages/ice-server/tests/message-integrity.test.ts](review-file:packages/ice-server/tests/message-integrity.test.ts) に、再署名した request の検証テストがあります。
- Arrange 用ユーティリティは [packages/ice/tests/utils.ts](review-diff:packages/ice/tests/utils.ts) に集約しています。
- `changelog.md` と生成ドキュメント（`doc/`、`packages/ice/doc`）を更新しています。

## 3. 判断理由

- **専用の入口を採用**: チケット案 A（`challengeReceived()`）を採りました。案 B のオプション引数は、`responseReceived()` の署名必須という前提を弱めるため見送りました。
- **署名付きでも不正な MESSAGE-INTEGRITY の 401/438 は challenge にしない**: 改ざんの可能性があるためです。`isUnauthenticatedChallenge()` は署名の有無だけで判定し、署名ありのものは検証経路に流します。
- **`TransactionChallenge` は `TransactionFailed` を継承**: 既存の `instanceof TransactionFailed` 分岐を保ちつつ、`authenticated = false` で認証済みエラーと区別できます。
- **`removeAttribute()` を追加**: `ice-server` 側の追加 API で済みます。`requestWithRetry()` で request を作り直す案より変更が小さくなります。

## 4. レビュアーが確認すべき点・リスク

- **互換性**: 認証済み request への同一 REALM の 401 は、即失敗になります。署名付き 401 を返して再リトライを期待するサーバーでは挙動が変わります。署名なし 401 は従来もタイムアウトで失敗していました。
- **署名なしの 403/400 は破棄のまま**: Cloudflare の「プライベート peer への ChannelBind」は RFC 8656 上は 403 が適切です。403 は引き続き破棄されタイムアウトになります（RFC 準拠）。ICE 側でプライベート peer のリレーペアを除外する案は別 issue です。
- **TCP/TLS の挙動変更**: 署名検証に失敗したレスポンスで即終了するようになりました。署名なし 400 だけは破棄です。チケットは「実装または follow-up」としており、この変更では実装済みです。PR への明記が必要です。
- **並行性**: CreatePermission と ChannelBind が同時に 438 を受けても、どちらのリトライも成功するテストがあります（[packages/ice/tests/ice/turn-long-term-credential.test.ts:553](review-file:packages/ice/tests/ice/turn-long-term-credential.test.ts:553)）。
- **公開 API**: `TurnProtocol` と `Message`（`removeAttribute`）が生成ドキュメントに反映されています。`ice-server` の共有コードは追加のみです。
- ICE の connectivity check / consent の経路（`StunProtocol` 等）には手を入れていません。

## 5. 検証結果

私がこのドキュメント作成時に実行したものです。

- `cd packages/ice && npx vitest run tests/ice/turn-long-term-credential.test.ts tests/turn/credential.test.ts`: 2 ファイル / 73 テストがすべて成功。

次は実行していません。完了条件にあるため、レビュアー側で確認してください。

- `packages/ice` の `npm run type` と `npm test` 全体
- `packages/ice-server` の type と vitest
- ルートの `npm run type` と `npm run test:small`
- `npm run test:pion-turn`
