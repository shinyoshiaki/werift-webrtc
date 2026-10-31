---
ide:
  viewer: review-document
  version: 1
  title: "DTLS 証明書の PeerConnection 単位分離レビュー"
  dock: right
  baseCommit: aae75be6ea30330b696840e1f8652f2ae1ee4048
---
# DTLS 証明書を RTCPeerConnection ごとに分離する変更のレビュー

## 1. 概要

`certificates` / `dtls.keys` を指定しない `RTCPeerConnection` は、これまでプロセス全体で共有される 1 つの証明書を使っていました。そのため同一プロセス内の独立した接続が、すべて同じ `a=fingerprint` を広告していました。

この変更では、**証明書の所有を PeerConnection 単位に移しました**。未指定の接続は自分専用の証明書を生成します(ブラウザと同じ挙動)。同一接続内の DTLS transport は引き続き 1 つの証明書を共有します。

<div style="display:flex;gap:12px;flex-wrap:wrap">
  <div style="flex:1;min-width:260px;padding:10px 14px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px;background:var(--review-surface)">
    <strong>Before</strong>
    <svg viewBox="0 0 260 150" width="100%" role="img" aria-label="全 PC が 1 つの静的証明書を共有">
      <rect x="70" y="6" width="120" height="30" rx="6" fill="none" stroke="var(--review-danger)"/>
      <text x="130" y="26" text-anchor="middle" font-size="12" fill="var(--review-fg)">静的証明書 (process)</text>
      <g stroke="var(--review-muted)"><line x1="130" y1="36" x2="45" y2="100"/><line x1="130" y1="36" x2="130" y2="100"/><line x1="130" y1="36" x2="215" y2="100"/></g>
      <g fill="none" stroke="var(--review-border)"><rect x="5" y="100" width="80" height="30" rx="6"/><rect x="90" y="100" width="80" height="30" rx="6"/><rect x="175" y="100" width="80" height="30" rx="6"/></g>
      <g fill="var(--review-fg)" font-size="12" text-anchor="middle"><text x="45" y="120">PC A</text><text x="130" y="120">PC B</text><text x="215" y="120">PC C</text></g>
    </svg>
    <div style="font-size:13px;color:var(--review-muted)">fingerprint は全 PC で同一</div>
  </div>
  <div style="flex:1;min-width:260px;padding:10px 14px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px;background:var(--review-surface)">
    <strong>After</strong>
    <svg viewBox="0 0 260 150" width="100%" role="img" aria-label="各 PC が自前の証明書を持つ">
      <g fill="none" stroke="var(--review-success)"><rect x="5" y="6" width="80" height="30" rx="6"/><rect x="90" y="6" width="80" height="30" rx="6"/><rect x="175" y="6" width="80" height="30" rx="6"/></g>
      <g fill="var(--review-fg)" font-size="12" text-anchor="middle"><text x="45" y="26">cert A</text><text x="130" y="26">cert B</text><text x="215" y="26">cert C</text></g>
      <g stroke="var(--review-muted)"><line x1="45" y1="36" x2="45" y2="100"/><line x1="130" y1="36" x2="130" y2="100"/><line x1="215" y1="36" x2="215" y2="100"/></g>
      <g fill="none" stroke="var(--review-border)"><rect x="5" y="100" width="80" height="30" rx="6"/><rect x="90" y="100" width="80" height="30" rx="6"/><rect x="175" y="100" width="80" height="30" rx="6"/></g>
      <g fill="var(--review-fg)" font-size="12" text-anchor="middle"><text x="45" y="120">PC A</text><text x="130" y="120">PC B</text><text x="215" y="120">PC C</text></g>
    </svg>
    <div style="font-size:13px;color:var(--review-muted)">fingerprint は PC ごとに別</div>
  </div>
</div>

## 2. 主要変更

### 2.1 `RTCDtlsTransport`(低レベル)

