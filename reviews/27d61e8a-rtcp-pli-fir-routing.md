---
ide:
  viewer: review-document
  version: 1
  title: "RTCP PLI/FIR を media SSRC で配送する — レビュー解説"
  dock: right
  baseCommit: 8b2366c00837f5b53519a49b8e54ed46bbdc326d
---
# RTCP PLI/FIR を media SSRC で配送する

## 概要

PLI / FIR の配送先を「フィードバックを送った SSRC」ではなく「要求対象のメディア SSRC」に変更しました。あわせて `RTCRtpSender` が FIR を解釈し、`firCount` と新しい公開 Event でアプリへ通知できるようにしました。

<div style="display:flex;gap:10px;flex-wrap:wrap;margin:8px 0 4px">
  <div style="flex:1;min-width:150px;padding:10px 14px;border:1px solid var(--review-border);border-radius:8px;background:var(--review-surface)">
    <div style="font-size:11px;letter-spacing:.08em;color:var(--review-muted)">ROUTING</div>
    <div style="font-size:20px;font-weight:700;color:var(--review-accent)">media SSRC</div>
    <div style="font-size:12px;color:var(--review-muted)">PLI は media、FIR は FCI</div>
  </div>
  <div style="flex:1;min-width:150px;padding:10px 14px;border:1px solid var(--review-border);border-radius:8px;background:var(--review-surface)">
    <div style="font-size:11px;letter-spacing:.08em;color:var(--review-muted)">SENDER API</div>
    <div style="font-size:20px;font-weight:700;color:var(--review-accent)">2 Events</div>
    <div style="font-size:12px;color:var(--review-muted)">onFullIntraRequest / onKeyFrameRequest</div>
  </div>
  <div style="flex:1;min-width:150px;padding:10px 14px;border:1px solid var(--review-border);border-radius:8px;background:var(--review-surface)">
    <div style="font-size:11px;letter-spacing:.08em;color:var(--review-muted)">COMPATIBILITY</div>
    <div style="font-size:20px;font-weight:700;color:var(--review-success)">Non-breaking</div>
    <div style="font-size:12px;color:var(--review-muted)">既存 Event / stats は不変</div>
  </div>
  <div style="flex:1;min-width:150px;padding:10px 14px;border:1px solid var(--review-border);border-radius:8px;background:var(--review-surface)">
    <div style="font-size:11px;letter-spacing:.08em;color:var(--review-muted)">TARGETED TESTS</div>
    <div style="font-size:20px;font-weight:700;color:var(--review-success)">57 / 57</div>
    <div style="font-size:12px;color:var(--review-muted)">router + sender + sendrecv</div>
  </div>
</div>

変更の中心は [packages/webrtc/src/media/router.ts:389](review-file:packages/webrtc/src/media/router.ts:389) の PSFB 分岐です。差分は [packages/webrtc/src/media/router.ts](review-diff:packages/webrtc/src/media/router.ts:commit:fcfe4833) で確認できます。

## 変更前後の比較

<div class="pli-tabs">
  <div style="display:flex;gap:6px;margin-bottom:10px">
    <button role="tab" aria-selected="true" data-panel="before" style="border:1px solid var(--review-border);background:var(--review-surface);color:var(--review-fg);padding:4px 12px;border-radius:6px;cursor:pointer">Before（sender-first）</button>
    <button role="tab" aria-selected="false" data-panel="after" style="border:1px solid var(--review-border);background:var(--review-surface);color:var(--review-fg);padding:4px 12px;border-radius:6px;cursor:pointer">After（media-targeted）</button>
  </div>
  <div role="tabpanel" data-panel="before">
    <div style="padding:12px 14px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:8px;background:var(--review-surface)">
      <strong style="color:var(--review-danger)">senderSsrc を先に lookup</strong>
      <div style="font-family:monospace;font-size:12px;margin:8px 0;color:var(--review-fg)">ssrcTable[senderSsrc] || ssrcTable[mediaSsrc]</div>
      <div style="font-size:13px;color:var(--review-muted)">送信元 SSRC が別の local stream（自分の sender / 受信 receiver）に一致すると、そちらへ誤配送。対象 sender には PLI が届かず <code>onPictureLossIndication</code> も発火しない。</div>
    </div>
  </div>
  <div role="tabpanel" data-panel="after" hidden>
    <div style="padding:12px 14px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:8px;background:var(--review-surface)">
      <strong style="color:var(--review-success)">要求対象だけで lookup</strong>
      <div style="font-family:monospace;font-size:12px;margin:8px 0;color:var(--review-fg)">PLI: ssrcTable[mediaSsrc]<br>FIR: ssrcTable[fir[i].ssrc]</div>
      <div style="font-size:13px;color:var(--review-muted)">senderSsrc は配送判定に使わない。未登録の media SSRC は配送しない（sender へのフォールバックなし）。</div>
    </div>
  </div>
