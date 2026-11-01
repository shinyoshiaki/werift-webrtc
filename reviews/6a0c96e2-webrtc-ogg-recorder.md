---
ide:
  viewer: review-document
  version: 1
  title: "MediaRecorder の Ogg Opus 対応レビュー"
  dock: right
  baseCommit: 4b4135f19adc06bcd843c8d6fdf9137f81e43b02
---
# MediaRecorder の Ogg Opus 対応レビュー

## 1. 概要

非標準 `MediaRecorder` が、WebM に加えて **Ogg Opus（RFC 7845）** を書き出せるようになりました。Opus 音声 1 トラックを録音します。指定方法は次の 2 つです。

- `path` の拡張子を `.ogg` / `.opus` にする。
- `format: "ogg"` と `stream` を組み合わせる。

実装は 3 つの層に分けて追加しました。

- コンテナ層: Ogg ページを作る。
- プロセッサ層: granule position（再生位置）の管理、ギャップの補完、ページへのまとめ。
- `webrtc` の Writer: RTP を受けて上の 2 層へ渡す。

再レビューでの指摘を受けて、並べ替えに使う共通部品 `JitterBufferBase` も書き直しました。この部品は WebM の映像録画でも使われているため、影響は WebM にも及びます。

次の図は録音経路の全体です。枠線を強調したものは、このチケットで追加・修正した部品です。

<div class="ogg-pipe">
<style>
  .ogg-pipe .row { display:flex; gap:6px; align-items:stretch; flex-wrap:wrap; }
  .ogg-pipe .box { flex:1; min-width:120px; padding:8px; border:1px solid var(--review-border); border-radius:6px; background:var(--review-surface); color:var(--review-fg); font-size:13px; }
  .ogg-pipe .box.new { border:2px solid var(--review-accent); }
  .ogg-pipe .box small { color:var(--review-muted); display:block; margin-top:4px; }
  .ogg-pipe .arrow { align-self:center; color:var(--review-muted); }
  .ogg-pipe .layer { font-size:11px; color:var(--review-muted); margin:10px 0 4px; }
</style>
<div class="layer">packages/webrtc（OggFactory が組み立てる）</div>
<div class="row">
  <div class="box">RTP / RTCP<small>MediaStreamTrack から購読</small></div><div class="arrow">→</div>
  <div class="box new"><strong>JitterBuffer</strong><small>seq 順に並べ替え（書き直し）</small></div><div class="arrow">→</div>
  <div class="box">Ntp / RtpTime<small>RTP 時刻 → ms</small></div><div class="arrow">→</div>
  <div class="box">Depacketize("OPUS")<small>フレーム化</small></div>
</div>
<div class="layer">packages/rtp</div>
<div class="row">
  <div class="box new"><strong>OggCallback / OggBase</strong><small>遅着破棄・ギャップ補完・granule 管理</small></div><div class="arrow">→</div>
  <div class="box new"><strong>OggPager</strong><small>lacing・ページ分割・CRC</small></div><div class="arrow">→</div>
  <div class="box new"><strong>saveOggToFileSystem</strong><small>初回は置き換え、以降は追記</small></div>
</div>
</div>

## 2. 主要変更

### 2.1 rtp: コンテナ層（Ogg ページの生成）

- [packages/rtp/src/extra/container/ogg/writer.ts:104](review-file:packages/rtp/src/extra/container/ogg/writer.ts:104) の `OggPager` が、ページの生成を担当します。
  - lacing（パケットを 255 バイト単位のセグメントに分けること）
  - BOS / EOS / continued のフラグ
  - ページの分割。1 ページに入るのは最大 255 セグメントで、超えたパケットは次のページに続きます。
- [packages/rtp/src/extra/container/ogg/writer.ts:35](review-file:packages/rtp/src/extra/container/ogg/writer.ts:35) の `oggCrc32` は、Ogg 専用の CRC です（多項式 0x04c11db7、非反転）。`common` の zlib 系 `crc32` とは計算方法が違うため流用できず、ogg 配下に置きました。
- 同じファイルに、次の関数もあります。
  - `createOpusHead` / `createOpusTags`
  - [packages/rtp/src/extra/container/ogg/writer.ts:255](review-file:packages/rtp/src/extra/container/ogg/writer.ts:255) の `getOpusPacketSamples`（TOC からフレームの長さを求める）

出力ファイルのページ構成は次のとおりです。

<div class="ogg-pages">
<style>
  .ogg-pages .row { display:flex; gap:4px; flex-wrap:wrap; font-size:12px; }
  .ogg-pages .pg { padding:6px 8px; border:1px solid var(--review-border); border-radius:4px; background:var(--review-surface); color:var(--review-fg); text-align:center; min-width:70px; }
  .ogg-pages .pg b { display:block; font-size:11px; color:var(--review-muted); font-weight:normal; }
  .ogg-pages .hdr { border-color:var(--review-accent); }
  .ogg-pages .eos { border-color:var(--review-warning); }
