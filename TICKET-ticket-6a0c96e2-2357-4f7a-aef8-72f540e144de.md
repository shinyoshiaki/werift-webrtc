# [WEBRTC] MediaRecorder should support OGG

## 1. 目的と背景

- `packages/webrtc` の非標準 `MediaRecorder`（`packages/webrtc/src/nonstandard/recorder/index.ts`）は現在 **WebM のみ**対応している。
  - `path` の拡張子が `webm` 以外だと `throw new Error()`（メッセージなし）で失敗する。
  - `path` 未指定（`stream` のみ）の場合は無条件に `WebmFactory` が使われる。
- 音声のみ（Opus）の録音用途では、WebM より軽量で汎用的な **Ogg Opus（RFC 7845, `.ogg` / `.opus`）** が求められる。ブラウザの `MediaRecorder` も `audio/ogg; codecs=opus` を扱える（Firefox 等）ため、API 上の自然な拡張でもある。
- `packages/rtp/src/extra/container/ogg/parser.ts` に **OggParser（読み取り専用）** は既にあるが、**Ogg を書き出すライタ／プロセッサは存在しない**。

## 2. 実装すべき機能・変更内容

### 2.1 `packages/rtp`（コンテナ層）: Ogg Opus ライタの追加
- `packages/rtp/src/extra/container/ogg/` に Ogg ページ生成ロジックを追加（例: `writer.ts`）。
  - Ogg ページヘッダ（`OggS`、version=0、header_type フラグ BOS(0x02)/EOS(0x04)/continued(0x01)、granule position(int64 LE)、bitstream serial、page sequence、CRC、segment table）。
  - Lacing（255 バイト単位のセグメント分割。255 ちょうどの倍数のパケットは 0 長セグメントで終端）。
  - **Ogg CRC32**: 多項式 `0x04c11db7`、**非反転（MSB first）**、初期値 0、最終 XOR なし。`packages/common/src/crc.ts` の `crc32` は反転版（zlib/IEEE `0xedb88320`）なので**流用不可**。専用テーブル実装を用意する（`common` に追加するか ogg 配下に閉じるかは実装時判断。他パッケージで使う予定がなければ ogg 配下で十分）。
- Opus ヘッダパケット（RFC 7845 §5）:
  - 1 ページ目（BOS）: `OpusHead` のみ。既存 `OpusRtpPayload.createCodecPrivate()`（`packages/rtp/src/codec/opus.ts`）は channel=2 / pre-skip=312 固定。チャンネル数を引数化するか同等関数を流用する。
  - 2 ページ目: `OpusTags`（vendor string 例: `"werift"`、user comment 0 件）。
  - 以降の音声データは 3 ページ目から。
- `index.ts` から export（`packages/rtp/src/extra/container/index.ts` は既に `./ogg` を re-export 済み）。

### 2.2 `packages/rtp`（プロセッサ層）: `OggCallback` 相当の追加
- `WebmCallback`（`packages/rtp/src/extra/processor/webmCallback.ts`）と同形の callback プロセッサを追加（例: `oggCallback.ts` / `ogg.ts` の Base + Callback 構成）。
  - 入力: `WebmInput` 互換（`{ frame?: { data, isKeyframe, time(ms) }, eol?: boolean }`）を `inputAudio` で受ける。`LipsyncCallback.pipeAudio` / `DepacketizeCallback` の出力をそのまま接続できること。
  - 出力: `saveToFile?: Buffer` / `eol` を持つ出力型（`OggOutput`）。
  - **granule position** は 48kHz サンプル単位（Opus は入力クロックに関係なく 48k）。`frame.time`(ms) から `(time - baseTime) * 48` で算出するか、Opus TOC バイトからフレーム長（2.5/5/10/20/40/60ms × フレーム数, RFC 6716 §3.1）を読み取って累積する。DTX / パケット欠落時のギャップにも単調増加を保つこと。pre-skip を加算する点に注意（RFC 7845 §4）。
  - ページ化方針: N パケット（例: 約 1 秒分、または 255 セグメント上限）ごとにページを flush し、`saveToFile` で逐次出力。`eol` 受信時に残りを **EOS フラグ付きページ**で出力。
  - Ogg は WebM と違い**ファイル末尾/先頭の後書き換え（duration/size）が不要**なので、逐次 append のみでよい。
