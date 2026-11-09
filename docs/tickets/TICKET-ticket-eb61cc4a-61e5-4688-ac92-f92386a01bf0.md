# WARP 非依存の SCTP / SRTP 修正を develop へバックポートする

元チケット: `71cc0e0d-e203-4057-816d-a89b993faf26`（epic4-warp-webrtc-detailed、ブランチ `epic4-warp-webrtc-detailed`）。
WARP（DTLS readiness / early data / SPED / DTLS role 基準の SCTP）に依存せず、develop の既存実装にもそのまま存在する問題の修正だけを develop へ移す。

## 対象

### 1. SCTP の INIT 衝突と verification tag（`packages/sctp/src/sctp.ts`）

develop の問題:
- `start()` 前に相手の INIT に INIT_ACK で答えると相手の verification tag を覚え、その後 `start()` で送る自分の INIT にもその tag を付ける。RFC 9260 §8.5.1 (A) では INIT の verification tag は 0 でなければならず、受信側は破棄し得る。
- initiator（COOKIE-WAIT / COOKIE-ECHOED）は相手の INIT と COOKIE_ECHO を無視する。両端が INIT を送る衝突（RFC 9260 §5.2.1、usrsctp / dcsctp は両端から INIT を送る）で、相手の INIT に答えた後に自分も initiator になると、どちらも ESTABLISHED に進めなくなる。
- 相手の INIT で確立済みでも、遅れた `start()` が INIT を送り直す。
- `init()` は INIT の送信完了後に T1 と COOKIE-WAIT へ入るため、送信中に届いた INIT_ACK を捨て、送信失敗時は T1 が動かず再送されない。COOKIE_ECHO も同様に送信後に COOKIE-ECHOED へ入る。

修正:
- INIT は常に tag 0 で送る。自分の tag が付いた INIT（旧 werift が送る）も受け付ける。
- initiator も相手の INIT に INIT_ACK で答え、その後の COOKIE_ECHO を受け入れて T1 を止める。
- 相手の INIT で確立済みなら `start()` は INIT を送らない。
- INIT / COOKIE_ECHO は状態遷移と T1 開始を送信前に行い、送信失敗は T1 の再送に任せる。COOKIE_ACK は送信前に ESTABLISHED へ進む。

対象外（WARP 固有）: `SCTPSendPermissionRevokedError` / `cancelStart()` / `startCommitted` / `startPassiveFallbackInit()` / `retransmitStartNow()`、DTLS role 基準の SCTP 開始側と DataChannel stream ID の割り当て。

### 2. SRTP / SRTCP の受信 replay 保護（`packages/rtp/src/srtp`）

develop の問題: 受信側に RFC 3711 §3.3.2 の replay list がなく、認証に通る同じ SRTP / SRTCP パケットを再送されると何度でも上位へ渡す。

修正: SSRC ごとに 1024 パケット（`SRTP_REPLAY_WINDOW_SIZE`。libwebrtc と同じで、RFC 3711 の最小値 64 より広く、遅れた NACK 再送も受理できる）の replay window（`SrtpReplayWindow`）を持ち、既に受け取った index と window より古い index を `SrtpReplayError`（`SrtpAuthenticationError` の subclass）で拒否する。window は認証成功後にだけ作成・更新し、偽造パケットで状態が増えないようにする。

## 調査したがバックポートしないもの

- DTLS `[1.3, 1.2]` client の extended_master_secret 提示、ICE restart 中の旧 selected pair 保持、`IceTransport.close()` の二重 close guard: develop に DTLS 1.3 / WARP の datagram gate がない、または develop に既に同じ guard がある。
- DataChannel stream ID の割り当て変更と SCTP の passive fallback INIT: Epic 4 で SCTP の開始側を DTLS role に変えたことに伴う変更。develop は ICE role のまま。

## 統合したチケット

同じ `packages/sctp/src/sctp.ts` の association / 送受信状態を扱う、develop ベースの SCTP 修正チケット 3 件（3〜5）と、SCTP の開始処理を直す `27e384b5`（6）のブランチをこのブランチへマージし、チケット内容をここへ取り込んだ。統合元チケットはアーカイブし、統合元のチケットファイルはこのブランチから削除した。

統合時に決めたこと:
- reneging（Gap ACK 済みチャンクが後の SACK から消える）の処理は 2 チケットで別々に実装されていたため 1 つにまとめた。`e639c2a5` の `gapAckedChunks` は廃止し、`c49c9ef1` の `reneged` フラグと miss indication の計上（RFC 9260 §6.2.1 D-iii）を使う。取り消されたチャンクは未確認に戻して `flightSize` に再計上し（`e639c2a5` の不変条件「`flightSize` = `inFlight` チャンクの bookSize 合計」を維持）、破棄済みチャンクは再計上しない。
- `flightSizeDecrease()` は `inFlight` で冪等にしたので `Math.max(0, …)` の clamp を外した（`e639c2a5` の方針）。T3-rtx は Gap ACK 済み・破棄済みチャンクを再送も減算もしない。
- `e639c2a5` のテストが使っていた秒単位の `expiry` は、`c49c9ef1` で `expiry` を epoch ms に統一したのに合わせて ms に直した。
- FORWARD-TSN 受信時は `c49c9ef1` の再組み立て処理（`forwardSequenceNumber()` / `pruneUnorderedChunks()`）を使い、`c7fccdd1` の保留中 reset の held DATA 破棄をその後に行う。
- 別の initiate tag の INIT（相手の再開始）で受信 TSN を初期化するときは、旧 TSN 空間の保留中 reset（`deferredReset`）と前回の reconfig 応答結果（`lastReconfigResult`）も破棄する。
- `changelog.md` の flightSize に関する 2 項目は 1 項目にまとめた。
- 相手の逆方向 reset request の `responseSequence` が自分の未完了 request と一致したとき（RFC 6525 §5.2.2 E1）、`c7fccdd1` は再構成タイマーを止めていたが、成功応答が失われると request が残り続け後続の reset も送れなくなる。そのため request は成功応答まで残したまま、In progress と同様に失敗回数を数えずに再送を続ける（相手は処理済み request の再送に同じ結果を返す）。
- 送信待ち（`outboundQueue`）メッセージの寿命切れは `transmit()` のキュー先頭でしか判定されず、相手の受信ウィンドウが 0 で未確認 DATA もないときや、寿命なしメッセージの後ろにあるときは、期限後も `send()`（と DataChannel の `bufferedAmount`）が残った。そのため `send()` で期限付きメッセージを積むとキュー内の最も早い `expiry` にタイマーを張り、満了時にキュー全体を走査して期限切れのメッセージをその場で破棄済みにし、`send()` を先行メッセージより先に解決する（`sendWaiters` に `done` を持たせ、先頭から取り除く）。TSN 順を保つためチャンクはキューに残し、先頭に来たら送らずに `sentQueue` へ移して FORWARD-TSN で飛ばす。次に早い期限へ張り直し、キューが空になったとき、`stop()`、相手の ABORT やタイムアウトによる CLOSED 遷移で解除する（閉じた後の `stop()` は早期 return するため、CLOSED 遷移でも解除しないとタイマーが残り Node.js プロセスが終了できない）。破棄済みチャンクは送信も再送もしないので、`markAbandoned()` でペイロード（`userData`）を手放し、`bookSize` と TSN / stream のメタデータだけを残す（先行メッセージが詰まったまま期限付きメッセージを送り続けてもメモリが増え続けない）。

### 3. [SCTP] Gap ACK後のT3再送でflightSizeが残存しDataChannel送信が停止する問題を修正する（#806）

統合元チケット: `e639c2a5-de81-40f0-94b7-9f3980f5db3a`（ブランチ `ticket/e639c2a5-de81-40f0-94b7-9f3980f5db3a`）。以下は統合元チケットファイルの内容。

