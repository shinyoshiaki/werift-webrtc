---
ide:
  viewer: review-document
  version: 1
  title: "DataChannel maxPacketLifeTime 修正と PR-SCTP 見直しのレビューガイド"
  dock: right
  baseCommit: 68038b1a24fd822a8acf39fad4650e21bcfa01cf
---
# DataChannel maxPacketLifeTime の修正と PR-SCTP 全体の見直し

## 1. 概要

チケット c49c9ef1 の本題は 1 行の単位ミスでした。DataChannel の `maxPacketLifeTime`（ミリ秒）を秒に直してから SCTP に渡し、SCTP 側も秒単位の時刻と比べていたため、寿命による破棄（PR-SCTP、RFC 3758）が一度も動いていませんでした。

単位を直すとこの経路が初めて動き出し、送信側・受信側に眠っていたバグが、レビューのたびに 1 件ずつ見つかりました。そこで途中から、指摘ごとに直す進め方をやめ、RFC 3758 / RFC 9260 に沿って全体を見直しました。あわせて、シード付き乱数でパケットを落とすテストを入れ、次の指摘を先に見つけられるようにしています。

<div style="display:flex;gap:12px;flex-wrap:wrap;font-family:var(--review-font)">
  <div style="flex:1;min-width:200px;padding:10px 14px;border:1px solid var(--review-border);border-left:4px solid var(--review-warning);border-radius:6px">
    <div style="color:var(--review-muted);font-size:12px">チケット状態</div>
    <div style="font-size:18px;font-weight:bold">未承認（レビュー上限 5/5）</div>
    <div style="font-size:12px;color:var(--review-muted)">最後の修正（撤回時のミス指示）はレビューが開始されず、まだ確認されていない</div>
  </div>
  <div style="flex:1;min-width:200px;padding:10px 14px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px">
    <div style="color:var(--review-muted);font-size:12px">テスト</div>
    <div style="font-size:18px;font-weight:bold">sctp 180 / webrtc 1590 通過</div>
    <div style="font-size:12px;color:var(--review-muted)">ランダム損失テスト 100 シードを常設（試行では 5000 シード以上）</div>
  </div>
  <div style="flex:1;min-width:200px;padding:10px 14px;border:1px solid var(--review-border);border-left:4px solid var(--review-accent);border-radius:6px">
    <div style="color:var(--review-muted);font-size:12px">変更規模（develop 比）</div>
    <div style="font-size:18px;font-weight:bold">12 ファイル / +1371 −43</div>
    <div style="font-size:12px;color:var(--review-muted)">本体は sctp.ts +270 行、残りの大半はテスト</div>
  </div>
</div>

## 2. 単位の修正（本題）

<div style="display:flex;gap:12px;flex-wrap:wrap;font-family:var(--review-font)">
  <div style="flex:1;min-width:260px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px">
    <strong>Before</strong>
    <pre style="font-family:var(--review-mono);font-size:12px;white-space:pre-wrap;margin:6px 0">// webrtc: ms → 秒にして渡す
expiry = (Date.now() + maxPacketLifeTime) / 1000
// sctp: 秒と比較
chunk.expiry &lt; Date.now() / 1000</pre>
    <span style="color:var(--review-muted);font-size:12px">しかも破棄対象を「送信キュー先頭の DATA」で探していたため、対象と別のチャンクを捨てていた</span>
  </div>
  <div style="flex:1;min-width:260px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px">
    <strong>After</strong>
    <pre style="font-family:var(--review-mono);font-size:12px;white-space:pre-wrap;margin:6px 0">// webrtc: epoch ms のまま渡す
expiry = Date.now() + maxPacketLifeTime
// sctp: epoch ms で比較
chunk.expiry &lt;= Date.now()</pre>
    <span style="color:var(--review-muted);font-size:12px">対象チャンク自身を見つけ、そのメッセージの断片だけを破棄する</span>
  </div>
</div>

呼び出し側の変更は [packages/webrtc/src/transport/sctp.ts:364](review-diff:packages/webrtc/src/transport/sctp.ts:364) です。`SCTP.send({ expiry })` の単位を TSDoc に明記し（[packages/sctp/src/sctp.ts:907](review-file:packages/sctp/src/sctp.ts:907)）、`changelog.md` では werift-sctp の Breaking change として記載しました。webrtc 側のテストは [packages/webrtc/tests/transport/sctp.test.ts:246](review-file:packages/webrtc/tests/transport/sctp.test.ts:246) です。