- ファイル保存ヘルパ: `saveToFileSystem`（WebM 用、duration/size の上書きを行う）とは別に、Ogg 用の append-only 保存関数を用意するか、出力型を判定して共通化する。
- `packages/rtp/src/extra/processor/index.ts` から export。

### 2.3 `packages/webrtc`: `MediaRecorder` の OGG 対応
- `packages/webrtc/src/nonstandard/recorder/writer/ogg.ts` に `OggFactory extends MediaWriter` を追加。パイプライン構成は `WebmFactory` の **audio 分岐**と同じ:
  `RtpSourceCallback / RtcpSourceCallback → NtpTimeCallback|RtpTimeCallback → DepacketizeCallback("OPUS") → (LipsyncCallback) → OggCallback → saveToFileSystem / stream`
  - `disableNtp` / `jitterBuffer` / `onEol` / `ended` / `EventDisposer` による unsubscribe / `stop()` の 5 秒待ちは WebM と同じ振る舞いにする。
  - 音声トラックのみなので Lipsync は不要（または `disableLipSync` 相当で常にバイパス）とするのが自然。実装時に判断し、ドキュメントに明記。
- `MediaRecorder` コンストラクタの拡張子分岐に `"ogg"`（必要なら `"opus"` も）を追加。
- path なし（`stream` のみ）の場合のフォーマット指定手段を追加（例: `props.format?: "webm" | "ogg"` / `mimeType`）。未指定時は従来通り WebM（後方互換）。
- 未対応拡張子のエラーを `WeriftError` などメッセージ付きに改善（任意だが推奨）。
- 型の一般化:
  - `StreamEvent = Event<[WebmOutput]>`（`writer/index.ts`）を、Ogg 出力も扱えるよう union 化 or ジェネリクス化する。既存利用者の型を壊さないこと。
- バリデーション（`OggFactory.start`）:
  - トラックが **audio かつ Opus 以外**、または **video トラックを含む**場合は `WeriftError` を投げる（Ogg に VP8 等を入れる Theora/VP8-in-Ogg は対象外）。
  - 複数音声トラック（`numOfTracks > 1`）は Ogg の多重化（複数論理ストリーム）になるため、**初期実装では 1 トラックのみサポート**とし、それ以外はエラーにする。
  - `track.codec.channels` を `OpusHead` の channel count に反映（Opus RTP は SDP 上常に `/2` なので通常 2 で問題ない）。

### 2.4 ドキュメント・サンプル
- `README.md` の **Recording** 行（`Nonstandard MediaRecorder / WebM writer paths ...`）に Ogg (Opus) を追記。
- `examples/save_to_disk/` に `opus_ogg.ts`（`path: ./opus-xxx.ogg`）などのサンプル追加を検討。追加する場合は `examples/e2e/tests/helpers/catalog.ts` の `save-opus` と同様のエントリ（`outputGlob: "*.ogg"`）を追加し、`npm run examples:e2e` 対象にする。
- `npm run doc` による API ドキュメント再生成が必要か確認。

## 3. 技術調査結果（要約）

| 項目 | 現状 | 参照 |
| --- | --- | --- |
| MediaRecorder 本体 | 拡張子 `webm` のみ switch、他は `throw new Error()` | `packages/webrtc/src/nonstandard/recorder/index.ts` |
| Writer 抽象 | `MediaWriter`（`start(tracks)` / `stop()`）、`StreamEvent = Event<[WebmOutput]>` | `.../recorder/writer/index.ts` |
| WebM Writer | RTP→時刻→depacketize→lipsync→`WebmCallback`→`saveToFileSystem` | `.../recorder/writer/webm.ts` |
| WebM プロセッサ | `WebmBase` + `WebmCallback`、`saveToFileSystem` は EOL で duration/size を書き戻し | `packages/rtp/src/extra/processor/webm.ts`, `webmCallback.ts` |
| MP4 プロセッサ | `mp4.ts` / `mp4Callback.ts` が存在（MediaRecorder 未接続）。Callback 構成の参考になる | `packages/rtp/src/extra/processor/mp4*.ts` |
| Ogg | `OggParser`（読み取りのみ、CRC 未検証）。ライタなし。テストなし | `packages/rtp/src/extra/container/ogg/parser.ts` |
| OpusHead | `OpusRtpPayload.createCodecPrivate()`（ch=2, pre-skip=312 固定） | `packages/rtp/src/codec/opus.ts` |
| CRC | `crc32`（反転 IEEE）/ `crc32c` のみ。**Ogg 用 CRC は未実装** | `packages/common/src/crc.ts` |
| export 経路 | `werift/nonstandard` → `imports/rtpExtra` → `packages/rtp/src/extra`（container/processor を再 export） | `packages/webrtc/src/nonstandard/index.ts` |
| 既存テスト | MediaRecorder 単体テストなし。MP4 は `packages/rtp/tests/processor/mp4.test.ts`（Arrange utils は `packages/rtp/tests/utils.ts`、mediabunny で読み戻し検証）。e2e は `examples/e2e/tests/save_to_disk/save_to_disk.test.ts` | — |

