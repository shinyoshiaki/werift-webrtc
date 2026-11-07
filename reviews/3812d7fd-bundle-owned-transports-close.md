---
ide:
  viewer: review-document
  version: 1
  title: "BUNDLE 後に残る DTLS/ICE transport の停止"
  dock: right
  baseCommit: 2430dc02357935a230419d64e2638e08a3e350c8
---
# max-compat の DTLS / ICE transport が BUNDLE 後に残る問題の修正

## 1. 概要

`RTCPeerConnection.close()` が、BUNDLE で使われなくなった DTLS / ICE transport を停止しない問題を直しました。`SecureTransportManager` が自分で作った transport を、閉じるまで自分で保持するようにしました。`close()` はその全部を `stop()` します。

あわせて `RTCDtlsTransport.stop()` を冪等にしました。これで、複数の経路から同時に `stop()` が呼ばれても、ICE の停止は 1 回で済みます。

## 2. 主要変更

<div style="display:flex;gap:12px">
  <div style="flex:1;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px">
    <strong>Before</strong><br>close() は transceiver と SCTP が今参照している transport だけを停止する。BUNDLE で付け替えられた transport は誰からも到達できず、UDP socket が残る。
  </div>
  <div style="flex:1;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px">
    <strong>After</strong><br>createTransport で作った transport を ownedTransports に登録する。close() は「現在の参照」と「所有集合」を重複なしで合わせて停止する。
  </div>
</div>

### SecureTransportManager

- [packages/webrtc/src/secureTransportManager.ts:52](review-file:packages/webrtc/src/secureTransportManager.ts:52) に `ownedTransports` を追加しました。`dtlsTransports` や `iceTransports` などの live 用 getter では使いません。そのため、ICE 状態の集約や `getStats()` の対象は変わりません。
- [packages/webrtc/src/secureTransportManager.ts:241](review-diff:packages/webrtc/src/secureTransportManager.ts:241) で、transport を作った時点で登録します。`stop()` を包み、ICE の停止が終わった時点で集合から外します。集合は再ネゴシエーションで増え続けません。
- [packages/webrtc/src/secureTransportManager.ts:760](review-diff:packages/webrtc/src/secureTransportManager.ts:760) の `close()` は、`allDtlsTransports` と `ownedTransports` を `uniqueTransports` で重複排除してから停止します。BUNDLE で共有している transport を 2 回止めることはありません。

### RTCDtlsTransport.stop()

- [packages/webrtc/src/transport/dtls.ts:520](review-diff:packages/webrtc/src/transport/dtls.ts:520) で、`stop()` が共有の `stopPromise` を返すようにしました。同時に呼んだ側は同じ promise を待ちます。
- `setState("closed")` が購読者へ通知する前に promise を公開します。購読者が `stop()` を再入呼び出ししても、同じ promise が返り、ICE の停止完了を待てます。これは 2 回目のコミット（再レビュー対応）で直した点です。
- DTLS が alert で closed になっても ICE は動いたままです。所有権は DTLS の状態ではなく、`stop()` の完了で終えます。

### changelog とテスト

- [changelog.md:17](review-diff:changelog.md:17) に Bug Fixes を追記しました。
- [packages/webrtc/tests/transport/secureTransportManager.test.ts](review-file:packages/webrtc/tests/transport/secureTransportManager.test.ts) は単体テスト 6 件です。参照されない transport の停止、閉じた transport の除外、live getter に混ざらないこと、alert で閉じた transport の停止、進行中の stop の待機、再入 `stop()` の待機を確認します。
- [packages/webrtc/tests/negotiation/cases/negotiationTransactionBundleOwnership.test.ts](review-file:packages/webrtc/tests/negotiation/cases/negotiationTransactionBundleOwnership.test.ts) は結合ケース 5 件です。audio + video + DataChannel の BUNDLE answer、DataChannel を group 外に残す場合、remote offer 側、pranswer、`close()` 後の全停止を確認します。

## 3. 判断理由

チケットの案は 3 つありました。(1) 付け替え時に参照が無くなったら即停止する、(2) manager が作った transport を全部所有する、(3) 退役 transport の集合を持つ、です。案 2 を採りました。

- 付け替えは `setRemoteDescription` の中の複数箇所（answer、remote offer、group 外 m-line）で起きます。各箇所で「他の m-line がまだ参照しているか」を判定する必要があり、誤って共有 transport を止める危険があります。
- 所有側で一元管理すれば、今後付け替え箇所が増えても取りこぼしません。
- pranswer のように、最終 answer まで旧 transport を保持したい場面でも、所有集合なら自然に扱えます（結合テスト 4 件目）。

即時停止（案 1）は採りませんでした。上記の判定ミスで共有 transport を壊すリスクがあるためです。

## 4. レビュアーが確認すべき点・リスク

- **`stop` の差し替え**: `createTransport` が返す transport の `stop` インスタンスメソッドを上書きしています（[packages/webrtc/src/secureTransportManager.ts:245](review-file:packages/webrtc/src/secureTransportManager.ts:245)）。外部が元の `stop` への参照を持つ場合は迂回されます。ただし `close()` が最終的に全て停止するので、リークはしません。
- **`stop()` のシグネチャ**: `async stop()` から `stop(): Promise<void>` に変わりました。戻り値の型は同じです。ただし、2 回目以降の呼び出しは何もせず、同じ promise を返します（以前は毎回 `setState` と ICE 停止を実行していました）。
- **公開 API**: 追加や削除はありません。`dtlsTransports` / `iceTransports` / 統計の対象は live な transport のままです。
- **TURN**: ICE 停止に TURN allocation の解放が含まれる点は、今回のテストでは直接確認していません。
- **WPT / E2E**: この変更では実行していません。

## 5. 検証結果

- 実行: `cd packages/webrtc && npx vitest run tests/transport/secureTransportManager.test.ts tests/negotiation/cases/negotiationTransactionBundleOwnership.test.ts`
  - 結果: 2 ファイル、11 テストすべて成功。
- 未実行（このドキュメント作成時点）: `npm run type`、`npm run test:small`、`npm run ci`、`npm run wpt`、`npm run e2e`。レビュー前のこれらの結果は、チケット側の記録を参照してください。