## 3. PR-SCTP の全体像と変更箇所

送信側は寿命切れを見つけるとメッセージ全体を「破棄済み」にし、FORWARD-TSN で受信側の累積 TSN を先へ進めます。下の図のオレンジ枠が今回手を入れた判断箇所です。

<svg viewBox="0 0 760 330" width="100%" role="img" aria-label="PR-SCTP の送信側と受信側の流れ" style="font-family:var(--review-font)">
  <defs><marker id="prs-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--review-muted)"/></marker></defs>
  <text x="180" y="18" text-anchor="middle" fill="var(--review-muted)" font-size="12">送信側（client）</text>
  <text x="600" y="18" text-anchor="middle" fill="var(--review-muted)" font-size="12">受信側（server）</text>
  <line x1="390" y1="10" x2="390" y2="320" stroke="var(--review-border)" stroke-dasharray="4 4"/>
  <g fill="var(--review-surface)" stroke-width="1.5">
    <rect x="20" y="30" width="320" height="40" rx="6" stroke="var(--review-warning)"/>
    <rect x="20" y="90" width="320" height="40" rx="6" stroke="var(--review-warning)"/>
    <rect x="20" y="150" width="320" height="40" rx="6" stroke="var(--review-warning)"/>
    <rect x="20" y="210" width="320" height="40" rx="6" stroke="var(--review-warning)"/>
    <rect x="20" y="270" width="320" height="40" rx="6" stroke="var(--review-warning)"/>
    <rect x="440" y="120" width="300" height="50" rx="6" stroke="var(--review-warning)"/>
    <rect x="440" y="210" width="300" height="50" rx="6" stroke="var(--review-warning)"/>
  </g>
  <g fill="var(--review-fg)" font-size="12">
    <text x="30" y="48">① outboundQueue → 初回送信の直前</text><text x="30" y="63" fill="var(--review-muted)">期限切れならメッセージごと破棄（送らない）</text>
    <text x="30" y="108">② 再送待ち → 再送の直前</text><text x="30" y="123" fill="var(--review-muted)">期限切れならメッセージごと破棄（再送しない）</text>
    <text x="30" y="168">③ T3 満了 / Fast Retransmit の判断</text><text x="30" y="183" fill="var(--review-muted)">gap ack 済みは対象外、撤回されたら未確認に戻す</text>
    <text x="30" y="228">④ 先頭の破棄済みを外し FORWARD-TSN</text><text x="30" y="243" fill="var(--review-muted)">相手の SACK が追いつくまで保持・T3 で再送</text>
    <text x="30" y="288">⑤ flightSize の勘定</text><text x="30" y="303" fill="var(--review-muted)">チャンクごとの inFlight で二重加減算を防ぐ</text>
    <text x="450" y="140">⑥ FORWARD-TSN 受信</text><text x="450" y="157" fill="var(--review-muted)">完全なメッセージは配送、不完全だけ破棄、SSN は後退しない</text>
    <text x="450" y="230">⑦ 再組み立て（popMessages）</text><text x="450" y="247" fill="var(--review-muted)">TSN が連続しない次メッセージ・順序なしも取りこぼさない</text>
  </g>
  <g stroke="var(--review-muted)" fill="none" marker-end="url(#prs-arr)">
    <path d="M340,230 C390,230 400,145 440,145"/>
    <path d="M740,170 C760,190 760,200 740,230" />
    <path d="M440,190 C400,190 380,170 340,170"/>
  </g>
  <g fill="var(--review-muted)" font-size="11">
    <text x="372" y="200">FORWARD-TSN</text><text x="395" y="183">SACK</text>
  </g>
</svg>

各箇所のコードは次のとおりです。

