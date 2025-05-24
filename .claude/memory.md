# WebRTC実装プロジェクト アーキテクチャ分析

## プロジェクト概要

werift-webrtcは、TypeScript (Node.js) で実装されたピュアなWebRTC実装プロジェクトです。
ネイティブライブラリに依存せず、RFC準拠の完全なWebRTCスタックを提供します。

## 1. モジュール構成

### packages/ディレクトリ内の各パッケージ

#### common (werift-common)
- **役割**: 全パッケージで共通利用されるユーティリティライブラリ
- **主要機能**: 
  - バイナリデータ操作 (binary.ts)
  - イベントシステム (event.ts)
  - ログ機能 (log.ts)
  - ネットワーク関連ユーティリティ (network.ts)
  - 数値操作 (number.ts)
  - Promise関連ユーティリティ (promise.ts)
  - トランスポート抽象化 (transport.ts)
  - 型定義 (type.ts)

#### ice (werift-ice)
- **役割**: ICE (Interactive Connectivity Establishment) プロトコル実装
- **主要機能**:
  - ICE候補の収集と管理
  - STUN/TURNプロトコル実装
  - NAT越境ロジック
  - 接続確立処理
- **依存関係**: common

#### dtls (werift-dtls)
- **役割**: DTLS (Datagram Transport Layer Security) プロトコル実装
- **主要機能**:
  - セキュアな通信チャンネル確立
  - 暗号化/復号化処理
  - 証明書管理
  - ハンドシェイク処理
- **依存関係**: common, rtp (一部機能)

#### rtp (werift-rtp)
- **役割**: RTP/RTCP/SRTP/SRTCP プロトコル実装
- **主要機能**:
  - RTPパケット処理
  - RTCPフィードバック
  - 暗号化RTP (SRTP)
  - コーデック実装 (H.264, VP8, VP9, AV1, Opus)
  - ジッターバッファ
  - NACK/FIR/PLI実装
- **依存関係**: common

#### sctp (werift-sctp)
- **役割**: SCTP (Stream Control Transmission Protocol) 実装
- **主要機能**:
  - DataChannel用の信頼性のあるデータ転送
  - メッセージ配信保証
  - フロー制御
- **依存関係**: common

#### webrtc (werift)
- **役割**: メインのWebRTC APIパッケージ
- **主要機能**:
  - RTCPeerConnection実装
  - MediaStream/MediaStreamTrack実装
  - RTCDataChannel実装
  - SDP処理
  - 統合管理レイヤー
- **依存関係**: common, dtls, ice, rtp, sctp (全パッケージを統合)

## 2. コア機能の実装構造

### RTCPeerConnection
- **場所**: packages/webrtc/src/peerConnection.ts
- **役割**: WebRTC接続の中核クラス
- **構成要素**:
  - SDPManager: SDP処理管理
  - TransceiverManager: メディアトランシーバー管理
  - SctpTransportManager: DataChannel管理
  - SecureTransportManager: セキュリティ管理
  - RtpRouter: RTP パケットルーティング

### RTCDataChannel
- **場所**: packages/webrtc/src/dataChannel.ts
- **実装**: SCTP上でのデータチャンネル機能
- **状態管理**: connecting → open → closing → closed

### MediaChannel (RTCRtpTransceiver)
- **場所**: packages/webrtc/src/media/rtpTransceiver.ts
- **構成**: RTCRtpSender + RTCRtpReceiver
- **方向制御**: sendrecv, sendonly, recvonly, inactive

### RTCレイヤー実装

#### ICEレイヤー
- **場所**: packages/ice/src/ice.ts
- **機能**: 候補収集、接続確立、Consent確認
- **トランスポート**: UDP/TCP両対応

#### DTLSレイヤー  
- **場所**: packages/dtls/src/
- **機能**: TLS over UDP、証明書検証、セッション管理
- **実装**: client.ts, server.ts, socket.ts

#### SCTPレイヤー
- **場所**: packages/sctp/src/sctp.ts
- **機能**: 信頼性のあるメッセージ配信
- **チャンク処理**: chunk.ts

