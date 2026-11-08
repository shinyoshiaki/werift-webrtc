---
ide:
  viewer: review-document
  version: 1
  title: "SCTP: Gap ACK 後の T3 で flightSize が残る問題の修正（#806）"
  dock: right
  baseCommit: 2c7175697304fc0cc54237c5c659e69b9677a0bb
---
# SCTP: Gap ACK 後の T3 で flightSize が残り送信が止まる問題の修正（#806）

## 1. 概要

T3-rtx（再送タイマー）が Gap ACK の後に発火すると、送信側 SCTP の `flightSize` が実際の未 ACK バイト数より大きいまま残っていました。`flightSize >= cwnd` が続くと新しい DATA も HEARTBEAT も出なくなり、DataChannel は接続を保ったまま送信だけが止まります。`send()` の Promise も解決しません。

原因は、`flightSize` を集計値だけで管理していたことです。チャンクごとに「計上済みかどうか」を持たず、`Math.max(0, …)` の丸めと、T3 での `flightSize = 0` の直接代入で辻褄を合わせていました。今回の修正では `DataChunk.inFlight` を追加し、計上の増減をチャンク単位で一度だけ効くようにしました。これで次の不変条件が全経路で成り立ちます。

> `flightSize === Σ(sentQueue 内で inFlight なチャンクの bookSize)`

- 変更対象: `werift-sctp`（`packages/sctp`）だけ。`packages/webrtc` のコード変更はありません。
- コミット（基点 `c3a2bf9bc`）:
  - `95d7a8e44`: 本体修正、回帰テスト 9 件、changelog
  - `c4ded960b`: レビュー指摘 1（Gap ACK 取り消し後に T3 が止まる問題）
  - `ced39a340`: レビュー指摘 2（破棄済み断片を再計上してしまう問題）
- 現在のチケットの `reviewStatus` は `approved` です。

## 2. 何が起きていたか（#806 の最小再現）

36 B / 652 B / 652 B の 3 件を送り、先頭 A を失い、B・C が Gap ACK された状態で T3 が発火するケースです。各ステップの `flightSize` を修正前後で比べます（破線は `cwnd = 1236`）。

<svg viewBox="0 0 660 250" width="100%" role="img" aria-label="#806 再現手順での flightSize の推移（修正前と修正後）">
  <g font-family="var(--review-font)" font-size="12" fill="var(--review-fg)">
    <line x1="50" y1="190" x2="640" y2="190" stroke="var(--review-border)"/>
    <line x1="50" y1="66.4" x2="640" y2="66.4" stroke="var(--review-warning)" stroke-dasharray="5 4"/>
    <text x="636" y="60" text-anchor="end" fill="var(--review-warning)">cwnd 1236</text>
    <g fill="var(--review-danger)">
      <rect x="80" y="56" width="36" height="134"/>
      <rect x="220" y="186.4" width="36" height="3.6"/>
      <rect x="360" y="59.6" width="36" height="130.4"/>
      <rect x="500" y="59.6" width="36" height="130.4"/>
    </g>
    <g fill="var(--review-success)">
      <rect x="124" y="56" width="36" height="134"/>
      <rect x="264" y="186.4" width="36" height="3.6"/>
      <rect x="404" y="186.4" width="36" height="3.6"/>
      <rect x="544" y="189" width="36" height="1"/>
    </g>
    <g text-anchor="middle" font-size="11">
      <text x="98" y="50">1340</text><text x="142" y="50">1340</text>
      <text x="238" y="180">36</text><text x="282" y="180">36</text>
      <text x="378" y="54">1304</text><text x="422" y="180">36</text>
      <text x="518" y="54" fill="var(--review-danger)">1304 残存</text><text x="562" y="180" fill="var(--review-success)">0</text>
    </g>
    <g text-anchor="middle">
      <text x="120" y="208">① 3 件送信</text>
      <text x="260" y="208">② B,C を Gap ACK</text>
      <text x="400" y="208">③ T3 発火</text>
      <text x="540" y="208">④ 全件を累積 ACK</text>
      <text x="400" y="226" fill="var(--review-muted)" font-size="11">修正前: A,B,C を再送 / 修正後: A だけ再送</text>
    </g>
    <rect x="60" y="234" width="12" height="10" fill="var(--review-danger)"/><text x="78" y="243">修正前</text>
    <rect x="140" y="234" width="12" height="10" fill="var(--review-success)"/><text x="158" y="243">修正後</text>
  </g>
