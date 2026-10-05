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
3. どちらでも解決できない場合（SPS / PPS が無い、SPS 解析が失敗する、SPS 由来の寸法が正の有限整数でない等）は、**そのキーフレームを破棄して video track を初期化せず、次のキーフレームを待つ**（確定事項。理由は 3-2-1 を参照）。

#### 3-2-1. 確定事項: 寸法を解決できないキーフレームはスキップして次のキーフレームを待つ

**決定**: `stop()` で muxing を終了するのではなく、そのキーフレームを捨てて video track を未初期化のまま保ち、後続の delta も従来どおり捨て、次のキーフレームで再度解決を試みる。

**理由**:

- **既存挙動と一致する**: `processVideoInput()` はもともと「`container.videoTrack` が未初期化の間は、キーフレームが来るまで delta を捨てる」作りになっている。寸法を解決できないキーフレームを「初期化に使えないフレーム」として同じ扱いにするだけなので、状態遷移を増やさずに済む。
- **一時的な欠損から回復できる**: ライブ RTP では、パケットロスで SPS が壊れることや、最初のキーフレームに in-band の SPS / PPS が付いていないことがある。こうした問題は次のキーフレーム（PLI/FIR や定期 IDR）で解消することが多い。1 フレームの不良で録画全体を終了させるのは影響が大きすぎる。
- **終端処理を壊さない**: video track が未初期化のまま `eol` / `destroy()` が来ても、`Mp4Container.stop()` は `!tracksReady` のときバッファを破棄して return し、`MP4Base.stop()` は従来どおり `{ eol: true }` を 1 回出力する。つまり「出力が無いまま EOL だけが届く」形で、呼び出し側は必ず終了を検知できる。
- **呼び出し側に判断を委ねられる**: 終了させたい利用者は、自分で `destroy()` を呼べばよい。逆に muxer 側から勝手に終了すると、利用者は復帰できない。

**実装上の要件**:

- 寸法と avcC の解決（SPS / PPS 抽出、`parseSPS()`、寸法の検証）は、`container.write()` と `annexb2avcSample()` より**前に**行い、失敗したら何も書き込まずに `return` する。
- 解決ヘルパー（例: `parseAvcDecoderConfig(frame.data)`）は、失敗時に例外ではなく `undefined` を返す。
  - SPS / PPS が無い場合は、`!` を使わず明示的に分岐する（現在の `annexb2avcc()` は `video_metadata_.sps!` で TypeError になる）。
  - `ExpGolomb` は入力が途中で尽きると例外を投げる（`exp-golomb.ts:42`）。そのため `SPSParser.parseSPS()` の呼び出し**だけ**を狭い `try/catch` で囲み、「解決不能」に変換する。AGENTS.md が禁じているのは広範囲の catch-and-ignore であり、この catch は失敗理由を戻り値として扱う package-local なエラー処理なので許容範囲。
- スキップするたびに `debug`（`werift-rtp : packages/rtp/src/extra/processor/mp4.ts` などの namespace）でログを出す。キーフレームごとに出る量なので、通常のログレベルでは出さない。
- 新しいイベントやエラーコールバックは追加しない（公開 API を増やさない）。将来必要になったら別チケットで扱う。
- `Track.width` / `Track.height` が有効でも SPS / PPS が無ければ avcC を作れないため、同じスキップ経路に入る。明示寸法の有無にかかわらず、avcC を作れないキーフレームは初期化に使わない。

#### 3-2-2. 検討済み: WebM のような固定ダミー値（例: 640x360）を使わない理由

WebM 側（`packages/webrtc/src/nonstandard/recorder/writer/webm.ts`）は `width ?? 640` / `height ?? 360` で補っている。fMP4 でも同じことは**技術的には可能**で、無限ループも解消する。ただし、次の理由から採用しない。

- **ダミー値では、本当に困るケースを救えない**: fMP4 の init segment（`avcC`）には、寸法とは関係なく SPS / PPS のバイト列そのものが必要。さらに High 系 profile では、SPS の解析結果（`chroma_format_idc` / `bit_depth_*`、`h264.ts` の `AVCDecoderConfigurationRecord`）も必要になる。そのため、SPS / PPS が無い・壊れているキーフレームでは、ダミー寸法を入れても init segment を作れない（作っても再生できない）。結局、3-2-1 のスキップ処理は必要になる。
- **SPS があるなら実際の値をタダで得られる**: `annexb2avcc()` はすでに `SPSParser.parseSPS()` を呼んで `codec_size` / `present_size` を計算しており、今はそれを捨てているだけ。ダミー値で済ませても実装コストはほとんど減らない。
- **ダミー値は誤ったメタデータとして残る**: H.264 のデコーダは SPS から実際の解像度を取るので、映像のデコード自体はたいてい成功する。一方、`tkhd` / `avc1` sample entry の幅・高さ（表示サイズ）は 640x360 のまま記録される。既存テストでも、SPS が 1920x1080 なのに mediabunny は `Track` に指定した 640x360 を表示サイズとして読み戻している。4:3 や縦長の映像では、プレイヤーによっては引き伸ばされて表示される。また、表示サイズを使う後段処理（サムネイル生成、メタデータ表示など）も誤った値を受け取る。
- **WebM との違い**: WebM の writer は `nonstandard` recorder が `Track` を組み立てる箇所で値を補っており、MP4 のような codec 設定から寸法を取る経路を持っていない。MP4 には SPS という正確な情報源があるので、そちらを使う。

