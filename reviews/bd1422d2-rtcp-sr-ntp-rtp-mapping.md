---
ide:
  viewer: review-document
  version: 1
  title: "RTCP SR の NTP と RTP timestamp の対応修正"
  dock: right
  baseCommit: b5e4214fe0dc97029075e8dfb10a4de3cdaa5666
---
# RTCP Sender Report の NTP と RTP timestamp の対応修正

## 1. 概要

`RTCRtpSender` は SR を作るとき、最後に RTP を送った時点の NTP 時刻と RTP timestamp をそのまま使っていました。そのため、SR の NTP 時刻が実際の送信時刻より最大 1.5 秒、RTP が止まっている間はそれ以上古くなっていました。

今回の変更では、SR を組み立てる時点で現在の壁時計を NTP として採取します。RTP timestamp は、NTP と RTP の対応点（アンカー）から同じ時刻まで外挿した値を使います。あわせて、NTP の小数部を RFC 3550 の定義（`fraction / 2^32`）に直しました。これが直っていないと、同じ秒内の SR が区別できないためです。

<div style="display:flex;gap:12px">
  <div style="flex:1;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px">
    <strong>Before</strong><br>SR = 最後の RTP 送出時の (NTP, RTP ts)。<br>RTP が止まると同じ値を繰り返す。
  </div>
  <div style="flex:1;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px">
    <strong>After</strong><br>SR = SR 生成時の NTP と、アンカーから clockRate で外挿した RTP ts。<br>idle 中も壁時計に沿って進む。
  </div>
</div>

## 2. 主要変更

### 2.1 SR 生成の変更（`packages/webrtc`）

- 旧フィールド `ntpTimestamp` / `rtpTimestamp` を廃止し、`rtpClockAnchor`（`performance.now()`、RTP ts、clockRate）に置き換えました。[packages/webrtc/src/media/rtpSender.ts:176](review-file:packages/webrtc/src/media/rtpSender.ts:176)
- `buildSenderReport()` が現在時刻の NTP を採取します。アンカーからの経過 ms に clockRate を掛けた値を 32bit で加算し、RTP ts とします。LSR（`lastSRtimestamp`）も実際に送る NTP から計算します。変更の核は [packages/webrtc/src/media/rtpSender.ts:634](review-diff:packages/webrtc/src/media/rtpSender.ts:634) です。
- `updateRtpClockAnchor()` は、より新しい RTP ts を持つ最初のパケットでだけアンカーを動かします。同一 ts（フレーム分割）、古い ts（遅着）、RTX 再送ではアンカーを動かしません。[packages/webrtc/src/media/rtpSender.ts:661](review-diff:packages/webrtc/src/media/rtpSender.ts:661)
- continuity rewrite の境界パケット（`replaceTrack` / `replaceRTP` / `onSourceChanged`）ではアンカーを張り直します。境界では出力 ts が `timestampStep` しか進まず、経過した壁時計時間は反映されないためです。[packages/webrtc/src/media/rtpSender.ts:767](review-diff:packages/webrtc/src/media/rtpSender.ts:767)
- clockRate が変わったときもアンカーを張り直します。

<svg viewBox="0 0 560 120" width="100%" role="img" aria-label="アンカーからの外挿">
  <g stroke="var(--review-muted)"><line x1="30" y1="70" x2="530" y2="70"/></g>
  <g fill="var(--review-accent)"><circle cx="110" cy="70" r="6"/></g>
  <g fill="var(--review-warning)"><circle cx="440" cy="70" r="6"/></g>
  <g stroke="var(--review-accent)" fill="none"><path d="M116 70 L434 70" stroke-dasharray="4 4"/></g>
  <g fill="var(--review-fg)" font-size="12" text-anchor="middle">
    <text x="110" y="52">アンカー（最新 ts の初送出）</text>
    <text x="440" y="52">SR 生成時刻</text>
    <text x="275" y="92">RTP ts = anchor ts + 経過ms × clockRate / 1000（32bit wrap）</text>
    <text x="440" y="108">NTP = 現在の壁時計</text>
  </g>
</svg>

### 2.2 NTP の小数部（`packages/webrtc` / `packages/rtp`）

