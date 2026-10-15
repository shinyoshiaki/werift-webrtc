---
ide:
  viewer: review-document
  version: 1
  title: "PeerConnection negotiation transaction の実装解説"
  dock: right
  baseCommit: 1a2dd102a2eacaebb5b979ce3e8475470fc0f967
---
# PeerConnection negotiation transaction の実装解説

## 1. 概要

`RTCPeerConnection` の再交渉（offer / pranswer / answer / rollback / replacement、ICE restart、BUNDLE、SCTP、trickle ICE、非対応 m-line の拒否）を、個別の補修ではなく **1 つの transaction** として扱うように作り直しました。守る不変条件は次の 1 つです。

> 最終 answer の適用だけが negotiated state の commit 境界であり、それまでの pending negotiation は通信中の current session を壊さない。rollback 後の current session も通信できる。

設計の正は設計文書です。遷移表（current / pending / rollback baseline / speculative side effect）、各 subsystem の mutation matrix、ルーティングキーの規則、生成済み description の再利用契約、pending 中に有効な値の表、develop との挙動差の棚卸し、コード構成、対象外の範囲を定義しています。チケットの各文と試験の対応表も置いています。

- 遷移表: [packages/webrtc/NEGOTIATION_TRANSACTION.md:197](review-file:packages/webrtc/NEGOTIATION_TRANSACTION.md:197)
- mutation matrix: [packages/webrtc/NEGOTIATION_TRANSACTION.md:208](review-file:packages/webrtc/NEGOTIATION_TRANSACTION.md:208)
- ルーティングキーの規則: [packages/webrtc/NEGOTIATION_TRANSACTION.md:352](review-file:packages/webrtc/NEGOTIATION_TRANSACTION.md:352)
- コード構成と、状態の snapshot の持ち主: [packages/webrtc/NEGOTIATION_TRANSACTION.md:469](review-file:packages/webrtc/NEGOTIATION_TRANSACTION.md:469)
- 生成済み description の再利用契約: [packages/webrtc/NEGOTIATION_TRANSACTION.md:122](review-file:packages/webrtc/NEGOTIATION_TRANSACTION.md:122)
- pending 中に有効な値の表: [packages/webrtc/NEGOTIATION_TRANSACTION.md:501](review-file:packages/webrtc/NEGOTIATION_TRANSACTION.md:501)
- 拒否された application m-line: [packages/webrtc/NEGOTIATION_TRANSACTION.md:779](review-file:packages/webrtc/NEGOTIATION_TRANSACTION.md:779)
- 操作の連鎖・接続の開始・探索の軸: [packages/webrtc/NEGOTIATION_TRANSACTION.md:820](review-file:packages/webrtc/NEGOTIATION_TRANSACTION.md:820)
- develop との挙動差の棚卸し: [packages/webrtc/NEGOTIATION_TRANSACTION.md:874](review-file:packages/webrtc/NEGOTIATION_TRANSACTION.md:874)
- 対象外・既知の制約: [packages/webrtc/NEGOTIATION_TRANSACTION.md:902](review-file:packages/webrtc/NEGOTIATION_TRANSACTION.md:902)
- 仕様と試験の対応表（チケットの全 276 文）: [packages/webrtc/NEGOTIATION_SPEC_COVERAGE.md](review-file:packages/webrtc/NEGOTIATION_SPEC_COVERAGE.md)
- チケット: [TICKET-support-fallback-state.md](review-file:TICKET-support-fallback-state.md)（同じ内容を [TICKET-ticket-0ad06d37-d829-4a08-8e49-2da46e551b79.md](review-file:TICKET-ticket-0ad06d37-d829-4a08-8e49-2da46e551b79.md) にも置いています）

変更規模は、最新の develop との merge base（`71b6ddbf`）から `packages/` で 68 ファイル（+28,052 / −1,726）です。うち `webrtc` と `ice` の `src` が 26 ファイル（+7,271 / −1,698）で、残りは主にテストと探索ツールです。公開 API の値は増やしていません（追加したのは内部用の型とフィールドだけです。4 章を参照）。

## 2. 主要変更

### 2.1 transaction coordinator（baseline / checkpoint / commit / rollback）

`NegotiationTransaction` が、交渉で変わる状態の baseline と、提案が作った資源を 1 か所で所有します（[packages/webrtc/src/negotiationTransaction.ts:87](review-file:packages/webrtc/src/negotiationTransaction.ts:87)）。

- transaction の開始（`createOffer` が取った snapshot を baseline に使う）: [packages/webrtc/src/negotiationTransaction.ts:147](review-file:packages/webrtc/src/negotiationTransaction.ts:147)
- commit（staged route / receive 値の切替、置換された transceiver と使われない transport の停止）: [packages/webrtc/src/negotiationTransaction.ts:179](review-file:packages/webrtc/src/negotiationTransaction.ts:179)
- replacement（baseline を残したまま戻す）と rollback: [packages/webrtc/src/negotiationTransaction.ts:239](review-file:packages/webrtc/src/negotiationTransaction.ts:239)
- 1 回の操作の途中失敗を、その操作の分だけ戻す checkpoint: [packages/webrtc/src/negotiationTransaction.ts:279](review-file:packages/webrtc/src/negotiationTransaction.ts:279)
- 復元処理（各コンポーネントの restore を順に呼び、使われなくなった transport を止める）: [packages/webrtc/src/negotiationTransaction.ts:440](review-file:packages/webrtc/src/negotiationTransaction.ts:440)

**状態の snapshot は、その状態を持つコンポーネントが自分で取り、自分で戻します。** transaction は、それらを組み合わせるだけです。新しい状態を足すときは、そのコンポーネントの snapshot / restore の組だけを直せば済みます。rollback で特別に残す規則も、それぞれの持ち主に置いています。

| コンポーネント | snapshot / restore | rollback 後も残す規則 |
| --- | --- | --- |
| transceiver（sender・receiver を含む） | [packages/webrtc/src/media/rtpTransceiver.ts:180](review-file:packages/webrtc/src/media/rtpTransceiver.ts:180) | transaction 中にアプリが呼んだ `stop()` |
| receiver | [packages/webrtc/src/media/rtpReceiver.ts:248](review-file:packages/webrtc/src/media/rtpReceiver.ts:248) | RID パケットから学習した SSRC（その track が残る場合） |
| transceiver 群（並び順、track 通知、提案が作った transceiver の除去） | [packages/webrtc/src/transceiverManager.ts:133](review-file:packages/webrtc/src/transceiverManager.ts:133) | remote offer が作った transceiver は、sender に track があるときだけ残す（develop と同じ。`stop()`・direction・codec の選択では残さない。[packages/webrtc/src/media/rtpTransceiver.ts:245](review-file:packages/webrtc/src/media/rtpTransceiver.ts:245)）。アプリが transaction 中に追加し、交渉していない transceiver は、rolled back の offer が付けた MID と m-line を外す（[packages/webrtc/src/transceiverManager.ts:179](review-file:packages/webrtc/src/transceiverManager.ts:179)） |
| router | [packages/webrtc/src/media/router.ts:123](review-file:packages/webrtc/src/media/router.ts:123) | パケットから学習した経路、未停止の各 sender の経路 |
| SCTP | [packages/webrtc/src/sctpManager.ts:138](review-file:packages/webrtc/src/sctpManager.ts:138) | アプリが作った SCTP transport（association が動いていない場合）。提案の SCTP が使った DTLS transport は、他に使われなければ止める（[packages/webrtc/src/negotiationTransaction.ts:461](review-file:packages/webrtc/src/negotiationTransaction.ts:461)） |

