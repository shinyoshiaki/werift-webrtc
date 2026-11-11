---
ide:
  viewer: review-document
  version: 1
  title: "ICE: semi-aggressive 既定と regular / renomination"
  dock: right
  baseCommit: 1cce757fc5452c56e7ef819d5b0ea0a94b924417
---
# ICE: 既定を semi-aggressive nomination にし、regular nomination と renomination を選べるようにする

## 1. 概要

**何が直ったか。** controlling 側の werift は、これまで最初に疎通したペアに固定され、後から届いた高優先度の候補へ移れませんでした。実環境（Chrome ↔ werift + TURN）では、先に通った TURN/TCP relay に張り付き、RTT が約 6.2 s になっていました（TURN/UDP なら約 88 ms）。

**ユーザーから見て何が変わるか。**

- **既定（設定なし）**: Chrome（libwebrtc）と同じ **semi-aggressive nomination** になります。最初に疎通したペアですぐ接続し（接続時間は従来と同じ）、後から成功した高優先度ペアに選択を移します。
- **controlled 側**: 相手が後から別のペアを指名すると、それに従います（従来は最初の指名を使い続けていました）。
- **オプション**: `PeerConfig.iceRenomination: true` で renomination（STUN 属性 `NOMINATION`、0xC001）を使えます。SDP に `a=ice-options:trickle renomination` を宣言します。`PeerConfig.iceNomination: "regular"` を指定すると、RFC 8445 の regular nomination（待ってから 1 ペアだけ指名）になります。
- **ICE-TCP ペアと ICE-lite**: どのモードでも従来どおりです。

<div style="display:flex;gap:12px;flex-wrap:wrap;font-family:var(--review-font)">
  <div style="flex:1;min-width:250px;padding:10px 12px;border:1px solid var(--review-border);border-left:5px solid var(--review-danger);border-radius:6px">
    <strong>Before（develop）</strong>
    <ul style="margin:6px 0 0;padding-left:18px">
      <li>通常 check すべてに <code>USE-CANDIDATE</code></li>
      <li>最初に成功したペアで <code>nominated</code> が確定し、二度と変わらない</li>
      <li>残りの Waiting / Frozen は FAILED、後から届いた候補はペアにならない</li>
      <li>controlled 側も最初の指名を使い続ける</li>
    </ul>
  </div>
  <div style="flex:1;min-width:250px;padding:10px 12px;border:1px solid var(--review-border);border-left:5px solid var(--review-success);border-radius:6px">
    <strong>After（既定: semi-aggressive）</strong>
    <ul style="margin:6px 0 0;padding-left:18px">
      <li>最初に成功したペアを<strong>待たずに</strong>選択（接続時間は従来と同じ）</li>
      <li>選択より<strong>上位</strong>のペアだけ check を続け、成功したら選択を置き換える</li>
      <li>trickle で後から届いた候補・遅れて割り当てられた relay も対象</li>
      <li>controlled 側は「値の大きい指名 → 同値なら優先度の高いペア」に従う</li>
    </ul>
  </div>
</div>

## 2. 修正前の問題と修正後の仕組み

### 2.1 同じ trickle の流れを Before / After で比べる

入力は同じです。先に TURN/TCP relay のペアが疎通し、少し遅れて TURN/UDP relay の候補が trickle で届きます。

<div style="font-family:var(--review-font);color:var(--review-fg)">
<div style="font-weight:bold;margin:4px 0;color:var(--review-danger)">Before（develop）</div>
<svg viewBox="0 0 760 250" width="100%" role="img" aria-label="Before: TURN/TCP に固定される流れ">
  <g stroke="var(--review-border)" stroke-width="1.5"><line x1="250" y1="30" x2="250" y2="245"/><line x1="510" y1="30" x2="510" y2="245"/></g>
  <g font-size="13" text-anchor="middle" fill="var(--review-fg)" font-weight="bold"><text x="250" y="20">werift（controlling）</text><text x="510" y="20">相手（controlled）</text></g>
  <g stroke="var(--review-muted)" stroke-width="1.5" fill="none"><line x1="250" y1="55" x2="505" y2="55"/><polyline points="497,50 505,55 497,60"/><line x1="510" y1="72" x2="255" y2="72" stroke-dasharray="4 3"/><polyline points="263,67 255,72 263,77"/></g>
  <text x="380" y="49" font-size="11" text-anchor="middle" fill="var(--review-fg)">checkStart(): TURN/TCP + USE-CANDIDATE</text>
  <text x="380" y="88" font-size="11" text-anchor="middle" fill="var(--review-muted)">成功応答</text>
  <g font-size="11" fill="var(--review-fg)"><text x="240" y="60" text-anchor="end">nominated = TCP（確定）</text><text x="240" y="76" text-anchor="end">8.1.2: 残りの Waiting/Frozen → FAILED</text></g>
  <g font-size="11" fill="var(--review-fg)"><text x="520" y="60">最初の指名で選択</text><text x="520" y="76">（nominated == undefined のときだけ）</text></g>
  <rect x="150" y="110" width="460" height="28" rx="5" fill="none" stroke="var(--review-border)" stroke-dasharray="4 3"/>
  <text x="380" y="129" font-size="12" text-anchor="middle" fill="var(--review-fg)">TURN/UDP relay の候補が trickle で到着（優先度は TCP より上）</text>
  <rect x="4" y="150" width="500" height="40" rx="5" fill="none" stroke="var(--review-danger)" stroke-width="2"/>
  <text x="14" y="167" font-size="11" fill="var(--review-danger)" font-weight="bold">✗ pairLocalProtocol() / tryPair(): 選択済みなので新ペアを作らない</text>
  <text x="14" y="183" font-size="11" fill="var(--review-danger)">（仮に check しても nominated は上書きされない）</text>
  <rect x="150" y="205" width="460" height="32" rx="5" fill="none" stroke="var(--review-danger)" stroke-width="2"/>
  <text x="380" y="226" font-size="12" text-anchor="middle" fill="var(--review-danger)" font-weight="bold">両端とも TURN/TCP に固定 → RTT 約 6.2 s（ICE restart まで戻らない）</text>
