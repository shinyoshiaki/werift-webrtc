---
ide:
  viewer: review-document
  version: 1
  title: "DTLS 証明書スコープ(certificateScope)オプション追加のレビュー"
  dock: right
  baseCommit: fbfb579befad700523d6a4fb51a99b524661acd8
---
# DTLS 証明書スコープ(`certificateScope`)オプション追加のレビュー

## 1. 概要

同一プロセス内の `RTCPeerConnection` は、`certificates` / `dtls.keys` 未指定のとき 1 つの証明書を共有し、`a=fingerprint` が全接続で同一になります。ブラウザは接続ごとに証明書を生成するため、この差は「fingerprint を永続 ID と誤用するアプリのバグ」を werift 同士のテストで隠します。

当初は挙動を直接 PC 単位へ変更しましたが、**追加要件でデフォルトを従来どおりに戻し、新挙動をコンストラクタのオプション `certificateScope` で選ぶ形に変更しました**。既定のままなら既存利用者への影響はありません。

<div style="display:flex;gap:12px;flex-wrap:wrap">
  <div style="flex:1;min-width:260px;padding:10px 14px;border:1px solid var(--review-border);border-left:4px solid var(--review-muted);border-radius:6px;background:var(--review-surface)">
    <strong>"process"(既定・従来どおり)</strong>
    <svg viewBox="0 0 260 150" width="100%" role="img" aria-label="全 PC が 1 つの証明書を共有">
      <rect x="70" y="6" width="120" height="30" rx="6" fill="none" stroke="var(--review-accent)"/>
      <text x="130" y="26" text-anchor="middle" font-size="12" fill="var(--review-fg)">共有証明書 (process)</text>
      <g stroke="var(--review-muted)"><line x1="130" y1="36" x2="45" y2="100"/><line x1="130" y1="36" x2="130" y2="100"/><line x1="130" y1="36" x2="215" y2="100"/></g>
      <g fill="none" stroke="var(--review-border)"><rect x="5" y="100" width="80" height="30" rx="6"/><rect x="90" y="100" width="80" height="30" rx="6"/><rect x="175" y="100" width="80" height="30" rx="6"/></g>
      <g fill="var(--review-fg)" font-size="12" text-anchor="middle"><text x="45" y="120">PC A</text><text x="130" y="120">PC B</text><text x="215" y="120">PC C</text></g>
    </svg>
    <div style="font-size:13px;color:var(--review-muted)">fingerprint は全 PC で同一</div>
  </div>
  <div style="flex:1;min-width:260px;padding:10px 14px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px;background:var(--review-surface)">
    <strong>"peerConnection"(オプトイン)</strong>
    <svg viewBox="0 0 260 150" width="100%" role="img" aria-label="各 PC が自前の証明書を持つ">
      <g fill="none" stroke="var(--review-success)"><rect x="5" y="6" width="80" height="30" rx="6"/><rect x="90" y="6" width="80" height="30" rx="6"/><rect x="175" y="6" width="80" height="30" rx="6"/></g>
      <g fill="var(--review-fg)" font-size="12" text-anchor="middle"><text x="45" y="26">cert A</text><text x="130" y="26">cert B</text><text x="215" y="26">cert C</text></g>
      <g stroke="var(--review-muted)"><line x1="45" y1="36" x2="45" y2="100"/><line x1="130" y1="36" x2="130" y2="100"/><line x1="215" y1="36" x2="215" y2="100"/></g>
      <g fill="none" stroke="var(--review-border)"><rect x="5" y="100" width="80" height="30" rx="6"/><rect x="90" y="100" width="80" height="30" rx="6"/><rect x="175" y="100" width="80" height="30" rx="6"/></g>
      <g fill="var(--review-fg)" font-size="12" text-anchor="middle"><text x="45" y="120">PC A</text><text x="130" y="120">PC B</text><text x="215" y="120">PC C</text></g>
    </svg>
    <div style="font-size:13px;color:var(--review-muted)">fingerprint は PC ごとに別(ブラウザと同じ)</div>
  </div>
</div>

## 2. 主要変更

### 2.1 設定オプション

`RTCConfiguration.certificateScope: "process" | "peerConnection"`。型・既定値・検証は [packages/webrtc/src/api/peerConfig.ts:126](review-file:packages/webrtc/src/api/peerConfig.ts:126)、既定値 `"process"` は [packages/webrtc/src/api/peerConfig.ts:276](review-file:packages/webrtc/src/api/peerConfig.ts:276)。

