---
ide:
  viewer: review-document
  version: 1
  title: "ICE 空の check list での待機と世代終了（レビュー解説）"
  dock: right
  baseCommit: de00840bf48bbf8c17b2d75b17be418eef97a463
---
# 8b7c8e4a: 空の check list での待機と ICE 世代の終了（レビュー解説）

対象 HEAD: `de00840bf`（ベースは `91f6b80eb`、レビュー対象の実装は `1726e9616` まで）。以下の「概要」から「検証結果」までが解説、「付録」は確認レビュー用に積み上げた経緯別の詳細メモです。

## 1. 概要

Firefox のように相手が `tcptype active` の TCP 候補しか出さない場合、werift の ICE は check list が空のまま `connect()` に入り、相手の check を待たずに即 `failed` になっていました。今回の変更で、空の check list では `incomingCheckTimeout`（既定 30 秒）まで相手の check を待ち、届いた check（triggered check / prflx の学習）で接続できるようにしました（RFC 6544）。

待機を入れたことで ICE restart と重なる時間が長くなったため、世代の終了（local / remote restart、close、transport の引退）で待つ側がすべて速やかに決着し、新しい世代の状態を変えないことも、不変条件として一緒に直しています。

## 2. 修正前と修正後の流れ

<div style="font-family:var(--review-font)">
<svg viewBox="0 0 820 480" width="100%" role="img" aria-label="修正前後の connect() の処理の流れ"><text x="200" y="24" text-anchor="middle" font-size="15" font-weight="bold" fill="var(--review-fg)">修正前</text><rect x="10" y="40" width="380" height="52" rx="6" fill="var(--review-surface)" stroke="var(--review-border)" stroke-width="2"/><text x="200.0" y="62" text-anchor="middle" font-size="13" font-family="var(--review-mono)" fill="var(--review-fg)">connect()</text><text x="200.0" y="80" text-anchor="middle" font-size="11" fill="var(--review-muted)">開始時に check list が空</text><line x1="200" y1="92" x2="200" y2="108" stroke="var(--review-muted)" stroke-width="2"/><polygon points="195,107 205,107 200,114" fill="var(--review-muted)"/><rect x="10" y="114" width="380" height="52" rx="6" fill="var(--review-surface)" stroke="var(--review-border)" stroke-width="2"/><text x="200.0" y="136" text-anchor="middle" font-size="13" font-family="var(--review-mono)" fill="var(--review-fg)">schedulingChecks()</text><text x="200.0" y="154" text-anchor="middle" font-size="11" fill="var(--review-muted)">送る check がなく即終了</text><line x1="200" y1="166" x2="200" y2="182" stroke="var(--review-danger)" stroke-width="2"/><polygon points="195,181 205,181 200,188" fill="var(--review-danger)"/><rect x="10" y="188" width="380" height="52" rx="6" fill="var(--review-surface)" stroke="var(--review-danger)" stroke-width="2"/><text x="200.0" y="210" text-anchor="middle" font-size="13" font-family="var(--review-mono)" fill="var(--review-fg)">while (checkList.length > 0 ...)</text><text x="200.0" y="228" text-anchor="middle" font-size="11" fill="var(--review-muted)">1 回も回らない</text><line x1="200" y1="240" x2="200" y2="256" stroke="var(--review-danger)" stroke-width="2"/><polygon points="195,255 205,255 200,262" fill="var(--review-danger)"/><rect x="10" y="262" width="380" height="52" rx="6" fill="var(--review-surface)" stroke="var(--review-danger)" stroke-width="2"/><text x="200.0" y="284" text-anchor="middle" font-size="13" font-family="var(--review-mono)" fill="var(--review-fg)">res === ICE_FAILED のまま</text><text x="200.0" y="302" text-anchor="middle" font-size="11" fill="var(--review-muted)">throw ICE negotiation failed</text><line x1="200" y1="314" x2="200" y2="330" stroke="var(--review-danger)" stroke-width="2"/><polygon points="195,329 205,329 200,336" fill="var(--review-danger)"/><rect x="10" y="336" width="380" height="52" rx="6" fill="var(--review-surface)" stroke="var(--review-danger)" stroke-width="2"/><text x="200.0" y="358" text-anchor="middle" font-size="13" font-family="var(--review-mono)" fill="var(--review-fg)">iceConnectionState = failed</text><text x="200.0" y="376" text-anchor="middle" font-size="11" fill="var(--review-muted)">checking の 1 ms 後</text><line x1="200" y1="388" x2="200" y2="404" stroke="var(--review-danger)" stroke-width="2"/><polygon points="195,403 205,403 200,410" fill="var(--review-danger)"/><rect x="10" y="410" width="380" height="52" rx="6" fill="var(--review-surface)" stroke="var(--review-danger)" stroke-width="2"/><text x="200.0" y="432" text-anchor="middle" font-size="13" font-family="var(--review-mono)" fill="var(--review-fg)">Firefox の active TCP から check 到着</text><text x="200.0" y="450" text-anchor="middle" font-size="11" fill="var(--review-muted)">2 ms 遅い。nominate しても failed のまま</text><text x="620" y="24" text-anchor="middle" font-size="15" font-weight="bold" fill="var(--review-fg)">修正後</text><rect x="430" y="40" width="380" height="52" rx="6" fill="var(--review-surface)" stroke="var(--review-border)" stroke-width="2"/><text x="620.0" y="62" text-anchor="middle" font-size="13" font-family="var(--review-mono)" fill="var(--review-fg)">connect()</text><text x="620.0" y="80" text-anchor="middle" font-size="11" fill="var(--review-muted)">ended = remoteChecks.signal を保持</text><line x1="620" y1="92" x2="620" y2="108" stroke="var(--review-muted)" stroke-width="2"/><polygon points="615,107 625,107 620,114" fill="var(--review-muted)"/><rect x="430" y="114" width="380" height="52" rx="6" fill="var(--review-surface)" stroke="var(--review-border)" stroke-width="2"/><text x="620.0" y="136" text-anchor="middle" font-size="13" font-family="var(--review-mono)" fill="var(--review-fg)">schedulingChecks()</text><text x="620.0" y="154" text-anchor="middle" font-size="11" fill="var(--review-muted)">check list が空のまま終了</text><line x1="620" y1="166" x2="620" y2="182" stroke="var(--review-success)" stroke-width="2"/><polygon points="615,181 625,181 620,188" fill="var(--review-success)"/><rect x="430" y="188" width="380" height="52" rx="6" fill="var(--review-surface)" stroke="var(--review-success)" stroke-width="2"/><text x="620.0" y="210" text-anchor="middle" font-size="13" font-family="var(--review-mono)" fill="var(--review-fg)">waitForIncomingCheck(ended)</text><text x="620.0" y="228" text-anchor="middle" font-size="11" fill="var(--review-muted)">期限 incomingCheckTimeout を固定して待つ</text><line x1="620" y1="240" x2="620" y2="256" stroke="var(--review-success)" stroke-width="2"/><polygon points="615,255 625,255 620,262" fill="var(--review-success)"/><rect x="430" y="262" width="380" height="52" rx="6" fill="var(--review-surface)" stroke="var(--review-success)" stroke-width="2"/><text x="620.0" y="284" text-anchor="middle" font-size="13" font-family="var(--review-mono)" fill="var(--review-fg)">起床源: addPair / 収集終了 / ended</text><text x="620.0" y="302" text-anchor="middle" font-size="11" fill="var(--review-muted)">待ち手は Set で複数でも全員が起きる</text><line x1="620" y1="314" x2="620" y2="330" stroke="var(--review-success)" stroke-width="2"/><polygon points="615,329 625,329 620,336" fill="var(--review-success)"/><rect x="430" y="336" width="380" height="52" rx="6" fill="var(--review-surface)" stroke="var(--review-success)" stroke-width="2"/><text x="620.0" y="358" text-anchor="middle" font-size="13" font-family="var(--review-mono)" fill="var(--review-fg)">相手の check で pair 追加 → 再スケジュール</text><text x="620.0" y="376" text-anchor="middle" font-size="11" fill="var(--review-muted)">収集終了でソケット 0 / 期限切れなら失敗</text><line x1="620" y1="388" x2="620" y2="404" stroke="var(--review-success)" stroke-width="2"/><polygon points="615,403 625,403 620,410" fill="var(--review-success)"/><rect x="430" y="410" width="380" height="52" rx="6" fill="var(--review-surface)" stroke="var(--review-success)" stroke-width="2"/><text x="620.0" y="432" text-anchor="middle" font-size="13" font-family="var(--review-mono)" fill="var(--review-fg)">connected</text><text x="620.0" y="450" text-anchor="middle" font-size="11" fill="var(--review-muted)">世代が終われば IceRestartedError で即決着</text></svg>
<div style="font-size:12px;color:var(--review-muted);margin-top:4px"><span style="color:var(--review-danger)">■ 赤枠</span>: 問題の経路　<span style="color:var(--review-success)">■ 緑枠</span>: 修正で変わった経路　灰枠: 変更なし</div>
</div>