</div>

<script>
  document.querySelectorAll(".pli-tabs [role=tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".pli-tabs [role=tab]").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
      document.querySelectorAll(".pli-tabs [role=tabpanel]").forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.panel; });
    });
  });
</script>

## なぜ問題になるか（sendrecv の具体例）

werift 同士の sendrecv video では、PLI の `senderSsrc` に「PLI を送った側の送信 SSRC」が入ります。受信側 router の `ssrcTable` には、相手から受ける SSRC（receiver）も登録されているため、旧実装では PLI が自分の receiver に吸われていました。

<svg viewBox="0 0 720 250" width="100%" role="img" aria-label="sendrecv PLI misrouting">
  <defs>
    <marker id="pli-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="var(--review-accent)"/></marker>
    <marker id="wrong-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="var(--review-danger)"/></marker>
    <marker id="ok-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="var(--review-success)"/></marker>
  </defs>
  <rect x="10" y="20" width="290" height="200" rx="10" fill="none" stroke="var(--review-border)"/>
  <rect x="420" y="20" width="290" height="200" rx="10" fill="none" stroke="var(--review-border)"/>
  <text x="155" y="44" text-anchor="middle" font-size="13" font-weight="700" fill="var(--review-fg)">Peer 1</text>
  <text x="565" y="44" text-anchor="middle" font-size="13" font-weight="700" fill="var(--review-fg)">Peer 2</text>
  <rect x="40" y="62" width="110" height="40" rx="6" fill="var(--review-surface)" stroke="var(--review-border)"/>
  <text x="95" y="87" text-anchor="middle" font-size="12" fill="var(--review-fg)">sender (video)</text>
  <rect x="180" y="62" width="100" height="40" rx="6" fill="var(--review-surface)" stroke="var(--review-danger)"/>
  <text x="230" y="87" text-anchor="middle" font-size="12" fill="var(--review-fg)">receiver</text>
  <rect x="470" y="62" width="110" height="40" rx="6" fill="var(--review-surface)" stroke="var(--review-border)"/>
  <text x="525" y="87" text-anchor="middle" font-size="12" fill="var(--review-fg)">sender (video)</text>
  <rect x="610" y="62" width="80" height="40" rx="6" fill="var(--review-surface)" stroke="var(--review-border)"/>
  <text x="650" y="87" text-anchor="middle" font-size="12" fill="var(--review-fg)">receiver</text>
  <line x1="610" y1="120" x2="300" y2="120" stroke="var(--review-accent)" stroke-width="2" marker-end="url(#pli-arrow)"/>
  <text x="455" y="112" text-anchor="middle" font-size="12" fill="var(--review-accent)">PLI: senderSsrc = Peer2 の送信 SSRC / mediaSsrc = Peer1 の送信 SSRC</text>
  <path d="M 300 140 C 260 170, 250 150, 232 108" fill="none" stroke="var(--review-danger)" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#wrong-arrow)"/>
  <text x="205" y="172" text-anchor="middle" font-size="11" fill="var(--review-danger)">旧: senderSsrc が receiver に一致 → 誤配送</text>
  <path d="M 300 140 C 250 195, 150 195, 96 108" fill="none" stroke="var(--review-success)" stroke-width="2" marker-end="url(#ok-arrow)"/>
  <text x="110" y="215" text-anchor="middle" font-size="11" fill="var(--review-success)">新: mediaSsrc の sender へ</text>
</svg>

この経路は SFU / relay でも同様に問題になります。viewer の RTCP sender SSRC が viewer 自身の stream と一致し、転送対象の video slot ではなく別 endpoint に PLI が届いていました。

## 配送ロジック