提案が作った資源（remote offer が作った transceiver、置換された transceiver、準備済み transport、pending-only transport、owner transport、候補を通知済みの transport）は、`ProposalResources` にまとめています。消去・複製・復元はこのクラスの中の 1 か所だけです（[packages/webrtc/src/negotiationTransaction.ts:27](review-file:packages/webrtc/src/negotiationTransaction.ts:27)）。replacement は「pending は最後のもの、baseline は最初のもの」です。新しい offer が来ると、前の pending を baseline まで戻してから適用します。

<!-- review-bookmark id="bm_1a1058d1043-1704bd93" title="2.1 transaction coordinator（baseline / c" -->
### 2.2 description 適用の順序（validate → codec 計画 → prepare → apply → commit）

`setRemoteDescription` は、次の順で進みます。

1. 状態を変える前に、description 全体を検証する。
2. 全 m-line の codec を、副作用なしで先に決める（codec 計画）。
3. checkpoint を取る。
4. m-line を適用する。live の transport を変える処理は、失敗しうる処理がすべて終わってから実行する。
5. answer なら commit する。

[packages/webrtc/src/peerConnection.ts:1488](review-file:packages/webrtc/src/peerConnection.ts:1488) が入口です。検証は [packages/webrtc/src/peerConnection.ts:1540](review-file:packages/webrtc/src/peerConnection.ts:1540)、codec 計画は [packages/webrtc/src/peerConnection.ts:1544](review-file:packages/webrtc/src/peerConnection.ts:1544)、checkpoint は [packages/webrtc/src/peerConnection.ts:1606](review-file:packages/webrtc/src/peerConnection.ts:1606)、m-line の適用は [packages/webrtc/src/peerConnection.ts:1621](review-file:packages/webrtc/src/peerConnection.ts:1621) です。transport の更新は [packages/webrtc/src/peerConnection.ts:1633](review-file:packages/webrtc/src/peerConnection.ts:1633) で、まとめて後から実行します。

事前検証の内容は次のとおりです。

- 共通 codec、使用中の payload type / extmap ID の再割当て
- DTLS の fingerprint と role（RFC 8842 §5.5）、SCTP port の変更、接続済み SCTP の別 transport への移動
- offer で共有した transport の分割（RFC 8843 §7.3.2）

検証の実装は [packages/webrtc/src/negotiation/descriptionValidation.ts:150](review-file:packages/webrtc/src/negotiation/descriptionValidation.ts:150) です。ローカル側の検証（準備済みの ICE 資格情報を使っているか、DTLS role を変えていないか）は [packages/webrtc/src/negotiation/descriptionValidation.ts:47](review-file:packages/webrtc/src/negotiation/descriptionValidation.ts:47) です。payload type と extmap の再割当ての拒否は [packages/webrtc/src/sdpManager.ts:463](review-file:packages/webrtc/src/sdpManager.ts:463) と [packages/webrtc/src/sdpManager.ts:437](review-file:packages/webrtc/src/sdpManager.ts:437) にあります。

<!-- review-bookmark id="bm_1a10662fd6e-753cc016" title="2.2 description 適用の順序（validate → codec 計" -->
remote m-line の適用は 4 段階です。入口は [packages/webrtc/src/negotiation/remoteMediaApplication.ts:85](review-file:packages/webrtc/src/negotiation/remoteMediaApplication.ts:85) です。

1. transceiver / SCTP との対応付け: [packages/webrtc/src/negotiation/remoteMediaApplication.ts:117](review-file:packages/webrtc/src/negotiation/remoteMediaApplication.ts:117)
2. BUNDLE の transport 所有: [packages/webrtc/src/negotiation/remoteMediaApplication.ts:238](review-file:packages/webrtc/src/negotiation/remoteMediaApplication.ts:238)
3. RTP / SCTP の受け入れ判定（codec 計画の結果を使う）: [packages/webrtc/src/negotiation/remoteMediaApplication.ts:342](review-file:packages/webrtc/src/negotiation/remoteMediaApplication.ts:342)
4. transport パラメータ更新の計画（実行は呼び出し側）: [packages/webrtc/src/negotiation/remoteMediaApplication.ts:393](review-file:packages/webrtc/src/negotiation/remoteMediaApplication.ts:393)

local 側の入口は [packages/webrtc/src/peerConnection.ts:938](review-file:packages/webrtc/src/peerConnection.ts:938) です。

### 2.3 ルーティングキーの staging（pending は追加だけ、変更は拒否か保留）

レビューが収束しなかった主な原因は、pending 中に、current が使っている共有 live table へ直接書き込み、rollback で snapshot から戻す方式だったことです。キーの種類ごとに、次の規則でまとめて閉じました。

- pending は、キーを**追加**してよい（暫定 RTP のため、すぐ有効）。
- current が使っているキーの値は、最終 answer まで変えない。変える提案は、適用前に拒否するか、commit まで保留（staged）する。

| キー | 扱い | 実装 |
| --- | --- | --- |
| payload type → codec | 再割当ては拒否。fmtp / rtcp-fb の変更は保留 | [packages/webrtc/src/media/rtpReceiver.ts:159](review-file:packages/webrtc/src/media/rtpReceiver.ts:159) |
| extmap ID → URI | 再割当ては拒否 | [packages/webrtc/src/sdpManager.ts:437](review-file:packages/webrtc/src/sdpManager.ts:437) |
| SSRC → receiver / RTX 対応 | 別の m-line への付け替えは保留 | [packages/webrtc/src/media/router.ts:206](review-file:packages/webrtc/src/media/router.ts:206) |
| MID+RID → receiver | RID は m-line 単位のキー | [packages/webrtc/src/negotiation/internalState.ts:39](review-file:packages/webrtc/src/negotiation/internalState.ts:39) |
| sender SSRC → sender | アプリ側の状態として rollback 後も維持 | [packages/webrtc/src/media/router.ts:123](review-file:packages/webrtc/src/media/router.ts:123) |
| PLI 判定 | その SSRC の live な受信 codec に従う | [packages/webrtc/src/media/rtpReceiver.ts:577](review-file:packages/webrtc/src/media/rtpReceiver.ts:577) |

staged route は [packages/webrtc/src/media/router.ts:67](review-file:packages/webrtc/src/media/router.ts:67) で commit 時に切り替わります。後から来た remote pranswer / answer は、先の pranswer が staged した値を [packages/webrtc/src/negotiationTransaction.ts:397](review-file:packages/webrtc/src/negotiationTransaction.ts:397) で破棄してから適用します。

### 2.4 ICE generation（restart / pranswer / trickle / EOC）

