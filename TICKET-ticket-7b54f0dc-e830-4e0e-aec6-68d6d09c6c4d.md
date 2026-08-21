# RTP 受信側で probe padding を正しく扱い、0 ペイロードのデシリアライズ漏れと受信イベントのパケット種別を直す

## 1. タスクの目的と背景

### 目的

親チケット（TWCC BWE 抽象化 + GCC、`c724daf9-5f79-4e30-bd50-7b27c8951844`）で **送信側** は `RTCRtpSender.maybeInjectProbePadding` / `maybeInjectLossPadding` により RFC 3550 の **padding-only RTP**（P ビット、末尾 length octet、TWCC 拡張、メディアとは別の RTP sequence）を送れるようになった。

一方 **受信側** は、復号・`RtpPacket.deSerialize` のあと payload が空になったパケットを通常メディアとして扱っており、次が起きる。

- コーデック / RED デシリアライザが **0 バイト payload** を前提にしておらず、例外またはゴミ解釈になる
- `onReceiveRtp` が空 payload をメディアとして配信し、jitter buffer / depacketizer / recorder / example がフレームを壊す
- アプリが probe / RTX / 通常メディアを区別できない

本タスクは **プロトコル層の 0 ペイロード耐性** と **webrtc 受信パイプラインの分類**、および **外部イベントへのパケット種別** を直す follow-up である。GCC 推定アルゴリズムの再設計は対象外。

### 背景（送信側が実際に送っているもの）

`maybeInjectProbePadding` は次の RTP を作る。

| 項目 | 値 |
| --- | --- |
| payload（構築時） | `Buffer.alloc(0)` |
| `header.padding` | `true` |
| `header.paddingSize` | `kProbePaddingPacketBytes`（**224**） |
| `header.payloadType` / `ssrc` / `timestamp` | 当該 sender の **メディア codec / SSRC / 直近 timestamp** |
| RTP sequence | `allocatePaddingSequence()`（メディアと **同一 16-bit 空間**、衝突回避済み） |
| ヘッダ拡張 | 通常送信と同じ（TWCC を含む） |
| RED | probe padding では **付けない**（`!opts.isProbePadding`） |
| 送信直前 | `appendRfc3550Padding` で 224 バイトを payload 領域に載せ、SRTP がその領域を暗号化 |

受信側では SRTP 復号後に `RtpPacket.deSerialize` が padding を剥がすため、**in-memory の `payload.length === 0`** になる（既存テスト `SRTP encrypt/decrypt を通した probe padding が復元できる` がこの契約を固定している）。

RFC 3550 §5.1: P=1 のとき最終オクテットは padding 長（自身を含む）。padding-only はメディアオクテットが 0。RTCP の packet count には含め、octet count からは padding を除外する。

TWCC / GCC の受信側は dumb receiver のまま、**padding-only も transport-wide seq 付きで feedback に載せる**必要がある。種別分類で TWCC から除外してはならない。

### 現状コードベースの整理

| 領域 | パス | 現状 |
| --- | --- | --- |
| RTP deSerialize | `packages/rtp/src/rtp/rtp.ts` | padding は末尾 1 バイトを `paddingSize` にし `subarray` で剥がす。**範囲検証なし**。`serializeSize` は padding を含まない |
| SRTP padding | `packages/rtp/src/srtp/packet.ts` `finalizeSrtpRtpHeader` | 認証後に padding 長を検証。その後 DTLS が **もう一度** `RtpPacket.deSerialize` する |
| 受信エントリ | `packages/webrtc/src/transport/dtls.ts` | decrypt → `RtpPacket.deSerialize` → `onRtp` |
| ルーティング | `packages/webrtc/src/media/router.ts` | 拡張をパースし `handleRtpBySsrc` / `ByRid` |
| 受信処理 | `packages/webrtc/src/media/rtpReceiver.ts` `handleRTP` | 統計・TWCC・RTX・RED・NACK・`onReceiveRtp` を **無分類** で実行 |
| 外部イベント | `packages/webrtc/src/media/track.ts` | `onReceiveRtp = Event<[RtpPacket, Extensions?]>`。購読で `muted=false` |
| 統計 | `packages/webrtc/src/media/receiver/statistics.ts` | `bytesReceived += payload.length`（剥がし後なら octet は正しい）。パケット数は padding も加算 |
| コーデック | `packages/rtp/src/codec/{vp8,vp9,h264,av1}.ts` | 先頭バイトを `getBit`。**空 Buffer で TypeError** |
| RED | `packages/rtp/src/rtp/red/packet.ts` | 空 payload でも例外にならず **PT=0 の偽ブロック** になり得る |
| デパケ | `packages/rtp/src/extra/processor/depacketizer.ts` | 例外時に `clearBuffer()` → **probe がキーフレーム組み立てを壊す** |
| recorder | `packages/webrtc/src/nonstandard/recorder/writer/webm.ts` | `onReceiveRtp` を無条件で jitter/depacketizer へ |
| 送信（参考・変更しない） | `packages/webrtc/src/media/rtpSender.ts` | 注入・SR octet 非算入・sequence 衝突防止は親チケット済み |

