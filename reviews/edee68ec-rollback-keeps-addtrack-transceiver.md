---
ide:
  viewer: review-document
  version: 1
  title: "#817 rollback で addTrack 済み transceiver を保持する"
  dock: right
  baseCommit: 76dbe33602796b4eed827bb4063b6e96d4d5f508
---
# #817 remote rollback で addTrack 済み transceiver が消える問題の修正

## 概要

remote offer を rollback すると、アプリが `addTrack()` で使った transceiver が消えることがありました。`sender.replaceTrack(null)` や `removeTrack()` で track を外したあとに起きます。修正後は、同じ object のまま `stopped === false`・`mid === null` で残ります。

原因は、保持するかどうかを「いま `sender.track` があるか」だけで決めていたことです。`addTrack()` が remote 生成の transceiver を再利用したことは、develop でもすでに `reusedForAddTrack` フィールドに記録されていました。ところが判定はそれを見ていませんでした。修正後の判定は `createdBy === "addTrack" || reusedForAddTrack || !!sender.track` です。どちらのフィールドも transceiver 自身が持ち、rollback では戻りません。

あわせて、次の流れも直しました。

- remote offer の保留中に `addTrack()` が transceiver を新しく作ると、rollback で `TypeError` になっていました（develop にもある不具合です。図 4）。
- 上の修正の 1 回目で、codec 検証に失敗するたびに DTLS transport が残る回帰が入っていました。レビューの指摘を受けて直しています（図 5）。
- **追加要件**：モジュールスコープに置いていた実行時の状態を、すべて持ち主のインスタンスへ移しました（図 6）。対象は、この修正の 1 回目で入れた WeakSet と、同じ形の既存 5 件です。再発防止として、root `AGENTS.md` に指示を足し、検査テストを追加しました。

## 図 1：#817 の処理の流れ（Before / After）

<style>
  .f817 { display:flex; gap:14px; flex-wrap:wrap; font-family:var(--review-font); }
  .f817 .pane { flex:1; min-width:320px; border:1px solid var(--review-border); border-radius:8px; padding:8px 10px; background:var(--review-surface); }
  .f817 h4 { margin:2px 0 6px; font-size:14px; }
  .f817 .b { color:var(--review-danger); } .f817 .a { color:var(--review-success); }
  .f817 svg text { font-family:var(--review-font); }
  .f817 svg .mono { font-family:var(--review-mono); }
  .f817-legend { display:flex; gap:16px; flex-wrap:wrap; font:12px var(--review-font); color:var(--review-muted); margin-top:6px; }
  .f817-legend span::before { content:""; display:inline-block; width:12px; height:12px; border-radius:3px; margin-right:5px; vertical-align:-2px; border:2px solid var(--c); }
</style>

<div class="f817">
<div class="pane">
<h4 class="b">Before（develop）</h4>
<svg viewBox="0 0 360 520" width="100%" role="img" aria-label="Before: rollback で transceiver が除去される流れ">
  <defs><marker id="f817ab" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--review-muted)"/></marker></defs>
  <g fill="none" stroke-width="1.5">
    <rect x="10" y="8" width="340" height="56" rx="7" stroke="var(--review-border)"/>
    <rect x="10" y="86" width="340" height="56" rx="7" stroke="var(--review-border)"/>
    <rect x="10" y="164" width="340" height="56" rx="7" stroke="var(--review-border)"/>
    <rect x="10" y="242" width="340" height="56" rx="7" stroke="var(--review-border)"/>
    <polygon points="180,320 350,360 180,400 10,360" stroke="var(--review-danger)" stroke-width="2.5"/>
    <rect x="10" y="430" width="340" height="80" rx="7" stroke="var(--review-danger)" stroke-width="2.5"/>
  </g>
  <g stroke="var(--review-muted)" stroke-width="1.5" marker-end="url(#f817ab)">
    <line x1="180" y1="64" x2="180" y2="84"/><line x1="180" y1="142" x2="180" y2="162"/><line x1="180" y1="220" x2="180" y2="240"/><line x1="180" y1="298" x2="180" y2="318"/><line x1="180" y1="400" x2="180" y2="428"/>
  </g>
  <g font-size="12.5" fill="var(--review-fg)">
    <text x="20" y="30" class="mono">① b.setRemoteDescription(offer)</text>
    <text x="20" y="50" fill="var(--review-muted)">transceiver T を作成（createdBy: "remote"）</text>
    <text x="20" y="108" class="mono">② b.addTrack(track)</text>
    <text x="20" y="128" fill="var(--review-muted)">T を再利用 / T.reusedForAddTrack = true</text>
    <text x="20" y="186" class="mono">③ replaceTrack(null) / removeTrack()</text>
    <text x="20" y="206" fill="var(--review-muted)">sender.track = null（reusedForAddTrack は残る）</text>
    <text x="20" y="264" class="mono">④ setRemoteDescription(rollback)</text>
    <text x="20" y="284" fill="var(--review-muted)">restoreNegotiationState(): remoteCreated を判定</text>
    <text x="180" y="356" text-anchor="middle" class="mono">heldByApplication</text>
    <text x="180" y="376" text-anchor="middle" class="mono" fill="var(--review-danger)">!!sender.track → false</text>
    <text x="20" y="452" class="mono" fill="var(--review-danger)">⑤ removeRemoteTransceiver(T)</text>
    <text x="20" y="472" fill="var(--review-danger)">getTransceivers() から消え stopped = true</text>
    <text x="20" y="492" fill="var(--review-danger)">アプリが持つ sender が使えなくなる ✗</text>
  </g>
