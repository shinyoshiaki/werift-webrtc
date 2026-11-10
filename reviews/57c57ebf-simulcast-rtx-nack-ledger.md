---
ide:
  viewer: review-document
  version: 1
  title: "Simulcast RTX 受信と NACK 台帳のレビュー"
  dock: right
  baseCommit: c5c4dfcce46be8aac23a173b0425e61b07292390
---
# Simulcast + RTX 受信の修正（レビュー解説）

## 1. 概要

RID ベースの simulcast では、Chrome が `a=ssrc-group:FID` を出しません。そのため werift は RTX パケットの行き先を決められず、**すべて破棄**していました。修正後は、RTX を該当レイヤーの track へ、元の SSRC・シーケンス番号・payload type に戻して届けます。あわせて NACK を媒体 SSRC ごとの状態に分け、レイヤー間の偽ロスと NACK の宛先ずれをなくしました。

設計の核は、「NACK が要求している欠落」と「RTX で埋めてよい欠落」を**同じ台帳**（`NackStream.holes`）で管理することです。RTX は推測で振り分けず、台帳に載った欠落を埋めるパケットかどうかを検証してから復元します。

<div style="display:flex;flex-wrap:wrap;gap:12px;margin:14px 0">
  <div style="flex:1 1 200px;padding:14px 16px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:8px;background:var(--review-surface)">
    <div style="font-size:12px;color:var(--review-muted)">修正前: RID simulcast の RTX</div>
    <div style="font-size:20px;font-weight:700;color:var(--review-danger);margin-top:4px">全数破棄</div>
    <div style="font-size:13px;color:var(--review-muted);margin-top:6px">router の <code>// bug</code> 分岐で何もせず終了</div>
  </div>
  <div style="flex:1 1 200px;padding:14px 16px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:8px;background:var(--review-surface)">
    <div style="font-size:12px;color:var(--review-muted)">修正後: RID simulcast の RTX</div>
    <div style="font-size:20px;font-weight:700;color:var(--review-success);margin-top:4px">検証して復元</div>
    <div style="font-size:13px;color:var(--review-muted);margin-top:6px">欠落台帳に載る RTX だけを元の SSRC / seq / PT へ</div>
  </div>
  <div style="flex:1 1 200px;padding:14px 16px;border:1px solid var(--review-border);border-left:4px solid var(--review-accent);border-radius:8px;background:var(--review-surface)">
    <div style="font-size:12px;color:var(--review-muted)">NACK の状態</div>
    <div style="font-size:20px;font-weight:700;color:var(--review-accent);margin-top:4px">receiver に 1 つ → SSRC ごと</div>
    <div style="font-size:13px;color:var(--review-muted);margin-top:6px">レイヤー間の偽ロスと宛先ずれを解消</div>
  </div>
</div>

## 2. RTX パケット 1 個の処理の流れ（修正前 / 修正後）

同じ RTX パケット（RTX SSRC `1001`、`repaired-rtp-stream-id = h`、元 seq `501`）が届いたとき、各段階で何が起きるかを左右に並べます。「次へ」で段階を進めると、その段階の説明が下に出ます。

