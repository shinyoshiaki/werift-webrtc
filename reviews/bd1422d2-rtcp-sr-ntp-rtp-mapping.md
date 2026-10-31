---
ide:
  viewer: review-document
  version: 1
  title: "RTCP SR の NTP と RTP timestamp の対応修正"
  dock: right
  baseCommit: 3a68c25475b8f2c57fd5719dc08af9e371ee36e9
---
# RTCP Sender Report の NTP と RTP timestamp の対応修正

## 1. 概要

`RTCRtpSender` は SR を作るとき、最後に RTP を送った時点の NTP 時刻と RTP timestamp をそのまま使っていました。そのため、SR の NTP 時刻は実際の送信時刻より「最後の RTP 送出からの経過時間」だけ古く、RTP が止まっている間は際限なく古くなっていました。RFC 3550 §6.4.1 は、NTP timestamp を「この SR を送った時点の壁時計時刻」と定めています。

今回の変更では、SR を組み立てる時点で現在の壁時計を NTP として採取します。RTP timestamp は、NTP と RTP の対応点（アンカー）から同じ時刻まで外挿した値を使います。あわせて、`ntpTime()` / `ntpTimeToEpochMs()` の NTP 小数部を RFC 3550 §4 の定義（`fraction / 2^32`）に直しました。これが直っていないと、同じ秒内の SR が区別できないためです。

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

- 旧フィールド `ntpTimestamp` / `rtpTimestamp` を廃止し、`rtpClockAnchor`（`performance.now()`、RTP ts、clockRate）に置き換えました。[packages/webrtc/src/media/rtpSender.ts:195](review-file:packages/webrtc/src/media/rtpSender.ts:195)
- `buildSenderReport()` が現在時刻の NTP を採取します。アンカーからの経過 ms に clockRate を掛けた値を 32bit で加算し、RTP ts とします。LSR（`lastSRtimestamp`）も、実際に送る NTP の中央 32bit から計算します。変更の核は [packages/webrtc/src/media/rtpSender.ts:645](review-diff:packages/webrtc/src/media/rtpSender.ts:645) です。
- `updateRtpClockAnchor()` は、より新しい RTP ts を持つ最初のパケットでアンカーを動かします。同一 ts（フレーム分割）、3 秒以内の古い ts（遅着・B フレームの並べ替え）、RTX 再送ではアンカーを動かしません。[packages/webrtc/src/media/rtpSender.ts:675](review-diff:packages/webrtc/src/media/rtpSender.ts:675)
- 3 秒（`RTP_CLOCK_ANCHOR_MAX_REORDER_SEC`）を超えて ts が巻き戻ったときは、continuity rewrite なしのソース不連続とみなしてアンカーを張り直します。以前は新しい ts しか受け付けなかったため、ソースが ts を巻き戻すと（最大 2^31 tick、90kHz で約 6.6 時間）、SR が旧タイムラインから外挿され続けていました。[packages/webrtc/src/media/rtpSender.ts:95](review-diff:packages/webrtc/src/media/rtpSender.ts:95)
- continuity rewrite の境界パケット（`replaceTrack` / `replaceRTP` / `onSourceChanged`）ではアンカーを張り直します。境界では出力 ts が `timestampStep` しか進まず、経過した壁時計時間は反映されないためです。[packages/webrtc/src/media/rtpSender.ts:783](review-diff:packages/webrtc/src/media/rtpSender.ts:783)
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

