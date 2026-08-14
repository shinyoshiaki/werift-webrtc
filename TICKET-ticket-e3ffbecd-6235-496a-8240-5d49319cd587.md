対象:
- Repository: shinyoshiaki/werift-webrtc
- Branch: ticket/c724daf9-5f79-4e30-bd50-7b27c8951844
- Ticket:
  TICKET-ticket-c724daf9-5f79-4e30-bd50-7b27c8951844.md
- libwebrtc fixed pin:
  0fda16159e33adf59c71a7ad1173dcbe5a632102
- Reference snapshot:
  third_party/libwebrtc-ref/

目的:
このブランチの GCC / TWCC BWE 実装を完成させてください。

既知のレビュー指摘だけを修正するのではなく、
ticket の完了条件と fixed-pin libwebrtc を source of truth として、
未発見の意味論差・state transition 差・clock/lifetime/order 差・
edge case・test不足を自律的に探索し、必要な修正を行ってください。

最終的に、自分自身で網羅的な再レビューを行った際に
Blocker / Major 相当の問題が残っていない状態まで反復してください。

重要:
「レビュー指摘を通すための局所修正」ではなく、
fixed pin のアーキテクチャ・状態・更新順序を理解したうえで
根本原因を修正してください。


====================
1. Source of truth
====================

互換性判断では必ず以下の優先順位を守ってください。

1. repository 内の fixed-pin snapshot
   third_party/libwebrtc-ref/
2. TICKET-ticket-c724daf9-5f79-4e30-bd50-7b27c8951844.md
3. draft / RFC
4. 現在の werift 実装

最新 upstream libwebrtc main の挙動を fixed pin に混ぜないでください。

PIN.json の SHA が必ず
0fda16159e33adf59c71a7ad1173dcbe5a632102
であることを確認してください。

参照に必要な fixed-pin source/header が snapshot に欠けている場合は、
推測で定数や意味論を補わず snapshot を追加してください。


====================
2. まず現在の実装を再構築する
====================

修正開始前に、以下を把握してください。

- branch HEAD
- develop との差分
- ticket の acceptance criteria
- GCC の主要データフロー
- RTCRtpSender → GccBandwidthEstimator
- OnSentPacket 相当
- OnTransportPacketsFeedback 相当
- OnProcessInterval 相当
- MaybeTriggerOnNetworkChanged 相当
- DelayBasedBwe
- AimdRateControl
- LossBasedBweV2
- ProbeController
- ProbeBitrateEstimator
- AlrDetector
- RttBasedBackoff
- TransportFeedbackAdapter 相当
- TWCC sequence/reference-time unwrap
- probe padding / pacing
- estimator swap/reset/dispose lifecycle

「各クラス単体」だけでなく、
fixed pin の controller-level call graph と更新順序まで追ってください。


====================
3. 既知のレビュー指摘
====================

以下は過去レビューで修正済みですが、
新しい修正によって再発していないか regression として確認してください。

- raw RTCP RTT と smoothed stats RTT の分離
- AIMD RTT と propagation RTT の分離
- RttBasedBackoff 3s / ×0.8 / 1s / 5kbps
- OnSentPacket と OnProcessInterval の責務分離
- ProcessInterval の ordering
- LinkCapacityEstimator Reset semantics
- AIMD equations
- initial probe と NetworkAvailability
- periodic ALR probe default false
- high RTT 中の LossBased ordering
- all-lost feedback の DelayBased Result.updated=false
- committed LossBased observation の late ACK 非書換え
- repeated PacketNotReceived accounting
- ALR 中の acked candidate suppression
- PaddingDuration / CanKeepIncreasingState
- byte-loss min/max spike filtering
- upward probe result の独自 cap 禁止
- lower probe の acked×0.85 floor
- active probe FIFO/send-fill lifecycle
- receive-time ordering
- TWCC wrap / late reorder / duplicate feedback
- 60s send-time history
- common BandwidthEstimator interface を thin に保つ
- RTT/processor/network availability 等は capability interface へ分離
- available bitrate event は change-only


