## 作業内容サマリー

### 実施した変更
1. **SdpManagerの実装**
   - `/home/shin/code/werift-webrtc/packages/webrtc/src/pc/managers/sdpManager.ts`を新規作成
   - SDPに関連する処理を集約（オファー/アンサー構築、記述の保存と処理）
   - DTO化サポート（ライブマイグレーション用）

2. **RTCPeerConnectionContextへの状態移行**
   - SDPマネージャーを統合
   - 記述関連メソッド (`_localDescription`, `_remoteDescription`, `localDescription`, `remoteDescription`, `remoteIsBundled`)を移行
   - 新しいメソッド (`buildOfferSdp`, `buildAnswer`, `setLocal`, `processRemoteDescription`)を追加

3. **RTCPeerConnectionクラスの修正**
   - 親クラスの新しいメソッドを利用するよう変更
   - 重複するコードを削除
   - アクセス修飾子の調整（privateからprotectedへ）

### 将来の計画
1. **他のマネージャーの実装**
   - ICEマネージャー：ICE候補収集、トランスポート作成
   - DTLSマネージャー：証明書管理、DTLSトランスポート
   - SCTPマネージャー：データチャネル処理
   - メディアマネージャー：トランシーバー、トラック管理

2. **ライブマイグレーション対応**
   - 各マネージャークラスにDTO変換機能を実装
   - 状態の完全なシリアライズ/デシリアライズをサポート

### 次のステップ
1. 残りのマネージャー（ICE, DTLS, SCTP, Media）の実装
2. RTCPeerConnectionContextへの統合と各マネージャー間の連携設計
3. RTCPeerConnectionクラスの修正（継承関係の整理）
4. テストの実装とエラー処理の強化

このリファクタリングによって、責務が明確に分離され、将来的なライブマイグレーションやコード保守がより容易になります。また、新しいマネージャークラス構造により、ユニットテストの実装も簡略化されます。