</svg>
<div style="font-weight:bold;margin:10px 0 4px;color:var(--review-success)">After（既定: semi-aggressive）</div>
<svg viewBox="0 0 760 300" width="100%" role="img" aria-label="After: TURN/UDP へ置き換わる流れ">
  <g stroke="var(--review-border)" stroke-width="1.5"><line x1="250" y1="30" x2="250" y2="295"/><line x1="510" y1="30" x2="510" y2="295"/></g>
  <g font-size="13" text-anchor="middle" fill="var(--review-fg)" font-weight="bold"><text x="250" y="20">werift（controlling）</text><text x="510" y="20">相手（controlled）</text></g>
  <g stroke="var(--review-muted)" stroke-width="1.5" fill="none"><line x1="250" y1="55" x2="505" y2="55"/><polyline points="497,50 505,55 497,60"/><line x1="510" y1="72" x2="255" y2="72" stroke-dasharray="4 3"/><polyline points="263,67 255,72 263,77"/></g>
  <text x="380" y="49" font-size="11" text-anchor="middle" fill="var(--review-fg)">checkStart(): TURN/TCP + USE-CANDIDATE</text>
  <text x="380" y="88" font-size="11" text-anchor="middle" fill="var(--review-muted)">成功応答</text>
  <g font-size="11" fill="var(--review-fg)"><text x="240" y="60" text-anchor="end">nominated = TCP → connect() 完了</text><text x="240" y="76" text-anchor="end" fill="var(--review-accent)">上位ペアは FAILED にせず残す</text></g>
  <g font-size="11" fill="var(--review-fg)"><text x="520" y="60">TCP を選択</text></g>
  <rect x="150" y="110" width="460" height="28" rx="5" fill="none" stroke="var(--review-border)" stroke-dasharray="4 3"/>
  <text x="380" y="129" font-size="12" text-anchor="middle" fill="var(--review-fg)">TURN/UDP relay の候補が trickle で到着（優先度は TCP より上）</text>
  <rect x="4" y="148" width="240" height="40" rx="5" fill="none" stroke="var(--review-success)" stroke-width="2"/>
  <text x="14" y="165" font-size="11" fill="var(--review-success)" font-weight="bold">admitsPair(): 上位ペアだけ追加</text>
  <text x="14" y="181" font-size="11" fill="var(--review-success)">→ checkOutrankingPairs()</text>
  <g stroke="var(--review-success)" stroke-width="2" fill="none"><line x1="250" y1="210" x2="505" y2="210"/><polyline points="497,205 505,210 497,215"/><line x1="510" y1="226" x2="255" y2="226" stroke-dasharray="4 3"/><polyline points="263,221 255,226 263,231"/></g>
  <text x="380" y="204" font-size="11" text-anchor="middle" fill="var(--review-success)">TURN/UDP + USE-CANDIDATE（上位なので付く）</text>
  <g font-size="11"><text x="240" y="232" text-anchor="end" fill="var(--review-success)" font-weight="bold">replacesSelectedPair() → nominated = UDP</text><text x="240" y="248" text-anchor="end" fill="var(--review-fg)">queryConsent() を新ペアで再開</text></g>
  <g font-size="11"><text x="520" y="215" fill="var(--review-success)" font-weight="bold">値 1 同士・優先度が上</text><text x="520" y="231" fill="var(--review-success)">→ UDP に置き換え</text></g>
  <rect x="150" y="262" width="460" height="32" rx="5" fill="none" stroke="var(--review-success)" stroke-width="2"/>
  <text x="380" y="283" font-size="12" text-anchor="middle" fill="var(--review-success)" font-weight="bold">両端とも TURN/UDP へ移る（RTT 約 88 ms 相当の経路）</text>
</svg>
<div style="font-size:12px;color:var(--review-muted);margin-top:4px">凡例: <span style="color:var(--review-danger)">赤 = 問題の箇所</span> / <span style="color:var(--review-success)">緑 = 変更で加わった流れ</span> / <span style="color:var(--review-accent)">アクセント = 変更で扱いが変わった状態</span>。上下の図は同じ入力・同じ配置です。</div>
</div>

要点:

- 分かれ目は、選択後に上位ペアを残すかどうかです。After では、選択時の 8.1.2 の掃除で上位ペアを残します（[packages/ice/src/ice.ts:2543](review-file:packages/ice/src/ice.ts:2543)）。`connect()` の打ち切り処理でも、上位ペアの check は続けます（[packages/ice/src/ice.ts:1824](review-file:packages/ice/src/ice.ts:1824)）。
- 後から届いた候補で上位のペアだけを作るのは `admitsPair()` です（[packages/ice/src/ice.ts:3466](review-file:packages/ice/src/ice.ts:3466)）。その check を 20 ms 間隔で進めるのが `checkOutrankingPairs()` です（[packages/ice/src/ice.ts:3094](review-file:packages/ice/src/ice.ts:3094)）。
- `USE-CANDIDATE` を付けるのは「未選択の間」と「選択より上位のペア」だけです（[packages/ice/src/ice.ts:2677](review-file:packages/ice/src/ice.ts:2677)）。
- 置き換えの判定は `replacesSelectedPair()`（[packages/ice/src/ice.ts:2993](review-file:packages/ice/src/ice.ts:2993)）です。送信経路・consent・統計の移し替えは `checkComplete()` で行います（[packages/ice/src/ice.ts:2519](review-file:packages/ice/src/ice.ts:2519)）。

### 2.2 どの方式になるか（条件を切り替えて確認できます）

<style>
  .rn-mode { font-family: var(--review-font); color: var(--review-fg); border: 1px solid var(--review-border); border-radius: 6px; padding: 10px 12px; }
  .rn-mode label { display: inline-block; margin: 2px 14px 2px 0; font-size: 13px; }
  .rn-mode .rn-out { margin-top: 10px; padding: 8px 10px; border-left: 5px solid var(--review-accent); background: var(--review-surface); border-radius: 4px; }
  .rn-mode .rn-out strong { display: block; margin-bottom: 4px; }
  .rn-mode code { font-family: var(--review-mono); font-size: 12px; }
  .rn-mode .rn-fn { color: var(--review-muted); font-size: 12px; margin-top: 4px; }
</style>

<div class="rn-mode">
  <div>
    <label><input type="checkbox" id="rn-controlled"> 自分が controlled</label>
    <label><input type="checkbox" id="rn-selflite"> 自分が ICE-lite</label>
    <label><input type="checkbox" id="rn-remotelite"> 相手が ICE-lite</label>
  </div>
  <div>
    <label><input type="checkbox" id="rn-ren-local"> 自分の <code>iceRenomination</code></label>
    <label><input type="checkbox" id="rn-ren-remote"> 相手の SDP に <code>renomination</code></label>
    <label><input type="checkbox" id="rn-regular"> <code>iceNomination: "regular"</code></label>
    <label><input type="checkbox" id="rn-tcp"> ICE-TCP のペア</label>
  </div>
  <div class="rn-out" id="rn-out"></div>