<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
  <div style="padding:12px 14px;border:1px solid var(--review-border);border-radius:8px;background:var(--review-surface)">
    <div style="font-size:12px;letter-spacing:.08em;color:var(--review-accent);font-weight:700">PLI (FMT=1)</div>
    <ol style="margin:8px 0 0;padding-left:18px;font-size:13px;line-height:1.7;color:var(--review-fg)">
      <li><code>mediaSsrc</code> だけで <code>ssrcTable</code> を引く</li>
      <li>未登録なら配送しない</li>
      <li><code>senderSsrc</code> へはフォールバックしない</li>
    </ol>
  </div>
  <div style="padding:12px 14px;border:1px solid var(--review-border);border-radius:8px;background:var(--review-surface)">
    <div style="font-size:12px;letter-spacing:.08em;color:var(--review-accent);font-weight:700">FIR (FMT=4)</div>
    <ol style="margin:8px 0 0;padding-left:18px;font-size:13px;line-height:1.7;color:var(--review-fg)">
      <li>Common header の <code>mediaSsrc</code> は使わない（通常 0）</li>
      <li>FCI の各 <code>fir[].ssrc</code> で引く</li>
      <li><code>Set</code> で recipient を重複排除</li>
      <li>FCI が空なら非 0 の <code>mediaSsrc</code> のみ fallback</li>
    </ol>
  </div>
</div>

実装は [packages/webrtc/src/media/router.ts:397](review-file:packages/webrtc/src/media/router.ts:397)（PLI）と [packages/webrtc/src/media/router.ts:401](review-file:packages/webrtc/src/media/router.ts:401)（FIR）です。未知 FMT は [packages/webrtc/src/media/router.ts:389](review-file:packages/webrtc/src/media/router.ts:389) で `feedback` 未定義をガードし、例外ではなく「配送しない」にしています。

<svg viewBox="0 0 720 220" width="100%" role="img" aria-label="FIR FCI routing with dedupe">
  <rect x="10" y="80" width="150" height="60" rx="8" fill="var(--review-surface)" stroke="var(--review-border)"/>
  <text x="85" y="105" text-anchor="middle" font-size="12" fill="var(--review-fg)">FIR packet</text>
  <text x="85" y="123" text-anchor="middle" font-size="11" fill="var(--review-muted)">mediaSsrc = 0</text>
  <rect x="200" y="25" width="210" height="170" rx="8" fill="none" stroke="var(--review-border)"/>
  <text x="305" y="46" text-anchor="middle" font-size="12" font-weight="700" fill="var(--review-fg)">FCI entries</text>
  <rect x="220" y="58" width="170" height="30" rx="5" fill="var(--review-surface)" stroke="var(--review-accent)"/>
  <text x="305" y="78" text-anchor="middle" font-size="11" fill="var(--review-fg)">ssrc = B, seq = 1</text>
  <rect x="220" y="96" width="170" height="30" rx="5" fill="var(--review-surface)" stroke="var(--review-accent)"/>
  <text x="305" y="116" text-anchor="middle" font-size="11" fill="var(--review-fg)">ssrc = C, seq = 1</text>
  <rect x="220" y="134" width="170" height="30" rx="5" fill="var(--review-surface)" stroke="var(--review-muted)"/>
  <text x="305" y="154" text-anchor="middle" font-size="11" fill="var(--review-muted)">ssrc = B, seq = 1（重複）</text>
  <text x="305" y="183" text-anchor="middle" font-size="11" fill="var(--review-muted)">Set で 1 recipient に集約</text>
  <line x1="160" y1="110" x2="200" y2="110" stroke="var(--review-muted)" stroke-width="2" marker-end="url(#pli-arrow)"/>
  <line x1="410" y1="73" x2="470" y2="73" stroke="var(--review-success)" stroke-width="2" marker-end="url(#ok-arrow)"/>
  <line x1="410" y1="111" x2="470" y2="111" stroke="var(--review-success)" stroke-width="2" marker-end="url(#ok-arrow)"/>
  <rect x="470" y="52" width="110" height="42" rx="6" fill="var(--review-surface)" stroke="var(--review-success)"/>
  <text x="525" y="78" text-anchor="middle" font-size="12" fill="var(--review-fg)">sender B ×1</text>
  <rect x="470" y="104" width="110" height="42" rx="6" fill="var(--review-surface)" stroke="var(--review-success)"/>
  <text x="525" y="130" text-anchor="middle" font-size="12" fill="var(--review-fg)">sender C ×1</text>
  <rect x="610" y="78" width="100" height="42" rx="6" fill="none" stroke="var(--review-border)" stroke-dasharray="4 3"/>
  <text x="660" y="104" text-anchor="middle" font-size="11" fill="var(--review-muted)">sender A には<br>届かない</text>
</svg>

## Sender 側の FIR 解釈

router が正しく届けても、旧 `RTCRtpSender` は PSFB のうち REMB と PLI しか処理していませんでした。そのため FIR は `onRtcp` に流れるだけで、`firCount` も増えず、アプリから FIR を検知できませんでした。

