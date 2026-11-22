---
ide:
  viewer: review-document
  version: 1
  title: "ICE: RTT・受信状態による選択ペアの切り替え"
  dock: right
  baseCommit: 831ee3dd8994cb75a8579ca7ae2134fdb3176794
---
# ICE: RTT・受信状態による選択ペアの切り替え（SelectionController）

## 1. 概要

controlling 側の werift が、選択中のペアを「書き込み可否 → 受信状態 → priority → RTT」の順で backup と比べ、勝つ backup を再指名して移るようにしました。libwebrtc の `BasicIceController::ShouldSwitchConnection` に相当します。これまでは priority の高いペアか、応答が止まったペアからのフェイルオーバーでしか移りませんでした。

追加した仕組みは次の 3 つです。
- priority が同じペアどうしでは、平滑化した RTT が 10 ms 以上低いペアへ移る
- 選択中のペアが受信していない場合、受信している backup へは 1 秒の保留後に移る。保留中に回復すれば移らない
- RTT は直近 5 サンプルの中央値を使うので、外れ値 1 回では移らない

初回実装は [0752292b6](review-diff:packages/ice/src/nomination/selectionController.ts:commit:0752292b6) と、テスト用 UDP 中継のタイマー後始末を直した c71d9123a です。今回の再レビュー（4 回目）では、「非受信」の起点の取り方を failover と共通化する修正（94e4eeff1 / c846a3a8a / 831ee3dd8）が入っています。ベースブランチ `main` との差分には他チケットの取り込みが大量に含まれるので、チケット固有のコミットだけを見れば足ります。

## 1.1 再レビューでの修正（4 回目）

「非受信になった時刻」を `SelectionController` と failover 監視で別々に数えていたため、判定がずれる場合がありました。たとえば、2.5 秒の無受信のあとで未応答の check が遅れて確定すると、保留 1 秒の起点が食い違います。この場合、保留の途中で RTT により切り替わった移行を failover とみなし、旧ペアを demote してしまう恐れがありました。

- [packages/ice/src/failover.ts:172](review-file:packages/ice/src/failover.ts:172) に `notReceivingSince()` を移し、無受信 2.5 秒と未応答 check の「遅い方」を起点にしました。`isNotReceiving()`（[同:194](review-diff:packages/ice/src/failover.ts:194)）も同じ起点から `receivingSwitchingDelay` を数えます。保留は 1 秒より短くなりません。
- [packages/ice/src/nomination/selectionController.ts:76](review-file:packages/ice/src/nomination/selectionController.ts:76) の `shouldSwitch()` は `receivingTimeout` を受け取ります。`SelectionControllerHost.thresholds` で `IceOptions.failover` の閾値（`receivingTimeout` / `receivingSwitchingDelay`）に従います。
- `evaluate()` の候補選びは `betterTarget()`（[同:244](review-diff:packages/ice/src/nomination/selectionController.ts:244)）で、受信中のペア → priority → RTT の順に比べます。`shouldSwitch` と同じ順序です。
- 重複していた `RECEIVING_SWITCHING_DELAY` の宣言を [packages/ice/src/iceBase.ts](review-diff:packages/ice/src/iceBase.ts) から 1 つ削除しました。
- changelog と [packages/ice/README.md](review-diff:packages/ice/README.md) に、起点の定義と「保留中の切り替えは failover ではなく旧ペアを demote しない」を追記しました。

## 2. 処理の流れ（Before / After）

