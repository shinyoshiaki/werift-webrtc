# 8b7c8e4a: 空の check list での待機と ICE 世代の終了

対象コミット: `9b1cb2bec`（実装とテスト）、`0b72d4547`（Firefox 記録）、`bfc957516`（`start()` の延期した `connect()` の取消）、`1cff1bead`（Firefox 記録）、`e535dc54d`（同期の状態イベント中の再起動）、`037110bdb`（Firefox 記録）、`feb9f8f52`（ICE-lite の待ち時間）、`3344382e9`（Firefox 記録）。ベースは `91f6b80eb`。
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