</div>

<script>
  (() => {
    const ids = ["controlled", "selflite", "remotelite", "ren-local", "ren-remote", "regular", "tcp"];
    const el = Object.fromEntries(ids.map((id) => [id, document.getElementById("rn-" + id)]));
    const out = document.getElementById("rn-out");
    const render = () => {
      const v = Object.fromEntries(ids.map((id) => [id, el[id].checked]));
      let title, body, fn, color = "var(--review-accent)";
      if (v.selflite) {
        title = "ICE-lite（自分）: 指名しない";
        body = "check は送らず、相手の USE-CANDIDATE を受けたペアを選択します。従来どおりです。";
        fn = "checkIncoming() の iceLite 分岐";
        color = "var(--review-muted)";
      } else if (v.controlled) {
        title = "controlled: 相手の指名に従う（変更あり）";
        body = "指名の値（NOMINATION の値、USE-CANDIDATE は 1）が大きいペアを使い、同じ値なら優先度の高いペアを使います。どの設定でも NOMINATION を処理します（Chrome と同じ）。従来は最初の指名を使い続けていました。";
        fn = "receivedNomination() / replacesSelectedPair() の controlled 分岐";
        color = "var(--review-success)";
      } else if (v.remotelite) {
        title = "ICE-lite の相手: 最初の成功ペアに専用 USE-CANDIDATE";
        body = "従来どおりです。renomination も使いません。";
        fn = "checkStart() の remoteIsLite 分岐（liteNominating）";
        color = "var(--review-muted)";
      } else if (v.tcp) {
        title = "ICE-TCP ペア: regular nomination（どのモードでも）";
        body = "TCP ペアは接続ごとに別なので、複数指名すると pruning 後に両端が別の接続になるおそれがあります（#721）。待ってから 1 ペアだけ指名し、選択を置き換えません。";
        fn = "replacesWith() / regularNominationPairs() → RegularNomination";
        color = "var(--review-warning)";
      } else if (v["ren-local"] && v["ren-remote"]) {
        title = "renomination: NOMINATION 属性で指名（値は単調増加）";
        body = "通常 check には何も付けません。最初の valid ペアと、後から valid になったより良いペアに、別の check で NOMINATION を送ります。応答で選択を移し、応答がないペアやエラーのペアは使いません。iceNomination の設定より優先されます（libwebrtc と同じ）。";
        fn = "usesRenomination() / evaluateSelection() / nominateSelection()";
        color = "var(--review-success)";
      } else if (v.regular) {
        title = "regular nomination: 待ってから 1 ペアだけ指名";
        body = "静穏起点 + nominationDelayMs（既定 300 ms）か、end-of-candidates の後に、最良の valid ペアへ USE-CANDIDATE の専用 check を 1 回送ります。応答がなければ同じペアに計 3 回まで送り、それでも届かなければ connect() を reject します。";
        fn = "usesRegularNomination() / RegularNomination / decideNomination";
        color = "var(--review-warning)";
      } else {
        title = "semi-aggressive（既定）";
        body = "未選択の間と、選択より上位のペアの check にだけ USE-CANDIDATE を付けます。最初の成功で即座に選択し、上位ペアが成功したら置き換えます。consent check も選択中のペアに USE-CANDIDATE を付けます。"
          + (v["ren-local"] !== v["ren-remote"] ? "（renomination は片側だけの宣言なので使いません）" : "");
        fn = "usesSemiAggressiveNomination() / replacesSelectedPair() / checkOutrankingPairs()";
        color = "var(--review-success)";
      }
      out.style.borderLeftColor = color;
      out.innerHTML = "";
      const t = document.createElement("strong"); t.textContent = title;
      const b = document.createElement("div"); b.textContent = body;
      const f = document.createElement("div"); f.className = "rn-fn"; f.textContent = "実装: " + fn;
      out.append(t, b, f);
    };
    ids.forEach((id) => el[id].addEventListener("change", render));
    render();
  })();
</script>

判定は上から順に優先されます。

| 条件 | 方式 | 実装 |
| --- | --- | --- |
| 自分が ICE-lite / 相手が ICE-lite | 従来どおり | `nominatesFullPeer()` が false |
| controlled | 相手の指名に従う（値 → 優先度） | [packages/ice/src/ice.ts:2993](review-file:packages/ice/src/ice.ts:2993) |
| ICE-TCP ペア | regular（置き換えない） | [packages/ice/src/ice.ts:2967](review-file:packages/ice/src/ice.ts:2967) / [packages/ice/src/ice.ts:2976](review-file:packages/ice/src/ice.ts:2976) |
| 両端が renomination を宣言 | renomination | [packages/ice/src/ice.ts:2913](review-file:packages/ice/src/ice.ts:2913) |
| `iceNomination: "regular"` | regular | [packages/ice/src/ice.ts:2927](review-file:packages/ice/src/ice.ts:2927) |
| それ以外（既定） | semi-aggressive | [packages/ice/src/ice.ts:2943](review-file:packages/ice/src/ice.ts:2943) |

### 2.3 controlled 側: 後からの指名に従う

相手（controlling）が指名を繰り返したとき、controlled 側の werift がどのペアを使うかの比較です。各行は、その指名を受けた後の選択です。

