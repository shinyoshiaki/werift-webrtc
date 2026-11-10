## 元報告・判定
元Issue: #269（koush）。**妥当な最適化課題（developで確認可能）**。ICE restartを伴わない再オファーでは既存のICE generation、資格情報、候補を再利用できるにもかかわらず、SDPに既存のICE candidatesを含めて毎回再提示するため、多数のm-lineがあるBUNDLEのシグナリングが大きくなる。
なおICE再交渉そのものが壊れているとは断定せず、**冗長なSDP/トリクルによる負荷削減**にスコープを限定する。#270（未使用ソケット累積）とは独立。

## 現行コードの根拠
- [sdpManager.ts L192–218](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/webrtc/src/sdpManager.ts#L192-L218) の`addTransportDescription()`は、同じICE generationでも`media.iceCandidates = generation.candidates`とし、既存のすべてのcandidateを付加する。
- [sdpManager.ts `buildOfferSdp()`](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/webrtc/src/sdpManager.ts#L560-L675) は再オファーでも既存のtransportでmedia descriptionを生成する。BUNDLEやTrickle ICE時の既存確定ペアが再利用される場合、候補一覧を全件繰り返す必要性を検討できる。

## 修正方針
1. `SDPManager`に当該m-section/transportで**既に相手に通知したICE generation**と、今生成するdescriptionのgenerationを識別する情報を保持する。
2. ICE credentialsが変化せず既存generationで再交渉する場合、候補一覧の省略を選べるようにする。ただし候補再送を前提とする非Trickle ICEの相手、pranswer/rollback、最初のoffer、BUNDLEのowner/transport変更などは省略しない・または既存方式へfallbackする。
3. `a=ice-ufrag`/`a=ice-pwd`/`a=ice-options`およびBUNDLE groupとMID、end-of-candidatesの扱いを整合させる。新しいcandidateは必要に応じてtrickleするが、同じ候補を不必要に再通知しない。
4. 既存アプリケーションがSDP候補一覧を期待する場合の後方互換性を考慮し、設定/モード変更を必要に応じて設ける。コーデック再交渉に影響しない。

## 回帰テスト
- [ ] BUNDLE確立後のaddTrack/removeTrack再交渉（ICE restartなし）で再オファーのcandidate情報が冗長に増えない。
- [ ] SDP/Trickle双方で同じ候補の不必要な重複通知がない。
- [ ] ICE restartで新世代の候補が確実に通知される。
- [ ] 非Trickle ICE / BUNDLE owner変更 / rollback / ICE-liteと複数m-lineでも接続できる。
- [ ] SDPサイズ、候補数、ソケット数を測定し改善を確認する。

**完了条件:** ICE restartなしの長寿命BUNDLE接続で再交渉を繰り返しても、不要な候補列挙によるSDP肥大化を防ぐ。