**結論**: 解決順序は「明示値 → SPS → スキップ（3-2-1）」のままとし、固定ダミー値の段は設けない。SPS が正常に解析できれば寸法も必ず得られるため、「avcC は作れるのに寸法だけ取れない」ケースは、実質的には SPS が壊れているケースに限られる。その場合も再生できない init segment を出すより、スキップするほうが安全である。

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
| `width: 0` / `NaN` / 負数など不正値 | ハングせず、SPS 由来の `1920x1080` にフォールバックして正常な fMP4 になる |
| audio + video（video 寸法未指定） | init segment と media segment が出力され、EOL が 1 回だけ届く |
| 既存の 640x360 明示ケース | 従来どおり 640x360（明示値が SPS より優先されることの回帰確認） |
| 寸法未指定で、SPS / PPS を含まないキーフレーム → delta → SPS 付きキーフレーム → delta → EOL | `inputVideo()` が throw しない。最初のキーフレームと後続 delta は捨てられ、2 枚目のキーフレームで初期化される。読み戻した fMP4 の寸法は `1920x1080`、開始時刻は 2 枚目のキーフレーム以降 |
| 寸法未指定で、SPS / PPS を含まない（または SPS が途中で切れた）キーフレームだけを投入して EOL | `inputVideo()` が throw せずハングもしない。`data` 出力は 0 件、`{ eol: true }` がちょうど 1 回届く |
| `destroy()` で終了（video 未初期化のまま） | 同上。EOL が 1 回届き、unhandled rejection も残らない |
| `computeRatio()` 単体（export した場合） | `undefined` / `0` / `NaN` / `Infinity` で即座に返る、`1920,1080 → 16,9` |

注意:

- 無限ループは同期的なので vitest のテストタイムアウトでは検出できず、**修正前はワーカーごとハングする**。修正前の red 確認をする場合は `timeout 60 npx vitest run tests/processor/mp4.test.ts` のように外側でタイムアウトを掛けること。
- Arrange の共通化: `createVideoFrames()` / `createFrame()` など複数テストで使うフィクスチャは、規約に従い `packages/rtp/tests/utils.ts` への移動を検討する（既存の `collectMp4Buffer` / `collectMp4Outputs` / `createMp4Input` と同じ場所）。寸法未指定の `Track[]` を作るヘルパーもそこに置く。

### 5. 制約・注意点

- **後方互換**: `Track` 型は変更しない（optional のまま）。明示された寸法は従来どおり最優先。`annexb2avcc()` のシグネチャ・戻り値は変えない。
- **ルート原因を直す**: `track.width ?? 640` のような固定デフォルトで握りつぶすのは避ける（詳細は 3-2-2）。`packages/webrtc/src/nonstandard/recorder/writer/webm.ts` は `?? 640` を使っているが、MP4 側には SPS という正確な情報源がある。
- **例外処理**: AGENTS.md の方針に従い、広い catch-and-ignore は追加しない。寸法解決失敗は明示的に分岐で扱う。
- **寸法の変化**: ストリーム途中で SPS の解像度が変わるケース（simulcast 切替など）は本チケットの対象外。初期化時点の SPS のみを使う。
- **SPS 解析失敗**: `annexb2avcc()` は SPS/PPS が無いと `video_metadata_.sps!` で TypeError になる。また `ExpGolomb` はデータ不足で throw する。3-2-1 のとおり、新しい解決ヘルパーでは `undefined` 返却に変換し、同期例外として漏らさない。既存 export の `annexb2avcc()` 自体の throw 挙動は互換性のため変えない。
- **スキップ中の audio バッファ**: audio + video 構成では、`Mp4Container` が `tracksReady` になるまで audio フレームを `frameBuffer` に溜め続ける。これは既存挙動（最初のキーフレームが来るまで）と同じだが、有効なキーフレームが長時間来ないとメモリが増え続ける。上限やドロップ方針は本チケットの対象外とし、必要なら別チケットで扱う。
- **ログ**: `debug` の namespace は既存の `werift-rtp : packages/rtp/src/...` 形式に合わせる。
- 影響パッケージは `packages/rtp` のみ（`packages/webrtc` は再 export 経由で恩恵を受ける）。公開挙動の変更（SPS 補完）を伴うため、`packages/webrtc` 側の nonstandard テストも通ることを確認する。

### 6. 完了条件

- [ ] `width` / `height` が未指定・部分指定・不正値でも `MP4Base.processVideoInput()` が無限ループしない。
- [ ] 寸法未指定時、最初のキーフレームの SPS から寸法が補完され、mediabunny で読み戻せる正しい fMP4（init + media segment + 単一 EOL）が出力される。
- [ ] SPS / PPS から avcC や寸法を得られないキーフレームは捨てられる。`inputVideo()` は throw せず、video track は未初期化のまま次のキーフレームで初期化される（3-2-1）。
- [ ] 有効なキーフレームが 1 枚も来ないまま `eol` / `destroy()` された場合、`data` 出力 0 件・`{ eol: true }` 1 回で終了し、unhandled rejection が残らない。
- [ ] 明示寸法が指定されている既存ケースの出力が変わらない（既存 `mp4.test.ts` が全て通る）。
- [ ] `container.ts` の `isVideoConfig()` が寸法欠落時も video config と正しく判定する。
- [ ] 上記の回帰テストが `packages/rtp/tests/processor/mp4.test.ts` に Arrange / Act / Assert + 日本語コメントで追加され、共有 Arrange は `tests/utils.ts` に置かれている。
- [ ] `Track.width` / `Track.height` の JSDoc（必要に応じて README / doc）が更新されている。
- [ ] 検証コマンドが通る:
  - `cd packages/rtp && npm run type && npm test`
  - 公開挙動変更のため `npm run type` と `npm run test:small`（ルート）
