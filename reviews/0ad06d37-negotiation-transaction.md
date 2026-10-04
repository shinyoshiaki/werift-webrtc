---
ide:
  viewer: review-document
  version: 1
  title: "PeerConnection negotiation transaction の実装解説"
  dock: right
  baseCommit: 98247860dbbf2713e8ef690682738fb8e8e4f15d
---
# PeerConnection negotiation transaction の実装解説

## 1. 概要

`RTCPeerConnection` の再交渉（offer / pranswer / answer / rollback / replacement、ICE restart、BUNDLE、SCTP、trickle ICE、非対応 m-line の拒否）を、個別の補修ではなく **1 つの transaction** として扱うように作り直しました。守る不変条件は次の 1 つです。

> 最終 answer の適用だけが negotiated state の commit 境界であり、それまでの pending negotiation は通信中の current session を壊さない。rollback 後の current session も通信できる。

設計の正は設計文書です。遷移表（current / pending / rollback baseline / speculative side effect）、各 subsystem の mutation matrix、ルーティングキーの規則、コード構成、対象外の範囲を定義しています。

- 遷移表: [packages/webrtc/NEGOTIATION_TRANSACTION.md:122](review-file:packages/webrtc/NEGOTIATION_TRANSACTION.md:122)
- mutation matrix: [packages/webrtc/NEGOTIATION_TRANSACTION.md:133](review-file:packages/webrtc/NEGOTIATION_TRANSACTION.md:133)
- ルーティングキーの規則: [packages/webrtc/NEGOTIATION_TRANSACTION.md:274](review-file:packages/webrtc/NEGOTIATION_TRANSACTION.md:274)
- コード構成と、状態の snapshot の持ち主: [packages/webrtc/NEGOTIATION_TRANSACTION.md:339](review-file:packages/webrtc/NEGOTIATION_TRANSACTION.md:339)
- 対象外・既知の制約: [packages/webrtc/NEGOTIATION_TRANSACTION.md:441](review-file:packages/webrtc/NEGOTIATION_TRANSACTION.md:441)
- チケット: [TICKET-ticket-0ad06d37-d829-4a08-8e49-2da46e551b79.md](review-file:TICKET-ticket-0ad06d37-d829-4a08-8e49-2da46e551b79.md)

変更規模は、最新の develop との merge base（`a0cc8d76`）から `packages/` で 47 ファイル（+12,926 / −1,678）です。うち `webrtc` と `ice` の `src` が 24 ファイル（+5,490 / −1,647）で、残りは主にテストです。公開 API の値は増やしていません（追加したのは内部用の型だけです。4 章を参照）。

## 2. 主要変更

### 2.1 transaction coordinator（baseline / checkpoint / commit / rollback）

`NegotiationTransaction` が、交渉で変わる状態の baseline と、提案が作った資源を 1 か所で所有します（[packages/webrtc/src/negotiationTransaction.ts:88](review-file:packages/webrtc/src/negotiationTransaction.ts:88)）。

- transaction の開始（`createOffer` が取った snapshot を baseline に使う）: [packages/webrtc/src/negotiationTransaction.ts:143](review-file:packages/webrtc/src/negotiationTransaction.ts:143)
- commit（staged route / receive 値の切替、置換された transceiver と使われない transport の停止）: [packages/webrtc/src/negotiationTransaction.ts:175](review-file:packages/webrtc/src/negotiationTransaction.ts:175)
- replacement（baseline を残したまま戻す）と rollback: [packages/webrtc/src/negotiationTransaction.ts:211](review-file:packages/webrtc/src/negotiationTransaction.ts:211)
- 1 回の操作の途中失敗を、その操作の分だけ戻す checkpoint: [packages/webrtc/src/negotiationTransaction.ts:237](review-file:packages/webrtc/src/negotiationTransaction.ts:237)
- 復元処理（各コンポーネントの restore を順に呼び、使われなくなった transport を止める）: [packages/webrtc/src/negotiationTransaction.ts:381](review-file:packages/webrtc/src/negotiationTransaction.ts:381)

**状態の snapshot は、その状態を持つコンポーネントが自分で取り、自分で戻します。** transaction は、それらを組み合わせるだけです。新しい状態を足すときは、そのコンポーネントの snapshot / restore の組だけを直せば済みます。rollback で特別に残す規則も、それぞれの持ち主に置いています。

