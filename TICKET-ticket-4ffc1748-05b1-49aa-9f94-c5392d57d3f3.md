## 1. タスクの目的と背景

- 対象は `packages/sctp/src/sctp.ts` の `timer3Start` と `timer3Restart` で、`setTimeout` の第2引数に `this.rto * 1000` を使う箇所と `this.rto` のままの箇所が混在しています。  
- `this.rto` は RTT 計算 (`Date.now() / 1000`) と `updateRto` のクランプで管理され、`SCTP_RTO_MIN=1`, `SCTP_RTO_MAX=60` と合わせて「秒」スケールで扱われています。  
- RFC 9260 §6.3.2 (R1/R3) は T3-rtx を「その宛先の current RTO で開始/再開始」することを要求し、§6.3.1 (C6/C7) でも RTO.Min / RTO.Max を秒で規定しています。  
- JavaScript の `setTimeout` はミリ秒単位のため、`timer3Restart` で `* 1000` が無い現状は、T3-rtx を想定より約1000倍短い 1–60ms で発火させる不整合です。
- 旧実装の `// for performance` は根拠となる計測や設計コメントが見当たらず、`git blame` 上はリファクタ時に追加された TODO コメントです。実際には「性能最適化」ではなく、秒→ms変換の適用漏れが残った可能性が高い状態です。

## 2. 実装すべき具体的な機能や変更内容

- `packages/sctp/src/sctp.ts` の `timer3Restart` を以下に統一する。  
  - 現在: `setTimeout(this.timer3Expired, this.rto)`  
  - 変更: `setTimeout(this.timer3Expired, this.rto * 1000)`  
- `timer3Restart` 直上の `// for performance` コメントは削除し、「RTOは秒管理、`setTimeout` 投入時にmsへ変換する」という単位境界コメントへ置換する。  
- 回帰防止として、`packages/sctp/tests` に「T3 restartがRTO(ms)でスケジュールされること」を検証するテストを追加。
- あわせて `timer3Start` / `timer3Restart` / `timerReconfigHandleStart`（および timer1/timer2）で、RTO利用時の `* 1000` 有無を網羅確認し、単位変換ルールを統一する。

## 3. 技術的な実装アプローチ（調査結果サマリ）

- RFC 9260 根拠:
  - §6.3.2 R1: DATA送信時、T3-rtx は「RTO after」で開始する。  
  - §6.3.2 R3: earliest outstanding TSN がACKされたとき、T3-rtx を「current RTO」で再開始する。  
  - §6.3.1 C6/C7: RTO.Min / RTO.Max は秒で扱う。  
- コード調査結果:
  - RTT測定値は `Date.now()/1000` 系で秒。
  - `updateRto` のクランプは `SCTP_RTO_MIN=1`, `SCTP_RTO_MAX=60`。
  - `timer3Start` は `this.rto * 1000`、`timer3Restart` のみ未変換。  
  - `git show 4bfa7297a (refactor)` では、旧 `t3Start/t3Restart` からの改名時に `timer3Start` だけ `* 1000` 化され、`timer3Restart` は `this.rto` のまま残存。ここで `// for performance` が付与されている。  
  - さらに元の vendored 実装 (`c55e3f26a:src/vendor/sctp/sctp.ts`) では `t3Start` と `t3Restart` がどちらも `this.rto` で、今回の不整合は「片側のみ変換された移植残り」と整合する。  
- 実装方針:
  - 本体修正は `timer3Restart` の1行を `* 1000` に統一（最小差分）。
  - `for performance` の説明は削除し、RFC準拠の単位境界（秒→ms）に置き換える。
  - 単位ミス再発防止として、`setTimeout` 呼び出しms値の検証テストを追加する。

## 4. 考慮すべき制約や注意点

- 既存挙動への影響:
  - タイムアウトが実質1000倍（ms換算の正常値）へ補正されるため、過剰再送は抑制される一方、再送までの待機は現状より長くなる。  
- 変更範囲はSCTPタイマー単位整合に限定し、他の輻輳制御ロジックには触れない。  
- privateメソッド検証時はテスト実装上のアクセス方法（`as any` 等）を最小限にし、型安全性を過度に崩さない。
- 「performance」の名目で RFC のタイマ規則（R1/R3）を逸脱しないこと。性能調整が必要なら、RTO計算式や最小値パラメータ側で議論し、タイマ単位変換の欠落で代替しない。  
- RFC実装上の注意:
  - RFCは「RTO値でタイマーを扱う」ことを要求しており、内部単位（秒/ミリ秒）の選択は実装依存。  
  - ただし同一実装内で単位は一貫させる必要があり、JSタイマー境界（`setTimeout`）での秒→ms変換漏れを防ぐこと。

## 5. 完了条件

- [ ] `timer3Restart` が `this.rto * 1000` でスケジュールされる。  
- [ ] `// for performance` が削除され、単位境界を説明する記述へ置換される。  
- [ ] 回帰テストが追加され、`packages/sctp` のテストが通る。  
- [ ] T1/T2/T3/reconfig のRTO単位（秒→ms変換）がコード上で一貫していることを確認できる。  
- [ ] チケット本文に RFC 9260 §6.3.1 / §6.3.2 を根拠として明記できている。
- [ ] 旧実装の原因が「性能最適化」ではなく「リファクタ時の部分的単位変換残り」であることを、調査結果（`git show`/`git blame`）として明記できている。