</svg>
</div>
<div class="pane">
<h4 class="a">After（この修正）</h4>
<svg viewBox="0 0 360 520" width="100%" role="img" aria-label="After: rollback で transceiver が保持される流れ">
  <defs><marker id="f817aa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--review-muted)"/></marker></defs>
  <g fill="none" stroke-width="1.5">
    <rect x="10" y="8" width="340" height="56" rx="7" stroke="var(--review-border)"/>
    <rect x="10" y="86" width="340" height="56" rx="7" stroke="var(--review-border)"/>
    <rect x="10" y="164" width="340" height="56" rx="7" stroke="var(--review-border)"/>
    <rect x="10" y="242" width="340" height="56" rx="7" stroke="var(--review-border)"/>
    <polygon points="180,316 350,360 180,404 10,360" stroke="var(--review-accent)" stroke-width="2.5"/>
    <rect x="10" y="430" width="340" height="80" rx="7" stroke="var(--review-success)" stroke-width="2.5"/>
  </g>
  <g stroke="var(--review-muted)" stroke-width="1.5" marker-end="url(#f817aa)">
    <line x1="180" y1="64" x2="180" y2="84"/><line x1="180" y1="142" x2="180" y2="162"/><line x1="180" y1="220" x2="180" y2="240"/><line x1="180" y1="298" x2="180" y2="314"/><line x1="180" y1="404" x2="180" y2="428"/>
  </g>
  <g font-size="12.5" fill="var(--review-fg)">
    <text x="20" y="30" class="mono">① b.setRemoteDescription(offer)</text>
    <text x="20" y="50" fill="var(--review-muted)">transceiver T を作成（createdBy: "remote"）</text>
    <text x="20" y="108" class="mono">② b.addTrack(track)</text>
    <text x="20" y="128" fill="var(--review-muted)">T を再利用 / T.reusedForAddTrack = true</text>
    <text x="20" y="186" class="mono">③ replaceTrack(null) / removeTrack()</text>
    <text x="20" y="206" fill="var(--review-muted)">sender.track = null（reusedForAddTrack は残る）</text>
    <text x="20" y="264" class="mono">④ setRemoteDescription(rollback)</text>
    <text x="20" y="284" fill="var(--review-muted)">restoreNegotiationState(): remoteCreated を判定</text>
    <text x="180" y="342" text-anchor="middle" class="mono">heldByApplication</text>
    <text x="180" y="358" text-anchor="middle" class="mono" font-size="10.5" fill="var(--review-accent)">createdBy === "addTrack"</text>
    <text x="180" y="372" text-anchor="middle" class="mono" font-size="10.5" fill="var(--review-accent)">|| reusedForAddTrack</text>
    <text x="180" y="386" text-anchor="middle" class="mono" font-size="10.5" fill="var(--review-success)">|| !!sender.track → true</text>
    <text x="20" y="452" class="mono" fill="var(--review-success)">⑤ 同じ T を保持</text>
    <text x="20" y="472" fill="var(--review-success)">createdNegotiationState に戻し mid = null</text>
    <text x="20" y="492" fill="var(--review-success)">stopped = false、sender はそのまま使える ✓</text>
  </g>
</svg>
</div>
</div>
<div class="f817-legend"><span style="--c:var(--review-danger)">問題が起きる箇所</span><span style="--c:var(--review-accent)">変更した判定</span><span style="--c:var(--review-success)">修正で変わった結果</span><span style="--c:var(--review-border)">変わらない処理</span></div>

①〜④ は Before と After で同じです。② で `reusedForAddTrack` が立つことも develop と変わりません。違いは ④ の判定だけです。After は、この既存の記録と `createdBy` も見るようになりました。

- 判定： [packages/webrtc/src/media/rtpTransceiver.ts:293](review-diff:packages/webrtc/src/media/rtpTransceiver.ts:293)（`heldByApplication`）
- 判定に使う既存の記録： [packages/webrtc/src/media/rtpTransceiver.ts:55](review-file:packages/webrtc/src/media/rtpTransceiver.ts:55)（`reusedForAddTrack`）、[packages/webrtc/src/transceiverManager.ts:640](review-file:packages/webrtc/src/transceiverManager.ts:640)（`noteReusedForAddTrack`。remote 生成のものだけに立てる）
- 判定を使う rollback 側（変更なし）： [packages/webrtc/src/transceiverManager.ts:214](review-file:packages/webrtc/src/transceiverManager.ts:214)、[packages/webrtc/src/negotiationTransaction.ts:426](review-file:packages/webrtc/src/negotiationTransaction.ts:426)

rollback で除去されうるのは、remote offer が作った transceiver だけです。そうした transceiver に `addTrack()` を使うと、空の sender を再利用する分岐か、送信しない transceiver を再利用する分岐を必ず通ります。どちらの分岐でも `reusedForAddTrack` が立つので、#817 を判定するにはこのフラグで足ります。`createdBy === "addTrack"` は、`addTrack()` が新しく作った transceiver にも、このプロパティの意味を合わせるために加えています。

## 図 2：ステップごとの状態（Before / After を同時に表示）

<style>
  .s817 { font-family:var(--review-font); font-size:13px; }
  .s817 .ctl { display:flex; gap:8px; align-items:center; margin-bottom:8px; }
  .s817 button { border:1px solid var(--review-border); background:var(--review-surface); color:var(--review-fg); padding:3px 12px; border-radius:4px; cursor:pointer; }
  .s817 .op { font-family:var(--review-mono); font-weight:bold; }
  .s817 table { border-collapse:collapse; width:100%; }
  .s817 th, .s817 td { border:1px solid var(--review-border); padding:5px 8px; text-align:left; }
  .s817 th { background:var(--review-surface); }
  .s817 td.v { font-family:var(--review-mono); }
  .s817 td.diff-b { color:var(--review-danger); font-weight:bold; }
  .s817 td.diff-a { color:var(--review-success); font-weight:bold; }
  .s817 .note { color:var(--review-muted); margin-top:6px; min-height:2.6em; }
</style>

<div class="s817">
  <div class="ctl"><button data-d="-1">← 前へ</button><button data-d="1">次へ →</button><span class="op"></span></div>
  <table>
    <thead><tr><th>状態</th><th>Before</th><th>After</th></tr></thead>
    <tbody></tbody>
  </table>
  <div class="note"></div>
</div>