<style>
  .rtx-flow { font-family: var(--review-font); color: var(--review-fg); }
  .rtx-flow .grid { display: grid; grid-template-columns: 120px 1fr 1fr; gap: 6px; }
  .rtx-flow .hd { font-size: 12px; font-weight: 700; padding: 4px 8px; color: var(--review-muted); }
  .rtx-flow .hd.b { color: var(--review-danger); }
  .rtx-flow .hd.a { color: var(--review-success); }
  .rtx-flow .lbl, .rtx-flow .cell { padding: 8px 10px; border: 1px solid var(--review-border); border-radius: 6px; font-size: 13px; line-height: 1.45; background: var(--review-surface); transition: opacity .15s, box-shadow .15s; }
  .rtx-flow .lbl { font-weight: 700; font-size: 12px; }
  .rtx-flow .cell.b { border-left: 4px solid var(--review-danger); }
  .rtx-flow .cell.a { border-left: 4px solid var(--review-success); }
  .rtx-flow .cell.none { color: var(--review-muted); border-style: dashed; border-left-width: 1px; }
  .rtx-flow .row-dim { opacity: .38; }
  .rtx-flow .row-on { box-shadow: 0 0 0 2px var(--review-accent); }
  .rtx-flow code { font-family: var(--review-mono); font-size: 12px; }
  .rtx-flow .bar { display: flex; gap: 8px; align-items: center; margin: 10px 0 6px; }
  .rtx-flow button { border: 1px solid var(--review-border); background: var(--review-surface); color: var(--review-fg); padding: 3px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .rtx-flow .pos { font-size: 12px; color: var(--review-muted); }
  .rtx-flow .detail { padding: 10px 12px; border-radius: 6px; background: var(--review-bg); border: 1px solid var(--review-border); font-size: 13px; line-height: 1.5; }
  .rtx-flow .ok { color: var(--review-success); font-weight: 700; }
  .rtx-flow .ng { color: var(--review-danger); font-weight: 700; }
</style>
<div class="rtx-flow">
  <div class="grid" id="rtx-flow-grid">
    <div class="hd">段階</div><div class="hd b">修正前</div><div class="hd a">修正後</div>
    <div class="lbl" data-s="0">① 到着</div>
    <div class="cell b" data-s="0">RTX SSRC <code>1001</code> / PT <code>97 (rtx)</code> / <code>rrid=h</code>。SDP に FID なし</div>
    <div class="cell a" data-s="0">同じパケット</div>
    <div class="lbl" data-s="1">② 経路決定<br><small>router.routeRtp</small></div>
    <div class="cell b" data-s="1"><code>ssrcTable</code> にも <code>rid</code> にも <code>trackBySSRC</code> にも該当なし → <code>// bug</code> 分岐で <span class="ng">破棄</span></div>
    <div class="cell a" data-s="1"><code>rrid=h</code> から <code>receiverByRid</code> で受信側を特定。SSRC <code>1001</code> を学習経路に登録（以後は拡張がなくても届く）</div>
    <div class="lbl" data-s="2">③ 受信側の入口<br><small>handleRtxByRid</small></div>
    <div class="cell b none" data-s="2">到達しない</div>
    <div class="cell a" data-s="2">RID <code>h</code> に track があるか、PT が交渉済み RTX かを確認 → RTX SSRC <code>1001</code> を RID <code>h</code> に束縛</div>
    <div class="lbl" data-s="3">④ 媒体 SSRC の決定<br><small>mediaSsrcOfRtx</small></div>
    <div class="cell b none" data-s="3">到達しない</div>
    <div class="cell a" data-s="3">SDP の FID なし → 候補は <b>RID h の現在の媒体 SSRC <code>1000</code> だけ</b>（推測で複数候補から選ばない）</div>
    <div class="lbl" data-s="4">⑤ 欠落台帳で検証<br><small>nack.canRepair</small></div>
    <div class="cell b none" data-s="4">到達しない</div>
    <div class="cell a" data-s="4">SSRC <code>1000</code> の台帳に seq <code>501</code> の欠落があり、timestamp が欠落前後のパケットの範囲（±1 秒）に入るか → <span class="ok">一致</span></div>
    <div class="lbl" data-s="5">⑥ 復元・配信</div>
    <div class="cell b" data-s="5">track に届かない。送った NACK に対する再送が無駄になり、映像は次のキーフレームまで乱れる</div>
    <div class="cell a" data-s="5"><code>unwrapRtx</code> で SSRC <code>1000</code> / seq <code>501</code> / PT <code>96</code> に戻し、track <code>h</code> に <code>retransmission</code> として <span class="ok">配信</span>。台帳から欠落を消し NACK 要求も止まる</div>
  </div>
  <div class="bar">
    <button data-d="-1">前へ</button><button data-d="1">次へ</button><button data-d="all">すべて表示</button>
    <span class="pos" id="rtx-flow-pos"></span>
  </div>
  <div class="detail" id="rtx-flow-detail"></div>
</div>
<script>
(() => {
  const notes = [
    "Chrome の RID simulcast は a=ssrc / a=ssrc-group:FID を出さないため、受信側は RTX SSRC 1001 がどの媒体 SSRC の再送かを SDP から知る手段がない。手がかりはヘッダー拡張 repaired-rtp-stream-id（RID h）だけ。",
    "修正前の router は rtp-stream-id しか見ていなかった。RTX は repaired-rtp-stream-id しか持たないので、どの分岐にも当たらず else の「// bug」に落ちて黙って捨てられていた。修正後は rrid で受信側を引き、最初の 1 パケットで経路を学習する（libwebrtc は RR 受信後に拡張を省略するため）。",
    "無効なパケットに経路を学習させないための入口チェック。track のない RID、未交渉の PT、RTX でない PT は rejected として返し、router はこのパケットが今追加した経路だけを取り消す（以前から学習済みの経路は残す）。",
    "同じ RID の媒体 SSRC は常に 1 つ。再交渉なしで変わったらストリームのリセットとして扱うので、候補が複数になることがない。旧版で反例を作られ続けた「どの候補に当てるかの推測」をなくした。",
    "RTX が運ぶ元 seq と元 timestamp を、NACK が欠落を検出したときに記録した台帳と照合する。重複・NACK 未要求の番号・別ストリームのパケットはここで落ちる。timestamp は前後どちらの順でもよい（B フレーム対策）。",
    "復元後のパケットは通常の受信と同じ経路で台帳に入り、欠落が埋まる。欠落を消すと NACK 要求も同時に止まるので、要求と検証がずれない。",
  ];
  const cells = [...document.querySelectorAll("#rtx-flow-grid [data-s]")];
  const detail = document.getElementById("rtx-flow-detail");
  const pos = document.getElementById("rtx-flow-pos");
  let cur = 0, all = false;
  const render = () => {
    cells.forEach((c) => {
      const s = Number(c.dataset.s);
      c.classList.toggle("row-dim", !all && s !== cur);
      c.classList.toggle("row-on", !all && s === cur && !c.classList.contains("lbl"));
    });
    pos.textContent = all ? "全段階を表示中" : (cur + 1) + " / " + notes.length;
    detail.textContent = all ? "修正前は②で処理が終わり、③〜⑤には到達しない。修正後は②〜⑤のどこかで条件を満たさなければ、そのパケットだけを破棄し、誤った SSRC には届けない。" : notes[cur];
  };
  document.querySelectorAll(".rtx-flow button").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.d === "all") { all = !all; } else { all = false; cur = Math.min(notes.length - 1, Math.max(0, cur + Number(b.dataset.d))); }
    render();
  }));
  render();
})();
</script>

対応するコード:

- 経路決定: [packages/webrtc/src/media/router.ts:367](review-file:packages/webrtc/src/media/router.ts:367) / [diff](review-diff:packages/webrtc/src/media/router.ts:367)
- 受信側の入口: [packages/webrtc/src/media/rtpReceiver.ts:799](review-file:packages/webrtc/src/media/rtpReceiver.ts:799)
- 媒体 SSRC の決定: [packages/webrtc/src/media/rtpReceiver.ts:971](review-file:packages/webrtc/src/media/rtpReceiver.ts:971)
- 台帳での検証: [packages/webrtc/src/media/receiver/nack.ts:215](review-file:packages/webrtc/src/media/receiver/nack.ts:215)
- 復元: [packages/webrtc/src/media/rtpReceiver.ts:1067](review-file:packages/webrtc/src/media/rtpReceiver.ts:1067)

