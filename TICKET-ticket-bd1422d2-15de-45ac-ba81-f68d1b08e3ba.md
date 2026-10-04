## Summary

`RTCRtpSender` currently caches the NTP time and RTP timestamp when the most recent RTP packet is dispatched, then reuses that cached pair when emitting a later RTCP Sender Report (SR).

That means an SR sent substantially after the last RTP packet can advertise an **old NTP timestamp** instead of the wall-clock time when the SR is actually sent.

RFC 3550 defines the SR NTP timestamp as the wall-clock time when the report is sent, and the SR RTP timestamp as the RTP-clock value corresponding to that same instant.

## Current behavior

The sender updates the cached pair while sending RTP:

```ts
const ntpTimestamp = ntpTime();
...
this.ntpTimestamp = ntpTimestamp;
this.rtpTimestamp = header.timestamp;
```

Later, `runRtcp()` builds the Sender Report using the cached values:

```ts
new RtcpSenderInfo({
  ntpTimestamp: this.ntpTimestamp,
  rtpTimestamp: this.rtpTimestamp,
  ...
})
```

So, for example:

```text
last RTP packet sent at t = 10.000 s
  RTP timestamp = 480000

RTCP SR actually sent at t = 10.700 s

current SR reports:
  NTP = 10.000 s
  RTP = 480000
```

The NTP value is stale by 700 ms.

This can also distort RTT calculations that use the SR's LSR/DLSR fields, because the NTP timestamp no longer represents the report transmission time.

## Expected behavior

At SR generation time:

1. Sample the **current NTP/wall-clock time**.
2. Report an RTP timestamp corresponding to that same instant in the sender's RTP clock domain.

For a continuously advancing 48 kHz audio clock, conceptually:

```text
anchor:
  NTP = 10.000 s
  RTP = 480000

SR generated at:
  NTP = 10.700 s

SR RTP timestamp:
  approximately 480000 + 0.700 * 48000
  = 513600
```

The exact implementation should respect the sender's actual media clock and not assume that packet send cadence itself defines sampling time.

## Design considerations

This needs care for:

- raw RTP relay sources whose timestamps originate elsewhere,
- silence suppression / gaps,
- codecs with different clock rates,
- timestamp wraparound,
- source replacement / continuity rewriting,
- delayed or jittery packet delivery.

A robust implementation likely needs to maintain an explicit NTP↔RTP clock anchor rather than simply extrapolating from packet-count or `setInterval` cadence.

## Suggested tests

- SR emitted immediately after RTP: mapping remains close to the last packet anchor.
- SR emitted hundreds of milliseconds after the last RTP packet: NTP reflects SR send time, not the previous RTP send time.
- RTP timestamp corresponds to the same instant as the SR NTP timestamp.
- 32-bit RTP timestamp wraparound.
- 48 kHz audio and 90 kHz video clock rates.
- sender with source replacement / RTP continuity rewrite.
- long idle gap / silence-suppression-like behavior.

## Related downstream finding

This was noticed while reviewing OpenClaw PR https://github.com/openclaw/openclaw/pull/146078, which fixed a separate RTP media-clock drift issue in its `werift`-backed GPT-Live sender. That downstream bug should remain fixed in OpenClaw; this issue is specifically about werift's own RTCP SR timestamp semantics.

---

# 詳細化（コードベース調査結果）

## 1. 目的と背景

- RFC 3550 §6.4.1 では SR の NTP timestamp は「**SR を送信する時点**の壁時計時刻」、RTP timestamp は「**同じ瞬間**に対応する RTP クロック値」と定義されている。RTP timestamp は直前のデータパケットの値と一致しなくてもよい。
- werift の `RTCRtpSender` は、最後に RTP を送った時点の `(ntpTime(), header.timestamp)` を保持し、`runRtcp()` の SR でそのまま使っている。このため SR の NTP が最大 1.5 秒程度（RTP が止まっている間はそれ以上）古くなる。受信側（ブラウザ）は A/V 同期（lip-sync）や `remote-outbound-rtp.remoteTimestamp` を SR の NTP↔RTP 対応から求めるので、ここが壊れていると同期がずれ、stats も不正確になる。
- 参考: libwebrtc の `RTCPSender::BuildSR` は「最後のフレームの RTP timestamp + 最後のフレームから現在までの経過時間 × clock rate」で SR の RTP timestamp を外挿している。本チケットもこの方式に合わせる。

## 2. 現状コードの調査結果