<script>
(() => {
  const root = document.querySelector(".s817");
  const rows = ["sender.track", "T.reusedForAddTrack", "heldByApplication", "T の状態"];
  const steps = [
    { op: "① b.setRemoteDescription(offer)", b: ["null", "false", "false", "remoteCreated, mid=0"], a: ["null", "false", "false", "remoteCreated, mid=0"], note: "remote offer で T が作られます。この時点では両者とも同じです。" },
    { op: "② b.addTrack(track)", b: ["track", "true", "true", "remoteCreated, mid=0"], a: ["track", "true", "true", "remoteCreated, mid=0"], note: "どちらも noteReusedForAddTrack(T) が reusedForAddTrack を立てます。ここも同じです。" },
    { op: "③ sender.replaceTrack(null) / removeTrack(sender)", b: ["null", "true", "false", "remoteCreated, mid=0"], a: ["null", "true", "true", "remoteCreated, mid=0"], note: "ここで両者が分かれます。記録は両方に残っていますが、Before の判定は sender.track しか見ません。" },
    { op: "④ b.setRemoteDescription({type:'rollback'})", b: ["null", "true", "false", "除去・stopped=true"], a: ["null", "true", "true", "保持・mid=null・stopped=false"], note: "restoreNegotiationState() が heldByApplication を見て、除去するか保持するかを決めます。" },
    { op: "⑤ a.createOffer → b.answer（再交渉）", b: ["—", "—", "—", "T は使えない"], a: ["null", "true", "true", "T が新しい m-line で交渉される"], note: "#817 の scene は、rollback のあとに再交渉まで進めて結果を確認します。" },
  ];
  let i = 0;
  const tbody = root.querySelector("tbody");
  const render = () => {
    const s = steps[i];
    root.querySelector(".op").textContent = `${i + 1}/${steps.length}  ${s.op}`;
    root.querySelector(".note").textContent = s.note;
    tbody.innerHTML = "";
    rows.forEach((label, r) => {
      const tr = document.createElement("tr");
      const differ = s.b[r] !== s.a[r];
      [label, s.b[r], s.a[r]].forEach((v, c) => {
        const td = document.createElement(c ? "td" : "th");
        td.textContent = v;
        if (c) td.className = "v" + (differ ? (c === 1 ? " diff-b" : " diff-a") : "");
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  };
  root.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    i = Math.min(steps.length - 1, Math.max(0, i + Number(b.dataset.d)));
    render();
  }));
  render();
})();
</script>

③ で判定が分かれ、④ で結果が変わります。この再現手順は [packages/webrtc/tests/pbt/model/scenes.ts:346](review-diff:packages/webrtc/tests/pbt/model/scenes.ts:346) の 2 つの scene（`replaceTrack` と `removeTrack`）です。どちらも修正前のコードでは失敗します。そこで使う `takeTrack` / `detachTrack` のステップは [packages/webrtc/tests/pbt/model/generator.ts:158](review-diff:packages/webrtc/tests/pbt/model/generator.ts:158) で追加しました。

## 図 3：rollback で保持されるか（操作ごとの比較）

<style>
  .m817 { border-collapse:collapse; width:100%; font:13px var(--review-font); }
  .m817 th, .m817 td { border:1px solid var(--review-border); padding:5px 8px; }
  .m817 th { background:var(--review-surface); text-align:left; }
  .m817 td.k { color:var(--review-success); } .m817 td.r { color:var(--review-muted); }
  .m817 td.chg { background:color-mix(in srgb, var(--review-success) 15%, transparent); font-weight:bold; }
  .m817 td.was { color:var(--review-danger); font-weight:bold; }
  .m817 code { font-family:var(--review-mono); }
</style>

<table class="m817">
  <thead><tr><th>remote offer の後にアプリが T にした操作</th><th>Before</th><th>After</th><th>補足</th></tr></thead>
  <tbody>
    <tr><td><code>addTrack()</code>（track を持ったまま）</td><td class="k">保持</td><td class="k">保持</td><td>どちらも <code>!!sender.track</code> で保持されます</td></tr>
    <tr><td><code>addTrack()</code> → <code>replaceTrack(null)</code></td><td class="was">除去 ✗</td><td class="k chg">保持 ✓</td><td>#817。<code>reusedForAddTrack</code> で保持</td></tr>
    <tr><td><code>addTrack()</code> → <code>removeTrack()</code></td><td class="was">除去 ✗</td><td class="k chg">保持 ✓</td><td>#817。<code>reusedForAddTrack</code> で保持</td></tr>
    <tr><td><code>replaceTrack(track)</code> だけ</td><td class="k">保持</td><td class="k">保持</td><td>werift 独自の挙動を残しています（WPT <code>?interop-2026</code> は除去を期待）</td></tr>
    <tr><td><code>stop()</code> / direction / <code>setCodecPreferences()</code> だけ</td><td class="r">除去</td><td class="r">除去</td><td>develop と同じ（scene で確認）</td></tr>
    <tr><td>何もしない</td><td class="r">除去</td><td class="r">除去</td><td>W3C の rollback 手順どおり</td></tr>
  </tbody>
</table>

変わるのは、`addTrack()` の後に track を外した 2 行だけです。判定は `!!sender.track` を含む OR のままなので、`!!sender.track` だけで保持されていた行の結果は変わりません。`replaceTrack(track)` は `reusedForAddTrack` を立てないので、外した後は従来どおり除去されます。

## 図 4：関連修正 — 保留中の addTrack で新規作成した transceiver の rollback（TypeError）

<style>
  .t817 { display:flex; gap:14px; flex-wrap:wrap; font-family:var(--review-font); }
  .t817 .pane { flex:1; min-width:320px; border:1px solid var(--review-border); border-radius:8px; padding:8px 10px; background:var(--review-surface); }
  .t817 h4 { margin:2px 0 6px; font-size:14px; }
  .t817 svg text { font-family:var(--review-font); } .t817 svg .mono { font-family:var(--review-mono); }
</style>

<div class="t817">
<div class="pane">
<h4 style="color:var(--review-danger)">Before（develop）</h4>
<svg viewBox="0 0 360 430" width="100%" role="img" aria-label="Before: transport なしの作成時状態に戻り TypeError">
  <defs><marker id="t817ab" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--review-muted)"/></marker></defs>
  <g fill="none" stroke-width="1.5">
    <rect x="10" y="8" width="340" height="56" rx="7" stroke="var(--review-border)"/>
    <rect x="10" y="86" width="340" height="56" rx="7" stroke="var(--review-danger)" stroke-width="2.5"/>
    <rect x="10" y="164" width="340" height="56" rx="7" stroke="var(--review-border)"/>
    <rect x="10" y="242" width="340" height="56" rx="7" stroke="var(--review-border)"/>
    <rect x="10" y="320" width="340" height="100" rx="7" stroke="var(--review-danger)" stroke-width="2.5"/>
  </g>
  <g stroke="var(--review-muted)" stroke-width="1.5" marker-end="url(#t817ab)">
    <line x1="180" y1="64" x2="180" y2="84"/><line x1="180" y1="142" x2="180" y2="162"/><line x1="180" y1="220" x2="180" y2="240"/><line x1="180" y1="298" x2="180" y2="318"/>
  </g>
  <g font-size="12.5" fill="var(--review-fg)">
    <text x="20" y="30" class="mono">① a.setRemoteDescription(offer) 保留中</text>
    <text x="20" y="50" fill="var(--review-muted)">a.addTrack(track) → 再利用できる T がない</text>
    <text x="20" y="108" class="mono">② addTransceiver(track, undefined)</text>
    <text x="20" y="128" fill="var(--review-danger)">createdNegotiationState = { dtlsTransport: undefined }</text>
    <text x="20" y="186" class="mono">③ pc.addTrack: setDtlsTransport(</text>
    <text x="20" y="206" class="mono" fill="var(--review-muted)">  findOrCreateTransport())  ← 作成後に付ける</text>
    <text x="20" y="264" class="mono">④ setRemoteDescription(rollback)</text>
    <text x="20" y="284" fill="var(--review-muted)">restoreNegotiationState(createdNegotiationState)</text>
    <text x="20" y="342" class="mono" fill="var(--review-danger)">⑤ setDtlsTransport(undefined)</text>
    <text x="20" y="362" class="mono" fill="var(--review-danger)">RTCRtpSender: this.dtlsTransport</text>
    <text x="20" y="380" class="mono" fill="var(--review-danger)">  .onStateChange → TypeError ✗</text>
    <text x="20" y="404" fill="var(--review-danger)">rollback が例外で失敗する</text>
  </g>
