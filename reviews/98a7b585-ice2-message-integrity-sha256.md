---
ide:
  viewer: review-document
  version: 1
  title: "ICE2 / MESSAGE-INTEGRITY-SHA256 レビュー解説"
  dock: right
  baseCommit: 34108f4149b5318d325b37101618673c3103e4a5
---
# ICE2 / MESSAGE-INTEGRITY-SHA256 レビュー解説

## 1. 概要

STUN の `MESSAGE-INTEGRITY-SHA256`（RFC 8489、属性 `0x001C`）を、ICE の短期クレデンシャルで生成・検証できるようにしました。これまでは SHA-256 だけで署名された応答が `parseMessage(data, key)` で必ず破棄されていました。この食い違いを解消しています。あわせて SDP の `ice2` ice-option を、設定で出力でき、リモート側の宣言を取得できるようにしました。

ブラウザとの相互接続を守るため、送信のデフォルトは従来どおり SHA-1 の `MESSAGE-INTEGRITY` のままです。SHA-256 はオプトインです。受信と検証、および「リクエストと同じアルゴリズムで応答する」処理だけを常時有効にしています。`ice2` も宣言と取得だけで、ICE の挙動は変えません。

実装コミットは `eec4db261` です。HEAD は `34108f414` で、その後ろは develop のマージです。

<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-family:sans-serif;font-size:13px">
<div style="border:1px solid #888;border-radius:6px;padding:10px"><b>変更前</b><br>送信: MI（SHA-1）固定<br>検証: MI のみ。SHA-256 のみの応答は破棄<br>応答: MI 固定<br>SDP: <code>trickle</code> 固定</div>
<div style="border:1px solid #888;border-radius:6px;padding:10px"><b>変更後</b><br>送信: 既定は MI。<code>sha256</code> / <code>both</code> はオプトイン<br>検証: MI / MI-SHA256（併用時は SHA256 のみ）<br>応答: リクエストと同じアルゴリズム<br>SDP: 設定で <code>trickle ice2</code></div>
</div>

## 2. 主要変更

### 2.1 STUN メッセージ層（`packages/ice-server`、ice も再エクスポートで共有）

- 定数と型: [packages/ice-server/src/stun/const.ts](review-diff:packages/ice-server/src/stun/const.ts) に `INTEGRITY_SHA256_LENGTH`（36）などと、`MessageIntegrityAlgorithm`（`sha1` / `sha256`）、`MessageIntegrityMode`（これに `both` を加えたもの）を追加しました。
- 長さの検証: [isValidIntegritySha256Length](review-file:packages/ice-server/src/stun/message.ts:37) は、16 以上 32 以下の 4 の倍数だけを許可します（RFC 8489 §14.6）。
- 検証: [parseMessage](review-diff:packages/ice-server/src/stun/message.ts:46) が MI-SHA256 を検証します。
  - MI と MI-SHA256 の両方がある場合は MI-SHA256 だけで判定します（§9.1.4）。判定は [ループ後の分岐](review-file:packages/ice-server/src/stun/message.ts:171) です。
  - 不正な長さは [148 行目](review-file:packages/ice-server/src/stun/message.ts:148) で `undefined` にします。
  - 比較は [integrityMatches](review-file:packages/ice-server/src/stun/message.ts:409) で `timingSafeEqual` を使います。SHA-1 の比較も同じ関数に揃えました。
  - MI の後ろにある MI-SHA256 / FINGERPRINT 以外の属性と、MI-SHA256 の後ろにある FINGERPRINT 以外の属性は、[保持せず読み飛ばします](review-file:packages/ice-server/src/stun/message.ts:88)。**既存のパース挙動が変わる箇所です。**
- 生成:
  - [addMessageIntegritySha256(key, length)](review-file:packages/ice-server/src/stun/message.ts:295) は範囲外の長さで `RangeError` を投げます。FINGERPRINT の後ろへの追加も拒否します。
  - [addIntegrity(key, mode)](review-file:packages/ice-server/src/stun/message.ts:323) は `sha1` / `sha256` / `both` を選べます。順序は MI → MI-SHA256 → FINGERPRINT です。
  - [integrityAlgorithm](review-file:packages/ice-server/src/stun/message.ts:261) で、呼び出し側が署名方式を判定できます。
  - HMAC 計算は [computeIntegrity](review-file:packages/ice-server/src/stun/message.ts:392) に一本化しました。

### 2.2 ICE 層（`packages/ice`）

- 応答: [ice.ts:1101](review-diff:packages/ice/src/ice.ts:1101) の成功応答と [ice.ts:2826](review-diff:packages/ice/src/ice.ts:2826) のエラー応答は、[responseIntegrityMode](review-file:packages/ice/src/ice.ts:2840) で決めます。リクエストが MI-SHA256 を持っていれば SHA-256 で、それ以外は SHA-1 で署名します。
- 送信オプション:
  - [IceOptions.messageIntegrity](review-diff:packages/ice/src/iceBase.ts:436) を追加しました。
  - `TransactionRequestOptions.integrityAlgorithm`（[types/model.ts:45](review-file:packages/ice/src/types/model.ts:45)）を、UDP（[stun/protocol.ts](review-diff:packages/ice/src/stun/protocol.ts)）、TCP（[stun/tcpProtocol.ts](review-diff:packages/ice/src/stun/tcpProtocol.ts)）、TURN（[turn/protocol.ts](review-diff:packages/ice/src/turn/protocol.ts)）の `request()` に渡します。