<div style="font-family:var(--review-font);color:var(--review-fg);overflow-x:auto">
<table style="border-collapse:collapse;width:100%;font-size:13px">
  <thead><tr style="background:var(--review-surface)">
    <th style="text-align:left;padding:6px;border:1px solid var(--review-border)">#</th>
    <th style="text-align:left;padding:6px;border:1px solid var(--review-border)">受けた指名</th>
    <th style="text-align:left;padding:6px;border:1px solid var(--review-border)">Before の選択</th>
    <th style="text-align:left;padding:6px;border:1px solid var(--review-border)">After の選択</th>
    <th style="text-align:left;padding:6px;border:1px solid var(--review-border)">After の理由</th>
  </tr></thead>
  <tbody>
    <tr><td style="padding:6px;border:1px solid var(--review-border)">1</td><td style="padding:6px;border:1px solid var(--review-border)">USE-CANDIDATE → 低優先度ペア</td><td style="padding:6px;border:1px solid var(--review-border)">低</td><td style="padding:6px;border:1px solid var(--review-border)">低</td><td style="padding:6px;border:1px solid var(--review-border);color:var(--review-muted)">最初の指名</td></tr>
    <tr><td style="padding:6px;border:1px solid var(--review-border)">2</td><td style="padding:6px;border:1px solid var(--review-border)">USE-CANDIDATE → 高優先度ペア</td><td style="padding:6px;border:2px solid var(--review-danger);color:var(--review-danger);font-weight:bold">低（変わらない）</td><td style="padding:6px;border:2px solid var(--review-success);color:var(--review-success);font-weight:bold">高</td><td style="padding:6px;border:1px solid var(--review-border)">値は同じ 1、優先度が上（RFC 5245 §8.1.1.2）</td></tr>
    <tr><td style="padding:6px;border:1px solid var(--review-border)">3</td><td style="padding:6px;border:1px solid var(--review-border)">USE-CANDIDATE → 低優先度ペア（再び）</td><td style="padding:6px;border:1px solid var(--review-border)">低</td><td style="padding:6px;border:1px solid var(--review-border)">高</td><td style="padding:6px;border:1px solid var(--review-border)">値は同じ 1、優先度が下なので戻らない</td></tr>
    <tr><td style="padding:6px;border:1px solid var(--review-border)">4</td><td style="padding:6px;border:1px solid var(--review-border)">NOMINATION=2 → 低優先度ペア</td><td style="padding:6px;border:1px solid var(--review-border)">（NOMINATION を知らない）</td><td style="padding:6px;border:2px solid var(--review-success);color:var(--review-success);font-weight:bold">低</td><td style="padding:6px;border:1px solid var(--review-border)">値 2 &gt; 1。値は優先度より強い（Chrome と同じ）</td></tr>
    <tr><td style="padding:6px;border:1px solid var(--review-border)">5</td><td style="padding:6px;border:1px solid var(--review-border)">NOMINATION=1 → 高優先度ペア（古い値）</td><td style="padding:6px;border:1px solid var(--review-border)">—</td><td style="padding:6px;border:1px solid var(--review-border)">低</td><td style="padding:6px;border:1px solid var(--review-border)">値 1 &lt; 2 なので戻らない</td></tr>
  </tbody>
</table>
<div style="font-size:12px;color:var(--review-muted);margin-top:4px">枠付きのセルが Before / After で結果の分かれる箇所です。1 回しか指名しない相手（regular nomination）では違いは出ません。</div>
</div>

- 受けた指名は `receivedNomination()` で値にします（[packages/ice/src/ice.ts:3015](review-file:packages/ice/src/ice.ts:3015)）。値はペアごとに最大値を `remoteNomination` に残します（[packages/ice/src/ice.ts:3390](review-file:packages/ice/src/ice.ts:3390)）。
- テストは [packages/ice/tests/ice/semi-aggressive.test.ts:344](review-file:packages/ice/tests/ice/semi-aggressive.test.ts:344)（値の大きい NOMINATION が優先）と [packages/ice/tests/ice/semi-aggressive.test.ts:365](review-file:packages/ice/tests/ice/semi-aggressive.test.ts:365)（USE-CANDIDATE は優先度の高いペアが優先）です。

### 2.4 semi-aggressive と renomination の指名の違い

どちらも「低優先度ペアで先に接続 → 高優先度ペアへ移る」流れです。違うのは、指名を通常の check に載せるか、別の check で送るかです。

<div style="display:flex;gap:12px;flex-wrap:wrap;font-family:var(--review-font)">
<div style="flex:1;min-width:330px">
<div style="font-weight:bold;margin-bottom:4px">semi-aggressive（既定）</div>
<svg viewBox="0 0 360 250" width="100%" role="img" aria-label="semi-aggressive の指名">
  <g stroke="var(--review-border)" stroke-width="1.5"><line x1="60" y1="28" x2="60" y2="245"/><line x1="300" y1="28" x2="300" y2="245"/></g>
  <g font-size="12" text-anchor="middle" fill="var(--review-fg)" font-weight="bold"><text x="60" y="18">controlling</text><text x="300" y="18">controlled</text></g>
  <g stroke="var(--review-muted)" stroke-width="1.5" fill="none"><line x1="60" y1="50" x2="296" y2="50"/><polyline points="288,45 296,50 288,55"/><line x1="300" y1="64" x2="64" y2="64" stroke-dasharray="4 3"/></g>
  <text x="180" y="44" font-size="11" text-anchor="middle" fill="var(--review-fg)">低: check + USE-CANDIDATE</text>
  <text x="180" y="80" font-size="11" text-anchor="middle" fill="var(--review-muted)">✓ 両端が「低」を選択</text>
  <g stroke="var(--review-success)" stroke-width="2" fill="none"><line x1="60" y1="130" x2="296" y2="130"/><polyline points="288,125 296,130 288,135"/><line x1="300" y1="144" x2="64" y2="144" stroke-dasharray="4 3"/></g>
  <text x="180" y="124" font-size="11" text-anchor="middle" fill="var(--review-success)">高: check + USE-CANDIDATE（上位なので）</text>
  <text x="180" y="160" font-size="11" text-anchor="middle" fill="var(--review-success)">✓ 両端が「高」へ置き換え</text>
  <text x="180" y="210" font-size="11" text-anchor="middle" fill="var(--review-muted)">指名は通常 check に載る（往復 1 回）</text>
  <text x="180" y="226" font-size="11" text-anchor="middle" fill="var(--review-muted)">consent check も選択中ペアに USE-CANDIDATE</text>
