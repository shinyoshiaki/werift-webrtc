# GCC 実装の自律的な互換性レビュー・修正・完成

| 項目 | 値 |
| --- | --- |
| チケット ID | `4fa9e286-abac-417c-8b36-347b071e3990` |
| 種別 | 親実装の **自律レビュー + 問題探索 + 修正 + 回帰テスト + self-review**（再実装タスクではない） |
| 親チケット | `c724daf9-5f79-4e30-bd50-7b27c8951844`（TWCC BWE 抽象化 + legacy / GCC 選択可能化） |
| 親チケット MD | `TICKET-ticket-c724daf9-5f79-4e30-bd50-7b27c8951844.md` |
| 対象ブランチ | `ticket/4fa9e286-abac-417c-8b36-347b071e3990`（親実装済みベース） |
| ベース | `develop` |
| **libwebrtc 突合ピン** | `0fda16159e33adf59c71a7ad1173dcbe5a632102`（`main` を 2026-08-11 固定） |
| **ローカル参照** | `third_party/libwebrtc-ref/`（`PIN.json` / `MANIFEST.md` / `fetch_ref.py`） |

---

## 1. タスクの目的と背景

### 1.1 目的

親チケットで実装済みの **TWCC 駆動 send-side BWE（抽象化 + legacy + GCC）** について、「既知レビュー指摘の消化」に留まらず、次を基準に **互換性問題・状態遷移バグ・lifetime / cleanup / clock-domain 不整合・境界条件を自律的に探索・修正**し、完了条件を満たす。

