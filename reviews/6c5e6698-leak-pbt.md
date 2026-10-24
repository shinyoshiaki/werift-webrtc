---
ide:
  viewer: review-document
  version: 1
  title: "PBT によるメモリーリーク検出と修正"
  dock: right
  baseCommit: 081dc19ae2b251738f9adcbcdb2c485fa0fc793b
---
# PBT によるメモリーリーク検出と修正 — レビュー解説

## 1. 結論

negotiation の PBT に **leak property** を追加し、見つかったリークを根本から直しました。判定は決定的で、CI では retry なしの約 30 秒で動きます。

- 検出の仕組み: [leakProbe.ts](review-file:packages/webrtc/tests/pbt/leak/leakProbe.ts:1) / [negotiationLeakProperty.test.ts](review-file:packages/webrtc/tests/pbt/leak/negotiationLeakProperty.test.ts:123) / [scenes.ts](review-file:packages/webrtc/tests/pbt/leak/scenes.ts:10)
- 修正は ice / dtls / webrtc の 3 package にまたがります。実装は commit `de807ac8` に入っています。
- 以下の検証結果は実装担当の報告に基づくものです。この文書の作成時には再実行していません（§7）。

<div style="display:flex;gap:10px;flex-wrap:wrap">
  <div style="flex:1;min-width:140px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-accent);border-radius:6px"><strong>3 つの property</strong><br>P1 close 後 / P2 session 内 / P3 heap 傾き</div>
  <div style="flex:1;min-width:140px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px"><strong>修正したリーク</strong><br>9 区分（報告では 11 件）</div>
  <div style="flex:1;min-width:140px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-warning);border-radius:6px"><strong>40 ファイル</strong><br>+2648 / −75（doc 除く）</div>
</div>

## 2. 検出の考え方（3 種類の property）

heap の増え方を見る統計的な方法は CI で不安定なので、**「何が残るか」を決定的に判定**します。heap の傾きは P3 として `pbt:deep` だけで実行します。

<style>
  .lk-tabs button { border: 1px solid var(--review-border); background: var(--review-surface); color: var(--review-fg); padding: 3px 12px; margin-right: 4px; border-radius: 4px; cursor: pointer; }
  .lk-tabs button[aria-selected="true"] { border-color: var(--review-accent); color: var(--review-accent); font-weight: bold; }
  .lk-tabs [role="tabpanel"] { padding: 10px 4px; line-height: 1.6; color: var(--review-fg); }
  .lk-tabs svg text { fill: var(--review-fg); }
</style>

