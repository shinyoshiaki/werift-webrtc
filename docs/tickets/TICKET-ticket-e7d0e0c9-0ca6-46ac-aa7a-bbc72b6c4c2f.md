# [RTP] SDPにSSRCが存在しない単一ストリームの受信RTPを適切なreceiverへ学習・配送する（#356）

## 1. 目的と背景

### 元報告と判定
- 元Issue: [#356](https://github.com/shinyoshiaki/werift-webrtc/issues/356)（tylerlong）。RingCentral（SIP over WebSocket）から届く音声Offerには `a=ssrc` がない。werift を `RTCPeerConnection` の代わりに使うと、受信RTPが `ssrcReceiver not found` で全部捨てられる。同じアプリをブラウザの `RTCPeerConnection` で動かすと正常に動く。
- **コード上で有効な未処理ケースだと確認した**（下の「現状コードの調査結果」を参照）。元Issueの接続条件での実通信再現は未実施。
- 報告者は werift-rtp 単体で自前実装して回避し、Issue をクローズしてよいと言っている。ただし、ブラウザ互換の挙動としては今も未対応のまま。
- 関連: [#355](https://github.com/shinyoshiaki/werift-webrtc/issues/355)（OPEN。同じSDPにある `a=rtcp:48037`、つまり RFC 3605 のアドレスを省いた形のパース）。**現在の develop（`63b3182ab`）では `SessionDescription.parse()` が `a=rtcp:48037` で `Error("exception")` を投げることを確認した**（`src/sdp.ts` L203–209 → `ipAddressFromSdp("")`、L591–595）。#356 のSDPをそのまま `setRemoteDescription` に渡すと、ルーティングより前の段階で失敗する。

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
- 既知の SSRC と RID の経路では transport を使わない（既存挙動を維持）。transport は **未知SSRCの学習判定** にだけ使う。
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

### 3.6 #355 への依存
- #356 の SDP fixture をそのまま `setRemoteDescription` に使うには #355（`a=rtcp:<port>` のパース）の修正が先に必要。方針は次のどちらか。
  - (a) #355 を先に、または同じ PR で修正する（`ipAddressFromSdp` がアドレス省略形を許容し、`rtcpHost` を undefined にする。RFC 3605）。
  - (b) 本チケットでは `a=rtcp:48037` を除いた fixture で検証し、#355 の修正後に元の SDP のテストを有効化する。
- どちらを選んでも、「#355 のパース後の入力でも学習・配送される」ことを確認するテストを、最終的にどちらかのチケットに残す。

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
- [ ] #356 の RingCentral Offer を remote offer にして answer を作り、受信 `dtlsTransport.onRtp` に RTP を流す（ICE 接続なしで router の結線まで検証する）。`ontrack` の track に配送されることを確認する。#355 の扱いは 3.6 に従う。
- [ ] werift 同士で、送信側 SDP から `a=ssrc*` と MID の extmap を除去した状態で実際にメディアを流し、受信側の `ontrack` track にRTPが届く。可能なら BUNDLE の audio+video で、PT が重なる / 重ならない両方のケースを試す。
- [ ] 学習後の remote SR が receiver に届く。受信統計（`getStats` の inbound-rtp）にその SSRC が出る。

### negotiation / property
- [ ] 学習後の rollback / 再 offer / ICE restart で route と track が保たれ、`assertNegotiationInvariants` が通る（`expectSessionContinues` まで）。
- [ ] 学習後に SDP が SSRC を与えた場合の上書き規則（3.4）。

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
- [ ] #356 の SDP fixture による回帰テストがある（#355 の修正後の入力を含む。3.6 のとおり、どちらのチケットで有効化するかを明記する）。
- [ ] `changelog.md` を更新している。
