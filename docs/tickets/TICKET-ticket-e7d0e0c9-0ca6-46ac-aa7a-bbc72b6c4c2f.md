# [RTP] SDPにSSRCが存在しない単一ストリームの受信RTPを適切なreceiverへ学習・配送する（#356）

## 1. 目的と背景

### 元報告と判定
- 元Issue: [#356](https://github.com/shinyoshiaki/werift-webrtc/issues/356)（tylerlong）。RingCentral（SIP over WebSocket）から届く音声Offerには `a=ssrc` がない。werift を `RTCPeerConnection` の代わりに使うと、受信RTPが `ssrcReceiver not found` で全部捨てられる。同じアプリをブラウザの `RTCPeerConnection` で動かすと正常に動く。
- **コード上で有効な未処理ケースだと確認した**（下の「現状コードの調査結果」を参照）。元Issueの接続条件での実通信再現は未実施。
- 報告者は werift-rtp 単体で自前実装して回避し、Issue をクローズしてよいと言っている。ただし、ブラウザ互換の挙動としては今も未対応のまま。
- 関連: [#355](https://github.com/shinyoshiaki/werift-webrtc/issues/355)（OPEN。同じSDPにある `a=rtcp:48037`、つまり RFC 3605 のアドレスを省いた形のパース）。**現在の develop（`63b3182ab`）では `SessionDescription.parse()` が `a=rtcp:48037` で `Error("exception")` を投げることを確認した**（`src/sdp.ts` L203–209 → `ipAddressFromSdp("")`、L591–595）。#356 のSDPをそのまま `setRemoteDescription` に渡すと、ルーティングより前の段階で失敗する。#355 は別チケット `a2bc2644-ae08-4dfa-89eb-56e39822f72d`（ブランチ `ticket/a2bc2644-…`）で扱う。本チケットでは `sdp.ts` を変更しない（3.6 参照）。

### 問題の本質
RFC 8843 / RFC 9143（BUNDLE）§9.2「Associating RTP/RTCP Streams with the Correct SDP Media Description」は、受信RTPと m-section の対応付けに MID ヘッダ拡張、SDPのSSRC、payload type を順に使えると定めている（実装時に RFC 9143 §9.2 の原文で順序と条件を確認すること）。ブラウザ（libwebrtc）は、SDPにSSRCがない単一ストリームでも、MID または一意な PT から受信先を決めて SSRC を学習する。werift の判定材料は **SDPのSSRC** と **RID** だけで、どちらもない従来型エンドポイント（SIPゲートウェイ、SBC、メディアサーバなど）からのRTPを配送できない。

---

## 2. 現状コードの調査結果（develop `63b3182ab` 時点）

| 箇所 | 内容 |
| --- | --- |
| `packages/webrtc/src/peerConnection.ts` L865–871 | `dtlsTransport.onRtp` → `router.routeRtp(rtp)`。**transport を渡していない**（`routeRtcp(rtcp, dtlsTransport)` は渡している）。 |
| `packages/webrtc/src/media/router.ts` L254–294 `registerRtpReceiverBySsrc` | `encodings.filter((e) => e.ssrc != undefined) // todo fix`。SSRCがないm-lineでは route も track も作らない（headerExtensions は登録する）。 |
| `packages/webrtc/src/media/router.ts` L341–397 `routeRtp` | ① `ssrcTable[ssrc]`、② RID 拡張があれば `receiverByRid`、③ どちらもなければ `ridTable` の receiver の `trackBySSRC` だけを探す（simulcast 用の学習。L366–375）。どれにも当たらないと L377 `// bug` を経て L382 `ssrcReceiver not found` で破棄する。**MID拡張は route 決定に使われず**、receiver が見つかった後に `sdesMid` を記録するだけ（L386–389）。 |
| `packages/webrtc/src/transceiverManager.ts` L693–730 `getRemoteRtpParams` | `encodings[].ssrc = media.ssrc[0]?.ssrc`。SSRCがないと `undefined` になる。 |
| `packages/webrtc/src/transceiverManager.ts` L1035–1088（setRemoteRTP 相当） | 受信方向なら `registerRtpReceiverBySsrc` を呼ぶ。remote が送信方向なら `ontrack` を **`transceiver.receiver.track`** で発火する。SSRCがないときの `receiver.track` は `tracks[0] ?? defaultTrack`、つまり **`defaultTrack`** になる。`setupTWCC` は `remoteMedia.ssrc[0]` があるときだけ呼ばれる。 |
| `packages/webrtc/src/media/rtpReceiver.ts` L167 `get track` / L394 `addTrack` / L698 `handleRtpBySsrc` / L723 | `handleRtpBySsrc` は `trackBySSRC[ssrc]` が引けないと track なしで処理する（統計は数えるが、アプリへの `onReceiveRtp` は出ない）。PT が受信 codec 表にないと L723 で破棄する。 |
| `packages/webrtc/src/media/router.ts` L100–104, L165–197 | `learnedSsrcs` は「パケットから学習した SSRC」。rollback（`restoreRoutes`）では、endpoint が残っていれば保持される。SDPで同じ SSRC を登録すると印が外れる（`registerRtpReceiver` L246、`commitStaged` L118）。 |
| `packages/webrtc/src/media/router.ts` L59–82 TSDoc | ルーティングキーの表（SSRC / RID / PT / extmap…）。**「パケットから学習した SSRC → receiver」の規則は表にない**。 |

**重要な観察:** SSRCがない m-line では、`ontrack` が **`defaultTrack`** で既に通知されている。学習時に `transceiver.addTrack(new MediaStreamTrack(...))` で新しい track を作ると、`receiver.track` が新しい track に入れ替わる。するとアプリが `ontrack` で受け取った track にはRTPが一切届かない。**学習した SSRC は通知済みの `receiver.track` に結び付ける必要がある。**

---

## 3. 実装内容

### 3.1 transport 文脈を router に渡す
- `peerConnection.ts` の `dtlsTransport.onRtp.subscribe` で `this.router.routeRtp(rtp, dtlsTransport)` を呼ぶ。`routeRtcp` と同じ形にする。
- SDP 由来の SSRC 経路、sender の経路、RID の経路では transport を使わない（既存挙動を維持）。transport は **未知SSRCの学習判定** と、**パケットから学習した SSRC 経路の引き当て**（3.7 の追加要件）に使う。
- 単体テストやツールで `routeRtp(packet)` を transport なしで呼ぶ互換経路では、学習 fallback を行わない（従来どおり drop）。

### 3.2 未知SSRCの学習（`RtpRouter` に private メソッド `learnUnknownSsrc` のようなものを追加）
既存の ①SSRC表 → ②RID → ③simulcast の `trackBySSRC` 検索がすべて外れたときだけ、次の順で判定する。

1. **MID 拡張がある場合**: `extensions[RTP_EXTENSION_URI.sdesMid]` の MID を持つ transceiver の receiver を候補にする。次をすべて満たすときだけ学習する。
   - `receiver.dtlsTransport === 受信transport`
   - 受信方向（`direction` が recvonly / sendrecv）で、stopped / stopping / `pendingRejection` でない
   - `packet.header.payloadType` がその receiver の受信 codec 表にあり、RTX ではない
   - MID が一致しても条件を満たさなければ学習せず、drop して理由をログに残す。別の m-line への推測 fallback は行わない。
2. **MID も RID もない場合（#356 のケース）**: 受信transport 上にある **「SDPにSSRCがなく、simulcast でもない」受信可能な receiver** を候補にし、PT が受信 codec 表にある receiver で絞り込む。**候補がちょうど1つのときだけ** 学習する。0件または2件以上なら学習せずに drop し、`log("unknown ssrc: ambiguous", ssrc, pt, mids)` のように理由を残す。
   - RFC 9143 §9.2 の「PT が BUNDLE 内で一意なら PT で関連付ける」と同じ考え方。BUNDLE で audio と video が同居していても、PT が重ならなければ一意に決まる。
   - SDPに `a=ssrc` がある m-line は fallback の候補にしない（SSRC 切替や不正 SSRC を誤学習しないため）。

**候補集合の持ち方（推奨）:** router に新しい永続テーブルを追加しない。TransceiverManager / PeerConnection が、現在の transceivers から候補を作る provider を router に注入する（例: `router.unknownSsrcCandidates = (transport) => RTCRtpReceiver[]`）。transceiver の mid / direction / dtlsTransport / codecs は既存の negotiation snapshot がすでに管理しているので、新しいルーティングキーの staging / rollback 規則を増やさずに済む。「SDPにSSRCがない m-line か」は、`registerRtpReceiverBySsrc` の時点で receiver にフラグ（例: `remoteSsrcLess`）として記録するか、`receiver` の受信パラメータから判定する。フラグを持たせる場合は `RTCRtpReceiver` の negotiation snapshot（`restoreNegotiationState`）に含める。

### 3.3 学習時の登録処理（SSRC・track・codec の整合）
- `ssrcTable[ssrc] = receiver`、`learnedSsrcs.add(ssrc)`（既存の simulcast 学習と同じ「パケット由来」扱い。staged / provisional には触れない）。
- receiver 側に **通知済みの `receiver.track`（`defaultTrack`）を結び付ける** メソッドを新設する（例: `receiver.bindLearnedSsrc(ssrc, codec)`）。
  - `track.ssrc = ssrc`、`track.codec = deliveredTrackCodec(kind, codecOfPt, codecs)` を設定し、`tracks` と `trackBySSRC` に登録し、`learnedTrackSsrcs.add(ssrc)` する。
  - `transceiver.onTrack` / `pc.ontrack` を **再発火しない**（SDP適用時に通知済み）。remote が送信方向でなく `ontrack` 未通知の m-line では学習しない、という条件も検討する。
- その後に `receiver.handleRtpBySsrc(packet, extensions)` で初回パケットから配送する。TWCC は `handleRTP` 内の `hasFeedback(mediaCodec, transport-cc)` → `setupTWCC(ssrc, true)` が処理するので、追加作業は不要（確認だけ行う）。
- 学習後は、remote SR（`routeRtcp` の `ssrcTable[packet.ssrc]`）と NACK / PLI の宛先 SSRC も同じ経路で解決される。

### 3.4 学習数の上限・再登録・解除のルール
- **fallback で学習する SSRC は receiver ごとに 1 つまで**（単一ストリームが前提）。同じ receiver に別の SSRC が来たときの方針（推奨）は次のとおり。
  - 新しい SSRC が **3.2 の条件を満たした場合だけ置き換える**。旧 SSRC の route と `learnedSsrcs` を外し、同じ track の `ssrc` を更新する（SIP の再 INVITE や、メディアサーバ切替による SSRC 変更を想定）。置き換えたことはログに残す。
  - 置き換えで表は増えないので、SSRC を変え続けるピアでも `ssrcTable` / `learnedSsrcs` は有界のまま。
  - SRTP の認証を通ったパケットだけが router に届く。そのため経路外からのなりすましは起きず、上限はピアの不具合への対策という位置付けになる。
- **RTX**: SDPにSSRCがないと `ssrc-group:FID` もないので、RTX SSRC を media SSRC に対応付けられない。RTX PT のパケットからは学習せず drop する（ログを残す）。
- **padding-only** パケット（payload なし）からの学習は可否を決める。推奨は「PT が媒体 codec なら学習してよい」。
- **後から SDP が SSRC を与えた場合**: `registerRtpReceiver` が learned の印を外し、SDP 由来の route に置き換える（既存の規則）。SDP の SSRC と学習済み SSRC が違う場合、学習済み route を残すか消すかを決めて TSDoc とテストに書く（推奨: その m-line が SSRC あり SDP になった時点で fallback 学習分を外す）。
- `unregisterTransceiver` / transceiver stop では、既存処理が `ssrcTable` から receiver の route を消す。`learnedSsrcs` と receiver の `learnedTrackSsrcs` にも残らないことを確認する。

### 3.5 ドキュメント・規則の記録
- `RtpRouter` の TSDoc 表（router.ts L67–74）に「パケットから学習した SSRC → receiver（MID / SSRC-less fallback）」の行を追加する。pending 中の学習、rollback での保持、SDP 登録時の上書きについても記載する（`packages/webrtc/AGENTS.md` Do 6: 規則は実装の TSDoc とテストに書く）。
- `changelog.md` に挙動変更（SSRCがない SDP で受信できるようになったこと）を追記する。

### 3.6 #355 との分担（決定: 案 (b)。本チケットでは #355 を修正しない）

**決定:** 本チケットの PR では `packages/webrtc/src/sdp.ts` を変更しない。#356 の RingCentral SDP は、**`a=rtcp:48037` の 1 行だけを除いた形** で回帰テストに使う。元の SDP（`a=rtcp:48037` を含む）を使う統合テストは、**2 つのチケットのうち後から develop に入る PR** が有効にする（下の「合流ルール」）。

**理由:**
1. **#355 は独立したチケットで、すでに詳細化が進んでいる。** 別チケット `a2bc2644`（`origin/ticket/a2bc2644-…`。2026-11-11 時点で docs コミットのみ、PR は未作成）の範囲は次のとおりで、本チケットの範囲（RTP ルーティング）とは性質が違う。
   - ポートの検証（不正な値をエラーにする）
   - `a=rtcp` / `a=rtcp-mux` のシリアライズの変更
   - 拒否 m-line の出力互換（案 A / B の選択）
   - `npm run doc` と changelog の更新
   同じ PR に混ぜると、SDP 出力の互換性確認（negotiation-diff、E2E）が本チケットのレビューにも必要になる。さらに、並行して進むブランチと `sdp.ts` で競合する。
2. **#355 のテストは #355 側が持っている。** #355 チケットにはすでに「`tests/issue/355.test.ts` で #356 の RingCentral offer を `SessionDescription.parse` しても例外にならない」と「#356 の RingCentral SDP を `setRemoteDescription()` できる」が回帰テストと完了条件として入っている。案 (a) にすると同じ検証を二重に持つことになる。
3. **`a=rtcp:48037` を除いても本チケットの検証対象は変わらない。** werift は `rtcpPort` / `rtcpHost` を受信処理で参照していない（参照は `sdpManager.ts` L102–103 の書き込みだけ）。また RingCentral SDP には `a=rtcp-mux` があり、RTCP は RTP と同じ transport に多重化される。そのため、この 1 行の有無は SSRC 学習・配送の挙動に影響しない。
4. **除いた形で本チケットの経路が通ることは確認済み**（develop `63b3182ab`、一時スクリプトで確認）。
   - 元の SDP: `setRemoteDescription` が `exception` で失敗する。
   - `a=rtcp:48037` だけを除いた SDP:
     - `setRemoteDescription` → `createAnswer` → `setLocalDescription` が成功する。
     - `ontrack` が 1 回、`track.ssrc === undefined`（既定 track）で発火する。
     - transceiver は `currentDirection: "recvonly"` になる。
     - 受信 codec は PT 109（OPUS）と PT 0（PCMU）になる。

**本チケットでの実装（テスト用）:**
- RingCentral SDP は **元の文字列のまま** fixture に置く（例: `packages/webrtc/tests/issue/356.fixture.ts`、または 356 テストの共有 Arrange ユーティリティ内）。`a=rtcp:48037` の除去は、fixture とは別のヘルパー（例: `withoutAddresslessRtcp(sdp)`。`^a=rtcp:\d+\r\n` に一致する行だけを消す）で行い、#355 へのリンクを日本語コメントで書く。fixture 自体を書き換えないので、後で元の SDP に戻すときはヘルパーの呼び出しを外すだけで済む。
- 本チケットでは `changelog.md` に #356（SSRC-less 受信）の項目だけを書く。#355 の項目は書かない。

**合流ルール（元の SDP での統合テストをどちらが有効にするか）:**
- **本チケットの PR をマージする時点で、develop に #355 の修正が入っている場合:** 本 PR で develop を取り込み、ヘルパーの呼び出しを外して、元の SDP のまま 356 の統合テストを通す。この場合、「#355 修正後の入力での学習・配送」は本チケットの完了条件として満たす。
- **本チケットが先に develop に入る場合:** 本 PR はヘルパー付きでマージする。#355 の PR が develop を取り込むときに `tests/issue/356.test.ts` のヘルパー呼び出しを外し、元の SDP で学習・配送まで通ることを #355 側で確認する。そのための作業項目を #355 チケット（`a2bc2644`）にも 1 行追加するよう依頼する（本チケットの作業として、#355 チケットの担当へ伝える）。
- どちらの場合も、ヘルパーを残したまま両方が develop に入る状態にはしない。後から入る PR のレビューで、ヘルパーが残っていないことを確認する。

### 3.7 追加要件: SSRC の一意性は RTP session（transport）単位（レビュー反復で追加）

**背景（レビューを通過できなかった理由）:** 6 回の指摘は、すべて同じ設計問題から出ていた。SSRC が一意なのは RTP session（transport）の中だけなのに、経路表 `ssrcTable` は PeerConnection 全体で SSRC をキーにした 1 つの表になっている。

| 回 | 指摘 | 対応 | 結果 |
| --- | --- | --- | --- |
| 2・3 | 別 transport の同一 SSRC を A へ誤配送 | — | — |
| 4 | — | B 側を破棄 | 正当な B の受信まで消えた |
| 5 | — | （未コミットのまま古いリビジョンがレビューされた） | 同じ指摘の繰り返し |
| 6 | RTCP（SR/RR）が A へ誤配送 | RTP 専用の補助表 `collidingRoutes` を追加 | RTCP は未対応のまま |

通過できなかった原因は次の 3 つ。
1. 指摘された症状だけを直していた（RTP だけ transport を区別し、RTCP は「対象外」と TSDoc に書いて残していた）。
2. SSRC の引き当て箇所が分散していた（`routeRtp` と `routeRtcp` の約 8 か所が直接 `ssrcTable[...]` を引いていた）。
3. 修正を未コミットのまま再レビューに出したため、修正前のコードが再レビューされた。

**要件:**
- [x] SSRC の引き当てを、transport を考慮する 1 つの関数 `endpointBySsrc(ssrc, transport)` にまとめ、RTP と RTCP のすべての経路（`routeRtp`、`routeRtcp` の SR / RR / 汎用 RTPFB（NACK など）/ REMB / PLI / FIR / その他 PSFB、`keyFrameRequestTarget`）をこの関数経由にする。判定順は次のとおり。
  1. 受信した transport に自分の補助経路（`collidingRoutes`）があれば、それを使う。
  2. なければ、別 transport でパケットから学習した経路（`learnedSsrcs` の receiver 経路）は使わない。
  3. それ以外は従来どおり `ssrcTable` で決める。
- [x] パケットから学習した経路の追加は 1 つの関数（`addLearnedRoute`）にまとめ、fallback 学習（`learnUnknownSsrc`）と RID / simulcast 学習（`learnSsrc`）の両方で使う。別 transport が学習済みの SSRC は、その transport の `collidingRoutes` に登録する（A の経路を奪わず、B も受信できる）。
- [x] simulcast の SSRC 探索（RID 拡張をやめた後のパケットを、RID receiver が学習済みの track SSRC で引く経路）は、受信した transport の receiver に限る。RID 側が先に SSRC を学習していても、別 transport の SSRC-less receiver は同じ数値の SSRC を fallback で学習できる（レビュー指摘）。
- [x] 置き換え済み fallback SSRC（`isRetiredFallbackSsrc`）の判定は、受信した transport の receiver に限る。別 transport で同じ数値の新しいストリームが来たら学習する。
  - MID 拡張がある場合は、その MID の receiver の置き換え履歴だけで判定する。同じ transport で別 MID が以前置き換えられた SSRC を使い始めたら、その MID の receiver が学習する。MID がない遅延パケットは、旧ストリームと区別できないので transport 上の全 receiver の履歴で破棄する（レビュー指摘）。
- [x] 相手の未知 SSRC がローカル sender の SSRC と一致しても `routeRtp` は例外を投げない。sender の経路を保ち、その SSRC は学習しない（RFC 3550 §8.2 の衝突）。
- [x] `collidingRoutes` は transceiver の登録解除、SSRC の置き換え・破棄で消える。receiver が停止済み、またはその SSRC の track を持たなくなった場合は、引き当て時に外れる。rollback（`restoreRoutes`）の後も、両 transport のパケット由来の経路は整合したまま残る。
- [x] `collidingRoutes` は transport ではなく SSRC をキーにした receiver の集合で持ち、引き当て時に receiver の**現在の** `dtlsTransport` と受信 transport を照合する（`ssrcTable` の学習経路と同じく、経路は receiver に付いて移る）。transceiver の transport が付け替わった後、旧 transport の RTP / RTCP はその receiver に届かず、新 transport では届く。削除も receiver 単位で行うので、旧 transport のエントリは残らない（レビュー指摘）。
- [x] leak probe に指標 `router.collidingRoutes` を加える。
- [x] **RFC 9143 §9.2 の判定順との突き合わせ（レビュー 9 回目の指摘を受けた監査）。** 指摘はすべて、実装の判定条件が §9.2 のアルゴリズムからずれた箇所から出ている（SSRC 表が RTP session 単位でない、MID の前に置き換え履歴を見ていた、PT 表を一部の m-line だけで作っていた）。§9.2 の各ステップと実装を 1 対 1 で照合し、次を直した。
  - **PT 表:** §9.2 は「BUNDLE 内で受信設定のある m-line すべて」から PT 表を作り、2 つ以上の m-line が受信する PT は表に入れない。MID のない未知 SSRC は、受信 transport 上で受信中の m-line のうち、その PT（メディア / RTX のどちらでも）を受信するものが **ちょうど 1 つ** で、それが `a=ssrc` も RID もない m-line のときだけ学習する。`a=ssrc` のある m-line・RID の m-line が同じ PT を受信していれば学習しない（レビュー指摘）。
  - **MID による対応付けの更新:** §9.2 は「パケットに MID があれば、その SSRC を MID の m-line に対応付け直す」と定める。fallback で学習済みの SSRC に別 MID が明示されたら、その MID の m-line が学習できる場合に引き渡し、できなければ破棄する（旧 m-line へ誤配送しない）。旧 m-line はその SSRC を置き換え済みとして覚え、MID 付きの遅延パケットで取り戻さない（§9.2 の「最後の MID 更新より古いパケットは無視」の近似）。SDP・RID・simulcast 由来の経路は MID で動かさない（既存挙動、3.1）。
  - **rollback:** baseline 後に学習済み SSRC の持ち主が変わった場合（A → B）、`restoreRoutes` は baseline のパケット由来経路（A）ではなく今の経路（B）を残す。receiver 側の track と表が食い違わない。
- [x] TSDoc（`RtpRouter`）に次の規則を書き、`npm run doc` で再生成する。
  - パケットから学習した経路は、学習した transport に属する。RTCP にも同じ規則を適用する。
  - SDP 由来の経路と sender の経路は transport で区別しない（既存挙動。3.1）。
- **意図的に範囲外とする点:** transport A の SDP で宣言された SSRC 55 と、SSRC のない transport B の SSRC 55 が衝突すると、B のパケットは A に届く（既存挙動、3.1「SDP 由来の経路は transport を使わない」）。SDP 由来の経路に transport の一致を求めると、BUNDLE 移行中に古い transport で届くパケットを失う恐れがあるため、本チケットでは変えず TSDoc に明記する。

**進め方の要件:**
- ~~再レビューの前に必ずコミットする~~ → 撤回。`ticket review` は未コミットの差分がないとレビューを開始しない（`skipped` / `no-uncommitted-changes`）。確認レビューは修正を未コミットのまま依頼し、差分が今回の変更ファイルだけであることを確かめる（3.8）。
- レビュー報告には、`pbt:deep` の leak の失敗が `develop` でも再現する ICE 側の既存 flaky（`ice.checkList` / `ice.remoteCandidates` の増加。ICE restart や pranswer の後）であることと、再現手順を書く。再現手順: `packages/webrtc` で `WERIFT_NEGOTIATION_LEAK_SEED=232 SEEDS=7 STEPS=10 CYCLES=6 npx vitest run tests/pbt/leak/negotiationLeakProperty.test.ts --retry=0`（seed は実行ごとに変わる。develop の一時 worktree でも seed 236 が 3 回中 1 回、同じ ICE の増加で失敗した）。
- RingCentral の元 SDP（`a=rtcp:48037` を含む）が未検証なのは、3.6 の合流ルールによる意図的なもの。報告にもそう書く。

### 3.8 追加要件: RFC 9143 §9.2 の判定手順に沿った学習（レビュー 9 回目以降に追加）

**背景（レビューを通過できない理由）:** 指摘 9 件のうち 6 件が非承認で、どれも同じ構造から出ている。SSRC-less 受信の学習を、werift の「SSRC 表をまず引く」流れの後ろに例外処理として付け足しており、RFC 9143 §9.2 の判定手順（MID → SSRC 表 → PT 表）と 1 つずつ照らし合わせていなかった。

- 指摘 1・4・5: SSRC 表が transport ごとに分かれていない（3.7）
- 指摘 7: MID を見る前に、置き換え済み SSRC の履歴で破棄している
- 指摘 9: PT 表を `a=ssrc` のない m-line だけから作っている

承認するレビュアーと深掘りするレビュアーが交互に入るため、条件のずれが残る限り、1 つ直すと次の 1 つが見つかる。そこで指摘を待たずに §9.2 の原文と実装を 1 ステップずつ突き合わせ、ずれをまとめて直す。

| §9.2 の規定 | 修正前 | 修正後 |
| --- | --- | --- |
| PT 表は受信設定のある**すべての** m-line から作り、2 つ以上の m-line が受信する PT は表に入れない | `a=ssrc` / RID のある m-line を数えていなかった（指摘 9） | transport 上で受信中の m-line をすべて数える（メディア PT も RTX PT も対象）。その PT を受信する m-line がちょうど 1 つで、しかも SSRC-less のときだけ学習する |
| パケットに MID があれば、SSRC の対応付けを MID の m-line に更新する | A が学習した SSRC に MID b が付いていても A に届いた（監査で発見） | B が学習できれば B に引き渡し、できなければ破棄する。A はその SSRC を置き換え済みとして覚え（`RTCRtpReceiver.retireFallbackSsrc`）、MID a 付きの遅延パケットで取り戻さない |
| （rollback での表と receiver の整合） | 持ち主が A から B に移った後で rollback すると、表は A に戻るのに track は B が持つ（監査で発見。パケットが失われる） | `restoreRoutes` は、パケットから学習した経路どうしなら今の持ち主を残す |
| PT 表の「受信中」は現在の session で決める | （未テスト） | `receiving` は確定済みの `currentDirection` を使う。保留中の offer が同じ PT の m-line を追加しても、MID のない未知 SSRC は曖昧として学習しない（MID を明示すれば学習する）。rollback で追加が消えれば学習する。保留中の offer が同じ PT の m-line を停止しても、commit までは曖昧のまま |

**要件:**
- [x] 上の表の修正（`router.ts`、`rtpReceiver.ts`）と TSDoc・`npm run doc` の再生成。
- [x] 回帰テスト（`router.test.ts`。共通の Arrange は `ssrcLessTestUtils.ts` の `createPayloadTypeSharingRouter`）。PT 共有・MID による引き渡し・rollback の 7 件は、うち 6 件が修正前のコードで失敗することを一時 worktree で確認済み（PT が分かれていれば学習する 1 件は修正前後とも通る）。
- [x] 保留中の offer が同じ PT の m-line を追加・停止するケースの回帰テスト 2 件（現行実装で通る。規則を固定するためのテスト）。
- [x] `leakProbe.ts` を develop の整形済みの形に戻す（マージコミットで崩れていた）。

**保留中の description と現在の session の分離（3.8 承認後のレビュー指摘）:**
- [x] 現在の session が SSRC も RID もない m-line に、保留中の description（remote offer / pranswer）が最初の SSRC を与えても、通知済み track の採用（`adoptDefaultTrack`）はその場で行わず、receiver に staging する（`RTCRtpReceiver.stageDefaultTrack`）。commit（`RtpRouter.commitStaged`）で track が SSRC と codec を採用し、fallback SSRC を外す。rollback では baseline の staging 状態に戻し、後続の description は staging を置き換える。
- [x] 保留中は、公開 track の `ssrc` / `codec`、`getStats()` の inbound-rtp、未知 SSRC の学習可否（`acceptsUnknownSsrc`）が現在の session のまま。現在の送信元が保留中に SSRC を切り替えても（300 → 301）学習して届く。保留中の SSRC（400）の RTP は `trackBySSRC` 経由で同じ通知済み track に届く。最終 answer（`deferConflicts` なし）は従来どおりその場で採用する。 SDP の encodings は codec ごとに同じ SSRC が並ぶので、staging 中は残りの encodings も staging する（同じ SSRC は無視し、別の SSRC の track は commit で追加する）。
- [x] 保留中の description が同じ m-line に **RID** を与える場合も同じ規則にする（レビュー指摘）。RID の track は `tracks` に入れず receiver に staging し（`RTCRtpReceiver.stagedTracks`。保留中の RID パケットは `trackByRID` 経由で届く）、commit で追加して fallback SSRC を外す。保留中は公開 track（`receiver.track`）と `acceptsUnknownSsrc` が現在の session のままなので、現在の送信元が SSRC を切り替えても（300 → 301）学習して届く。rollback では staging と `trackByRID`、`ridTable` が baseline に戻る。staging は remote description を適用するたびに捨てて作り直す（`TransceiverManager.setRemoteRTP`）。
- [x] commit で公開 track が RID の track に変わった m-line には、`NegotiationTransaction.commit` から `TransceiverManager.notifyCommittedRemoteTracks` で `ontrack` を通知する（保留中に通知を先送りした分。同じ track・同じ stream なら通知しない）。
- [x] **staging した RID track がパケットから学んだ状態の後始末（レビュー指摘）。**
  - rollback: rollback で消える RID（`trackByRID` が baseline にない RID）の media / RTX SSRC と、track が残らなかった学習済み SSRC は、receiver で忘れ（`forgetLearnedSsrc`）、`takeForgottenSsrcs` 経由で `RtpRouter.restoreRoutes` が学習済み経路も外す（`NegotiationTransaction` は receiver を先に、経路を後に戻す）。現在の送信元がその SSRC に切り替えれば fallback として学習し直す。
  - commit: fallback SSRC が保留中に新しい RID 付きでも届いていた（`mediaSsrcByRid`）場合、fallback を外す前にその SSRC の track の対応付けを RID の track に引き継ぐ（`RTCRtpReceiver.handOverFallbackToRid`）。経路は学習済みのまま残り、送信側が RID 拡張を省いても RID の track に届く。

**意図的に範囲外とする点（§9.2 監査の結果）:**
- SDP・RID・simulcast 由来の経路は、MID が別の m-line を示していても動かさない（3.1 の既存挙動。TSDoc に記載）。指摘された場合は、RID で学習した SSRC に限って MID での引き渡しを広げるかを判断する。その場合は receiver の `learnedTrackSsrcs` を外す API が必要。
- RTCP SDES の MID と BYE による対応付けの更新は未対応（develop にも実装がない）。指摘された場合は別チケットを提案する。
- SDP で宣言された SSRC と別 transport の SSRC の衝突（3.7 に記載済み）。

**`pbt:deep` の leak の ICE 失敗の扱い:** このチケットの中で ICE を直すことは範囲外とする。前回の実行（前任の報告）では leak の 27 件が単独でも失敗し、すべて `ice.checkList` / `ice.remoteCandidates` の増加（固定ケース「an ICE restart keeps the agent's credential history bounded」を含む）で、develop（`6474a6953`）の一時 worktree でも固定ケースと cycle seed 10 が同じ増加で失敗していた。再現手順: `packages/webrtc` で `WERIFT_NEGOTIATION_LEAK_SEED=10 WERIFT_NEGOTIATION_LEAK_SEEDS=1 WERIFT_NEGOTIATION_LEAK_STEPS=10 WERIFT_NEGOTIATION_LEAK_CYCLES=6 npx vitest run tests/pbt/leak/negotiationLeakProperty.test.ts --retry=0`。
  - 2026-11-14 の再確認（`ded0c3dc5` に保留中 offer のテスト 2 件を加えた作業ツリー）では再現しなかった。`pbt:deep` の leak は 652 件成功・1 件 flaky（heap seed 4、単独で成功）、上の seed 10 の手順は単独で成功、固定ケースは本ブランチと develop の両方で 3 回中 3 回成功した。負荷に依存する既存の揺らぎと判断する。
  - 方針: 案 (a) を採る。再び失敗したら、develop で再現することを確かめたうえで ICE / DTLS 側の別チケットを立て、レビュー報告に上の再現手順と「develop でも再現する」ことを書く。今回は再現しないので別チケットは立てていない。
  - 同じ実行の model seed 275（「after operation #42: traffic … the transport did not settle」）は、`tests/pbt/leak/negotiationLeakProperty.test.ts` の既知 flaky の記述どおりで、単独 replay で本ブランチ・develop とも 5 回中 4 回、同じメッセージで失敗する。scenario の seed 257 / 262 は flaky（単独で成功）。
  - 保留中の staging の修正後（`6d6bc4313` + 未コミット差分）の `pbt:deep`: fuzz 306/306、scenario 2159 成功・4 flaky（単独で成功）、model は seed 275 が失敗（単独 replay では成功。上記の既知 flaky）・2 flaky、leak は heap seed 4 が実行中に失敗。heap seed 4 は単独 replay で本ブランチ・develop とも 3 回中 3 回成功しており、過去の実行でも flaky として出ている負荷依存の揺らぎと判断する。修正途中の実行で落ちた固定ケース「a re-offer that gives an m-line learned without a=ssrc its SSRC keeps the learned route until the rollback」と seed 264 は、codec ごとに同じ SSRC が並ぶ encodings の扱いを直して解消した。
  - **並列探索の揺らぎの比較（RID staging の修正後、`ac51a5d3b` + 未コミット差分 vs develop `6474a6953`、同じコンテナで `npm run pbt:deep` を 3 回ずつ）:** 本ブランチは run1 が exit 0（model seed 275 flaky）、run2・run3 が model seed 275 で exit 1（run3 は leak heap seed 4 も失敗）。develop は run1 exit 0（seed 275・heap seed 4 が flaky）、run2 が leak heap seed 4 で exit 1、run3 exit 0。fuzz・scenario は両方とも失敗 0（scenario は毎回 1〜4 件 flaky、単独で成功）。
  - **seed 275 の単独 replay（交互に 6 回ずつ）:** 本ブランチ 5/6、develop 3/6 が同じ「the transport did not settle」で失敗。縮小後の最小失敗シーンは両方とも同じ形（`extmapMoved` の wireOffer → answer → rollback → `addTrack(video)` → glare → answer → settle）で、`ssrcRemoved` を含まない（SSRC-less の学習経路を通らない）。過去 3 回の比較（本ブランチ 1/5・4/5・5/6、develop 2/5・4/5・3/6）を合わせ、本チケットの変更による悪化ではなく既存の ICE / transport の揺らぎと判断する。heap seed 4 も develop で同じく失敗する。
  - **leak heap seed 4（P3 heap slope、閾値 16.00 KiB/cycle）の追加調査（`a9d207f12` + 未コミット差分 vs develop `6474a6953`）:** 単独 replay（ファイル全体）は両方とも 4 回中 4 回成功。heap テストだけを実行して判定値を記録すると、develop 16.0 / 16.2 KiB/cycle（2 回とも成功。全体実行では 3 回中 1 回失敗）、本ブランチ 16.3 / 16.4 / 16.4 / 16.5 / 16.9 KiB/cycle（R²≈0.94、閾値超えが多い）。最小の周期は「BUNDLE split and merge / ICE restart / re-offer」で `ssrcRemoved` を含まず、SSRC-less の学習経路を通らない。P1/P2（表の件数）は通っており、router / receiver の表は増えていない。develop がすでに閾値付近まで増える（前任報告の ICE restart 後の `ice.checkList` / `ice.remoteCandidates` の増加と同じ周期）ところに、本ブランチで約 0.3〜0.7 KiB/cycle が上乗せされている。上乗せ分の原因（receiver のフィールド追加で、保持され続けているオブジェクトが大きくなった可能性など）は未特定。~~**未解決の検証課題**として残す。~~ → 下の「原因の特定」で解決。
  - **原因の特定（ヒープスナップショットの比較。本ブランチ `e8f500f6b` + 未コミット差分 vs develop `6474a6953`、同じコンテナ）:** 一時テスト（`openCycleSession` で seed 4 の周期を 40 回 → `collectGarbage` → `v8.writeHeapSnapshot` A、さらに 120 回 → B。計測後に削除）で、A→B の保持オブジェクトを型ごとに集計した。
    - 保持の増分（self size 合計）: 本ブランチ 26.20 KiB/cycle、develop 26.40 KiB/cycle（ほぼ同じ）。上位の内訳（ArrayBuffer データ、`Candidate` +240、`RtpHeader` / `RtpPacket` +264、`Buffer` +704 など）も一致する。
    - `RTCRtpReceiver` / `RTCRtpTransceiver` / `MediaStreamTrack` / `RtpRouter` / `Map` / `Set` の増分は両方とも 0。両者で違う型は無名 closure（+500 / +480）と Context（+257 / +240）、Promise（+477 / +480）だけで、保留中の Promise の数の揺らぎの範囲。本チケットの差分に由来する保持はない。
    - 増え続ける `Candidate` の保持経路は両方とも同じ: `RTCPeerConnection → … → RTCIceTransport.connection → Connection.closedSignal (Promise) → PromiseReaction の連鎖 → Promise.allSettled の結果 → Candidate`。`packages/ice/src/ice.ts` の候補収集が ICE restart のたびに `Promise.race([Promise.allSettled(candidatePromises), this.closedSignal])` を行い、close まで解決しない `closedSignal` に反応が積まれる（Promise.race の典型的なリーク）。`packages/ice` は本ブランチで変更していない。
    - P3 の傾きの差（develop 16.0〜16.2、本ブランチ 16.3〜16.9 KiB/cycle）は、保持オブジェクトの差がないことから、GC のタイミングや `heapUsed` の測定の揺らぎと判断する（閾値 16 KiB/cycle に対し develop 自体が境目にある）。
    - 方針 (a) に従い、ICE 側の別チケット `74132240-6e06-4628-8ca1-13db4377f261`（「[ICE] 候補収集の Promise.race が closedSignal に反応を積み、ICE restart ごとに候補を close まで保持する」）を作成した。本チケットの中では ICE を直さない。

**確認レビューの依頼手順:**
- 修正は未コミットのまま依頼する（CLI は未コミットの差分がないとレビューを開始しない）。外部ツールが自動コミットした場合は、その旨と対象リビジョンを報告に書く。
- 依頼前に、未コミットの差分が今回の変更ファイルだけであることを確かめる。`npm run format`（ルート）が `packages/rtp/tests/codec/vp8.test.ts` を書き換えたら元に戻す。
- RingCentral の元 SDP（`a=rtcp:48037` を含む）は、従来どおり 3.6 の合流ルールで #355 側が確認する（#355 チケットへの後続作業の追記は、レビュー 8 回目で確認済み）。

---

## 4. 制約・注意点

- **誤配送の防止を最優先する**: 曖昧なら推測せず drop する（従来挙動）。他の transport、他の PeerConnection、停止済み transceiver、SSRCあり m-line には学習させない。router は PeerConnection ごとに独立したインスタンス（`peerConnection.ts` L146）だが、`bundlePolicy: "disable"` などで transport が複数あるので、transport 一致の確認は必須。
- **既存経路を回帰させない**: SSRC 既知、RID（MID+RID / RID のみ）、simulcast の RID 送信停止後の SSRC 学習（L366–375）、RTX（`ssrcByRtx`）、PT 不一致の drop、SSRC 切替の wire mutation（`ssrcSwapped` / `mediaSsrcRenewed`）。fallback はすべての既存判定が外れた後に置く。
- **negotiation 規則**（`packages/webrtc/AGENTS.md` Do 6〜8）: router / receiver の表を変えるので negotiation 変更として扱う。
  - pending な description の間でも、未知SSRCの学習は「新しいキーの追加」に当たるので即時反映してよい。ただし current session が使っている SSRC の route は変えない（既知 SSRC は fallback に入らないので満たされる）。
  - rollback 後は `learnedSsrcs` の既存規則で保持または破棄される。保持される場合、receiver 側の `learnedTrackSsrcs` / track の ssrc と整合することを `assertNegotiationInvariants` で検出できるか確認し、必要なら拡張する。
  - 新しい状態（receiver のフラグ、fallback 学習の記録）を持つ場合は、leak property（`tests/pbt/leak/leakProbe.ts`）の `leakFootprint` に指標を加える。上限があるなら `BOUNDED_METRICS` に根拠付きで登録する。
- **テストに使う SDP の出所**: `tests/negotiation/cases` には他実装の SDP を置けない（AGENTS.md Do 6）。RingCentral の SDP fixture は `tests/issue/356.test.ts` などの issue 回帰テストに置く。werift 同士の検証では、送信側 SDP から `a=ssrc` / `a=ssrc-group` / MID extmap を取り除いて SSRC-less ピアを模擬する。model property の wire mutation（`tests/pbt/model/wireMutations.ts`）に `ssrcRemoved` を加える案も検討する（加える場合は oracle と generator も対応させる）。
- **erasableSyntaxOnly**: `enum` やパラメータプロパティを使わない。
- **ログ**: drop 理由は `debug` ログ（`werift:packages/webrtc/src/media/router.ts`）で区別できるようにする（no candidate / ambiguous / MID mismatch / transport mismatch / RTX / unknown PT）。パケットごとに大量に出ないよう、同じ SSRC・同じ理由は抑制することも検討する。

---

## 5. テスト計画（Arrange / Act / Assert、Act / Assert には日本語コメント）

共通の Arrange（SSRC-less の receiver / transceiver / 偽 DTLS transport / RTP パケットの生成）は `tests/fixture.ts`、または新しい `tests/media/routerTestUtils.ts` に 1 か所でまとめる。

### 単体（`tests/media/router.test.ts`）
- [ ] `a=ssrc` なし、MID/RID なし、音声 m-line 1 本: 初回 RTP が `ontrack` 済みの `receiver.track` の `onReceiveRtp` に届き、2 パケット目以降も同じ SSRC で届く。`ssrcTable` / `learnedSsrcs` / `trackBySSRC` / `track.ssrc` / `track.codec` が整合する。
- [ ] 同じ transport 上に SSRC-less の receiver が 2 つあり PT が重なる: 学習せずに drop する（どの track にも届かず、`ssrcTable` も変わらない）。
- [ ] 同じ transport 上に SSRC-less の audio と video がいて PT が分かれている: PT で一意に決まり、正しい receiver だけに届く。
- [ ] MID 拡張あり: MID の receiver に学習する。MID の receiver が別 transport・停止済み・PT 非対応なら学習しない。
- [ ] 別 transport から届いたパケット、`routeRtp(packet)` の transport なし呼び出し: 学習しない。
- [ ] RTX PT、受信 codec 表にない PT のパケット: 学習しない。
- [ ] 学習済み receiver に別 SSRC が来る: 決めた置き換え方針どおりに動き、表のサイズは 1 のまま。
- [ ] SDP に `a=ssrc` がある m-line: 未知 SSRC は fallback の対象にならない（既存挙動）。
- [ ] 既存テスト（`routeRtp`、simulcast 学習、`SDP registration clears the learned mark of an SSRC` など）がそのまま通る。

### PeerConnection レベル（`tests/issue/356.test.ts`）
- [ ] #356 の RingCentral Offer（`withoutAddresslessRtcp` で `a=rtcp:48037` だけを除いたもの。3.6）を remote offer にして answer を作り、受信 `dtlsTransport.onRtp` に RTP を流す（ICE 接続なしで router の結線まで検証する）。
  - 流す RTP: 受信 codec 表にある PT 109（OPUS）または PT 0（PCMU）。MID / RID 拡張なし、任意の SSRC。
  - 確認すること: `ontrack` で受け取った track（`ssrc === undefined` だった既定 track）に、初回パケットから届く。
  - 確認すること: 受信 codec 表にない PT（例: 111、63）のパケットからは学習しない。
- [ ] 同じテストで、fixture は元の文字列のまま持ち、除去はヘルパーだけで行っている（後から元の SDP に切り替えられることの担保）。
- [ ] werift 同士で、送信側 SDP から `a=ssrc*` と MID の extmap を除去した状態で実際にメディアを流し、受信側の `ontrack` track にRTPが届く。可能なら BUNDLE の audio+video で、PT が重なる / 重ならない両方のケースを試す。
- [ ] 学習後の remote SR が receiver に届く。受信統計（`getStats` の inbound-rtp）にその SSRC が出る。

### transport ごとの SSRC 経路（3.7）
- [x] SR / RR / NACK / PLI のそれぞれで、同じ SSRC 55 を名指す RTCP が、受信した transport の receiver にだけ届く。
- [x] 同じ SSRC 55 が transport A と B に流れ、それぞれの receiver にだけ RTP が届き、A の `ssrcTable` 経路が維持される。
- [x] 先に学習した A を登録解除した後も、B の RTP と SR が B に届く。
- [x] rollback（`restoreRoutes`）の後も、両 transport の RTP と SR がそれぞれの receiver に届く。
- [x] A が置き換えた SSRC 55 を、B の transport の新しいストリームとして学習し、RTP と SR が B に届く。
- [x] 別 transport が fallback で学習済みの SSRC を RID で学習しても、RID 付き・RID なしの RTP と SR が RID の receiver に届き、A の経路は残る。
- [x] 別 transport の RID receiver が先に SSRC 55 を学習した後でも、B の SSRC-less receiver が SSRC 55 を学習して RTP と SR を受け、simulcast の RTP と SR も simulcast の receiver に届く（MID なし / MID が B の両方）。
- [x] B を新しい transport に付け替えた後、旧 transport の RTP と SR は B に届かず、新 transport の RTP と SR は B に届き、A の経路は保たれる。付け替え後の登録解除と SSRC の置き換えで、補助経路が残らない。
- [x] 同じ transport（BUNDLE）で MID a が SSRC 55 から 66 に切り替えた後、MID b を明示した SSRC 55 を B が学習し、続く MID なしの RTP と SR も B に届く。MID a 付き / MID なしの 55 の遅延パケットは学習しない。
- [x] ローカル sender と同じ SSRC の未知 RTP で例外が出ず、sender の経路が残る。
- [x] `a=ssrc` のある m-line（メディア / RTX）・RID の m-line と PT を共有する SSRC-less m-line は、MID のない未知 SSRC を学習せず、RTP も SR も届かない。同じ SSRC でも MID を明示すれば学習する。PT が分かれていれば学習する。
- [x] fallback で学習済みの SSRC に別 MID が明示されたら、その MID の receiver へ引き渡し、続く MID なしの RTP と SR もそちらに届く。旧 MID の遅延パケットでは戻らない。学習できない m-line の MID なら、どちらにも届けず旧経路は残る。
- [x] baseline 後に学習済み SSRC の持ち主が変わってから rollback しても、RTP と SR は今の持ち主に届き、表と receiver の track が一致する。

### §9.2 の判定手順（3.8）
- [x] `a=ssrc` のある m-line（メディア / RTX）・RID の m-line と PT を共有する SSRC-less m-line は、MID のない未知 SSRC を学習しない。MID を明示すれば学習する。PT が分かれていれば学習する。（3.7 のテスト計画にも記載）
- [x] 保留中の offer が同じ PT の m-line を追加すると、MID のない未知 SSRC は commit 後も学習せず、MID を明示すれば学習し、rollback で追加が消えれば学習する。
- [x] 保留中の offer が同じ PT の m-line を停止（拒否予定・inactive）しても、commit までは MID のない未知 SSRC を学習せず、commit 後は残る m-line が学習する。
- [x] 保留中に RID "high" 付きの SSRC 400 を受信してから rollback すると、`trackByRID` / `trackBySSRC[400]` / 経路 400 / `learnedSsrcs` のいずれにも残らず、RID なしの 400 は fallback として学習されて通知済み track に届く。
- [x] fallback の SSRC 300 が保留中に RID "high" 付きでも届いてから commit すると、`trackBySSRC[300]` が RID の track になり経路も残り、RID 拡張を省いた 300 が RID の track に届く。（この 2 件は修正前のコードで失敗することを確認）
- [x] 学習済み SSRC 300 の確定済み session に、保留中の re-offer が RID "high" を与えても、commit / rollback までは `receiver.track` と `tracks` が変わらず、保留中の SSRC 切替（301）を学習して届く。commit で RID の track に切り替わり fallback が外れ、rollback で 301 の fallback が残って `trackByRID` / `ridTable` は空に戻る（修正前のコードで失敗することを一時 worktree で確認）。
- [x] 学習済み SSRC 300（opus）の確定済み session に、保留中の re-offer が PCMU の SSRC 400 を与えても、commit / rollback までは track の SSRC・codec・inbound-rtp 統計が 300 / opus のまま。保留中の SSRC 切替（301）を学習し、400 の RTP も届く。commit で 400 / PCMU に切り替わり統計も 400、rollback で 301 / opus に戻り 400 の経路は残らない。

### negotiation / property
- [ ] 学習後の rollback / 再 offer / ICE restart で route と track が保たれ、`assertNegotiationInvariants` が通る（`expectSessionContinues` まで）。
- [ ] 学習後に SDP が SSRC を与えた場合の上書き規則（3.4）。
- [x] pending の description が通知済み track（既定 track）に別 codec の SSRC を与えてから rollback すると、track の SSRC と codec が baseline に戻る。baseline 後にパケットから学習した fallback SSRC が rollback で残る場合は、学習時の codec に戻る（レビュー指摘: `track.codec` が pending の値のまま残っていた）。

---

## 6. 検証コマンド
長時間の検証の前に、リビジョン、未コミットの差分、目的を記録しておく（ルート AGENTS.md Do 8）。

```bash
cd packages/webrtc
npm run type
npm test                       # negotiation / leak の property を含む
npm run pbt:deep               # router / receiver 表の変更なのでレビュー前に実行
cd ../.. && npm run type && npm run test:small   # 公開挙動の変更なので
npm run format
```
develop との比較が必要なら、一時 worktree（`git worktree add --detach <tmp> develop`）で `tools/negotiation-diff` を実行し、差分 0 を確認する。

---

## 7. 完了条件
- [ ] SDP に `a=ssrc` がなく、MID/RID 拡張もない単一ストリームの m-line で、受信 transport 上の候補が一意に決まる場合は、初回 RTP から SSRC を学習し、`ontrack` で通知済みの track にRTPが継続して届く。
- [ ] MID 拡張がある場合は MID の m-line に限定して学習し、transport・方向・PT の条件を満たさなければ学習しない。
- [ ] 候補が曖昧な場合、別 transport・RTX・未知 PT の場合は学習せずに drop し、drop 理由をログで区別できる。
- [ ] fallback で学習する SSRC は receiver ごとに上限があり、置き換え・SDP 上書き・rollback・transceiver 停止のときの規則が `RtpRouter` の TSDoc とテストに書かれている。
- [ ] 既存の SSRC / RID / simulcast / RTX / PT 不一致 / SSRC 切替の経路に回帰がない（`npm test` と `npm run pbt:deep` が通る）。
- [ ] #356 の RingCentral SDP fixture（元の文字列のまま保持し、`a=rtcp:48037` の除去はヘルパーで行う）を使い、学習・配送まで確認する回帰テスト `tests/issue/356.test.ts` がある。
- [ ] 本 PR で `packages/webrtc/src/sdp.ts` を変更していない（#355 はチケット `a2bc2644` の範囲）。
- [ ] 3.6 の合流ルールに従っている。
  - マージ時点で develop に #355 の修正が入っていれば、ヘルパーを外し、元の SDP のまま統合テストが通っている。
  - 入っていなければ、#355 チケットに「`tests/issue/356.test.ts` のヘルパー呼び出しを外し、元の SDP で学習・配送を確認する」作業項目が追加されている。
- [ ] `changelog.md` に #356 の項目を追記している（#355 の項目は書かない）。
- [ ] 3.7 の追加要件を満たしている。パケットから学習した SSRC 経路は RTP と RTCP の両方で transport ごとに解決され、同じ数値の SSRC が複数 transport にあっても、それぞれの receiver に誤配送も欠落もなく届く。
- [ ] rollback 後、通知済み track の `codec` が現在の negotiated state と一致する（receiver の negotiation snapshot に既定 track の codec を含める）。
- [ ] 確認レビューを依頼する時点で、修正が `ticket review` の対象として見える状態にしている（CLI は未コミットの差分がないとレビューを開始しない）。
- [ ] 3.8 の追加要件を満たしている。MID のない未知 SSRC は、受信中のすべての m-line で一意な PT のときだけ学習し、MID は fallback の対応付けを更新し、rollback 後も表と track が一致する。
- [ ] `pbt:deep` の leak の ICE 失敗について、3.8 の扱いに沿って原因の切り分け（develop での再現）と報告をしている。