- `ntpTime()` は、小数部を「秒の小数のデシマル桁」で書いていました。これを `fraction / 2^32` に直し、引数 `epochMs` を任意で受け取れるようにしました。[packages/webrtc/src/utils.ts:87](review-diff:packages/webrtc/src/utils.ts:87)
- `ntpTimeToEpochMs()` と `ntpTime2Sec()` も同じ定義に揃えました。[packages/rtp/src/rtcp/sr.ts:132](review-diff:packages/rtp/src/rtcp/sr.ts:132)
- `NtpTimeBase` の RTP ts 差分を 32bit 符号付き差分にしました。SR が wrap 後、遅延パケットが wrap 前というケースで、約 26 時間ずれる不具合を防ぎます。[packages/rtp/src/extra/processor/ntpTime.ts:125](review-diff:packages/rtp/src/extra/processor/ntpTime.ts:125)

### 2.3 テストと changelog

- SR の時計対応のテスト群を追加しました。即時 SR、700ms 後の SR、90kHz、32bit wrap、同一 ts、遅着、continuity 境界、clockRate 変更、長い idle、LSR の差、`runRtcp` が対象です。[packages/webrtc/tests/media/rtpSender.test.ts:1277](review-file:packages/webrtc/tests/media/rtpSender.test.ts:1277)
- NTP 変換のテストも追加しました。[packages/webrtc/tests/utils.test.ts](review-diff:packages/webrtc/tests/utils.test.ts) / [packages/rtp/tests/processor/ntpTime.test.ts](review-diff:packages/rtp/tests/processor/ntpTime.test.ts) / [packages/rtp/tests/rtcp/rtcp.test.ts](review-diff:packages/rtp/tests/rtcp/rtcp.test.ts)
- 利用者向けの変更は [changelog.md](review-diff:changelog.md) の Unreleased に記載しました。

## 3. 判断理由

- **libwebrtc 方式の外挿を採用**: libwebrtc の `RTCPSender::BuildSR` は、最後のフレームの RTP ts に、経過時間と clock rate から求めた増分を足します。werift も同じ方式にしました。
- **アンカーは「最新 ts の最初のパケット」の送出時刻**: werift は capture 時刻を知らないため、送出時刻で近似します。パケット数や `setInterval` の周期を媒体時計とみなす案は、チケットが明示的に避けているため採りませんでした。
- **単調時計 `performance.now()` で経過を測る**: 壁時計 `Date.now()` が調整されても外挿が飛ばないようにするためです。NTP 値は `performance.timeOrigin + now` から作ります。

## 4. レビュアーが確認すべき点・リスク

- **既存挙動の互換性**: NTP の小数部の符号化が変わります。次の二点が影響範囲です。
  - SR を受け取る側は、以前の誤った値でなく正しい 2^32 分率を受け取ります。
  - `ntpTime()` を使う abs-send-time も影響を受けます。
  - 公開関数の `ntpTime()` / `ntpTimeToEpochMs()` / `ntpTime2Sec()` の戻り値の意味が変わるため、外部利用者への影響は changelog の記述で足りるか確認してください。
- **近似の限界**: リレー RTP では、送出ジッタがそのまま SR の対応誤差になります（changelog に Limitation として記載済み）。
- **アンカー更新条件**: `uint32Gt` による比較なので、RTP ts の wrap は正しく扱います。ただし、ソースが ts を大きく巻き戻した場合は continuity rewrite 経由でないと張り直されません。
- **作業ツリーの差分**: 検証時点で `packages/webrtc/tests/media/rtpSender.test.ts` に import 順序だけの未コミット差分がありました（`NtpTimeBase` の import 位置）。本文書の作成者が加えたものではなく、機能への影響はありません。

## 5. 検証結果

本文書の作成時に、次のテストを実行しました。

| 対象 | 結果 |
| --- | --- |
| `packages/webrtc`: `tests/media/rtpSender.test.ts` `tests/utils.test.ts` | 2 ファイル / 77 テスト 成功 |
| `packages/rtp`: `tests/processor/ntpTime.test.ts` `tests/rtcp/rtcp.test.ts` | 2 ファイル / 8 テスト 成功 |

次の項目は実行していません。

- `npm run type`
- `npm run test:small`
- `npm run ci`
- E2E
- WPT
