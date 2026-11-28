---
ide:
  viewer: review-document
  version: 1
  title: "TURN / ICE-TCP の接続失敗と終了競合の解説"
  dock: right
  baseCommit: a9336ef40fb4196e7f365d83e1046b403e49b563
---
# TURN / ICE-TCP の接続失敗と終了競合

## 概要

監査では、現行版の ICE/TURN 故障系から `unhandledRejection` / `uncaughtException` は出ませんでした（チケット §6 の記録）。一方で、失敗や `close()` の後も Promise、socket、refresh が残る欠陥が見つかったため、これを是正しています。中心は、TCP/TLS 接続中の abort、割り当て後の切断、ICE-TCP の接続中 close です。

発端は、下流（ds-harness-remote#241）で TURN TCP の `ETIMEDOUT` が未処理 rejection になり、プロセスが終了した報告です。下流は werift の更新と回帰テストの追加で解決したとしています。ただし、下流自身のライフサイクルが原因だった可能性は残ります。

対象は、`develop`（`286454bcd`）と承認時の head `eb9142cd2` の差分です。

| ID | 修正前の症状 | 対応 |
| --- | --- | --- |
| R1 | 割り当て後に TURN の TCP/TLS が切れても、refresh と再送が続く | 是正 |
| R2 | TCP/TLS 接続中に abort しても、`connectTimeoutMs`（既定 8 秒）まで残る | 是正 |
| R3 | ICE-TCP の接続中に close すると、送信 Promise が settle しない | 是正（connect タイムアウトの追加は見送り） |
| R4 | protocol の close が 1 つ失敗すると、残りが閉じられない（潜在リスク） | 是正 |
| R5 | `asPromise` の timeout が文字列で reject する | 見送り |

## 修正前と修正後の流れ

### R1: 割り当て後にサーバー側が切断した場合

<div style="display:flex;gap:12px;flex-wrap:wrap;font-family:var(--review-font);color:var(--review-fg);font-size:13px">
  <div style="flex:1;min-width:260px;border:1px solid var(--review-border);border-radius:6px;padding:10px">
    <strong>Before</strong>
    <div style="margin-top:6px;padding:6px;border:1px solid var(--review-border);border-radius:4px">TCP/TLS close → <code>Transport.onClosed</code></div>
    <div style="text-align:center">↓</div>
    <div style="padding:6px;border:1px solid var(--review-border);border-radius:4px"><code>allocationLost()</code>（割り当て成功後のみ通知）</div>
    <div style="text-align:center">↓</div>
    <div style="padding:6px;border:2px solid var(--review-danger);border-radius:4px">問題: refresh ループが継続</div>
    <div style="margin-top:6px;padding:6px;border:2px solid var(--review-danger);border-radius:4px">問題: 実行中の transaction は timeout まで再送</div>
    <div style="margin-top:6px;padding:6px;border:2px solid var(--review-danger);border-radius:4px">問題: 後続の要求も transaction を登録して待つ</div>
  </div>
  <div style="flex:1;min-width:260px;border:1px solid var(--review-border);border-radius:6px;padding:10px">
    <strong>After</strong>
    <div style="margin-top:6px;padding:6px;border:1px solid var(--review-border);border-radius:4px">TCP/TLS close → <code>Transport.onClosed</code></div>
    <div style="text-align:center">↓</div>
    <div style="padding:6px;border:2px solid var(--review-success);border-radius:4px"><code>transportLost()</code>: エラーを保存し、<code>allocationLost()</code> も呼ぶ</div>
    <div style="text-align:center">↓</div>
    <div style="padding:6px;border:2px solid var(--review-success);border-radius:4px">refresh ループを停止</div>
    <div style="margin-top:6px;padding:6px;border:2px solid var(--review-success);border-radius:4px">実行中の transaction を <code>fail(error)</code></div>
    <div style="margin-top:6px;padding:6px;border:2px solid var(--review-success);border-radius:4px">後続の要求は登録前に即 reject</div>
  </div>
