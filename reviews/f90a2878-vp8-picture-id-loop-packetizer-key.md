---
ide:
  viewer: review-document
  version: 1
  title: "VP8 PictureID ループ修正のレビュー"
  dock: right
  baseCommit: f0edb477da30bf56c59fe63a7e1be39ac776c2f3
---
# VP8 PictureID がループで戻る問題の修正レビュー

## 1. 概要

`createFileMediaPlayer({ loop: true })` は、ループの 1 周ごとに packetizer を作り直すかどうかを「codec の fmtp 文字列を含む key」で判定していました。Firefox の answer は VP8 に `max-fs=12288;max-fr=60` を付けるため、2 周目で key が変わり、`Vp8Packetizer` が作り直されて PictureID がランダム値に戻っていました。

修正では key を「packetizer の出力に影響する値」だけに絞りました。VP8 では fmtp が変わっても packetizer が維持され、PictureID が +1 で続きます。公開 API の変更はありません。

## 2. 修正前後の流れ

<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px">
<div style="border:1px solid #d33;border-radius:6px;padding:10px">
<b style="color:#d33">Before</b>
<ol>
<li>1 周目 <code>play()</code>: key = <code>["video/vp8",90000,null,null]</code></li>
<li>answer 適用: <code>track.codec.parameters = "max-fs=12288;max-fr=60"</code></li>
<li>2 周目 <code>play()</code>: <code>packetizerCodecKey</code> が変化</li>
<li style="color:#d33"><code>createPacketizer()</code> で <code>Vp8Packetizer</code> を再生成</li>
<li style="color:#d33">PictureID が <code>random16()</code> に戻る（8363 → 2288）</li>
</ol>
</div>
<div style="border:1px solid #2a8;border-radius:6px;padding:10px">
<b style="color:#2a8">After</b>
<ol>
<li>1 周目 <code>play()</code>: <code>packetizerStateKey</code> = <code>["vp8","video/vp8",90000,null,null]</code></li>
<li>answer 適用: <code>parameters = "max-fs=12288;max-fr=60"</code>（key に含めない）</li>
<li>2 周目 <code>play()</code>: key は同じ</li>
<li style="color:#2a8">packetizer を維持</li>
<li style="color:#2a8">PictureID が +1 で連続</li>
</ol>
</div>
</div>

図のキャプション: 同じ起点（Firefox answer で fmtp が付く）から、Before は 4 番目で packetizer を作り直し、After は維持します。赤が不具合の経路、緑が修正後の経路です。Chrome の VP8 answer には fmtp がないため、修正前から再現しませんでした。

## 3. 主要変更

- [packages/webrtc/src/nonstandard/userMedia/packetizer.ts:155](review-file:packages/webrtc/src/nonstandard/userMedia/packetizer.ts:155) に `packetizerStateKey()` を新設しました。key は `sourceCodec`、正規化した mimeType、clockRate、channels です。H.264 だけ `getH264PacketizationMode()` で正規化した `packetization-mode` を足します。payloadType は `MediaStreamTrack.writeRtp` が書き換えるため、従来どおり含めません。変更の核は [この差分](review-diff:packages/webrtc/src/nonstandard/userMedia/packetizer.ts:155) です。
- [packages/webrtc/src/nonstandard/userMedia.ts:334](review-file:packages/webrtc/src/nonstandard/userMedia.ts:334) の `getPacketizer()` で `packetizerStateKey()` を使うようにし、生の fmtp を含む旧 `packetizerCodecKey()` を削除しました。[差分](review-diff:packages/webrtc/src/nonstandard/userMedia.ts:334)
- [packages/webrtc/tests/nonstandard/userMedia.test.ts](review-diff:packages/webrtc/tests/nonstandard/userMedia.test.ts) に 3 件を追加しました。VP8 の fmtp 変化で PictureID が連続すること、H.264 で `packetization-mode` 以外の fmtp が変わっても packetizer を作り直さないこと、`packetization-mode` が変わると従来どおりエラーで止まることです。
- [packages/webrtc/tests/nonstandard/userMediaTestUtils.ts](review-diff:packages/webrtc/tests/nonstandard/userMediaTestUtils.ts) に、最初の RTP で `track.codec` を差し替える `reassignCodecOnFirstRtp()` を共通化しました。既存テストもこれを使います。
- [e2e/tests/fixture.ts](review-diff:e2e/tests/fixture.ts) から `firefoxKnownIssue.vp8PictureIdLoop` を削除し、[e2e/tests/mediachannel/vp8Playback.test.ts](review-diff:e2e/tests/mediachannel/vp8Playback.test.ts) の `file` を Firefox でも実行します。差分の大半はスキップ指定を外したことによるインデント変更です。
- [changelog.md:34](review-file:changelog.md:34) に Bug Fixes を 1 行追加しました。`e2e/firefox-runs/` に Firefox E2E の run record も入っています。

## 4. 判断理由

- **採用**: key を出力に影響する値だけにする。作り直し自体が起きなくなるため、VP9 や AV1 に状態が増えても同じ対応が要りません。
- **不採用**: 作り直すときに前の PictureID を `Vp8Packetizer` の `pictureId` option で引き継ぐ。packetizer の内部状態を外へ出す必要があり、codec が増えるたびに対応が繰り返されます。
- 修正は E2E 専用ではなく `packages/webrtc/src` の通常動作に入れています。VP8 の answer に fmtp を付ける相手すべてで起きうる問題だからです。

## 5. レビュアーが確認すべき点・リスク

- `packetizerStateKey()` に含める値が `createPacketizer()` の読む値と一致しているか。将来 `createPacketizer()` が別の fmtp を読むようになったら、key にも足す必要があります。コメントでこの対応関係を明記しています。
- H.264 で `packetization-mode` が 1 以外になった場合は、従来どおり `createPacketizer()` の例外で再生が止まります（意図した挙動）。
- channels を `?? null` で正規化したため、`undefined` と `null` の差で作り直しが起きることはありません。
- Firefox E2E の run record が 2 件あります。1 件目は修正が未コミットの状態（`dirty: true`）、2 件目はコミット `f0edb477d` 時点（`dirty: false`）です。AGENTS.md の方針どおり、変更とともにコミットされています。

## 6. 検証結果

私（このドキュメント作成担当）は、テストやビルドを新たに実行していません。以下は差分とコミット済みの記録から確認できた内容です。

- Firefox E2E: `e2e/firefox-runs/20261118T101653Z-f0edb477d.json` に、`tests/mediachannel/vp8Playback.test.ts` を Firefox 157.0 で実行して `result: passed`（exitCode 0）と記録されています。以前は `pictureIdGapDetails` が 1 件出て失敗していました。
- 単体テスト（`userMedia.test.ts`）の実行結果は、このドキュメント作成時点では確認していません。完了条件の「修正前のコードでは失敗する」も、旧実装での実行は未確認です。