</style>
<div class="row">
  <div class="pg hdr"><b>page 0 · BOS</b>OpusHead</div>
  <div class="pg hdr"><b>page 1〜</b>OpusTags</div>
  <div class="pg"><b>page n</b>音声 約 1 秒</div>
  <div class="pg"><b>page n+1</b>音声 約 1 秒</div>
  <div class="pg"><b>…</b>…</div>
  <div class="pg eos"><b>最終 · EOS</b>残りの音声</div>
</div>
</div>

### 2.2 rtp: プロセッサ層（granule position とギャップ補完）

[packages/rtp/src/extra/processor/ogg.ts:69](review-file:packages/rtp/src/extra/processor/ogg.ts:69) の `OggBase` は、届いたフレームを次の 3 段階で処理します（[packages/rtp/src/extra/processor/ogg.ts:142](review-file:packages/rtp/src/extra/processor/ogg.ts:142)）。

<div class="ogg-frame">
<style>
  .ogg-frame .row { display:flex; gap:6px; flex-wrap:wrap; align-items:stretch; }
  .ogg-frame .st { flex:1; min-width:150px; padding:8px; border:1px solid var(--review-border); border-radius:6px; background:var(--review-surface); color:var(--review-fg); font-size:13px; }
  .ogg-frame .st i { display:block; font-style:normal; color:var(--review-muted); font-size:12px; margin-top:4px; }
  .ogg-frame .st.drop { border-left:4px solid var(--review-danger); }
  .ogg-frame .st.fill { border-left:4px solid var(--review-warning); }
  .ogg-frame .st.write { border-left:4px solid var(--review-success); }
  .ogg-frame .arrow { align-self:center; color:var(--review-muted); }
</style>
<div class="row">
  <div class="st drop"><strong>① 遅着・重複を捨てる</strong><i>入力時刻が、書き込み済みの範囲（position）に半分以上入っていれば破棄</i></div>
  <div class="arrow">→</div>
  <div class="st fill"><strong>② ギャップを埋める</strong><i>期待位置との差を、TOC だけの 1 バイトパケット（20 / 10 / 5 / 2.5 ms）で補完</i></div>
  <div class="arrow">→</div>
  <div class="st write"><strong>③ 書き込む</strong><i>サンプル数を加算し、granule = 格納サンプル数 としてページへ</i></div>
</div>
</div>

各段階の実装箇所:

- ①: [packages/rtp/src/extra/processor/ogg.ts:154](review-file:packages/rtp/src/extra/processor/ogg.ts:154)
- ②: [packages/rtp/src/extra/processor/ogg.ts:162](review-file:packages/rtp/src/extra/processor/ogg.ts:162)
- ③: [packages/rtp/src/extra/processor/ogg.ts:185](review-file:packages/rtp/src/extra/processor/ogg.ts:185)

1 バイトのパケットは、デコーダーが「欠落したフレーム」として扱います（RFC 6716 §3.2.1）。そのため DTX やパケットの欠落があっても、granule は単調に増え、再生時間がメディア時間に一致します。たとえば 20 ms のパケットが時刻 0 / 20 / 50 ms で届くと、40〜50 ms の 10 ms 分を補完し、全体は 70 ms になります。

<svg viewBox="0 0 560 70" width="100%" role="img" aria-label="ギャップ補完の例: 0, 20, 50ms のパケットの間に 10ms の補完が入る">
  <g font-size="11" fill="var(--review-muted)"><text x="20" y="12">0</text><text x="160" y="12">20</text><text x="300" y="12">40</text><text x="370" y="12">50</text><text x="510" y="12">70 ms</text></g>
  <rect x="20" y="20" width="140" height="28" rx="3" fill="var(--review-surface)" stroke="var(--review-success)"/>
  <rect x="160" y="20" width="140" height="28" rx="3" fill="var(--review-surface)" stroke="var(--review-success)"/>
  <rect x="300" y="20" width="70" height="28" rx="3" fill="var(--review-surface)" stroke="var(--review-warning)" stroke-dasharray="4 3"/>
  <rect x="370" y="20" width="140" height="28" rx="3" fill="var(--review-surface)" stroke="var(--review-success)"/>
  <g font-size="12" fill="var(--review-fg)" text-anchor="middle"><text x="90" y="39">pkt@0</text><text x="230" y="39">pkt@20</text><text x="335" y="39">補完10</text><text x="440" y="39">pkt@50</text></g>
  <text x="20" y="64" font-size="11" fill="var(--review-muted)">最後の granule = 70 ms × 48 = 3360</text>
</svg>

