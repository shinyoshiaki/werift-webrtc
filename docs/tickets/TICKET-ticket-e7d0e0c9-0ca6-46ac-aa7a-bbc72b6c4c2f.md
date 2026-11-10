## 元報告と判定
元Issue: #356（tylerlong）。**有効な未処理ケースをコード上で確認**。RingCentralの音声Offerには`a=ssrc`がなく、受信RTPは`ssrcReceiver not found`として破棄され得る。元Issueの接続条件での実通信再現は今回未実施。
関連: #355（同SDPの`a=rtcp:<port>`パース）。

## コード根拠
- [router.ts L254–285](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/webrtc/src/media/router.ts#L254-L285) はSDPにあるSSRCから`ssrcTable`を生成する。
- [router.ts L341–386](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/webrtc/src/media/router.ts#L341-L386) で未知のSSRCについて、RIDがなければ既存の`trackBySSRC`由来のルートしか検索せず、`// bug`から`ssrcReceiver not found`で捨てる。SDPにSSRCがなく、RTP MID/RID拡張もない従来エンドポイントだと初回RTPから学習できない。

## 修正方針
1. RTPヘッダ拡張にMIDが存在する場合は**MIDに対応するm-section/receiver**を起点にSSRCを学習し、現在のroute/DTLS transport所属条件を検証する。
2. MID/RIDがない場合は、**そのRTPを受信したtransport上の適切なreceiver候補が1つに限られる**ときだけfallbackで学習する。複数m-lineが同じBUNDLE transportを共有して曖昧な場合は推測で結び付けず従来どおりdropし、ログ/診断で理由を残す。
3. 初回SSRC登録時に受信track生成・`ontrack`・codec/PT対応を整合させる。RTCP、RTX、SIMULCAST、SSRC移動や未知SSRC DoSへの対策として学習数や再登録条件を明確にする。
4. `RtpRouter.routeRtp()`にtransport文脈が必要なら呼び出し元から安全に渡し、他transport/他PeerConnectionへの誤配送を防止する。

## 回帰テスト
- [ ] `a=ssrc`なし、MID/RIDなし、音声1m-lineに初回RTPを送信すると適切なreceiverへ配送し以降も同SSRCを継続処理する。
- [ ] 複数receiverで曖昧な場合は誤学習しない。
- [ ] MIDあり・RIDあり・RTX/Simulcast・RTP PT不一致・SSRC切替の既存経路に回帰なし。
- [ ] #356のリングセントラルSDPをテストfixtureとして利用し、#355の`a=rtcp`パース後の入力も検証。

**完了条件:** RFCに沿ったSSRC-less SDPでも、安全に受信先が特定できる場合はRTPを配送する。