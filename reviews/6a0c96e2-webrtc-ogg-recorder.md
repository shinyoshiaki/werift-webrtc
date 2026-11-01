---
ide:
  viewer: review-document
  version: 1
  title: "MediaRecorder の Ogg Opus 対応レビュー"
  dock: right
  baseCommit: 66960ba1e0222ffc6d193ee577a568a1bc45fda2
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
  <div style="flex:1;min-width:110px;padding:8px;border:1px solid var(--review-border);border-radius:6px"><strong>saveOggToFileSystem</strong><br>初回は置き換え・以降は追記</div>
</div>

## 2. 主要変更

### rtp: コンテナ層

- [packages/rtp/src/extra/container/ogg/writer.ts:104](review-file:packages/rtp/src/extra/container/ogg/writer.ts:104) の `OggPager` が、lacing、BOS / EOS / continued フラグ、ページ分割を担当します。
- [packages/rtp/src/extra/container/ogg/writer.ts:35](review-file:packages/rtp/src/extra/container/ogg/writer.ts:35) の `oggCrc32` は Ogg 専用の CRC です（多項式 0x04c11db7、非反転）。`common` の zlib 系 `crc32` は流用できないため、ogg 配下に閉じました。
- `createOpusHead` / `createOpusTags` と、TOC からフレーム長を求める [packages/rtp/src/extra/container/ogg/writer.ts:255](review-file:packages/rtp/src/extra/container/ogg/writer.ts:255) の `getOpusPacketSamples` も同じファイルにあります。

### rtp: プロセッサ層

- [packages/rtp/src/extra/processor/ogg.ts:69](review-file:packages/rtp/src/extra/processor/ogg.ts:69) の `OggBase` が granule position を 48 kHz サンプルで累積します。granule は pre-skip 分を含む格納サンプル数そのもので、`duration` / `eol.duration` は格納サンプル数から pre-skip を引いた再生時間です（[packages/rtp/src/extra/processor/ogg.ts:110](review-file:packages/rtp/src/extra/processor/ogg.ts:110)、RFC 7845 §4）。
- 時刻のずれが 2.5 ms 以上あると、TOC のみの空 Opus パケットで補完します（[packages/rtp/src/extra/processor/ogg.ts:162](review-file:packages/rtp/src/extra/processor/ogg.ts:162)）。DTX やパケット欠落があっても granule が単調増加し、再生時間がメディア時間に追従します。
- 遅着・重複パケットは書き出し済みの範囲に入るため破棄します（[packages/rtp/src/extra/processor/ogg.ts:154](review-file:packages/rtp/src/extra/processor/ogg.ts:154)）。判定には、書き込んだサンプル数とは別に持つ「入力時刻上の到達位置」（`position`）を使います。`fillGaps: false` でギャップ分がサンプル数に入らなくても、重複を正しく検出できます。
- `vendor` が長く OpusTags が複数ページにまたがる場合も、途中で完成したページを含めて初期出力にまとめます（[packages/rtp/src/extra/processor/ogg.ts:115](review-file:packages/rtp/src/extra/processor/ogg.ts:115)）。
- `eol` 受信時は EOS 付きの最終ページを出し、続けて `eol.duration` を出します（[packages/rtp/src/extra/processor/ogg.ts:206](review-file:packages/rtp/src/extra/processor/ogg.ts:206)）。
- `OggCallback` と、追記専用の [packages/rtp/src/extra/processor/oggCallback.ts:58](review-file:packages/rtp/src/extra/processor/oggCallback.ts:58) `saveOggToFileSystem` を追加しました。WebM と違い、末尾の書き戻しは不要です。最初の書き込みはファイルを切り詰めて書くため、削除できない場所にある既存ファイルも確実に置き換わります。
- 出力コールバック（ファイル書き込み）の失敗は、未処理の Promise 拒否にせず `OggCallback.onError` で通知します（[packages/rtp/src/extra/processor/oggCallback.ts:17](review-file:packages/rtp/src/extra/processor/oggCallback.ts:17)）。

### rtp: JitterBuffer の修正（再レビューでの指摘対応）

[packages/rtp/src/extra/processor/jitterBuffer.ts:33](review-file:packages/rtp/src/extra/processor/jitterBuffer.ts:33) を、不変条件ベースで書き直しました。

