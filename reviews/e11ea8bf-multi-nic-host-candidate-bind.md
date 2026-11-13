---
ide:
  viewer: review-document
  version: 1
  title: "#814 複数NICでhost candidateと送信元IPを一致させる（最新版）"
  dock: right
  baseCommit: 77fc625d11972a466876316fd9e525012d8fcb1a
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
| 既定経路を調べるプローブ | なし | 設定した STUN / TURN server への経路だけを調べる。server がなければ調べない。パケットは送らない |

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

### 3.1 gathering の完了は代表ソケットで判定し、残りは trickle する

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

### 3.2 wildcard ソケットは「どの host ソケットも覆っていない経路」だけを check する

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

### 3.3 host の優先順：既定経路、通常 NIC、VPN NIC

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

### 3.4 既定経路の決め方：3 段階の変遷と最終仕様

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

- ice の主な差分は [packages/ice/src/ice.ts](review-diff:packages/ice/src/ice.ts:commit:fc1f6e81e) です。内容は §3.1 から §3.3 の図に対応します。
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