- ① 初回送信前の期限確認：[packages/sctp/src/sctp.ts:1073](review-diff:packages/sctp/src/sctp.ts:1073)
- ② 再送前の期限確認：[packages/sctp/src/sctp.ts:1041](review-diff:packages/sctp/src/sctp.ts:1041)。①と②で破棄が起きたら、[packages/sctp/src/sctp.ts:1104](review-diff:packages/sctp/src/sctp.ts:1104) で同じ送信処理の中から FORWARD-TSN を出す
- ③ T3 満了：[packages/sctp/src/sctp.ts:1255](review-diff:packages/sctp/src/sctp.ts:1255)。撤回（renege）の検出は [packages/sctp/src/sctp.ts:732](review-diff:packages/sctp/src/sctp.ts:732)、ミス指示の加算は [packages/sctp/src/sctp.ts:1448](review-diff:packages/sctp/src/sctp.ts:1448)
- メッセージ単位の破棄：[packages/sctp/src/sctp.ts:1431](review-diff:packages/sctp/src/sctp.ts:1431)（`maybeAbandon`）と [packages/sctp/src/sctp.ts:1465](review-diff:packages/sctp/src/sctp.ts:1465)（`abandonMessage`）
- ④ FORWARD-TSN の保持と再送：[packages/sctp/src/sctp.ts:1019](review-diff:packages/sctp/src/sctp.ts:1019)、[packages/sctp/src/sctp.ts:1390](review-diff:packages/sctp/src/sctp.ts:1390)、[packages/sctp/src/sctp.ts:1401](review-diff:packages/sctp/src/sctp.ts:1401)
- ⑤ flightSize：[packages/sctp/src/sctp.ts:1157](review-diff:packages/sctp/src/sctp.ts:1157)。チャンクの状態フィールド（`inFlight` / `reneged`）は [packages/sctp/src/chunk.ts:200](review-diff:packages/sctp/src/chunk.ts:200)
- ⑥ FORWARD-TSN 受信：[packages/sctp/src/sctp.ts:810](review-diff:packages/sctp/src/sctp.ts:810) と [packages/sctp/src/sctp.ts:1739](review-diff:packages/sctp/src/sctp.ts:1739)（`forwardSequenceNumber`）
- ⑦ 再組み立て：[packages/sctp/src/sctp.ts:1666](review-diff:packages/sctp/src/sctp.ts:1666)

## 4. 寿命切れから回復までの流れ（ステップ送り）

典型例として、A（寿命付き）が失われ、同じストリームの B は届いている場合の流れです。

<style>
  .prs-steps { font-family: var(--review-font); }
  .prs-steps button { border: 1px solid var(--review-border); background: var(--review-surface); color: var(--review-fg); padding: 3px 12px; border-radius: 4px; cursor: pointer; }
  .prs-steps ol { margin: 8px 0; padding-left: 22px; color: var(--review-muted); }
  .prs-steps li { margin: 4px 0; }
  .prs-steps li[aria-current="step"] { color: var(--review-fg); font-weight: bold; }
  .prs-steps .prs-note { margin: 6px 0 10px; padding: 8px 12px; border-left: 4px solid var(--review-accent); background: var(--review-surface); color: var(--review-fg); min-height: 2.6em; }
</style>

<div class="prs-steps">
  <ol>
    <li aria-current="step">送信側が A（寿命 100ms）と B を送る。A はネットワークで失われ、B は届く</li>
    <li>受信側は B を保持するが、順序付きのため A を待って配送しない。B は SACK のギャップで確認済みになる</li>
    <li>T3 満了。A は寿命切れなので破棄済みにする。B は確認済みなので再送も破棄もしない</li>
    <li>先頭の破棄済み A を送信キューから外し、FORWARD-TSN（累積 TSN = A）を送る</li>
    <li>受信側は累積 TSN を A まで進め、受信済みの B まで続けて進める。A の SSN を飛ばし、B を配送する</li>
    <li>SACK の累積 TSN が FORWARD-TSN に追いつくと、送信側は保持していた FORWARD-TSN を解放する</li>
  </ol>
  <div class="prs-note" id="prs-note"></div>
  <button data-dir="-1">前へ</button>
  <button data-dir="1">次へ</button>
</div>