- 修正前は、空の check list が `res === ICE_FAILED` のまま `throw` に落ちます（`packages/ice/src/ice.ts` の `connect()`）。
- 修正後は、空リストで待機に入り、`addPair()`、ローカル収集の終了、世代終了のどれかで起きます。変更の核は [packages/ice/src/ice.ts:2088](review-diff:packages/ice/src/ice.ts:2088) の `waitForIncomingCheck()` と、[packages/ice/src/ice.ts:1928](review-diff:packages/ice/src/ice.ts:1928) の `connect()` です。

## 3. 主要変更

### ICE（`packages/ice`）

- [packages/ice/src/ice.ts:1928](review-file:packages/ice/src/ice.ts:1928)：`connect()` は開始時に `ended`（`remoteChecks.signal`、`restart()` / `restartRemote()` / `close()` で abort）と `queue`（`checkListState`）を保持し、スケジューリング、空リスト待機、完了待ち、ICE-lite の完了待ちをすべて `ended` で打ち切ります。打ち切ったら `connectError()`（[packages/ice/src/ice.ts:2055](review-file:packages/ice/src/ice.ts:2055)）を投げます。再起動なら `IceRestartedError`、close なら従来どおり `ICE negotiation failed` です。
- [packages/ice/src/ice.ts:2088](review-diff:packages/ice/src/ice.ts:2088)：`waitForIncomingCheck()` は期限を開始時に固定し、起きるたびにソケットの有無、`ended`、pair を再評価します。期限は延びません。
- [packages/ice/src/ice.ts:118](review-file:packages/ice/src/ice.ts:118)：待ち手を `incomingCheckWaits`（`Set<AbortController>`）にし、`wakeIncomingCheckWaits()`（[packages/ice/src/ice.ts:2120](review-file:packages/ice/src/ice.ts:2120)）が全員を起こします。呼び出しは `addPair()`（[packages/ice/src/ice.ts:3090](review-file:packages/ice/src/ice.ts:3090)）と、`localCandidatesEnd = true` を立てる 2 か所（[packages/ice/src/ice.ts:1009](review-file:packages/ice/src/ice.ts:1009)、[packages/ice/src/ice.ts:1019](review-file:packages/ice/src/ice.ts:1019)）です。

