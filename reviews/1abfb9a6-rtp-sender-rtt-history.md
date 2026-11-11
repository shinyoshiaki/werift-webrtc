---
ide:
  viewer: review-document
  version: 1
  title: "RTCRtpSender RTT: 古い SR を参照する RR の受け入れ"
  dock: right
  baseCommit: ee20dd2f4f8d0a6b33fa78cd4981043a85ccd7b2
---
# RTCRtpSender RTT: 古い SR を参照する RR を受け入れる

## 概要

`RTCRtpSender` が RTT を更新する条件を、「直近に送った 1 つの SR と `LSR` が一致したとき」から「保持範囲内に送った任意の SR と一致したとき」に広げる変更です。遅延・キューイング・TURN 中継で RR が遅れ、古い SR を参照していても RTT サンプルを捨てません。

<div style="display:flex;gap:12px;flex-wrap:wrap;margin:12px 0">
  <div style="flex:1;min-width:260px;padding:12px 16px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:8px;background:var(--review-surface)">
    <strong style="color:var(--review-danger)">Before</strong>
    <ul style="margin:8px 0 0;padding-left:18px;color:var(--review-muted);line-height:1.7">
      <li>SR の識別子と送信時刻を <strong style="color:var(--review-fg)">1 組だけ</strong>保持</li>
      <li>SR A → B → C の後に届いた RR(A) は <strong style="color:var(--review-fg)">破棄</strong></li>
      <li>RTT 計算に壁時計の <code>Date.now()</code></li>
      <li><code>DLSR = 0</code> の即時応答も破棄</li>
    </ul>
  </div>
  <div style="flex:1;min-width:260px;padding:12px 16px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:8px;background:var(--review-surface)">
    <strong style="color:var(--review-success)">After</strong>
    <ul style="margin:8px 0 0;padding-left:18px;color:var(--review-muted);line-height:1.7">
      <li>送信 SR を <strong style="color:var(--review-fg)">32 件 / 30 秒</strong>の有界な履歴で保持</li>
      <li>RR の <code>LSR</code> で履歴を引き、<strong style="color:var(--review-fg)">該当 SR 基準</strong>で RTT を計算</li>
      <li>単調時刻 <code>performance.now()</code> を使用</li>
      <li><code>DLSR = 0</code> も正しいサンプルとして記録</li>
    </ul>
  </div>
</div>

## 何が問題だったか

RTCP の RR は、どの SR に対する応答かを `LSR`（Last SR timestamp）で示します。しかし旧実装は「ローカルが最後に送った SR」としか比較していませんでした。SR A の応答が SR B / C の送信後に届くと、`LSR=A` は現在値 `C` と一致せず、正当なサンプルが捨てられます。

