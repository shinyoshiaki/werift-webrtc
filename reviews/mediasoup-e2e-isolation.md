---
ide:
  viewer: review-document
  version: 1
  title: "mediasoup E2E 隔離と timeout 診断"
  dock: right
  baseCommit: 29bebf4dec965a68ad95fae4cc6794fc330c45f3
---
# mediasoup E2E 隔離と timeout 診断

## 概要

チケット `66f91b2c-dfb7-4a14-94e0-43f302a605a6` の再レビュー指摘は、fixture の通常 `npm test` が並列実行時に不安定になることでした。同一プロセスのグローバル `navigator` / polyfill と、実 mediasoup worker の並列起動が干渉します。

今回の変更は **werift 本体のプロトコル実装ではなく、interop fixture のテスト実行隔離** です。ファイルごとに子プロセスを立て、同一プロセス内では polyfill と worker 利用を直列化し、タイムアウト時に ICE/DTLS/transport 状態を出します。確認レビューは `lifecycle.status` と `ticket.reviewStatus` がともに `approved` です。親側は fixture SHA `325a59b` の gitlink 更新と、検証手順の追記です。

## 主要変更

### 1. テストランナーを直列 + プロセス隔離

[`integration/werift-mediasoup-interop/package.json:11`](review-file:integration/werift-mediasoup-interop/package.json:11) の `test` / `test:interop` に `--test-concurrency=1 --test-isolation=process` を付けました。ファイル単位の共有 `navigator` が混ざらないようにしています。

変更の核は [`integration/werift-mediasoup-interop/package.json:11`](review-diff:integration/werift-mediasoup-interop/package.json:11) です。

### 2. 同一プロセス内の polyfill / worker 直列化

ロック本体は [`integration/werift-mediasoup-interop/test/helpers/lock.ts:5`](review-file:integration/werift-mediasoup-interop/test/helpers/lock.ts:5) です。Promise チェーンで 1 本の排他を作り、二重 release を防ぎます。

[`integration/werift-mediasoup-interop/test/helpers/lock.ts:5`](review-diff:integration/werift-mediasoup-interop/test/helpers/lock.ts:5)

セッション開始は [`integration/werift-mediasoup-interop/test/helpers/session.ts:205`](review-file:integration/werift-mediasoup-interop/test/helpers/session.ts:205) で先にロックを取り、`close()` まで保持します。ネストして `arrangeInstalledPolyfill` を呼ばないよう、session 内部の polyfill は unlocked 経路です。

[`integration/werift-mediasoup-interop/test/helpers/session.ts:205`](review-diff:integration/werift-mediasoup-interop/test/helpers/session.ts:205)

standalone の polyfill は [`integration/werift-mediasoup-interop/test/helpers/polyfill.ts:54`](review-file:integration/werift-mediasoup-interop/test/helpers/polyfill.ts:54) で同じロックを取り、`uninstall()` で解放します。

[`integration/werift-mediasoup-interop/test/helpers/polyfill.ts:54`](review-diff:integration/werift-mediasoup-interop/test/helpers/polyfill.ts:54)

### 3. タイムアウト時の ICE / DTLS / transport ダンプ

[`integration/werift-mediasoup-interop/test/helpers/signaling.ts:163`](review-file:integration/werift-mediasoup-interop/test/helpers/signaling.ts:163) で client の `connectionState` / `closed` と server の ICE/DTLS/SCTP を文字列化し、`waitForClientConnected` の timeout / failed に載せます。

[`integration/werift-mediasoup-interop/test/helpers/signaling.ts:204`](review-file:integration/werift-mediasoup-interop/test/helpers/signaling.ts:204)

接続待ちの差分は [`integration/werift-mediasoup-interop/test/helpers/signaling.ts:204`](review-diff:integration/werift-mediasoup-interop/test/helpers/signaling.ts:204) です。

接続待ち API は [`integration/werift-mediasoup-interop/test/helpers/session.ts:74`](review-file:integration/werift-mediasoup-interop/test/helpers/session.ts:74) で `{ client, server }` を渡し、失敗時に両側の状態が残るようにしました。close 伝播テストも server を渡しています。

[`integration/werift-mediasoup-interop/test/interop/transport.test.ts:52`](review-file:integration/werift-mediasoup-interop/test/interop/transport.test.ts:52)
[`integration/werift-mediasoup-interop/test/interop/transport.test.ts:52`](review-diff:integration/werift-mediasoup-interop/test/interop/transport.test.ts:52)

### 4. 検証手順の更新

隔離や polyfill 共有を触ったときは `npm test` を繰り返す、と [`AGENTS.md:78`](review-file:AGENTS.md:78) に追記しました。

親リポジトリ上の差分は [`AGENTS.md:78`](review-diff:AGENTS.md:commit:29bebf4d:78) です。

## 判断理由

`--test-concurrency=1` だけでは **ファイル間は直列でも、同一ファイル内の複数 `test()` は同一プロセスで並行し得る** ため、共有 `navigator` と worker が残ります。プロセス隔離とプロセス内ロックを重ねることで、指摘の干渉経路を両方塞ぎました。timeout 診断は、再発時に ICE/DTLS のどちらで止まったかをログだけで切り分けるためのものです。

## リスク

- `--test-isolation=process` は実行時間が伸びます（実測は 1 回あたりおおよそ 13–18 秒、16 件）。
- プロセス内ロックは入れ子 acquire でデッドロックします。session がロック保持中に `arrangeInstalledPolyfill` を呼ばないことが前提です。
- worker 強制終了後の client 状態遷移は UDP 上の DTLS close_notify に依存し、到達しないことがあります。lifecycle テストはそれを失敗条件にしていません。
- レビュー側も、初回の E2E 全体で一時的な接続失敗があり、単独実行と全体再実行では成功した、と注記しています。隔離後も稀な UDP/ICE 揺らぎは残り得ます。

## 検証結果

- fixture: `npm run type` 成功。`npm test` を連続 2 回、いずれも 16/16。
- fixture commit `325a59bbb613eec8d4034c669de7a9f32c90664a` を `origin/main` に push し、親 gitlink を更新。
- 確認レビュー: `lifecycle.status=approved`、`ticket.reviewStatus=approved`（iteration 0/5）。