### webrtc（`packages/webrtc`）

- [packages/webrtc/src/transport/ice.ts:184](review-file:packages/webrtc/src/transport/ice.ts:184)：`checksGeneration` を `restart()` と `resetRemoteGeneration()` で 1 増やします。[packages/webrtc/src/transport/ice.ts:820](review-diff:packages/webrtc/src/transport/ice.ts:820) の `start()` は、まだ自分の世代のときだけ `failed` にします。
- [packages/webrtc/src/negotiation/transportActivation.ts:256](review-diff:packages/webrtc/src/negotiation/transportActivation.ts:256)（`connect()`）と [packages/webrtc/src/negotiation/transportActivation.ts:395](review-diff:packages/webrtc/src/negotiation/transportActivation.ts:395)（`connectPending()`）は、`start()` と `checksSettled()` の 4 つの await 地点で世代を比べ、変わっていたら（または transport が引退していたら）状態を変えずに終わります。エラーの型ではなく世代で判定します。

### テスト

- ICE：[generation-end.test.ts](review-file:packages/ice/tests/ice/generation-end.test.ts)（世代終了 × 待ち場所のマトリクス）、[incoming-check-wake.test.ts](review-file:packages/ice/tests/ice/incoming-check-wake.test.ts)（起床源のマトリクス）、[tcp.test.ts:134](review-file:packages/ice/tests/ice/tcp.test.ts:134)（active のみ）。
- webrtc：[iceGenerationActivation.test.ts](review-file:packages/webrtc/tests/transport/iceGenerationActivation.test.ts)（4 待ち手 × 3 終了）、[ice.test.ts:924](review-file:packages/webrtc/tests/transport/ice.test.ts:924)（二つの接続処理が並行中の `restartIce()` で `failed` にならない）。
- E2E：`e2e/tests/datachannel/iceTcp.test.ts` の Firefox スキップを外しました。

## 4. 判断理由

- 指摘のたびに経路を 1 本ずつ塞ぐのではなく、「世代が終わったら待つ側はすべて決着し、新しい世代に触れない」を不変条件にして、終了のシグナルを `remoteChecks.signal` の 1 本にまとめました。R1 / R5 / R7 と、未指摘だった ICE-lite、full の `schedulingChecks()`、残りの check の取消の経路が同じ仕組みで塞がります。
- 待機の起床源は、pair 追加、収集の終了、世代終了の 3 つに限り、期限は待機の開始時に固定します（起こされるたびに延びると、収集の終了や並行呼び出しで失敗が遅れるため）。
- 世代の判定にエラーの型ではなく `checksGeneration` を使うのは、同じ世代の本物の失敗と、再起動による取消を、型で区別できないためです。
- 採用しなかった案：空リストを失敗にしたまま Firefox だけ別扱いにする案は、RFC 6544 と peer-reflexive の学習に反するため採りませんでした。

## 5. レビュアーが確認すべき点・リスク

- 挙動の互換性：候補が 1 つもなく相手の check も来ない接続は、即 `failed` ではなく最大 `incomingCheckTimeout`（既定 30 秒）後に `failed` になります。ただし、ローカル収集の終了時にソケットが 0 なら即失敗します。
- 公開 API：`IceOptions.incomingCheckTimeout` と `PeerConfig.iceIncomingCheckTimeout` の JSDoc、`changelog.md`、生成ドキュメントが更新対象です（差分から読み取れる範囲では、コードと文書の整合を確認してください）。
- 並行 `connect()` が同じ結果キューを取り合う問題は、チケット以前からの full モードの制約で、今回は待機の起床だけを直しています。
- `RTCIceTransport.checksGeneration` は `@internal` です。
- 失敗した過去の Firefox 記録（`bfc957516` の 1 回目の `iceTcp.test.ts` のタイムアウト）は、原因を特定できていません（付録を参照）。

## 6. 検証結果

最新の実装コミット `1726e9616` で、付録に記録された結果です（この解説の作成時には再実行していません）。

| コマンド | 結果 |
| --- | --- |
| `cd packages/ice && npm test` | 52 ファイル成功、479 件成功、5 件スキップ |
| `npm run type` | 成功 |
| `npm run test:small` | 全パッケージ成功（webrtc 1880 件成功） |
| `npm run e2e`（Chrome） | 25 ファイル、71 件成功 |
| `cd e2e && npm run firefox:record`（clean な `1726e9616`） | 63 件成功、0 件失敗、8 件スキップ |

`src/negotiation` を変える `9b1cb2bec` では `npm run pbt:deep` も実行済みです（model seed 287 の 1 件はベースでも再現）。`1726e9616` は `src/negotiation` を変えないので実行していません。

## 付録：経緯別の詳細（確認レビュー用メモ）

