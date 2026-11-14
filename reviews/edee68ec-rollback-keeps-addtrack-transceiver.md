---
ide:
  viewer: review-document
  version: 1
  title: "#817 rollback で addTrack 済み transceiver を保持する"
  dock: right
  baseCommit: d2d1e09e842f2f193be17b30a61f407ffd3a5843
---
# #817 remote rollback で addTrack 済み transceiver が消える問題の修正

## 概要

remote offer を rollback すると、アプリが `addTrack()` で使った transceiver が消えることがありました。`sender.replaceTrack(null)` や `removeTrack()` で track を外したあとに起きます。修正後は、同じ object のまま `stopped === false`・`mid === null` で残ります。

原因は、保持するかどうかを「いま `sender.track` があるか」で決めていたことです。track を外すと、`addTrack()` で使ったという事実が消えていました。修正後は、`addTrack()` で使ったことを rollback でも `replaceTrack(null)` でも消えない記録として残し、保持の判定に使います。

あわせて、関連する 2 つの流れも直しました。

- remote offer の保留中に `addTrack()` が transceiver を新しく作ると、rollback で `TypeError` になっていました（develop にもある不具合です）。
- 上の修正の 1 回目で、codec 検証に失敗するたびに DTLS transport が残る回帰が入っていました。レビューの指摘を受けて直しています。

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
    <rect x="10" y="164" width="340" height="56" rx="7" stroke="var(--review-danger)" stroke-width="2.5"/>
    <rect x="10" y="242" width="340" height="56" rx="7" stroke="var(--review-border)"/>
    <polygon points="180,320 350,360 180,400 10,360" stroke="var(--review-danger)" stroke-width="2.5"/>
    <rect x="10" y="430" width="340" height="80" rx="7" stroke="var(--review-danger)" stroke-width="2.5"/>
  </g>
  <g stroke="var(--review-muted)" stroke-width="1.5" marker-end="url(#f817ab)">
    <line x1="180" y1="64" x2="180" y2="84"/><line x1="180" y1="142" x2="180" y2="162"/><line x1="180" y1="220" x2="180" y2="240"/><line x1="180" y1="298" x2="180" y2="318"/><line x1="180" y1="400" x2="180" y2="428"/>
  </g>
  <g font-size="12.5" fill="var(--review-fg)">
    <text x="20" y="30" class="mono">① b.setRemoteDescription(offer)</text>
    <text x="20" y="50" fill="var(--review-muted)">transceiver T を作成 → remoteCreated に登録</text>
    <text x="20" y="108" class="mono">② b.addTrack(track)</text>
    <text x="20" y="128" fill="var(--review-muted)">T を再利用 / sender.track = track</text>
    <text x="20" y="186" class="mono">③ replaceTrack(null) / removeTrack()</text>
    <text x="20" y="206" fill="var(--review-danger)">sender.track = null → 使った痕跡が消える</text>
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
    <rect x="10" y="86" width="340" height="56" rx="7" stroke="var(--review-accent)" stroke-width="2.5"/>
    <rect x="10" y="164" width="340" height="56" rx="7" stroke="var(--review-border)"/>
    <rect x="10" y="242" width="340" height="56" rx="7" stroke="var(--review-border)"/>
    <polygon points="180,320 350,360 180,400 10,360" stroke="var(--review-success)" stroke-width="2.5"/>
    <rect x="10" y="430" width="340" height="80" rx="7" stroke="var(--review-success)" stroke-width="2.5"/>
  </g>
  <g stroke="var(--review-muted)" stroke-width="1.5" marker-end="url(#f817aa)">
    <line x1="180" y1="64" x2="180" y2="84"/><line x1="180" y1="142" x2="180" y2="162"/><line x1="180" y1="220" x2="180" y2="240"/><line x1="180" y1="298" x2="180" y2="318"/><line x1="180" y1="400" x2="180" y2="428"/>
  </g>
  <g font-size="12.5" fill="var(--review-fg)">
    <text x="20" y="30" class="mono">① b.setRemoteDescription(offer)</text>
    <text x="20" y="50" fill="var(--review-muted)">transceiver T を作成 → remoteCreated に登録</text>
    <text x="20" y="108" class="mono">② b.addTrack(track)</text>
    <text x="20" y="128" fill="var(--review-accent)">＋ noteApplicationAddTrack(T)（WeakSet に記録）</text>
    <text x="20" y="186" class="mono">③ replaceTrack(null) / removeTrack()</text>
    <text x="20" y="206" fill="var(--review-muted)">sender.track = null（記録は消えない）</text>
    <text x="20" y="264" class="mono">④ setRemoteDescription(rollback)</text>
    <text x="20" y="284" fill="var(--review-muted)">restoreNegotiationState(): remoteCreated を判定</text>
    <text x="180" y="350" text-anchor="middle" class="mono">heldByApplication</text>
    <text x="180" y="368" text-anchor="middle" class="mono" font-size="11" fill="var(--review-success)">isAttachedByAddTrack(T)</text>
    <text x="180" y="384" text-anchor="middle" class="mono" font-size="11" fill="var(--review-success)">|| !!sender.track → true</text>
    <text x="20" y="452" class="mono" fill="var(--review-success)">⑤ 同じ T を保持</text>
    <text x="20" y="472" fill="var(--review-success)">createdNegotiationState に戻し mid = null</text>
    <text x="20" y="492" fill="var(--review-success)">stopped = false、sender はそのまま使える ✓</text>
  </g>