</svg>
</div>
<div class="pane">
<h4 style="color:var(--review-success)">After（この修正）</h4>
<svg viewBox="0 0 360 430" width="100%" role="img" aria-label="After: transport 付きの作成時状態に戻る">
  <defs><marker id="t817aa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--review-muted)"/></marker></defs>
  <g fill="none" stroke-width="1.5">
    <rect x="10" y="8" width="340" height="56" rx="7" stroke="var(--review-border)"/>
    <rect x="10" y="86" width="340" height="56" rx="7" stroke="var(--review-accent)" stroke-width="2.5"/>
    <rect x="10" y="164" width="340" height="56" rx="7" stroke="var(--review-border)" stroke-dasharray="5 4"/>
    <rect x="10" y="242" width="340" height="56" rx="7" stroke="var(--review-border)"/>
    <rect x="10" y="320" width="340" height="100" rx="7" stroke="var(--review-success)" stroke-width="2.5"/>
  </g>
  <g stroke="var(--review-muted)" stroke-width="1.5" marker-end="url(#t817aa)">
    <line x1="180" y1="64" x2="180" y2="84"/><line x1="180" y1="142" x2="180" y2="162"/><line x1="180" y1="220" x2="180" y2="240"/><line x1="180" y1="298" x2="180" y2="318"/>
  </g>
  <g font-size="12.5" fill="var(--review-fg)">
    <text x="20" y="30" class="mono">① a.setRemoteDescription(offer) 保留中</text>
    <text x="20" y="50" fill="var(--review-muted)">a.addTrack(track) → 再利用できる T がない</text>
    <text x="20" y="108" class="mono">② addTransceiver(track, createTransport())</text>
    <text x="20" y="128" fill="var(--review-accent)">createdNegotiationState = { dtlsTransport: D }</text>
    <text x="20" y="186" class="mono" fill="var(--review-muted)">③ if (!transceiver.dtlsTransport) …</text>
    <text x="20" y="206" fill="var(--review-muted)">新規作成ではもう通らない（再利用の分岐用に残す）</text>
    <text x="20" y="264" class="mono">④ setRemoteDescription(rollback)</text>
    <text x="20" y="284" fill="var(--review-muted)">restoreNegotiationState(createdNegotiationState)</text>
    <text x="20" y="342" class="mono" fill="var(--review-success)">⑤ setDtlsTransport(D)</text>
    <text x="20" y="362" fill="var(--review-success)">作成時の transport に戻るだけで例外は出ない ✓</text>
    <text x="20" y="386" fill="var(--review-success)">続く re-offer / answer も通る</text>
  </g>
</svg>
</div>
</div>

変わったのは ② だけです。transport を作成後に付けるのをやめ、作成時に渡します。そのため、rollback が戻す先の「作成時状態」にも transport が入ります。破線の ③ は、再利用の分岐のために残っています。

- `pc.addTrack` から transport を作る関数を渡す： [packages/webrtc/src/peerConnection.ts:1976](review-diff:packages/webrtc/src/peerConnection.ts:1976)
- 新規作成の分岐で、作成時に渡す： [packages/webrtc/src/transceiverManager.ts:627](review-diff:packages/webrtc/src/transceiverManager.ts:627)
- 例外が出ていた箇所（変更なし）： [packages/webrtc/src/media/rtpTransceiver.ts:276](review-file:packages/webrtc/src/media/rtpTransceiver.ts:276) → [packages/webrtc/src/media/rtpSender.ts:341](review-file:packages/webrtc/src/media/rtpSender.ts:341)
- 再現する scene： [packages/webrtc/tests/pbt/model/scenes.ts:334](review-diff:packages/webrtc/tests/pbt/model/scenes.ts:334)（model property の seed 25 で見つけたもの）

## 図 5：レビュー指摘（P2）の修正 — codec 検証と transport 作成の順序

<style>
  .o817 { display:flex; gap:14px; flex-wrap:wrap; font-family:var(--review-font); }
  .o817 .pane { flex:1; min-width:320px; border:1px solid var(--review-border); border-radius:8px; padding:8px 10px; background:var(--review-surface); }
  .o817 h4 { margin:2px 0 6px; font-size:14px; }
  .o817 svg text { font-family:var(--review-font); } .o817 svg .mono { font-family:var(--review-mono); }
</style>

<div class="o817">
<div class="pane">
<h4 style="color:var(--review-danger)">1 回目の修正（指摘を受けた版）</h4>
<svg viewBox="0 0 360 330" width="100%" role="img" aria-label="1回目: transport 作成後に codec 検証が失敗し transport が残る">
  <defs><marker id="o817ab" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--review-muted)"/></marker></defs>
  <g fill="none" stroke-width="1.5">
    <rect x="10" y="8" width="340" height="46" rx="7" stroke="var(--review-border)"/>
    <rect x="10" y="76" width="340" height="56" rx="7" stroke="var(--review-danger)" stroke-width="2.5"/>
    <rect x="10" y="154" width="340" height="56" rx="7" stroke="var(--review-border)"/>
    <rect x="10" y="232" width="340" height="90" rx="7" stroke="var(--review-danger)" stroke-width="2.5"/>
  </g>
  <g stroke="var(--review-muted)" stroke-width="1.5" marker-end="url(#o817ab)">
    <line x1="180" y1="54" x2="180" y2="74"/><line x1="180" y1="132" x2="180" y2="152"/><line x1="180" y1="210" x2="180" y2="230"/>
  </g>
  <g font-size="12.5" fill="var(--review-fg)">
    <text x="20" y="36" class="mono">pc.addTrack(H.264 track)  ※ VP8 のみの pc</text>
    <text x="20" y="98" class="mono">① createTransport() → findOrCreateTransport()</text>
    <text x="20" y="118" fill="var(--review-danger)">secureManager.ownedTransports.add(D)</text>
    <text x="20" y="176" class="mono">② addTransceiver(track, D)</text>
    <text x="20" y="196" class="mono" fill="var(--review-danger)">assertCodecsSupported → throw</text>
    <text x="20" y="256" fill="var(--review-danger)">transceiver は 0 件のまま</text>
    <text x="20" y="276" fill="var(--review-danger)">D は ownedTransports に残る ✗</text>
    <text x="20" y="300" fill="var(--review-danger)">3 回失敗すると 3 件（develop は 0 件）</text>
  </g>
