---
ide:
  viewer: review-document
  version: 1
  title: "MediaRecorder の Ogg Opus 対応レビュー"
  dock: right
  baseCommit: d00815ae81696f6739860d1cf1e7998cd555960d
---
# MediaRecorder の Ogg Opus 対応レビュー

## 1. 概要

非標準 `MediaRecorder` が WebM に加えて **Ogg Opus（RFC 7845）** を書き出せるようになりました。`.ogg` / `.opus` の `path`、または `format: "ogg"` と `stream` の組み合わせで、Opus 音声 1 トラックを録音します。

コンテナ層（ページ生成）、プロセッサ層（granule position 管理とページ化）、`webrtc` の Writer の 3 層で追加しました。再レビューの指摘を受け、並べ替え用に `JitterBufferBase` も修正しています。この修正は WebM の映像録画にも影響します。

<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
  <div style="flex:1;min-width:110px;padding:8px;border:1px solid var(--review-border);border-radius:6px"><strong>RTP</strong><br>RtpSource</div>
  <div>→</div>
  <div style="flex:1;min-width:110px;padding:8px;border:1px solid var(--review-accent);border-radius:6px"><strong>JitterBuffer</strong><br>並べ替え（修正あり）</div>
  <div>→</div>
  <div style="flex:1;min-width:110px;padding:8px;border:1px solid var(--review-border);border-radius:6px"><strong>Ntp/RtpTime → Depacketize("OPUS")</strong></div>
  <div>→</div>
  <div style="flex:1;min-width:110px;padding:8px;border:1px solid var(--review-accent);border-radius:6px"><strong>OggCallback</strong><br>ギャップ補完・ページ化</div>
  <div>→</div>
  <div style="flex:1;min-width:110px;padding:8px;border:1px solid var(--review-border);border-radius:6px"><strong>saveOggToFileSystem</strong><br>追記のみ</div>
</div>

## 2. 主要変更

### rtp: コンテナ層

- [packages/rtp/src/extra/container/ogg/writer.ts:104](review-file:packages/rtp/src/extra/container/ogg/writer.ts:104) の `OggPager` が、lacing、BOS / EOS / continued フラグ、ページ分割を担当します。
- [packages/rtp/src/extra/container/ogg/writer.ts:35](review-file:packages/rtp/src/extra/container/ogg/writer.ts:35) の `oggCrc32` は Ogg 専用の CRC です（多項式 0x04c11db7、非反転）。`common` の zlib 系 `crc32` は流用できないため、ogg 配下に閉じました。
- `createOpusHead` / `createOpusTags` と、TOC からフレーム長を求める [packages/rtp/src/extra/container/ogg/writer.ts:255](review-file:packages/rtp/src/extra/container/ogg/writer.ts:255) の `getOpusPacketSamples` も同じファイルにあります。

### rtp: プロセッサ層

- [packages/rtp/src/extra/processor/ogg.ts:69](review-file:packages/rtp/src/extra/processor/ogg.ts:69) の `OggBase` が granule position を 48 kHz サンプルで累積します。
- 時刻のずれが 2.5 ms 以上あると、TOC のみの空 Opus パケットで補完します（[packages/rtp/src/extra/processor/ogg.ts:162](review-file:packages/rtp/src/extra/processor/ogg.ts:162)）。DTX やパケット欠落があっても granule が単調増加し、再生時間がメディア時間に追従します。
- 遅着・重複パケットは書き出し済みの範囲に入るため破棄します（[packages/rtp/src/extra/processor/ogg.ts:154](review-file:packages/rtp/src/extra/processor/ogg.ts:154)）。
- `eol` 受信時は EOS 付きの最終ページを出し、続けて `eol.duration` を出します（[packages/rtp/src/extra/processor/ogg.ts:206](review-file:packages/rtp/src/extra/processor/ogg.ts:206)）。
- `OggCallback` と、追記専用の [packages/rtp/src/extra/processor/oggCallback.ts:58](review-file:packages/rtp/src/extra/processor/oggCallback.ts:58) `saveOggToFileSystem` を追加しました。WebM と違い、末尾の書き戻しは不要です。最初の書き込みで既存ファイルを置き換えます。

### rtp: JitterBuffer の修正（再レビューでの指摘対応）

[packages/rtp/src/extra/processor/jitterBuffer.ts:33](review-file:packages/rtp/src/extra/processor/jitterBuffer.ts:33) を、不変条件ベースで書き直しました。

- **旧実装の問題:** タイムアウト時に位置を最新受信へ飛ばすため、バッファ内の待機パケットが捨てられていました。最新 seq が 0 のときは、バッファ全体が捨てられました。
- **新実装:** 実際に届かなかった seq だけを諦め、各欠落範囲を `isPacketLost` で 1 回ずつ通知します（`to` は欠落範囲の最後です）。[packages/rtp/src/extra/processor/jitterBuffer.ts:165](review-file:packages/rtp/src/extra/processor/jitterBuffer.ts:165) の `releaseUntil` が出力順を保ちます。
- 差分の核: [packages/rtp/src/extra/processor/jitterBuffer.ts:33](review-diff:packages/rtp/src/extra/processor/jitterBuffer.ts:33)