<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
  <div style="padding:12px 14px;border:1px solid var(--review-border);border-left:4px solid var(--review-warning);border-radius:8px;background:var(--review-surface)">
    <strong>firCount の数え方</strong>
    <div style="font-size:13px;color:var(--review-muted);margin-top:4px">自分宛 FCI エントリ 1 つにつき 1 増やす。再送も数える（libwebrtc と同じ）。</div>
  </div>
  <div style="padding:12px 14px;border:1px solid var(--review-border);border-left:4px solid var(--review-accent);border-radius:8px;background:var(--review-surface)">
    <strong>Event の発火条件</strong>
    <div style="font-size:13px;color:var(--review-muted);margin-top:4px">FIR 送信元（<code>senderSsrc</code>）ごとに最後の Seq nr を保持し、新しいときだけ発火。同じ Seq nr の再送では発火しない。</div>
  </div>
</div>

<svg viewBox="0 0 720 250" width="100%" role="img" aria-label="FIR sequence timeline">
  <line x1="30" y1="150" x2="690" y2="150" stroke="var(--review-border)" stroke-width="2"/>
  <g font-size="11" fill="var(--review-muted)" text-anchor="middle">
    <text x="90" y="180">PLI</text>
    <text x="250" y="180">FIR seq=1</text>
    <text x="410" y="180">FIR seq=1（再送）</text>
    <text x="570" y="180">FIR seq=2</text>
  </g>
  <g>
    <circle cx="90" cy="150" r="7" fill="var(--review-accent)"/>
    <circle cx="250" cy="150" r="7" fill="var(--review-success)"/>
    <circle cx="410" cy="150" r="7" fill="var(--review-muted)"/>
    <circle cx="570" cy="150" r="7" fill="var(--review-success)"/>
  </g>
  <g font-size="11" text-anchor="middle">
    <text x="90" y="125" fill="var(--review-accent)">"pli"</text>
    <text x="250" y="125" fill="var(--review-success)">"fir"</text>
    <text x="410" y="125" fill="var(--review-muted)">発火なし</text>
    <text x="570" y="125" fill="var(--review-success)">"fir"</text>
  </g>
  <g font-size="11" text-anchor="middle" fill="var(--review-muted)">
    <text x="90" y="210">pliCount++</text>
    <text x="250" y="210">firCount++</text>
    <text x="410" y="210">firCount++</text>
    <text x="570" y="210">firCount++</text>
  </g>
  <text x="360" y="235" text-anchor="middle" font-size="11" fill="var(--review-fg)">onKeyFrameRequest の発火列: ["pli"] → ["fir"] → ["fir"]</text>
</svg>

実装は [packages/webrtc/src/media/rtpSender.ts:892](review-file:packages/webrtc/src/media/rtpSender.ts:892) から始まる FIR 分岐、Seq nr の状態は [packages/webrtc/src/media/rtpSender.ts:195](review-file:packages/webrtc/src/media/rtpSender.ts:195) です。差分は [packages/webrtc/src/media/rtpSender.ts](review-diff:packages/webrtc/src/media/rtpSender.ts:commit:fcfe4833) にあります。

## 公開 API

<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
  <div style="padding:12px 14px;border:1px solid var(--review-border);border-radius:8px;background:var(--review-surface)">
    <div style="font-family:monospace;font-size:12px;color:var(--review-accent)">onFullIntraRequest</div>
    <div style="font-size:13px;color:var(--review-muted);margin-top:6px"><code>Event&lt;[FullIntraRequest]&gt;</code>。自分宛の FIR で、Seq nr が新しいときだけ発火。payload から <code>fir[]</code> を読める。</div>
  </div>
  <div style="padding:12px 14px;border:1px solid var(--review-border);border-radius:8px;background:var(--review-surface)">
    <div style="font-family:monospace;font-size:12px;color:var(--review-accent)">onKeyFrameRequest</div>
    <div style="font-size:13px;color:var(--review-muted);margin-top:6px"><code>Event&lt;["pli" | "fir"]&gt;</code>。PLI は毎回、FIR は再送を除いて発火。キーフレーム要求だけを扱うアプリ向けの統合 Event。</div>
  </div>
</div>

