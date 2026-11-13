# RTCRtpSender RTT should accept Receiver Reports that reference older Sender Reports

## 1. 目的と背景

- `RTCRtpSender` は、受信した RR / SR の report block の `LSR` が**直近に送った 1 つの SR** と一致したときだけ RTT を更新している。SR A → B → C の順に送った後で A や B を参照する RR が届くと、そのサンプルは捨てられる。
- RTCP は遅延・キューイング・TURN 中継などで普通に遅れる。RFC 3550 §6.4.1 の RTT は「RR の `LSR` が指す SR」を基準に計算するもので、「ローカルが最後に送った SR」を基準にするものではない。
- 下流の `Rkcr007/mfarm-cloud` (https://github.com/Rkcr007/mfarm-cloud/pull/273) で、帯域制約のある TURN 経路と実 Chrome 受信側の組み合わせで再現した。経路が詰まるほど RTT が stale のまま更新されなくなる。下流では有界な `SenderReportLog`(LSR → 送信時刻)を入れて回避している。
- 影響を受けるもの: `RTCRemoteInboundRtpStreamStats.roundTripTime` / `totalRoundTripTime` / `roundTripTimeMeasurements`、送信 RTT を使う輻輳制御・適応ロジック・診断。
- #701(SR の NTP/RTP ペアが SR 送信時刻を表していない問題)とは別件。#701 が直っても、最新 SR だけを持つ実装では遅れて届いた正当な RR を照合できない。

## 2. 現状のコード調査結果

### 対象: `packages/webrtc/src/media/rtpSender.ts`

| 箇所 | 内容 |
| --- | --- |
| L91 | `const RTT_ALPHA = 0.85;`(RTT の EWMA 係数) |
| L171-180 | `lastSRtimestamp?` / `lastSentSRTimestamp?` / `ntpTimestamp = 0n` / `rtt?` / `totalRoundTripTime` / `roundTripTimeMeasurements` |
| L494-539 `runRtcp()` | 500〜1500ms ごとに SR(+SDES)を組み立て、`lastSRtimestamp = compactNtp(this.ntpTimestamp)` と `lastSentSRTimestamp = timestampSeconds()` で**上書き**してから `dtlsTransport.sendRtcp()` を呼ぶ。送信に失敗しても記録は残る |
| L641, L691 `sendRtp()` | `this.ntpTimestamp = ntpTime()` は **最後に RTP を送った時刻**。SR 送信時刻ではない(#701) |
| L724-753 `handleRtcpPacket()` | SR/RR の `reports` を `report.ssrc === this.ssrc` で絞り込み、`this.lastSRtimestamp === report.lsr && report.dlsr` のときだけ `rtt = timestampSeconds() - lastSentSRTimestamp - dlsr/65536` を計算する。負値は弾いていない |
| L884-944 `collectStats()` | `rtt` / `totalRoundTripTime` / `roundTripTimeMeasurements` を `remote-inbound-rtp` に出力する。`rtt !== undefined` が `remoteId` 出力条件の 1 つ |

### 関連ユーティリティ: `packages/webrtc/src/utils.ts`

- `timestampSeconds = () => Date.now() / 1000`: 壁時計なので単調ではない(NTP 補正やシステム時刻変更で逆行・跳躍しうる)。
- `ntpTime()` (L83-92): 秒を `toString().split(".")` で分割し、**小数部の 10 進数字列をそのまま 32bit fraction として書き込んでいる**(例: `1760500000.123` → fraction = `123`)。そのため fraction の上位 16bit はほぼ 0 になる。
- `compactNtp()` (L107-111): NTP 64bit の中央 32bit(秒の下位 16bit + fraction の上位 16bit)を返す。
  - **重要**: 上の `ntpTime()` の問題により、送信側の `compactNtp` は**実質 1 秒粒度**になる。SR 間隔は 0.5〜1.5s で、SR 間に RTP が無ければ `ntpTimestamp` 自体が変わらないので、**連続する SR が同じ LSR 値になることがよくある**。履歴の設計ではキー衝突を前提にする必要がある。
- 受信側 `packages/webrtc/src/media/rtpReceiver.ts` (L240-266, L436-444) は、受け取った SR の `compactNtp` と受信時刻から `lsr` / `dlsr` を作る。werift 同士の接続ではこの値が送信側に返ってくる(受信側は変更不要)。

### 型: `packages/rtp/src/rtcp/rr.ts`

- `RtcpReceiverInfo` の `lsr: number`(32bit compact NTP)と `dlsr: number`(1/65536 秒単位)。

### 既存テスト

- `packages/webrtc/tests/media/rtpSender.test.ts`: RTT / LSR の照合を検証するテストは**存在しない**。`describe("media/rtpSender RTP continuity")` 内の `arrangeSender`(L877〜)と `tests/fixture.ts` の `createConnectedRtpSender()`(`sendRtp` / `sendRtcp` を spy で mock)が Arrange の基盤になる。
- `tests/fixture.ts` が共通 Arrange ユーティリティの置き場(AGENTS.md の「Arrange utility は単一ファイルに集約」ルールに沿う)。

## 3. 実装内容

### 3.1 SR 送信履歴の導入(推奨アプローチ)

RFC の compact-NTP 演算(`A - LSR - DLSR`)を直接使う案は、現状の `ntpTimestamp` が SR 送信時刻ではなく(#701)、`ntpTime()` の fraction も壊れているため、**本チケットでは採用しない**。LSR をキーにした**有界な送信履歴**で照合する。

1. **履歴構造**: 小さな内部クラスにする(例: `SenderReportHistory`。`packages/webrtc/src/media/sender/` 配下に置くと単体テストしやすい)。
   - エントリ: `{ lsr: number /* compactNtp(SR に実際に載せた ntpTimestamp) */, sentAt: number /* 単調時刻 (秒) */ }`
   - 上限: 件数(例: 32 件。最短 0.5s 間隔でも約 16 秒分)と保持時間(例: 30 秒)。どちらかを超えた古いエントリから削除する。
   - 同じ LSR のエントリが複数あってもよい(上記のキー衝突対策)。`Map<lsr, sentAt>` で上書きする実装にはしない。
2. **SR 送信時 (`runRtcp`)**:
   - SR に載せた `ntpTimestamp` から作った `compactNtp` と `performance.now() / 1000` などの単調時刻を記録する。
   - `lastSRtimestamp` / `lastSentSRTimestamp` は履歴に置き換えて削除する(`private` なので外部 API への影響はない。テストの `(sender as any)` 参照が無いことを確認済み)。
   - 記録のタイミング: `sendRtcp()` の直前に記録するのが既存挙動と同じで、DTLS の送信遅延を RTT に含めない。送信失敗時にエントリを残すかどうかは実装時に判断する。残しても照合されないだけなので害はない。
3. **RR 受信時 (`handleRtcpPacket`)**:
   - `report.lsr === 0` は「SR 未受信」(RFC 3550)なので無視する。現状の `report.dlsr` が truthy かどうかの判定は、正当な `dlsr === 0`(即時応答)を誤って捨てるため、`lsr !== 0` の判定に置き換えることを検討する。
   - `now = 単調時刻`, `dlsrSec = report.dlsr / 65536` とし、`report.lsr` に一致するエントリのうち **`sentAt <= now - dlsrSec` を満たす最も新しいもの**を選ぶ。キー衝突時に新しすぎる SR を選んで負の RTT を出さないため。
   - `rtt = now - sentAt - dlsrSec` を計算し、`rtt < 0` や上限超過(例: 保持時間より大きい)なら棄却する。
   - 採用したら既存ロジックのまま `totalRoundTripTime += rtt`、`roundTripTimeMeasurements++`、`rtt` の EWMA(`RTT_ALPHA`)を更新する。この部分は関数に切り出すと見通しが良くなる。
   - 一致しない LSR、または履歴から追い出された LSR は何もしない(`remotePacketsLost` / `remoteFractionLost` の更新は従来どおり続ける)。
4. **compact NTP のラップアラウンド**: 履歴方式では LSR を等値比較するだけなので、16bit 秒のラップ(約 18.2 時間周期)で問題が起きるのは、保持時間内に同じ値が再出現した場合だけになる。有界な保持時間(数十秒)であれば実害はない。テストで `0xffffxxxx` → `0x0000xxxx` をまたいでも照合できることを確認する。

### 3.2 対象外 / 別チケット

- `ntpTime()` の fraction 計算の修正と、SR の NTP/RTP ペアを SR 送信時刻に揃える修正は **#701 の範囲**。本チケットでは触らない。履歴方式はどちらの状態でも動くので、#701 修正後も変更なしで両立する。
- `rtpReceiver.ts` 側の RR 生成ロジックは変更しない。

## 4. 制約・注意点

- **単調時刻の使用**: RTT 計算に `Date.now()` を使うと時刻補正で負値や巨大値が出る。`performance.now()` を使う。他の箇所も `timestampSeconds()` に依存しているので、utils の既存関数は変えず、sender 内だけで単調時刻を使う。
- **LSR の衝突**: 前述のとおり現行の `ntpTime()` では LSR が約 1 秒粒度で重複する。テストでは `ntpTimestamp` を明示的に設定するか、`ntpTime` を制御して衝突ケースと非衝突ケースの両方を作る。
- **メモリ / 性能**: 履歴は sender ごとに固定上限。RR 1 件ごとの線形探索(最大 32 件程度)で十分。`stop()` 時に履歴をクリアしても構わない。
- **既存挙動の維持**: 最新 SR を参照する RR の RTT 値・統計の更新方法(EWMA・累積・回数)は変えない。
- **パッケージ境界**: 変更は `packages/webrtc` に閉じる。`packages/rtp` の型は変更不要。
- **テスト規約 (AGENTS.md)**: Arrange / Act / Assert の 3 フェーズで書き、Act / Assert には日本語コメントを付ける。SR 送信や RR 生成の Arrange ヘルパー(例: `createReceiverReport({ ssrc, lsr, dlsr })`、SR を 1 回送って記録する helper)は `tests/fixture.ts` に集約する。
- **時間制御**: `runRtcp()` は 500〜1500ms のランダム待ちが入るので、実時間に依存したテストは不安定になる。`vi.useFakeTimers()` + `vi.spyOn(performance, "now")` で制御するか、SR 記録処理を直接呼べるメソッドに切り出してテストする。

## 5. 回帰テスト(`packages/webrtc/tests/media/rtpSender.test.ts` または履歴クラスの単体テスト)

1. SR A → SR B を送信し、A を参照する RR を受信 → RTT が更新される。
2. A の後に SR を複数送信してから A を参照する RR を受信 → 保持範囲内なら照合される。
3. 最新 SR を参照する RR → 従来どおり RTT が更新される(期待値 = `now - sentAt - dlsr/65536`)。
4. 未知の LSR → `rtt` は `undefined` のまま、`roundTripTimeMeasurements` は 0。
5. 件数上限・保持時間を超えて追い出された LSR → 無視され、例外も出ない。
6. compact NTP のラップアラウンド(`0xffff....` → `0x0000....`)をまたいでも正しい SR が照合される。
7. 同じ LSR の SR が複数ある場合 → `sentAt <= now - dlsr` を満たす最新エントリが選ばれ、負の RTT は記録されない。
8. 負になるサンプル(DLSR が経過時間より大きい)→ 棄却される。
9. 統計: 複数サンプルの後で `getStats()` の `remote-inbound-rtp` の `roundTripTime`(EWMA)、`totalRoundTripTime`(合計)、`roundTripTimeMeasurements`(件数)が期待どおり。
10. `lsr === 0` の RR → RTT は更新しないが、`packetsLost` / `fractionLost` は更新される。
11. (任意)#701 との統合: SR の NTP が送信時刻と一致する状態(`ntpTimestamp` を SR 送信時に設定した状態)でも照合が成立する。#701 が未完了なら、そのチケットの完了条件に移すか TODO を残す。

## 6. 完了条件

- [ ] `RTCRtpSender` が、直近の 1 件だけでなく保持範囲内の任意の SR を参照する RR から RTT を計算できる。
- [ ] 未知・保持期限切れ・`lsr === 0`・負値のサンプルは安全に無視され、例外は出ない。
- [ ] RTT 計算に単調時刻を使い、LSR の重複時も負の RTT を記録しない。
- [ ] 履歴が件数と時間で有界になっている。
- [ ] `lastSRtimestamp` / `lastSentSRTimestamp` の単一値ロジックがなくなり、最新 SR を参照する場合の既存挙動(EWMA / 累積 / 回数)は変わっていない。
- [ ] 上記の回帰テストが追加され、AGENTS.md の Arrange / Act / Assert 規約(共通 Arrange は `tests/fixture.ts`、Act / Assert に日本語コメント)に沿っている。
- [ ] `cd packages/webrtc && npm run type && npm test` が通る。
- [ ] 振る舞い変更なので `changelog.md` の慣例に沿って追記する(必要な場合)。
- [ ] #701 との関係(本変更は #701 修正後もそのまま両立すること)が PR 説明に書かれている。

---

## 付録: 元の起票内容

## Summary

`RTCRtpSender` only updates RTT when an incoming Receiver Report's `LSR` matches the **most recently sent** Sender Report.

If a receiver report refers to an older SR — which is normal when media/RTCP is delayed or queued — werift ignores that RTT sample entirely.

This was reproduced against a real Chrome receiver in `Rkcr007/mfarm-cloud` while debugging video over a bandwidth-constrained TURN path:

https://github.com/Rkcr007/mfarm-cloud/pull/273

Their regression test sends/records multiple SR clock points, then feeds werift an RR that echoes an older SR. werift ignores it, while the downstream history-based implementation calculates the expected RTT.

## Current implementation

Current `develop` in `packages/webrtc/src/media/rtpSender.ts` keeps only one SR identity/time pair:

```ts
private lastSRtimestamp?: number;
private lastSentSRTimestamp?: number;
```

Each new Sender Report overwrites it:

```ts
this.lastSRtimestamp = compactNtp(this.ntpTimestamp);
this.lastSentSRTimestamp = timestampSeconds();
```

Receiver Reports are accepted only when they echo that latest SR:

```ts
if (this.lastSRtimestamp === report.lsr && report.dlsr) {
  if (this.lastSentSRTimestamp) {
    const rtt =
      timestampSeconds() -
      this.lastSentSRTimestamp -
      report.dlsr / 65536;
    ...
  }
}
```

So with SRs A, B, C already sent, an RR for A or B is dropped once C has become `lastSRtimestamp`.

## Why this is valid traffic

RTCP Receiver Reports identify the Sender Report they are reporting on through `LSR` and `DLSR`.

A receiver is not required to return a report quickly enough that the sender has sent no newer SR in the meantime. Queueing, scheduling delay, relay delay, or a congested media path can easily make an RR for SR A arrive after SR B/C were transmitted.

RFC 3550 RTT calculation is based on the particular SR identified by the RR, not on “whatever SR was most recently transmitted locally”.

## Downstream impact

mfarm-cloud observed a constrained video path where Chrome's effective round trip grew substantially behind a queue, while werift's sender RTT could remain stale because delayed RRs referenced older SRs and were ignored.

They introduced a bounded `SenderReportLog` that records multiple SR identities/times and resolves RTT by the RR's LSR.

Their test explicitly covers:

```text
send SR A
send SR B
send SR C
receive RR whose LSR references SR A
=> RTT must still be computed
```

This matters for:

- `RTCRemoteInboundRtpStreamStats.roundTripTime`
- congestion/adaptation logic consuming sender RTT
- diagnostics on queued/congested media paths
- applications that use media RTT as an input to transport policy

## Relation to #701

#701 tracks a separate Sender Report timestamp-mapping problem: the SR NTP/RTP pair should represent the instant the SR is sent.

This issue is distinct.

Even after #701 is fixed, a sender that stores only the latest SR cannot match a delayed RR that legitimately references an older SR.

The two changes should be compatible. Once SR timestamps are correct, RTT can either:

- follow the RFC compact-NTP calculation directly, or
- retain a bounded history keyed by LSR and the actual send time.

## Expected behavior

When an RR contains a non-zero LSR corresponding to any **recently sent** SR, werift should be able to calculate an RTT sample even if newer SRs were sent afterwards.

Unknown/stale LSR values that cannot safely be matched should still be ignored.

## Suggested implementation

One option is a bounded recent-SR history, e.g.:

```ts
Map<compactNtpLsr, monotonicSendTime>
```

On SR send:

1. record the compact NTP value actually placed in the SR;
2. record a monotonic send timestamp;
3. retain only a bounded number/time window of entries.

On RR receive:

1. look up `report.lsr`;
2. if found, compute `now - srSendTime - DLSR`;
3. reject negative/unreasonable samples;
4. update `rtt`, `totalRoundTripTime`, and measurement count.

Alternatively, after #701 makes the SR NTP timestamp standards-correct, implement the RFC 3550 compact-NTP arithmetic directly while handling wrap correctly.

## Regression tests

Please cover:

1. SR A sent, then SR B, RR references A -> RTT updates.
2. Several newer SRs are sent before the RR -> older recent SR still matches.
3. RR references latest SR -> existing behavior remains.
4. Unknown LSR -> no RTT update.
5. Bounded history eviction -> very old LSR is ignored safely.
6. Compact-NTP wraparound.
7. RTT statistics (`roundTripTime`, `totalRoundTripTime`, count) update correctly.
8. Integration with the SR timestamp semantics fixed by #701.

I did not find an existing issue specifically tracking the latest-SR-only RR matching behavior.