- **旧実装の問題:** タイムアウト時に位置を最新受信へ飛ばすため、バッファ内の待機パケットが捨てられていました。最新 seq が 0 のときは、バッファ全体が捨てられました。
- **新実装:** クラスコメント（[packages/rtp/src/extra/processor/jitterBuffer.ts:18](review-file:packages/rtp/src/extra/processor/jitterBuffer.ts:18)）に不変条件を明記しました。
  - latency 未満の遅れで届いたパケットは、必ず 1 回だけ番号順に出力する。
  - 諦めるのは実際に届かなかった seq だけ。各欠落範囲を、直後のパケットの直前に `isPacketLost` で 1 回ずつ通知する（`to` は欠落範囲の最後。`eol` でも通知）。
  - 出力位置は「タイムアウトした最大の seq」までしか進めない（[packages/rtp/src/extra/processor/jitterBuffer.ts:165](review-file:packages/rtp/src/extra/processor/jitterBuffer.ts:165) の `releaseUntil`）。
  - uint16 / uint32 の折り返しでも同じに動く。
- 番号どおりに届いたパケットがタイムアウトを起こした場合もバッファ内を捨てません。バッファ上限を超えたときは、新着を捨てずに古い欠落を諦めて出力します。
- テストはシード固定の疑似乱数で、欠落・重複・入れ替わりを組み合わせて検証します。開始 seq は 0 / 65000 / 65530 / 65534 / 65535 です。修正前の実装では、出力パケットの比較だけで 20 件が失敗することを一時 worktree で確認しました（当時の報告）。
- 差分の核: [packages/rtp/src/extra/processor/jitterBuffer.ts:33](review-diff:packages/rtp/src/extra/processor/jitterBuffer.ts:33)

### webrtc: Writer と MediaRecorder

- [packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:26](review-file:packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:26) の `OggFactory` は、WebmFactory の音声分岐から Lipsync を除いたパイプラインです。Opus 以外、video、複数トラックは [packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:40](review-file:packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:40) で `WeriftError` にします。
- Ogg の経路には `JitterBufferCallback` を入れ、順序の入れ替わりを直してから時刻処理に渡します。`jitterBuffer` オプション（既定 latency 200 ms）は Ogg では音声に効きます。
- 書き込み失敗時は [packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:103](review-file:packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:103) で購読解除とソース停止を行い、`onError` で通知します。
- `stop()` が終了通知を待つのは「録音処理が動いていて終了通知がまだ来る」状態（`running`、[packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:34](review-file:packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:34)）のときだけです。コーデック未設定などで開始に失敗した場合（[packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:75](review-file:packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:75)）や、録音が始まらなかった場合は、5 秒待たずにすぐ終わります。開始失敗時は購読も解除します。
- 録音先の既存ファイルを事前に `unlink` する処理（エラーを無視していた）はやめ、上記の切り詰め書き込みに任せました。
- [packages/webrtc/src/nonstandard/recorder/index.ts:94](review-file:packages/webrtc/src/nonstandard/recorder/index.ts:94) の `addTrack()` は、Ogg ではトラックを一覧に加える前に「追加後が 1 本か」を確認し、2 本目を `WeriftError` で拒否します。
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
| pre-skip 指定時の granule | 格納サンプル数そのもの（pre-skip を含む） | 格納サンプル数 + pre-skip（実際より長いファイルになり、終了通知もずれる）。 |
| `fillGaps: false` の重複判定 | 入力時刻上の到達位置で判定 | 書き込んだサンプル数で判定（ギャップ分ずれて重複を通してしまう）。 |
| 既存ファイルの扱い | 初回書き込みで切り詰め | 事前 `unlink` してエラーを無視（削除できないと古い内容に追記してしまう）。 |
| Lipsync | 常に使わない | 1 トラックのみなので同期相手がいません。 |
| 並べ替え | JitterBuffer を通す | 遅着パケットが補完済み区間の後に書かれ、時刻が逆行するため。 |
| 複数トラック | エラー（`addTrack()` の 2 本目も拒否） | 複数論理ストリームの多重化は初期実装の対象外としました。 |
| CRC | ogg 配下に専用実装 | 現状は他パッケージから使われません。 |

## 4. レビュアーが確認すべき点・リスク