受信単体テスト `packages/webrtc/tests/media/rtpReceiver.test.ts` に **padding-only / probe** ケースは無い。RTP パケットテストには `test_padding_only_with_header_extensions`（payload 0 の **正常系 roundtrip**）のみ。

---

## 2. 実装すべき具体的な機能・変更内容

### 2.1 受信パイプラインでの padding-only 分類（本丸）

padding-only の判定（**deSerialize 後**の正規形）:

```ts
packet.header.padding === true && packet.payload.length === 0
```

送信直前（padding バイトがまだ `payload` に載っている）ではこの判定は使わない。ヘルパーは rtp パッケージに置き、JSDoc で「受信後 / 正規形専用」と書く。

`RTCRtpReceiver.handleRTP` の処理順（決定済み）:

| 段階 | padding-only | 通常メディア | RTX（unwrap 前） |
| --- | --- | --- | --- |
| 未知 PT で drop | 同じ | 同じ | 同じ |
| `StreamStatistics.add` | **含める** | 含める | 含める（RTX SSRC） |
| TWCC `handleTWCC` | **含める** | 含める | 含める |
| RTX unwrap | **しない**（空 payload で `readUInt16BE` しない） | — | 既存どおり `length < 2` なら return |
| RED parse | **しない** | RED なら既存 | — |
| NACK `addPacket` | **含める**（同一 sequence 空間のため。欠落するとメディア欠落と誤認する） | 含める | unwrap 後の media seq |
| `onReceiveRtp` | **発火**（`type: "padding"`） | `type: "media"` | unwrap 後は `type: "retransmission"` |
| `muted = false` | **しない**（メディア未到着の probe だけで unmute しない） | する | する |

RED の音声復元パケットは従来どおり複数回 `onReceiveRtp` し、`type: "media"`（必要なら `recoveredFromRed: true` を任意で付けてよい。必須ではない）。

### 2.2 外部向けイベントにパケット種別を追加

**採用（決定済み）: 既存タプルを壊さず第 3 引数を追加する。**

```ts
export const RtpReceivePacketType = {
  media: "media",
  padding: "padding",
  retransmission: "retransmission",
} as const;
export type RtpReceivePacketType =
  (typeof RtpReceivePacketType)[keyof typeof RtpReceivePacketType];

export type RtpReceiveInfo = {
  type: RtpReceivePacketType;
};

// MediaStreamTrack
readonly onReceiveRtp = new Event<
  [RtpPacket, Extensions?, RtpReceiveInfo?]
>();
```

| 項目 | 方針 |
| --- | --- |
| 第 1・2 引数 | 維持（既存 `subscribe((rtp) => …)` / `(rtp, extensions) => …` はコンパイル可能） |
| 第 3 引数 | receiver / `writeRtp` から **常に渡す**。型は `?` で購読側互換 |
| 非採用 | `Extensions` への混入、`RtpPacket` 本体への webrtc 意味論フィールド、オブジェクト 1 本化（破壊的） |
| 種別の意味 | **配信時点の意味**。RTX は unwrap 後のパケットを渡し `retransmission`。padding-only は空 payload のまま `padding` |
| 公開 | `packages/webrtc` から export（型は `track.ts` または隣接。rtp の判定ヘルパーは `packages/rtp`） |

`MediaStreamTrack` 内部購読:

