# PeerConnection negotiation transaction invariant の明文化と state machine 整理

## 1. 目的と背景

非対応 RTP m-line の拒否を含む再交渉で、rollback、replacement offer/pranswer、ICE restart、BUNDLE、SCTP、trickle ICE の更新境界が食い違う問題を、個別の補修ではなく PeerConnection 全体の transaction として解決する。最終 answer の適用だけが negotiated state の commit 境界であり、それまでの pending negotiation が通信中の session を壊さないことを設計・実装・テストで保証する。公開 WebRTC API の追加は行わない。

### コードベース調査で確認した現状

| 箇所 | 現状と具体的なリスク |
| --- | --- |
| [`peerConnection.ts`](packages/webrtc/src/peerConnection.ts) | `setLocalDescription` / `setRemoteDescription` が signaling、MID、direction、transport、candidate、connect を個別の順序で更新する。`setRemoteDescription` は `SDPManager` の description 更新後に media/transport を直接変更するため、途中の例外で description と実体が食い違いうる。remote offer は transceiver を生成し、BUNDLE binding、RTP/router、ICE/DTLS、SCTP を answer 前に変更する。rollback と implicit rollback は主に description を消す。`pendingRemoteCandidates` は pre-SRD 用の単一キュー。`createOffer({iceRestart:true})` は offer 適用前に live ICE を restart する。`connect()` は transport の状態を見て早期 return する。 |
| [`sdpManager.ts`](packages/webrtc/src/sdpManager.ts) | `currentLocal/RemoteDescription` と `pendingLocal/RemoteDescription` はあるが、media/transport と同期した commit 単位ではない。`remoteIsBundled` と `setLocal()` は most-recent description を参照し、MID 履歴も可変。検証は主に signaling と SDP parse に限られる。 |
| [`transceiverManager.ts`](packages/webrtc/src/transceiverManager.ts)、[`router.ts`](packages/webrtc/src/media/router.ts) | `setRemoteRTP()` は codecs、header extensions、direction、sender/receiver と router 登録を即時変更し、`onTrack` も発火する。unsupported codec は全体を throw する経路がある。router は SSRC/RID/extension の live table を持つ。 |
| [`secureTransportManager.ts`](packages/webrtc/src/secureTransportManager.ts)、[`ice.ts`](packages/webrtc/src/transport/ice.ts) | candidate は most-recent remote SDP の MID から live transport へ直接配送される。ICE credential 変更は `RTCIceTransport.setRemoteParams()` から `Connection.restart()` を呼び、候補・checklist・nominated pair を消す。EOC と candidate は generation 専用 bucket になっていない。 |
| [`dtls.ts`](packages/webrtc/src/transport/dtls.ts)、[`sctpManager.ts`](packages/webrtc/src/sctpManager.ts) | remote DTLS fingerprint は旧値に追加され、role も更新される。SCTP remote port / max-message-size / MID / binding は remote description 適用時に live association 側へ反映される。 |

このブランチで確認できたのは **分散した mutable state と局所的な rollback** であり、背景にある「subsystem ごとの snapshot/staged field が既に存在する」という前提は現状と一致しない。実装時には実在するフィールドと副作用を棚卸しし、不要になったものだけ削除する。既存の関連テストは [`peerConnection.test.ts`](packages/webrtc/tests/integrate/peerConnection.test.ts)、[`negotiation.test.ts`](packages/webrtc/tests/integrate/negotiation.test.ts)、[`trickle.test.ts`](packages/webrtc/tests/integrate/trickle.test.ts)、transport / DataChannel テストで、transaction 全体の不変条件をまとめて検査する基盤はない。