- `eol` を受け取ると、EOS フラグ付きの最終ページを出力し、続けて `eol.duration` を通知します（[packages/rtp/src/extra/processor/ogg.ts:206](review-file:packages/rtp/src/extra/processor/ogg.ts:206)）。
- `OggCallback` は、出力コールバック（ファイル書き込み）の失敗を `onError` で通知します（[packages/rtp/src/extra/processor/oggCallback.ts:17](review-file:packages/rtp/src/extra/processor/oggCallback.ts:17)）。未処理の Promise 拒否にはなりません。

### 2.3 rtp: JitterBuffer の書き直し

[packages/rtp/src/extra/processor/jitterBuffer.ts:33](review-file:packages/rtp/src/extra/processor/jitterBuffer.ts:33) の `JitterBufferBase` を、不変条件にもとづいて書き直しました。不変条件はクラスのコメント（[packages/rtp/src/extra/processor/jitterBuffer.ts:18](review-file:packages/rtp/src/extra/processor/jitterBuffer.ts:18)）に明記しています。

1. latency 未満の遅れで届いたパケットは、必ず 1 回だけ、seq 順に出力する。
2. 諦めるのは、実際に届かなかった seq だけ。欠落範囲ごとに `isPacketLost` を 1 回通知する。通知の位置は、欠落の直後のパケットの直前。`to` は欠落範囲の最後の seq。`eol` のときも通知する。
3. 出力位置は「タイムアウトした最大の seq」までしか進めない。その先のパケットはバッファに残して待つ。
4. uint16（seq）/ uint32（timestamp）の折り返しをまたいでも同じように動く。

**旧実装の問題:** 欠落がタイムアウトすると、出力位置を「今届いたパケット」まで一気に進めていました。そのため、まだ待っていた手前のパケットが重複扱いで捨てられていました。下の図は、seq 1 が欠落し、13 と 12 が入れ替わって届いた場合です。

<div class="jb-cmp">
<style>
  .jb-cmp .cards { display:flex; gap:12px; flex-wrap:wrap; }
  .jb-cmp .card { flex:1; min-width:260px; padding:8px 12px; border:1px solid var(--review-border); border-radius:6px; }
  .jb-cmp .before { border-left:4px solid var(--review-danger); }
  .jb-cmp .after { border-left:4px solid var(--review-success); }
  .jb-cmp .seqs { display:flex; flex-wrap:wrap; gap:3px; margin:6px 0; }
  .jb-cmp .s { width:26px; height:22px; line-height:22px; text-align:center; font-size:11px; border-radius:3px; border:1px solid var(--review-border); color:var(--review-fg); background:var(--review-surface); }
  .jb-cmp .lost { border-style:dashed; color:var(--review-muted); }
  .jb-cmp .gone { background:var(--review-danger); color:var(--review-bg); border-color:var(--review-danger); }
  .jb-cmp .note { font-size:12px; color:var(--review-muted); }
  .jb-cmp .arr { font-size:12px; color:var(--review-muted); margin-bottom:8px; }
</style>
<div class="arr">到着順: 0, 2, 3, …, 11, <b>13</b>, <b>12</b>, 14, …（1 は欠落。2 の待ち時間が 200 ms を超えるのは 13 が届いたとき）</div>
<div class="cards">
  <div class="card before"><strong>Before</strong>
    <div class="seqs" id="jb-before"></div>
    <div class="note">13 が届いた時点で位置を 13 まで進めた → 後から届いた 12 は「重複」として捨てられる。最大 seq が 0 だと、バッファ全体を捨てる不具合もあった。</div>
  </div>
  <div class="card after"><strong>After</strong>
    <div class="seqs" id="jb-after"></div>
    <div class="note">諦めるのはタイムアウトした 2 の手前（= 1）だけ。13 はバッファで待ち、12 が届くと 12 → 13 の順に出力。</div>
  </div>
</div>
</div>
<script>
  (function () {
    function draw(id, gone) {
      var el = document.getElementById(id);
      for (var i = 0; i <= 15; i++) {
        var d = document.createElement("div");
        d.className = "s" + (i === 1 ? " lost" : "") + (gone.indexOf(i) >= 0 ? " gone" : "");
        d.textContent = i === 1 ? "×" : String(i);
        d.title = i === 1 ? "欠落（isPacketLost で通知）" : gone.indexOf(i) >= 0 ? "受信したのに捨てられた" : "出力";
        el.appendChild(d);
      }
    }
    draw("jb-before", [12]);
    draw("jb-after", []);
  })();
</script>

修正後の処理の流れは、次のステップ送りで確認できます。

<div class="jb-steps">
<style>
  .jb-steps button { border:1px solid var(--review-border); background:var(--review-surface); color:var(--review-fg); padding:2px 10px; border-radius:4px; }
  .jb-steps ol { margin:8px 0; padding-left:20px; color:var(--review-muted); font-size:13px; }
  .jb-steps li[aria-current="step"] { color:var(--review-fg); font-weight:bold; }
