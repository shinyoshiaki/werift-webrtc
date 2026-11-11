---
ide:
  viewer: review-document
  version: 1
  title: "ICE: semi-aggressive 既定と regular / renomination"
  dock: right
  baseCommit: 832672e32babb3302422654d87cc59b29a0b21f9
---
# ICE: 既定を semi-aggressive nomination にし、regular nomination と renomination を選べるようにする

## 1. 概要

controlling 側の werift は、UDP / relay の通常 check すべてに `USE-CANDIDATE` を付け、最初に成功したペアに固定していました。そのため trickle で後から届いた高優先度の TURN/UDP relay を使えず、実環境で RTT が約 6.2 s（TURN/TCP）に張り付いていました。

この変更では、既定を Chrome（libwebrtc）と同じ **semi-aggressive nomination** にしました。最初に成功したペアをすぐ選び、後から成功した高優先度ペアで選択を置き換えます。当初実装した **regular nomination** は `nomination: "regular"` で選べるオプションとして残し、`PeerConfig.iceRenomination` による **renomination**（NOMINATION 属性）も追加しました。HEAD の最後のコミットでは、接続完了時に打ち切った check のペアを Waiting に戻す修正（S10）を足しています。

<div style="display:flex;gap:12px;flex-wrap:wrap">
  <div style="flex:1;min-width:240px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px">
    <strong>Before</strong><br>通常 check すべてに <code>USE-CANDIDATE</code>。最初の成功ペアで固定。後から届く高優先度ペアは check されても選ばれず、ICE restart まで切り替わらない。
  </div>
  <div style="flex:1;min-width:240px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px">
    <strong>After（既定）</strong><br>最初の成功ペアを即選択（遅延なし）。選択より上位のペアだけ check を続け、成功したら選択を置き換える。両端が宣言すれば renomination、<code>"regular"</code> なら 1 回だけ指名。
  </div>
</div>

## 2. 主要変更

### 2.1 nomination 方式の選択（`packages/ice/src/ice.ts`）

方式は次の優先順で決まります。TCP ペアはどの方式でも regular nomination です（S8）。

<svg viewBox="0 0 760 170" width="100%" role="img" aria-label="nomination 方式の選択">
  <g fill="none" stroke="var(--review-border)">
    <rect x="4" y="10" width="150" height="46" rx="6"/>
    <rect x="200" y="10" width="170" height="46" rx="6" stroke="var(--review-accent)"/>
    <rect x="416" y="10" width="170" height="46" rx="6"/>
    <rect x="416" y="72" width="170" height="46" rx="6"/>
    <rect x="416" y="128" width="170" height="36" rx="6"/>
  </g>
  <g stroke="var(--review-muted)">
    <line x1="154" y1="33" x2="200" y2="33"/>
    <line x1="370" y1="33" x2="416" y2="33"/>
    <line x1="285" y1="56" x2="285" y2="95"/><line x1="285" y1="95" x2="416" y2="95"/>
    <line x1="285" y1="95" x2="285" y2="146"/><line x1="285" y1="146" x2="416" y2="146"/>
  </g>
  <g fill="var(--review-fg)" font-size="12" text-anchor="middle">
    <text x="79" y="30">controlling・</text><text x="79" y="46">full ICE</text>
    <text x="285" y="30">両端が renomination</text><text x="285" y="46">を宣言したか</text>
    <text x="501" y="30">yes: NOMINATION 属性</text><text x="501" y="46">（値は単調増加）</text>
    <text x="501" y="92">no・既定: semi-aggressive</text><text x="501" y="108">USE-CANDIDATE（上位のみ）</text>
    <text x="501" y="150">"regular": 1 ペアだけ指名</text>
  </g>
</svg>

- [packages/ice/src/ice.ts:2943](review-file:packages/ice/src/ice.ts:2943) `usesSemiAggressiveNomination()` が方式を判定します。renomination は `usesRenomination()`（[packages/ice/src/ice.ts:2913](review-file:packages/ice/src/ice.ts:2913)）で、両端が宣言したときだけ有効になり、`nomination` の設定より優先されます。
- semi-aggressive では、通常 check に `USE-CANDIDATE` を付けるのは「未選択の間」と「選択中のペアより上位のペア」だけです。置き換えは `replacesSelectedPair()`（[packages/ice/src/ice.ts:2993](review-file:packages/ice/src/ice.ts:2993)）が判定し、`checkComplete()`（[packages/ice/src/ice.ts:2495](review-file:packages/ice/src/ice.ts:2495)）が送信経路・consent・統計を新ペアへ移します。
- 選択後も上位ペアの check を続けます（S2）。下位のペアは作らず check もしません。
- renomination の指名は `evaluateSelection()`（[packages/ice/src/ice.ts:3031](review-file:packages/ice/src/ice.ts:3031)）と `nominateSelection()` が別の check で送ります。応答がない場合やエラーの場合、そのペアは使いません。
- controlled 側は `receivedNomination()`（[packages/ice/src/ice.ts:3015](review-file:packages/ice/src/ice.ts:3015)）で、NOMINATION の値（`USE-CANDIDATE` は 1）が大きいペアを優先し、同値なら優先度の高いペアを使います（S4・S7）。
- regular nomination（`RegularNomination`、[packages/ice/src/ice.ts:3772](review-file:packages/ice/src/ice.ts:3772)、`decideNomination`、[packages/ice/src/ice.ts:3645](review-file:packages/ice/src/ice.ts:3645)）は、静穏起点 + `nominationDelayMs`（既定 300 ms）か EOC 到達まで待ち、最良 valid pair にだけ専用 check を送ります。無応答は同じペアに計 3 回再送し、尽きたら `connect()` を reject します。provisional（ICE restart）にも同じ判定を適用しています。