<script>
  (() => {
    const notes = [
      "寿命は send() 時点の Date.now() + maxPacketLifeTime（epoch ms）で決まる。",
      "B の DataChunk は acked = true。送信中バイト数（flightSize）からも外れる。",
      "以前は B も再送対象にしていたため、flightSize に B が残り続けた（develop からのバグ）。",
      "FORWARD-TSN は SACK で確認されるまで保持する。失われたら T3 で再送する。",
      "以前は SSN 以下のチャンクを完全・不完全を問わず消していたため、B が消えていた。",
      "古いストリーム情報で期待 SSN が後退しないよう、uint16 の比較で前進時だけ更新する。",
    ];
    const root = document.querySelector(".prs-steps");
    const steps = [...root.querySelectorAll("li")];
    const note = root.querySelector("#prs-note");
    let current = 0;
    const render = () => {
      steps.forEach((s, i) => (i === current ? s.setAttribute("aria-current", "step") : s.removeAttribute("aria-current")));
      note.textContent = notes[current];
    };
    root.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        current = Math.min(steps.length - 1, Math.max(0, current + Number(b.dataset.dir)));
        render();
      }),
    );
    render();
  })();
</script>

## 5. レビューの経緯と見つかったバグ

指摘が承認と非承認を行き来していたため、途中で進め方を変えました。下の表は、どの回にどのバグが見つかり、それが今回の差分によるものか develop に元からあったものかの一覧です（クリックで並べ替えできます）。

<style>
  .prs-bugs { font-family: var(--review-font); border-collapse: collapse; width: 100%; font-size: 12px; }
  .prs-bugs th, .prs-bugs td { border: 1px solid var(--review-border); padding: 4px 8px; text-align: left; vertical-align: top; }
  .prs-bugs th { background: var(--review-surface); cursor: pointer; user-select: none; }
  .prs-bugs .own { color: var(--review-warning); }
  .prs-bugs .dev { color: var(--review-accent); }
</style>

<table class="prs-bugs">
  <thead><tr><th data-k="0">回</th><th data-k="1">見つかった問題</th><th data-k="2">由来</th><th data-k="3">対応</th></tr></thead>
  <tbody>
    <tr><td>0</td><td>maxPacketLifeTime の ms / 秒の混在（チケット本題）</td><td class="dev">develop</td><td>epoch ms に統一</td></tr>
    <tr><td>0</td><td>破棄対象を送信キュー先頭で探す・直前の別メッセージまで巻き込む</td><td class="dev">develop</td><td>対象チャンク自身から FIRST〜LAST の断片だけ破棄</td></tr>
    <tr><td>1</td><td>未送信の断片が残り、後続の配送が止まる</td><td class="dev">develop（寿命が動いて露見）</td><td>outboundQueue の残り断片も破棄</td></tr>
    <tr><td>3</td><td>FORWARD-TSN が失われると配送が止まる</td><td class="dev">develop</td><td>SACK で確認されるまで保持・T3 で再送</td></tr>
    <tr><td>3</td><td>FORWARD-TSN 受信で、先に届いた後続データが消える</td><td class="dev">develop</td><td>受信処理を RFC 3758 §3.6 に合わせる</td></tr>
    <tr><td>5</td><td>古いストリーム情報で期待 SSN が巻き戻る</td><td class="own">本差分（第3回の修正）</td><td>前進時だけ更新</td></tr>
    <tr><td>7</td><td>gap ack 済みのデータが FORWARD-TSN で消える</td><td class="own">本差分</td><td>確認済みは破棄しない・受信側で完全なものは配送</td></tr>
    <tr><td>9</td><td>SACK 損失で完全なメッセージが消える</td><td class="own">本差分（第7回の修正）</td><td>forwardSequenceNumber で完全なものを配送</td></tr>
    <tr><td>9</td><td>gap ack 済みの再送で flightSize がずれる</td><td class="dev">develop</td><td>T3 で確認済みを除外・inFlight フラグ</td></tr>
    <tr><td>乱数</td><td>配送後に次の完全なメッセージを取りこぼす（seed 6）</td><td class="dev">develop</td><td>popMessages の startPos をリセット</td></tr>
    <tr><td>乱数</td><td>不完全な断片の直後の順序なしメッセージを読み飛ばす（seed 37）</td><td class="dev">develop</td><td>不一致時に同じチャンクを再評価</td></tr>
    <tr><td>乱数</td><td>再送待ちのまま gap ack されたチャンクを再送（seed 38, 78）</td><td class="dev">develop</td><td>gap ack 時に retransmit を解除</td></tr>
    <tr><td>11</td><td>初回送信前に期限が切れても送られる</td><td class="dev">develop</td><td>送信直前に期限確認</td></tr>
    <tr><td>12</td><td>再送待ちの間に期限が切れても再送される</td><td class="dev">develop</td><td>再送直前に期限確認</td></tr>
    <tr><td>13</td><td>gap ack の撤回後に再送されず配送が止まる</td><td class="own">本差分（T3 で確認済みを除外した影響）</td><td>撤回を検出して未確認に戻す</td></tr>
    <tr><td>14</td><td>撤回後のミス指示が加算されず Fast Retransmit が遅れる</td><td class="own">本差分</td><td>SACK ごとにミス指示を加算（未レビュー）</td></tr>
  </tbody>
