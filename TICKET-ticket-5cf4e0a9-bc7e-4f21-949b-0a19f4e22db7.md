# PeerConnection negotiation transaction invariant の明文化と state machine 整理

関連:
- Issue #705: https://github.com/shinyoshiaki/werift-webrtc/issues/705
- PR #711: https://github.com/shinyoshiaki/werift-webrtc/pull/711
- 分離元: `TICKET-ticket-4502cb15-1c26-483f-9742-2294e86e343e.md`

## 1. 背景

PR #711 では、非対応 RTP m-line を Answer 側で reject する修正を起点に、rollback、replacement offer/pranswer、ICE restart、BUNDLE membership、SCTP、candidate/EOC generation などの整合性問題が連鎖的に露出した。

現在は `pendingRemoteDescription` / `pendingLocalDescription` に加え、transceiver/router の snapshot、staged ICE/DTLS/SCTP state、candidate/EOC bucket などが個別に transaction を模倣している。そのため、ある subsystem の修正が別 subsystem の current/pending 境界を破る、rollback baseline と latest pending state を混同する、commit 順序によって answer SDP と live transport が不一致になる、といった問題が発生しやすい。

このチケットでは、個別症状を追加 patch で塞ぎ続けるのではなく、**PeerConnection negotiation 全体の transaction invariant を先に明文化し、その invariant に沿って state machine と実装責務を整理する。**

## 2. 目的

- `current / pending / rollback baseline / commit` の意味を PeerConnection 全体で統一する
- RTP / transceiver / router / BUNDLE / ICE / DTLS / SCTP / trickle ICE が同じ transaction lifecycle に従うようにする
- offer / pranswer / replacement offer/pranswer / final answer / rollback の commit 境界を明確にする
- pending negotiation が既存の committed session を意図せず破壊しないことを構造的に保証する
- rollback が subsystem ごとの ad-hoc snapshot 実装に依存しない設計へ整理する
- commit と rollback の ordering を一箇所で管理し、partial commit を防ぐ
- 将来の SDP/transport 機能追加時に invariant test で regression を検出できるようにする

## 3. 対象外

このチケットは negotiation transaction の設計整理であり、以下は直接の目的にしない。

- ICE connectivity check / nomination algorithm 自体の全面書き換え
- DTLS protocol implementation 自体の全面書き換え
- SCTP congestion control / association 実装そのものの再設計
- codec / RTP packetizer / jitter buffer / TWCC bandwidth estimation の再設計
- 新しい公開 WebRTC API の追加
- unrelated な performance optimization
- 全 WPT failure の一括解消

ただし、transaction invariant を満たすために各 subsystem の API 境界を整理する変更は対象とする。

## 4. Transaction invariant

実装前に以下を設計ドキュメントとして確定し、コード・テストの共通判断基準にする。

### 4.1 状態の分類

PeerConnection の negotiation state を最低限次の概念に分ける。

- **committed/current state**
  - currentLocalDescription / currentRemoteDescription と整合する、現在通信に使用してよい状態
  - 現在の RTP/RTCP、ICE/DTLS、SCTP/DataChannel の通信継続性を表す
- **pending state**
  - pendingLocalDescription / pendingRemoteDescription に対応する未確定状態
  - replacement offer/pranswer では latest pending description に追従する
  - committed state を破壊せず、commit まで独立して保持できること
- **rollback baseline**
  - negotiation transaction 開始直前の committed state
  - transaction 中に replacement offer/pranswer が複数回適用されても上書きしない（first-wins）
- **speculative resource / irreversible side effect**
  - pending negotiation 中に作成可能な transport、transceiver、track、event 等
  - rollback 可能な state と、仕様上巻き戻せない observable side effect を明示的に区別する

### 4.2 commit 境界

- remote offer に対する transaction は、対応する final local answer の適用時に commit する
- local offer に対する transaction は、対応する final remote answer の適用時に commit する
- pranswer は provisional state であり committed baseline を置き換えない
- replacement offer / replacement pranswer は pending state を latest-wins で更新するが、rollback baseline は維持する
- final answer commit は SDP description と media/transport state を同一 transaction として確定する
- validation failure の場合、committed state と rollback baseline を変更しない
- commit 途中の失敗で subsystem ごとの部分 commit を残さない

### 4.3 rollback

- rollback は transaction 開始前の committed state と等価な通信状態へ戻す
- pending-only resource は停止・detach・GC 対象にする
- committed session の RTP/RTCP、ICE selected pair、DTLS、SCTP association を pending operation の副作用で壊さない
- rollback 後に pending candidate/EOC、staged credentials、pending BUNDLE mapping 等を残さない
- 既に外部へ発火した event など「取り消せない副作用」は一覧化し、その後の内部 state が二重発火や重複 object を生まない invariant を定める

### 4.4 RTP / transceiver / router

- negotiated codecs、header extensions、encodings、direction、MID/mLineIndex、rejected/stopping/stopped を current と pending で混同しない
- pending re-offer が current RTP pipeline を停止・再登録しない
- pending 中に必要な receiver/sender/router mapping は speculative state として扱い、commit/rollback の owner を明確にする
- rejected m-line、stopped transceiver、m-line reuse は committed negotiation の結果としてのみ recycling eligibility に反映する
- `negotiationneeded` は application 操作と内部 description application を区別し、transaction commit 後に一貫した state から再計算する

