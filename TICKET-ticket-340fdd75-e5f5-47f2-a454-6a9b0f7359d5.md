## Summary

`RTCSctpTransport.dataChannelOpen()` loses the DCEP unordered bit when a DataChannel is both unordered and partially reliable.

For:

- `ordered: false, maxRetransmits: N`
- `ordered: false, maxPacketLifeTime: N`

werift currently advertises DCEP channel types `0x01` / `0x02` instead of `0x81` / `0x82`.

This makes the remote peer construct the channel as **ordered**, even though the local channel is configured as unordered.

## Current implementation

In `packages/webrtc/src/transport/sctp.ts`:

```ts
let channelType = DATA_CHANNEL_RELIABLE;

if (!channel.ordered) {
  channelType = 0x80;
}
if (channel.maxRetransmits !== null) {
  channelType = 1;
  reliability = channel.maxRetransmits;
} else if (channel.maxPacketLifeTime !== null) {
  channelType = 2;
  reliability = channel.maxPacketLifeTime;
}
```

The second branch overwrites the high-order unordered bit set by the first branch.

The correct constants already exist in `packages/webrtc/src/const.ts`:

```ts
DATA_CHANNEL_RELIABLE_UNORDERED = 0x80
DATA_CHANNEL_PARTIAL_RELIABLE_REXMIT_UNORDERED = 0x81
DATA_CHANNEL_PARTIAL_RELIABLE_TIMED_UNORDERED = 0x82
```

The receive path also interprets the high bit correctly:

```ts
ordered: (channelType & 0x80) === 0
```

so this is specifically an OPEN-message encoding bug.

## Expected behavior

Per RFC 8832, the DCEP channel types are:

| Configuration | Channel Type |
|---|---:|
| reliable ordered | `0x00` |
| retransmit-limited ordered | `0x01` |
| lifetime-limited ordered | `0x02` |
| reliable unordered | `0x80` |
| retransmit-limited unordered | `0x81` |
| lifetime-limited unordered | `0x82` |

RFC 8832: https://www.rfc-editor.org/rfc/rfc8832.html

## Reproduction / downstream evidence

PrismarineJS/node-nethernet found this while validating werift 0.24.4 against native WebRTC implementations.

Their current workaround mutates the queued DCEP OPEN packet:

```js
if (!channel.ordered) {
  const [, , open] = this.sctpTransport.dataChannelQueue.find(
    ([queued]) => queued === channel
  )
  open[1] |= 0x80
}
```

Downstream reference:
https://github.com/PrismarineJS/node-nethernet/pull/28

Their interoperability matrix verifies ordered/unordered and reliability settings across werift/native peers on Linux, macOS and Windows.

## Suggested fix

Preserve the unordered bit while selecting the reliability mode, ideally using the existing constants rather than raw numeric literals.

For example, conceptually:

```ts
if (channel.maxRetransmits !== null) {
  channelType = channel.ordered
    ? DATA_CHANNEL_PARTIAL_RELIABLE_REXMIT
    : DATA_CHANNEL_PARTIAL_RELIABLE_REXMIT_UNORDERED;
} else if (channel.maxPacketLifeTime !== null) {
  channelType = channel.ordered
    ? DATA_CHANNEL_PARTIAL_RELIABLE_TIMED
    : DATA_CHANNEL_PARTIAL_RELIABLE_TIMED_UNORDERED;
} else {
  channelType = channel.ordered
    ? DATA_CHANNEL_RELIABLE
    : DATA_CHANNEL_RELIABLE_UNORDERED;
}
```

## Tests

Please add coverage for all six DCEP channel types, especially:

1. `ordered: false, maxRetransmits: 0` emits `0x81`
2. `ordered: false, maxPacketLifeTime: N` emits `0x82`
3. a werift peer receiving those OPEN messages exposes `ordered === false`
4. browser/native interop preserves unordered semantics

This appears to affect current `develop` as well as werift 0.24.4.
---

# 詳細化（コードベース調査結果）

## 1. 目的と背景

- `RTCSctpTransport.dataChannelOpen()`（`packages/webrtc/src/transport/sctp.ts:247`）が DCEP `DATA_CHANNEL_OPEN` を組み立てるとき、`ordered: false` と部分信頼性（`maxRetransmits` / `maxPacketLifeTime`）を同時に指定すると、Channel Type の unordered ビット（`0x80`）が後続の分岐で上書きされて消える。
  - `ordered:false` 単独 → `0x80`（正しい）
  - `ordered:false, maxRetransmits:N` → `0x01`（正しくは `0x81`）
  - `ordered:false, maxPacketLifeTime:N` → `0x02`（正しくは `0x82`）
- 影響: リモート側（werift・ブラウザ・libwebrtc など）が該当チャネルを **ordered** として生成する。werift 側の送信は `channel.ordered` を見て SCTP DATA チャンクに U フラグを付けるため正しく unordered になるが、**リモート→werift 方向は ordered で送られ**、`RTCDataChannel.ordered` の値も両端で食い違う（非対称な状態）。
- 下流（PrismarineJS/node-nethernet PR #28）は private な `dataChannelQueue` を書き換えて回避しており、本修正で workaround を不要にすることが目的。
- RFC 8832 §5.1 の Channel Type 定義に準拠させる。

