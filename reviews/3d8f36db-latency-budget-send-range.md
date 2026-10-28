---
ide:
  viewer: review-document
  version: 1
  title: "latency_budget example: 送信範囲照合と NACK 改善の解説"
  dock: right
  baseCommit: 201e7a9fdb71ee6c7474de137afe476f8922af7c
---
# MoQ ブログの主張を WebRTC で再現する example (latency_budget) 最終レビュー解説

## 1. 概要

[MoQ ブログ「WebRTC is still the problem」](https://moq.dev/blog/webrtc-is-still-the-problem/) が挙げる弱点（音声の遅延再送が効かない、到着時刻で再生される、購読ごとの遅延設定ができない、割り込み時のバッファ破棄）を、werift と Encoded Transform を使った `examples/mediachannel/latency_budget` で再現します。werift 側は、NACK の時間予算、音声 NACK、再送履歴の設定、再送 API、擬似ロスの修正を入れました。

今回の最終コミット（`ae883623`〜`201e7a9f`）は、チケット 6 章の追加要件に対応するものです。「最初に受信したパケット」や「受信数からの推定」をやめ、**送信側が知っている事実（送信範囲）と受信結果を照合**します。照合できない場合は数値を出さず `unverified` と表示します。

このコミット範囲の差分は 68 ファイル（`doc/` や `.sak-context` 配下のコピーを含む）です。以下では核になるものだけを扱います。

## 2. 主要変更

<svg viewBox="0 0 640 150" width="100%" role="img" aria-label="送信範囲の照合フロー">
  <g fill="none" stroke="var(--review-border)"><rect x="6" y="20" width="140" height="50" rx="6"/><rect x="180" y="20" width="140" height="50" rx="6" stroke="var(--review-accent)"/><rect x="354" y="20" width="140" height="50" rx="6" stroke="var(--review-accent)"/><rect x="520" y="20" width="114" height="50" rx="6"/></g>
  <g stroke="var(--review-muted)"><line x1="146" y1="45" x2="180" y2="45"/><line x1="320" y1="45" x2="354" y2="45"/><line x1="494" y1="45" x2="520" y2="45"/></g>
  <g fill="var(--review-fg)" font-size="12" text-anchor="middle"><text x="76" y="42">ブラウザ</text><text x="76" y="58">SendGate</text><text x="250" y="42">werift 受信</text><text x="250" y="58">SendAccounting</text><text x="424" y="42">NackHandler</text><text x="424" y="58">markSentFrom</text><text x="577" y="42">統計</text><text x="577" y="58">balanced / unverified</text></g>
  <g fill="var(--review-muted)" font-size="11" text-anchor="middle"><text x="76" y="95">start / range 通知</text><text x="76" y="110">(rtpTimestamp, frames)</text><text x="250" y="95">seq と timestamp を</text><text x="250" y="110">全パケットで検算</text><text x="424" y="95">先頭・末尾の欠番も</text><text x="424" y="110">NACK 対象にする</text></g>
</svg>

### 2.1 packages/webrtc（werift 本体）

- 先頭欠落の NACK: `NackHandler.markSentFrom(seq)` を追加しました。最初に受信したパケットより前の欠番も lost として扱います。パケット受信前に呼べます。先頭で入れ替わって届いたパケットは欠番にしません。16bit の折り返しをまたぎます。実装は [packages/webrtc/src/media/receiver/nack.ts:283](review-file:packages/webrtc/src/media/receiver/nack.ts:283)、差分は [packages/webrtc/src/media/receiver/nack.ts](review-diff:packages/webrtc/src/media/receiver/nack.ts) です。
- 公開メソッド `RTCRtpReceiver.markFirstSentSequence(seq)`（nonstandard）は [packages/webrtc/src/media/rtpReceiver.ts:153](review-file:packages/webrtc/src/media/rtpReceiver.ts:153) にあります。
- `late` の計上: 諦めた後に届いたパケットを `NackStats.late` で数えます。`unrecovered` に含めたままにするので、届かなかった数は `unrecovered − late` です。判定は [packages/webrtc/src/media/receiver/nack.ts:185](review-file:packages/webrtc/src/media/receiver/nack.ts:185) の `giveUp` と `isRecent` で行います。16bit 折り返し後の同番号を late と誤判定しない窓（`RECENT_WINDOW = 4096`）を持たせています。
- `DebugConfig.inboundRtpDrop(rtp)` を追加しました。RTP ヘッダ（seq / timestamp / ssrc）で破棄を決められるため、「最初の送信だけ落とす」といった決定的なロスを作れます。呼び出しは [packages/webrtc/src/transport/debugPacketLoss.ts:61](review-file:packages/webrtc/src/transport/debugPacketLoss.ts:61)、差分は [packages/webrtc/src/transport/dtls.ts](review-diff:packages/webrtc/src/transport/dtls.ts) です。
- 再送の年齢計算: 同じパケットを relay で再度送っても、`retransmit({ maxAgeMs })` の年齢は最初の送信時刻から数えます（[packages/webrtc/src/media/rtpSender.ts:821](review-file:packages/webrtc/src/media/rtpSender.ts:821)）。

### 2.2 packages/rtp（Lipsync と JitterBuffer）

- `JitterBufferOptions.startSequenceNumber` を追加しました。先頭が後から届いても、古いものとして捨てずに順序どおり出力します（[packages/rtp/src/extra/processor/jitterBuffer.ts](review-diff:packages/rtp/src/extra/processor/jitterBuffer.ts)）。
- `Lipsync` を修正しました。全 kind が終わってから終了し、`eol` の前にバッファを時刻順に出し、最も遅い kind までで出力します。録画の末尾約 0.5 秒が欠ける問題や、遅れた kind が古いとして捨てられる問題を解消します（[packages/rtp/src/extra/processor/lipsync.ts](review-diff:packages/rtp/src/extra/processor/lipsync.ts)）。

### 2.3 example（examples/mediachannel/latency_budget）

- [examples/mediachannel/latency_budget/sendGate.ts:28](review-file:examples/mediachannel/latency_budget/sendGate.ts:28): publisher の sender transform。通過するフレームが実際に送られる RTP パケットなので、最初のフレームで `start`、停止時に `range`（最初と最後の timestamp、フレーム数）を通知します。停止後のフレームは破棄します。
- [examples/mediachannel/latency_budget/sendRange.ts:50](review-file:examples/mediachannel/latency_budget/sendRange.ts:50): `SendAccounting`。受信した 1 パケットの (seq, timestamp) から `firstSeq` を求め、他の全パケットで対応を検算します。重複は 1 回に数えます。`uniqueReceived + pending + (unrecovered − late) === frames` かつ範囲外・不一致が 0 のときだけ `balanced` です。DTX や ptime の変化などで合わなければ `unverified` と理由を返します。
- [examples/mediachannel/latency_budget/server.ts](review-diff:examples/mediachannel/latency_budget/server.ts): 上記を組み込み、`markFirstSentSequence` / `markLastSentSequence` を呼びます。ロスは `inboundRtpDrop` で決定的に作ります。
- [examples/mediachannel/latency_budget/subscriptionStart.ts:10](review-file:examples/mediachannel/latency_budget/subscriptionStart.ts:10): 購読開始位置の判定（`start` / `relay` / `before`）です。
- [examples/mediachannel/latency_budget/webmFrames.ts:27](review-file:examples/mediachannel/latency_budget/webmFrames.ts:27): 保存した WebM を読み、順序どおりに保存できた数を数えます。
- [examples/mediachannel/latency_budget/main.ts](review-diff:examples/mediachannel/latency_budget/main.ts) と [examples/mediachannel/latency_budget/player.ts](review-diff:examples/mediachannel/latency_budget/player.ts): UI と player の追従です。

## 3. 判断理由

- **推定をやめて送信側の事実と照合する**: レビューで、最初に受信したパケット、固定時間の待機、受信数からの推定が、到着順・遅延・先頭末尾のロスのどれかで破綻しました。そのため、送信側が確実に知っている値（Encoded Transform で見える `rtpTimestamp` とフレーム数）を使います。
- **seq ではなく rtpTimestamp で通知する**: Chrome の送信側 transform の metadata には `sequenceNumber` がありません（HeadlessChrome 156.0.8078.4 で確認）。一方 `rtpTimestamp` は wire 上の値と一致します。Opus 20ms は 1 フレーム 1 パケット（+960 ticks、+1 seq）なので、1 パケット受信すれば seq に変換できます。
- **照合できないときは `unverified`**: 合わない前提（DTX など）で数値を出すと誤解を招くためです。
- **先頭欠落は NackHandler の API で扱う**: 受信側だけでは先頭の欠落を検知できません。別実装にせず、末尾用の `markLastSentSequence` と対称な API にしました。
- 採用しなかった案: 受信パケット数や最大 seq からの範囲推定、固定時間の待機後に集計する方式。いずれもレビューで破綻した方式です。

## 4. レビュアーが確認すべき点・リスク

- **公開 API の追加（すべて nonstandard、既定値は互換）**: `RTCRtpReceiver.markFirstSentSequence`、`NackStats.late`、`DebugConfig.inboundRtpDrop` / `DebugRtpHeader`。`doc/` は再生成済みです（`doc/classes/RTCRtpReceiver.md`、`doc/type-aliases/NackStats.md`、`doc/type-aliases/DebugRtpHeader.md`）。
- **`late` の意味**: `unrecovered` に含めたままです。`unrecovered` を「届かなかった数」と読む既存の利用側があると意味がずれるため、`NackStats` の説明と `changelog.md` の記述を確認してください。
- **`Lipsync` の挙動変更**: `MediaRecorder` が使う共通処理で、終了条件と出力タイミングが変わります（`changelog.md` の Fixes に記載）。録画の欠落は減る想定ですが、影響範囲は example の外に及びます。
- **照合の前提**: 20ms Opus、1 フレーム 1 パケットを前提にします。前提が外れると `unverified` になる設計ですが、この判定が過剰に出ないかを確認してください。
- **`.sak-context` 配下に example のコピーが差分に含まれています**（`.sak-context/.../examples/...`）。意図した成果物かをレビューで確認してください。この文書では内容を精査していません。
- **ブラウザ依存の限界**: 自作 player は NetEQ を迂回して再生します。NetEQ そのものの挙動は変えていません。PLC の簡易化、AEC、クロックドリフトの制約は README に記載されています（[examples/mediachannel/latency_budget/README.md](review-diff:examples/mediachannel/latency_budget/README.md)）。

## 5. 検証結果

この文書の作成時点では、**テストやビルドは実行していません**。以下は差分から確認できた、追加済みのテストです。合否は実行していないため記載しません。

| 領域 | 追加・更新されたテスト | 内容 |
|---|---|---|
| NACK | [packages/webrtc/tests/media/nack.test.ts](review-diff:packages/webrtc/tests/media/nack.test.ts) | 先頭欠落、先頭の入れ替わり、16bit 折り返し、`late` の計上 |
| 再送 | [packages/webrtc/tests/media/rtpSender.test.ts](review-diff:packages/webrtc/tests/media/rtpSender.test.ts) | 再送の年齢計算 |
| 擬似ロス | [packages/webrtc/tests/transport/debugPacketLoss.test.ts](review-diff:packages/webrtc/tests/transport/debugPacketLoss.test.ts) | `inboundRtpDrop` |
| rtp | [packages/rtp/tests/processor/lipsync.test.ts](review-diff:packages/rtp/tests/processor/lipsync.test.ts)、[packages/rtp/tests/processor/jitterBuffer.test.ts](review-diff:packages/rtp/tests/processor/jitterBuffer.test.ts) | Lipsync の終了と出力順、先頭シーケンス番号 |
| 録画 | [packages/webrtc/tests/nonstandard/recorderAudioJitterBuffer.test.ts](review-diff:packages/webrtc/tests/nonstandard/recorderAudioJitterBuffer.test.ts) | 音声の並べ替え |
| example | [examples/e2e/tests/mediachannel/sendRange.test.ts](review-diff:examples/e2e/tests/mediachannel/sendRange.test.ts)、[examples/e2e/tests/mediachannel/latency_budget.test.ts](review-diff:examples/e2e/tests/mediachannel/latency_budget.test.ts) | 送信範囲の照合、smoke |

チケット 5 章の検証コマンド（`npm run type`、`npm run test:small`、`examples/e2e` の smoke、`npm run format`）の最終結果は、レビュー担当の実行ログで確認してください。