### 4.5 BUNDLE / transport ownership

- committed BUNDLE membership / identification-tag と pending proposal を分離する
- candidate routing、transport ownership、MID/mLineIndex label は committed mapping を使う場面と pending mapping を使う場面を明文化する
- membership/tag 変更は final answer commit まで live transport topology を破壊しない
- rollback では BUNDLE split/merge 前の transport ownership を復元し、pending-only transport は停止する
- shared ICE/DTLS transport を、一つの m-line reject/stop だけで破棄しない

### 4.6 ICE generation

ICE state は credential だけでなく、最低限次を同一 generation として扱う。

- local ufrag/password
- remote ufrag/password
- remote candidates
- end-of-candidates
- checklist / candidate pair
- selected/nominated pair
- gathering/checking generation に紐づく state

Invariant:

- current generation と pending generation を混ぜない
- old-generation candidate を new generation へ carry-over しない
- explicit `usernameFragment` は該当 generation へ、未指定 candidate/EOC は JSEP/WebRTC の規則に従い most-recent applicable generation へ解決する
- remote ICE restart を answer する場合、answer に広告する local credentials/candidates と commit 後 live generation が一致する
- restart commit 後に新 checklist が確実に開始され、DTLS の既存状態が ICE restart 開始を短絡しない
- rollback では current generation の connectivity を維持し、pending generation の candidate/EOC/checklist を破棄する

### 4.7 DTLS

- remote fingerprint / role / parameters は pending SDP の適用だけで committed transport を置き換えない
- replacement description では pending DTLS state は latest-wins
- rollback baseline は first-wins
- ICE restart と DTLS reuse/restart の関係を明文化し、`connected` という旧状態だけを理由に新 ICE generation の start を skip しない
- commit 時に SDP で合意した fingerprint/role と live transport が一致する

### 4.8 SCTP / DataChannel

- SCTP port、max-message-size、MID/mLineIndex、DTLS transport binding の current/pending を分ける
- 既存 association の port change を未対応とする場合は live state を変更する前に validation で reject する
- pending max-message-size 等は final answer commit まで current association に反映しない
- rollback では current association を保持し、pending-only SCTP transport を停止する
- DataChannel object/event のうち rollback 不可能な observable side effect を明文化する

### 4.9 validation と atomicity

- SDP 全体の cross-field validation を可能な限り live mutation 前に完了する
- subsystem ごとに勝手に snapshot → mutate → restore するのではなく、PeerConnection transaction coordinator が stage / validate / commit / rollback の順序を管理する
- 同じ description を再適用した場合や duplicate trickle 等の idempotency 方針を定義する
- commit/rollback の各 phase は例外発生時の状態を定義し、「半分だけ新 generation」の状態を許容しない

## 5. 状態遷移表を先に作る

実装変更より先に、少なくとも以下の遷移について表を作成する。

| Flow | baseline | pending | commit / rollback 後 |
| --- | --- | --- | --- |
| initial offer → answer | none/current empty | first pending | negotiated current |
| local re-offer → answer | current A | pending B | current B |
| remote re-offer → local answer | current A | pending B | current B |
| offer → pranswer → answer | current A | provisional B | final B |
| offer A → replacement offer B → answer | current A | latest B | current B |
| offer A → replacement offer B → rollback | current A | latest B | current A |
| ICE restart offer → answer | ICE gen A | ICE gen B | ICE gen B |
| ICE restart offer → rollback | ICE gen A | ICE gen B | ICE gen A |
| BUNDLE membership/tag change | topology A | proposed topology B | B or A |
| RTP reject/stop/m-line reuse | media A | proposed reject/reuse | deterministic current |
| SCTP parameter re-offer | SCTP A | pending SCTP B | B or reject/rollback |

各行について RTP、BUNDLE、ICE、DTLS、SCTP、candidate/EOC、event の owner と mutation timing を記載する。

## 6. 実装方針

### 6.1 transaction coordinator を一級概念にする

`RTCPeerConnection` 内に散在している snapshot/staged field を、単一 transaction の lifecycle から管理できる構造へ集約する。

例:

```ts
interface NegotiationTransaction {
  baseline: NegotiationBaseline;
  pendingLocal?: PendingLocalState;
  pendingRemote?: PendingRemoteState;
  media: PendingMediaState;
  transports: PendingTransportState;
  bundle: PendingBundleState;
  sctp?: PendingSctpState;
}
```

型名・配置は実装時に決めてよいが、少なくとも以下の操作を一箇所から追えるようにする。

- begin
- replace/update pending
- validate
- commit
- rollback
- cleanup

### 6.2 manager API を stage / commit / rollback に揃える

対象候補:

- `SDPManager`
- `TransceiverManager`
- `SecureTransportManager`
- `SctpTransportManager`
- `RTCIceTransport`
- `RTCDtlsTransport`
- `RtpRouter`

