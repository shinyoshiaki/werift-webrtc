GCC 実装の自律的な互換性レビュー・修正・完成

対象ブランチの実装を、リポジトリ内のチケット要件および固定された libwebrtc 参照実装を基準として網羅的にレビューし、問題を自律的に探索・修正してください。

最重要方針

この作業は「現在知られているレビュー指摘だけを修正する」タスクではありません。

既知の問題を修正した後、その修正によって新しい意味論的差異・状態遷移の不整合・lifetime 問題・cleanup 漏れ・clock domain の混在などが生じていないかを自律的に再レビューしてください。

最終的に以下を満たすまで、

調査 → 問題特定 → 修正 → regression test 追加 → CI/test → 固定 pin との再比較 → self-review

を反復してください。

- Blocker: 0
- Major: 0
- GCC の主要 state transition に説明不能な libwebrtc との差異がない
- Known Differences が実装上の重大な意味論差異を隠すために使われていない
- チケットの完了条件をすべて満たしている

Minor についても合理的に修正可能なものは残さないでください。

---

1. Source of truth

Ticket

リポジトリ内の対象チケット Markdown を最初から最後まで読み、要件・完了条件・非機能要件・self-review 条件をチェックリスト化してください。

チケットに書かれている完了条件を勝手に縮小しないでください。

libwebrtc reference

比較対象はリポジトリに固定されている libwebrtc snapshot のみとします。

"third_party/libwebrtc-ref/"

および pin metadata に記載された revision を source of truth としてください。

Web 上の最新 "main" や別 revision の libwebrtc を混ぜないでください。

固定 pin と異なる別 revision を参照した場合は、その結果を互換性判断に使用しないでください。

---

2. 最初に既知の問題を確認する

現在までのレビューで特に問題になっていた次の領域を、まず最新コードで確認してください。

ただし、これらを修正しただけで作業完了とはしないでください。

Probe

- active probe を partial TWCC feedback の loss / overuse だけで mid-cluster abort しないこと
- pacing lifetime と result wait lifetime が独立していること
- ProbeController の result-wait timeout と ProbeBitrateEstimator の measurement history lifetime が分離されていること
- late TWCC が controller timeout 後でも合理的な期間は probe result を生成できること
- estimator history / sequence mapping が無期限に残らないこと
- zero-packet / no-feedback / partial-feedback の cluster でも memory が回収されること
- initial / further / recovery probe の exact-max 判定が固定 pin と一致すること
- probe result 80%成立後も残り ACK で estimator が更新可能なこと
- probe result の lower-result guard が固定 pin と一致すること

Probe state gating

特に以下を固定 pin と比較してください。

- "normal"
- "underuse"
- "overuse"
- loss-based decreasing
- loss-based increasing
- loss-based hold
- delay-based limited
- RTT limited

それぞれについて、

- 新規 probe を開始してよいか
- further probe を開始してよいか
- recovery probe を開始してよいか
- upward probe result を適用してよいか
- downward probe result を適用してよいか

を表にして比較してください。

単純な

const congested = usage === "overuse";

のような一つの boolean で複数の異なる libwebrtc state を潰していないか特に確認してください。

libwebrtc の

- "GetBandwidthLimitedCause"
- "ProbeController::InitiateProbing"
- "ProbeController::SetEstimatedBitrate"
- "ProbeController::RequestProbe"
- "DelayBasedBwe"
- "GoogCcNetworkController"

の連携全体を追ってください。

---

3. 既知の問題以外を自律探索する

コードを subsystem 単位で固定 pin と比較してください。

最低限以下をすべてレビュー対象にします。

Feedback preprocessing

- TWCC sequence unwrap
- reference time unwrap
- receive-time ordering
- send-time ordering
- duplicate feedback
- overlapping feedback
- late loss correction
- soft loss
- unknown sequence
- 16-bit wrap
- 24-bit reference-time wrap

Acknowledged bitrate