## 3. NACK: receiver に 1 つの状態から、媒体 SSRC ごとの状態へ

修正前の `NackHandler` は、receiver 全体で `newEstSeqNum`（最新の seq）を 1 つだけ持っていました。simulcast では 2 つのレイヤーのパケットが交互に届くため、**別レイヤーの seq との差を欠落と誤認**していました。NACK の宛先 `mediaSourceSsrc` も、最後に受けたパケットの SSRC で上書きされていました。

下の図は、レイヤー h（SSRC `1000`, seq 100 から）とレイヤー q（SSRC `3000`, seq 7000 から）が交互に届き、h の seq 102 が実際に失われた場合です。

<style>
  .rtx-nack { font-family: var(--review-font); color: var(--review-fg); display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 720px) { .rtx-nack { grid-template-columns: 1fr; } }
  .rtx-nack .card { border: 1px solid var(--review-border); border-radius: 8px; padding: 12px; background: var(--review-surface); }
  .rtx-nack .card.b { border-top: 4px solid var(--review-danger); }
  .rtx-nack .card.a { border-top: 4px solid var(--review-success); }
  .rtx-nack h4 { margin: 0 0 8px; font-size: 14px; }
  .rtx-nack .lane { display: flex; align-items: center; gap: 4px; margin: 6px 0; flex-wrap: wrap; }
  .rtx-nack .tag { width: 92px; font-size: 11px; color: var(--review-muted); }
  .rtx-nack .p { min-width: 40px; text-align: center; padding: 4px 4px; border-radius: 4px; font: 12px var(--review-mono); border: 1px solid var(--review-border); background: var(--review-bg); }
  .rtx-nack .h { border-color: var(--review-accent); color: var(--review-accent); }
  .rtx-nack .q { border-color: var(--review-warning); color: var(--review-warning); }
  .rtx-nack .lost { border-style: dashed; border-color: var(--review-danger); color: var(--review-danger); }
  .rtx-nack .state { font: 12px var(--review-mono); padding: 6px 8px; border-radius: 4px; background: var(--review-bg); border: 1px solid var(--review-border); margin-top: 8px; line-height: 1.6; }
  .rtx-nack .ng { color: var(--review-danger); font-weight: 700; }
  .rtx-nack .ok { color: var(--review-success); font-weight: 700; }
</style>
<div class="rtx-nack">
  <div class="card b">
    <h4>修正前: 状態は receiver に 1 つ</h4>
    <div class="lane"><span class="tag">到着順（混在）</span><span class="p h">h100</span><span class="p q">q7000</span><span class="p h">h101</span><span class="p q">q7001</span><span class="p lost">h102</span><span class="p h">h103</span></div>
    <div class="state">
      h100 → newEstSeqNum = 100<br>
      q7000 → 101〜6999 を欠落と判定 <span class="ng">（偽ロス 6899 件、150 件に切り詰め）</span><br>
      h101 / h103 → 7000 より小さいので無視 <span class="ng">（本物の欠落 h102 を検出できない）</span><br>
      NACK 宛先 = 最後に受けた SSRC <span class="ng">（q の番号を h へ、またはその逆へ要求）</span>
    </div>
  </div>
  <div class="card a">
    <h4>修正後: NackStream を媒体 SSRC ごとに保持</h4>
    <div class="lane"><span class="tag">SSRC 1000 (h)</span><span class="p h">100</span><span class="p h">101</span><span class="p lost">102</span><span class="p h">103</span></div>
    <div class="lane"><span class="tag">SSRC 3000 (q)</span><span class="p q">7000</span><span class="p q">7001</span></div>
    <div class="state">
      1000 の台帳: { 102 } → NACK(mediaSsrc=1000, [102]) <span class="ok">本物の欠落だけを正しい宛先へ</span><br>
      3000 の台帳: 空 → タイマー停止 <span class="ok">偽ロスなし</span><br>
      seq の比較は 16 bit の折り返しを考慮（折り返し前の遅着で巨大な偽の欠落を作らない）
    </div>
  </div>
</div>

公開 API の `receiver.onPacketLost`（NACK 送信ごとに 1 回）と統計の NACK 数は従来どおりです。欠落がなくなるとタイマーが止まるようにしました（修正前は止まらないことがありました）。

- `NackHandler`（SSRC ごとの振り分け）: [packages/webrtc/src/media/receiver/nack.ts:36](review-file:packages/webrtc/src/media/receiver/nack.ts:36) / [diff](review-diff:packages/webrtc/src/media/receiver/nack.ts:36)
- `NackStream`（1 SSRC 分の台帳とタイマー）: [packages/webrtc/src/media/receiver/nack.ts:156](review-file:packages/webrtc/src/media/receiver/nack.ts:156)

## 4. 欠落台帳: NACK の要求と RTX の検証を同じ表で行う

`NackStream.addPacket` は、seq が飛んだ時点で欠落ごとに「番号」と「前後に受信したパケットの timestamp」を台帳に記録します。NACK はこの台帳から要求を作り、RTX はこの台帳と照合して復元してよいかを決めます。欠落を台帳から消すのは「埋まったとき」か「上限で捨てるとき」だけで、どちらの場合も NACK 要求が同時に止まります。

下の図で RTX の種類を選ぶと、台帳との照合結果を修正前と並べて表示します（SSRC `1000`、90 kHz、1 フレーム 3000 tick）。