</style>
<ol>
  <li aria-current="step">パケットを受け取る。出力済みの seq 以下か、すでにバッファにあれば破棄する（重複）。</li>
  <li>バッファに入れ、出力位置から連続している分を出力する（releaseContinuous）。</li>
  <li>今回の timestamp を基準に、待ち時間が latency を超えたパケットのうち最大の seq を探す（findLatestTimeoutSeqNum）。</li>
  <li>見つかったら、その seq までを seq 順に出力し、間の欠落ごとに isPacketLost を出す（releaseUntil）。その先はバッファに残す。</li>
  <li>バッファが上限を超えたら、新しく届いたパケットは捨てず、古い欠落を諦めて出力する。</li>
</ol>
<button data-dir="-1">前へ</button> <button data-dir="1">次へ</button>
</div>
<script>
  (function () {
    var root = document.querySelector(".jb-steps");
    var steps = Array.prototype.slice.call(root.querySelectorAll("li"));
    var cur = 0;
    root.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        cur = Math.min(steps.length - 1, Math.max(0, cur + Number(b.dataset.dir)));
        steps.forEach(function (s, i) { if (i === cur) s.setAttribute("aria-current", "step"); else s.removeAttribute("aria-current"); });
      });
    });
  })();
</script>

各ステップの実装箇所:

- 連続分の出力: [packages/rtp/src/extra/processor/jitterBuffer.ts:148](review-file:packages/rtp/src/extra/processor/jitterBuffer.ts:148)
- タイムアウトした seq までの出力と欠落通知: [packages/rtp/src/extra/processor/jitterBuffer.ts:165](review-file:packages/rtp/src/extra/processor/jitterBuffer.ts:165)
- タイムアウトの判定: [packages/rtp/src/extra/processor/jitterBuffer.ts:186](review-file:packages/rtp/src/extra/processor/jitterBuffer.ts:186)
- 変更の中心となる差分: [packages/rtp/src/extra/processor/jitterBuffer.ts:33](review-diff:packages/rtp/src/extra/processor/jitterBuffer.ts:33)

**テスト:** 指摘された入力列を 1 本ずつ足すのではなく、シード固定の疑似乱数で欠落・重複・入れ替わりを組み合わせ、不変条件そのものを確かめています。

- 開始 seq: 0 / 65000 / 65530 / 65534 / 65535
- 規模: 25 シード × 各 3000 パケット

修正前の実装でも、一時 worktree で同じテストを流しました。欠落通知の確認を外し、出力パケットだけを比べても 20 件が失敗しました（当時の報告による）。

### 2.4 webrtc: Writer と MediaRecorder

- [packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:26](review-file:packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:26) の `OggFactory` は、`WebmFactory` の音声経路から Lipsync を除いたものです。代わりに JitterBuffer を挟みます（[packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:134](review-file:packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:134)）。
- 次のトラックは、[packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:40](review-file:packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:40) で `WeriftError` にします: Opus 以外、video、2 本以上。
- [packages/webrtc/src/nonstandard/recorder/index.ts:122](review-file:packages/webrtc/src/nonstandard/recorder/index.ts:122) の `resolveFormat` が、拡張子と `format` からコンテナを決めます。

| 指定 | 結果 |
| --- | --- |
| `path: "a.ogg"` / `"a.opus"` | Ogg |
| `path: "a.webm"` | WebM |
| `stream` だけ（`format` なし） | WebM（従来どおり） |
| `stream` + `format: "ogg"` | Ogg |
| `path: "a.webm"` + `format: "ogg"` | `WeriftError`（拡張子と format が食い違う） |
| `path: "a.mp4"` | `WeriftError`（未対応の拡張子。以前は空の `Error`） |

- `StreamEvent<O = WebmOutput>` に型引数を足しました。型引数なしの `StreamEvent` は以前と同じ型です（[packages/webrtc/src/nonstandard/recorder/writer/index.ts](review-diff:packages/webrtc/src/nonstandard/recorder/writer/index.ts)）。

## 3. レビュー反復で直した問題（Before / After）

レビューで見つかった問題と、その修正です。それぞれ、修正前のコードでテストが失敗することを確認してから直しました。

### 3.1 書き込み失敗でプロセスが落ちる / 失敗後も購読が残る

<div class="wf">
<style>
  .wf .cards { display:flex; gap:12px; flex-wrap:wrap; }
  .wf .card { flex:1; min-width:240px; padding:8px 12px; border:1px solid var(--review-border); border-radius:6px; font-size:13px; color:var(--review-fg); }
  .wf .before { border-left:4px solid var(--review-danger); }
  .wf .after { border-left:4px solid var(--review-success); }
  .wf ol { margin:4px 0 0; padding-left:18px; }