推奨アプローチ: **rtp 層に Ogg Opus ライタ + Callback プロセッサを追加 → webrtc 層に `OggFactory` を追加し拡張子/format で選択**。WebM の構造（Base/Callback/Factory）を踏襲し、manager/callback パターンと `Event` クラスによる通知に揃える。

## 4. 制約・注意点

- **後方互換**: `path: *.webm` / `stream` のみ指定時のデフォルト動作（WebM）を変えないこと。`StreamEvent` の型変更で既存利用者のコンパイルを壊さないこと。
- **対象コーデックは Opus のみ**。Ogg Vorbis / FLAC / Speex、Ogg 内ビデオは対象外（エラーで明示）。
- **CRC は非反転 CRC32 (poly 0x04c11db7)**。既存 `crc32` の誤用に注意。既存 `OggParser` で CRC を検証していないため、パーサだけでの往復テストでは CRC バグを検出できない → 既知のテストベクタ or 外部デコーダ（mediabunny が Ogg を読めればそれを利用、または `ffprobe` を任意依存で）での検証を推奨。
- **granule position の正確性**: 最終ページの granule が実長と一致しないと再生時間がずれる。DTX（無音パケット省略）時にも時刻ベースで正しく進めること。pre-skip(312) 加算を忘れない。
- ページサイズ上限（1 ページあたり最大 255 セグメント / ~64KB）を超えないよう flush。
- `stop()` 時に EOS ページが必ず出力されること（`eol` 経路）。`onEol` 待ちタイムアウト（5 秒）を WebM と揃える。
- `MediaRecorderOptions` の `width/height/roll/defaultDuration` は Ogg では無視される旨をドキュメント化。
- テストは AGENTS.md に従い **Arrange / Act / Assert** の 3 フェーズ、Arrange は共通ユーティリティ（`packages/rtp/tests/utils.ts` など単一ファイル）に抽出、Act / Assert には日本語コメント。
- Windows ネイティブは対象外（Unix 系のみ）。

## 5. 完了条件

- [ ] `packages/rtp` に Ogg Opus ライタ（ページ生成・lacing・Ogg CRC32・OpusHead/OpusTags）と Callback プロセッサが追加され、`werift/nonstandard` から利用可能。
- [ ] `new MediaRecorder({ path: "xxx.ogg", tracks: [opusTrack] })` で、標準的なデコーダ（ffprobe / mediabunny 等）で再生・解析可能な Ogg Opus ファイルが生成される。
- [ ] `stream` のみ指定時に format（例: `format: "ogg"`）で Ogg 出力を選べる。未指定時は従来通り WebM。
- [ ] video トラック・非 Opus・複数トラック指定時は明確なメッセージ付きエラーになる。
- [ ] 単体テスト追加:
  - Ogg ページ生成（ヘッダ各フィールド、lacing 境界値: 254/255/256/510 バイト、CRC 既知値）
  - Callback: BOS/EOS フラグ、page sequence 連番、granule position の単調増加と最終値、`OggParser` による往復読み取り
  - （可能なら）外部デコーダでの読み戻し検証
- [ ] `cd packages/rtp && npm run type && npm test`、`cd packages/webrtc && npm run type && npm test` が通る。cross-package 変更のため `npm run type` と `npm run test:small` も通る。
- [ ] README の Recording 行を更新。サンプルを追加した場合は e2e カタログに登録し `npm run examples:e2e` で確認。
- [ ] 必要に応じて `packages/rtp` / `packages/webrtc` の `AGENTS.md` を更新（スクリプトや安定エントリポイントに変更がある場合のみ）。