</svg>

修正前は ③ で Gap ACK 済みの B・C まで再送して計上し直し、④ の累積 ACK では「Gap ACK 済み＝減算済み」とみなして減算しませんでした。そのため `sentQueue` が空なのに 1304 B が残り、`cwnd` を超えたままになっていました。

この流れはテスト [packages/sctp/tests/sctp.test.ts:290](review-file:packages/sctp/tests/sctp.test.ts:290) でそのまま再現しています。送信が再開すること（`send()` が resolve し DATA が出る）も同じテストで確認しています。

## 3. 主要変更

### 3.1 チャンク単位の計上フラグ `inFlight`

`DataChunk` に公開フィールド `inFlight` を追加しました（後方互換の追加です）。`acked`（受信確認状態）と `inFlight`（輻輳制御上の計上状態）を分けて扱います。

[packages/sctp/src/chunk.ts:200](review-diff:packages/sctp/src/chunk.ts:commit:95d7a8e44:200)

増減ヘルパーはフラグを見て一度だけ効くようにし、`Math.max(0, …)` の丸めは外しました。

[packages/sctp/src/sctp.ts:1112](review-diff:packages/sctp/src/sctp.ts:commit:95d7a8e44:1112)

<div style="display:flex;gap:10px;flex-wrap:wrap;font-family:var(--review-font);font-size:13px">
  <div style="flex:1;min-width:200px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px">
    <strong>inFlight = true にする（加算）</strong>
    <ul style="margin:6px 0;padding-left:18px">
      <li>初回送信</li>
      <li>再送</li>
      <li>Gap ACK の取り消し（未破棄のチャンクのみ）</li>
    </ul>
  </div>
  <div style="flex:1;min-width:200px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-accent);border-radius:6px">
    <strong>inFlight = false にする（減算）</strong>
    <ul style="margin:6px 0;padding-left:18px">
      <li>Gap ACK / 累積 ACK</li>
      <li>T3・3 miss での再送予約</li>
      <li>破棄（部分信頼性）</li>
      <li>FORWARD TSN で sentQueue から外す</li>
    </ul>
  </div>
  <div style="flex:1;min-width:200px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px">
    <strong>削除したもの</strong>
    <ul style="margin:6px 0;padding-left:18px">
      <li>T3 での <code>flightSize = 0</code></li>
      <li><code>Math.max(0, …)</code> の丸め</li>
    </ul>
  </div>
</div>

### 3.2 経路ごとの変更

| 経路 | 変更内容 | 差分 |
|---|---|---|
| 累積 ACK | 計上は毎回外します。cwnd 成長用の `doneBytes` は従来どおり Gap ACK されていないチャンクだけ加算します | [sctp.ts:695](review-diff:packages/sctp/src/sctp.ts:commit:95d7a8e44:695) |
| Gap ACK | 再送予約（`retransmit`）も取り消します | [sctp.ts:722](review-diff:packages/sctp/src/sctp.ts:commit:95d7a8e44:722) |
| T3 | Gap ACK 済み・破棄済みのチャンクはスキップします。直接の 0 代入は削除しました | [sctp.ts:1217](review-diff:packages/sctp/src/sctp.ts:commit:95d7a8e44:1217) |
| 再送ループ | 予約後に ACK・破棄されたチャンクは送りません。fast recovery の送信枠も消費しません | [sctp.ts:1009](review-diff:packages/sctp/src/sctp.ts:commit:95d7a8e44:1009) |
| FORWARD TSN | `sentQueue` から外す破棄チャンクの計上を外します | [sctp.ts:1349](review-diff:packages/sctp/src/sctp.ts:commit:95d7a8e44:1349) |
| 破棄（部分信頼性） | 対象チャンクの位置を `v === chunk` で求めます（従来は常に先頭を破棄していました）。前方探索の停止位置を `FIRST_FRAG` に直しました | [sctp.ts:1373](review-diff:packages/sctp/src/sctp.ts:commit:95d7a8e44:1373) |
| Gap ACK の取り消し（reneging） | 指摘 1・2 で追加しました。詳細は 4 章です | [sctp.ts:701](review-diff:packages/sctp/src/sctp.ts:commit:c4ded960b:701) |