- `header` 更新: 全種別で可（sequence 追跡）
- `muted = false`: **`type === "media" | "retransmission"` のときだけ**

転送漏れ（種別を落とさない）:

- `navigator.ts` の clone: 第 2・3 引数を転送
- `writeRtp`: 明示指定が無ければ `{ type: "media" }`
- recorder / extra processor: `type === "padding"` をデパケ前に捨てる（jitter には **通す**。sequence 連続性のため）

relay（`RTCRtpSender.registerTrack` → `sendRtp`）: 第 3 引数を見ず全パケットを再送すると、受信した probe をメディアとして再パケット化 + 再プローブし得る。**padding は転送しない**（SFU は hop ごとに自分の BWE で probe する）。決定済み。

### 2.3 RTP デシリアライザ: payload サイズ 0 / 不正 padding の漏れ一覧と修正

調査時点の漏れ。実装時にすべて潰す。テストで「修正前に落ちる」形を優先。

#### A. プロトコル本体（必須）

| # | 箇所 | 空 / 不正時の挙動 | 修正 |
| --- | --- | --- | --- |
| A1 | `RtpHeader.deSerialize` | 12 バイト未満で `rawPacket[0]` が `undefined` → `getBit` が TypeError | 最小長チェック。不足は throw（DTLS 側は既存の malformed catch で drop） |
| A2 | `RtpHeader.deSerialize` padding | `paddingSize = rawPacket[last]` のみ。0 や残バイト超過を許す | RFC 3550: padding 長は **1 以上かつ `packet.length - payloadOffset` 以下**。不正は throw |
| A3 | `RtpPacket.deSerialize` | `subarray(payloadOffset, length - paddingSize)`。不正長だと空や逆転 | A2 後に media 領域を切る。padding-only は **空 Buffer**（既存契約） |
| A4 | `RtpPacket.serializeSize` / `serialize` 確保サイズ | padding を含めない | 正規形（payload=メディアのみ、`paddingSize` にパッド長）では **padding 分を含める**。二重付与しない（payload に既にパッドを載せた送信直前表現とは混同しない） |

SRTP の `finalizeSrtpRtpHeader` は認証後検証として維持。`RtpPacket.deSerialize` 単体（`writeRtp`、テスト、非 SRTP）でも同じ不正 padding を拒否する。

#### B. コーデック / RED / RTX（必須・防御）

受信側で padding-only をコーデックに渡さないのが主防御。それでも **空や短すぎるメディア payload**（壊れたパケット、バグ）で TypeError にしない。

| # | 箇所 | 空時 | 修正 |
| --- | --- | --- | --- |
| B1 | `Vp8RtpPayload.deSerialize` | `getBit(buf[0])` TypeError | 最小ヘッダ長不足は throw（専用 Error / 既存に合わせた Error）。`getBit(undefined)` 禁止 |
| B2 | `Vp9RtpPayload.parseRtpPayload` | 同上 | 同上 |
| B3 | `H264RtpPayload.deSerialize` | `buf[0]` および FU の `buf[1]` | タイプに応じた最小長。不足は throw |
| B4 | `AV1RtpPayload.deSerialize` | aggregation header 1 バイト未満 | 不足は throw |
| B5 | `OpusRtpPayload.deSerialize` | 空をそのまま返す（破綻しない） | **変更不要**。空 Opus は DTX と紛らわしいが probe は padding 判定で除外 |
| B6 | `Red.deSerialize` / `RedHeader.deSerialize` | 空でも PT=0 フィールドが 1 つできる | バッファ不足は throw。receiver は padding-only で RED に入らない |
| B7 | `unwrapRtx` | `payload.readUInt16BE(0)` が `<2` で RangeError | 関数側でも `<2` を拒否。receiver の既存ガードは残す |

#### C. ヘッダ拡張（推奨・短 payload）

probe 自体は TWCC 2 バイトを載せる。壊れ拡張で router 全体が落ちないようにする。

| # | 箇所 | 短すぎる payload | 修正 |
| --- | --- | --- | --- |
| C1 | `deserializeUint16BE`（TWCC） | `readUInt16BE()` RangeError | 2 バイト未満はその拡張を無視（router 全体は継続） |
| C2 | `deserializeAbsSendTime` | 3 バイト未満 | 無視 |
| C3 | `deserializeAudioLevelIndication` / `deserializeVideoOrientation` | 1 バイト未満 | 無視 |
| C4 | One-byte 拡張の **serialize** | `payload.length === 0` で `(len - 1)` が 255 | 0 長は RFC 8285 one-byte 不可。serialize 時 throw または two-byte へ。受信 parse は既存スキップで可 |