現在の `snapshotXxx()/restoreXxx()` と mutable setter の組み合わせを棚卸しし、どの state が committed / pending / packet-driven runtime かを分類する。

packet-driven runtime state をすべて deep-copy することを目的にはせず、「pending negotiation が触ってよい state」を減らすことで snapshot 対象そのものを縮小する。

### 6.3 commit ordering を固定する

commit 順序は設計ドキュメントとコードで一箇所に固定する。最低限以下を検討する。

1. final SDP validation
2. BUNDLE / transport ownership 決定
3. ICE generation commit
4. DTLS parameters / lifecycle commit
5. SCTP binding/parameters commit
6. RTP/transceiver/router commit
7. descriptions / signaling state の確定
8. orphan speculative resource cleanup
9. negotiationneeded の再計算
10. commit 後にのみ許される event / connect kick

実際の順序は spec と既存 API に合わせて決定するが、複数箇所から独立に commit しない。

### 6.4 既存の ad-hoc state を段階的に削除する

一度に全面置換せず、次の順で移行する。

1. invariant test と transition matrix を追加
2. transaction container を導入
3. ICE/DTLS generation state を移行
4. BUNDLE/transport ownership を移行
5. RTP/transceiver/router state を移行
6. SCTP state を移行
7. legacy snapshot/staged field を削除
8. duplicate rollback/cleanup code を削除

各段階で外部 observable behavior を変えないこと。

## 7. 必須テスト

### 7.1 invariant helper

テスト専用に `assertNegotiationInvariants(pc)` 相当を用意し、少なくとも以下を検査できるようにする。

- current descriptions と live transport/media state の整合
- pending state が current generation を上書きしていない
- BUNDLE owner / MID / mLineIndex の一意性
- ICE candidate/EOC と ufrag generation の整合
- no orphan live transport
- stopped/rejected transceiver と router registration の整合
- SCTP association と negotiated parameters の整合

### 7.2 transition matrix tests

以下を local-offerer / remote-offerer の両方向で可能な範囲まで検証する。

- initial offer/answer
- re-offer/answer
- pranswer → replacement pranswer → final answer
- replacement offer → commit
- replacement offer → rollback
- unsupported codec reject
- port 0 reject
- transceiver.stop / m-line reuse
- partial BUNDLE / tag preservation / split / merge
- ICE restart commit
- ICE restart rollback
- answer 前 trickle candidate/EOC
- current generation への遅延 trickle
- DTLS fingerprint/role replacement
- SCTP max-message-size
- unsupported SCTP port change
- pending-only RTP/SCTP transport cleanup

### 7.3 実通信テスト

state field の assert だけではなく、少なくとも次を実通信で確認する。

- re-offer/rollback 中も current RTP が継続する
- ICE restart commit 後に新 generation で nomination が完了し RTP が再開する
- rollback 後に旧 selected pair で RTP が継続する
- BUNDLE split/merge 後の各 MID が正しい transport で通信する
- DataChannel が許容された renegotiation 後も送受信できる

## 8. 完了条件

- [ ] transaction invariant と状態遷移表が設計ドキュメントとして追加されている
- [ ] current / pending / rollback baseline / speculative side effect の定義が全 subsystem で共有されている
- [ ] negotiation transaction の begin / replace / validate / commit / rollback / cleanup を一箇所から追える
- [ ] replacement offer/pranswer が pending latest-wins、rollback baseline first-wins になっている
- [ ] final answer commit が RTP/BUNDLE/ICE/DTLS/SCTP を部分 commit しない
- [ ] rollback 後に committed session と等価な通信状態へ戻る
- [ ] remote/local ICE restart の commit 後に実際の ICE checklist/nomination が新 generation で進行する
- [ ] answer SDP の ICE credentials/candidates/EOC と commit 後 live generation が一致する
- [ ] BUNDLE membership/tag と transport ownership が current/pending で混同されない
- [ ] RTP/transceiver/router state が pending negotiation で current pipeline を破壊しない
- [ ] SCTP current association が pending description で早期変更されない
- [ ] internal description application が不要な negotiationneeded loop を起こさない
- [ ] invariant helper と transition matrix tests が追加されている
- [ ] ICE restart、rollback、BUNDLE、RTP、DataChannel の実通信回帰テストが通る
- [ ] migration 完了後、不要になった ad-hoc snapshot/staged fields と duplicate cleanup code が削除されている
- [ ] `packages/webrtc` の type/test と関連 E2E が green
- [ ] CI dependency failure がある場合は先に解消し、transaction tests が CI 上で実行される

## 9. #705 / PR #711 との境界

このチケットは #705 の完了条件ではない。

#705 / PR #711 では、非対応 RTP m-line の reject、m-line reuse、そこで直接必要になった限定的な correctness fix と回帰テストまでを対象とする。PeerConnection negotiation 全体の transaction abstraction、ICE/DTLS restart orchestration の全面整理、全 subsystem の atomic commit/rollback 統一はこのチケットへ分離する。

#711 のレビュー中に、#705 の主要フローを成立させるための局所修正を越えて「汎用 transaction state machine の再設計」が必要だと判明した事項は、本チケットへ記録し、#711 の scope を無制限に拡大させない。