</svg>
</div>
<div class="pane">
<h4 style="color:var(--review-success)">現在</h4>
<svg viewBox="0 0 360 330" width="100%" role="img" aria-label="現在: codec 検証を先に行い transport を作らない">
  <defs><marker id="o817aa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--review-muted)"/></marker></defs>
  <g fill="none" stroke-width="1.5">
    <rect x="10" y="8" width="340" height="46" rx="7" stroke="var(--review-border)"/>
    <rect x="10" y="76" width="340" height="56" rx="7" stroke="var(--review-accent)" stroke-width="2.5"/>
    <rect x="10" y="154" width="340" height="56" rx="7" stroke="var(--review-border)" stroke-dasharray="5 4"/>
    <rect x="10" y="232" width="340" height="90" rx="7" stroke="var(--review-success)" stroke-width="2.5"/>
  </g>
  <g stroke="var(--review-muted)" stroke-width="1.5" marker-end="url(#o817aa)">
    <line x1="180" y1="54" x2="180" y2="74"/><line x1="180" y1="132" x2="180" y2="152"/><line x1="180" y1="210" x2="180" y2="230"/>
  </g>
  <g font-size="12.5" fill="var(--review-fg)">
    <text x="20" y="36" class="mono">pc.addTrack(H.264 track)  ※ VP8 のみの pc</text>
    <text x="20" y="98" class="mono">① assertTrackCodecsSupported(track)</text>
    <text x="20" y="118" fill="var(--review-accent)">transport を作る前に検証 → throw</text>
    <text x="20" y="176" class="mono" fill="var(--review-muted)">② createTransport() / addTransceiver()</text>
    <text x="20" y="196" fill="var(--review-muted)">（検証失敗時はここまで進まない）</text>
    <text x="20" y="256" fill="var(--review-success)">transceiver は 0 件</text>
    <text x="20" y="276" fill="var(--review-success)">ownedTransports は増えない ✓</text>
    <text x="20" y="300" fill="var(--review-success)">成功時の流れは図 4 の After と同じ</text>
  </g>
</svg>
</div>
</div>

失敗しうる codec 検証を、副作用のある `createTransport()` より前に移しました。検証の中身は `addTransceiver` 内の処理を `assertTrackCodecsSupported` に切り出したものです。両方が同じ関数を呼ぶので、検証内容は変わっていません。

- 切り出した検証： [packages/webrtc/src/transceiverManager.ts:454](review-diff:packages/webrtc/src/transceiverManager.ts:454)
- `addTransceiver` からの呼び出し： [packages/webrtc/src/transceiverManager.ts:490](review-diff:packages/webrtc/src/transceiverManager.ts:490)
- `addTrack` の新規作成分岐で先に検証する箇所： [packages/webrtc/src/transceiverManager.ts:622](review-diff:packages/webrtc/src/transceiverManager.ts:622)
- transport が登録される箇所（変更なし）： [packages/webrtc/src/secureTransportManager.ts:278](review-file:packages/webrtc/src/secureTransportManager.ts:278)
- 回帰テスト： [packages/webrtc/tests/media/codecResolution.test.ts:97](review-diff:packages/webrtc/tests/media/codecResolution.test.ts:97)（3 回失敗させ、`ownedTransports` の数と transceiver 0 件を確認）

## 図 6：追加要件 — モジュールスコープの状態を持ち主のインスタンスへ移す

コードメモ（`internalState.ts` 行 56「グローバルスコープの変数を状態管理に使うのは避けたい」）を受けた変更です。状態を、その寿命の持ち主の object のフィールドに移しました。外から触るものは `private` か `@internal` にしています（typedoc は `--excludePrivate --excludeInternal`、`.d.ts` は `stripInternal`）。

<style>
  .g817 { display:flex; gap:14px; flex-wrap:wrap; font-family:var(--review-font); }
  .g817 .pane { flex:1; min-width:320px; border:1px solid var(--review-border); border-radius:8px; padding:8px 10px; background:var(--review-surface); }
  .g817 h4 { margin:2px 0 6px; font-size:14px; }
  .g817 svg text { font-family:var(--review-font); } .g817 svg .mono { font-family:var(--review-mono); }
</style>

<div class="g817">
<div class="pane">
<h4 style="color:var(--review-danger)">Before：モジュールが状態を持つ</h4>
<svg viewBox="0 0 360 300" width="100%" role="img" aria-label="Before: モジュールスコープの WeakMap が全 PeerConnection の transceiver の状態を持つ">
  <defs><marker id="g817ab" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--review-danger)"/></marker></defs>
  <g fill="none" stroke-width="1.5">
    <rect x="10" y="10" width="340" height="100" rx="7" stroke="var(--review-danger)" stroke-width="2.5"/>
    <rect x="10" y="170" width="160" height="120" rx="7" stroke="var(--review-border)"/>
    <rect x="190" y="170" width="160" height="120" rx="7" stroke="var(--review-border)"/>
    <rect x="22" y="215" width="136" height="30" rx="5" stroke="var(--review-border)"/>
    <rect x="202" y="215" width="136" height="30" rx="5" stroke="var(--review-border)"/>
  </g>
  <g stroke="var(--review-danger)" stroke-width="1.5" marker-end="url(#g817ab)" stroke-dasharray="4 3">
    <line x1="90" y1="213" x2="120" y2="112"/><line x1="270" y1="213" x2="240" y2="112"/>
  </g>
  <g font-size="12" fill="var(--review-fg)">
    <text x="20" y="30" class="mono" fill="var(--review-danger)">module internalState.ts（プロセスに 1 つ）</text>
    <text x="20" y="52" class="mono">const applicationStops = new WeakMap()</text>
    <text x="20" y="70" class="mono">const attachedByAddTrack = new WeakSet()</text>
    <text x="20" y="96" fill="var(--review-danger)">全 PeerConnection の T がここに書き込む</text>
    <text x="20" y="190" class="mono">RTCPeerConnection A</text>
    <text x="200" y="190" class="mono">RTCPeerConnection B</text>
    <text x="32" y="235" class="mono">T1（状態なし）</text>
    <text x="212" y="235" class="mono">T2（状態なし）</text>
    <text x="20" y="275" fill="var(--review-muted)">noteApplicationStop(T1)</text>
    <text x="200" y="275" fill="var(--review-muted)">noteApplicationAddTrack(T2)</text>
  </g>
