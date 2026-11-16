# [ICE] 相手が active の TCP 候補しか出さないと、werift の ICE が check を待たずに即 failed になる

## 1. 目的と背景

- Firefox E2E 整備（`a461df90-10bb-4aad-8f1b-3cce626d630b`、親チケット #269 `190063e8-99d9-410f-89ca-cee8cf6423a1` の派生）で見つかった werift 本体の不具合。
- E2E `e2e/tests/datachannel/iceTcp.test.ts`（direct ICE-TCP）が Firefox 157 だけ失敗する。Chrome は passive の TCP 候補も出すので通る。
- Firefox は TCP の host 候補を `tcptype active`（port 9）しか出さない。テストは offer を TCP 候補だけに絞るので、werift（`iceUseTcp: true`、passive / active を持つ）から見ると、相手の候補とペアにできるものがない（active 同士はペアにならず、werift の passive は相手の active へ check を送れない）。

## 2. 現象（サーバーの `DEBUG=werift*` ログ）

```
iceConnectionStateChange checking
earlyChecks ... 0
iceConnectionStateChange failed          ← checking の 1 ms 後
iceTransport.start failed Error: ICE negotiation failed
Triggered Checks {...}                   ← その 2 ms 後に Firefox の active TCP から check が届く
nominated {...}                          ← nominate まで進むが、状態はもう failed
```

## 3. 原因（コード）

- `packages/ice/src/ice.ts` `connect()`: check list が空だと `schedulingChecks()` はすぐ終わり、完了待ちの `while (this.checkList.length > 0 && res === ICE_FAILED)` も 1 回も回らないので、`res` が `ICE_FAILED` のまま `throw new Error("ICE negotiation failed")` に進む。
- 相手が active の TCP 候補だけを出す場合（RFC 6544）や peer-reflexive しか成立しない場合は、こちらから送る check がなくても、相手から届く check（triggered check / prflx の学習）で接続できる。空の check list を即失敗にせず、相手からの check を一定時間待つ必要がある。

## 4. 完了条件

- 相手が active の TCP 候補だけを出す接続で、相手からの check によって ICE が connected になる。`packages/ice` にテストを足す（相手候補が空・active のみのケース）。
- `e2e/tests/datachannel/iceTcp.test.ts` の Firefox スキップを外し、`cd e2e && npm run firefox:record -- tests/datachannel/iceTcp.test.ts` で通る。スキップ箇所は `grep -rn "firefox-known:ice-tcp-active-only" e2e/tests` で探す。
- Chrome の E2E（`npm run e2e`）と `npm run test:small` に回帰がない。

## 5. 追加要件：ICE 世代の終了を 1 本のシグナルにまとめる（レビュー収束のための打開策）

### 背景

- 空の check list で相手の check を待つ処理（既定 30 秒）を入れたことで、ICE restart と重なる時間が長くなった。既存の世代管理の穴が表に出て、レビューでは同じ系統の指摘が経路を変えて繰り返された（R1: 再起動後も旧世代の待機が残り failed を通知する。R5: 旧 `connect()` が永久に終わらない。R7: `checksSettled()` で並行して待つ側が取消を failed と誤認する）。
- 同じ系統でまだ指摘されていない経路：ICE-lite の旧 `connect()` が再起動後も close 後も保留される。full モードで旧 `connect()` が再起動後も `schedulingChecks()` を回し続ける（再起動で `remoteCandidatesEnd` が false に戻るため）。完了待ちの後の「残りの check の取消」が新しい世代の `checkList` に対して動く。

### 不変条件

世代が終わったら（local restart、remote-only restart、close、transport の引退）、その世代を待つ側はすべて速やかに決着し、新しい世代の状態を一切変えない。

### 要件

- **ICE (`packages/ice/src/ice.ts`)**
  - `connect()` は開始時に `remoteChecks.signal`（`restart()` / `restartRemote()` / `close()` で abort される）を `ended` として、`checkListState` を `queue` として保持する。
  - スケジューリングのループ、空リストでの待機、完了待ち、ICE-lite の完了待ちのすべてを `ended` で打ち切る。
  - 打ち切ったらその場でエラーを投げる。再起動による終了は `IceRestartedError`、close による終了は従来どおり `ICE negotiation failed`。
  - 打ち切った後は、残りの check の取消にも状態の変更にも進まない。
- **webrtc**
  - `RTCIceTransport.checksGeneration` を、`restart()` と `resetRemoteGeneration()` で 1 増やす。
  - `start()` が失敗を `failed` にするのは、まだ自分の世代のときだけ。
  - `TransportActivation` の `connect()` と `connectPending()` は、`start()` と `checksSettled()` の 4 つの await 地点すべてで、前後の世代を比べる。変わっていたら、または transport が引退していたら（connect: `dtlsTransports` にない、connectPending: pending-only でない）、状態を変えずに終わる。
  - エラーの型ではなく世代で判定する。