</svg>
</div>
<div style="flex:1;min-width:330px">
<div style="font-weight:bold;margin-bottom:4px">renomination（両端が宣言）</div>
<svg viewBox="0 0 360 250" width="100%" role="img" aria-label="renomination の指名">
  <g stroke="var(--review-border)" stroke-width="1.5"><line x1="60" y1="28" x2="60" y2="245"/><line x1="300" y1="28" x2="300" y2="245"/></g>
  <g font-size="12" text-anchor="middle" fill="var(--review-fg)" font-weight="bold"><text x="60" y="18">controlling</text><text x="300" y="18">controlled</text></g>
  <g stroke="var(--review-muted)" stroke-width="1.5" fill="none"><line x1="60" y1="50" x2="296" y2="50"/><polyline points="288,45 296,50 288,55"/><line x1="300" y1="64" x2="64" y2="64" stroke-dasharray="4 3"/></g>
  <text x="180" y="44" font-size="11" text-anchor="middle" fill="var(--review-fg)">低: check（属性なし）</text>
  <g stroke="var(--review-accent)" stroke-width="2" fill="none"><line x1="60" y1="88" x2="296" y2="88"/><polyline points="288,83 296,88 288,93"/><line x1="300" y1="102" x2="64" y2="102" stroke-dasharray="4 3"/></g>
  <text x="180" y="82" font-size="11" text-anchor="middle" fill="var(--review-accent)">低: NOMINATION=1（別の check）</text>
  <text x="180" y="116" font-size="11" text-anchor="middle" fill="var(--review-muted)">✓ 両端が「低」を選択</text>
  <g stroke="var(--review-muted)" stroke-width="1.5" fill="none"><line x1="60" y1="140" x2="296" y2="140"/><polyline points="288,135 296,140 288,145"/><line x1="300" y1="154" x2="64" y2="154" stroke-dasharray="4 3"/></g>
  <text x="180" y="134" font-size="11" text-anchor="middle" fill="var(--review-fg)">高: check（属性なし）</text>
  <g stroke="var(--review-success)" stroke-width="2" fill="none"><line x1="60" y1="178" x2="296" y2="178"/><polyline points="288,173 296,178 288,183"/><line x1="300" y1="192" x2="64" y2="192" stroke-dasharray="4 3"/></g>
  <text x="180" y="172" font-size="11" text-anchor="middle" fill="var(--review-success)">高: NOMINATION=2（値を増やす）</text>
  <text x="180" y="208" font-size="11" text-anchor="middle" fill="var(--review-success)">✓ 応答で両端が「高」へ移る</text>
  <text x="180" y="232" font-size="11" text-anchor="middle" fill="var(--review-muted)">応答なし・エラーのペアは使わない</text>
</svg>
</div>
</div>

- renomination の指名は `evaluateSelection()`（[packages/ice/src/ice.ts:3031](review-file:packages/ice/src/ice.ts:3031)）が「今の最良の valid ペア」を選び、`nominateSelection()`（[packages/ice/src/ice.ts:3050](review-file:packages/ice/src/ice.ts:3050)）が値を 1 増やして送ります。
- consent check は、選択中のペアの値をそのまま運びます（`consentNomination()`、[packages/ice/src/ice.ts:1954](review-file:packages/ice/src/ice.ts:1954)）。semi-aggressive では consent に USE-CANDIDATE を付けます（`shouldNominateConsentRequest()`、[packages/ice/src/ice.ts:1940](review-file:packages/ice/src/ice.ts:1940)）。
- STUN 属性は [packages/ice-server/src/stun/attributes.ts:209](review-file:packages/ice-server/src/stun/attributes.ts:209) に追加しました。

### 2.5 打ち切った check のペアを Waiting に戻す（S10、レビュー指摘への対応）

controlled 側が低優先度ペアで接続した時点で、高優先度ペアへの自分の check がまだ応答待ちだった場合の流れです。「次へ」で 1 段ずつ進めると、Before / After が同時に進みます。

<style>
  .rn-s10 { font-family: var(--review-font); color: var(--review-fg); border: 1px solid var(--review-border); border-radius: 6px; padding: 10px 12px; }
  .rn-s10 .rn-step { font-weight: bold; margin-bottom: 8px; }
  .rn-s10 .rn-cols { display: flex; gap: 10px; flex-wrap: wrap; }
  .rn-s10 .rn-col { flex: 1; min-width: 240px; border: 1px solid var(--review-border); border-radius: 6px; padding: 8px 10px; }
  .rn-s10 .rn-col h4 { margin: 0 0 6px; font-size: 13px; }
  .rn-s10 .rn-state { font-family: var(--review-mono); font-size: 12px; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--review-border); }
  .rn-s10 .rn-bad { border-color: var(--review-danger); color: var(--review-danger); }
  .rn-s10 .rn-good { border-color: var(--review-success); color: var(--review-success); }
  .rn-s10 .rn-same { color: var(--review-muted); }
  .rn-s10 .rn-diverge { border-width: 2px; }
  .rn-s10 button { border: 1px solid var(--review-border); background: var(--review-surface); color: var(--review-fg); padding: 2px 12px; margin-top: 8px; margin-right: 6px; border-radius: 4px; }
  .rn-s10 ol { margin: 8px 0 0; padding-left: 20px; font-size: 12px; color: var(--review-muted); }
  .rn-s10 li[aria-current="step"] { color: var(--review-fg); font-weight: bold; }
</style>

<div class="rn-s10">
  <div class="rn-step" id="rn-s10-title"></div>
  <div class="rn-cols">
    <div class="rn-col" id="rn-s10-before-box"><h4 style="color:var(--review-danger)">Before（S10 なし）</h4><div id="rn-s10-before"></div></div>
    <div class="rn-col" id="rn-s10-after-box"><h4 style="color:var(--review-success)">After（S10 あり）</h4><div id="rn-s10-after"></div></div>
  </div>
  <button data-rn-s10="-1">前へ</button><button data-rn-s10="1">次へ</button>
  <ol id="rn-s10-list"></ol>
</div>

