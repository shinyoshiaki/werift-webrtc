Grep "rto|\* 1000|RTO" in **/*.ts (packages/sctp/src)

● Read packages/sctp/src/sctp.ts lines 680-760

● Read packages/sctp/src/sctp.ts lines 930-1045

● Grep "time\(|Date.now|performance.now|timestamp" in **/*.ts (packages/sctp/src)

● Read packages/sctp/src/sctp.ts lines 250-430

● Read packages/sctp/src/sctp.ts lines 540-610

● Read packages/sctp/src/sctp.ts lines 840-915

● Grep "timer3Restart\(|timer3Start\(|rto\s*\*\s*1000" in **/*.{ts,test.ts} (packages/sctp)

● Read packages/sctp/src/sctp.ts lines 620-675

● Glob "packages/sctp/**/*.test.ts"

● Grep "timer3|rto|retransmit|SACK|T3-rtx" in **/*.test.ts (packages/sctp)

● Read packages/sctp/tests/sctp.test.ts lines 1-260

● Blame timer3 lines
  $ git --no-pager blame -L 1016,1028 packages/sctp/src/sctp.ts

● Inspect commit introducing timer change
  $ git --no-pager show --stat --no-color --no-patch 4bfa7297a && git --no-pager show --no-color
  4bfa7297a -- packages/sctp/src/sctp.ts | sed -n '1,220p'

● Find timer3 setTimeout in commit diff
  $ git --no-pager show --no-color 4bfa7297a -- packages/sctp/src/sctp.ts | rg
  "t3Restart|timer3Restart|setTimeout\(.*rto" -n

● Inspect historical vendor t3 timer code
  $ git --no-pager show --no-color c55e3f26a:src/vendor/sctp/sctp.ts | sed -n '930,1015p'

● Locate vendor timer3 functions
  $ git --no-pager show --no-color c55e3f26a:src/vendor/sctp/sctp.ts | rg
  "t3Start|t3Restart|setTimeout\(this\.t3Expired" -n

● Check historical RTO constants units
  $ git --no-pager show --no-color c55e3f26a:src/vendor/sctp/sctp.ts | sed -n '40,90p'

● Read packages/sctp/package.json

● Grep "vi\.useFakeTimers|jest\.useFakeTimers|setTimeout\(" in **/*.ts (packages/sctp/tests)

● Read packages/sctp/src/sctp.ts lines 90-210

● Read packages/sctp/src/transport.ts

● Create session plan file
  $ cat > /home/shin/.copilot/session-state/11a3764c-a04d-483f-b6eb-7b83e80f9dcc/plan.md <<'EOF'
  - [x] Locate SCTP RTO timer code and unit usage
  - [x] Compare timer3Start and timer3Restart behavior
  - [x] Check historical commits for intent
  - [x] Draft detailed task specification in Japanese...

● update_todo

## 1. タスクの目的と背景

- 対象は `packages/sctp/src/sctp.ts` の `timer3Start` と `timer3Restart` で、`setTimeout` の第2引数に `this.rto * 1000` を使う箇所と `this.rto` のままの箇所が混在しています。  
- コード調査では、`this.rto` は `Date.now() / 1000` 由来のRTT計算（秒単位）で更新され、`SCTP_RTO_MIN=1`, `SCTP_RTO_MAX=60` も秒前提です。  
- `setTimeout` はミリ秒前提のため、`timer3Restart` だけ `* 1000` が無いと再送タイマー(T3-rtx)が 1–60ms で発火し、`timer3Start`/T1/T2/reconfig timer と整合しません（挙動不安定・過剰再送の原因）。

## 2. 実装すべき具体的な機能や変更内容

- `packages/sctp/src/sctp.ts` の `timer3Restart` を以下に統一する。  
  - 現在: `setTimeout(this.timer3Expired, this.rto)`  
  - 変更: `setTimeout(this.timer3Expired, this.rto * 1000)`  
- 「for performance」コメントは誤解を招くため、削除または「RTOは秒なのでmsへ変換」といった単位明示コメントに置換。  
- 回帰防止として、`packages/sctp/tests` に「T3 restartがRTO(ms)でスケジュールされること」を検証するテストを追加。

## 3. 技術的な実装アプローチ（調査結果サマリ）

- 単位の事実確認:
  - RTT計算: `receivedTime - sentTime`（両方 `Date.now()/1000`）→ 秒
  - `updateRto` のクランプも秒
  - 他タイマー（T1/T2/T3 start/reconfig）は `* 1000`
- 履歴確認:
  - 旧実装由来で `t3Restart` は長く `this.rto` のまま残っており、リファクタ時に `timer3Start` は `*1000` 化されたが `timer3Restart` が取り残された形。  
- 実装方針:
  - 変更は1行中心の最小修正。
  - テストは `setTimeout` 呼び出し引数の検証で十分（ネットワーク統合テスト不要）。

## 4. 考慮すべき制約や注意点

- 既存挙動への影響:
  - タイムアウトが実質1000倍に戻るため、再送頻度がRFC意図に近づく一方、短期的にテスト待機時間へ影響の可能性。  
- 変更範囲はSCTPタイマー単位整合に限定し、他の輻輳制御ロジックには触れない。  
- privateメソッド検証時はテスト実装上のアクセス方法（`as any` 等）を最小限にし、型安全性を過度に崩さない。

## 5. 完了条件

- [ ] `timer3Restart` が `this.rto * 1000` でスケジュールされる。  
- [ ] 単位不整合を生むコメント/記述が解消される。  
- [ ] 回帰テストが追加され、`packages/sctp` のテストが通る。  
- [ ] T1/T2/T3/reconfig のRTO単位（秒→ms変換）がコード上で一貫していることを確認できる。