</style>
<div class="cards">
  <div class="card before"><strong>Before</strong><ol><li>appendFile が ENOENT で reject</li><li>呼び出し元が Promise を受けていない</li><li>未処理の拒否 → Node.js プロセスが終了</li></ol></div>
  <div class="card after"><strong>After</strong><ol><li>OggCallback が拒否を受けて onError を発火</li><li>OggFactory が出力を破棄し、RTP / RTCP の購読を解除して rtpSource を止める</li><li>onEol で stop() の待ちを解き、MediaRecorder.onError に通知</li></ol></div>
</div>
</div>

実装箇所: [packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:103](review-file:packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:103)

### 3.2 pre-skip を指定すると長さがずれる

RFC 7845 では、pre-skip 分のサンプルも格納した音声に含まれ、デコーダーがその先頭分を捨てます。したがって granule は格納したサンプル数そのものです。再生時間は「格納サンプル数 − pre-skip」になります。

<svg viewBox="0 0 560 150" width="100%" role="img" aria-label="preSkip 312 で 48000 サンプルを格納した場合の granule と長さ">
  <g font-size="12" fill="var(--review-fg)">
    <text x="0" y="16">格納した音声 48,000 サンプル（20 ms × 50）</text>
  </g>
  <rect x="0" y="24" width="500" height="22" fill="var(--review-surface)" stroke="var(--review-border)"/>
  <rect x="0" y="24" width="20" height="22" fill="var(--review-warning)" opacity="0.6"/>
  <text x="26" y="40" font-size="11" fill="var(--review-muted)">← 先頭 312 はデコーダーが捨てる（pre-skip）</text>
  <g font-size="12">
    <text x="0" y="74" fill="var(--review-danger)">Before: granule = 48,000 + 312 = 48,312 / eol.duration = 1000 ms</text>
    <rect x="0" y="80" width="503" height="8" fill="var(--review-danger)" opacity="0.5"/>
    <text x="0" y="110" fill="var(--review-success)">After: granule = 48,000 / eol.duration = (48,000 − 312) ÷ 48 = 993.5 ms</text>
    <rect x="0" y="116" width="500" height="8" fill="var(--review-success)" opacity="0.5"/>
    <text x="0" y="144" fill="var(--review-muted)" font-size="11">ffmpeg でのデコード結果 47,688 サンプル = eol.duration と一致</text>
  </g>
</svg>

- 実装箇所: [packages/rtp/src/extra/processor/ogg.ts:110](review-file:packages/rtp/src/extra/processor/ogg.ts:110)、[packages/rtp/src/extra/processor/ogg.ts:192](review-file:packages/rtp/src/extra/processor/ogg.ts:192)
- 既定値は `preSkip: 0` です。RTP 由来の録音には encoder の準備用音声がなく、0 以外にすると本物の音声を削ってしまうためです。
- ffprobe の `duration` は pre-skip を含む値（= granule ÷ 48000）を返します。ffmpeg の libopus が書いたファイルでも同じ関係になることを確認しています。

### 3.3 `fillGaps: false` で重複パケットが入る

重複かどうかを「書き込んだサンプル数」で判定していたため、補完を無効にするとギャップ分だけ判定がずれていました。そこで、入力時刻の上でどこまで書いたか（`position`）を別に持つようにしました。下の表は、時刻 0 / 100 / 100 / 120 ms の 20 ms パケットを順に入れた例です。

<div class="pos-tbl">
<style>
  .pos-tbl table { border-collapse:collapse; font-size:12px; width:100%; color:var(--review-fg); }
  .pos-tbl th, .pos-tbl td { border:1px solid var(--review-border); padding:4px 6px; text-align:center; }
  .pos-tbl th { background:var(--review-surface); }
  .pos-tbl .ng { color:var(--review-danger); font-weight:bold; }
  .pos-tbl .ok { color:var(--review-success); font-weight:bold; }
</style>
<table>
  <tr><th>入力</th><th>Before: 比較相手（書いたサンプル数）</th><th>Before: 判定</th><th>After: 比較相手（position）</th><th>After: 判定</th></tr>
  <tr><td>0 ms</td><td>0</td><td>書く</td><td>0</td><td>書く</td></tr>
  <tr><td>100 ms</td><td>960（= 20 ms）</td><td>書く</td><td>960</td><td>書く → position = 100 + 20 ms</td></tr>
  <tr><td>100 ms（重複）</td><td>1920（= 40 ms）</td><td class="ng">書く（重複が入る）</td><td>5760（= 120 ms）</td><td class="ok">捨てる</td></tr>
  <tr><td>120 ms</td><td>…</td><td>書く</td><td>5760</td><td>書く</td></tr>
  <tr><td colspan="2">合計</td><td class="ng">80 ms</td><td></td><td class="ok">60 ms</td></tr>
</table>
</div>

実装箇所: [packages/rtp/src/extra/processor/ogg.ts:154](review-file:packages/rtp/src/extra/processor/ogg.ts:154)