<svg viewBox="0 0 840 410" width="100%" role="img" aria-label="SR A/B/C の後に届く RR(A) を旧実装は破棄し、新実装は履歴から A を照合するシーケンス図">
  <defs>
    <marker id="rtt-seq-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="var(--review-muted)"/>
    </marker>
    <marker id="rtt-seq-arrow-accent" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="var(--review-accent)"/>
    </marker>
  </defs>

  <g fill="var(--review-fg)" font-size="13" text-anchor="middle">
    <rect x="100" y="16" width="140" height="30" rx="6" fill="var(--review-surface)" stroke="var(--review-border)"/>
    <text x="170" y="36">Sender (werift)</text>
    <rect x="610" y="16" width="140" height="30" rx="6" fill="var(--review-surface)" stroke="var(--review-border)"/>
    <text x="680" y="36">Receiver</text>
  </g>

  <g stroke="var(--review-border)" stroke-dasharray="4 5">
    <line x1="170" y1="46" x2="170" y2="330"/>
    <line x1="680" y1="46" x2="680" y2="330"/>
  </g>

  <g stroke="var(--review-muted)" fill="none" marker-end="url(#rtt-seq-arrow)">
    <line x1="172" y1="88" x2="676" y2="88"/>
    <line x1="172" y1="138" x2="676" y2="138"/>
    <line x1="172" y1="188" x2="676" y2="188"/>
  </g>
  <g fill="var(--review-fg)" font-size="12" text-anchor="middle">
    <text x="425" y="80">SR A</text>
    <text x="425" y="130">SR B</text>
    <text x="425" y="180">SR C</text>
  </g>

  <line x1="100" y1="88" x2="100" y2="292" stroke="var(--review-accent)" stroke-dasharray="3 4"/>
  <g stroke="var(--review-accent)" fill="none">
    <line x1="100" y1="88" x2="112" y2="88"/>
    <line x1="100" y1="292" x2="112" y2="292"/>
  </g>
  <text x="92" y="196" fill="var(--review-accent)" font-size="12" text-anchor="middle" transform="rotate(-90 92 196)">RTT = now - A の送信時刻 - DLSR</text>

  <g stroke="var(--review-accent)" fill="none" marker-end="url(#rtt-seq-arrow-accent)">
    <line x1="678" y1="292" x2="174" y2="292"/>
  </g>
  <g fill="var(--review-accent)" font-size="12" text-anchor="middle">
    <text x="425" y="284">RR: LSR = A, DLSR = 経過時間</text>
  </g>

  <g font-size="12" text-anchor="middle">
    <rect x="150" y="338" width="250" height="52" rx="6" fill="var(--review-surface)" stroke="var(--review-danger)"/>
    <text x="275" y="358" fill="var(--review-danger)" font-weight="bold">旧実装</text>
    <text x="275" y="377" fill="var(--review-muted)">最新 SR = C と比較 → 不一致で破棄</text>

    <rect x="440" y="338" width="250" height="52" rx="6" fill="var(--review-surface)" stroke="var(--review-success)"/>
    <text x="565" y="358" fill="var(--review-success)" font-weight="bold">新実装</text>
    <text x="565" y="377" fill="var(--review-muted)">履歴から LSR = A を検索 → RTT を記録</text>
  </g>
</svg>

RFC 3550 §6.4.1 の RTT は、RR の `LSR` が指す SR を基準に計算するものです。最新 SR を基準にするのは仕様とも一致していません。

## 主要変更

### 1. 送信 SR の履歴クラス

履歴は [packages/webrtc/src/media/sender/senderReportHistory.ts:29](review-file:packages/webrtc/src/media/sender/senderReportHistory.ts:29) の小さなクラスに閉じています。エントリは「SR に実際に載せた `LSR`」と「単調時刻の送信時刻」の組だけです。件数上限 32 件・保持時間 30 秒は [senderReportHistory.ts:6](review-file:packages/webrtc/src/media/sender/senderReportHistory.ts:6) と [senderReportHistory.ts:13](review-file:packages/webrtc/src/media/sender/senderReportHistory.ts:13) で定義しています。

#### 上限値（32 件・30 秒）の根拠と妥当性

照合できるのは、受信時点で「経過時間 = RTT + DLSR」以内に送った SR だけです。上限値はこの経過時間を十分に覆うように決めました。

| 前提 | 値 | 出典 |
| --- | --- | --- |
| werift の SR 送信間隔 | 0.5〜1.5 秒の一様乱数（平均 1 秒） | [rtpSender.ts:682](review-file:packages/webrtc/src/media/rtpSender.ts:682) |
| `DLSR` の通常の大きさ | 受信側が最後の SR を受け取ってからの時間なので、SR が届いていれば通常は 1.5 秒以内。SR が失われると、その分だけ伸びる | RFC 3550 §6.4.1 |
| 受信側（Chrome / libwebrtc）の RR 送信間隔の既定値 | 映像 1 秒・音声 5 秒 | libwebrtc `media_config.h` |
| 通常の RTT | 数十〜数百 ms。帯域制約のある TURN 経路のキュー遅延でも、数秒程度 | — |

