# CLAUDE.md

このファイルはClaude Code (claude.ai/code)がこのリポジトリで作業する際のガイダンスを提供します。

## プロジェクト概要

werift（WebRTC Implementation for TypeScript）は、Node.js向けのピュアTypeScriptによるWebRTC実装です。ICE/DTLS/SCTP/RTPプロトコルスタックを包含する完全なWebRTCライブラリです。

### アーキテクチャ

6つのコアパッケージで構成されたmonorepo構成：

```
webrtc (メインAPI)
├── dtls (セキュア通信)
├── ice (接続確立) 
├── rtp (メディア転送)
├── sctp (データ転送)
└── common (共通ユーティリティ)
```

**プロトコルスタック**: ICE → DTLS → SCTP/RTP

**主要コンポーネント**:
- `RTCPeerConnection`: WebRTC接続の中核クラス
- `RTCDataChannel`: データチャンネル機能
- `RTCRtpTransceiver`: メディアトランシーバー（送受信制御）

## 開発コマンド

### ビルドとテスト
```bash
# 全パッケージビルド
npm run build

# 全テスト実行（単体テスト + E2Eテスト）
npm run test

# 単体テストのみ
npm run test:small

# E2Eテストのみ（ブラウザテスト）
npm run e2e

# 特定パッケージのテスト
cd packages/webrtc && npm test
```

### 開発ツール
```bash
# コードフォーマット（Biome使用）
npm run format

# 型チェック
npm run type:all

# ドキュメント生成
npm run doc

# 依存関係チェック
npm run knip
```

### デバッグ
```bash
# デバッグログ付きで実行
DEBUG=werift* npm run example

# 特定の例を実行
npm run datachannel  # DataChannel例
npm run media        # MediaChannel例
```

### E2Eテスト詳細
```bash
# Chrome E2Eテスト
cd e2e && npm run chrome

# Firefox E2Eテスト  
cd e2e && npm run firefox

# 本番環境テスト
cd e2e && npm run ci
```

## 開発ガイドライン

### Monorepo作業

1. **パッケージ間依存関係**: 変更時は依存先パッケージへの影響を考慮
2. **ビルド順序**: common → ice/dtls/rtp/sctp → webrtc の順序でビルド
3. **テスト実行**: 各パッケージの単体テスト後、webrtcパッケージの統合テスト

### 重要な設計パターン

**マネージャーパターン**: 複雑な機能は専門マネージャークラスで管理
- `SDPManager`: SDP処理
- `TransceiverManager`: メディア管理
- `SctpTransportManager`: DataChannel管理

**イベント駆動**: EventTargetを継承し、非同期通知を実装

**エラーハンドリング**: 各パッケージで独自例外クラスを定義

### WebRTCプロトコル理解

- **ICE**: ネットワーク接続確立とNAT穴あけ
- **DTLS**: UDP上でのTLS暗号化
- **SCTP**: 信頼性のあるメッセージ配信（DataChannel用）
- **RTP/RTCP**: リアルタイムメディア転送とフィードバック

### examplesディレクトリ活用

実装参考のため積極的に活用：
- `datachannel/`: DataChannel実装例
- `mediachannel/`: 音声・映像転送例
- `ice/`: ICE処理例
- `save_to_disk/`: メディア録画例

### ブラウザ互換性

Chrome、Firefox、Safari での動作確認済み。
ブラウザ固有の実装差異に注意が必要。

## プロジェクト固有の注意事項

- **デバッグ**: `DEBUG=werift*` 環境変数でログ出力制御
- **Node.js要件**: 最低Node.js 16以上
- **RFC準拠**: WebRTC関連RFCに忠実な実装
- **TypeScript**: 型安全性を重視した実装

## よく使用されるファイルパス

- メインAPI: `packages/webrtc/src/index.ts`
- PeerConnection: `packages/webrtc/src/peerConnection.ts`
- DataChannel: `packages/webrtc/src/dataChannel.ts`  
- RTCメディア: `packages/webrtc/src/media/`
- 統合テスト: `packages/webrtc/tests/integrate/`