<div style="display:flex;gap:16px;flex-wrap:wrap;font-family:sans-serif;font-size:13px">
<div style="flex:1;min-width:300px;border:1px solid #c0392b;border-radius:8px;padding:12px">
<b style="color:#c0392b">Before</b>
<ol style="margin:8px 0 0 18px;padding:0;line-height:1.7">
<li>check / consent / backup check が完了 <code>onLinkChanged()</code></li>
<li><code>evaluateFailover()</code>: 選択中のペアが書き込み不可のときだけ移る</li>
<li><code>SelectionReplacement</code>: priority が高いペアにだけ移る</li>
<li style="background:#fdecea">priority が同じ・遅いペアでも、受信が止まったペアでも移らない（RTT は統計のみ）</li>
</ol>
</div>
<div style="flex:1;min-width:300px;border:1px solid #1e8449;border-radius:8px;padding:12px">
<b style="color:#1e8449">After</b>
<ol style="margin:8px 0 0 18px;padding:0;line-height:1.7">
<li>同じタイミングで <code>onLinkChanged()</code> / check 応答から <code>switching.evaluate()</code></li>
<li><code>shouldSwitch()</code>: 書き込み可否 → 受信 → priority → RTT</li>
<li style="background:#e9f7ef"><code>reason = receiving</code>: 選択が 1 秒受信なし、backup は受信中 → 移る</li>
<li style="background:#e9f7ef"><code>reason = rtt</code>: 同 priority で平滑化 RTT が 10 ms 以上低い → 移る</li>
<li style="background:#e9f7ef">保留中は <code>recheckAt</code> のタイマーで再判定</li>
<li><code>switchTo()</code> → <code>selection.nominate()</code>（USE-CANDIDATE または NOMINATION 値を増やす）</li>
</ol>
</div>
</div>
<p style="font-size:12px;color:#666">凡例: 赤 = 修正前に移れなかった場合、緑 = 追加した判定。応答の処理順は同じで、判定を 1 段足しています。</p>

## 3. 主要変更

### 判定ロジック
[packages/ice/src/nomination/selectionController.ts:76](review-file:packages/ice/src/nomination/selectionController.ts:76) の `shouldSwitch()` は副作用のない純粋関数です。

1. 候補が書き込み不可なら移らない
2. 選択が書き込み不可なら `writable` で移る（実際の移行は従来の failover が担当）
3. 受信状態を比べる。選択だけが受信中なら移らない。候補だけが受信中なら、選択が受信していない時間が `RECEIVING_SWITCHING_DELAY` 以上のときに限り `receiving` で移り、未満なら `recheckAt` を返す
4. priority が高ければ `priority`、低ければ移らない
5. 同 priority では、RTT が `RTT_SWITCH_MIN_IMPROVEMENT` 以上低い場合だけ `rtt`

「受信していない」は `notReceivingSince()`（failover.ts に移動）で判定します。2.5 秒以上何も受信しておらず、かつ応答のない check があることが条件です。werift は選択ペアの check を頻繁に送らないため、受信の沈黙だけで判定すると誤って切り替えるからです。

`SelectionController.evaluate()`（[同ファイル:170](review-file:packages/ice/src/nomination/selectionController.ts:170)）が backup を全部比べ、`receiving` / `rtt` で勝つ中から priority、RTT の順に最良の 1 つを選んで `switchTo()` します。priority で勝つ移行は既存の `SelectionReplacement` に任せています。

### RTT の平滑化
[packages/ice/src/iceBase.ts:220](review-file:packages/ice/src/iceBase.ts:220) に `recordRoundTrip()` と `smoothedRtt` を追加しました。直近 5 サンプル（`RTT_SMOOTHING_SAMPLES`）の中央値で、3 サンプル未満は `undefined` です。`getStats()` の `currentRoundTripTime` は従来どおり最後のサンプルです。

### Connection への組み込み
[packages/ice/src/ice.ts:329](review-diff:packages/ice/src/ice.ts:commit:0752292b6) 付近で `SelectionController` を生成し、次の契機で `evaluate()` を呼びます。
- 接続チェックの応答（[ice.ts:1849](review-file:packages/ice/src/ice.ts:1849)）
- `onLinkChanged()`（[ice.ts:2717](review-file:packages/ice/src/ice.ts:2717)）。consent / backup check の成功・失敗

`failoverNomination` は `switchNomination: { pair, reason: "failover" | "receiving" | "rtt" }` に一般化しました。移行完了時の旧ペアの扱いは次のとおりです。
- `failover` / `receiving`: 旧ペアを demote（従来の failover と同じ）
- `rtt`: `nominated = false` にして backup に戻すだけ