- ICE restart は、offer の時点では資格情報を stage するだけで、live の ICE は answer の commit で切り替えます。pranswer は、選択中の pair を保ったまま provisional generation の check を進めます。
- provisional の check は、送信時の checklist（revision と pair の所属）にだけ効きます。replacement pranswer より前の遅延応答は、新しい checklist を nominate しません。実装は [packages/ice/src/ice.ts:452](review-file:packages/ice/src/ice.ts:452) です。
- EOC は、live と provisional のどちらの generation も完了させます（RFC 8838）。EOC 後の候補は、SDP にも checklist にも入りません。EOC より前に届いて mDNS を解決中の候補は保持し、generation の完了はその解決を待ちます。実装は [packages/ice/src/ice.ts:351](review-file:packages/ice/src/ice.ts:351)、[packages/ice/src/ice.ts:329](review-file:packages/ice/src/ice.ts:329)、[packages/webrtc/src/secureTransportManager.ts:321](review-file:packages/webrtc/src/secureTransportManager.ts:321) です。
- trickle ICE は、候補が対象とする m-line の ufrag で、current と pending のどちらの generation に属するかを決めます。実装は [packages/webrtc/src/negotiation/remoteCandidates.ts:60](review-file:packages/webrtc/src/negotiation/remoteCandidates.ts:60) です。EOC は transport 単位で BUNDLE group 全体に及びます（[packages/webrtc/src/negotiation/remoteCandidates.ts:234](review-file:packages/webrtc/src/negotiation/remoteCandidates.ts:234)）。
- `restartIce()` は、current と pending のローカル ufrag を置き換え対象として記録します（W3C の `[[LocalIceCredentialsToReplace]]`）。rollback や glare の後も要求は残ります。実装は [packages/webrtc/src/negotiation/iceRestartRequest.ts:18](review-file:packages/webrtc/src/negotiation/iceRestartRequest.ts:18) と [packages/webrtc/src/peerConnection.ts:1480](review-file:packages/webrtc/src/peerConnection.ts:1480) です。
- restart の候補は offer / answer の作成時に確定し、commit はそれを再広告するだけでサーバーを待ちません。背景の再収集（STUN の再問い合わせ、新しい TURN allocation）は開始時の generation に属し、次の restart や `close()` に追い越されたら何も足さずに閉じます。
- relay-only の restart では、相手の候補と end-of-candidates が自分の新しい relay 候補より先に届くことがあります。接続確認は、相手の end-of-candidates に加えて自分の収集が終わるまで候補を待ち、後から確立した allocation を既知の相手候補とペアにします（[packages/ice/src/ice.ts:1245](review-file:packages/ice/src/ice.ts:1245)、[packages/ice/src/ice.ts:1399](review-file:packages/ice/src/ice.ts:1399)）。agent の close で収集の待機は終わります（[packages/ice/src/ice.ts:89](review-file:packages/ice/src/ice.ts:89)）。
- remote だけの restart（offer で restart していない transport の資格情報を answer が変える）は、別の `remoteGeneration` を進め、local の収集には触れません（[packages/ice/src/ice.ts:77](review-file:packages/ice/src/ice.ts:77)、[packages/ice/src/ice.ts:253](review-file:packages/ice/src/ice.ts:253)）。pair の選択は checklist と ufrag の所属で判定し、相手の SDP の `generation` 番号とローカルの番号は比べません。ICE-lite の相手が answer で資格情報を変えて `generation 1` を付けても接続します（[packages/ice/src/ice.ts:1865](review-file:packages/ice/src/ice.ts:1865)）。
- develop からある renomination 経路（`inactive` の m-line と資格情報の変更）は残し、別の ufrag を名乗る相手候補と pair だけを checklist から落とします（[packages/ice/src/ice.ts:653](review-file:packages/ice/src/ice.ts:653)）。

### 2.5 BUNDLE topology

- BUNDLE group は最初のものだけでなく、すべての group を扱います。group の tag が member の transport を決めます: [packages/webrtc/src/negotiation/bundleTopology.ts:48](review-file:packages/webrtc/src/negotiation/bundleTopology.ts:48)
- 分割・統合・新しい owner は、local offer では [packages/webrtc/src/negotiation/bundleTopology.ts:119](review-file:packages/webrtc/src/negotiation/bundleTopology.ts:119)、remote re-offer では [packages/webrtc/src/negotiation/bundleTopology.ts:268](review-file:packages/webrtc/src/negotiation/bundleTopology.ts:268) で準備し、answer の commit で切り替えます。
- offer で共有した transport を answer が分割することは拒否します: [packages/webrtc/src/negotiation/bundleTopology.ts:343](review-file:packages/webrtc/src/negotiation/bundleTopology.ts:343)
- 所有のためだけに作った transport は、rollback で閉じます: [packages/webrtc/src/peerConnection.ts:1756](review-file:packages/webrtc/src/peerConnection.ts:1756)
- max-compat / balanced の offer の BUNDLE group は、相手が BUNDLE を受理するまで提案にすぎません。各 m-line は自分の transport と候補を保ち、BUNDLE を受けない相手とも接続します（RFC 8843 §7.2）。

### 2.6 develop の issue 705（m-line 拒否・停止・再利用）との統合

develop のマージ（`c580f5d2`）でコンフリクトを解消したとき、705 の挙動の大半が落ちていました。これを transaction の中で動くように復元しました。

- 拒否予定（`pendingRejection`）を baseline に含めました。rollback の所有者は transaction だけにしています。
- remote が port 0 で出した m-line は拒否予定にします。
- アプリの再利用は、kind が一致し、停止が確定した位置だけにしました: [packages/webrtc/src/transceiverManager.ts:429](review-file:packages/webrtc/src/transceiverManager.ts:429)
- `setRemoteRTP` の受け入れ判定: [packages/webrtc/src/transceiverManager.ts:900](review-file:packages/webrtc/src/transceiverManager.ts:900)

意図した挙動変更（705 単独のときとの違い）は 3 点あり、チケットの 2.5 章に表で記載しています。

| 点 | 705 単独 | 本チケット | 根拠 |
| --- | --- | --- | --- |
| 確立済み member を BUNDLE 外へ出す re-offer | 拒否 | staged topology として受理 | RFC 8843 §7.5 |
| 使用中の payload type の codec 付け替え | 受理して拒否予定 | 適用前に拒否 | RFC 3264 §8.3.2 |
| group 外 m-line の answer の `a=setup` | 常に `active` | offer の逆 | RFC 8842 §5.3 |

### 2.7 develop の codec 統合（`setCodecPreferences()` / track source codec）との統合

最新の develop のマージ（`64f374a3`）と CI 対応（`d5cd6112`）で取り込みました。codec の解決は develop の方式に合わせ、適用する時期をこのチケットの規則（pending 中は current を保つ）に合わせています。

- **remote description：** 全 m-line の codec を、適用前に副作用なしで決めます（`planRemoteRtpCodecs`）。決めた結果を受け入れ判定で使います。計画: [packages/webrtc/src/transceiverManager.ts:833](review-file:packages/webrtc/src/transceiverManager.ts:833)、呼び出し: [packages/webrtc/src/negotiation/remoteMediaApplication.ts:69](review-file:packages/webrtc/src/negotiation/remoteMediaApplication.ts:69)
- **受信設定：** pending の offer / pranswer では、新しいキーの追加だけを行います。受信 codec 表の置き換え（`resyncCodecs`）は、remote answer または commit の時点でだけ行います: [packages/webrtc/src/media/rtpReceiver.ts:287](review-file:packages/webrtc/src/media/rtpReceiver.ts:287)
- **`createAnswer()`：** answer 用の codec を transceiver の提案として解決するだけです（[packages/webrtc/src/transceiverManager.ts:777](review-file:packages/webrtc/src/transceiverManager.ts:777)、呼び出しは [packages/webrtc/src/peerConnection.ts:1861](review-file:packages/webrtc/src/peerConnection.ts:1861)）。sender・受信 codec / RTX 表・TWCC・remote track の codec は、local answer の commit で切り替えます（[packages/webrtc/src/transceiverManager.ts:805](review-file:packages/webrtc/src/transceiverManager.ts:805)、呼び出しは [packages/webrtc/src/peerConnection.ts:1179](review-file:packages/webrtc/src/peerConnection.ts:1179)）。develop 単独では `createAnswer()` の時点で切り替えていたので、これは pending 中の current RTP を守るための意図した挙動変更です。
- **rollback：** `pendingLocalOfferCodecs` と再解決の要求（`codecPreferencesNeedResolution`）を baseline に含めます。`setCodecPreferences()` 自体はアプリの選択なので戻しません。
- **回帰テスト：** [packages/webrtc/tests/negotiation/cases/negotiationTransactionRegression.test.ts:1614](review-file:packages/webrtc/tests/negotiation/cases/negotiationTransactionRegression.test.ts:1614)

