---
ide:
  viewer: review-document
  version: 1
  title: "ICE consent: 高RTT・損失下の誤失効の修正"
  dock: right
  baseCommit: 3a028d90fcb8d65402d3fd34ebaf63a143af1318
---
# ICE consent: 高 RTT・損失下の誤失効の修正

## 1. 概要

正常なピアが真正な consent 応答を返し続けているのに、RTT が見積もりより上がると応答が捨てられ、30 秒後に `failed` になる問題を直しました。原因は、consent request の transaction を RTT 見積もり（最低 500 ms）で閉じていたことと、次の request が前の request を abort していたことです。

修正後は、request を従来どおり 1 回だけ送り、その transaction を `CONSENT_TIMEOUT`（30 秒）まで開いたままにします。nomination の方式（regular、ICE-TCP、ICE-lite、failover）には依存しません。遅れて届いた有効な応答も、RFC 7675 §5.1 の「応答は以前の request に対するものかもしれない」に沿って consent の期限を延ばします。

## 2. 修正前の問題

consent の応答待ちは `consentResponseTimeoutMs(nominated.rtt)` で決まっていました。RTT 見積もりは「受理した応答」でしか更新されません。そのため、選択時に RTT が 10 ms で、その後 1 s に上がった経路では、次のように自己ロックしました。

<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-family:sans-serif;font-size:13px">
<div style="border:2px solid #d9534f;border-radius:8px;padding:10px">
<b style="color:#d9534f">Before（RTT 10ms → 1000ms）</b>
<ol style="margin:6px 0 0 18px;padding:0">
<li>選択時 <code>nominated.rtt</code> = 10 ms</li>
<li><code>responseTimeout</code> = 500 ms（<code>consentResponseTimeoutMs</code>）</li>
<li>500 ms で <code>TransactionTimeout</code>、txid が map から消える</li>
<li>1 s 後に真正な応答が届く → <b style="color:#d9534f">未登録 txid として破棄</b></li>
<li>RTT が更新されず 500 ms のまま → 30 s 後に <b style="color:#d9534f">failed</b></li>
<li>RTT ≥ 4〜6 s は、次の request の <code>abort()</code> でも破棄</li>
</ol>
</div>
<div style="border:2px solid #2e9e5b;border-radius:8px;padding:10px">
<b style="color:#2e9e5b">After（同じ入力）</b>
<ol style="margin:6px 0 0 18px;padding:0">
<li>選択時 <code>nominated.rtt</code> = 10 ms</li>
<li>transaction は <b style="color:#2e9e5b">30 s 開いたまま</b>（<code>CONSENT_TIMEOUT</code>）</li>
<li>次の request は前の request を abort しない</li>
<li>1 s 後の応答は登録済み txid なので<b style="color:#2e9e5b">受理され期限を延長</b></li>
<li>RTT 見積もりが 1 s に更新される</li>
<li>連続して応答があれば <b style="color:#2e9e5b">connected のまま</b></li>
</ol>
</div>
</div>

*図: 同じ入力（RTT が 10 ms から 1 s に上がる経路）での処理の流れ。赤が修正前に失われていた応答、緑が修正後の経路です。*

## 3. 主要変更

### 3.1 consent の request 管理（`packages/ice/src/consent.ts`）

- request ごとに `AbortController` を持ち、`outstanding` に集めます。前の request を次の request が abort することはなくなりました: [packages/ice/src/consent.ts:103](review-file:packages/ice/src/consent.ts:103)
- transaction の寿命は failover の有無にかかわらず `CONSENT_TIMEOUT * 1000` です。RTT ベースの値は「未応答とみなす期限」にだけ使います: [packages/ice/src/consent.ts:395](review-diff:packages/ice/src/consent.ts:395)
- 同時に開く request の上限は `CONSENT_MAX_OUTSTANDING_REQUESTS`（35 = 30 s ÷ failover の 900 ms 間隔 + 1）です。上限を超えたら最古のものだけ終了します。30 s 以内に応答され得る request は上限では終わりません: [packages/ice/src/consent.ts:28](review-file:packages/ice/src/consent.ts:28)
- 失効、`stop()`、`cancelRequests()`、restart、close、新しい selection では、すべての未完了 request を `abortRequests()` で破棄します。失効後の遅延応答では consent は戻りません: [packages/ice/src/consent.ts:152](review-file:packages/ice/src/consent.ts:152)
- 応答が順不同で届いた場合、古い request の応答は RTT の合計値にだけ数え、現在の RTT 見積もりは新しい request の応答で更新します: [packages/ice/src/consent.ts:474](review-diff:packages/ice/src/consent.ts:474)