====================
4. 現在特に重点的に調査する領域
====================

直近レビューでは LossBasedBweV2 にまだ構造的な差が見つかっています。

特に fixed pin の
LossBasedBweV2::UpdateBandwidthEstimate()
を上から下までほぼ1対1で比較してください。

最低限、次を確認・修正してください。

A. current_best_estimate_ と loss_based_result_ の分離

fixed pin は:

- current_best_estimate_
  candidate exploration の内部 state

- loss_based_result_
  externally published result/state

を別に保持しています。

HOLD 中も current_best_estimate_ は新しい best candidate を保持し、
published result だけ last_hold_info_.rate で抑えます。

TypeScript 側もこの2つを分離してください。
HOLD のために internal best estimate 自体を巻き戻さないでください。


B. HOLD は独立 LossBasedState ではない

fixed pin LossBasedState は:

- kIncreasing
- kIncreaseUsingPadding
- kDecreasing
- kDelayBasedEstimate

だけです。

kHold はありません。

HOLD は:

state == kDecreasing
&& last_hold_info.timestamp > last_send_time

として表現してください。

さらに HOLD timer は
「kDecreasing へ初めて入るとき」にだけ arm します。

すでに kDecreasing の状態でさらに bitrate が低下しても、
毎回 hold timer / duration を再設定してはいけません。


C. GetCandidates と acked ramp-up cap の順序

fixed pin:

GetCandidates
→ NewtonsMethodUpdate
→ GetObjective
→ best candidate 選択
→ delayed increase window
→ acked bitrate ramp-up cap
→ decreasing→increasing 用 +1bps 補正
→ instant/delay bound
→ state transition

です。

acked-rate cap を candidate generation 前や
objective 評価前に適用しないでください。

特に fixed pin にある:

if previous state == kDecreasing &&
   acked cap 後の best == current_best
then
   best = current_best + 1 bps

も確認してください。

これは kIncreasing へ戻して padding を開始するための意味論です。


D. max bitrate 判定

loss-limited state 判定では global 1Gbps 定数ではなく、
configured max_bitrate_ を使ってください。

fixed pin:

bounded < delay_based_estimate_
&& bounded < max_bitrate_

です。


E. initial state

LossBasedBwe の公開 result/state は
初期状態 kDelayBasedEstimate 相当であるべきです。

internal candidate state と externally visible state を混同しないでください。


====================
5. 「同様の問題」を自律的に探す方法
====================

上の項目を直したら終わりにしないでください。

fixed pin の各主要クラスについて、
TypeScript 実装との systematic diff をしてください。

特に次の観点で探索してください。

- state field の数・役割が一致しているか
- 2つの state/value を1つへ統合していないか
- update order が一致しているか
- early return の位置が一致しているか
- previous state と new state のどちらを条件に使うか
- condition が < / <= / > / >= で違わないか
- timer をセットするタイミング
- timer を更新しない条件
- reset が全 state を消すのか一部だけ消すのか
- timestamp の clock domain
- sender time / receiver time / feedback time の混在
- infinity / undefined / zero の意味の違い
- optional value を 0 sentinel にして意味を壊していないか
- configured min/max と global defaults の混同
- receive order / send order の取り違え
- commit 前後で mutable/immutable semantics が変わらないか
- duplicate / late / reordered feedback
- first packet / first feedback / no feedback
- network unavailable / reconnect
- ALR enter/leave
- high RTT
- all lost
- no receive delta
- probe timeout
- max bitrate 到達
- min bitrate 到達
- sequence wrap
- estimator reset / swap
- process timer と event-driven update の重複

単に関数単位で似ているかを見るのではなく、
実際の一連の event sequence に対して
「fixed pin と werift が同じ state を遷移するか」
を確認してください。


====================
6. Known Differences の扱い
====================

Known Differences を「問題を許容する逃げ道」にしないでください。

以下に影響する差は原則として修正対象です。

- target bitrate
- loss/delay state
- BandwidthLimitedCause
- probe generation
- probe suppression
- recovery timing
- ALR behavior
- RTT safety behavior
- loss observation
- state transition
- event timing
- lifetime
- clock semantics