### 2.8 `negotiationneeded` と設定

- 同じ tick の変更はまとめて 1 回だけ発火します。確定した local offer が含んでいた変更は、通し番号で「交渉済み」として扱います: [packages/webrtc/src/negotiation/negotiationNeeded.ts:12](review-file:packages/webrtc/src/negotiation/negotiationNeeded.ts:12)
- `setConfiguration` の検証とマージは純粋関数にしました: [packages/webrtc/src/api/peerConfig.ts:350](review-file:packages/webrtc/src/api/peerConfig.ts:350)

### 2.9 モジュール構成

`peerConnection.ts`（分割前 3,514 行、現在 2,015 行）を責務ごとに分割しました。`src/negotiation/` には交渉用の内部サブシステム、`src/api/` には公開型（設定とイベント）を置いています。transport の起動処理は [packages/webrtc/src/negotiation/transportActivation.ts:24](review-file:packages/webrtc/src/negotiation/transportActivation.ts:24) にあります。対応表は [packages/webrtc/NEGOTIATION_TRANSACTION.md:469](review-file:packages/webrtc/NEGOTIATION_TRANSACTION.md:469) です。

`negotiationTransaction.ts` も 653 行から 440 行に整理しました（その後の規則の追加で現在 509 行）（2.1 章のとおり、snapshot を各コンポーネントへ移し、提案の資源を `ProposalResources` にまとめたため）。状態の持ち主の表は [packages/webrtc/NEGOTIATION_TRANSACTION.md:489](review-file:packages/webrtc/NEGOTIATION_TRANSACTION.md:489) です。

### 2.10 生成済み description の再利用契約

生成済みの description を後から／再度適用したときの扱いを、1 件ずつの特例ではなく契約と構造で決めました（チケット 2.9）。規則は 3 つです: (a) W3C が受理を求める適用は必ず受理する、(b) develop で受理・通信できた適用は退行させない、(c) それ以外は `InvalidModificationError` で拒否し、状態を一切変えない。

- `createOffer()` / `createAnswer()` ごとに、不変の生成記録（transport ごとの ICE 資格情報と stage した generation、MID と m-line の割当て、m-line ごとの codec）を残します: [packages/webrtc/src/peerConnection.ts:613](review-file:packages/webrtc/src/peerConnection.ts:613)、[packages/webrtc/src/transport/ice.ts:199](review-file:packages/webrtc/src/transport/ice.ts:199)
- `setLocalDescription` は、SDP と記録から割当てを計画し（[packages/webrtc/src/peerConnection.ts:675](review-file:packages/webrtc/src/peerConnection.ts:675)）、状態に書き込まずに検証し、そのあと一括で反映します。各 transport は description が持つ generation に切り替わります（[packages/webrtc/src/peerConnection.ts:705](review-file:packages/webrtc/src/peerConnection.ts:705)）。失敗時は undo に頼らず、構造的に何も変わりません。
- 未適用の `createOffer()` は MID を transceiver に関連付けません（W3C）。develop は `createOffer` の時点で割り当てます（2.14 の差分ファズで「意図した差」として数えます）。
- 契約表と develop の実測: [packages/webrtc/NEGOTIATION_TRANSACTION.md:122](review-file:packages/webrtc/NEGOTIATION_TRANSACTION.md:122)

### 2.11 pending 中に有効な値

「pending 中は current を壊さない」という規則は、pranswer で暫定的に有効にすべき値には当てはまりません。値ごとに、remote offer / pranswer / replacement pranswer / final answer / rollback の各段階で live になる値を current・provisional・both・reject のどれかに決めました（チケット 2.10）。

- 例: 送信 codec と direction、SCTP の max-message-size は provisional（W3C は pranswer でも max-message-size を更新します）。remote SSRC は both（新しい SSRC はすぐ route し、衝突は commit まで保留）。接続中の SCTP port の変更は reject。
- 表: [packages/webrtc/NEGOTIATION_TRANSACTION.md:501](review-file:packages/webrtc/NEGOTIATION_TRANSACTION.md:501)
- invariant helper は、一律の「live = current SDP」ではなく、表の規則（`expectedLive`）で検査します: [packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts:486](review-file:packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts:486)

### 2.12 拒否された application m-line と「その後も使い続けられるか」

application m-line を拒否した answer の commit で SCTP を閉じる規則を一度入れましたが、拒否の後の `createOffer()` が失敗する退行を起こしたので撤回し、develop と同じ挙動に戻しました（チケット 2.11）。

- m-line の位置（MID・index・拒否されたか）は、SCTP オブジェクトではなく current description が記録します。SCTP のない位置は同じ MID の port 0 で保ち、未束縛の SCTP（`createDataChannel`）は拒否された位置を新しい MID で使い直します: [packages/webrtc/src/sdpManager.ts:606](review-file:packages/webrtc/src/sdpManager.ts:606)、[packages/webrtc/src/negotiation/remoteMediaApplication.ts:196](review-file:packages/webrtc/src/negotiation/remoteMediaApplication.ts:196)
- 相手の offer で port 0 の application には port 0 で答えます（RFC 3264 §6）。answer の commit は、拒否された SCTP を別の transport へ移しません（[packages/webrtc/src/negotiation/bundleTopology.ts:318](review-file:packages/webrtc/src/negotiation/bundleTopology.ts:318)）。
- 接続済みの DTLS transport に後から載った SCTP（再交渉で足した最初の DataChannel）も association を開始します（[packages/webrtc/src/negotiation/transportActivation.ts:292](review-file:packages/webrtc/src/negotiation/transportActivation.ts:292)）。SCTP の client / server は、DTLS を開始したときの ICE role で固定します（werift は offer / answer のたびに ICE role を設定し直すため。[packages/webrtc/src/transport/dtls.ts:99](review-file:packages/webrtc/src/transport/dtls.ts:99)、[packages/webrtc/src/transport/sctp.ts:118](review-file:packages/webrtc/src/transport/sctp.ts:118)）。
- **共通の継続確認:** `expectSessionContinues(a, b)` は、両端を stable に戻してから、次の offer → ICE restart → DataChannel と transceiver の追加 → 相手からの再 offer を invariant 付きで行い、追加した経路で実通信を確認します（[packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts:1396](review-file:packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts:1396)）。`enforceSessionContinuation()` は呼び忘れを afterEach で検出し、除外は理由付きに限ります（[packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts:1262](review-file:packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts:1262)）。対応表の試験・回帰・変異・拒否の各試験で有効です。

### 2.13 操作の連鎖・close・接続の開始

- **操作の連鎖**（W3C の "chain an operation" を 1 か所で実装）: 閉じた接続への登録はその場で reject し、前の操作を待った後・操作の途中で close に追い越された操作は `InvalidStateError` で決着します。永久に pending の Promise はありません（[packages/webrtc/src/peerConnection.ts:736](review-file:packages/webrtc/src/peerConnection.ts:736)、[packages/webrtc/src/peerConnection.ts:1888](review-file:packages/webrtc/src/peerConnection.ts:1888)）。description 操作は各 await と signaling 通知の後に閉鎖を確認し、閉じていれば何も変更せず、回復処理も行いません。閉じた接続は transport を作りません。
- **addIceCandidate:** 前の操作が description を適用した時点まで待ち、`setLocalDescription` の収集の完了は待ちません（develop と同じ遅延。[packages/webrtc/src/peerConnection.ts:1372](review-file:packages/webrtc/src/peerConnection.ts:1372)）。後続の description 操作は両方の完了を待ちます。
- **接続の開始:** `connect()` は、適用した description で remote の ICE / DTLS パラメータを受けた transport だけを開始します（再交渉の pranswer で `failed` にならない。[packages/webrtc/src/negotiation/transportActivation.ts:202](review-file:packages/webrtc/src/negotiation/transportActivation.ts:202)）。`connectPending()` も同じ規則で、checks は generation ごとに一度だけ始め、実行中なら待ち、確立済みはやり直しません（pranswer の再適用で `checking` に戻らない。[packages/webrtc/src/negotiation/transportActivation.ts:308](review-file:packages/webrtc/src/negotiation/transportActivation.ts:308)）。ICE transport の停止は `checksSettled()` の待機を決着させます。
- **simulcast の RID:** MID+RID で見つからなければ、develop と同じく RID だけで引き直します（[packages/webrtc/src/media/router.ts:282](review-file:packages/webrtc/src/media/router.ts:282)）。