参照規範: [W3C WebRTC 仕様](https://www.w3.org/TR/webrtc/) の signaling state・description・`addIceCandidate`、[RFC 8829 JSEP](https://www.rfc-editor.org/rfc/rfc8829.html) の offer/answer、pranswer、rollback。とくに trickle は明示 `usernameFragment` が該当 ICE generation、未指定は最新の applicable generation に対応し、該当する current/pending description に追記される。現行 API の pre-SRD candidate buffering は werift の互換動作として維持し、厳格な upstream WPT 専用動作は `tools/wpt-runner` に留める。

## 2. 実装する変更

### 2.1 先に確定する設計文書

`packages/webrtc` 内に negotiation transaction の設計文書を追加し、次を固定する。

- **current/committed**: 最後に stable へ遷移した local/remote description に対応する通信可能な media、BUNDLE owner、ICE generation、DTLS、SCTP。packet-driven runtime（受信統計、consent timer など）は基本的にこの live state に属する。pranswer による暫定通信が始まっても、最後の stable な description と rollback baseline は書き換えない。
- **pending**: 最も新しく適用した offer/pranswer とそれに付随する media・transport proposal。replacement は latest-wins。current と共存し、既存 RTP/RTCP、ICE selected pair、DTLS、SCTP を切断しない。
- **rollback baseline**: transaction 開始直前の current の識別子・所有関係。transaction 中は first-wins。runtime 全体の deep-copy は要求せず、pending が触れる範囲を制限する。
- **speculative resource / observable side effect**: pending 専用の transceiver、transport、track、DataChannel 関連 object とイベントを区別する。`ontrack`、transceiver/event 発火、gathered candidate など外部に見えたものは取り消せない。以下の暫定通信・イベント契約を設計文書とテストの基準にする。
- **phase と失敗状態**: `begin → replace/update → validate → prepare → commit → cleanup` と `rollback → cleanup` の owner を一つにする。各 phase の前提・事後条件、同一 description の再適用と duplicate candidate/EOC の扱い、非同期 connect/event の開始時点、例外時の復旧方針を記載する。既存 signaling state と許可される local/remote の offer、pranswer、answer、rollback の対応表を含める。

#### 状態遷移表の骨子

下表の **M/B/I/D/S/C/E** は順に RTP・transceiver・router、BUNDLE/transport owner、ICE generation、DTLS、SCTP、candidate/EOC、observable event を表す。各セルの `P` は transaction 所有の pending、`C` は current 所有、`K` は最終 answer commit、`R` は rollback cleanup。設計文書では各行の各 subsystem について pending 中に変更できる field と K/R 時の mutation timing まで展開する。`C 維持` は既存セッションでの通信継続を意味する。

| Flow | baseline → pending | M / B / I / D / S / C / E の owner と確定時点 | 結果 |
| --- | --- | --- | --- |
| 初回 offer → answer | 空 → P1 | 全領域 P で準備。remote offer の track event、candidate gathering 等は K 前にも起きる。pranswer があれば P の接続・通信も可能。K で最終値を採用 | current P1 |
| local re-offer → remote answer | C=A → P=B | M/B/I/D/S/C は A を維持し B を P に保管。E は provisional な発火条件を記録。K で B に切替 | current B |
| remote re-offer → local answer | C=A → P=B | 同上。remote offer 受信だけで既存 router、ICE、SCTP を置換しない。K で B に切替 | current B |
| offer → pranswer → answer | C=A → P=暫定 B → 最終 B | M は合意方向・codec で暫定 RTP 可、I/D は P generation で ICE checks/DTLS handshake 可、S は新規 P association の開始可、C/E は P generation に紐付ける。B の旧 owner と baseline を保持し、最終 K で確定・余剰解放 | current B |
| offer A → replacement offer B → answer | C=A → P=A → P=B | M/B/I/D/S/C は旧 P を片付け B が latest-wins。baseline と既存 E の履歴は保持。K で B を採用 | current B |
| offer A → replacement offer B → rollback | C=A → P=A → P=B | M/B/I/D/S/C の pending-only 部分を R で破棄。発火済み E は記録に基づき重複防止 | current A |
| ICE restart offer → answer | ICE A → P ICE B | M/B/D/S は A で通信継続。I と C は credential・候補・EOC・checklist を B に束ね、K 後に新 checklist/nomination を開始。E は B と紐付け | ICE B |
| ICE restart offer → rollback | ICE A → P ICE B | I/C の B を R で破棄し A の selected pair・DTLS・SCTP を保持。M/B/E も baseline に整合 | ICE A |
| BUNDLE membership/tag 変更 | topology A → P topology B | B の owner/tag と M/S binding、I/D/C routing は P で計画。A の共有 transport は継続。K で topology B、R で A。E は新 owner の確定後 | B または A |
| RTP reject/stop/m-line reuse | media A → P reject/reuse | M の停止・router unregister・reuse eligibility は K。B/I/D の共有 owner を維持し、S/C/E の整合も K/R で確認 | 合意結果または A |
| SCTP parameter re-offer | SCTP A → P SCTP B | S の port、max-message-size、MID、DTLS binding は P。未対応の既存 association port change は live mutation 前に reject。M/B/I/D/C/E は A を保持 | B または reject/R |

両 offerer 方向の pranswer replacement と implicit rollback、validation failure、duplicate trickle を表の補助行として追加する。final answer の SDP と live state は同一 commit の結果として公開する。

### 2.2 pranswer の暫定通信と lifecycle を確定する

[RFC 8829 §4.1.10・§5.11](https://www.rfc-editor.org/rfc/rfc8829.html) に従い、pranswer は **pending description のまま**、合意した非 `inactive` の m-line で RTP/RTCP の暫定送受信を許す。remote offer 適用時の受信準備と track 通知も final answer を待たない。pending ICE generation は候補 gathering / connectivity checks / nomination を、対応する DTLS は ICE 到達後の handshake を開始してよい。新しい application m-line の SCTP association と、その上の DataChannel 通信も pranswer が条件を満たす場合は開始してよい。これは provisional な有効状態であり、last-stable/current description の書き換えではない。[W3C WebRTC の description 適用手順](https://www.w3.org/TR/webrtc/#set-the-session-description) も pranswer で RTP direction と新規 SCTP transport を適用する。

- 既存 session がある場合は current RTP/RTCP と選択済み ICE pair、DTLS、SCTP association を rollback baseline として保持する。pranswer の有効な送受信・接続は pending owner に紐付け、共有 transport の破壊的な restart/stop、旧 codec/router mapping の削除、既存 SCTP association の破棄は final answer 前に行わない。provisional と current の同時受信に必要な codec/routing は両方を処理する。
- pranswer または replacement pranswer が ICE credential、DTLS parameter、codec、direction、BUNDLE、SCTP max-message-size を更新した場合、最新の provisional state を有効にできる。ただし旧 current の復元可能性を保ち、既存 DataChannel の送信上限は provisional な合意値を超えない。既存 SCTP port 変更など元の association を破壊しなければ実装できない提案は、未対応なら live mutation 前に拒否する。
- final answer は **最後の pranswer と異なっていてよい**。final の SDP 全体を再検証し、その内容へ切り替え、不要になった decoder・candidate・transport・provisional SCTP を解放する。`pranswer → replacement pranswer` では旧 provisional resource を停止・detach して最新案に入れ替えるが、baseline と既に発火したイベント履歴を上書きしない。
- rollback は pranswer で始めた送受信・ICE checks・DTLS/SCTP を止め、旧 current の RTP 経路、selected pair、DTLS/SCTP を復元する。初回交渉なら current は空へ戻る。replacement offer が旧 transaction を取り消す場合も先に同じ cleanup を行い、旧 stable baseline を保持して新 offer を stage する。final answer 適用後の stable state からは rollback できない。

### 2.3 不可逆イベントと speculative object の契約

[RFC 8829 §5.7](https://www.rfc-editor.org/rfc/rfc8829.html#section-5.7) と [W3C WebRTC の rollback / remote track 処理](https://www.w3.org/TR/webrtc/#set-the-session-description) に合わせ、イベントを final commit まで一律に遅延させない。coordinator は transaction ID、description revision、ICE generation と object identity を記録し、**発火済みの通知は取り消さず、内部所有関係と後続通知を整える**。

| 対象 | 発火・公開時点 | rollback / replacement 後の扱いと再通知 |
| --- | --- | --- |
| `ontrack`、remote `MediaStreamTrack` / receiver | remote offer または pranswer の適用で受信方向へ移る時に通知可能 | 既存 transceiver の track/receiver identity を保ち、last-stable の stream association・受信方向へ戻す。pending のみで生成された transceiver は下記のとおり停止・除外する。通知済みの track object はアプリ側参照から消せない。再適用時は同一 receiver の受信方向遷移または stream 追加が本当に起きた場合にだけ再通知する。 |
| remote offer 由来の transceiver / sender | remote offer 適用時に作成・公開可能 | rollback で旧 m-line との関連と MID/index を外す。remote offer が作成し `addTrack` で local track が付かなかった transceiver は停止し `getTransceivers()` 相当の集合から除外する。`addTrack` で使われたものは残し、次の local offer に使える。アプリが保持する object 参照自体は無効化しない。新たな offer が実際に新 transceiver を作れば新規通知は許される。 |
| `icecandidate` / EOC / gathering state | local pending generation の gathering 中にも発火する | 発火済み candidate は回収できない。rollback/replacement 後は旧 generation の queued callback を新 SDP・transport に書き込まず、同一 generation の同一候補/EOC を再通知しない。新 generation の候補は別通知として扱う。null の gathering 完了通知も、対象 generation の実際の完了条件で一度だけ出す。 |
| `ondatachannel`、DataChannel object | provisional な SCTP association で remote DCEP を受信すれば final 前にも通知可能 | pending-only association の remote-created channel は rollback/置換で閉じ、内部 registry から外す。既に渡した object と event は残るが再利用しない。application が `createDataChannel()` で作った object 自体は rollback で消さない。committed association 上の channel は継続し、pending-only association に実際に結び付いていた channel は association の終了に従い閉じる。未接続 channel の後続 negotiation での扱いを状態別にテストする。新 association で新たな DCEP が来た場合のみ新 object/event を作る。 |
| `signalingstatechange`、transport state、`negotiationneeded` | 実際の pending/provisional 状態変化に応じて通知 | 通知を巻き戻さず、rollback/replacement の新しい遷移だけ通知する。内部 description 適用由来の変更と application 操作を区別し、stable に戻った後に必要性を再計算する。 |

同じ pending description を再適用しても新しい track/transceiver/channel や重複 event を作らない。重複抑止キーを MID だけにせず、object identity と受信方向/stream の遷移、ICE generation、DCEP の association と stream ID に結び付ける。rollback で除外された remote-only transceiver に対する後日の新 offer は、新 object と正当な新 event を許す。発火待ちの非同期 callback は対象 transaction が廃棄済みなら配送を中止する。ただし仕様上必要な close / statechange は対象 object に配送する。

### 2.4 ルーティングキーの staging（追加要件）

レビューが収束しなかった主因は、pending 中に current が使う共有 live table（router・receiver）へ直接書き込み、rollback で snapshot から戻す方式だったことにある。この方式で守れるのは rollback 後だけで、pending 中の current の通信は守れない。指摘を 1 件ずつ直すのではなく、キーの種類ごとにまとめて次の規則で閉じる。

**規則:** pending の remote offer / pranswer はキーを**追加**してよい（暫定 RTP のため即時有効）。current が使っているキーの値は最終 answer まで変えない。値を変える提案は、live に書く前に拒否するか、commit まで保留（staged）する。rollback は保留分を捨て、pending が追加した分を戻す。

| キー | 保持場所 | 値を変える提案の扱い | 根拠 |
| --- | --- | --- | --- |
| payload type → codec | receiver の codec table | 再割当ては拒否。同じ codec の fmtp 変更は commit まで保留 | RFC 3264 §8.3.2 |
| header extension ID → URI | router の `extIdUriMap`（PeerConnection 全体で共有） | ID を別 URI に付け替えるものは拒否。URI を新しい ID へ移すのは追加扱い（旧 ID は引き続き解析される） | RFC 8285 §7、Chrome も拒否 |
| SSRC → receiver | router の `ssrcTable` | 別 m-line への付け替えは commit まで保留 | Chrome は受理 |
| RTX SSRC → media SSRC | receiver の RTX 対応表 | 対応の付け替えは commit まで保留 | Chrome は受理 |
| MID+RID → receiver | router の `ridTable` | RID は m-line 単位（RFC 8851）なので MID と組で引く。別 m-line での同名 RID は新しいキー | RFC 8851 |
| SSRC/RID の remote track | receiver の `tracks` | 新しいキーの track を追加するだけで、既存キーの track は置き換えない | — |
| payload type の RTCP feedback | receiver の codec table | current の payload type の `a=rtcp-fb` 変更は commit まで保留。NACK・TWCC・PLI は最小 payload type ではなく各パケットの codec で判断する | — |

送信側・フィードバック側も同じ規則に従う。remote pranswer が暫定適用した送信パラメータ（codec、header extension、RTX・RED の payload type、MID、RID）は baseline に全体を保持し、rollback で戻す。pending の記述は transport-cc フィードバックを開始しない（codec が交渉済みのパケット受信時か answer の commit 時に開始し、pending 中に始まったものは rollback で止める）。remote offer のために作る transceiver はアプリ操作ではないので、`negotiationneeded` を起こさず、inactive な transceiver の枠も奪わない。local answer / pranswer も、接続中の DTLS role を変える `a=setup` は適用前に拒否する。

拒否と保留の判断は、上記の Chrome 実機確認（extmap の ID→URI 再割当ては拒否、URI の新 ID への移動・SSRC 移動・RTX 付け替えは受理）と RFC に合わせる。

### 2.5 develop の issue 705 (m-line 拒否・停止・再利用) との統合（追加要件）

develop に取り込まれた issue 705 の規則（`docs/design/705-media-rejection-and-removetrack.md`）は、2.1〜2.4 の transaction の中で実行する。マージで落ちた挙動（`mLineReuse`、local candidate の MID / index、answer と offer の共通 codec 検証、BUNDLE group 単位の transport 所有、kind 一致の m-line 再利用、remote port 0 の拒否予定、`negotiationneeded` の重複抑止）は退行として復元し、次の点だけを本チケットの意図した挙動変更とする。

| 点 | issue 705 単独の挙動 | 本チケットでの挙動 | 根拠 |
| --- | --- | --- | --- |
| 確立済み member を BUNDLE 外へ出す / 別 group に分割する re-offer | `InvalidAccessError` で拒否 | staged topology として pending にし、answer で確定、rollback で破棄 | RFC 8843 §7.5、2.1 の BUNDLE split/merge |
| 使用中 payload type の codec を付け替える re-offer | 受理して拒否予定 | 適用前に拒否（非対応 codec は新しい payload type で提案すれば拒否予定になる） | RFC 3264 §8.3.2、2.4 |
| group 外 m-line の answer の `a=setup` | 常に `active` | offer の `setup` の逆（`active` には `passive`） | RFC 8842 §5.3 |

- 拒否予定（`pendingRejection`）、`rejected`、track 通知状態は rollback baseline に含め、rollback の所有者は transaction の一つだけにする（issue 705 の transceiver 単位の snapshot は使わない）。
- 初回交渉と answer の transport 所有は offer の BUNDLE group で決め、group 外は独立した ICE credentials を持つ。所有のためだけに作った transport は rollback で閉じる。確立済み session の re-offer / pranswer は current の所有を変えない。
- 後の remote pranswer / answer は、先の pranswer が staged した経路と受信設定を置き換える（final answer の値だけが commit される）。
- answerer の `stop()` は inactive で答え、自分の次の offer で port 0 を交渉する。invariant helper は app が止めた pipeline を経路検査の対象から外し、受信 codec は MIME type・fmtp・RTCP feedback まで current SDP と一致することを検査する。
- develop の codec 統合（`setCodecPreferences()`、track source codec、`planRemoteRtpCodecs`）も transaction の中で実行する。`createAnswer()` は answer 用の codec を transceiver の提案として解決するだけで、sender・受信 codec / RTX 表・TWCC・remote track の codec は local answer の commit で切り替える（develop 単独では `createAnswer()` の時点で切り替えていた。pending 中の current RTP を守るための意図した挙動変更）。`pendingLocalOfferCodecs` と再解決要求は rollback baseline に含める。

### 2.6 最新 develop にマージされた機能の網羅的な統合（追加要件）

本チケットの作業中に `develop` へマージされた機能のうち、ソースに変更があるものをすべて洗い出し、2.1〜2.5 の transaction の規則（pending 中は current のキー・設定を変えない、negotiated state は staged か baseline で戻す、application state と configuration は rollback で戻さない）に照らして、pending 中に書き込む状態を一つずつ分類する。調整が必要な箇所は修正し、回帰テストを置く。対象は分岐点 `62582c21` 以降の `develop`（最新の `origin/develop` をマージした上で確認する）。

| develop の機能 | 確認結果と本チケットでの扱い |
| --- | --- |
| #716 SCTP の送信 MTU (`sctp.mtu`) | configuration として扱う。pending の remote offer が作る SCTP transport・別 DTLS transport への移動・rollback の復元のいずれも設定の MTU を使う。SCTP transport（pending のものを含む）がある間は変更できず、rollback で提案の transport が消えれば変更できる。退行なし（テストを追加）。 |
| #721 / issue 705 の m-line 拒否・停止・再利用 | 2.5 のとおり。加えて、pending 中にアプリが追加した transceiver が停止済み m-line の位置を引き継いだ場合、rollback でその位置を返す（重複した `mLineIndex` を残さない）。 |
| #688 TURN 割り当て失敗時の close、#731 TURN endpoint 選択と `turnUdpFamily` | ICE server 設定は configuration で rollback しない。gather 前の transport には即時、gather 済みの transport には次の ICE restart で適用する（restart の stage 後に変更した場合も含む。JSEP 4.1.18）。ICE restart は旧 TURN allocation を閉じ、commit 後に現在の設定で新しく allocate する（未使用の allocation を残さず、切れた allocation からも回復できる。詳細は 2.8）。 |
| #729 codec 統合 (`setCodecPreferences()`、track source codec) | `setCodecPreferences()` と `addTrack()` による track の追加は application の変更として扱い、transceiver の解決済み codec だけを消して live の sender / receiver は変えない。pending 中の変更は rollback 後も残す（revision で baseline と区別する）。`createAnswer()` から answer 適用までの間の変更は、適用した answer の codec を commit し、次の offer で再解決する。remote offer の pending 中の `replaceTrack()` は、確定済みの codec に加えて answer が送信に使う codec とも track source を照合する。answer 事前検証は develop で廃止された track codec の採用を行わない。merge で失われていた #729 の 1 対 1 の codec 照合（`usedRemote`）と、local answer の codec を自分の設定順に並べる規則（remote answer は remote の順を保つ）を復元する。local answer の commit は、preference の変更有無に関係なく、answer した codec で受信表・remote track の codec・TWCC を置き換える。 |

merge で落ちた変更は機能単位の確認では拾えないため、分岐点以降に develop が `packages/*/src` に加えた全 hunk を HEAD と突き合わせ、(a) transaction 設計で意図的に置き換えたもの、(b) 失われたもの、(c) 不明に分類する。(b) は復元し回帰テストを置く。hunk 単位の目視だけでは同じ hunk 内の 1 行の巻き戻し（answer の codec 順）を見落とすため、develop が追加した各行が現在の `packages/*/src` のどこかに存在するかを機械的に照合し、存在しない行を (a)〜(c) に分類する。見つかった (b) は #729 の 1 対 1 照合と answer の codec 順の 2 件で、それ以外の欠落行は transaction 設計・モジュール分割で置き換えたもの（(a)）だった。

### 2.7 provisional ICE generation の明文化（追加要件）

確立済みの transport の ICE restart を交渉している間だけ、live generation と同じ socket の上に並べて動かす provisional generation（2.2 の pending ICE checks の実体）について、何によっていつ発生し、どう進み、何につながるかを設計文書（ICE generation boundaries）とレビュー解説（7.1）に図と表で記載する。記載する内容は実装と一致させる。

| 段階 | 契機と時点 | 内容 |
| --- | --- | --- |
| 作成 | offerer は `restartIce()` 要求中の `createOffer()`、answerer は live transport の ufrag を変える remote offer への `createAnswer()` | restart の資格情報を stage し、その ufrag 宛ての check に応答する。live の ICE agent は変えない |
| 相手の情報 | offerer は remote pranswer の適用（とその ufrag の trickle）、answerer は自分の pranswer の適用（remote offer の資格情報・候補） | provisional の remote 資格情報・候補・EOC を設定する。replacement pranswer は checklist をやり直す |
| check | pranswer の適用直後 | STUN check と controlling 側の暫定 nominate。RTP・DataChannel は live の selected pair のまま |
| 終了 | 最終 answer、または rollback / replacement offer / 別の generation を選ぶ description の作成 | answer では ICE agent を作り直して live generation を一から check し、provisional の nominate 結果は引き継がない。取り消しでは provisional を捨て、live generation が続く |

provisional の checklist は live と同じ規則に従う: 候補から作る pair には `filterCandidatePair` を適用し、ICE-lite は check を送らず応答だけを行い、staged ufrag 宛ての check へのエラー応答（487 role conflict）は staged password で署名する。

初回の交渉と提案のために作る transport（BUNDLE split、pending-only）は provisional を持たず、pranswer で通常の接続を始める。provisional の nominate 結果を commit で引き継がないことは、6 章の「ICE restart の commit で RTP が途切れる」制約の原因として扱う。

### 2.8 レビュー指摘で確定した規則（追加要件）

- **trickle の非同期配送:** description 操作のキューの中では、remote 候補の SDP への記録と generation の振り分けだけを行う。mDNS 解決と checklist への投入は ICE 層で非同期に行い、解決しない `.local` 候補が `addIceCandidate`・後続の候補・description 操作を待たせない（ICE 層は EOC との順序を自分で保つ）。
- **ICE restart の候補と commit:** restart generation の候補は offer / answer の作成時に確定する（保持した socket の host 候補と、その socket の既存の server-reflexive）。commit はそれを同期的に再広告するだけでサーバーを待たない。ICE server がない場合は description に end-of-candidates を含める。STUN / TURN がある場合は relay 候補と end-of-candidates を含めず、commit 後に背景で STUN を再問い合わせ（変わった mapping だけ追加）し、旧 TURN allocation を閉じて新しく allocate し、追加分と end-of-candidates を trickle する。まだ generation を持たない transport（restart と同時に追加した m-line など）は restart を stage しない。背景の gather は開始時の generation に属する: その後に次の restart か `close()` が来たら、await の後で候補を追加せず、作った socket / TURN allocation を閉じ、`localCandidatesEnd`・end-of-candidates・gathering `complete` も出さない（end-of-candidates は generation ごとに一度、その generation の gather の完了時だけ）。接続確認の開始後に終わった gather は ICE の状態を動かさない。restart の ICE password にも `icePasswordPrefix` を付ける。生成済みの description を後から／再度適用したときの扱い（answer の再生成、未適用の offer、rollback 後の再適用、置き換えなど）は 2.9 の再利用契約に従う。背景の gather が適用済みの description（current / pending）を更新するときは、その description が適用した generation の資格情報・候補・end-of-candidates を使う。
- **ICE の状態と consent:** pair を選んだ接続確認の成功を初期 consent とし（RFC 7675 §5.1）、選択直後から送信できる。接続確認の開始後に終わった gathering は ICE の状態を上書きしない。
- **使用中の判定:** payload type と header extension ID が「使用中」なのは、その m-line の current の local と remote の両方にある場合だけ。offer に載ったが answer で受理されなかったものは、別の値で再提案できる。
- **close:** `close()` は transaction だけが持つ transport（提案用に作成・pending 専用・BUNDLE owner・準備済み）も停止する。transport を準備する処理（`createAnswer()` の owner 準備、local offer の stage）は各 `gather()` の後で閉鎖を確認し、閉じていれば自分が作った transport を止めて `InvalidStateError` で失敗する（close の後に新しい transport を作らない）。`closed` は終端で、`close()` に追い越された description 操作は `InvalidStateError` で失敗し、状態を戻さない。
- **MID の照合 (#142):** 初回交渉の remote answer に限り、offer と位置・kind が一致する m-line の独自 MID（`0_srtp` など）は offer の MID に読み替え、BUNDLE の項目も追従する（RFC 3264 の位置対応）。session 確立後は answer の MID は offer と完全一致が必要（RFC 8843）。develop の #142 テストは fixture を変えずに通る。
- **接続の再開始:** answer の適用で transport の接続を進めるとき、ICE の接続確認を始めるのは、その generation でまだ始めていない場合（初回交渉と commit した restart）だけ。実行中の接続確認は待ち、確立済み・`completed`・`failed` の generation はやり直さない（`checking` に戻さない。`failed` からの回復は ICE restart で行う）。DTLS handshake が進行中なら開始し直さずに完了を待ち、`connectionState` は DTLS の完了まで `connected` にしない。接続の処理を何も始めず待ちもしなかった場合は `connectionState` を変えない。
- **BUNDLE の EOC 集約:** answer で確定する共有 transport の generation は、group のどの m-line に trickle された候補・end-of-candidates も受け取る（tag 以外の m-line の EOC も live ICE の完了になる）。pranswer の provisional generation も同じ。終端は ICE generation ごとに扱う。current の description では transport と ufrag、保留中の提案（新しい ufrag の restart offer など）ではその提案自身の BUNDLE 所有関係（group の tag、または m-line 自身）と ufrag で generation を識別し、ある m-line の end-of-candidates は同じ generation の全 MID に反映する。transport の準備前でも同じ BUNDLE には伝わり、提案が group から外す m-line には、同じ資格情報を使っていても伝わらない（RFC 8839 §5.4）。その後に別の MID へ届いた同じ generation の候補は、pending SDP にも確定後の ICE にも入れない（RFC 8838 §14）。
- **初回 pranswer 接続:** 初回交渉の pranswer で接続した DTLS association も確立済みとして扱い、final answer での `a=setup` の反転は適用前に拒否する（RFC 8842 §3.1）。初回 pranswer で接続した後の offer の置き換えは 2.9 の再利用契約に従い、最終 answer で接続し直す。初回交渉を rollback したら current session はないので、`connectionState`・`iceConnectionState` は `new` に戻し、その提案の接続処理は以後の状態を報告しない。app が使うために残す remote offer 由来の transceiver は、作成時の状態（MID・direction・codec・経路なし）に戻す。
- **適用した answer の codec:** local の answer / pranswer を適用するとき、transceiver の codec は適用する SDP から取る。保存しておいた answer の後に `createOffer()`（未適用）や `setCodecPreferences()` で解決し直した codec は送受信に入れず、次の offer で解決し直す。初回交渉の pranswer は守る current session がないので、answer した codec で暫定の送受信を設定する（rollback で baseline に戻る）。再交渉の pranswer は local / remote のどちらでも送信 codec を暫定的にその pranswer のものにし（受信表は current を保ち、衝突しない値だけ追加する）、final answer で確定、rollback で baseline に戻す（2.10 の有効値表）。invariant helper は stable の送信 codec が確定した SDP にあることも検査する。
- **max-compat の BUNDLE 提案:** 相手が確定 session で BUNDLE を受理するまで（初回交渉など）、max-compat / balanced の offer の BUNDLE group は提案にすぎない。各 m-line は自分の transport と候補を保ち、group を受理した answer で統合する（RFC 8843 §7.2）。BUNDLE を使わず m-line ごとに独立した資格情報で答える相手とも接続する。max-bundle、相手が BUNDLE を受理済みの session、すでに共有している m-line では offer の時点で tag の transport を共有する。
- **ICE-lite 相手の provisional nomination:** 相手が ICE-lite のとき、controlling の full agent は provisional checks でも live checklist と同じく regular nomination を行う（成功した pair に USE-CANDIDATE 付きの check を送る）。
- **受信表の置き換え:** answer の commit で受信表を置き換えるときは、pending の description が staged にした値も捨てる。answer で外した codec は、commit 時の staged 値の適用で戻らない。
- **その他:** local offer の停止済み m-line の再利用は同じ kind に限る。answer の `a=setup:actpass`（RFC 5763 §5 で不正）は確立済み association の role を保ち、新しい association では client にする。negotiation 用の状態型と helper は `src/negotiation/internalState.ts` に置き、パッケージから export しない。

### 2.9 生成済み description の再利用契約（追加要件）

承認後の再レビューで続いた非承認は、すべて「生成済みの description を後から／再度適用したとき、適用結果が生成時に退避した隠れた状態（staged ICE generation、MID / m-line の割り当て、codec、staged topology）に依存して壊れる」類型だった。develop は `createOffer` の時点で ICE restart を反映し、適用・rollback のたびに「最後に作った offer」を消して、その後は一致検査なしで offer を受理していた。このブランチは restart を answer まで stage する設計なので、適用に生成時の状態が要る。これを 1 件ずつの特例ではなく、次の契約と構造で閉じる。

**規則**

- (a) W3C が受理を求める適用は必ず受理する。local offer は最後に作った offer（[[LastCreatedOffer]]）と一致すれば受理し、rollback でも answer による `stable` でも消えない（次の `createOffer` で置き換わる。`stable` 後の再適用は develop も受理して通信できるため (b) にも当たる）。local answer / pranswer は最後に作った answer と一致すれば受理する。
- (b) develop で受理され、かつ通信できていた適用は退行させない（受理し、通信まで成立させる）。
- (c) (a)(b) のどちらにも当たらない適用は `InvalidModificationError`（または仕様が定める例外）で拒否し、拒否の前後で状態を一切変えない。

**構造**

- 生成記録: `createOffer()` は SDP と、各 MID を作った transceiver を変更不能な記録として残す。offer / answer が持つ ICE restart generation は、transport に ufrag をキーとして登録する。最後に作った offer と最後に作った answer の generation は、同じ種類の新しい description が置き換えるまで、何を適用・rollback・commit しても残る（その generation 自身の commit や、別の generation の commit でも消えない）（適用中の pending description が持つものは残す）。新しい offer は適用済みの pending offer の generation を（その pending 中に `restartIce()` が呼ばれ、資格情報が `[[LocalIceCredentialsToReplace]]` に入った場合を除く）、同じ remote offer への answer の再生成は先の answer の generation を、その間に何を作ったかに関係なく登録から引いて再利用する（JSEP 5.2.1 / 5.3.1）。codec は SDP そのものから取る。
- 適用: `setLocalDescription` は SDP を解析し、SDP と記録から MID / m-line の割り当て（transceiver と、application m-line の SCTP transport）を計画し、各 m-line の資格情報を transport の live 資格情報または登録済み generation と照合し、topology が必要とする新しい transport を stage する。ここまでで live / transaction の状態には書き込まないので、解析・検証・stage のどこで失敗しても何も変わらない（undo 処理に頼らない）。その後で pending の description を退け、割り当てを書き、各 transport を description が持つ generation に切り替える（その資格情報への、保持した socket での ICE restart）。owner が再利用する transport は、install 時点で生きているものを使う。
- 置き換えた特例: `createdOfferAssignments` / `restoreCreatedOfferAssignments`、`restageOfferedIceRestart` / `restageOfferedRestart`、answer 用 generation を remote offer が所有する特例、pranswer の rollback 後の再 stage、`cleanupInitialProvisional` 後の topology の再 stage、失敗時の undo。`describedLocalGeneration` の applied 分岐は、適用済み description の更新に必要なので残す。

**契約表**（develop は `tools/negotiation-diff/scenarios.ts` で develop 71b6ddbf を実測）

| 操作順序 | 受理か拒否か | 根拠 |
| --- | --- | --- |
| 保存した answer の後に `createOffer`（未適用）して、その answer を適用 | 受理 | (a) answer は [[LastCreatedAnswer]] のまま。develop: 受理・通信可 |
| answer を再生成し（間に未適用の restart offer を作った場合も含む）、先に作った answer を適用 | 受理 | (b) develop: 受理・通信可（werift も develop も answer を [[LastCreatedAnswer]] と照合しない） |
| 未適用の restart offer（`createOffer({ iceRestart })`、`restartIce()` 後の `createOffer()`）がある状態で、保存した answer を適用 | 受理 | (a) [[LastCreatedAnswer]] は変わらない。develop は受理するが通信できない（`createOffer` で ICE を restart するため） |
| remote offer の保留中に作った offer を `stable` 後に適用 | 受理 | (a) [[LastCreatedOffer]] と一致。develop: 受理・通信可 |
| rollback 後に同じ offer を再適用（restart なし／あり、新規 media あり） | 受理 | (a) rollback は [[LastCreatedOffer]] を変えない。develop: 受理・通信可 |
| restart offer を rollback し（または一度確定し）、相手の restart を確定した後に再適用 | 受理（offer の資格情報へ restart） | (a)(b) develop: 受理・通信可（`createOffer` で資格情報を live にしていたため） |
| 適用した offer を answer で `stable` にした後に再適用 | 受理 | (a)(b) develop: 受理・通信可 |
| `have-remote-pranswer` での置き換え（同じ offer／新しい offer）、初回 pranswer で接続した後の置き換え | 受理（先に remote pranswer を rollback） | 2.1 の状態遷移表（werift の拡張。JSEP 5.5 / W3C は `InvalidStateError` で拒否し、develop も拒否する） |
| 相手の前回の answer（m-line が少ない）を新しい local offer に適用 | 受理（答えられなかった m-line は拒否として停止） | (b) develop: 受理・通信可（RFC 3264 §6 は m-line 数の一致を求める。develop との差分ファズで検出） |
| 古い offer（後から別の offer を作った） | 拒否（`InvalidModificationError`、状態不変） | W3C: [[LastCreatedOffer]] と不一致。develop も拒否 |
| SDP munging した local offer | 拒否（`InvalidModificationError`、状態不変） | W3C: [[LastCreatedOffer]] と不一致。develop も拒否 |
| glare（polite 側が remote offer を受ける） | 受理（implicit rollback） | W3C の implicit rollback。develop: 受理・通信可 |

**機械化した探索**: `tools/negotiation-diff` の `run.ts` は公開 API だけで seed 固定の操作列（適用しない `createOffer` / `createAnswer`、保存済み description のプールからの再適用、rollback、再適用、pranswer、glare、trickle と EOC）を実行し、各操作の結果を JSONL で出す。`compare.ts` は develop の一時 worktree と HEAD の結果を突き合わせ、「develop は受理して通信でき、HEAD は拒否または通信できない」差分を列挙する。property test にも同じ description pool の episode を加え、拒否された操作の前後で両 peer の snapshot（signalingState、current / pending SDP、公開 ICE 資格情報、staged の有無、MID / mLineIndex、router の table）が完全に一致することを検査する。既存の episode の ICE restart の answer は「保存 → 再生成 → 未適用の restart offer → 保存した answer を適用」で行う。

### 2.10 レビューを通過させるための追加要件（策1〜3）

**背景**: 承認後の再レビューで非承認が続いた原因は、(a) pending 中に「どの値が live か」を値ごとに定めておらず、invariant helper が「live = current SDP」を一律に検査していたため、pranswer で有効になるべき値（例: 再交渉 pranswer の max-message-size、R10）の誤りを検出できなかったこと、(b) 試験の相手が素直な werift 同士に偏り、他実装の SDP の違い（BUNDLE なし、ICE-lite、資格情報の分離、setup の違い、MID の変更、SSRC の違いなど）や、待機中の割り込みを網羅していなかったこと、(c) チケットの各文と試験の対応がなく、未検証の文が残っていたこと、(d) 指定のチケットファイル（`TICKET-support-fallback-state.md`）が古いまま（2.8 / 2.9 がない）だったこと、である。次の 3 策と (d) の解消を追加要件とする。

**策1: pending 中の有効値表と `expectedLive`**

- 交渉する値（ICE 資格情報・候補・EOC、DTLS role / fingerprint、受信 codec / RTCP feedback、送信 codec、direction、BUNDLE owner、SCTP port、SCTP max-message-size、header extension ID、remote SSRC）ごとに、remote offer / pranswer / replacement pranswer / final answer / rollback の各段階で live になる値を **current**・**provisional**（最後に適用した pranswer）・**both**（current を保ち、衝突しない pending の値を追加、衝突は commit まで staged）・**reject**（live mutation 前に拒否）のどれかに定める。表は設計文書の「Effective values while pending」に置く。要点:
  - 送信 codec と direction は provisional: 再交渉の pranswer でも local / remote の両側で pranswer の値になり、`inactive` / `recvonly` の pranswer は送信を止める（sender の送信抑止）。local の answer / pranswer の `currentDirection` は適用する SDP の direction から取る。
  - SCTP max-message-size は provisional（W3C は answer と pranswer で data max message size を更新する）。remote offer の段階では current のまま。再交渉の remote / local pranswer でも更新し、rollback で戻す。SCTP port の変更は既存 association（初回 pranswer が始めたものを含む）では拒否する。
  - remote SSRC は both: pranswer の新しい SSRC はすぐ route し、current と衝突する SSRC は staged にする。replacement pranswer と final answer は、置き換えた pranswer だけが追加した route を外し、その track は次にその receiver に与えられた SSRC が引き継ぐ（receiver の track は同じ object のまま。初回 pranswer と final answer で SSRC が違っても app の track にメディアが届く）。answer が載せなくなった current の SSRC の route は develop と同じく残す。
  - answer / pranswer が、offer で restart していない transport の remote 資格情報を変えた場合は、新しい remote generation で接続確認をやり直し、local の資格情報は offer で伝えたものを保つ（どの SDP にもない資格情報を作らない。Chrome と同じ）。拒否された m-line（port 0）は renomination の判定（`inactive` の m-line）に数えない。
  - answer が BUNDLE を外しても m-line が同じ transport に残る場合、commit 後の current は transport と ufrag で generation を判定し、終了済みの generation の end-of-candidates を同じ transport・ufrag の全 m-line に記録する。
- invariant helper は値ごとの規則を `expectedLive(snapshot, field)` で表し（direction、送信 codec、max-message-size）、一律の「live = current SDP」検査を置き換える。pranswer 中の remote SSRC の route も検査する。helper を先に直して失敗を確認してから実装を直す。
- 回帰試験: 再交渉の max-message-size（remote offer 段階・pranswer・replacement pranswer・final answer・rollback、R10 とその兄弟）、pranswer の送信 codec（answer / rollback）、inactive の pranswer の送信停止、pranswer と final answer の SSRC 変更（再交渉と初回）。

**策2: 相手の多様性と割り込み**

- `tools/negotiation-diff/mutations.ts` に SDP 変異のライブラリを置く: BUNDLE なし、m-line ごとの BUNDLE group、ICE-lite、分割した m-line の別資格情報、setup の反転 / `actpass`、max-message-size、sctp-port、NACK / PLI なし、fmtp の変更、codec の部分集合 / 並べ替え、port 0、inactive、MID の変更（#142）、extmap ID の入れ替え、別の SSRC、end-of-candidates なし。純粋な文字列変換なので、試験と develop 差分ランナーの両方で使う。
- `negotiationTransactionMutation.test.ts` は変異を offer / pranswer（その後に変異なしの final answer）/ answer に、初回交渉と再交渉の両方で wire 上に適用する。各操作は invariant を満たして受理されるか、原子的に拒否される（前後の snapshot が一致）。拒否された再交渉は current session で通信を続け、変異した pranswer の後の変異なしの final answer と、その後の変異なしの再交渉は通信できる。`close()` 後は全 transport が閉じる。相手の実際の動作と食い違う変異（`misdescribesPeer`: BUNDLE、ICE、setup、port、MID、SSRC、extension ID、m-line の受理）は、受理後の通信を期待しない（受理か原子的拒否かは検査する）。既定は単独、`WERIFT_NEGOTIATION_MUTATION=pairwise` で全ペア、`=random:<count>:<seed>` で最大 3 個の乱択の組み合わせ。
- develop 差分: `run.ts --mutate <p>` は配送する description を確率 p で変異させ、`compare.ts` は「develop は受理して通信でき、HEAD は拒否または通信できない」差分を出す。
- `negotiationTransactionInterrupt.test.ts` は、ICE restart commit の gather、provisional generation の候補の mDNS 解決、初回 answer の DTLS 開始、誰も応答しない候補への STUN checks のそれぞれで交渉を止め、その間に `close()`・`restartIce()`・新しい offer・（pranswer 中は）rollback を行う。保留した操作と割り込みが決着し（hang しない）、invariant を満たし、`close()` 後は途中で作ったものを含む全 transport が閉じ、それ以外は割り込みのない交渉で通信できることを検査する。閉じた ICE transport は `closed` のままで、`stop()` が中断した checks が後から `failed` を報告しない。

**策3: 仕様と試験の対応表**

- 2.1〜2.10 と 5 章の各文を、それを検証する試験名（または helper）か「対象外（理由）」に対応づけた表を `packages/webrtc/NEGOTIATION_SPEC_COVERAGE.md` に置き、7 章に要約する。未検証の文をなくし（partial / uncovered を 0 にする）、その後で自己レビューする。

**変異試験と対応表の作業で見つけ、修正して確定した規則**（それぞれ修正前に失敗する試験がある）

- 閉じた ICE transport は `closed` のまま。`stop()` が中断した接続確認が後から `failed` を報告しない。
- 置き換えられる remote offer が作った transceiver は、置き換える offer が同じ MID・kind を記述するなら作成時の状態で引き継ぎ（MID・m-line・track の object を保つ）、transceiver・track の通知を繰り返さない。rollback では除外する。
- 初回交渉の rollback は、提案が接続した transport に加えて、remote の資格情報・候補だけを受けた transport も置き換える（app が残す transceiver にも旧 offer の候補を残さない）。
- final answer の適用では、SCTP は answer の BUNDLE owner の transport へ直接移る（自分用に準備した transport を経由して association を作り直さない。初回 pranswer で確立した association と DataChannel を保つ）。
- 停止した SCTP transport（rollback・置き換え・close）は、保留中の callback が運ぶ DCEP を受け付けず、新しい channel を通知しない。
- application m-line を拒否（port 0）した answer の commit は SCTP transport とその channel を閉じ、`sctpTransport` を外す（W3C）。他に使われない transport も止める。
- replacement pranswer の後、どの m-line も載せなくなった提案用 transport は、先の pranswer が始めた接続確認を止める（local の generation は final answer のために保つ）。
- transport-cc feedback は受信したパケットの codec の交渉で始める（最小の payload type の codec に依存しない）。
- remote offer は、拒否されておらず停止していない local transceiver が使う m-line（`inactive` を含む）に新しい MID を付けて再利用できない（`InvalidModificationError`、状態不変）。
- `restartIce()` を pending の restart offer 中に呼んだ後の `createOffer()` は、pending の資格情報も置き換える（W3C `[[LocalIceCredentialsToReplace]]`）。
- ICE restart の no-server 経路（end-of-candidates を description に含める）は、agent に STUN / TURN がない構成で検証する（werift は `iceServers: []` でも既定の STUN を使う）。

**(d) チケットの同期**: 指定のチケットファイルは古い。最新のチケット内容（本ファイル）をサーバーのチケット本文に反映する。

## 3. 技術的な実装アプローチ

### 3.1 transaction coordinator と subsystem API

- `RTCPeerConnection` が所有する内部 `NegotiationTransaction`（配置・型名は実装時に決定）に baseline、pending local/remote、media、BUNDLE owner、transport、ICE generation、DTLS、SCTP、candidate/EOC、speculative resource と event 履歴を集約する。外部公開 API は増やさない。
- `SDPManager` は parse/serialization と description proposal を担当し、current/pending の公開値は coordinator が commit/rollback した状態から得る。offer/answer の SDP 全体を、MID 重複・m-line 順序/再利用、rejected section、BUNDLE group/tag、ICE credential、DTLS role/fingerprint、SCTP port 等を横断して live mutation 前に検証する。
- `TransceiverManager` / `RtpRouter` は proposed codecs、extensions、encodings、direction、MID/mLineIndex、router mapping を stage し、commit 時に atomic に切り替える。unsupported media や port 0 の拒否は m-line 単位で処理し、共有 transport を他の m-line とともに停止しない。application の `addTrack`/`stop` と SDP 適用による内部変更を区別する。
- `SecureTransportManager` / `RTCIceTransport` は BUNDLE の current owner と proposal を分ける。ICE generation は local/remote credential、local/remote candidate、EOC、checklist、selected pair、gathering/checking を一単位とする。trickle は MID/mLineIndex と ufrag で current または pending generation に routing し、遅延 old-generation candidate を new generation へ持ち越さない。remote ICE restart に対する answer の local credential/candidate と commit 後 live generation を一致させる。
- `RTCDtlsTransport` は pending fingerprint/role を live 値と分け、replacement では latest-wins とする。ICE restart 後の checklist 起動を旧 DTLS `connected` の判定で短絡させない。DTLS reuse と restart の可否は既存 association と JSEP の制約で検証する。
- `SctpTransportManager` は pending port、max-message-size、MID/mLineIndex、binding を stage。pranswer が新規 association を成立させる場合は pending-only として開始できる。既存 association で未対応の port 変更は適用前に拒否し、rollback で current association と既存 DataChannel の送受信を維持する。
- transport や receiver が packet-driven に更新する runtime は丸ごと snapshot せず、pending 専用 resource の分離と、commit 時の ownership switch で守る。非同期 gather/connect、queued event、trickle は transaction/generation ID で古い callback が新 state を汚さないようにする。

- `RTCPeerConnection` は公開 API と各 description 操作の順序だけを持ち、検証（`negotiation/descriptionValidation.ts`）、remote m-line の適用（`negotiation/remoteMediaApplication.ts`）、BUNDLE topology（`negotiation/bundleTopology.ts`）、trickle ICE（`negotiation/remoteCandidates.ts`）、transport の起動（`negotiation/transportActivation.ts`）、`negotiationneeded`（`negotiation/negotiationNeeded.ts`）、`restartIce()` 要求（`negotiation/iceRestartRequest.ts`）、設定とイベント型（`api/peerConfig.ts` / `api/peerConnectionEvents.ts`）は個別モジュールに置く。対応表は設計文書の Code layout。

### 3.2 commit / rollback の順序

1. description と cross-field の preflight validation を完了し、全 subsystem の `prepare` が失敗しないことを確認する。
2. BUNDLE owner と m-line → transport 対応を確定する。新 transport が必要なら pending resource として生成する。
3. ICE generation、DTLS parameter/lifecycle、SCTP binding/parameter、RTP/transceiver/router の順序を coordinator の単一 commit path に置く。実際の入替順は設計文書で packet routing と shared transport の安全性を確認して固定する。
4. local/remote descriptions と signaling state を新 current として公開する。orphan speculative resource を停止し、`negotiationneeded` を application 操作の残件から再計算する。
5. commit による最終的な変化の event と、まだ開始していない ICE/DTLS/SCTP connect kick を送る。remote offer/pranswer や pending gathering に伴う event・暫定接続は既に起きてよく、同一 object/generation について再送しない。非同期接続失敗は「commit 前 validation の失敗」と混同せず、対象 generation の接続失敗として状態・イベントを報告する。

commit path に例外が残る場合は、公開状態を切り替える前に失敗しうる処理を完了するか、元の current へ戻せる compensating action を定義する。description だけ先に current へ移す、旧 ICE pair を破棄してから SDP validation に失敗する、部分的に router だけ更新する状態を禁止する。rollback は baseline first-wins に戻し、pending candidate/EOC と pending-only transport を cleanup する。発火済み event は取り消さず、再適用での二重発火を防ぐ。

### 3.3 段階的な移行

1. 設計文書・状態遷移表・test-only invariant helper を追加し、現状で赤になる期待ケースを記録する。
2. coordinator と operations の直列化を導入し、description の begin/replace/commit/rollback を移す。
3. ICE/DTLS generation と trickle bucket、次に BUNDLE/transport ownership を移す。
4. RTP/transceiver/router と SCTP を stage/commit/rollback API に移す。
5. 不要になった mutable field、局所 rollback/cleanup、重複 connect 起動を除去する。各段階で外部の observable behavior を必要な仕様修正以外は維持する。

## 4. 技術的制約・注意点

- `createOffer` / `createAnswer` の副作用、`setLocalDescription` の gather と SDP 再生成、`setRemoteDescription` の即時 event があるため、`set*Description` だけを包んでも transaction にはならない。offer 生成と candidate gathering の generation ownership も設計対象にする。
- pranswer は final commit ではないが、仕様上 RTP・ICE/DTLS・新規 SCTP/DataChannel の暫定開始がありうる。2.2 の条件で current baseline を維持し、rollback 時は暫定通信を終了する。外部に渡した track/transceiver/DataChannel object と event は無かったことにせず、2.3 の寿命・再通知契約を守る。
- current/pending が同じ BUNDLE transport を参照する場合、pending の m-line reject/stop で shared ICE/DTLS を止めない。split/merge や tag 変更では MID ごとの candidate routing と SCTP binding を検査する。
- `addIceCandidate` の pre-SRD buffering は既存の werift 利便動作。規範上の厳格な拒否は WPT runner wrapper に留める。明示 ufrag、未指定、null/空 candidate の EOC、duplicate、replacement/rollback 後の遅延到着を個別に定義する。
- 既存 DataChannel association の port 変更、DTLS fingerprint/role の不整合、unsupported codec/rejected m-line は、実装可能範囲を preflight validation で決める。未対応を黙って部分適用しない。
- protocol 層の ICE nomination、DTLS handshake、SCTP congestion control、RTP codec/packetizer、全 WPT failure の再設計は対象外。ただし generation を切り離すために lower-layer API 境界の変更が必要なら対象とし、該当 package の `AGENTS.md` とテストも確認する。
- CI 依存関係の失敗が gate を塞ぐ場合は先に原因を修正する。WPT に触る段階では `git submodule update --init --recursive` を実施する。

## 5. テストと完了条件

### テスト設計

- `packages/webrtc/tests` に reusable な Arrange utility を一つ置き、`assertNegotiationInvariants(pc)` 相当の test-only helper を提供する。current SDP と live RTP/router、BUNDLE owner/MID/mLineIndex、ICE credential/candidate/EOC/checklist/selected pair の generation、DTLS role/fingerprint、SCTP association/parameter、orphan transport を検査する。内部観測のための test-only access を使い、公開 API は増やさない。
- 状態遷移表を local/remote offerer の両方向で実行する。replacement offer/pranswer、rollback/implicit rollback、validation failure、unsupported codec と port 0、`transceiver.stop`/m-line reuse、partial BUNDLE/tag/split/merge、local/remote ICE restart、answer 前 trickle と current への遅延 trickle、DTLS replacement、SCTP max-message-size と port change、pending-only resource cleanup、duplicate 適用・EOC を含める。各操作後と final answer 後に helper を呼ぶ。
- pranswer 固有テストで、初回と再交渉の RTP 暫定送受信、pending ICE checks/DTLS handshake、新規 SCTP/DataChannel、inactive m-line の送信抑止を確認する。replacement pranswer と異なる final answer、pranswer 後 rollback、implicit rollback をそれぞれ検証し、旧 current の RTP・selected pair・DTLS・DataChannel が継続することを実通信で確認する。
- event/object テストで、remote offer 時の `ontrack` と transceiver 作成通知、pending ICE candidate/EOC、provisional `ondatachannel` のタイミング・件数・object identity を確認する。rollback 後の remote-only transceiver 除外、`addTrack` 済み transceiver の存続、pending-only channel の close、application-created object の参照存続と association ごとの open/close、同一 description 再適用時の無重複、replacement と後日の新 offer の正当な新通知を検証する。
- 実通信テストで、re-offer/rollback 中の既存 RTP 継続、ICE restart commit 後の新 generation nomination と RTP 再開、rollback 後の旧 selected pair での RTP、BUNDLE split/merge 後の MID ごとの経路、許容された renegotiation 後の DataChannel 双方向通信を確認する。フィールド比較のみで合格にしない。
- invariant helper は 2.4 のキーについても、各 signaling state で current SDP と live table の一致を検査する。current remote SDP の SSRC・RTX 対応・MID+RID が current の receiver（と track）に解決されること、router が知る extmap ID が current SDP と矛盾しないこと、`stable` に保留分が残らないことを含む。helper は各操作の後に呼ばれるので、同種の問題を機械的に検出できるようにする。
- PLI の送信可否は、その SSRC が運ぶ payload type の live な受信 codec（pending 中は current、commit で切替、rollback で復元）で決め、再利用される track の codec には依存しない。invariant helper は各操作の後に PLI 判定が current SDP の RTCP feedback と一致することを検査し、回帰テストは同じ SSRC の再交渉で NACK/PLI を追加・削除したときの実際の PLI 送信を pending・rollback・commit で確認する。
- rollback は description 由来の経路だけを戻し、アプリが追加した sender の SSRC 経路（pending 中の `addTransceiver()` を含む）は live な sender がある限り残す。invariant helper は各操作の後に、停止していない全 sender の SSRC がその sender に解決されることを検査する。
- `restartIce()` は current と pending のローカル ufrag を置き換え対象として記録し（W3C `[[LocalIceCredentialsToReplace]]`）、rollback・glare では要求を保持して次の offer でも restart する。answer の確定で current のローカル資格情報が対象外になったときだけ解除する。provisional ICE の check は送信時の checklist（revision と pair の所属）にだけ効き、replacement pranswer 前の遅延応答や別資格情報からの受信 check は新しい checklist を nominate しない。BUNDLE の所有（staged topology、候補配送、DTLS role、answer の tag）は最初の group だけでなく全 group に適用する。それぞれ回帰テストにする。
- EOC は live・provisional のどちらの generation も完了させる（RFC 8838）。EOC 後の同じ generation の候補は current / pending SDP にも checklist にも入れず、mDNS 名も解決しない。EOC 前に届いて mDNS 解決中の候補は保持し、その解決後に generation を完了する。解決中に ICE restart や replacement pranswer が起きた候補は破棄する。ICE 単体と PeerConnection（restart の pranswer）の両方で、EOC 後の候補と mDNS 解決中の競合を回帰テストにする。
- 2.4 の各行について、pending 中に current の経路が変わらないこと、answer で確定・rollback で復元されることを実通信で確認する回帰テストを置く。
- 2.6 の各機能について、pending 中・rollback 後・commit 後の挙動を確認する回帰テストを `negotiationTransactionDevelopIntegration.test.ts`（ICE 層の TURN allocation は `packages/ice/tests/ice/turn-restart.test.ts`）に置く。TURN はローカル TURN server を使い、restart の offer・commit 後の trickle・新 generation での通信まで確認する。修正前の実装で失敗することを確認する。
- **property test（追加要件）:** seed 固定の乱数で操作列を生成して実行し、各操作の後に invariant helper を、各ステップの後に video・audio・DataChannel の実通信を検査する。操作は offer / pranswer / answer / rollback / replacement、ICE restart、BUNDLE split・merge、m-line 追加、EOC、routing key の変更（RTX 対応、extmap の移動、および拒否されるべき extmap ID 再割当て）を含む。CI では固定 seed と、過去に不具合を見つけた seed を常に再生する。失敗時は seed と操作列を出力し、環境変数で seed 数・step 数を増やした深い探索を手元で実行できるようにする。
- **レビュー前の自己点検（追加要件）:** レビュー依頼の前に、深い探索（数百 seed）と、「pending 中に live table へ書き込む経路」を洗い出す自己レビューを 1 回ずつ行い、見つかった経路は 2.4 の規則で閉じるか、6 章の既知の制約に記載する。
- **有効値・相手の多様性・割り込み（2.10）:** invariant helper の `expectedLive` が 2.10 の有効値表（direction・送信 codec・max-message-size）を各操作の後に検査し、pranswer 中の remote SSRC の route も検査する。`negotiationTransactionEffectiveValues.test.ts` は表の行ごとの回帰試験、`negotiationTransactionMutation.test.ts` は変異の単独（CI）・全ペア・乱択の組み合わせ（手元の深い探索）、`negotiationTransactionInterrupt.test.ts` は待機 × 割り込みの表を実行する。develop 差分ファズも `--mutate` で変異を配送する。
- テストは Arrange / Act / Assert に分け、共有 Arrange を単一 utility に置き、Act / Assert の操作と期待には適切な粒度の日本語コメントを入れる。

### 完了判定

- [ ] 独立した設計文書に current / pending / rollback baseline / speculative side effect、phase、失敗状態、全 subsystem の owner・mutation timing を定義した遷移表がある。
- [ ] begin / replace / validate / prepare / commit / rollback / cleanup を coordinator の一つの lifecycle から追え、replacement は pending latest-wins、baseline first-wins である。
- [ ] final answer まで既存 session が通信でき、SDP・RTP/BUNDLE/ICE/DTLS/SCTP の部分 commit が残らない。rollback 後の current session は通信可能で、pending-only resource と candidate/EOC は残らない。
- [ ] pranswer で許可された RTP/ICE/DTLS/SCTP の暫定動作、final answer による切替と余剰解放、rollback/replacement による baseline 復元が 2.2 の条件どおりである。
- [ ] pending 中の `ontrack`、transceiver、ICE candidate/EOC、`ondatachannel` を 2.3 の時点で通知し、rollback 後の object 寿命と同一操作の重複通知抑止がテストされている。
- [ ] local/remote ICE restart の answer SDP と committed generation が一致し、新 checklist/nomination が進む。BUNDLE owner、RTP/router、SCTP association、`negotiationneeded` も current/pending 境界を守る。
- [ ] invariant helper、両方向の transition matrix tests、RTP/ICE/BUNDLE/DataChannel の実通信回帰テストが追加されている。不要になった局所的な mutable state と cleanup が除去されている。
- [ ] 2.4 のルーティングキー規則（追加は即時、current のキーの変更は拒否または commit まで保留、rollback で復元）が全キーで守られ、invariant helper がそれを検査している。
- [ ] property test が CI の固定 seed と回帰 seed で通り、レビュー依頼前に深い探索と自己レビューを実施している。
- [ ] 2.8 の規則がそれぞれ回帰テスト（修正前の実装で失敗し、修正後に通る）で確認されている。invariant helper は stable の受信表に確定していない payload type がないこと、staged の受信値が残らないこと、remote track の codec を検査する。
- [ ] 2.9 の再利用契約が設計文書に表として記載され、適用は SDP と生成記録だけから組み立てられる（検証が通るまで状態に書き込まず、失敗時の undo に頼らない）。develop との差分ファズで「develop は受理して通信でき、HEAD は拒否または通信できない」差分が 0 件で、property test の description pool 操作と原子性の oracle が通る。
- [ ] 2.7 の provisional ICE generation のライフサイクル（作成・相手の情報・check・終了）が設計文書とレビュー解説に図と表で記載され、実装と一致している。
- [ ] 2.6 のとおり、分岐点以降に `develop` へマージされたソース変更を伴う機能（#716、#721、#688、#731、#729）を網羅的に確認し、調整が必要な箇所が修正され、回帰テストが修正前の実装で失敗し修正後に通る。
- [ ] 2.5 のとおり issue 705 の挙動が transaction の中で動き、`tests/issue/705*.test.ts` は意図した挙動変更の 3 点を除いて develop と同じ期待で通る。
- [ ] 2.10 の有効値表が設計文書にあり、`expectedLive` が一律の「live = current SDP」検査を置き換えている。表の各行に回帰試験があり、修正した箇所は修正前の実装で失敗し修正後に通る。
- [ ] 変異ライブラリの単独・全ペア・乱択の組み合わせ、割り込みの表、変異を含む develop 差分ファズが通る（差分ファズは「develop は受理して通信でき、HEAD は拒否または通信できない」が 0 件、または意図した拒否として理由を記載）。
- [ ] 仕様と試験の対応表（7 章、`NEGOTIATION_SPEC_COVERAGE.md`）で partial / uncovered が 0 件で、その後に自己レビューを行っている。
- [ ] `cd packages/webrtc && npm run type && npm test`、cross-package 変更時の `npm run type && npm run test:small`、関連 E2E が通る。WPT runner や allowlist を変更した場合は `npm run wpt --workspace packages/webrtc`（coverage wiring 変更時は `npm run wpt:coverage --workspace packages/webrtc`）も通る。CI dependency failure があれば先に解消し、transaction tests が CI で実行される。

## 6. 対象外・既知の制約

完了条件は有限とする。2.1 の状態遷移表、設計文書の mutation matrix、property test の操作カタログに載っている組み合わせが本チケットの保証範囲である。これらに載っていない新しい組み合わせ（別の subsystem・操作・相互運用先）で見つかった問題は、懸念事項ではなく**後続チケット**として扱う。既知の制約は次のとおり。

- 相互運用の確認は Chrome のみ。Firefox・Safari などとの相互運用は対象外。
- 生成済み description の再利用は 2.9 の契約表にある操作順序だけを保証する。表にない再利用順序は後続チケットとする。
- SCTP association を持たない接続済み session で後から作った DataChannel は、再交渉しても開かない（`develop` から既存）。
- header extension の ID 対応は PeerConnection 全体で 1 つ。別 transport（非 BUNDLE）の m-line が同じ ID を別 URI に使う構成は未対応。current が使う ID の再割当てだけを拒否する。
- `addTransceiver()` で作った未関連付けの transceiver を、remote offer が m-line に関連付けることがある（W3C は `addTrack()` 由来だけを再利用する）。werift の既存動作。
- ICE restart の commit で ICE 層は旧 selected pair を手放すため、新 generation が nominate するまで RTP が途切れる。RFC 8445 / 8839 と Chrome は新しい pair が選ばれるまで旧 pair で送り続ける。pranswer 中の provisional generation の nominate 結果は commit で引き継がない（2.7）。
- ICE server がなく、restart の offer が end-of-candidates まで通知した後に変更した ICE server 設定は、その restart では使わず次の restart で使う。
- STUN / TURN がある場合、restart の relay 候補と end-of-candidates は commit 後に届く。relay だけの構成では新しい allocation ができるまで新 generation の候補がない。
- `setConfiguration` で `iceTransportPolicy` だけを変えても既存の ICE transport には反映されない。（`develop` から既存）。`close()` と並行して完了した TURN allocation は閉じる（2.8）。
- remote description の適用中に、送信 track の codec に合わせて設定の codec 順序と動的 payload type が調整されることがある。影響するのは後の offer だけで、current の RTP には影響せず、rollback でも戻らない。
- m-line の再利用で置き換わる transceiver は、再利用する offer の適用時点で stopped になる（current の m-line は既に拒否済みで、current の通信は使っていない）。rollback で戻る。
- `createOffer` は transceiver の空の codec・header extension リストに既定値を入れる。交渉済みの状態ではなく、適用されなかった offer の後も残る。
- pranswer と final answer で SSRC が変わる場合は、変異試験で再現して修正した（2.10: 置き換えた pranswer の SSRC の track を final answer の SSRC が引き継ぐ）。answer が載せなくなった current の SSRC の route と track は残る（`develop` から既存）。実機での相互運用は未確認。BUNDLE の非 tag m-line の SDP 候補は投入しない（tag が拒否される場合だけ影響）。port 0 の answer の `c=` 行は、非対応 codec の拒否経路では出力されることを確認した（ほかの経路は未確認。Chrome は受理する）。
- answer / pranswer が offer で restart していない transport の remote 資格情報を変えた場合は、local の資格情報を保ったまま新しい remote generation で接続確認をやり直す（Chrome と同じ）。新しい pair が nominate されるまで通信は途切れる。
- `packages/rtp` の `TransportWideCC.serialize()` は padding がないと RTCP header の length が実際の長さより短くなり、相手は transport-cc feedback を解析できない（`develop` から既存、交渉の範囲外。後続チケット）。試験は feedback の送信を観測して検証する。
- 変異ライブラリと develop 差分ファズは両端とも werift で動かす。他実装は変異が表す範囲でしか確認していない。
- protocol 層（ICE nomination、DTLS handshake、SCTP 輻輳制御、RTP codec）の再設計と、全 WPT failure の解消は対象外（4 章のとおり）。

## 7. 仕様と試験の対応表（策3）

2.1〜2.10 と 5 章の各文（要件）を、それを検証する試験名（または invariant helper）か「対象外（理由）」に対応づけた表を `packages/webrtc/NEGOTIATION_SPEC_COVERAGE.md` に置く（全 251 件: covered 230 件、対象外 21 件、partial / uncovered 0 件）。対象外は設計文書・コード構造・作業プロセスの記述だけで、理由を併記する。

- 表の作成時点で partial / uncovered だった 59 件は、要件 ID を名前に持つ試験（`negotiationTransactionCoverageEvents` / `Transport` / `Ice` / `Codecs`、`packages/ice/tests/coverageConsent.test.ts`）で閉じた。そのうち修正前の実装で失敗したものは、2.10 の「見つけ、修正して確定した規則」として実装を直した。
- 要件や試験を変えたら表も更新する。新しい要件は、ID を名前に含む試験を追加してから covered にする。
