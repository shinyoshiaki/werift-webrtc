---
ide:
  viewer: review-document
  version: 1
  title: "#814 複数NICでhost candidateと送信元IPを一致させる（最新版）"
  dock: right
  baseCommit: ac9e6a5cb3158d17bd9fe6f305c56fb03fde4d5c
---
# #814 複数 NIC で host candidate と送信元 IP を一致させる（最新版）

この文書は、チケット `e11ea8bf` で行った変更をまとめたものです。対象は次の 4 段階すべてです。

1. 当初の修正：host ソケットを NIC の IP ごとに bind する。
2. 2026-11-12 の追加要件：wildcard ソケット、代表ソケットでの gathering 完了判定、VPN NIC の収集、既定経路の優先。
3. 既定経路の判定を、設定された STUN / TURN server への経路に変える。
4. 2026-11-13 の追加要件：公開アドレスへのプローブのフォールバックを廃止する。

## 1. 概要

`iceInterfaceAddresses` を指定しない既定設定での、複数 NIC 環境の ICE 候補収集を作り直しました。

| 観点 | 変更前（develop） | 変更後 |
| --- | --- | --- |
| host candidate の送信元 | wildcard ソケット。送信元は経路表で決まり、広告と食い違うことがある | NIC の IP ごとに bind したソケット。送信元は広告と常に一致する |
| 相手の prflx | 送信元の食い違いで不要な prflx を学習する | 学習しない（Chrome / pion / werift で 0 を確認） |
| STUN に届かない NIC があるとき | （wildcard なので届く）。ただし送信元は食い違う | `setLocalDescription()` はその NIC を待たない。srflx は後から trickle する |
| 全通信を VPN に流す構成 | `tun` などを候補から除外していた | VPN の NIC も低い優先度で収集し、wildcard ソケットでも srflx を取る |
| host の優先順 | 全 host が同じ優先度。順序は NIC 名のソート次第 | 既定経路の IP、通常 NIC、VPN NIC の順 |
| 既定経路を調べるプローブ | なし | 設定した STUN / TURN server への経路だけを調べる。server がなければ調べない。パケットは送らない。必要な理由は §3.5 |

<div style="display:flex;gap:10px;flex-wrap:wrap;font-family:var(--review-font)">
  <div style="flex:1;min-width:150px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px"><div style="color:var(--review-muted);font-size:12px">送信元不一致による prflx</div><div style="font-size:20px;font-weight:bold">0 件</div><div style="font-size:12px;color:var(--review-muted)">Chrome / pion / 新 werift</div></div>
  <div style="flex:1;min-width:150px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px"><div style="color:var(--review-muted);font-size:12px">STUN に届かない NIC がある構成での gathering</div><div style="font-size:20px;font-weight:bold">5010 → 16 ms</div><div style="font-size:12px;color:var(--review-muted)">当初の修正のみ → 最終</div></div>
  <div style="flex:1;min-width:150px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px"><div style="color:var(--review-muted);font-size:12px">相互接続（最終コード）</div><div style="font-size:20px;font-weight:bold">20 / 20 OK</div><div style="font-size:12px;color:var(--review-muted)">新旧 werift / Chrome / pion</div></div>
  <div style="flex:1;min-width:150px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-accent);border-radius:6px"><div style="color:var(--review-muted);font-size:12px">公開アドレスへのプローブ</div><div style="font-size:20px;font-weight:bold">0 か所</div><div style="font-size:12px;color:var(--review-muted)">8.8.8.8 などへのフォールバックを廃止</div></div>
</div>

## 2. 修正前の問題

### 2.1 送信元の食い違い（元の #814）

<svg viewBox="0 0 760 250" width="100%" role="img" aria-label="Before と After のソケット構成と送信元" style="font-family:var(--review-font)">
  <text x="185" y="18" text-anchor="middle" font-size="14" font-weight="bold" fill="var(--review-danger)">Before: 全 host ソケットが wildcard bind</text>
  <text x="575" y="18" text-anchor="middle" font-size="14" font-weight="bold" fill="var(--review-success)">After: IP ごとに bind ＋ wildcard は STUN 用</text>
  <line x1="380" y1="8" x2="380" y2="245" stroke="var(--review-border)" stroke-dasharray="4 4"/>
  <g font-size="12" fill="var(--review-fg)">
    <rect x="10" y="34" width="165" height="40" rx="6" fill="none" stroke="var(--review-border)"/>
    <text x="92" y="50" text-anchor="middle">socket 0.0.0.0:p1</text><text x="92" y="66" text-anchor="middle" fill="var(--review-muted)">広告: host A:p1</text>
    <rect x="10" y="88" width="165" height="40" rx="6" fill="none" stroke="var(--review-danger)" stroke-width="2"/>
    <text x="92" y="104" text-anchor="middle">socket 0.0.0.0:p2</text><text x="92" y="120" text-anchor="middle" fill="var(--review-muted)">広告: host B:p2</text>
    <rect x="215" y="60" width="150" height="40" rx="6" fill="none" stroke="var(--review-border)"/>
    <text x="290" y="76" text-anchor="middle">経路表</text><text x="290" y="92" text-anchor="middle" fill="var(--review-muted)">相手へは eth0 (A)</text>
    <line x1="175" y1="108" x2="215" y2="86" stroke="var(--review-danger)" stroke-width="2"/>
    <rect x="215" y="160" width="150" height="58" rx="6" fill="none" stroke="var(--review-danger)" stroke-width="2"/>
    <text x="290" y="178" text-anchor="middle">相手が受信</text><text x="290" y="194" text-anchor="middle" fill="var(--review-danger)">送信元 A:p2 = 未知</text><text x="290" y="210" text-anchor="middle" fill="var(--review-danger)">→ prflx を学習</text>
    <line x1="290" y1="100" x2="290" y2="160" stroke="var(--review-danger)" stroke-width="2"/>
    <text x="300" y="134" fill="var(--review-danger)" font-size="11">src = A:p2</text>

    <rect x="395" y="34" width="165" height="40" rx="6" fill="none" stroke="var(--review-success)" stroke-width="2"/>
    <text x="477" y="50" text-anchor="middle">socket A:p1 (bind)</text><text x="477" y="66" text-anchor="middle" fill="var(--review-muted)">広告: host A:p1</text>
    <rect x="395" y="88" width="165" height="40" rx="6" fill="none" stroke="var(--review-success)" stroke-width="2"/>
    <text x="477" y="104" text-anchor="middle">socket B:p2 (bind)</text><text x="477" y="120" text-anchor="middle" fill="var(--review-muted)">広告: host B:p2</text>
    <rect x="395" y="142" width="165" height="54" rx="6" fill="none" stroke="var(--review-accent)" stroke-width="2"/>
    <text x="477" y="158" text-anchor="middle">socket 0.0.0.0:pw</text><text x="477" y="174" text-anchor="middle" fill="var(--review-accent)">host は広告しない</text><text x="477" y="190" text-anchor="middle" fill="var(--review-muted)">srflx (raddr 0.0.0.0) 専用</text>
    <rect x="600" y="88" width="150" height="58" rx="6" fill="none" stroke="var(--review-success)" stroke-width="2"/>
    <text x="675" y="106" text-anchor="middle">相手が受信</text><text x="675" y="122" text-anchor="middle" fill="var(--review-success)">送信元 B:p2 = 広告済み</text><text x="675" y="138" text-anchor="middle" fill="var(--review-success)">→ prflx なし</text>
    <line x1="560" y1="108" x2="600" y2="114" stroke="var(--review-success)" stroke-width="2"/>
    <rect x="600" y="170" width="150" height="40" rx="6" fill="none" stroke="var(--review-border)"/>
    <text x="675" y="186" text-anchor="middle">STUN server</text><text x="675" y="202" text-anchor="middle" fill="var(--review-muted)">経路は OS が選ぶ</text>
    <line x1="560" y1="175" x2="600" y2="188" stroke="var(--review-accent)" stroke-width="2"/>
  </g>
  <g font-size="11" fill="var(--review-muted)"><rect x="10" y="232" width="10" height="10" fill="var(--review-danger)"/><text x="24" y="241">問題の経路</text><rect x="110" y="232" width="10" height="10" fill="var(--review-success)"/><text x="124" y="241">修正後の経路</text><rect x="220" y="232" width="10" height="10" fill="var(--review-accent)"/><text x="234" y="241">追加した wildcard ソケット</text></g>
</svg>

wildcard に bind したソケットでは、送信元 IP が宛先への経路で決まります。そのため、candidate B 用のソケットから出た check が eth0 の A から届き、相手は未知の送信元として prflx を学習していました。変更後は host ソケットを広告アドレスそのものに bind します。wildcard ソケットは srflx を取るためだけに残し、host candidate は広告しません。

### 2.2 当初の修正だけでは残った問題（デグレード調査で判明）

当初の修正（host を IP ごとに bind）を入れた時点で、デグレードを調査しました。その結果、次の問題を実測で確認しました。

- 外へ出られない NIC があると、その NIC の srflx の問い合わせが `stunGatherTimeout`（5 秒）まで終わらず、`setLocalDescription()` が 5 秒遅れる。
- 全通信を VPN に流す構成では、`tun` を候補から除外していたうえ、bind したソケットからは外へ出られず、srflx を 1 つも取れない。

下の図の「疑似 NIC 構成」を切り替えると、3 つの段階を同時に比べられます。