### 2.14 自前の探索（レビュアーと同じ軸）

レビュアーの主な手法は「develop では成功し、HEAD では失敗する」操作を公開 API の別の軸から探すことでした。同じ探索を依頼前に自分で回すために、次の仕組みを置いています。

| 仕組み | 内容 | 実行 |
| --- | --- | --- |
| invariant helper | 各操作の後に current SDP と live 状態の一致・有効値・孤立 transport を検査 | すべての交渉試験（[packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts:628](review-file:packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts:628)） |
| property test | seed 固定のランダム操作列。description pool の再利用、相手が m-line を拒否する episode を含む。仕組みは 2.14.1 | CI は固定 seed と回帰 seed、深い探索は 300 seed × 20 step（[packages/webrtc/tests/pbt/fuzz/episodes.ts:105](review-file:packages/webrtc/tests/pbt/fuzz/episodes.ts:105)、[packages/webrtc/tests/pbt/fuzz/episodes.ts:289](review-file:packages/webrtc/tests/pbt/fuzz/episodes.ts:289)） |
| 相手の SDP の変異 | 手書きの session 単位の変異と、「kind × 属性」の表から生成した変異（27 種類）を offer / pranswer / answer、初回と再交渉に適用 | CI は単独、手元で全ペア（[packages/webrtc/tools/negotiation-diff/mutations.ts:246](review-file:packages/webrtc/tools/negotiation-diff/mutations.ts:246)） |
| 割り込み | gather・mDNS・DTLS・STUN の待機中に close / restartIce / 新しい offer / rollback | CI（[packages/webrtc/tests/negotiation/cases/negotiationTransactionInterrupt.test.ts](review-file:packages/webrtc/tests/negotiation/cases/negotiationTransactionInterrupt.test.ts)） |
| close のタイミング | 10 種類の操作 × 0〜10 microtask 後と 1 macrotask 後の close（120 件）。全 Promise の決着と transport の停止を検査 | CI（[packages/webrtc/tests/negotiation/cases/negotiationTransactionCloseTiming.test.ts](review-file:packages/webrtc/tests/negotiation/cases/negotiationTransactionCloseTiming.test.ts)） |
| develop 差分ファズ | 公開 API だけの操作列。設定（`bundlePolicy`、`rtcpMuxPolicy`、TURN の relay-only）、アプリの操作（stop・replaceTrack・direction・setCodecPreferences・createDataChannel・restartIce）、close のタイミング、変異、2 つの合成操作。HEAD について未決着・故障なしの `failed`・transceiver 状態の差を常に検査 | 手元（[packages/webrtc/tools/negotiation-diff/run.ts:124](review-file:packages/webrtc/tools/negotiation-diff/run.ts:124)、[packages/webrtc/tools/negotiation-diff/compare.ts:139](review-file:packages/webrtc/tools/negotiation-diff/compare.ts:139)） |
| 仕様と試験の対応表 | チケットの全 276 文を試験名か「対象外（理由）」に対応づけ（covered 253、対象外 23、partial / uncovered 0） | [packages/webrtc/NEGOTIATION_SPEC_COVERAGE.md](review-file:packages/webrtc/NEGOTIATION_SPEC_COVERAGE.md) |

#### 2.14.1 property test の仕組み

property test は、「どんな操作の順序でも成り立つべき性質」を決めておき、ランダムに作った操作列でそれが崩れないかを確かめる試験です。例ベースの試験が「この手順ならこうなる」を 1 本ずつ確かめるのに対し、property test は手順そのものを乱数で組み立てます。そのため、人が思いつかない組み合わせにも届きます。本体は [packages/webrtc/tests/pbt/fuzz/negotiationTransactionProperty.test.ts:51](review-file:packages/webrtc/tests/pbt/fuzz/negotiationTransactionProperty.test.ts:51) の `playSeed` です。各 episode と乱数は [packages/webrtc/tests/pbt/shared/random.ts:6](review-file:packages/webrtc/tests/pbt/shared/random.ts:6) 以降にあります。property test のファイルは `packages/webrtc/tests/pbt/` にまとめ、invariant の検査など他の試験と共有する helper は `negotiationTransactionUtils.ts` に残しています。

確かめる性質は 3 つです。

1. **各操作の後**：両 peer の invariant が成り立つ。`step()` が操作のたびに `assertNegotiationInvariants` を呼び、pending 中を含むどの signaling state でも検査します（[packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts:1189](review-file:packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts:1189)）。
2. **各 step の後**：確定した session が実際に通信できる。video の RTP（双方向）、DataChannel（双方向）、交渉済みの各 audio の RTP を実際に送り、受信を待ちます（[packages/webrtc/tests/pbt/fuzz/episodes.ts:71](review-file:packages/webrtc/tests/pbt/fuzz/episodes.ts:71)）。
3. **拒否された操作**：再利用契約で拒否される操作は、状態を何も変えない（原子性）。

**1 seed の実行の流れ**

まず、video（VP8 + RTX、MID / abs-send-time の header extension）・audio（OPUS）・DataChannel を持つ接続済みの 2 peer を作ります（[packages/webrtc/tests/pbt/fuzz/episodes.ts:37](review-file:packages/webrtc/tests/pbt/fuzz/episodes.ts:37)）。RTX と header extension を入れているのは、ルーティングキーを変える操作を選べるようにするためです。そのうえで、次のループを `steps` 回（既定は 8 回）繰り返します。

```text
seed ─┬─ rng          = seededRandom(seed)
      ├─ poolRng      = seededRandom(seed × 7919 + 13)
      └─ rejectionRng = seededRandom(seed × 104729 + 7)

step を steps 回くり返す:
  rng          70% → 交渉 episode / 30% → remote の routing key 変更
               → 実通信を確認
  poolRng      50% → description pool の episode → 実通信を確認   (pool = true のときだけ)
  rejectionRng 30% → m-line の拒否の episode   → 実通信を確認   (pool = true のときだけ)

どの操作の後にも両 peer の invariant を検査する。
失敗したら seed と操作の記録 (log) を付けて例外を投げる。
```

乱数を 3 系統に分けているのは、後から追加した pool と拒否の episode で、主操作の乱数列がずれないようにするためです。同じ乱数列から引くと、追加した時点で既存の seed の操作が変わり、過去に欠陥を見つけた seed が同じ操作を再生しなくなります。回帰 seed は `pool = false` で再生し、欠陥を見つけたときの主操作だけの操作列を再現します。

**4 種類の episode**

どの episode も、最後には両 peer が stable に戻ります（rollback か answer で終える）。そのため、続けて実通信を確認できます。