- **JitterBuffer の挙動変更は WebM 映像録画にも及びます。** `isPacketLost` の `to` の意味と通知タイミングが変わりました。利用側（PLI/NACK などの判断）を確認してください。
- 公開 API が増えます（`OggPager`、`createOggPage`、`oggCrc32`、`createOpusHead`、`createOpusTags`、`getOpusPacketSamples`、`OggCallback`、`saveOggToFileSystem`）。`MediaRecorderOptions.format` も新規です。
- `jitterBuffer` オプションは、WebM では映像のみに適用されます。Ogg では音声に適用されます。ドキュメントの記述と合っているか確認してください。
- 補完は 48 kHz 前提のデフォルト ON です。`fillGaps: false` で無効にできます。
- 補完の最小単位は 2.5 ms です。NTP 由来の時刻に 2.5 ms 以上のゆらぎがあると、短い空パケットが入る可能性があります。
- JitterBuffer の既定 latency 200 ms 分、Ogg 録音の書き出しは遅れます。終了時は残りを一括で書き出します。
- ストリーム先頭でパケットの順序が入れ替わると、最初に届いたパケットが基準になるため、本来先頭のパケットは捨てられます（修正前と同じ動作）。
- `preSkip` を指定した場合、ffprobe の `duration` は pre-skip を含む値（= granule ÷ 48000）になります。ffmpeg の libopus が書くファイルと同じ慣例で、実際の再生時間はデコード結果と `eol.duration` で一致します。格納サンプル数が pre-skip 未満の極端に短い録音は、実デコーダーで確認していません。
- WebM（`WebmFactory`）でも、録音が始まらないまま `stop()` すると 5 秒待つと思われます。このチケット以前からの動作で、今回は手を入れていません（未検証）。
- 拡張子の大文字（`.OGG`）は未対応です。`ext` はそのまま照合しています。
- WebM の `.webm` 以外の拡張子は、以前は空の `Error` でしたが、`WeriftError` になりました。型は `Error` のサブクラスなので互換です。
- 私は `npm run doc` による生成ドキュメントの再生成状況を確認していません。`doc/_media` 配下の追加は、コミット済みの差分から確認したものです。`saveOggToFileSystem` のコメント変更後にも再生成していません。
- **`changelog.md` が develop の取り込みで崩れています。** 今回の Ogg / JitterBuffer の項目が `## v0.26.0` の見出しの下に入っています（`packages/webrtc` の version も 0.26.0）。また、`UdpTransport` / WebM の Cluster サイズ / `ntpTime2Sec()` の項目が 3 回ずつ重複しています（develop 側でも 2 回ずつ重複しています）。どのリリースに載せるかを決め、整理が必要です。

## 5. 検証結果

### 今回の文書更新時（HEAD `fcfe41810`、未コミット変更なし）

| コマンド | 結果 |
| --- | --- |
| `packages/rtp` で `vitest run tests/container/ogg.test.ts tests/processor/ogg.test.ts tests/processor/jitterBuffer.test.ts` | 3 ファイル / 93 テスト通過 |
| `packages/webrtc` で `vitest run tests/nonstandard/recorder.test.ts` | 1 ファイル / 24 テスト通過 |
| `npm run type` | `error TS` 0 件 |

前回の文書作成（`8e1f423d5`）以降、develop の取り込みで入ったのは別チケットの変更です。このチケットの実装・テストファイルには差分がありません（`changelog.md` を除く）。

### 過去のレビュー反復で実行したもの（当時のリビジョン）

| コマンド | リビジョン | 結果 |
| --- | --- | --- |
| `npm run test:small` | `a28b7711d` + 最後の指摘対応（7 ファイル未コミット、のちにコミット済み） | exit 0、全パッケージ成功 |
| `npm run examples:e2e` | `1a325ca22` + JitterBuffer 書き直し（未コミット、のちにコミット済み） | exit 0、68 件成功。サイレント実行のため個別のテスト名は未確認ですが、`save-opus-ogg` はカタログに登録済みです。 |

ffmpeg / ffprobe を使うテスト（libopus の実パケットの書き直し、デコード後のサンプル数、pre-skip 指定時の長さ、ページをまたぐ OpusTags）は、ffmpeg がある環境でだけ実行されます。上記のテストはこの環境で実行されています。

実行していないもの: 現在の HEAD での `npm run test:small` / `npm run e2e` / `npm run examples:e2e`、実ブラウザやメディアプレーヤーでの再生確認。
