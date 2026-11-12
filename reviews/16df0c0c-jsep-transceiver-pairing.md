---
ide:
  viewer: review-document
  version: 1
  title: "#816 remote offer の transceiver 関連付けを JSEP に合わせる"
  dock: right
  baseCommit: 30e6a20aca9f39a1ece429527267b9fe6c8cceb8
---
# #816 remote offer が addTransceiver 作成の transceiver を奪わないようにする

## 1. 概要

remote offer の m-section に MID が一致する transceiver がないとき、これまでの werift は「同じ kind で MID 未設定の transceiver」を何でも関連付けていました。そのため perfect negotiation の glare で、アプリが `addTransceiver("audio", { direction: "sendonly" })` で作った transceiver の方向と MID が相手の offer に上書きされていました。

この変更は RFC 8829 §5.10（JSEP）に合わせ、関連付けの対象を「`addTrack()` が作った（または rollback で昇格した）未関連付けの transceiver」に絞ります。既定を JSEP にする破壊的変更なので、旧挙動に戻す `PeerConfig.transceiverPairing: "legacy"` を追加しました。チケットの 2.5 で決定済みの方針です。

## 2. 修正前後の流れ

同じ入力（A が offer、B が offer を受ける前に `addTransceiver("audio", { direction: "sendrecv" })` 済み）で比べます。

<div style="display:flex;gap:12px;flex-wrap:wrap;font-family:sans-serif;font-size:13px">
<div style="flex:1;min-width:300px;border:1px solid #c0392b;border-radius:8px;padding:10px">
<b style="color:#c0392b">Before（legacy 相当）</b>
<ol style="margin:6px 0 0 18px;padding:0">
<li><code>findTransceiver()</code>: MID 不一致</li>
<li>同じ kind で <code>mid == null</code> の transceiver を全て候補にする</li>
<li style="color:#c0392b"><b>addTransceiver 由来の transceiver を取る</b></li>
<li style="color:#c0392b">MID が <code>"0"</code> に、方向が offer で上書きされる</li>
<li style="color:#c0392b">transceiver 1 個、アプリの指定は失われる</li>
</ol>
</div>
<div style="flex:1;min-width:300px;border:1px solid #27ae60;border-radius:8px;padding:10px">
<b style="color:#27ae60">After（jsep、既定）</b>
<ol style="margin:6px 0 0 18px;padding:0">
<li><code>matchRemoteTransceiver()</code>: MID 不一致</li>
<li>候補を <code>createdBy === "addTrack"</code> に絞る。sendonly / inactive の m-line は新規作成</li>
<li style="color:#27ae60"><b>該当なし、remote 用 transceiver を新規作成</b></li>
<li style="color:#27ae60">ローカル側は <code>mid === null</code> と指定方向を保つ</li>
<li style="color:#27ae60">transceiver 2 個、answer 確定後に <code>negotiationneeded</code></li>
</ol>
</div>
</div>

*図: 赤が修正前に問題が起きていた分岐、緑が修正で変わった分岐です。*

## 3. 主要変更

### 3.1 生成元の記録

[packages/webrtc/src/media/rtpTransceiver.ts:46](review-file:packages/webrtc/src/media/rtpTransceiver.ts:46) に内部フィールド `createdBy`（`"addTrack" | "addTransceiver" | "remote"`）と `reusedForAddTrack` を追加しました。付与は [packages/webrtc/src/transceiverManager.ts:497](review-diff:packages/webrtc/src/transceiverManager.ts:497) と、`addTrack()` が新規作成する経路（[:617](review-diff:packages/webrtc/src/transceiverManager.ts:617)）で行います。既存 transceiver を `addTrack()` で再利用しても生成元は変えません（remote 起源のときだけ `reusedForAddTrack` を立てます。[:631](review-diff:packages/webrtc/src/transceiverManager.ts:631)）。トラックの有無や MID は判定に使いません。

### 3.2 関連付けの純関数化

新規ファイル [packages/webrtc/src/negotiation/transceiverPairing.ts:55](review-file:packages/webrtc/src/negotiation/transceiverPairing.ts:55) の `matchRemoteTransceiver()` が、MID 一致、port 0 の除外、JSEP 条件（`createdBy === "addTrack"`、m-line が sendrecv / recvonly）を一箇所で判定します。`legacy` では旧条件のままです。[packages/webrtc/src/negotiation/remoteMediaApplication.ts:272](review-diff:packages/webrtc/src/negotiation/remoteMediaApplication.ts:272) の `findTransceiver()` はこの関数を呼ぶだけになりました。

### 3.3 planCodecs と apply の対応付けを一致させる

`planCodecs` は暗黙の rollback より前、`apply` は後に走ります。glare で自分の pending offer が付けた MID と相手の MID が同じだと、plan 側だけがローカル transceiver と対応付けてしまう問題がありました。

[packages/webrtc/src/negotiationTransaction.ts:391](review-diff:packages/webrtc/src/negotiationTransaction.ts:391) の `pairingViewForRemoteOffer()` が、rollback / replace / 未適用 createOffer の取り消し後に見える状態を、何も書き換えずに返します。[packages/webrtc/src/peerConnection.ts:1682](review-diff:packages/webrtc/src/peerConnection.ts:1682) でこれを `planCodecs` に渡し、plan と apply が同じ関数・同じ状態で対応付けます。

### 3.4 rollback での昇格と negotiationneeded

