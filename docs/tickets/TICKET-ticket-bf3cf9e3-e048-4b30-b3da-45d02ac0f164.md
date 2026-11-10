## 元報告・判定
元Issue: #818（sidorares）。**妥当（developのコード上で確認）**。0.26.0での再現コードは元Issueを参照。今回、独立したテスト実行はしていない。

## 原因
- [peerConnection.ts L626–632](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/webrtc/src/peerConnection.ts#L626-L632) の `createOfferNow()` は `transceiver.codecs.length===0` または `codecPreferencesNeedResolution` の場合しか `assignTransceiverCodecs()` を呼ばない。
- [transceiverManager.ts L970–1030](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/webrtc/src/transceiverManager.ts#L970-L1030) の `setRemoteRTP()` はAnswerに合わせて交渉済みcodec集合をtransceiverへ反映する。結果として、以前のAnswerで除外された能力を後続オファーで再提示できない。
- 対応コーデック（能力・preferences・固定encoded source制約）と、最後のOffer/Answerで**実際に交渉された**コーデックを同一フィールドで扱っているのが根本原因。

## 修正方針
1. `RTCRtpTransceiver` の「次回offerで提示可能なcodec」と「現在確定したcodec」の状態を分離する。既存の`sender/receiver`を直ちに書き換えず、`config.codecs[kind]`、`codecPreferences`、sourceの制約からoffer用集合を再解決する。
2. `createOfferNow()` は既存のAnswerで縮んだ`transceiver.codecs`をそのままofferに再利用しない。コーデック順序とRTX/REDのPT・`apt`関係は`resolveCodecs`やSDP生成器で整合させる。
3. `pendingLocalOfferCodecs`・Answer commit・rollback時の状態更新を整理し、再オファー中も現在送受信中のcodecを変更しない。新しいAnswerのcommit時にのみ送受信パイプラインへ反映する。
4. `setCodecPreferences([])` の解除、preferences変更、source切替、無共通codec時の拒否判定との相互作用を確認する。

## 回帰テスト
- [ ] VP8+VP9で初回Offer → VP8だけのAnswer → 次回OfferにVP8とVP9の両方が載る。
- [ ] 次回AnswerでVP9が選択でき、確定前の送受信codecは以前のVP8のまま。
- [ ] codec preferencesで明示的にVP8だけに制限した場合はVP9が復活しない。
- [ ] RTX/REDとcodec payload typeの再提示、rollbackで以前の確定codecが保全される。
- [ ] WPT `webrtc/protocol/codecs-subsequent-offer.https.html` 相当を追加。

**完了条件:** 交渉結果で一時的にcodec能力を失わず、後続のofferでサポート能力を再提示できる。