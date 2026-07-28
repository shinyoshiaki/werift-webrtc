# ICE consent freshness を RFC 7675 準拠にし、ICE-lite 相手との長時間接続を安定化する

## 1. タスクの目的と背景

[stack-chan-dock の調査文書](https://github.com/meganetaaan/stack-chan-dock/blob/bf7795242f475b679a777a997cd023b7bc5967bc/bridge/codex-stackchan-voice/docs/WEBRTC_TRANSPORT.md)では、`werift` 0.24.1 が OpenAI の ICE-lite endpoint と接続した際、ICE consent freshness の不整合によって約30秒で接続が切れると報告されている。下流では `postinstall` パッチを当て、heartbeat なしで90秒接続できることを確認している。

調査対象の本リポジトリは `fa9113780f0b227244b10bbb23079ab832c1c2f1f`（`v0.24.1`）であり、報告対象と同じ実装が現在の HEAD に残っている。静的調査の結果、**主要4点は現行コードと RFC 7675 の不一致として妥当であり、上流での修正が必要**と判断する。5点目の `USE-CANDIDATE` は RFC 7675 の必須要件ではないが、libwebrtc と OpenAI ICE-lite endpoint で観測された相互運用条件として、仕様修正とは分けて対応する価値がある。

### 妥当性の確認結果

| 指摘 | 判定 | 現行実装・仕様との対応 |
| --- | --- | --- |
| 最初の STUN timeout で監視ループを抜ける | 妥当 | `packages/ice/src/ice.ts:762-768` が1回の失敗で `disconnected` にして `break` するため、以後の consent request と30秒失効判定が行われない。RFC 7675 は個々の request が失われ得ることを前提としている。 |
| 再送0回が50msの応答期限になる | 妥当 | consent request は `retransmissions = 0` で呼ばれる一方、`Transaction` は `RETRY_RTO = 50` ms 後に timeout する（`packages/ice/src/stun/transaction.ts:11-25,52-68`、`packages/ice-server/src/stun/const.ts:9-10`）。RFC 7675 は推定 RTT と遅延変動を考慮した待機を求め、RFC 8445 は ICE の RTO を500ms未満にしてはならない。 |
| 応答待ち後に次の4〜6秒を測る | 妥当 | `packages/ice/src/ice.ts:725-756` は sleep と request 完了待ちを直列化しており、request 開始間隔が「4〜6秒 + 応答待ち」になる。RFC 7675 の check interval は4〜6秒で、失効 timer とも独立していなければならない。 |
| 6回の失敗数で30秒失効を近似する | 妥当 | `CONSENT_FAILURES = 6`（`packages/ice/src/iceBase.ts:174-175`）では4秒周期なら24秒、6秒周期なら36秒となる。さらに現状は最初の失敗でループを抜けるため、この分岐自体が実質到達不能である。RFC 7675 は最後の有効な応答から30秒での失効を要求する。 |
| ICE-lite の選択済み経路へ `USE-CANDIDATE` を付け続ける | 条件付きで妥当 | 現行 consent request は常に `nominate: false`（`packages/ice/src/ice.ts:736-742`）。RFC 7675 自体は定期的な再指名を要求しない。一方、libwebrtc の `BasicIceController::GetUseCandidateAttr` は semi-aggressive nomination で、remote が ICE-lite の場合に selected かつ writable な pair へ `USE-CANDIDATE` を付ける。下流の属性あり／なし対照試験でも接続維持に差が出ているため、controlling・remote ICE-lite・現在の selected pair に限定した相互運用処理として扱う。 |

また、調査中に次の関連問題も確認したため、本修正に含める。

- `StunOverTurnProtocol.request()` は `retransmissions` 引数を無視して `Transaction` へ `undefined` を渡す（`packages/ice/src/turn/protocol.ts:84-106`）。選択 pair が TURN relay の場合、consent request が「一度だけ送信」という RFC 7675 の要件を満たさない。
- consent 失効時に低レベル ICE state を `closed` にしている（`packages/ice/src/ice.ts:770-774`）。`packages/webrtc/src/peerConnection.ts:251-254` は ICE の `closed` を PeerConnection 全体の明示 close として扱う。WebRTC 仕様上、consent を失った transport は `failed` であり、`closed` は明示的に transport を停止した状態である。また、失効後は同じ5-tupleへ application data を送ってはならない。

### 参照仕様・実装

- [RFC 7675 Section 5.1 — Expiration of Consent](https://www.rfc-editor.org/rfc/rfc7675.html#section-5.1)
- [RFC 5389 Section 7.2.1 — Sending over UDP](https://www.rfc-editor.org/rfc/rfc5389.html#section-7.2.1)
- [RFC 8445 Section 14.3 — RTO](https://www.rfc-editor.org/rfc/rfc8445.html#section-14.3)
- [RFC 8445 Section 7.1.2 / 8.1.1 — USE-CANDIDATE と nomination](https://www.rfc-editor.org/rfc/rfc8445.html#section-8.1.1)
- [WebRTC 1.0 — RTCIceTransportState](https://w3c.github.io/webrtc-pc/#rtcicetransportstate)
- [libwebrtc BasicIceController](https://webrtc.googlesource.com/src/+/c18b45b7bde1efe5d14b3932c18bb9942c0ede7c/p2p/base/basic_ice_controller.cc)
- [下流の暫定パッチ](https://github.com/meganetaaan/stack-chan-dock/blob/bf7795242f475b679a777a997cd023b7bc5967bc/bridge/codex-stackchan-voice/scripts/patch-werift-consent.mjs)
- [下流の回帰テスト](https://github.com/meganetaaan/stack-chan-dock/blob/bf7795242f475b679a777a997cd023b7bc5967bc/bridge/codex-stackchan-voice/test/werift-consent.spec.ts)

## 2. 実装すべき具体的な機能や変更内容

### A. consent freshness のスケジューラを時間基準へ変更する

`packages/ice/src/ice.ts` の `queryConsent()` を、失敗回数ではなく次の2つの独立 timer で管理する。

1. **request 開始 timer**
   - basic period 5秒を `0.8〜1.2` 倍し、各 request の開始間隔を4〜6秒にする。
   - 応答完了時刻ではなく、直前の request 開始時刻を基準に次回期限を計算する。
   - 個別 request の timeout が発生しても監視を継続する。
   - request ごとに新しい STUN transaction ID を使い、一度だけ送信する。

2. **consent expiry timer**
   - 初期 ICE check の有効応答を起点に30秒の期限を開始する。
   - selected pair から matching・authenticated・non-error response を受信するたび、最後の有効応答から30秒へ更新する。
   - request の送信回数、連続失敗数、4〜6秒の揺らぎとは独立させる。
   - pair、ICE generation、credentials が切り替わった後に到着した古い response で現在の期限を更新しない。
   - `restart()`、`close()`、selected pair の切替時には request timer、expiry timer、未完了 transaction を確実に破棄する。

`CONSENT_FAILURES` は公開 export であるため即時削除による互換性破壊は避ける。内部の失効判定では使用せず、必要なら deprecated として残し、代わりに30秒の期限を表す定数を追加する。

### B. 「送信回数」と「応答待ち時間」を分離する

`packages/ice/src/stun/transaction.ts` と `packages/ice/src/types/model.ts` の transaction/request 設定に、少なくとも以下を独立に表現できる option を追加する。

- STUN packet の再送回数
- response を待つ期限
- cancel 用 signal または同等の明示的な中断手段
- request 送信 callback

既存の positional 引数を利用するコードとの後方互換性は維持する。consent request では再送回数を0にしつつ、response timeout は推定 RTT と遅延変動を考慮する。RTT 情報が不足する場合でも RFC 8445 の下限500msを下回らない保守的な既定値（下流で実証済みの1秒を候補）を用いる。`retransmissions === 0` という値そのものへ一律に1秒を暗黙設定するのではなく、consent usage が明示的に timeout を渡せる形にする。

次の実装が同じ設定を尊重するよう統一する。

- `StunProtocol`
- `TcpActiveProtocol` / `TcpPassiveProtocol`
- `StunOverTurnProtocol`

特に `StunOverTurnProtocol` で `retransmissions = 0` が捨てられないようにする。TURN server 自身との allocation/refresh transaction の再送ポリシーは、peer に対する consent request と混同しない。

### C. consent 失効時の状態と送信停止を正す

- `packages/ice/src/iceBase.ts` の `IceState` に `failed` を追加し、最後の有効応答から30秒経過したときは `closed` ではなく `failed` へ遷移させる。
- 失効した selected pair を送信対象から外すか、明示的な consent-valid flag で `Connection.send()` を遮断し、RTP/DTLS/SCTP を含む application data が当該5-tupleへ渡らないことを保証する。
- `failed` では ICE restart に必要な transport 資源を明示 close と同様に破棄しない。新しい ICE credentials を使う `restart()` で復帰できる状態にする。
- `packages/webrtc/src/transport/ice.ts` と `packages/webrtc/src/secureTransportManager.ts` で `failed` が `RTCIceTransport.state`、`iceConnectionState`、`connectionState` へ正しく伝播し、PeerConnection の明示 `close()` と混同されないことを確認する。
- 失効後に届いた遅延 response だけで consent を再確立しない。RFC 7675 に従い、復帰には ICE restart と新しい credentials を必要とする。

### D. ICE-lite 相互運用用 `USE-CANDIDATE` を限定的に付与する

consent request の `nominate` は、次の条件をすべて満たす場合のみ有効にする。

- local agent が controlling
- remote agent が ICE-lite
- request 対象が現在の selected/nominated pair

controlled 側、remote が full ICE の場合、古い pair に対しては付与しない。これは RFC 7675 の30秒失効修正とは独立した相互運用処理として、コメントとテストで理由を残す。同一 selected pair の nomination を維持する用途に限定し、別 pair の再 nomination を発生させない。

### E. 回帰テストを追加する

Arrange 用の consent harness／mock protocol／candidate pair 生成は `packages/ice/tests/utils.ts` など単一の共有 utility ファイルへ集約し、`packages/ice/tests/ice/consent.test.ts` に fake timer ベースのテストを追加する。テストは Arrange / Act / Assert に分け、Act / Assert にはリポジトリ規約に従って日本語コメントを付ける。

最低限、次を自動検証する。

1. 1回目の request が欠落しても2回目以降を送信し、後続の有効応答で接続を維持する。
2. 150〜300ms程度の遅延応答を受理し、同じ transaction ID の packet を再送しない。
3. 応答待ちがあっても request 開始間隔が選ばれた4〜6秒を超えて伸びない。
4. 4秒周期でも30秒未満で失効せず、6秒周期でも最後の有効応答から30秒で失効する。
5. 有効応答で30秒期限が更新される。
6. 各 consent request の transaction ID が異なる。
7. restart／close／pair 切替で timer と未完了 transaction が残らず、古い応答が期限を更新しない。
8. 失効後は ICE state が `failed` となり application data を送らず、明示 close の `closed` とは区別される。
9. host UDP、ICE-TCP、TURN relay の各経路で consent request が一度だけ送信される。
10. `USE-CANDIDATE` が controlling + remote ICE-lite + selected pair の場合だけ含まれる。
11. `consentRequestsSent`、`requestsSent`、`responsesReceived`、`retransmissionsSent` の stats が実際の packet 数と一致する。

必要に応じて `packages/webrtc/tests` に、ICE の `failed` が PeerConnection の状態へ伝播し、PeerConnection を `closed` にしないこと、および ICE restart で再接続できることの統合テストを追加する。

## 3. 技術的な実装アプローチ

1. `queryConsent()` 内の「sleep → request を await → sleep」という単一ループを、request cadence と30秒 expiry を別々に管理する小さな consent lifecycle に置き換える。
2. request 開始時に次回 deadline を確定し、request promise の完了は cadence timer を後ろ倒しにしない。成功 handler だけが expiry deadline を更新し、timeout は記録して次回 check を待つ。
3. STUN transaction API に明示的な response timeout／cancel を追加し、consent usage は `retransmissions: 0` と適切な response timeout を別々に渡す。既存 API は overload または互換 wrapper で維持する。
4. lifecycle は pair ID、ICE generation、credentials の snapshot を持ち、callback 実行時に現在値と一致する場合だけ stats と consent を更新する。
5. 30秒経過時は scheduler と outstanding transaction を止め、selected pair への application data を遮断して `failed` を通知する。明示 `close()` のみが `closed` を通知し、transport を破棄する。
6. ICE-lite 用 `USE-CANDIDATE` は専用 predicate に切り出し、RFC 準拠の consent timing と相互運用 policy を混在させない。

この構成なら、単純に timeout を1秒へ延ばすだけでは解決しない request cadence、独立した30秒失効、遅延応答、restart/close 時の cleanup を一貫して扱える。

## 4. 制約・注意点

- RFC 7675 の30秒は「6回失敗」ではなく、最後の有効応答からの経過時間で厳密に扱う。
- consent request は packet を一度だけ送る。response を長く待つことと packet を再送することを混同しない。
- expiry timer と request cadence timer は独立させる。event loop の遅延があった場合に、失われた複数回分を一度に burst 送信しない。
- 有効 response は selected pair の transport address、transaction ID、message integrity、non-error class が一致する場合だけ受理する。別 pair や旧 generation の response は consent を更新しない。
- `USE-CANDIDATE` の反復付与は RFC 7675 の必須事項ではない。OpenAI 固有分岐にはせず、libwebrtc と同様の ICE-lite interoperability policy として最小条件に限定する。
- `Protocol.request` は公開 export されているため、既存利用者を壊す signature 変更を避ける。
- TURN 経路では、peer 向け STUN over TURN transaction と TURN server 向け transaction の retry policy を分離する。
- `failed` と `closed` を区別しつつ、RFC 7675 が要求する失効後の送信停止は必ず満たす。遅延 response だけで自動復帰させない。
- fake timer テストでは `node:timers/promises` と global timer の双方を確実に差し替え・復元し、テスト間リークを防ぐ。
- 実接続試験は外部サービス、認証情報、ネットワーク遅延に依存するため、決定論的な単体・統合テストを必須とし、OpenAI endpoint での90秒試験は利用可能な環境で補完する。
- public API、protocol behavior、ICE state propagation にまたがる変更なので、`packages/ice` だけでなく `packages/webrtc` まで検証する。

## 5. 完了条件

- [ ] 上記妥当性確認で「妥当」とした4点が修正され、RFC 7675 の4〜6秒 cadence、一度だけの送信、最後の有効応答から30秒の失効を満たす。
- [ ] 単発の timeout で consent check が停止せず、後続の有効応答を受理できる。
- [ ] response timeout が再送回数から独立し、500ms未満の固定 deadline によって正常な consent response を破棄しない。
- [ ] UDP、ICE-TCP、TURN relay の selected pair で consent request が再送されない。
- [ ] consent 失効後は当該5-tupleへ application data を送らず、ICE/PeerConnection には `failed` として伝播し、明示 `closed` と区別される。
- [ ] ICE restart が新しい credentials で consent/通信を再確立でき、旧 transaction の応答は新しい接続へ影響しない。
- [ ] controlling + remote ICE-lite + selected pair の consent request にのみ `USE-CANDIDATE` が付く。
- [ ] `packages/ice/tests/utils.ts` 等に再利用可能な Arrange utility が集約され、Act / Assert に日本語コメントを持つ回帰テストが追加されている。
- [ ] `cd packages/ice && npm run type && npm test` が成功する。
- [ ] `cd packages/webrtc && npm run type && npm test` が成功する。
- [ ] cross-package 変更として `npm run type` と `npm run test:small` が成功する。
- [ ] 利用可能な検証環境がある場合、下流の依存パッチを外した build で OpenAI ICE-lite endpoint との接続を heartbeat なしで90秒以上維持し、idle 後も双方向 audio/data が継続する。
- [ ] 変更した公開型・定数・状態遷移に対応する API docs または関連説明が更新され、`CONSENT_FAILURES` を残す場合は非推奨／未使用であることが明記される。
