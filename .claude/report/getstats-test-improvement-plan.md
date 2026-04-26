# getStats()テスト改善計画

## 実行日時
2025年5月24日

## 背景
`.claude/webrtc-statics-api.md`に従ったgetStats()メソッドが実装されているが、`packages/webrtc/tests/integrate/getStats.test.ts`のテストケースに以下の問題が確認された：

1. **実質的に何もテストしていないケースが存在**
2. **統計タイプのカバレッジが不十分**
3. **期待値検証が曖昧**
4. **実際の接続状態での統計が未検証**

## 現在のテスト問題点

### 1. 実質的に何もテストしていないケース

#### データチャンネル統計テスト（113-127行目）
```typescript
test("getStats() includes data-channel stats after creating data channel", async () => {
  // データチャンネル作成
  const dc1 = pc1.createDataChannel("test-channel", { maxRetransmits: 3 });
  
  // 統計取得
  const stats = await pc1.getStats();
  
  // 問題：データチャンネル統計を検証していない
  // peer-connection統計の存在確認のみ
  const pcStats = Array.from(stats.values()).find(
    (stat) => stat.type === "peer-connection",
  );
  expect(pcStats).toBeDefined();
});
```

**問題点**: データチャンネル統計（type: "data-channel"）の存在と内容を全く検証していない

#### コーデック統計テスト（170-185行目）  
```typescript
test("getStats() includes codec stats when transceivers are present", async () => {
  const track = new MediaStreamTrack({ kind: "audio" });
  pc1.addTrack(track);
  
  const stats = await pc1.getStats();
  
  // 問題：コーデック統計の存在を検証していない
  // peer-connection統計の存在確認のみ
  const pcStats = Array.from(stats.values()).find(
    (stat) => stat.type === "peer-connection",
  );
  expect(pcStats).toBeDefined();
});
```

**問題点**: コーデック統計（type: "codec"）の存在と内容を全く検証していない

### 2. カバレッジ不足の統計タイプ

以下の統計タイプがテストされていない：
- `transport` - DTLSトランスポート統計
- `candidate-pair` - ICE候補ペア統計  
- `local-candidate` - ローカルICE候補統計
- `remote-candidate` - リモートICE候補統計
- `certificate` - DTLS証明書統計
- `remote-inbound-rtp` - リモート受信統計
- `remote-outbound-rtp` - リモート送信統計

### 3. 期待値検証の問題

#### トラックセレクタテスト（144-168行目）
```typescript
// 問題：フィルタリング結果の完全性を検証していない
const audioStats = await pc1.getStats(audioTrack);
const outboundRtpStats = Array.from(audioStats.values()).filter(
  (stat) => stat.type === "outbound-rtp",
);

// kindは検証しているが、他の統計が除外されているかは未検証
for (const stat of outboundRtpStats) {
  const rtpStat = stat as any;
  if (rtpStat.kind) {
    expect(rtpStat.kind).toBe("audio");
  }
}
```

**問題点**: 
- 指定したトラック以外の統計が除外されているかを検証していない
- セレクタ機能の完全性が未確認

## 分析結果：実装されている統計タイプ

### RTCPeerConnection
- `peer-connection`: 基本的な接続統計

### RTCRtpSender  
- `outbound-rtp`: 送信RTPストリーム統計
- `media-source`: メディアソース統計
- `remote-inbound-rtp`: 受信側フィードバック統計

### RTCRtpReceiver
- `inbound-rtp`: 受信RTPストリーム統計  
- `remote-outbound-rtp`: 送信側情報統計

### RTCRtpTransceiver
- `codec`: コーデック統計

### SctpTransportManager
- `data-channel`: データチャンネル統計

### DTLSTransport  
- `transport`: トランスポート統計
- `certificate`: 証明書統計

### ICETransport
- `local-candidate`: ローカルICE候補統計
- `remote-candidate`: リモートICE候補統計
- `candidate-pair`: ICE候補ペア統計

## 改善計画

### Phase 1: 基本統計タイプの網羅的テスト

#### 1.1 peer-connection統計の詳細テスト
- データチャンネル開閉数の検証
- 基本プロパティの検証

