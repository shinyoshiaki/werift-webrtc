## 1. 目的と背景

`packages/webrtc/src/nonstandard/userMedia.ts` は、`gst-launch-1.0` を起動して `mp4/webm` を RTP 化し、UDP 経由で `MediaStreamTrack.writeRtp()` に流し込む実装です。  
この方式は **外部 gstreamer 依存・プロセス管理・UDP 受け渡し** が必要で、`packages/webrtc` の中に閉じた実装になっていません。

今回の目的は、**mediabunny を使った in-process のファイル解析/送出機能に置き換え**、`mp4/webm` から直接 RTP パケットを生成して `MediaStreamTrack` として扱えるようにすることです。既存の gstreamer ベースの類似機能は、この新実装へ統合して削除対象にします。

---

## 2. 実装すべき具体的な変更内容

- `packages/webrtc/src/nonstandard/userMedia.ts` の gstreamer 起動処理を削除し、mediabunny ベースの実装に置換する
- 入力は **path / Buffer / stream** の 3 形態に対応する
- `mp4/webm` を解析し、音声/映像ごとの `MediaStreamTrack` を生成する
- 読み込んだサンプルを **RTP パケットに変換して `track.writeRtp()` へ投入** する
- `loop` を維持し、ファイル末尾で再生を繰り返せるようにする
- `start()/stop()` のライフサイクルは現行 API と揃える
- `width/height` による変換は **スコープ外** とし、該当 API は削除または別経路へ分離する
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
- 入力メディアの codec と `RTCPeerConnection` / SDP / `werift` 側の設定が一致しない場合は、**明示的にエラーを送出** する

---

## 4. 考慮すべき制約・注意点

- **音声コーデックの扱い**  
  現行 mp4 パスは AAC を Opus に変換していますが、今回の要件では **変換はスコープ外** とする。したがって、入力音声 codec と SDP 上の音声 codec が一致しない場合はエラーにする。

- **`width/height` の扱い**  
  変換はスコープ外なので、`width/height` によるリサイズ/再エンコード系 API は削除または非推奨化する。

- **対応 codec の明確化**  
  現状の `packages/webrtc` が実質受けるのは `H264 / VP8 / VP9 / AV1 / Opus / PCMU` 系です。入力ファイルが何でも良い、にはできません。  
  → mediabunny が読み取った codec と werift の送出設定が合わない場合は、サイレントに落とさずエラーにする。

- **ライフサイクル**  
  `loop`、`stop()`、ファイル末尾、再生再開時の `source changed` を壊さないこと。

- **公開 API の整合性**  
  `examples` は `getUserMedia({ path, loop, width, height })` を前提にしているので、変更するなら呼び出し側も一緒に直す必要があります。  
  → 新 API は `path | Buffer | stream` を受ける形に揃える。

- **別系統の gstreamer は混同しない**  
  `packages/webrtc/src/nonstandard/navigator.ts` の `getUserMedia` は別物です。これは RTP をクローンする in-memory 実装なので、今回の file playback 置換とは分けて扱うべきです。

---

## 5. 完了条件

- `packages/webrtc` 内で `mp4/webm` から RTP を生成する実装が **gstreamer 依存なし** で動く
- `packages/webrtc/src/nonstandard/userMedia.ts` から `gst-launch-1.0` / UDP 依存が消える
- `MediaStreamTrack` として `mp4/webm` ソースを作成し、既存の `RTCPeerConnection` へそのまま送れる
- `path / Buffer / stream` の 3 入力形式が利用できる
- `loop` を含む既存利用例が動作する
- 未対応 codec / SDP 不一致 / 変換不能ケースで明確なエラーが返る
- 必要なら例・ドキュメントが更新され、公開 API と実装が一致している