| コンポーネント | snapshot / restore | rollback 後も残す規則 |
| --- | --- | --- |
| transceiver（sender・receiver を含む） | [packages/webrtc/src/media/rtpTransceiver.ts:164](review-file:packages/webrtc/src/media/rtpTransceiver.ts:164) | transaction 中にアプリが呼んだ `stop()` |
| receiver | [packages/webrtc/src/media/rtpReceiver.ts:245](review-file:packages/webrtc/src/media/rtpReceiver.ts:245) | RID パケットから学習した SSRC（その track が残る場合） |
| transceiver 群（並び順、track 通知、提案が作った transceiver の除去） | [packages/webrtc/src/transceiverManager.ts:142](review-file:packages/webrtc/src/transceiverManager.ts:142) | アプリが使っている transceiver（[packages/webrtc/src/media/rtpTransceiver.ts:218](review-file:packages/webrtc/src/media/rtpTransceiver.ts:218)） |
| router | [packages/webrtc/src/media/router.ts:107](review-file:packages/webrtc/src/media/router.ts:107) | パケットから学習した経路、未停止の各 sender の経路 |
| SCTP | [packages/webrtc/src/sctpManager.ts:138](review-file:packages/webrtc/src/sctpManager.ts:138) | アプリが作った SCTP transport（association が動いていない場合） |

提案が作った資源（remote offer が作った transceiver、置換された transceiver、準備済み transport、pending-only transport、owner transport、候補を通知済みの transport）は、`ProposalResources` にまとめています。消去・複製・復元はこのクラスの中の 1 か所だけです（[packages/webrtc/src/negotiationTransaction.ts:28](review-file:packages/webrtc/src/negotiationTransaction.ts:28)）。replacement は「pending は最後のもの、baseline は最初のもの」です。新しい offer が来ると、前の pending を baseline まで戻してから適用します。

### 2.2 description 適用の順序（validate → codec 計画 → prepare → apply → commit）

`setRemoteDescription` は、次の順で進みます。

1. 状態を変える前に、description 全体を検証する。
2. 全 m-line の codec を、副作用なしで先に決める（codec 計画）。
3. checkpoint を取る。
4. m-line を適用する。live の transport を変える処理は、失敗しうる処理がすべて終わってから実行する。
5. answer なら commit する。

[packages/webrtc/src/peerConnection.ts:1236](review-file:packages/webrtc/src/peerConnection.ts:1236) が入口です。検証は [packages/webrtc/src/peerConnection.ts:1286](review-file:packages/webrtc/src/peerConnection.ts:1286)、codec 計画は [packages/webrtc/src/peerConnection.ts:1290](review-file:packages/webrtc/src/peerConnection.ts:1290)、checkpoint は [packages/webrtc/src/peerConnection.ts:1347](review-file:packages/webrtc/src/peerConnection.ts:1347)、m-line の適用は [packages/webrtc/src/peerConnection.ts:1362](review-file:packages/webrtc/src/peerConnection.ts:1362) です。transport の更新は [packages/webrtc/src/peerConnection.ts:1371](review-file:packages/webrtc/src/peerConnection.ts:1371) で、まとめて後から実行します。

事前検証の内容は次のとおりです。

- 共通 codec、使用中の payload type / extmap ID の再割当て
- DTLS の fingerprint と role（RFC 8842 §5.5）、SCTP port の変更、接続済み SCTP の別 transport への移動
- offer で共有した transport の分割（RFC 8843 §7.3.2）

検証の実装は [packages/webrtc/src/negotiation/descriptionValidation.ts:107](review-file:packages/webrtc/src/negotiation/descriptionValidation.ts:107) です。ローカル側の検証（準備済みの ICE 資格情報を使っているか、DTLS role を変えていないか）は [packages/webrtc/src/negotiation/descriptionValidation.ts:42](review-file:packages/webrtc/src/negotiation/descriptionValidation.ts:42) です。payload type と extmap の再割当ての拒否は [packages/webrtc/src/sdpManager.ts:376](review-file:packages/webrtc/src/sdpManager.ts:376) と [packages/webrtc/src/sdpManager.ts:346](review-file:packages/webrtc/src/sdpManager.ts:346) にあります。

