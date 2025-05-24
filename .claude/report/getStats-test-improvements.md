# getStats.test.ts 改善計画書

## 📋 現状分析

### ファイル概要
- **ファイル**: `packages/webrtc/tests/integrate/getStats.test.ts`
- **サイズ**: 646行の包括的なテストスイート
- **対象**: RTCPeerConnection.getStats() メソッドの統合テスト

### 特定された問題点

#### 1. **スキップされたテスト (主要問題)**
- **場所**: 行538-556（Connection Statistics section）
- **スキップされたテスト数**: 4つ
  - `includes transport stats after connection establishment`
  - `includes ICE candidate stats after connection`
  - `candidate pair stats include required properties`
  - `includes certificate stats after connection`
- **理由**: 実装制限により、実際のWebRTC接続確立環境でのテストが困難

#### 2. **テストコメントの不足**
- 各テストブロックの冒頭に、何をテストするかの簡潔な説明コメントが欠如
- テストの意図が不明確で保守性に悪影響

#### 3. **その他の問題**
- パフォーマンステストのタイムアウト値（1000ms）が保守的すぎる可能性
- 一部のテストでany型を多用し、型安全性を犠牲

## 🎯 改善戦略

### Phase 1: スキップされたテストの解決

#### 戦略A: モック環境での実装
```typescript
// ICE/DTLS接続状態をモックで模擬
test("includes transport stats after connection establishment", async () => {
  // モック接続を確立
  const mockConnection = await createMockConnection(pc1, pc2);
  
  const stats = await pc1.getStats();
  const transportStats = Array.from(stats.values()).filter(
    (stat) => stat.type === "transport"
  );
  
  expect(transportStats.length).toBeGreaterThan(0);
  // 詳細検証...
});
```

#### 戦略B: テスト環境の拡張
- テスト専用のヘルパー関数で実際の接続確立をシミュレート
- E2Eテスト環境に近い統合テスト環境の構築

### Phase 2: テストコメントの追加
各テストブロックに以下形式のコメントを追加：

```typescript
/**
 * RTCStatsReportの基本的なインスタンス生成と型検証をテスト
 * Map継承の正常性とRTCStatsReportクラスの実装を確認
 */
test("getStats() returns RTCStatsReport instance", async () => {
  // テスト実装
});
```

### Phase 3: テストの安定性向上

#### パフォーマンス閾値の調整
```typescript
// 現在: 1000ms → 提案: 500ms（実環境に近い値）
expect(duration).toBeLessThan(500);
```

#### 型安全性の改善
```typescript
// any型の使用を削減
interface ExpectedOutboundRtpStat extends RTCOutboundRtpStreamStats {
  kind: "audio" | "video";
  ssrc: number;
}

const outboundStat = outboundStats[0] as ExpectedOutboundRtpStat;
```

## 🛠️ 実装計画

### 実装順序

1. **テストコメント追加** (低リスク・高価値)
   - 各テストケースに簡潔な説明コメントを追加
   - ドキュメンテーション品質の向上

2. **スキップテストの段階的解決**
   - 段階1: モック環境でのbasic transport stats実装
   - 段階2: ICE candidate stats のモック実装
   - 段階3: certificate stats の実装

3. **テスト安定性改善**
   - パフォーマンス閾値の調整
   - 型安全性の改善
   - フレーキーテストの特定と修正

### 期待される効果

#### 直接的効果
- ✅ テストカバレッジの完全性：現在80% → 目標95%
- ✅ 保守性向上：コメント追加により新規開発者の理解促進
- ✅ CI/CD安定性：スキップテスト解決によるテスト信頼性向上

#### 間接的効果
- ✅ getStats実装の品質向上（テストからのフィードバック）
- ✅ WebRTC Statistics API準拠の確認
- ✅ 回帰バグの早期発見

## 🔍 技術的考慮事項

### WebRTC Statistics API 準拠
- W3C WebRTC Statistics API仕様との整合性確保
- ブラウザ実装との互換性検証

### テスト環境の制約
- Node.js環境での制限（実際のメディアストリーム不可）
- ネットワーク接続確立の複雑性
- タイミング依存の問題

### パフォーマンス考慮
- 大量stats生成時のメモリ使用量
- getStats()呼び出し頻度の最適化

## ✅ 実装完了確認項目

### 必須項目
- [ ] 全テストにコメント追加完了
- [ ] スキップテスト4件の解決
- [ ] パフォーマンステストの調整
- [ ] 型安全性改善の実装

### 品質確認項目
- [ ] 全テストがCI環境で安定実行
- [ ] テストカバレッジ95%以上達成
- [ ] コードレビュー通過
- [ ] ドキュメント更新

## 📝 次のステップ

1. **ユーザー承認**: この計画がプロジェクト要件を満たしているか確認
2. **実装フェーズ移行**: 承認後、実装フェーズを開始
3. **段階的実装**: Phase 1から順次実装し、各段階でフィードバック収集

---

**計画作成日**: 2025年5月24日  
**想定実装期間**: 2-3日  
**リスク評価**: 低（既存機能への影響最小限）