## 2. 実装すべき変更内容

### 2.1 送信側エンコードの修正（必須）

対象: `packages/webrtc/src/transport/sctp.ts` の `dataChannelOpen()`（現状 256〜269 行付近）

```ts
let channelType = DATA_CHANNEL_RELIABLE;
...
if (!channel.ordered) channelType = 0x80;
if (channel.maxRetransmits !== null) { channelType = 1; ... }      // ← 0x80 を上書き
else if (channel.maxPacketLifeTime !== null) { channelType = 2; ... } // ← 同上
```

- 信頼性モードの選択と ordered/unordered の選択を独立させ、`packages/webrtc/src/const.ts:13-18` の既存定数を使って 6 種類すべてを正しく出力する。
  - `DATA_CHANNEL_RELIABLE` / `DATA_CHANNEL_PARTIAL_RELIABLE_REXMIT` / `DATA_CHANNEL_PARTIAL_RELIABLE_TIMED`
  - `DATA_CHANNEL_RELIABLE_UNORDERED` / `DATA_CHANNEL_PARTIAL_RELIABLE_REXMIT_UNORDERED` / `DATA_CHANNEL_PARTIAL_RELIABLE_TIMED_UNORDERED`
- 生の数値リテラル（`0x80`, `1`, `2`）を排除する。
- 現在 `sctp.ts` は `DATA_CHANNEL_RELIABLE` しか import していないため、残りの定数を import に追加する。
- テストしやすさのため、`(ordered, maxRetransmits, maxPacketLifeTime) -> { channelType, reliability }` を純粋関数として切り出す（例: `sctp.ts` 内の export 関数、または `const.ts` 近傍）ことを推奨。切り出した関数は `src/index.ts` の公開 API に**追加しない**（内部ヘルパー扱い）。

### 2.2 受信側（変更不要だが確認対象）

- `datachannelReceive` の `DATA_CHANNEL_OPEN` 処理（`sctp.ts:130-188`）は
  - `ordered: (channelType & 0x80) === 0`
  - `maxRetransmits: (channelType & 0x03) === 1 ? reliability : undefined`
  - `maxPacketLifeTime: (channelType & 0x03) === 2 ? reliability : undefined`
  と正しく解釈しているため修正不要。テストで 6 種類すべてのラウンドトリップを確認する。

### 2.3 ドキュメント

- 公開 API の振る舞い（リモートに伝わる `ordered` の値）が変わるため、`CHANGELOG` 等リリースノートがあれば bug fix として記載する。examples の変更は不要。

## 3. 技術的な実装アプローチ（調査結果）

| 項目 | 場所 | 状況 |
|---|---|---|
| OPEN 生成 | `packages/webrtc/src/transport/sctp.ts:247-286` | バグ箇所。`!BBHLHH` ヘッダ + label + protocol を組み立てて `dataChannelQueue` に push |
| 定数 | `packages/webrtc/src/const.ts:12-18` | 6 種類すべて定義済み・未使用 |
| OPEN 受信 | `packages/webrtc/src/transport/sctp.ts:130-188` | 正しく bit 解釈済み |
| チャネル属性 | `packages/webrtc/src/dataChannel.ts:72-82,160-165` | `ordered` 既定 `true`、`maxRetransmits`/`maxPacketLifeTime` 未指定時は getter が `null` を返す |
| オプション検証 | `packages/webrtc/src/sctpManager.ts:41-90` | `maxPacketLifeTime` と `maxRetransmits` の同時指定は既に例外 |
| ユーザーデータ送信 | `sctp.ts` `dataChannelFlush()` | `ordered: channel.ordered` を SCTP に渡しており、ローカル送信方向は既に unordered で正しい |

実装イメージ:

```ts
// 信頼性モード（下位ビット）と unordered ビットを独立に決める
let channelType: number;
let reliability = 0;
if (channel.maxRetransmits !== null) {
  channelType = channel.ordered
    ? DATA_CHANNEL_PARTIAL_RELIABLE_REXMIT
    : DATA_CHANNEL_PARTIAL_RELIABLE_REXMIT_UNORDERED;
  reliability = channel.maxRetransmits;
} else if (channel.maxPacketLifeTime !== null) {
  channelType = channel.ordered
    ? DATA_CHANNEL_PARTIAL_RELIABLE_TIMED
    : DATA_CHANNEL_PARTIAL_RELIABLE_TIMED_UNORDERED;
  reliability = channel.maxPacketLifeTime;
} else {
  channelType = channel.ordered
    ? DATA_CHANNEL_RELIABLE
    : DATA_CHANNEL_RELIABLE_UNORDERED;
}
```

### テスト方針