<script>
  (() => {
    const pill = (state, cls) => '<span class="rn-state ' + (cls || "") + '">' + state + "</span>";
    const steps = [
      {
        title: "1. 相手の check が通り、高優先度ペアへの自分の check は応答待ち",
        before: ["低ペア " + pill("SUCCEEDED"), "高ペア " + pill("IN_PROGRESS")],
        after: ["低ペア " + pill("SUCCEEDED"), "高ペア " + pill("IN_PROGRESS")],
        diverge: false,
      },
      {
        title: "2. 相手が低ペアを指名 → 接続完了。connect() が残りの check を打ち切る",
        before: ["選択 = 低", "高ペア " + pill("IN_PROGRESS のまま", "rn-bad"), "打ち切り経路は何もせず return"],
        after: ["選択 = 低", "高ペア " + pill("WAITING", "rn-good"), "checkCancelled() が Waiting に戻す（打ち切り中に指名を受けていれば即 check）"],
        diverge: true,
      },
      {
        title: "3. 経路が回復し、相手が高ペアに check + USE-CANDIDATE（または NOMINATION）",
        before: ["checkIncoming(): 状態が WAITING / FAILED ではない", pill("triggered check を起こさない", "rn-bad"), "remoteNominated は立つが SUCCEEDED でないので選択しない"],
        after: ["checkIncoming(): " + pill("WAITING", "rn-good") + " なので triggered check", "成功 → remoteNominated && controlled → nominated", "replacesSelectedPair() → 選択 = 高"],
        diverge: true,
      },
      {
        title: "4. 結果",
        before: [pill("相手 = 高 / werift = 低", "rn-bad"), "経路が食い違ったまま（ICE restart まで）"],
        after: [pill("相手 = 高 / werift = 高", "rn-good"), "両端が同じ 5-tuple に収束"],
        diverge: true,
      },
    ];
    const $ = (id) => document.getElementById(id);
    const list = $("rn-s10-list");
    steps.forEach((s) => { const li = document.createElement("li"); li.textContent = s.title.replace(/^\d+\.\s*/, ""); list.append(li); });
    let current = 0;
    const render = () => {
      const s = steps[current];
      $("rn-s10-title").textContent = s.title;
      $("rn-s10-before").innerHTML = s.before.map((x) => "<div>" + x + "</div>").join("");
      $("rn-s10-after").innerHTML = s.after.map((x) => "<div>" + x + "</div>").join("");
      $("rn-s10-before-box").style.borderColor = s.diverge ? "var(--review-danger)" : "var(--review-border)";
      $("rn-s10-after-box").style.borderColor = s.diverge ? "var(--review-success)" : "var(--review-border)";
      [...list.children].forEach((li, i) => i === current ? li.setAttribute("aria-current", "step") : li.removeAttribute("aria-current"));
    };
    document.querySelectorAll("[data-rn-s10]").forEach((b) => b.addEventListener("click", () => {
      current = Math.min(steps.length - 1, Math.max(0, current + Number(b.dataset.rnS10)));
      render();
    }));
    render();
  })();
</script>

- 分かれ目はステップ 2 です。check の打ち切り経路から `checkCancelled()` を呼ぶようにしました（[packages/ice/src/ice.ts:2724](review-file:packages/ice/src/ice.ts:2724)、本体は [packages/ice/src/ice.ts:2855](review-file:packages/ice/src/ice.ts:2855)）。
- 対象は live checklist にある In-Progress のペアだけです。restart / close で世代が終わった場合と、checklist から外れたペアは対象外です。
- ステップ 3 で triggered check の対象になるのは `WAITING` と `FAILED` だけです（[packages/ice/src/ice.ts:3406](review-file:packages/ice/src/ice.ts:3406)）。Before ではここで止まっていました。
- 回帰テスト:
  - 実ソケット 2 件（semi-aggressive / renomination）: [packages/ice/tests/ice/semi-aggressive.test.ts:492](review-file:packages/ice/tests/ice/semi-aggressive.test.ts:492)。準備処理は `createDelayedPreferredPathPair()`（[packages/ice/tests/utils.ts:2948](review-file:packages/ice/tests/utils.ts:2948)）です。TURN relay のペアで接続させ、host ↔ host ペアの request を両端で止めておき、接続後に通します。
  - controlled の単体テスト 2 件: [packages/ice/tests/ice/semi-aggressive.test.ts:384](review-file:packages/ice/tests/ice/semi-aggressive.test.ts:384) と [packages/ice/tests/ice/semi-aggressive.test.ts:411](review-file:packages/ice/tests/ice/semi-aggressive.test.ts:411)。

### 2.6 regular nomination（オプション）

`iceNomination: "regular"` のときだけの挙動です。valid なペアができてもすぐには指名せず、上位のペアが追加されなくなってから `nominationDelayMs`（既定 300 ms）待つか、両端の end-of-candidates の後に、最良の valid ペアへ 1 回だけ指名します。

<svg viewBox="0 0 760 120" width="100%" role="img" aria-label="regular nomination のタイムライン" style="font-family:var(--review-font)">
  <line x1="20" y1="60" x2="740" y2="60" stroke="var(--review-border)" stroke-width="2"/>
  <g font-size="11" fill="var(--review-fg)" text-anchor="middle">
    <circle cx="80" cy="60" r="5" fill="var(--review-muted)"/><text x="80" y="45">低ペアが valid</text>
    <circle cx="260" cy="60" r="5" fill="var(--review-accent)"/><text x="260" y="45">上位ペアが追加</text><text x="260" y="84" fill="var(--review-accent)">quietSince を更新</text>
    <circle cx="360" cy="60" r="5" fill="var(--review-success)"/><text x="360" y="45">上位ペアが valid</text>
    <rect x="260" y="92" width="300" height="16" rx="3" fill="none" stroke="var(--review-warning)"/><text x="410" y="104" fill="var(--review-warning)">nominationDelayMs（既定 300 ms）</text>
    <circle cx="560" cy="60" r="6" fill="var(--review-success)"/><text x="560" y="45" font-weight="bold">deadline: 最良 valid ペアに USE-CANDIDATE</text>
    <circle cx="690" cy="60" r="5" fill="var(--review-success)"/><text x="690" y="84">応答で選択 → connect()</text>
  </g>
</svg>

- 実装は `RegularNomination`（[packages/ice/src/ice.ts:3772](review-file:packages/ice/src/ice.ts:3772)）と判定関数 `decideNomination`（[packages/ice/src/ice.ts:3645](review-file:packages/ice/src/ice.ts:3645)）です。live と provisional（pranswer の ICE restart）で共有しています。
- 応答がなければ同じペアに計 3 回まで送ります（`NOMINATION_ATTEMPTS`、[packages/ice/src/ice.ts:68](review-file:packages/ice/src/ice.ts:68)）。届かなければ他のペアは指名せず、`connect()` を reject して `failed` にします。相手が受理済みかもしれないペアの後に別のペアを指名すると、両端の経路が食い違うためです。
- 既定にしなかった理由は接続時間です。前々回のラウンドで、ループバックで計測しました（各 10 回の中央値。RTT 50 ms は UDP 送信に片道 25 ms の遅延を注入したもので、実ネットワークの計測ではありません）。

| 条件 | develop（aggressive） | regular nomination |
| --- | --- | --- |
| RTT ≈ 0、EOC あり | 21 ms | 21 ms |
| RTT ≈ 0、EOC なし | 21 ms | 306 ms |
| RTT 50 ms、EOC あり（controlling） | 53 ms | 104 ms |
| RTT 50 ms、EOC なし（controlling） | 62 ms | 410 ms |

既定の semi-aggressive は「最初の成功で即選択」なので、接続完了までの流れは develop と同じです（この表の再計測はしていません）。

## 3. 主要変更（ファイル別）