- 新規 `static generateCertificate()`: 呼ぶたびに新しい自己署名証明書(ECDSA P-256 / SHA-256、従来と同じ)を作る。[packages/webrtc/src/transport/dtls.ts:156](review-file:packages/webrtc/src/transport/dtls.ts:156)
- コンストラクタは証明書未指定でも共有 static 証明書へフォールバックしない。[packages/webrtc/src/transport/dtls.ts:124](review-file:packages/webrtc/src/transport/dtls.ts:124)
- `SetupCertificate()` と static `localCertificate` / `localCertificatePromise` は互換のため残し、`@deprecated` を付与。`RTCPeerConnection` は使わない。[packages/webrtc/src/transport/dtls.ts:116](review-file:packages/webrtc/src/transport/dtls.ts:116)

### 2.2 `SecureTransportManager.ensureCerts()`(核心)

[packages/webrtc/src/secureTransportManager.ts:702](review-file:packages/webrtc/src/secureTransportManager.ts:702) が変更の中心です(差分: [packages/webrtc/src/secureTransportManager.ts](review-diff:packages/webrtc/src/secureTransportManager.ts))。

<svg viewBox="0 0 640 170" width="100%" role="img" aria-label="ensureCerts の流れ">
  <g fill="none" stroke="var(--review-border)">
    <rect x="4" y="60" width="120" height="44" rx="6"/>
    <rect x="164" y="60" width="130" height="44" rx="6" stroke="var(--review-accent)"/>
    <rect x="334" y="10" width="140" height="44" rx="6"/>
    <rect x="334" y="110" width="140" height="44" rx="6"/>
    <rect x="514" y="60" width="122" height="44" rx="6" stroke="var(--review-success)"/>
  </g>
  <g stroke="var(--review-muted)">
    <line x1="124" y1="82" x2="164" y2="82"/><line x1="294" y1="82" x2="334" y2="32"/><line x1="294" y1="82" x2="334" y2="132"/>
    <line x1="474" y1="32" x2="514" y2="82"/><line x1="474" y1="132" x2="514" y2="82"/>
  </g>
  <g fill="var(--review-fg)" font-size="12" text-anchor="middle">
    <text x="64" y="86">createOffer /</text><text x="64" y="100">createAnswer</text>
    <text x="229" y="86">ensureCerts()</text>
    <text x="404" y="30">明示証明書あり</text><text x="404" y="44">→ そのまま使用</text>
    <text x="404" y="130">なし → generate</text><text x="404" y="144">(Promise を共有)</text>
    <text x="575" y="80">全 DTLS transport</text><text x="575" y="94">へ同じ cert を配布</text>
  </g>
</svg>

- 明示証明書があればそれを使い、無ければその接続用に 1 回だけ生成して寿命の間固定。
- 並行する `createOffer()` / `createAnswer()` は同じ生成 Promise を待つ(生成は 1 回)。
- 生成失敗時はエラーを呼び出し元へ返し、Promise を破棄して次回呼び出しで再試行。
- 生成した証明書は `getConfiguration().certificates` には書き戻さない。

## 3. 判断理由

| 論点 | 判断 | 理由 |
| --- | --- | --- |
| 証明書の所有者 | PeerConnection | ブラウザと同じ。接続間で DTLS identity が漏れ・混ざらない |
| 同一 PC 内の共有 | 維持 | `max-compat` の 3 transport で fingerprint が 1 つであることが SDP 上必要 |
| 旧 API | 削除せず deprecated | 破壊を最小化。ただしコンストラクタの暗黙フォールバックは廃止(Breaking) |
| 安定した identity が必要な利用者 | 永続 `RTCCertificate` を渡す | changelog に移行手順を記載 |
| 生成の競合 | Promise を共有 | 並行呼び出しで複数証明書が出来るのを防ぐ |

## 4. リスク

<div style="display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13px">
  <strong style="color:var(--review-danger)">Breaking</strong><span>`new RTCDtlsTransport(config, iceTransport)` を証明書なしで使い、`SetupCertificate()` に依存していた低レベル利用者は、第 3 引数で証明書を渡す必要がある。changelog の Breaking changes に記載済み: [changelog.md](review-diff:changelog.md)</span>
  <strong style="color:var(--review-warning)">挙動</strong><span>fingerprint を固定値として事前共有していた運用は、証明書を明示指定しない限り接続ごとに変わる。</span>
  <strong style="color:var(--review-warning)">コスト</strong><span>接続ごとに鍵生成が走る(初回 createOffer/createAnswer 時、ECDSA P-256 のため軽量)。</span>
  <strong style="color:var(--review-muted)">範囲外</strong><span>`integration/werift-mediasoup-interop` のサブモジュール参照変更は本チケットとは無関係(着手前から存在)。</span>
