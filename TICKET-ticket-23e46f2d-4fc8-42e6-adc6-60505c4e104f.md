対象リポジトリ:
shinyoshiaki/werift-webrtc

対象ブランチ:
ticket/c724daf9-5f79-4e30-bd50-7b27c8951844

目的:
このブランチの GCC / TWCC sender-side bandwidth estimation 実装を完成させてください。

単に既知のレビュー指摘を修正するだけではなく、同種の問題を自律的に探索し、
固定された libwebrtc implementation と比較して未発見の意味論差・state machine差・
timing差・lifetime差・clock domain差・境界条件差を見つけ、必要な修正まで行ってください。

最終的な目標は「レビューで新しい Blocker / Major が見つからない状態」です。

==================================================
Source of truth
==================================================

この実装については、リポジトリに固定されている
libwebrtc snapshot / pin を一次資料として扱ってください。

主な比較対象:

third_party/libwebrtc-ref/

特に以下を横断的に比較してください。

- goog_cc_network_control.cc / .h
- send_side_bandwidth_estimation.cc / .h
- delay_based_bwe.cc / .h
- aimd_rate_control.cc / .h
- link_capacity_estimator.cc / .h
- loss_based_bwe_v2.cc / .h
- probe_controller.cc / .h
- probe_bitrate_estimator.cc / .h
- acknowledged_bitrate_estimator*
- robust_throughput_estimator*
- alr_detector.cc / .h
- transport_feedback_adapter.cc / .h
- bitrate_prober.cc / .h
- bwe_defines.h
- sequence number unwrap 関連
- その他、上記から参照される定数・state・helper

固定 pin に存在しない仕様を「libwebrtc互換」として推測で追加しないでください。
必要な参照ファイルが snapshot に不足している場合は、まず snapshot を補完してください。

==================================================
重要な作業原則
==================================================

1. 直前のレビュー指摘だけを直して終了しないこと。

既知の指摘を修正した後、必ず周辺コードを再レビューし、
同じ種類の問題が別経路にも存在しないか探索してください。

例:
- TWCC path は正しいが ProcessInterval path が違う
- feedback path は正しいが OnSentPacket path が違う
- target bitrate は正しいが ProbeController へ伝播されていない
- state は正しいが呼び出し順序が違う
- reset 時だけ semantics が違う
- exact equality / wrap / timeout 境界だけ違う
- receive-time と send-time / wall clock が混在している
- controller timeout と estimator history lifetime が混ざっている

2. libwebrtc の「関数単位」ではなく「呼び出しグラフ単位」で比較すること。

例えば以下を独立に比較しないでください。

  UpdateEstimate()
  ProbeController::Process()
  MaybeTriggerOnNetworkChanged()

実際に GoogCcNetworkController からどの順序で呼ばれるかを確認し、

  event
    ↓
  state update
    ↓
  probe process
    ↓
  target propagation

まで含めて werift と比較してください。

特に以下の production event path を図にして比較してください。

- OnSentPacket
- OnTransportPacketsFeedback
- OnProcessInterval
- OnRoundTripTimeUpdate
- OnNetworkStateEstimate
- ALR enter / leave
- probe result
- feedback stall / high RTT
- reset / estimator replacement

3. 「同じ計算式」だけでなく以下を必ず比較してください。

- 実行順序
- state transition
- state persistence
- reset semantics
- clock domain
- timeout の基準 clock
- periodic processing
- boundary condition (`>` / `>=`)
- default value
- min/max clamp の順序
- feedback reorder
- duplicate feedback
- late feedback
- sequence wrap
- packet lifetime
- cluster lifetime
- ALR中の挙動
- loss limited時の挙動
- high RTT時の挙動
- probe開始/停止条件
- probe result適用条件

4. Known Differences を逃げ道にしないこと。

純TypeScript実装上避けられない差や、このチケットで明示的に非対象とされたものだけを
Known Differences に残してください。

以下のような差は原則として修正対象です。

- state machine の違い
- probe exploration policy の違い
- timeout semantics の違い
- RTT / loss / delay の優先順位の違い
- min/max bitrate の違い
- feedback ordering の違い
- reset後にstateが余計に消える
- pinに存在するperiodic処理がない
- pinと異なる独自cap
- testを通すためだけのproduction special case

「Known Difference に書いたから完了」としないでください。

==================================================
まず修正する既知の問題
==================================================

現在のレビューで少なくとも以下が残っています。

A. OnSentPacket の責務が広すぎる

werift の rtpPacketSent() から、

- RTT based target reduction
- ProbeController::Process 相当

を実行しないでください。

pin の OnSentPacket と同じく主に、

- ALR OnBytesSent
- sent packet history
- first packet の UpdatePropagationRtt(send_time, 0)
- RttBasedBackoff::OnSentPacket
- probe packet send-fill accounting

までにしてください。

time-driven な処理は ProcessInterval に集約してください。

B. ProcessInterval の呼び出し順序

固定 pin の実際の順序をそのまま確認してください。

概念的には:

  bandwidth_estimation_.UpdateEstimate()
  ↓
  ALR start/end wiring
  ↓
  ProbeController::Process()
  ↓
  MaybeTriggerOnNetworkChanged()
      ├─ AlrDetector::SetEstimatedBitrate
      └─ ProbeController::SetEstimatedBitrate