#### RTP/RTCPレイヤー
- **場所**: packages/rtp/src/
- **RTPパケット**: rtp/rtp.ts
- **RTCPパケット**: rtcp/rtcp.ts
- **SRTP**: srtp/session.ts

## 3. 開発ワークフロー

### monorepo構成
- **ツール**: npm workspaces
- **ビルド戦略**: 各パッケージ独立ビルド → webrtcパッケージで統合
- **テスト戦略**: 
  - 単体テスト: 各パッケージのtests/
  - 統合テスト: packages/webrtc/tests/
  - E2Eテスト: e2e/

### examplesディレクトリ活用
- **datachannel/**: データチャンネル実装例
- **mediachannel/**: メディア転送実装例
- **ice/**: ICE処理実装例
- **save_to_disk/**: メディア保存実装例

### e2eテスト構成
- **ブラウザテスト**: Playwright使用
- **実動作確認**: 実際のWebRTC通信テスト
- **互換性テスト**: ブラウザ実装との相互運用

## 4. 重要な設計パターン

### イベント駆動アーキテクチャ
- **Event クラス**: packages/common/src/event.ts
- **EventTarget継承**: 各主要クラスでイベント発行
- **パイプライン**: イベントチェーン処理

### レイヤー分離
- **トランスポート抽象化**: transport.ts
- **プロトコルスタック**: ICE → DTLS → SCTP/RTP
- **API層とプロトコル層の分離**

### マネージャーパターン
- **SDPManager**: SDP生成・パース管理
- **TransceiverManager**: メディアトランシーバー管理
- **SecureTransportManager**: セキュリティトランスポート管理
- **SctpTransportManager**: SCTP管理

### エラーハンドリング戦略
- **例外の分類**: 各パッケージで独自例外クラス
- **ログ出力**: debug モジュール使用
- **状態管理**: 明確な状態遷移定義

### 非同期処理パターン
- **Promise中心**: async/await使用
- **Event Emitter**: リアルタイム通知
- **PromiseQueue**: packages/common/src/promise.ts

### コーデック抽象化
- **DePacketizer**: packages/rtp/src/codec/base.ts
- **個別コーデック**: h264.ts, vp8.ts, vp9.ts, av1.ts, opus.ts
- **拡張可能設計**: 新コーデック追加容易

## アーキテクチャの特徴

1. **ピュアTypeScript実装**: ネイティブ依存なし
2. **RFC準拠**: 標準仕様に忠実な実装
3. **モジュラー設計**: 各プロトコル層が独立
4. **拡張性**: 新機能追加が容易
5. **テスト充実**: 単体〜E2Eまで包括的
6. **実用性重視**: 実際のWebRTCアプリケーションで使用可能

## packages/webrtc/src/ 詳細構造

### コアファイル
- **index.ts**: パッケージエクスポート
- **peerConnection.ts**: RTCPeerConnection実装 (750+ lines)
- **dataChannel.ts**: RTCDataChannel実装
- **helper.ts**: ヘルパー関数
- **const.ts**: 定数定義
- **utils.ts**: ユーティリティ関数

### 管理層 (Manager)
- **sdpManager.ts**: SDP処理管理
- **transceiverManager.ts**: トランシーバー管理
- **sctpManager.ts**: SCTP管理
- **secureTransportManager.ts**: セキュリティ管理

### メディア層 (media/)
- **rtpTransceiver.ts**: RTPトランシーバー
- **rtpSender.ts**: RTP送信機
- **rtpReceiver.ts**: RTP受信機
- **router.ts**: パケットルーティング
- **track.ts**: メディアトラック
- **codec.ts**: コーデック定義
- **parameters.ts**: RTPパラメータ
- **stats.ts**: 統計情報（WebRTC Statistics API実装）

### トランスポート層 (transport/)
- **ice.ts**: ICEトランスポート
- **dtls.ts**: DTLSトランスポート  
- **sctp.ts**: SCTPトランスポート

### ユーティリティ
- **imports/**: 他パッケージインポート
- **types/**: 型定義
- **nonstandard/**: 非標準拡張機能

このアーキテクチャにより、WebRTCの複雑なプロトコルスタックを整理された形で実装し、保守性と拡張性を両立しています。