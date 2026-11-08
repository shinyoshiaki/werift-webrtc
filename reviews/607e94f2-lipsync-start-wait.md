---
ide:
  viewer: review-document
  version: 1
  title: "MediaRecorder A/V 録画先頭欠落の修正"
  dock: right
  baseCommit: 270ad669d09c8dae42d7293e67403870be860bc3
---
# MediaRecorder の A/V 録画先頭欠落の修正（再レビュー 2 回目）

## 1. 概要

`MediaRecorder` の WebM 録画（既定の NTP + lipsync）で、遅く最初の RTCP SR が届いたトラックの先頭が捨てられる問題を、`LipsyncBase` に「開始待ち」を入れて解消しました。全 kind のフレームがそろい、遅れたトラックの溜め込み分が追いつくまで保留し、最も古いフレームから出力を始めます。

今回の再レビュー反復（`29e6c1ac6` → `270ad669d`）では、レビュー指摘 2 件に対応しています。入力時に期限切れを検出した直後の停止でフレームが失われる問題（P1）と、公開型 `LipSyncOptions` に必須プロパティが増えていた問題（P2）です。

## 2. 主要変更

<svg viewBox="0 0 640 150" width="100%" role="img" aria-label="開始待ちの流れ">
<style>text{font:13px sans-serif;fill:currentColor}rect{fill:none;stroke:currentColor;stroke-width:1.5}line{stroke:currentColor;stroke-width:1.5}</style>
<rect x="10" y="20" width="130" height="50" rx="6"/><text x="22" y="42">フレーム入力</text><text x="22" y="60">(pendingFrames)</text>
<rect x="190" y="20" width="200" height="50" rx="6"/><text x="200" y="42">全 kind そろい＋追いつき</text><text x="200" y="60">→ start()</text>
<rect x="190" y="90" width="200" height="50" rx="6"/><text x="200" y="112">期限切れ（タイマー/入力時）</text><text x="200" y="130">→ startAndDrain()</text>
<rect x="450" y="40" width="180" height="70" rx="6"/><text x="460" y="65">リングバッファ経由で出力</text><text x="460" y="85">確定時刻は最新フレーム以下</text>
<line x1="140" y1="45" x2="190" y2="45"/><line x1="140" y1="55" x2="190" y2="115"/>
<line x1="390" y1="45" x2="450" y2="65"/><line x1="390" y1="115" x2="450" y2="90"/>
</svg>

### lipsync 本体

[packages/rtp/src/extra/processor/lipsync.ts:210](review-file:packages/rtp/src/extra/processor/lipsync.ts:210) の `processPendingInput` が、開始前のフレームを `pendingFrames` に溜めます。開始条件は `kinds` 全部から受信済みで、各 kind の最新時刻の差が `bufferDuration` 以内であることです。

今回の反復の核は 2 点です。

1. **入力時の期限切れ（P1）**: [packages/rtp/src/extra/processor/lipsync.ts:238](review-diff:packages/rtp/src/extra/processor/lipsync.ts:238) で、期限切れを入力時に検出したときもタイマーと同じ `startAndDrain()` を使うようにしました。その入力で全 kind がそろった場合も同じです。以前は `start()` だけを呼んでいたため、リングバッファに残ったフレームが直後の `stop()` で破棄されていました。
2. **確定時刻の上限（案D）**: [packages/rtp/src/extra/processor/lipsync.ts:96](review-diff:packages/rtp/src/extra/processor/lipsync.ts:96) の `executeTask(end)` に終端引数を追加しました。[packages/rtp/src/extra/processor/lipsync.ts:271](review-diff:packages/rtp/src/extra/processor/lipsync.ts:271) の `startAndDrain()` は、最後のスロットを `executeTask(last)` で受信済みの最新フレームまでしか確定しません。無音補完がスロット末尾まで時刻を進め、後から届くフレームを捨てる不具合を避けるためです。通常経路は `end` の既定値により動作が変わりません。

### 公開型（P2）

