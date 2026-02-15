## 1. タスクの目的と背景

- `packages/sctp/src/sctp.ts` では `rto` を秒で保持している一方、`timer3Restart` のみ `setTimeout(this.timer3Expired, this.rto)` となっており、`timer3Start`/timer1/timer2/reconfig の `* 1000` と不整合です。  
- この不整合により T3-rtx 再開始が 1–60ms で過剰発火し、再送・キュー再走査・タイマ再登録が高頻度化して CPU 負荷を押し上げます（「performance」対策ではなく逆効果）。  
- 一方で単純に「interval頻度を落とす」だけだと、再送検知・障害検知が遅延し得ます。RFC 9260 はこの副作用を明示しており、特に Heartbeat 間隔増加時は ABORT ロスト検知遅延が増えるとしています（§8.2, HB.interval）。  
- よって本タスクは、**RFC準拠で単位不整合を是正したうえで、性能課題は RFC が許容する遅延ACK/Heartbeat運用で吸収**する方針へ詳細化する。

## 2. 実装すべき具体的な機能や変更内容

- T3-rtx 単位整合の修正（必須）  
  - `timer3Restart`: `setTimeout(this.timer3Expired, this.rto * 1000)` に統一。  
  - `// for performance` は削除し、「`rto` は秒、JS タイマ投入時に ms へ変換する」コメントへ置換。  
- RFC乖離を埋める性能対策（同時実施）  
  - 現状の `sendSack()` は `setImmediate` でほぼ即時ACK。これを RFC 9260 の遅延ACK方針（「少なくとも2パケットごと」「未ACK DATA 到着から200ms以内」）に合わせ、遅延SACKタイマを導入。  
  - Gap Ack/重複/ロス兆候時は即時SACKを許容し、輻輳制御・fast retransmit の応答性を維持。  
  - Heartbeat 送信側タイマ（idle時 `RTO + HB.interval`、推奨 HB.interval=30s）未実装/不足箇所を補完し、頻度調整時の副作用（障害検知遅延）を設定で制御可能にする。  
- 検証追加  
  - `timer3Restart` が ms 単位でスケジュールされるテスト。  
  - SACK 遅延の上限（<=200ms）と即時送信条件（ロス兆候時）テスト。  
  - Heartbeat 間隔変更時の検知遅延が想定どおり増減するテスト（少なくとも単体でタイマ算出検証）。

## 3. 技術的な実装アプローチ（調査結果サマリ）

- RFC全文確認で本件に直接効く要件  
  - §6.3.1 C6/C7: RTO は Min/Max の範囲（秒）で管理。  
  - §6.3.2 R1/R3: T3-rtx は送信時/earliest outstanding TSN ACK時に current RTO で開始・再開始。  
  - §6（delayed ACKガイド）: SACK は少なくとも2パケットごと、かつ未ACK DATA 到着から 200ms 以内。  
  - §8.2: HB.interval を上げると ABORT ロスト検知が遅れる副作用あり。  
- 現状実装との乖離  
  - `timer3Restart` のみ秒→ms変換漏れ（過剰発火）。  
  - 受信ACKは `setImmediate` ベースで、RFC の遅延ACK運用（SACK.Delay=200ms 推奨）を活用できておらず、高トラフィック時にACK頻度が高い。  
  - Heartbeat は受信応答（HB ACK返送）はあるが、送信側の定期HB運用がコード上で確認できず、パス障害検知の設計余地が残る。  
- 実装順序  
  1. T3単位バグ修正（正しさ回復）。  
  2. 遅延SACK導入で制御パケット頻度を抑制。  
  3. HB.interval 管理を導入/補強し、運用で検知速度と負荷のトレードオフを調整可能にする。  
  4. テストで「RFC要件を満たしつつ性能面を悪化させない」ことを固定化。

## 4. 考慮すべき制約や注意点

- T3を正しい秒スケールへ戻すと、現状（誤って短すぎるタイマ）より再送開始は遅くなるが、これは RFC 準拠の正常化であり、過剰再送抑制に寄与する。  
- 性能最適化は「タイマ単位の崩し」ではなく、RFC許容の遅延ACK/HB設定で行うこと。  
- SACK遅延はやり過ぎると recovery/cwnd 成長が鈍るため、200ms上限と即時ACK条件を必須にする。  
- HB.interval 調整は障害検知遅延とトレードオフになるため、既定値と設定範囲を明確化する。  
- 変更は SCTP タイマ・ACK 制御に限定し、データ再送アルゴリズム本体（misses=3 の fast retransmit 等）の意味論は維持する。

## 5. 完了条件

- [x] `timer3Restart` が `this.rto * 1000` へ統一され、単位境界コメントに更新されている。  
- [x] `timer1/timer2/timer3/reconfig` で RTO秒→ms 変換の一貫性が確認できる。  
- [x] 遅延SACK実装が入り、`<=200ms` 上限・2パケット方針・即時ACK条件をテストで確認できる。  
- [x] Heartbeat 送信側の interval 制御（`RTO + HB.interval`）と副作用（検知遅延）を設計・テスト・設定値で説明できる。  
- [x] `packages/sctp` の関連テストが通る。  
- [x] チケット本文に RFC 9260 §6.3.1/§6.3.2/§8.2（および delayed ACK要件）を根拠として明記できている。  
- [x] 「for performance」の実態が、最適化ではなく単位不整合＋RFC乖離であることを調査結果として明記できている。

## 6. 実施結果（実装・検証）

- `timer3Restart` は `setTimeout(this.timer3Expired, this.rto * 1000)` に修正し、`rto` が秒で保持されることを明示するコメントへ更新した。これにより T1/T2/T3/reconfig の秒→ms 変換が統一された。  
- SACK は `setImmediate` 即時送信を廃止し、RFC 9260 の delayed ACK 方針に合わせて `SCTP_SACK_DELAY_MS=200` の遅延タイマへ変更した。2パケット到着時、重複TSN、Gap（mis-order）や `FORWARD TSN` 受信時は即時SACKへ昇格し、recovery 応答性を維持した。  
- Heartbeat 送信側タイマを追加し、`(RTO + heartbeatInterval) * 1000` でスケジュールするようにした。`setHeartbeatInterval()` で運用側が interval を調整でき、interval 増加時に障害検知遅延が増える RFC 9260 §8.2 のトレードオフを制御可能にした。  
- テストを追加し、(1) `timer3Restart` の ms スケジュール、(2) delayed SACK の 200ms 上限と 2パケット/Gap 時の即時送信、(3) Heartbeat の `RTO + HB.interval` 算出を検証した。  
- 「for performance」は実測上の最適化ではなく、`timer3Restart` の単位不整合と delayed ACK 未実装という RFC 乖離が主因であることをコード・テストで明確化した。
