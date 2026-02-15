update_todo

● Glob "packages/{sctp,webrtc,common}/**/*.{ts,js}"

● Grep "class .*Sctp|stop\(|close\(|setInterval|setTimeout|Timer|heartbeat|retrans|ack|rto"
(/home/shin/code/werift.worktree/d57c0b1a-bdea-41a4-8c0e-bc21983606bf/packages)

● Read packages/sctp/src/sctp.ts

● Grep "setInterval|setTimeout|clearInterval|clearTimeout|stop\(|close\(|abort|destroy|unref"
(/home/shin/code/werift.worktree/d57c0b1a-bdea-41a4-8c0e-bc21983606bf/packages/sctp/src)

● Read packages/sctp/src/transport.ts

● Read packages/common/src/transport.ts

● Read packages/common/src/event.ts

● Read packages/sctp/src/sctp.ts lines 1-260

● Read packages/sctp/src/sctp.ts lines 900-1145

● Read packages/sctp/src/sctp.ts lines 1180-1320

● Grep "new Event\(|EventDisposer|watch\(|asPromise\(|setImmediate|process\.nextTick|queueMicrotask|
createServer|connect\("
(/home/shin/code/werift.worktree/d57c0b1a-bdea-41a4-8c0e-bc21983606bf/packages/sctp/src)

● Read packages/sctp/src/sctp.ts lines 760-860

● Read packages/sctp/tests/udp.test.ts

● Read packages/webrtc/src/transport/sctp.ts

● Read packages/sctp/tests/api.test.ts

● Create session plan file
  $ cat > /home/shin/.copilot/session-state/1dca50a2-68b6-40a2-8653-4a44528e0b1a/plan.md <<'EOF'
  # Plan
  1. Trace SCTP stop/close flow and all async handles (timeout/immediate/events).
  2. Inspect transport shutdown contracts and existing tests for teardown.
  3. Produce task refinement with concrete implementation targets, constraints, and completion ...

● Grep "flush\.(execute|complete|asPromise|subscribe)|onSackReceived|sackTimeout|setImmediate"
(/home/shin/code/werift.worktree/d57c0b1a-bdea-41a4-8c0e-bc21983606bf/packages/sctp/src/sctp.ts)

● Grep "stop\(|close\(|setState\(SCTP_STATE\.CLOSED\)|timer3Start\(|timer1Expired|timer2Expired|time
rReconfigHandleExpired"
(/home/shin/code/werift.worktree/d57c0b1a-bdea-41a4-8c0e-bc21983606bf/packages/sctp/tests)

● Read packages/sctp/tests/sctp.test.ts

● Read packages/sctp/src/index.ts

● Grep "transport\.onData|onData\s*=|close\(\)\s*\{|removeAllListeners|off\(|once\("close""
(/home/shin/code/werift.worktree/d57c0b1a-bdea-41a4-8c0e-bc21983606bf/packages/sctp/src)

● Read package.json

● Read packages/sctp/package.json

● Reproduce active handles after SCTP stop
  $ cd /home/shin/code/werift.worktree/d57c0b1a-bdea-41a4-8c0e-bc21983606bf && npx --yes tsx -e
  'import { createSocket } from "dgram"; import { SCTP, createUdpTransport } from
  "./packages/sctp/src/index.ts"; const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
  const main=async()=>{ const port=56000+Math.floor(Math.random()*1000); const
  serverSock=createSocket("udp4"); serverSock.bind(port); const ...

● Read TICKET-ticket-7e99f301-ab64-4dfb-91ec-3d3059ec7715.md

● Read TICKET-ticket-4d5e008a-351a-4b02-a739-9c081973cf2e.md

● web_fetch: https://raw.githubusercontent.com/versatica/mediasoup/try-test-werift-sctp/node/src/tes
t/test-werift-sctp.ts

● Read packages/sctp/src/sctp.ts lines 540-750

● Grep "case AbortChunk\.type|case ShutdownChunk\.type|case ShutdownAckChunk\.type|case
ShutdownCompleteChunk\.type|setState\(SCTP_STATE\.CLOSED\)|t2Start\(|timer2Cancel\(|timer1Cancel\("
(/home/shin/code/werift.worktree/d57c0b1a-bdea-41a4-8c0e-bc21983606bf/packages/sctp/src/sctp.ts)

● Read packages/sctp/src/sctp.ts lines 828-910

● update_todo

## 1. タスクの目的と背景

- mediasoup 側の `test-werift-sctp.ts` では `afterEach` で `await sctpClient.stop(); sctpClient.transport.close();` を実行しているのに、Jest が open handle を検出しています。  
- werift 側調査では、`SCTP.stop()` は主に state/timer cleanup を行う一方で、SCTP 内のタイマーコールバック実行中レースや再スケジュール経路が残っており、停止後も `setTimeout` が再生成され得る構造です（`packages/sctp/src/sctp.ts` の timer1/2/3/reconfig 周辺）。  
- 目的は「SCTP 停止後に Node プロセスへ残る非同期ハンドル（特に timer/immediate/socket close 待ち）を確実にゼロにする teardown の保証」を実装・検証することです。

## 2. 実装すべき具体的な機能や変更内容

- **停止フラグ導入（SCTPインスタンス単位）**
  - `SCTP` に `isStopping` / `isClosed` 相当の明示フラグを追加し、`stop()` 冒頭で立てる。
- **タイマー再スケジュール防止**
  - `timer1Expired` / `timer2Expired` / `timer3Expired` / `timerReconfigHandleExpired` で、`CLOSED` または stopping 状態なら **再送・再タイマー生成を行わず即 return**。
  - `transmit()` 内の `timer3Start()/timer3Restart()` 呼び出し前にも同様のガードを追加。
- **残ハンドルの明示キャンセル**
  - `stop()` で `timer1/2/3/reconfig` だけでなく `sackTimeout` (`setImmediate`) も `clearImmediate` 対象にする。
- **入力経路の無効化**
  - `stop()` で `transport.onData = undefined/noop` 相当を設定し、停止後の受信で再度処理が進まないようにする（Transport 契約範囲内で）。
- **Transport close 契約の明確化**
  - 現状どおり `SCTP.stop()` は transport を暗黙 close しない（既存テスト仕様維持）。
  - ただし `UdpTransport.close()` が非同期 close 完了を待てない設計なので、必要に応じ `close(): Promise<void>` への拡張（後方互換に配慮）を検討。
- **回帰テスト追加**
  - `packages/sctp/tests` に「大量送信直後に stop + close しても open timer が残らない」回帰テストを追加。
  - `stop()` の idempotent 性と「transport をデフォルトでは閉じない」既存仕様は維持確認。

## 3. 技術的な実装アプローチを調査し結果を簡潔にまとめる

- コード上、`stop()` 自体は `setState(CLOSED)` と `clearTimeout` を呼びますが、**既に発火中のタイマーコールバックが stop 後に再度 `setTimeout` を張る可能性**があります（特に `timer1Expired/timer2Expired/timerReconfigHandleExpired`）。  
- `transmit()` は `sendChunk()` が closed で早期 return しても `timer3Start()` を呼び得るため、停止レース時に timer ハンドルが再生成される余地があります。  
- mediasoup の再現テストは `void sctpClient.send(...)` で多数送信してから teardown するため、送信中タイミングで stop が入るレース条件を満たしやすく、ここを潰す設計（停止フラグ + 再スケジュール禁止）が最も効果的です。

## 4. 考慮すべき制約や注意点

- **後方互換性**: `SCTP.stop()` が transport を閉じない既存仕様（`packages/sctp/tests/api.test.ts`）は維持する。  
- **最小変更**: SCTP 本体の停止/タイマー経路に限定し、データチャネルや他パッケージへ波及させない。  
- **非同期レース前提**: 「clear したから安全」では不十分で、コールバック内ガードが必須。  
- **テスト安定性**: open handle 検証は環境依存があるため、テストは `--detectOpenHandles` 前提の実行手順も併記する。  
- **`net` import 差分の独立性**: ご提示の `import * as net` 変更（issue #548 対応）は本件の根因とは分離して扱う。

## 5. 完了条件

- [ ] `SCTP.stop()` 後に timer/immediate が再生成されない（停止レース込みで保証）。  
- [ ] mediasoup 再現シナリオ（大量送信後 teardown）で Jest の open handle 警告が解消する。  
- [ ] `stop()` の idempotent 性と「transport 非暗黙close」仕様が既存テストで維持される。  
- [ ] 追加回帰テストが `packages/sctp` テスト群で安定して通る。  
- [ ] 変更は `packages/sctp/src/sctp.ts`（必要なら `transport.ts`）中心の最小差分に収まっている。