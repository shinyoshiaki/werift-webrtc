---
ide:
  viewer: review-document
  version: 1
  title: "ICE: UDP / relay ペアの regular nomination"
  dock: right
  baseCommit: 225e2038d33da13fb5829b890a703cdc51ac03cc
---
# ICE: UDP / relay ペアにも regular nomination を使う

## 1. 概要

controlling 側の full ICE が、UDP / relay の通常 connectivity check にも `USE-CANDIDATE` を付けていました（aggressive nomination）。そのため、先に成功した低優先度ペア（例: TURN/TCP relay）がそのまま選ばれ、後から trickle で届いた TURN/UDP relay は選べませんでした。

この変更で、通常 check からは `USE-CANDIDATE` を外しました。valid pair の中から最良の 1 つを選び、そのペアにだけ専用の `USE-CANDIDATE` check を 1 回送ります（RFC 8445 §8.1.1）。待ち時間は新オプション `nominationDelayMs`（既定 300 ms）で決めます。live の checklist と ICE restart の provisional generation の両方に、同じ判定ロジックを適用しました。

<div style="display:flex;gap:12px;flex-wrap:wrap">
  <div style="flex:1;min-width:240px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px">
    <strong>Before</strong><br>通常 check すべてに <code>USE-CANDIDATE</code>。最初に成功したペアが即 nominated になり、残りは FAILED。TURN/TCP が先に成功すると RTT 約 6.2 s のまま固定。
  </div>
  <div style="flex:1;min-width:240px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px">
    <strong>After</strong><br>通常 check は <code>USE-CANDIDATE</code> なし。静穏期間（既定 300 ms）または EOC 到達まで待ち、最良 valid pair にだけ専用 check を 1 回送る。
  </div>
</div>

## 2. 主要変更

### 2.1 nomination 判定（`packages/ice/src/ice.ts`）

判定は純関数 [packages/ice/src/ice.ts:3121](review-file:packages/ice/src/ice.ts:3121) `decideNomination` に切り出し、`RegularNomination` クラス（[packages/ice/src/ice.ts:3248](review-file:packages/ice/src/ice.ts:3248)）が `nominate` / `wait` / `none` / `abandon` の結果に従ってタイマーと送信を管理します。live と provisional は `NominationHost` を介して同じクラスを使います。差分全体は [packages/ice/src/ice.ts](review-diff:packages/ice/src/ice.ts:3121) で確認できます。

<svg viewBox="0 0 760 150" width="100%" role="img" aria-label="nomination 判定フロー">
  <g fill="none" stroke="var(--review-border)">
    <rect x="4" y="10" width="170" height="52" rx="6"/>
    <rect x="214" y="10" width="170" height="52" rx="6" stroke="var(--review-accent)"/>
    <rect x="424" y="10" width="150" height="52" rx="6"/>
    <rect x="614" y="10" width="140" height="52" rx="6"/>
    <rect x="214" y="90" width="170" height="52" rx="6"/>
  </g>
  <g stroke="var(--review-muted)">
    <line x1="174" y1="36" x2="214" y2="36"/><line x1="384" y1="36" x2="424" y2="36"/><line x1="574" y1="36" x2="614" y2="36"/>
    <line x1="299" y1="62" x2="299" y2="90"/>
  </g>
  <g fill="var(--review-fg)" font-size="12" text-anchor="middle">
    <text x="89" y="32">check 成功 / ペア追加</text><text x="89" y="48">EOC / タイマー満了</text>
    <text x="299" y="32">decideNomination</text><text x="299" y="48">（最良 valid pair を選ぶ）</text>
    <text x="499" y="32">nominate</text><text x="499" y="48">専用 USE-CANDIDATE を 1 回</text>
    <text x="684" y="32">ICE_COMPLETED</text>
    <text x="299" y="112">wait: deadline に再武装</text><text x="299" y="128">none / abandon</text>
  </g>
</svg>

判定規則は次のとおりです。

- 先頭（最高優先度）の `SUCCEEDED` ペアを候補にします。
- 両側の end-of-candidates（EOC）が済み、かつ候補より上位に未完了ペアがなければ、即 nominate します。
- それ以外は `quietSince + nominationDelayMs` を deadline とし、到達で nominate します。上位の未完了ペアを無期限には待ちません。
- `quietSince` は、最初の valid pair の成立時刻と、最良 valid pair を上回るペアが最後に追加された時刻のうち、遅いほうです。下位ペアの追加では動きません。

[packages/ice/src/ice.ts:57](review-file:packages/ice/src/ice.ts:57) に既定値 `DEFAULT_NOMINATION_DELAY_MS = 300` があり、負値や非有限値はこの既定値に戻します。

### 2.2 オプションと公開 API

- [packages/ice/src/iceBase.ts:298](review-diff:packages/ice/src/iceBase.ts:298): `IceOptions.nominationDelayMs` を追加しました。
- [packages/webrtc/src/api/peerConfig.ts:92](review-diff:packages/webrtc/src/api/peerConfig.ts:92): `PeerConfig.iceNominationDelayMs` を追加しました。
- [packages/webrtc/src/secureTransportManager.ts:190](review-diff:packages/webrtc/src/secureTransportManager.ts:190): `RTCIceGatherer` へ `nominationDelayMs` を渡します。
- [packages/webrtc/src/transport/ice.ts](review-diff:packages/webrtc/src/transport/ice.ts:631): `getSelectedCandidatePair()` は、nominated ペアだけを返すようにしました（挙動変更。§4 参照）。