## 4. レビューでの指摘と対応

<div style="display:flex;gap:10px;flex-wrap:wrap;font-family:var(--review-font);font-size:13px">
  <div style="flex:1;min-width:190px;padding:8px 12px;border:1px solid var(--review-border);border-top:4px solid var(--review-accent);border-radius:6px">
    <strong>95d7a8e44 本体修正</strong><br>
    <span style="color:var(--review-muted)">inFlight 導入、全経路の計上修正、破棄位置のバグ修正、回帰テスト 9 件</span>
  </div>
  <div style="flex:1;min-width:190px;padding:8px 12px;border:1px solid var(--review-border);border-top:4px solid var(--review-warning);border-radius:6px">
    <strong>c4ded960b 指摘 1（P1）</strong><br>
    <span style="color:var(--review-muted)">Gap ACK が取り消されても acked のまま残り、T3 がスキップして停止していた</span>
  </div>
  <div style="flex:1;min-width:190px;padding:8px 12px;border:1px solid var(--review-border);border-top:4px solid var(--review-warning);border-radius:6px">
    <strong>ced39a340 指摘 2（P1）</strong><br>
    <span style="color:var(--review-muted)">取り消し検出が破棄済み断片まで再計上し、cwnd を使い切って停止していた</span>
  </div>
  <div style="flex:1;min-width:190px;padding:8px 12px;border:1px solid var(--review-border);border-top:4px solid var(--review-success);border-radius:6px">
    <strong>reviewStatus: approved</strong><br>
    <span style="color:var(--review-muted)">確認レビューで承認済み</span>
  </div>
</div>

### 指摘 1: Gap ACK の取り消し後に T3 が止まる

本体修正では T3 が `acked` のチャンクをスキップします。そのため、受信側が Gap ACK した B を破棄し（reneging）、A までの累積 ACK しか返さない場合、B は `acked` のまま残っていました。新しい ACK が来ないと再送もタイマー再開も起きません。

対応として、累積 ACK の処理直後に「今回の SACK の Gap ACK に含まれない `acked` チャンク」を検出するようにしました（RFC 9260 §6.2.1）。該当チャンクは `acked` を外して再計上し、T3 が止まっていれば再開します。

[packages/sctp/src/sctp.ts:701](review-diff:packages/sctp/src/sctp.ts:commit:c4ded960b:701) で検出し、[packages/sctp/src/sctp.ts:795](review-diff:packages/sctp/src/sctp.ts:commit:c4ded960b:795) で T3 を再開します。

回帰テストは [packages/sctp/tests/sctp.test.ts:569](review-file:packages/sctp/tests/sctp.test.ts:569) です。

### 指摘 2: 破棄済み断片を取り消し時に再計上して止まる

指摘 1 の検出処理は `abandoned` を見ていませんでした。Gap ACK された後に期限切れで破棄された断片が SACK から消えると、`flightSize` に戻されていました。破棄済みは T3 の対象外なので減ることがなく、`cwnd`（1160 B）を使い切ります。その結果、先頭 A の再送も FORWARD TSN も進まなくなっていました。

対応として、破棄済みチャンクを取り消し検出の対象から外しました。

[packages/sctp/src/sctp.ts:713](review-diff:packages/sctp/src/sctp.ts:commit:ced39a340:713)

回帰テストは [packages/sctp/tests/sctp.test.ts:595](review-file:packages/sctp/tests/sctp.test.ts:595) です。A だけが再送されること、`flightSize = 100`（A のみ）、T3 の継続、A の累積 ACK 後に FORWARD TSN が出て計上が 0 になることを確認します。修正を一時的に外すとこのテストだけが失敗することを、前回の対応時に確認しています。

## 5. 判断理由

- **集計値の補正ではなくチャンク状態で管理しました。** #806 の暫定パッチ案（`sentQueue` が空なら `flightSize = 0`）は、空でない場合の過大計上を隠すだけなので採用していません。
- **3 miss で再送する従来の reneging 経路は残しました。** チケット 4.2 の制約に従い、`acked` を「永久に再送しない」印にはしていません。指摘 1 の検出は、それを補う経路です。
- **`maybeAbandon()` の位置探索バグも同じ変更で直しました。** 部分信頼性テストの前提に直接関わるためです（チケット 4.1 の判断ポイント）。
- **範囲外として残したもの:** RTO バックオフ、T3 時の 1 パケット束ね（E3）、strike の HTNA 限定、3 miss ごとの cwnd 半減。チケット 4.1 で別チケットに分けると決めています。