[packages/rtp/src/extra/processor/lipsync.ts:368](review-diff:packages/rtp/src/extra/processor/lipsync.ts:368) の `kinds` と [packages/rtp/src/extra/processor/lipsync.ts:380](review-diff:packages/rtp/src/extra/processor/lipsync.ts:380) の `startTimeout` を省略可能にしました。既定値は実行時に入ります。従来の全指定オブジェクトを [packages/rtp/tools/publicTypes/consumer.ts:36](review-diff:packages/rtp/tools/publicTypes/consumer.ts:36) に追加し、`npm run type:public` で検証します。

### WebM 側

[packages/webrtc/src/nonstandard/recorder/writer/webm.ts:87](review-file:packages/webrtc/src/nonstandard/recorder/writer/webm.ts:87) で `WebmFactory` が録画対象トラックの kind を必ず渡します。この反復では変更していません。映像だけの録画は待たずに開始します。

### テスト・changelog

- [packages/rtp/tests/processor/lipsync.test.ts:177](review-diff:packages/rtp/tests/processor/lipsync.test.ts:177): 入力時の期限切れ + 直後の停止の回帰テスト。
- [packages/rtp/tests/processor/lipsync.test.ts:196](review-diff:packages/rtp/tests/processor/lipsync.test.ts:196): その入力で全 kind がそろう場合の回帰テスト。
- [packages/rtp/tests/processor/lipsync.test.ts:94](review-diff:packages/rtp/tests/processor/lipsync.test.ts:94): 無音補完の有無 × {入力停止、同区間の入力継続} の 4 ケース。完全一致比較に変えました。
- [changelog.md:47](review-diff:changelog.md:47): オプションが省略可能であること、タイマー開始の確定時刻の上限、入力時の期限切れ経路を追記しました。

## 3. 判断理由

- **症状ごとの修正をやめ、不変条件で直した**: タイマー開始経路の指摘が連鎖していたため、「確定時刻は受信済みの最新フレームを越えない」という条件に揃えました。通常経路の `insertFrame` が元々守っている条件です。
- **案A（タイマーでは `start()` のみ）は不採用**: 保留が短いと入力停止中に何も出力されず、初期の指摘（入力が止まるとタイムアウトしない）に戻ります。
- **SR 前の仮 NTP マッピングは不採用**: 合わせ直しで時刻が巻き戻り、Ogg など他のパイプラインにも影響するためです。チケットで別チケット候補としています。

## 4. レビュアーが確認すべき点・リスク

- **挙動の変更**: 既定で開始が待たれます。出力（`stream` を含む）は最大 `startTimeout`（既定 10 s）遅れ、その間フレームをメモリに保持します。changelog に明記済みです。
- **直接利用者への影響**: `LipsyncCallback` を単一トラックで使う場合は `kinds` を渡さないとタイムアウトまで待ちます。
- **互換性**: 公開型の新プロパティは省略可能です。既存の呼び出しは壊れません。
- **ダミー音声の格子**: 250 ms のスロット境界ごとに取り直されます。develop からの既存挙動で、変更していません。
- **未解決（スコープ外）**: SR を送らない送信者のトラックは `NtpTimeCallback` が出力しません。`disableLipSync: true` では遅いトラックの先頭欠落が残ります。`LipsyncBase.stop()` による末尾の欠落も対象外です。

## 5. 検証結果

この文書の作成時に、次を実行しました。

- `cd packages/rtp && npm test`: 49 ファイル / 544 テストがすべて通過。
- `cd packages/rtp && npm run type:public`: エラーなし。

次はチケットの記録によるもので、この文書の作成時には再実行していません。

- 修正前の実装（一時 worktree）で、案D の無音補完あり 2 ケース、P1 の回帰テスト、P2 の `type:public`（`TS2739`）が失敗することを確認済み。
- E2E `recordPlayback.test.ts` の `av` ケースと `npm run e2e` は通過済みと記載されています。ただしこの反復後の再実行結果は確認できていません。