</div>

赤枠が残っていた処理、緑枠が変更後の処理です。後続の要求には、サーバー向けの `TurnProtocol.request()` と、peer 向けの `StunOverTurnProtocol.request()` の両方が含まれます。

- 切断の処理は [packages/ice/src/turn/protocol.ts:358](review-diff:packages/ice/src/turn/protocol.ts:commit:5db606239:358) の `transportLost()` です。購読側は [packages/ice/src/turn/protocol.ts:387](review-diff:packages/ice/src/turn/protocol.ts:commit:5db606239:387) です。
- peer 向けの経路は、初回レビューの指摘（P2）を受けて追加しました。アドレス解決を `await` した後、transaction を登録する直前に [packages/ice/src/turn/protocol.ts:192](review-diff:packages/ice/src/turn/protocol.ts:commit:905324559:192) で検査します。
- 検査の本体は [packages/ice/src/turn/protocol.ts:378](review-diff:packages/ice/src/turn/protocol.ts:commit:905324559:378) の `assertUsable()` で、サーバー向けの経路は [packages/ice/src/turn/protocol.ts:740](review-diff:packages/ice/src/turn/protocol.ts:commit:905324559:740) です。切断後は喪失のエラー、`close()` 後は `TransactionCancelled` になります。

### R2: TCP/TLS 接続中に ICE agent を閉じた場合

<div style="display:flex;gap:12px;flex-wrap:wrap;font-family:var(--review-font);color:var(--review-fg);font-size:13px">
  <div style="flex:1;min-width:260px;border:1px solid var(--review-border);border-radius:6px;padding:10px">
    <strong>Before</strong>
    <div style="margin-top:6px;padding:6px;border:1px solid var(--review-border);border-radius:4px"><code>createTurnClient({ signal })</code></div>
    <div style="text-align:center">↓</div>
    <div style="padding:6px;border:1px solid var(--review-border);border-radius:4px"><code>await Tcp/TlsTransport.init()</code></div>
    <div style="text-align:center">↓ この間の abort</div>
    <div style="padding:6px;border:2px solid var(--review-danger);border-radius:4px">問題: listener が未登録で、connect の完了か timeout を待つ</div>
    <div style="text-align:center">↓</div>
    <div style="padding:6px;border:1px solid var(--review-border);border-radius:4px">abort listener を登録</div>
  </div>
  <div style="flex:1;min-width:260px;border:1px solid var(--review-border);border-radius:6px;padding:10px">
    <strong>After</strong>
    <div style="margin-top:6px;padding:6px;border:1px solid var(--review-border);border-radius:4px"><code>createTurnClient({ signal })</code></div>
    <div style="text-align:center">↓</div>
    <div style="padding:6px;border:2px solid var(--review-success);border-radius:4px"><code>init({ connectTimeoutMs, signal })</code></div>
    <div style="text-align:center">↓ この間の abort</div>
    <div style="padding:6px;border:2px solid var(--review-success);border-radius:4px"><code>StreamTransport</code> が <code>AbortError</code> で reject し、socket を destroy</div>
    <div style="text-align:center">↓</div>
    <div style="padding:6px;border:2px solid var(--review-success);border-radius:4px"><code>TransactionCancelled</code> に変換</div>
  </div>
</div>

同じ `signal` は、300（Try Alternate）の再接続にも渡ります。`TransactionCancelled` に揃えるのは、`gatherRelayCandidate` の「cancel は `onIceCandidateError` に報告しない」という判定に合わせるためです。

- `signal` の監視は [packages/common/src/transport.ts:455](review-diff:packages/common/src/transport.ts:commit:5db606239:455) にあります。
- 受け渡しは [packages/ice/src/turn/protocol.ts:1160](review-diff:packages/ice/src/turn/protocol.ts:commit:5db606239:1160)、エラーの変換は [packages/ice/src/turn/protocol.ts:1219](review-diff:packages/ice/src/turn/protocol.ts:commit:5db606239:1219) です。

