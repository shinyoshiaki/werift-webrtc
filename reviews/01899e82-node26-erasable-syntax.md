---
ide:
  viewer: review-document
  version: 1
  title: "Node 26 対応レビュー解説"
  dock: right
  baseCommit: 699c15674b85b02a4f4443610b9bc115f863fcf8
---
# Node 26 対応: `--experimental-transform-types` 廃止への対応レビュー

## 結論

Node 26 でフラグを廃止しても動くよう、**ソースを「型注釈を消すだけで動く構文」に揃え、フラグを全廃**しました（チケット案 A）。ただし **E2E は 65/66 で、`packetize_vp9` 1 件はこの環境では通りません**。develop でも同じ失敗をするため、今回の変更による退行ではなく環境（Chrome が VP9 を再生できない）が原因と判断しています。承認は未取得です。

<div style="display:flex;gap:12px;flex-wrap:wrap">
  <div style="flex:1;min-width:200px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px"><strong>Before</strong><br>enum / パラメータプロパティを使用<br>実行に <code>--experimental-transform-types</code> が必要<br>Node 26 では起動不可</div>
  <div style="flex:1;min-width:200px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px"><strong>After</strong><br>erasable な構文のみ（<code>erasableSyntaxOnly</code> で強制）<br>フラグ不要、Node 22.18+ / 24 / 26 で動作<br>CI に Node 26 を追加</div>
</div>

## 変更の全体像

<svg viewBox="0 0 640 150" width="100%" role="img" aria-label="変更の4本柱">
  <g fill="none" stroke="var(--review-border)"><rect x="5" y="20" width="145" height="90" rx="8"/><rect x="165" y="20" width="145" height="90" rx="8"/><rect x="325" y="20" width="145" height="90" rx="8"/><rect x="485" y="20" width="145" height="90" rx="8"/></g>
  <g fill="var(--review-fg)" font-size="13" text-anchor="middle">
    <text x="77" y="45" font-weight="bold">パラメータ</text><text x="77" y="62" font-weight="bold">プロパティ</text><text x="77" y="86">132 クラス</text><text x="77" y="102">298 箇所</text>
    <text x="237" y="45" font-weight="bold">enum</text><text x="237" y="62" font-weight="bold">→ as const</text><text x="237" y="86">11 個</text><text x="237" y="102">@enum 付き</text>
    <text x="397" y="45" font-weight="bold">再発防止</text><text x="397" y="86">tsconfig 12 個に</text><text x="397" y="102">erasableSyntaxOnly</text>
    <text x="557" y="45" font-weight="bold">フラグ全廃</text><text x="557" y="86">scripts / 起動引数</text><text x="557" y="102">README / CI / AGENTS</text>
  </g>
</svg>

### 1. パラメータプロパティの展開
明示的なフィールド宣言＋コンストラクタ内代入に書き換えました。フィールドはクラス先頭に置き、プロパティの定義順は従来と同じです。

### 2. enum → `as const` オブジェクト＋同名の型
公開値は変わりません。DTLS の `AlertDesc` 逆引きは非公開関数で置き換えています: [packages/dtls/src/record/const.ts](review-diff:packages/dtls/src/record/const.ts)。
値の推論が狭まる箇所には旧 enum 名の型注釈を付け、公開型がリテラルに狭まらないようにしました（例: [packages/sctp/src/sctp.ts](review-diff:packages/sctp/src/sctp.ts) の `associationState`）。

### 3. 再発防止とフラグ削除
例: [packages/webrtc/tsconfig.json:12](review-file:packages/webrtc/tsconfig.json:12) の `erasableSyntaxOnly`。CI は [.github/workflows/nodejs.yml](review-diff:.github/workflows/nodejs.yml) で Node `24.x, 26.x`。Node 要件は [README.md](review-diff:README.md) に 3 項目で記載。

## 検証結果

<style>
  .vr td, .vr th { border: 1px solid var(--review-border); padding: 4px 10px; font-size: 13px; color: var(--review-fg); }
  .vr table { border-collapse: collapse; }
  .vr .ok { color: var(--review-success); font-weight: bold; }
  .vr .ng { color: var(--review-danger); font-weight: bold; }
  .vr .wn { color: var(--review-warning); font-weight: bold; }