remote m-line の適用は 4 段階です。入口は [packages/webrtc/src/negotiation/remoteMediaApplication.ts:85](review-file:packages/webrtc/src/negotiation/remoteMediaApplication.ts:85) です。

1. transceiver / SCTP との対応付け: [packages/webrtc/src/negotiation/remoteMediaApplication.ts:117](review-file:packages/webrtc/src/negotiation/remoteMediaApplication.ts:117)
2. BUNDLE の transport 所有: [packages/webrtc/src/negotiation/remoteMediaApplication.ts:218](review-file:packages/webrtc/src/negotiation/remoteMediaApplication.ts:218)
3. RTP / SCTP の受け入れ判定（codec 計画の結果を使う）: [packages/webrtc/src/negotiation/remoteMediaApplication.ts:322](review-file:packages/webrtc/src/negotiation/remoteMediaApplication.ts:322)
4. transport パラメータ更新の計画（実行は呼び出し側）: [packages/webrtc/src/negotiation/remoteMediaApplication.ts:369](review-file:packages/webrtc/src/negotiation/remoteMediaApplication.ts:369)

local 側の入口は [packages/webrtc/src/peerConnection.ts:798](review-file:packages/webrtc/src/peerConnection.ts:798) です。

### 2.3 ルーティングキーの staging（pending は追加だけ、変更は拒否か保留）

レビューが収束しなかった主な原因は、pending 中に、current が使っている共有 live table へ直接書き込み、rollback で snapshot から戻す方式だったことです。キーの種類ごとに、次の規則でまとめて閉じました。

- pending は、キーを**追加**してよい（暫定 RTP のため、すぐ有効）。
- current が使っているキーの値は、最終 answer まで変えない。変える提案は、適用前に拒否するか、commit まで保留（staged）する。

| キー | 扱い | 実装 |
| --- | --- | --- |
| payload type → codec | 再割当ては拒否。fmtp / rtcp-fb の変更は保留 | [packages/webrtc/src/media/rtpReceiver.ts:157](review-file:packages/webrtc/src/media/rtpReceiver.ts:157) |
| extmap ID → URI | 再割当ては拒否 | [packages/webrtc/src/sdpManager.ts:346](review-file:packages/webrtc/src/sdpManager.ts:346) |
| SSRC → receiver / RTX 対応 | 別の m-line への付け替えは保留 | [packages/webrtc/src/media/router.ts:188](review-file:packages/webrtc/src/media/router.ts:188) |
| MID+RID → receiver | RID は m-line 単位のキー | [packages/webrtc/src/media/router.ts:31](review-file:packages/webrtc/src/media/router.ts:31) |
| sender SSRC → sender | アプリ側の状態として rollback 後も維持 | [packages/webrtc/src/media/router.ts:107](review-file:packages/webrtc/src/media/router.ts:107) |
| PLI 判定 | その SSRC の live な受信 codec に従う | [packages/webrtc/src/media/rtpReceiver.ts:527](review-file:packages/webrtc/src/media/rtpReceiver.ts:527) |

staged route は [packages/webrtc/src/media/router.ts:68](review-file:packages/webrtc/src/media/router.ts:68) で commit 時に切り替わります。後から来た remote pranswer / answer は、先の pranswer が staged した値を [packages/webrtc/src/negotiationTransaction.ts:339](review-file:packages/webrtc/src/negotiationTransaction.ts:339) で破棄してから適用します。

### 2.4 ICE generation（restart / pranswer / trickle / EOC）