### R3: ICE-TCP の接続中に socket を破棄した場合

| 段階 | Before | After |
| --- | --- | --- |
| 起点 | `getSocket()` が connect 中 | 同じ |
| `close()` / `pruneForSelection()` | `socket.destroy()`（error なし） | 同じ |
| 発火するイベント | `close` のみ。待っているのは `connect` と `error` | `close` も待つ |
| 保留中の Promise | **settle しない**。`pendingSockets` に残る | **reject する**。`finally` で `pendingSockets` から消える |

[packages/ice/src/stun/tcpProtocol.ts:346](review-diff:packages/ice/src/stun/tcpProtocol.ts:commit:5db606239:346) の `onClose` が reject します。protocol の `close()` 後は `TransactionCancelled`、それ以外は `tcp connection to <host>:<port> closed` です。

## 主要変更

| 対象 | 内容 |
| --- | --- |
| `werift-common` | `StreamTransportOptions.signal` を追加。closed 後の `send()` は即 reject |
| `werift-ice` TURN | 接続中の abort、切断時の後始末、transaction 登録前の検査 |
| `werift-ice` STUN / ICE-TCP | `Transaction.fail()` を public 化。connect 中の `close` を処理。protocol の close 失敗を隔離 |
| テスト | 故障注入テストと共有 Arrange を追加。TURN の stub に `assertUsable` を追加 |
| 文書 | `changelog.md`、生成 doc、チケットの調査・実施記録を更新 |

- 公開オプションの定義は [packages/common/src/transport.ts:39](review-diff:packages/common/src/transport.ts:commit:5db606239:39)、送信の拒否は [packages/common/src/transport.ts:506](review-diff:packages/common/src/transport.ts:commit:5db606239:506) です。
- 実行中の要求を外から失敗させる入口は [packages/ice/src/stun/transaction.ts:287](review-diff:packages/ice/src/stun/transaction.ts:commit:5db606239:287) です。
- R4 の隔離は [packages/ice/src/ice.ts:2275](review-diff:packages/ice/src/ice.ts:commit:5db606239:2275) です。現在の位置は [packages/ice/src/ice.ts:2274](review-file:packages/ice/src/ice.ts:2274) です。
- テストは [packages/ice/tests/ice/turn-failure-propagation.test.ts:54](review-file:packages/ice/tests/ice/turn-failure-propagation.test.ts:54) から始まります。故障を注入するサーバーは [packages/ice/tests/utils.ts:4607](review-file:packages/ice/tests/utils.ts:4607) です。

## 判断理由

- **再現しなかった不具合は直したことにしない。** 未処理 rejection は再現していません。是正は、テストや静的調査で werift 本体に確認できた欠陥と、潜在リスクの R4 に限っています。
- **abort は transport まで渡す。** チケットは、`createTurnClient` 内で `Promise.race` と後始末を組む案も挙げていました。採用したのは `StreamTransportOptions.signal` で、socket を持つ層が直接破棄します。
- **下流が提案した `socket.setTimeout` は採用しない。** 既存の `connectTimeoutMs` と役割が重なります。
- **ICE への通知経路は増やさない。** `onAllocationLost` の通知は 1 回のままです。TURN の候補収集に失敗しても、`gatherCandidates()` は reject しません。
- **ICE-TCP の connect タイムアウトは追加しない。** チケットの記録では、transaction 側の timeout で利用者の待ちは終わるため、新しい公開オプションを増やさない判断です。
- **R5 は見送る。** 今回の経路は `asPromise(timeLimit)` を使いません。reject の型を変えると、既存の呼び出し側に影響する可能性があります。後続チケットの番号は記録されていません。

## レビュアーが確認すべき点・リスク

**互換性と API**