- 宣言は [packages/webrtc/src/media/rtpSender.ts:157](review-file:packages/webrtc/src/media/rtpSender.ts:157) と [packages/webrtc/src/media/rtpSender.ts:162](review-file:packages/webrtc/src/media/rtpSender.ts:162)。統合 Event の差分は [packages/webrtc/src/media/rtpSender.ts](review-diff:packages/webrtc/src/media/rtpSender.ts:commit:8b2366c0) です。
- `onPictureLossIndication` / `pliCount` / `firCount` の既存契約は変えていません。PLI だけ、FIR だけを購読する既存アプリはそのまま動きます。
- `FullIntraRequest` を [packages/rtp/src/index.ts:8](review-file:packages/rtp/src/index.ts:8) から export しました。Event の型引数を利用者が参照できます。
- ドキュメントは [doc/classes/RTCRtpSender.md:49](review-file:doc/classes/RTCRtpSender.md:49) と [doc/classes/RTCRtpSender.md:63](review-file:doc/classes/RTCRtpSender.md:63) に反映済みです。

`onKeyFrameRequest` はレビュー中の要望で追加したもので、元チケットの「統合 Event は今回は作らない」という判断を更新しています。既存 Event を置き換えず追加のみなので、互換性への影響はありません。

## example の移行

`sendrecv` example は PLI / FIR の両方で上流へキーフレーム要求を出す必要があります。個別 Event の二重購読ではなく、統合 Event 1 つに移行しました。

```ts
video.sender.onKeyFrameRequest.subscribe(() =>
  video.receiver.sendRtcpPLI(track.ssrc),
);
```

該当箇所は [examples/mediachannel/sendrecv/offer.ts:28](review-file:examples/mediachannel/sendrecv/offer.ts:28)、差分は [examples/mediachannel/sendrecv/offer.ts](review-diff:examples/mediachannel/sendrecv/offer.ts:commit:8b2366c0) です。この example は `examples/e2e` の `sendrecv-offer` カタログに含まれます。

## テストの見取り図

<div style="overflow-x:auto">
<table style="width:100%;border-collapse:collapse;font-size:13px">
  <thead>
    <tr style="border-bottom:1px solid var(--review-border);text-align:left">
      <th style="padding:8px 10px">観点</th>
      <th style="padding:8px 10px">テスト</th>
      <th style="padding:8px 10px">確認内容</th>
    </tr>
  </thead>
  <tbody>
    <tr style="border-bottom:1px solid var(--review-border)">
      <td style="padding:8px 10px;color:var(--review-accent)">PLI 配送</td>
      <td style="padding:8px 10px;font-family:monospace;font-size:12px">router.test.ts:100</td>
      <td style="padding:8px 10px;color:var(--review-muted)">senderSsrc が別 stream でも mediaSsrc の sender に届く</td>
    </tr>
    <tr style="border-bottom:1px solid var(--review-border)">
      <td style="padding:8px 10px;color:var(--review-accent)">PLI 未登録</td>
      <td style="padding:8px 10px;font-family:monospace;font-size:12px">router.test.ts:123</td>
      <td style="padding:8px 10px;color:var(--review-muted)">mediaSsrc 未登録なら senderSsrc にフォールバックしない</td>
    </tr>
    <tr style="border-bottom:1px solid var(--review-border)">
      <td style="padding:8px 10px;color:var(--review-accent)">FIR 配送</td>
      <td style="padding:8px 10px;font-family:monospace;font-size:12px">router.test.ts:138 / 158</td>
      <td style="padding:8px 10px;color:var(--review-muted)">mediaSsrc=0、複数 FCI、重複 FCI、未登録 SSRC</td>
    </tr>
    <tr style="border-bottom:1px solid var(--review-border)">
      <td style="padding:8px 10px;color:var(--review-accent)">回帰</td>
      <td style="padding:8px 10px;font-family:monospace;font-size:12px">router.test.ts:183 / 203 / 227</td>
      <td style="padding:8px 10px;color:var(--review-muted)">FCI 空 fallback、REMB、未知 FMT で例外なし</td>
    </tr>
    <tr style="border-bottom:1px solid var(--review-border)">
      <td style="padding:8px 10px;color:var(--review-success)">Sender FIR</td>
      <td style="padding:8px 10px;font-family:monospace;font-size:12px">rtpSender.test.ts:1256 / 1280</td>
      <td style="padding:8px 10px;color:var(--review-muted)">firCount、onFullIntraRequest、Seq nr 再送の重複除去</td>
    </tr>
    <tr style="border-bottom:1px solid var(--review-border)">
      <td style="padding:8px 10px;color:var(--review-success)">Sender 分離</td>
      <td style="padding:8px 10px;font-family:monospace;font-size:12px">rtpSender.test.ts:1308 / 1330 / 1353</td>
      <td style="padding:8px 10px;color:var(--review-muted)">他人宛 FIR、onKeyFrameRequest、PLI/FIR の相互非干渉</td>
    </tr>
    <tr>
      <td style="padding:8px 10px;color:var(--review-success)">E2E</td>
      <td style="padding:8px 10px;font-family:monospace;font-size:12px">mediaChannel.test.ts:167</td>
      <td style="padding:8px 10px;color:var(--review-muted)">werift 同士 sendrecv video で PLI が sender に届く</td>
    </tr>
  </tbody>
