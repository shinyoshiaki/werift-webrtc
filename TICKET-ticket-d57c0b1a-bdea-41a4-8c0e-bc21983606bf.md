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