対象コミット: `9b1cb2bec`（実装とテスト）、`0b72d4547`（Firefox 記録）、`bfc957516`（`start()` の延期した `connect()` の取消）、`1cff1bead`（Firefox 記録）、`e535dc54d`（同期の状態イベント中の再起動）、`037110bdb`（Firefox 記録）、`feb9f8f52`（ICE-lite の待ち時間）、`3344382e9`（Firefox 記録）、`0a4590d0d`（ICE-lite が収集中に connect する場合）、`0d32385bd`（Firefox 記録）、`1726e9616`（空の check list での待機の起床源）、`988d3db68`（Firefox 記録）。ベースは `91f6b80eb`。
この文書は確認レビュー用に未コミットのまま置いています。

## 不変条件

世代が終わったら（local restart、remote-only restart、close、transport の引退）、その世代を待つ側はすべて速やかに決着し、新しい世代の状態を一切変えない。

これまでの指摘（R1: 旧世代の待機が残り failed を通知する、R5: 旧 `connect()` が永久に終わらない、R7: `checksSettled()` の待ち手が取消を failed と誤認する）は、どれもこの不変条件の違反です。今回は、指摘された経路だけを塞ぐのではなく、層ごとに終了の仕組みを 1 つにまとめました。

## 仕組み

### ICE（`packages/ice/src/ice.ts`）

