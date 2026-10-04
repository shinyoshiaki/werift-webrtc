# Fix fMP4 muxer infinite loop when video track dimensions are undefined

## Summary

The fMP4 muxer can enter an infinite loop when a video track does not provide `width` and/or `height` metadata.

## Reproduction

A downstream user (`sergio-pulido/reverie`) reproduced this while muxing H.264 RTP into fMP4 using werift 0.24.4.

The failure happens when processing the first complete H.264 keyframe:

```
computeRatio(track.width!, track.height!)
  -> gcd(width, height)
```

`Track.width` and `Track.height` are optional, so values can be `undefined` at runtime.

With both values undefined:

```
gcd(undefined, undefined)
```

causes:

```ts
while (y !== 0) {
  ...
}
```

to never terminate because `undefined % undefined` becomes `NaN` and `NaN !== 0` is always true.

## Impact

- fMP4 muxing never completes
- no init segment/media segment is produced
- recording pipelines can hang indefinitely
- Node.js event loop can be blocked

## Expected behavior

Invalid or missing video dimensions should not cause an infinite loop. Possible approaches:

- return a safe default ratio when dimensions are unavailable
- skip aspect-ratio calculation
- validate dimensions before calling gcd

## Additional notes

The public type already allows optional dimensions:

```ts
width?: number;
height?: number;
```

Therefore the runtime path should handle missing values safely.

A regression test should cover:

- H.264 keyframe processing
- fMP4 muxing with undefined width/height
- ensuring muxing fails gracefully or continues without hanging

Related downstream reproduction:
- https://github.com/sergio-pulido/reverie/pull/22

---

## 詳細化

### 1. 目的と背景

- `packages/rtp` の `MP4Base`（公開 API としては `MP4Callback`、`werift` からは `nonstandard` 経由で再 export）は、`Track.width` / `Track.height` を optional として公開しているにもかかわらず、最初の H.264 キーフレーム処理時に `track.width!` / `track.height!` と非 null 断言して `computeRatio()` に渡している。
- `computeRatio()` 内の `gcd()` は `while (y !== 0)` で終了判定しており、`undefined` / `NaN` / 非整数 / `Infinity` が入ると `y` が `NaN` になり **同期的な無限ループ** に陥る。イベントループごと停止するため、タイマーやタイムアウトでも回復できない。
- 目的は「寸法が欠落・不正でもハングしない」ことを保証し、さらに可能な限り **SPS から寸法を補完して正常な fMP4 を出力する** こと。

### 2. 調査結果（現状のコード）

| 箇所 | 内容 |
| --- | --- |
| `packages/rtp/src/extra/processor/mp4.ts:93-123` | `processVideoInput()`。`container.videoTrack` 未設定かつキーフレームのとき `annexb2avcc()` → `computeRatio(track.width!, track.height!)` → `container.write({ codedWidth: track.width, codedHeight: track.height, displayAspect* ... })` |
| `packages/rtp/src/extra/processor/mp4.ts:200-212` | `computeRatio()` / 内部 `gcd()`。入力検証なし。`gcd(0, 0)` は `0` を返し `0/0 = NaN` になる問題もある |
| `packages/rtp/src/extra/processor/mp4.ts:214-221` | `export interface Track { width?: number; height?: number; ... }` |
| `packages/rtp/src/extra/container/mp4/h264.ts:184-226` | `annexb2avcc()`。内部で `SPSParser.parseSPS()` を呼び `details.codec_size` / `details.present_size` / `details.sar_ratio` を得ているが、**戻り値は avcC バイト列のみで寸法は捨てている** |
| `packages/rtp/src/extra/container/mp4/sps-parser.ts:221-270` | SPS から crop 適用済みの `codec_size`、SAR 適用済みの `present_size` を算出済み |
| `packages/rtp/src/extra/container/mp4/container.ts:142-144` | video config の `codedWidth` / `codedHeight` が `undefined` なら `"missing coded video dimensions"` を throw する想定 |
| `packages/rtp/src/extra/container/mp4/container.ts:448-450` | `isVideoConfig()` が `codedWidth !== undefined` で判定しているため、寸法欠落の video config は audio config と誤判定され、実際には `"video track requires a video decoder config"` という分かりにくいエラーになる（上の guard に到達しない） |