Known Differences に残してよいのは例えば:

- pure TypeScript と C++ の sub-bps numerical drift
- PacedSender 自体を使わない実装方式の違い
- ticket で明示的に non-goal とされた REMB 等

です。

material semantic difference を Known Differences に記載して
完了扱いにはしないでください。


====================
7. テスト
====================

修正した問題ごとに regression test を追加してください。

private field を直接書き換えるだけのテストに偏らず、
可能なら public/controller-level event sequence で再現してください。

特に:

- state before
- event
- state after

を fixed pin と比較可能な形にしてください。

LossBasedBweV2 については、
fixed pin の代表的な系列を table-driven test にすることを推奨します。

例:

delay_based
→ loss decrease
→ kDecreasing + HOLD
→ HOLD 中に internal best は増加
→ published result は hold rate
→ HOLD expire
→ increasing
→ IncreaseUsingPadding
→ PaddingDuration expire
→ delay_based

ALR true/false、
acked rate、
configured max、
duplicate loss、
late received、
loss spike、
padding window
も組み合わせてください。


====================
8. Validation
====================

最低限以下を実行してください。

cd packages/webrtc
npx vitest run tests/media/bandwidthEstimator.test.ts
npm run type

変更範囲に応じて:

npm run test:small
または
npm run ci

可能なら必ず:

npm run test:sim

さらに e2e simulation:

cd e2e
npm run test:sim

werift↔werift bottleneck simulation と
Chrome↔werift bottleneck simulation の両方を確認してください。

単に process が exit 0 したことではなく、
simulation assertion が実際に:

- bandwidth rise
- congestion reduction
- recovery
- RTT stall backoff
- probe behavior

を検証していることも確認してください。


====================
9. 自己レビューを反復する
====================

一度修正したら、自分で reviewer role に切り替えてください。

以下を繰り返してください。

1. fixed pin と比較
2. 新しい Blocker / Major / Minor を列挙
3. Blocker / Major があれば修正
4. regression test 追加
5. tests / type / simulations 実行
6. もう一度ゼロベースでレビュー

「既知指摘がなくなった」では終了しないでください。

新規 Blocker/Major が発見できなくなるまで反復してください。


====================
10. develop の取り込み
====================

最終段階では develop との差分を確認してください。

branch が develop behind の場合は、
GCC実装への影響を確認したうえで最新 develop を取り込み、
その HEAD で validation を再実行してください。

merge/rebase によって新しい regression が入っていないことも確認してください。


====================
11. 完了条件
====================

以下をすべて満たした場合だけ「完成」と判断してください。

- ticket acceptance criteria を満たす
- fixed pin systematic comparison 完了
- Blocker 0
- Major 0
- 未説明の material semantic difference なし
- Known Differences が実装と一致
- common interface architecture が ticket と一致
- legacy estimator backward compatibility 維持
- runtime estimator swap が安全
- timer/listener/subscription lifetime が bounded
- tests green
- type check green
- relevant CI green
- werift↔werift simulation green
- Chrome↔werift simulation green
- latest develop 取り込み後も green


====================
12. Git 操作
====================

必要な修正を対象 branch に直接行ってください。

作業中は小さい意味のある単位で commit して構いませんが、
最終的には:

ticket/c724daf9-5f79-4e30-bd50-7b27c8951844

へ push してください。

無関係な変更は入れないでください。
既存のユーザー変更を勝手に revert しないでください。


====================
13. 最終報告
====================

最後に以下を報告してください。

- 最終 HEAD SHA
- fixed pin SHA
- 修正した問題
- 自律探索で新たに発見した問題
- 各問題の root cause
- fixed pin の対応箇所
- 追加した regression tests
- 実行したコマンド
- test/type/simulation の結果
- develop との差分状態
- Known Differences の残件と、それが material semantic difference でない理由
- 最終 self-review:
  Blocker / Major / Minor 件数

Blocker または Major が1件でも残っている場合は
「完成」と報告せず、引き続き修正してください。