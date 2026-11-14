---
ide:
  viewer: review-document
  version: 1
  title: "ICE: semi-aggressive 既定と regular / renomination、ice.ts のモジュール分割"
  dock: right
  baseCommit: b1b176c03d3dfffa13d5000c9e8c8a6256b7dc4a
---
# ICE: 既定を semi-aggressive nomination にし、regular nomination と renomination を選べるようにする（`ice.ts` のモジュール分割を含む）

## 1. 概要

**何が直ったか。** controlling 側の werift は、これまで最初に疎通したペアに固定され、後から届いた高優先度の候補へ移れませんでした。実環境（Chrome ↔ werift + TURN）では、先に通った TURN/TCP relay に張り付き、RTT が約 6.2 s になっていました（TURN/UDP なら約 88 ms）。

**ユーザーから見て何が変わるか。**

- **既定（設定なし）**: Chrome（libwebrtc）と同じ **semi-aggressive nomination** になります。最初に疎通したペアですぐ接続し（接続時間は従来と同じ）、後から成功した高優先度ペアに選択を移します。
- **controlled 側**: 相手が後から別のペアを指名すると、それに従います（従来は最初の指名を使い続けていました）。
- **オプション**: `PeerConfig.iceRenomination: true` で renomination（STUN 属性 `NOMINATION`、0xC001）を使えます。SDP に `a=ice-options:trickle renomination` を宣言します。`PeerConfig.iceNomination: "regular"` を指定すると、RFC 8445 の regular nomination（待ってから 1 ペアだけ指名）になります。
- **選択後に失敗した上位ペア**: 選択ペアより優先度が高いのに check が失敗したペアは、失敗から 1・2・4・8・16 秒後に再 check します（合計約 31 秒。2.7）。
- **controlled 側の同値の指名**: 指名の値が同じペアが複数あるときは、相手がデータを送ってきたペアを使います（libwebrtc と同じ。2.3）。
- **ICE-TCP ペアと ICE-lite**: どのモードでも従来どおりです。
- **コードの構成**: 4,168 行あった `packages/ice/src/ice.ts` を、責務ごとに 6 ファイルへ分けました。挙動は変わりません（3 章に Before / After の流れの図）。

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

### 2.1 同じ trickle の流れを 3 方式で比べる

**指名（nomination）** は、controlling 側が `USE-CANDIDATE` 付きの Binding Request を送り、成功応答を受けることです。成功すると、そのペアが両端で「接続に使うペア」として選択されます。3 つの方式の違いは、`USE-CANDIDATE` を**どの check に付けるか**と、**選択を後から置き換えるか**です。

入力は 3 つとも同じです。先に TURN/TCP relay のペアが疎通し、少し遅れて、優先度が上の TURN/UDP relay の候補が trickle で届きます。図はすべて同じ配置にしてあります。上から ① 最初の check、② 候補の到着、③ 到着後の check、④ 専用の指名 check（regular だけ）、⑤ 結果 の順です。

<div style="font-family:var(--review-font);color:var(--review-fg)">
<div style="font-weight:bold;margin:4px 0;color:var(--review-danger)">Before（develop: aggressive）</div>
<svg viewBox="0 0 760 350" width="100%" role="img" aria-label="Before: 最初の check から USE-CANDIDATE を付け、TURN/TCP に固定される流れ">
  <g stroke="var(--review-border)" stroke-width="1.5"><line x1="250" y1="30" x2="250" y2="345"/><line x1="510" y1="30" x2="510" y2="345"/></g>
  <g font-size="13" text-anchor="middle" fill="var(--review-fg)" font-weight="bold"><text x="250" y="20">werift（controlling）</text><text x="510" y="20">相手（controlled）</text></g>
  <g font-size="11" fill="var(--review-muted)"><text x="4" y="20">①</text><text x="4" y="124">②</text><text x="4" y="210">③</text><text x="4" y="262">④</text><text x="4" y="322">⑤</text></g>
  <g stroke="var(--review-danger)" stroke-width="2" fill="none"><line x1="250" y1="55" x2="505" y2="55"/><polyline points="497,50 505,55 497,60"/></g>
  <g stroke="var(--review-muted)" stroke-width="1.5" fill="none"><line x1="510" y1="72" x2="255" y2="72" stroke-dasharray="4 3"/><polyline points="263,67 255,72 263,77"/></g>
  <text x="380" y="49" font-size="11" text-anchor="middle" fill="var(--review-danger)" font-weight="bold">TURN/TCP + USE-CANDIDATE（すべての check に付く）</text>
  <text x="380" y="88" font-size="11" text-anchor="middle" fill="var(--review-muted)">成功応答 = 指名成立</text>
  <g font-size="11" fill="var(--review-fg)"><text x="240" y="60" text-anchor="end">nominated = TCP（確定）→ connect() 完了</text><text x="240" y="76" text-anchor="end">8.1.2: 残りの Waiting/Frozen → FAILED</text></g>
  <g font-size="11" fill="var(--review-fg)"><text x="520" y="60">最初の指名で TCP を選択</text><text x="520" y="76">（nominated == undefined のときだけ）</text></g>
  <rect x="150" y="105" width="460" height="28" rx="5" fill="none" stroke="var(--review-border)" stroke-dasharray="4 3"/>
  <text x="380" y="124" font-size="12" text-anchor="middle" fill="var(--review-fg)">TURN/UDP relay の候補が trickle で到着（優先度は TCP より上）</text>
  <text x="618" y="124" font-size="11" fill="var(--review-muted)">（選択後）</text>
  <rect x="24" y="148" width="480" height="40" rx="5" fill="none" stroke="var(--review-danger)" stroke-width="2"/>
  <text x="34" y="165" font-size="11" fill="var(--review-danger)" font-weight="bold">✗ pairLocalProtocol() / tryPair(): 選択済みなので新ペアを作らない</text>
  <text x="34" y="181" font-size="11" fill="var(--review-danger)">（仮に check しても nominated は上書きされない）</text>
  <text x="380" y="210" font-size="11" text-anchor="middle" fill="var(--review-muted)">TURN/UDP の check は送られない</text>
  <text x="380" y="262" font-size="11" text-anchor="middle" fill="var(--review-muted)">（専用の指名 check はない。① の check 自体が指名）</text>
  <rect x="150" y="300" width="460" height="44" rx="5" fill="none" stroke="var(--review-danger)" stroke-width="2"/>
  <text x="380" y="318" font-size="12" text-anchor="middle" fill="var(--review-danger)" font-weight="bold">両端とも TURN/TCP に固定 → RTT 約 6.2 s</text>
  <text x="380" y="335" font-size="11" text-anchor="middle" fill="var(--review-danger)">接続は最速だが、ICE restart まで上位ペアへ戻れない</text>
</svg>

<div style="font-weight:bold;margin:12px 0 4px;color:var(--review-success)">After（既定: semi-aggressive）</div>
<svg viewBox="0 0 760 350" width="100%" role="img" aria-label="semi-aggressive: 未選択の間と上位ペアにだけ USE-CANDIDATE を付け、TURN/UDP へ置き換わる流れ">
  <g stroke="var(--review-border)" stroke-width="1.5"><line x1="250" y1="30" x2="250" y2="345"/><line x1="510" y1="30" x2="510" y2="345"/></g>
  <g font-size="13" text-anchor="middle" fill="var(--review-fg)" font-weight="bold"><text x="250" y="20">werift（controlling）</text><text x="510" y="20">相手（controlled）</text></g>
  <g font-size="11" fill="var(--review-muted)"><text x="4" y="20">①</text><text x="4" y="124">②</text><text x="4" y="210">③</text><text x="4" y="262">④</text><text x="4" y="322">⑤</text></g>
  <g stroke="var(--review-muted)" stroke-width="1.5" fill="none"><line x1="250" y1="55" x2="505" y2="55"/><polyline points="497,50 505,55 497,60"/><line x1="510" y1="72" x2="255" y2="72" stroke-dasharray="4 3"/><polyline points="263,67 255,72 263,77"/></g>
  <text x="380" y="49" font-size="11" text-anchor="middle" fill="var(--review-fg)">TURN/TCP + USE-CANDIDATE（未選択なので付く）</text>
  <text x="380" y="88" font-size="11" text-anchor="middle" fill="var(--review-muted)">成功応答 = 指名成立</text>
  <g font-size="11" fill="var(--review-fg)"><text x="240" y="60" text-anchor="end">nominated = TCP → connect() 完了</text><text x="240" y="76" text-anchor="end" fill="var(--review-accent)">8.1.2: 上位ペアは FAILED にせず残す</text></g>
  <g font-size="11" fill="var(--review-fg)"><text x="520" y="60">TCP を選択</text></g>
  <rect x="150" y="105" width="460" height="28" rx="5" fill="none" stroke="var(--review-border)" stroke-dasharray="4 3"/>
  <text x="380" y="124" font-size="12" text-anchor="middle" fill="var(--review-fg)">TURN/UDP relay の候補が trickle で到着（優先度は TCP より上）</text>
  <text x="618" y="124" font-size="11" fill="var(--review-muted)">（選択後）</text>
  <rect x="24" y="148" width="220" height="40" rx="5" fill="none" stroke="var(--review-success)" stroke-width="2"/>
  <text x="34" y="165" font-size="11" fill="var(--review-success)" font-weight="bold">admitsPair(): 上位ペアだけ追加</text>
  <text x="34" y="181" font-size="11" fill="var(--review-success)">→ checkOutrankingPairs()</text>
  <g stroke="var(--review-success)" stroke-width="2" fill="none"><line x1="250" y1="210" x2="505" y2="210"/><polyline points="497,205 505,210 497,215"/><line x1="510" y1="226" x2="255" y2="226" stroke-dasharray="4 3"/><polyline points="263,221 255,226 263,231"/></g>
  <text x="380" y="204" font-size="11" text-anchor="middle" fill="var(--review-success)" font-weight="bold">TURN/UDP + USE-CANDIDATE（上位なので付く）</text>
  <text x="380" y="242" font-size="11" text-anchor="middle" fill="var(--review-muted)">成功応答 = 指名成立</text>
  <g font-size="11"><text x="240" y="232" text-anchor="end" fill="var(--review-success)" font-weight="bold">selection.replaces() → nominated = UDP</text><text x="240" y="248" text-anchor="end" fill="var(--review-fg)">consent.start() を新ペアで再開</text></g>
  <g font-size="11"><text x="520" y="215" fill="var(--review-success)" font-weight="bold">値 1 同士・優先度が上</text><text x="520" y="231" fill="var(--review-success)">→ UDP に置き換え</text></g>
  <text x="380" y="270" font-size="11" text-anchor="middle" fill="var(--review-muted)">（専用の指名 check はない。③ の check 自体が指名）</text>
  <rect x="150" y="300" width="460" height="44" rx="5" fill="none" stroke="var(--review-success)" stroke-width="2"/>
  <text x="380" y="318" font-size="12" text-anchor="middle" fill="var(--review-success)" font-weight="bold">TCP で即接続 → 両端とも TURN/UDP へ移る（RTT 約 88 ms 相当）</text>
  <text x="380" y="335" font-size="11" text-anchor="middle" fill="var(--review-fg)">接続時間は Before と同じ。選択後に届いた上位候補にも移れる</text>
</svg>