- 不正値は `TypeError`([packages/webrtc/src/api/peerConfig.ts:430](review-file:packages/webrtc/src/api/peerConfig.ts:430))。
- 構築後に `setConfiguration()` で変えると `InvalidModificationError`("certificateScope cannot be changed")([packages/webrtc/src/api/peerConfig.ts:440](review-file:packages/webrtc/src/api/peerConfig.ts:440))。`mLineReuse` など既存の構築時オプションと同じ扱い。

### 2.2 `SecureTransportManager.ensureCerts()`(核心)

[packages/webrtc/src/secureTransportManager.ts:703](review-file:packages/webrtc/src/secureTransportManager.ts:703)(差分: [packages/webrtc/src/secureTransportManager.ts](review-diff:packages/webrtc/src/secureTransportManager.ts))。

<svg viewBox="0 0 700 190" width="100%" role="img" aria-label="ensureCerts の分岐">
  <g fill="none" stroke="var(--review-border)">
    <rect x="4" y="73" width="120" height="44" rx="6"/>
    <rect x="164" y="73" width="130" height="44" rx="6" stroke="var(--review-accent)"/>
    <rect x="344" y="6" width="170" height="44" rx="6"/>
    <rect x="344" y="73" width="170" height="44" rx="6"/>
    <rect x="344" y="140" width="170" height="44" rx="6"/>
    <rect x="564" y="73" width="132" height="44" rx="6" stroke="var(--review-success)"/>
  </g>
  <g stroke="var(--review-muted)">
    <line x1="124" y1="95" x2="164" y2="95"/>
    <line x1="294" y1="95" x2="344" y2="28"/><line x1="294" y1="95" x2="344" y2="95"/><line x1="294" y1="95" x2="344" y2="162"/>
    <line x1="514" y1="28" x2="564" y2="95"/><line x1="514" y1="95" x2="564" y2="95"/><line x1="514" y1="162" x2="564" y2="95"/>
  </g>
  <g fill="var(--review-fg)" font-size="12" text-anchor="middle">
    <text x="64" y="92">createOffer /</text><text x="64" y="106">createAnswer</text>
    <text x="229" y="99">ensureCerts()</text>
    <text x="429" y="24">certificates / dtls.keys</text><text x="429" y="38">→ 明示証明書を使用</text>
    <text x="429" y="91">"process"</text><text x="429" y="105">→ SetupCertificate()(共有)</text>
    <text x="429" y="158">"peerConnection"</text><text x="429" y="172">→ generateCertificate()</text>
    <text x="630" y="92">全 DTLS transport</text><text x="630" y="106">へ配布</text>
  </g>
</svg>

- `"peerConnection"` は PC ごとに 1 回だけ生成し、寿命中固定。並行する `createOffer()` / `createAnswer()` は同じ生成 Promise を待つ。生成失敗時はエラーを返し、次回呼び出しで再試行。
- どちらの値でも明示証明書が優先。生成した証明書は `getConfiguration().certificates` へ書き戻さない。

### 2.3 `RTCDtlsTransport`

- 新規 `static generateCertificate()`(呼ぶたびに新規生成、ECDSA P-256 / SHA-256)。[packages/webrtc/src/transport/dtls.ts:155](review-file:packages/webrtc/src/transport/dtls.ts:155)
- `SetupCertificate()` は `generateCertificate()` を使ってプロセス共有キャッシュを作る。挙動は従来どおり。[packages/webrtc/src/transport/dtls.ts:171](review-file:packages/webrtc/src/transport/dtls.ts:171)
- コンストラクタの static フォールバックは**維持**(一度削除したが、追加要件で復元)。[packages/webrtc/src/transport/dtls.ts:126](review-file:packages/webrtc/src/transport/dtls.ts:126)
- deprecated 指定も取り消し。

## 3. 判断理由

| 論点 | 判断 | 理由 |
| --- | --- | --- |
| 既定値 | `"process"`(従来どおり) | 追加要件。fingerprint 変化に依存する既存アプリを壊さない |
| 新挙動の選択方法 | コンストラクタのオプション | 接続単位で選べ、`mLineReuse` 等と同じ構築時オプションの作法に合う |
| 構築後の変更 | 禁止 | 証明書が変わると DTLS 再ハンドシェイクや相手側検証失敗を招く |
| 同一 PC 内の共有 | 維持 | `max-compat` の複数 transport で SDP の fingerprint を 1 つに保つ |
| 旧 API / フォールバック | 変更なし | Breaking を避ける。changelog は Breaking → Features に移動 |
| 生成の競合 | Promise を共有 | 並行呼び出しで複数証明書ができるのを防ぐ |

## 4. リスク