</style>
<div class="vr"><table>
<tr><th>検証</th><th>Node 24</th><th>Node 26</th><th>Node 22</th></tr>
<tr><td>type:all / test:small</td><td class="ok">成功</td><td class="ok">成功</td><td>-</td></tr>
<tr><td>test:node-ts / wpt:list</td><td class="ok">成功</td><td class="ok">成功</td><td class="ok">成功</td></tr>
<tr><td>wpt / wpt:coverage</td><td class="ok">回帰なし</td><td class="ok">回帰なし</td><td>-</td></tr>
<tr><td>examples:e2e</td><td class="ok">68/68</td><td class="ok">68/68</td><td>-</td></tr>
<tr><td>e2e</td><td class="ng">65/66</td><td class="ng">65/66</td><td>-</td></tr>
</table></div>

- 公開 `.d.ts` は実装時に基準リビジョンのビルドと比較し、リテラル型への意図しない狭まりなし（今回の再レビュー対応では再実施していません）。
- `npm run format` は実行済みで修正対象なし。

## 再レビュー対応（HEAD 699c15674 まで）

パラメータプロパティ展開で、利用者側の型が変わる箇所が見つかったため修正しました。

- 省略可能な公開プロパティを `?: T | undefined` にしました。`exactOptionalPropertyTypes` を有効にした利用者が `undefined` を代入できる従来の型を保つためです。対象は [packages/ice/src/candidate.ts:11](review-diff:packages/ice/src/candidate.ts:11)、[packages/dtls/src/context/cipher.ts:30](review-diff:packages/dtls/src/context/cipher.ts:30)、[packages/dtls/src/flight/flight.ts](review-diff:packages/dtls/src/flight/flight.ts)、[packages/webrtc/src/transport/ice.ts](review-diff:packages/webrtc/src/transport/ice.ts)、[packages/webrtc/src/transport/dtls.ts](review-diff:packages/webrtc/src/transport/dtls.ts) です。
- [packages/dtls/src/handshake/random.ts:9](review-diff:packages/dtls/src/handshake/random.ts:9) の `random_bytes` を `Buffer<ArrayBuffer>` にし、`Uint8Array<ArrayBuffer>` へ代入できる従来の型を保ちました。
- 上記を固定する型テスト [packages/webrtc/tests/types/publicTypes.test.ts:7](review-file:packages/webrtc/tests/types/publicTypes.test.ts:7) を追加しました。利用者コードをソースに対してコンパイルし、診断 0 件を確認します（Arrange / Act / Assert、Japanese コメント付き）。
- netns シミュレーションの [Dockerfile](review-diff:e2e/simulations/netns/Dockerfile) と [in-container.sh](review-diff:e2e/simulations/netns/in-container.sh) から旧フラグを削除し、Node 24 固定の理由を「Node 24 でしか検証していないため」に直しました（[README](review-diff:e2e/simulations/README.md)）。
- [changelog.md](review-diff:changelog.md) の項目を整理し、ESM ビルドの定義順が CJS と一致する旨を追記しました。
- import 順・コンストラクタ整形など、フォーマッタ由来の差分もあります。

この再レビュー対応後に私が実行した検証は `npx vitest run tests/types/publicTypes.test.ts`（2 件成功）だけです。下の表は前回の実装時の結果で、再実行していません。

## リスク・未解決事項

<div style="display:flex;gap:12px;flex-wrap:wrap">
  <div style="flex:1;min-width:220px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px"><strong>E2E <code>packetize_vp9</code></strong><br><code>waitVideoPlay</code> が 30 秒でタイムアウト。develop（<code>c9906b16a</code>）でも専用ブラウザ環境で同じ失敗。コード側で直す点なし。66/66 は未確認。</div>
  <div style="flex:1;min-width:220px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-warning);border-radius:6px"><strong>サブモジュール</strong><br><code>integration/werift-mediasoup-interop</code> は別リポジトリのため未変更。CI の該当ジョブは Node 24 のみ。</div>
  <div style="flex:1;min-width:220px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-warning);border-radius:6px"><strong>WPT</strong><br>個別ケースの FAIL/TIMEOUT は upstream 既知。runner のベースライン比較で回帰ゼロ。全ケース合格ではない。</div>
</div>

## レビュワーが見るべき点

1. 書き換えの機械的な正しさ（定義順・初期化順が変わっていないか）。
2. enum 置換後の公開型が旧 enum 名のままか。
3. 完了条件の「フラグ検索ゼロ」の除外範囲（チケット文書・過去チケット・サブモジュール）が妥当か。
4. VP9 失敗をベースライン失敗として許容するか。