- **保持時間 30 秒:** 経過時間は通常 2 秒前後で、悪条件が重なっても数秒〜十数秒です（遅い音声 RR、SR の連続損失、数秒のキュー遅延）。30 秒あれば、これを 2 倍以上の余裕で覆えます。これより古い SR を参照する RR は、RTT 20 秒超を意味します。この RR は経路が事実上壊れていることを示すだけなので、`roundTripTime` に混ぜない方が有用です。逆に数秒まで短くすると、起票の原因である遅延 RR を再び捨てるおそれがあります。
- **件数 32 件:** 主な役割は、メモリと探索コストを固定するための安全上限です。32 件で覆える時間は、平均間隔 1 秒なら約 32 秒です（乱数間隔の和なので、標準偏差は約 1.6 秒）。保持時間 30 秒とほぼ同じ長さなので、通常はどちらか一方だけが先に効くことはありません。全間隔が 0.5 秒という最悪の場合は約 16 秒に縮みます。それでも上の経過時間は覆えます。
- **コスト:** sender 1 つあたり 32 エントリ（数値 2 つ）の配列で、RR 1 件あたりの探索は最大 32 件です。値を大きくしても得るものはほとんどなく、小さくすると取りこぼしが増えるだけなので、現在の値を維持しました。
- **誤照合の余地:** `LSR` の分解能は 1/65536 秒で、照合は等値比較です。そのため、値を大きくしても誤照合はほとんど増えません。上限は、誤照合ではなく古すぎるサンプルを除くためのものです。

<div style="display:flex;gap:16px;flex-wrap:wrap;margin:12px 0">
  <div style="flex:1.15;min-width:300px;padding:12px 16px;border:1px solid var(--review-border);border-radius:8px;background:var(--review-surface)">
    <div style="font-weight:bold;margin-bottom:10px;color:var(--review-fg)">履歴のイメージ（古い → 新しい）</div>
    <div style="display:flex;gap:6px;align-items:stretch;flex-wrap:wrap">
      <div style="flex:1;min-width:62px;padding:8px 6px;border:1px dashed var(--review-border);border-radius:6px;color:var(--review-muted);text-align:center;opacity:.55">
        <div style="font-size:11px">LSR=A</div>
        <div style="font-size:11px">t=0.5s</div>
        <div style="font-size:10px">追い出し</div>
      </div>
      <div style="flex:1;min-width:62px;padding:8px 6px;border:1px dashed var(--review-border);border-radius:6px;color:var(--review-muted);text-align:center;opacity:.55">
        <div style="font-size:11px">LSR=B</div>
        <div style="font-size:11px">t=1.0s</div>
        <div style="font-size:10px">追い出し</div>
      </div>
      <div style="flex:1;min-width:62px;padding:8px 6px;border:2px solid var(--review-accent);border-radius:6px;color:var(--review-fg);text-align:center;background:var(--review-bg)">
        <div style="font-size:11px">LSR=C</div>
        <div style="font-size:11px">t=5.0s</div>
        <div style="font-size:10px;color:var(--review-accent)">照合対象</div>
      </div>
      <div style="flex:1;min-width:62px;padding:8px 6px;border:1px solid var(--review-border);border-radius:6px;color:var(--review-fg);text-align:center">
        <div style="font-size:11px">LSR=C</div>
        <div style="font-size:11px">t=5.5s</div>
        <div style="font-size:10px">同値も保持</div>
      </div>
      <div style="flex:1;min-width:62px;padding:8px 6px;border:1px solid var(--review-border);border-radius:6px;color:var(--review-fg);text-align:center">
        <div style="font-size:11px">LSR=D</div>
        <div style="font-size:11px">t=6.0s</div>
        <div style="font-size:10px">最新</div>
      </div>
    </div>
    <div style="margin-top:10px;font-size:12px;color:var(--review-muted);line-height:1.7">
      上限を超えた古い順に削除。同じ <code>LSR</code> でも上書きせず、複数エントリとして保持します。
    </div>
  </div>

  <div style="flex:1;min-width:280px;padding:12px 16px;border:1px solid var(--review-border);border-radius:8px;background:var(--review-surface)">
    <div style="font-weight:bold;margin-bottom:8px;color:var(--review-fg)">RR 受信時の照合</div>
    <ol style="margin:0;padding-left:20px;color:var(--review-muted);line-height:1.7;font-size:13px">
      <li><code>LSR = 0</code> なら何もしない</li>
      <li>期限切れエントリを捨てる</li>
      <li>同じ <code>LSR</code> のうち、<strong style="color:var(--review-fg)">送信時刻 &lt;= now - DLSR</strong> を満たす最新を選ぶ</li>
      <li><code>RTT = now - 送信時刻 - DLSR</code> を計算</li>
      <li>負値・保持時間超なら棄却、それ以外は統計へ</li>
    </ol>
  </div>