werift も同じ順序にしてください。

以前のレビューや既存コメントを正しいと仮定せず、
必ず固定 pin のコードそのものを確認してください。

==================================================
既知問題修正後の自律探索
==================================================

上記を修正したあと、以下の方法で未発見問題を探索してください。

各主要クラスについて werift と pin の state を対応付けた表を作ってください。

例:

werift field
libwebrtc field
initial value
update path
reset path
clock
lifetime

対象:

- GccBandwidthEstimator
- AimdRateControl
- LinkCapacityEstimator
- RttBasedBackoff
- LossBasedBwe
- ProbeController
- ProbeBitrateEstimator相当
- AcknowledgedBitrateEstimator
- AlrDetector
- InterArrivalDelta
- TrendlineEstimator
- sent packet / TWCC sequence history

次に、各イベントについて before/after state を比較してください。

特に探索優先度が高いもの:

- feedbackが一度も来ない
- feedbackが途中で止まる
- feedbackが60秒近く遅延
- TWCC duplicate
- not-received → 後からreceived
- sequence 0xffff → 0x0000
- probe 80%到達直後
- probe result timeout直前/直後
- pacing timeout直前/直後
- ALR enter直前/直後
- underuse → normal が同じfeedback内
- high RTT と loss decrease が同時
- probe result と high RTT が同時
- exact max bitrate
- exact min bitrate
- targetが5kbps floorに到達
- estimator swap中にawaitがある
- reset後に設定値が保持されるべきもの
- reset後に消えるべきhistory
- media reorder + padding sequence
- multi feedback batch ordering

==================================================
テスト方針
==================================================

修正ごとに「そのバグだけを再現する最小 regression test」を追加してください。

private field を直接書き換えるテストだけで済ませず、
可能なものは public / production path でもテストしてください。

特に以下の形式を優先してください。

  Arrange
  → 実際の production event
  → intermediate state
  → next production event
  → final observable result

例:

  RTP send
  → 25ms process
  → TWCC
  → 25ms process
  → availableBitrate / probe config

境界値テストを必ず追加してください。

- timeout - 1
- timeout
- timeout + 1
- max - 1
- max
- max + 1
- wrap前
- wrap後

「実装に合わせて期待値を作る」のではなく、
固定 pin のコードから期待値を導いてください。

==================================================
検証
==================================================

最低限以下を実行してください。

- GCC/TWCC関連 targeted vitest
- packages/webrtc type check
- packages/webrtc の通常テスト
- repository の CI 相当
- werift ↔ werift bottleneck simulation
- Chrome ↔ werift GCC/TWCC simulation

失敗した場合は、
「既存失敗だから無視」ではなく今回の変更との因果を確認してください。

simulation については単に process が終了するだけではなく、

- bitrateが容量に収束する
- congestion時に下がる
- recoveryする
- probeで過剰送信し続けない
- floorに張り付かない
- feedback stallで安全側へ落ちる

など意味のあるassertを維持してください。

==================================================
self-review loop
==================================================

実装後、必ず以下のループを自律的に実行してください。

  1. fixed-pin libwebrtc と再比較
  2. 新しい意味論差を探す
  3. severity を Blocker / Major / Minor に分類
  4. Blocker または Major があれば修正
  5. regression test を追加
  6. tests / type / simulation を再実行
  7. 再度 self-review

Blocker / Major が 0 になるまで繰り返してください。

「既知のレビュー指摘を全部直した」だけでは終了条件を満たしません。

==================================================
禁止事項
==================================================

以下はしないでください。

- テストを通すためだけの production branch / clock heuristic
- libwebrtc の挙動を確認せず推測で定数を置く
- synthetic test の都合で production clock semantics を変える
- state-preserving setter の代わりに full reset
- timeout 後に必要な measurement history まで消す
- Known Differences に重大な意味論差を追加して終了
- 修正対象と無関係な大量リファクタ
- generated file / __pycache__ 等のコミット
- CIを実行できていないのに成功したと記載
- 「レビューで言われていないから」という理由で問題を残す

==================================================
develop との差分
==================================================

作業終盤で最新 develop を確認してください。

GCC実装と直接関係しない変更でも、
対象ブランチが behind なら取り込み可否を評価してください。

コンフリクトがなければ最新 develop に追従した状態で最終 validation を行ってください。

==================================================
完了条件
==================================================

以下をすべて満たした場合のみ完了してください。

- 既知レビュー指摘がすべて修正済み
- fixed-pin libwebrtc と event path / state machine を再監査済み
- 新規 Blocker 0
- 新規 Major 0
- Known Differences に重大な意味論差が残っていない
- regression tests がある
- targeted tests 成功
- type check 成功
- broader tests / CI 成功
- werift↔werift simulation 成功
- Chrome↔werift simulation 成功
- generated garbage がない
- developとの差分を最終評価済み

最後に、以下を報告してください。

- 最終 commit SHA
- 修正した問題
- 自律探索で新たに発見した問題
- pin と比較した主要 event path
- 意図的に残した Known Differences と理由
- 実行したテストと結果
- simulation結果
- developとの差分
- 最終 self-review の Blocker / Major / Minor 件数

途中で新しい問題を見つけた場合、
私への確認待ちにせず、チケットの目的の範囲内であれば修正まで進めてください。