</svg>
</div>
<div class="pane">
<h4 style="color:var(--review-success)">After：各インスタンスが自分の状態を持つ</h4>
<svg viewBox="0 0 360 300" width="100%" role="img" aria-label="After: transceiver が自分のフィールドに状態を持つ">
  <g fill="none" stroke-width="1.5">
    <rect x="10" y="10" width="340" height="100" rx="7" stroke="var(--review-border)" stroke-dasharray="5 4"/>
    <rect x="10" y="170" width="160" height="120" rx="7" stroke="var(--review-border)"/>
    <rect x="190" y="170" width="160" height="120" rx="7" stroke="var(--review-border)"/>
    <rect x="22" y="200" width="136" height="80" rx="5" stroke="var(--review-success)" stroke-width="2.5"/>
    <rect x="202" y="200" width="136" height="80" rx="5" stroke="var(--review-success)" stroke-width="2.5"/>
  </g>
  <g font-size="12" fill="var(--review-fg)">
    <text x="20" y="30" class="mono" fill="var(--review-muted)">module internalState.ts</text>
    <text x="20" y="52" fill="var(--review-muted)">型と ridRouteKey だけ（状態なし）</text>
    <text x="20" y="190" class="mono">RTCPeerConnection A</text>
    <text x="200" y="190" class="mono">RTCPeerConnection B</text>
    <text x="32" y="220" class="mono">T1</text>
    <text x="32" y="240" class="mono" font-size="10.5" fill="var(--review-success)">_applicationStopRevision</text>
    <text x="32" y="256" class="mono" font-size="10.5" fill="var(--review-success)">reusedForAddTrack</text>
    <text x="32" y="272" class="mono" font-size="10.5" fill="var(--review-success)">createdBy</text>
    <text x="212" y="220" class="mono">T2</text>
    <text x="212" y="240" class="mono" font-size="10.5" fill="var(--review-success)">_applicationStopRevision</text>
    <text x="212" y="256" class="mono" font-size="10.5" fill="var(--review-success)">reusedForAddTrack</text>
    <text x="212" y="272" class="mono" font-size="10.5" fill="var(--review-success)">createdBy</text>
  </g>
</svg>
</div>
</div>
<div class="f817-legend"><span style="--c:var(--review-danger)">モジュールスコープの状態</span><span style="--c:var(--review-success)">インスタンスのフィールド</span><span style="--c:var(--review-border)">変わらない部分</span></div>

図は A1 / A2（transceiver）の例です。B3〜B5 も同じ形で、状態を track・transport・source の option へ移しています。B6 は採番そのものをやめ、各 dummy source が作成時に乱数で SSRC などを決めます。どれも振る舞いは変えていません（生成 docs の差分は `heldByApplication` の TSDoc だけです）。

<style>
  .r817 { border-collapse:collapse; width:100%; font:13px var(--review-font); }
  .r817 th, .r817 td { border:1px solid var(--review-border); padding:5px 8px; vertical-align:top; }
  .r817 th { background:var(--review-surface); text-align:left; }
  .r817 td.was { color:var(--review-danger); } .r817 td.now { color:var(--review-success); }
  .r817 code { font-family:var(--review-mono); }
</style>

<table class="r817">
  <thead><tr><th>#</th><th>修正前（モジュールスコープ）</th><th>修正後（持ち主）</th></tr></thead>
  <tbody>
    <tr><td>A1</td><td class="was"><code>internalState.ts</code> <code>attachedByAddTrack</code>（WeakSet）</td><td class="now">削除。既存の <code>reusedForAddTrack</code> / <code>createdBy</code> で判定（図 1）</td></tr>
    <tr><td>A2</td><td class="was"><code>internalState.ts</code> <code>applicationStops</code>（WeakMap）</td><td class="now"><code>RTCRtpTransceiver</code> の <code>private _applicationStopRevision</code> と <code>@internal</code> getter</td></tr>
    <tr><td>B3</td><td class="was"><code>track.ts</code> <code>sourceCodecsByTrack</code> / <code>sourceCodecsCapturedByTrack</code></td><td class="now"><code>MediaStreamTrack</code> の <code>@internal</code> <code>sourceCodecs</code> / <code>sourceCodecsCaptured</code>。公開関数の signature は不変</td></tr>
    <tr><td>B4</td><td class="was"><code>receiverTwcc.ts</code> <code>receiverTwccByTransport</code>（WeakMap）</td><td class="now"><code>RTCDtlsTransport</code> の <code>@internal sharedReceiverTWCC</code></td></tr>
    <tr><td>B5</td><td class="was"><code>sourceIo.ts</code> <code>let udpSocketFactory</code> / <code>setUdpSocketFactory()</code></td><td class="now"><code>udp</code> source の <code>@internal createSocket</code> option。テストは register に渡す</td></tr>
    <tr><td>B6</td><td class="was"><code>dummyMedia.ts</code> <code>let nextDummySourceId</code></td><td class="now">削除。各 source が SSRC・初期 sequence・初期 PictureID を乱数で決める（RFC 3550 5.1 / 8.1）</td></tr>
  </tbody>
</table>

- A1 / A2： [packages/webrtc/src/negotiation/internalState.ts:39](review-diff:packages/webrtc/src/negotiation/internalState.ts:39)（状態の削除）、[packages/webrtc/src/media/rtpTransceiver.ts:83](review-diff:packages/webrtc/src/media/rtpTransceiver.ts:83)（`_applicationStopRevision`）、[packages/webrtc/src/negotiationTransaction.ts:407](review-diff:packages/webrtc/src/negotiationTransaction.ts:407)（getter を使う側）
- B3： [packages/webrtc/src/media/track.ts:34](review-diff:packages/webrtc/src/media/track.ts:34)（公開関数）、[packages/webrtc/src/media/track.ts:146](review-diff:packages/webrtc/src/media/track.ts:146)（フィールド）
- B4： [packages/webrtc/src/media/receiver/receiverTwcc.ts:54](review-diff:packages/webrtc/src/media/receiver/receiverTwcc.ts:54)、[packages/webrtc/src/transport/dtls.ts:181](review-diff:packages/webrtc/src/transport/dtls.ts:181)
- B5： [packages/webrtc/src/polyfill/sourceIo.ts:19](review-diff:packages/webrtc/src/polyfill/sourceIo.ts:19)（option）、[packages/webrtc/src/polyfill/sourceIo.ts:73](review-diff:packages/webrtc/src/polyfill/sourceIo.ts:73)（使う側）、[packages/webrtc/tests/nonstandard/polyfillTestUtils.ts:120](review-diff:packages/webrtc/tests/nonstandard/polyfillTestUtils.ts:120)、[packages/webrtc/tests/nonstandard/polyfill.test.ts:1562](review-diff:packages/webrtc/tests/nonstandard/polyfill.test.ts:1562)
- B6： [packages/webrtc/src/nonstandard/dummyMedia.ts:128](review-diff:packages/webrtc/src/nonstandard/dummyMedia.ts:128)（乱数の SSRC と初期 sequence）、[packages/webrtc/src/nonstandard/dummyMedia.ts:85](review-diff:packages/webrtc/src/nonstandard/dummyMedia.ts:85)（初期 PictureID）、回帰テスト [packages/webrtc/tests/nonstandard/navigator.test.ts:92](review-diff:packages/webrtc/tests/nonstandard/navigator.test.ts:92)