- ICE restart は、offer の時点では資格情報を stage するだけで、live の ICE は answer の commit で切り替えます。pranswer は、選択中の pair を保ったまま provisional generation の check を進めます。
- provisional の check は、送信時の checklist（revision と pair の所属）にだけ効きます。replacement pranswer より前の遅延応答は、新しい checklist を nominate しません。実装は [packages/ice/src/ice.ts:397](review-file:packages/ice/src/ice.ts:397) です。
- EOC は、live と provisional のどちらの generation も完了させます（RFC 8838）。EOC 後の候補は、SDP にも checklist にも入りません。EOC より前に届いて mDNS を解決中の候補は保持し、generation の完了はその解決を待ちます。実装は [packages/ice/src/ice.ts:303](review-file:packages/ice/src/ice.ts:303)、[packages/ice/src/ice.ts:281](review-file:packages/ice/src/ice.ts:281)、[packages/webrtc/src/secureTransportManager.ts:322](review-file:packages/webrtc/src/secureTransportManager.ts:322) です。
- trickle ICE は、候補が対象とする m-line の ufrag で、current と pending のどちらの generation に属するかを決めます。実装は [packages/webrtc/src/negotiation/remoteCandidates.ts:60](review-file:packages/webrtc/src/negotiation/remoteCandidates.ts:60) です。EOC は transport 単位で BUNDLE group 全体に及びます（[packages/webrtc/src/negotiation/remoteCandidates.ts:234](review-file:packages/webrtc/src/negotiation/remoteCandidates.ts:234)）。
- `restartIce()` は、current と pending のローカル ufrag を置き換え対象として記録します（W3C の `[[LocalIceCredentialsToReplace]]`）。rollback や glare の後も要求は残ります。実装は [packages/webrtc/src/negotiation/iceRestartRequest.ts:18](review-file:packages/webrtc/src/negotiation/iceRestartRequest.ts:18) と [packages/webrtc/src/peerConnection.ts:1228](review-file:packages/webrtc/src/peerConnection.ts:1228) です。

### 2.5 BUNDLE topology

- BUNDLE group は最初のものだけでなく、すべての group を扱います。group の tag が member の transport を決めます: [packages/webrtc/src/negotiation/bundleTopology.ts:32](review-file:packages/webrtc/src/negotiation/bundleTopology.ts:32)
- 分割・統合・新しい owner は、local offer では [packages/webrtc/src/negotiation/bundleTopology.ts:76](review-file:packages/webrtc/src/negotiation/bundleTopology.ts:76)、remote re-offer では [packages/webrtc/src/negotiation/bundleTopology.ts:191](review-file:packages/webrtc/src/negotiation/bundleTopology.ts:191) で準備し、answer の commit で切り替えます。
- offer で共有した transport を answer が分割することは拒否します: [packages/webrtc/src/negotiation/bundleTopology.ts:249](review-file:packages/webrtc/src/negotiation/bundleTopology.ts:249)
- 所有のためだけに作った transport は、rollback で閉じます: [packages/webrtc/src/peerConnection.ts:1466](review-file:packages/webrtc/src/peerConnection.ts:1466)

### 2.6 develop の issue 705（m-line 拒否・停止・再利用）との統合

develop のマージ（`c580f5d2`）でコンフリクトを解消したとき、705 の挙動の大半が落ちていました。これを transaction の中で動くように復元しました。

- 拒否予定（`pendingRejection`）を baseline に含めました。rollback の所有者は transaction だけにしています。
- remote が port 0 で出した m-line は拒否予定にします。
- アプリの再利用は、kind が一致し、停止が確定した位置だけにしました: [packages/webrtc/src/transceiverManager.ts:395](review-file:packages/webrtc/src/transceiverManager.ts:395)
- `setRemoteRTP` の受け入れ判定: [packages/webrtc/src/transceiverManager.ts:853](review-file:packages/webrtc/src/transceiverManager.ts:853)

意図した挙動変更（705 単独のときとの違い）は 3 点あり、チケットの 2.5 章に表で記載しています。

| 点 | 705 単独 | 本チケット | 根拠 |
| --- | --- | --- | --- |
| 確立済み member を BUNDLE 外へ出す re-offer | 拒否 | staged topology として受理 | RFC 8843 §7.5 |
| 使用中の payload type の codec 付け替え | 受理して拒否予定 | 適用前に拒否 | RFC 3264 §8.3.2 |
| group 外 m-line の answer の `a=setup` | 常に `active` | offer の逆 | RFC 8842 §5.3 |

### 2.7 develop の codec 統合（`setCodecPreferences()` / track source codec）との統合

最新の develop のマージ（`64f374a3`）と CI 対応（`d5cd6112`）で取り込みました。codec の解決は develop の方式に合わせ、適用する時期をこのチケットの規則（pending 中は current を保つ）に合わせています。