<div style="font-weight:bold;margin:12px 0 4px;color:var(--review-warning)">After（<code>iceNomination: "regular"</code>）</div>
<svg viewBox="0 0 760 350" width="100%" role="img" aria-label="regular: 通常の check には USE-CANDIDATE を付けず、待ってから最良の TURN/UDP を 1 回だけ指名する流れ">
  <g stroke="var(--review-border)" stroke-width="1.5"><line x1="250" y1="30" x2="250" y2="345"/><line x1="510" y1="30" x2="510" y2="345"/></g>
  <g font-size="13" text-anchor="middle" fill="var(--review-fg)" font-weight="bold"><text x="250" y="20">werift（controlling）</text><text x="510" y="20">相手（controlled）</text></g>
  <g font-size="11" fill="var(--review-muted)"><text x="4" y="20">①</text><text x="4" y="124">②</text><text x="4" y="210">③</text><text x="4" y="262">④</text><text x="4" y="322">⑤</text></g>
  <g stroke="var(--review-muted)" stroke-width="1.5" fill="none"><line x1="250" y1="55" x2="505" y2="55"/><polyline points="497,50 505,55 497,60"/><line x1="510" y1="72" x2="255" y2="72" stroke-dasharray="4 3"/><polyline points="263,67 255,72 263,77"/></g>
  <text x="380" y="49" font-size="11" text-anchor="middle" fill="var(--review-warning)" font-weight="bold">TURN/TCP（USE-CANDIDATE なし）</text>
  <text x="380" y="88" font-size="11" text-anchor="middle" fill="var(--review-muted)">成功応答 = valid になるだけ</text>
  <g font-size="11" fill="var(--review-fg)"><text x="240" y="60" text-anchor="end">TCP は valid（未指名・未接続）</text><text x="240" y="76" text-anchor="end" fill="var(--review-warning)">⏱ 静穏から nominationDelayMs 待つ</text></g>
  <g font-size="11" fill="var(--review-muted)"><text x="520" y="60">まだ選択しない</text></g>
  <rect x="150" y="105" width="460" height="28" rx="5" fill="none" stroke="var(--review-border)" stroke-dasharray="4 3"/>
  <text x="380" y="124" font-size="12" text-anchor="middle" fill="var(--review-fg)">TURN/UDP relay の候補が trickle で到着（優先度は TCP より上）</text>
  <text x="618" y="124" font-size="11" fill="var(--review-warning)">（待ち時間中）</text>
  <rect x="24" y="148" width="220" height="40" rx="5" fill="none" stroke="var(--review-warning)" stroke-width="2"/>
  <text x="34" y="165" font-size="11" fill="var(--review-warning)" font-weight="bold">pairAdded(): 上位ペアなので</text>
  <text x="34" y="181" font-size="11" fill="var(--review-warning)">待ち時間をやり直す</text>
  <g stroke="var(--review-muted)" stroke-width="1.5" fill="none"><line x1="250" y1="210" x2="505" y2="210"/><polyline points="497,205 505,210 497,215"/><line x1="510" y1="226" x2="255" y2="226" stroke-dasharray="4 3"/><polyline points="263,221 255,226 263,231"/></g>
  <text x="380" y="204" font-size="11" text-anchor="middle" fill="var(--review-fg)">TURN/UDP（USE-CANDIDATE なし）</text>
  <text x="380" y="242" font-size="11" text-anchor="middle" fill="var(--review-muted)">成功応答 = valid になるだけ</text>
  <g font-size="11" fill="var(--review-fg)"><text x="240" y="232" text-anchor="end">UDP も valid（最良の valid ペア）</text></g>
  <g font-size="11" fill="var(--review-muted)"><text x="520" y="215">まだ選択しない</text></g>
  <g stroke="var(--review-success)" stroke-width="2" fill="none"><line x1="250" y1="262" x2="505" y2="262"/><polyline points="497,257 505,262 497,267"/><line x1="510" y1="278" x2="255" y2="278" stroke-dasharray="4 3"/><polyline points="263,273 255,278 263,283"/></g>
  <text x="380" y="256" font-size="11" text-anchor="middle" fill="var(--review-success)" font-weight="bold">専用 check: TURN/UDP + USE-CANDIDATE（1 回だけ）</text>
  <text x="380" y="294" font-size="11" text-anchor="middle" fill="var(--review-muted)">成功応答 = 指名成立（応答なしなら計 3 回まで）</text>
  <g font-size="11"><text x="240" y="250" text-anchor="end" fill="var(--review-warning)">⏱ 待ち終了 or end-of-candidates</text><text x="240" y="268" text-anchor="end" fill="var(--review-success)" font-weight="bold">RegularNomination → nominated = UDP</text><text x="240" y="284" text-anchor="end" fill="var(--review-fg)">connect() 完了 / 残りは FAILED</text></g>
  <g font-size="11"><text x="520" y="267" fill="var(--review-success)" font-weight="bold">最初の指名で UDP を選択</text></g>
  <rect x="150" y="300" width="460" height="44" rx="5" fill="none" stroke="var(--review-warning)" stroke-width="2"/>
  <text x="380" y="318" font-size="12" text-anchor="middle" fill="var(--review-success)" font-weight="bold">最初から TURN/UDP だけを指名（選択は 1 回で、移り変わらない）</text>
  <text x="380" y="335" font-size="11" text-anchor="middle" fill="var(--review-warning)">接続は待ち時間の分だけ遅い。待ちが終わった後に届いた上位候補には移らない</text>
</svg>
<div style="font-size:12px;color:var(--review-muted);margin-top:4px">凡例: <span style="color:var(--review-danger)">赤 = 問題の箇所</span> / <span style="color:var(--review-success)">緑 = 指名・置き換えが起きる流れ</span> / <span style="color:var(--review-warning)">黄 = regular 固有の待ちとトレードオフ</span> / <span style="color:var(--review-accent)">アクセント = 変更で扱いが変わった状態</span>。灰色の矢印は <code>USE-CANDIDATE</code> の付かない check か、指名にならない check です。3 つの図は同じ入力・同じ配置です。</div>
</div>

3 方式の違いをまとめると次のとおりです。

| | aggressive（Before） | semi-aggressive（既定） | regular |
| --- | --- | --- | --- |
| ① 最初の check の `USE-CANDIDATE` | 付く | 付く（未選択なので） | 付かない |
| 選択するタイミング | 最初の成功で即 | 最初の成功で即 | 待ち時間の後に 1 回だけ |
| 接続時間 | 最速 | 最速（Before と同じ） | 待ち時間の分だけ遅い |
| 選択後に届いた上位ペア | ペアを作らない | check して置き換える | 置き換えない |
| この入力での結果 | TURN/TCP に固定 | TCP → UDP に移る | 最初から UDP |

要点:

- 最初のペアに `USE-CANDIDATE` が付くのは、aggressive も semi-aggressive も同じです。2 つの違いは選択した後です。semi-aggressive では、選択時の 8.1.2 の掃除で上位ペアを残します（[packages/ice/src/ice.ts:1472](review-file:packages/ice/src/ice.ts:1472)）。`connect()` の打ち切り処理でも、上位ペアの check は続けます（[packages/ice/src/ice.ts:988](review-file:packages/ice/src/ice.ts:988)）。
- 後から届いた候補で上位のペアだけを作るのは `admitsPair()` です（[packages/ice/src/ice.ts:2253](review-file:packages/ice/src/ice.ts:2253)）。その check を 20 ms 間隔で進めるのが `SelectionReplacement.checkOutrankingPairs()` です（[packages/ice/src/nomination/selectionReplacement.ts:316](review-file:packages/ice/src/nomination/selectionReplacement.ts:316)）。
- semi-aggressive で `USE-CANDIDATE` を付けるのは、「未選択の間」の check と「選択より上位のペア」の check だけです（[packages/ice/src/ice.ts:1608](review-file:packages/ice/src/ice.ts:1608)）。regular と renomination の通常の check には何も付けません。
- 置き換えの判定は `SelectionReplacement.replaces()`（[packages/ice/src/nomination/selectionReplacement.ts:194](review-file:packages/ice/src/nomination/selectionReplacement.ts:194)）です。送信経路・consent・統計の移し替えは `checkComplete()` で行います（[packages/ice/src/ice.ts:1448](review-file:packages/ice/src/ice.ts:1448)）。
- regular では、待つか指名するかを `decideNomination()` が決めます（[packages/ice/src/nomination/regularNomination.ts:59](review-file:packages/ice/src/nomination/regularNomination.ts:59)）。上位ペアが追加されると、`RegularNomination.pairAdded()` が待ち時間をやり直します（[packages/ice/src/nomination/regularNomination.ts:218](review-file:packages/ice/src/nomination/regularNomination.ts:218)）。regular は選択を置き換えないので、後から届いた候補をペアにするのは選択前だけです（[packages/ice/src/ice.ts:2265](review-file:packages/ice/src/ice.ts:2265)）。

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
        body = "指名の値（NOMINATION の値、USE-CANDIDATE は 1）が大きいペアを使います。同じ値なら相手が直近にデータを送ったペア、どちらにもデータがなければ優先度の高いペアを使います。どの設定でも NOMINATION を処理します（Chrome と同じ）。従来は最初の指名を使い続けていました。";
        fn = "receivedNomination()（internal/checkMessages.ts）/ SelectionReplacement.replaces() の controlled 分岐";
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
        fn = "usesRenomination() / SelectionReplacement.evaluate() / nominateSelection()";
        color = "var(--review-success)";
      } else if (v.regular) {
        title = "regular nomination: 待ってから 1 ペアだけ指名";
        body = "静穏起点 + nominationDelayMs（既定 300 ms）か、end-of-candidates の後に、最良の valid ペアへ USE-CANDIDATE の専用 check を 1 回送ります。応答がなければ同じペアに計 3 回まで送り、それでも届かなければ connect() を reject します。";
        fn = "usesRegularNomination() / RegularNomination / decideNomination（nomination/regularNomination.ts）";
        color = "var(--review-warning)";
      } else {
        title = "semi-aggressive（既定）";
        body = "未選択の間と、選択より上位のペアの check にだけ USE-CANDIDATE を付けます。最初の成功で即座に選択し、上位ペアが成功したら置き換えます。consent check も選択中のペアに USE-CANDIDATE を付けます。"
          + (v["ren-local"] !== v["ren-remote"] ? "（renomination は片側だけの宣言なので使いません）" : "");
        fn = "usesSemiAggressiveNomination() / SelectionReplacement.replaces() / checkOutrankingPairs()";
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
| controlled | 相手の指名に従う（値 → 最終受信 → 優先度） | [packages/ice/src/nomination/selectionReplacement.ts:194](review-file:packages/ice/src/nomination/selectionReplacement.ts:194) |
| ICE-TCP ペア | regular（置き換えない） | [packages/ice/src/ice.ts:1898](review-file:packages/ice/src/ice.ts:1898) / [packages/ice/src/ice.ts:1907](review-file:packages/ice/src/ice.ts:1907) |
| 両端が renomination を宣言 | renomination | [packages/ice/src/ice.ts:1844](review-file:packages/ice/src/ice.ts:1844) |
| `iceNomination: "regular"` | regular | [packages/ice/src/ice.ts:1858](review-file:packages/ice/src/ice.ts:1858) |
| それ以外（既定） | semi-aggressive | [packages/ice/src/ice.ts:1874](review-file:packages/ice/src/ice.ts:1874) |

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

- 受けた指名は `receivedNomination()` で値にします（[packages/ice/src/internal/checkMessages.ts:44](review-file:packages/ice/src/internal/checkMessages.ts:44)）。値はペアごとに最大値を `remoteNomination` に残します（[packages/ice/src/ice.ts:2180](review-file:packages/ice/src/ice.ts:2180)）。
- テストは [packages/ice/tests/ice/semi-aggressive.test.ts:344](review-file:packages/ice/tests/ice/semi-aggressive.test.ts:344)（値の大きい NOMINATION が優先）と [packages/ice/tests/ice/semi-aggressive.test.ts:365](review-file:packages/ice/tests/ice/semi-aggressive.test.ts:365)（USE-CANDIDATE は優先度の高いペアが優先）です。

#### 同じ指名の値のとき: 相手がデータを送るペアに従う

指名の値が同じペアが複数あるとき、これまでは優先度の高いほうを選んでいました。ところが libwebrtc の controlling 側は、選択中のペアが働かなくなると、優先度の低いペアへ自分で移ることがあります。優先度で選ぶと、werift は相手が離れた経路へ送り続けてしまいます。

そこで、値が同じ指名済みペアのあいだでは **相手が最後にアプリケーションデータを送ってきたペア** を選びます。データがまだ届いていない間は、従来どおり優先度の高いペアです。

- 受信ごとに、そのペアへ増加する通し番号を記録します（`SelectionReplacement` の `lastData`）。[packages/ice/src/nomination/selectionReplacement.ts:204](review-file:packages/ice/src/nomination/selectionReplacement.ts:204) で通し番号を比べ、[packages/ice/src/nomination/selectionReplacement.ts:225](review-file:packages/ice/src/nomination/selectionReplacement.ts:225) の `controlledDataReceived()` が受信時に置き換えを判定します（流れの図は 3.3）。
- 指名の値が小さいペアや、相手が指名していないペアにデータが届いても、選択は動きません。指名したのにデータを送らないペアは、データが届くまで選択を置き換えません。
- ICE-TCP ペアは記録だけで、選択しません（選ぶと他の TCP 接続を整理するため）。
- この判定のため、`Protocol.onDataReceived` が受信元のアドレスも渡すようになりました（[packages/ice/src/types/model.ts:52](review-file:packages/ice/src/types/model.ts:52)）。独自の `Protocol` 実装は `Event<[Buffer, Address]>` に合わせて、`execute(data, addr)` で呼ぶ必要があります（公開型の変更。6 章）。
- テストは [packages/ice/tests/ice/semi-aggressive.test.ts:384](review-file:packages/ice/tests/ice/semi-aggressive.test.ts:384)（データを送るペアが優先）、[packages/ice/tests/ice/semi-aggressive.test.ts:406](review-file:packages/ice/tests/ice/semi-aggressive.test.ts:406)（データが来るまで置き換えない）、[packages/ice/tests/ice/semi-aggressive.test.ts:426](review-file:packages/ice/tests/ice/semi-aggressive.test.ts:426)（値が小さい・指名のないペアでは動かない）です。

### 2.4 semi-aggressive と renomination の違い

ひとことで言うと、違いは次の 2 点です。

- **指名の運び方**: semi-aggressive は、指名（`USE-CANDIDATE`）を**通常の check に相乗り**させます。renomination は、ペアが valid になってから**別の check で番号付きの指名**（`NOMINATION=n`）を送ります。
- **どのペアを使うかを誰が決めるか**: semi-aggressive の指名には値がない（すべて 1 扱い）ので、controlled 側は「指名されたペアのうち**優先度が最も高いもの**」を自分で選びます。renomination では、controlled 側は「**値が最も大きい（＝最新の）指名**」に従います。どのペアを使うかを controlling 側が明示的に決められます。

#### (a) 同じ流れ: 低優先度で接続 → 高優先度へ移る

左右の図は同じ配置です。① 低の check、② 低の指名、③ 高の check、④ 高の指名、の順に並べ、最後に controlled 側の判定を示しています。

<div style="display:flex;gap:12px;flex-wrap:wrap;font-family:var(--review-font);color:var(--review-fg)">
<div style="flex:1;min-width:330px">
<div style="font-weight:bold;margin-bottom:4px;color:var(--review-success)">semi-aggressive（既定）</div>
<svg viewBox="0 0 360 300" width="100%" role="img" aria-label="semi-aggressive: 指名は通常の check に相乗りし、controlled 側は優先度で選ぶ">
  <g stroke="var(--review-border)" stroke-width="1.5"><line x1="60" y1="28" x2="60" y2="245"/><line x1="300" y1="28" x2="300" y2="245"/></g>
  <g font-size="12" text-anchor="middle" fill="var(--review-fg)" font-weight="bold"><text x="60" y="18">controlling</text><text x="300" y="18">controlled</text></g>
  <g font-size="11" fill="var(--review-muted)"><text x="4" y="54">①</text><text x="4" y="111">②</text><text x="4" y="160">③</text><text x="4" y="217">④</text></g>
  <g stroke="var(--review-success)" stroke-width="2" fill="none"><line x1="60" y1="50" x2="296" y2="50"/><polyline points="288,45 296,50 288,55"/></g>
  <g stroke="var(--review-muted)" stroke-width="1.5" fill="none"><line x1="300" y1="64" x2="64" y2="64" stroke-dasharray="4 3"/></g>
  <text x="180" y="44" font-size="11" text-anchor="middle" fill="var(--review-success)" font-weight="bold">低: check + USE-CANDIDATE</text>
  <text x="180" y="80" font-size="11" text-anchor="middle" fill="var(--review-success)">✓ 応答で指名成立 → 両端が「低」を選択</text>
  <text x="180" y="111" font-size="11" text-anchor="middle" fill="var(--review-muted)">（別の指名 check はない。① が指名を兼ねる）</text>
  <g stroke="var(--review-success)" stroke-width="2" fill="none"><line x1="60" y1="156" x2="296" y2="156"/><polyline points="288,151 296,156 288,161"/></g>
  <g stroke="var(--review-muted)" stroke-width="1.5" fill="none"><line x1="300" y1="170" x2="64" y2="170" stroke-dasharray="4 3"/></g>
  <text x="180" y="150" font-size="11" text-anchor="middle" fill="var(--review-success)" font-weight="bold">高: check + USE-CANDIDATE（上位なので）</text>
  <text x="180" y="186" font-size="11" text-anchor="middle" fill="var(--review-success)">✓ 応答で指名成立 → 両端が「高」へ</text>
  <text x="180" y="217" font-size="11" text-anchor="middle" fill="var(--review-muted)">（別の指名 check はない。③ が指名を兼ねる）</text>
  <rect x="10" y="246" width="340" height="48" rx="5" fill="none" stroke="var(--review-border)"/>
  <text x="180" y="264" font-size="11" text-anchor="middle" fill="var(--review-fg)" font-weight="bold">controlled の判定: 値は「低」も「高」も 1</text>
  <text x="180" y="282" font-size="11" text-anchor="middle" fill="var(--review-fg)">→ 同じ値なので<tspan font-weight="bold">優先度</tspan>の高い「高」を使う</text>
</svg>
<div style="font-size:12px;color:var(--review-muted)">指名 1 回 = 往復 1 回。最初の接続が最も速い。</div>
</div>
<div style="flex:1;min-width:330px">
<div style="font-weight:bold;margin-bottom:4px;color:var(--review-accent)">renomination（両端が宣言）</div>
<svg viewBox="0 0 360 300" width="100%" role="img" aria-label="renomination: 通常の check の後に番号付きの指名 check を送り、controlled 側は値の大きい指名に従う">
  <g stroke="var(--review-border)" stroke-width="1.5"><line x1="60" y1="28" x2="60" y2="245"/><line x1="300" y1="28" x2="300" y2="245"/></g>
  <g font-size="12" text-anchor="middle" fill="var(--review-fg)" font-weight="bold"><text x="60" y="18">controlling</text><text x="300" y="18">controlled</text></g>
  <g font-size="11" fill="var(--review-muted)"><text x="4" y="54">①</text><text x="4" y="108">②</text><text x="4" y="160">③</text><text x="4" y="214">④</text></g>
  <g stroke="var(--review-muted)" stroke-width="1.5" fill="none"><line x1="60" y1="50" x2="296" y2="50"/><polyline points="288,45 296,50 288,55"/><line x1="300" y1="64" x2="64" y2="64" stroke-dasharray="4 3"/></g>
  <text x="180" y="44" font-size="11" text-anchor="middle" fill="var(--review-fg)">低: check（属性なし）</text>
  <text x="180" y="80" font-size="11" text-anchor="middle" fill="var(--review-muted)">valid になるだけ（まだ選択しない）</text>
  <g stroke="var(--review-accent)" stroke-width="2" fill="none"><line x1="60" y1="104" x2="296" y2="104"/><polyline points="288,99 296,104 288,109"/></g>
  <g stroke="var(--review-muted)" stroke-width="1.5" fill="none"><line x1="300" y1="118" x2="64" y2="118" stroke-dasharray="4 3"/></g>
  <text x="180" y="98" font-size="11" text-anchor="middle" fill="var(--review-accent)" font-weight="bold">低: NOMINATION=1（別の check）</text>
  <text x="180" y="134" font-size="11" text-anchor="middle" fill="var(--review-accent)">✓ 応答で両端が「低」を選択</text>
  <g stroke="var(--review-muted)" stroke-width="1.5" fill="none"><line x1="60" y1="156" x2="296" y2="156"/><polyline points="288,151 296,156 288,161"/><line x1="300" y1="170" x2="64" y2="170" stroke-dasharray="4 3"/></g>
  <text x="180" y="150" font-size="11" text-anchor="middle" fill="var(--review-fg)">高: check（属性なし）</text>
  <text x="180" y="186" font-size="11" text-anchor="middle" fill="var(--review-muted)">valid になるだけ（選択は「低」のまま）</text>
  <g stroke="var(--review-accent)" stroke-width="2" fill="none"><line x1="60" y1="210" x2="296" y2="210"/><polyline points="288,205 296,210 288,215"/></g>
  <g stroke="var(--review-muted)" stroke-width="1.5" fill="none"><line x1="300" y1="224" x2="64" y2="224" stroke-dasharray="4 3"/></g>
  <text x="180" y="204" font-size="11" text-anchor="middle" fill="var(--review-accent)" font-weight="bold">高: NOMINATION=2（値を 1 増やす）</text>
  <text x="180" y="240" font-size="11" text-anchor="middle" fill="var(--review-accent)">✓ 応答で両端が「高」へ</text>
  <rect x="10" y="246" width="340" height="48" rx="5" fill="none" stroke="var(--review-border)"/>
  <text x="180" y="264" font-size="11" text-anchor="middle" fill="var(--review-fg)" font-weight="bold">controlled の判定: 「低」= 1、「高」= 2</text>
  <text x="180" y="282" font-size="11" text-anchor="middle" fill="var(--review-fg)">→ <tspan font-weight="bold">値</tspan>の大きい（＝最新の）「高」を使う</text>
</svg>
<div style="font-size:12px;color:var(--review-muted)">指名 1 回 = 往復 2 回（check + 指名 check）。応答なし・エラーのペアは使わない。</div>
</div>
</div>

この流れでは、どちらも最終的に「高」へ移ります。違いは、② と ④ に別の指名 check があるかどうかと、controlled 側が何を根拠に選ぶかです。

#### (b) 違いが結果に出る場面: 優先度の**低い**ペアへ移したいとき

controlling 側が、「高」の経路が劣化したので「低」へ戻したいと考えた場合です。controlled 側（werift）は、受けた指名を次のように扱います。

<div style="display:flex;gap:12px;flex-wrap:wrap;font-family:var(--review-font);color:var(--review-fg)">
<div style="flex:1;min-width:330px">
<div style="font-weight:bold;margin-bottom:4px;color:var(--review-success)">semi-aggressive の指名</div>
<svg viewBox="0 0 360 190" width="100%" role="img" aria-label="semi-aggressive: 低優先度ペアへの USE-CANDIDATE では選択は移らない">
  <g stroke="var(--review-border)" stroke-width="1.5"><line x1="60" y1="28" x2="60" y2="135"/><line x1="300" y1="28" x2="300" y2="135"/></g>
  <g font-size="12" text-anchor="middle" fill="var(--review-fg)" font-weight="bold"><text x="60" y="18">controlling</text><text x="300" y="18">controlled（werift）</text></g>
  <text x="180" y="48" font-size="11" text-anchor="middle" fill="var(--review-muted)">選択中: 「高」（値 1）</text>
  <g stroke="var(--review-muted)" stroke-width="1.5" fill="none"><line x1="60" y1="84" x2="296" y2="84"/><polyline points="288,79 296,84 288,89"/><line x1="300" y1="98" x2="64" y2="98" stroke-dasharray="4 3"/></g>
  <text x="180" y="78" font-size="11" text-anchor="middle" fill="var(--review-fg)">低: USE-CANDIDATE（値 1）</text>
  <text x="180" y="116" font-size="11" text-anchor="middle" fill="var(--review-muted)">成功応答は返る</text>
  <rect x="10" y="138" width="340" height="46" rx="5" fill="none" stroke="var(--review-danger)" stroke-width="2"/>
  <text x="180" y="156" font-size="11" text-anchor="middle" fill="var(--review-danger)" font-weight="bold">値 1 同士 → 優先度で比べて「高」のまま</text>
  <text x="180" y="174" font-size="11" text-anchor="middle" fill="var(--review-danger)">USE-CANDIDATE では下位へ戻す指示を伝えられない</text>
</svg>
</div>
<div style="flex:1;min-width:330px">
<div style="font-weight:bold;margin-bottom:4px;color:var(--review-accent)">renomination の指名</div>
<svg viewBox="0 0 360 190" width="100%" role="img" aria-label="renomination: 値の大きい NOMINATION で低優先度ペアへ移る">
  <g stroke="var(--review-border)" stroke-width="1.5"><line x1="60" y1="28" x2="60" y2="135"/><line x1="300" y1="28" x2="300" y2="135"/></g>
  <g font-size="12" text-anchor="middle" fill="var(--review-fg)" font-weight="bold"><text x="60" y="18">controlling</text><text x="300" y="18">controlled（werift）</text></g>
  <text x="180" y="48" font-size="11" text-anchor="middle" fill="var(--review-muted)">選択中: 「高」（値 2）</text>
  <g stroke="var(--review-accent)" stroke-width="2" fill="none"><line x1="60" y1="84" x2="296" y2="84"/><polyline points="288,79 296,84 288,89"/></g>
  <g stroke="var(--review-muted)" stroke-width="1.5" fill="none"><line x1="300" y1="98" x2="64" y2="98" stroke-dasharray="4 3"/></g>
  <text x="180" y="78" font-size="11" text-anchor="middle" fill="var(--review-accent)" font-weight="bold">低: NOMINATION=3</text>
  <text x="180" y="116" font-size="11" text-anchor="middle" fill="var(--review-muted)">成功応答</text>
  <rect x="10" y="138" width="340" height="46" rx="5" fill="none" stroke="var(--review-success)" stroke-width="2"/>
  <text x="180" y="156" font-size="11" text-anchor="middle" fill="var(--review-success)" font-weight="bold">値 3 &gt; 2 → 優先度に関係なく「低」へ移る</text>
  <text x="180" y="174" font-size="11" text-anchor="middle" fill="var(--review-success)">controlling の判断がそのまま両端の選択になる</text>
</svg>
</div>
</div>

libwebrtc（Chrome）は、優先度だけでなく疎通状態や RTT も見て選択を変えるので、優先度の低いペアへ移すことがあります。werift が controlled のとき、そうした相手に正しく従えるのは renomination の場合だけです。一方、werift が controlling のときは、どちらの方式でも**上位のペアにしか**選択を移しません（`SelectionReplacement.evaluate()` と `replaces()` の `outranks()` 判定）。そのため werift 同士では、(a) の違い（往復の回数と判定の根拠）だけが現れます。

#### (c) 比較表

| | semi-aggressive（既定） | renomination |
| --- | --- | --- |
| 使う条件 | 設定なし（標準の `USE-CANDIDATE`） | 自分が `iceRenomination: true`、かつ相手の SDP に `a=ice-options:renomination` |
| 指名を運ぶもの | `USE-CANDIDATE`（値なし、1 扱い） | `NOMINATION`（0xC001、1, 2, 3… と単調増加） |
| 指名を載せる check | 通常の check（未選択の間と上位ペアのとき） | valid になった後の別の check（通常の check には何も付けない） |
| 最初の接続までの往復 | 1 回 | 2 回（check + 指名 check） |
| controlled 側が使うペア | 指名済みのうち優先度が最も高いペア | 値が最も大きい（最新の）指名のペア |
| 優先度の低いペアへ戻す | 伝えられない | 値を増やせば伝えられる |
| 指名に失敗したとき | check 自体の失敗として扱う | 応答なし・エラーのペアは使わず、次に良い valid ペアを指名する |
| consent check | 選択中のペアに `USE-CANDIDATE` を付ける | 選択中のペアの値をそのまま付ける |
| 片側だけが宣言したとき | — | semi-aggressive になる |

実装の参照先:

- renomination の指名は、`SelectionReplacement.evaluate()`（[packages/ice/src/nomination/selectionReplacement.ts:256](review-file:packages/ice/src/nomination/selectionReplacement.ts:256)）が「今の最良の valid ペア」を選び、`nominateSelection()`（[packages/ice/src/nomination/selectionReplacement.ts:272](review-file:packages/ice/src/nomination/selectionReplacement.ts:272)）が値を 1 増やして送ります。失敗したペアは FAILED にして、次のペアを評価し直します。
- semi-aggressive の指名は、通常の check の `nominate` 判定で決まります（[packages/ice/src/ice.ts:1608](review-file:packages/ice/src/ice.ts:1608)）。
- controlled 側の「値 → 最終受信 → 優先度」の判定は `SelectionReplacement.replaces()`（[packages/ice/src/nomination/selectionReplacement.ts:194](review-file:packages/ice/src/nomination/selectionReplacement.ts:194)）です。受けた指名を値にするのは `receivedNomination()`（[packages/ice/src/internal/checkMessages.ts:44](review-file:packages/ice/src/internal/checkMessages.ts:44)）です。
- consent check は、renomination では選択中のペアの値を運びます（`consentNomination()`、[packages/ice/src/ice.ts:1099](review-file:packages/ice/src/ice.ts:1099)）。semi-aggressive では `USE-CANDIDATE` を付けます（`shouldNominateConsentRequest()`、[packages/ice/src/ice.ts:1085](review-file:packages/ice/src/ice.ts:1085)）。
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
        after: ["checkIncoming(): " + pill("WAITING", "rn-good") + " なので triggered check", "成功 → remoteNominated && controlled → nominated", "SelectionReplacement.replaces() → 選択 = 高"],
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

- 分かれ目はステップ 2 です。check の打ち切り経路から `checkCancelled()` を呼ぶようにしました（[packages/ice/src/ice.ts:1655](review-file:packages/ice/src/ice.ts:1655)、本体は [packages/ice/src/ice.ts:1786](review-file:packages/ice/src/ice.ts:1786)）。
- 対象は live checklist にある In-Progress のペアだけです。restart / close で世代が終わった場合と、checklist から外れたペアは対象外です。
- ステップ 3 で triggered check の対象になるのは `WAITING` と `FAILED` だけです（[packages/ice/src/ice.ts:2193](review-file:packages/ice/src/ice.ts:2193)）。Before ではここで止まっていました。
- 回帰テスト:
  - 実ソケット 2 件（semi-aggressive / renomination）: [packages/ice/tests/ice/semi-aggressive.test.ts:705](review-file:packages/ice/tests/ice/semi-aggressive.test.ts:705)。準備処理は `createDelayedPreferredPathPair()`（[packages/ice/tests/utils.ts:2953](review-file:packages/ice/tests/utils.ts:2953)）です。TURN relay のペアで接続させ、host ↔ host ペアの request を両端で止めておき、接続後に通します。
  - controlled の単体テスト 2 件: [packages/ice/tests/ice/semi-aggressive.test.ts:455](review-file:packages/ice/tests/ice/semi-aggressive.test.ts:455) と [packages/ice/tests/ice/semi-aggressive.test.ts:482](review-file:packages/ice/tests/ice/semi-aggressive.test.ts:482)。

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

- 実装は `RegularNomination`（[packages/ice/src/nomination/regularNomination.ts:186](review-file:packages/ice/src/nomination/regularNomination.ts:186)）と判定関数 `decideNomination`（[packages/ice/src/nomination/regularNomination.ts:59](review-file:packages/ice/src/nomination/regularNomination.ts:59)）です。live と provisional（pranswer の ICE restart、`ProvisionalChecklist`）で共有しています。
- 応答がなければ同じペアに計 3 回まで送ります（`NOMINATION_ATTEMPTS`、[packages/ice/src/nomination/regularNomination.ts:15](review-file:packages/ice/src/nomination/regularNomination.ts:15)）。届かなければ他のペアは指名せず、`connect()` を reject して `failed` にします。相手が受理済みかもしれないペアの後に別のペアを指名すると、両端の経路が食い違うためです。
- 既定にしなかった理由は接続時間です。前々回のラウンドで、ループバックで計測しました（各 10 回の中央値。RTT 50 ms は UDP 送信に片道 25 ms の遅延を注入したもので、実ネットワークの計測ではありません）。

| 条件 | develop（aggressive） | regular nomination |
| --- | --- | --- |
| RTT ≈ 0、EOC あり | 21 ms | 21 ms |
| RTT ≈ 0、EOC なし | 21 ms | 306 ms |
| RTT 50 ms、EOC あり（controlling） | 53 ms | 104 ms |
| RTT 50 ms、EOC なし（controlling） | 62 ms | 410 ms |

既定の semi-aggressive は「最初の成功で即選択」なので、接続完了までの流れは develop と同じです（この表の再計測はしていません）。

### 2.7 選択後に失敗した上位ペアを再 check する

semi-aggressive と renomination では、選択後も「選択ペアより優先度が高いペア」の check を続けます。そのペアが一度失敗すると、これまでは二度と check されませんでした。接続した瞬間だけ経路が途切れていた場合（例: 相手の check も失敗していて、相手から triggered check が来ない場合）に、回復した高優先度の経路へ移れなくなります。libwebrtc は接続に 30 秒間何も届かなくなるまで ping を続けるので、同じ性質に合わせました。

<div style="display:flex;gap:12px;flex-wrap:wrap;font-family:var(--review-font)">
  <div style="flex:1;min-width:250px;padding:10px 12px;border:1px solid var(--review-border);border-left:5px solid var(--review-danger);border-radius:6px">
    <strong>Before</strong>
    <ol style="margin:6px 0 0;padding-left:18px">
      <li>低優先度ペアで接続（選択）</li>
      <li>高優先度ペアの <code>checkStart()</code> が無応答で FAILED</li>
      <li style="color:var(--review-danger)">経路が回復しても、再 check されない</li>
      <li style="color:var(--review-danger)">相手から check が来なければ、低い経路に残る</li>
    </ol>
  </div>
  <div style="flex:1;min-width:250px;padding:10px 12px;border:1px solid var(--review-border);border-left:5px solid var(--review-success);border-radius:6px">
    <strong>After</strong>
    <ol style="margin:6px 0 0;padding-left:18px">
      <li>低優先度ペアで接続（選択）</li>
      <li>高優先度ペアの <code>checkStart()</code> が無応答で FAILED</li>
      <li style="color:var(--review-success)"><code>SelectionReplacement.scheduleRetries()</code> が 1 s 後に再 check</li>
      <li style="color:var(--review-success)">失敗するたびに 2・4・8・16 s 後に再試行（合計約 31 s）</li>
      <li style="color:var(--review-success)">成功したら <code>SelectionReplacement.replaces()</code> の判定で選択を置き換える</li>
    </ol>
  </div>
</div>
<div style="font-size:12px;color:var(--review-muted);margin-top:4px">Before / After とも、同じ「高優先度ペアの最初の check が失敗した」状態から始めています。</div>

- 遅延は [packages/ice/src/nomination/selectionReplacement.ts:17](review-file:packages/ice/src/nomination/selectionReplacement.ts:17) の `OUTRANKING_RETRY_DELAYS_MS`（1・2・4・8・16 s）です（分割で `nomination/selectionReplacement.ts` に移しました）。5 回の再試行で終わります。
- 再試行を予約するのは [packages/ice/src/nomination/selectionReplacement.ts:105](review-file:packages/ice/src/nomination/selectionReplacement.ts:105) の `SelectionReplacement.scheduleRetries()` です。controlling で semi-aggressive または renomination のときだけ働きます。ペアごとに同時に待つ再試行は 1 つで、[packages/ice/src/nomination/selectionReplacement.ts:148](review-file:packages/ice/src/nomination/selectionReplacement.ts:148) の `retryOutrankingPair()` が実行時にもう一度条件（restart していない、ペアが checklist にある、まだ選択を上回る、など）を確かめます。
- ペアが成功したら `forgetRetry()` で打ち切り、restart・close・ロール変更では `clearRetries()` が保留中のタイマーをすべて解除します。
- 選択を上回らない失敗ペアは再 check しません。regular nomination にも影響しません。
- テストは [packages/ice/tests/ice/semi-aggressive.test.ts:546](review-file:packages/ice/tests/ice/semi-aggressive.test.ts:546)（semi-aggressive）、[packages/ice/tests/ice/semi-aggressive.test.ts:569](review-file:packages/ice/tests/ice/semi-aggressive.test.ts:569)（renomination）、[packages/ice/tests/ice/semi-aggressive.test.ts:589](review-file:packages/ice/tests/ice/semi-aggressive.test.ts:589)（1・2・4・8・16 s の間隔と 5 回で停止）、[packages/ice/tests/ice/semi-aggressive.test.ts:614](review-file:packages/ice/tests/ice/semi-aggressive.test.ts:614)（上回らないペアは対象外）、[packages/ice/tests/ice/semi-aggressive.test.ts:638](review-file:packages/ice/tests/ice/semi-aggressive.test.ts:638)（close とロール変更で停止）です。

## 3. `ice.ts` のモジュール分割（リファクタリング）

**何をしたか。** 4,168 行あった `packages/ice/src/ice.ts` を、責務ごとに 6 つのファイルへ分けました。`Connection` には、公開 API・ライフサイクル（restart / close / 状態）・socket のイベント処理・live checklist の中核（`connect` / `checkStart` / `checkComplete` / `checkIncoming`）だけを残しています（2,339 行）。

**挙動は変えていません。** 公開 API は同じで、`npm run doc` の生成物にも差分はありません。テストの件数と結果も分割前と同じです（7 章）。

### 3.1 構造: 1 クラスに全部 → 中核 + 協調クラス

<div style="font-family:var(--review-font);color:var(--review-fg)">
<div style="font-weight:bold;margin:4px 0;color:var(--review-danger)">Before: <code>ice.ts</code> 1 ファイル（4,168 行）</div>
<svg viewBox="0 0 760 150" width="100%" role="img" aria-label="Before: すべての責務が ice.ts の Connection 1 クラスにある">
  <rect x="6" y="8" width="748" height="136" rx="8" fill="none" stroke="var(--review-danger)" stroke-width="2"/>
  <text x="18" y="28" font-size="12" font-weight="bold" fill="var(--review-fg)">class Connection（+ ファイル末尾の RegularNomination / decideNomination / 補助関数）</text>
  <g font-size="11" text-anchor="middle">
    <rect x="18" y="40" width="300" height="56" rx="4" fill="none" stroke="var(--review-border)"/>
    <text x="168" y="62" fill="var(--review-fg)" font-weight="bold">中核（残す）</text>
    <text x="168" y="80" fill="var(--review-muted)">API・ライフサイクル・live checklist</text>
    <rect x="322" y="40" width="104" height="56" rx="4" fill="none" stroke="var(--review-accent)" stroke-dasharray="4 3"/>
    <text x="374" y="62" fill="var(--review-accent)" font-weight="bold">候補収集</text>
    <text x="374" y="80" fill="var(--review-muted)">約 600 行</text>
    <rect x="430" y="40" width="86" height="56" rx="4" fill="none" stroke="var(--review-accent)" stroke-dasharray="4 3"/>
    <text x="473" y="62" fill="var(--review-accent)" font-weight="bold">pranswer</text>
    <text x="473" y="80" fill="var(--review-muted)">約 500 行</text>
    <rect x="520" y="40" width="78" height="56" rx="4" fill="none" stroke="var(--review-accent)" stroke-dasharray="4 3"/>
    <text x="559" y="62" fill="var(--review-accent)" font-weight="bold">置き換え</text>
    <text x="559" y="80" fill="var(--review-muted)">約 450 行</text>
    <rect x="602" y="40" width="74" height="56" rx="4" fill="none" stroke="var(--review-accent)" stroke-dasharray="4 3"/>
    <text x="639" y="62" fill="var(--review-accent)" font-weight="bold">regular</text>
    <text x="639" y="80" fill="var(--review-muted)">約 420 行</text>
    <rect x="680" y="40" width="64" height="56" rx="4" fill="none" stroke="var(--review-accent)" stroke-dasharray="4 3"/>
    <text x="712" y="62" fill="var(--review-accent)" font-weight="bold">consent</text>
    <text x="712" y="80" fill="var(--review-muted)">約 280 行</text>
  </g>
  <text x="18" y="118" font-size="11" fill="var(--review-danger)">すべてが <tspan font-family="var(--review-mono)">this.xxx</tspan> の private フィールド・メソッドで、互いの状態を直接読み書きしている</text>
  <text x="18" y="134" font-size="11" fill="var(--review-muted)">点線の枠 = 分割で外へ出した責務</text>
</svg>

<div style="font-weight:bold;margin:12px 0 4px;color:var(--review-success)">After: 中核 + 6 ファイル（呼び出しは host オブジェクト経由）</div>
<svg viewBox="0 0 760 330" width="100%" role="img" aria-label="After: Connection が協調クラスを呼び、協調クラスは host オブジェクト経由で Connection に戻る">
  <rect x="250" y="120" width="260" height="96" rx="8" fill="none" stroke="var(--review-fg)" stroke-width="2"/>
  <text x="380" y="144" font-size="13" text-anchor="middle" font-weight="bold" fill="var(--review-fg)">Connection（ice.ts, 2,339 行）</text>
  <text x="380" y="164" font-size="11" text-anchor="middle" fill="var(--review-muted)">公開 API・restart / close / 状態</text>
  <text x="380" y="180" font-size="11" text-anchor="middle" fill="var(--review-muted)">ensureProtocol（socket のイベント）</text>
  <text x="380" y="196" font-size="11" text-anchor="middle" fill="var(--review-muted)">connect / checkStart / checkComplete / checkIncoming</text>
  <g font-size="11" text-anchor="middle">
    <rect x="10" y="12" width="220" height="62" rx="6" fill="none" stroke="var(--review-accent)" stroke-width="2"/>
    <text x="120" y="32" font-weight="bold" fill="var(--review-accent)">CandidateGatherer</text>
    <text x="120" y="48" fill="var(--review-fg)">candidateGatherer.ts（483 行）</text>
    <text x="120" y="64" fill="var(--review-muted)">host / srflx / relay の収集</text>
    <rect x="270" y="12" width="220" height="62" rx="6" fill="none" stroke="var(--review-accent)" stroke-width="2"/>
    <text x="380" y="32" font-weight="bold" fill="var(--review-accent)">ConsentFreshness</text>
    <text x="380" y="48" fill="var(--review-fg)">consent.ts（285 行）</text>
    <text x="380" y="64" fill="var(--review-muted)">RFC 7675 の consent</text>
    <rect x="530" y="12" width="220" height="62" rx="6" fill="none" stroke="var(--review-accent)" stroke-width="2"/>
    <text x="640" y="32" font-weight="bold" fill="var(--review-accent)">ProvisionalChecklist</text>
    <text x="640" y="48" fill="var(--review-fg)">provisional.ts（636 行）</text>
    <text x="640" y="64" fill="var(--review-muted)">pranswer の ICE restart の checklist</text>
    <rect x="10" y="258" width="220" height="62" rx="6" fill="none" stroke="var(--review-accent)" stroke-width="2"/>
    <text x="120" y="278" font-weight="bold" fill="var(--review-accent)">SelectionReplacement</text>
    <text x="120" y="294" fill="var(--review-fg)">nomination/selectionReplacement.ts（365 行）</text>
    <text x="120" y="310" fill="var(--review-muted)">semi-aggressive / renomination の置き換え</text>
    <rect x="270" y="258" width="220" height="62" rx="6" fill="none" stroke="var(--review-accent)" stroke-width="2"/>
    <text x="380" y="278" font-weight="bold" fill="var(--review-accent)">RegularNomination</text>
    <text x="380" y="294" fill="var(--review-fg)">nomination/regularNomination.ts（399 行）</text>
    <text x="380" y="310" fill="var(--review-muted)">regular nomination（移動のみ）</text>
    <rect x="530" y="258" width="220" height="62" rx="6" fill="none" stroke="var(--review-border)" stroke-width="2"/>
    <text x="640" y="278" font-weight="bold" fill="var(--review-fg)">buildCheckRequest など</text>
    <text x="640" y="294" fill="var(--review-fg)">internal/checkMessages.ts（97 行）</text>
    <text x="640" y="310" fill="var(--review-muted)">check の組み立て・読み取り（純関数）</text>
  </g>
  <g stroke="var(--review-success)" stroke-width="2" fill="none">
    <line x1="300" y1="120" x2="150" y2="76"/><polyline points="160,74 150,76 156,84"/>
    <line x1="380" y1="120" x2="380" y2="76"/><polyline points="375,84 380,76 385,84"/>
    <line x1="460" y1="120" x2="610" y2="76"/><polyline points="600,74 610,76 604,84"/>
    <line x1="300" y1="216" x2="150" y2="256"/><polyline points="156,248 150,256 160,258"/>
    <line x1="380" y1="216" x2="380" y2="256"/><polyline points="375,248 380,256 385,248"/>
    <line x1="460" y1="216" x2="610" y2="256"/><polyline points="604,248 610,256 600,258"/>
  </g>
  <g stroke="var(--review-warning)" stroke-width="1.5" fill="none" stroke-dasharray="5 3">
    <line x1="170" y1="76" x2="320" y2="118"/>
    <line x1="400" y1="76" x2="400" y2="118"/>
    <line x1="590" y1="76" x2="440" y2="118"/>
    <line x1="170" y1="256" x2="320" y2="218"/>
    <line x1="400" y1="256" x2="400" y2="218"/>
  </g>
  <g font-size="10" fill="var(--review-warning)">
    <text x="196" y="112">host.appendLocalCandidate など</text>
    <text x="404" y="104">host.setState など</text>
    <text x="500" y="112">host.buildRequest など</text>
    <text x="150" y="234">host.check / host.complete</text>
    <text x="404" y="242">host.send など</text>
  </g>
</svg>
<div style="font-size:12px;color:var(--review-muted);margin-top:4px">凡例: <span style="color:var(--review-success)">緑の実線 = Connection からの呼び出し</span> / <span style="color:var(--review-warning)">黄の点線 = 協調クラスから host オブジェクト経由で Connection へ戻る呼び出し</span> / <span style="color:var(--review-accent)">アクセントの枠 = 分割で外へ出したクラス</span>。<code>checkMessages.ts</code> は状態を持たない関数なので、戻りの線はありません。</div>
</div>

要点:

- 分け方は、既存の `RegularNomination` + `NominationHost`（[packages/ice/src/nomination/regularNomination.ts:133](review-file:packages/ice/src/nomination/regularNomination.ts:133)）と同じ形にそろえました。協調クラスは、必要な状態と操作だけを関数として持つ「host オブジェクト」をコンストラクタで受け取ります。`Connection` の private フィールドを直接読むことはありません。
- host の型はファイルの先頭にあります: `GatherHost`（[packages/ice/src/candidateGatherer.ts:18](review-file:packages/ice/src/candidateGatherer.ts:18)）、`ConsentHost`（[packages/ice/src/consent.ts:16](review-file:packages/ice/src/consent.ts:16)）、`ProvisionalHost`（[packages/ice/src/provisional.ts:62](review-file:packages/ice/src/provisional.ts:62)）、`SelectionHost`（[packages/ice/src/nomination/selectionReplacement.ts:22](review-file:packages/ice/src/nomination/selectionReplacement.ts:22)）。
- `Connection` 側で host を組み立てている箇所: `selection`（[packages/ice/src/ice.ts:146](review-file:packages/ice/src/ice.ts:146)）、`consent`（[packages/ice/src/ice.ts:223](review-file:packages/ice/src/ice.ts:223)）、`provisionalChecklist`（[packages/ice/src/ice.ts:242](review-file:packages/ice/src/ice.ts:242)）、`gatherer`（[packages/ice/src/ice.ts:266](review-file:packages/ice/src/ice.ts:266)）。
- どの責務がどのファイルにあるかは、`Connection` の直前のコメントにまとめました（[packages/ice/src/ice.ts:64](review-file:packages/ice/src/ice.ts:64)）。

### 3.2 処理の流れ: 同じ入口から見た Before / After

同じ入口（左端）から呼ばれる処理が、分割の前後でどこを通るかを並べました。左右は同じ入口・同じ順序で、違いは呼び出し先のファイルだけです。

<style>
  .rf-flow { font-family: var(--review-font); color: var(--review-fg); width: 100%; border-collapse: collapse; font-size: 12px; }
  .rf-flow th, .rf-flow td { border: 1px solid var(--review-border); padding: 6px; vertical-align: top; }
  .rf-flow th { background: var(--review-surface); text-align: left; }
  .rf-flow .rf-chain { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
  .rf-flow .rf-step { font-family: var(--review-mono); border: 1px solid var(--review-border); border-radius: 4px; padding: 1px 6px; white-space: nowrap; }
  .rf-flow .rf-self { color: var(--review-muted); }
  .rf-flow .rf-mod { border: 2px solid var(--review-accent); color: var(--review-accent); }
  .rf-flow .rf-back { border: 1px dashed var(--review-warning); color: var(--review-warning); }
  .rf-flow .rf-arrow { color: var(--review-muted); }
  .rf-flow .rf-file { display: block; font-size: 10px; color: var(--review-muted); font-family: var(--review-font); }
  .rf-flow tr:hover td { background: var(--review-surface); }
</style>

<table class="rf-flow">
  <thead><tr><th style="width:16%">入口</th><th style="width:38%">Before（すべて <code>ice.ts</code> の <code>this.*</code>）</th><th>After</th></tr></thead>
  <tbody>
    <tr>
      <td><b>候補の収集</b><br><code>gatherCandidates()</code></td>
      <td><div class="rf-chain"><span class="rf-step rf-self">this.getCandidatePromises</span><span class="rf-arrow">→</span><span class="rf-step rf-self">this.gatherRelayCandidate</span><span class="rf-arrow">→</span><span class="rf-step rf-self">this.appendLocalCandidate</span></div></td>
      <td><div class="rf-chain"><span class="rf-step rf-mod">gatherer.candidatePromises<span class="rf-file">candidateGatherer.ts</span></span><span class="rf-arrow">→</span><span class="rf-step rf-mod">gatherRelayCandidate<span class="rf-file">candidateGatherer.ts</span></span><span class="rf-arrow">⇢</span><span class="rf-step rf-back">host.appendLocalCandidate<span class="rf-file">↩ Connection</span></span></div></td>
    </tr>
    <tr>
      <td><b>check が成功して選択</b><br><code>checkStart()</code> → <code>checkComplete()</code></td>
      <td><div class="rf-chain"><span class="rf-step rf-self">this.queryConsent</span><span class="rf-arrow">·</span><span class="rf-step rf-self">this.evaluateSelection</span><span class="rf-arrow">·</span><span class="rf-step rf-self">this.checkOutrankingPairs</span><span class="rf-arrow">·</span><span class="rf-step rf-self">this.scheduleOutrankingRetries</span></div></td>
      <td><div class="rf-chain"><span class="rf-step rf-mod">consent.start<span class="rf-file">consent.ts</span></span><span class="rf-arrow">·</span><span class="rf-step rf-mod">selection.evaluate<span class="rf-file">selectionReplacement.ts</span></span><span class="rf-arrow">·</span><span class="rf-step rf-mod">selection.checkOutrankingPairs</span><span class="rf-arrow">·</span><span class="rf-step rf-mod">selection.scheduleRetries</span><span class="rf-arrow">⇢</span><span class="rf-step rf-back">host.check / host.complete<span class="rf-file">↩ checkStart / checkComplete</span></span></div></td>
    </tr>
    <tr>
      <td><b>データ受信（controlled）</b><br><code>protocol.onDataReceived</code></td>
      <td><div class="rf-chain"><span class="rf-step rf-self">this.controlledDataReceived</span><span class="rf-arrow">→</span><span class="rf-step rf-self">this.replacesSelectedPair</span><span class="rf-arrow">→</span><span class="rf-step rf-self">this.checkComplete</span></div></td>
      <td><div class="rf-chain"><span class="rf-step rf-mod">selection.controlledDataReceived<span class="rf-file">selectionReplacement.ts</span></span><span class="rf-arrow">→</span><span class="rf-step rf-mod">replaces</span><span class="rf-arrow">⇢</span><span class="rf-step rf-back">host.complete<span class="rf-file">↩ checkComplete</span></span></div></td>
    </tr>
    <tr>
      <td><b>consent の送信と失効</b><br>選択の直後</td>
      <td><div class="rf-chain"><span class="rf-step rf-self">this.queryConsent</span><span class="rf-arrow">→</span><span class="rf-step rf-self">this.buildRequest</span><span class="rf-arrow">→</span><span class="rf-step rf-self">this.setState("failed")</span></div></td>
      <td><div class="rf-chain"><span class="rf-step rf-mod">consent.start<span class="rf-file">consent.ts</span></span><span class="rf-arrow">⇢</span><span class="rf-step rf-back">host.buildRequest<span class="rf-file">↩ Connection</span></span><span class="rf-arrow">⇢</span><span class="rf-step rf-back">host.setState("failed")<span class="rf-file">↩ Connection</span></span></div></td>
    </tr>
    <tr>
      <td><b>pranswer の ICE restart</b><br><code>stageLocalCredentials()</code> ほか</td>
      <td><div class="rf-chain"><span class="rf-step rf-self">this.tryProvisionalPair</span><span class="rf-arrow">→</span><span class="rf-step rf-self">this.checkProvisional</span><span class="rf-arrow">→</span><span class="rf-step rf-self">this.nominateProvisional</span></div></td>
      <td><div class="rf-chain"><span class="rf-step">公開メソッドは Connection に残して委譲</span><span class="rf-arrow">→</span><span class="rf-step rf-mod">provisionalChecklist.stage / start<span class="rf-file">provisional.ts</span></span><span class="rf-arrow">→</span><span class="rf-step rf-mod">tryPair → check → nominate</span></div></td>
    </tr>
    <tr>
      <td><b>受信 check の振り分け</b><br><code>checkIncoming()</code></td>
      <td><div class="rf-chain"><span class="rf-step rf-self">this.checkIncomingProvisional</span><span class="rf-arrow">·</span><span class="rf-step rf-self">this.receivedNomination</span></div></td>
      <td><div class="rf-chain"><span class="rf-step rf-mod">provisionalChecklist.checkIncoming<span class="rf-file">provisional.ts</span></span><span class="rf-arrow">·</span><span class="rf-step rf-mod">receivedNomination<span class="rf-file">internal/checkMessages.ts</span></span></div></td>
    </tr>
    <tr>
      <td><b>check の組み立て</b><br>live・pranswer・consent</td>
      <td><div class="rf-chain"><span class="rf-step rf-self">this.buildRequest</span><span class="rf-arrow">（Message をその場で組み立て）</span></div></td>
      <td><div class="rf-chain"><span class="rf-step">this.buildRequest（1 行）</span><span class="rf-arrow">→</span><span class="rf-step rf-mod">buildCheckRequest<span class="rf-file">internal/checkMessages.ts</span></span></div></td>
    </tr>
  </tbody>
</table>
<div style="font-size:12px;color:var(--review-muted);margin-top:4px">凡例: <span style="color:var(--review-muted)">灰 = Connection 内の呼び出し</span> / <span style="color:var(--review-accent)">アクセントの太枠 = 分割で外へ出したクラス・関数</span> / <span style="color:var(--review-warning)">黄の点線枠 ⇢ = host オブジェクト経由で Connection に戻る呼び出し</span>。「·」は同じ箇所から続けて呼ぶもの。</div>

### 3.3 例: データ受信で選択が移るまで（2.3 の流れ）

1 つの流れを、呼び出しの往復まで含めて並べます。上下は同じ入力（controlled 側で、指名済みの別のペアにデータが届く）・同じ段の配置です。

<div style="font-family:var(--review-font);color:var(--review-fg)">
<div style="font-weight:bold;margin:4px 0;color:var(--review-muted)">Before: Connection の中の自己呼び出し</div>
<svg viewBox="0 0 760 200" width="100%" role="img" aria-label="Before: データ受信からの判定と consent の再開がすべて Connection の自己呼び出し">
  <g stroke="var(--review-border)" stroke-width="1.5"><line x1="90" y1="30" x2="90" y2="195"/><line x1="330" y1="30" x2="330" y2="195"/></g>
  <g font-size="12" text-anchor="middle" font-weight="bold" fill="var(--review-fg)"><text x="90" y="20">Protocol</text><text x="330" y="20">Connection（ice.ts）</text></g>
  <g stroke="var(--review-muted)" stroke-width="1.5" fill="none"><line x1="90" y1="50" x2="325" y2="50"/><polyline points="317,45 325,50 317,55"/></g>
  <text x="210" y="44" font-size="11" text-anchor="middle" fill="var(--review-fg)">onDataReceived(data, addr)</text>
  <g stroke="var(--review-muted)" stroke-width="1.5" fill="none">
    <path d="M330 72 h40 v16 h-35"/><polyline points="343,83 335,88 343,93"/>
    <path d="M330 104 h40 v16 h-35"/><polyline points="343,115 335,120 343,125"/>
    <path d="M330 136 h40 v16 h-35"/><polyline points="343,147 335,152 343,157"/>
    <path d="M330 168 h40 v16 h-35"/><polyline points="343,179 335,184 343,189"/>
  </g>
  <g font-size="11" fill="var(--review-fg)">
    <text x="380" y="84">① this.controlledDataReceived(): 受信を記録</text>
    <text x="380" y="116">② this.replacesSelectedPair(): 値 → 最終受信 → 優先度</text>
    <text x="380" y="148">③ this.checkComplete(): nominated を置き換え</text>
    <text x="380" y="180">④ this.queryConsent(): 新しいペアで consent を再開</text>
  </g>
</svg>

<div style="font-weight:bold;margin:12px 0 4px;color:var(--review-success)">After: 責務ごとのクラスを往復</div>
<svg viewBox="0 0 760 200" width="100%" role="img" aria-label="After: SelectionReplacement が判定し、host.complete で Connection に戻り、ConsentFreshness が consent を再開する">
  <g stroke="var(--review-border)" stroke-width="1.5"><line x1="90" y1="30" x2="90" y2="195"/><line x1="290" y1="30" x2="290" y2="195"/><line x1="490" y1="30" x2="490" y2="195"/><line x1="680" y1="30" x2="680" y2="195"/></g>
  <g font-size="12" text-anchor="middle" font-weight="bold"><text x="90" y="20" fill="var(--review-fg)">Protocol</text><text x="290" y="20" fill="var(--review-fg)">Connection</text><text x="490" y="20" fill="var(--review-accent)">SelectionReplacement</text><text x="680" y="20" fill="var(--review-accent)">ConsentFreshness</text></g>
  <g stroke="var(--review-muted)" stroke-width="1.5" fill="none"><line x1="90" y1="50" x2="285" y2="50"/><polyline points="277,45 285,50 277,55"/></g>
  <text x="190" y="44" font-size="11" text-anchor="middle" fill="var(--review-fg)">onDataReceived(data, addr)</text>
  <g stroke="var(--review-success)" stroke-width="2" fill="none"><line x1="290" y1="84" x2="485" y2="84"/><polyline points="477,79 485,84 477,89"/></g>
  <text x="390" y="78" font-size="11" text-anchor="middle" fill="var(--review-success)">① controlledDataReceived()</text>
  <g stroke="var(--review-accent)" stroke-width="1.5" fill="none"><path d="M490 100 h40 v16 h-35"/><polyline points="503,111 495,116 503,121"/></g>
  <text x="536" y="112" font-size="11" fill="var(--review-accent)">② replaces(): 値 → 最終受信 → 優先度</text>
  <g stroke="var(--review-warning)" stroke-width="1.5" fill="none" stroke-dasharray="5 3"><line x1="490" y1="148" x2="295" y2="148"/><polyline points="303,143 295,148 303,153"/></g>
  <text x="390" y="142" font-size="11" text-anchor="middle" fill="var(--review-warning)">③ host.complete(pair) → checkComplete()</text>
  <g stroke="var(--review-success)" stroke-width="2" fill="none"><line x1="290" y1="180" x2="675" y2="180"/><polyline points="667,175 675,180 667,185"/></g>
  <text x="480" y="174" font-size="11" text-anchor="middle" fill="var(--review-success)">④ consent.start(): 新しいペアで consent を再開</text>
</svg>
<div style="font-size:12px;color:var(--review-muted);margin-top:4px">凡例: <span style="color:var(--review-success)">緑 = Connection からの呼び出し</span> / <span style="color:var(--review-warning)">黄の点線 = host 経由で Connection に戻る呼び出し</span> / <span style="color:var(--review-accent)">アクセント = 協調クラスの中の処理</span>。① 〜 ④ の順序と判定の中身は Before と同じです。</div>
</div>

- 入口は `ensureProtocol()` の受信の購読です（[packages/ice/src/ice.ts:869](review-file:packages/ice/src/ice.ts:869)）。判定は [packages/ice/src/nomination/selectionReplacement.ts:225](review-file:packages/ice/src/nomination/selectionReplacement.ts:225) と [packages/ice/src/nomination/selectionReplacement.ts:194](review-file:packages/ice/src/nomination/selectionReplacement.ts:194)、置き換えは `checkComplete()`（[packages/ice/src/ice.ts:1448](review-file:packages/ice/src/ice.ts:1448)）、consent の再開は [packages/ice/src/ice.ts:1469](review-file:packages/ice/src/ice.ts:1469) → [packages/ice/src/consent.ts:95](review-file:packages/ice/src/consent.ts:95) です。

### 3.4 名前の対応表（差分を読むとき用）

| 分割前（`ice.ts` の `Connection`） | 分割後 |
| --- | --- |
| `getCandidatePromises()` / `gatherRelayCandidate()` / `reflexiveBySocket` | `CandidateGatherer.candidatePromises()`（[packages/ice/src/candidateGatherer.ts:69](review-file:packages/ice/src/candidateGatherer.ts:69)）/ `gatherRelayCandidate()` / `reflexiveOf()` |
| `queryConsent()` / `stopConsentLifecycle()` / `consentFresh` / `consentSessionId` | `ConsentFreshness.start()` / `stop()` / `fresh` / `sessionId`（`connection.consent`） |
| `stageLocalCredentials()` などの内部 / `checkProvisional()` / `nominateProvisional()` / `checkIncomingProvisional()` / `allowsProvisional()` / `endProvisional()` | `ProvisionalChecklist.stage()` / `check()` / `nominate()` / `checkIncoming()` / `allows()` / `end()`（[packages/ice/src/provisional.ts:105](review-file:packages/ice/src/provisional.ts:105)） |
| `replacesSelectedPair()` / `evaluateSelection()` / `checkOutrankingPairs()` / `scheduleOutrankingRetries()` / `forgetOutrankingRetry()` / `clearOutrankingRetries()` / `controlledDataReceived()` / `dataReceived` | `SelectionReplacement.replaces()` / `evaluate()` / `checkOutrankingPairs()` / `scheduleRetries()` / `forgetRetry()` / `clearRetries()` / `controlledDataReceived()` / `lastData`（`connection.selection`） |
| ファイル末尾の `RegularNomination` / `decideNomination` / `NominationHost` など | そのまま `nomination/regularNomination.ts` へ移動（[packages/ice/src/nomination/regularNomination.ts:186](review-file:packages/ice/src/nomination/regularNomination.ts:186)） |
| `buildRequest()` の本体 / `receivedNomination()` / `encodeTxUsername` などの補助関数 | `buildCheckRequest()`（[packages/ice/src/internal/checkMessages.ts:67](review-file:packages/ice/src/internal/checkMessages.ts:67)）/ `receivedNomination()`（[packages/ice/src/internal/checkMessages.ts:44](review-file:packages/ice/src/internal/checkMessages.ts:44)） |

### 3.5 変わらないもの・気をつける点

- **公開 API**: pranswer 系の公開メソッド（`stageLocalCredentials` / `setProvisionalRemoteParams` / `addProvisionalRemoteCandidate` / `startProvisionalChecks` / `provisionalNominated`）は `Connection` に残し、中身を `ProvisionalChecklist` に委譲しています（[packages/ice/src/ice.ts:499](review-file:packages/ice/src/ice.ts:499)）。`npm run doc` の生成物に差分はありません。
- **テスト**: テストケースは変えていません。private の内部に触れていたテスト用の入口だけを、移動先に合わせました。consent は `connection.consent.*`、pranswer の checklist は共通の補助関数 `provisionalChecklistOf()`（[packages/ice/tests/utils.ts:715](review-file:packages/ice/tests/utils.ts:715)）を使います。
- **debug ログの名前**: ファイルごとの名前空間になりました（例: `werift-ice : packages/ice/src/consent.ts : log`）。`DEBUG=werift-ice*` ならすべて出ますが、旧 `ice.ts` の名前を完全一致で指定していると、移したコードのログは出ません。
- **追いやすさの代わりに増えたもの**: host オブジェクトの組み立てが `Connection` のフィールド定義に 4 つ増えました。協調クラスは host に必要な関数を足さない限り `Connection` の状態に触れないので、変更の影響範囲は追いやすくなっています。

## 4. 主要変更（ファイル別）

### 4.1 公開 API とオプション

| 追加物 | 場所 |
| --- | --- |
| `IceOptions.nominationDelayMs` / `nomination` / `renomination` | [packages/ice/src/iceBase.ts:370](review-file:packages/ice/src/iceBase.ts:370)、[packages/ice/src/iceBase.ts:388](review-file:packages/ice/src/iceBase.ts:388)、[packages/ice/src/iceBase.ts:401](review-file:packages/ice/src/iceBase.ts:401) |
| `CandidatePair.remoteNomination` / `nomination` | [packages/ice/src/iceBase.ts:168](review-file:packages/ice/src/iceBase.ts:168) |
| `PeerConfig.iceNominationDelayMs` / `iceNomination` / `iceRenomination` | [packages/webrtc/src/api/peerConfig.ts:112](review-file:packages/webrtc/src/api/peerConfig.ts:112)、[packages/webrtc/src/api/peerConfig.ts:121](review-file:packages/webrtc/src/api/peerConfig.ts:121)、[packages/webrtc/src/api/peerConfig.ts:133](review-file:packages/webrtc/src/api/peerConfig.ts:133) |
| `RTCIceGatherer` への受け渡し | [packages/webrtc/src/secureTransportManager.ts:228](review-file:packages/webrtc/src/secureTransportManager.ts:228) |
| SDP の `a=ice-options:trickle renomination` 宣言 | [packages/webrtc/src/sdpManager.ts:63](review-file:packages/webrtc/src/sdpManager.ts:63) |
| 相手の `renomination` 宣言の読み取り（session / media） | [packages/webrtc/src/negotiation/remoteMediaApplication.ts:498](review-file:packages/webrtc/src/negotiation/remoteMediaApplication.ts:498) |
| `Protocol.onDataReceived` が受信元の `Address` も渡す（`Event<[Buffer, Address]>`） | [packages/ice/src/types/model.ts:52](review-file:packages/ice/src/types/model.ts:52) |
| `getSelectedCandidatePair()` は選択済みのペアだけを返す（R11） | [packages/webrtc/src/transport/ice.ts:641](review-file:packages/webrtc/src/transport/ice.ts:641) |

`iceRenomination` が既定の `false` なら、SDP は従来どおり `a=ice-options:trickle` だけです。

### 4.2 ペア優先度の計算修正（R1）

develop の `candidatePairPriority()` は `(1 << 32) * MIN + 2 * MAX + tie` でした。JavaScript の `1 << 32` は 32 bit のシフトなので **1** になり、RFC 8445 §6.1.2.3 では最優先のはずの MIN が効いていませんでした。「最良のペア」が正しく決まらないと、どの nomination 方式も意味がないため、この変更に含めました。

| ペア（G / D の候補 priority） | RFC の順序 | develop の値 | 結果 |
| --- | --- | --- | --- |
| A: srflx 1694498815 / srflx 1694498815 | **A が上**（MIN が大きい） | 5,083,496,445 | develop は B を上と判定（逆転） |
| B: host 2130706431 / srflx 1694498559 | B が下 | 5,955,911,422 | |

新設の `compareCandidatePairPriority()`（[packages/ice/src/iceBase.ts:568](review-file:packages/ice/src/iceBase.ts:568)）が MIN → MAX → tie-break の順に正確に比較します。`candidatePairPriority()` の値は統計用の近似値です。

### 4.3 ICE の中核（`packages/ice/src/` の各ファイル）

差分は大きいので、次の順に読むと追いやすいです（ファイルの構成は 3 章）。

1. 方式の判定（`ice.ts`）: [packages/ice/src/ice.ts:1835](review-file:packages/ice/src/ice.ts:1835)〜[packages/ice/src/ice.ts:1907](review-file:packages/ice/src/ice.ts:1907)
2. check の送信と USE-CANDIDATE の付与（`ice.ts`）: [packages/ice/src/ice.ts:1584](review-file:packages/ice/src/ice.ts:1584)
3. 選択と置き換え（`ice.ts`）: [packages/ice/src/ice.ts:1423](review-file:packages/ice/src/ice.ts:1423)
4. 選択の置き換え・上位ペアの check と再 check・同値の指名（`selectionReplacement.ts`）: [packages/ice/src/nomination/selectionReplacement.ts:194](review-file:packages/ice/src/nomination/selectionReplacement.ts:194)、[packages/ice/src/nomination/selectionReplacement.ts:316](review-file:packages/ice/src/nomination/selectionReplacement.ts:316)、[packages/ice/src/nomination/selectionReplacement.ts:105](review-file:packages/ice/src/nomination/selectionReplacement.ts:105)
5. 受信した check と指名（`ice.ts`）: [packages/ice/src/ice.ts:2116](review-file:packages/ice/src/ice.ts:2116)
6. ロール変更時の指名の無効化（R5）と、選択済みペアの再指名（R16）（`ice.ts`）: [packages/ice/src/ice.ts:1396](review-file:packages/ice/src/ice.ts:1396)、[packages/ice/src/ice.ts:1339](review-file:packages/ice/src/ice.ts:1339)
7. regular nomination（`regularNomination.ts`）: [packages/ice/src/nomination/regularNomination.ts:59](review-file:packages/ice/src/nomination/regularNomination.ts:59)、[packages/ice/src/nomination/regularNomination.ts:186](review-file:packages/ice/src/nomination/regularNomination.ts:186)
8. pranswer の ICE restart（`provisional.ts`）: [packages/ice/src/provisional.ts:105](review-file:packages/ice/src/provisional.ts:105)

`ice.ts` の差分は [packages/ice/src/ice.ts](review-diff:packages/ice/src/ice.ts:1786) から辿れます。新しいファイルは丸ごと追加なので、`review-file` で読むほうが速いです。

### 4.4 PBT oracle の調整（S10 の副作用への対応）

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
- 最新のコミットで、controlled 側が同じ指名の値のペア間をデータに従って移る場合も「ICE 自身による置き換え」に含めました（[packages/webrtc/tests/pbt/model/oracles.ts:867](review-diff:packages/webrtc/tests/pbt/model/oracles.ts:867)）。
- 変更箇所は [packages/webrtc/tests/pbt/model/oracles.ts:713](review-file:packages/webrtc/tests/pbt/model/oracles.ts:713) と [packages/webrtc/tests/pbt/model/oracles.ts:850](review-file:packages/webrtc/tests/pbt/model/oracles.ts:850) です。

### 4.5 CI 修正（SCTP のバースト計測テスト）

最新のコミット `1cce757fc` は、`npm run ci` で失敗した [packages/sctp/tests/burst.test.ts:35](review-diff:packages/sctp/tests/burst.test.ts:35) の調整です。ICE の変更とは無関係で、計測の揺らぎに対応しています。

- 2,000 件程度の小さいバーストは 1 件あたりの CPU 時間が大きいバーストの半分ほどしかなく、処理が線形でも比が 8 倍前後になっていました。
- 1 件あたりの時間が安定する 4,000 件と 16,000 件で比べ、各規模 2 回計測した最小値を使うようにしました。判定（8 倍未満）は変えていません。

### 4.6 Chrome との相互接続 E2E

[e2e/tests/ice/nomination.test.ts:134](review-file:e2e/tests/ice/nomination.test.ts:134)（handler: [e2e/server/handler/ice/nomination.ts:37](review-file:e2e/server/handler/ice/nomination.ts:37)）。

- 構成: werift は TURN/UDP を使い、自分からは relay ペアだけを check します。ブラウザには werift の host 候補を保留しておくので、最初は relay ↔ host の経路で両端がつながります。
- その後、保留していた host 候補を Chrome に渡します。両端の選択が同じ host ↔ host の経路に移り、データが届くことを確認します。
- 組み合わせ: Chrome / werift のどちらが offer（= controlling）か × renomination の有無の 4 通りです。renomination ありでは、Chrome のローカル SDP の `a=ice-options` に `renomination` を書き足します（Chrome には有効にする API がないため）。

## 5. 判断理由

- **既定を semi-aggressive にした**: regular nomination では、controlling 側の接続完了が少なくとも 1 RTT 遅れます（2.6 の表）。Chrome の既定が semi-aggressive なので、相互接続時の挙動もそろいます。
- **「aggressive で繋いでから再指名」を既定にしなかった**: RFC 8445 §8.1.1 は、ICE restart なしの再指名を認めていません。相手によっては最初の指名を使い続けるので（webrtc-rs、develop の werift）、両端の経路が食い違います。semi-aggressive は libwebrtc の実績ある挙動に合わせたものです。
- **ICE-TCP はどの方式でも regular**: TCP ペアは接続ごとに別なので、複数を指名すると pruning 後に両端が別の接続になるおそれがあります（#721 と同じ理由）。
- **renomination は両端の宣言が必要**: ドラフトの前提に合わせました。controlled 側は設定に関係なく NOMINATION を処理します（Chrome と同じ）。
- **S10 は Waiting に戻す方法にした**: RFC 8445 §7.3.1.4 では、In-Progress のペアに check が届いたら triggered check をやり直すとされています。打ち切った check を Waiting に戻せば、既存の triggered check の経路（Waiting / Failed が対象）をそのまま使えます。

## 6. リスクとレビューで確認してほしい点

- **既定の挙動の変更**: 「最初の成功ペアで固定」がなくなり、接続後に選択ペアが変わることがあります。選択ペアが変わらない前提の利用側がないか確認してください。
- **controlled 側の挙動の変更**: 相手が後から別のペアを指名すると、そのペアに移ります。1 回しか指名しない相手では変化はありません。
- **指名の応答が失われたときの一時的な食い違い**: semi-aggressive では、相手が受理したのに応答だけが失われると、両端の経路が一時的に食い違うことがあります。werift はどのペアで届いたデータも受け取るので、通信は続きます（libwebrtc と同じ性質）。
- **Chrome の renomination は SDP の書き換えに依存**: Chrome はこの書き換えを SDP munging（種類 28）として計測しており、将来拒否される可能性があります。E2E もこの書き換えに依存しています。
- **公開型の変更**: `Protocol.onDataReceived` が `Event<[Buffer, Address]>` になりました。独自の `Protocol` 実装を持つ利用側は、`execute(data, addr)` で受信元を渡す必要があります。内蔵の 5 つの実装（`StunProtocol` / `TcpActiveProtocol` / `TcpPassiveProtocol` / `TurnProtocol` / `StunOverTurnProtocol`）は対応済みで、`doc/` も再生成されています。
- **再 check のコスト**: 選択を上回る失敗ペアごとに、最大 5 回（約 31 秒）の check が増えます。ペア数が多い環境で、無駄な STUN トラフィックにならないか確認してください。
- **データによる選択の移動**: controlled 側は、指名済みで値が同じペアにデータが届くと選択を移します。相手が複数の経路へ同時にデータを送る場合に、選択が頻繁に動かないか確認してください。
- **`candidatePairPriority()` の値**: `MAX_SAFE_INTEGER` を超えることがあります。順序の比較には `compareCandidatePairPriority()` を使ってください。
- **oracle の緩和範囲**: 4.4 で許したのは「ICE 自身による置き換え」に当たる変化だけです。この範囲が妥当か確認してください。
- **チケット範囲を超える変更**: ペア優先度の修正、regular の再送・断念、487 の扱い、provisional の対応、`getSelectedCandidatePair()` の変更を含みます。いずれも changelog に書いています（[changelog.md](review-diff:changelog.md)）。

## 7. 検証結果

### 7.1 この文書の更新時に実行したもの（HEAD `b1b176c03`、develop を取り込んだ後）

作業ツリーに未コミットの変更はありません（この文書の更新前）。

| 内容 | 結果 |
| --- | --- |
| `npm run type` | 成功 |
| `cd packages/ice && npm test` | 48 ファイル成功・1 スキップ。521 件成功・5 件スキップ |
| webrtc `tests/transport/ice.test.ts` と `tests/pbt/model` | 2 ファイル成功。88 件成功・2 件スキップ |

### 7.2 モジュール分割（3 章）のときに実行したもの（コミット `c013a1207`）

| 内容 | 結果 |
| --- | --- |
| `npm run type` | 成功 |
| `cd packages/ice && npm test`（分割の各段階のあと毎回） | 521 件成功・5 件スキップ（分割前と同じ） |
| `npm run test:small` | 全パッケージ成功（webrtc 1728 件成功・5 件スキップ。分割前と同じ） |
| E2E 全体（Chrome、再試行なし） | 24 ファイル・71 件成功 |
| `npm run doc` | 生成物の差分なし（公開 API は不変） |

### 7.3 2.3 の同値の指名と 2.7 の再 check を入れたときに実行したもの

| 内容 | 結果 |
| --- | --- |
| `npm run test:small` | 全パッケージ成功（ICE 521 件成功・5 件スキップ） |
| 追加した実ソケットテスト 7 件の繰り返し | 10 回連続成功 |
| 検出力 | 2.3 の判定を外すと 3 件、2.7 の再試行を外すと 5 件が失敗 |
| E2E `tests/ice/nomination.test.ts`（Chrome、再試行なし） | 3 回連続で 4/4 成功 |
| E2E 全体（Chrome、再試行なし） | 24 ファイル・71 件成功 |
| leak property「a BUNDLE split merged again, then close」 | 10 回中失敗 0 |

### 7.4 それ以前に実行したもの

| 内容 | 結果 |
| --- | --- |
| S10 の検出力 | `checkCancelled()` を外すと S10 の 4 件すべて失敗、即時の再 check だけを外すと該当の 1 件が失敗 |
| leak property の比較（15 回ずつ） | 修正前 0/15、S10 のみ 5/15、oracle 調整後 0/15 |

### 7.5 実行していないもの

- `npm run wpt`、`npm run ci`（全体）、`npm run examples:e2e`
- develop を取り込んだ後（`b1b176c03`）の `npm run test:small` と E2E
- 2.6 の接続時間の表の再計測