#### 1.2 データチャンネル統計の完全テスト
- データチャンネル作成後の統計存在確認
- ラベル、プロトコル、状態の検証
- メッセージ送受信後の統計更新検証

#### 1.3 メディアソース統計の完全テスト
- トラック種別ごとの統計検証
- ビデオ固有プロパティ（解像度、フレームレート）
- オーディオ固有プロパティ（オーディオレベル）

#### 1.4 コーデック統計の完全テスト
- トランシーバー追加後の統計存在確認
- ペイロードタイプ、MIMEタイプの検証
- クロックレート、チャネル数の検証

### Phase 2: 接続確立時の統計テスト

#### 2.1 実際のピア接続確立
- 2つのPeerConnection間でのOffer/Answer交換
- ICE接続確立の完了
- DTLS接続確立の完了

#### 2.2 トランスポート統計の検証
- DTLSトランスポート統計の存在確認
- 状態（dtlsState, iceState）の検証
- 選択候補ペアIDの検証
- 証明書IDの検証

#### 2.3 ICE統計の検証  
- ローカル/リモート候補統計の存在確認
- 候補ペア統計の存在確認
- 選択された候補ペアの特定
- 接続メトリクス（RTT、パケット数）の検証

#### 2.4 証明書統計の検証
- 証明書統計の存在確認
- フィンガープリント、アルゴリズムの検証

### Phase 3: メディア送受信統計テスト

#### 3.1 RTPストリーム統計の検証
- outbound-rtp統計の詳細検証
- inbound-rtp統計の詳細検証
- SSRC、パケット数、バイト数の検証

#### 3.2 リモート統計の検証
- remote-inbound-rtp統計の検証
- remote-outbound-rtp統計の検証
- RTT測定値の検証

#### 3.3 統計間の整合性検証
- 送信側と受信側の統計の対応関係
- 統計IDの参照関係の検証

### Phase 4: エラーケース・エッジケーステスト

#### 4.1 無効パラメータテスト
- 存在しないトラックセレクタ
- 無効なオブジェクトでの呼び出し
- null/undefinedパラメータ

#### 4.2 接続状態別テスト
- 未接続状態での統計取得
- 接続終了後の統計取得
- ICE再接続中の統計取得

#### 4.3 セレクタ機能の完全テスト
- トラックセレクタによる適切なフィルタリング
- 複数トラック環境での選択的統計取得
- セレクタ未指定時の全統計取得

### Phase 5: パフォーマンス・妥当性テスト

#### 5.1 統計値の妥当性検証
- 時間経過による統計値の増加
- ネットワークメトリクスの妥当性
- パケットロス率の計算精度

#### 5.2 高負荷時の動作確認
- 大量のトラック追加時の統計取得性能
- 頻繁な統計取得時の性能影響

## 実装予定のテスト構造

```
describe("RTCPeerConnection.getStats() - Comprehensive Tests", () => {
  
  describe("Basic Statistics", () => {
    // peer-connection, data-channel, media-source, codec統計
  });
  
  describe("Connection Statistics", () => {
    // transport, certificate, ICE関連統計
  });
  
  describe("Media Statistics", () => {
    // RTPストリーム、リモート統計
  });
  
  describe("Selector Functionality", () => {
    // トラックセレクタの完全テスト
  });
  
  describe("Error Cases", () => {
    // エラーケース・エッジケース
  });
  
  describe("Performance & Validation", () => {
    // パフォーマンス・妥当性テスト
  });
});
```

## 期待される成果

1. **完全なカバレッジ**: 全ての実装済み統計タイプのテスト
2. **実用的な検証**: 実際の使用シナリオでの統計動作確認  
3. **エラー耐性**: 異常系・エラー系の適切な処理確認
4. **保守性向上**: 将来の統計機能拡張時の回帰防止
5. **品質保証**: WebRTC標準準拠の統計API実装の品質担保

## 次のステップ

1. ユーザー承認後、Phase 1から順次実装開始
2. 各フェーズ完了時の進捗報告
3. 全体完了後のカバレッジ測定と検証
4. 必要に応じた追加テストケースの検討

---

**注意**: この計画は`.claude/webrtc-statics-api.md`に記載された実装仕様に基づいており、実装されていない統計タイプについては将来の拡張を考慮したテスト設計となっています。