</div>

照合ロジックの本体は [packages/webrtc/src/media/sender/senderReportHistory.ts:67](review-file:packages/webrtc/src/media/sender/senderReportHistory.ts:67)、記録は [senderReportHistory.ts:50](review-file:packages/webrtc/src/media/sender/senderReportHistory.ts:50)、期限切れの削除は [senderReportHistory.ts:91](review-file:packages/webrtc/src/media/sender/senderReportHistory.ts:91) です。差分は [senderReportHistory.ts:20 の追加差分（95fba0c33 時点）](review-diff:packages/webrtc/src/media/sender/senderReportHistory.ts:commit:95fba0c33:20) で確認できます。

### 2. Sender への組み込み

- 履歴は `SenderStatistics` が持ちます（統計の責務を `rtpSender.ts` ではなく `SenderStatistics` に一本化）: [packages/webrtc/src/media/sender/senderStats.ts:72](review-file:packages/webrtc/src/media/sender/senderStats.ts:72)。
- SR 生成時に、SR に載せた `LSR` とその単調時刻を `buildSenderReport` で記録します: [senderStats.ts:187](review-file:packages/webrtc/src/media/sender/senderStats.ts:187)。
- RR 受信時は `recordReceptionReport` が履歴を引き、損失フィールド・EWMA・合計・回数を更新して生の RTT を返します: [senderStats.ts:110](review-file:packages/webrtc/src/media/sender/senderStats.ts:110)。`rtpSender.ts` はその生の RTT を BWE に渡すだけです: [packages/webrtc/src/media/rtpSender.ts:1242](review-file:packages/webrtc/src/media/rtpSender.ts:1242)。
- `stop()` で履歴をクリアします（`clearSenderReports`）: [rtpSender.ts:663](review-file:packages/webrtc/src/media/rtpSender.ts:663)。
- 旧来の `lastSRtimestamp` / `lastSentSRTimestamp`（`Date.now()` ベース）、`rtpSender.ts` 側の重複した RTT 状態・`RTT_ALPHA`、`collectStats` での `remote-inbound-rtp` 上書きは、すべて削除しました。RTT の状態は `SenderStatistics` の 1 か所だけです。

### 3. 意図的に変わる挙動: DLSR = 0

旧実装は `report.dlsr` の truthy 判定で、`DLSR = 0`（受信側が即時応答）の RR を捨てていました。新実装は `LSR != 0` を条件にするため、この RR からも RTT を記録します。これは RFC 上正当なサンプルで、回帰テストにも追加しています（[rtpSender.test.ts:2640](review-file:packages/webrtc/tests/media/rtpSender.test.ts:2640)）。

## 判断理由

- **履歴方式を採用**: SR の NTP タイムスタンプを直接使う compact-NTP 演算は、#701（SR の NTP/RTP ペアが送信時刻を表さない問題）と `ntpTime()` の小数部の扱いに依存します。履歴方式なら #701 の修正前後どちらでも動きます。この worktree では SR が送信時刻基準の NTP を作るため、実際に載せた `LSR` を記録すれば両立します。
- **Map ではなく配列**: 現行の `ntpTime()` は小数部を `fraction / 2^32` で表すため、`LSR` の分解能は 1/65536 秒です。通常、連続する SR が同じ値になることはありません。ただし、壁時計の逆行やテストで時刻を固定した場合など、同じ `LSR` は起こり得ます。上書きすると古い SR を失うため、重複を許容する配列にしました。
- **「DLSR 前までに送った最新」を選ぶ**: 同じ `LSR` の新しい SR を選ぶと負の RTT になるため、受信側がその SR を受け取れた時刻以前の最新エントリに限定しています。負値は最後にも棄却します。
- **単調時刻**: `Date.now()` は NTP 補正やシステム時刻変更で逆行し得るため、送信・受信とも `performance.now()` に統一しました。
- **有界化**: sender ごとに最大 32 件・30 秒。RR 1 件あたり最大 32 件の線形探索で、メモリ・計算量とも固定です。
- **ラップアラウンド**: `LSR` は等値比較のみなので、16bit 秒のラップ（約 18.2 時間）は保持時間 30 秒内で同じ値が再出現する場合だけ問題になります。実質的な影響はありません。テストでも `0xffff` → `0x0000` を確認しています。