<div class="lk-tabs">
  <button role="tab" aria-selected="true" data-panel="p1">P1 close 後</button>
  <button role="tab" aria-selected="false" data-panel="p2">P2 session 内</button>
  <button role="tab" aria-selected="false" data-panel="p3">P3 heap</button>
  <div role="tabpanel" data-panel="p1">
    <svg viewBox="0 0 640 70" width="100%" role="img" aria-label="P1 flow">
      <g fill="none" stroke="var(--review-border)"><rect x="4" y="16" width="120" height="38" rx="6"/><rect x="164" y="16" width="130" height="38" rx="6"/><rect x="334" y="16" width="130" height="38" rx="6" stroke="var(--review-accent)"/><rect x="504" y="16" width="130" height="38" rx="6" stroke="var(--review-accent)"/></g>
      <g stroke="var(--review-muted)"><line x1="124" y1="35" x2="164" y2="35"/><line x1="294" y1="35" x2="334" y2="35"/><line x1="464" y1="35" x2="504" y2="35"/></g>
      <g font-size="12" text-anchor="middle"><text x="64" y="39">シーン実行</text><text x="229" y="39">継続確認/割込み/asIs</text><text x="399" y="39">両 peer を close</text><text x="569" y="39">GC・資源数を判定</text></g>
    </svg>
    <ul><li>L1: シーン中に作った全オブジェクトを WeakRef で登録し、強制 GC 後にすべて消えること</li><li>L2: socket / timer / immediate の数が開始前に戻ること（最大 2 秒待つ）</li><li>固定ケース: close タイミング行列、DTLS handshake 中、TURN allocation 中（応答しないサーバー含む）</li></ul>
  </div>
  <div role="tabpanel" data-panel="p2" hidden>
    <svg viewBox="0 0 640 70" width="100%" role="img" aria-label="P2 flow">
      <g fill="none" stroke="var(--review-border)"><rect x="4" y="16" width="130" height="38" rx="6"/><rect x="184" y="16" width="130" height="38" rx="6" stroke="var(--review-accent)"/><rect x="364" y="16" width="130" height="38" rx="6" stroke="var(--review-accent)"/><rect x="530" y="16" width="104" height="38" rx="6"/></g>
      <g stroke="var(--review-muted)"><line x1="134" y1="35" x2="184" y2="35"/><line x1="314" y1="35" x2="364" y2="35"/><line x1="494" y1="35" x2="530" y2="35"/></g>
      <g font-size="12" text-anchor="middle"><text x="69" y="39">stable</text><text x="249" y="39">周期を実行</text><text x="429" y="39">stable に戻る</text><text x="582" y="39">footprint</text></g>
    </svg>
    <ul><li>周期（re-offer、ICE restart、BUNDLE 分割/統合、rollback、glare など）を同一 session で繰り返す</li><li><code>leakFootprint</code> の各指標が「2 回目の後の値」から増えないこと</li><li>意図して残る状態（<code>seenMid</code>、退役 ufrag 最大 64 件など）は上限つきで許可</li></ul>
  </div>
  <div role="tabpanel" data-panel="p3" hidden>
    P2 の周期を 200 回繰り返し、強制 GC 後の heapUsed の傾きを <code>detectLeak</code> で判定します。<code>WERIFT_NEGOTIATION_LEAK_HEAP=1</code>（<code>npm run pbt:deep</code>）のときだけ実行します。memleak 側にも同じ周期の <code>renegotiation</code> シナリオを追加しました。
  </div>
</div>

<script>
  document.querySelectorAll(".lk-tabs [role=tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".lk-tabs [role=tab]").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
      document.querySelectorAll(".lk-tabs [role=tabpanel]").forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.panel; });
    });
  });
</script>

P1 / P2 / P3 の関係と CI での実行条件は [NEGOTIATION_TRANSACTION.md](review-file:packages/webrtc/NEGOTIATION_TRANSACTION.md:858) の「Leak property」にあります。公開 STUN の代わりにテストプロセス内の STUN サーバーを使うため、判定はネットワークに左右されません。

## 3. 見つかったリークと修正

<table style="width:100%;border-collapse:collapse;font-size:13px">
<tr style="text-align:left;border-bottom:2px solid var(--review-border)"><th style="padding:4px">#</th><th>package</th><th>何が残っていたか</th><th>直し方</th></tr>
<tr style="border-bottom:1px solid var(--review-border)"><td style="padding:4px">1</td><td>webrtc</td><td>相手が作って閉じた DataChannel が SCTP の一覧に残る</td><td>作成側と受信側で同じ <code>track()</code> を通し、close で一覧から外す</td></tr>
<tr style="border-bottom:1px solid var(--review-border)"><td style="padding:4px">2</td><td>webrtc</td><td>止めた sender が BUNDLE 共有の DTLS transport を購読し続ける（rollback で結び直された場合も）</td><td>stopped の sender は購読しない</td></tr>
<tr style="border-bottom:1px solid var(--review-border)"><td style="padding:4px">3</td><td>webrtc</td><td>pending が m-line を別 transport に移した後の close で、rollback baseline だけが参照する transport が止まらない</td><td>baseline が束ねる transport も停止対象にする</td></tr>
<tr style="border-bottom:1px solid var(--review-border)"><td style="padding:4px">4</td><td>webrtc</td><td>transport-cc の送信記録が RTP packet ごとに無制限に増える</td><td>5 秒・32768 件で上限（Map で古い順に破棄）</td></tr>
<tr style="border-bottom:1px solid var(--review-border)"><td style="padding:4px">5</td><td>ice</td><td>ICE restart のたびに資格情報の履歴が 2 件ずつ増える</td><td>履歴を上限つきで作り直す</td></tr>
<tr style="border-bottom:1px solid var(--review-border)"><td style="padding:4px">6</td><td>ice</td><td>close 時の STUN transaction が決着せず、DNS lookup 完了後に request が始まる</td><td>close で transaction をキャンセルする</td></tr>
<tr style="border-bottom:1px solid var(--review-border)"><td style="padding:4px">7</td><td>ice</td><td>置き換えた checklist の check が約 12 秒再送を続ける</td><td>置き換え時に check をキャンセルする</td></tr>
<tr style="border-bottom:1px solid var(--review-border)"><td style="padding:4px">8</td><td>ice</td><td>close に追い越された TURN allocation が socket と再送を保持</td><td><code>AbortSignal</code> を渡し、失敗時に TURN client を閉じる</td></tr>
<tr><td style="padding:4px">9</td><td>dtls / webrtc</td><td>transport 停止後も DTLS flight が約 30 秒再送を続ける</td><td>停止時に <code>dtls.close()</code>、flight の待機を closed signal で中断</td></tr>
</table>

