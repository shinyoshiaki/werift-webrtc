## WebRTC Statistics API 実装

### getStats() メソッドの実装完了

WebRTC標準準拠の統計情報API `getStats()` が完全実装されています。

### 統計情報の収集構造

1. **RTCPeerConnection.getStats()**:
   - 各コンポーネントから統計を収集して統合
   - セレクターによるフィルタリング対応
   - WebRTC標準準拠のRTCStatsReportを返却

2. **コンポーネント別統計収集**:
   - **RTCRtpSender**: 送信統計（outbound-rtp, media-source, remote-inbound-rtp）
   - **RTCRtpReceiver**: 受信統計（inbound-rtp, remote-outbound-rtp）
   - **RTCRtpTransceiver**: コーデック統計（codec）
   - **SctpTransportManager**: データチャンネル統計（data-channel）
   - **RTCDtlsTransport**: トランスポート・証明書統計（transport, certificate）
   - **RTCIceTransport**: ICE統計（candidate-pair, local-candidate, remote-candidate）

3. **統計タイプ**:
   - peer-connection: 接続全体の統計
   - outbound-rtp: 送信RTP統計
   - inbound-rtp: 受信RTP統計
   - remote-outbound-rtp: リモート送信統計
   - remote-inbound-rtp: リモート受信統計
   - media-source: メディアソース統計
   - data-channel: データチャンネル統計
   - transport: トランスポート統計
   - candidate-pair: ICE候補ペア統計
   - local-candidate: ローカルICE候補統計
   - remote-candidate: リモートICE候補統計
   - certificate: 証明書統計
   - codec: コーデック統計

### テスト実装

- **単体テスト**: `packages/webrtc/tests/integrate/getStats.test.ts` で包括的テスト実装
- **動作確認**: `examples/getStats/demo.ts` で実際の動作確認プログラム実装
- **11テストケース**: 基本機能から詳細機能まで網羅的テスト

### 使用例

```typescript
// 全統計情報取得
const stats = await peerConnection.getStats();

// 特定トラックの統計のみ取得
const trackStats = await peerConnection.getStats(mediaTrack);

// 統計情報の反復処理
for (const [id, stat] of stats) {
  console.log(`${stat.type}: ${id}`);
}
```