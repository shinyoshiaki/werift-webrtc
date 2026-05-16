│ "packages/webrtc/**/*.ts"

  │ "mediabunny|gstreamer|MediaStreamTrack|track" in *.ts (packages/webrtc)

関連箇所を絞って、既存の非標準 media 生成と track/送信経路を確認します。

  │ packages/webrtc/src/nonstandard/userMedia.ts

  │ packages/webrtc/src/nonstandard/navigator.ts

  │ packages/webrtc/src/nonstandard/recorder/index.ts

  │ packages/webrtc/src/nonstandard/recorder/writer/webm.ts

  │ packages/webrtc/src/media/track.ts

  │ "packages/webrtc/AGENTS.md"

  │ packages/webrtc/src/nonstandard/index.ts

  │ packages/webrtc/src/index.ts

  │ packages/webrtc/package.json


  │ "getUserMedia\(|MediaPlayerMp4|MediaPlayerWebm|MediaRecorder\(|WebmFactory|g
  │ streamer|gst-launch-1.0|matroskademux|rtph264pay|rtpopuspay" in *.ts

既存の mp4/webm 入力経路と、削除対象になりそうな gstreamer 依存箇所を確認します。

  │ "mp4box" in *.ts (packages/webrtc)

  │ "MediaPlayer|getUserMedia" in *.ts (examples)

  │ "Webm|webm" in *.ts (packages/webrtc/src)

  │ packages/webrtc/src/nonstandard/recorder/writer/index.ts

  │ packages/webrtc/src/media/index.ts

  │ packages/webrtc/tests/utils.ts

  │ packages/webrtc/src/nonstandard/index.ts

  │ examples/mediachannel/sendonly/av.ts

  │ packages/webrtc/src/imports/rtpExtra.ts

  │ "mp4box|matroska|webm|ebml|mkv" in *.ts (packages/webrtc/src)

  │ "mediabunny" in *

RTP 送信側の前提を確認して、ファイルパース→track 注入の設計に必要な制約を拾います。

  │ packages/webrtc/src/media/rtpSender.ts

  │ packages/webrtc/src/media/router.ts

  │ packages/webrtc/src/media/rtpTransceiver.ts

  │ packages/webrtc/src/peerConnection.ts

mediabunny は外部依存なので、実装方針に必要な最低限の API/役割だけ外部確認します。

● Web Search (MCP: github-mcp-server) · mediabunny npm package mp4 webm parsing typescript · query:…

● Web Search (MCP: github-mcp-server) · mediabunny TypeScript MP4 WebM parse RTP API documentation …

外部 API は過剰に断定せず、実装観点で使う範囲だけ確認します。

● Web Search (MCP: github-mcp-server) · site:npmjs.com mediabunny package mp4 webm · query: "site:n…

● Web Search (MCP: github-mcp-server) · site:github.com mediabunny mp4 webm github README · query: …

✗ Fetching web content https://www.npmjs.com/package/mediabunny · url: "https://www.npmjs.com/packa…
    code 403

● Fetching web content https://raw.githubusercontent.com/Vanilagy/mediabunny/main/README.md · url: …

パース後の RTP 化に既存の payloader が使えるかを確認します。ここが実装アプローチの分岐点です。

  │ "packages/rtp/src/**/*.ts"

  │ "class .*Pay|payloader|Packetizer|Rtp.*Pay" in *.ts (packages/rtp)

  │ "pay|packetize|depacket|rtph264pay|rtpvp8pay|rtpopuspay|payload" in *.ts
  │ (packages)

  │ packages/rtp/src/index.ts

既存の RTP/コンテナ処理があるので、mediabunny に置き換える時の再利用候補を確認します。

  │ packages/rtp/src/extra/processor/mp4.ts

  │ packages/rtp/src/extra/container/mp4/index.ts

  │ packages/rtp/src/extra/container/webm/index.ts

  │ packages/rtp/src/extra/processor/webm.ts

  │ packages/rtp/src/extra/processor/rtpStream.ts

  │ packages/rtp/src/extra/processor/mp4Callback.ts

  │ packages/rtp/src/extra/processor/interface.ts

  │ packages/rtp/src/extra/processor/webmCallback.ts

  │ packages/rtp/src/extra/container/mp4/container.ts