補足:

- gcd を修正しただけでは、`codedWidth: undefined` のまま `container.write()` に渡り、`processVideoInput()` から **同期例外** が呼び出し側（RTP パイプラインのコールバック等）へ漏れる。ハングは解消するが「graceful」ではない。
- 既存テスト `packages/rtp/tests/processor/mp4.test.ts` の `createVideoFrames()` に含まれる SPS（`6742001e...`）を `SPSParser.parseSPS()` で解析すると `codec_size = present_size = 1920x1080`、`sar = 1:1` になる（テストでは `Track` に 640x360 を明示しているため、それが優先されている）。SPS 補完のテストではこの値を期待値として使える。
- リポジトリ内の利用箇所（`examples/save_to_disk/mp4/{h264,av}.ts`、`packages/webrtc/tests/nonstandard/userMediaTestUtils.ts`）はすべて `width: 640, height: 360` を明示しているため、寸法未指定経路はテストされていない。

### 3. 実装すべき変更内容

#### 3-1. `computeRatio()` の堅牢化（無限ループの根本除去）

- `computeRatio()` の入力を検証し、どちらかが「正の有限整数」でない場合はループに入らない。
  - 推奨: 不正値なら `undefined`（または `[undefined, undefined]`）を返し、呼び出し側で `displayAspectWidth` / `displayAspectHeight` を省略する。`container.ts` 側の `displayAspect*` は既に optional。
- `gcd()` は `Math.abs` / `Number.isInteger` 前提で書き、`0` や負数でも有限回で停止することを保証する。
- テスト容易性のため、`computeRatio()` を（`@internal` 扱いで）export するか、寸法解決ロジックを小さなヘルパーに切り出すことを検討する。

#### 3-2. 寸法の解決順序を定義する（SPS フォールバック）

キーフレームで video track を初期化する際、寸法を次の順で解決する:

1. `Track.width` / `Track.height` が両方とも正の有限整数ならそれを使用（**既存挙動を維持**）。
2. そうでなければ、キーフレーム内 SPS から得た寸法を使用。
   - `annexb2avcc()` が avcC に加えて SPS の `details`（少なくとも `codec_size` と `present_size`）を返せるようにする。既存 export の互換性を保つため、新関数（例: `annexb2avccWithDetails()` / `parseAvcDecoderConfig()`）を追加し、`annexb2avcc()` はそれをラップする形が安全。
   - `codedWidth/Height` には `codec_size`、表示アスペクトには `present_size`（SAR 考慮）を使うのが WebCodecs の意味論に合う。
3. どちらでも解決できない場合（SPS が無い/壊れている等）は、**ハングも同期例外の漏出もさせない**。
   - 推奨: そのキーフレームでは video track を初期化せず、次のキーフレームを待つ（`debug` ログを出す）。既存の「キーフレームが来るまで delta をドロップする」挙動と整合する。
   - 代替: `container.write()` に到達する前にエラーとして扱い、`stop()` 経路で EOL を出して終了する。どちらを採るかは実装時に決め、テストで固定する。

#### 3-3. `container.ts` の判定修正

- `isVideoConfig()` を `codedWidth` の有無ではなく `track === "video"` や audio 固有フィールド（`numberOfChannels` / `sampleRate`）の有無で判定するよう修正し、寸法欠落時に正しく `"missing coded video dimensions"` へ到達するようにする（防御的ガードとして残す）。

#### 3-4. ドキュメント

- `Track.width` / `Track.height` に JSDoc を追加し、「省略時は最初のキーフレームの SPS から補完される」ことを明記する。
- 必要に応じて `packages/rtp/README.md` / `npm run doc` で生成される doc を更新する。

### 4. テスト方針

`packages/rtp/tests/processor/mp4.test.ts` に回帰テストを追加する。AGENTS.md の規約に従い Arrange / Act / Assert を分け、Act / Assert には日本語コメントを付ける。