C は router の `rtpHeaderExtensionsParser` で try/skip してもよい。TWCC 欠落時は既存どおり `handleTWCC` を呼ばない。

#### D. 対応不要（確認済み）

- `test_padding_only_with_header_extensions`: 正常系 roundtripは既にある。不正 padding / 最小長の欠測を足す
- SRTP CTR/GCM: 空 payload + padding の encrypt/decrypt は親チケットでカバー。**壊さない**
- `StreamStatistics.bytesReceived`: 剥がし後 0 は RFC の octet に合う
- `isMedia()`（`packages/rtp/src/helper.ts`）: RTP/RTCP 判別であり padding 分類ではない。流用しない

### 2.4 extra processor / recorder / example

padding-only を **デパケしない**。jitter buffer には通し、depacketizer の先頭で drop。

| 対象 | 対応 |
| --- | --- |
| `DepacketizeBase.processInput` | padding-only は出力せず return（例外も `clearBuffer` もしない） |
| `JitterBufferBase` | 変更しない（seq 連続） |
| `WebmFactory` | `type === "padding"` なら `rtpSource.input` しない **または** depacketizer 側 drop に任せる。両方でも可。少なくとも一方は必須 |
| examples（`save_to_disk/*`, `mediachannel/codec/*`, `rtp_forward` 等） | デパケしている購読は `type === "padding"` をスキップ。JSDoc か短いコメントで「GCC probe は padding-only」と書く。全 example の機械的書き換えは不要。**デパケ / ファイル書き込みするものは必須** |

### 2.5 テスト

規約: Arrange / Act / Assert、共有 Arrange は utility、Act/Assert に日本語コメント。失敗の握りつぶし禁止。

**packages/rtp**

1. padding-only（拡張なし / あり）: deSerialize 後 `payload.length === 0`、`paddingSize` 一致、serialize 正規形 roundtrip
2. 不正 padding（size=0、size > remaining、ヘッダ未満）: throw、`getBit(undefined)` にしない
3. VP8/VP9/H264/AV1/RED/RTX: 空または不足長で TypeError ではなく明示的失敗
4. （任意）one-byte 拡張 0 長 serialize の拒否

**packages/webrtc**

1. padding-only が TWCC に載る（extension 付き）
2. `onReceiveRtp` 第 3 引数が `{ type: "padding" }`。payload 空
3. 通常パケットは `{ type: "media" }`
4. RTX unwrap 後は `{ type: "retransmission" }` と復元 payload
5. 統計: `packetsReceived` は増え、`bytesReceived` は padding で増えない
6. NACK: padding seq を挟んでもメディア欠落としない（到着済みとして進む）
7. RED ネゴシエーション下の padding-only で `Red.deSerialize` しない / 例外なし
8. `muted`: padding だけでは `false` にならない。メディア到着後に `false`
9. sender が作った probe を receiver に流す結合（`appendRfc3550Padding` + deSerialize + handleRTP）

**packages/rtp extra（depacketizer）**

- フレーム組み立て中の padding-only で buffer を discard しない

### 2.6 ドキュメント

- `MediaStreamTrack.onReceiveRtp` の JSDoc: 第 3 引数、種別、padding はデコードしない、TWCC 用に受信はしている
- 公開 API 追加のため `packages/webrtc` の typedoc 対象になること
- README に長いカタログは足さない。既存 TWCC/GCC 節があれば「受信側は probe padding を `type: "padding"` で通知」を 1 文
- `AGENTS.md` は scripts 不変なら更新不要

### 2.7 その他検討して対応するもの / しないもの

**対応する**

- 上記 A–C、受信分類、イベント、depacketizer、unmute、relay での padding 非転送、navigator 転送
- DTLS の malformed RTP catch が新しい throw を drop できることの確認（新規 catch の握りつぶしはしない）

**対応しない（非ゴール）**