報告の「11 件」と上の 9 行は数が一致しません。1 行に複数の経路（#2 の rollback、#6 の DNS 後始末など）が含まれていると推測しますが、件数の数え方は確認できていません（§7）。

### 代表例

**#4 transport-cc の送信記録（無制限増加 → 上限）**

<div style="display:flex;gap:12px">
  <div style="flex:1;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px"><strong>Before</strong><br>送信 packet ごとに <code>sentInfos[wideSeq]</code> が増え、sender の寿命の間残る</div>
  <div style="flex:1;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px"><strong>After</strong><br>Map で古い順に保持し、5 秒超または 32768 件超を破棄</div>
</div>

[senderBWE.ts:74](review-diff:packages/webrtc/src/media/sender/senderBWE.ts:74) が変更の核です。上限値の定義は [senderBWE.ts:10](review-file:packages/webrtc/src/media/sender/senderBWE.ts:10) にあります。

**#1 相手が作った DataChannel** は [sctpManager.ts:105](review-diff:packages/webrtc/src/sctpManager.ts:105) で、作成側・受信側の両方が同じ登録処理を通るようにしました。

**#9 DTLS 再送** は [flight.ts:43](review-diff:packages/dtls/src/flight/flight.ts:43)（closed なら送信・再送しない、待機も abort）と [dtls.ts:518](review-diff:packages/webrtc/src/transport/dtls.ts:518)（handshake 中でも停止時に閉じる）です。

**#8 TURN allocation** は [ice.ts:1242](review-diff:packages/ice/src/ice.ts:1242)（close 後は TCP フォールバックもしない）と [turn/protocol.ts:820](review-diff:packages/ice/src/turn/protocol.ts:820)（失敗時に client を閉じる）です。

**#5 資格情報履歴** は [ice.ts:221](review-diff:packages/ice/src/ice.ts:221) です。

**#3 rollback baseline の transport** は [negotiationTransaction.ts:77](review-diff:packages/webrtc/src/negotiationTransaction.ts:77) の `baselineTransports` と [negotiationTransaction.ts:333](review-diff:packages/webrtc/src/negotiationTransaction.ts:333) の `replace` が関係します。

**#2 stopped の sender** は [rtpSender.ts:253](review-diff:packages/webrtc/src/media/rtpSender.ts:253) で購読を張らないようにしています。

## 4. 修正ごとの回帰テスト

各修正には、修正前に失敗する固定シーン・周期、または下位 package のテストがあります。

| 下位 package のテスト | 対象 |
| --- | --- |
| [credential-history.test.ts](review-file:packages/ice/tests/ice/credential-history.test.ts:1) | #5 |
| [transactionClose.test.ts](review-file:packages/ice/tests/stun/transactionClose.test.ts:1) | #6 |
| [check-cancel.test.ts](review-file:packages/ice/tests/ice/check-cancel.test.ts:1) | #7 |
| [turn-close-during-allocation.test.ts](review-file:packages/ice/tests/ice/turn-close-during-allocation.test.ts:1) | #8 |
| [retransmission.test.ts](review-file:packages/dtls/tests/flight/retransmission.test.ts:1) | #9 |
| [senderBWE.test.ts](review-file:packages/webrtc/tests/media/senderBWE.test.ts:1) | #4 |
| [rtpSender.test.ts](review-file:packages/webrtc/tests/media/rtpSender.test.ts:1) | #2 |

