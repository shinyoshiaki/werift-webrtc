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