| episode | 乱数で選ぶもの | 特に確認すること |
| --- | --- | --- |
| 交渉（[packages/webrtc/tests/pbt/fuzz/episodes.ts:105](review-file:packages/webrtc/tests/pbt/fuzz/episodes.ts:105)） | offerer、variant、finish、EOC（30%） | すべての経路で invariant が成り立つ。ICE restart では、answer を保存 → 作り直し → 未適用の restart offer を作成 → 保存した answer を適用しても、その answer が適用できる |
| remote の routing key 変更（[packages/webrtc/tests/pbt/fuzz/episodes.ts:225](review-file:packages/webrtc/tests/pbt/fuzz/episodes.ts:225)） | RTX の SSRC の付け替え / abs-send-time を新しい extmap ID へ移動 / 同じ extmap ID を別 URI に再割り当て | 前の 2 つは、pending のまま現在の RTP と DataChannel が流れることを確認してから rollback する。再割り当ては `InvalidModificationError` で拒否され、signaling state と current SDP が変わらない |
| description pool（[packages/webrtc/tests/pbt/fuzz/episodes.ts:369](review-file:packages/webrtc/tests/pbt/fuzz/episodes.ts:369)） | offerer、ICE restart（50%）、後から別の offer を作って古い方を適用（50%）、rollback して同じ offer を再適用（40%）、answer の作り直しと未適用の offer（50%、順序も 50%）、pranswer を先に適用（30%） | 再利用契約（2.10）。古い offer は拒否され、状態は何も変わらない。保存した answer は、作り直しや未適用の offer の後でも適用できる |
| m-line の拒否（[packages/webrtc/tests/pbt/fuzz/episodes.ts:289](review-file:packages/webrtc/tests/pbt/fuzz/episodes.ts:289)） | offerer、拒否する場所（offer / answer）、種類（application / 新しく足した video / 交渉済みの audio） | port 0 と BUNDLE から外す拒否の後も invariant が成り立ち、残りの経路で通信を続けられる。後の episode でも交渉を続けられる（2.12） |

交渉 episode は、次の 4 つの選択を組み合わせた手順です。選べる variant は session の状態で変わります。

```text
offerer (a / b) → variant                → EOC (30%)           → finish
                  plain                     answerer に remote     answer
                  iceRestart                の EOC を追加          pranswerAnswer
                  addAudio   (audio 2 本未満)                      pranswerRollback
                  splitAudio (交渉済み audio あり)                  rollback
                  mergeAudio (交渉済み audio あり)                  replacementAnswer
```

確定で終わると、ICE restart なら新しい generation の nomination を、BUNDLE の分割なら新しい transport の DTLS 確立を待ってから、実通信を確認します。

**2 段の検査**

invariant は「状態の辻褄」を、実通信は「利用者から見た結果」を見ます。どちらか一方では見逃す欠陥があります。invariant を満たしていても RTP が止まることがあり、通信は続いていても pending の値が live に漏れていることがあります。

```text
a: SLD(offer) → b: SRD(offer) → b: SLD(pranswer) → a: SRD(pranswer) → … answer → 実通信 (RTP・DC)
      ▲inv           ▲inv             ▲inv               ▲inv             ▲inv
```

invariant の検査（[packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts:628](review-file:packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts:628)）は試験専用の観測で、公開 API は増やしていません。

| 検査 | 確かめる内容 |
| --- | --- |
| description と transport | 各 m-line の transport・BUNDLE の共有・ICE 資格情報が current SDP と一致する。current の local SDP が拒否した m-line には route がない |
| ルーティング表 | SSRC・RTX の対・MID+RID・extmap ID が current SDP どおりに解決される。pending の提案はキーを追加するだけで、衝突するキーは commit まで stage に置く。stable では staged route が残らない |
| router と sender | router は peer に残る sender / receiver だけを参照する。停止していない sender は、交渉状態によらず自分の SSRC で RTCP を受け取れる |
| ICE generation | 資格情報・候補・EOC・checklist・選択 pair が、その generation の description と一致する |
| DTLS / SCTP | 接続済みの DTLS の role は current answer の `a=setup` と、fingerprint は current の local SDP と一致する。SCTP は current の application m-line（MID と m-line index）に束縛される |
| 有効値 | pending 中に live な値（direction、送信 codec など）が、有効値の表（2.11）の規則どおりである。規則は `expectedLive` にある。送信するのは currentDirection が送信を含むときだけ |
| 孤立 transport | どの description にも属さない transport が残っていない |

**拒否された操作の原子性**

`expectRejectedAtomically` は、拒否の前後で両 peer の snapshot を取り、完全一致を要求します（[packages/webrtc/tests/pbt/fuzz/episodes.ts:349](review-file:packages/webrtc/tests/pbt/fuzz/episodes.ts:349)）。snapshot の内容は、signaling state、current / pending の local・remote SDP、各 ICE transport の ufrag と staged restart、transceiver の MID と m-line index、SSRC / RID の表です（[packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts:2526](review-file:packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts:2526)）。

```text
snapshot(a, b) → 拒否される操作 (例: 古い offer の SLD → reject) → snapshot(a, b) + invariant
      └──────────────────────── 完全一致 (toEqual) ────────────────────────┘
```

**再現と、CI で回る seed**

乱数は mulberry32 です（[packages/webrtc/tests/pbt/shared/random.ts:6](review-file:packages/webrtc/tests/pbt/shared/random.ts:6)）。同じ seed からは同じ乱数列が出るので、操作の選択も同じになります。ただし、ICE や DTLS が終わるタイミングは実際のソケットの通信に依存します。そのため、タイミングに依存する欠陥は、同じ seed でも毎回は再現しないことがあります。失敗すると、seed と操作の記録を付けた例外を投げます（元の例外は `cause` に残します）。出力の形式は次のとおりです（内容は例です）。

```text
AssertionError: expected 'checking' to be 'connected'
seed 19 operations:
  episode a iceRestart pranswerAnswer
  pool b iceRestart
    stale offer refused
    pranswer first
  rejection a video in answer
  mutation b extmapMove
```

| 環境変数 | 既定値 | 意味 |
| --- | --- | --- |
| `WERIFT_NEGOTIATION_FUZZ_SEEDS` | 6 | 試す seed の数 |
| `WERIFT_NEGOTIATION_FUZZ_STEPS` | 8 | 1 seed あたりの step 数 |
| `WERIFT_NEGOTIATION_FUZZ_SEED` | 1 | 最初の seed。失敗した seed の再生に使う。指定すると回帰 seed は実行しない |

CI で既定値のまま回るのは、次の 12 件です。

- 固定 seed 1〜6：8 step。pool と拒否の episode も実行する
- 回帰 seed 17、19、28：8 step、pool なし。3、4、6 は固定 seed と重複するので除く
- 長い回帰 seed 254、302、1385：20 step、pool なし

回帰 seed は、この変更で直した欠陥を実際に見つけた seed です（[packages/webrtc/tests/pbt/fuzz/negotiationTransactionProperty.test.ts:39](review-file:packages/webrtc/tests/pbt/fuzz/negotiationTransactionProperty.test.ts:39)）。

| seed | 見つかった欠陥 |
| --- | --- |
| 3 | 古い ufrag の connectivity check が、live の候補を付け替えた |
| 6 | pranswer で、ICE restart の資格情報を作り直した |
| 17 | fallback の DTLS role が、BUNDLE を分割した transport の owner を上書きした |
| 19 | 古い check が、破棄済みの pair を選択した |
| 28 | まだ回答のない transceiver に answer が direction を与えた。未適用の `createOffer()` が MID を割り当てた |
| 254、302 | 未適用の offer を繰り返すと、古い m-line index が残った（20 step） |
| 1385 | ICE restart の後に srflx 候補が落ちた（20 step） |

seed 4 は、試験のコメントに欠陥の記載がありません。固定 seed 1〜6 にも含まれるため、CI では pool ありで実行されます。