<div style="display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13px">
  <strong style="color:var(--review-success)">互換性</strong><span>既定は従来どおりのため、オプションを使わない限り Breaking change はない。低レベル API の利用者への影響もない。</span>
  <strong style="color:var(--review-warning)">運用</strong><span>ブラウザ互換の挙動(identity の分離)は既定では得られない。利用者が `certificateScope: "peerConnection"` を明示する必要がある。</span>
  <strong style="color:var(--review-warning)">コスト</strong><span>`"peerConnection"` では接続ごとに鍵生成が走る(初回 createOffer / createAnswer、ECDSA P-256 のため軽量)。多数の PC を作る loadtest / memleak は未計測。</span>
  <strong style="color:var(--review-warning)">残存</strong><span>`certificateScope` は `PeerConfig` に追加したため、`getConfiguration()` の戻り値にも現れる。</span>
</div>

## 5. テストとドキュメント

[packages/webrtc/tests/integrate/certificate.test.ts](review-file:packages/webrtc/tests/integrate/certificate.test.ts)(Arrange / Act / Assert、Act・Assert は日本語コメント)。共有ヘルパーは [packages/webrtc/tests/fixture.ts](review-diff:packages/webrtc/tests/fixture.ts)、[packages/webrtc/tests/transport/dtls.test.ts](review-diff:packages/webrtc/tests/transport/dtls.test.ts) は証明書の明示渡しに変更。

| # | シナリオ | 位置 |
| --- | --- | --- |
| 1 | 既定では PC 間で同じ fingerprint、`certificateScope` は `"process"` | [certificate.test.ts:23](review-file:packages/webrtc/tests/integrate/certificate.test.ts:23) |
| 2 | 不正な `certificateScope` は TypeError | [certificate.test.ts:43](review-file:packages/webrtc/tests/integrate/certificate.test.ts:43) |
| 3 | 構築後の変更は拒否 | [certificate.test.ts:50](review-file:packages/webrtc/tests/integrate/certificate.test.ts:50) |
| 4 | `"peerConnection"`: PC ごとに別の証明書 | [certificate.test.ts:60](review-file:packages/webrtc/tests/integrate/certificate.test.ts:60) |
| 5 | `"peerConnection"`: 同一 PC の全 transport が同じ証明書(max-compat、SDP の fingerprint は 1 つ) | [certificate.test.ts:82](review-file:packages/webrtc/tests/integrate/certificate.test.ts:82) |
| 6 | `"peerConnection"`: 並行 createOffer + createAnswer でも 1 証明書 | [certificate.test.ts:109](review-file:packages/webrtc/tests/integrate/certificate.test.ts:109) |
| 7 | 同じ `RTCCertificate` を渡した PC 同士は同じ fingerprint | [certificate.test.ts:132](review-file:packages/webrtc/tests/integrate/certificate.test.ts:132) |
| 8 | 同じ `dtls.keys` を渡した PC 同士は同じ fingerprint | [certificate.test.ts:158](review-file:packages/webrtc/tests/integrate/certificate.test.ts:158) |
| 9 | `"peerConnection"`: 証明書が異なる PC 同士で DataChannel が通信できる | [certificate.test.ts:181](review-file:packages/webrtc/tests/integrate/certificate.test.ts:181) |

ドキュメント: [changelog.md](review-diff:changelog.md)(Unreleased > Features)、[docs/browser-api-compatibility.md](review-diff:docs/browser-api-compatibility.md)、`npm run doc` による `doc/` の再生成(`PeerConfig` / `RTCPeerConnection` / `RTCDtlsTransport`)。

## 6. 検証結果

<div style="display:flex;flex-direction:column;gap:6px;font-size:13px">
  <div style="display:flex;align-items:center;gap:8px"><span style="width:200px">npm run type</span><span style="background:var(--review-success);color:var(--review-bg);padding:1px 10px;border-radius:10px">成功</span></div>
  <div style="display:flex;align-items:center;gap:8px"><span style="width:200px">npm run test:small</span><span style="background:var(--review-success);color:var(--review-bg);padding:1px 10px;border-radius:10px">成功</span><span style="color:var(--review-muted)">webrtc: 907 passed / 5 skipped</span></div>
  <div style="display:flex;align-items:center;gap:8px"><span style="width:200px">npm run wpt</span><span style="background:var(--review-warning);color:var(--review-bg);padding:1px 10px;border-radius:10px">未実施</span><span style="color:var(--review-muted)">オプション追加後は未実行</span></div>
  <div style="display:flex;align-items:center;gap:8px"><span style="width:200px">ブラウザ相互接続 E2E</span><span style="background:var(--review-warning);color:var(--review-bg);padding:1px 10px;border-radius:10px">未実施</span></div>
</div>

- 未確認: WPT の回帰、ブラウザとの実機相互接続、多数 PC 生成時の性能・memleak。
- 変更は未コミット。