再起動・クローズ・role 変更・consent 失効の各所で `switching.stop()` を呼んで保留タイマーを止めています。

### ドキュメント
`changelog.md`、`packages/ice/README.md`、生成ドキュメント（`packages/ice/doc/**`）に定数 4 つと `CandidatePair` の追加分を反映しました。

### テスト用ヘルパー
c71d9123a は [packages/ice/tests/utils.ts:1133](review-diff:packages/ice/tests/utils.ts:commit:c71d9123a) の遅延付き UDP 中継 `createHeldUdpProxy` が、`close()` 後もタイマーを残す問題を直しました。

## 4. 判断理由

| 論点 | 採用 | 採らなかった案 |
| --- | --- | --- |
| RTT の平滑化 | 直近 5 サンプルの中央値 | `totalRoundTripTime / measurements`（長期平均で経路の変化に追従しにくい）、指数移動平均（外れ値 1 回に引きずられる） |
| 閾値・保留時間 | 定数（libwebrtc の値: 1 秒・10 ms） | `IceOptions` / `PeerConfig` への公開（チケット M6「要検討」。API を増やさず見送り） |
| ネットワークコスト | 扱わない | Node.js から取得できないため |
| priority で勝つ移行 | 既存 `SelectionReplacement` のまま | `SelectionController` に統合 |
| 適用範囲 | failover と同じ（controlling、フル ICE、semi-aggressive / renomination、ICE-TCP 除く） | 全構成 |

## 5. レビュアーが確認すべき点・リスク

- **挙動変更**: 経路が壊れたとき、旧実装は書き込み不可（5〜10 秒）まで待ちましたが、今回は最後の応答から約 4〜6 秒で移ります。旧ペアに戻るには 3 回の応答が必要です（failover と同じ）。changelog に明記済みです。
- **RTT 切り替え後の旧ペア**: demote せず backup に戻します。新しい nomination がない限り戻りません。ping-pong 対策は 10 ms のヒステリシスと中央値だけです。
- **`notReceivingSince()` の条件**: 「応答のない check がある」ことを要件にしました。libwebrtc は 48 ms 間隔で ping する前提なので、その差を埋める werift 独自の解釈です。
- **非受信の起点**: 未応答 check が遅れて確定した場合、保留 1 秒はその時点から数えます。切り替えまでの時間は最後の受信から約 3.5 秒（check が間に合う場合）か、未応答 check の 1 秒後です。保留中に RTT で移った場合は旧ペアを demote しません。
- **公開 API**: 追加は定数 4 つと `CandidatePair.smoothedRtt` / `recordRoundTrip()` です。`IceOptions` は変更なしです。
- **チケット完了条件との差**: `npm run e2e`（Chrome との E2E）は今回実行していません。

## 6. 検証結果

このドキュメント作成時に、自分で次を実行しました。
- `cd packages/ice && npx vitest run tests/ice/selection-controller.test.ts tests/ice/failover.test.ts tests/pbt`: 10 ファイル 1562 テスト通過（HEAD 831ee3dd8）

再レビューで追加・変更したテストは次のとおりです。
- [packages/ice/tests/ice/selection-controller.test.ts](review-file:packages/ice/tests/ice/selection-controller.test.ts): 起点が遅い方になること、保留中の RTT 切り替えで旧ペアを demote しないこと、`IceOptions.failover` の閾値に従うこと
- [packages/ice/tests/pbt/failoverRules/failoverRulesProperty.test.ts](review-file:packages/ice/tests/pbt/failoverRules/failoverRulesProperty.test.ts): `notReceivingSince` と `isNotReceiving` の整合を性質として追加
- `failoverBurstProperty.test.ts`: 小修正

初回実装のテスト（`shouldSwitch` の純粋関数、`smoothedRtt`、擬似ソケット、遅延付き UDP 中継の実ソケット）は引き続き通っています。

次は今回実行していません。`npm run type`、`npm run test:small` 全体、`npm run e2e`、`npm run doc` の再生成確認、`npm run pbt:deep`。