- ice-options の保持: [setRemoteIceOptions / remoteIce2](review-file:packages/ice/src/ice.ts:827)。

### 2.3 WebRTC 層（`packages/webrtc`）

- 設定: [PeerConfig.iceMessageIntegrity](review-diff:packages/webrtc/src/api/peerConfig.ts:136) と [PeerConfig.iceOptionIce2](review-diff:packages/webrtc/src/api/peerConfig.ts:143)。`iceOptionIce2` は構築後に変更すると `InvalidModificationError` になります。
- SDP 出力: [sdpManager.ts:55](review-diff:packages/webrtc/src/sdpManager.ts:55) で `trickle` / `trickle ice2` を切り替えます。
- 解釈: [parseIceOptions / descriptionIceOptions](review-diff:packages/webrtc/src/sdp.ts:37) を共通化しました。`canTrickleIceCandidates` と、新しい [remoteIceOptionIce2](review-file:packages/webrtc/src/peerConnection.ts:480) の両方がこれを使います。
- 伝達: `remoteMediaApplication.ts` と `transportActivation.ts` が、リモート記述の適用時に `RTCIceTransport.setRemoteIceOptions` を呼びます。

### 2.4 ドキュメントとテスト

- `changelog.md`、各 README、`AGENTS.md`、`docs/browser-api-compatibility.md`、生成 doc（`doc/`、`packages/*/doc`）を更新しています。
- テストの Arrange は共通ユーティリティにまとめています。
  - [packages/ice-server/tests/messageIntegrityUtils.ts](review-file:packages/ice-server/tests/messageIntegrityUtils.ts)
  - [packages/ice/tests/utils.ts](review-file:packages/ice/tests/utils.ts)
  - [packages/webrtc/tests/utils.ts](review-file:packages/webrtc/tests/utils.ts)
- 固定ベクタは `packages/ice/tests/data/binding_request_mi_*.bin` の 3 件です。

## 3. 判断理由

- **送信のデフォルトを SHA-1 にした理由**: `0x001C` は comprehension-required の範囲です。MI-SHA256 を知らないピアは 420 を返すか、メッセージを破棄する可能性があります。ブラウザ互換を優先しました。
- **`ice2` を MI-SHA256 の自動有効化に使わなかった理由**: `ice2` は RFC 8445 準拠の宣言にすぎず、MI-SHA256 対応を保証しません。チケットでも Phase 2 扱いでした。
- **`ice2` で挙動を分岐しなかった理由**: werift は既に RFC 8445 の手順で動いているためです。
- **受信 Binding Request の完全性検証（401 応答）を別チケットに切り出した理由**: 既存の挙動を大きく変えるためです。この判断は [ice.ts の該当箇所のコメント](review-file:packages/ice/src/ice.ts:1033) と changelog に明記されています。SHA-256 の検証ロジック自体は `parseMessage(data, localPassword)` でそのまま使えます。
- **TURN 長期クレデンシャルの SHA-256（`PASSWORD-ALGORITHM` など）を対象外にした理由**: クライアントとサーバの両方に影響が大きいためです。changelog にも「別の変更」と書かれています。

## 4. レビュアーが確認すべき点・リスク

1. **`parseMessage` の後続属性の無視**: MI の後ろにある属性が保持されなくなります。MI より後ろに独自属性を置く実装との互換性と、FINGERPRINT 検証の順序を確認してください。
2. **公開 API の追加**: `IceOptions.messageIntegrity`、`PeerConfig.iceMessageIntegrity` / `iceOptionIce2`、`Message` の 3 メソッド（`addMessageIntegritySha256`、`addIntegrity`、`integrityAlgorithm`）、`RTCIceTransport.remoteIce2` / `remoteIceOptions`、`RTCPeerConnection.remoteIceOptionIce2` が増えます。
3. **`addMessageIntegrity()` の新しい例外**: すでに MI-SHA256 がある状態で呼ぶと例外になります。順序を RFC どおりに強制するためです。
4. **`Protocol` / `IceConnection` インターフェース**: 追加したメンバは `remoteIceOptions?` / `setRemoteIceOptions?` のようにオプショナルです。外部実装が壊れないかを確認してください。
5. **オプトイン時の相互接続**: `sha256` を既存ブラウザに使うと接続できません。ドキュメントと型コメントに注意書きがあります。
6. **実ブラウザとの E2E**: 下記のとおり、この文書の作成時には再実行していません。

## 5. 検証結果

この文書の作成時に、次のコマンドを実行しました。いずれも成功しています。

| 対象 | コマンド | 結果 |
| --- | --- | --- |
| ice-server | `npx vitest run tests/message-integrity.test.ts` | 1 ファイル 26 件 成功 |
| ice | `npx vitest run tests/ice/message-integrity.test.ts tests/stun/stun.test.ts` | 2 ファイル 24 件 成功 |
| webrtc | `npx vitest run tests/sdp.test.ts tests/integrate/iceOptions.test.ts` | 2 ファイル 14 件 成功 |

未実施:

- `npm run type`、`npm run test:small`、`npm run e2e`、`npm run wpt`、ブラウザ相互接続。チケットの完了条件には含まれますが、この文書の作成時には実行していません。
- ブラウザ（libwebrtc / Firefox）が MI-SHA256 を受理するかどうかの確認。デフォルトを SHA-1 にして回避しています。