既存テスト資産:
- `packages/webrtc/tests/transport/sctp.test.ts` — `dtlsTransportPair()`（`tests/fixture.ts:129`）で 2 つの `RTCSctpTransport` を直接接続するテストあり。
- `packages/webrtc/tests/utils.ts:27` `createDataChannelPair(options, pc1, pc2)` — PeerConnection 同士で DataChannel ペアを開く共有 Arrange ユーティリティ（`ordered` / `maxRetransmits` / `maxPacketLifeTime` を受け取れる）。
- `packages/webrtc/tests/integrate/datachannel.test.ts` — 統合テスト。

追加するテスト:
1. **ユニット（エンコード）**: 6 パターン（reliable/rexmit/timed × ordered/unordered）を `test.each` で回し、OPEN バッファの byte[1]（Channel Type）と byte[4..8]（reliability）を検証。特に
   - `ordered:false, maxRetransmits:0` → `0x81`, reliability `0`（`0` が falsy でも REXMIT 扱いになることを確認）
   - `ordered:false, maxPacketLifeTime:N` → `0x82`, reliability `N`
   - 純粋関数として切り出した場合はその関数を直接検証。切り出さない場合は `dataChannelQueue` を参照するのではなく、SCTP 確立後に `sctp.send` をスパイして DCEP ペイロードを取得する方が private 実装依存が少ない。
2. **ラウンドトリップ（werift ⇔ werift）**: `createDataChannelPair({ ordered:false, maxRetransmits:0 })` / `{ ordered:false, maxPacketLifeTime:N }` 等で、受信側チャネルの `ordered === false` と `maxRetransmits` / `maxPacketLifeTime` が送信側と一致することを検証（6 パターン）。配置は `tests/integrate/datachannel.test.ts` または `tests/transport/sctp.test.ts`。
3. **ブラウザ interop（可能なら）**: `e2e/tests/datachannel/` と `e2e/server/handler/datachannel/` に、werift から `ordered:false` + 部分信頼性チャネルを作り、ブラウザ側 `ondatachannel` で `channel.ordered === false` / `maxRetransmits` / `maxPacketLifeTime` を確認するシナリオを追加（逆方向 browser→werift もあれば尚良い）。

テスト規約（AGENTS.md）:
- Arrange / Act / Assert の 3 フェーズで書き、Act / Assert に日本語コメントを付ける。
- 6 パターンの期待値テーブルなど Arrange 用データ・ヘルパーは `tests/utils.ts`（または既存 `tests/fixture.ts`）に集約し、テストファイル間で重複させない。

## 4. 制約・注意点

- **`maxRetransmits: 0` の扱い**: 判定は `!== null` で行うこと（truthy 判定にすると 0 が reliable 扱いになる）。現行コードの `!== null` 判定は維持する。
- 生成順序: `maxRetransmits` と `maxPacketLifeTime` の同時指定は `sctpManager.ts` で既に弾かれているため、優先順位の変更は不要。ただし `RTCDataChannel` を直接 `new` する経路（テスト等）では検証されない点に留意。
- 受信側ロジック・公開 API シグネチャは変更しない。`dataChannelQueue` は private のまま（下流 workaround は修正後に不要になるが、本チケットで互換レイヤーは用意しない）。
- `negotiated: true` のチャネルは DCEP OPEN を送らないため本修正の影響を受けない。
- WPT 用の厳格な挙動は `tools/wpt-runner/*` に閉じ込めるルールがあるが、本修正は RFC 準拠のバグ修正なので `src` 側で直す。
- **スコープ外（別チケット候補）**: `dataChannelFlush()` の `expiry = Date.now() + maxPacketLifeTime / 1000`（ms + 秒換算の混在）と、`packages/sctp/src/sctp.ts:1333` の `chunk.expiry < Date.now() / 1000`（秒）で単位が一致しておらず、lifetime による abandon が実質機能していない可能性がある。また `dataChannel.ts:162` のコメント `// sec` は仕様（ms）と食い違う。本チケットでは修正せず、別チケットで扱う。
- `channel.label.length` / `channel.protocol.length` が UTF-16 長で書かれている（マルチバイト label で長さ不一致の可能性）点も既存の別問題。本チケットでは触れない。

## 5. 完了条件

- [ ] `dataChannelOpen()` が RFC 8832 の 6 種類の Channel Type（`0x00/0x01/0x02/0x80/0x81/0x82`）を正しく出力し、数値リテラルではなく `const.ts` の定数を使っている。
- [ ] 6 パターンの OPEN エンコード（Channel Type と reliability）を検証するユニットテストが追加されている（`ordered:false, maxRetransmits:0` → `0x81` を含む）。
- [ ] werift 同士で、受信側チャネルの `ordered` / `maxRetransmits` / `maxPacketLifeTime` が送信側設定と一致することを検証するテストが追加されている。
- [ ] テストは Arrange / Act / Assert 構成で、Act / Assert に日本語コメントがあり、Arrange ヘルパーは共有ユーティリティに集約されている。
- [ ] `cd packages/webrtc && npm run type && npm test` が成功する。
- [ ] 可能であればブラウザ interop の e2e シナリオを追加し `npm run e2e` で確認（実施できない場合はその旨を PR に明記）。
- [ ] スコープ外の発見（maxPacketLifeTime の単位不整合、label 長の計算）を別チケットとして起票または記録している。
