---
ide:
  viewer: review-document
  version: 1
  title: "空 sdpMid を sdpMLineIndex で解決する（Pion 互換）"
  dock: right
  baseCommit: d19d604cfcc36dd8f3cabf463f3c099f39a68e89
---
# 空 sdpMid を sdpMLineIndex で解決する（Pion 互換）

## 概要

Pion は MID を持たない candidate を `sdpMid: ""` と数値の `sdpMLineIndex` で送ります。werift はこれを「MID 指定あり」と解釈し、`OperationError("Media section for sdpMid was not found")` で reject していました。今回の変更では、`sdpMid === ""` かつ `sdpMLineIndex` が数値のときだけ、`addIceCandidate()` の入口で `sdpMid` を `null` に正規化し、index で m-line を解決します。W3C 仕様はこの入力を reject しますが、libwebrtc / Firefox 互換の動作を既定 API に採用し、その差異を TSDoc と changelog に明記しました。

## 修正前の問題と修正後の仕組み

<div style="display:flex;gap:16px;flex-wrap:wrap;font-family:sans-serif;font-size:13px">
<div style="flex:1;min-width:300px;border:2px solid #d9534f;border-radius:8px;padding:12px">
<b style="color:#d9534f">Before</b>（入力: <code>{sdpMid:"", sdpMLineIndex:1}</code>）
<ol>
<li><code>addIceCandidate()</code> がそのまま queue / <code>apply()</code> へ渡す</li>
<li><code>RemoteCandidates.apply()</code>: <code>typeof sdpMid === "string"</code> → muxId が <code>""</code> の m-line は無く、<code>matchesUfrag</code> が常に false。<span style="color:#d9534f">ICE generation を誤選択する余地</span></li>
<li><code>resolveCandidateMediaIndices()</code>: <code>findIndex</code> が -1 → <span style="color:#d9534f">OperationError で reject</span></li>
</ol>
</div>
<div style="flex:1;min-width:300px;border:2px solid #2e8b57;border-radius:8px;padding:12px">
<b style="color:#2e8b57">After</b>（同じ入力）
<ol>
<li><code>addIceCandidate()</code> が <span style="color:#2e8b57"><code>normalizeEmptyCandidateMid()</code> で <code>sdpMid: null</code> に正規化</span>（queue する前）</li>
<li><code>apply()</code>: index の m-line の ufrag で current / pending を選択</li>
<li><code>resolveCandidateMediaIndices()</code>: index で m-line を解決。<code>usernameFragment</code> 不一致・範囲外は従来どおり OperationError</li>
</ol>
</div>
</div>

凡例: 赤は問題の経路、緑は変更された経路です。正規化を 1 か所（入口）で行うことで、`apply()` の generation 選択と `SecureTransportManager` の m-line 解決が必ず同じ m-line を指します。

## 主要変更

- 正規化関数 [packages/webrtc/src/negotiation/remoteCandidates.ts:51](review-diff:packages/webrtc/src/negotiation/remoteCandidates.ts:51) を追加しました。`sdpMid === ""` かつ `sdpMLineIndex` が数値のときだけ `sdpMid: null` にします。呼び出し元のオブジェクトは変更せず、`RTCIceCandidate` は `toJSON()` 経由で複製します。
- 入口での適用 [packages/webrtc/src/peerConnection.ts:1833](review-diff:packages/webrtc/src/peerConnection.ts:1833)。`normalizeCandidateUfrag()` の後、remote description の有無で queue する前に通します。
- index 無しの `""` は [packages/webrtc/src/secureTransportManager.ts:444](review-diff:packages/webrtc/src/secureTransportManager.ts:444) で、原因が分かるメッセージ `"sdpMid is empty and no sdpMLineIndex was given"` の OperationError にしました。end-of-candidates も同様です。
- 仕様との差異を [packages/webrtc/src/transport/iceCandidateAttribute.ts](review-diff:packages/webrtc/src/transport/iceCandidateAttribute.ts) の TSDoc、`peerConnection.ts` の互換ノート、`changelog.md`、生成 doc（`doc/`）に記載しました。
- テスト: 共通 Arrange を [packages/webrtc/tests/integrate/addIceCandidateUtils.ts](review-file:packages/webrtc/tests/integrate/addIceCandidateUtils.ts) に切り出し（`peerConnection.test.ts` の重複を削減）、新規 [packages/webrtc/tests/integrate/remoteCandidateTarget.test.ts:21](review-file:packages/webrtc/tests/integrate/remoteCandidateTarget.test.ts:21) に BUNDLE / 非 BUNDLE、ufrag 照合、範囲外 index、index 無し、end-of-candidates、`RTCIceCandidate` 入力、pre-SRD の queue、ICE restart、非空 mid 優先のケースを追加しました。

## 判断理由

| 案 | 採否 | 理由 |
| --- | --- | --- |
| A. `""` を常に MID なしとみなす | 不採用 | index なしの end-of-candidates が全 m-line に広がり、受け入れ範囲が広すぎる |
| B. `""` + 数値 index のときだけ index で解決 | 採用 | Pion の問題を直し、受け入れ範囲が最小 |
| C. 明示エラーで reject | 不採用 | 下流の問題が直らない |

- WPT runner に strict な reject は追加していません。upstream に空 `sdpMid` の subtest が無く、追加しても dead code になるためです（チケットの方針）。

## レビュアーが確認すべき点・リスク

- W3C 仕様（non-null `sdpMid` が一致しなければ OperationError）からの意図的な逸脱です。libwebrtc / Firefox の挙動はチケット上「記憶ベース・未検証」と記載されており、私もソースでは再確認していません。
- 公開 API の型や形式は変更していません。挙動だけが「reject → 受理」に変わるのは、空 MID と数値 index の組み合わせに限ります。
- 空白だけの MID など非空の MID は従来どおり MID として検索します。
- `wpt/baseline.json` への影響は未確認です（`npm run wpt` は実行していません）。

## 検証結果

- 実施: `cd packages/webrtc && npx vitest run tests/integrate/remoteCandidateTarget.test.ts tests/integrate/peerConnection.test.ts` → 2 ファイル pass、41 passed / 1 skipped。
- 未実施: `npm run type`、`npm run test:small`、`npm run wpt`、E2E、Pion 実機との interop（リポジトリにハーネスが無い）。
