---
ide:
  viewer: review-document
  version: 1
  title: "DCEP DATA_CHANNEL_OPEN の Label / Protocol Length を UTF-8 バイト数にする修正"
  dock: right
  baseCommit: d0edbcae072c789c16498854acda4a3e3207cbcc
---
# DCEP DATA_CHANNEL_OPEN の Label / Protocol Length を UTF-8 バイト数にする修正

## 1. 概要

`DATA_CHANNEL_OPEN` の Label Length / Protocol Length に UTF-16 の `string.length` を書いていたため、非 ASCII の `label` / `protocol` で受信側の値が壊れていました。エンコード済み `Buffer` の `.length` を書くように直し、長さとペイロードが構造的にずれないようにしました。レビューで、UTF-8 で 65535 バイトを超える値を `createDataChannel` が受け付けてしまう問題も指摘されたため、`RTCDataChannel` と `createDataChannel` の入口で `TypeError` にしています。

<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
<div style="border:1px solid #c0392b;border-radius:8px;padding:10px"><b>変更前</b><br/>Label Length = <code>"日本語".length</code> = 3<br/>実ペイロード = 9 バイト<br/>受信側は先頭 3 バイト（"日"）だけを label とし、残りを protocol として読む</div>
<div style="border:1px solid #27ae60;border-radius:8px;padding:10px"><b>変更後</b><br/>Label Length = <code>Buffer.from(label).length</code> = 9<br/>実ペイロード = 9 バイト<br/>ヘッダとペイロードが常に一致する</div>
</div>

## 2. 主要変更

### 送信側の長さ修正（核）

[packages/webrtc/src/transport/sctp.ts:271](review-file:packages/webrtc/src/transport/sctp.ts:271) で `label` / `protocol` を一度だけ UTF-8 エンコードします。
[packages/webrtc/src/transport/sctp.ts:310](review-diff:packages/webrtc/src/transport/sctp.ts:310) で、そのバッファの `.length` を Length フィールドに書き、同じバッファを `Buffer.concat` に渡します。ASCII ではワイヤ上のバイト列は変わりません。

### 65535 バイト上限の検証（レビュー指摘への対応）

Length は 16 ビットなので、UTF-8 で 65535 バイトを超える値は表現できません。
[packages/webrtc/src/dataChannel.ts:13](review-diff:packages/webrtc/src/dataChannel.ts:13) に `assertDataChannelFieldLengths()` を追加し、超過時は `TypeError` を投げます。呼び出し箇所は 2 つです。

- [packages/webrtc/src/dataChannel.ts:81](review-file:packages/webrtc/src/dataChannel.ts:81): `RTCDataChannel` のコンストラクタ。ID 登録などの状態を変える前に検証します。
- [packages/webrtc/src/peerConnection.ts:699](review-diff:packages/webrtc/src/peerConnection.ts:699): `createDataChannel` の先頭。SCTP transport の生成や `needNegotiation()` より前に検証するので、失敗した呼び出しは接続の状態を変えません。

### テスト

- [packages/webrtc/tests/transport/sctp.test.ts:244](review-diff:packages/webrtc/tests/transport/sctp.test.ts:244): ASCII、CJK とサロゲートペア、空 label、空 protocol の 4 ケースで、ワイヤ上の Length が `Buffer.byteLength` と一致し、`12 + 両者の合計` がペイロード長に等しいことを確認します。受信側チャネルの `label` / `protocol` の完全一致も確認します。
- [packages/webrtc/tests/transport/sctp.test.ts:288](review-diff:packages/webrtc/tests/transport/sctp.test.ts:288): 過長な label / protocol が `TypeError` になり、OPEN が送られず、同じ ID で作り直せることを確認します。
- [packages/webrtc/tests/datachannel/openLimit.test.ts:1](review-file:packages/webrtc/tests/datachannel/openLimit.test.ts:1): `RTCPeerConnection.createDataChannel` 経由で、negotiated と in-band の両方について、`TypeError`、SCTP transport 未生成、negotiation 未予約、ID 解放を確認します。
- 共通 Arrange は [packages/webrtc/tests/transport/sctp.test.ts:112](review-file:packages/webrtc/tests/transport/sctp.test.ts:112) の `connectedPair()` と `captureDcep()` に切り出しました。既存の 2 テストの重複セットアップもこれに置き換えています。

### changelog

[changelog.md:47](review-file:changelog.md:47) に修正の 1 行を追加しました。

## 3. 判断理由

- **`Buffer.byteLength()` ではなくエンコード済みバッファの `.length` を使う**: 長さを別計算にすると、長さとペイロードがずれる余地が残ります。チケットの推奨どおりです。
- **ワイヤ値を直接検証するテストを入れた**: werift 同士のラウンドトリップは、送受信が同じ誤りをしても通ります。ブラウザとの相互接続性を担保するため、DCEP を記録して Length フィールドを直接確認しています。
- **65535 バイト検証を今回の範囲に含めた**: チケットは「別チケット可」としていましたが、レビューの再指摘で取り込みました。`writeUInt16BE` の `RangeError` や遅延 flush 内での失敗より、W3C 準拠の `TypeError` を同期的に返すほうが妥当と判断しています。
- **検証を `src` の既定 API に置いた**: W3C が `createDataChannel` に求める挙動で、werift の利便性を損なわないため、`wpt-runner` のラッパーには寄せていません。
- **採用しなかった案**: 受信側の `12 + labelLength + protocolLength > data.length` 検証は任意項目で、今回は入れていません。

## 4. レビュアーが確認すべき点・リスク

- **互換性**: ASCII の値はワイヤ上で不変です。非 ASCII だけが仕様準拠の値に変わります。旧 werift が送った壊れた OPEN の受信互換は考慮していません（受信側は元から仕様どおりの解釈）。
- **振る舞いの変更**: `createDataChannel` / `RTCDataChannel` が、UTF-8 で 65535 バイトを超える label / protocol に `TypeError` を投げるようになりました。公開 API の型とシグネチャは変わりません。
- **差分に含まれる無関係な変更**: 本ブランチには「Merge develop into ticket worktree」が入っています。`main` との差分には BWE や `enum` の `as const` 化などの develop 由来の変更が大量に含まれますが、本チケットの変更ではありません。本チケットの範囲は上記のファイルだけです。
- **未対応の関連問題**: `!ordered` かつ `maxRetransmits` / `maxPacketLifeTime` 指定時の unordered ビット喪失は、チケット上は範囲外です。changelog の既存行（[changelog.md:154](review-file:changelog.md:154)）を見ると、別チケット 340fdd75 で修正済みのようです。
- **フォローアップチケット**: 完了条件の「範囲外の問題をフォローアップ起票したか、起票しない判断を PR に記載」は、今回確認できていません。65535 バイト検証は本修正に取り込み済みです。

## 5. 検証結果

- 実行: `cd packages/webrtc && npx vitest run tests/transport/sctp.test.ts tests/datachannel/` → 5 ファイル 41 テストがすべて成功（本文書の作成時に実行）。
- 未実行（本文書の作成時）: `npm run type`、`npm run format`、`npm run test:small`、および「追加テストが修正前のコードで失敗すること」の確認。これらをレビュー過程で実行した記録は、差分とコミット履歴からは読み取れません。