- RobustThroughputEstimator の default
- required packets
- min/max window
- receive gap replacement
- send/receive rate calculation
- reorder handling
- stale packet handling
- ALR / prior-unacked-data を省略した影響

Delay-based BWE

- InterArrivalDelta
- TrendlineEstimator
- overuse / underuse / normal transition
- stream timeout
- reordered packet
- AIMD state
- RTT
- TimeToReduceFurther
- probe result application
- SetEstimate 時の state preservation

Loss-based BWE

- observation window
- partial observation
- loss correction
- byte loss
- HOLD
- decreasing / increasing / delay-based transition
- delayed increase
- inherent loss
- candidate bounds
- probe result application時の history preservation

ProbeController / ProbeBitrateEstimator

- initial exponential probing
- FIFO
- pacing
- send-fill
- result wait
- estimator history
- recovery
- further probing
- exact max
- loss/delay gating
- cooldown
- timeout
- late ACK
- cleanup
- sequence ownership
- result refinement

Sender integration

- media packet と padding packet の RTP sequence
- transport-wide sequence
- reorder
- retransmission
- RTP cache
- padding packet accounting
- SR packet/octet counters
- async padding injection
- estimator reset / reuse
- event firing
- disposal / cleanup

---

4. 特に探索すべきバグパターン

以下を grep 的に見るだけではなく、実際の state transition を追って検証してください。

Clock domain

同じ変数・timeout・comparison に、

- sender wall clock
- TWCC receiver timeline
- RTP send timestamp
- feedback arrival time

が混在していないか。

Lifetime coupling

本来独立である、

- sender packet history
- ProbeController session
- BitrateProber pacing
- ProbeBitrateEstimator measurement history

の寿命が一つの map / timeout に結合されていないか。

Premature cleanup

- controller が結果待ちを終了しただけで estimator data を削除していないか
- 80% result で残り20%を捨てていないか
- partial feedback で cluster を捨てていないか

Missing cleanup

逆に、

- no ACK
- zero send
- partial send
- sequence never reported
- network loss
- repeated recovery

で map / history が永久保持されないか。

長時間接続で有界メモリになることを確認してください。

State collapsing

libwebrtc では別の意味を持つ状態を、

congested / not congested

や

loss limited / not loss limited

の1bitにまとめた結果、probe permission や rate-control behavior が変わっていないか。

Known Differences misuse

Known Differences に書いてあるから許容、という判断は禁止です。

各 difference について、

1. チケット上許容される理由があるか
2. pure TypeScript という制約上不可避か
3. 主要な control response を変えないか

を確認してください。

意味論的に合わせられるものは合わせてください。

---

5. 状態遷移テーブルを作る

実装を修正する前、または修正と並行して、少なくとも Probe 周辺について固定 pin と werift の比較表を作ってください。

例:

Delay state| Loss state| Controller state| libwebrtc action| werift action| Match
normal| delay_based| complete| recovery allowed| ...| ...
underuse| delay_based| complete| no new probe| ...| ...
overuse| delay_based| complete| no new probe| ...| ...
normal| decreasing| complete| no probe| ...| ...
normal| increasing| complete| capped probe| ...| ...

この表で差異が見つかったら、意図的差異として正当化できない限り修正してください。

---

6. テスト方針

問題を修正するときは、必ずその問題を再現する regression test を先に追加するか、修正と同時に追加してください。

private field を直接書き換えるだけのテストだけでは不十分です。

可能な限り public/full-path の

RTP sent
→ pacing
→ TWCC feedback
→ estimator
→ state transition
→ available bitrate / next probe

を通してください。

最低限、以下を追加・維持してください。

Probe state

- underuse 中は新規/further probe が開始されない
- underuse → normal 復帰時には recovery probe が可能
- overuse 中は upward probe result を適用しない
- lower valid probe result は必要な guard 付きで適用
- loss decreasing/hold 中は probe を開始しない
- loss increasing の behavior が固定 pin と対応する

Lifetime