## リスクと注意点

- **`DLSR = 0` のサンプルが増える**: これまで 0 件だった測定が 1 件目として記録されることがあります。統計の意味としては改善ですが、RTT の初期値が変わる点は利用側で認識が必要です。
- **履歴の取りこぼし**: 32 件 / 30 秒を超えた SR を参照する RR は従来どおり無視されます。極端に長い遅延や大量の SR 送信ではサンプルが取れません。
- **同じ `LSR` の衝突**: 「DLSR 前までに送った最新」で選ぶため、実際に RR が参照した SR と異なるエントリを選ぶ可能性は理論上残ります。ただし負の RTT を出さないことを優先した設計です。
- **実環境の再現シナリオは未実施**: 起票元の「実 Chrome 受信側 + 帯域制約 TURN 経路」の組み合わせは、この環境では再現していません。回帰テストは SR 送信・RR 受信を直接制御して検証しています。

## テスト

共通 Arrange は [packages/webrtc/tests/fixture.ts:273](review-file:packages/webrtc/tests/fixture.ts:273) の `lsrOf` / `dlsrUnits` / `createReceiverReport` / `remoteInboundRtpStats` に集約しました。回帰テストは [rtpSender.test.ts:2468](review-file:packages/webrtc/tests/media/rtpSender.test.ts:2468) の新しい describe と、履歴単体の [senderReportHistory.test.ts:4](review-file:packages/webrtc/tests/media/senderReportHistory.test.ts:4) です。

| チケットのケース | テスト | 場所 |
| --- | --- | --- |
| 1. SR A → B の後に RR(A) | `SR A → SR B の後に A を参照する RR が届いても RTT を更新する` | [rtpSender.test.ts:2510](review-file:packages/webrtc/tests/media/rtpSender.test.ts:2510) |
| 2. 複数 SR 送信後でも保持範囲内の A | `A の後に SR を複数送っても保持範囲内なら A を照合する` | [rtpSender.test.ts:2526](review-file:packages/webrtc/tests/media/rtpSender.test.ts:2526) |
| 3. 最新 SR を参照 | `最新 SR を参照する RR から now - 送信時刻 - DLSR を RTT とする` | [rtpSender.test.ts:2495](review-file:packages/webrtc/tests/media/rtpSender.test.ts:2495) |
| 4. 未知の LSR | `未知の LSR は RTT を記録しない` | [rtpSender.test.ts:2544](review-file:packages/webrtc/tests/media/rtpSender.test.ts:2544) |
| 5. 件数上限・保持時間の追い出し | `件数上限を超えて追い出された...` / `保持時間を過ぎた...` | [rtpSender.test.ts:2559](review-file:packages/webrtc/tests/media/rtpSender.test.ts:2559) / [rtpSender.test.ts:2580](review-file:packages/webrtc/tests/media/rtpSender.test.ts:2580) |
| 6. compact NTP のラップ | `compact NTP の秒がラップ...しても参照先の SR を照合する` | [rtpSender.test.ts:2599](review-file:packages/webrtc/tests/media/rtpSender.test.ts:2599) |
| 7. 同じ LSR の衝突 | `同じ LSR が複数あるときは...最新の SR を選ぶ` / `...負になる RTT は棄却する` | [senderReportHistory.test.ts:5](review-file:packages/webrtc/tests/media/senderReportHistory.test.ts:5) / [senderReportHistory.test.ts:20](review-file:packages/webrtc/tests/media/senderReportHistory.test.ts:20) |
| 8. 負の RTT | `DLSR が SR からの経過時間より大きい...` | [rtpSender.test.ts:2625](review-file:packages/webrtc/tests/media/rtpSender.test.ts:2625) |
| 9. 統計（EWMA / 合計 / 件数） | `複数サンプルで roundTripTime は EWMA...` | [rtpSender.test.ts:2654](review-file:packages/webrtc/tests/media/rtpSender.test.ts:2654) |
| 10. `LSR = 0` と損失統計 | `LSR = 0 の RR は RTT を更新せず...` | [rtpSender.test.ts:2673](review-file:packages/webrtc/tests/media/rtpSender.test.ts:2673) |
| 11. #701 との統合（実際の SR 送信経路） | `runRtcp が実際に送った SR を参照する RR から RTT を計算する` | [rtpSender.test.ts:2689](review-file:packages/webrtc/tests/media/rtpSender.test.ts:2689) |
| 追加. `DLSR = 0` | `DLSR = 0 (即時応答) の RR も RTT を記録する` | [rtpSender.test.ts:2640](review-file:packages/webrtc/tests/media/rtpSender.test.ts:2640) |
| 追加. 有界性・clear | `件数と保持時間の両方で有界になる` / `clear で履歴を空にする` | [senderReportHistory.test.ts:46](review-file:packages/webrtc/tests/media/senderReportHistory.test.ts:46) / [senderReportHistory.test.ts:66](review-file:packages/webrtc/tests/media/senderReportHistory.test.ts:66) |