</table>

<script>
  (() => {
    const table = document.querySelector(".prs-bugs");
    const body = table.querySelector("tbody");
    let dir = 1, last = -1;
    table.querySelectorAll("th").forEach((th) =>
      th.addEventListener("click", () => {
        const k = Number(th.dataset.k);
        dir = k === last ? -dir : 1;
        last = k;
        const rows = [...body.rows];
        const key = (r) => r.cells[k].textContent;
        const num = (v) => (isNaN(Number(v)) ? Infinity : Number(v));
        rows.sort((a, b) => (k === 0 ? num(key(a)) - num(key(b)) : key(a).localeCompare(key(b), "ja")) * dir);
        rows.forEach((r) => body.appendChild(r));
      }),
    );
  })();
</script>

「本差分」の行は、それまでの修正が新たに生んだ問題です。指摘ごとの対症療法がこれを繰り返していたため、第 9 回以降は受信側の FORWARD-TSN 処理を作り直し、flightSize の勘定をチャンク単位のフラグに変えて、加減算の経路を 1 つにまとめました。

## 6. 主要な判断理由

- **受信側：完全なメッセージは配送し、不完全なものだけ捨てる。** RFC 3758 §3.6 と usrsctp（`sctp_kick_prsctp_reorder_queue`）の挙動に合わせました。送信側が SACK を受け取れず破棄扱いにしたデータでも、受信側に完全に揃っていれば配送します。実装は [packages/sctp/src/sctp.ts:1739](review-file:packages/sctp/src/sctp.ts:1739) です。
- **flightSize はチャンクごとの `inFlight` フラグで管理する。** 以前は経路ごとに「acked なら引かない」などの条件が散らばっていて、二重に引いたり引き漏れたりしていました。増減をフラグ経由にしたので、どの経路から呼んでも一度しか数えません。
- **gap ack 済みのチャンクは T3 で再送しない。** RFC 9260 §6.3.3 では gap ack 済みは未確認に当たりません。その代わり、受信側が破棄（撤回）した場合に備えて、RFC 9260 §6.2.1 D-iii の撤回検出と、SACK ごとのミス指示の加算を入れました（[packages/sctp/src/sctp.ts:732](review-file:packages/sctp/src/sctp.ts:732)）。二重加算を避けるため、HTNA 以下のチャンクは従来の数え上げに任せ、HTNA より後ろかギャップのない SACK の場合だけここで数えます。
- **期限切れの確認は「送る直前」に置く。** 輻輳ウィンドウや受信ウィンドウで待たされている間に期限が切れるケースがあるため、初回送信・再送の両方の直前で確認します。TSN は割り当て済みなので、送らずに破棄済みとして FORWARD-TSN の対象にします。
- **public API は変えない。** `InboundStream.pruneChunks` は使わなくなりましたが、export されているクラスのメソッドなので残しています。

## 7. テスト

テストの共通準備は [packages/sctp/tests/utils.ts:197](review-file:packages/sctp/tests/utils.ts:197) にまとめました。種類ごとに DATA・SACK・FORWARD-TSN を落とすフィルタ、損失ありの接続ペア、シード付き乱数（[packages/sctp/tests/utils.ts:258](review-file:packages/sctp/tests/utils.ts:258)）、flightSize の不変条件チェック（[packages/sctp/tests/utils.ts:274](review-file:packages/sctp/tests/utils.ts:274)）です。

決め打ちの回帰テストは [packages/sctp/tests/lifetime.test.ts:22](review-file:packages/sctp/tests/lifetime.test.ts:22) から並んでいます。主なものは次のとおりです。

