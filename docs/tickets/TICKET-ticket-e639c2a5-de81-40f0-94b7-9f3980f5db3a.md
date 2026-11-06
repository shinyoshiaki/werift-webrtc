## 背景・目的

元報告: #806（再現コード・実測値・暫定パッチを含む）

`develop` の [`565dd85fb530d1ddfd144a0bb74171e3a5545c90`](https://github.com/shinyoshiaki/werift-webrtc/commit/565dd85fb530d1ddfd144a0bb74171e3a5545c90) の実装を静的に確認した結果、**Gap ACK済みのDATAチャンクがT3-rtxタイムアウトで誤再送され、`flightSize`が過大計上されたまま残る** という報告は妥当。

その結果、`sentQueue`が空でも`flightSize >= cwnd`となり、以後のDATAが`outboundQueue`から送出されず、DataChannelの送信が永続的に停止し得る。SCTP自体の接続状態が維持され、ICE consent等では検知しづらい。また `timerHeartbeatExpired` は `flightSize === 0 && outboundQueue.length === 0` の場合のみHEARTBEATを送るため、同様にプローブも止まり得る。

**優先度: 高（長寿命接続の可用性・送信停止）**

## 根拠（develop / 上記コミット）

1. [`receiveSackChunk` L671–743](https://github.com/shinyoshiaki/werift-webrtc/blob/565dd85fb530d1ddfd144a0bb74171e3a5545c90/packages/sctp/src/sctp.ts#L671-L743)
   - Gap ACKで `sChunk.acked = true` とし、`flightSizeDecrease(sChunk)` を実行。
   - 後続の累積ACK処理では `!sChunk.acked` の場合しか減算しない。
2. [`timer3Expired` L1196–1220](https://github.com/shinyoshiaki/werift-webrtc/blob/565dd85fb530d1ddfd144a0bb74171e3a5545c90/packages/sctp/src/sctp.ts#L1196-L1220)
   - `sentQueue`内のチャンクを `acked` にかかわらず再送指定し、`flightSize = 0` とする。
3. [`transmitOnce` L980–1055](https://github.com/shinyoshiaki/werift-webrtc/blob/565dd85fb530d1ddfd144a0bb74171e3a5545c90/packages/sctp/src/sctp.ts#L980-L1055)
   - 再送指定されたGap ACK済みチャンクまで送信し、`flightSizeIncrease` で再加算する。
   - `flightSize >= cwnd` になると未送信DATAの送出を停止する。
4. [`flightSizeIncrease/Decrease` L1103–1109](https://github.com/shinyoshiaki/werift-webrtc/blob/565dd85fb530d1ddfd144a0bb74171e3a5545c90/packages/sctp/src/sctp.ts#L1103-L1109)
   - チャンクがすでに計上済み／計上解除済みかを追跡しておらず、加減算が非冪等。
5. [`timerHeartbeatExpired` L1297–1314](https://github.com/shinyoshiaki/werift-webrtc/blob/565dd85fb530d1ddfd144a0bb74171e3a5545c90/packages/sctp/src/sctp.ts#L1297-L1314)
   - 不正な `flightSize` と積み残し `outboundQueue` がHEARTBEAT発行を抑制する。

## 最小再現シナリオ（元Issueのコードを回帰テストに移植）

1. 36 B / 652 B / 652 B のDATAを順に送信（最初のTSNのみ紛失）。
2. 残り2件をGap ACKする → `flightSize = 36`。
3. T3を発火させる → 現実装はACK済み2件まで再送する。
4. 全件を累積ACKする → `sentQueue = 0` だが `flightSize = 1304` が残る（元報告の再現値）。
5. 新しいメッセージを送る → `cwnd` 判定で `outboundQueue` から出ない。

※元Issueの独立再現スクリプトを参照。ここではコード上の経路を検証済みだが、今回別途テスト実行したと主張するものではない。

## 推奨修正方針

### 1. ACK済み／破棄済みDATAを再送しない

- `timer3Expired()` は `acked || abandoned` を除外して再送指定する。T3時点でGap ACK済みでも`sentQueue`に残るのは、累積TSNがまだ進んでいないためであり、再送対象という意味ではない。
- `transmitOnce()` の再送ループでも `acked || abandoned` を再確認し、古い `retransmit` フラグはクリアする。再送指示後にGap ACKが届く場合も想定した二重防御。
- `receiveSackChunk()` が新たなGap ACKを認識した時点でも再送フラグの解除を検討する。
- **Gap ACKのreneging（後続SACKで受信確認が取り消される場合）は別扱い**。後続SACKの欠落検出・再送処理を永久に禁止しない（RFC 9260 §6.2.1(D-iii)、§6.3.2(R4)）。

### 2. `flightSize`の計上状態をチャンク単位で管理（本命）

`packages/sctp/src/chunk.ts` の `DataChunk` に、例: `inFlight = false`（または内部の同等管理）を追加する。`acked` は受信確認状態、`inFlight` は輻輳制御上の未ACK送信バイト計上状態として**明確に分離**する。

概念コード:

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

- 初回送信／再送で未計上なら加算し、Gap ACK／累積ACK／再送待ちへの移行／破棄で計上済みなら一度だけ減算する。
- `timer3Expired()` では再送対象にしたチャンクを計上解除する。現在の `this.flightSize = 0` だけを行うのではなく、**各チャンクの `inFlight` と集計値を同期**させる。
- `receiveSackChunk()` の累積ACKでは `acked` による `doneBytes` の重複計上回避を維持しつつ、計上解除は冪等ヘルパー経由に統一する。
- `maybeAbandon()`、`updateAdvancedPeerAckPoint()`、Fast Retransmit、Forward TSN関連を確認し、`sentQueue`から除去するチャンクに未解除の計上が残らないようにする。
- テスト上の不変条件: `flightSize === Σ(sentQueue内でinFlightのチャンクのbookSize)`、`flightSize >= 0`、`sentQueue.length === 0 => flightSize === 0`。
- **`transmitOnce()` 冒頭で `sentQueue.length === 0` の場合に強制的に `flightSize = 0` にする案は、単独の根本修正として採用しない**。不整合を隠すのみでチャンク状態と乖離する可能性があるため。不変条件を満たす設計にする。

### 3. 既存の輻輳制御／タイマー動作を維持

- `cwnd`、`ssthresh`、`partialBytesAcked`、`peerRwnd` の計算への影響を確認する。
- T3後は未ACKの最古TSNから適正に再送し、T3開始／停止／再起動が破綻しないこと。
- 送信バイト数の計上修正にスコープを絞り、RTO backoffやT3パケット束ね等のRFC完全準拠性改善は別タスクに切り分ける。

参考: [RFC 9260 §6.2.1 / §6.3.2 / §6.3.3 / §7.2.4](https://www.rfc-editor.org/rfc/rfc9260.html)

## 回帰テスト（`packages/sctp/tests/sctp.test.ts` を中心に追加）

- [ ] **Gap ACK → T3 → 累積ACK**: 元Issueの最小再現を移植。T3後の再送TSNは欠落分だけ。`sentQueue === 0` と `flightSize === 0` を確認。
- [ ] **送信復旧**: 上記ACK後に新規DATAを送って、`outboundQueue`が排出され、実際のパケットが送信されること。
- [ ] **ACK競合**: Fast Retransmit/T3で `retransmit` 指定された後、実送信前にGap ACKを処理しても不要な再送・二重加算がないこと。
- [ ] **重複ACKと複数T3**: 同一チャンクへのGap ACK/累積ACKの重複、T3再発火でも二重減算／負値／正の残存値がないこと。
- [ ] **部分信頼性**: `maxRetransmits` / `expiry` による破棄・FORWARD TSN後に未解放の計上が残らないこと。
- [ ] **Gap ACK reneging**: 一度Gap ACKされたTSNが後続SACKから欠落した際、既存の欠落検出・再送制御を壊さないこと。
- [ ] **HEARTBEAT**: キュー排出後、`flightSize`がゼロに戻り、通常のHEARTBEAT生成条件を妨げないこと。
- [ ] **既存テスト**: `packages/sctp/tests/burst.test.ts` のロス・大量転送と `sctp.test.ts` のrwnd/タイマー試験を通す。

**テストは固定タイマー／モックtransportで決定的に実装する**（長時間の実RTO待ちは不要）。

## 完了条件

- T3によるGap ACK済みDATAの不要再送が発生しない。
- 元Issueの送信停止ケースが解消し、以後もDataChannelの送信が進む。
- ACK・再送・破棄の全経路で`flightSize`の不変条件が成立する。
- 関連するSCTPユニット／転送テストが通り、正常系の転送性能を不必要に劣化させない。

関連: #806