</svg>
</div>
</div>
<div class="f817-legend"><span style="--c:var(--review-danger)">問題が起きる箇所</span><span style="--c:var(--review-accent)">追加した処理</span><span style="--c:var(--review-success)">修正で変わった結果</span><span style="--c:var(--review-border)">変わらない処理</span></div>

①、③、④ は Before と After で同じです。違いは 2 つだけです。② で記録を残すようになったこと、そして ④ の判定がその記録を見るようになったことです。

- 記録： [packages/webrtc/src/negotiation/internalState.ts:56](review-diff:packages/webrtc/src/negotiation/internalState.ts:56)（WeakSet と `noteApplicationAddTrack` / `isAttachedByAddTrack`）
- 判定： [packages/webrtc/src/media/rtpTransceiver.ts:263](review-diff:packages/webrtc/src/media/rtpTransceiver.ts:263)（`heldByApplication`）
- 判定を使う rollback 側（変更なし）： [packages/webrtc/src/transceiverManager.ts:206](review-file:packages/webrtc/src/transceiverManager.ts:206)
- 記録する 3 箇所： [packages/webrtc/src/transceiverManager.ts:561](review-diff:packages/webrtc/src/transceiverManager.ts:561)（空 sender の再利用）、[packages/webrtc/src/transceiverManager.ts:596](review-diff:packages/webrtc/src/transceiverManager.ts:596)（非送信 transceiver の再利用）、[packages/webrtc/src/transceiverManager.ts:605](review-diff:packages/webrtc/src/transceiverManager.ts:605)（新規作成）

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
  const rows = ["sender.track", "addTrack の記録（WeakSet）", "heldByApplication", "T の状態"];
  const steps = [
    { op: "① b.setRemoteDescription(offer)", b: ["null", "—", "false", "remoteCreated, mid=0"], a: ["null", "なし", "false", "remoteCreated, mid=0"], note: "remote offer で T が作られます。この時点では両者とも同じです。" },
    { op: "② b.addTrack(track)", b: ["track", "—", "true", "remoteCreated, mid=0"], a: ["track", "あり", "true", "remoteCreated, mid=0"], note: "After だけ noteApplicationAddTrack(T) が記録を残します。判定結果はまだ同じです。" },
    { op: "③ sender.replaceTrack(null) / removeTrack(sender)", b: ["null", "—", "false", "remoteCreated, mid=0"], a: ["null", "あり", "true", "remoteCreated, mid=0"], note: "ここで両者が分かれます。Before は track がなくなると、使ったことが分からなくなります。" },
    { op: "④ b.setRemoteDescription({type:'rollback'})", b: ["null", "—", "false", "除去・stopped=true"], a: ["null", "あり", "true", "保持・mid=null・stopped=false"], note: "restoreNegotiationState() が heldByApplication を見て、除去するか保持するかを決めます。" },
    { op: "⑤ a.createOffer → b.answer（再交渉）", b: ["—", "—", "—", "T は使えない"], a: ["null", "あり", "true", "T が新しい m-line で交渉される"], note: "#817 の scene は、rollback のあとに再交渉まで進めて結果を確認します。" },
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

③ で状態が分かれ、④ で結果が変わります。この再現手順は [packages/webrtc/tests/pbt/model/scenes.ts:344](review-diff:packages/webrtc/tests/pbt/model/scenes.ts:344) の 2 つの scene（`replaceTrack` と `removeTrack`）です。どちらも修正前のコードでは失敗します。そこで使う `takeTrack` / `detachTrack` のステップは [packages/webrtc/tests/pbt/model/generator.ts:149](review-diff:packages/webrtc/tests/pbt/model/generator.ts:149) で追加しました。

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
    <tr><td><code>addTrack()</code> → <code>replaceTrack(null)</code></td><td class="was">除去 ✗</td><td class="k chg">保持 ✓</td><td>#817</td></tr>
    <tr><td><code>addTrack()</code> → <code>removeTrack()</code></td><td class="was">除去 ✗</td><td class="k chg">保持 ✓</td><td>#817</td></tr>
    <tr><td><code>replaceTrack(track)</code> だけ</td><td class="k">保持</td><td class="k">保持</td><td>werift 独自の挙動を残しています（WPT <code>?interop-2026</code> は除去を期待）</td></tr>
    <tr><td><code>stop()</code> / direction / <code>setCodecPreferences()</code> だけ</td><td class="r">除去</td><td class="r">除去</td><td>develop と同じ（scene で確認）</td></tr>
    <tr><td>何もしない</td><td class="r">除去</td><td class="r">除去</td><td>W3C の rollback 手順どおり</td></tr>
  </tbody>
</table>

変わるのは、`addTrack()` の後に track を外した 2 行だけです。`heldByApplication` を `isAttachedByAddTrack(T) || !!sender.track` の OR にしたので、`!!sender.track` だけで保持されていた行の結果は変わりません。

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

- `pc.addTrack` から transport を作る関数を渡す： [packages/webrtc/src/peerConnection.ts:1931](review-diff:packages/webrtc/src/peerConnection.ts:1931)
- 新規作成の分岐で、作成時に渡す： [packages/webrtc/src/transceiverManager.ts:601](review-diff:packages/webrtc/src/transceiverManager.ts:601)
- 例外が出ていた箇所（変更なし）： [packages/webrtc/src/media/rtpTransceiver.ts:249](review-file:packages/webrtc/src/media/rtpTransceiver.ts:249) → [packages/webrtc/src/media/rtpSender.ts:341](review-file:packages/webrtc/src/media/rtpSender.ts:341)
- 再現する scene： [packages/webrtc/tests/pbt/model/scenes.ts:333](review-diff:packages/webrtc/tests/pbt/model/scenes.ts:333)（model property の seed 25 で見つけたもの）

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

- 切り出した検証： [packages/webrtc/src/transceiverManager.ts:439](review-diff:packages/webrtc/src/transceiverManager.ts:439)
- `addTransceiver` からの呼び出し： [packages/webrtc/src/transceiverManager.ts:469](review-diff:packages/webrtc/src/transceiverManager.ts:469)
- `addTrack` の新規作成分岐で先に検証する箇所： [packages/webrtc/src/transceiverManager.ts:600](review-diff:packages/webrtc/src/transceiverManager.ts:600)
- transport が登録される箇所（変更なし）： [packages/webrtc/src/secureTransportManager.ts:278](review-file:packages/webrtc/src/secureTransportManager.ts:278)
- 回帰テスト： [packages/webrtc/tests/media/codecResolution.test.ts:96](review-diff:packages/webrtc/tests/media/codecResolution.test.ts:96)（3 回失敗させ、`ownedTransports` の数と transceiver 0 件を確認）

## 判断理由

- `addTrack()` の記録は、公開クラスのフィールドにせず、`internalState.ts` の WeakSet に置きました。既存の `noteApplicationStop` と同じ置き場所です。rollback の snapshot / restore の対象外なので、rollback をまたいでも残ります。公開 API と生成 docs は変わりません。
- remote 起源かどうかの判定には、既存の `NegotiationTransaction.resources.remoteCreated` をそのまま使っています。
- `replaceTrack(track)` だけで保持する werift 独自の挙動は、互換のため残しました。チケットの範囲外です（図 3 の 4 行目）。

## リスク・確認してほしい点

- `heldByApplication` を OR にしたので、`replaceTrack(track)` だけのケースは仕様より保持寄りのままです。
- 図 4 の transport の修正は、チケット本文の「実装する変更」には含まれていません。ただし #817 のテスト追加で見つかった develop の不具合で、同じ rollback の経路にあります。
- 保持された transceiver の `receiver.transport` が null にならない点は、チケットで範囲外としています。

## 検証結果

この回の作業ではこの文書を書き直しただけで、テストやビルドは実行していません。以下は、これまでの作業で報告済みの結果です。

| 検証 | 結果 | 時点 |
| --- | --- | --- |
| `tsc --noEmit`（packages/webrtc） | エラーなし | P2 修正後 |
| `packages/webrtc` の `npm test` | 82 ファイル、1762 件成功、5 件スキップ | P2 修正後 |
| `npm run wpt` | 回帰なし | P2 修正前 |
| `npm run pbt:deep` | fuzz・model・leak は成功。scenario の seed 161 が 1 回失敗（develop でも 6 回中 1 回失敗する既存の flaky） | P2 修正前 |
| negotiation-diff と develop の比較（80 seeds × 12 steps） | 回帰 0、差分 0 | P2 修正前 |

未確認のこと：

- 回帰テスト（図 5）が、修正前のコードで実際に失敗するかは確かめていません。
- P2 修正後に `npm run wpt`、`pbt:deep`、negotiation-diff は再実行していません。