- GCC / ProbeController / `maybeInjectProbePadding` の再設計
- padding を RTP sequence から外す（送信側の確定仕様）
- FEC / ULPFEC / FlexFEC を第 4 種別にする（未実装）
- DTX / comfort noise を `RtpReceivePacketType` に入れる（payload 空の Opus とは別。padding ビットで切る）
- REMB 統合、default BWE を GCC にする
- `onReceiveRtp` をオブジェクトイベントに作り替える破壊的変更
- sim の CI 必須化

---

## 3. 技術的な実装アプローチ（調査結果の要約）

### 3.1 データフロー（問題の発生点）

```
Sender maybeInjectProbePadding
  → RtpPacket(padding=true, payload=[]) + appendRfc3550Padding(224)
  → SRTP encrypt (padding 領域も暗号)
  → Receiver SRTP decrypt
  → RtpPacket.deSerialize  → payload=[] , paddingSize=224
  → router.routeRtp（TWCC 拡張は読める）
  → handleRTP
       ├ statistics / TWCC     ← 必要（現状どおりでよい）
       ├ Red.deSerialize([])   ← 不必要・危険
       ├ nack.addPacket        ← 必要（seq）
       └ onReceiveRtp(empty)   ← 種別なし。下流が VP8.deSerialize([]) で TypeError
            → DepacketizeBase catch → clearBuffer() で映像フレーム破壊
```

### 3.2 正規形と送信直前表現を混ぜない

| 表現 | payload | padding フラグ |
| --- | --- | --- |
| 正規形（deSerialize 後、イベント） | メディアのみ（probe なら空） | `padding` + `paddingSize` |
| 送信直前（`dtls.sendRtp(payload, header)`） | メディア + RFC padding バイト | 同じフラグ（SRTP がこの領域を暗号化） |

`new RtpPacket(header, payloadAlreadyPadded).serialize()` は **padding を二重付加**し得る。既存 BWE テストは wire 再パースで payload 長を見ていない。本タスクで serialize を直すなら、正規形だけを対象にし、送信経路の `appendRfc3550Padding` は維持する。

### 3.3 `getBit(undefined)` が落ちる理由

`packages/common/src/binary.ts` の `getBit` は `bits.toString(2)`。空 Buffer の `buf[0]` は `undefined` で TypeError。コーデックは先頭 1 バイト必須なので、空入力は parse 前に弾く。

### 3.4 配置

```
packages/rtp/src/rtp/rtp.ts          # deSerialize 検証、serializeSize、isPaddingOnlyRtpPacket
packages/rtp/src/codec/*             # 最小長
packages/rtp/src/rtp/red/packet.ts
packages/rtp/src/rtp/rtx.ts
packages/rtp/src/rtp/headerExtension.ts
packages/rtp/src/extra/processor/depacketizer.ts
packages/webrtc/src/media/track.ts   # RtpReceiveInfo / Event 型 / muted
packages/webrtc/src/media/rtpReceiver.ts
packages/webrtc/src/nonstandard/navigator.ts
packages/webrtc/src/media/rtpSender.ts  # registerTrack で padding を送らない
```

アルゴリズム層（`estimators/gcc/**`）は触らない。触るのは RTP の意味論と受信配線。

### 3.5 後方互換

- 第 3 引数追加は JS では非破壊。TS で 2 引数まで使う購読は維持
- padding をデパケしているアプリは、種別を見ないと **GCC 有効時に既に壊れている**。種別と skip が修復
- default BWE は legacy のまま（親契約）。legacy でも loss padding 注入経路があるため、受信修正は GCC 限定にしない

---

## 4. 考慮すべき制約・注意点

1. **TWCC から padding を外さない。** probe の ACK が消え BWE が壊れる。
2. **NACK の sequence 空間から padding を外さない。** 欠番がメディアロスに見える。
3. **octet と packet を混同しない。** 統計の bytes は剥がし後 payload。packets は padding 含む。
4. **正規形と wire payload を混同しない。** 受信イベントの payload は空が正しい。
5. **プロトコルとアルゴリズムを混同しない。** ReceiverTWCC を GCC 専用にしない。
6. **破壊的 API を増やさない。** `onReceiveRtp` の先頭引数は `RtpPacket` のまま。
7. **WPT shim を default API に漏らさない。**
8. **pure TypeScript。** ネイティブ追加なし。
9. **テスト規約。** Arrange 共有、Act/Assert の日本語コメント。
10. **Windows 非対応** を増やさない。
11. **親チケット契約。** default estimator、`onAvailableBitrate`、setter は変更しない。