交渉の変更でレビューを依頼する前に、`WERIFT_NEGOTIATION_FUZZ_SEEDS=300 WERIFT_NEGOTIATION_FUZZ_STEPS=20` で 300 seed × 20 step を回します（`packages/webrtc/AGENTS.md` の手順。結果は 5 章）。新しい欠陥を見つけたら、その seed を回帰 seed に加えます。

**この試験が扱わないもの**

相手は常に werift で、SDP の多様性は上の変異と拒否に限られます。設定（`bundlePolicy`・`rtcpMuxPolicy`・relay-only）、アプリの操作、close のタイミングは扱いません。これらは、上の表の他の仕組み（相手の SDP の変異、close のタイミング、develop 差分ファズ）で探索します。

## 3. 判断理由

- **live に書いて rollback で戻す方式から、stage して commit する方式へ。** live に書いて rollback で戻す方式では、rollback 後の状態しか守れず、pending 中の current の通信は守れません。キーの種類ごとに「追加は即時、変更は拒否か保留」と決めることで、反例を個別に塞ぐのではなく、種類ごとにまとめて閉じました。develop の codec 統合も、同じ規則に合わせて commit 時に切り替えています。
- **拒否と保留の判断は RFC と Chrome の実機挙動に合わせました。** extmap ID の再割当ては拒否します（RFC 8285 §7、Chrome も拒否）。SSRC の移動と RTX の付け替えは保留します（Chrome は受理）。
- **状態の snapshot は持ち主に置きました。** transaction が他のオブジェクトのプロパティを列挙すると、状態を足すたびに漏れが起きます（実際に develop の codec 統合で修正が必要になりました）。持ち主の snapshot / restore の組だけを直せば済む形にしています。
- **invariant helper で機械的に検出します。** 各操作の後に、current SDP と live 状態の一致を検査します。対象は、SSRC / RTX / MID+RID / extmap、受信 codec（fmtp と RTCP feedback まで）、PLI の判定、未停止の sender の経路、ICE の credential / candidate / EOC / checklist、DTLS、SCTP です: [packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts:628](review-file:packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts:628)、ルーティング表の検査は [packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts:698](review-file:packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts:698)
- **自分で反例を探索します。** seed 固定の property test で、ランダムな操作列（offer / pranswer / answer / rollback / replacement、ICE restart、BUNDLE の分割と統合、EOC、ルーティングキーの変更）を実行し、各操作の後に invariant を、各ステップの後に実通信を検査します: [packages/webrtc/tests/pbt/fuzz/episodes.ts:105](review-file:packages/webrtc/tests/pbt/fuzz/episodes.ts:105)。CI では固定 seed と回帰 seed を再生します: [packages/webrtc/tests/pbt/fuzz/negotiationTransactionProperty.test.ts:39](review-file:packages/webrtc/tests/pbt/fuzz/negotiationTransactionProperty.test.ts:39)
- **develop と挙動を変える箇所を増やしません。** develop と挙動が変わる規則を、核の不変条件・W3C・RFC のどれに必須かで棚卸ししました（[packages/webrtc/NEGOTIATION_TRANSACTION.md:874](review-file:packages/webrtc/NEGOTIATION_TRANSACTION.md:874)）。必須でないもの（application 拒否での SCTP の close）は develop に戻しました。新しい差は、develop で失敗していた操作を成功させるものか、`expectSessionContinues` を通るものに限ります。
- **完了条件を有限にしました。** 遷移表・mutation matrix・操作カタログに載っていない新しい組み合わせは、後続チケットとして扱います（設計文書の Scope 章、チケットの 6 章）。

## 4. リスク・既知の制約

- 相互運用は Chrome でしか確認していません。Firefox や Safari は対象外です。
- extmap の ID 対応表は PeerConnection 全体で 1 つです。BUNDLE しない別の transport で同じ ID を別の URI に使う構成には対応していません。
- ICE restart の commit で旧 pair を手放すため、新しい generation が nominate するまで RTP が途切れます。
- application m-line を拒否しても、SCTP transport と DataChannel は閉じません（develop と同じ挙動です。W3C の仕様では `sctpTransport` を null にします）。次の offer では同じ MID で application を再提案します。
- develop の werift は、application を port 0 にした offer に、port 9 で `a=sctp-port` のない answer を返します。HEAD はこの answer を拒否します（状態は変えません）。
- PLI の判定は werift の既存規則のままで、`nack` 系の feedback が交渉されていれば送ります。
- 状態の snapshot 用の型（`TransceiverNegotiationState`、`ReceiverNegotiationState`、`TransceiversNegotiationState`、`RouterSnapshot`）は、`media/index.ts` の `export *` を通じて型として公開されています。内部用のフィールドとメソッド（`RTCDtlsTransport.iceRoleAtStart` / `hasRemoteParameters`、ICE の `Connection.dropOtherRemoteGenerations`）は doc に載りますが、公開 API として案内していません。
- close に追い越された操作の Promise は `InvalidStateError` で決着します。W3C は永久に pending にします（該当する WPT 2 件は、もともと FAIL で allowlist の外です）。
- develop との意図した差（設計文書の棚卸し表）: 未適用の `createOffer()` は MID を関連付けない、pending の remote offer は current の送信 codec を変えず rollback で戻す（develop はこの漏れのおかげで、offer にない codec を含む相手の古い answer を後から適用しても通信できる場合があります）、接続中の SCTP port の変更は拒否する。
- WPT は runner 判定で REGRESSION 0 です（upstream WPT の FAIL や TIMEOUT は多く残っており、件数は実行時の負荷で変動します）。

## 5. 検証結果

最後の修正（`84734b92`、ICE の pair 選択の判定）の時点での結果です。WPT だけはその 2 回前の修正（`65bd6ed9`）の時点で実行しました。

| 検証 | 結果 |
| --- | --- |
| workspace の `npm run type` / `npm run test:small` | 全パッケージ成功（ice 208 passed、webrtc 1031 passed / 3 skipped） |
| 深い property 探索（300 seed × 20 step） | 303 / 303 passed |
| 変異の全ペア | 2106 / 2106 passed |
| Chrome E2E | 46 / 46 passed |
| WPT（allowlist） | REGRESSION 0（PASS 442） |
| develop 差分ファズ（60 seed × 12 step、変異なし） | 回帰・未決着・故障なしの `failed`・transceiver 状態の差がすべて 0 件 |
| develop 差分ファズ（60 seed × 12 step、変異 0.3） | 1 件だけ（意図した差: develop の rollback が送信 codec を戻さないことに依存した成功） |

修正前のビルド（`3da7c5a4`）に同じ差分ファズを当てると、8 回目のレビューで確定した 3 件（disable の pranswer で `failed`、close のタイミングで未決着、stop 後の rollback で transceiver が残る）をすべて検出しました。

主なテストファイル:

- 遷移マトリクス: [packages/webrtc/tests/negotiation/cases/negotiationTransactionMatrix.test.ts](review-file:packages/webrtc/tests/negotiation/cases/negotiationTransactionMatrix.test.ts)
- ルーティングキー: [packages/webrtc/tests/negotiation/cases/negotiationTransactionRouting.test.ts:18](review-file:packages/webrtc/tests/negotiation/cases/negotiationTransactionRouting.test.ts:18)
- 拒否された application m-line の組み合わせ: `packages/webrtc/tests/negotiation/cases/negotiationTransactionApplicationRejection.test.ts`（TICKET 2.20 で削除）
- pending 中の有効値: `packages/webrtc/tests/negotiation/cases/negotiationTransactionEffectiveValues.test.ts`（TICKET 2.20 で削除）
- 対応表の要件 ID を名前に持つ試験: [packages/webrtc/tests/negotiation/cases/negotiationTransactionCoverageTransport.test.ts](review-file:packages/webrtc/tests/negotiation/cases/negotiationTransactionCoverageTransport.test.ts) ほか Coverage* 4 本
- 決定的な回帰テスト（レビュー指摘の再現を含む）: [packages/webrtc/tests/negotiation/cases/negotiationTransactionRegression.test.ts:74](review-file:packages/webrtc/tests/negotiation/cases/negotiationTransactionRegression.test.ts:74)
- ICE の EOC と mDNS の競合: [packages/ice/tests/ice/end-of-candidates.test.ts](review-file:packages/ice/tests/ice/end-of-candidates.test.ts)

