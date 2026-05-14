コードベースを調査して、`packages/rtp` の MP4 依存箇所と移行観点を洗い出します。



  │ "**/AGENTS.md"

  │ "mp4|MP4|mediabunny|mp4box|muxer|demux" in *.{ts,tsx,js,mjs,json,md}

  │ packages/rtp/package.json

  │ packages/webrtc/package.json

  │ import-test/package.json

  │ "mp4|MP4|mp4box|mediabunny|muxer|demux" in *.{ts,tsx,js,mjs,json,md}
  │ (packages/rtp, packages/webrtc, examples, import-test)

  │ packages/rtp/src/extra/processor/mp4.ts

  │ packages/rtp/src/extra/container/mp4/mp4box.ts

  │ packages/rtp/src/extra/processor/mp4Callback.ts

  │ packages/rtp/src/typings/mp4box.d.ts

  │ packages/rtp/src/extra/container/mp4/container.ts

  │ packages/webrtc/src/nonstandard/userMedia.ts

  │ packages/rtp/src/extra/container/mp4/container.ts

関連する利用箇所とテスト面を追加で確認します。

  │ "packages/rtp/tests/**/*"

  │ packages/rtp/src/extra/container/index.ts

  │ packages/rtp/src/extra/processor/index.ts

  │ "examples/save_to_disk/mp4/**/*"

  │ "packages/rtp/src/extra/container/mp4/**/*"

  │ "MP4Callback|Mp4Container|mp4SupportedCodecs|extra/container/mp4|extra/proce
  │ ssor/mp4|save_to_disk/mp4|getUserMedia\(|MediaPlayerMp4" in
  │ *.{ts,tsx,js,mjs,md}

  │ packages/rtp/src/extra/container/mp4/index.ts

  │ packages/rtp/src/extra/container/mp4/h264.ts

  │ examples/save_to_disk/mp4/av.ts

  │ examples/save_to_disk/mp4/h264.ts

  │ examples/save_to_disk/mp4/opus.ts

  │ "from ["']werift-rtp["']|from
  │ ["']werift-rtp/extra["']|require\(["']werift-rtp/extra["']\)" in
  │ *.{ts,tsx,js,mjs}

  │ packages/webrtc/src/nonstandard/index.ts

  │ "MP4Callback|werift-rtp/extra|extra/index" in *.ts (packages/webrtc/src,
  │ packages/webrtc/tests, packages/webrtc/examples)
    2)

  │ "packages/webrtc/src/nonstandard/**/*"

  │ "mp4box" in *.ts (packages/webrtc/src, packages/webrtc/tests)

  │ "MP4Callback|Mp4Container|mp4SupportedCodecs" in *.ts (packages/webrtc/src,
  │ packages/webrtc/tests)

  │ packages/webrtc/src/imports/rtpExtra.ts

`mediabunny` の MP4 muxing API と、現実的な移行方式を確認します。


● Web Search (MCP: github-mcp-server) · site:mediabunny.dev MediaBunny MP4OutputFormat Output addVi…

● Web Search (MCP: github-mcp-server) · MediaBunny MP4 muxing API fragmented MP4 output streaming a…

✗ Fetching web content https://mediabunny.dev/guide/output-formats/ · url: "https://mediabunny.dev/…
    code 404

● Fetching web content https://mediabunny.dev/api/Output · url: "https://mediabunny.dev/api/Output"…

● Fetching web content https://mediabunny.dev/api/Mp4OutputFormat · url: "https://mediabunny.dev/ap…