| ケース | 期待 |
| --- | --- |
| video-only、`width` / `height` 未指定、SPS 付きキーフレーム + delta 2 枚 + EOL | ハングせず完了。mediabunny で読み戻すと `getDisplayWidth()/Height()` が SPS 由来の `1920x1080`、codec が `avc1.42001e` |
| `width` のみ指定（`height` 未指定） | 同上（部分指定は無効扱いで SPS にフォールバック）※仕様として決めた挙動をテストで固定 |
| `width: 0` / `NaN` / 負数など不正値 | ハングしない（SPS フォールバックまたは graceful な終了） |
| audio + video（video 寸法未指定） | init segment と media segment が出力され、EOL が 1 回だけ届く |
| 既存の 640x360 明示ケース | 従来どおり 640x360（明示値が SPS より優先されることの回帰確認） |
| SPS を含まないキーフレームのみ | 例外が呼び出し側へ漏れず、ハングしない（3-2 の 3 で決めた挙動） |
| `computeRatio()` 単体（export した場合） | `undefined` / `0` / `NaN` / `Infinity` で即座に返る、`1920,1080 → 16,9` |

注意:

- 無限ループは同期的なので vitest のテストタイムアウトでは検出できず、**修正前はワーカーごとハングする**。修正前の red 確認をする場合は `timeout 60 npx vitest run tests/processor/mp4.test.ts` のように外側でタイムアウトを掛けること。
- Arrange の共通化: `createVideoFrames()` / `createFrame()` など複数テストで使うフィクスチャは、規約に従い `packages/rtp/tests/utils.ts` への移動を検討する（既存の `collectMp4Buffer` / `collectMp4Outputs` / `createMp4Input` と同じ場所）。寸法未指定の `Track[]` を作るヘルパーもそこに置く。

### 5. 制約・注意点

- **後方互換**: `Track` 型は変更しない（optional のまま）。明示された寸法は従来どおり最優先。`annexb2avcc()` のシグネチャ・戻り値は変えない。
- **ルート原因を直す**: `track.width ?? 640` のような固定デフォルトで握りつぶすのは避ける（実映像とアスペクトが食い違う MP4 を生成するため）。`packages/webrtc/src/nonstandard/recorder/writer/webm.ts` は `?? 640` を使っているが、MP4 側は SPS という正確な情報源がある。
- **例外処理**: AGENTS.md の方針に従い、広い catch-and-ignore は追加しない。寸法解決失敗は明示的に分岐で扱う。
- **寸法の変化**: ストリーム途中で SPS の解像度が変わるケース（simulcast 切替など）は本チケットの対象外。初期化時点の SPS のみを使う。
- **SPS 解析失敗**: `annexb2avcc()` は SPS/PPS が無いと `video_metadata_.sps!` で TypeError になる既存問題がある。3-2 の 3 の扱いを決める際にこの経路も同期例外として漏れないようにする。
- 影響パッケージは `packages/rtp` のみ（`packages/webrtc` は再 export 経由で恩恵を受ける）。公開挙動の変更（SPS 補完）を伴うため、`packages/webrtc` 側の nonstandard テストも通ることを確認する。

### 6. 完了条件

- [ ] `width` / `height` が未指定・部分指定・不正値でも `MP4Base.processVideoInput()` が無限ループしない。
- [ ] 寸法未指定時、最初のキーフレームの SPS から寸法が補完され、mediabunny で読み戻せる正しい fMP4（init + media segment + 単一 EOL）が出力される。
- [ ] SPS からも寸法を得られない場合、ハングも呼び出し側への同期例外漏出も起きない（採用した挙動がテストで固定されている）。
- [ ] 明示寸法が指定されている既存ケースの出力が変わらない（既存 `mp4.test.ts` が全て通る）。
- [ ] `container.ts` の `isVideoConfig()` が寸法欠落時も video config と正しく判定する。
- [ ] 上記の回帰テストが `packages/rtp/tests/processor/mp4.test.ts` に Arrange / Act / Assert + 日本語コメントで追加され、共有 Arrange は `tests/utils.ts` に置かれている。
- [ ] `Track.width` / `Track.height` の JSDoc（必要に応じて README / doc）が更新されている。
- [ ] 検証コマンドが通る:
  - `cd packages/rtp && npm run type && npm test`
  - 公開挙動変更のため `npm run type` と `npm run test:small`（ルート）