### 対象箇所（`packages/webrtc/src/media/rtpSender.ts`）

| 箇所 | 内容 |
| --- | --- |
| L173-174 | `private ntpTimestamp = 0n; private rtpTimestamp = 0;`（SR 用のキャッシュ） |
| L641 | `dispatchRtp()` 内の `const ntpTimestamp = ntpTime();`（abs-send-time 拡張にも使用） |
| L691-692 | 送出のたびに `this.ntpTimestamp` / `this.rtpTimestamp` を**全パケットで**上書きしている |
| L494-541 | `runRtcp()`: `500 + rand*1000` ms ごとにキャッシュ値で `RtcpSenderInfo` を作り、`lastSRtimestamp = compactNtp(this.ntpTimestamp)` と `lastSentSRTimestamp = timestampSeconds()` を記録 |
| L713 | `runRtcp()` は最初の RTP を送出したときに起動される（RTP 未送出のまま SR が出ることはない） |
| L728-747 | `handleRtcpPacket()`: `report.lsr === lastSRtimestamp` が一致したとき `RTT = now - lastSentSRTimestamp - dlsr/65536` を計算 |
| L607-638 | `dispatchRtp()`: `timestampOffset` / `seqOffset` による continuity rewrite（`replaceTrack` / `onSourceChanged` / `replaceRTP`）。書き換え後の `header.timestamp` が出力タイムライン |
| L274-288 | `this.codec`（送出 codec。RED の場合は `sendPrimaryCodec` が実 primary）。`RTCRtpCodecParameters.clockRate` は必須フィールド |

### RTT への影響（チケット本文の補足）

- werift 自身の RTT 計算は SR の NTP ではなく `lastSentSRTimestamp`（`Date.now()`）を使うので、NTP が古くても RTT 値が直接ずれるわけではない。
- ただし、**RTP が止まっている間に出た複数の SR は NTP が同じ値になり、LSR（`compactNtp`）も同じ値になる**。このとき受信側が古い SR を LSR として返しても `lastSRtimestamp` と一致してしまう。その結果、最新 SR の送信時刻を使って RTT を計算し、**RTT を過小評価する**。SR ごとに NTP を採り直すとこの衝突も解消される。

### 関連する既存不具合: NTP fraction のエンコードが RFC と異なる

`packages/webrtc/src/utils.ts` の `ntpTime()` は、秒の文字列を `"."` で分割した小数部の**10 進の数字列をそのまま整数**として fraction フィールドに入れている。

```text
seconds.toString() = "4000115502.9875374"
→ [sec, frac] = [4000115502, 9875374]   // 正しくは 0.9875374 * 2^32 ≈ 4241378000
```

- 対になるデコーダの `ntpTimeToEpochMs()`（fraction をミリ秒として扱う）や `packages/rtp/src/rtcp/sr.ts` の `ntpTime2Sec()`（`Number(\`${sec}.${frac}\`)`）も同じ独自形式を前提にしている。そのため werift 同士では見かけ上整合するが、ブラウザとは互換性がない。
- abs-send-time（`serializeAbsSendTime(ntp)` は `(ntp >> 14) & 0xffffff`）も同じ値から作られるため、影響を受ける。
- **本チケットとの切り分け**: SR の RTP timestamp の外挿は NTP の差分ではなく**単調時計（`performance.now()`）の差分**で計算すれば、エンコード不具合とは独立に直せる。NTP エンコードの修正はエンコーダ・デコーダ（`ntpTime` / `ntpTimeToEpochMs` / `ntpTime2Sec` / `NtpTimeBase`）と abs-send-time に同時に影響するので、**別チケットとして起票する**ことを推奨する。本チケットでは、SR 生成用に「指定した epoch ms から NTP を作る」入口（例: `ntpTime(nowMs?)` の引数化）を用意し、後で正しいエンコードへ差し替えやすくしておく。

## 3. 実装すべき変更内容