✗ Fetching web content https://mediabunny.dev/guide/writing-media-files/ · url: "https://mediabunny…
    status code 404







    not point to a file or directory, or the file does not exist in the
    repository.

    not point to a file or directory, or the file does not exist in the
    repository.

  │ /tmp/1778801814653-copilot-tool-output-mptu36.txt

  │ /tmp/1778801814654-copilot-tool-output-hz3d5n.txt








  │ "class StreamTarget|type
  │ StreamTargetOptions|constructor\(|onData|write\(|chunked|append"
  │ (/tmp/1778801814653-copilot-tool-output-mptu36.txt)

  │ "class EncodedAudioPacketSource|class EncodedVideoPacketSource|add\(|constru
  │ ctor\(|videoCodec|audioCodec|addPacket"
  │ (/tmp/1778801831740-copilot-tool-output-vc1h0i.txt)

  │ "fragment|fastStart|moof|timestamped|fragmentation"
  │ (/tmp/1778801814654-copilot-tool-output-hz3d5n.txt)

  │ /tmp/1778801814653-copilot-tool-output-mptu36.txt

  │ /tmp/1778801814653-copilot-tool-output-mptu36.txt

  │ /tmp/1778801831740-copilot-tool-output-vc1h0i.txt

  │ /tmp/1778801831740-copilot-tool-output-vc1h0i.txt

● Fetching web content https://mediabunny.dev/api/EncodedAudioPacketSource · url: "https://mediabun…

● Fetching web content https://mediabunny.dev/api/EncodedVideoPacketSource · url: "https://mediabun…

● Fetching web content https://mediabunny.dev/api/StreamTarget · url: "https://mediabunny.dev/api/S…

● Fetching web content https://mediabunny.dev/api/IsobmffOutputFormatOptions · url: "https://mediab…

● Fetching web content https://mediabunny.dev/api/AUDIO_CODECS · url: "https://mediabunny.dev/api/A…

    'repo:Vanilagy/mediabunny "const VIDEO_CODECS" language:TypeScript': GET
    https://api.github.com/search/code?page=1&per_page=20&q=repo%3AVanilagy%2Fme
    diabunny+%22const+VIDEO_CODECS%22+language%3ATypeScript: 403 API rate limit
    exceeded for user ID 234441420. If you reach out to GitHub Support for help,
    please include the request ID DE28:2C244D:F3DBF0:1100494:6A065CC5 and
    timestamp 2026-05-14 23:37:42 UTC. For more on scraping GitHub and how it
    may affect your rights, please review our Terms of Service (https://docs.git
    hub.com/en/site-policy/github-terms/github-terms-of-service) [rate reset in
    3s]

● Fetching web content https://mediabunny.dev/api/VIDEO_CODECS · url: "https://mediabunny.dev/api/V…


● Fetching web content https://mediabunny.dev/api/NON_PCM_AUDIO_CODECS · url: "https://mediabunny.d…

● Fetching web content https://mediabunny.dev/api/FilePathTarget · url: "https://mediabunny.dev/api…

● Fetching web content https://mediabunny.dev/api/EncodedPacket · url: "https://mediabunny.dev/api/…

● Fetching web content https://mediabunny.dev/api/BufferTarget · url: "https://mediabunny.dev/api/B…

型・実行環境の制約も確認します。

  │ packages/rtp/tsconfig.production.json

  │ packages/rtp/tsconfig.json

  │ "dom-webcodecs|EncodedVideoChunkMetadata|EncodedAudioChunkMetadata|VideoDeco
  │ derConfig|AudioDecoderConfig" in *.{ts,tsx,json} (packages/rtp,
  │ packages/webrtc)

  │ "mp4box" in package*.json

  │ "fastStart\?: false \| 'in-memory' \| 'reserve' \|
  │ 'fragmented'|minimumFragmentDuration"
  │ (/tmp/1778801814654-copilot-tool-output-hz3d5n.txt)

  │ "FilePathTarget|BufferTarget|AppendOnlyStreamTarget|StreamTarget"
  │ (/tmp/1778801814653-copilot-tool-output-mptu36.txt)

  │ "AudioCodec =|VideoCodec =|type VideoCodec|type AudioCodec"
  │ (/tmp/1778801831740-copilot-tool-output-vc1h0i.txt)

  │ packages/webrtc/tsconfig.json

  │ "mp4box\.d\.ts|BoxParser\.dOpsBox|writeInitializationSegment|addTrack\(|addS
  │ ample\(" in *.ts (packages/rtp/src)

  │ "MP4Callback|save_to_disk/mp4|\.mp4\)|\.mp4"|getUserMp4|MediaPlayerMp4" in
  │ *.{md,ts,tsx} (README.md, docs, doc, examples, packages)


  │ "stop\(\)|destroy =|onStopped|stopped = false" in *.ts
  │ (packages/rtp/src/extra/processor, packages/rtp/src/extra/container)

  │ "eol" in *.ts (packages/rtp, examples, packages/webrtc)

  │ packages/rtp/src/extra/processor/webm.ts

  │ packages/rtp/src/extra/processor/interface.ts

● Fetching web content https://mediabunny.dev/guide/installation · url: "https://mediabunny.dev/gui…


● Web Search (MCP: github-mcp-server) · Mediabunny package.json exports commonjs ESM Node support ·…

H.264 / Opus の入力データ形式も確認して、移行時の注意点を固めます。


● Web Search (MCP: github-mcp-server) · site:mediabunny.dev opus EncodedAudioPacketSource decoderCo…

● Web Search (MCP: github-mcp-server) · site:mediabunny.dev avc EncodedVideoPacketSource decoderCon…

  │ "avcc|Annex B|AnnexB|AVCC|OpusHead|decoderConfig|description"
  │ (/tmp/1778801831740-copilot-tool-output-vc1h0i.txt)



  │ /tmp/1778801814653-copilot-tool-output-mptu36.txt

  │ "AppendOnlyStreamTarget" (/tmp/1778801814653-copilot-tool-output-mptu36.txt)

● Fetching web content https://mediabunny.dev/api/AppendOnlyStreamTarget · url: "https://mediabunny…

出力検証を外部ツールに依存しない形で設計できるかも確認します。

● Fetching web content https://mediabunny.dev/api/Input · url: "https://mediabunny.dev/api/Input", …

● Fetching web content https://mediabunny.dev/api/Mp4InputFormat · url: "https://mediabunny.dev/api…

● Fetching web content https://mediabunny.dev/api/BufferSource · url: "https://mediabunny.dev/api/B…

● Fetching web content https://mediabunny.dev/api/InputTrack · url: "https://mediabunny.dev/api/Inp…

● Fetching web content https://mediabunny.dev/api/InputAudioTrack · url: "https://mediabunny.dev/ap…

● Fetching web content https://mediabunny.dev/api/InputVideoTrack · url: "https://mediabunny.dev/ap…

調査結果として、このタスクは **`packages/rtp` の `mp4box` 直結実装を `mediabunny` ベースへ置き換えつつ、`werift-rtp/extra` と `werift` の nonstandard 公開 API を壊さず、MP4 出力の自動検証基盤も追加する** タスクです。  
特に重要なのは、現状の MP4 経路に **自動テストがなく**、さらに **最終フレーム flush / finalize が未整備** な点です。

## 1. タスクの目的と背景

- 現在の MP4 出力は `packages/rtp/src/extra/container/mp4/container.ts` で `mp4box` に直接依存しています。
- `packages/rtp/src/extra/container/mp4/mp4box.ts` では `mp4box` の API をラップし、さらに **`dOpsBox.write` を monkey patch** しています。
- 型も `packages/rtp/src/typings/mp4box.d.ts` で独自補完しており、MP4 周辺が **外部ライブラリ仕様 + 独自パッチ + 独自型定義** に強く結びついています。
- その MP4 出力は `MP4Base` / `MP4Callback` 経由で公開され、`werift-rtp/extra` と `werift` の `nonstandard` API から利用されます。
- 一方で `packages/rtp/tests` には **MP4 の自動テストが存在しません**。現在の確認手段は `examples/save_to_disk/mp4/*.ts` などの手動実行寄りです。
- さらに現状実装には `MP4Base.stop()` が空実装で、`container.ts` にも **最後のフレーム flush が TODO** として残っており、移行時にここを曖昧にすると「動いているように見えるが最後のデータが欠ける」状態になりえます。

## 2. 実装すべき具体的な機能や変更内容

### 変更の主対象

1. `packages/rtp` の MP4 muxing 実装を `mediabunny` へ移行する
2. 既存の公開 API (`MP4Base`, `MP4Callback`, `werift-rtp/extra`, `werift` nonstandard) を極力維持する
3. MP4 出力の自動テストを追加する
4. 依存定義と lockfile を更新する
5. 手動確認用 examples がそのまま動くことを担保する

### MP4依存箇所のリストアップ

| 分類 | ファイル | 内容 | 対応 |
|---|---|---|---|
| 直接依存 | `packages/rtp/package.json` | `mp4box` 依存 | `mediabunny` へ置換 |
| 直接依存 | `packages/webrtc/package.json` | `mp4box` 依存 | `mediabunny` へ置換 |
| 実装本体 | `packages/rtp/src/extra/container/mp4/container.ts` | `ISOFile`, `addTrack`, `addSample`, init segment / moof / mdat 生成 | 全面移行対象 |
| 実装補助 | `packages/rtp/src/extra/container/mp4/mp4box.ts` | `mp4box` ラッパー + `dOpsBox.write` patch | 削除/不要化候補 |
| 型補完 | `packages/rtp/src/typings/mp4box.d.ts` | `mp4box` 用の独自型定義 | 削除/不要化候補 |
| 公開API | `packages/rtp/src/extra/processor/mp4.ts` | `MP4Base`。音声/映像入力から MP4 出力へ橋渡し | 互換維持しつつ内部差し替え |
| 公開API | `packages/rtp/src/extra/processor/mp4Callback.ts` | `MP4Callback`, `saveToFileSystem` | 互換維持しつつ内部差し替え |
| export面 | `packages/rtp/src/extra/container/index.ts` / `packages/rtp/src/extra/processor/index.ts` | MP4 API の export | 影響確認 |
| cross-package | `packages/webrtc/src/imports/rtpExtra.ts` / `packages/webrtc/src/nonstandard/index.ts` | `rtp extra` の再公開 | 回帰確認必須 |
| 利用例 | `examples/save_to_disk/mp4/av.ts` | 音声+映像 MP4 保存 | 回帰確認対象 |
| 利用例 | `examples/save_to_disk/mp4/h264.ts` | 映像のみ MP4 保存 | 回帰確認対象 |
| 利用例 | `examples/save_to_disk/mp4/opus.ts` | 音声のみ MP4 保存 | 回帰確認対象 |
| 隣接機能 | `packages/webrtc/src/nonstandard/userMedia.ts` | `.mp4` 入力を GStreamer `qtdemux` で再生 | **mp4box依存ではないため移行主対象外** |
| 隣接機能 | `examples/mediachannel/sendonly/av.ts`, `examples/mediachannel/wip_lipsync/rtpbin.ts` | `.mp4` 入力例 | 影響有無の確認対象 |

### 依存更新で波及するファイル

- `package-lock.json`
- `examples/package-lock.json`
- `import-test/package-lock.json`
- `e2e/package-lock.json`
- `loadtest/package-lock.json`

## 3. 技術的な実装アプローチを調査し結果を簡潔にまとめる

### 調査結果（MediaBunny 側）

`mediabunny` には、今回の用途にかなり合う API があります。

- MP4 出力: `Output + Mp4OutputFormat`
- fragmented MP4: `new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: ... })`
- エンコード済み入力: `EncodedVideoPacketSource`, `EncodedAudioPacketSource`
- パケット表現: `EncodedPacket`
- Node 向けターゲット: `FilePathTarget`, `BufferTarget`
- 逐次書き込み: `AppendOnlyStreamTarget`
- 出力検証: `Input + BufferSource + MP4(Mp4InputFormat)` で再読込可能

### このコードベースに合う移行方針

- `packages/rtp/src/extra/processor/mp4.ts` の外形は維持し、内部だけ `mediabunny` 化する
- `Mp4Container` 相当は、`mp4box` の box 操作ではなく、`mediabunny` の
  - `EncodedVideoPacketSource('avc')`
  - `EncodedAudioPacketSource('opus')`
  - `Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented' }), target: ... })`
 で組み直す
- 現在の codec 初期化ロジックはかなり再利用できます
  - 映像: `annexb2avcc(...)` で `decoderConfig.description` を作る
  - 音声: `OpusRtpPayload.createCodecPrivate()` で Opus の初期 description を作る
- 現在の時刻系は `frame.time` が ms、内部 MP4 では us 相当で扱っていますが、`mediabunny` の `EncodedPacket` は **秒単位** なので単位変換が必要です
- 現状と同様、**次フレームが来るまで duration を確定できない** ため、1フレームバッファ戦略は維持が必要です
- その代わり移行時に `stop()` / `destroy()` で `output.finalize()` を呼び、**最後の1フレーム flush 問題を解消する** のが自然です

### 実装上の最有力案

- 内部の MP4 生成は `mediabunny`
- 外部 API は既存の `MP4Callback.pipe(...)` / `saveToFileSystem(...)` を維持
- 逐次出力は `AppendOnlyStreamTarget` か `StreamTarget` を使って実現
- 生成物の検証は新しく `mediabunny` の `Input` で読み直して、以下をテストで確認
  - 読み取り可能な MP4 であること
  - track 数
  - codec (`avc` / `opus`)
  - width/height, sampleRate, channels
  - duration が概ね期待通り
  - 音声のみ / 映像のみ / 音声+映像 の 3 パターン

## 4. 考慮すべき制約や注意点

- **公開 API 互換性**  
  `werift-rtp/extra` と `werift` nonstandard 経由で公開されているため、`MP4Base` / `MP4Callback` の使い方はなるべく維持した方が安全です。
- **対応 codec のスコープ**  
  現在の `mp4SupportedCodecs` は `["avc1", "opus"]` のみです。`mediabunny` はもっと広いですが、移行タスクではまず **H.264 + Opus を同等動作させる** のが妥当です。
- **最後のフレーム flush**  
  現実装はここが弱く、移行時に `stop/finalize` の仕様を明確化しないと不完全です。
- **fragmented MP4 前提**  
  既存実装は init + `moof/mdat` を逐次出す fMP4 的な振る舞いです。`mediabunny` でも `fastStart: 'fragmented'` を前提に設計した方が近いです。
- **Node / TS 互換性**  
  `mediabunny` は TypeScript 5.7+ と ES2021 以上を前提にしており、リポジトリ全体の実環境とは整合しますが、`packages/rtp/package.json` の `node >=10` とは実質合いません。**engine の見直しが必要になる可能性**があります。
- **依存ライセンス確認**  
  `mediabunny` は MPL-2.0 なので、依存差し替え時にライセンス・NOTICE の扱い確認が必要です。
- **`packages/webrtc` への波及**  
  `webrtc` は `rtp/src/extra` を再公開しているため、`rtp` だけ直して終わりではありません。
- **`userMedia.ts` の `.mp4` 入力は別系統**  
  こちらは GStreamer `qtdemux` ベースで、`mp4box` 移行の主対象ではありません。スコープを広げすぎない方がよいです。

## 5. 完了条件

- `packages/rtp` の MP4 出力実装が `mp4box` ではなく `mediabunny` を使う構成になっている
- `mp4box` 専用ラッパー/型定義（`mp4box.ts`, `mp4box.d.ts`）が不要化または削除されている
- `MP4Base` / `MP4Callback` の既存利用例が壊れていない
- `examples/save_to_disk/mp4/opus.ts`
- `examples/save_to_disk/mp4/h264.ts`
- `examples/save_to_disk/mp4/av.ts`
  の少なくとも設計上の前提が維持され、回帰確認できる
- `stop()` / `destroy()` で最終パケットまで含めて finalize される
- `packages/rtp/tests` に MP4 の自動テストが追加され、生成した MP4 を `mediabunny` で再読込して track / codec / duration を検証できる
- 検証観点として最低限以下が通る
  1. audio-only Opus MP4
  2. video-only H.264 MP4
  3. audio+video MP4
- 変更が cross-package / public API にまたがるため、完了判定は少なくとも  
  `npm run type` と `npm run test:small` を通せる状態であること