<style>
  .rtx-led { font-family: var(--review-font); color: var(--review-fg); }
  .rtx-led .row { display: flex; gap: 4px; align-items: flex-end; flex-wrap: wrap; margin: 6px 0 12px; }
  .rtx-led .c { width: 64px; text-align: center; border: 1px solid var(--review-border); border-radius: 5px; padding: 5px 2px; font: 12px var(--review-mono); background: var(--review-surface); }
  .rtx-led .c small { display: block; color: var(--review-muted); font-size: 10px; margin-top: 2px; }
  .rtx-led .c.hole { border: 2px dashed var(--review-danger); color: var(--review-danger); }
  .rtx-led .c.filled { border: 2px solid var(--review-success); color: var(--review-success); }
  .rtx-led .c.hit { box-shadow: 0 0 0 3px var(--review-accent); }
  .rtx-led .btns { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .rtx-led button { border: 1px solid var(--review-border); background: var(--review-surface); color: var(--review-fg); padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .rtx-led button[aria-pressed="true"] { border-color: var(--review-accent); color: var(--review-accent); font-weight: 700; }
  .rtx-led .pkt { font: 12px var(--review-mono); padding: 6px 10px; border-radius: 4px; background: var(--review-bg); border: 1px solid var(--review-border); margin-bottom: 8px; }
  .rtx-led .verdict { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .rtx-led .v { border: 1px solid var(--review-border); border-radius: 6px; padding: 8px 10px; font-size: 13px; line-height: 1.5; background: var(--review-surface); }
  .rtx-led .v b { display: block; font-size: 12px; color: var(--review-muted); margin-bottom: 2px; }
  .rtx-led .ok { color: var(--review-success); font-weight: 700; }
  .rtx-led .ng { color: var(--review-danger); font-weight: 700; }
  .rtx-led .chk { font: 12px var(--review-mono); color: var(--review-muted); margin-top: 4px; }
</style>
<div class="rtx-led">
  <div class="row" id="rtx-led-row"></div>
  <div class="btns" id="rtx-led-btns"></div>
  <div class="pkt" id="rtx-led-pkt"></div>
  <div class="verdict">
    <div class="v" style="border-left:4px solid var(--review-danger)"><b>修正前</b><span id="rtx-led-before"></span></div>
    <div class="v" style="border-left:4px solid var(--review-success)"><b>修正後</b><span id="rtx-led-after"></span><div class="chk" id="rtx-led-chk"></div></div>
  </div>
</div>
<script>
(() => {
  const SLACK = 90000;
  const received = { 499: 87000, 500: 90000, 503: 99000, 504: 102000 };
  const holes = { 501: [90000, 99000], 502: [90000, 99000] };
  const cases = [
    { name: "正しい再送", seq: 501, ts: 93000, why: "NACK が要求した seq 501 の再送" },
    { name: "B フレーム順", seq: 502, ts: 88000, why: "送信順と表示順が違い、timestamp が前のパケットより小さい" },
    { name: "重複", seq: 500, ts: 90000, why: "受信済みの seq 500 を送信側が再送（帯域プローブなど）" },
    { name: "NACK 要求外", seq: 9000, ts: 95000, why: "台帳にない番号" },
    { name: "別ストリームの RTX", seq: 502, ts: 3812345678, why: "番号は偶然一致したが、timestamp の基点が別（RFC 3550 のランダム初期値）" },
  ];
  const row = document.getElementById("rtx-led-row");
  const btns = document.getElementById("rtx-led-btns");
  const signedDiff = (a, b) => ((a - b) | 0);
  const draw = (hit, filled) => {
    row.innerHTML = "";
    for (let s = 499; s <= 504; s++) {
      const d = document.createElement("div");
      const isHole = holes[s] && !(filled === s);
      d.className = "c" + (isHole ? " hole" : filled === s ? " filled" : "") + (hit === s ? " hit" : "");
      d.innerHTML = s + "<small>" + (isHole ? "欠落（台帳）" : filled === s ? "RTX で埋まる" : "ts " + received[s]) + "</small>";
      row.appendChild(d);
    }
  };
  const select = (i) => {
    const c = cases[i];
    [...btns.children].forEach((b, j) => b.setAttribute("aria-pressed", String(i === j)));
    document.getElementById("rtx-led-pkt").textContent = "RTX: 元 seq " + c.seq + " / 元 timestamp " + c.ts + " — " + c.why;
    document.getElementById("rtx-led-before").innerHTML = '<span class="ng">破棄</span>（router の // bug 分岐。中身を見る前に捨てる）';
    const hole = holes[c.seq];
    let ok = false, chk;
    if (!hole) {
      chk = "台帳に seq " + c.seq + " の欠落がない → 照合失敗";
    } else {
      const before = signedDiff(hole[0], hole[1]);
      const off = signedDiff(c.ts, hole[1]);
      const lo = Math.min(before, 0) - SLACK, hi = Math.max(before, 0) + SLACK;
      ok = off >= lo && off <= hi;
      chk = "欠落直後の ts 基準の差 " + off + " が [" + lo + ", " + hi + "] に" + (ok ? "入る" : "入らない");
    }
    document.getElementById("rtx-led-after").innerHTML = ok
      ? '<span class="ok">SSRC 1000 / seq ' + c.seq + " として復元</span>。台帳から欠落を消し、NACK 要求も止まる"
      : '<span class="ng">破棄</span>（誤った位置には入れない。RTX SSRC の対応も変えない）';
    document.getElementById("rtx-led-chk").textContent = chk;
    draw(c.seq >= 499 && c.seq <= 504 ? c.seq : undefined, ok ? c.seq : undefined);
  };
  cases.forEach((c, i) => {
    const b = document.createElement("button");
    b.textContent = c.name;
    b.addEventListener("click", () => select(i));
    btns.appendChild(b);
  });
  select(0);
})();
</script>

台帳と NACK 要求の範囲の関係は次のとおりです。台帳は NACK の要求範囲を常に含むので、「NACK が要求している間は、その RTX を必ず検証できる」が成り立ちます。

<svg viewBox="0 0 760 150" width="100%" role="img" aria-label="台帳 1024 件の中に NACK 要求 150 件が含まれる">
  <g font-family="var(--review-font)" font-size="12" fill="var(--review-fg)">
    <rect x="20" y="30" width="700" height="34" rx="6" fill="var(--review-surface)" stroke="var(--review-border)"/>
    <text x="30" y="22" fill="var(--review-muted)">台帳 holes（媒体 SSRC ごと、最大 MAX_HOLES = 1024 件、seq 距離 0x8000 未満）</text>
    <rect x="618" y="34" width="98" height="26" rx="4" fill="none" stroke="var(--review-accent)" stroke-width="2"/>
    <text x="667" y="51" text-anchor="middle" fill="var(--review-accent)">要求中 150</text>
    <rect x="24" y="34" width="590" height="26" rx="4" fill="none" stroke="var(--review-muted)" stroke-dasharray="4 3"/>
    <text x="319" y="51" text-anchor="middle" fill="var(--review-muted)">要求は止まったが検証は可能（LOST_SIZE 超過・再送 10 回超過）</text>
    <text x="20" y="82" fill="var(--review-muted)">← 古い欠落</text>
    <text x="720" y="82" text-anchor="end" fill="var(--review-muted)">新しい欠落 →</text>
    <line x1="20" y1="100" x2="720" y2="100" stroke="var(--review-border)"/>
    <text x="20" y="120" fill="var(--review-danger)">台帳から消す = 要求も同時に止まる（上限超過 / 16 bit で前後不明 / SSRC リセット）</text>
    <text x="20" y="140" fill="var(--review-success)">要求だけ止める = 台帳には残り、遅れて届いた RTX も検証できる</text>
  </g>
</svg>

- 欠落の記録: [packages/webrtc/src/media/receiver/nack.ts:184](review-file:packages/webrtc/src/media/receiver/nack.ts:184)
- 照合: [packages/webrtc/src/media/receiver/nack.ts:215](review-file:packages/webrtc/src/media/receiver/nack.ts:215)
- 台帳の上限処理: [packages/webrtc/src/media/receiver/nack.ts:233](review-file:packages/webrtc/src/media/receiver/nack.ts:233)

## 5. 再交渉なしの媒体 SSRC 切り替え

同じ RID の媒体 SSRC が再交渉なしで `1000` から `2000` に変わる場合です。レビューで何度も反例を作られた箇所で、修正前（初期実装）は「RID の現在の媒体 SSRC」に当てていたため、遅れて届いた旧 RTX が新しい SSRC に混入しました。修正後は切り替えをストリームのリセットとして扱います。

<style>
  .rtx-sw { font-family: var(--review-font); color: var(--review-fg); display: grid; gap: 12px; }
  .rtx-sw .tl { border: 1px solid var(--review-border); border-radius: 8px; padding: 10px 12px; background: var(--review-surface); }
  .rtx-sw .tl.b { border-left: 4px solid var(--review-danger); }
  .rtx-sw .tl.a { border-left: 4px solid var(--review-success); }
  .rtx-sw h4 { margin: 0 0 8px; font-size: 14px; }
  .rtx-sw .steps { display: flex; align-items: stretch; gap: 0; flex-wrap: wrap; }
  .rtx-sw .st { flex: 1 1 130px; padding: 6px 8px; font-size: 12px; line-height: 1.45; border: 1px solid var(--review-border); background: var(--review-bg); position: relative; margin-right: 14px; border-radius: 5px; }
  .rtx-sw .st:not(:last-child)::after { content: "→"; position: absolute; right: -13px; top: 40%; color: var(--review-muted); }
  .rtx-sw .st.bad { border-color: var(--review-danger); }
  .rtx-sw .st.good { border-color: var(--review-success); }
  .rtx-sw code { font-family: var(--review-mono); }
  .rtx-sw .ng { color: var(--review-danger); font-weight: 700; }
  .rtx-sw .ok { color: var(--review-success); font-weight: 700; }
</style>
<div class="rtx-sw">
  <div class="tl b">
    <h4>修正前（初期実装）: RID の「現在の」媒体 SSRC に当てる</h4>
    <div class="steps">
      <div class="st">媒体 <code>1000</code> と RTX <code>1001</code> を学習</div>
      <div class="st">RID h の媒体が <code>2000</code> に変わる（上書き）</div>
      <div class="st">遅れて RTX <code>1001</code>（元 seq 501）が届く</div>
      <div class="st bad"><span class="ng">SSRC 2000 / seq 501 として配信</span>。別ストリームの映像が混入し、2000 の NACK 状態も誤って更新</div>
    </div>
  </div>
  <div class="tl a">
    <h4>修正後: 切り替え = リセット（RID ごとに媒体 SSRC は 1 つ）</h4>
    <div class="steps">
      <div class="st">媒体 <code>1000</code> と RTX <code>1001</code> を学習</div>
      <div class="st good">媒体が <code>2000</code> に変わる → <code>nack.forget(1000)</code> で要求と台帳を同時に破棄。<code>1000</code> と、それを修復した <code>1001</code> を退役</div>
      <div class="st">遅れて RTX <code>1001</code> が届く</div>
      <div class="st good"><span class="ok">退役済みなので破棄</span>（TWCC の記録だけ残す）。新しい RTX <code>2001</code> は <code>2000</code> の台帳で検証され、回復は止まらない</div>
    </div>
  </div>
</div>

旧 SSRC の遅着パケットを破棄するのは意図した挙動です。SSRC が置き換わった後は、旧ストリームの RTX と新ストリームの RTX を十分な確度で区別できないためです（チケット §5 の保証範囲）。

- 切り替え処理: [packages/webrtc/src/media/rtpReceiver.ts:849](review-file:packages/webrtc/src/media/rtpReceiver.ts:849) / [diff](review-diff:packages/webrtc/src/media/rtpReceiver.ts:849)
- 退役済みの破棄: [packages/webrtc/src/media/rtpReceiver.ts:834](review-file:packages/webrtc/src/media/rtpReceiver.ts:834)
- NACK 状態のリセット: [packages/webrtc/src/media/receiver/nack.ts:108](review-file:packages/webrtc/src/media/receiver/nack.ts:108)

## 6. 周辺の不具合と境界のガード

RTX の対応に伴って見つかった問題と、レビューで指摘された境界条件です。どれも「修正前に起きていたこと」と「修正後の状態」を並べています。

<style>
  .rtx-guard { font-family: var(--review-font); color: var(--review-fg); display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
  .rtx-guard .g { border: 1px solid var(--review-border); border-radius: 8px; background: var(--review-surface); overflow: hidden; }
  .rtx-guard .t { padding: 8px 12px; font-weight: 700; font-size: 13px; border-bottom: 1px solid var(--review-border); }
  .rtx-guard .ba { display: grid; grid-template-columns: 1fr 1fr; }
  .rtx-guard .ba > div { padding: 8px 10px; font-size: 12px; line-height: 1.5; }
  .rtx-guard .ba > div:first-child { border-right: 1px solid var(--review-border); }
  .rtx-guard .k { display: block; font-size: 11px; font-weight: 700; margin-bottom: 2px; }
  .rtx-guard .kb { color: var(--review-danger); }
  .rtx-guard .ka { color: var(--review-success); }
  .rtx-guard code { font-family: var(--review-mono); }
</style>
<div class="rtx-guard">
  <div class="g"><div class="t">track の codec</div><div class="ba">
    <div><span class="k kb">修正前</span><code>codecs[0]</code> を採用。<code>video/rtx</code> が先頭の SDP では track の codec が RTX になる</div>
    <div><span class="k ka">修正後</span><code>primaryTrackCodec</code> が RTX / RED / FEC を飛ばす。RID 登録と <code>resyncCodecs</code> の両方で使用</div>
  </div></div>
  <div class="g"><div class="t">未交渉の payload type</div><div class="ba">
    <div><span class="k kb">修正前（途中版）</span>未知 PT のパケット 1 個で RID の媒体 SSRC が切り替わり、正常な旧 SSRC が退役して配信停止</div>
    <div><span class="k ka">修正後</span>PT を先に検証。未交渉なら媒体 SSRC の切り替え・経路・track の学習に使わず破棄</div>
  </div></div>
  <div class="g"><div class="t">無効パケットと学習済み経路</div><div class="ba">
    <div><span class="k kb">修正前（途中版）</span>無効パケットの SSRC が「忘れる」経路に入り、以前に学習した RTX 経路まで削除。拡張なしの後続 RTX が届かない</div>
    <div><span class="k ka">修正後</span>「却下」と「忘却」を分離。却下では、そのパケットが今追加した経路だけを取り消す</div>
  </div></div>
  <div class="g"><div class="t">rollback</div><div class="ba">
    <div><span class="k kb">修正前（途中版）</span>スナップショットから、退役済みの旧 SSRC の経路と track 対応が復活し、旧 SSRC の遅着が再び配信</div>
    <div><span class="k ka">修正後</span>パケットから学習した SSRC は、現在の表から消えていれば復元しない</div>
  </div></div>
  <div class="g"><div class="t">壊れた RTX</div><div class="ba">
    <div><span class="k kb">修正前</span><code>apt</code> codec がなければ RTX の PT のまま、SDP 対応がなければ SSRC 未定義のまま <code>unwrapRtx</code> して配信しうる</div>
    <div><span class="k ka">修正後</span><code>apt</code> codec 不在・媒体 SSRC 未解決の RTX は破棄。壊れたパケットを配信しない</div>
  </div></div>
  <div class="g"><div class="t">保持状態の上限</div><div class="ba">
    <div><span class="k kb">修正前（途中版）</span>パケットから学習した SSRC が増え続け、経路と統計が解放されない</div>
    <div><span class="k ka">修正後</span>RID ごと・receiver ごとに上限を置き、追い出した SSRC の経路・track・統計も同時に解放（§9）</div>
  </div></div>
</div>

- track codec: [packages/webrtc/src/media/codecCompatibility.ts:94](review-file:packages/webrtc/src/media/codecCompatibility.ts:94) / [packages/webrtc/src/media/router.ts:322](review-file:packages/webrtc/src/media/router.ts:322)
- PT の検証: [packages/webrtc/src/media/rtpReceiver.ts:754](review-file:packages/webrtc/src/media/rtpReceiver.ts:754)
- 却下された経路の取り消し: [packages/webrtc/src/media/router.ts:444](review-file:packages/webrtc/src/media/router.ts:444)
- rollback: [packages/webrtc/src/media/router.ts:164](review-file:packages/webrtc/src/media/router.ts:164) / [packages/webrtc/src/media/router.ts:184](review-file:packages/webrtc/src/media/router.ts:184)

## 7. 主要変更

| 領域 | 内容 | リンク |
| --- | --- | --- |
| 欠落台帳と NACK | `NackHandler` が媒体 SSRC ごとに `NackStream` を持つ。欠落ごとに番号と前後パケットの timestamp を記録し、NACK 要求と RTX 検証が同じ台帳を使う | [packages/webrtc/src/media/receiver/nack.ts:156](review-file:packages/webrtc/src/media/receiver/nack.ts:156) / [diff](review-diff:packages/webrtc/src/media/receiver/nack.ts:156) |
| RTX の検証 | `canRepair` が「台帳に番号がある」かつ「timestamp が欠落前後の範囲に収まる（符号付き差、slack 付き）」を判定 | [packages/webrtc/src/media/receiver/nack.ts:215](review-file:packages/webrtc/src/media/receiver/nack.ts:215) |
| ルーティング | `repaired-rtp-stream-id` 付きパケットを RID の receiver へ渡し、最初の rid / rrid 付きパケットで SSRC を学習済み経路として登録 | [packages/webrtc/src/media/router.ts:367](review-file:packages/webrtc/src/media/router.ts:367) / [diff](review-diff:packages/webrtc/src/media/router.ts:367) |
| RTX の結び付け | `handleRtxByRid` が RTX SSRC を RID に束縛。`mediaSsrcOfRtx` が RID の現在の媒体 SSRC だけを候補にして復元 | [packages/webrtc/src/media/rtpReceiver.ts:799](review-file:packages/webrtc/src/media/rtpReceiver.ts:799) / [packages/webrtc/src/media/rtpReceiver.ts:971](review-file:packages/webrtc/src/media/rtpReceiver.ts:971) |
| SSRC 切り替え | 同じ RID で媒体 SSRC は 1 つ。変わったらリセットし、旧 SSRC の NACK・台帳・RTX 対応を同時に捨て、遅着を破棄 | [packages/webrtc/src/media/rtpReceiver.ts:849](review-file:packages/webrtc/src/media/rtpReceiver.ts:849) |
| track codec | RTX/RED を飛ばす `primaryTrackCodec` を RID 登録と `resyncCodecs` で使用 | [packages/webrtc/src/media/codecCompatibility.ts:94](review-file:packages/webrtc/src/media/codecCompatibility.ts:94) / [packages/webrtc/src/media/rtpReceiver.ts:378](review-file:packages/webrtc/src/media/rtpReceiver.ts:378) |
| 破損パケット防止 | 媒体 SSRC 未解決、`apt` codec 不在の RTX は破棄 | [packages/webrtc/src/media/rtpReceiver.ts:1067](review-file:packages/webrtc/src/media/rtpReceiver.ts:1067) |
| テスト | nack / router の単体テスト（共通の準備は `rtpReceiverTestUtils.ts`）と、`receiver.nack` の要求リストを判定基準にした property テスト | [packages/webrtc/tests/media/nack.test.ts](review-file:packages/webrtc/tests/media/nack.test.ts) / [packages/webrtc/tests/media/router.test.ts](review-file:packages/webrtc/tests/media/router.test.ts) / [packages/webrtc/tests/media/rtpReceiverTestUtils.ts](review-file:packages/webrtc/tests/media/rtpReceiverTestUtils.ts) / [packages/webrtc/tests/pbt/simulcastRtx/generator.ts](review-file:packages/webrtc/tests/pbt/simulcastRtx/generator.ts) / [packages/webrtc/tests/pbt/simulcastRtx/simulcastRtxProperty.test.ts](review-file:packages/webrtc/tests/pbt/simulcastRtx/simulcastRtxProperty.test.ts) |
| 文書 | `changelog.md` の Unreleased、`packages/webrtc/AGENTS.md`（`pbt:deep` に simulcastRtx を追加） | [changelog.md:7](review-file:changelog.md:7) / [packages/webrtc/AGENTS.md](review-file:packages/webrtc/AGENTS.md) |

## 8. 判断理由と設計の変遷

RTX パケットだけでは、どの媒体 SSRC の再送かを確定できません。初期の版は受信側の状態から推測するルールを足し続け、そのたびにレビューで別の到着順の反例が見つかりました。最終形では推測をやめ、パケットが運ぶ元 seq と timestamp を欠落台帳で検証する方式に変えました。

<style>
  .rtx-hist { font-family: var(--review-font); color: var(--review-fg); position: relative; padding-left: 22px; }
  .rtx-hist::before { content: ""; position: absolute; left: 7px; top: 6px; bottom: 6px; width: 2px; background: var(--review-border); }
  .rtx-hist .it { position: relative; margin: 0 0 10px; padding: 8px 12px; border: 1px solid var(--review-border); border-radius: 6px; background: var(--review-surface); font-size: 13px; line-height: 1.5; }
  .rtx-hist .it::before { content: ""; position: absolute; left: -20px; top: 12px; width: 10px; height: 10px; border-radius: 50%; background: var(--review-danger); }
  .rtx-hist .it.mid::before { background: var(--review-warning); }
  .rtx-hist .it.fin::before { background: var(--review-success); }
  .rtx-hist .it.fin { border-color: var(--review-success); }
  .rtx-hist .h { font-weight: 700; }
  .rtx-hist .x { color: var(--review-muted); font-size: 12px; }
</style>
<div class="rtx-hist">
  <div class="it"><div class="h">推測 1〜5: RID の現在値 / 切り替え時に固定 / 一律破棄 / NACK の一意性 / seq の近さ</div><div class="x">反例: 旧 RTX の遅着、RTX が媒体より先着、旧・新が同じ seq を失う、SSRC ごとに seq が独立 … いずれも受信側の状態だけでは区別できない</div></div>
  <div class="it mid"><div class="h">検証方式（受信済みリング + 前後の timestamp）</div><div class="x">反例: B フレームで timestamp が単調でない、長いバースト、古い遅着がリングを上書き、NACK 要求中なのに窓の外 … 要求と検証が別の上限を持っていた</div></div>
  <div class="it fin"><div class="h">最終形: 欠落台帳の一本化 + RID ごとに媒体 SSRC は 1 つ</div><div class="x">要求と検証が同じ台帳を参照し、台帳から消すと要求も止まる。複数候補の判定が不要になり、境界ごとの不整合がなくなった。その後の指摘（rollback、未知 PT、無効パケット）は入口のガードで対応</div></div>
</div>

- **台帳の一本化**: NACK の要求と RTX の検証を別々の上限で保持すると、片方だけが切れて不整合になります。台帳から欠落を捨てるときに NACK 要求も同時に止まる構造にし、「NACK が (SSRC, seq) を要求している間は、その RTX を検証できる」を保証しました。
- **同じ RID で媒体 SSRC は 1 つ**: SDP に対応がない以上、複数候補から RTX を割り当てる方式は誤配信の余地が残ります。切り替えはリセットとして扱い、判別できない遅着パケットの破棄を許容しました。
- **SDP の対応がない RTX は台帳照合を必須にした**: 重複、NACK 未要求の番号、別ストリームの RTX は復元しません。

保証範囲外（チケット §5）: seq と timestamp の基点が同じストリーム（RFC 3550 §5.1 違反）は、パケットがビット単位で同一になるため判別できません。

## 9. 保持上限と NACK を途中で切らない理由

| 上限 | 値 | 超えたときの扱い | NACK を切らない（または同時に捨てる）理由 |
| --- | --- | --- | --- |
| 台帳の欠落数 `MAX_HOLES` | 1024 / 媒体 SSRC | 古い欠落を台帳から削除 | 削除は欠落そのものの削除なので NACK 要求も同時に止まる。NACK 要求数 `LOST_SIZE`(150) より大きく、要求中の欠落は常に台帳にある ([nack.ts:19](review-file:packages/webrtc/src/media/receiver/nack.ts:19)) |
| seq 距離 | 0x8000 未満 | 超えた欠落を台帳から削除 | 16 bit では前後を区別できないため。台帳から消すのと同時に要求も止まる ([nack.ts:233](review-file:packages/webrtc/src/media/receiver/nack.ts:233)) |
| NACK 要求数 `LOST_SIZE` | 150（新しい順） | 要求だけ止める（台帳には残す） | 遅れて届く RTX を検証できるよう台帳は残す。要求が止まるだけで検証能力は縮まない |
| 再送回数 `retryCount` | 10 | 要求だけ止める（台帳には残す） | 同上 |
| NACK 状態の SSRC 数 `MAX_NACK_STREAMS` | 16 / receiver | 最も古く受信した SSRC を `close()` して削除 | SSRC ごとにタイマーと台帳を同時に捨てるので不整合なし ([nack.ts:26](review-file:packages/webrtc/src/media/receiver/nack.ts:26)) |
| RTX SSRC 数 | 8 / RID | 現在の媒体 SSRC を修復していないものから追い出す | 使用中の RTX は残る。追い出した SSRC の学習経路も同時に消す ([rtpReceiver.ts:63](review-file:packages/webrtc/src/media/rtpReceiver.ts:63)) |
| 退役 SSRC 数 | 8 / RID | 古いものから忘れる | 忘れた SSRC が再出現すると新しい切り替え（リセット）として扱う ([rtpReceiver.ts:70](review-file:packages/webrtc/src/media/rtpReceiver.ts:70)) |
| 媒体 SSRC 数 | 1 / RID | 切り替え時にリセット | 旧 SSRC の NACK・台帳・RTX 対応を同時に解放 |

## 10. レビュアーが確認すべき点・リスク

- **挙動の互換性**: `NackHandler` は公開 `receiver.onPacketLost` を維持（NACK 送信ごとに 1 回）。アイドル時にタイマーが止まるようになり、seq 比較が 16 bit 折り返しに対応しました。公開 API のシグネチャ変更はありません。
- **RTX の取りこぼし**: SDP に対応がない RTX は台帳に載る場合のみ復元します。NACK が要求していない RTX（送信側が自発的に送る再送）は破棄されます。実ブラウザでの影響は未確認です。
- **SSRC 変更時の遅着破棄**: リセット時に旧 SSRC と旧 RTX SSRC の遅着パケットを破棄します。判別できないパケットの破棄はチケットで許容済みです。
- **ネゴシエーション状態**: 学習した経路は rollback / commit を跨いで保持し、退役・追い出しした経路は baseline から復活させません（`snapshotRoutes` / `restoreRoutes`）。
- **timestamp slack**: B フレームを考慮して 1 秒（メディアクロック換算）。広めの値の妥当性を見てください（[rtpReceiver.ts:72](review-file:packages/webrtc/src/media/rtpReceiver.ts:72)）。
- 実ブラウザ（Chrome）での `examples/mediachannel/rtx/simulcast_offer.ts` の手動確認は行っていません。

## 11. 検証結果

本ドキュメント更新時に自分で実行したもの:

- `cd packages/webrtc && npx vitest run tests/media/nack.test.ts tests/media/router.test.ts tests/pbt/simulcastRtx` → 3 ファイル / 88 テスト成功（2026-11-10、HEAD `c5c4dfcce`）。

この更新では実行していないもの: `npm run type`、`npm run test:small`、`npm run e2e`、`npm run wpt`、`memleak`、`pbt:deep`、Chrome での手動確認。これまでのレビュー修正時の結果は会話の報告にありますが、この文書の更新時には再確認していません。