## 6. レビュー指摘・依頼の対応履歴

各回の修正は、指摘された 1 件だけでなく同じ種類の経路をまとめて閉じ、回帰テストと invariant を追加しました。

| コミット | 指摘・依頼 | 対応 |
| --- | --- | --- |
| `2da2bc5a` | develop マージでの 705 の退行 8 件 | 705 の挙動を transaction 内に復元 — [packages/webrtc/src/peerConnection.ts](review-diff:packages/webrtc/src/peerConnection.ts:commit:2da2bc5a) |
| `0b2fa95b` | provisional generation が EOC 後の候補を受け入れる | EOC 後の候補の破棄と mDNS 競合への対応 — [packages/ice/src/ice.ts](review-diff:packages/ice/src/ice.ts:commit:0b2fa95b) |
| `d8e4c4cc` | rollback で restart 要求が失われる / 複数 BUNDLE group / 遅延した provisional 応答 | 全 group への対応と revision の検査 — [packages/webrtc/src/sdpManager.ts](review-diff:packages/webrtc/src/sdpManager.ts:commit:d8e4c4cc) |
| `233d566c` | rollback 後の sender の RTCP 経路 / pending 中の `restartIce()` | sender 経路の維持と pending 資格情報の記録 — [packages/webrtc/src/negotiationTransaction.ts](review-diff:packages/webrtc/src/negotiationTransaction.ts:commit:233d566c) |
| `909c6991` | 同じ SSRC の再交渉後に PLI の判定が古いまま残る | live な受信 codec で判定 — [packages/webrtc/src/media/rtpReceiver.ts](review-diff:packages/webrtc/src/media/rtpReceiver.ts:commit:909c6991) |
| `69ff0059` / `922aa3bb` | （依頼）`peerConnection.ts` の分割とディレクトリ整理 | 挙動を変えないモジュール分割 — [packages/webrtc/src/peerConnection.ts](review-diff:packages/webrtc/src/peerConnection.ts:commit:69ff0059) |
| `64f374a3` / `d5cd6112` | develop の codec 統合のマージと CI 対応 | codec の切り替えを commit 時に統一 — [packages/webrtc/src/transceiverManager.ts](review-diff:packages/webrtc/src/transceiverManager.ts:commit:d5cd6112) |
| `98247860` | （依頼）`negotiationTransaction.ts` のリファクタリング | snapshot を各コンポーネントへ移し、提案の資源を集約 — [packages/webrtc/src/negotiationTransaction.ts](review-diff:packages/webrtc/src/negotiationTransaction.ts:commit:98247860dbbf) |
| `74e50f9b` / `ebc6d797` | develop との比較レビューで見つかった退行（trickle、受信 codec、使用中の判定、close、#142、接続済み ICE の再 check） | develop の挙動を transaction の中で復元 — [packages/webrtc/src/peerConnection.ts](review-diff:packages/webrtc/src/peerConnection.ts:commit:74e50f9b) |
| `0905b081` / `4e3f5e4f` | 背景の ICE 収集が後の generation に混ざる / provisional check が live の規則に従わない | 収集を generation に紐付け、provisional checklist に同じ規則を適用 — [packages/ice/src/ice.ts](review-diff:packages/ice/src/ice.ts:commit:0905b081) |
| `78b25741` / `b8270b09` | BUNDLE の EOC、初回 pranswer の DTLS role、rollback 状態 / answer の codec | 適用した SDP から codec を取る — [packages/webrtc/src/peerConnection.ts](review-diff:packages/webrtc/src/peerConnection.ts:commit:b8270b09) |
| `dd85585d` | 生成済み description の再適用・後からの適用 | 生成記録と再利用契約（2.10）— [packages/webrtc/src/peerConnection.ts](review-diff:packages/webrtc/src/peerConnection.ts:commit:dd85585d) |
| `5e9f5b00` / `85e1f01a` | max-compat の BUNDLE、generation の寿命、ICE-lite の nomination / 提案の EOC、準備中の close | BUNDLE を提案として扱い、提案の generation 単位で EOC — [packages/webrtc/src/negotiation/bundleTopology.ts](review-diff:packages/webrtc/src/negotiation/bundleTopology.ts:commit:5e9f5b00) |
| `16016a77` | pranswer の max-message-size（有効値の表がない）／相手の多様性と割り込み／仕様と試験の対応 | 有効値の表と `expectedLive`、変異ライブラリ、割り込み試験、対応表（2.11、2.14）— [packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts](review-diff:packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts:commit:16016a77) |
| `abd0c275` | application m-line を拒否した後の `createOffer()` が失敗する（直前の修正の副作用） | SCTP の close を撤回して develop に戻し、m-line の位置を description から求める。全試験の継続確認、kind × 属性の変異、拒否の property episode（2.12）— [packages/webrtc/src/sdpManager.ts](review-diff:packages/webrtc/src/sdpManager.ts:commit:abd0c275) |
| `9543d593` | 変異の全ペアの失敗（renomination 経路の古い候補、試験の判定） | 別の ufrag の候補だけを落とす — [packages/ice/src/ice.ts](review-diff:packages/ice/src/ice.ts:commit:9543d593) |
| `2f51531a` | relay-only の ICE restart で接続できない | 自分の収集が終わるまで候補を待ち、後から確立した allocation をペアにする — [packages/ice/src/ice.ts](review-diff:packages/ice/src/ice.ts:commit:2f51531a) |
| `3da7c5a4` | glare の `stable` 通知の中で close すると状態が残る | await と signaling 通知の後に閉鎖を確認 — [packages/webrtc/src/peerConnection.ts](review-diff:packages/webrtc/src/peerConnection.ts:commit:3da7c5a4) |
| `65bd6ed9` | 8 回目: disable の pranswer で `failed`、close のタイミングで永久 pending、stop 後の rollback で transceiver が残る | 操作の連鎖を 1 か所で実装、remote パラメータのない transport を開始しない、rollback は track の有無で残す。未確認の 3 件（remote generation、RID、addIceCandidate）と置き換えた offer の rollback の MID も修正。差分ファズに探索の軸と検査を追加（2.13、2.14）— [packages/webrtc/src/peerConnection.ts](review-diff:packages/webrtc/src/peerConnection.ts:commit:65bd6ed9) |
| `24d45a96` | local pranswer の再適用で ICE checks が完了しない | `connectPending()` も同じ generation の checks を再開始しない — [packages/webrtc/src/negotiation/transportActivation.ts](review-diff:packages/webrtc/src/negotiation/transportActivation.ts:commit:24d45a96) |
| `84734b92` | ICE-lite の相手が answer で資格情報を変え `generation 1` を付けると接続できない | pair の選択を checklist と ufrag の所属で判定 — [packages/ice/src/ice.ts](review-diff:packages/ice/src/ice.ts:commit:84734b92) |
<!-- review-bookmark id="bm_1a1066566bb-ef47584a" title="しおり 3" -->
