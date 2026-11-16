# 8b7c8e4a: 空の check list での待機と ICE 世代の終了

対象コミット: `9b1cb2bec`（実装とテスト）、`0b72d4547`（Firefox 記録）。ベースは `91f6b80eb`。
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