- **remote description：** 全 m-line の codec を、適用前に副作用なしで決めます（`planRemoteRtpCodecs`）。決めた結果を受け入れ判定で使います。計画: [packages/webrtc/src/transceiverManager.ts:788](review-file:packages/webrtc/src/transceiverManager.ts:788)、呼び出し: [packages/webrtc/src/negotiation/remoteMediaApplication.ts:69](review-file:packages/webrtc/src/negotiation/remoteMediaApplication.ts:69)
- **受信設定：** pending の offer / pranswer では、新しいキーの追加だけを行います。受信 codec 表の置き換え（`resyncCodecs`）は、remote answer または commit の時点でだけ行います: [packages/webrtc/src/media/rtpReceiver.ts:279](review-file:packages/webrtc/src/media/rtpReceiver.ts:279)
- **`createAnswer()`：** answer 用の codec を transceiver の提案として解決するだけです（[packages/webrtc/src/transceiverManager.ts:733](review-file:packages/webrtc/src/transceiverManager.ts:733)、呼び出しは [packages/webrtc/src/peerConnection.ts:1569](review-file:packages/webrtc/src/peerConnection.ts:1569)）。sender・受信 codec / RTX 表・TWCC・remote track の codec は、local answer の commit で切り替えます（[packages/webrtc/src/transceiverManager.ts:760](review-file:packages/webrtc/src/transceiverManager.ts:760)、呼び出しは [packages/webrtc/src/peerConnection.ts:981](review-file:packages/webrtc/src/peerConnection.ts:981)）。develop 単独では `createAnswer()` の時点で切り替えていたので、これは pending 中の current RTP を守るための意図した挙動変更です。
- **rollback：** `pendingLocalOfferCodecs` と再解決の要求（`codecPreferencesNeedResolution`）を baseline に含めます。`setCodecPreferences()` 自体はアプリの選択なので戻しません。
- **回帰テスト：** [packages/webrtc/tests/integrate/negotiationTransactionRegression.test.ts:674](review-file:packages/webrtc/tests/integrate/negotiationTransactionRegression.test.ts:674)

### 2.8 `negotiationneeded` と設定

- 同じ tick の変更はまとめて 1 回だけ発火します。確定した local offer が含んでいた変更は、通し番号で「交渉済み」として扱います: [packages/webrtc/src/negotiation/negotiationNeeded.ts:12](review-file:packages/webrtc/src/negotiation/negotiationNeeded.ts:12)
- `setConfiguration` の検証とマージは純粋関数にしました: [packages/webrtc/src/api/peerConfig.ts:343](review-file:packages/webrtc/src/api/peerConfig.ts:343)

### 2.9 モジュール構成

`peerConnection.ts`（3,514 行）を責務ごとに分割しました。`src/negotiation/` には交渉用の内部サブシステム、`src/api/` には公開型（設定とイベント）を置いています。transport の起動処理は [packages/webrtc/src/negotiation/transportActivation.ts:23](review-file:packages/webrtc/src/negotiation/transportActivation.ts:23) にあります。対応表は [packages/webrtc/NEGOTIATION_TRANSACTION.md:339](review-file:packages/webrtc/NEGOTIATION_TRANSACTION.md:339) です。

`negotiationTransaction.ts` も 653 行から 440 行に整理しました（2.1 章のとおり、snapshot を各コンポーネントへ移し、提案の資源を `ProposalResources` にまとめたため）。状態の持ち主の表は [packages/webrtc/NEGOTIATION_TRANSACTION.md:358](review-file:packages/webrtc/NEGOTIATION_TRANSACTION.md:358) です。

## 3. 判断理由