過去セッションに同様の実装・調査がないかだけ確認して、抜けを減らします。

  │ SELECT DISTINCT s.id, s.branch, s.summary

  │ SELECT s.id, s.branch, s.summary, t.user_message
    /tmp/1778907873348-copilo…

過去の関連タスクが見つかったので、移行方針だけ拾って今回の詳細化に反映します。

  │ SELECT s.id, s.summary, s.branch, s.created_at, s.updated_at

  │ SELECT checkpoint_number, title, overview, work_done, technical_details,
  │ importa…

  │ SELECT source_type, source_id, substr(content,1,500) AS excerpt

  │ SELECT turn_index, user_message, assistant_response
    /tmp/1778907880634-copilot…

● Find related repo sessions (sql)
  │ SELECT s.id, s.summary, t.user_message
    /tmp/1778907880634-copilo…

例でどの入力パターンが使われているかを見て、要件に含めるべき互換性を洗います。

  │ examples/mediachannel/wip_lipsync/rtpbin.ts

  │ examples/mediachannel/sendonly/av.ts

  │ packages/webrtc/src/nonstandard/userMedia.ts

  │ "loop: true|width:|height:|getUserMedia\(\{\s*path" in *.ts (examples)

RTP 化に使える既存 codec 実装を確認して、変換ロジックの現実的な範囲を把握します。

  │ packages/rtp/src/codec/h264.ts

  │ packages/rtp/src/codec/vp8.ts

  │ packages/rtp/src/codec/opus.ts

  │ packages/rtp/src/codec/av1.ts

codec 制約を確認して、単なるパースで足りるのか／変換が必要かを切り分けます。

  │ packages/webrtc/src/media/codec.ts

  │ packages/webrtc/src/media/index.ts

  │ "useOPUS|useVP8|useH264|useVP9|useAV1|PCMU|opus" in *.ts
  │ (packages/webrtc/src)

  │ "mimeType: \"audio/opus\"|mimeType: \"video/H264\"|mimeType:
  │ \"video/vp8\"|mimeType: \"video/vp9\"|mimeType: \"video/av1\"" in *.ts
  │ (packages/webrtc)

音声経路が本当に足りるかを確認するため、mediabunny 側の codec 対応だけ見ます。

● Web Search (MCP: github-mcp-server) · site:mediabunny.dev opus mediabunny audio encoder · query: …

● Web Search (MCP: github-mcp-server) · site:github.com/Vanilagy/mediabunny opus mediabunny README …

  │ "nonstandard|getUserMedia|MediaRecorder" in README.md (README.md)

  │ "packages/webrtc/doc/**/*.md"

  │ "getUserMedia" in *.md (packages/webrtc/doc)
    /workspace/packages/webrtc/doc: No such file or directory (os error 2)

gstreamer 依存が他にもあるかだけ確認し、今回のスコープを packages/webrtc に絞れるか見ます。

  │ e2e/server/handler/mediachannel/addTrack.ts

  │ e2e/server/gstreamer.ts

  │ "spawnGstreamerPipeline|gstreamer|gst-launch-1.0" in *.ts
  │ (e2e/server/handler)

## 1. 目的と背景

`packages/webrtc/src/nonstandard/userMedia.ts` は、`gst-launch-1.0` を起動して `mp4/webm` を RTP 化し、UDP 経由で `MediaStreamTrack.writeRtp()` に流し込む実装です。  
この方式は **外部 gstreamer 依存・プロセス管理・UDP 受け渡し** が必要で、`packages/webrtc` の中に閉じた実装になっていません。

今回の目的は、**mediabunny を使った in-process のファイル再生/パース機能に置き換え**、`mp4/webm` ファイルから直接 RTP パケットを生成して `MediaStreamTrack` として扱えるようにすることです。既存の gstreamer ベースの類似機能は、この新実装へ統合して削除対象にします。