- `connect()` は開始時に `ended = this.remoteChecks.signal` と `queue = this.checkListState` を保持します（[ice.ts:1944](../packages/ice/src/ice.ts#L1944)）。`remoteChecks` は `restart()`、`restartRemote()`、`close()` だけが abort します（`cancelChecks()`）。
- 次の 4 か所の待ちは、すべて `ended` で打ち切ります。打ち切ったらその場で `connectError()` を投げます。
  - ICE-lite の完了待ち（[ice.ts:1971](../packages/ice/src/ice.ts#L1971)）
  - スケジューリングのループ（[ice.ts:1993](../packages/ice/src/ice.ts#L1993)）。再起動で `remoteCandidatesEnd` が false に戻っても回り続けません。
  - 空リストでの待機（`AbortSignal.any([wait.signal, ended])`、[ice.ts:2080](../packages/ice/src/ice.ts#L2080)、その後 [ice.ts:2001](../packages/ice/src/ice.ts#L2001)）
  - 完了待ち（`Promise.race([queue.get(), untilEnded])`、[ice.ts:2012](../packages/ice/src/ice.ts#L2012)）。投げるのは「残りの check の取消」より前なので、新しい世代の `checkList` には触れません。
- `connectError()`（[ice.ts:2037](../packages/ice/src/ice.ts#L2037)）は、close による終了なら `Error("ICE negotiation failed")`（従来どおり）、再起動による終了なら `IceRestartedError` を返します。
- 前回の `superseded()`、世代番号の比較、`stopIncomingCheckWait()` は、この仕組みに置き換えたので削除しました。

### webrtc

- `RTCIceTransport.checksGeneration`（@internal、[transport/ice.ts:183](../packages/webrtc/src/transport/ice.ts#L183)）は、`restart()` と `resetRemoteGeneration()` で 1 増えます。
- `start()` の catch が `failed` にするのは、まだ自分の世代のときだけです（[transport/ice.ts:822](../packages/webrtc/src/transport/ice.ts#L822)）。エラーの型は見ません。
- `TransportActivation` の `connect()`（[transportActivation.ts:256](../packages/webrtc/src/negotiation/transportActivation.ts#L256)）と `connectPending()`（[transportActivation.ts:392](../packages/webrtc/src/negotiation/transportActivation.ts#L392)）は、`start()` と `checksSettled()` の 4 つの await 地点すべてで世代を比べます。世代が変わっていたら、または transport が引退していたら、状態を変えずに終わります。
  - 引退の判定：`connect()` は `dtlsTransports` にないとき、`connectPending()` は pending-only でないとき。
  - 新しい世代の結果は、その世代を運ぶ description の connect が報告します。

## マトリクステスト

### ICE：[generation-end.test.ts](../packages/ice/tests/ice/generation-end.test.ts)

準備処理は [tests/utils.ts:2362](../packages/ice/tests/utils.ts#L2362) の `startConnectWaitingIn`、`restartGeneration`（L2408）、`exchangeGeneration`（L2424）です。

| 待っている場所 \ 終了 | local restart | remote restart | close |
| --- | --- | --- | --- |
| 空リストで待機中 (`empty`) | 1, 2, 3 | 1, 2, 3 | 1' |
| スケジューリング中 (`scheduling`、相手候補の終了前) | 1, 2, 3 | 1, 2, 3 | 1' |
| 完了待ち (`completion`、応答しない UDP の宛先) | 1, 2, 3 | 1, 2, 3 | 1' |
| ICE-lite (`lite`) | 1, 2, 3 | 1, 2, 3 | 1' |

- 1：旧 `connect()` が 1 秒以内に `IceRestartedError` で決着する。新しい世代の候補を交換する前に確認するので、相手候補の終了待ちで回り続ける経路も検出します。
- 1'：1 秒以内に `ICE negotiation failed` で決着する（`IceRestartedError` ではない）。
- 2：再起動後、新しい世代の `connect()` を始める前に `checkStart` が呼ばれない（spy）。
- 3：新しい世代で両側が connected になる。
- ベース `91f6b80eb` では、スケジューリング中・完了待ち・ICE-lite × 2 種類の再起動の 6 件が失敗します（旧 `connect()` が決着しない）。今回の変更では 12 件すべて成功します。

### webrtc：[iceGenerationActivation.test.ts](../packages/webrtc/tests/transport/iceGenerationActivation.test.ts)

実物の `TransportActivation` と `RTCIceTransport` を使い、それ以外は stub です。準備処理は [tests/utils.ts:743](../packages/webrtc/tests/utils.ts#L743) の `startActivationWaiting` です。

| 待ち手 \ 終了 | `restart()` | `resetRemoteGeneration()` | 引退（集合から外して `stop()`） |
| --- | --- | --- | --- |
| `connect()` が `start()` | ✓ | ✓ | ✓ |
| `connect()` が待ち手（`checksSettled()`） | ✓ | ✓ | ✓ |
| `connectPending()` が `start()` | ✓ | ✓ | ✓ |
| `connectPending()` が待ち手 | ✓ | ✓ | ✓ |

- 各ケースで確認すること：待ち手が 1 秒以内にエラーなしで終わる。`setConnectionState` に `failed` も `connected` も渡らない。DTLS の `start()` が呼ばれない。
- ベースでは 12 件中 11 件が失敗します。

### RTCPeerConnection：[ice.test.ts:924](../packages/webrtc/tests/transport/ice.test.ts#L924)

- 手順：候補なしで交渉して 1 回目の connect が checks を始め、再交渉の answer で 2 回目の connect が同じ世代を待ちます。その状態で `restartIce()` し、候補ありで交渉し直します。
- 確認すること：`connectionState` が一度も `failed` にならずに connected になる。
- ベースでは `['connecting', 'failed', …]` となり失敗します（R7 の再現）。準備処理は [tests/utils.ts:187](../packages/webrtc/tests/utils.ts#L187) の `negotiateWithoutCandidates` です。

### 既存テストの修正

- [tcp.test.ts:134](../packages/ice/tests/ice/tcp.test.ts#L134)：active のみのケースの準備段階の assert を、候補数 1 の決め打ちから「すべて `tcptype==="active"` で 1 件以上」に変えました（ネットワークインターフェースが複数あるホストで落ちていたため）。
- 前回追加した TCP 限定の再起動テスト 4 件は、ICE のマトリクスに含まれるので削除しました。

## 空の check list での待機：起床源の不変条件（`1726e9616`）

世代終了の系統は、上のマトリクスで塞ぎました。その後の指摘は、新しい待機（`waitForIncomingCheck`）がいつ始まり、何で起き、いつ失敗するかに移っています。この系統も、1 本ずつではなく不変条件として宣言し、まとめて網羅しました。

### 不変条件

空の check list での待機は、次のとおりに動く。

1. pair が追加されたら、直ちに続行する。
2. ローカル収集が終わった時点でソケットがなければ、直ちに失敗する。
3. 世代が終わったら、直ちにその世代のエラーで決着する。
4. それ以外は、`incomingCheckTimeout` の期限で失敗する。期限は待機の開始時に決まり、起こされて再評価しても延びない。

同一世代の待ち手が複数いても、各自が起きる。

### 修正（[ice.ts:2088](../packages/ice/src/ice.ts#L2088)）

- 待ち手は `incomingCheckWaits`（`Set<AbortController>`）で持ちます。以前は単一の `AbortController` だったので、並行した 2 本目の `connect()` が 1 本目の起床を奪っていました。
- `wakeIncomingCheckWaits()`（L2120）がすべての待ち手を起こします。呼ぶのは次の 3 か所です。
  - `addPair()`（L3090）
  - ローカル収集の終了：`localCandidatesEnd = true` を立てる 2 か所（L1009 の即時の分岐、L1019 の `localCandidatesEndPromise` の `.then`）
- 前回の応答で「収集の終了を知らせるイベントがない」と書いたのは誤りでした。この 2 か所が終了の地点です。
- 待機は、開始時に決めた期限までループします。起きるたびに、`ended`、ソケットの有無と収集の終了、pair を再評価します。
- webrtc 側の実装は変えていません。ICE-lite の regather（`commit()` が収集を await しない経路）から、収集中の `connect()` に到達しうることをコメントで残しました（`transport/ice.ts` の `commit()`）。

### マトリクス（[incoming-check-wake.test.ts](../packages/ice/tests/ice/incoming-check-wake.test.ts)）

準備処理は `tests/utils.ts` の `createLiteAgentStillGathering`（lite 側の options を受け取るよう拡張）、`createLiteAgentWithoutPeerCandidates`、`createTcpOnlyConnections` です。

| 起床源 \ 対象 | ICE-lite 収集中 | ICE-lite 収集後 | full 収集後 |
| --- | --- | --- | --- |
| pair 追加（相手の check） | L23：connected になる | `ice-lite-incoming-check.test.ts`：connected になる | `tcp.test.ts`：connected になる |
| 収集終了・ソケット 0（`useIpv4/6: false`） | **L41：待ち時間 3 秒の前に即失敗（ベースでは 3003 ms）** | 待ちに入る前に即失敗 | 即失敗（従来どおり） |
| 収集終了・ソケットあり・pair なし | L62：開始時の期限（0.6 秒）で失敗し、延びない | — | — |
| 世代終了 | L82：restart は `IceRestartedError`、close は `ICE negotiation failed`。どちらも 1 秒以内 | `generation-end.test.ts` の `lite` 行 | `generation-end.test.ts` |
| 並行 `connect()` 2 本 | — | **L116：2 本とも check の到着直後に接続（ベースでは 1 本目が 3001 ms）** | L138：2 本とも check の到着直後に接続 |

- ベース `df7f97f9f` で失敗するのは、太字の 2 件（L41、L116）です。
- それ以外のセルはベースでも成功します。不変条件の各項目を固定するために入れています。
- 並行 `connect()` で 2 本が同じ結果キューを取り合う問題は、チケット以前からの full モードの制約です。webrtc 層は `startPromise` の共有で防いでいます。今回は待機の起床だけを直しました（L138 では 2 本とも接続することを確認しています）。
- 前回 `ice-lite-incoming-check.test.ts` に加えた「収集中の `connect()`」のテストは、L23 と同じ内容なので削除しました。

### 検証（`1726e9616`）

| コマンド | 結果 |
| --- | --- |
| `cd packages/ice && npm test` | 52 ファイル成功、479 件成功、5 件スキップ |
| `npm run type` | 成功 |
| `npm run test:small` | 全パッケージ成功（webrtc 1880 件成功） |
| `npm run e2e`（Chrome） | 25 ファイル、71 件成功 |
| `cd e2e && npm run firefox:record`（clean な `1726e9616`、引数なし） | 63 件成功、0 件失敗、8 件スキップ。[記録](../e2e/firefox-runs/20261116T082802Z-1726e9616.json) |

`src/negotiation` は変えていないので、`pbt:deep` は実行していません。

## 追加の修正：ICE-lite が収集の途中で `connect()` する場合（`0a4590d0d`）

### 指摘された問題

`waitForIncomingCheck()` は、check を受けられるソケット（`protocols`）が 1 つもないと即座に戻っていました。full agent はローカル候補の収集が終わった後にしかこの待ちに入らないので、問題は起きません。しかし ICE-lite は、check list が空ならすぐにこの待ちに入ります。そのため `gatherCandidates()` の開始直後、ソケットが開く前に `connect()` すると、すぐにソケットが開くにもかかわらず `ICE negotiation failed` で失敗していました。

### 修正

- ソケットがないことによる即失敗は、収集が終わってもソケットがない場合（`protocols.length === 0 && localCandidatesEnd`）だけにしました（[ice.ts:2081](../packages/ice/src/ice.ts#L2081)）。
- 収集中は `incomingCheckTimeout` の間待ちます。その間にソケットが開いて相手の check が届けば、peer-reflexive の pair が追加されて先に進みます。
- 収集がソケットなしで終わった場合は、待ち時間が過ぎてから失敗します。`gatherCandidates()` には終了を知らせるイベントがないため、待ちを途中で打ち切ってはいません。
- full agent の動作は変わりません。収集の終了後に待ちに入るので、ソケットがなければ従来どおり即失敗します。

### テスト（[ice-lite-incoming-check.test.ts:70](../packages/ice/tests/ice/ice-lite-incoming-check.test.ts#L70)）

- 準備処理は [tests/utils.ts:2464](../packages/ice/tests/utils.ts#L2464) の `createLiteAgentStillGathering` です。
- 内容：`gatherCandidates()` を開始した直後（`protocols` が空であることを確認）に ICE-lite の `connect()` を呼び、収集の完了後に full 側が connect します。lite が即失敗せずに接続することを確認します。
- ベース `04dc6829a` では、`ICE negotiation failed` で失敗します。

### 検証（`0a4590d0d`）

| コマンド | 結果 |
| --- | --- |
| `npm run type` | 成功 |
| `npm run test:small` | 全パッケージ成功（ice 473 件、webrtc 1880 件成功） |
| `npm run e2e`（Chrome） | 25 ファイル、71 件成功 |
| `cd e2e && npm run firefox:record`（clean な `0a4590d0d`、引数なし） | 63 件成功、0 件失敗、8 件スキップ。[記録](../e2e/firefox-runs/20261116T014758Z-0a4590d0d.json) |

## 追加の修正：ICE-lite の空の check list にも `incomingCheckTimeout` を適用する（`feb9f8f52`）

### 指摘された問題

ICE-lite の分岐は check list が空でも待ち時間の処理を通らず、相手の nomination を際限なく待っていました。`incomingCheckTimeout` の説明は ICE-lite を例外にしていないので、説明と動作が食い違っていました。

### 修正

- ICE-lite の `connect()` は、nominate されておらず check list が空なら、full agent と同じ `waitForIncomingCheck(ended)` で待ちます（[ice.ts:1967](../packages/ice/src/ice.ts#L1967)）。
  - 相手の check で peer-reflexive の pair が追加されるか、trickle された候補で pair ができると、待ちを抜けて従来どおり nomination を待ちます。
  - 時間内に pair ができなければ `ICE negotiation failed` で失敗します。`0` なら即失敗です。
  - 待機中に世代が終わった場合は、従来どおり `connectError()` で決着します（ICE の世代終了マトリクスの `lite` 行）。
- pair ができた後の nomination 待ちには、従来どおり時間制限を設けていません。
- `IceOptions.incomingCheckTimeout` と `PeerConfig.iceIncomingCheckTimeout` の説明に ICE-lite の扱いを書き足し、`changelog.md` と生成ドキュメントを更新しました。

### テスト（[ice-lite-incoming-check.test.ts](../packages/ice/tests/ice/ice-lite-incoming-check.test.ts)）

準備処理は [tests/utils.ts:2439](../packages/ice/tests/utils.ts#L2439) の `createLiteAgentWithoutPeerCandidates` です。

| テスト | 内容 | ベース `06eee1235` |
| --- | --- | --- |
| L8 | 待ち時間 0.3 秒で check が届かない。250 ms 以上待ってから `ICE negotiation failed` | 失敗（決着しない） |
| L25 | 待ち時間 0 で即 `ICE negotiation failed` | 失敗（決着しない） |
| L40 | full 側の check と nomination で、時間内に peer-reflexive の pair で接続し、データが届く | 成功（従来の動作を保つ） |

### 検証（`feb9f8f52`）

| コマンド | 結果 |
| --- | --- |
| `npm run type` | 成功 |
| `npm run test:small` | 全パッケージ成功（ice 472 件、webrtc 1880 件成功） |
| `npm run e2e`（Chrome） | 25 ファイル、71 件成功（ICE-lite の E2E を含む） |
| `cd e2e && npm run firefox:record`（clean な `feb9f8f52`、引数なし） | 63 件成功、0 件失敗、8 件スキップ。[記録](../e2e/firefox-runs/20261116T013444Z-feb9f8f52.json) |

`src/negotiation` は変えていないので、今回は `pbt:deep` を実行していません。

## 追加の修正：同期の状態イベント中の再起動（`e535dc54d`）

### 指摘された問題と同じ形の箇所

`Event` の購読者は同期で呼ばれます。そのため、状態イベントを発行してから世代を読む、またはイベントの後に登録や消去をするコードでは、購読者が途中で世代を切り替えられます。`transport/ice.ts` と `transportActivation.ts` の状態イベント発行箇所をすべて確認し、該当する 3 か所を直しました。

| 箇所 | 問題 | 修正 |
| --- | --- | --- |
| `start()` の `setState("checking")`（指摘箇所、[transport/ice.ts:814](../packages/webrtc/src/transport/ice.ts#L814)） | 世代をイベントの後に読んでいた。購読者が再起動すると、旧 `start()` が新しい世代の番号を捕まえ、新しい世代の `connect()` を呼んで、失敗時に `failed` にしていた | 世代の固定と `waitStart` / `checksStarted` / `startPromise` の登録をすべて済ませてから `checking` を発行する。購読者が `start()` を呼び直しても同じ要求を共有する |
| `restart()` / `resetRemoteGeneration()` の `setState("new")`（[transport/ice.ts:778](../packages/webrtc/src/transport/ice.ts#L778), [L791](../packages/webrtc/src/transport/ice.ts#L791)） | `startPromise` などの消去をイベントの後に行っていた。`new` の購読者が始めた新しい世代の `start()` の登録が消え、次の `start()` が二重に checks を始めうる | 消去をイベント（`new`、gathering state、negotiationneeded）より前に移す |
| `TransportActivation.connect()` の `setConnectionState("connecting")`（[transportActivation.ts:263](../packages/webrtc/src/negotiation/transportActivation.ts#L263)） | 購読者が再起動して新しい認証情報を設定すると、旧 connect が新しい世代の `start()` を呼んでいた | イベントの後に `replaced()` を確かめ、変わっていれば `start()` を呼ばずに状態を変えずに終わる |

### 回帰テスト（[iceGenerationActivation.test.ts](../packages/webrtc/tests/transport/iceGenerationActivation.test.ts)）

| テスト | 内容 | ベース `6f8704ddb` |
| --- | --- | --- |
| L97 `$restart restart $when`（4 件） | local / remote restart を、`start()` の直後と `checking` の同期購読者の中で行う。旧 `start()` が `connect()` を呼ばずに `IceRestartedError` で決着し、`failed` にならず、`checksStarted=false`。新しい世代は connected で、`connect()` は合計 1 回 | 購読者の中の 2 件が失敗（新しい世代で `connect()` が呼ばれる） |
| L143 | 指摘の再現。`checking` の購読者が `resetRemoteGeneration()` し、新しい認証情報を設定する | 失敗（タイムアウト） |
| L183 | `new` の購読者が新しい世代を設定して `start()` し、その後もう一度 `start()` を呼ぶ。`connect()` は 1 回で connected | 失敗 |
| L56 | `connecting` の connectionState 購読者が remote restart し、新しい認証情報を設定する。旧 connect は新しい世代の checks を始めず（`checksStarted=false`）、`setConnectionState` は `["connecting"]` だけ。DTLS も始まらない | 失敗（タイムアウト） |

### 検証（`e535dc54d`）

| コマンド | 結果 |
| --- | --- |
| `npm run type` | 成功 |
| `npm run test:small` | 全パッケージ成功（webrtc 1880 件成功） |
| `npm run e2e`（Chrome） | 25 ファイル、71 件成功 |
| `npm run pbt:deep` | fuzz 306/306。scenario は seed 95 が失敗、flaky 4 件。model は flaky 1 件。leak は heap seed 4 が失敗 |
| `cd e2e && npm run firefox:record`（clean な `e535dc54d`、引数なし） | 63 件成功、0 件失敗、8 件スキップ。[記録](../e2e/firefox-runs/20261116T011924Z-e535dc54d.json) |

`pbt:deep` の 2 件の失敗について：

- 単独で再実行すると、scenario seed 95 は 3/3、leak heap seed 4 は 2/2 成功しました。seed 95 は、失敗時と同じ shard（seed 92〜98）で 2/2 成功しました。
- ベース `6f8704ddb` でも同じ条件で再実行し、どれも同じく成功しました。
- 失敗が出るのは 16 並列の負荷下だけで、今回の変更による回帰ではないと判断しました。leak heap seed 4 は、前回（`9b1cb2bec`）の `pbt:deep` でも同じく負荷下で失敗しています。

## 追加の修正：`start()` の直後に世代が終わる場合（`bfc957516`）

### 指摘された問題

`RTCIceTransport.start()` は `connection.connect()` を次のマイクロタスクで呼びます。その前に `restart()` または `resetRemoteGeneration()` が走り、新しい認証情報で `start()` が呼ばれると、旧 `start()` も新しい世代の `connect()` を呼びます。その結果、新しい世代の checks が二重に始まります。

これも不変条件の違反で、今回は「旧世代の開始要求が、新しい世代の処理を始めてしまう」という向きの漏れです。

### 修正

- 延期した処理の先頭で世代を比べます（[transport/ice.ts:820](../packages/webrtc/src/transport/ice.ts#L820)）。
  - 世代が変わっていたら、`connect()` を呼ばずに `IceRestartedError` で決着します。
  - 同じ区間で `stop()` されていたら、`connect()` を呼ばずに `RTCIceTransport is closed` で決着します。
- どちらの場合も、`failed` にするかどうかは既存の catch が判定します。世代が変わっていれば何もしません。`stop()` 済みなら `closed` は最終状態なので変わりません。
- `start()` 以外に、延期して ICE の処理を始める箇所は `transport/ice.ts` と `transportActivation.ts` にありません（`Promise.resolve()` / `queueMicrotask` / `setImmediate` を検索して確認しました）。

### 回帰テスト

[iceGenerationActivation.test.ts:57](../packages/webrtc/tests/transport/iceGenerationActivation.test.ts#L57) で、`start()` の直後、同じ同期区間で世代を終わらせます。準備処理は [tests/utils.ts:73](../packages/webrtc/tests/utils.ts#L73) の `endIceTransportGeneration`（同期で restart する）と `exchangeIceTransportGeneration`（L87）です。

| 終了 | 旧 `start()` | 旧世代での `connect()` の呼び出し | 新しい世代 |
| --- | --- | --- | --- |
| local restart | `IceRestartedError`。`failed` にならない | 0 回 | connected。`connect()` は合計 1 回 |
| remote restart | `IceRestartedError`。`failed` にならない | 0 回 | connected。`connect()` は合計 1 回 |
| `stop()`（L93） | エラーで決着。`closed` のまま | 0 回 | － |

ベース `82ef35f4b` では 3 件とも失敗します。restart の 2 件は、旧 `start()` が新しい世代の `connect()` を呼んでしまい、認証情報や収集が未完了のエラーになります。`stop()` の件はタイムアウトします。

テスト用の ICE transport（`createIceTransportsWithoutPeerCandidates`）は、`useDefaultStunServer: false` で公開 STUN サーバーに問い合わせないようにしました。問い合わせると収集に時間がかかり、準備段階がタイムアウトすることがありました。

### 検証（`bfc957516`）

| コマンド | 結果 |
| --- | --- |
| `npm run type` | 成功 |
| `npm run test:small` | 全パッケージ成功（webrtc 1875 件成功） |
| `npm run e2e`（Chrome） | 25 ファイル、71 件成功 |
| 対象ファイル（`iceGenerationActivation.test.ts` と `transport/ice.test.ts`） | 連続 26 回成功（`iceGenerationActivation.test.ts` 単独 20 回を含む） |
| `cd e2e && npm run firefox:record`（clean な `bfc957516`、引数なし） | 1 回目（[003908Z](../e2e/firefox-runs/20261116T003908Z-bfc957516.json)）：`iceTcp.test.ts` がリトライを含めて 20 秒のタイムアウトで失敗（62 件成功）。2 回目（[004831Z](../e2e/firefox-runs/20261116T004831Z-bfc957516.json)）：63 件成功、0 件失敗 |

`iceTcp.test.ts` の 1 回目の失敗について：

- 同じコミットで、単独実行 15 回と全件の手動実行 3 回はすべて成功しました。
- 全件の手動実行のうち 1 回で、`turnRelay.test.ts`（TURN-TCP）の unhandled rejection（`timed out waiting for "server-to-browser-tcp"`）が出ました。この実行も最終的には成功しています。TCP を使う他のテストでも、断続的な遅延が出ています。
- `bfc957516` の変更は `start()` と再起動が重なるときだけに効き、再起動のない `iceTcp` の経路は変えていません。
- ただし、1 回目の失敗時のサーバーログは残っていないため、原因は特定できていません。

## 検証（`9b1cb2bec` 相当の作業ツリー）

| コマンド | 結果 |
| --- | --- |
| `cd packages/ice && npm test` | 50 ファイル成功、469 件成功、5 件スキップ |
| `npm run type` | 成功 |
| `npm run test:small` | 全パッケージ成功（webrtc 91 ファイル、1872 件成功） |
| `npm run e2e`（Chrome） | 25 ファイル、71 件成功 |
| `npm run pbt:deep` | fuzz 306/306、scenario 2161 件成功 + flaky 2（単独再実行で成功）。model は seed 287 の 1 件が失敗、leak は heap seed 4 の 1 件が失敗（単独再実行で成功） |
| `cd e2e && npm run firefox:record`（clean な `9b1cb2bec`、引数なし） | 63 件成功、0 件失敗、8 件スキップ。[記録](../e2e/firefox-runs/20261116T000700Z-9b1cb2bec.json) |

model seed 287 の失敗（`channel dc0 did not open on both peers`）は、ベースでも再現しました。単独で再実行した結果は、ベース `91f6b80eb` が 6 回中 2 回成功、今回の変更が 5 回中 4 回成功です。今回の変更による回帰ではありません。