- **live に書いて rollback で戻す方式から、stage して commit する方式へ。** live に書いて rollback で戻す方式では、rollback 後の状態しか守れず、pending 中の current の通信は守れません。キーの種類ごとに「追加は即時、変更は拒否か保留」と決めることで、反例を個別に塞ぐのではなく、種類ごとにまとめて閉じました。develop の codec 統合も、同じ規則に合わせて commit 時に切り替えています。
- **拒否と保留の判断は RFC と Chrome の実機挙動に合わせました。** extmap ID の再割当ては拒否します（RFC 8285 §7、Chrome も拒否）。SSRC の移動と RTX の付け替えは保留します（Chrome は受理）。
- **状態の snapshot は持ち主に置きました。** transaction が他のオブジェクトのプロパティを列挙すると、状態を足すたびに漏れが起きます（実際に develop の codec 統合で修正が必要になりました）。持ち主の snapshot / restore の組だけを直せば済む形にしています。
- **invariant helper で機械的に検出します。** 各操作の後に、current SDP と live 状態の一致を検査します。対象は、SSRC / RTX / MID+RID / extmap、受信 codec（fmtp と RTCP feedback まで）、PLI の判定、未停止の sender の経路、ICE の credential / candidate / EOC / checklist、DTLS、SCTP です: [packages/webrtc/tests/integrate/negotiationTransactionUtils.ts:463](review-file:packages/webrtc/tests/integrate/negotiationTransactionUtils.ts:463)、ルーティング表の検査は [packages/webrtc/tests/integrate/negotiationTransactionUtils.ts:532](review-file:packages/webrtc/tests/integrate/negotiationTransactionUtils.ts:532)
- **自分で反例を探索します。** seed 固定の property test で、ランダムな操作列（offer / pranswer / answer / rollback / replacement、ICE restart、BUNDLE の分割と統合、EOC、ルーティングキーの変更）を実行し、各操作の後に invariant を、各ステップの後に実通信を検査します: [packages/webrtc/tests/integrate/negotiationTransactionUtils.ts:1436](review-file:packages/webrtc/tests/integrate/negotiationTransactionUtils.ts:1436)。CI では固定 seed と回帰 seed を再生します: [packages/webrtc/tests/integrate/negotiationTransactionProperty.test.ts:34](review-file:packages/webrtc/tests/integrate/negotiationTransactionProperty.test.ts:34)
- **完了条件を有限にしました。** 遷移表・mutation matrix・操作カタログに載っていない新しい組み合わせは、後続チケットとして扱います（設計文書の Scope 章、チケットの 6 章）。

## 4. リスク・既知の制約

- 相互運用は Chrome でしか確認していません。Firefox や Safari は対象外です。
- extmap の ID 対応表は PeerConnection 全体で 1 つです。BUNDLE しない別の transport で同じ ID を別の URI に使う構成には対応していません。
- ICE restart の commit で旧 pair を手放すため、新しい generation が nominate するまで RTP が途切れます。
- SCTP association を持たない接続済み session で後から作った DataChannel は、再交渉しても開きません（develop から既存の問題）。
- PLI の判定は werift の既存規則のままで、`nack` 系の feedback が交渉されていれば送ります。
- 状態の snapshot 用の型（`TransceiverNegotiationState`、`ReceiverNegotiationState`、`TransceiversNegotiationState`、`RouterSnapshot`）は、`media/index.ts` の `export *` を通じて型として公開されています。実行時の値は増えていません。
- WPT は runner 判定で REGRESSION 0 です。ただし、最後に実行したのは develop の codec 統合をマージする前です。upstream WPT の FAIL や TIMEOUT はまだ多く残っており、件数は実行時の負荷で変動します。

## 5. 検証結果

`negotiationTransaction.ts` のリファクタリング（`98247860`）の時点での結果です。

| 検証 | 結果 |
| --- | --- |
| webrtc の型検査、全テスト | 561 passed / 3 skipped |
| 深い property 探索（300 seed × 20 step） | 303 / 303 passed |
| workspace の `npm run type` / `npm run test:small` | 全パッケージ成功 |
| Chrome E2E | 46 / 46 passed |
| WPT（allowlist） | REGRESSION 0（PASS 443、codec 統合のマージ前に実行） |

主なテストファイル:

- 遷移マトリクス: [packages/webrtc/tests/integrate/negotiationTransactionMatrix.test.ts](review-file:packages/webrtc/tests/integrate/negotiationTransactionMatrix.test.ts)
- ルーティングキー: [packages/webrtc/tests/integrate/negotiationTransactionRouting.test.ts:18](review-file:packages/webrtc/tests/integrate/negotiationTransactionRouting.test.ts:18)
- 決定的な回帰テスト（レビュー指摘の再現を含む）: [packages/webrtc/tests/integrate/negotiationTransactionRegression.test.ts:27](review-file:packages/webrtc/tests/integrate/negotiationTransactionRegression.test.ts:27)
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
| `98247860` | （依頼）`negotiationTransaction.ts` のリファクタリング | snapshot を各コンポーネントへ移し、提案の資源を集約 — [packages/webrtc/src/negotiationTransaction.ts](review-diff:packages/webrtc/src/negotiationTransaction.ts:commit:98247860) |
