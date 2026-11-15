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