- `ntpTime()` は、小数部を「秒の小数のデシマル桁」で書いていました。これを `fraction / 2^32` に直し、引数 `epochMs` を任意で受け取れるようにしました。[packages/webrtc/src/utils.ts:86](review-diff:packages/webrtc/src/utils.ts:86)
- `ntpTimeToEpochMs()` も同じ定義に揃えました。`ntpTime2Sec()` は develop で既に `fraction / 2^32` に直っており、今回はコメントの追加だけです。[packages/rtp/src/rtcp/sr.ts:133](review-diff:packages/rtp/src/rtcp/sr.ts:133)
- abs-send-time（`serializeAbsSendTime`）は、64bit NTP の `>> 14` の下位 24bit を 6.18 固定小数点として使います。コードは変えていませんが、入力の小数部が正しくなったので値も正しくなります。
- `NtpTimeBase` の RTP ts 差分を 32bit 符号付き差分にしました。SR が wrap 後、遅延パケットが wrap 前というケースで、約 26.5 時間（90kHz の例）ずれる不具合を防ぎます。差分は RTP ごとに基準を更新しながら取るので、符号付き 32bit の範囲（90kHz で約 6.6 時間）を超えることはありません。[packages/rtp/src/extra/processor/ntpTime.ts:126](review-diff:packages/rtp/src/extra/processor/ntpTime.ts:126)

### 2.3 テストと changelog

- SR の時計対応のテスト群を追加しました。即時 SR、700ms 後の SR、90kHz、32bit wrap、同一 ts、遅着、3 秒を超える巻き戻り（wrap またぎを含む）と 3 秒ちょうどの巻き戻り、continuity 境界、clockRate 変更、長い idle、LSR の差、`runRtcp` が対象です。実際の SR を `NtpTimeBase` に渡し、wrap 後の SR と wrap 前の遅延パケットが SR の 500ms 前になる結合テストも含みます。[packages/webrtc/tests/media/rtpSender.test.ts:1529](review-file:packages/webrtc/tests/media/rtpSender.test.ts:1529)
- NTP 変換のテストも追加しました。[packages/webrtc/tests/utils.test.ts](review-diff:packages/webrtc/tests/utils.test.ts) / [packages/rtp/tests/processor/ntpTime.test.ts](review-diff:packages/rtp/tests/processor/ntpTime.test.ts) / [packages/rtp/tests/rtcp/rtcp.test.ts](review-diff:packages/rtp/tests/rtcp/rtcp.test.ts)
- 利用者向けの変更は [changelog.md](review-diff:changelog.md) の Unreleased に記載しました。

## 3. 判断理由

RFC 3550 と libwebrtc（Chromium ミラーの `main`、`modules/rtp_rtcp/source/rtcp_sender.cc` / `rtp_rtcp_impl2.cc` / `rtcp_receiver.cc`）を照合しました。

| 項目 | RFC 3550 / libwebrtc | werift（本変更後） |
| --- | --- | --- |
| SR の NTP | §6.4.1: SR を送った時点の壁時計。libwebrtc は `ConvertTimestampToNtpTime(ctx.now_)` | `performance.timeOrigin + performance.now()` から生成 |
| SR の RTP ts | §6.4.1: NTP と同じ瞬間の値で、隣接パケットの ts とは通常一致しない。壁時計との関係から算出する（MUST）。libwebrtc は `last_rtp_timestamp_ + (now_ms - last_frame_capture_time_ms) * rtp_rate_khz` | アンカー ts + 経過 ms × clockRate / 1000（32bit wrap） |
| アンカーの更新 | libwebrtc の `SetLastRtpTime` はフレームを送るたびに無条件で上書きし、capture time（音声は呼び出し時刻）を使う | 新しい ts の最初の送出時刻。3 秒以内の巻き戻りは無視し、それを超える巻き戻りでは張り直す |
| 最初のメディア前の SR | libwebrtc は送らない（`can_calculate_rtp_timestamp`） | `runRtcp()` は最初の RTP 送出後に起動するので、送らない |
| NTP 形式 / LSR | §4: 小数部は 2^-32 秒単位。§6.4.1: LSR は NTP の中央 32bit | `fraction / 2^32`、`compactNtp()` |
| RTT | §6.4.1: `A - LSR - DLSR`。libwebrtc は compact NTP で任意の report block から計算 | 最後の SR と LSR が一致した report block だけを使い、`Date.now()` 差分 − DLSR で計算（一致時は同じ値） |