**残したもの**（プロセス全体で共有するのが仕様のもの）：

- `streamHubs`：アプリの stream は 1 か所からしか読めないので、同じ stream を開く全員で 1 つの hub を共有する必要があります。宣言に理由を書きました。 [packages/webrtc/src/polyfill/sourceIo.ts:157](review-diff:packages/webrtc/src/polyfill/sourceIo.ts:157)
- `RTCDtlsTransport.localCertificate`（既定の `certificateScope: "process"`）、公開の `navigator`、dtls の公開 static 設定値：どれも公開 API なので、変えるなら別チケットで扱います。

**再発防止**：

- root `AGENTS.md` の Don't に指示を加えました。中身は次の 3 点です。モジュールスコープ（最上位の `let`、モジュールレベルの `Map` / `Set` / `WeakMap` / `WeakSet`・カウンタ・キャッシュ、書き換え可能な `static`）に実行時の状態を置かない。テスト用の差し替え口は option で渡す。仕様で共有するものは、宣言に理由を書く。 [AGENTS.md:32](review-diff:AGENTS.md:32)
- 検査テスト [packages/webrtc/tests/moduleState.test.ts:13](review-diff:packages/webrtc/tests/moduleState.test.ts:13) は、`packages/webrtc/src` を走査して次の 3 つを検出します。許可リストにない宣言。もう存在しないのに許可リストに残った項目。検出パターン自体の誤り（パターン単体のテスト）。

## 判断理由

- `addTrack()` の記録には、develop から使われている `reusedForAddTrack` を使いました。新しいフラグを足すと、同じ事実を 2 か所で持つことになります。最初はモジュールスコープの WeakSet を足していましたが、追加要件を受けて削除しました。
- remote 起源かどうかの判定には、既存の `NegotiationTransaction.resources.remoteCreated` をそのまま使っています。
- `replaceTrack(track)` だけで保持する werift 独自の挙動は、互換のため残しました。チケットの範囲外です（図 3 の 4 行目）。
- B3 の `setTrackSourceCodecs` などは公開関数（`doc/functions/` にあります）なので、signature を変えずに中身だけ track のフィールドへ移しました。B5 の `setUdpSocketFactory` は公開されていなかったので削除しました。

## リスク・確認してほしい点

- `heldByApplication` を OR にしたので、`replaceTrack(track)` だけのケースは仕様より保持寄りのままです。
- `reusedForAddTrack` が立つのは remote 生成の transceiver だけです。`addTransceiver()` で作った transceiver を `addTrack()` が再利用し、track を外した場合、`heldByApplication` は false になります。ただ、rollback が除去を判定するのは remote 生成のものだけなので、結果は変わりません。
- B4 では、共有 TWCC を transport が強参照で持つようになりました。参照数が 0 になると `undefined` に戻すので、解放のタイミングは修正前と同じです。
- 図 4 の transport の修正は、チケット本文の「実装する変更」には含まれていません。ただし #817 のテスト追加で見つかった develop の不具合で、同じ rollback の経路にあります。
- 保持された transceiver の `receiver.transport` が null にならない点は、チケットで範囲外としています。

## 検証結果

追加要件（図 6）の修正後の結果です（revision `3e06baf61` に A1〜B6 の変更を加えた状態。現在は `f54cdd569` に自動コミット済み）。

| 検証 | 結果 |
| --- | --- |
| `npm run type`（workspace） | エラーなし |
| `packages/webrtc` の `npm test` | 89 ファイル、1838 件成功、5 件スキップ |
| `npm run pbt:deep -- --suite model,leak` | model は失敗 0。leak は seed 10・295 が失敗。単独で再実行すると通る |
| 上の leak 失敗と develop の比較 | seed 10 を含む shard（seed 8〜14）を develop で 3 回実行し、2 回が同じ ICE `checkList` / `remoteCandidates` の増加で失敗。既存の問題（ICE ticket `74132240`） |
| `npm run wpt` | 回帰 0 |
| negotiation-diff `scenarios.ts --check 1` | 一致 |
| `npm run doc` | 差分は `doc/classes/RTCRtpTransceiver.md` の `heldByApplication` の TSDoc だけ |
| `npm run format` | 実行済み（関係のない `packages/rtp/tests/codec/vp8.test.ts` の書き換えは戻した） |
| `moduleState.test.ts` を A1〜B6 の修正前（`3e06baf61`）に当てる | 失敗し、7 件の宣言（A1〜B6）をすべて検出 |

未確認のこと：

- `pbt:deep` の fuzz と scenario は、追加要件の修正後には実行していません。
- negotiation-diff の develop 比較（80 seeds × 12 steps）は追加要件の前に行ったもので、修正後は `--check` だけです。
- leak seed 295 を含む shard は、develop で比較していません。
- P2 の回帰テスト（図 5）が修正前のコードで失敗するかは確かめていません。

## 並列実行時の失敗の切り分け（2 回目のレビューの「残る不確実性」への対応）

前回のレビューの高並列 `pbt:deep` では、3 つの失敗が出ていました。scenario seed 58 と model seed 130 の失敗、flaky 4 件、`negotiation-diff scenarios.ts` の glare シナリオでの通信確認の失敗 1 回です。これらを、並列数と負荷（`/proc/loadavg` の 1 分値を 10 秒ごとに記録）を変えて、HEAD と develop で交互に再実行しました。対象は HEAD `70e710c69`（develop `7a1cb6f6c` をマージ済み）と develop `7a1cb6f6c` で、16 コアのホストです。