## 6. リスク

- **公開フィールドの追加:** `DataChunk.inFlight` は追加のみで、既存の利用者には影響しません。
- **取り消し検出の走査コスト:** SACK ごとに `sentQueue` を 1 回走査し、Gap ACK の TSN を Set に展開します。`burst.test.ts` の線形性テストとイベントループ遅延テストは通っていますが、チケット 4.3 の「`sentQueue` の全件走査を新たに増やさない」にはこの走査が該当します。レビューでは承認されていますが、大きな `sentQueue` での性能を実測したものではありません。
- **取り消しの即時検出:** 1 回の SACK で Gap ACK が消えたら即座に未確認扱いに戻します。順序が入れ替わって届いた古い SACK でも戻る可能性がありますが、その場合も再計上と再送が起きるだけで、計上の不変条件は崩れません。
- **既存テストのセットアップ変更:** `flightSize` だけを直接設定していた既存テストに `inFlight = true` を加えています（新しい前提に合わせただけで、検証内容は変えていません）。

## 7. テスト

共通の Arrange は [packages/sctp/tests/utils.ts:193](review-file:packages/sctp/tests/utils.ts:193) に集約しました（`createMockSctp`、`buildSack`、`holdTransport` など）。不変条件チェックは [packages/sctp/tests/utils.ts:273](review-file:packages/sctp/tests/utils.ts:273) です。

| テスト | 確認する経路 |
|---|---|
| [sctp.test.ts:290](review-file:packages/sctp/tests/sctp.test.ts:290) | #806 再現と送信再開 |
| [sctp.test.ts:330](review-file:packages/sctp/tests/sctp.test.ts:330) | 全件 ACK 後の HEARTBEAT 送出 |
| [sctp.test.ts:350](review-file:packages/sctp/tests/sctp.test.ts:350) | T3 の再送予約後、送る前に Gap ACK |
| [sctp.test.ts:380](review-file:packages/sctp/tests/sctp.test.ts:380) | Fast Retransmit の予約後、送る前に Gap ACK |
| [sctp.test.ts:416](review-file:packages/sctp/tests/sctp.test.ts:416) | ACK の重複、T3 の連続発火 |
| [sctp.test.ts:458](review-file:packages/sctp/tests/sctp.test.ts:458) | 累積 ACK 後の Gap ACK |
| [sctp.test.ts:474](review-file:packages/sctp/tests/sctp.test.ts:474) | 期限切れ破棄と FORWARD TSN（複数断片） |
| [sctp.test.ts:515](review-file:packages/sctp/tests/sctp.test.ts:515) | 再送上限による破棄 |
| [sctp.test.ts:537](review-file:packages/sctp/tests/sctp.test.ts:537) | 3 miss での reneging 再送 |
| [sctp.test.ts:569](review-file:packages/sctp/tests/sctp.test.ts:569) | 指摘 1: 新規 ACK なしの取り消し |
| [sctp.test.ts:595](review-file:packages/sctp/tests/sctp.test.ts:595) | 指摘 2: 破棄済み断片の取り消し |

## 8. 検証結果

| 検証 | 結果 | 実施時点 |
|---|---|---|
| `cd packages/sctp && npm test`（型チェック + vitest） | 8 ファイル・72 件通過 | この文書の作成時に HEAD `2c7175697` で再実行 |
| 本体修正前（HEAD 当時）での新規テスト | 9 件中 8 件が失敗 | 本体修正時 |
| 指摘 2 の修正を外した状態 | 追加テストだけが失敗 | 指摘 2 の対応時 |
| `npm run type` | 通過 | 本体修正時のみ（指摘 1・2 の後は未再実行） |
| `npm run test:small` | exit 0 | 本体修正時のみ（指摘 1・2 の後は未再実行） |

未確認事項:

- 指摘 1・2 の修正後に、ワークスペース全体の `npm run type` / `npm run test:small` を再実行していません。変更は `packages/sctp` 内に閉じています。
- 指摘 1 の回帰テストが修正前のコードで失敗することは確認していません。
- ブラウザとの DataChannel 実通信（E2E）での再現・回復確認は行っていません。