1. **NTP↔RTP クロックアンカーを導入する**（`RTCRtpSender` 内の private state）
   - `rtpAnchor?: { monotonicMs: number; rtpTimestamp: number; clockRate: number }` のような構造にする。
   - 更新は `dispatchRtp()` で、continuity rewrite 後の `header.timestamp` を使う。
   - **更新条件**: 出力 timestamp がアンカーより新しい場合（32bit serial number 比較、RFC 1982）だけ更新する。こうすると次のように扱える。
     - 同じ timestamp の後続パケット（映像フレームの分割など）はアンカーを動かさない。フレームの先頭パケットの送出時刻を基準にし、ペーシングや送出遅延で後ろにずれないようにする。
     - 古い timestamp（再順序・relay の遅着パケット）は無視する。
   - **リセット条件**: continuity rewrite で `timestampOffset` を確定したとき、codec（clockRate）が変わったときは、そのパケットでアンカーを張り直す（serial 比較をスキップ）。
   - NACK による RTX 再送（`handleRtcpPacket` 内の `dtlsTransport.sendRtp`）ではアンカーを更新しない。
2. **SR 生成を純粋なメソッドに切り出す**（例: `private buildSenderReport(nowEpochMs, nowMonotonicMs): RtcpSrPacket`、テストから呼べる粒度にする）
   - 時刻は**一度だけ**サンプルし、NTP と RTP の両方をその値から作る。
   - `ntpTimestamp = ntpTime(nowEpochMs)`（`utils.ts` の `ntpTime` に任意引数を追加し、既存の引数なし呼び出しとの互換を保つ）。
   - `rtpTimestamp = uint32Add(anchor.rtpTimestamp, Math.round((nowMonotonicMs - anchor.monotonicMs) * clockRate / 1000))`
     - `uint32Add`（既存の `@werift/common` ユーティリティ）で 32bit wrap を処理する。
     - 経過時間が負になるケース（時計の戻り）は 0 に clamp する。単調時計を使えば通常は起きない。
   - `lastSRtimestamp = compactNtp(ntpTimestamp)` は、**実際に SR に入れた NTP** から計算する。
3. **`runRtcp()` を修正**: キャッシュ値ではなく `buildSenderReport()` の結果を送出する。SDES (CNAME) の付与などの既存の挙動は変えない。
4. **旧フィールドの整理**: `ntpTimestamp` / `rtpTimestamp` キャッシュは削除するか、アンカーへ置き換える。`dispatchRtp()` の `ntpTime()` は abs-send-time 専用として残す。
5. **既存テストの更新**: `tests/media/rtpSender.test.ts:1173`「RTCP SR の rtpTimestamp は書き換え後値…」は `(sender as any).rtpTimestamp` を直接参照しているので、アンカー（または `buildSenderReport()` の出力）を検証する形に書き換える。

## 4. 技術的アプローチの要点

- **時計**: 経過時間の計算には `performance.now()`（単調時計）を使い、SR の壁時計 NTP には `performance.timeOrigin + performance.now()` を使う（既存 `ntpTime()` と同じ基準）。同じ `performance.now()` のサンプルから両方を作れば、同一瞬間の対応になる。
- **テスト容易性**: `runRtcp()` は 500〜1500 ms のランダム待ちなので、待ってからテストするのは遅く、不安定になる。時刻を引数で受け取る `buildSenderReport()` を直接呼ぶか、`vi.useFakeTimers({ toFake: ["performance", "Date", ...] })` で時刻を進める。前者の方が決定的で推奨。
- **clockRate の取得**: `this.codec.clockRate` を使う。RED の場合は `sendPrimaryCodec?.clockRate ?? this.codec.clockRate` で primary 側を優先する（RED/opus はどちらも 48000）。
- **relay（外部由来 timestamp）**: werift は capture time を知らないので、「フレーム先頭パケットの送出時刻 ≈ そのフレームのサンプリング時刻」と近似する。この近似の限界（送出ジッタがそのまま SR の誤差になる）はコメントと docs に明記する。平滑化（ジッタフィルタ）は本チケットでは行わず、必要になったら follow-up とする。
- **無音・長時間の idle**: RFC どおり、壁時計に合わせて外挿し続ける（libwebrtc と同じ）。DTX/無音抑圧で timestamp が飛んでも、次のパケットの timestamp はアンカーより新しいのでアンカーを張り直し、整合が回復する。

## 5. 考慮すべき制約・注意点

