# Bug: DCEP DATA_CHANNEL_OPEN writes UTF-16 label/protocol lengths for UTF-8 bytes

> Found while fixing ticket 340fdd75.

## 1. 目的と背景

`packages/webrtc/src/transport/sctp.ts` の `RTCSctpTransport.dataChannelOpen()` は DCEP の DATA_CHANNEL_OPEN を組み立てるときに、
**Label Length / Protocol Length に `string.length`（UTF-16 のコードユニット数）を書き込みます**。一方で後ろに付ける本体は `Buffer.from(..., "utf8")`（UTF-8 のバイト列）です。

RFC 8832 §5.1 では、Label Length / Protocol Length は **Label / Protocol フィールドのバイト数**と定められています（どちらも UTF-8 文字列）。ASCII では 2 つの値がたまたま一致しますが、非 ASCII では一致しません。

| 値 | `.length`（UTF-16） | `Buffer.byteLength(utf8)` |
| --- | --- | --- |
| `"chat"` | 4 | 4 |
| `"日本語"` | 3 | 9 |
| `"😀"`（サロゲートペア） | 2 | 4 |

このため、受信側（werift 自身の `datachannelReceive`、ブラウザ、その他の実装）では次の問題が起きます。

- label が途中で切れる（`"日本語"` が先頭 3 バイト、つまり `"日"` だけになる）
- 残りの label バイトが protocol として解釈され、protocol が壊れる。UTF-8 の途中で切れれば U+FFFD になる
- ヘッダの長さとペイロードの長さが合わないので、厳密な実装には不正メッセージとして捨てられる可能性がある

結果として `ondatachannel` に届くチャネルの `label` / `protocol` が送信側と一致せず、label ベースでチャネルを振り分けるアプリが動きません。

## 2. 実装すべき変更

### 2.1 送信側の修正（必須）

`packages/webrtc/src/transport/sctp.ts`、`dataChannelOpen()` の 278〜292 行付近:

```ts
// 現状
data.writeUInt16BE(channel.label.length, 8);
data.writeUInt16BE(channel.protocol.length, 10);
const send = Buffer.concat([
  data,
  Buffer.from(channel.label, "utf8"),
  Buffer.from(channel.protocol, "utf8"),
]);
```

```ts
// 修正案: エンコード済みバッファの長さをそのまま書く
const label = Buffer.from(channel.label, "utf8");
const protocol = Buffer.from(channel.protocol, "utf8");
...
data.writeUInt16BE(label.length, 8);
data.writeUInt16BE(protocol.length, 10);
const send = Buffer.concat([data, label, protocol]);
```

- `Buffer.byteLength()` を別途呼ぶより、一度だけエンコードしたバッファの `.length` を使うほうが、長さとペイロードが構造的にずれません。
- コメント `// 5.1. DATA_CHANNEL_OPEN Message` の近くに「Length はバイト数（RFC 8832 §5.1）」と一言添えます。

### 2.2 受信側の確認（変更不要の見込み）

`datachannelReceive` の DATA_CHANNEL_OPEN 処理（137〜160 行付近）は、すでに `readUInt16BE(8/10)` を**バイト長**として扱い `slice(...).toString("utf8")` しているので、仕様どおりです。送信側を直せばラウンドトリップは成立します。

- ただし、`12 + labelLength + protocolLength > data.length` の場合の検証がありません（`slice` は範囲外でも例外を出さず、黙って切り詰めます）。この修正の必須範囲ではありませんが、扱いは「4. 制約・注意点」に記載します。

### 2.3 テスト追加（必須）

`packages/webrtc/tests/transport/sctp.test.ts` の `describe("RTCSctpTransportTest")` にテストを追加します。

1. **マルチバイトのラウンドトリップ（in-band negotiation）**
   - Arrange: 既存テスト `test_connect_then_client_creates_data_channel` と同じく、`dtlsTransportPair()` から client / server の `RTCSctpTransport` を作り、`start()` と `waitForOutcome()` で association を確立する。
   - Act: client 側で `new RTCDataChannel(client, new RTCDataChannelParameters({ label: "日本語ラベル😀", protocol: "プロトコル/ü", id: 1 }))` を作り、server の `onDataChannel` を待つ。
   - Assert: server 側チャネルの `label` / `protocol` が送信値と完全に一致する。混在ケース（ASCII + マルチバイト + サロゲートペア）を入れて、label の切り詰めと protocol へのはみ出しの両方を検出できるようにする。
2. **ワイヤフォーマットの単体検証（推奨）**
   - `transport.sctp.send` を差し替えて（既存テスト `stop discards unsent messages...` と同じ手法）、DATA_CHANNEL_OPEN の `userData` を取り出す。
   - `readUInt16BE(8) === Buffer.byteLength(label)`、`readUInt16BE(10) === Buffer.byteLength(protocol)`、`userData.length === 12 + 両者の合計` を確認する。
   - ラウンドトリップは werift 同士なので、仮に送受信の両方が同じ誤りをしても通ってしまいます。ワイヤ上の値を直接確認すると、ブラウザとの相互接続性を担保できます。