### 3.1 公開 API とオプション

| 追加物 | 場所 |
| --- | --- |
| `IceOptions.nominationDelayMs` / `nomination` / `renomination` | [packages/ice/src/iceBase.ts:370](review-file:packages/ice/src/iceBase.ts:370)、[packages/ice/src/iceBase.ts:388](review-file:packages/ice/src/iceBase.ts:388)、[packages/ice/src/iceBase.ts:401](review-file:packages/ice/src/iceBase.ts:401) |
| `CandidatePair.remoteNomination` / `nomination` | [packages/ice/src/iceBase.ts:168](review-file:packages/ice/src/iceBase.ts:168) |
| `PeerConfig.iceNominationDelayMs` / `iceNomination` / `iceRenomination` | [packages/webrtc/src/api/peerConfig.ts:112](review-file:packages/webrtc/src/api/peerConfig.ts:112)、[packages/webrtc/src/api/peerConfig.ts:121](review-file:packages/webrtc/src/api/peerConfig.ts:121)、[packages/webrtc/src/api/peerConfig.ts:133](review-file:packages/webrtc/src/api/peerConfig.ts:133) |
| `RTCIceGatherer` への受け渡し | [packages/webrtc/src/secureTransportManager.ts:226](review-file:packages/webrtc/src/secureTransportManager.ts:226) |
| SDP の `a=ice-options:trickle renomination` 宣言 | [packages/webrtc/src/sdpManager.ts:63](review-file:packages/webrtc/src/sdpManager.ts:63) |
| 相手の `renomination` 宣言の読み取り（session / media） | [packages/webrtc/src/negotiation/remoteMediaApplication.ts:498](review-file:packages/webrtc/src/negotiation/remoteMediaApplication.ts:498) |
| `getSelectedCandidatePair()` は選択済みのペアだけを返す（R11） | [packages/webrtc/src/transport/ice.ts:641](review-file:packages/webrtc/src/transport/ice.ts:641) |

`iceRenomination` が既定の `false` なら、SDP は従来どおり `a=ice-options:trickle` だけです。

### 3.2 ペア優先度の計算修正（R1）

develop の `candidatePairPriority()` は `(1 << 32) * MIN + 2 * MAX + tie` でした。JavaScript の `1 << 32` は 32 bit のシフトなので **1** になり、RFC 8445 §6.1.2.3 では最優先のはずの MIN が効いていませんでした。「最良のペア」が正しく決まらないと、どの nomination 方式も意味がないため、この変更に含めました。

| ペア（G / D の候補 priority） | RFC の順序 | develop の値 | 結果 |
| --- | --- | --- | --- |
| A: srflx 1694498815 / srflx 1694498815 | **A が上**（MIN が大きい） | 5,083,496,445 | develop は B を上と判定（逆転） |
| B: host 2130706431 / srflx 1694498559 | B が下 | 5,955,911,422 | |

新設の `compareCandidatePairPriority()`（[packages/ice/src/iceBase.ts:568](review-file:packages/ice/src/iceBase.ts:568)）が MIN → MAX → tie-break の順に正確に比較します。`candidatePairPriority()` の値は統計用の近似値です。

### 3.3 ICE の中核（`packages/ice/src/ice.ts`）

差分は大きいので、次の順に読むと追いやすいです。

1. 方式の判定: [packages/ice/src/ice.ts:2913](review-file:packages/ice/src/ice.ts:2913)〜[packages/ice/src/ice.ts:2993](review-file:packages/ice/src/ice.ts:2993)
2. check の送信と USE-CANDIDATE の付与: [packages/ice/src/ice.ts:2653](review-file:packages/ice/src/ice.ts:2653)
3. 選択と置き換え: [packages/ice/src/ice.ts:2495](review-file:packages/ice/src/ice.ts:2495)
4. 選択後の上位ペアの check: [packages/ice/src/ice.ts:3094](review-file:packages/ice/src/ice.ts:3094)
5. 受信した指名（controlled）: [packages/ice/src/ice.ts:3329](review-file:packages/ice/src/ice.ts:3329)
6. ロール変更時の指名の無効化（R5）と、選択済みペアの再指名（R16）: [packages/ice/src/ice.ts:2383](review-file:packages/ice/src/ice.ts:2383)、[packages/ice/src/ice.ts:2411](review-file:packages/ice/src/ice.ts:2411)
7. regular nomination: [packages/ice/src/ice.ts:3645](review-file:packages/ice/src/ice.ts:3645)、[packages/ice/src/ice.ts:3772](review-file:packages/ice/src/ice.ts:3772)

全体の差分は [packages/ice/src/ice.ts](review-diff:packages/ice/src/ice.ts:2855) から辿れます。

### 3.4 PBT oracle の調整（S10 の副作用への対応）

S10 を入れたところ、webrtc の leak property の 1 ケース（「a BUNDLE split merged again, then close」）が時々失敗するようになりました（HEAD 0/15、S10 のみ 5/15）。

<div style="display:flex;gap:12px;flex-wrap:wrap;font-family:var(--review-font)">
  <div style="flex:1;min-width:250px;padding:10px 12px;border:1px solid var(--review-border);border-left:5px solid var(--review-danger);border-radius:6px">
    <strong>Before の oracle</strong><br>
    何も確定しない操作（例: <code>setLocal(offer)</code>）の前後で、選択ペアが<strong>同じオブジェクト</strong>でなければ失敗。<br>
    <span style="color:var(--review-muted);font-size:12px">ICE が自分で選択を移したタイミングが操作と重なると失敗する。</span>
  </div>
  <div style="flex:1;min-width:250px;padding:10px 12px;border:1px solid var(--review-border);border-left:5px solid var(--review-success);border-radius:6px">
    <strong>After の oracle</strong><br>
    同じペアのまま、<strong>または</strong> ICE 自身による置き換え（同じ checklist の中で、指名の値が大きいペア、または値が同じで優先度の高いペアへの移動）なら合格。<br>
    <span style="color:var(--review-muted);font-size:12px">restart などで旧ペアが checklist から外れた場合と、劣るペアへの変化は従来どおり失敗。</span>
  </div>
</div>