---

## 5. 完了条件

### 機能

- [ ] padding-only（`maybeInjectProbePadding` 相当）を受信してもコーデック / RED 例外で落ちない
- [ ] TWCC / パケット統計 / NACK の sequence 追跡に padding-only が残る。octet 統計に padding を足さない
- [ ] `onReceiveRtp` が `RtpReceiveInfo.type`（`media` / `padding` / `retransmission`）を第 3 引数で渡す
- [ ] padding だけでは `MediaStreamTrack.muted` が unmute されない
- [ ] jitter/depacketizer 経路で probe がフレーム組み立てを discard しない
- [ ] §2.3 の A・B 漏れを修正。C は短拡張で router が落ちない
- [ ] 正規形の `RtpPacket.deSerialize` が不正 padding / 短パケットで不明な TypeError にならない
- [ ] relay（`registerTrack`）が受信 padding をメディアとして再送しない
- [ ] 種別の JSDoc（必要なら example 1 箇所）がある

### 品質

- [ ] §2.5 の rtp / webrtc / depacketizer テスト（Arrange / Act / Assert + 日本語コメント）
- [ ] `cd packages/rtp && npm test`（少なくとも packet / codec / red / rtx）
- [ ] `cd packages/webrtc && npx vitest run tests/media/rtpReceiver.test.ts` および触った近傍
- [ ] `cd packages/rtp && npm run type` と `cd packages/webrtc && npm run type`
- [ ] 変更が extra/example に及ぶ場合はそのテストまたは型
- [ ] 横断時はルート `npm run type` / `npm run test:small`

### 非ゴール（再掲）

- GCC アルゴリズム・probe 注入ロジックの変更
- 第 3 BWE、REMB 必須化、sim の CI 化
- `onReceiveRtp` のオブジェクト化などの破壊的作り替え

---

## 決定事項（詳細化で確定）

| 項目 | 決定 |
| --- | --- |
| padding-only 判定 | deSerialize 後: `padding && payload.length === 0` |
| TWCC / NACK seq / packet count | padding を **含める** |
| octet / bytesReceived | padding を **含めない**（剥がし後 payload） |
| `onReceiveRtp` | 既存 2 引数維持 + 第 3 引数 `RtpReceiveInfo`。padding も発火 |
| 種別 | `media` / `padding` / `retransmission` の 3 値。RED 復元は `media` |
| unmute | media と retransmission のみ |
| デパケ | padding をスキップ。jitter は通す |
| relay | 受信 padding は `sendRtp` しない |
| デシリアライザ | §2.3 A+B 必須、C は router 非クラッシュ |
| GCC コード | 本チケットでは変更しない |

---

## 参考リンク・主要ファイル

| 種別 | 参照 |
| --- | --- |
| RFC 3550 padding | https://datatracker.ietf.org/doc/html/rfc3550#section-5.1 |
| TWCC | https://datatracker.ietf.org/doc/html/draft-holmer-rmcat-transport-wide-cc-extensions-01 |
| 親チケット | TWCC BWE 抽象化 + GCC（`c724daf9-5f79-4e30-bd50-7b27c8951844`） |
| 送信注入 | `packages/webrtc/src/media/rtpSender.ts` `maybeInjectProbePadding` |
| 受信 | `packages/webrtc/src/media/rtpReceiver.ts` |
| イベント | `packages/webrtc/src/media/track.ts` |
| deSerialize | `packages/rtp/src/rtp/rtp.ts` |
| SRTP padding | `packages/rtp/src/srtp/packet.ts` |
| 定数 | `kProbePaddingPacketBytes`（224） |

### 推奨作業順

1. `RtpPacket` / `RtpHeader` の検証と padding-only ヘルパー + rtp 単体テスト
2. コーデック / RED / RTX の最小長
3. `RtpReceiveInfo` と `handleRTP` 分岐、muted、RTX 種別
4. depacketizer・recorder・registerTrack・navigator
5. ヘッダ拡張の短 payload
6. JSDoc と webrtc テスト、type / 対象 vitest