- **32bit wrap**: アンカー比較（serial number arithmetic）と外挿加算の両方で wrap を正しく扱う。`>>> 0` / `uint32Add` を使い、JS の number 精度に注意する。
- **source replacement**: continuity rewrite の境界では `timestampStep`（既定 1）しか進まない。そのため、壁時計の経過と出力 timestamp の経過が一致しない。境界パケットでアンカーをリセットし、旧ソースのアンカーから外挿しないようにする。既存の continuity テスト群（`describe("media/rtpSender RTP continuity")`）を壊さないこと。
- **codec 切替**（`prepareSend` での再ネゴシエーション）: clockRate が変わったらアンカーを無効化する。
- **SR を送るタイミング**: RTP 未送出の間は `runRtcp()` が起動しないという既存の前提を維持する。RFC 3550 §6.4 の「直近 2 回の報告間隔で送信していない sender は RR に切り替える」は本チケットの範囲外とし、必要なら別チケットにする。
- **公開 API は変えない**: `RTCRtpSender` の public シグネチャ、`replaceRTP()` の引数の意味、`sendRtp()` の Promise の意味は変更しない。
- **NTP エンコード不具合（§2）は本チケットで直さない**。ただし、テストで NTP の値を検証する場合は既存の独自形式に依存しないようにする。検証は `buildSenderReport()` に渡した入力時刻との対応で行う。
- **パッケージ境界**: 変更は `packages/webrtc` 内で完結する。`packages/rtp` の `RtcpSenderInfo` は変更不要。
- AGENTS.md に従い、根本原因を修正する。既存テストを緩めて通すことはしない。

## 6. テスト計画（`packages/webrtc/tests/media/rtpSender.test.ts`）

- Arrange は既存の `tests/fixture.ts`（`createConnectedRtpSender` / `createRtpPacket` / `sentRtpHeaders`）を再利用する。SR 用の共通 Arrange（時刻を固定した sender の生成など）が必要になった場合も `tests/fixture.ts` に追加する。
- Act / Assert には日本語コメントを付ける。

| # | ケース | 期待値 |
| --- | --- | --- |
| 1 | RTP 送出直後に SR を生成 | RTP ts ≈ アンカー ts（差は 0〜数 tick） |
| 2 | 最後の RTP から 700 ms 後に SR（48 kHz） | NTP が SR 生成時刻に対応し、RTP = anchor + 33600 |
| 3 | 90 kHz の video で 700 ms 後 | RTP = anchor + 63000 |
| 4 | アンカー ts = `0xffffff00` 付近で外挿 | 32bit wrap 後の値（`>>> 0`）になる |
| 5 | 同じ timestamp の複数パケット（フレーム分割）を時間差で送出 | アンカーは先頭パケットの時刻のまま |
| 6 | 古い timestamp の遅着パケット | アンカーを後退させない |
| 7 | `replaceTrack` / `replaceRTP` による continuity rewrite の直後 | アンカーは書き換え後の境界パケットに張り直され、SR の RTP ts は書き換え後のタイムライン上にある（既存 L1173 テストの置き換え） |
| 8 | 数秒の idle 後に SR → 再開パケット | idle 中は壁時計に沿って外挿し、再開後は新アンカーに基づく |
| 9 | RTP が止まったまま SR を 2 回生成 | 2 回の NTP / LSR が異なる（LSR 衝突による RTT 過小評価の回帰防止） |
| 10 | `runRtcp()` 経由の送出（既存の abort テストと同等の短時間テスト、または fake timers） | `dtlsTransport.sendRtcp` に渡った SR がキャッシュ値ではなく生成時刻ベースになっている |

## 7. 完了条件

- [ ] `runRtcp()` が送る SR の NTP timestamp が、SR 生成時点の時刻をサンプルした値になっている。
- [ ] SR の RTP timestamp が、同じ瞬間に対応するように `clockRate` で外挿されている（32bit wrap 対応）。
- [ ] アンカーはフレーム先頭（より新しい timestamp）でだけ進む。continuity rewrite と codec 変更ではリセットされる。RTX 再送では更新されない。
- [ ] `lastSRtimestamp`（LSR 照合用）が、実際に送った SR の NTP から計算されている。
- [ ] §6 のテストが追加され、既存テスト（特に RTP continuity 群・L1173 の置き換え）がすべて通る。
- [ ] `cd packages/webrtc && npm run type && npm test` が通る。
- [ ] 必要に応じて、ブラウザとの相互接続（`npm run e2e`）で受信側の `remote-outbound-rtp` stats や A/V 同期に退行がないことを確認する（可能な範囲で）。
- [ ] NTP fraction エンコード不具合（`ntpTime` / `ntpTimeToEpochMs` / `ntpTime2Sec` / abs-send-time）について、follow-up チケットを起票する。
- [ ] 挙動の変更点（relay では送出時刻を capture time の近似として使う、という限界）を、該当コードのコメントと必要に応じて docs / changelog に記載する。