### 2.2 オプションと SDP（公開 API）

| 追加物 | 場所 |
| --- | --- |
| `IceOptions.nomination` / `nominationDelayMs` / `renomination` | [packages/ice/src/iceBase.ts:370](review-file:packages/ice/src/iceBase.ts:370)〜[401](review-file:packages/ice/src/iceBase.ts:401) |
| `PeerConfig.iceNomination` / `iceNominationDelayMs` / `iceRenomination` | [packages/webrtc/src/api/peerConfig.ts:106](review-file:packages/webrtc/src/api/peerConfig.ts:106)〜[133](review-file:packages/webrtc/src/api/peerConfig.ts:133) |
| `RTCIceGatherer` への伝搬 | [packages/webrtc/src/secureTransportManager.ts:226](review-file:packages/webrtc/src/secureTransportManager.ts:226) |
| SDP の `a=ice-options:trickle renomination` 宣言 | [packages/webrtc/src/sdpManager.ts:63](review-file:packages/webrtc/src/sdpManager.ts:63) |
| STUN 属性 `NOMINATION`（0xC001） | [packages/ice-server/src/stun/attributes.ts:209](review-file:packages/ice-server/src/stun/attributes.ts:209) |

相手の `a=ice-options`（session / media）に `renomination` があるかは `remoteRenomination` として読み取ります。`iceRenomination` が既定の `false` なら、SDP は従来どおり `trickle` のみです。

### 2.3 ペア優先度の計算修正

`candidatePairPriority()` が `1 << 32`（JavaScript では 1）を使っていて、RFC 8445 §6.1.2.3 の式になっていませんでした。新設の `compareCandidatePairPriority()`（[packages/ice/src/iceBase.ts:528](review-file:packages/ice/src/iceBase.ts:528) 付近）が、53 bit を超える値でも正確に比較します。「最良ペア」の判定が正しくないと、どの方式でも意味がないためこの変更に含めました。

### 2.4 最後のコミットの修正（S10）

[packages/ice/src/ice.ts:2855](review-file:packages/ice/src/ice.ts:2855) `checkCancelled()` を追加し、[packages/ice/src/ice.ts:2724](review-diff:packages/ice/src/ice.ts:2724) の打ち切り経路から呼びます。

- Before: `connect()` 完了で打ち切られた check のペアが In-Progress のまま残りました。controlled 側が下位ペアで接続した場合、後から相手がそのペアを指名しても check が起動せず、選択を移せませんでした。
- After: 打ち切られた In-Progress のペアを Waiting に戻し、7.2.1.4 の triggered check の対象にします。打ち切り中に指名を受けていれば、すぐ check し直します。restart / close で終わった世代や checklist から外れたペアは対象外です。

<svg viewBox="0 0 760 120" width="100%" role="img" aria-label="S10 の before after">
  <g fill="none" stroke="var(--review-border)">
    <rect x="4" y="10" width="340" height="96" rx="6" stroke="var(--review-danger)"/>
    <rect x="416" y="10" width="340" height="96" rx="6" stroke="var(--review-success)"/>
  </g>
  <g fill="var(--review-fg)" font-size="12">
    <text x="16" y="32" font-weight="bold">Before</text>
    <text x="16" y="52">connect() 完了 → 上位ペアの check を打ち切り</text>
    <text x="16" y="70">ペアは In-Progress のまま</text>
    <text x="16" y="88">後から指名されても check されない → 経路が食い違う</text>
    <text x="428" y="32" font-weight="bold">After</text>
    <text x="428" y="52">打ち切り → ペアを Waiting に戻す</text>
    <text x="428" y="70">指名済みなら即 check、後続の指名でも triggered check</text>
    <text x="428" y="88">→ 両端が同じ上位ペアへ移る</text>
  </g>
</svg>

## 3. 判断理由