## 検証結果

今回このワークツリーで再実行した結果です。

<div style="display:flex;gap:12px;flex-wrap:wrap;margin:12px 0">
  <div style="flex:1;min-width:150px;padding:12px 16px;border:1px solid var(--review-border);border-radius:8px;background:var(--review-surface);text-align:center">
    <div style="font-size:24px;font-weight:bold;color:var(--review-success)">100</div>
    <div style="font-size:12px;color:var(--review-muted)">対象テスト成功<br>2 ファイル</div>
  </div>
  <div style="flex:1;min-width:150px;padding:12px 16px;border:1px solid var(--review-border);border-radius:8px;background:var(--review-surface);text-align:center">
    <div style="font-size:24px;font-weight:bold;color:var(--review-success)">1609</div>
    <div style="font-size:12px;color:var(--review-muted)">webrtc 全体成功<br>5 skipped / 77 files</div>
  </div>
  <div style="flex:1;min-width:150px;padding:12px 16px;border:1px solid var(--review-border);border-radius:8px;background:var(--review-surface);text-align:center">
    <div style="font-size:24px;font-weight:bold;color:var(--review-success)">Pass</div>
    <div style="font-size:12px;color:var(--review-muted)">パッケージ型検査<br>TypeScript 6.0.3</div>
  </div>
</div>

```bash
cd packages/webrtc
npx vitest run ./tests/media/rtpSender.test.ts ./tests/media/senderReportHistory.test.ts
# 2 files / 100 tests passed

npm run type
# tsc --noEmit ... 成功

npm test
# 77 files passed / 1609 passed, 5 skipped（134.81s）
```

レビュー時には、ロックファイルどおりの依存関係を用意した一時 worktree でワークスペースの `npm run type` と `npm run test:small` も通過しています。今回の再実行でも、変更パッケージの型検査・全体テストに対象テストを含めて成功を確認しました。

## 未確認事項と残作業

- 起票元の実環境（実 Chrome 受信側 + 帯域制約 TURN 経路）での再現・改善効果は未確認です。今回の検証は単体・結合テストと型検査までです。
- PR はまだ作成していません。チケット完了条件にある「#701 修正後も両立すること」を PR 説明に記載する必要があります。
- 変更は HEAD `ee20dd2f4`（`291b955fa` の上に SR 履歴の `SenderStatistics` への統合・フォーマット修正を追加）にコミット済みです（このレビュー文書のみ未コミット）。上記の検証件数はこの内容で取得しました。`changelog.md` の追記は [changelog.md:17](review-file:changelog.md:17)、リーク検査の有界状態の記載は [leakProbe.ts:1007](review-file:packages/webrtc/tests/pbt/leak/leakProbe.ts:1007) です。

## まとめ

最新 SR だけでなく、保持範囲内の SR を参照する RR から RTT を計算できるようになりました。照合は `LSR` と単調時刻の履歴で行い、`LSR = 0`・未知・期限切れ・負値は安全に無視します。EWMA・累積・回数の計算は変えず、対象テスト 100 件と webrtc 全体 1609 件（5 skipped）、型検査が通っています。実 Chrome + TURN 経路の再現と PR 作成は残っています。