3. 必要なら、空 label / 空 protocol（長さ 0）の回帰確認を同じテストのパラメータに含める。

テスト規約（root / package の `AGENTS.md`）:

- Arrange / Act / Assert 構成にし、各 Act / Assert に日本語コメントを付ける。
- association 確立などの共通 Arrange は、ファイル内の既存ヘルパー（`trackChannels`、`waitForOutcome`）を再利用する。新たに重複したセットアップを書かない。必要ならファイル末尾のヘルパー群に `connectedPair()` のような関数として切り出す。

## 3. 技術調査の結果

| 項目 | 内容 |
| --- | --- |
| 対象コード | `packages/webrtc/src/transport/sctp.ts` `dataChannelOpen()`（254 行〜）、`datachannelReceive`（126 行〜） |
| 定数 | `packages/webrtc/src/const.ts` `DATA_CHANNEL_OPEN = 3`、`WEBRTC_DCEP` |
| 呼び出し元 | `RTCDataChannel` のコンストラクタ（`negotiated: false` の場合）から `dataChannelOpen()` が呼ばれ、`dataChannelQueue` 経由で `dataChannelFlush()` が SCTP へ渡す |
| 停止・再接続の経路 | `discardUnsentMessages()` は `userData[0] === DATA_CHANNEL_OPEN` だけを見るので、長さ修正の影響はない |
| 下位層 | `packages/sctp` は DCEP を解釈しない（ppid 50 のペイロードをそのまま運ぶ）ので、修正は `packages/webrtc` 内で完結する |
| 仕様 | RFC 8832 §5.1: "Label Length: 2 bytes (unsigned integer) — The length of the label field in bytes." Protocol Length も同様 |
| 既存テスト | `tests/transport/sctp.test.ts` には ASCII の label（`"chat"`、`"alive"` など）しかなく、protocol を指定したケースもないため、今まで検出されなかった |

## 4. 制約・注意点

- **範囲の限定**: 修正は送信側の長さ計算とテスト追加に絞ります。公開 API の型やシグネチャは変わりません。
- **互換性**: ASCII の label / protocol ではワイヤ上のバイト列は変わりません。非 ASCII の場合だけ、正しい（仕様準拠の）値に変わります。旧 werift が送った壊れた OPEN の受信互換を考える必要はありません（受信側はもともと仕様どおりの解釈です）。
- **65535 バイト上限**: Length は 16bit なので、UTF-8 で 65535 バイトを超える label / protocol は表現できません。W3C WebRTC の `createDataChannel` では、label / protocol が 65535 バイトを超えると `TypeError` を投げると定められていますが、`src/sctpManager.ts` の `createDataChannel` にはこの検証がありません（`writeUInt16BE` が `RangeError` を投げるか、遅延した flush の中で失敗する）。これは別の不具合なので、**このチケットの必須範囲外**とし、必要なら別チケットに切り出します。WPT の厳密な挙動を入れる場合は、`tools/wpt-runner/*` と `src` の住み分けに注意します。
- **受信側の境界検証**: `12 + labelLength + protocolLength > data.length` のときに破棄またはログを出す処理を入れるかどうかは任意です。入れる場合は、既存の `data.length < 12` と同様に `log(...)` して `return` するパターンに合わせます。
- **関連して見つかった別の問題（範囲外のメモ）**: `dataChannelOpen()` は `!ordered` のとき `channelType = 0x80` にしますが、その後 `maxRetransmits` / `maxPacketLifeTime` が設定されていると `channelType = 1 / 2` で上書きし、unordered ビットが失われます（本来は `0x81` / `0x82`）。このチケットでは直さず、別チケットとして起票を検討します。
- **作業規約**: 他のリビジョンとの比較には `git worktree add --detach` を使います。アクティブな worktree で checkout / reset / stash をしてはいけません。PR 前に `npm run format` を実行します。

## 5. 完了条件

- [ ] `dataChannelOpen()` が Label Length / Protocol Length に UTF-8 のバイト数を書き込み、ヘッダの長さとペイロードの長さが常に一致する。
- [ ] `tests/transport/sctp.test.ts` に、マルチバイト（CJK とサロゲートペアを含む）の label / protocol のラウンドトリップテストがあり、server 側の `label` / `protocol` が送信値と完全に一致することを確認している。
- [ ] DATA_CHANNEL_OPEN のワイヤ上の Length フィールドが `Buffer.byteLength(..., "utf8")` と一致することを確認するテストがある。
- [ ] 追加したテストが修正前のコードで失敗し、修正後に通る（実際に確認する）。
- [ ] テストが Arrange / Act / Assert 構成で、日本語コメントを付け、既存ヘルパーを再利用している。
- [ ] `cd packages/webrtc && npm run type` と `npm test`（少なくとも `npx vitest run tests/transport/sctp.test.ts` と `tests/datachannel/`）が通る。
- [ ] `npm run format` を実行済み。
- [ ] 範囲外とした問題（65535 バイト検証、unordered ビットの喪失）をフォローアップチケットとして起票したか、起票しない判断を PR に記載している。