### 3.2 RTT 関数と定数の役割変更（`packages/ice/src/iceBase.ts`）

`consentResponseTimeoutMs()` と `CONSENT_RESPONSE_TIMEOUT` は残しました。役割は「transaction の寿命」から「未応答とみなす期限」と「backup check の応答待ち」に変わっています。コメントと生成 doc を更新しています: [packages/ice/src/iceBase.ts:419](review-diff:packages/ice/src/iceBase.ts:419)

### 3.3 テスト

- 共有 Arrange の [packages/ice/tests/utils.ts](review-diff:packages/ice/tests/utils.ts) に、本物の `StunProtocol` と `Transaction` を通す遅延・損失・順序入れ替えのハーネスを追加しました。従来の `ConsentMockProtocol` は timeout も abort も無視するため、この経路を通っていませんでした。
- 新規の [packages/ice/tests/ice/consent-network.test.ts](review-file:packages/ice/tests/ice/consent-network.test.ts) が、次を検証します。
  - 応答が続く経路では失効しない（RTT の上昇、往復 5.5 s、順序入れ替え、損失バースト）。
  - 応答がなければ 31 s の blackhole で `failed` になる。
  - 旧 generation、旧 pair、restart 前の応答は期限を延長しない。
  - 未完了 transaction が lifecycle の各終了点で 0 になる。
  - 送信間隔が 4〜6 s で、request ごとに wire 送信が 1 回である。
- [packages/ice/tests/ice/consent-wire.test.ts](review-diff:packages/ice/tests/ice/consent-wire.test.ts) を新しい寿命に合わせて更新しました。

### 3.4 ドキュメント

[changelog.md](review-diff:changelog.md)、[packages/ice/README.md:94](review-file:packages/ice/README.md:94) の "Consent freshness (RFC 7675)" 節、`doc/` と `packages/ice/doc/` の生成 doc を更新しました。

## 4. 判断理由

| 案 | 採否 | 理由 |
| --- | --- | --- |
| transaction を 30 s 開く + request 単位の abort | 採用 | RTT の見積もりに依存せず、自己ロックと次 request による abort を両方なくせる |
| 応答待ちを 4 s に固定（下流パッチ） | 不採用 | RTT ≥ 4 s では次 request の abort が残り、RTT に基づく待ちという SHOULD からも外れる |
| 応答がないとき 1 s ごとに追加送信（下流パッチ） | 不採用 | RFC 7675 §5.1 の「4 秒未満禁止」に違反し、損失時に負荷を増やす |
| 同時 request の上限なし | 不採用 | 未完了 transaction が無制限に増える。上限は 30 s 内に応答され得るものを切らない値にした |

## 5. レビュアーが確認すべき点・リスク

- 公開 API の追加: `CONSENT_MAX_OUTSTANDING_REQUESTS` を export しています。`outstandingRequests` は `@internal` です。
- 挙動の変更: failover を使わない構成でも、transaction が 30 s 開くようになります。メモリは上限 35 件で抑えています。
- `consentResponseTimeoutMs` の意味が変わったので、利用者向けの説明が README、changelog、生成 doc で一致しているか確認してください。
- failover の 900 ms 間隔（weak な pair のとき）は RFC §5.1 の 4 s より短い挙動です。これは今回変えておらず、libwebrtc に合わせた従来動作で、failover 有効時だけ適用されます。README に注記を追加しました。
- #860（経路が消えたときの disconnected 遷移）と #730（イベントループ飢餓）は対象外です。

## 6. 検証結果

- 実行: `cd packages/ice && npx vitest run tests/ice/consent-network.test.ts tests/ice/consent-wire.test.ts` → 2 ファイル / 38 テストすべて成功（この文書作成時に実行）。
- 未実行: `npm run type`、`npm run test:small`、`npm run pbt:deep`、WPT、E2E。この文書作成では再実行していません。過去のレビュー結果は、チケットとレビュー履歴を参照してください。