| 条件 | HEAD | develop |
| --- | --- | --- |
| scenario seed 58 / model seed 130 を単独（1 プロセス、load 約 2） | 5/5 成功 / 5/5 成功 | 5/5 成功 / 5/5 成功 |
| `pbt:deep --suite scenario,model --jobs 16` と `scenarios.ts --check` を同時実行（load 平均 5.5〜11.4、最大 16.1）、2 回ずつ | 失敗 0・flaky 0、契約一致 | 失敗 0・flaky 0、契約一致 |
| `pbt:deep --suite fuzz,scenario,model,leak --jobs 16` と `pbt:deep --suite scenario,model --jobs 16` と `scenarios.ts --check` を同時実行（load 最大 19.9）、1 回ずつ | fuzz・scenario・model は失敗 0。leak は失敗 4・flaky 17。契約は 18 件すべて一致 | fuzz・model は失敗 0、scenario は flaky 2。leak は失敗 5・flaky 21。契約は 18 件すべて一致 |

- **scenario seed 58・model seed 130・glare の通信確認**：どの条件でも HEAD・develop の両方で再現しませんでした（合計で、通信確認は HEAD で 3 回、develop で 3 回、高負荷下で実行）。
- **leak の失敗**：失敗は 2 種類で、どちらも develop でも出ます。1 つは cycle seed で、ICE 再起動を含むサイクルの後に `ice.checkList` / `ice.remoteCandidates` が 1 件だけ増えます。もう 1 つは heap seed 4 で、傾きが閾値 16 KiB/cycle を少し超えます（HEAD 16.11〜16.33、develop 16.59〜16.71）。原因は ICE の候補収集で、ICE チケット `74132240` で追跡しています。

leak cycle seed 248 は負荷のないときにも HEAD で落ちやすかったので、src とテストハーネスを入れ替えて同じループで交互に 20 回ずつ実行しました。

| 変種 | src | ハーネス（`negotiationTransactionUtils.ts`） | seed 248 の失敗 |
| --- | --- | --- | --- |
| HEAD | HEAD | HEAD | 15/20 |
| develop + HEAD のハーネス | develop | HEAD | 15/20 |
| develop | develop | develop | 11/20 |
| HEAD + develop のハーネス | HEAD | develop | 9/20 |

失敗率は src ではなくハーネスの違いに従っています。このブランチでは、CI 対応の自動コミット（`665a1bfe4`）が、テストの peer で公開の既定 STUN サーバーを使わないようにしています（`iceUseDefaultStunServer: false`）。leak probe はこのハーネスの `createDuplexSession` を使うので、候補収集のタイミングが変わり、既存の ICE の増加が表に出やすくなります。

- ハーネスの設定： [packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts:1330](review-diff:packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts:1330)
- leak probe からの呼び出し： [packages/webrtc/tests/pbt/leak/leakProbe.ts:1085](review-file:packages/webrtc/tests/pbt/leak/leakProbe.ts:1085)

develop の src でも seed 248 は 20 回中 11 回失敗します。そのため、この失敗は今回の rollback・状態移動の変更から来たものではないと判断しました。ハーネスの変更は、テストが外部の STUN サーバーに依存しないようにするためのものなので、残しています。

ICE の増加そのものは、この branch では直していません。並列 `pbt:deep` の leak が緑になるのは、ICE チケット `74132240` が直った後です。

## 3 回目のレビュー指摘への対応

### dummy RTP source の SSRC 重複（B6 の回帰）

B6 の 1 回目の修正では、dummy source の番号を作る側（`MediaDevices` のインスタンスなど）ごとに 0 から数えていました。修正前のプロセス全体の連番は、異なる `MediaDevices` の source にも別の番号を振っていました。それを失ったため、別々の `MediaDevices` から作った track の SSRC が同じ `0x1a2b3c00`、最初の sequence も同じ `0x4000` になっていました。1 つの PeerConnection で両方を送ると、受信側は区別できません。

番号を振ること自体をやめました。各 source が作成時に、SSRC（`random32()`）、初期 sequence（`random16()`）、初期 PictureID（15 bit の乱数）を決めます。RFC 3550 5.1 / 8.1 も、SSRC と初期 sequence を乱数にするよう勧めています。これで共有の状態も作る側ごとの採番も要らなくなりました。`navigator.ts`、`callback.ts`、WPT の `runner.ts` は develop と同じ内容に戻っています。

- [packages/webrtc/src/nonstandard/dummyMedia.ts:128](review-diff:packages/webrtc/src/nonstandard/dummyMedia.ts:128)（SSRC と初期 sequence）
- [packages/webrtc/src/nonstandard/dummyMedia.ts:85](review-diff:packages/webrtc/src/nonstandard/dummyMedia.ts:85)（初期 PictureID）
- 回帰テスト [packages/webrtc/tests/nonstandard/navigator.test.ts:92](review-diff:packages/webrtc/tests/nonstandard/navigator.test.ts:92)：2 つの `Navigator` から audio と video を 1 本ずつ作り、4 つの source の SSRC がすべて異なることを確認します。修正前のコード（`76dbe3360`）では失敗し、修正後は成功します。
- 既存テストの sequence の比較は、初期値が乱数になったので 16 bit の差（`& 0xffff`）で比べるようにしました。 [packages/webrtc/tests/nonstandard/navigator.test.ts:22](review-diff:packages/webrtc/tests/nonstandard/navigator.test.ts:22)

### leak cycle seed 206

レビューでは、seed 206 が現 branch で単独で失敗し、develop では単独で成功していました。merge-base `7a1cb6f6c`（develop の変更を含み、この branch の変更を含まない）と HEAD を同じループで交互に 20 回ずつ実行しました。

| 変種 | 失敗 |
| --- | --- |
| HEAD `76dbe3360` | 12/20 |
| merge-base `7a1cb6f6c` | 12/20 |
| merge-base + HEAD のハーネス | 14/20 |

この間は並行して確認レビューが動いていたので、load は 1.0〜19.8 と高めでした。ただし交互に実行したので、各変種への負荷の影響は揃っています。merge-base でも HEAD と同じ率で失敗するので、seed 206 の失敗はこの branch の変更から来たものではありません。レビューで develop が単独で成功したのは、5〜6 割で失敗する seed がたまたま通ったものと判断しました。失敗の中身は、ほかの cycle seed と同じ ICE `checkList` の 1 件の増加です（ICE チケット `74132240`）。

`npm test` の leak fixed scene「an ICE restart keeps the agent's credential history bounded」も、load 25 のとき 1 回だけ同じ `checkList` の増加で失敗しました。単独で 3 回実行すると 3 回とも成功しました。