### 3.4 長い vendor で OpusTags の先頭ページが失われる

<div class="tags">
<style>
  .tags .cards { display:flex; gap:12px; flex-wrap:wrap; }
  .tags .card { flex:1; min-width:240px; padding:8px 12px; border:1px solid var(--review-border); border-radius:6px; font-size:12px; color:var(--review-fg); }
  .tags .before { border-left:4px solid var(--review-danger); }
  .tags .after { border-left:4px solid var(--review-success); }
  .tags .row { display:flex; gap:3px; margin-top:6px; flex-wrap:wrap; }
  .tags .p { padding:4px 6px; border:1px solid var(--review-border); border-radius:3px; background:var(--review-surface); }
  .tags .x { text-decoration:line-through; color:var(--review-danger); border-color:var(--review-danger); border-style:dashed; }
</style>
<div class="cards">
  <div class="card before"><strong>Before</strong> — addPacket() が返したページを捨てていた
    <div class="row"><span class="p">Head</span><span class="p x">Tags(1/2)</span><span class="p">Tags(2/2)</span><span class="p">音声…</span></div>
    <div style="margin-top:6px;color:var(--review-muted)">ffprobe: Header processing failed</div>
  </div>
  <div class="card after"><strong>After</strong> — 途中で完成したページも初期出力に含める
    <div class="row"><span class="p">Head</span><span class="p">Tags(1/2)</span><span class="p">Tags(2/2)</span><span class="p">音声…</span></div>
    <div style="margin-top:6px;color:var(--review-muted)">65,536 バイトの vendor でも ffmpeg でエラーなくデコードできる</div>
  </div>
</div>
</div>

実装箇所: [packages/rtp/src/extra/processor/ogg.ts:122](review-file:packages/rtp/src/extra/processor/ogg.ts:122)

### 3.5 開始に失敗した後の `stop()` が 5 秒待つ

`stop()` は「録音の終了通知をまだ受けていない」ときに最大 5 秒待っていました。開始に失敗した場合や開始されなかった場合は、終了通知が来ることはありません。そこで、終了通知を待つ状態を `running` フラグで明示し、`stop()` はこのフラグが立っているときだけ待つようにしました。

<svg viewBox="0 0 600 120" width="100%" role="img" aria-label="running フラグの状態遷移">
  <defs><marker id="rn-arr" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--review-muted)"/></marker></defs>
  <g fill="var(--review-surface)" stroke="var(--review-border)">
    <rect x="10" y="40" width="140" height="40" rx="6"/>
    <rect x="230" y="40" width="140" height="40" rx="6" stroke="var(--review-accent)"/>
    <rect x="450" y="40" width="140" height="40" rx="6"/>
  </g>
  <g font-size="12" fill="var(--review-fg)" text-anchor="middle">
    <text x="80" y="58">running = false</text><text x="80" y="73" font-size="11" fill="var(--review-muted)">未開始 / 開始失敗</text>
    <text x="300" y="58">running = true</text><text x="300" y="73" font-size="11" fill="var(--review-muted)">stop() は eol を待つ</text>
    <text x="520" y="58">running = false</text><text x="520" y="73" font-size="11" fill="var(--review-muted)">終了済み</text>
  </g>
  <g stroke="var(--review-muted)" fill="none" marker-end="url(#rn-arr)">
    <path d="M150,52 L230,52"/>
    <path d="M230,70 L150,70"/>
    <path d="M370,60 L450,60"/>
  </g>
  <g font-size="11" fill="var(--review-muted)" text-anchor="middle">
    <text x="190" y="44">パイプライン組立</text>
    <text x="190" y="88">組立中の例外</text>
    <text x="410" y="52">eol / 書込失敗</text>
  </g>
  <text x="10" y="112" font-size="11" fill="var(--review-muted)">running = false の状態で stop() を呼ぶと、待たずにすぐ終わる（コーデック未設定のトラック、トラック不足でも 1 秒以内）</text>
</svg>

- 実装箇所: [packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:34](review-file:packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:34)、[packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:75](review-file:packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:75)、[packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:168](review-file:packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:168)
- `running` は、パイプラインが何かを出力するより前に立てます（[packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:100](review-file:packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:100)）。こうしておけば、組み立て直後に書き込みが失敗しても状態がずれません。
- 開始に失敗したときは、購読も解除します。
- `MediaRecorder.stop()` は、非同期の開始処理が終わるのを待ってから止めます（[packages/webrtc/src/nonstandard/recorder/index.ts:115](review-file:packages/webrtc/src/nonstandard/recorder/index.ts:115)）。

### 3.6 既存ファイルを削除できないと、古い内容に追記する / 2 本目のトラックが黙って無視される