---

## 2. 実装すべき具体的な変更内容

- `packages/webrtc/src/nonstandard/userMedia.ts` の gstreamer 起動処理を削除し、mediabunny ベースの実装に置換する
- `path` から `mp4/webm` を読み込み、音声/映像ごとの `MediaStreamTrack` を生成する
- 読み込んだサンプルを **RTP パケットに変換して `track.writeRtp()` へ投入** する
- `loop` を維持し、ファイル末尾で再生を繰り返せるようにする
- `start()/stop()` のライフサイクルは現行 API と揃える
- `examples/mediachannel/sendonly/av.ts` と `examples/mediachannel/wip_lipsync/rtpbin.ts` の利用方法を必要に応じて調整する
- もし API を変えるなら、`packages/webrtc/src/nonstandard/index.ts` の公開面と例の呼び出しを揃える
- 既存の gstreamer 依存コード（少なくとも `packages/webrtc/src/nonstandard/userMedia.ts` 内）は削除する

---

## 3. 技術的な実装アプローチ

- mediabunny の **入力/デマルチプレックス系 API** で `mp4/webm` を解析する
- コンテナから得た **音声/映像サンプル列** を、WebRTC が受け取れる RTP に組み立てる
- 既存の `MediaStreamTrack.writeRtp()` をそのまま使い、UDP 受信を挟まずに直接 track に注入する
- `RTCRtpSender` 側は `track.onSourceChanged` に反応するため、ループ時の再開やタイムスタンプ/シーケンス再初期化はここに合わせる
- mediabunny は browser-first なので、**Node 実行前提なら `@mediabunny/server` 相当の polyfill/初期化が必要** になる可能性が高い
- `packages/rtp` には H264/VP8/VP9/AV1/Opus の depacketizer はあるが、**ファイル→RTP の packetizer はない** ので、必要ならこの層を新設または `packages/webrtc` 側に小さな packetizer を実装する

---

## 4. 考慮すべき制約・注意点

- **音声が最大の論点**  
  現行 mp4 パスは AAC を Opus に変換しています。単純な「パースしてそのまま RTP 化」だけでは、`audio/opus` 前提の WebRTC 送出に足りない可能性があります。  
  → **AAC→Opus の扱いをどうするか** を先に決める必要があります。

- **`width/height` の扱い**  
  現行 gstreamer 実装は mp4 でリサイズ/再エンコード相当の分岐があります。mediabunny 移行後にこの機能を維持するなら、変換ステップまで含める必要があります。維持しないなら API 変更が必要です。

- **対応 codec の明確化**  
  現状の `packages/webrtc` が実質受けるのは `H264 / VP8 / VP9 / AV1 / Opus / PCMU` 系です。入力ファイルが何でも良い、にはできません。  
  → 対応フォーマットと unsupported 時のエラーを明示する必要があります。

- **ライフサイクル**  
  `loop`、`stop()`、ファイル末尾、再生再開時の `source changed` を壊さないこと。

- **公開 API の整合性**  
  `examples` は `getUserMedia({ path, loop, width, height })` を前提にしているので、変更するなら呼び出し側も一緒に直す必要があります。

- **別系統の gstreamer は混同しない**  
  `packages/webrtc/src/nonstandard/navigator.ts` の `getUserMedia` は別物です。これは RTP をクローンする in-memory 実装なので、今回の file playback 置換とは分けて扱うべきです。

---

## 5. 完了条件

- `packages/webrtc` 内で `mp4/webm` から RTP を生成する実装が **gstreamer 依存なし** で動く
- `packages/webrtc/src/nonstandard/userMedia.ts` から `gst-launch-1.0` / UDP 依存が消える
- `MediaStreamTrack` として `mp4/webm` ソースを作成し、既存の `RTCPeerConnection` へそのまま送れる
- `loop` を含む既存利用例が動作する
- 未対応 codec / 変換不能ケースで明確なエラーが返る
- 必要なら例・ドキュメントが更新され、公開 API と実装が一致している