- `StreamTransportOptions.signal` は公開 API の追加です。`signal` が効くのは接続の確立中だけです。`TcpTransport.init` / `TlsTransport.init` を直接使うと、abort は `AbortError` になります。
- `StreamTransport.send()` は、closed 後に `tcp transport closed` / `tls transport closed` を投げます。以前は `write` の結果に任せていたため、エラーの内容に依存する利用側には違いが出ます。`changelog.md` は、この `send()` の変更を単独の項目にしていません。
- TURN の接続が切れると、実行中の要求は `connection to the TURN server closed (...)` の通常の `Error` で失敗します。割り当ての完了前に切れた場合も、このエラーになり得ます。`ECONNRESET` などの `code` を前提にした分岐は使えません。
- `Connection.close()` は protocol の close 失敗をログに残すだけで、呼び出し側には返しません。
- `Transaction.fail()` は public になりましたが、`Transaction` は `werift-ice` の index から export されていません。`TurnProtocol.assertUsable()` は、export されるクラス上の `@internal` メソッドです。`StunOverTurnProtocol` に渡すテスト用 stub には、このメソッドが必要です。

**不変条件**

- `assertUsable()` と transaction の登録の間に `await` を入れないでください。`transportLost()` と `close()` が終了させるのは、その時点で登録済みの transaction だけです。
- redirect で置き換えた古い transport の close は、喪失として扱いません。購読側の `this.transport !== transport` と、ローカルの close では `onClosed` を出さない `StreamTransport` の動作が前提です。

**テストで直接は確認していない範囲**

- TCP の SYN が応答待ちの状態は再現していません。接続中の abort は、TLS handshake が止まるサーバーで代用しています。
- 切断の瞬間に実行中だった要求が、喪失のエラーで失敗することを直接 Assert するテストは見当たりません。R1 のテストが見るのは、切断後と、アドレス解決中の切断です。
- redirect の再接続が**確立する前**の abort には、専用テストを確認できていません。既存の `turn-close-race.test.ts` は、接続の確立後で止めて abort します。
- R3 のテストは `close()` の場合に reject と `pendingSockets` の消去を確認します。エラーが `TransactionCancelled` であることは Assert していません。`pruneForSelection()` を単独で呼ぶ場合のテストはありません。
- 下流が使っていた Windows と Electron の環境では検証していません。native Windows は werift のサポート対象外です。

## 検証結果

### この文書の作成時に実行したもの

作業ツリーの HEAD は `a9336ef40` です。`eb9142cd2` との間で、`packages/ice` と `packages/common` に差分はありません。

| コマンド（`packages/ice`） | 結果 |
| --- | --- |
| `npx vitest run tests/ice/turn-failure-propagation.test.ts tests/ice/consent-wire.test.ts` | 2 ファイル、28 テストが成功 |

型検査、全テスト、`doc:check`、format は、今回は再実行していません。

### レビュー記録からの引用（今回は再実行していない）

| 対象 | 確認内容 |
| --- | --- |
| `eb9142cd2` の承認（最後の記録） | `npm run type` 成功。common 80 件、ICE 2,422 件が成功（ICE は opt-in の Pion 連携などを含む 10 件が skip）。TURN 故障テスト 16 件が成功。`doc:check` はエラーなし（警告 42 件） |
| `eb9142cd2` のもう 1 件の承認 | `npm run test:small` は 149 ファイル、3,428 件成功、5 件 skip（同じ記録の懸念事項欄には「194 テストが skip」ともあり、数が一致しない） |

最後の承認は、この revision では workspace 全体の `test:small` と外部の Pion 連携を再実行していないと記しています。

### 修正前コードでの再現（チケット §6 の記録）

故障マトリクスを修正前のコードで実行しても、process レベルのエラーは 0 件でした。一方、R1〜R3 に関する 5 ケースが失敗しました。追加指摘の回帰テスト 3 件も、修正前は 5 秒のテスト timeout で失敗したと記録されています。この文書の作成時には、修正前コードでの実行を再現していません。
