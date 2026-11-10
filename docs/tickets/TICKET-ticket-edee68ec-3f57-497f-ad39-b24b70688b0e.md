## 元報告・判定
元Issue: #817（sidorares）。**妥当（developのコード上で確認）**。元Issueに最小再現とWPT名あり。今回、独立再現テストは未実施。

## 原因
- [rtpTransceiver.ts L253–261](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/webrtc/src/media/rtpTransceiver.ts#L253-L261) の `heldByApplication` は `!!this.sender.track` の現在値しか見ない。
- [transceiverManager.ts L196–216](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/webrtc/src/transceiverManager.ts#L196-L216) のrollbackはこの値がfalseならremote offerで作成したtransceiverを除去する。
- しかし `addTrack` 済みtransceiverへの `sender.replaceTrack(null)` は現在のtrackを外すだけで、`addTrack` というアプリ操作の履歴を取り消すものではない。

## 修正方針
1. `RTCRtpTransceiver` に現在の `sender.track` と独立した、**remote offer以降にアプリが`addTrack`で獲得したこと**を記録する持続フラグ（例 `heldByApplicationSinceCreation`）を設ける。remote offer起源かどうかも明示的に識別する。
2. [transceiverManager.ts `addTrack()`](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/webrtc/src/transceiverManager.ts#L511-L565) でremote生成transceiverを再利用したときフラグを立てる。trackを後からnullへ置換しても消さない。`addTransceiver()`によるアプリ起源のものは既存どおりrollbackで保存する。
3. rollbackではremote生成かつ未獲得のものだけを除去し、獲得済みはMID/mLineIndex・交渉状態のみ巻き戻して、stopやsenderを不当に失効させない。
4. snapshot/restore、複数回のrollback、removeTrack/replaceTrack、stopの扱いを一貫させる。アプリによるstopをrollbackで復活させない。

## 回帰テスト
- [ ] SRD(remote offer) → `addTrack` → `replaceTrack(null)` → SRD(rollback)でも同一transceiverが保持され`stopped === false`。
- [ ] `addTrack`しなかったremote生成transceiverはrollbackで除去。
- [ ] trackを保持したままのrollback、別transceiverへの`addTrack`、複数回rollback、`stop()`を回帰確認。
- [ ] WPT `RTCPeerConnection-setRemoteDescription-rollback.html` 相当を追加。

**完了条件:** アプリが使用したtransceiverをtrackの瞬間値によって誤削除しない。