- **libwebrtc 方式の外挿を採用**: 外挿の式は libwebrtc の `BuildSR` と同じです。libwebrtc は整数 kHz の clock rate を使いますが（44.1kHz は 44 になる）、werift は正確な clockRate で計算します。
- **アンカーは「最新 ts の最初のパケット」の送出時刻**: werift は capture 時刻を知らないため、送出時刻で近似します。libwebrtc はエンコーダ出力のフレーム順に更新しますが、werift はリレー RTP の遅着や B フレームで ts が前後するため、小さな巻き戻りではアンカーを動かしません。一方、3 秒を超える巻き戻りではソース不連続として張り直し、libwebrtc と同じく最新の送出に追従します。パケット数や `setInterval` の周期を媒体時計とみなす案は、チケットが明示的に避けているため採りませんでした。
- **単調時計 `performance.now()` で経過を測る**: 壁時計 `Date.now()` が調整されても外挿が飛ばないようにするためです。libwebrtc も、単調時計の時刻を NTP に変換して SR に載せています。

## 4. レビュアーが確認すべき点・リスク

- **既存挙動の互換性**: NTP の小数部の符号化が変わります。影響範囲は次のとおりです。
  - SR を受け取る側は、以前の誤った値でなく正しい 2^32 分率を受け取ります。
  - `ntpTime()` を使う abs-send-time も影響を受けます。
  - 公開関数の `ntpTime()` / `ntpTimeToEpochMs()` の戻り値の意味が変わります（`ntpTime2Sec()` は develop で既に変更済み）。外部利用者への影響は changelog の記述で足りるか確認してください。
- **近似の限界**: リレー RTP では、送出ジッタがそのまま SR の対応誤差になります（changelog に Limitation として記載済み）。
- **アンカー更新条件**: 32bit 符号付き差分で比較するので、RTP ts の wrap は正しく扱います。3 秒以内の巻き戻りは並べ替えとみなすため、ソースが 3 秒以内だけ ts を巻き戻した場合は、新しい ts が旧アンカーに追いつくまで（最大 3 秒）、その分の誤差が残ります。閾値の 3 秒が妥当か確認してください。
- **RTP 停止中の SR**: RFC 3550 §6.4 では、直近 2 回の報告間隔に RTP を送っていない参加者は sender ではなく、RR を送ります。werift は libwebrtc と同じく、送信中は RTP が止まっても SR を送り続け、RTP ts を壁時計に沿って外挿します。この挙動は今回変えていません。

## 5. 検証結果

本文書の更新時（HEAD `2876df23d` に未コミットの修正を載せた状態）に、次の検証を実行しました。

| 対象 | 結果 |
| --- | --- |
| `packages/webrtc`: 型検査（`tsc --noEmit`、TypeScript 6.0.3） | 成功 |
| `packages/webrtc`: `tests/media/rtpSender.test.ts` `tests/utils.test.ts` | 2 ファイル / 88 テスト 成功 |
| `packages/webrtc`: `npm test`（全テスト） | 917 成功 / 2 失敗 / 5 スキップ |
| `packages/rtp`: `tests/processor/ntpTime.test.ts` `tests/rtcp/rtcp.test.ts` | 2 ファイル / 13 テスト 成功 |

- 型検査を TypeScript 6.0.3 で実行したのは、環境の `node_modules` の TypeScript が 5.7.3 で、package.json の指定（6.0.3）と合わず、`npm run type` が `tsconfig.json` の TS5095 で止まるためです。
- 全テストで失敗した 2 件は `tests/nonstandard/polyfill.test.ts` の DOM lib コンパイルテストです。原因は同じく古い `node_modules` です（TypeScript 5.7.3 による TS5095。TypeScript 6.0.3 で実行しても、`@types/dom-webcodecs` が lockfile の 0.1.19 でなく 0.1.13 のため型が衝突します）。本変更は polyfill と tsconfig を変えていません。

次の項目は実行していません。

- `npm run type`
- `npm run test:small`
- `npm run ci`
- E2E（Chrome の `remote-outbound-rtp` や A/V 同期の確認を含む）
- WPT