<div class="ex">
<style>
  .ex table { border-collapse:collapse; font-size:12px; width:100%; color:var(--review-fg); }
  .ex th, .ex td { border:1px solid var(--review-border); padding:5px 8px; vertical-align:top; }
  .ex th { background:var(--review-surface); }
  .ex .ng { border-left:4px solid var(--review-danger); }
  .ex .ok { border-left:4px solid var(--review-success); }
</style>
<table>
  <tr><th>状況</th><th>Before</th><th>After</th></tr>
  <tr><td>既存ファイルは書き込める。ディレクトリからは削除できない</td><td class="ng">unlink の失敗を無視して追記 → 「OLD-CONTENT + 新しい Ogg」になる。通知もなし</td><td class="ok">初回の書き込みでファイルを切り詰める → 新しい Ogg だけになる</td></tr>
  <tr><td>既存ファイルが読み取り専用で、削除もできない</td><td class="ng">（追記に失敗）</td><td class="ok">onError に EACCES を通知。既存ファイルは変えない。stop() はすぐ終わる</td></tr>
  <tr><td>録音中に 2 本目の Opus トラックを addTrack()</td><td class="ng">成功扱いで tracks は 2 本になるが、2 本目は録音されない</td><td class="ok">一覧に加える前に WeriftError（exactly one audio track, got 2）で拒否する</td></tr>
</table>
</div>

実装箇所:

- [packages/rtp/src/extra/processor/oggCallback.ts:58](review-file:packages/rtp/src/extra/processor/oggCallback.ts:58)（初回の書き込みで切り詰める）
- [packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:146](review-file:packages/webrtc/src/nonstandard/recorder/writer/ogg.ts:146)（事前の `unlink` を廃止）
- [packages/webrtc/src/nonstandard/recorder/index.ts:94](review-file:packages/webrtc/src/nonstandard/recorder/index.ts:94)（`addTrack()` でトラック数を確認）

### 3.7 その他の付随変更

- `WeriftError` が `message` / `payload` / `path` を保持するよう直しました（[packages/common/src/log.ts](review-diff:packages/common/src/log.ts)）。以前はクラスフィールドの宣言が `Error` のメッセージを上書きしていました。メッセージ付きのエラーを出すには、この修正が前提になります。
- 次のファイルを更新しました。
  - README
  - `changelog.md`
  - サンプル [examples/save_to_disk/opus_ogg.ts](review-file:examples/save_to_disk/opus_ogg.ts)
  - E2E カタログ [examples/e2e/tests/helpers/catalog.ts](review-diff:examples/e2e/tests/helpers/catalog.ts)

## 4. 判断理由

| 論点 | 採用した案 | 採用しなかった案と理由 |
| --- | --- | --- |
| granule position の求め方 | 入力時刻から期待位置を求め、差を空パケットで補完する | 時刻だけで granule を決める案。パケット列と食い違い、シークや再生時間が狂う。 |
| pre-skip の既定値 | 0 | 312。RTP 由来の録音には encoder の準備用音声がなく、本物の音声を削ってしまう。 |
| pre-skip 指定時の granule | 格納サンプル数そのもの（pre-skip を含む） | 格納サンプル数 + pre-skip。実際より長いファイルになり、終了通知もずれる。 |
| `fillGaps: false` での重複判定 | 入力時刻上の到達位置（position）で判定する | 書き込んだサンプル数で判定する案。ギャップ分ずれて重複を通してしまう。 |
| 既存ファイルの扱い | 初回の書き込みで切り詰める | 事前に `unlink` してエラーを無視する案。削除できないと古い内容に追記してしまう。 |
| Lipsync | 使わない | 録音するのは 1 トラックだけで、同期する相手がいない。 |
| 並べ替え | JitterBuffer を通す | 通さない案。遅れて届いたパケットが補完済みの区間の後ろに書かれ、時刻が逆行する。 |
| JitterBuffer の直し方 | 不変条件を決め、乱数を使ったテストで確かめる | 指摘された入力列ごとに場当たりで直す案。隣のケースが次の不具合として出続けた。 |
| 複数トラック | エラーにする（`addTrack()` の 2 本目も拒否） | 複数の論理ストリームを多重化する案。初期実装の対象外とした。 |
| CRC | ogg 配下に専用の実装を置く | `common` の `crc32` を流用する案。計算方法が違う（非反転）。 |

## 5. レビュアーが確認すべき点・リスク

- **JitterBuffer の変更は、WebM の映像録画にも及びます。**
  - `isPacketLost` の `to` の意味が変わりました。以前は「最後にタイムアウトした受信パケット」、今は「最後に欠けた seq」です。
  - 通知の位置も、欠落の直後のパケットの直前に変わりました。
  - src 内に `isPacketLost` を使っている箇所はありません。外部の利用者がいれば影響します。