<style>
  .r814-tl { font-family: var(--review-font); font-size: 13px; color: var(--review-fg); }
  .r814-tl .btns button { border: 1px solid var(--review-border); background: var(--review-surface); color: var(--review-fg); padding: 3px 10px; margin-right: 6px; border-radius: 4px; cursor: pointer; }
  .r814-tl .btns button[aria-pressed="true"] { border-color: var(--review-accent); color: var(--review-accent); font-weight: bold; }
  .r814-tl .row { display: grid; grid-template-columns: 150px 1fr; gap: 8px; align-items: center; margin: 10px 0 2px; }
  .r814-tl .track { position: relative; height: 22px; background: var(--review-surface); border: 1px solid var(--review-border); border-radius: 4px; }
  .r814-tl .bar { position: absolute; top: 0; bottom: 0; left: 0; border-radius: 3px; }
  .r814-tl .end { position: absolute; top: -3px; bottom: -3px; width: 3px; background: var(--review-warning); }
  .r814-tl .note { grid-column: 2; font-size: 12px; color: var(--review-muted); }
  .r814-tl .note b.bad { color: var(--review-danger); } .r814-tl .note b.good { color: var(--review-success); }
  .r814-tl .legend { font-size: 12px; color: var(--review-muted); margin-top: 8px; }
</style>

<div class="r814-tl">
  <div class="btns">疑似 NIC 構成:
    <button data-s="real">実 NIC のみ</button>
    <button data-s="secondary" aria-pressed="true">外へ出られない二次 NIC あり</button>
    <button data-s="tunOnly">出口は VPN (tun0) だけ</button>
  </div>
  <div id="r814-tl-rows"></div>
  <div class="legend">バーの長さ：<code>gatherCandidates()</code> / <code>setLocalDescription()</code> が返るまで（0〜5.2 秒の目盛り）。黄色の縦線：end-of-candidates（<code>iceGatheringState</code> が complete になる時点）。</div>
</div>

<script>
  (() => {
    const data = {
      real: [
        ["develop", 22, 22, "host 1 + srflx 1。送信元の食い違いなし（NIC が 1 つ）", ""],
        ["当初の修正のみ", 14, 14, "host 1 + srflx 1", ""],
        ["最終", 17, 17, "host 1（既定経路 65535）+ srflx 2（bind ソケットと wildcard）", "good"],
      ],
      secondary: [
        ["develop", 24, 24, "srflx は 2 つ取れるが、127.0.0.2 の candidate の check が別アドレスから届き prflx になる", "bad"],
        ["当初の修正のみ", 5010, 5010, "届かない NIC の STUN timeout を待ち、5 秒遅れる。srflx は 1 つ", "bad"],
        ["最終", 16, 5011, "16 ms で返り、srflx 2 つ（wildcard と既定経路）が揃う。届かない NIC は裏で timeout し、end-of-candidates は 5 秒後", "good"],
      ],
      tunOnly: [
        ["develop", 11, 11, "tun0 を除外。wildcard の host 127.0.0.2 から srflx が取れるが、送信元は食い違う", "bad"],
        ["当初の修正のみ", 5008, 5008, "tun0 は除外され、127.0.0.2 に bind したソケットからは外へ出られない。srflx は 0 で、5 秒待つ", "bad"],
        ["最終", 17, 5011, "tun0 を VPN NIC として収集（既定経路なので 65535）。srflx 2 つで 17 ms で返る", "good"],
      ],
    };
    const max = 5200;
    const rows = document.getElementById("r814-tl-rows");
    const render = (s) => {
      rows.innerHTML = "";
      for (const [label, ret, end, note, tone] of data[s]) {
        const row = document.createElement("div");
        row.className = "row";
        const color = tone === "bad" ? "var(--review-danger)" : tone === "good" ? "var(--review-success)" : "var(--review-muted)";
        const width = Math.max(0.6, (ret / max) * 100);
        const endMark = end > ret ? `<span class="end" style="left:${(end / max) * 100}%" title="end-of-candidates ${end} ms"></span>` : "";
        row.innerHTML = `<div><b>${label}</b><br><span style="font-size:12px;color:var(--review-muted)">${ret} ms で返る</span></div>` +
          `<div class="track"><span class="bar" style="width:${width}%;background:${color}"></span>${endMark}</div>` +
          `<div class="note"><b class="${tone}">${tone === "bad" ? "✗" : tone === "good" ? "✓" : "・"}</b> ${note}</div>`;
        rows.appendChild(row);
      }
    };
    document.querySelectorAll(".r814-tl .btns button").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll(".r814-tl .btns button").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
        render(button.dataset.s);
      });
    });
    render("secondary");
  })();
</script>

数値は、Google STUN（`74.125.250.129:19302`）を使ってこのコンテナで実測したものです。疑似 NIC は `os.networkInterfaces()` を差し替え、`127.0.0.2` を外へ出られない NIC として見せています。「develop」は修正前、「当初の修正のみ」は bind 修正だけを入れた時点、「最終」は現在のコードです。

## 3. 修正後の仕組み

### 3.1 全体像：ICE の接続確立までの流れはどう変わったか

`setLocalDescription()` から ICE の接続確立（`connected`）までを 6 つの段階に分け、変更前（develop）と変更後を並べました。前提とする構成は次のとおりです。

- 自ホストには eth0（アドレス A、既定経路）と eth1（アドレス B、STUN server へは届かない）がある。
- STUN server を 1 つ設定している。
- 相手（例：Chrome）は eth0 側の LAN にいて、candidate R を持つ。

<style>
  .r814-ph { font-family: var(--review-font); font-size: 12px; color: var(--review-fg); display: grid; grid-template-columns: 92px repeat(6, 1fr); gap: 4px; }
  .r814-ph div { border: 1px solid var(--review-border); border-radius: 5px; padding: 5px 6px; line-height: 1.45; }
  .r814-ph .h { background: var(--review-surface); font-weight: bold; text-align: center; }
  .r814-ph .lbl { font-weight: bold; display: flex; align-items: center; }
  .r814-ph .same { color: var(--review-muted); }
  .r814-ph .bad { border-left: 4px solid var(--review-danger); }
  .r814-ph .chg { border-left: 4px solid var(--review-success); }
  .r814-ph .new { border-left: 4px solid var(--review-accent); }
  .r814-ph-legend { font-family: var(--review-font); font-size: 12px; color: var(--review-muted); margin-top: 6px; }
  .r814-ph-legend span { display: inline-block; width: 10px; height: 10px; margin: 0 4px 0 10px; vertical-align: middle; }
</style>

<div class="r814-ph">
  <div class="h"></div><div class="h">① 候補の収集</div><div class="h">② シグナリング</div><div class="h">③ ペア作成</div><div class="h">④ 疎通確認 (check)</div><div class="h">⑤ 指名</div><div class="h">⑥ 終端</div>
  <div class="lbl">変更前<br>(develop)</div>
  <div class="bad">A 用・B 用とも 0.0.0.0 に bind。送信元は経路表まかせ。tun は除外</div>
  <div class="same">全 srflx を待ってから SDP。end-of-candidates も同時</div>
  <div class="same">全 host が同じ優先度。順序は NIC 名順</div>
  <div class="bad">B 用ソケットの check が eth0 の A:p2 から出る。相手は未知の送信元として prflx を学習</div>
  <div class="bad">選ばれた pair が SDP の candidate と一致しない（相手側は prflx A:p2）</div>
  <div class="same">gathering 完了と同時</div>
  <div class="lbl">変更後</div>
  <div class="chg">A:p1・B:p2 にそれぞれ bind。VPN も収集。STUN 用の wildcard ソケット（host は広告しない）。経路プローブで既定経路 = A</div>
  <div class="chg">代表（A と wildcard）の srflx だけを待って SDP。B の srflx は後から trickle</div>
  <div class="chg">既定経路の A を最優先（65535）。wildcard は相手 R への経路が A と分かるので pair しない</div>
  <div class="chg">A:p1 の check は A:p1 から出る。相手は広告済み candidate として受け取り、prflx なし</div>
  <div class="chg">選ばれた pair（A:p1 ↔ R）が両側の SDP と一致</div>
  <div class="new">B の問い合わせが終わってから end-of-candidates。check list が尽きていればそこで失敗判定</div>
</div>
<div class="r814-ph-legend"><span style="background:var(--review-danger)"></span>問題があった段階<span style="background:var(--review-success)"></span>変更で直った段階<span style="background:var(--review-accent)"></span>新しく加わった振る舞い<span style="background:var(--review-border)"></span>変わらない段階</div>

下のシーケンス図は、同じ流れを 1 ステップずつ進めて、変更前と変更後を上下に並べて同時に表示します。「次へ」で進めると、どのステップで両者が分かれるかが分かります。赤は問題の経路、緑は変更で直った経路、青は新しく加わったやり取り、灰色は変わらないやり取りです。

<style>
  .r814-sq { font-family: var(--review-font); color: var(--review-fg); }
  .r814-sq .ctl { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; font-size: 13px; }
  .r814-sq .ctl button { border: 1px solid var(--review-border); background: var(--review-surface); color: var(--review-fg); padding: 3px 12px; border-radius: 4px; cursor: pointer; }
  .r814-sq .panel { border: 1px solid var(--review-border); border-radius: 8px; padding: 4px 8px 8px; margin-bottom: 10px; }
  .r814-sq .panel.before { border-top: 4px solid var(--review-danger); }
  .r814-sq .panel.after { border-top: 4px solid var(--review-success); }
  .r814-sq .ttl { font-size: 13px; font-weight: bold; margin: 4px 0; }
  .r814-sq .desc { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 12px; }
  .r814-sq .desc div { border: 1px solid var(--review-border); border-radius: 6px; padding: 6px 8px; }
  .r814-sq .desc .b { border-left: 4px solid var(--review-danger); }
  .r814-sq .desc .a { border-left: 4px solid var(--review-success); }