### webrtc: Writer と MediaRecorder

- [packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:26](review-file:packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:26) の `OggFactory` は、WebmFactory の音声分岐から Lipsync を除いたパイプラインです。Opus 以外、video、複数トラックは [packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:40](review-file:packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:40) で `WeriftError` にします。
- 書き込み失敗時は [packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:103](review-file:packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:103) で購読解除とソース停止を行い、`onError` で通知します。
- [packages/webrtc/src/nonstandard/recorder/index.ts:122](review-file:packages/webrtc/src/nonstandard/recorder/index.ts:122) の `resolveFormat` が、拡張子と `format` からコンテナを決めます。未対応拡張子は、メッセージ付きの `WeriftError` になります。`stream` のみで `format` 未指定なら従来どおり WebM です。
- [packages/webrtc/src/nonstandard/recorder/index.ts:117](review-file:packages/webrtc/src/nonstandard/recorder/index.ts:117) で、`stop()` が非同期の `start` 完了を待つようにしました。
- `StreamEvent<O = WebmOutput>` を総称化し、既存の `StreamEvent` の型は変わりません。差分の核: [packages/webrtc/src/nonstandard/recorder/index.ts:60](review-diff:packages/webrtc/src/nonstandard/recorder/index.ts:60)

### 付随変更

- `WeriftError` が `message` / `payload` / `path` を保持するように修正しました（[packages/common/src/log.ts](review-diff:packages/common/src/log.ts)）。メッセージ付きエラーの前提になる修正です。
- README、`changelog.md`、`examples/save_to_disk/opus_ogg.ts`（[examples/save_to_disk/opus_ogg.ts](review-file:examples/save_to_disk/opus_ogg.ts)）、E2E カタログ（[examples/e2e/tests/helpers/catalog.ts](review-diff:examples/e2e/tests/helpers/catalog.ts)）を更新しました。

## 3. 判断理由

| 論点 | 採用 | 採用しなかった案と理由 |
| --- | --- | --- |
| granule position の算出 | 入力時刻から期待位置を求め、差分を空パケットで補完 | 時刻だけで granule を決める案。パケット列と食い違い、シークや再生時間が狂います。 |
| pre-skip の既定値 | 0 | 312（RTP 由来の録音にはエンコーダ先頭の余剰がなく、実音声を削ってしまう）。 |
| Lipsync | 常に使わない | 1 トラックのみなので同期相手がいません。 |
| 並べ替え | JitterBuffer を通す | 遅着パケットが補完済み区間の後に書かれ、時刻が逆行するため。 |
| 複数トラック | エラー | 複数論理ストリームの多重化は初期実装の対象外としました。 |
| CRC | ogg 配下に専用実装 | 現状は他パッケージから使われません。 |

## 4. レビュアーが確認すべき点・リスク

- **JitterBuffer の挙動変更は WebM 映像録画にも及びます。** `isPacketLost` の `to` の意味と通知タイミングが変わりました。利用側（PLI/NACK などの判断）を確認してください。
- 公開 API が増えます（`OggPager`、`createOggPage`、`oggCrc32`、`createOpusHead`、`createOpusTags`、`getOpusPacketSamples`、`OggCallback`、`saveOggToFileSystem`）。`MediaRecorderOptions.format` も新規です。
- `jitterBuffer` オプションは、WebM では映像のみに適用されます。Ogg では音声に適用されます。ドキュメントの記述と合っているか確認してください。
- 補完は 48 kHz 前提のデフォルト ON です。`fillGaps: false` で無効にできます。
- 拡張子の大文字（`.OGG`）は未対応です。`ext` はそのまま照合しています。
- WebM の `.webm` 以外の拡張子は、以前は空の `Error` でしたが、`WeriftError` になりました。型は `Error` のサブクラスなので互換です。
- 私は `npm run doc` による生成ドキュメントの再生成状況を確認していません。`doc/_media` 配下の追加は、コミット済みの差分から確認したものです。

## 5. 検証結果

今回の文書作成時に、次のテストを実行しました。

| コマンド | 結果 |
| --- | --- |
| `packages/rtp` で `vitest run tests/container/ogg.test.ts tests/processor/ogg.test.ts tests/processor/jitterBuffer.test.ts` | 3 ファイル / 93 テスト通過 |
| `packages/webrtc` で `vitest run tests/nonstandard/recorder.test.ts` | 1 ファイル / 24 テスト通過 |

実行していないもの: `npm run type`、`npm run test:small` 全体、`npm run e2e`、`npm run examples:e2e`、実ブラウザやメディアプレーヤーでの再生確認。これらの結果は、過去のレビュー反復で実行されたかどうかを含め、この文書では確認できていません。