- 元報告: #806（再現スクリプト・実測値・暫定パッチを含む。werift 0.24.4 / 0.26.0 / HEAD で再現）
- 調査基準: `develop` [`565dd85fb`](https://github.com/shinyoshiaki/werift-webrtc/commit/565dd85fb530d1ddfd144a0bb74171e3a5545c90)（本 worktree の HEAD `7de370c99` も `packages/sctp/src` は同一）
- 対象パッケージ: `werift-sctp`（`packages/sctp`）。`packages/webrtc` は `RTCSctpTransport` 経由で影響を受けるだけで、コード変更は不要
- **優先度: 高**（長寿命の DataChannel が、接続を保ったまま送信だけ永続的に止まる）

---

#### 1. 目的と背景

##### 現象

T3-rtx が一度でもタイムアウトすると、送信側 SCTP の `flightSize` が実際の未 ACK バイト数より大きいまま残ることがある。以後は `flightSize >= cwnd` が成り立ち続けるので、`transmitOnce()` は `outboundQueue` の DATA を一つも送らない。

- ICE consent は STUN で行うため、SCTP が止まっても接続は健全に見え、検知できない。
- `timerHeartbeatExpired()` は `flightSize === 0 && outboundQueue.length === 0` のときだけ HEARTBEAT を送る。そのため HEARTBEAT も止まり、パス障害検知でも回復しない。
- `send()` は最後のチャンクが `sentQueue` に移った時点で resolve する。そのため呼び出し側の `await send()` も永久に解決しない。

##### 発生メカニズム（静的確認済み）

| # | 箇所 | 内容 |
|---|---|---|
| 1 | `receiveSackChunk()` gap 処理 `sctp.ts:713-723` | Gap ACK されたチャンクに `acked = true` を立て、`flightSizeDecrease()` する |
| 2 | `receiveSackChunk()` 累積 ACK `sctp.ts:684-698` | `!sChunk.acked` のときだけ `flightSizeDecrease()` する（gap ACK 済みは「減算済み」とみなす） |
| 3 | `timer3Expired()` `sctp.ts:1196-1220` | `acked` を見ずに `sentQueue` の全チャンクを `retransmit = true` にし、集計値だけ `flightSize = 0` にする |
| 4 | `transmitOnce()` 再送ループ `sctp.ts:1004-1026` | `retransmit` が立っていれば `acked` でも再送し、`flightSizeIncrease()` で加算し直す |
| 5 | 2 に戻る | 累積 ACK が来ても、`acked` が立っているチャンクは減算されない。その `bookSize` が `flightSize` に永久に残る |
| 6 | `flightSizeIncrease/Decrease` `sctp.ts:1103-1109` | チャンク単位で計上済みかを追跡しないため冪等でない。`Math.max(0, …)` の clamp が負値（過少計上）を隠している |

##### 最小再現（#806）

1. 36 B / 652 B / 652 B の DATA を送る（各 1 パケット）。`flightSize = 1340`
2. 先頭 TSN を失い、後ろの 2 件を Gap ACK（`gaps: [[2, 3]]`）する。`flightSize = 36`
3. T3 が発火する。3 件とも再送され（正しくは先頭 1 件だけ）、`flightSize = 1304`
4. 全件を累積 ACK する。`sentQueue = 0` なのに `flightSize = 1304` が残り、`cwnd = 1236`
5. 新しいメッセージが `outboundQueue` から出ない

##### 調査で見つかった周辺の不整合（同じ根本原因の別経路）

`flightSize` を集計値だけで管理し、clamp で辻褄を合わせている設計が根本原因である。#806 の経路以外にも、次の経路で過大計上・過少計上が起きる。

| 経路 | 箇所 | 問題 |
|---|---|---|
| T3 後に再送待ちのまま累積 ACK される | `sctp.ts:691-693` | T3 で集計を 0 にしたのに、再送前に累積 ACK されたチャンクをもう一度減算する（clamp で隠れた過少計上。輻輳制御を超えた過剰送出につながる） |
| Fast Retransmit の strike | `sctp.ts:731-739` | 3 miss で `flightSizeDecrease()` するが、再送前に再び 3 miss に達すると二重減算になる。Gap ACK 済み（`acked`）が後続 SACK から消えた reneging のケースでも二重減算になる |
| 部分信頼性の破棄 | `maybeAbandon()` `sctp.ts:1349-1376`、`updateAdvancedPeerAckPoint()` `sctp.ts:1324-1347` | 同じメッセージの他フラグメントを `abandoned` にしても減算しない。`updateAdvancedPeerAckPoint()` は `abandoned` チャンクを `sentQueue` から外すときに減算しないため、計上が残る |
| `maybeAbandon()` の位置探索バグ | `sctp.ts:1356` | `findIndex((v) => v.type === chunk.type)` は DATA チャンクなら常に 0（先頭）を返す。対象チャンクではなく先頭メッセージを破棄してしまい、対象チャンクは `abandoned` にならないまま「破棄扱い（`true` を返す）」で再送もされない |

---

#### 2. 実装する変更

##### 2.1 `DataChunk` に送信中の計上状態を追加する（本命）

`packages/sctp/src/chunk.ts` `DataChunk`（L182〜）に `inFlight: boolean = false` を追加する。

- `acked` = 受信確認状態（Gap ACK 済みかどうか）
- `inFlight` = 輻輳制御上、`flightSize` に計上中かどうか
- 2 つの意味を明確に分けて扱う。既存の `abandoned` / `acked` / `retransmit` / `misses` / `sentCount` と同じく public field にする（`DataChunk` は `werift-sctp` から export されている）。

##### 2.2 `flightSizeIncrease/Decrease` を冪等にする

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

##### 2.3 経路ごとの変更

| 関数 | 変更内容 |
|---|---|
| `receiveSackChunk()` 累積 ACK | `doneBytes` は従来どおり `!acked` のときだけ加算する（cwnd 成長の二重計上を防ぐ）。`flightSizeDecrease()` は無条件に呼ぶ（冪等なので安全） |
| `receiveSackChunk()` Gap ACK | 新たに ACK されたチャンクは `acked = true`、`retransmit = false`（再送予約の取り消し）にし、`flightSizeDecrease()` する |
| `receiveSackChunk()` strike | 判定条件（`!seen.has(tsn)` で `misses++`、3 で再送予約）は変えない。3 miss での `flightSizeDecrease()` は冪等になるので二重減算は起きない。reneging 時の `acked = false` も維持する（後述 4.2） |
| `timer3Expired()` | `acked \|\| abandoned` のチャンクはスキップする。残りは `maybeAbandon()` で破棄判定し、破棄でなければ `retransmit = true` にする。どちらの場合も `flightSizeDecrease()` する。`this.flightSize = 0` は削除する（ループ後は不変条件から自然に 0 になる） |
| `transmitOnce()` 再送ループ | `retransmit` が立っていても `acked \|\| abandoned` のチャンクは `retransmit = false` にして送らない（予約後に Gap ACK が届いた場合の二重防御）。スキップしたチャンクで `fastRecoveryTransmit`（cwnd を無視して 1 件送れる権利）を消費しない |
| `maybeAbandon()` | `findIndex((v) => v === chunk)` に直して対象チャンクの位置を正しく求める。`abandoned = true` にした各フラグメントを `flightSizeDecrease()` する |
| `updateAdvancedPeerAckPoint()` | `sentQueue` から `abandoned` チャンクを外すときに `flightSizeDecrease()` する（念のため。冪等） |

##### 2.4 採用しない案

- #806 の暫定パッチにある「`transmitOnce()` の冒頭で `sentQueue.length === 0` なら `flightSize = 0` にする」案は、根本修正として採用しない。不整合を隠すだけで、`sentQueue` が空でない場合の過大計上（例: 長い `sentQueue` の途中に `acked` かつ計上中のチャンクが残る）は直らない。チャンク状態と集計値も乖離したままになる。
- `timer3Expired()` で `acked` をスキップするだけの修正（暫定パッチの残り 2 点）は、2.3 の一部として取り込む。ただし単独では、T3 後に累積 ACK される再送待ちチャンクの二重減算や、破棄経路の計上漏れが残る。そのため 2.1 / 2.2 と組み合わせる。

---

#### 3. 技術的アプローチ（調査結果の要約）

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

#### 4. 制約・注意点

##### 4.1 スコープ

- 送信バイト数の計上修正に絞る。次の改善は別チケットに切り出す。
  - RTO バックオフ（T3 での `rto *= 2`。現状 T3 では倍にしていない）
  - T3 時の 1 パケット束ね（E3）
  - strike の対象を HTNA 以前に限定する精緻化
  - 3 miss ごとに cwnd を何度も半減する挙動
- `maybeAbandon()` の `findIndex` バグは本件の部分信頼性テストに直接関わるため、このチケットで直す。修正が大きくなる場合は別チケットに分け、本件のテストは単一フラグメントのメッセージで書く（判断ポイント）。

##### 4.2 Gap ACK の reneging

- 一度 Gap ACK された TSN が後続 SACK から消えた場合（reneging）、既存の strike 経路（3 miss で `acked = false`、`retransmit = true`）で再送できるよう維持する。`acked` を永久に「再送しない」印にしない。
- reneging で `acked` が外れたチャンクは、Gap ACK の時点で `inFlight = false` なので、再送されるまで計上しない。再送時に `flightSizeIncrease()` で一度だけ加算される。
- `acked` が立ったまま（miss が 3 未満）のチャンクは T3 でスキップされる。reneging の検出は、従来どおり SACK 経路の strike に任せる。

##### 4.3 その他の注意

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

#### 5. 回帰テスト（`packages/sctp/tests/sctp.test.ts` を中心に）

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

#### 6. 完了条件

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


#### 元 GitHub issue

https://github.com/shinyoshiaki/werift-webrtc/issues/807

### 4. Bug: DataChannel maxPacketLifeTime expiry mixes ms and seconds, so lifetime-based abandon does not work

統合元チケット: `c49c9ef1-1bf3-4dbf-97ea-8eba3401de13`（ブランチ `ticket/c49c9ef1-1bf3-4dbf-97ea-8eba3401de13`）。以下は統合元チケットファイルの内容。

Found while fixing ticket 340fdd75 (DCEP unordered channel types).

#### 1. Purpose and background

`RTCDataChannel.maxPacketLifeTime` is in **milliseconds** (W3C WebRTC `RTCDataChannelInit.maxPacketLifeTime`; RFC 8832 §5.1, the DCEP `Reliability Parameter` for `DATA_CHANNEL_PARTIAL_RELIABLE_TIMED`). A message that is still unacknowledged after that many ms should be abandoned with PR-SCTP (RFC 3758), and FORWARD-TSN should move the peer's cumulative TSN past it.

werift mixes units along this path, so a lifetime-limited chunk is **never** abandoned:

| Location | Current code | Unit |
| --- | --- | --- |
| `packages/webrtc/src/transport/sctp.ts` `dataChannelFlush()` (~L343-346) | `Date.now() + channel.maxPacketLifeTime / 1000` | epoch **ms** + lifetime in **s** (lifetime shrinks 1000x, but the value is still about 1.7e12) |
| `packages/sctp/src/sctp.ts` `maybeAbandon()` (~L1349-1353) | `chunk.expiry < Date.now() / 1000` | compares in epoch **seconds** (about 1.7e9) |
| `packages/webrtc/src/dataChannel.ts` `RTCDataChannelParameters` (L161) | `maxPacketLifeTime?: number; // sec` | comment is wrong (the value is ms) |

So `expiry` (about 1.7e12) is always greater than `Date.now()/1000` (about 1.7e9), and `maybeAbandon()` never abandons on lifetime. The only effect of `maxPacketLifeTime` today is the DCEP OPEN channel type and reliability value.

Notes:
- `packages/sctp/tests/mtu.test.ts:98` already passes `expiry: Date.now() + 10_000` (epoch ms). The tests already assume the `expiry` contract is epoch ms.
- On the receive side, DCEP OPEN `reliability` goes into `maxPacketLifeTime` unchanged (`transport/sctp.ts` ~L166-176). That is ms and correct as is.
- The DCEP OPEN send side (`reliability = channel.maxPacketLifeTime`, L273-276) is also ms and correct as is.

#### 2. Changes to implement

1. **Use one unit (epoch ms) for `expiry`** (recommended)
   - `packages/sctp/src/sctp.ts` `maybeAbandon()`: change `chunk.expiry < Date.now() / 1000` to `chunk.expiry <= Date.now()` (or `<`).
   - `packages/webrtc/src/transport/sctp.ts` `dataChannelFlush()`: change `Date.now() + channel.maxPacketLifeTime / 1000` to `Date.now() + channel.maxPacketLifeTime`.
   - Add TSDoc to the `expiry` option of `SCTP.send()` and to `DataChunk.expiry` (`packages/sctp/src/chunk.ts:198`) saying it is "absolute time in `Date.now()` epoch milliseconds".
2. **Fix the comment**: change `// sec` in `RTCDataChannelParameters.maxPacketLifeTime` to milliseconds. Writing it as TSDoc (`/** Lifetime in milliseconds (RFC 8832 / WebRTC). */`) also carries it into the generated docs.
3. **Add tests** (see section 3).
4. **Update docs and changelog**
   - Add a Fix entry to `changelog.md` `## Unreleased`: DataChannel `maxPacketLifeTime` now abandons messages after the given ms.
   - `werift-sctp`: `SCTP.send({ expiry })` is now interpreted as epoch ms. A caller that passed epoch seconds would now see every chunk abandoned at its first retransmission decision, so record this under ⚠️ Breaking changes (or as a clear behavior change).
   - If TSDoc changes, regenerate with `npm run doc` (`doc/classes/RTCDataChannelParameters.md` and others). Don't edit generated docs by hand.

##### Alternative (not recommended)

Keep sctp in seconds and change webrtc to `(Date.now() + maxPacketLifeTime) / 1000`. This conflicts with the existing tests (mtu.test.ts) that use ms, uses floating-point seconds, and doesn't match `Date.now()`. Prefer unifying on ms.

#### 3. Technical approach (findings)

##### When abandonment is evaluated
`maybeAbandon()` is only called when a retransmission decision is made:
- `timer3Expired()` (~L1197-1206): runs over every chunk in `sentQueue`, then `updateAdvancedPeerAckPoint()`
- When SACK gap reports reach `misses === 3` (fast retransmit, ~L725-741), then `updateAdvancedPeerAckPoint()` (~L781)

`updateAdvancedPeerAckPoint()` (~L1324-1347) takes the abandoned chunks off the front of `sentQueue` and builds `forwardTsnChunk`. `transmitOnce()` (~L987-996) sends it before any other data. So chunks that are delivered without loss need no abandonment, and fixing the comparison is enough to meet the ticket's requirement.

##### Test design (packages/sctp)
- Use `createConnectedSctpPair({ dropClient })` (`packages/sctp/tests/utils.ts`) and drop the client's DATA packets (`burst.test.ts` has a `dropDataPacketsAt`-style helper you can reuse; if you need a general one, move it into `tests/utils.ts`).
- Arrange: connected pair, a transport that drops the first transmission (and its retransmissions) of the target DATA chunk.
- Act: `client.send(streamId, ppid, data, { expiry: Date.now() + 100, ordered: true })`, then advance time past the lifetime and past T3 (initial RTO `SCTP_RTO_INITIAL = 3` s).
  - Real timers take 3 s or more. Consider `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })` + `vi.advanceTimersByTimeAsync()`. `MemoryTransport` uses `setImmediate`, so keep it out of `toFake` (see the existing fake-timer usage in `sctp.test.ts:133`).
- Assert:
  - The client sent a FORWARD-TSN (`ForwardTsnChunk.type`) and its `cumulativeTsn` is the abandoned chunk's TSN (parse sent packets with `parsePacket`, or check the DATA chunk did not stay in `client.sentQueue`).
  - The server's `lastReceivedTsn` moved to that TSN, and a following message on the same stream reaches the server's `onReceive` (it doesn't stall in ordered delivery).
  - Contrast case: a chunk with a long `expiry` (for example +10 s) is retransmitted, not abandoned, when T3 expires.
- Write Act / Assert comments in Japanese, and put shared Arrange code in `tests/utils.ts` (root AGENTS.md Do 6).

##### Test design (packages/webrtc, optional)
- Spy on `RTCSctpTransport` and check that `sctp.send` receives `expiry ≈ Date.now() + maxPacketLifeTime` (in ms). One unit test that pins down the webrtc-side conversion is enough. An E2E-level test that loses packets is hard in werift-to-werift and is out of scope.

#### 4. Constraints and cautions

- **Related bugs found nearby** (decide whether to fix them here or split them into tickets):
  1. `maybeAbandon()` searches with `this.sentQueue.findIndex((v) => v.type === chunk.type)`. Every DATA chunk has the same `type`, so this always returns the **first DATA chunk in sentQueue**. For a fragmented message, or when the target is not at the head, the wrong message's fragments get marked abandoned (aiortc uses `self._sent_queue.index(chunk)`). This is likely to show up once lifetime abandonment starts working, so **fixing it in the same change is recommended** (`findIndex((v) => v === chunk)`). Add a test that abandons a fragmented message and checks that all of its fragments, and only those, are marked.
  2. With `!!chunk.maxRetransmits`, `maxRetransmits: 0` (no retransmission) is falsy and is never abandoned. Out of scope for this ticket, but worth recording as a separate ticket.
  3. Chunks that are still in `outboundQueue` (never sent) are not checked for expiry. RFC 3758 allows abandoning before the first transmission, but that is optional and out of scope here.
- In the FORWARD-TSN `streams` list, unordered chunks are excluded (handled in `updateAdvancedPeerAckPoint`). Make sure ticket 340fdd75 (unordered channel types) still behaves correctly.
- FORWARD-TSN is sent only when `remotePartialReliability` is true (default true; L142/L559). The tests use werift-to-werift, so this holds.
- Changing the meaning of `expiry` in werift-sctp affects its public API. Record it in the changelog.
- Per root AGENTS.md: don't check out or stash the active worktree; compare against another revision only in a temporary worktree.

#### 5. Done when

- [ ] `maxPacketLifeTime` (ms) is handled in ms from webrtc to sctp (no `/ 1000` mixing left in `dataChannelFlush()` or `maybeAbandon()`).
- [ ] The `RTCDataChannelParameters.maxPacketLifeTime` comment/TSDoc says milliseconds, and the `SCTP.send` `expiry` option has TSDoc saying epoch ms.
- [ ] New test in `packages/sctp/tests`: a lifetime-limited chunk that is not delivered is abandoned after the lifetime, a FORWARD-TSN is sent, and the receiver's cumulative TSN advances (Arrange / Act / Assert, Japanese comments).
- [ ] Contrast test: a chunk whose lifetime has not expired is retransmitted and not abandoned.
- [ ] (Recommended) The `maybeAbandon()` `findIndex` bug is fixed, with a fragment abandonment test.
- [ ] `changelog.md` `Unreleased` records the fix and the werift-sctp `expiry` unit change.
- [ ] If TSDoc changed, `npm run doc` has regenerated the docs.
- [ ] `cd packages/sctp && npm test`, `cd packages/webrtc && npm test` (at least the DataChannel / sctp tests), `npm run type`, and `npm run test:small` pass, and `npm run format` has been run.

### 5. SCTP: defer incoming stream reset until DATA through Sender's Last Assigned TSN is received

統合元チケット: `c7fccdd1-e5ad-444a-91c8-4992de7ab3a5`（ブランチ `ticket/c7fccdd1-e5ad-444a-91c8-4992de7ab3a5`）。以下は統合元チケットファイルの内容。

#### 1. 目的と背景

##### 目的

相手から届く SCTP Outgoing SSN Reset Request（RFC 6525 §4.1, §5.2.2）を、その **Sender's Last Assigned TSN**（以下 `lastTsn`）までの DATA を全部受け取ってから実行するようにする。こうすれば、stream reset が再送 DATA を追い越しても、最後のユーザーメッセージを取りこぼさない（RFC 6525 の deferred reset processing）。

##### 背景・起票時の情報

* downstream の相互接続テスト `sidorares/react-x11-components#1154`（<https://github.com/sidorares/react-x11-components/pull/1154>）で、最後の DataChannel メッセージのチャンクを 1 つわざと落とすと、64 KiB のメッセージが 1 件まるごと届かない現象が決定的に再現した。
* 送信側は欠けたチャンクを再送するが、その前に Stream Reset が届く。werift はすぐに inbound stream を削除して DataChannel を閉じるため、後から来た再送チャンクは捨てられる。
* downstream の回避策は「自分が close する前に、その stream の DATA が全部 ACK されるのを待つ」もの。これは自分が送信側のときしか効かず、**相手が送った reset が相手自身の再送を追い越すケース**では werift を守れない。
* 起票時点で `werift 0.25.2` と `develop`（v0.26.0 の作業を含む）の両方に残っている。v0.26.0 の SCTP キュー改善（`ee6ae1055`）は送信/ACK のスケーリングを改善しただけで、deferred reset は実装していない。

##### 現状コードの調査結果

| 箇所 | 現状 |
| --- | --- |
| `packages/sctp/src/param.ts:21-69` `OutgoingSSNResetRequestParam` | `lastTsn` の parse/serialize はできているが、受信側では一度も参照されていない。 |
| `packages/sctp/src/param.ts:116-119` `reconfigResult` | 定義は `ReconfigResultSuccessPerformed: 1` と `BadSequenceNumber: 5` だけ。`In progress (6)`、`Success - Nothing to do (0)`、`Denied (2)`、`Error - Request already in progress (4)` などがない。 |
| `packages/sctp/src/sctp.ts:566-598` `receiveReconfigParam()` の `OutgoingSSNResetRequestParam` 分岐 | `lastTsn` を見ないまま、すぐに (1) `SuccessPerformed` を返し、(2) `delete this.inboundStreams[streamId]`、(3) 逆方向の reset を `reconfigQueue` に積んで `transmitReconfigRequest()`、(4) `onReconfigStreams.execute(p.streams)`（webrtc 側で DataChannel が `closed` になる）。**`requestSequence` の検証（期待値・重複・不正値）もない**ため、再送された request も毎回処理される。 |
| `packages/sctp/src/sctp.ts:642-668` `receiveDataChunk()` | `markReceived()` で `lastReceivedTsn`（cumulative TSN）を進め、`getInboundStream()` に `addChunk` → `popMessages()` で配信する。stream が削除済みなら `getInboundStream()` が**新しい `InboundStream`（SSN=0）を作る**ので、reset 後に届いた古い再送チャンクは中途半端なフラグメントとして残り、配信されない。 |
| `packages/sctp/src/sctp.ts:786-827` `receiveForwardTsnChunk()` | PR-SCTP で `lastReceivedTsn` を進める。ここも deferred reset を再評価すべき地点。 |
| `packages/sctp/src/sctp.ts:855-876` `markReceived()` | cumulative TSN が進む唯一の地点（DATA 経由）。 |
| `packages/sctp/src/sctp.ts:194-201` | `reconfigResponseSeq` は「最後に処理した incoming request の seq（初期値は peer initialTsn - 1）」。`init` / `initAck` 受信時に `tsnMinusOne(initialTsn)` で初期化される（`sctp.ts:370, 416`）。 |
| `packages/sctp/src/sctp.ts:599-628` `ReconfigResponseParam` 分岐（自分が送った request への応答） | 結果が `SuccessPerformed` 以外ならログを出すだけ。`reconfigRequest` は残り、`timerReconfigHandleExpired` が再送する。`In progress` も「失敗」としてログに出て、再送のたびに `timerReconfigFailures` が増える。上限 `SCTP_MAX_ASSOCIATION_RETRANS` を超えると association が `CLOSED` になる（`sctp.ts:1241-1262`）。 |
| `packages/sctp/src/sctp.ts:905-920` `send()` | TSN は `send()` でキューに積んだ時点で採番される。そのため werift が送る request の `lastTsn = tsnMinusOne(localTsn)`（`sctp.ts:1069-1074`）には、まだ送っていないキュー内の DATA も含まれる。相手が deferred reset を正しく実装していれば、送信側の werift は問題ない。 |
| `packages/webrtc/src/transport/sctp.ts:83-92` | `onReconfigStreams` を受けると、該当 DataChannel を `closing` → `closed` にして `dataChannels` から削除する。SCTP 層で `onReconfigStreams` の発火を遅らせれば、DataChannel の close も自然に遅れる。webrtc 層の変更は原則不要。 |

#### 2. 実装すべき機能・変更内容

##### 2.1 incoming Outgoing SSN Reset Request の deferred reset processing（必須）

RFC 6525 §5.2.2 に従い、`OutgoingSSNResetRequestParam` を受けたときに次を行う。

1. **Request Sequence Number を検証する**（RFC 6525 §5.2.1、冪等性のため）
   * `requestSequence === tsnPlusOne(reconfigResponseSeq)`（次に期待する値）なら新規 request として処理する。
   * `requestSequence === reconfigResponseSeq`（処理済み request の再送）なら、状態は変えず、**前回と同じ result をもう一度返す**。
   * 現在保留中の deferred request と同じ seq なら、もう一度評価する（届いていれば実行して `SuccessPerformed`、まだなら再び `In progress`）。
   * それ以外は `BadSequenceNumber` を返し、何もしない。
2. **TSN 境界を判定する**
   * `uint32Gte(lastReceivedTsn, p.lastTsn)` が成り立てば、従来どおりすぐに reset を実行し `SuccessPerformed` を返す。
   * 成り立たなければ **deferred reset** に入る。`ReconfigResponseParam(requestSequence, InProgress = 6)` を返し、request を保留状態として覚えておく。この時点では `reconfigResponseSeq` を進めない（再送 request をもう一度評価するため）。
3. **保留中の扱い**
   * 対象 stream の inbound 状態（`InboundStream` と再組立てバッファ、SSN）は残し、`lastTsn` 以下の DATA（再送を含む）は従来どおり受信・再組立て・配信する。
   * 対象 stream 宛てで TSN が `lastTsn` より大きい DATA は、RFC の要求どおり reset 後の stream に属するものとして**別バッファに退避し、配信しない**（TSN は `markReceived()` で受信済みとして SACK に反映する。rwnd の扱いにも注意）。
   * `onReconfigStreams` の発火、`inboundStreams` の削除、逆方向の reset（`reconfigQueue` への追加と `transmitReconfigRequest()`）は**すべて実行時まで遅らせる**。
4. **保留を解消するタイミング**
   * `markReceived()`（DATA）と `receiveForwardTsnChunk()`（FORWARD-TSN）で cumulative TSN が進んだあと、保留中 request を評価し、`uint32Gte(lastReceivedTsn, pending.lastTsn)` になったら実行する。
   * 評価は、そのパケットで配信できるメッセージを `onReceive` に渡し**終えてから**行う。境界までの最後のメッセージが `onReconfigStreams` より先に届くことを保証するため。
   * 実行内容は、inbound stream の削除（SSN を 0 にリセット）、退避した `lastTsn` 超の DATA を新しい `InboundStream` に入れ直して配信判定、逆方向の reset の送出、`onReconfigStreams.execute(streams)`、`reconfigResponseSeq = requestSequence`、最後の result を `SuccessPerformed` として記録。
   * 実行後に相手が request を再送してきたら、1 の重複判定で `SuccessPerformed` を返す（dcsctp と同じ方式）。保留が解けた時点で `SuccessPerformed` をこちらから能動的に送るかは実装時に決める（RFC 上は必須ではない）。
5. **後始末**
   * `stop()` / association close / abort のときに保留状態と退避バッファを捨てる。

##### 2.2 `reconfigResult` の拡充（必須）

`packages/sctp/src/param.ts` の `reconfigResult` に RFC 6525 §4.4 の値を追加する。少なくとも `SuccessNothingToDo: 0`、`Denied: 2`、`ErrorWrongSSN: 3`、`ErrorRequestAlreadyInProgress: 4`、`InProgress: 6` を足す。既存のキー名 `ReconfigResultSuccessPerformed` と `BadSequenceNumber` は public export なので変えない。

##### 2.3 自分が送った request への `In progress` 応答（推奨）

相手（Chrome の dcsctp / usrsctp、または修正後の werift）が `In progress` を返したとき、werift が送信側として壊れないようにする。

* `In progress` を失敗としてログに出さない。`reconfigRequest` は残し、Re-configuration timer で同じ request を再送する。
* `In progress` が続いただけで `SCTP_MAX_ASSOCIATION_RETRANS` を超えて association が閉じないよう、失敗カウントの扱いを見直す。応答は届いているので、到達性の失敗には数えない。

##### 2.4 テスト（必須）

`packages/sctp/tests/` に deferred reset の回帰テストを追加する（例: `reconfig.test.ts`）。

* **決定的なユニットテスト**（パケットを直接注入する）。`sctp.test.ts` の `createMockSctp` / `handleData` 注入と同じ方式で、モック transport 上の SCTP を `ESTABLISHED` にし、`lastReceivedTsn` を設定してから行う。
  1. 複数フラグメントの ordered メッセージのうち、最後の 1 フラグメントだけ欠けた状態で DATA を注入する。
  2. その欠けた TSN を `lastTsn` に持つ Outgoing SSN Reset Request を注入する。
  3. Assert: 応答が `In progress (6)`、`onReconfigStreams` は未発火、メッセージは未配信。
  4. 欠けていたフラグメントを注入する。
  5. Assert: 完全なメッセージが `onReceive` に届き、**そのあとで** `onReconfigStreams` が発火する。
* 追加で検証するケース
  * 1 つの request に複数 stream が含まれる場合
  * TSN wrap（`lastTsn` が `0xffffffff` 付近をまたぐ）
  * FORWARD-TSN で境界を越えたときに reset が実行されること（PR-SCTP / partial reliability）
  * 重複 request（同じ seq の再送）で状態が二重に変わらず、同じ result が返ること。保留中の再送は `In progress` のまま、実行後の再送は `SuccessPerformed`
  * `lastTsn` 以下の DATA がすでに全部届いている場合は、従来どおりすぐに実行されること（非回帰）
  * 保留中に届いた、対象 stream 宛てで `lastTsn` より大きい DATA が reset 後の stream（SSN=0）として扱われること
  * 不正な seq に `BadSequenceNumber` が返ること
* **統合寄りのテスト**（任意、推奨）。`createConnectedSctpPair({ dropClient: dropDataPacketsAt([...]) })` で 64 KiB 程度のメッセージの最後のフラグメントを落とし、送信直後に `reconfigQueue.push(streamId)` と `transmitReconfigRequest()` を呼ぶ。T3 再送のあとにメッセージが完全に届き、そのあとで両方向の reset が完了すること、association が閉じないことを確認する。
* 共有の Arrange（reset request パケットを組み立てて注入する、ESTABLISHED のモック SCTP を作る、など）は `packages/sctp/tests/utils.ts` にまとめる。Act / Assert には日本語でコメントを付ける（ルート `AGENTS.md` の Do 6）。

#### 3. 技術的な実装アプローチ（調査結果のまとめ）

##### RFC 6525 の要点

* §5.2.2: Sender's Last Assigned TSN が cumulative acknowledgment point より大きければ、"deferred reset processing" に入らなければならない（MUST）。その間、対象 stream 宛てで `lastTsn` より大きい TSN の DATA は、cumulative point が `lastTsn` に届くまでキューに保持しなければならない（MUST）。届いた時点で reset を実行する（MUST）。deferred に入ったら `In progress` を返す（MUST）。
* §5.2.1: Request Sequence Number は「期待値なら処理」「直前に処理したもの（重複）なら前回の応答を再送」「それ以外は `Error - Bad Sequence Number`」。
* §4.4: result の値は 0 = Success-Nothing to do、1 = Success-Performed、2 = Denied、3 = Error-Wrong SSN、4 = Error-Request already in progress、5 = Error-Bad Sequence Number、6 = In progress。

##### 参考実装（dcsctp, Chrome の SCTP）

`StreamResetHandler::HandleResetOutgoing` は、`sender_last_assigned_tsn` が cumulative ack TSN より新しければ `ReassemblyQueue` に deferred reset を登録して `kInProgress` を返す。このとき `last_processed_req_seq_nbr_` は更新しない（再送された request をもう一度評価するため）。DATA を受け取るたびに `MaybeResetStreamsDeferred(cum_ack_tsn)` で reset を実行し、その後の request 再送には `kSuccessPerformed` を返す。werift でもこの構成が素直に実装できる。

##### werift での実装方針案

```ts
// sctp.ts（イメージ）
private deferredReset?: {
  request: OutgoingSSNResetRequestParam;
  heldChunks: DataChunk[]; // 対象 stream 宛てで tsn > lastTsn の DATA
};
private lastReconfigResult?: ReconfigResult; // 重複 request に再送する値
```

* `receiveReconfigParam` の `OutgoingSSNResetRequestParam` 分岐を「seq 検証 → 境界判定 → 即時実行 / 保留」に書き換える。実行処理は `performIncomingStreamReset(request)` のような private メソッドに切り出し、即時実行と保留解除の両方から呼ぶ。
* `receiveDataChunk` では、`markReceived` で新規と判定した直後、`getInboundStream` に入れる前に、保留中かつ対象 stream かつ `uint32Gt(chunk.tsn, lastTsn)` なら `heldChunks` に退避する。
* `handleData` のチャンクループ（`sctp.ts:285-287`）を抜けたあと、または `receiveDataChunk` / `receiveForwardTsnChunk` の末尾で、`maybePerformDeferredReset()` を呼ぶ。`receiveDataChunk` は同期メソッド、reset 実行は `sendReconfigParam` などを await する非同期処理なので、**呼び出し位置と await の順序に注意する**。`handleData` の SACK 送信より前に置くか後に置くかも決める。
* TSN の比較はすべて `uint32Gt` / `uint32Gte`（`packages/sctp/src/imports/common` 経由の `packages/common/src/number.ts`）を使い、生の `<` / `>` は使わない。
* inbound stream を削除するときは、残っている `reassembly` の `userData.length` を `advertisedRwnd` に戻す（現状は戻していない）。

#### 4. 制約・注意点

* **配信順序の保証**: 境界までのメッセージを全部 `onReceive` に渡してから `onReconfigStreams` を発火する。webrtc 層は `onReconfigStreams` で DataChannel を `closed` にして `dataChannels` から削除するので、順序が逆だと `datachannelReceive` 側でメッセージが捨てられる。
* **ordered / unordered の違い**: ordered で SSN の歯抜けが残っても、cumulative TSN が `lastTsn` に届けば reset を実行する（未完成のメッセージは破棄する）。unordered のチャンクも同じ境界判定で扱う。
* **FORWARD-TSN**: PR-SCTP で境界を飛び越えたときも保留を解消する。そうしないと、reset が来ない、または DataChannel が閉じないまま残る。
* **重複・再送 request の冪等性**: 現状 seq を見ていないため、同じ request の再送で `onReconfigStreams` が 2 回発火したり、逆方向の reset が二重に積まれたりしうる。seq 検証を入れて解消する。`reconfigResponseSeq` は自分が送る request の `responseSequence` フィールドにも使われているので（`sctp.ts:1069-1074`）、更新するタイミングを変えるときは影響を確認する。
* **保留は 1 つだけを想定**: 相手は応答が `Performed` になるまで次の request を出さない前提（seq が単調に増えるため）。保留中に別の seq が届いたら、seq 検証の規則（`BadSequenceNumber`）か `Error - Request already in progress` で応答する。どちらにするかは実装時に決め、テストで固定する。
* **public API の互換性**: `reconfigResult` の既存キー、`onReconfigStreams` のシグネチャ、`reconfigQueue` / `transmitReconfigRequest()`（webrtc 層が直接使っている）は変えない。値を追加するだけなら破壊的変更にはならない。
* **送信側の挙動との相互作用**: werift 同士では、修正後に相手が `In progress` を返すようになる。2.3 を入れないと、受信側の保留が長い（T3 再送待ちで RTO 初期値 3 秒、バックオフあり）ときに、`timerReconfigFailures` の上限で association が `CLOSED` になるおそれがある。2.3 は同じ変更に含めるのが望ましい。
* **Reconfig timer が共有の `this.rto` を変更している**（`sctp.ts:1245`）のは既存の問題。このチケットの範囲外だが、`In progress` 再送の扱いを変えるときに影響が出ないか確認する。
* 修正は `packages/sctp` の中で完結させる（root cause は SCTP 層にある）。webrtc 層に回避策を入れない（ルート `AGENTS.md` の Do 2、`packages/webrtc/AGENTS.md`）。
* `packages/sctp` 用の `AGENTS.md` はないので、ルート `AGENTS.md` の規約（AAA、共有ユーティリティ、日本語コメント）に従う。
* public な挙動が変わるので（RFC 準拠の deferred reset、`reconfigResult` の追加）、`changelog.md` の 🐛 Bug Fixes に追記する。必要なら `npm run doc` で生成ドキュメントを更新する。

#### 5. 完了条件

- [ ] `OutgoingSSNResetRequestParam.lastTsn` までの DATA が届いていないと、reset が保留され、`In progress (6)` が返る。
- [ ] 保留中も、対象 stream で `lastTsn` 以下の DATA（再送を含む）が再組立て・配信される。
- [ ] cumulative TSN が DATA または FORWARD-TSN で `lastTsn` に届いた時点で、inbound stream の reset、逆方向の reset の送出、`onReconfigStreams` が実行され、境界までのメッセージは必ずその前に配信される。
- [ ] 保留中に届いた、対象 stream 宛てで `lastTsn` より大きい DATA は、reset 後の stream として扱われる。
- [ ] request seq の検証が入っている。重複 request は状態を変えずに同じ result を返し、不正な seq には `BadSequenceNumber` を返す。
- [ ] TSN wrap を `uint32Gt` / `uint32Gte` で正しく扱う。
- [ ] 自分が送った request に `In progress` が返っても、失敗扱いで association が閉じない（2.3）。
- [ ] 2.4 の回帰テスト（欠けたフラグメントより reset が先に届くケース、複数 stream、TSN wrap、FORWARD-TSN、重複 request、即時実行の非回帰）を AAA 形式・日本語コメントで追加し、通る。
- [ ] `cd packages/sctp && npm test` が通る。
- [ ] SCTP の挙動変更が webrtc の DataChannel close に波及するため、`npm run type` と `npm run test:small` が通る（`packages/webrtc/tests/datachannel/close.test.ts` を含む）。可能なら `npm run e2e` で Chrome との DataChannel close の相互接続も確認する。
- [ ] `npm run format` を実行済みで、`changelog.md` に追記してある。

### 6. PeerConnection: SCTP added by renegotiation is not started after DTLS is already connected

統合元チケット: `27e384b5-59e8-4548-af5d-889c06350565`（ブランチ `ticket/27e384b5-59e8-4548-af5d-889c06350565`。develop ベースに修正された版）。以下は統合元チケットファイルの内容。行番号は統合元チケット起票時点のもの。

統合時に決めたこと:
- `SctpTransportManager.connectSctp()` は、このチケットの「確立済みなら `connected` を待たない」修正と競合したため、それを包含する `27e384b5` の実装（`ensureStarted()` による冪等な開始と、`connected` / `closed` の待ち合わせ）を採用した。`tests/data/sctpManagerConnect.test.ts` は `ensureStarted()` が呼ばれることを確認する形に直した。
- 完了条件の `NEGOTIATION_TRANSACTION.md` の更新は、develop にこの文書がないため対象外。

> 調査基準: `support-fallback-state`(`469c5ed1`)へリベースした後の `ticket/27e384b5-...` ブランチ。
> negotiation transaction へのリファクタで、`connect()` は `peerConnection.ts` から `negotiation/transportActivation.ts` に移動しています。本チケットの行番号は、すべてこのリベース後のものです。

#### 1. 目的と背景

##### 現象

SCTP の `m=application` を含まずに確立した `RTCPeerConnection` に、後の再交渉で DataChannel/SCTP を追加しても、SCTP association が開始されません。DataChannel は `connecting` のまま止まります。

- downstream での再現: RelayMessenger/Relay-SDK PR #440(`werift 0.24.4`)<https://github.com/RelayMessenger/Relay-SDK/pull/440>
  - 最初に audio だけで接続を確立する。
  - その後、SFU の re-offer で `m=application ... UDP/DTLS/SCTP webrtc-datachannel` が追加される。
  - SDP の再交渉は成功し、ICE/DTLS も connected のまま維持される。それでも SCTP は開始されない。
- Relay-SDK は、private の `sctpManager.connectSctp()` を外から呼び出し、passive 側で接続済みのケースを独自にガードすることで回避しています。標準どおりの再交渉なので、この回避策が要らない状態にすることが目的です。

##### リベース後も再現することを確認済み

`tests/integrate/negotiationTransactionUtils.ts` の `createConnectedVideoPeers()` で video だけの接続を作り、その後、片側で `createDataChannel()` してから offer/answer を 1 往復させました。2 秒後の状態は次のとおりです(一時テストで計測し、計測後に削除済み)。

| re-offer する側 | DataChannel | 両側の `sctp.state` / `started` / `associationState` | DTLS transport | `connectionState` |
| --- | --- | --- | --- | --- |
| 元の offerer(ICE controlling) | `connecting` | `new` / `false` / `CLOSED(1)` | BUNDLE で既存の 1 本を共有 | 両側 `connected` |
| 元の answerer(ICE controlled) | `connecting` | `new` / `false` / `CLOSED(1)` | 同上 | 両側 `connected` |

- 設計ドキュメントにも既知の制約として記載されています。`packages/webrtc/NEGOTIATION_TRANSACTION.md:515-516`(生成物は `doc/_media/NEGOTIATION_TRANSACTION.md`)の該当箇所は次のとおりです。

  > A DataChannel created on an already connected session without an SCTP association does not open after renegotiation (existing since `develop`).

  本チケットで修正し、この制約の記述を削除します。

##### werift の不具合と言える理由

- 後続の offer/answer で `m=application` を追加することは、JSEP 上正当なユースケースです(RFC 8841 の SDP 定義、RFC 8831 / RFC 8864 の DataChannel)。
- `NEGOTIATION_TRANSACTION.md` の commit 規約(`:41`)にも「Start remaining asynchronous connect work」とあります。answer の commit 後に SCTP 層を起動するのは、設計上の責務です。
- 現在の実装では、SCTP の起動が「ICE/DTLS を初めて起動するフロー」にしか結び付いていません。

##### 根本原因(リベース後のコード)

###### 原因 A: `TransportActivation.connect()` が early return するため SCTP 起動に到達しない

`packages/webrtc/src/negotiation/transportActivation.ts:139-183`

```ts
if (iceTransport.state === "connected" && dtlsTransport.state === "connected") {
  return;                                   // ← 再交渉 (後付け SCTP) ではここで抜ける
}
this.secure.setConnectionState("connecting");
await iceTransport.start();                 // ← ICE が connected でも無条件に呼ぶ
if (checkDtlsConnected()) return;           // ← ICE restart 時はここで抜ける
await dtlsTransport.start();
if (this.sctp.sctpTransport && this.sctp.sctpTransport.dtlsTransport.id === dtlsTransport.id) {
  await this.sctp.connectSctp();            // ← 初回 DTLS 起動時にしか到達しない
}
```

- `connect()` は answer と pranswer のたびに fire-and-forget で呼ばれます。
  - local の answer/pranswer: `peerConnection.ts:1183-1196`
  - remote の answer/pranswer: `peerConnection.ts:1465-1477`
- `connect()` が走る時点で、SCTP の remote port は既に設定されています。
  - remote re-offer の場合:
    - `currentRemoteDescription` があるので `preserveCurrentTransport` は true。
    - ただし `sctpRemotePort` が未設定なので、`RemoteMediaApplication.accept()` が `setRemoteSCTP()` を呼ぶ(`negotiation/remoteMediaApplication.ts:93-95`, `357-361`)。
    - local answer の commit 時に `activatePendingRemote()` でも再設定される(`transportActivation.ts:102-104`、呼び出し元は `peerConnection.ts:993`)。
  - local re-offer の場合: remote answer の `accept()` で設定される。
- BUNDLE(既定)では、後付けの SCTP transport も既存の DTLS transport を共有します。
  - local 側で追加する場合: `createDataChannel()` → `createSctpTransport()` → `findOrCreateTransport()`(`peerConnection.ts:569-601`, `647-`)。
  - remote offer で追加する場合: `RemoteMediaApplication.associate()`(`remoteMediaApplication.ts:122-129`)。

  そのため ICE と DTLS の両方が connected の時点で return し、`connectSctp()` には到達しません。`bundlePolicy: "disable"` のように新しい DTLS transport ができる場合は、初回の起動経路を通るので開始されます。

###### 原因 B: `connectSctp()` が冪等でなく、passive に確立済みの association を壊す

`packages/webrtc/src/sctpManager.ts:195-203`

```ts
await this.sctpTransport.start(this.sctpRemotePort);
await this.sctpTransport.sctp.stateChanged.connected.asPromise();
```

- 関係するコードの動作:
  - `RTCSctpTransport.start()`(`transport/sctp.ts:381-390`):
    - ICE role から `sctp.isServer` を決める。controlled なら server。
    - `dataChannelId` を 0 または 1 に決める。
    - `SCTP.start()` を呼ぶ。
  - `SCTP.start()`(`packages/sctp/src/sctp.ts:1366-1379`): `started === false` の場合だけ `setConnectionState("connecting")` を実行する。client なら INIT を送って COOKIE_WAIT に入る。
- 未 start の SCTP も、remote からの INIT / COOKIE_ECHO を受けると ESTABLISHED になります。
  - `SCTP.isServer` の初期値は `true`(`sctp.ts:131`)。
  - `transport.onData` は constructor で接続済み(`sctp.ts:228`)。
  - INIT と COOKIE_ECHO の受信処理は `sctp.ts:354-355`, `478`。

  その結果、`state === "connected"` かつ `started === false` という状態が生じます。
- この状態で `connectSctp()` を呼ぶと、次の問題が起きます。
  1. `sctp.state` が `"connected"` から `"connecting"` に戻る。
  2. local が ICE controlling の場合、`isServer = false` に切り替わり、2 回目の INIT を送り、`associationState` が COOKIE_WAIT に戻る。
  3. local が passive の場合、もう発火しない `stateChanged.connected` を待ち続ける。
- 潜在バグ: start を経由せずに確立すると、`RTCSctpTransport.dataChannelId` が `undefined` のままになります。その後、in-band channel の stream id を採番するとき(`transport/sctp.ts:303-310`)に `streamId.toString()` で TypeError が出ます。

###### リファクタ時に壊しやすい制約(現行コードで確認済み)

- **DTLS の二重 start**: `RTCDtlsTransport.start()` は `state !== "new"` のとき throw します(`transport/dtls.ts:185-188`)。DTLS が connecting の最中に `connect()` が重複して走った場合、reject されて `connectionState` が `failed` になります。
- **ICE の再 connect**: `RTCIceTransport.start()`(`transport/ice.ts:451-476`)は、状態に関係なく `setState("checking")` と `connection.connect()` を実行します。
  - 現行の `connect()` は、ICE が connected で DTLS だけ未接続の場合にも `iceTransport.start()` を呼んでいる。
  - リファクタではこの挙動を明示的に扱い、悪化させないこと。少なくとも「ICE も DTLS も connected」の場合は ICE を触らないこと。
- **接続状態の揺れ**: `setConnectionState("connecting")`(`secureTransportManager.ts:664-671`)を「SCTP だけを起動したい」ケースで呼ぶと、`connectionstatechange` が `connected → connecting → connected` と余分に発火します。
- **pranswer**: pranswer でも `connect()` が走ります(provisional の ICE/DTLS 生成は別に `connectPending()` が担う)。設計(`NEGOTIATION_TRANSACTION.md` の pranswer 節)では「pranswer 中に新しい SCTP association / DCEP が active になってよい」とされています。後付けの SCTP も pranswer の時点で起動しうるので、rollback との整合が必要です。扱いは 2.5 で決定済みです。
- **rollback の穴**: `SctpTransportManager.restoreNegotiationState()`(`sctpManager.ts:138-169`)が association を stop するのは、baseline に存在しない(transaction 中に追加された)transport だけです。
  - 後付け SCTP の典型パターンでは、transport が baseline に含まれる。`createDataChannel()` を `createOffer()` より前に呼ぶため、transaction 開始時の snapshot に入るからである。ただし baseline 上では未交渉で、`remotePort` は無い。
  - この場合 rollback は MID や remote port を戻すだけで、pending 中に走った association は残る。
  - transaction 中に追加された application-owned の transport で association が走っていた場合は、transport ごと stop して破棄する。このとき stream id 未割当て(未 attach)の channel は `connecting` のまま孤立する。

#### 2. 実装すべき変更

##### 2.1 `TransportActivation.connect()` を「層ごとに独立して保証する」形にする

対象: `packages/webrtc/src/negotiation/transportActivation.ts:139-183`

- ICE、DTLS、SCTP を層ごとに判定し、下位層の early return で上位層がスキップされないようにする。
- 方針の例:

```ts
const iceUsable = ["connected", "completed"].includes(iceTransport.state);
const dtlsConnected = dtlsTransport.state === "connected";
if (!iceUsable || !dtlsConnected) {
  this.secure.setConnectionState("connecting"); // ICE/DTLS を実際に起動・待機するときだけ
}
if (!iceUsable) await iceTransport.start();      // 初回交渉 / ICE restart (state "new")
if (dtlsTransport.state === "new") {
  await dtlsTransport.start();
} else if (dtlsTransport.state === "connecting") {
  await /* DTLS connected を待つ (二重 start で throw させない) */;
}
if (this.sctp.sctpTransport && this.sctp.sctpTransport.dtlsTransport.id === dtlsTransport.id) {
  await this.sctp.connectSctp();               // 層ごとに独立して保証
}
```

- 次の挙動は変えない:
  - 初回交渉での ICE/DTLS 起動。
  - ICE restart の commit 後に ICE を再起動すること(state が `"new"` に戻る)。
  - 最終的な `setConnectionState("connected" | "failed")` の判定。
- ICE が `"checking"` / `"disconnected"` などのときの扱い(start を呼ぶかどうか)は、現行の挙動から退行しないように決め、テストで固定する。
- SCTP の待機で `Promise.allSettled` が終わらず、初回交渉で `connectionState` が `connected` になるタイミングが現状より遅れることがないようにする。

##### 2.2 SCTP の起動を冪等かつ passive でも安全にする

対象: `packages/webrtc/src/sctpManager.ts`(`connectSctp`)、`packages/webrtc/src/transport/sctp.ts`(`RTCSctpTransport`)

- `start()` の意味は変えない。代わりに `RTCSctpTransport.ensureStarted(remotePort)` に相当するメソッドを追加することを推奨する。
- 状態ごとに保証すべき挙動:

| SCTP の状態 | 期待する動作 |
| --- | --- |
| `state === "connected"`(passive に確立して `started === false` の場合も含む) | 再 start しない。INIT を送らず、state も変えない。role と `dataChannelId` の parity だけ確定する |
| `started === true` でハンドシェイク中 | INIT を重複送信せず、`connected` を待つ |
| 未 start(`"new"`) | `connected` の待ち受けを start より前に登録し、1 回だけ start する |
| `"closed"` | 待ち続けない(即 return するか、reject してログに残す) |
| 同じ application section で再交渉を繰り返す | 確立済みの association を再起動しない |

- `connectSctp()` の例:

```ts
async connectSctp() {
  if (!this.sctpTransport || !this.sctpRemotePort) return;
  const sctp = this.sctpTransport.sctp;
  if (sctp.state === "connected") { /* role 確定のみ */ return; }
  const connected = sctp.stateChanged.connected.asPromise(); // 遷移の取りこぼしを防ぐ
  await this.sctpTransport.ensureStarted(this.sctpRemotePort);
  if (sctp.state !== "connected") await connected;           // closed との race も考慮
}
```

- `dataChannelId` と `sctp.isServer` の確定を `start()` から分離する。passive に確立した場合でも `dataChannelFlush` の採番が壊れないようにするため。
  - 方法は「`ensureStarted` 内で常に確定する」か「flush 時に `dataChannelId ??= isServer ? 0 : 1` で遅延確定する」のどちらか。
  - parity は RFC 8832(DTLS client が偶数)に合わせ、既存の「ICE controlling = DTLS server = 奇数」という対応を維持する。
- `packages/sctp` の `SCTP.start()` は変更せず、webrtc 層で閉じる修正を優先する。sctp 側を変える場合は cross-package の変更になるので、sctp 単体テストも追加する。
- 外部から `connectSctp()` を呼んでいる downstream(Relay-SDK)のためにも、何度呼んでも安全であることを保証する。

##### 2.3 `createDataChannel()` を SCTP 起動のトリガーにしない

- SCTP association は、交渉済みの `m=application` に属します。DataChannel オブジェクトを作るタイミングとは無関係です。
- `negotiated: true` の channel では、remote が先に SCTP を開始していることがあります。`createDataChannel()` を起点にすると、順序の競合が生じ、確立済みの association を再起動する原因になります。
- 起動のトリガーは、`connect()` 経路の「application m-line の交渉成功(answer/pranswer)と、bound DTLS が利用可能であること」に限定します。

##### 2.4 ドキュメント更新

- `packages/webrtc/NEGOTIATION_TRANSACTION.md:515-516` の既知の制約(後付け DataChannel が開かない)を削除する。
- 同じファイルの pranswer / rollback 節(200-221)を、2.5 の決定に合わせて書き換える。
  - 「後付けの SCTP は、bound DTLS が接続済みでも、application m-line を含む pranswer / answer の適用後に起動する」。
  - 「baseline に交渉済みの SCTP binding が無いのに pending 中に走った association は、transport が baseline に含まれていても rollback で破棄する」。
  - 「application-owned の transport は新しい未起動の association で残り、未 attach の channel を次の交渉に持ち越す」。
- `npm run doc` を実行し、`doc/_media/NEGOTIATION_TRANSACTION.md` に反映する。
- public API は変更しない。`changelog.md` には、修正内容を記述する欄があれば追記する。

##### 2.5 決定事項: 後付け SCTP の pranswer での起動と rollback 時の破棄

**決定**: 後付け SCTP の起動を最終 answer まで遅らせることは**しない**。

- pranswer で application m-line が交渉された時点で起動する(2.1 / 2.2 の経路そのまま)。
- rollback した場合、pending 中に走った association は**破棄する**。
- 初回交渉の pranswer と同じ規則にする。既存の挙動とテスト `negotiationTransaction.test.ts:1881`「initial pranswer starts provisional DataChannel traffic and rollback closes it」に揃える。

###### 根拠(仕様と主要実装の調査結果)

| 参照先 | 起動のタイミング | rollback 時の扱い |
| --- | --- | --- |
| RFC 9429(JSEP)§5.11 Applying an Answer | 「pranswer または answer」を適用するとき、有効な association が無ければ "prepare to initiate an SCTP association" とする。remote SCTP port が変われば、have-remote-pranswer の状態でも既存の association を破棄する | §5.7: pranswer も rollback できる。"Any resources or candidates that were allocated by the abandoned local description are discarded" |
| RFC 9429 §4.1.10 | pranswer は "MUST NOT result in the freeing of allocated resources"、"may result in the start of media transmission" | 確保した資源の解放は final answer か rollback で行う |
| W3C webrtc-pc(set the session description) | "answer" / "pranswer" で SCTP association を確立する(DataChannel ID の割当てと max message size の更新も pranswer で行う) | rollback で `[[SctpTransport]]` を `[[LastStableStateSctpTransport]]` に戻す。後付けの場合は null に戻る |
| Chrome(libwebrtc `pc/sdp_offer_answer.cc` `PushdownMediaDescription`) | local と remote の description(pending を含む)の両方に SCTP section があれば `StartSctpTransport`。つまり pranswer で起動する | `Rollback()` は have-local-offer / have-remote-offer でしか許可しない。pranswer 状態の rollback は INVALID_STATE になるので、破棄の処理が不要になっている |
| Pion(`peerconnection.go` `startRTP` → `startSCTP`、`sctptransport.go` `StartContext`) | final answer(local answer / remote answer)の適用時だけ起動する。再交渉の answer のたびに呼ぶが、`isStarted` ガードで冪等にしている | pranswer で起動しないので、破棄の問題が起きない |

###### 判断の理由

1. **仕様**
   - JSEP と W3C は、どちらも pranswer を SCTP の確立手順の対象にしている。
   - rollback は「破棄された description が確保した資源を捨てる」と定めている。
   - したがって「pranswer で起動し、rollback で破棄する」が仕様にそのまま沿う。
2. **遅らせても破棄処理は必要**
   - remote(Chrome)は pranswer の時点で INIT を送ってくる。
   - werift の未起動の SCTP は `isServer` の初期値が `true` なので、その INIT に応答して passive に確立してしまう(原因 B)。
   - local の起動を最終 answer まで遅らせても「pending 中に確立した association」は生じうる。rollback での破棄はどちらにしても実装が必要になる。
3. **werift 内での一貫性**
   - 初回交渉の pranswer では既に DataChannel を開き、rollback で閉じている。
   - 後付けのケースだけ遅らせると、「接続済みかどうか」で規則が分かれる。
   - Pion のやり方(final answer まで遅らせる)は単純だが、Pion は再交渉で pranswer の transport を扱っていない。werift の設計(pranswer で provisional な DataChannel を許可)とは合わない。
   - Chrome は pranswer 状態の rollback を禁止して破棄の問題を避けている。werift は JSEP どおりその rollback を許可しているので、破棄を実装する必要がある。
4. **Pion から取り入れる点**: 「answer / pranswer のたびに start を呼び、`isStarted` 相当のガードで冪等にする」という方式は 2.2 として採用する。

###### rollback 時の扱い(確定した規則)

- **破棄の対象を判定する**
  - baseline に交渉済みの SCTP binding が無い(`baseline.remotePort === undefined`)のに、現在の association が初期状態でない場合、その association を「pending-only association」とみなす。
  - 初期状態でないとは、`sctp.started`、`state !== "new"`、`associationState !== CLOSED` のいずれかが成り立つこと。
  - transport が baseline に含まれるかどうかは問わない。remote からの INIT で passive に確立したものも対象に含める。
- **association の破棄**: 既存の `RTCSctpTransport.stop()` で ABORT を送り、association を閉じる。
- **channel の扱い**
  - stream id 割当て済み(attach 済み)の channel:
    - `stateChanged.closed` の handler(`transport/sctp.ts:94-99`)で `closed` にする。
    - pending 中に open になったものもこれに含まれる。設計の "channels opened on a pending-only association close when it is discarded" に従う。
  - stream id 未割当てで queue に残っている(未 attach の)channel: `connecting` のまま application のオブジェクトとして残し、次の交渉で open にする。
- **`RTCSctpTransport` オブジェクトの扱い**
  - application-owned の場合: `createDataChannel` 由来なら、baseline にあったか transaction 中に追加されたかに関係なく残す。
    - 同じ DTLS transport 上に、新しい未起動の `SCTP` インスタンスを作り直す。
    - 現在の `setDtlsTransport()` は同じ DTLS id だと早期 return するので、`resetAssociation()` 相当のメソッドを新設する。
    - `stop()` が `dtlsTransport.dataReceiver` を空にする点にも対処する。BUNDLE で共有している DTLS 上で、SCTP の受信経路を張り直す必要がある。
    - `detachFromDescription()` と `sctpRemotePort = undefined` で未交渉に戻す。これで次の `createOffer()` に再び `m=application` が載る。
  - description 由来の場合(remote offer が作ったもの): 従来どおり stop して破棄する。
  - これに合わせて、`restoreNegotiationState()` の `keepAdded` 判定(`associationState === CLOSED` を条件にしている)を上記の規則に置き換える。
- **影響を受けないもの**: baseline で既に交渉済みの association(`baseline.remotePort` あり)。既存の DataChannel は committed な association に残る。
- **final answer での確定**
  - pranswer と同じ sctp-port を受け入れた場合: association を継続する。再起動も INIT の再送もしない。
  - final answer が `m=application` を拒否した場合(port 0、RFC 8841 §10.3-10.4): association を閉じる。
  - sctp-port が変わった場合(JSEP §5.11): 既存の validate に従う。変更前に拒否するなら拒否する。受け入れる場合は association を破棄して作り直す。
  - どちらの挙動になるかはテストで固定する。
- **適用範囲**: Relay-SDK の再現経路は pranswer を使わないので、この規則の影響を受けない。

#### 3. テスト計画(PeerConnection レベル)

##### 配置と規約

- 新規ファイル `packages/webrtc/tests/integrate/lateSctpNegotiation.test.ts` を作る。あるいは `negotiationTransactionRegression.test.ts` に追記してもよい。
- Arrange 用の helper は、既存の共有ファイル `tests/integrate/negotiationTransactionUtils.ts` を再利用する。新しい helper もこのファイルに追加する。
  - 再利用する helper: `createConnectedVideoPeers`, `sendAndExpectData`, `waitForDtlsConnected`, `assertNegotiationInvariants`, `createDuplexSession` / `negotiate` / `step`。
  - 追加する helper の例: 「後付けで DataChannel を交渉して open を待つ」。
- 各操作の後に `assertNegotiationInvariants()` を通す(package `AGENTS.md` Do #6)。
  - 現在の `assertSctpBinding` は、application 未交渉の SCTP について「MID も remote port も無いこと」を検査している(`negotiationTransactionUtils.ts:799-808`)。
  - 次の 2 つの状態も検出できるように拡張する:
    - 「交渉済み、かつ bound DTLS が connected なのに association が未起動」
    - 「未交渉(stable で application m-line が無い)なのに association が初期状態でない」。2.5 の rollback 破棄漏れを検出するため。
- Act / Assert には日本語コメントを付ける。

##### シナリオ

| # | シナリオ | 確認すること |
| --- | --- | --- |
| A | video だけで接続済み。元の answerer(ICE controlled = SCTP passive)が `createDataChannel` して re-offer する(downstream と同じ形) | 再交渉の前: ICE/DTLS は connected、SCTP は無い。再交渉の後: 両側で `sctp.state === "connected"`、channel が `open`、双方向に送受信できる |
| B | 同じ状況で、元の offerer(controlling = SCTP client)が re-offer する | A と同じ |
| C | 両側で `createDataChannel("late", { negotiated: true, id: 2 /*または 3*/, ordered: false, maxRetransmits: 0 })` を作ってから再交渉する | 両側が open になり、送受信できる |
| D | remote が先に INIT を送り、local が `started === false` のまま `connected` になった後、通常の post-negotiation 経路が走る | `connected` のまま変わらない。2 回目の INIT を送らない(`sendChunk` を spy して数える)。COOKIE_WAIT に戻らない。in-band / negotiated のどちらの channel でも送受信できる。local が controlling の場合も確認する |
| E | 同じ application section で、もう一度 offer/answer する | association を再起動しない(INIT の数が増えない、`stateChanged.connecting` が発火しない)。既存の channel は open のまま |
| F | 初回交渉から DataChannel を含む既存の経路 | 既存テスト(`integrate/datachannel.test.ts`, `negotiationTransaction*.test.ts`, `createDuplexSession` を使う matrix / property)がそのまま green |
| G | 後付け SCTP の再交渉中の `connectionState` | `connectionstatechange` が余分に発火しない(`connecting` に戻らない) |
| H | ICE restart(`negotiate(..., { iceRestart: true })`) | 既存の DataChannel が開いたまま残り、SCTP を再起動しない |
| I-1 | 接続済みのセッションで、後付けの `m=application` を pranswer → final answer の順で確定する | pranswer の時点で channel が open になり、双方向に送受信できる。final answer の後も association を継続する(INIT の数が増えない、`connecting` に戻らない) |
| I-2 | 後付けの `m=application` を pranswer で起動した後、両側で rollback する。DataChannel は `createOffer()` より前に作る(transport が baseline に含まれる典型パターン) | attach 済みの channel が `closed` になる。remote 側の association も ABORT で閉じる。`pc.sctpTransport` は application-owned として残り、MID も remote port も無く、association は初期状態。`assertNegotiationInvariants` が通る |
| I-3 | I-2 の後に、rollback 後に作った channel と未 attach で残った channel を持ったまま、通常の offer/answer をやり直す | 次の offer に `m=application` が載る。新しい association で channel が open になり、双方向に送受信できる |
| I-4 | pranswer の間に remote が先に INIT を送り、local は未起動のまま passive に確立する。その後 rollback する | `started === false` の passive association も破棄される(破棄の判定が `started` に依存しないこと) |
| I-5 | DataChannel を transaction 中(have-local-offer / have-remote-offer)に作り、pranswer で起動した後に rollback する | transport は application-owned として残り、association は作り直される。未 attach の channel が孤立せず、I-3 と同様に次の交渉で open になる |
| I-6 | pranswer で起動した後、final answer が `m=application` を拒否する(port 0) | association が閉じ、attach 済みの channel が `closed` になる。invariants が通る |
| J | `bundlePolicy: "disable"` で SCTP を後付けする | 別の DTLS transport で起動する経路が退行していない |

- D の作り方は、次のいずれか:
  - re-offer 側の `setRemoteDescription(answer)` を遅らせ、answerer 側(controlling)の INIT が先に届く順序にする。
  - `tests/fixture.ts` の `dtlsTransportPair()` の上に `RTCSctpTransport` を 2 つ作り、片側だけ start して passive に確立させてから `SctpTransportManager.connectSctp()` を呼ぶ。

#### 4. 制約・注意点

- **ICE restart / pranswer の互換性**
  - restart の commit 後に ICE だけを再起動する挙動(DTLS は connected のまま)を変えない。
  - provisional generation は `connectPending()` が担うので、`connect()` の変更で干渉しないこと。
- **pranswer と rollback の整合(2.5 で決定済み)**
  - pranswer で起動し、rollback で破棄する。破棄するかどうかは association の状態と baseline の binding で判定し、transport が baseline に含まれるかどうかや `started` には依存させない。
  - rollback の後も application-owned の transport は再利用できる状態(未起動の新しい association)で残すこと。
  - 共有している DTLS の `dataReceiver` を空のまま放置しないこと。放置すると、以降の SCTP 受信が失われる。
  - remote の ABORT 受信とローカルの rollback が競合しても、channel の `closed` 通知が二重に発火しないこと。
- **重複起動の禁止**: DTLS は `"connecting"` のときに start しないこと。SCTP は `connected` 済みのものを start しないこと。
- **待機で詰まらない**
  - SCTP が `closed` になった場合や、remote が応答しない場合に、`connect()` が永久に待たないこと。
  - 待ち受けを登録する前に遷移が完了して、取りこぼすことがないようにする。
- **低レイヤの変更は最小限に**: `packages/sctp` の `started` / `state` の意味は、他の利用者にも影響する。webrtc 層で閉じる修正を優先する。
- **negotiation 変更の規約**(package `AGENTS.md` Do #6-7)
  - pending の description が current session の live state を書き換えないこと。
  - `assertNegotiationInvariants` で新しい状態クラスを検出できるようにしておくこと。
  - review を依頼する前に、より深い property search と、pending 中に live state を書き込む全経路の self-review を行うこと。
- **WPT の境界**: WPT 専用の厳格な挙動を `src` に持ち込まない(root `AGENTS.md` Do #14)。
- **revision の比較**: active worktree を checkout / reset / stash しない。`git worktree add --detach <tmp> <rev>` を使う(root `AGENTS.md` Do #15)。
- **根本原因を直す**: retry やタイムアウトの延長で症状を隠さない(root `AGENTS.md` Do #11)。

#### 5. 完了条件

- [ ] SCTP なしで確立した PeerConnection に、作り直さずに後の再交渉で `m=application` を追加できる。
- [ ] bound DTLS が既に connected でも(BUNDLE 共有)、answer の commit 後に SCTP association が起動する。
- [ ] remote 起点で確立した association や接続済みの association を再起動しない。2 回目の INIT を送らず、state も後退しない。
- [ ] `connectSctp()`(または新設の `ensureStarted`)は何度呼んでも安全で、passive に確立した後も stream id の採番が壊れない。
- [ ] 後付けの SCTP を交渉した後、in-band と `negotiated: true` の両方の DataChannel が open になり、双方向に送受信できる。
- [ ] offerer / answerer(ICE controlling / controlled)の両方向をテストしている(シナリオ A〜E)。
- [ ] 後付けの SCTP は pranswer で起動し、final answer で再起動されない(シナリオ I-1)。
- [ ] pranswer の後に rollback すると、pending-only association が破棄される(passive に確立したものや、baseline にある transport の上で走ったものも含む)。attach 済みの channel は `closed` になり、未 attach の channel と application-owned の transport は次の交渉で使える(シナリオ I-2〜I-5)。
- [ ] final answer で `m=application` を拒否すると、association が閉じる(シナリオ I-6)。
- [ ] `assertNegotiationInvariants` で、未交渉なのに association が残っている状態を検出できる。
- [ ] 初回交渉での DataChannel、ICE restart、`bundlePolicy: "disable"` の挙動が変わらない。再交渉時に `connectionState` が揺れない。
- [ ] `NEGOTIATION_TRANSACTION.md` の既知の制約(515-516 行)を削除し、pranswer / rollback 節(200-221 行)を 2.5 の規則に更新し、`npm run doc` で生成物に反映している。
- [ ] 検証コマンドがすべて通る:
  - `cd packages/webrtc && npm run type && npm test`
  - `WERIFT_NEGOTIATION_FUZZ_SEEDS=300 WERIFT_NEGOTIATION_FUZZ_STEPS=20 npx vitest run tests/integrate/negotiationTransactionProperty.test.ts`(package `AGENTS.md` Do #7)
  - `packages/sctp` を変更した場合は `cd packages/sctp && npm run type && npm test`、さらに root で `npm run type` と `npm run test:small`
  - DataChannel の挙動に関わる WPT allowlist が退行していないことを、必要に応じて `npm run wpt --workspace packages/webrtc` で確認する

#### 参考: 主な関連箇所(リベース後)

| ファイル | 箇所 |
| --- | --- |
| `packages/webrtc/src/negotiation/transportActivation.ts` | `cleanupInitialProvisional` 39-65(初回交渉専用で、本件とは無関係)、`activatePendingRemote` 68-122(`setRemoteSCTP` 102-104)、**`connect` 139-183**、`connectPending` 186-205 |
| `packages/webrtc/src/peerConnection.ts` | `activatePendingRemote` の呼び出し 993 / 1017、local の answer/pranswer からの connect 1183-1196、remote の answer/pranswer からの connect 1465-1477、`createSctpTransport` 569-577、`createDataChannel` 579-601、`findOrCreateTransport` 647- |
| `packages/webrtc/src/negotiation/remoteMediaApplication.ts` | `preserveCurrentTransport` 93-95、`associate`(application)122-129、`accept` 内の `setRemoteSCTP` 357-361 |
| `packages/webrtc/src/sctpManager.ts` | `snapshotNegotiationState` 125-135、`restoreNegotiationState` 138-169、**`connectSctp` 195-203**、`setRemoteSCTP` 205-224 |
| `packages/webrtc/src/transport/sctp.ts` | `setDtlsTransport` 59-112(`stateChanged.connected` で negotiated channel を open にする)、`isServer` 114-116、`dataChannelFlush` 295-、`start` 381-390、`stop` 392-395(`dtlsTransport.dataReceiver` を空にする) |
| `packages/sctp/src/sctp.ts` | `started` / `isServer` の初期値 129-131、INIT の受信 353-394、`start` 1366-1379、`setState` / `setConnectionState` 1428-1457 |
| `packages/webrtc/src/transport/ice.ts` | `start` 451-476 |
| `packages/webrtc/src/transport/dtls.ts` | `start` 185-(`state !== "new"` のとき throw) |
| `packages/webrtc/src/secureTransportManager.ts` | `setConnectionState` 664-671 |
| 設計ドキュメント | `packages/webrtc/NEGOTIATION_TRANSACTION.md`(commit 規約 41、pranswer / rollback 200-221、既知の制約 515-516) |
| 既存の前例テスト | `tests/integrate/negotiationTransaction.test.ts:1881`(初回交渉の pranswer で DataChannel を開き、rollback で閉じる) |
| 外部仕様・実装(2.5 の根拠) | RFC 9429 §4.1.10 / §4.1.10.2 / §5.7 / §5.11、RFC 8841 §10.3-10.4、W3C webrtc-pc "set the session description"(`[[LastStableStateSctpTransport]]`)、libwebrtc `pc/sdp_offer_answer.cc`(`PushdownMediaDescription` 末尾の `StartSctpTransport`、`Rollback()` の状態制限、2026-10-07 時点の main)、Pion `peerconnection.go`(`startRTP` / `SetLocalDescription` / `SetRemoteDescription`)と `sctptransport.go`(`StartContext` の `isStarted` ガード、2026-10-07 時点の master) |
| テストの Arrange 資産 | `tests/integrate/negotiationTransactionUtils.ts`(`createConnectedVideoPeers` 31、`sendAndExpectData` 150、`assertNegotiationInvariants` 471、`createDuplexSession` 855、`negotiate` 971、`waitForDtlsConnected` 1037)、`tests/fixture.ts`(`dtlsTransportPair`)、`tests/utils.ts` |

## 完了条件

- [ ] 各問題を develop 上のテストで再現し（修正前に失敗）、修正後に成功することを確認する。
- [ ] テストは Arrange / Act / Assert で書き、Arrange は各 package の `tests/utils.ts` に置く。Act / Assert に日本語コメントを付ける。
- [ ] `packages/sctp`、`packages/rtp`、`packages/webrtc` のテストと型検査、`npm run doc:check` を実行する。
- [ ] 公開 API 追加（`SrtpReplayError`、`SrtpReplayWindow`、`SRTP_REPLAY_WINDOW_SIZE`）に合わせて生成 docs と `changelog.md` を更新する。
- [ ] 統合元 4 チケット（3〜6）の完了条件を満たし、マージ後の `packages/sctp` / `packages/webrtc` で各チケットの回帰テストがすべて成功する。