#1・#3 は webrtc の固定シーン（[scenes.ts](review-file:packages/webrtc/tests/pbt/leak/scenes.ts:10)）と P2 周期（[scenes.ts:119](review-file:packages/webrtc/tests/pbt/leak/scenes.ts:119)）が対象と推測しますが、どのシーンがどの # に対応するかは `ref` フィールドで確認してください。

## 5. テスト・ハーネス側の変更

- 空の describe 2 件を [negotiationTransactionCoverageTransport.test.ts](review-diff:packages/webrtc/tests/negotiation/negotiationTransactionCoverageTransport.test.ts) から削除（HEAD でも失敗していたもの）
- ハーネスが peer を握り続けないよう、継続確認の記録を解放し、操作ログを最新 40 件に制限
- `pbt:deep` に `leak` suite を追加: [run.ts](review-diff:packages/webrtc/tools/pbt-deep/run.ts)
- memleak に `renegotiation` シナリオを追加: [scenarios.ts](review-diff:packages/webrtc/tests/memleak/scenarios.ts)

## 6. 判断理由とリスク

- **決定的判定を優先**: CI で heap 傾きに頼るとフレークするため、WeakRef・資源数・指標の不変性で判定しました。
- **意図して残る状態は上限つきで許可**: 根拠は文書に記載されています。許容が広すぎると検出力が落ちるので、上限値の妥当性は見てください。
- **挙動の変化**: `getStats` の `dataChannelsClosed` など、develop と変わる点は「Behavior differences from develop」に追記済みです。
- **既知の未対応**:
  - model seed 275 は高負荷時のみ "the transport did not settle" で失敗します。修正前の HEAD でも同頻度で再現し、今回の変更とは無関係と報告されています。
  - TURN client は close 時にサーバー側 allocation を削除しません（Refresh lifetime=0 を送らない）。werift のプロセス内には何も残らないため、follow-up として文書に記録しています。

## 7. 検証結果と未確認事項

実装担当の報告による結果です（この文書の作成では再実行していません）。

<div style="display:flex;flex-direction:column;gap:6px">
  <div style="display:flex;align-items:center;gap:8px"><span style="width:200px">人工リーク 6 種の検出</span><span style="flex:1;height:14px;background:var(--review-success);border-radius:3px"></span><span>6 / 6</span></div>
  <div style="display:flex;align-items:center;gap:8px"><span style="width:200px">リーク無しで 10 回連続実行</span><span style="flex:1;height:14px;background:var(--review-success);border-radius:3px"></span><span>誤検知 0</span></div>
  <div style="display:flex;align-items:center;gap:8px"><span style="width:200px">test（ice / dtls / webrtc）</span><span style="flex:1;height:14px;background:var(--review-success);border-radius:3px"></span><span>211 / 34 / 861 通過</span></div>
  <div style="display:flex;align-items:center;gap:8px"><span style="width:200px">pbt:deep（leak は 300 seed）</span><span style="flex:1;height:14px;background:var(--review-success);border-radius:3px"></span><span>0 failed</span></div>
</div>

`npm run type` と memleak の短縮スモークも通ったと報告されています。

**未確認・注意点**

- 上記の数値はこの文書作成時には再実行していません。
- 実装の報告では「未コミット、HEAD は `520b76fc`」とありましたが、現在のリポジトリでは実装が `de807ac8` に入り、HEAD は `081dc19a` です。コミットとマージが後から行われたと推測しますが、確認していません。
- 作業ツリーには `doc/` と `packages/ice/doc/` の再生成差分（Connection.md、TurnClientOptions.md の変更と `doc/_media/NEGOTIATION_TRANSACTION.md` の削除）が未コミットで残っています。このタスクの変更かどうかは未確認です。
- 「11 件」と表の 9 行の対応は未確認です（§3）。