### 2.3 ペア優先度の計算修正（`packages/ice/src/iceBase.ts`）

[packages/ice/src/iceBase.ts:380](review-diff:packages/ice/src/iceBase.ts:380): 既存の `candidatePairPriority()` は `1 << 32`（JavaScript では 1）を使っていて、RFC の `2^32 * MIN(G,D)` になっていませんでした。「最良ペア」の選択が正しくなければ regular nomination の意味がないため、この PR で直しています。新設の `compareCandidatePairPriority()` は、53 bit を超える値でも正確に比較します。`sortCandidatePairs()` は同順位の入力順を保ちます。

### 2.4 provisional generation（ICE restart）

pranswer による provisional の checklist にも同じ `RegularNomination` を適用しています（`ProvisionalGeneration` が nomination を持ちます）。pranswer の置換、rollback、`restart()` / `close()` でタイマーを解除し、stale な結果は無視します。final answer 後は、provisional で nominate したペアと同じ 5-tuple だけを nominate します（`NominationHint`）。ピアが既にそのペアを選択済みの可能性があるためです。

### 2.5 nomination 失敗時の扱い

| 結果 | 動作 |
| --- | --- |
| エラー応答 / 送信不能 | そのペアだけ FAILED にして、次点の valid pair で再評価 |
| 無応答（timeout） | ピアが選択済みかもしれないため同じペアに再送（合計 3 transaction）。それでも駄目なら他ペアへ移らず `connect()` を reject して `failed` |
| 487（role conflict） | controlled へ切替。ペアは valid のまま |
| role 切替中の in-flight | 遅れて届いた応答・timeout は無効 |

ICE-lite 相手と controlled 側の挙動は変えていません。

## 3. 判断理由

- **遅延の起点を静穏起点にした。** 「最初の valid pair から固定時間」では、直後に届く高優先度候補を救えません。「最後の候補追加から」では、結果に影響しない低優先度候補でも待ちが延びます。
- **上位の未完了ペアを無期限には待たない。** TCP 専用だった旧ロジックをそのまま流用すると、到達不能な host↔host UDP の失敗確定（数秒）を待つことになり、通常の NAT 越えが遅くなります。TCP も同じ deadline 方式に統一しました。
- **EOC を待ち続けない。** `a=end-of-candidates` を送らない相手でも、deadline で必ず nominate します。その代わり、そうした相手では接続確立が最大 `nominationDelayMs` 遅くなります。
- **provisional も同じ PR で対応した。** live だけ直すと restart 時の挙動が食い違うためです。判定は共通の純関数にまとめました。
- **無応答時に他ペアへ切り替えない。** 切り替えると、両 agent が別のペアに居続ける恐れがあります。失敗として扱い、ICE restart で復旧させます。

## 4. レビュアーが確認すべき点・リスク

- **接続確立の遅延**: EOC を送らない相手では最大 300 ms 増えます。EOC 済みで上位に未完了ペアがなければ増えません。`0` を指定すれば猶予なしです。
- **公開 API の挙動変更**: `RTCIceTransport.getSelectedCandidatePair()` は、nominated ペアがなければ `null` を返します（以前は check に成功したペアを返していました）。[packages/webrtc/src/transport/ice.ts](review-diff:packages/webrtc/src/transport/ice.ts:631) を利用側で参照している箇所がないか確認してください。
- **ペア優先度の値の変化**: `candidatePairPriority()` の戻り値が RFC の式に変わり、`MAX_SAFE_INTEGER` を超えることがあります。順序の比較には `compareCandidatePairPriority()` を使ってください。
- **チケット範囲を超える変更**: ペア優先度の修正、無応答時の再送・失敗扱い、487 と pranswer の final answer の扱い、`forceTurn` 時の provisional が含まれます。いずれもチケット本文には明記されていません。changelog には記載がありますが、範囲として妥当かを判断してください。
- **差分の規模**: `ice.ts` の変更が大きく（約 970 行）、`RegularNomination` と `decideNomination` を中心に読むのが効率的です。
- **ドキュメント**: `doc/` と `packages/ice/doc` は生成物です。[changelog.md](review-diff:changelog.md) も更新済みです。

## 5. 検証結果

このドキュメント作成時点では、テスト・型検査・WPT・E2E を**新たには実行していません**。差分、チケット本文、テスト名の確認だけを行いました。

追加・更新されたテストの構成は次のとおりです。

- [packages/ice/tests/ice/nomination.test.ts](review-file:packages/ice/tests/ice/nomination.test.ts:28): 新規（約 1,590 行）。UDP/relay の高優先度勝ち、trickle、EOC なし、`nominationDelayMs: 0`、下位ペア追加で deadline が延びないこと、単一 nomination、失敗・再送、role 変更、ICE-lite、provisional、forceTurn、実ソケットを使う統合ケース。
- [packages/ice/tests/utils.ts](review-diff:packages/ice/tests/utils.ts): Arrange ヘルパーを集約。
- [packages/ice/tests/ice/ice.test.ts](review-diff:packages/ice/tests/ice/ice.test.ts): ペア優先度比較のテスト。
- [packages/webrtc/tests/transport/ice.test.ts](review-diff:packages/webrtc/tests/transport/ice.test.ts): `iceNominationDelayMs` の伝搬と `getSelectedCandidatePair` のテスト。

チケット完了条件の `cd packages/ice && npm run type && npm test`、`npm run wpt`、`npm run e2e` の結果は、この文書からは確認していません。承認前に CI の結果を確認してください。