</table>
</div>

Arrange は [packages/webrtc/tests/fixture.ts:188](review-file:packages/webrtc/tests/fixture.ts:188) の `createRtcpFeedbackRouter` に集約し、PLI / FIR packet 生成と sendrecv peer 構築も同じファイルに置いています。テストは Arrange / Act / Assert の3段構成で、Act / Assert に日本語コメントを付けています。

## リスクと判断ポイント

<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
  <div style="padding:12px 14px;border:1px solid var(--review-border);border-left:4px solid var(--review-warning);border-radius:8px;background:var(--review-surface)">
    <strong>挙動変更</strong>
    <div style="font-size:13px;color:var(--review-muted);margin-top:4px">senderSsrc が偶然一致して届いていた PLI は届かなくなる。RFC 上は誤りで、changelog に明記済み。</div>
  </div>
  <div style="padding:12px 14px;border:1px solid var(--review-border);border-left:4px solid var(--review-warning);border-radius:8px;background:var(--review-surface)">
    <strong>未知 FMT</strong>
    <div style="font-size:13px;color:var(--review-muted);margin-top:4px">SLI / RPSI などは配送しない。従来の TypeError は解消するが、これらの feedback は転送されない。</div>
  </div>
  <div style="padding:12px 14px;border:1px solid var(--review-border);border-left:4px solid var(--review-warning);border-radius:8px;background:var(--review-surface)">
    <strong>FIR Seq nr の状態</strong>
    <div style="font-size:13px;color:var(--review-muted);margin-top:4px">送信元 SSRC ごとに保持。negotiation の snapshot / rollback 対象外（packet 由来の状態）。transceiver stop で破棄される。</div>
  </div>
  <div style="padding:12px 14px;border:1px solid var(--review-border);border-left:4px solid var(--review-warning);border-radius:8px;background:var(--review-surface)">
    <strong>RTX / simulcast</strong>
    <div style="font-size:13px;color:var(--review-muted);margin-top:4px">RTX SSRC は sender 登録されないため、RTX SSRC 宛の PLI/FIR は対象外。simulcast は現状単一 SSRC。</div>
  </div>
</div>

配送先を `RTCRtpSender` 型に限定するフィルタは入れていません。`ssrcTable` の値をそのまま使い、sender にのみ届くことをテストで確認する方針です（simulcast / RTX の将来変更と衝突しにくくするため）。

## 検証結果

今回の作業時点（HEAD `8b2366c0`、作業ツリー clean）で次を実行し、すべて成功しました。

- `packages/webrtc`: `npm run type` 成功。`router.test.ts` / `rtpSender.test.ts` / `mediaChannel.test.ts` の **3 ファイル・57 テスト**成功。
- `packages/rtp`: `npm run type` 成功。`npm test` で **39 ファイル・348 テスト**成功。
- `examples/e2e`: `npm run type` 成功。

未実施の検証:

- `packages/webrtc` の全テストスイート（今回のドキュメント作成では対象3ファイルのみ）。
- `npm run examples:e2e`（Chromium を使う `sendrecv-offer` カタログ）。example の変更は購読の書き換えのみで、型チェックは通過していますが、ブラウザ実行は未確認です。
- ルートの `npm run ci`、`npm run test:small`、WPT。今回の変更は WPT runner に触れておらず、PLI/FIR の配送は WebRTC / RTP のテストで確認しています。

## まとめ

- PLI は `mediaSsrc`、FIR は FCI の `ssrc` で配送し、sender-first の誤配送を解消しました。
- `RTCRtpSender` が FIR を `firCount` と `onFullIntraRequest` に反映し、`onKeyFrameRequest` で PLI / FIR を統合して購読できます。
- 既存 Event と stats の契約は維持し、example は統合 Event に移行しました。
- 配送・重複排除・再送・回帰・sendrecv のテストが揃っています。