- rollback で残る remote 起源 transceiver が `addTrack()` で再利用されていたら `createdBy` を `"addTrack"` に昇格します（JSEP 4.1.8.2）。[packages/webrtc/src/transceiverManager.ts:223](review-diff:packages/webrtc/src/transceiverManager.ts:223)
- 関連付かなかった `addTransceiver` 分を次の offer に載せるため、answer 確定後に未関連付けの transceiver があれば `negotiationneeded` を再評価します（jsep のみ）。[packages/webrtc/src/peerConnection.ts:1510](review-diff:packages/webrtc/src/peerConnection.ts:1510)

### 3.5 公開オプション

[packages/webrtc/src/api/peerConfig.ts:205](review-diff:packages/webrtc/src/api/peerConfig.ts:205) に `transceiverPairing`（既定 `"jsep"`）を追加しました。不正値は `TypeError`、`setConfiguration()` での変更は `InvalidModificationError` で、`mLineReuse` と同じ扱いです。

### 3.6 利用側の移行・docs・テスト・WPT

- examples と e2e handler は、answer 側が SRD 前に `addTransceiver()` していた箇所を `addTrack()` などに書き換え、`legacy` に頼らない形にしました（例: [examples/mediachannel/sendrecv/answer.ts](review-diff:examples/mediachannel/sendrecv/answer.ts)）。
- [changelog.md](review-diff:changelog.md) に Breaking changes と Features を追記し、[packages/webrtc/README.md](review-diff:packages/webrtc/README.md) と生成 docs を更新しました。
- テスト: [packages/webrtc/tests/negotiation/cases/negotiationTransactionPairing.test.ts](review-file:packages/webrtc/tests/negotiation/cases/negotiationTransactionPairing.test.ts)（jsep / legacy の表比較）、[packages/webrtc/tests/issue/816.test.ts](review-file:packages/webrtc/tests/issue/816.test.ts)（設定の検証）、PBT の [oracle](review-diff:packages/webrtc/tests/pbt/model/oracles.ts) と [固定シーン](review-diff:packages/webrtc/tests/pbt/model/scenes.ts:559)。
- [packages/webrtc/tools/negotiation-diff/run.ts:90](review-diff:packages/webrtc/tools/negotiation-diff/run.ts:90) に `legacyPairing` 設定を追加しました。
- [packages/webrtc/wpt/allowlist.json](review-diff:packages/webrtc/wpt/allowlist.json) に `RTCRtpTransceiver` の DoesntPair 3 件と perfect-negotiation の setup 2 件を gate として追加し、glare 系は `enabled: false` または gate 外にしました。

## 4. 判断理由

| 選択 | 理由 | 採らなかった案 |
| --- | --- | --- |
| 既定を `"jsep"`（破壊的変更） | 実際の glare で指定方向が壊れるのは相互接続の誤りで、WPT 専用の厳密化ではない。`werift/polyfill` の利用者もブラウザ挙動を期待する。`mLineReuse`（v0.25.0）に前例がある | 既定を legacy のままにする案。既定経路に不具合が残る |
| 関連付けを純関数 + view で共有 | plan と apply の食い違いを構造的に防ぐ | rollback 後に planCodecs をやり直す案。codec 非互換を rollback 前に拒否する既存設計が崩れる |
| 生成元を snapshot に含めない | アプリ操作で決まる属性で、含めると rollback で巻き戻る | なし |
| 操作チェーンの遅延解放（旧 `a29d5c0`）を取り除く | PBT seed 263 の回帰の原因で、#816 の範囲外。別チケット cd89d492 に分離 | 本チケットで同時に直す案 |

## 5. レビュアーが確認すべき点・リスク

- **破壊的変更**: SRD の前に `addTransceiver()` して自動関連付けに頼っていた answer 側は、新しい transceiver が作られ、元の transceiver は未関連付けのまま残ります。移行は changelog と README にあります。
- jsep では remote の m-line が `sendonly` / `inactive` のとき、`addTrack` 起源でも関連付けず新規作成します（[transceiverPairing.ts:78](review-file:packages/webrtc/src/negotiation/transceiverPairing.ts:78) 付近）。チケット本文にない条件なので、仕様（JSEP §5.10）との整合を確認してください。
- `pairingViewForRemoteOffer()` は `restoreState` 等の処理を写した実装で、二重管理です。rollback の仕様を変えるときは両方の更新が要ります。
- glare 系 WPT（`glare` 2 件、stress-glare 2 ファイル）は gate に入っていません。develop にも操作チェーンの競合があり、cd89d492 の範囲です。
- 型 `TransceiverPairing` / `TransceiverPairingModes` が公開されます（`peerConnection.ts` から export）。

## 6. 検証結果

私（この文書の作成担当）はテストを実行していません。以下はチケットファイル 7章に記録された、コミット前の検証結果です。

- 全体 `npm run wpt`: gate を setup 2 件に絞った後、20 回連続で回帰 0。gate 対象 5 件は 30 回すべて PASS。gate 外の glare 系は 20 回中 10 回で 1 件以上 FAIL。
- `pbt:deep --jobs 8` で失敗した seed を develop と本ブランチで 10 回ずつ単独再実行した結果、本ブランチだけで新たに再現する失敗はなし。seed 50（VP8 の `transport-cc` 不一致）は develop でも最小シーンで再現する既存の不一致です。
- この記録は HEAD `cd3ac9b3b` に未コミット変更を当てた状態のもので、最終コミット `30e6a20ac` での再実行結果は、今回確認できていません。
- `npm run type`、`npm run test:small`、`npm run e2e`、`npm run examples:e2e`、`negotiation-diff`（`legacyPairing` で差分 0）の結果は、チケット上に記録がなく未確認です。