- **公開 API が増えます。**
  - `werift-rtp`: `OggPager`、`createOggPage`、`oggCrc32`、`createOpusHead`、`createOpusTags`、`getOpusPacketSamples`、`OggCallback`、`saveOggToFileSystem`
  - `werift`: `MediaRecorderOptions.format`
- `jitterBuffer` オプションは、WebM では映像だけ、Ogg では音声に効きます。
- Ogg の書き出しは、JitterBuffer の既定 latency 200 ms 分遅れます。終了時に残りをまとめて書き出します。
- 補完の最小単位は 2.5 ms です。NTP 由来の時刻に 2.5 ms 以上のゆらぎがあると、短い空パケットが入る可能性があります。補完は既定で有効で、`fillGaps: false` で無効にできます。
- ストリームの先頭で順序が入れ替わると、最初に届いたパケットが基準になるため、本来先頭にあるべきパケットは捨てられます。修正前と同じ動作です。
- `preSkip` 指定時の ffprobe の `duration` は pre-skip を含みます（libopus が書くファイルと同じ慣例）。格納サンプル数が pre-skip より少ない極端に短い録音は、実デコーダーでは確かめていません。
- 拡張子の大文字（`.OGG`）には対応していません。
- WebM（`WebmFactory`）でも、録音が始まらないまま `stop()` すると 5 秒待つと思われます。このチケット以前からの動作で、今回は手を入れていません（未検証）。
- `npm run doc` による生成ドキュメントの再作成は、`saveOggToFileSystem` のコメントを変えた後は行っていません。
- **`changelog.md` が develop の取り込みで崩れています。**
  - 今回の Ogg / JitterBuffer の項目が、`## v0.26.0` の見出しの下に入っています（`packages/webrtc` の version も 0.26.0）。
  - `UdpTransport` / WebM の Cluster サイズ / `ntpTime2Sec()` の項目が、それぞれ 3 回ずつ重複しています（develop 側でも 2 回ずつ重複）。
  - どのリリースに載せるかを決めて、整理する必要があります。

## 6. 検証結果

### 今回の文書更新時（HEAD `fcfe41810` で実行。その後 develop の取り込みで HEAD は `952621a6d` に進んだが、このチケットのコードとテストには差分なし）

<div class="vr">
<style>
  .vr .bar { display:flex; align-items:center; gap:8px; font-size:12px; margin:4px 0; color:var(--review-fg); }
  .vr .lbl { width:260px; }
  .vr .track { flex:1; height:14px; background:var(--review-surface); border:1px solid var(--review-border); border-radius:3px; overflow:hidden; }
  .vr .fill { height:100%; background:var(--review-success); }
</style>
<div class="bar"><span class="lbl">rtp Ogg / JitterBuffer（3 ファイル）</span><span class="track"><span class="fill" style="display:block;width:100%"></span></span><span>93 / 93</span></div>
<div class="bar"><span class="lbl">webrtc recorder.test.ts</span><span class="track"><span class="fill" style="display:block;width:100%"></span></span><span>24 / 24</span></div>
<div class="bar"><span class="lbl">npm run type（error TS）</span><span class="track"><span class="fill" style="display:block;width:100%"></span></span><span>0 件</span></div>
</div>

| コマンド | 結果 |
| --- | --- |
| `packages/rtp` で `vitest run tests/container/ogg.test.ts tests/processor/ogg.test.ts tests/processor/jitterBuffer.test.ts` | 3 ファイル / 93 テスト成功 |
| `packages/webrtc` で `vitest run tests/nonstandard/recorder.test.ts` | 1 ファイル / 24 テスト成功 |
| `npm run type` | `error TS` 0 件 |

前回この文書を作った `8e1f423d5` 以降、develop から取り込んだのは別チケットの変更だけです。このチケットの実装とテストのファイルには差分がありません（`changelog.md` を除く）。

### 過去のレビュー反復で実行したもの（当時のリビジョン）

| コマンド | リビジョン | 結果 |
| --- | --- | --- |
| `npm run test:small` | `a28b7711d` + 最後の指摘対応（当時は未コミットで、のちにコミット済み） | exit 0、全パッケージ成功 |
| `npm run examples:e2e` | `1a325ca22` + JitterBuffer の書き直し（当時は未コミットで、のちにコミット済み） | exit 0、68 件成功。サイレント実行のため個別のテスト名は確認していないが、`save-opus-ogg` はカタログに登録済み |

ffmpeg / ffprobe を使うテストは、ffmpeg がある環境でだけ実行されます。対象は、libopus の実パケットの書き直し、デコード後のサンプル数、pre-skip 指定時の長さ、ページをまたぐ OpusTags です。上記の rtp のテストは、ffmpeg がある環境で実行しています。

実行していないもの:

- 現在の HEAD での `npm run test:small` / `npm run e2e` / `npm run examples:e2e`
- 実ブラウザやメディアプレーヤーでの再生確認