</div>

## 5. テストとドキュメント

新規 [packages/webrtc/tests/integrate/certificate.test.ts](review-file:packages/webrtc/tests/integrate/certificate.test.ts)(Arrange / Act / Assert、Act・Assert は日本語コメント)。共有ヘルパーは [packages/webrtc/tests/fixture.ts](review-diff:packages/webrtc/tests/fixture.ts) に集約し、[packages/webrtc/tests/transport/dtls.test.ts](review-diff:packages/webrtc/tests/transport/dtls.test.ts) も証明書を明示渡しに変更しました。

| # | シナリオ | 位置 |
| --- | --- | --- |
| 1 | 未指定 PC 同士は別の証明書・fingerprint | [certificate.test.ts:23](review-file:packages/webrtc/tests/integrate/certificate.test.ts:23) |
| 2 | 同一 PC の全 DTLS transport は同じ証明書(max-compat、SDP の fingerprint は 1 つ) | [certificate.test.ts:45](review-file:packages/webrtc/tests/integrate/certificate.test.ts:45) |
| 3 | 並行 createOffer + createAnswer でも証明書は 1 つ | [certificate.test.ts:69](review-file:packages/webrtc/tests/integrate/certificate.test.ts:69) |
| 4a | 同じ `RTCCertificate` を渡せば同じ fingerprint | [certificate.test.ts:92](review-file:packages/webrtc/tests/integrate/certificate.test.ts:92) |
| 4b | 同じ `dtls.keys` を渡せば同じ fingerprint | [certificate.test.ts:118](review-file:packages/webrtc/tests/integrate/certificate.test.ts:118) |
| 5 | 証明書が異なる PC 同士で DataChannel が通信できる | [certificate.test.ts:141](review-file:packages/webrtc/tests/integrate/certificate.test.ts:141) |

ドキュメント: [changelog.md](review-diff:changelog.md)(Breaking 追記)、[docs/browser-api-compatibility.md](review-diff:docs/browser-api-compatibility.md)(接続ごと生成の注記)、`npm run doc` による `doc/classes/RTCDtlsTransport.md` と `doc/_media/browser-api-compatibility.md` の再生成。

## 6. 検証結果

<div style="display:flex;flex-direction:column;gap:6px;font-size:13px">
  <div style="display:flex;align-items:center;gap:8px"><span style="width:200px">npm run type</span><span style="background:var(--review-success);color:var(--review-bg);padding:1px 10px;border-radius:10px">成功</span></div>
  <div style="display:flex;align-items:center;gap:8px"><span style="width:200px">npm run test:small</span><span style="background:var(--review-success);color:var(--review-bg);padding:1px 10px;border-radius:10px">成功</span><span style="color:var(--review-muted)">webrtc: 880 passed / 5 skipped(59 files)</span></div>
  <div style="display:flex;align-items:center;gap:8px"><span style="width:200px">npm run wpt</span><span style="background:var(--review-success);color:var(--review-bg);padding:1px 10px;border-radius:10px">成功</span><span style="color:var(--review-muted)">regression 0 件</span></div>
  <div style="display:flex;align-items:center;gap:8px"><span style="width:200px">ブラウザ相互接続 E2E</span><span style="background:var(--review-warning);color:var(--review-bg);padding:1px 10px;border-radius:10px">未実施</span></div>
</div>

- 型検査は、`node_modules` が古かった(TypeScript 5.7.3 / 要求 6.0.3)ため `npm ci` 後に実施。
- 上記の結果はチケット対応時と自動レビューでの報告に基づく。この文書作成時点で再実行はしていない。
- 未確認: ブラウザ(Chromium 等)との実機相互接続 E2E。DataChannel の異証明書間通信は werift 同士のテストのみ。
