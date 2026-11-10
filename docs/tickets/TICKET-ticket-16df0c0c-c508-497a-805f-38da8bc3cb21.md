## 元報告・判定
元Issue: #816（sidorares）。**妥当（developのコード上で確認）**。glare/perfect negotiationへの影響あり。今回、独立テスト未実施。

## 原因
[remoteMediaApplication.ts L243–267](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/webrtc/src/negotiation/remoteMediaApplication.ts#L243-L267) `findTransceiver()` はMID不一致の未関連付けtransceiverをkindとmLineIndexで選ぶため、`addTransceiver()`で作った独立したローカルtransceiverまでremote offerのm-sectionに割り当ててしまう。RFC 8829 §5.10の関連付け条件と異なる。

## 修正方針
1. transceiverの**生成元**（`addTrack` / `addTransceiver` / remote offer）を示す内部情報を生成時に記録し、トラックの現在値やMIDだけでは判定しない。
2. remote offerの未知MIDに対しては、規定に従う **`addTrack` により作成され、未関連付けで停止していないtransceiverのみ** を再利用候補にする。`addTransceiver`起源のtransceiverはtrack付きでも対象外。候補がない場合はremote側の新規transceiverを作る。
3. 既に同じMIDで関連付け済みのtransceiverを探す既存処理を保持し、拒否m-line・mLine再利用・BUNDLE・re-offer・rollbackの判定を崩さない。
4. `planRemoteRtpCodecs` とremote SDP適用が同じ対応付け結果を使い、同じtransceiverが1 offer内の複数m-lineに割り当てられないようにする。

## 回帰テスト
- [ ] `addTransceiver("audio",{direction:"sendrecv"})` → 同kindのremote offerをSRDしたとき、transceiverは2個でローカル作成側MIDはnull。
- [ ] `addTransceiver(track)`、`addTransceiver`→`replaceTrack(track)`もremote m-sectionに自動関連付けしない。
- [ ] `addTrack(track)`起源の未関連付けtransceiverはRFCに従い関連付けされる。
- [ ] 同じMIDの再offer、拒否、複数m-section、glare rollback時の方向・順序を確認。
- [ ] WPT `RTCRtpTransceiver.https.html` の `checkAddTransceiver*DoesntPair` とperfect-negotiation系に相当する回帰テスト。

**完了条件:** ローカル`addTransceiver`の意図した送受信方向とMIDが相手のofferで上書きされない。