</style>

<div class="r814-sq">
  <div class="ctl"><button data-d="-1">前へ</button><button data-d="1">次へ</button><button data-d="all">全部表示</button><span id="r814-sq-step"></span></div>
  <div class="panel before"><div class="ttl">変更前（develop）</div><svg id="r814-sq-b" viewBox="0 0 760 420" width="100%" role="img" aria-label="変更前のシーケンス"></svg></div>
  <div class="panel after"><div class="ttl">変更後</div><svg id="r814-sq-a" viewBox="0 0 760 420" width="100%" role="img" aria-label="変更後のシーケンス"></svg></div>
  <div class="desc"><div class="b" id="r814-sq-db"></div><div class="a" id="r814-sq-da"></div></div>
</div>

<script>
  (() => {
    const lanes = { app: 60, ice: 220, os: 380, stun: 540, peer: 700 };
    const laneNames = { app: "アプリ", ice: "werift ICE（ソケット）", os: "OS の経路表", stun: "STUN server", peer: "相手（candidate R）" };
    const C = { bad: "var(--review-danger)", good: "var(--review-success)", fresh: "var(--review-accent)", same: "var(--review-muted)" };
    // [step, from, to, label, tone, dashed]
    const before = [
      [1, "app", "ice", "setLocalDescription()", "same"],
      [1, "ice", "ice", "socket 0.0.0.0:p1（A 用）/ 0.0.0.0:p2（B 用）", "bad"],
      [2, "ice", "stun", "Binding（p1, p2 とも eth0 の A から出る）", "same"],
      [2, "stun", "ice", "srflx × 2", "same"],
      [3, "ice", "app", "SDP: host A:p1, host B:p2, srflx, end-of-candidates", "same"],
      [3, "app", "peer", "offer / answer（R）", "same"],
      [4, "ice", "ice", "pair (A:p1,R) (B:p2,R) 同じ優先度・NIC 名順", "same"],
      [5, "ice", "os", "check from p2（B 用）", "bad"],
      [5, "os", "peer", "送信元 A:p2 ← 未広告", "bad"],
      [6, "peer", "peer", "未知の送信元 → prflx A:p2 を学習", "bad"],
      [6, "peer", "ice", "triggered check → A:p2", "bad"],
      [7, "ice", "peer", "指名: 自分は (B:p2,R)、相手は (R, prflx A:p2)", "bad"],
      [8, "ice", "app", "connected（pair が SDP と不一致）", "bad"],
    ];
    const after = [
      [1, "app", "ice", "setLocalDescription()", "same"],
      [1, "ice", "ice", "socket A:p1 / B:p2（bind）+ wildcard 0.0.0.0:pw", "good"],
      [1, "ice", "os", "経路プローブ connect(STUN)（送信なし）", "fresh", true],
      [1, "os", "ice", "→ 送信元は A（既定経路）", "fresh", true],
      [2, "ice", "stun", "Binding from A:p1 と pw（代表）/ B:p2", "same"],
      [2, "stun", "ice", "srflx(A) と srflx(raddr 0.0.0.0)。B は応答なし", "good"],
      [3, "ice", "app", "代表がそろった時点で SDP（end-of-candidates なし）", "good"],
      [3, "app", "peer", "offer / answer（R）", "same"],
      [4, "ice", "os", "R への経路プローブ（wildcard 用）", "fresh", true],
      [4, "ice", "ice", "pair (A:p1,R)=65535 優先。wildcard は A が覆うので pair しない", "good"],
      [5, "ice", "peer", "check from A:p1（送信元 A:p1 = 広告済み）", "good"],
      [6, "peer", "ice", "R から A:p1 へ check / 応答（prflx なし）", "good"],
      [7, "ice", "peer", "指名 (A:p1,R)：両側の SDP と一致", "good"],
      [8, "ice", "app", "connected。B は裏で timeout → null / end-of-candidates", "fresh"],
    ];
    const text = {
      1: ["host ソケットはすべて 0.0.0.0 に bind する。どのアドレスから出るかは送るまで決まらない。tun は収集しない。",
          "A と B にそれぞれ bind し、STUN 用の wildcard ソケットも作る。経路プローブで OS に「STUN server へはどこから出るか」を尋ね、既定経路 = A と分かる（パケットは送らない）。"],
      2: ["両方のソケットの STUN 問い合わせが eth0 の A から出るので、どちらも srflx が取れる（送信元の食い違いはここでは見えない）。",
          "代表は A:p1（既定経路）と wildcard。B:p2 は eth1 から外へ出られないので応答がないが、待たずに裏で問い合わせを続ける。"],
      3: ["全 srflx が揃ってから SDP を返す（このホストでは速いが、srflx が届かない NIC があると最大 5 秒待つ）。",
          "代表の srflx が揃った時点（実測 16 ms）で SDP を返す。B の srflx が後で取れれば trickle し、end-of-candidates はその後に出す。"],
      4: ["全 host の pair が同じ優先度なので、check の順は NIC 名のソートで決まる。",
          "既定経路の A を最優先（65535）にする。wildcard は相手 R への経路を調べ、A（host が覆う経路）なので pair を作らない。"],
      5: ["B 用ソケットの check が経路表に従って eth0 から出て、送信元が A:p2 になる。p2 は「B:p2」として広告したポートなので、相手には未知の組。",
          "A:p1 の check は A:p1 から出る。相手が受け取る送信元は、SDP で広告した candidate そのもの。"],
      6: ["相手は未知の送信元を peer-reflexive（prflx）candidate として学習し、そこへ triggered check を返す。",
          "相手は既知の candidate として処理する。prflx は生まれない。"],
      7: ["指名された pair が、自分は (B:p2, R)、相手は (R, prflx A:p2) と食い違い、SDP で交換した candidate とも合わない。",
          "指名された pair (A:p1, R) が両側で同じで、SDP の candidate とも一致する。"],
      8: ["接続はできるが、選ばれた pair を SDP や getStats から説明できない（WPT の selected pair 検証が失敗する原因）。",
          "接続後、B の問い合わせが stunGatherTimeout で終わると null candidate / end-of-candidates を出す。check list が尽きていれば、この時点で失敗を判定する。"],
    };
    const maxStep = 8;
    let step = 1;
    const ns = "http://www.w3.org/2000/svg";
    const el = (name, attrs, txt) => { const e = document.createElementNS(ns, name); for (const k in attrs) e.setAttribute(k, attrs[k]); if (txt != null) e.textContent = txt; return e; };
    const draw = (svg, msgs) => {
      svg.innerHTML = "";
      const defs = el("defs", {});
      for (const [k, c] of Object.entries(C)) {
        const m = el("marker", { id: `r814-sq-${svg.id}-${k}`, viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" });
        m.appendChild(el("path", { d: "M0,0 L10,5 L0,10 z", fill: c }));
        defs.appendChild(m);
      }
      svg.appendChild(defs);
      for (const [k, x] of Object.entries(lanes)) {
        svg.appendChild(el("text", { x, y: 16, "text-anchor": "middle", "font-size": 12, "font-weight": "bold", fill: "var(--review-fg)" }, laneNames[k]));
        svg.appendChild(el("line", { x1: x, y1: 24, x2: x, y2: 415, stroke: "var(--review-border)", "stroke-dasharray": "3 3" }));
      }
      msgs.forEach(([s, from, to, label, tone, dashed], i) => {
        if (s > step) return;
        const y = 46 + i * 26;
        const current = s === step;
        const color = C[tone];
        const g = el("g", { opacity: current ? 1 : 0.45 });
        g.appendChild(el("text", { x: 8, y: y + 4, "font-size": 10, fill: "var(--review-muted)" }, `${s}`));
        if (from === to) {
          const x = lanes[from];
          // 右端のレーンでは左向きのループにし、ラベルも左側に置く
          const dir = x > 600 ? -1 : 1;
          g.appendChild(el("path", { d: `M${x},${y - 5} h${26 * dir} v10 h${-26 * dir}`, fill: "none", stroke: color, "stroke-width": current ? 2 : 1.2, "marker-end": `url(#r814-sq-${svg.id}-${tone})` }));
          g.appendChild(el("text", { x: x + 32 * dir, y: y + 4, "text-anchor": dir > 0 ? "start" : "end", "font-size": 11, fill: color }, label));
        } else {
          const x1 = lanes[from], x2 = lanes[to];
          g.appendChild(el("line", { x1, y1: y, x2: x2 + (x2 > x1 ? -4 : 4), y2: y, stroke: color, "stroke-width": current ? 2 : 1.2, "stroke-dasharray": dashed ? "5 3" : "", "marker-end": `url(#r814-sq-${svg.id}-${tone})` }));
          // ラベルは矢印の左端から右へ書く（短い区間でも左にはみ出さない）
          g.appendChild(el("text", { x: Math.min(x1, x2) + 8, y: y - 5, "font-size": 11, fill: color }, label));
        }
        svg.appendChild(g);
      });
    };
    const render = () => {
      draw(document.getElementById("r814-sq-b"), before);
      draw(document.getElementById("r814-sq-a"), after);
      const t = text[Math.min(step, maxStep)];
      document.getElementById("r814-sq-step").textContent = step > maxStep ? "全ステップ" : `ステップ ${step} / ${maxStep}`;
      document.getElementById("r814-sq-db").innerHTML = `<b>変更前</b>：${t[0]}`;
      document.getElementById("r814-sq-da").innerHTML = `<b>変更後</b>：${t[1]}`;
    };
    document.querySelectorAll(".r814-sq .ctl button").forEach((b) => b.addEventListener("click", () => {
      const d = b.dataset.d;
      step = d === "all" ? maxStep : Math.min(maxStep, Math.max(1, step + Number(d)));
      render();
    }));
    render();
  })();
</script>

段階ごとの要点と、該当するコードは次のとおりです。

- **① 候補の収集。** ソケットごとの bind 先は [packages/ice/src/ice.ts:1358](review-file:packages/ice/src/ice.ts:1358) で決めます。wildcard ソケットの作成は [packages/ice/src/ice.ts:1722](review-file:packages/ice/src/ice.ts:1722)、経路プローブを並行して始める箇所は [packages/ice/src/ice.ts:976](review-file:packages/ice/src/ice.ts:976) です。
- **② シグナリング。** 代表と background への振り分けは [packages/ice/src/ice.ts:1682](review-file:packages/ice/src/ice.ts:1682) です。`gatherCandidates()` が返る条件は [packages/ice/src/ice.ts:997](review-file:packages/ice/src/ice.ts:997) です。webrtc 側で `setLocalDescription()` を止めずに `null` candidate を後から出す処理は [packages/webrtc/src/transport/ice.ts:973](review-file:packages/webrtc/src/transport/ice.ts:973) です。
- **③ ペア作成。** host の優先度は [packages/ice/src/ice.ts:1407](review-file:packages/ice/src/ice.ts:1407) で付けます。wildcard ソケットの pair を経路で絞る処理は [packages/ice/src/ice.ts:3078](review-file:packages/ice/src/ice.ts:3078) と [packages/ice/src/ice.ts:1791](review-file:packages/ice/src/ice.ts:1791) です。
- **④ 疎通確認。** 送信元が広告と一致するので、相手側の prflx 学習（werift では [packages/ice/src/ice.ts:2992](review-file:packages/ice/src/ice.ts:2992) の `7.2.1.3 Learning Peer Reflexive Candidates`）に入らなくなります。後から加わった pair の check をいつ始めるかは [packages/ice/src/ice.ts:1980](review-file:packages/ice/src/ice.ts:1980) で扱います。
- **⑤ 指名。** 指名の処理自体は変えていません。④で prflx が生まれなくなったので、両側の選択ペアが SDP の candidate と一致します。
- **⑥ 終端。** end-of-candidates が後から来た場合の失敗判定は [packages/ice/src/ice.ts:2630](review-file:packages/ice/src/ice.ts:2630) の `concludeCheckListIfExhausted()` です。

この図は説明用のモデルです。各段階の実際の挙動は、§2.2 の実測（gathering の時間）と §7.2 の相互接続の結果（prflx の件数）で確認しています。

### 3.2 gathering の完了は代表ソケットで判定し、残りは trickle する

<style>
  .r814-seq { font-family: var(--review-font); font-size: 12px; color: var(--review-fg); display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .r814-seq .col { border: 1px solid var(--review-border); border-radius: 8px; padding: 8px 10px; }
  .r814-seq .col.before { border-top: 4px solid var(--review-danger); } .r814-seq .col.after { border-top: 4px solid var(--review-success); }
  .r814-seq .lane { display: grid; grid-template-columns: 130px 1fr; align-items: center; gap: 6px; margin: 6px 0; }
  .r814-seq .t { position: relative; height: 18px; border-bottom: 1px dashed var(--review-border); }
  .r814-seq .seg { position: absolute; height: 12px; top: 3px; border-radius: 3px; }
  .r814-seq .ret { position: absolute; top: -2px; height: 22px; width: 2px; background: var(--review-accent); }
  .r814-seq .cap { color: var(--review-muted); margin-top: 6px; }
</style>

<div class="r814-seq">
  <div class="col before"><b>当初の修正のみ</b>：全ソケットの srflx を待つ
    <div class="lane"><span>socket eth0（既定経路）</span><div class="t"><span class="seg" style="left:0;width:6%;background:var(--review-success)"></span></div></div>
    <div class="lane"><span>socket eth1（外へ出られない）</span><div class="t"><span class="seg" style="left:0;width:96%;background:var(--review-danger)"></span></div></div>
    <div class="lane"><span><code>setLocalDescription()</code></span><div class="t"><span class="ret" style="left:96%"></span></div></div>
    <div class="cap">eth1 の timeout（5 秒）まで offer の生成が止まる。</div>
  </div>
  <div class="col after"><b>最終</b>：代表ソケットだけを待つ
    <div class="lane"><span>wildcard socket（代表）</span><div class="t"><span class="seg" style="left:0;width:6%;background:var(--review-accent)"></span></div></div>
    <div class="lane"><span>socket eth0（既定経路・代表）</span><div class="t"><span class="seg" style="left:0;width:6%;background:var(--review-success)"></span></div></div>
    <div class="lane"><span>socket eth1（裏で継続）</span><div class="t"><span class="seg" style="left:0;width:96%;background:var(--review-muted);opacity:.5"></span></div></div>
    <div class="lane"><span><code>setLocalDescription()</code></span><div class="t"><span class="ret" style="left:6%"></span></div></div>
    <div class="lane"><span><code>onicecandidate(null)</code></span><div class="t"><span class="ret" style="left:96%;background:var(--review-warning)"></span></div></div>
    <div class="cap">offer はすぐに作れる。eth1 で取れた srflx は trickle し、end-of-candidates はその後に出す。</div>
  </div>
</div>

代表ソケットは、wildcard ソケットと、既定経路の IP の host ソケットです。どちらもないファミリーでは、全 host ソケットが代表になります（従来どおり）。代表以外の srflx の問い合わせは `background` に分けます。`gatherCandidates()` は代表の問い合わせが終わった時点で返り、`localCandidatesEnd` は background がすべて終わってから true になります。

- 振り分けは [packages/ice/src/ice.ts:1672](review-file:packages/ice/src/ice.ts:1672) の `primary` 集約処理です。`representative` の選び方は [packages/ice/src/ice.ts:1682](review-file:packages/ice/src/ice.ts:1682) です。
- end-of-candidates を遅らせる処理は [packages/ice/src/ice.ts:997](review-file:packages/ice/src/ice.ts:997) です。end が遅れて来たときの失敗判定は [packages/ice/src/ice.ts:2630](review-file:packages/ice/src/ice.ts:2630) の `concludeCheckListIfExhausted()` で、待つための API は [packages/ice/src/ice.ts:1027](review-file:packages/ice/src/ice.ts:1027) の `waitForLocalCandidatesEnd()` です。
- webrtc 側は [packages/webrtc/src/transport/ice.ts:973](review-file:packages/webrtc/src/transport/ice.ts:973) の `RTCIceGatherer.gather()` です。`gather()` 自体はすぐ返し、`null` candidate と `complete` を後から出します。

end-of-candidates を代表ソケットの時点で出さないのは、RFC 8838 が end-of-candidates の後に同じ generation の candidate を出すことを認めていないためです。全 NIC が STUN に届くホストでは background が空になるので、SDP にも従来どおり `a=end-of-candidates` が付きます。

### 3.3 wildcard ソケットは「どの host ソケットも覆っていない経路」だけを check する

<svg viewBox="0 0 760 210" width="100%" role="img" aria-label="wildcard ソケットの経路ゲート" style="font-family:var(--review-font)">
  <text x="185" y="18" text-anchor="middle" font-size="14" font-weight="bold" fill="var(--review-danger)">ゲートなし: 全 remote と pair</text>
  <text x="575" y="18" text-anchor="middle" font-size="14" font-weight="bold" fill="var(--review-success)">ゲートあり: wildcardPathUncovered()</text>
  <line x1="380" y1="8" x2="380" y2="205" stroke="var(--review-border)" stroke-dasharray="4 4"/>
  <g font-size="12" fill="var(--review-fg)">
    <rect x="10" y="34" width="160" height="40" rx="6" fill="none" stroke="var(--review-accent)"/>
    <text x="90" y="50" text-anchor="middle">wildcard 0.0.0.0:pw</text><text x="90" y="66" text-anchor="middle" fill="var(--review-muted)">LAN の相手 C へ check</text>
    <rect x="210" y="34" width="160" height="58" rx="6" fill="none" stroke="var(--review-danger)" stroke-width="2"/>
    <text x="290" y="52" text-anchor="middle">Chrome (C) が受信</text><text x="290" y="68" text-anchor="middle" fill="var(--review-danger)">送信元 A:pw は未広告</text><text x="290" y="84" text-anchor="middle" fill="var(--review-danger)">→ prflx 1 件（実測）</text>
    <line x1="170" y1="54" x2="210" y2="60" stroke="var(--review-danger)" stroke-width="2"/>
    <text x="90" y="120" text-anchor="middle" fill="var(--review-muted)">srflx は公開 IP:port。LAN では</text>
    <text x="90" y="136" text-anchor="middle" fill="var(--review-muted)">NAT を通らないので送信元が</text>
    <text x="90" y="152" text-anchor="middle" fill="var(--review-muted)">「ローカル IP:pw」になる</text>

    <rect x="395" y="34" width="170" height="44" rx="6" fill="none" stroke="var(--review-border)"/>
    <text x="480" y="52" text-anchor="middle">C への経路の送信元を調べる</text><text x="480" y="68" text-anchor="middle" fill="var(--review-muted)">UDP connect（送信なし）</text>
    <rect x="395" y="100" width="170" height="44" rx="6" fill="none" stroke="var(--review-border)"/>
    <text x="480" y="118" text-anchor="middle">送信元 = host ソケットの</text><text x="480" y="134" text-anchor="middle">bind アドレス？</text>
    <line x1="480" y1="78" x2="480" y2="100" stroke="var(--review-muted)"/>
    <rect x="590" y="78" width="160" height="44" rx="6" fill="none" stroke="var(--review-success)" stroke-width="2"/>
    <text x="670" y="96" text-anchor="middle" fill="var(--review-success)">はい: pair を作らない</text><text x="670" y="112" text-anchor="middle" fill="var(--review-muted)">host ソケットが担当</text>
    <rect x="590" y="140" width="160" height="58" rx="6" fill="none" stroke="var(--review-accent)" stroke-width="2"/>
    <text x="670" y="158" text-anchor="middle" fill="var(--review-accent)">いいえ: pair を作る</text><text x="670" y="174" text-anchor="middle" fill="var(--review-muted)">VPN 経由など、host が</text><text x="670" y="190" text-anchor="middle" fill="var(--review-muted)">覆わない唯一の経路</text>
    <line x1="565" y1="114" x2="590" y2="100" stroke="var(--review-success)" stroke-width="2"/>
    <line x1="565" y1="130" x2="590" y2="160" stroke="var(--review-accent)" stroke-width="2"/>
  </g>
</svg>

仕様どおりに wildcard ソケットを全 remote candidate と pair させたところ、Chrome との接続で Chrome 側が prflx を 1 件学習しました。そこで、相手アドレスへの経路の送信元が、いずれかの UDP host ソケットの bind アドレスと一致する場合は、wildcard ソケットの pair を作らないようにしました。その経路は host ソケットが担当し、NAT を越える場合も host ソケットの srflx が使われます。

- 判定は [packages/ice/src/ice.ts:1791](review-file:packages/ice/src/ice.ts:1791) の `wildcardPathUncovered()` です。pairing の入口は live 側が [packages/ice/src/ice.ts:3078](review-file:packages/ice/src/ice.ts:3078)、provisional 側が [packages/ice/src/ice.ts:579](review-file:packages/ice/src/ice.ts:579) です。
- wildcard ソケットの作成と srflx の取得は [packages/ice/src/ice.ts:1722](review-file:packages/ice/src/ice.ts:1722) の `gatherWildcardReflexive()` です。srflx の base（`0.0.0.0` / `::`）は [packages/ice/src/ice.ts:1804](review-file:packages/ice/src/ice.ts:1804) で、作成条件は [packages/ice/src/ice.ts:1544](review-file:packages/ice/src/ice.ts:1544) です。
- check の開始が遅れた pair は、スケジューラーのループが止まっている場合にだけ直接開始します（[packages/ice/src/ice.ts:1980](review-file:packages/ice/src/ice.ts:1980)）。それ以外は優先度順のスケジューラーに任せます。直接開始すると host 同士の pair より先に wildcard の check が出てしまい、新 werift 同士でも prflx が出たためです。

### 3.4 host の優先順：既定経路、通常 NIC、VPN NIC

<style>
  .r814-pref { font-family: var(--review-font); font-size: 12px; color: var(--review-fg); display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .r814-pref .col { border: 1px solid var(--review-border); border-radius: 8px; padding: 8px 10px; }
  .r814-pref .r { display: grid; grid-template-columns: 120px 1fr 52px; gap: 6px; align-items: center; margin: 5px 0; }
  .r814-pref .b { height: 14px; border-radius: 3px; }
</style>

<div class="r814-pref">
  <div class="col" style="border-top:4px solid var(--review-danger)"><b>develop</b>：全 host が同じ優先度で、VPN は除外
    <div class="r"><span>eth0（既定経路）</span><span class="b" style="width:12.5%;background:var(--review-muted)"></span><span>8191</span></div>
    <div class="r"><span>eth1</span><span class="b" style="width:12.5%;background:var(--review-muted)"></span><span>8191</span></div>
    <div class="r"><span>tun0（VPN）</span><span style="color:var(--review-danger)">除外（候補なし）</span><span>—</span></div>
    <div style="color:var(--review-muted);margin-top:6px">優先度が同じなので、check の順は NIC 名のソート次第。</div>
  </div>
  <div class="col" style="border-top:4px solid var(--review-success)"><b>最終</b>：<code>HostLocalPreference</code> の 3 区分
    <div class="r"><span>既定経路の IP</span><span class="b" style="width:100%;background:var(--review-success)"></span><span>65535</span></div>
    <div class="r"><span>通常 NIC</span><span class="b" style="width:50%;background:var(--review-accent)"></span><span>32767</span></div>
    <div class="r"><span>VPN（tun / utun / ipsec / tap）</span><span class="b" style="width:25%;background:var(--review-warning)"></span><span>16383</span></div>
    <div style="color:var(--review-muted);margin-top:6px">同じ区分の中では収集順に 1 ずつ下げる。vmnet / veth は従来どおり除外する。</div>
  </div>
</div>

- 区分の定義は [packages/ice/src/internal/hostPreference.ts:12](review-file:packages/ice/src/internal/hostPreference.ts:12) で、host candidate への適用は [packages/ice/src/ice.ts:1407](review-file:packages/ice/src/ice.ts:1407) です。
- VPN NIC の収集は [packages/ice/src/internal/selectAddresses.ts:53](review-file:packages/ice/src/internal/selectAddresses.ts:53) の `selectHostInterfaces()` です。公開 API の `getHostAddresses()` の戻り値は変えていません。

### 3.5 なぜ経路プローブが必要か

#### 3.5.1 「どの NIC から出ていくか」は NIC の一覧からは分からない

werift が NIC について得られる情報は `os.networkInterfaces()` だけで、これは各 NIC のアドレスの一覧です。ある宛先へのパケットがどの NIC のどのアドレスから出ていくかは、OS の経路表（と policy routing や VPN の設定）で決まります。この情報は一覧に含まれていません。Node.js には経路表を読む API もありません。

そこで「宛先 X に送るなら、送信元はどのアドレスになるか」を OS に直接尋ねます。これが経路プローブです。

<svg viewBox="0 0 760 250" width="100%" role="img" aria-label="経路プローブの仕組み" style="font-family:var(--review-font)">
  <g font-size="12" fill="var(--review-fg)">
    <rect x="8" y="10" width="230" height="122" rx="8" fill="none" stroke="var(--review-border)"/>
    <text x="123" y="30" text-anchor="middle" font-weight="bold">os.networkInterfaces()</text>
    <text x="22" y="52">docker0  172.17.0.1</text>
    <text x="22" y="70">eth0     192.168.10.5</text>
    <text x="22" y="88">wlan0    10.0.0.7</text>
    <text x="22" y="112" fill="var(--review-danger)">✗ どれが STUN server へ出るかは</text>
    <text x="22" y="126" fill="var(--review-danger)">   書かれていない</text>

    <rect x="280" y="10" width="200" height="122" rx="8" fill="none" stroke="var(--review-accent)" stroke-width="2"/>
    <text x="380" y="30" text-anchor="middle" font-weight="bold" fill="var(--review-accent)">経路プローブ</text>
    <text x="292" y="54">① UDP socket を作る</text>
    <text x="292" y="74">② connect(STUN server)</text>
    <text x="292" y="94">③ socket.address() を読む</text>
    <text x="292" y="114">④ socket を閉じる</text>

    <rect x="522" y="10" width="230" height="122" rx="8" fill="none" stroke="var(--review-border)"/>
    <text x="637" y="30" text-anchor="middle" font-weight="bold">OS（カーネル）</text>
    <text x="534" y="54">経路表・policy routing・VPN を</text>
    <text x="534" y="72">引いて送信元アドレスを決める</text>
    <text x="534" y="100" fill="var(--review-success)">→ 「10.0.0.7 から出る」</text>
    <text x="534" y="118" fill="var(--review-muted)">（実際に送るときと同じ判定）</text>

    <line x1="480" y1="74" x2="522" y2="74" stroke="var(--review-accent)" stroke-width="2"/>
    <line x1="522" y1="100" x2="480" y2="100" stroke="var(--review-success)" stroke-width="2"/>
    <line x1="238" y1="70" x2="280" y2="70" stroke="var(--review-muted)" stroke-dasharray="4 3"/>

    <rect x="8" y="160" width="744" height="80" rx="8" fill="none" stroke="var(--review-border)" stroke-dasharray="5 4"/>
    <text x="22" y="182" font-weight="bold">ネットワーク上</text>
    <text x="22" y="204" fill="var(--review-success)">UDP の connect() は「宛先を覚えるだけ」の操作で、パケットは 1 つも送らない。</text>
    <text x="22" y="224" fill="var(--review-muted)">STUN server には何も届かない（テストで受信数 0 を確認）。libwebrtc も同じ方法で既定のローカルアドレスを求めている。</text>
  </g>
</svg>

`connect()` は宛先を覚えるだけの操作で、送信はしません。経路表を引く判定は実際に送るときと同じなので、結果は「その宛先に送ったら、この送信元から出る」と一致します。

- 実装は [packages/ice/src/internal/defaultRoute.ts:16](review-file:packages/ice/src/internal/defaultRoute.ts:16) の `getRouteSourceAddress()` です。
- パケットを送らないことは [packages/ice/tests/ice/default-route.test.ts:45](review-file:packages/ice/tests/ice/default-route.test.ts:45) で確認しています。プローブ先の server の受信数が 0 であること、プローブ先が server だけであることを調べています。

#### 3.5.2 用途 1：STUN / TURN server へのプローブ（代表ソケットと優先順を決める）

このプローブの答えを 2 か所で使います。

- **代表ソケットを決める（§3.2）。** STUN server に実際に届くのは、STUN server への経路の送信元アドレスに bind したソケットです。そのソケットの srflx だけを待てば、届かない NIC を待たずに済みます。
- **host の優先順を決める（§3.4）。** そのアドレスの host candidate を最優先にし、check を実際に使われる経路から始めます。

下の例では、STUN server の置き場所を切り替えると、プローブがある場合とない場合で選ばれる NIC がどう変わるかを比べられます（NIC 構成は説明用の例です）。

<style>
  .r814-pr { font-family: var(--review-font); font-size: 13px; color: var(--review-fg); }
  .r814-pr .btns button { border: 1px solid var(--review-border); background: var(--review-surface); color: var(--review-fg); padding: 3px 10px; margin: 0 6px 6px 0; border-radius: 4px; cursor: pointer; }
  .r814-pr .btns button[aria-pressed="true"] { border-color: var(--review-accent); color: var(--review-accent); font-weight: bold; }
  .r814-pr .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .r814-pr .col { border: 1px solid var(--review-border); border-radius: 8px; padding: 8px 10px; }
  .r814-pr .col.no { border-top: 4px solid var(--review-danger); } .r814-pr .col.yes { border-top: 4px solid var(--review-success); }
  .r814-pr .nic { display: grid; grid-template-columns: 70px 110px 1fr; gap: 6px; padding: 3px 6px; margin: 3px 0; border-radius: 4px; border: 1px solid var(--review-border); }
  .r814-pr .nic.pick-bad { border-color: var(--review-danger); background: color-mix(in srgb, var(--review-danger) 10%, transparent); }
  .r814-pr .nic.pick-good { border-color: var(--review-success); background: color-mix(in srgb, var(--review-success) 12%, transparent); }
  .r814-pr .res { margin-top: 6px; font-size: 12px; color: var(--review-muted); }
</style>

<div class="r814-pr">
  <div class="btns">STUN server の場所:
    <button data-k="inet" aria-pressed="true">Internet 上（wlan0 から出る）</button>
    <button data-k="lan">社内 LAN 上（eth0 から出る）</button>
    <button data-k="vpn">VPN の先（tun0 から出る）</button>
  </div>
  <div class="grid">
    <div class="col no"><b>プローブなし</b>：NIC 名の順に並べるしかない
      <div id="r814-pr-no"></div>
      <div class="res" id="r814-pr-no-res"></div>
    </div>
    <div class="col yes"><b>プローブあり</b>：STUN server への経路の送信元を OS に尋ねる
      <div id="r814-pr-yes"></div>
      <div class="res" id="r814-pr-yes-res"></div>
    </div>
  </div>
</div>

<script>
  (() => {
    const nics = [
      ["docker0", "172.17.0.1"],
      ["eth0", "192.168.10.5"],
      ["tun0", "10.8.0.2"],
      ["wlan0", "10.0.0.7"],
    ];
    const route = { inet: "wlan0", lan: "eth0", vpn: "tun0" };
    const draw = (k) => {
      const out = route[k];
      // プローブなし: 名前順 (VPN は最後)。先頭が最優先として扱われる
      const byName = [...nics].sort((a, b) => (a[0] === "tun0") - (b[0] === "tun0") || a[0].localeCompare(b[0]));
      const no = document.getElementById("r814-pr-no");
      no.innerHTML = byName.map(([n, a], i) => `<div class="nic ${i === 0 ? (n === out ? "pick-good" : "pick-bad") : ""}"><span>${n}</span><span>${a}</span><span>${i === 0 ? "先頭（最初に check）" : ""}${n === out ? " ← 実際の出口" : ""}</span></div>`).join("");
      document.getElementById("r814-pr-no-res").innerHTML = byName[0][0] === out
        ? "偶然、先頭が実際の出口と一致した。"
        : `<span style="color:var(--review-danger)">先頭の ${byName[0][0]} は STUN server へ出ない。</span>代表ソケットを決められないので、全ソケットの srflx を待つ（届かない NIC があれば 5 秒）か、wildcard だけを待つ（単一 NIC でも SDP の内容が変わる）しかない。`;
      // プローブあり: 実際の出口が最優先 (65535)
      const yes = document.getElementById("r814-pr-yes");
      const ordered = [nics.find(([n]) => n === out), ...byName.filter(([n]) => n !== out)];
      yes.innerHTML = ordered.map(([n, a], i) => `<div class="nic ${i === 0 ? "pick-good" : ""}"><span>${n}</span><span>${a}</span><span>${i === 0 ? "既定経路 65535・代表ソケット" : n === "tun0" ? "VPN 16383" : "通常 32767"}</span></div>`).join("");
      document.getElementById("r814-pr-yes-res").innerHTML = `<span style="color:var(--review-success)">connect(STUN server) の答えは ${route[k] === "wlan0" ? "10.0.0.7" : route[k] === "eth0" ? "192.168.10.5" : "10.8.0.2"}（${out}）。</span>このソケットの srflx だけを待ち、他の NIC は裏で問い合わせる。check もここから始める。`;
    };
    document.querySelectorAll(".r814-pr .btns button").forEach((b) => b.addEventListener("click", () => {
      document.querySelectorAll(".r814-pr .btns button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      draw(b.dataset.k);
    }));
    draw("inet");
  })();
</script>

プローブがないと、代表ソケットは次のどちらかの決め方しかありません。このコンテナでの実測と既存テストの結果で比べると、次のようになります。

<div style="display:flex;gap:10px;flex-wrap:wrap;font-family:var(--review-font);font-size:12px">
  <div style="flex:1;min-width:210px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px">
    <b>A. 全ソケットの srflx を待つ</b>（当初の修正の挙動）<br>
    STUN に届かない NIC があると <b style="color:var(--review-danger)">5010 ms</b> 待つ（二次 NIC あり構成の実測）。
  </div>
  <div style="flex:1;min-width:210px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px">
    <b>B. wildcard ソケットだけを待つ</b>（途中で試した案）<br>
    単一 NIC のホストでも bind ソケットの srflx が後回しになる。そのため <code>setLocalDescription()</code> 直後の SDP から <b style="color:var(--review-danger)">a=end-of-candidates が消え</b>、後から届く candidate で SDP が変わる。既存テストが 2 件失敗した。
  </div>
  <div style="flex:1;min-width:210px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px">
    <b>C. プローブで既定経路のソケットも代表にする</b>（採用）<br>
    届かない NIC があっても <b style="color:var(--review-success)">16 ms</b> で返る。全 NIC が届くホストでは、待ち時間も SDP も従来どおり。
  </div>
</div>

プローブ先が公開アドレスではなく、設定した STUN / TURN server である理由は次のとおりです。

- 代表ソケットに求められるのは「その STUN server に届くこと」なので、その server への経路を直接尋ねるのが最も正確です。
- 社内 STUN や、VPN の split tunnel、policy routing の構成では、Internet への経路と server への経路が別の NIC になることがあります。上の例の「社内 LAN」「VPN の先」がこのケースです。
- server がない構成では srflx の問い合わせ自体がありません。代表ソケットを決める必要がないので、プローブもしません。
- 公開アドレスへのフォールバックを廃止したので、ユーザーが設定していない宛先へはプローブしません。

実装は [packages/ice/src/internal/defaultRoute.ts:104](review-file:packages/ice/src/internal/defaultRoute.ts:104) で、gathering から呼ぶ箇所は [packages/ice/src/ice.ts:976](review-file:packages/ice/src/ice.ts:976) です。代表の選び方は [packages/ice/src/ice.ts:1682](review-file:packages/ice/src/ice.ts:1682) です。テストは [packages/ice/tests/ice/multi-nic-reflexive.test.ts:258](review-file:packages/ice/tests/ice/multi-nic-reflexive.test.ts:258) で、STUN server への経路の NIC が最優先になることを確認しています。

#### 3.5.3 用途 2：相手 candidate へのプローブ（wildcard ソケットの check を絞る）

wildcard ソケットは送信元を OS に任せるソケットです。そのため、相手 C へ送ったときに「どのアドレスから出るか」は送ってみるまで分かりません。もし出口が host ソケットの bind アドレスと同じなら、その経路は host ソケットが担当しています。この場合、wildcard ソケットから送っても、相手には未広告の「ローカル IP:wildcard ポート」が届くだけです。

<div style="display:flex;gap:10px;flex-wrap:wrap;font-family:var(--review-font);font-size:12px">
  <div style="flex:1;min-width:210px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px">
    <b>常に pair する</b>（プローブなし案 1）<br>
    LAN の相手に未広告の送信元から check が届く。<b style="color:var(--review-danger)">Chrome が prflx を 1 件学習した</b>（実測）。#814 の目的と矛盾する。
  </div>
  <div style="flex:1;min-width:210px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px">
    <b>常に pair しない</b>（プローブなし案 2）<br>
    出口が列挙外のアドレス（列挙しない NIC、gathering 後に変わったアドレス、policy routing で選ばれる別アドレスなど）だけの場合、<b style="color:var(--review-danger)">その経路の check が誰からも出ない</b>。wildcard ソケットを置いた意味がなくなる。
  </div>
  <div style="flex:1;min-width:210px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px">
    <b>C への経路をプローブして決める</b>（採用）<br>
    出口が host ソケットのアドレスなら pair しない。そうでなければ pair する。<b style="color:var(--review-success)">Chrome の prflx は 0</b> で、host が覆わない経路も残る。
  </div>
</div>

このプローブの宛先は、ICE の check でもともとパケットを送る相手の candidate です。新しい宛先は増えません。

- 実装は [packages/ice/src/ice.ts:1791](review-file:packages/ice/src/ice.ts:1791) の `wildcardPathUncovered()` です。
- テストは [packages/ice/tests/ice/multi-nic-reflexive.test.ts:294](review-file:packages/ice/tests/ice/multi-nic-reflexive.test.ts:294)（覆われた経路では pair しない）と [packages/ice/tests/ice/multi-nic-reflexive.test.ts:330](review-file:packages/ice/tests/ice/multi-nic-reflexive.test.ts:330)（覆われていない経路では pair する）です。判定を「常に pair する」「常に pair しない」に差し替えると、それぞれ失敗します。

#### 3.5.4 コストと安全性

| 観点 | 内容 |
| --- | --- |
| ネットワークへの影響 | パケットを送らない（UDP `connect()` だけ） |
| 宛先 | 設定した STUN / TURN server と、相手の candidate だけ。どちらもプローブがなくても通信する相手 |
| server がない構成 | 何もプローブしない（テストで `connect()` 先が 0 件であることを確認） |
| gathering の待ち時間 | ソケットの bind と並行して行う。ホスト名の server は DNS の解決を待つ（上限 1 秒）が、STUN の問い合わせも同じ解決を待つので、gathering の完了時刻はほぼ変わらない |
| 失敗したとき | 経路がない、解決できないときは「既定経路なし」として扱い、host の順序は収集順になる。接続は止めない |

### 3.6 既定経路の決め方：3 段階の変遷と最終仕様

<div style="display:flex;gap:10px;flex-wrap:wrap;font-family:var(--review-font);font-size:12px">
  <div style="flex:1;min-width:200px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px">
    <b>① fc1f6e81e</b><br>プローブ先：<code>8.8.8.8</code> / <code>2001:4860:4860::8888</code> 固定<br><span style="color:var(--review-danger)">設定と関係なく公開アドレスへプローブする</span>
  </div>
  <div style="flex:1;min-width:200px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-warning);border-radius:6px">
    <b>② 98cfd596d</b><br>プローブ先：設定した STUN / TURN server（優先順）<br><span style="color:var(--review-warning)">server がなければ ① の公開アドレスへフォールバック</span>
  </div>
  <div style="flex:1;min-width:200px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px">
    <b>③ 77fc625d1（最終）</b><br>プローブ先：設定した STUN / TURN server だけ<br><span style="color:var(--review-success)">server がなければ何もプローブせず、既定経路なしとして扱う</span>
  </div>
</div>

<svg viewBox="0 0 760 120" width="100%" role="img" aria-label="最終仕様の既定経路判定フロー" style="font-family:var(--review-font)">
  <g font-size="12" fill="var(--review-fg)">
    <rect x="5" y="30" width="150" height="50" rx="6" fill="none" stroke="var(--review-border)"/><text x="80" y="50" text-anchor="middle">STUN → TURN の</text><text x="80" y="66" text-anchor="middle">優先順で server を列挙</text>
    <rect x="190" y="30" width="160" height="50" rx="6" fill="none" stroke="var(--review-border)"/><text x="270" y="50" text-anchor="middle">ファミリーで解決</text><text x="270" y="66" text-anchor="middle" fill="var(--review-muted)">ホスト名は 1 秒以内</text>
    <rect x="385" y="30" width="160" height="50" rx="6" fill="none" stroke="var(--review-border)"/><text x="465" y="50" text-anchor="middle">UDP connect で</text><text x="465" y="66" text-anchor="middle">経路の送信元を取得</text>
    <rect x="580" y="6" width="175" height="44" rx="6" fill="none" stroke="var(--review-success)" stroke-width="2"/><text x="667" y="24" text-anchor="middle" fill="var(--review-success)">最初に得られた送信元</text><text x="667" y="40" text-anchor="middle">= 既定経路の IP</text>
    <rect x="580" y="66" width="175" height="48" rx="6" fill="none" stroke="var(--review-accent)" stroke-width="2"/><text x="667" y="84" text-anchor="middle" fill="var(--review-accent)">server なし / 全滅</text><text x="667" y="100" text-anchor="middle">既定経路なし（プローブもしない）</text>
    <g stroke="var(--review-muted)"><line x1="155" y1="55" x2="190" y2="55"/><line x1="350" y1="55" x2="385" y2="55"/><line x1="545" y1="45" x2="580" y2="30"/><line x1="545" y1="65" x2="580" y2="88"/></g>
  </g>
</svg>

最終仕様では、プローブの宛先は agent がもともと通信する相手だけです。

- 設定した STUN / TURN server：gathering で問い合わせる相手。
- wildcard ソケットの経路ゲートで調べる相手の candidate：ICE の check で送る相手。

プローブは UDP `connect()` で経路を調べるだけで、パケットは送りません。server がない構成では既定経路の区分を使わず、host candidate は通常 NIC / VPN NIC の区分と収集順で並びます。

- 実装は [packages/ice/src/internal/defaultRoute.ts:104](review-file:packages/ice/src/internal/defaultRoute.ts:104) の `getDefaultRouteAddresses()` と [packages/ice/src/internal/defaultRoute.ts:82](review-file:packages/ice/src/internal/defaultRoute.ts:82) の `getServerRouteAddress()` です。ソケット bind と並行して調べ、プローブ先として server を渡す箇所は [packages/ice/src/ice.ts:976](review-file:packages/ice/src/ice.ts:976) です。
- フォールバックを廃止した差分は [packages/ice/src/internal/defaultRoute.ts](review-diff:packages/ice/src/internal/defaultRoute.ts:commit:77fc625d1) です。server 向けに変えた差分は [packages/ice/src/internal/defaultRoute.ts](review-diff:packages/ice/src/internal/defaultRoute.ts:commit:98cfd596d) です。

組み込みの既定 STUN server（`stun.l.google.com:19302`、`iceUseDefaultStunServer`）は、本チケットより前からある server 設定です。プローブのフォールバックではないので、範囲外として変えていません。この server には STUN の問い合わせを実際に送るので、プローブ先にしても新しい宛先は増えません。`iceUseDefaultStunServer: false` で無効にできます。

## 4. 主要変更

### 4.1 当初の修正（host を IP ごとに bind）

- common：[packages/common/src/transport.ts:47](review-file:packages/common/src/transport.ts:47) で `UdpTransport.init()` に `bindAddress` を追加しました。`bindAddress` は `interfaceAddresses` より優先します。差分は [packages/common/src/transport.ts](review-diff:packages/common/src/transport.ts:commit:1274358e1) です。`findPort()` は bind 先のアドレスで空きポートを探します（[packages/common/src/network.ts](review-diff:packages/common/src/network.ts:commit:1274358e1)）。
- ice：[packages/ice/src/stun/protocol.ts:40](review-file:packages/ice/src/stun/protocol.ts:40) で `StunProtocol.connectionMade()` に第 4 引数 `{ bindAddress }` を追加しました。
- [packages/ice/src/internal/resolveHostAddresses.ts:84](review-file:packages/ice/src/internal/resolveHostAddresses.ts:84) は、アドレスごとに bind 方針（`explicit` / `enumerated` / `wildcard`）を返すようにしました。IPv6 は [packages/ice/src/internal/resolveHostAddresses.ts:48](review-file:packages/ice/src/internal/resolveHostAddresses.ts:48) の `normalizeIp` で正規化してから比べます。ローカルに割り当てのない `additionalHostAddresses`（1:1 NAT の公開 IP など）は、wildcard ソケットのままにしました。
- [packages/ice/src/ice.ts:1358](review-file:packages/ice/src/ice.ts:1358) で bind 先を決め、bind 後の `socket.address()` を広告します。bind に失敗したアドレスだけを落とします。

### 4.2 追加要件（2026-11-12）

- ice の主な差分は [packages/ice/src/ice.ts](review-diff:packages/ice/src/ice.ts:commit:fc1f6e81e) です。内容は §3.2 から §3.4 の図に対応します。
- `serverReflexiveCandidate()` に、省略可能な `base` 引数を追加しました（[packages/ice/src/iceBase.ts:548](review-file:packages/ice/src/iceBase.ts:548)）。`IceConnection.waitForLocalCandidatesEnd?()` も追加しました（[packages/ice/src/iceBase.ts:61](review-file:packages/ice/src/iceBase.ts:61)）。
- webrtc の差分は [packages/webrtc/src/transport/ice.ts](review-diff:packages/webrtc/src/transport/ice.ts:commit:fc1f6e81e) です。

### 4.3 既定経路のプローブ先の変更

- server 向けに変更：[packages/ice/src/ice.ts](review-diff:packages/ice/src/ice.ts:commit:98cfd596d)
- 公開アドレスへのフォールバックを廃止：[packages/ice/src/ice.ts](review-diff:packages/ice/src/ice.ts:commit:77fc625d1)

### 4.4 ドキュメント

- JSDoc は [packages/ice/src/iceBase.ts](review-diff:packages/ice/src/iceBase.ts:commit:77fc625d1) と [packages/webrtc/src/api/peerConfig.ts](review-diff:packages/webrtc/src/api/peerConfig.ts:commit:77fc625d1) を更新しました。
- `changelog.md` にも追記しました。`doc/` と `packages/*/doc` は `npm run doc` で作り直しています。

## 5. 判断理由

- **TURN は ICE 用の wildcard ソケットに多重化しませんでした。** TURN の allocation は既定でもともと wildcard に bind した専用ソケットを使っており、「OS が経路を選ぶ」点は同じです。多重化すると、TURN の Data Indication と ICE の STUN を分ける処理が要ります。
- **end-of-candidates は遅らせ、`setLocalDescription()` は待たせないようにしました。** RFC 8838 では、end-of-candidates の後に同じ generation の candidate を出せません。offer の生成を止めずに仕様を守るため、この 2 つを分けました。
- **既定経路のソケットも代表にしました。** wildcard ソケットだけを代表にすると、単一 NIC のホストでも bind ソケットの srflx が background に回ります。すると、SDP から `a=end-of-candidates` が消えるなど、全利用者に見える変化が出ました（既存テスト 2 件が失敗した）。
- **wildcard の pair を経路で絞りました。** 仕様どおりに全 remote と pair すると、LAN の相手が prflx を学習します（Chrome で再現）。#814 の目的と矛盾するため、host ソケットが覆っていない経路だけに限定しました。
- **プローブ先は通信相手だけにしました。** ユーザーの追加要件（意図しない公開サーバーへのアクセスをしない）に合わせ、設定した server がなければ既定経路を求めないことにしました。

## 6. リスク・レビュアーに確認してほしい点

- **gathering の完了を待つアプリへの影響：** `iceGatheringState === "complete"` を待ってから SDP を送るアプリは、STUN に届かない NIC がある構成では従来どおり最大 `stunGatherTimeout` 待ちます。`setLocalDescription()` を待つだけのアプリは待ちません。
- **server がない構成：** 既定経路の区分を使わないので、host の順序は収集順（NIC 名順、VPN NIC は最後）になります。
- **IPv6 の wildcard ソケット：** IPv6 リテラルの STUN server があるときだけ作ります。テストで直接は確認していません。
- **経路ゲート：** 経路の送信元で判定するので、host ソケットが実際には届く経路でも、送信元が別アドレスなら wildcard の pair を作ることがあります（保守的な判定）。
- **未検証：** 実機の複数 NIC、VPN、NAT を通した構成と WPT は確認していません。疑似 NIC はループバック上の `127.0.0.2` です。

## 7. 検証結果

### 7.1 テスト

| コマンド（最終コード） | 結果 |
| --- | --- |
| `npm run type` | 成功 |
| `npm run test:small` | ice 453 件、webrtc 1722 件などが成功。失敗は sctp の `tests/burst.test.ts` の 1 件で、計時テストとして develop でも 3/3 失敗する（環境起因） |
| `npm run e2e`（Chrome 157） | 23 ファイル / 67 件成功 |

主な追加テストは次のとおりです。

- [packages/ice/tests/ice/multi-nic.test.ts:58](review-file:packages/ice/tests/ice/multi-nic.test.ts:58)：bind 先と広告の一致、prflx が出ないこと、bind 失敗の扱い、IPv4 と IPv6、ICE restart、portRange、追加アドレス。
- [packages/ice/tests/ice/multi-nic-reflexive.test.ts:103](review-file:packages/ice/tests/ice/multi-nic-reflexive.test.ts:103)：代表ソケットだけを待つことと trickle の順序。
- [packages/ice/tests/ice/multi-nic-reflexive.test.ts:218](review-file:packages/ice/tests/ice/multi-nic-reflexive.test.ts:218)：優先度の 3 区分。
- [packages/ice/tests/ice/multi-nic-reflexive.test.ts:258](review-file:packages/ice/tests/ice/multi-nic-reflexive.test.ts:258)：既定経路 = STUN server への経路。
- [packages/ice/tests/ice/multi-nic-reflexive.test.ts:294](review-file:packages/ice/tests/ice/multi-nic-reflexive.test.ts:294) と [packages/ice/tests/ice/multi-nic-reflexive.test.ts:330](review-file:packages/ice/tests/ice/multi-nic-reflexive.test.ts:330)：経路ゲートの両方向。
- [packages/ice/tests/ice/multi-nic-reflexive.test.ts:389](review-file:packages/ice/tests/ice/multi-nic-reflexive.test.ts:389)：ICE restart での再利用と close での解放。
- [packages/ice/tests/ice/default-route.test.ts:94](review-file:packages/ice/tests/ice/default-route.test.ts:94) と [packages/ice/tests/ice/default-route.test.ts:107](review-file:packages/ice/tests/ice/default-route.test.ts:107)：`node:dgram` を差し替えて `connect()` 先をすべて記録し、server 以外へのプローブがないことを確認します。
- [packages/webrtc/tests/transport/iceGatheringMultiNic.test.ts:39](review-file:packages/webrtc/tests/transport/iceGatheringMultiNic.test.ts:39)：`setLocalDescription()` が待たないこと、trickle、`null`、`complete` の順序。

次のテストは、実装をわざと戻すと失敗することを確認しました。

- 経路ゲートのテスト：「常に pair する」「常に pair しない」のそれぞれで失敗する。
- プローブ先のテスト：公開アドレスへのプローブを戻すと 4 件が失敗する。
- 既定経路のテスト：server を渡さない旧実装相当で失敗する。

### 7.2 相互接続（DataChannel でテキスト 5 件 + 16 KiB バイナリを往復）

<style>
  .r814-mx { font-family: var(--review-font); font-size: 12px; border-collapse: collapse; width: 100%; }
  .r814-mx th, .r814-mx td { border: 1px solid var(--review-border); padding: 4px 6px; text-align: center; }
  .r814-mx th { background: var(--review-surface); }
  .r814-mx td.ok { color: var(--review-success); } .r814-mx td.warn { color: var(--review-warning); } .r814-mx td.ng { color: var(--review-danger); }
  .r814-mx td.l { text-align: left; }
</style>

<table class="r814-mx">
  <tr><th>相手</th><th>werift の役割</th><th>実 NIC</th><th>二次 NIC あり</th><th>VPN (tun0) だけ</th><th>相手が werift から学習した prflx</th></tr>
  <tr><td class="l">Chromium 156 × 新 werift</td><td>offer / answer</td><td class="ok">OK / OK</td><td class="ok">OK / OK</td><td class="ok">OK / OK</td><td class="ok">全構成 0</td></tr>
  <tr><td class="l">Chromium 156 × werift 0.27（比較）</td><td>offer / answer</td><td class="ok">OK / OK</td><td class="ok">OK / OK</td><td class="ok">OK / OK</td><td class="warn">0 / 1 / 2</td></tr>
  <tr><td class="l">pion v4.2.26 × 新 werift</td><td>offer / answer</td><td class="ok">OK / OK</td><td class="ok">OK / OK</td><td class="ok">OK / OK</td><td class="ok">pion が選んだ remote は常に werift の host</td></tr>
  <tr><td class="l">pion v4.2.26 × werift 0.27（比較）</td><td>offer / answer</td><td class="ok">OK / OK</td><td class="ok">OK / OK</td><td class="ok">OK / OK</td><td class="warn">VPN 構成で prflx</td></tr>
  <tr><td class="l">新 werift ⇔ 新 werift</td><td>両方向</td><td class="ok">OK</td><td class="ok">OK</td><td class="ok">OK</td><td class="ok">0 / 0</td></tr>
  <tr><td class="l">新 werift ⇔ werift 0.27 / develop</td><td>両方向</td><td class="ok">OK</td><td class="ok">OK</td><td class="ok">OK</td><td class="ok">新 werift 側に出る prflx は 0.27 / develop の送信元不一致によるもの</td></tr>
  <tr><td class="l">新 werift ⇔ werift 0.22.9</td><td>両方向</td><td class="ok">OK</td><td class="ok">OK</td><td class="ng">タイムアウト</td><td class="l">0.22⇔0.22 / 0.22⇔develop / 0.22⇔0.27 でも同じくタイムアウトする（0.22 の既存の制約）</td></tr>
</table>

上の表は、各段階で行った確認を合わせたものです。最終コード（公開アドレスへのフォールバック廃止後）では、次の 20 通りを再確認し、すべて OK でした。新 werift 同士と Chrome の prflx は 0 です。

- werift 新⇔0.27（両方向）と新⇔新：STUN あり / ICE server なしの両方で実施。
- Chrome / pion × offer / answer：STUN ありで実施。
- 構成：実 NIC と、外へ出られない二次 NIC あり。

Chrome / pion の 3 構成 24 通りは、経路ゲートを入れた時点のコードで実施しました。werift 同士の 21 通り（0.22.9 を含む）は、追加要件の実装時点で実施しました。