- 寿命切れ → FORWARD-TSN → 後続配送：[packages/sctp/tests/lifetime.test.ts:22](review-file:packages/sctp/tests/lifetime.test.ts:22)
- SACK 損失で破棄扱いになった完全なメッセージを配送：[packages/sctp/tests/lifetime.test.ts:363](review-file:packages/sctp/tests/lifetime.test.ts:363)
- 初回送信前の期限切れ：[packages/sctp/tests/lifetime.test.ts:479](review-file:packages/sctp/tests/lifetime.test.ts:479)
- 再送待ち中の期限切れ：[packages/sctp/tests/lifetime.test.ts:572](review-file:packages/sctp/tests/lifetime.test.ts:572)
- 撤回後の Fast Retransmit：[packages/sctp/tests/lifetime.test.ts:665](review-file:packages/sctp/tests/lifetime.test.ts:665)
- popMessages の単体テスト：[packages/sctp/tests/stream.test.ts:59](review-file:packages/sctp/tests/stream.test.ts:59)

ランダム損失テスト（[packages/sctp/tests/lifetime.test.ts:728](review-file:packages/sctp/tests/lifetime.test.ts:728)）は、DATA・SACK・FORWARD-TSN を 20% の確率で落とし、複数ストリーム、断片化、順序なし、寿命あり／なしを混ぜて 100 シード実行します。各シードで次の条件を確かめます。

<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;font-family:var(--review-font);font-size:12px">
  <div style="padding:6px 10px;border:1px solid var(--review-border);border-radius:6px"><strong>送信側</strong><br>flightSize = 計上中チャンクの合計（常時）</div>
  <div style="padding:6px 10px;border:1px solid var(--review-border);border-radius:6px"><strong>送信側</strong><br>最後に全キューと FORWARD-TSN が片付き flightSize = 0</div>
  <div style="padding:6px 10px;border:1px solid var(--review-border);border-radius:6px"><strong>受信側</strong><br>取り残された断片なし・受信ウィンドウが初期値</div>
  <div style="padding:6px 10px;border:1px solid var(--review-border);border-radius:6px"><strong>配送</strong><br>二重配送なし・内容の破損なし</div>
  <div style="padding:6px 10px;border:1px solid var(--review-border);border-radius:6px"><strong>配送</strong><br>寿命なしのメッセージは必ず届く</div>
  <div style="padding:6px 10px;border:1px solid var(--review-border);border-radius:6px"><strong>配送</strong><br>ストリームごとに送信順を保つ</div>
</div>

修正を 1 か所ずつ元に戻すミューテーション確認では、どの修正を外しても少なくとも 1 件のテストが失敗しました。

## 8. 検証結果

| 項目 | 結果 |
| --- | --- |
| `packages/sctp` `npm test` | 9 ファイル・180 件すべて通過 |
| ランダム損失テスト（条件を広げた試行、設定は元に戻した） | 2000 シード・損失 20%、損失 40% / 5% 各 1000 シード、30 メッセージ・20,000 バイト含みで 1000 シード、いずれも全件通過 |
| `npm run type` | エラー 0 件 |
| `packages/webrtc` `npm test` | 74 ファイル・1590 件通過、5 件スキップ |
| `npm run test:small` | 第 10 回の修正時点で exit 0（以降の回はレビュー側で実行） |
| E2E / WPT / `npm run ci` | 未実施 |

## 9. リスクと未対応

- **未承認：** 最後の修正（撤回後のミス指示の加算）は、レビュー上限 5/5 に達したため確認レビューが開始されていません。チケットの `reviewStatus` は `completed` です。
- **送信側の挙動変更：** T3 で gap ack 済みを再送しなくなりました。撤回の検出を入れているので、受信側がデータを破棄した場合も回復します。ただし、実ブラウザ（usrsctp）との相互接続は E2E で確認していません。
- **破壊的変更：** werift-sctp を直接使い、`expiry` に epoch 秒を渡していた利用者は、すべてのチャンクが即座に破棄されます。`changelog.md` の Breaking changes に記載しました。
- **範囲外として残した問題：** `maxRetransmits: 0` が falsy 扱いで破棄されません。別チケット化を推奨します。
- **テストの書き方：** 受信側の撤回など、一部のテストは private な状態を直接書き換えて状況を作っています。実装を変えるとテストも直す必要があります。