- **既定を semi-aggressive にした。** regular nomination は controlling の接続完了を 1 RTT（EOC がなければ最大 300 ms 加えて 1 RTT）遅らせます。Chrome の既定が semi-aggressive なので、相互接続時の挙動を揃えるために切り替えました。regular は `nomination: "regular"` で残しています。
- **ICE-TCP はどの方式でも regular。** TCP ペアは接続ごとに別で、複数を指名すると pruning 後に両端が別の接続になるためです（#721 と同じ理由）。
- **renomination は両端の宣言が必要。** ドラフトの前提に合わせ、相手が宣言しなければ使いません。controlled 側は設定に関係なく NOMINATION を処理します（Chrome と同じ）。
- **regular の待ちは静穏起点にした。** 上位の未完了ペアを無期限に待つと、到達不能な host↔host UDP の失敗確定（数秒）まで待つことになるため、deadline で打ち切ります。
- **regular で無応答のとき別ペアへ切り替えない。** 相手が受理済みかもしれず、切り替えると両端が別ペアに残る恐れがあるためです。
- **採用しなかった案:** 既定を regular のまま延長する案は、Chrome と接続完了の速さが食い違うため、ユーザーの追加要件（半 aggressive を既定）で不採用になりました。

## 4. レビュアーが確認すべき点・リスク

- **既定の挙動変更**: controlling の既定が変わります。従来の「最初の成功ペアで固定」はなくなり、後から上位ペアで選択が置き換わります。選択ペアの変化を前提にしている利用側がないか確認してください。
- **公開 API の追加**: `PeerConfig.iceNomination` / `iceNominationDelayMs` / `iceRenomination`、`IceOptions.nomination` / `nominationDelayMs` / `renomination`、SDP の `renomination` 宣言、STUN 属性 `NOMINATION`。`iceRenomination` を有効にすると SDP が変わります。
- **`getSelectedCandidatePair()`**: nominated ペアだけを返します（[packages/webrtc/src/transport/ice.ts:631](review-file:packages/webrtc/src/transport/ice.ts:631) 付近）。check 成功だけのペアは返さなくなりました。
- **指名応答を失った場合の食い違い**: semi-aggressive では、相手が受理して応答だけ失われると、両端の経路が一時的に食い違うことがあります。werift はどのペアで受けたデータも受け付けるので、データは届きます（libwebrtc と同じ性質）。
- **Chrome の renomination は SDP 書き換え依存**: Chrome は JS API を持たず、`a=ice-options` の書き換え（SDP munging）で有効にします。将来拒否される可能性があります（E2E もこの書き換えに依存）。
- **ペア優先度の値の変化**: `candidatePairPriority()` の戻り値が `MAX_SAFE_INTEGER` を超えることがあります。順序比較は `compareCandidatePairPriority()` を使ってください。
- **チケット範囲を超える変更**: ペア優先度の修正、無応答時の再送・失敗扱い、487 と pranswer の final answer の扱い、`forceTurn` 時の provisional が含まれます。changelog には記載しています。
- **差分の規模**: `ice.ts` の変更が大きいため、2.1 の関数を起点に読むのが効率的です。差分は [packages/ice/src/ice.ts](review-diff:packages/ice/src/ice.ts:2943) と [changelog.md](review-diff:changelog.md) から辿れます。
- **PBT oracle の緩和**: [packages/webrtc/tests/pbt/model/oracles.ts](review-diff:packages/webrtc/tests/pbt/model/oracles.ts) で、ICE 自身による選択ペアの置き換え（指名の値が大きい、または同値で優先度が高いペアへの移動）を許容しました。劣るペアへの変化や、restart で旧ペアが外れた場合は従来どおり失敗です。許容範囲が妥当か確認してください。

## 5. 検証結果

この文書の作成時に、次を**実行しました**。

- `cd packages/ice && npx vitest run tests/ice/semi-aggressive.test.ts tests/ice/nomination.test.ts tests/ice/consent.test.ts tests/ice/tcp.test.ts` → 4 ファイル / 116 テストがすべて合格。

テストの構成は次のとおりです。

- [packages/ice/tests/ice/semi-aggressive.test.ts](review-file:packages/ice/tests/ice/semi-aggressive.test.ts): 既定の即時選択、上位ペアでの置き換え、下位ペアは指名しない、trickle で後から届く候補、renomination（NOMINATION の値の増加、応答なし、ロール変更）、controlled 側の優先規則、実ソケットでの収束、S10 の再 check。
- [packages/ice/tests/ice/nomination.test.ts](review-file:packages/ice/tests/ice/nomination.test.ts): `nomination: "regular"` の挙動（遅延・EOC・再送・失敗・provisional・forceTurn）。
- [packages/ice/tests/utils.ts](review-diff:packages/ice/tests/utils.ts): Arrange ヘルパー。
- [packages/webrtc/tests/transport/ice.test.ts](review-file:packages/webrtc/tests/transport/ice.test.ts): `iceNomination` / `iceRenomination` の伝搬と SDP 宣言。
- `e2e/tests/ice/nomination.test.ts`: Chrome との相互接続（Chrome / werift が controlling × renomination の有無の 4 通り）。

**未実行**: `npm run type`、`npm run test:small`、`npm run wpt`、`npm run e2e`（Chrome 相互接続を含む）、`npm run ci`。チケット §9.3 / 9.4 には検出力の確認結果が記載されていますが、この文書では再実行していません。承認前に CI の結果を確認してください。