- **テスト**（Arrange は共有ユーティリティに集約し、各ステップに日本語コメントを付ける）
  - ICE：{local restart, remote restart, close} × {空リストで待機中, スケジューリング中, 完了待ち, ICE-lite}。旧 `connect()` が 1 秒以内に期待どおりのエラーで決着すること、新しい世代の pair に check を送らないこと、新しい世代が connected になることを確認する。
  - webrtc：{connect() が start, connect() が待ち手, connectPending() が start, connectPending() が待ち手} × {restart, resetRemoteGeneration, 引退}。`setConnectionState` に failed / connected が渡らず、DTLS も始まらないことを確認する。
  - `RTCPeerConnection`：二つの接続処理が並行しているときに `restartIce()` しても、`connectionState` が failed にならない。
  - `tcp.test.ts` の active のみのケースで、準備段階の assert をネットワークインターフェース数に依存しない形にする（候補はすべて `tcptype==="active"` で 1 件以上）。
- **検証と記録**
  - `packages/ice` のテスト、`npm run type`、`npm run test:small`、`npm run e2e`、`npm run pbt:deep` を実行する（`src/negotiation` を変えるため）。
  - 修正をコミットした後、clean な HEAD で `cd e2e && npm run firefox:record`（引数なし）を実行し、その記録をコミットする。
  - 確認レビューは未コミットの差分だけを見る。そのため `reviews/8b7c8e4a-ice-incoming-check-wait.md` に不変条件、マトリクス、テストの位置を書き、未コミットのまま残してレビューを依頼する。

## 6. 追加要件：空の check list での待機の起床源を網羅する

### 背景

- 世代終了の系統はマトリクステストで塞いだ。その後のレビューの指摘は、新しい待機（`waitForIncomingCheck`）が「いつ始まり、何で起き、いつ失敗するか」に移った（ICE-lite に待ち時間が効かない、ICE-lite が収集中に即失敗する）。
- 同じ系統で未指摘だった問題が 2 件ある。
  - A：ICE-lite がソケットを 1 つも作れない（`useIpv4/6: false`）状態で、収集中に `connect()` すると、収集が数 ms で終わっても待ち時間が切れるまで失敗しない。
  - B：同一世代で `connect()` を 2 本並行に呼ぶと、待ち手が 1 つしか登録できないため、2 本目が 1 本目の起床を奪い、1 本目は待ち時間が切れるまで接続しない。
- 原因は、待機が「pair 追加」と「世代終了」でしか起きず、「ローカル収集の完了」で起きないこと、そして待ち手を 1 つしか持てないことにある。`gatherCandidates()` には `localCandidatesEnd = true` を立てる地点が 2 か所ある（即時の分岐と `localCandidatesEndPromise` の `.then`）。

### 不変条件

空の check list での待機は、次のとおりに動く。

1. pair が追加されたら、直ちに続行する。
2. ローカル収集が終わった時点でソケットがなければ、直ちに失敗する。
3. 世代が終わったら、直ちにその世代のエラーで決着する。
4. それ以外は、`incomingCheckTimeout` の期限で失敗する。期限は待機の開始時に決まり、起こされて再評価しても延びない。

同一世代の待ち手が複数いても、各自が起きる。

### 要件

- **`packages/ice/src/ice.ts`**
  - 待ち手を `incomingCheckWaits`（`Set<AbortController>`）で管理する。
  - `addPair()` と、`localCandidatesEnd = true` を立てる 2 か所の直後で、`wakeIncomingCheckWaits()` を呼ぶ。
  - `waitForIncomingCheck()` は期限を固定してループで待ち、起きるたびにソケットの有無と pair を再評価する。
- **ドキュメント**
  - `IceOptions.incomingCheckTimeout` と `PeerConfig.iceIncomingCheckTimeout` の JSDoc に、「収集が終わってソケットがなければ即失敗」「期限は延びない」を追記する。
  - `changelog.md` を更新し、`npm run doc` を実行する。
  - webrtc 側の実装は変えない。ICE-lite の regather（`commit()` が収集を await しない経路）から、収集中の `connect()` に到達しうることをコメントで残す。
- **マトリクステスト `packages/ice/tests/ice/incoming-check-wake.test.ts`**（Arrange は `tests/utils.ts` の共有ユーティリティ、各ステップに日本語コメント）

  | 起床源 | 対象 | 期待 |
  | --- | --- | --- |
  | pair 追加 | ICE-lite 収集中 | connected になる |
  | 収集終了・ソケット 0 | ICE-lite 収集中 | 待ち時間の前に即失敗する（A） |
  | 収集終了・ソケットあり・pair なし | ICE-lite 収集中 | 開始時の期限で失敗する（延びない） |
  | 世代終了（restart / close） | ICE-lite 収集中 | `IceRestartedError` / `ICE negotiation failed` |
  | 並行 `connect()` 2 本 | ICE-lite / full、収集後 | 2 本とも check の到着直後に決着する（B） |

  ベース（`df7f97f9f`）で失敗するケースを一時 worktree で確認する。
- **検証と記録**
  - `packages/ice` のテスト、`npm run type`、`npm run test:small`、`npm run e2e` を実行する（`src/negotiation` は変えないので `pbt:deep` は不要）。
  - コミット後、clean な HEAD で `cd e2e && npm run firefox:record`（引数なし）を実行し、記録をコミットする。
  - レビューは上限（`maxReviewIterations = 5`）に達しているため、再開にはユーザーの操作（`currentReviewIteration` のリセット、または手動でのレビュー開始）が必要。再開時は `reviews/8b7c8e4a-ice-incoming-check-wait.md` に不変条件と表を追記し、未コミットのまま `ticket review` を依頼する。