- 原因はログで確かめました。loopback では、controlling 側が host ↔ host、controlled 側が `127.0.0.1` の peer-reflexive ペアで先に接続することがあります。ワイルドカードの socket から `127.0.0.1` 宛てに送ると、送信元も `127.0.0.1` になるためです。
- HEAD では、この食い違いが気づかれないまま固定されていました。S10 で controlled 側が十数 ms 後に controlling 側と同じペアへ移るようになり、その移動を旧 oracle が検出していました。oracle を調整した後は 15 回中 0 回の失敗です。
- 変更箇所は [packages/webrtc/tests/pbt/model/oracles.ts:713](review-file:packages/webrtc/tests/pbt/model/oracles.ts:713) と [packages/webrtc/tests/pbt/model/oracles.ts:848](review-file:packages/webrtc/tests/pbt/model/oracles.ts:848) です。

### 3.5 CI 修正（SCTP のバースト計測テスト）

最新のコミット `1cce757fc` は、`npm run ci` で失敗した [packages/sctp/tests/burst.test.ts:35](review-diff:packages/sctp/tests/burst.test.ts:35) の調整です。ICE の変更とは無関係で、計測の揺らぎに対応しています。

- 2,000 件程度の小さいバーストは 1 件あたりの CPU 時間が大きいバーストの半分ほどしかなく、処理が線形でも比が 8 倍前後になっていました。
- 1 件あたりの時間が安定する 4,000 件と 16,000 件で比べ、各規模 2 回計測した最小値を使うようにしました。判定（8 倍未満）は変えていません。

### 3.6 Chrome との相互接続 E2E

[e2e/tests/ice/nomination.test.ts:134](review-file:e2e/tests/ice/nomination.test.ts:134)（handler: [e2e/server/handler/ice/nomination.ts:37](review-file:e2e/server/handler/ice/nomination.ts:37)）。

- 構成: werift は TURN/UDP を使い、自分からは relay ペアだけを check します。ブラウザには werift の host 候補を保留しておくので、最初は relay ↔ host の経路で両端がつながります。
- その後、保留していた host 候補を Chrome に渡します。両端の選択が同じ host ↔ host の経路に移り、データが届くことを確認します。
- 組み合わせ: Chrome / werift のどちらが offer（= controlling）か × renomination の有無の 4 通りです。renomination ありでは、Chrome のローカル SDP の `a=ice-options` に `renomination` を書き足します（Chrome には有効にする API がないため）。

## 4. 判断理由

- **既定を semi-aggressive にした**: regular nomination では、controlling 側の接続完了が少なくとも 1 RTT 遅れます（2.6 の表）。Chrome の既定が semi-aggressive なので、相互接続時の挙動もそろいます。
- **「aggressive で繋いでから再指名」を既定にしなかった**: RFC 8445 §8.1.1 は、ICE restart なしの再指名を認めていません。相手によっては最初の指名を使い続けるので（webrtc-rs、develop の werift）、両端の経路が食い違います。semi-aggressive は libwebrtc の実績ある挙動に合わせたものです。
- **ICE-TCP はどの方式でも regular**: TCP ペアは接続ごとに別なので、複数を指名すると pruning 後に両端が別の接続になるおそれがあります（#721 と同じ理由）。
- **renomination は両端の宣言が必要**: ドラフトの前提に合わせました。controlled 側は設定に関係なく NOMINATION を処理します（Chrome と同じ）。
- **S10 は Waiting に戻す方法にした**: RFC 8445 §7.3.1.4 では、In-Progress のペアに check が届いたら triggered check をやり直すとされています。打ち切った check を Waiting に戻せば、既存の triggered check の経路（Waiting / Failed が対象）をそのまま使えます。

## 5. リスクとレビューで確認してほしい点

- **既定の挙動の変更**: 「最初の成功ペアで固定」がなくなり、接続後に選択ペアが変わることがあります。選択ペアが変わらない前提の利用側がないか確認してください。
- **controlled 側の挙動の変更**: 相手が後から別のペアを指名すると、そのペアに移ります。1 回しか指名しない相手では変化はありません。
- **指名の応答が失われたときの一時的な食い違い**: semi-aggressive では、相手が受理したのに応答だけが失われると、両端の経路が一時的に食い違うことがあります。werift はどのペアで届いたデータも受け取るので、通信は続きます（libwebrtc と同じ性質）。
- **Chrome の renomination は SDP の書き換えに依存**: Chrome はこの書き換えを SDP munging（種類 28）として計測しており、将来拒否される可能性があります。E2E もこの書き換えに依存しています。
- **`candidatePairPriority()` の値**: `MAX_SAFE_INTEGER` を超えることがあります。順序の比較には `compareCandidatePairPriority()` を使ってください。
- **oracle の緩和範囲**: 3.4 で許したのは「ICE 自身による置き換え」に当たる変化だけです。この範囲が妥当か確認してください。
- **チケット範囲を超える変更**: ペア優先度の修正、regular の再送・断念、487 の扱い、provisional の対応、`getSelectedCandidatePair()` の変更を含みます。いずれも changelog に書いています（[changelog.md](review-diff:changelog.md)）。

## 6. 検証結果

### 6.1 この文書の更新時に実行したもの（HEAD `1cce757fc`）

作業ツリーに未コミットの変更はありません。

| 内容 | 結果 |
| --- | --- |
| `npm run type` | 成功 |
| `cd packages/ice && npm test` | 48 ファイル成功・1 スキップ。510 件成功・5 件スキップ |
| webrtc `tests/transport/ice.test.ts` と `tests/pbt/model`（oracle を使う model property） | 2 ファイル成功。88 件成功・2 件スキップ |
| sctp `tests/burst.test.ts`（3.5） | 6 件成功 |

### 6.2 前回のレビュー修正（S10）のときに実行したもの

コード内容は今の HEAD と同じです（その後の差分は 3.5 の SCTP テストだけ）。

| 内容 | 結果 |
| --- | --- |
| `npm run test:small` | 全パッケージ成功（webrtc 1711 件成功・5 件スキップ） |
| E2E 全体（Chrome、再試行なし） | 24 ファイル・71 件成功 |
| E2E `tests/ice/nomination.test.ts`（再試行なし） | 3 回連続で 4/4 成功 |
| S10 の実ソケットテストの繰り返し | 10 回連続成功 |
| 検出力 | `checkCancelled()` を外すと S10 の 4 件すべて失敗、即時の再 check だけを外すと該当の 1 件が失敗 |
| leak property の比較（15 回ずつ） | HEAD 0/15、S10 のみ 5/15、oracle 調整後 0/15 |

### 6.3 実行していないもの

- `npm run wpt`、`npm run ci`（全体）、`npm run examples:e2e`
- 2.6 の接続時間の表の再計測
