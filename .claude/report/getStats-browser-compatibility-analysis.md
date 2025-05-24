# WebRTC getStats() ブラウザ互換性分析報告書

## 概要

werift-webrtcの`RTCPeerConnection.getStats()`実装について、ブラウザ版WebRTC APIとの互換性を調査し、必要な修正を特定しました。

## 現在の実装状況

### 1. 基本的な実装 ✅

現在の実装は以下の点でブラウザ版と互換性があります：

- `RTCStatsReport`クラスが`Map`を継承している
- 基本的なメソッドシグネチャが一致（`getStats(selector?: MediaStreamTrack | null): Promise<RTCStatsReport>`）
- 統計オブジェクトの基本構造（`id`, `timestamp`, `type`）が仕様通り

### 2. ブラウザ版との相違点 ⚠️

以下の点でブラウザ版と異なる実装があります：

#### a. タイムスタンプの実装
- **現状**: `performance.now()`を使用（DOMHighResTimeStamp）
- **ブラウザ版**: DOMHighResTimeStamp（相対的な高精度タイムスタンプ）
- **判定**: ✅ 互換性あり

#### b. セレクター引数の処理
- **現状**: `selector`引数でトラックを指定した場合、関連する統計のみを返す
- **ブラウザ版**: セレクターに関係なく、peer-connection統計などの一般的な統計も含める
- **判定**: ⚠️ 部分的に非互換

#### c. RTCStatsReportの読み取り専用性
- **現状**: `Map`を継承しているため、技術的には`set()`, `delete()`, `clear()`メソッドが利用可能
- **ブラウザ版**: 読み取り専用のMap-likeオブジェクト
- **判定**: ⚠️ 非互換

## 修正が必要な項目

### 1. RTCStatsReportの読み取り専用化

ブラウザ版では`RTCStatsReport`は読み取り専用のMap-likeオブジェクトです。現在の実装では完全な`Map`を継承しているため、変更操作が可能です。

**修正案**: 
- `set()`, `delete()`, `clear()`メソッドをオーバーライドして例外をスローする
- または、読み取り専用のMap-likeインターフェースを実装する

### 2. セレクター使用時の統計フィルタリング

現在の実装では、セレクターが指定された場合、関連する統計のみを返しています。しかし、ブラウザ版では：
- peer-connection統計は常に含まれる
- transport統計も常に含まれる
- セレクターは主にRTP関連の統計のフィルタリングに使用される

**修正案**:
- セレクターが指定された場合でも、一般的な統計（peer-connection, transport, data-channel）は常に含める
- セレクターはRTP関連の統計（outbound-rtp, inbound-rtp, media-source）のフィルタリングのみに使用

### 3. 統計IDの一貫性

現在の実装では統計IDが適切に生成されていますが、ブラウザ実装との完全な互換性を確保するために、以下の点を確認する必要があります：
- 同一オブジェクトのIDがgetStats()呼び出し間で一貫している
- IDの形式がブラウザ実装と類似している

## 推奨される実装手順

1. **RTCStatsReportクラスの改修**
   - 読み取り専用のMap-likeオブジェクトとして実装
   - 変更操作メソッドをオーバーライドして例外をスロー

2. **getStats()メソッドの改修**
   - セレクター使用時のフィルタリングロジックを修正
   - 一般的な統計は常に含めるように変更

3. **テストの更新**
   - 読み取り専用性のテストを追加
   - セレクター使用時の挙動テストを更新

## 影響範囲

- `packages/webrtc/src/peerConnection.ts`: getStats()メソッドの修正
- `packages/webrtc/src/media/stats.ts`: RTCStatsReportクラスの修正
- `packages/webrtc/tests/integrate/getStats.test.ts`: テストケースの更新

## 結論

現在の実装は基本的な機能は提供していますが、ブラウザ版との完全な互換性を確保するためには、主に以下の2点の修正が必要です：

1. RTCStatsReportの読み取り専用化
2. セレクター使用時の統計フィルタリングロジックの修正

これらの修正により、werift-webrtcのgetStats()実装がブラウザ版WebRTC APIとより高い互換性を持つようになります。