- controller timeout 後でも late TWCC result が得られる
- controller timeout で further session が再度開かない
- receive-time horizon 超過で estimator cluster が prune される
- no-ACK cluster が sender-side finite lifetime 後に消える
- zero-packet pacing timeout が history leak を作らない
- repeated recovery probe を多数回行っても map/history size が bounded

Boundary

境界値について必ずテストしてください。

- "== max"
- "== timeout"
- "timeout + 1"
- 79% / 80% / 100% ACK
- sequence "65535 → 0"
- TWCC reference time wrap
- exact loss thresholds
- exact state transition threshold

---

7. 修正後の自律 self-review

テストが通った時点で終了しないでください。

一度「自分が別のレビュアーである」と仮定して、修正後の diff を再レビューしてください。

特に以下を問い直してください。

- この修正で別の state に probe を許可してしまっていないか
- cleanup を遅らせた結果 leak を作っていないか
- cleanup を追加した結果 late feedback を早く捨てていないか
- sender clock と receiver timeline を混ぜていないか
- controller と estimator の lifetime を再結合していないか
- max / threshold の ">" と ">=" は固定 pin と一致しているか
- Known Differences の文面と実コードは一致しているか
- docs が古い挙動を説明していないか
- テストが実装詳細に合わせて pass しているだけではないか

一つ問題を修正したら、その周囲を最低1段階広くレビューしてください。

たとえば ProbeController の timeout を修正したなら、

ProbeController
→ ProbeBitrateEstimator
→ GccBandwidthEstimator
→ RTCRtpSender pacing

まで確認してください。

---

8. CI / validation

対象チケットで指定されている CI コマンドを実行してください。

失敗した場合は、

原因調査
→ 修正
→ 同じCI再実行

を成功するまで繰り返してください。

さらにチケットに要求されている、

- unit tests
- werift ↔ werift simulation
- 他実装との interoperability test
- bottleneck
- loss
- delay

を実施してください。

手動試験指定のものを unit test に置き換えただけで完了扱いにしないでください。

実行できない試験があれば黙って完了扱いにせず、理由・未確認範囲を明記してください。

---

9. develop との差分

最終段階で最新 "develop" との差分を確認してください。

対象ブランチが behind の場合は develop の変更内容を確認し、競合・回帰・依存関係への影響を評価してください。

取り込みが必要なら取り込み、取り込み後に再度 CI / relevant tests を実行してください。

---

10. ドキュメント

コード修正後、

- GCC_KNOWN_DIFFERENCES
- API docs
- ProbeController docs
- simulation docs
- ticket Markdown

が実装と一致していることを確認してください。

生成ツールやエージェント由来の説明文など、チケット本文ではない文章が accidentally committed されていないかも確認してください。

---

11. 完了判定

以下のどれかが残っている場合、作業完了と宣言しないでください。

- Blocker
- Major
- 説明不能な pinned libwebrtc との state-transition 差異
- unbounded memory growth
- clock-domain bug
- premature cleanup
- controller / estimator lifetime coupling
- Known Differences と実装の不一致
- 必須 regression test の不足
- 必須 CI / simulation の失敗
- チケット完了条件の未達

新しい問題を発見した場合、ユーザーの確認を待たず、対象チケットのスコープ内であれば自律的に修正してください。

ただし、単なる好み・大規模リファクタ・チケット外の改善まで無制限にスコープを広げないでください。

---

最終報告

最後に以下を報告してください。

1. 発見した問題一覧
   
   - Blocker / Major / Minor
   - 原因
   - 固定 pin との違い

2. 実施した修正

3. 追加した regression tests

4. 固定 libwebrtc pin と比較した主要 state transition の最終結果

5. CI / simulation / interoperability test の実行結果

6. Known Differences として最終的に残した差異と、その差異を許容できる理由

7. 最終 self-review 結果
   
   - Blocker: 0
   - Major: 0
   - Minor: N

8. 完了条件チェックリスト

Blocker または Major が1件でも残っている場合は「実装完了」と報告しないこと。