- 親チケットの acceptance criteria（縮小禁止）
- [draft-ietf-rmcat-gcc-02](https://datatracker.ietf.org/doc/html/draft-ietf-rmcat-gcc-02)（概要）
- **固定ピンの libwebrtc 一次ソースのみ**（`third_party/libwebrtc-ref/` / commit `0fda1615…`）

最終目標:

> 別の厳密な reviewer が pinned libwebrtc と親チケット要件を基準に再レビューしても、**Blocker / Major を新たに発見しにくい状態**にする。

### 1.2 最重要方針

この作業は **「現在知られているレビュー指摘だけを修正する」タスクではない**。

1. 既知問題を確認・修正する  
2. その修正が新しい意味論差・state 不整合・lifetime 結合・cleanup 漏れ・clock domain 混在を生んでいないかを **再レビュー**する  
3. subsystem 単位で固定 pin と網羅比較し、未知の問題も探索する  
4. 以下を満たすまで反復する  

```text
調査 → 問題特定 → 修正 → regression test 追加 → CI/test → 固定 pin 再比較 → self-review
```

完了宣言に必要な品質バー:

| バー | 要求 |
| --- | --- |
| Severity | **Blocker: 0** / **Major: 0**（Minor も合理的に直せるものは残さない） |
| State | GCC 主要 state transition に **説明不能**な pinned libwebrtc 差がない |
| Known Diff | 重大な意味論差を隠すために `GCC_KNOWN_DIFFERENCES` を使っていない |
| Parent AC | 親チケット完了条件を勝手に縮小せずすべて満たす |

### 1.3 背景（親チケットで既に達成されていること）

本タスクは **新規に BWE を作り直す**のではなく、親実装の **監査・是正・完成**である。

| 領域 | 状態 | 主なパス |
| --- | --- | --- |
| 共通 interface | 実装済 | `packages/webrtc/src/media/sender/bandwidthEstimator.ts`（`BandwidthEstimator` = I/O + `availableBitrate` + `onAvailableBitrate` のみ。probe は `ProbePacingController`） |
| 変化時のみ通知 | 実装済 | `setAvailableBitrateIfChanged` |
| legacy 推定 | 実装済 | `estimators/legacyCumulativeBwe.ts`（`SenderBandwidthEstimator` alias）+ `onCongestion*` は具象固有 |
| GCC | 実装済 | `estimators/gcc/*`（Trendline / InterArrival / AIMD / LossBasedBweV2 系 / ProbeController / RobustThroughputEstimator） |
| 差し替え API | 実装済 | `RTCRtpSender.setBandwidthEstimator` + 安定 `onAvailableBitrate` bridge + probe padding / pacing |
| 単体テスト | 厚め | `packages/webrtc/tests/media/bandwidthEstimator.test.ts`（約 3300+ 行、多数の Blocker 回帰を含む） |
| peer sim（CI 外） | 実装済 | `packages/webrtc/simulations/` → `npm run test:sim` |
| Chrome sim（CI 外） | 実装済 | `e2e/simulations/` → `cd e2e && npm run test:sim` |
| 既知差分 | 文書化 | `GCC_KNOWN_DIFFERENCES`（`estimators/gcc/constants.ts`、typedoc: `doc/variables/GCC_KNOWN_DIFFERENCES.md`） |
| libwebrtc pin | 配置済 | `third_party/libwebrtc-ref/`（フル clone 禁止・参照専用） |

### 1.4 Source of truth

| ソース | 扱い |
| --- | --- |
| 親チケット MD | 要件・完了条件・非機能・非ゴールの一次。**完了条件を縮小しない** |
| 本チケット | 自律レビュー手順・既知問題・探索範囲・報告フォーマット |
| `third_party/libwebrtc-ref/` + `PIN.json` | 互換性判断の **唯一の libwebrtc 根拠** |
| Web 上の最新 main / 別 revision | **互換性判断に使わない**（参照した場合も結果を棄却） |
| draft-ietf-rmcat-gcc | 概要理解用。draft と pin が乖離したら **pin 優先**（親チケット方針） |

Browse（ピン固定）:

https://webrtc.googlesource.com/src/+/0fda16159e33adf59c71a7ad1173dcbe5a632102/modules/congestion_controller/goog_cc/

再取得: `python3 third_party/libwebrtc-ref/fetch_ref.py`（既定で同ピン）

### 1.5 過去レビューで潰された領域（再発防止・現状確認）

履歴上少なくとも次が Blocker/Major として扱われ修正済み。**現状も真に解消されているか**を確認するが、チェックリスト消化だけで終了しない。

| 領域 | 期待（pinned 相当 / 親方針） | 現状コードの手掛かり |
| --- | --- | --- |
| Probe FIFO | ACK 成功ではなく **send-fill（minBytes ∧ minPackets）** で次 cluster | `ProbeController` + tests `probe fill 完了で ACK を待たず…` |
| 80% ACK | pacing 早期終了しない / 80% 後も estimate 再計算 | `resultAccepted` + tests |
| 3x→6x FIFO | multi-active 禁止、front のみ pacing | tests `initial probe は front=3x のみ` |
| initial 全失敗 | complete 後 recovery 可能 | tests |
| timeout 分離 | pacing ≈5s / result-wait ≈1s / estimator history 独立 | `kProbePacingTimeoutMs` / `kProbeResultTimeoutMs` / `estimatorHistory` |
| lower probe result | 無視しない + acked×0.85 floor | `kProbeDropThroughputFraction` |
| mid-cluster abort | congestion で active probe を abort **しない** | tests `congestion feedback は active probe を abort しない` |
| probe 適用 | AIMD/Loss full `reset` ではなく `setEstimate` / `setBandwidthEstimate` | tests + `gccBwe.ts` |
| acked bitrate | 単純 1s 窓ではなく RobustThroughputEstimator defaults | `AcknowledgedBitrateEstimator` |
| ordering | loss=seq 順、delay/acked/probe=receive-time 順 | `gccBwe.receiveTWCC` |
| soft loss | not-received 永久 finalize 禁止、重複 soft-loss 二重計上禁止 | `softLostSeqs` + tests |
| TWCC wrap | 16-bit seq / 24-bit reference_time unwrap | `TwccReferenceTimeUnwrapper` + tests |
| probe padding | RFC3550 padding・SRTP・octetCount 非算入・seq 衝突防止 | `rtpSender` + tests |

---

## 2. 実装すべき具体的な機能や変更内容

本タスクの「実装」は **新機能追加が主目的ではない**。以下のサイクルを自律実行する。

### 2.1 必須作業フロー

1. **Source of truth 読了**  
   - 親チケット全文（特に §5 完了条件・非ゴール）  
   - 本チケット全文  
   - `GCC_KNOWN_DIFFERENCES` + `estimators/gcc/**`  
   - `third_party/libwebrtc-ref/PIN.json` と必須 .cc/.h（§3.3）  
2. **既知問題の現状確認**（§2.2）— 修正だけで完了としない  
3. **subsystem 網羅探索**（§2.3）— 固定 pin と比較  
4. **Probe state gating 表の作成**（§2.4）— 差異は正当化できない限り修正  
5. **問題ごとに**  
   - 修正前に落ちる最小 regression（可能な限り public/full-path）  
   - root-cause 修正  
   - 周囲を最低 1 段広くレビュー（例: ProbeController → ProbeBitrateEstimator 相当 → GccBandwidthEstimator → RTCRtpSender pacing）  
6. **targeted test → package type → 広い validation → sim**  
7. **develop 差分確認**（behind なら影響評価・必要なら取り込み後再 CI）  
8. **docs 同期**（Known Differences / JSDoc / sim README / 本チケット）  
9. **self-review pass 最低 1 回**（実装者前提を捨てる）。問題があれば 5〜8 を繰り返す  

### 2.2 既知問題（最初に確認する領域）

#### Probe lifetime / cleanup

| 確認項目 | 期待 |
| --- | --- |
| mid-cluster abort | active probe を partial TWCC の loss / overuse **だけで** abort しない |
| pacing vs result-wait | 寿命が独立（pacing timeout ≠ result-wait timeout） |
| controller vs estimator history | ProbeController result-wait timeout と ProbeBitrateEstimator measurement history が **分離** |
| late TWCC | controller timeout 後も合理期間は probe result を生成できる |
| bounded memory | estimator history / seq mapping が無期限に残らない |
| no/zero/partial cluster | zero-packet / no-feedback / partial-feedback でも memory 回収 |
| exact-max | initial / further / recovery の exact-max（`>= max`）が pin と一致 |
| 80% 後 refinement | 80% 成立後も残り ACK で estimator 更新可能 |
| lower-result guard | pin の `limit_probes_lower_than_throughput_estimate`（acked×0.85 floor）と一致 |

#### Probe state gating（必須比較表）

次の各状態について、固定 pin と werift で **新規 / further / recovery / upward result 適用 / downward result 適用** を表にして比較する（§2.4 テンプレ）。

| Delay / その他 | Loss / その他 |
| --- | --- |
| `normal` | loss `decreasing` |
| `underuse` | loss `increasing` |
| `overuse` | loss `hold`（または hold-while-decreasing） |
| delay-based limited | RTT limited（pin: `kRttBasedBackOffHighRtt`） |
| | loss `delay_based` / `kDelayBasedEstimate` |

**特に禁止パターン:**

```ts
const congested = usage === "overuse"; // 複数 state を 1 bit に潰す
```

libwebrtc では `GetBandwidthLimitedCause` が delay usage / RTT / loss state を **別 cause** に写像し、`ProbeController::InitiateProbing` が cause ごとに「禁止」と「cap 付き許可」を分ける。1 つの boolean で underuse・overuse・loss decreasing・RTT high を同一扱いしていないか確認する。

追跡対象の連携（ピンローカル）:

| libwebrtc | ローカルパス |
| --- | --- |
| `GetBandwidthLimitedCause` | `goog_cc_network_control.cc` |
| `ProbeController::InitiateProbing` | `probe_controller.cc` |
| `ProbeController::SetEstimatedBitrate` | 同上 |
| `ProbeController::RequestProbe` | 同上 |
| `DelayBasedBwe` | `delay_based_bwe.{h,cc}` |
| `GoogCcNetworkController` | `goog_cc_network_control.{h,cc}` |

#### 調査時点の werift 実装メモ（要再検証・確定ではない）

コード調査時点の `gccBwe.ts` は概ね次:

| 項目 | 現状（要 pin 突合） |
| --- | --- |
| 新規 further/recovery | `usage === "normal"` かつ loss ∈ `{increasing, delay_based}` |
| upward probe result | `usage !== "overuse"` のとき適用 |
| downward probe result | overuse 中も acked×0.85 floor 付きで適用 |
| recovery トリガ | `underuse → normal` かつ probeState `complete` かつ `allowNewProbe` |
| mid-abort | しない（KNOWN + tests） |
| RTT limited | **AIMD 用 RTT proxy はあるが、`kRttBasedBackOffHighRtt` 相当の probe 禁止は未実装の可能性** — 要突合 |
| loss `increasing` | pin は `kLossLimitedBweIncreasing` で **max probe bitrate を scale cap**。werift が cap 無しなら意味論差 |

**これらが「実装済みだから完了」ではない。** 表で pin と突き合わせ、差があれば修正または厳格な Known Diff 正当化。

### 2.3 既知問題以外の自律探索（subsystem 必須カバレッジ）

コードを subsystem 単位で固定 pin と比較する。**最低限すべて**レビュー対象。

#### Feedback preprocessing

- TWCC sequence unwrap / 16-bit wrap  
- reference time unwrap / 24-bit wrap  
- receive-time ordering / send-time ordering  
- duplicate feedback / overlapping feedback  
- late loss correction / soft loss / unknown sequence  

参照: `gccBwe.ts`, `sequenceNumber.ts`, `twccReferenceTime.ts`, `receiverTwcc.ts`, `packages/rtp/.../twcc.ts`  
pin: `transport_feedback_adapter.*` 等

#### Acknowledged bitrate

- RobustThroughputEstimator default（window/required/min-max duration）  
- receive gap replacement  
- send/receive rate calculation  
- reorder / stale packet  
- ALR / `prior_unacked_data` 省略の影響  

参照: `acknowledgedBitrateEstimator.ts`  
pin: `robust_throughput_estimator.*`, `acknowledged_bitrate_estimator.*`, `bitrate_estimator.*`

#### Delay-based BWE

- InterArrivalDelta  
- TrendlineEstimator  
- overuse / underuse / normal  
- stream timeout / reordered packet  
- AIMD state / RTT / TimeToReduceFurther  
- probe result application / SetEstimate 時の state preservation  

参照: `interArrivalDelta.ts`, `trendlineEstimator.ts`, `aimdRateControl.ts`, `overuseDetector.ts`（runtime 未使用クラスの整理可否）  
pin: 同名 goog_cc / `aimd_rate_control.*`

#### Loss-based BWE

- observation window / partial observation / loss correction / byte loss  
- HOLD / decreasing / increasing / delay_based 遷移  
- delayed increase / inherent loss / candidate bounds  
- probe result 適用時の history preservation  

参照: `lossBasedBwe.ts`  
pin: `loss_based_bwe_v2.*`（本ピンに V1 は存在しない）

#### ProbeController / ProbeBitrateEstimator

- initial exponential / FIFO / pacing / send-fill / result wait  
- estimator history / recovery / further / exact max  
- loss/delay gating / cooldown / timeout / late ACK  
- cleanup / sequence ownership / result refinement  

参照: `probeController.ts`（上流 3 分割を 1 クラスに統合）  
pin: `probe_controller.*`, `probe_bitrate_estimator.*`, `modules/pacing/bitrate_prober.*`

#### Sender integration

- media / padding の RTP sequence と transport-wide sequence  
- reorder / retransmission / RTP cache  
- padding accounting / SR packet·octet counters  
- async padding injection  
- estimator reset / reuse / event firing / disposal  

参照: `rtpSender.ts`, `bandwidthEstimator.ts`

### 2.4 状態遷移テーブル（修正前または並行で作成・最終報告に添付）

最低限 Probe 周辺について、固定 pin と werift を埋める。

#### 2.4.1 libwebrtc `GetBandwidthLimitedCause` → `InitiateProbing`（ピン根拠）

`goog_cc_network_control.cc` / `probe_controller.cc`（commit `0fda1615…`）より:

| Delay usage | RTT high? | LossBasedState | Cause | InitiateProbing |
| --- | --- | --- | --- | --- |
| overuse | * | * | `kDelayBasedLimitedDelayIncreased` | **禁止**（空 vector） |
| underuse | * | * | 同上 | **禁止** |
| normal | yes | * | `kRttBasedBackOffHighRtt` | **禁止** |
| normal | no | `kDecreasing` | `kLossLimitedBwe` | **禁止** |
| normal | no | `kIncreaseUsingPadding` | `kLossLimitedBwe` | **禁止** |
| normal | no | `kIncreasing` | `kLossLimitedBweIncreasing` | **許可**（`max_probe_bitrate` を `estimated × loss_limited_probe_scale` で cap） |
| normal | no | `kDelayBasedEstimate` | `kDelayBasedLimited` | **許可**（追加 cap なし） |

RequestProbe（recovery）も同一 `bandwidth_limited_cause_` と cooldown / estimate 条件に依存。SetEstimatedBitrate の further も cause を渡す。

#### 2.4.2 実装エージェントが埋める比較表（必須成果物）

| Delay state | Loss state | Controller state | libwebrtc action | werift action | Match | 備考 |
| --- | --- | --- | --- | --- | --- | --- |
| normal | delay_based | complete | recovery allowed（他条件満了時） | | | |
| underuse | delay_based | complete | no new probe | | | |
| overuse | delay_based | complete | no new probe | | | |
| normal | decreasing | complete | no probe | | | |
| normal | increasing | complete | capped probe | | | scale 一致? |
| normal | hold / hold-while-decreasing | * | no probe | | | state 名差の有無 |
| overuse | * | waiting_for_result | no mid-abort; upward result ignore; lower result floor | | | |
| normal | * | waiting_for_result + late TWCC after timeout | estimator history で result 可 | | | |
| * | * | RTT limited | no probe | | | werift 未実装なら差 |

差異が見つかったら、意図的差異として正当化できない限り **修正**する。

### 2.5 特に探索すべきバグパターン

grep ではなく **実際の state transition を追って**検証する。

#### Clock domain

同一変数・timeout・比較に次が混在していないか:

- sender wall clock（`milliTime` / `sendingAtMs`）  
- TWCC receiver timeline（`receivedAtMs` / unwrapped reference）  
- RTP send timestamp  
- feedback arrival time  

現状コメント上の役割分担（要検証）:

| 用途 | 期待 clock |
| --- | --- |
| pacing / result-wait timeout / cooldown / process | sender clock |
| ProbeBitrateEstimator history prune（receive horizon） | receive timeline |
| no-ACK の有界寿命 | sender-side age（`kSentInfoMaxAgeMs`） |
| rate math（send/recv interval） | cluster 内 send/recv 時刻 |
| AIMD RTT proxy | feedback arrival − last send（Known Diff 候補） |

#### Lifetime coupling

本来独立:

1. sender packet history（`sentInfos`）  
2. ProbeController session（pacing / awaitingResults / queue / state）  
3. BitrateProber pacing（active cluster のみ）  
4. ProbeBitrateEstimator measurement history（`estimatorHistory` + seq maps）  

寿命が一つの map / timeout に再結合されていないか。

#### Premature cleanup

- controller 結果待ち終了だけで estimator data を削除していないか  
- 80% result で残り 20% を捨てていないか  
- partial feedback で cluster を捨てていないか  

#### Missing cleanup

- no ACK / zero send / partial send / never reported / network loss / repeated recovery で map が永久保持されないか  
- 長時間接続で **有界メモリ**  

#### State collapsing

libwebrtc で別意味の状態を `congested` / `loss limited` の 1 bit にまとめた結果、probe permission や rate-control が変わっていないか。

#### Known Differences misuse

「Known に書いてあるから許容」は禁止。各差分について:

1. チケット上許容される理由があるか  
2. pure TypeScript 制約上不可避か  
3. 主要な control response を変えないか  

意味論的に合わせられるものは合わせる。残す場合は文面と実コードを一致させる。

### 2.6 テスト方針

- 問題修正時は **再現 regression を先に、または同時に**追加  
- private field 直書きだけのテストは不十分  
- 可能な限り public/full-path:

```text
RTP sent → pacing → TWCC feedback → estimator
  → state transition → available bitrate / next probe
```

#### 最低限維持・不足なら追加するケース

**Probe state**

- underuse 中は新規/further 開始されない  
- underuse → normal で recovery 可能  
- overuse 中は upward result 非適用  
- lower valid result は guard 付き適用  
- loss decreasing/hold 中は probe 開始しない  
- loss increasing の behavior が pin と対応（**cap の有無を含む**）  

**Lifetime**

- controller timeout 後も late TWCC result  
- controller timeout で further session が不当に再開しない  
- receive-time horizon 超過で estimator cluster prune  
- no-ACK cluster が sender-side finite lifetime 後に消える  
- zero-packet pacing timeout が history leak を作らない  
- repeated recovery 多数回でも map/history size bounded  

**Boundary**

- `== max` / `== timeout` / `timeout + 1`  
- 79% / 80% / 100% ACK  
- sequence `65535 → 0`  
- TWCC reference time wrap  
- exact loss thresholds / exact state transition threshold  

規約: Arrange / Act / Assert、共有 Arrange は utility 化、Act/Assert に日本語コメント。

### 2.7 修正時の成果物

- root-cause 修正パッチ（テスト握りつぶし禁止）  
- 失敗→成功を示す regression  
- 必要なら `GCC_KNOWN_DIFFERENCES` / JSDoc / simulations README / 本チケット同期  
- 意図的差分の増減は **理由付き**（安易な追加禁止）  
- 最終報告（§5.3）  

### 2.8 非ゴール

- 親チケットの再設計（interface 契約の大幅変更、default を GCC に切替 等）  
- NADA / SCReAM 等の第三アルゴリズム  
- C++ バインディング / ネイティブ addon  
- REMB 統合の必須化  
- Chrome と bit 完全一致の保証  
- sim の CI 必須化  
- 単なる好み・大規模リファクタ・チケット外改善の無制限スコープ拡大  

スコープ内で新問題を発見したら **ユーザー確認を待たず自律修正**する。

### 2.9 develop との差分

最終段階で最新 `develop` との差分を確認する。

- behind なら develop の変更内容を確認し、競合・回帰・依存影響を評価  
- 取り込みが必要なら取り込み、**取り込み後に再度 CI / relevant tests**  
- force-push や無関係ファイル改変は避ける  

調査時点メモ: 本 worktree は親 GCC 実装の積み上げブランチ上。作業中に `git rev-list develop...HEAD` で ahead/behind を再確認すること。

### 2.10 ドキュメント

コード修正後、次が実装と一致していること:

- `GCC_KNOWN_DIFFERENCES`（`constants.ts`；doc 再生成が必要なら `npm run doc` はルート方針に従う）  
- API docs / ProbeController コメント / simulation docs  
- 親・本チケット Markdown  

生成ツールやエージェント由来の説明文など、チケット本文ではない文章が accidentally committed されていないかも確認。

---

## 3. 技術的な実装アプローチ（調査結果の要約）

### 3.1 アーキテクチャ（現状）

```text
RTP send (RTCRtpSender)
  ├─ transport-wide seq (RTCDtlsTransport)  … transport 共有
  ├─ optional probe padding / token-bucket pacing (ProbePacingController)
  └─ BandwidthEstimator.rtpPacketSent(SentInfo)

Remote ReceiverTWCC → RTCP TransportWideCC
  └─ RTCRtpSender.handleRtcpPacket → estimator.receiveTWCC

GccBandwidthEstimator.receiveTWCC
  ├─ TwccReferenceTimeUnwrapper
  ├─ sort by wideSeq → loss / soft-loss path
  ├─ sort by receive time → delay / acked / probe ACK
  ├─ InterArrivalDelta → TrendlineEstimator (usage)
  ├─ AimdRateControl (delay-based)
  ├─ LossBasedBwe (loss-based V2-ish)
  ├─ ProbeController (result apply + further/recovery gating)
  └─ target = min(delay, loss) ± probe → setAvailableBitrateIfChanged
```

差し替え: `setBandwidthEstimator(impl)` が正式 API。具象は public export。

### 3.2 モジュール対応表（werift ↔ 固定 pin）

| werift | libwebrtc（pin） | 備考 |
| --- | --- | --- |
| `gccBwe.ts` | `goog_cc_network_control` / 合成部 | cause 導出・probe 適用・結合 |
| `interArrivalDelta.ts` | `inter_arrival_delta.*` | group latest send delta、reorder reset |
| `trendlineEstimator.ts` | `trendline_estimator.*` | Detect 内包 |
| `overuseDetector.ts` | 歴史的 Detect | **runtime dead class**（型 `BandwidthUsage` のみ）— 整理候補 |
| `aimdRateControl.ts` | `remote_bitrate_estimator/aimd_rate_control.*` | TimeToReduceFurther、β=0.85 |
| `lossBasedBwe.ts` | `loss_based_bwe_v2.*` | V1 は本ピンに無し |
| `probeController.ts` | `probe_controller` + `probe_bitrate_estimator` + `bitrate_prober` | 単一クラス統合 |
| `acknowledgedBitrateEstimator.ts` | `robust_throughput_estimator` (+ interface) | Bayesian は utility |
| `rtpSender` pacing/padding | `PacedSender` / BitrateProber | token-bucket 代替（Known Diff） |
| TWCC 配線 | `transport_feedback_{adapter,demuxer}.*` | |

ローカル接頭辞: `third_party/libwebrtc-ref/`。

### 3.3 必須読了（ローカル pin）

- `modules/congestion_controller/goog_cc/goog_cc_network_control.{h,cc}`  
- `modules/congestion_controller/goog_cc/delay_based_bwe.{h,cc}`  
- `modules/congestion_controller/goog_cc/inter_arrival_delta.{h,cc}`  
- `modules/congestion_controller/goog_cc/trendline_estimator.{h,cc}`  
- `modules/remote_bitrate_estimator/aimd_rate_control.{h,cc}`  
- `modules/congestion_controller/goog_cc/acknowledged_bitrate_estimator*.{h,cc}`  
- `modules/congestion_controller/goog_cc/bitrate_estimator.{h,cc}`  
- `modules/congestion_controller/goog_cc/robust_throughput_estimator.{h,cc}`  
- `modules/congestion_controller/goog_cc/loss_based_bwe_v2.{h,cc}`  
- `modules/congestion_controller/goog_cc/probe_controller.{h,cc}`  
- `modules/congestion_controller/goog_cc/probe_bitrate_estimator.{h,cc}`  
- `modules/pacing/bitrate_prober.{h,cc}`  
- `modules/congestion_controller/rtp/transport_feedback_{adapter,demuxer}.{h,cc}`  

### 3.4 差分判断順

1. 親チケットの明示的非目標・制約か  
2. pure TypeScript で実用的に寄せられるか  
3. bitrate 収束・安定性・相互運用への影響があるか  
4. 実装方式の差か、アルゴリズム意味論の差か  

**意味論に影響する差は原則修正。** Known Differences に残してよいのは、チケット許容・実運用影響が小さい・主要制御を変えないものに限定。

### 3.5 調査時点の Known Differences（実装と一致要確認）

`GCC_KNOWN_DIFFERENCES`（要約）:

| # | 内容 | 許容の論点 |
| --- | --- | --- |
| 1 | LossBasedBweV2: byte-loss / HOLD / instant bounds 等。ALR/padding 状態機械は `IncreaseUsingPadding` を increasing に畳み込み | padding path 未使用なら control 影響小か要検証 |
| 2 | No REMB（親非ゴール） | OK |
| 3 | Probe: token-bucket + padding、FIFO send-fill、lifetime 分離、no mid-abort、gating 文面 | **文面とコードの一致・loss increasing cap の有無を要検証** |
| 4 | AIMD: RTT proxy、probe accept は setEstimate | RTT 精度は Known 候補として妥当か再確認 |
| 5 | RobustThroughput; prior_unacked/ALR 省略 | media-only TWCC 前提 |
| 6 | TWCC 24-bit unwrap; ReceiverTWCC late-reorder 窓 | プロトコル都合 |
| 7 | FP / wall-clock の sub-bps drift | OK |
| 8 | InterArrival: system-clock path 省略 | TWCC-only なら OK |
| 9 | transport-wide 共有 vs per-sender BWE | 親制約・意図的 |
| 10 | OveruseDetector dead class | 整理 or 正当化 |

### 3.6 推奨作業順（実装エージェント向け）

1. 親 MD + GCC 一式 + Known Diff + 主要テスト + `PIN.json` を読む  
2. §2.4 の gating 表を pin から埋め、werift `gccBwe` / `probeController` / `lossBasedBwe` を埋める  
3. 差異（特に RTT limited・loss increasing cap・state collapsing）を優先修正 + regression  
4. lifetime / clock / cleanup を横断監査  
5. Feedback / acked / delay / loss / sender を subsystem 監査  
6. 発見ごとに regression → fix → 既存 BWE テスト全通し  
7. type / test:small or ci / sim / 可能なら e2e sim  
8. develop 差分  
9. docs 同期  
10. self-review（§4.4）→ Blocker/Major 0 まで繰り返し  

### 3.7 必読ファイル一覧

1. `TICKET-ticket-c724daf9-5f79-4e30-bd50-7b27c8951844.md`  
2. 本ファイル `TICKET-ticket-4fa9e286-abac-417c-8b36-347b071e3990.md`  
3. `packages/webrtc/src/media/sender/bandwidthEstimator.ts`  
4. `packages/webrtc/src/media/sender/estimators/gcc/**`  
5. `packages/webrtc/src/media/sender/estimators/legacyCumulativeBwe.ts`  
6. `packages/webrtc/src/media/sender/estimators/twccReferenceTime.ts` / `twccReceiveTiming.ts`  
7. `packages/webrtc/src/media/rtpSender.ts`  
8. `packages/webrtc/src/media/receiver/receiverTwcc.ts`  
9. `packages/rtp/src/rtcp/rtpfb/twcc.ts`  
10. `packages/webrtc/tests/media/bandwidthEstimator.test.ts`  
11. `packages/webrtc/tests/media/receiverTwcc.test.ts`  
12. `packages/webrtc/simulations/**`  
13. `e2e/simulations/**`  
14. `GCC_KNOWN_DIFFERENCES`（`constants.ts`）  
15. examples: `examples/mediachannel/simulcast/abr.ts`, `examples/mediachannel/twcc/offer.ts`  
16. **`third_party/libwebrtc-ref/`**  

外部仕様:

- TWCC: https://datatracker.ietf.org/doc/html/draft-holmer-rmcat-transport-wide-cc-extensions-01  
- GCC: https://datatracker.ietf.org/doc/html/draft-ietf-rmcat-gcc-02  
- libwebrtc pin: https://webrtc.googlesource.com/src/+/0fda16159e33adf59c71a7ad1173dcbe5a632102/  

---

## 4. 考慮すべき制約や注意点

1. **プロトコルとアルゴリズムを混同しない**  
   TWCC は feedback。Receiver を GCC 専用に作り替えない（dumb receiver 維持。ロス報告の正しさは必要）。

2. **後方互換**  
   default=legacy、`senderBWE` 名、`onAvailableBitrate`（bps・変化時のみ）、legacy `onCongestion*` を壊さない。共通 interface に congestion / overuse / probe API を載せない。

3. **pure TypeScript**  
   ネイティブ依存を足さない。`third_party/libwebrtc-ref` は **参照専用**（ビルド・ランタイムにリンクしない）。

4. **libwebrtc 版を混ぜない**  
   突合はピン `0fda1615…` のみ。未ピン main や古いミラーを根拠にしない。

5. **単位**  
   bitrate は bps。時刻は ms。TWCC 相対時刻と壁時計を混在させない。

6. **transport-wide 共有 vs sender 単位 BWE**  
   親チケット制約。multi-sender 非対称は意図的だが、誤配線による二重計上はバグ。

7. **パフォーマンス / メモリ**  
   `sentInfos` / finalize / softLost / probe seq maps の有限窓。長時間で unbounded growth 禁止。

8. **テスト規約**  
   失敗握りつぶし禁止。「前回指摘だけ通す」特殊 case 実装を避ける。

9. **sim は CI 対象外**  
   落とさない・必須 CI に入れない。明示実行で回帰確認。実行不能なら **理由と未確認範囲を報告に明記**（黙って完了扱い禁止）。

10. **手動試験を unit に置き換えただけで完了扱いにしない**  
    親が求める sim / interop / bottleneck / loss / delay は実施する。

11. **Windows 非対応**  
    Unix 系前提を増やさない。

12. **コミット**  
    実装完了後は対象ブランチにコミット（運用に従う）。force-push や無関係改変は避ける。

### 4.4 self-review で必ず問い直すこと

修正一巡後、別 reviewer として `develop...HEAD`（または作業 diff）を読み直す。

- この修正で別 state に probe を許可してしまっていないか  
- cleanup 遅延で leak を作っていないか / 追加 cleanup で late feedback を早く捨てていないか  
- sender clock と receiver timeline を混ぜていないか  
- controller と estimator の lifetime を再結合していないか  
- max / threshold の `>` と `>=` は固定 pin と一致しているか  
- Known Differences 文面と実コードは一致しているか  
- docs が古い挙動を説明していないか  
- テストが実装詳細追認だけで pass していないか  
- 1 fix の周囲を 1 段広く見たか  

**追加問題を探すだけの pass を最低 1 回。** 見つかれば修正して再実施。

### 4.5 完了と宣言してはいけない残存条件

次のいずれかが残っている場合、作業完了と宣言しない:

- Blocker / Major  
- 説明不能な pinned libwebrtc state-transition 差異  
- unbounded memory growth  
- clock-domain bug  
- premature cleanup  
- controller / estimator lifetime coupling  
- Known Differences と実装の不一致  
- 必須 regression 不足  
- 必須 CI / simulation 失敗  
- 親チケット完了条件の未達  

---

## 5. 完了条件

以下を **すべて**満たすまで完了としない。親チケット acceptance も同時に満たすこと（縮小禁止）。

### 5.1 親チケット回帰（必須）

- [ ] 帯域推定が interface として定義され、共通契約は TWCC I/O + `availableBitrate` / `onAvailableBitrate` のみ  
- [ ] 現行（legacy）がデフォルトで実用上同等、`onCongestion*` は具象維持  
- [ ] GCC が delay / loss / probe で推定更新、固有状態は具象側  
- [ ] GCC が draft + **pinned libwebrtc** に可能な限り最大互換（既知差分は文書化かつ正当）  
- [ ] 推定帯域 **変動時**に bps 通知（変化時のみが望ましい）  
- [ ] `setBandwidthEstimator` による差し替えが動作し docs/example で分かる  
- [ ] 単体テスト（legacy / GCC / setter / overuse·loss·probe 応答）が有効  
- [ ] examples（`abr.ts` / `twcc/offer.ts`）が破綻しない  

### 5.2 本タスク固有のレビュー・品質

- [ ] **ピン済み** libwebrtc（`third_party/libwebrtc-ref` / `0fda1615…`）との差分を **体系的に**確認済み（§2.2 / §2.3 / §3.2）  
- [ ] §2.4 の state transition 比較表を作成し、説明不能差が 0  
- [ ] 既知 Blocker 領域が再発していない  
- [ ] 自律探索で見つけた問題を修正（発見ゼロなら調査内容と「差がない」根拠を報告）  
- [ ] 各修正に修正前失敗の regression（可能な限り full-path）  
- [ ] state-preserving であるべき更新で不必要な full reset をしていない（または正当化済み）  
- [ ] packet reorder / loss / late feedback / wrap / probe 経路テストが有効  
- [ ] lifetime: late TWCC 可能かつ history 有界  
- [ ] clock domain 混在バグなし  
- [ ] `GCC_KNOWN_DIFFERENCES` と実装・コメントが一致（隠蔽用途なし）  
- [ ] docs / sim README / チケットが実装と一致  
- [ ] 最終 self-review: **Blocker 0 / Major 0**（Minor は合理修正可能なものを残さない）  

### 5.3 検証コマンド

| 優先 | コマンド | 備考 |
| --- | --- | --- |
| 必須 | `cd packages/webrtc && npx vitest run tests/media/bandwidthEstimator.test.ts` | 触った近傍テストも |
| 必須 | `cd packages/webrtc && npm run type` | |
| 必須（範囲に応じ） | ルート `npm run test:small` または `npm run ci` | クロスパッケージなら ci |
| 必須（可能なら） | `cd packages/webrtc && npm run test:sim` | peer bottleneck/loss/delay。失敗時は原因調査→修正→再実行 |
| 必須（可能なら） | `cd e2e && npm run test:sim` | ブラウザ依存。**環境失敗とコード失敗を区別**し、未実施なら理由明記 |
| 任意・近傍 | `cd packages/webrtc && npx vitest run tests/media/receiverTwcc.test.ts` | TWCC 変更時 |

失敗時は原因調査 → 修正 → **同じコマンド再実行**を成功まで繰り返す。

### 5.4 最終報告フォーマット（実装エージェントの出力）

1. **発見した問題一覧**（Blocker / Major / Minor、原因、固定 pin との違い）  
2. **実施した修正**  
3. **追加した regression tests**  
4. **固定 pin と比較した主要 state transition の最終結果**（§2.4 表の完成版）  
5. **CI / simulation / interoperability の実行結果**（未実施は理由・未確認範囲）  
6. **Known Differences として残した差異と許容理由**  
7. **最終 self-review**（Blocker: 0 / Major: 0 / Minor: N）  
8. **完了条件チェックリスト**（§5.1–5.3）  

**Blocker または Major が 1 件でも残っている場合は「実装完了」と報告しない。**

---

## 6. 親チケット完了条件チェックリスト（縮小禁止・再掲）

作業終了時に親 §5 もすべて満たしていること。詳細は `TICKET-ticket-c724daf9-5f79-4e30-bd50-7b27c8951844.md` を正とする。

### 機能

- [ ] interface + 共通は推奨帯域のみ  
- [ ] legacy デフォルト互換  
- [ ] GCC delay/loss/probe  
- [ ] 最大互換 + 既知差分文書化  
- [ ] onAvailableBitrate 変動通知（bps）  
- [ ] setBandwidthEstimator  

### 品質

- [ ] 単体テスト（発火条件含む）  
- [ ] setter 配送テスト  
- [ ] GCC 制御応答 / 可能なら決定的系列  
- [ ] 意図的差分一覧  
- [ ] type + 関連テスト  
- [ ] examples 破綻なし  
- [ ] 破壊的変更時の移行手順（なければデフォルト互換確認）  

### 非ゴール（必須にしない）

- 第三アルゴリズム、C++ リンク、bit 完全一致、エンコーダ強制、REMB 全面置換、Receiver 刷新  

---

## 決定事項

| 項目 | 決定 |
| --- | --- |
| 本タスクの性質 | 再実装ではなく **自律レビュー・探索・修正・完成** |
| libwebrtc 根拠 | `third_party/libwebrtc-ref` ピン `0fda16159e33adf59c71a7ad1173dcbe5a632102` のみ |
| 品質バー | Blocker 0 / Major 0。説明不能 state 差 0。Known Diff 悪用禁止 |
| 完了条件 | 親 AC + 本チケット §5 の両方（縮小禁止） |
| 修正方針 | スコープ内問題は確認待ちせず自律修正。スコープ外リファクタはしない |
| sim | CI 外だが完了前に可能なら実行。不可なら理由明記 |
