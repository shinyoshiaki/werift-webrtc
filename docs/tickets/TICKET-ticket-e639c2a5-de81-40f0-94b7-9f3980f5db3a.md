# [SCTP] Gap ACK後のT3再送でflightSizeが残存しDataChannel送信が停止する問題を修正する（#806）

- 元報告: #806（再現スクリプト・実測値・暫定パッチを含む。werift 0.24.4 / 0.26.0 / HEAD で再現）
- 調査基準: `develop` [`565dd85fb`](https://github.com/shinyoshiaki/werift-webrtc/commit/565dd85fb530d1ddfd144a0bb74171e3a5545c90)（本 worktree の HEAD `7de370c99` も `packages/sctp/src` は同一）
- 対象パッケージ: `werift-sctp`（`packages/sctp`）。`packages/webrtc` は `RTCSctpTransport` 経由で影響を受けるだけで、コード変更は不要
- **優先度: 高**（長寿命の DataChannel が、接続を保ったまま送信だけ永続的に止まる）

---

## 1. 目的と背景

### 現象

T3-rtx が一度でもタイムアウトすると、送信側 SCTP の `flightSize` が実際の未 ACK バイト数より大きいまま残ることがある。以後は `flightSize >= cwnd` が成り立ち続けるので、`transmitOnce()` は `outboundQueue` の DATA を一つも送らない。

- ICE consent は STUN で行うため、SCTP が止まっても接続は健全に見え、検知できない。
- `timerHeartbeatExpired()` は `flightSize === 0 && outboundQueue.length === 0` のときだけ HEARTBEAT を送る。そのため HEARTBEAT も止まり、パス障害検知でも回復しない。
- `send()` は最後のチャンクが `sentQueue` に移った時点で resolve する。そのため呼び出し側の `await send()` も永久に解決しない。

### 発生メカニズム（静的確認済み）

| # | 箇所 | 内容 |
|---|---|---|
| 1 | `receiveSackChunk()` gap 処理 `sctp.ts:713-723` | Gap ACK されたチャンクに `acked = true` を立て、`flightSizeDecrease()` する |
| 2 | `receiveSackChunk()` 累積 ACK `sctp.ts:684-698` | `!sChunk.acked` のときだけ `flightSizeDecrease()` する（gap ACK 済みは「減算済み」とみなす） |
| 3 | `timer3Expired()` `sctp.ts:1196-1220` | `acked` を見ずに `sentQueue` の全チャンクを `retransmit = true` にし、集計値だけ `flightSize = 0` にする |
| 4 | `transmitOnce()` 再送ループ `sctp.ts:1004-1026` | `retransmit` が立っていれば `acked` でも再送し、`flightSizeIncrease()` で加算し直す |
| 5 | 2 に戻る | 累積 ACK が来ても、`acked` が立っているチャンクは減算されない。その `bookSize` が `flightSize` に永久に残る |
| 6 | `flightSizeIncrease/Decrease` `sctp.ts:1103-1109` | チャンク単位で計上済みかを追跡しないため冪等でない。`Math.max(0, …)` の clamp が負値（過少計上）を隠している |

### 最小再現（#806）

1. 36 B / 652 B / 652 B の DATA を送る（各 1 パケット）。`flightSize = 1340`
2. 先頭 TSN を失い、後ろの 2 件を Gap ACK（`gaps: [[2, 3]]`）する。`flightSize = 36`
3. T3 が発火する。3 件とも再送され（正しくは先頭 1 件だけ）、`flightSize = 1304`
4. 全件を累積 ACK する。`sentQueue = 0` なのに `flightSize = 1304` が残り、`cwnd = 1236`
5. 新しいメッセージが `outboundQueue` から出ない

### 調査で見つかった周辺の不整合（同じ根本原因の別経路）

`flightSize` を集計値だけで管理し、clamp で辻褄を合わせている設計が根本原因である。#806 の経路以外にも、次の経路で過大計上・過少計上が起きる。

| 経路 | 箇所 | 問題 |
|---|---|---|
| T3 後に再送待ちのまま累積 ACK される | `sctp.ts:691-693` | T3 で集計を 0 にしたのに、再送前に累積 ACK されたチャンクをもう一度減算する（clamp で隠れた過少計上。輻輳制御を超えた過剰送出につながる） |
| Fast Retransmit の strike | `sctp.ts:731-739` | 3 miss で `flightSizeDecrease()` するが、再送前に再び 3 miss に達すると二重減算になる。Gap ACK 済み（`acked`）が後続 SACK から消えた reneging のケースでも二重減算になる |
| 部分信頼性の破棄 | `maybeAbandon()` `sctp.ts:1349-1376`、`updateAdvancedPeerAckPoint()` `sctp.ts:1324-1347` | 同じメッセージの他フラグメントを `abandoned` にしても減算しない。`updateAdvancedPeerAckPoint()` は `abandoned` チャンクを `sentQueue` から外すときに減算しないため、計上が残る |
| `maybeAbandon()` の位置探索バグ | `sctp.ts:1356` | `findIndex((v) => v.type === chunk.type)` は DATA チャンクなら常に 0（先頭）を返す。対象チャンクではなく先頭メッセージを破棄してしまい、対象チャンクは `abandoned` にならないまま「破棄扱い（`true` を返す）」で再送もされない |

---

## 2. 実装する変更

### 2.1 `DataChunk` に送信中の計上状態を追加する（本命）

`packages/sctp/src/chunk.ts` `DataChunk`（L182〜）に `inFlight: boolean = false` を追加する。

- `acked` = 受信確認状態（Gap ACK 済みかどうか）
- `inFlight` = 輻輳制御上、`flightSize` に計上中かどうか
- 2 つの意味を明確に分けて扱う。既存の `abandoned` / `acked` / `retransmit` / `misses` / `sentCount` と同じく public field にする（`DataChunk` は `werift-sctp` から export されている）。

### 2.2 `flightSizeIncrease/Decrease` を冪等にする

```ts
private flightSizeIncrease(chunk: DataChunk) {
  if (chunk.inFlight) return;
  chunk.inFlight = true;
  this.flightSize += chunk.bookSize;
}

private flightSizeDecrease(chunk: DataChunk) {
  if (!chunk.inFlight) return;
  chunk.inFlight = false;
  this.flightSize -= chunk.bookSize;
}
```

- `Math.max(0, …)` の clamp は外す。残す場合も、テストで不変条件を検証し、clamp が一度も効かないことを保証する。
- `flightSize` を直接書き換える箇所（`timer3Expired` の `this.flightSize = 0`）はなくし、増減はすべてこのヘルパー経由にする。

### 2.3 経路ごとの変更

| 関数 | 変更内容 |
|---|---|
| `receiveSackChunk()` 累積 ACK | `doneBytes` は従来どおり `!acked` のときだけ加算する（cwnd 成長の二重計上を防ぐ）。`flightSizeDecrease()` は無条件に呼ぶ（冪等なので安全） |
| `receiveSackChunk()` Gap ACK | 新たに ACK されたチャンクは `acked = true`、`retransmit = false`（再送予約の取り消し）にし、`flightSizeDecrease()` する |
| `receiveSackChunk()` strike | 判定条件（`!seen.has(tsn)` で `misses++`、3 で再送予約）は変えない。3 miss での `flightSizeDecrease()` は冪等になるので二重減算は起きない。reneging 時の `acked = false` も維持する（後述 4.2） |
| `timer3Expired()` | `acked \|\| abandoned` のチャンクはスキップする。残りは `maybeAbandon()` で破棄判定し、破棄でなければ `retransmit = true` にする。どちらの場合も `flightSizeDecrease()` する。`this.flightSize = 0` は削除する（ループ後は不変条件から自然に 0 になる） |
| `transmitOnce()` 再送ループ | `retransmit` が立っていても `acked \|\| abandoned` のチャンクは `retransmit = false` にして送らない（予約後に Gap ACK が届いた場合の二重防御）。スキップしたチャンクで `fastRecoveryTransmit`（cwnd を無視して 1 件送れる権利）を消費しない |
| `maybeAbandon()` | `findIndex((v) => v === chunk)` に直して対象チャンクの位置を正しく求める。`abandoned = true` にした各フラグメントを `flightSizeDecrease()` する |
| `updateAdvancedPeerAckPoint()` | `sentQueue` から `abandoned` チャンクを外すときに `flightSizeDecrease()` する（念のため。冪等） |

### 2.4 採用しない案

- #806 の暫定パッチにある「`transmitOnce()` の冒頭で `sentQueue.length === 0` なら `flightSize = 0` にする」案は、根本修正として採用しない。不整合を隠すだけで、`sentQueue` が空でない場合の過大計上（例: 長い `sentQueue` の途中に `acked` かつ計上中のチャンクが残る）は直らない。チャンク状態と集計値も乖離したままになる。
- `timer3Expired()` で `acked` をスキップするだけの修正（暫定パッチの残り 2 点）は、2.3 の一部として取り込む。ただし単独では、T3 後に累積 ACK される再送待ちチャンクの二重減算や、破棄経路の計上漏れが残る。そのため 2.1 / 2.2 と組み合わせる。

---

## 3. 技術的アプローチ（調査結果の要約）

- **不変条件で設計する**: `flightSize === Σ(sentQueue 内で inFlight のチャンクの bookSize)` を常に成り立たせる。チャンクが `sentQueue` を出るとき（累積 ACK、破棄後の advance）には必ず `inFlight = false` になっている。したがって `sentQueue.length === 0 ⇒ flightSize === 0` も自動的に成り立つ。
- **状態遷移**:
  - 未送信 → 初回送信: `inFlight = true`
  - Gap ACK / 累積 ACK / T3 での再送予約 / 3 miss での再送予約 / 破棄: `inFlight = false`
  - 再送: `inFlight = true`
- **影響する計算**: 次の計算はすべて `flightSize` を参照するため、計上が正しくなれば副作用なく直る。
  - `peerRwnd`（`peerAdvertisedRwnd - flightSize`）
  - `cwndFullyUtilized`
  - `transmitOnce()` のバースト上限 `min(flightSize + burst, cwnd)`
  - heartbeat の発行条件
- `cwnd` / `ssthresh` / `partialBytesAcked` の更新式は変えない。
- **RFC / 他実装との整合**:
  - RFC 9260 §6.3.3 (E1–E3): T3 で未 ACK の最古 TSN から再送する。
  - RFC 9260 §6.2.1 (D-iii): Gap ACK 済みでも累積 ACK まではバッファを保持し、reneging を考慮する。
  - Linux `sctp_retransmit_mark()` は T3 時に gap ACK 済みチャンクを再送対象にしない（#806 の指摘）。
- **テスト手法**: `packages/sctp/tests/sctp.test.ts` の `createMockSctp()`（`vi.fn` の transport + `SCTP.client(transport, 5000)` + `setRemotePort(5001)`）と、`(sctp as any)` で内部状態を操作する既存パターンに合わせる。#806 の再現スクリプトと同様に、`associationState = ESTABLISHED` に設定する。T3 は `timer3Cancel()` → `timer3Expired()` を直接呼ぶか、`vi.useFakeTimers()` で決定的に発火させる。`setImmediate` を数回回して非同期の送信を落ち着かせる。

---

## 4. 制約・注意点

### 4.1 スコープ

- 送信バイト数の計上修正に絞る。次の改善は別チケットに切り出す。
  - RTO バックオフ（T3 での `rto *= 2`。現状 T3 では倍にしていない）
  - T3 時の 1 パケット束ね（E3）
  - strike の対象を HTNA 以前に限定する精緻化
  - 3 miss ごとに cwnd を何度も半減する挙動
- `maybeAbandon()` の `findIndex` バグは本件の部分信頼性テストに直接関わるため、このチケットで直す。修正が大きくなる場合は別チケットに分け、本件のテストは単一フラグメントのメッセージで書く（判断ポイント）。

### 4.2 Gap ACK の reneging

- 一度 Gap ACK された TSN が後続 SACK から消えた場合（reneging）、既存の strike 経路（3 miss で `acked = false`、`retransmit = true`）で再送できるよう維持する。`acked` を永久に「再送しない」印にしない。
- reneging で `acked` が外れたチャンクは、Gap ACK の時点で `inFlight = false` なので、再送されるまで計上しない。再送時に `flightSizeIncrease()` で一度だけ加算される。
- `acked` が立ったまま（miss が 3 未満）のチャンクは T3 でスキップされる。reneging の検出は、従来どおり SACK 経路の strike に任せる。

### 4.3 その他の注意

- **TSN の比較**: `uint32Gt` / `uint32Gte` を使い、ラップアラウンドを考慮する。`localTsn` は乱数で初期化されるので、テストでは TSN を `sentQueue` から読み取って使う。
- **RTT 計測（Karn のアルゴリズム）**: `sentCount === 1` のときだけ RTT を計測する既存条件を壊さない。再送スキップで `sentCount` を増やさない。
- **`sendResetRequest()` の DATA**: `bookSize = 0` の DATA を `outboundQueue` に積む。`inFlight` は立つが加算は 0 なので問題ない。
- **パフォーマンス**: 追加は O(1) のフラグ判定だけにする。`burst.test.ts` の線形性テスト（4 倍の件数で 8 倍未満）とイベントループ遅延テストを劣化させない。`sentQueue` の全件走査を新たに増やさない。
- **公開 API**: `DataChunk.inFlight` の追加は後方互換。`changelog.md` の `## Unreleased` → `### 🐛 Bug Fixes` に `werift-sctp` の修正として記載する。`packages/sctp` には生成ドキュメントがないので、`npm run doc` は不要（root `doc/` との差分が出たら再生成する）。
- **リポジトリ規約（AGENTS.md）**:
  - テストは Arrange / Act / Assert で書き、Act / Assert のコメントは日本語にする。
  - `createMockSctp()` や送信ヘルパー、不変条件の検証ヘルパーなど共通の Arrange は `packages/sctp/tests/utils.ts` に集約する。既存の `sctp.test.ts` 内の `createMockSctp` を移すのが望ましい。
  - `npm run format` を実行する。
- **後始末**: テストの最後に `timer3Cancel()` / `heartbeatCancel()` / `sctp.stop()` を必ず呼ぶ。`vi.useFakeTimers()` を使ったら `finally` で `vi.useRealTimers()` に戻し、open handle を残さない。

---

## 5. 回帰テスト（`packages/sctp/tests/sctp.test.ts` を中心に）

共通ヘルパー（`tests/utils.ts`）の案:

- `createMockSctp()`（ESTABLISHED 状態の client と送信パケットの記録）
- `settle()`（`setImmediate` を数回回す）
- `sentDataTsns(transport, from)`（パケット先頭チャンクが DATA なら TSN を読む）
- `buildSack(cumulativeTsn, gaps, rwnd)`
- `expectFlightSizeInvariant(sctp)`（`flightSize === Σ inFlight bookSize`、`>= 0`、`sentQueue` が空なら 0）

テストケース:

- [ ] **Gap ACK → T3 → 累積 ACK（#806 の移植）**: T3 後に再送される TSN は欠落した先頭だけ。累積 ACK 後に `sentQueue.length === 0` かつ `flightSize === 0`
- [ ] **送信の復旧**: 上の続きで新しい DATA を送ると、`outboundQueue.length === 0` になり、transport に DATA パケットが実際に出る。`send()` の Promise も resolve する
- [ ] **ACK との競合**: Fast Retransmit（3 miss）または T3 で `retransmit` が立った後、実際に送る前に Gap ACK を処理する。そのチャンクは再送されず、二重加算もない
- [ ] **ACK の重複と T3 の連続発火**: 同じチャンクへの Gap ACK の重複、Gap ACK の後の累積 ACK、T3 の 2 回連続発火、T3 後に再送前の累積 ACK のいずれでも、各ステップで不変条件が成り立つ（負値にも正の残存値にもならない）
- [ ] **部分信頼性**: `maxRetransmits` / `expiry` で破棄 → FORWARD TSN 送出 → `updateAdvancedPeerAckPoint` の後に計上が残らない。複数フラグメントのメッセージでは、対象チャンクのメッセージが破棄される（`findIndex` の修正の確認）
- [ ] **Gap ACK の reneging**: Gap ACK した TSN を含まない SACK を 3 回受けると、そのチャンクが `acked = false` で再送される。再送後の累積 ACK で `flightSize === 0`
- [ ] **HEARTBEAT**: キューが空になった後に heartbeat タイマーを発火させると HEARTBEAT チャンクが送られる
- [ ] **既存テスト**: `burst.test.ts`（ロスあり・大量転送・線形性・イベントループ遅延）、`sctp.test.ts`（rwnd・タイマー・SACK ポリシー）、`stream.test.ts` / `api.test.ts` / `mtu.test.ts` / `packet.test.ts` がすべて通る

タイマーは固定値またはモックで決定的に動かし、実際の RTO 時間（秒単位）を待たない。

---

## 6. 完了条件

- [ ] T3 で Gap ACK 済み・破棄済みの DATA を再送しない
- [ ] #806 の最小再現で `sentQueue` が空になったとき `flightSize === 0` になり、以後も DataChannel / SCTP の送信が進む（`outboundQueue` が空になり、`send()` が resolve する）
- [ ] 初回送信・Gap ACK・累積 ACK・Fast Retransmit・T3・再送・破棄・FORWARD TSN のすべての経路で、`flightSize === Σ(sentQueue 内で inFlight のチャンクの bookSize)` と `flightSize >= 0` が成り立つ
- [ ] `flightSize` を直接 0 に書き換える箇所と、不整合を隠す clamp に依存する箇所がない
- [ ] reneging の再送経路が維持されている
- [ ] 上記の回帰テストを追加し、`cd packages/sctp && npm test`（type と vitest）が通る
- [ ] `npm run type` と `npm run test:small` が通る（`werift-sctp` は `packages/webrtc` から使われるため）
- [ ] `npm run format` 済み
- [ ] `changelog.md` の Unreleased に Bug Fix を記載済み
- [ ] `burst.test.ts` の性能系テストが従来どおり通る（正常系の転送性能を劣化させない）

参考: [RFC 9260 §6.2.1 / §6.3.2 / §6.3.3 / §7.2.4](https://www.rfc-editor.org/rfc/rfc9260.html)、#806


## 元 GitHub issue

https://github.com/shinyoshiaki/werift-webrtc/issues/807
