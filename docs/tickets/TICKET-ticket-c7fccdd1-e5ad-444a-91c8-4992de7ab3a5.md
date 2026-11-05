# SCTP: defer incoming stream reset until DATA through Sender's Last Assigned TSN is received

## 1. 目的と背景

### 目的

相手から届く SCTP Outgoing SSN Reset Request（RFC 6525 §4.1, §5.2.2）を、その **Sender's Last Assigned TSN**（以下 `lastTsn`）までの DATA を全部受け取ってから実行するようにする。こうすれば、stream reset が再送 DATA を追い越しても、最後のユーザーメッセージを取りこぼさない（RFC 6525 の deferred reset processing）。

### 背景・起票時の情報

* downstream の相互接続テスト `sidorares/react-x11-components#1154`（<https://github.com/sidorares/react-x11-components/pull/1154>）で、最後の DataChannel メッセージのチャンクを 1 つわざと落とすと、64 KiB のメッセージが 1 件まるごと届かない現象が決定的に再現した。
* 送信側は欠けたチャンクを再送するが、その前に Stream Reset が届く。werift はすぐに inbound stream を削除して DataChannel を閉じるため、後から来た再送チャンクは捨てられる。
* downstream の回避策は「自分が close する前に、その stream の DATA が全部 ACK されるのを待つ」もの。これは自分が送信側のときしか効かず、**相手が送った reset が相手自身の再送を追い越すケース**では werift を守れない。
* 起票時点で `werift 0.25.2` と `develop`（v0.26.0 の作業を含む）の両方に残っている。v0.26.0 の SCTP キュー改善（`ee6ae1055`）は送信/ACK のスケーリングを改善しただけで、deferred reset は実装していない。

### 現状コードの調査結果

| 箇所 | 現状 |
| --- | --- |
| `packages/sctp/src/param.ts:21-69` `OutgoingSSNResetRequestParam` | `lastTsn` の parse/serialize はできているが、受信側では一度も参照されていない。 |
| `packages/sctp/src/param.ts:116-119` `reconfigResult` | 定義は `ReconfigResultSuccessPerformed: 1` と `BadSequenceNumber: 5` だけ。`In progress (6)`、`Success - Nothing to do (0)`、`Denied (2)`、`Error - Request already in progress (4)` などがない。 |
| `packages/sctp/src/sctp.ts:566-598` `receiveReconfigParam()` の `OutgoingSSNResetRequestParam` 分岐 | `lastTsn` を見ないまま、すぐに (1) `SuccessPerformed` を返し、(2) `delete this.inboundStreams[streamId]`、(3) 逆方向の reset を `reconfigQueue` に積んで `transmitReconfigRequest()`、(4) `onReconfigStreams.execute(p.streams)`（webrtc 側で DataChannel が `closed` になる）。**`requestSequence` の検証（期待値・重複・不正値）もない**ため、再送された request も毎回処理される。 |
| `packages/sctp/src/sctp.ts:642-668` `receiveDataChunk()` | `markReceived()` で `lastReceivedTsn`（cumulative TSN）を進め、`getInboundStream()` に `addChunk` → `popMessages()` で配信する。stream が削除済みなら `getInboundStream()` が**新しい `InboundStream`（SSN=0）を作る**ので、reset 後に届いた古い再送チャンクは中途半端なフラグメントとして残り、配信されない。 |
| `packages/sctp/src/sctp.ts:786-827` `receiveForwardTsnChunk()` | PR-SCTP で `lastReceivedTsn` を進める。ここも deferred reset を再評価すべき地点。 |
| `packages/sctp/src/sctp.ts:855-876` `markReceived()` | cumulative TSN が進む唯一の地点（DATA 経由）。 |
| `packages/sctp/src/sctp.ts:194-201` | `reconfigResponseSeq` は「最後に処理した incoming request の seq（初期値は peer initialTsn - 1）」。`init` / `initAck` 受信時に `tsnMinusOne(initialTsn)` で初期化される（`sctp.ts:370, 416`）。 |
| `packages/sctp/src/sctp.ts:599-628` `ReconfigResponseParam` 分岐（自分が送った request への応答） | 結果が `SuccessPerformed` 以外ならログを出すだけ。`reconfigRequest` は残り、`timerReconfigHandleExpired` が再送する。`In progress` も「失敗」としてログに出て、再送のたびに `timerReconfigFailures` が増える。上限 `SCTP_MAX_ASSOCIATION_RETRANS` を超えると association が `CLOSED` になる（`sctp.ts:1241-1262`）。 |
| `packages/sctp/src/sctp.ts:905-920` `send()` | TSN は `send()` でキューに積んだ時点で採番される。そのため werift が送る request の `lastTsn = tsnMinusOne(localTsn)`（`sctp.ts:1069-1074`）には、まだ送っていないキュー内の DATA も含まれる。相手が deferred reset を正しく実装していれば、送信側の werift は問題ない。 |
| `packages/webrtc/src/transport/sctp.ts:83-92` | `onReconfigStreams` を受けると、該当 DataChannel を `closing` → `closed` にして `dataChannels` から削除する。SCTP 層で `onReconfigStreams` の発火を遅らせれば、DataChannel の close も自然に遅れる。webrtc 層の変更は原則不要。 |

## 2. 実装すべき機能・変更内容

### 2.1 incoming Outgoing SSN Reset Request の deferred reset processing（必須）

RFC 6525 §5.2.2 に従い、`OutgoingSSNResetRequestParam` を受けたときに次を行う。

1. **Request Sequence Number を検証する**（RFC 6525 §5.2.1、冪等性のため）
   * `requestSequence === tsnPlusOne(reconfigResponseSeq)`（次に期待する値）なら新規 request として処理する。
   * `requestSequence === reconfigResponseSeq`（処理済み request の再送）なら、状態は変えず、**前回と同じ result をもう一度返す**。
   * 現在保留中の deferred request と同じ seq なら、もう一度評価する（届いていれば実行して `SuccessPerformed`、まだなら再び `In progress`）。
   * それ以外は `BadSequenceNumber` を返し、何もしない。
2. **TSN 境界を判定する**
   * `uint32Gte(lastReceivedTsn, p.lastTsn)` が成り立てば、従来どおりすぐに reset を実行し `SuccessPerformed` を返す。
   * 成り立たなければ **deferred reset** に入る。`ReconfigResponseParam(requestSequence, InProgress = 6)` を返し、request を保留状態として覚えておく。この時点では `reconfigResponseSeq` を進めない（再送 request をもう一度評価するため）。
3. **保留中の扱い**
   * 対象 stream の inbound 状態（`InboundStream` と再組立てバッファ、SSN）は残し、`lastTsn` 以下の DATA（再送を含む）は従来どおり受信・再組立て・配信する。
   * 対象 stream 宛てで TSN が `lastTsn` より大きい DATA は、RFC の要求どおり reset 後の stream に属するものとして**別バッファに退避し、配信しない**（TSN は `markReceived()` で受信済みとして SACK に反映する。rwnd の扱いにも注意）。
   * `onReconfigStreams` の発火、`inboundStreams` の削除、逆方向の reset（`reconfigQueue` への追加と `transmitReconfigRequest()`）は**すべて実行時まで遅らせる**。
4. **保留を解消するタイミング**
   * `markReceived()`（DATA）と `receiveForwardTsnChunk()`（FORWARD-TSN）で cumulative TSN が進んだあと、保留中 request を評価し、`uint32Gte(lastReceivedTsn, pending.lastTsn)` になったら実行する。
   * 評価は、そのパケットで配信できるメッセージを `onReceive` に渡し**終えてから**行う。境界までの最後のメッセージが `onReconfigStreams` より先に届くことを保証するため。
   * 実行内容は、inbound stream の削除（SSN を 0 にリセット）、退避した `lastTsn` 超の DATA を新しい `InboundStream` に入れ直して配信判定、逆方向の reset の送出、`onReconfigStreams.execute(streams)`、`reconfigResponseSeq = requestSequence`、最後の result を `SuccessPerformed` として記録。
   * 実行後に相手が request を再送してきたら、1 の重複判定で `SuccessPerformed` を返す（dcsctp と同じ方式）。保留が解けた時点で `SuccessPerformed` をこちらから能動的に送るかは実装時に決める（RFC 上は必須ではない）。
5. **後始末**
   * `stop()` / association close / abort のときに保留状態と退避バッファを捨てる。

### 2.2 `reconfigResult` の拡充（必須）

`packages/sctp/src/param.ts` の `reconfigResult` に RFC 6525 §4.4 の値を追加する。少なくとも `SuccessNothingToDo: 0`、`Denied: 2`、`ErrorWrongSSN: 3`、`ErrorRequestAlreadyInProgress: 4`、`InProgress: 6` を足す。既存のキー名 `ReconfigResultSuccessPerformed` と `BadSequenceNumber` は public export なので変えない。

### 2.3 自分が送った request への `In progress` 応答（推奨）

相手（Chrome の dcsctp / usrsctp、または修正後の werift）が `In progress` を返したとき、werift が送信側として壊れないようにする。

* `In progress` を失敗としてログに出さない。`reconfigRequest` は残し、Re-configuration timer で同じ request を再送する。
* `In progress` が続いただけで `SCTP_MAX_ASSOCIATION_RETRANS` を超えて association が閉じないよう、失敗カウントの扱いを見直す。応答は届いているので、到達性の失敗には数えない。

### 2.4 テスト（必須）

`packages/sctp/tests/` に deferred reset の回帰テストを追加する（例: `reconfig.test.ts`）。

* **決定的なユニットテスト**（パケットを直接注入する）。`sctp.test.ts` の `createMockSctp` / `handleData` 注入と同じ方式で、モック transport 上の SCTP を `ESTABLISHED` にし、`lastReceivedTsn` を設定してから行う。
  1. 複数フラグメントの ordered メッセージのうち、最後の 1 フラグメントだけ欠けた状態で DATA を注入する。
  2. その欠けた TSN を `lastTsn` に持つ Outgoing SSN Reset Request を注入する。
  3. Assert: 応答が `In progress (6)`、`onReconfigStreams` は未発火、メッセージは未配信。
  4. 欠けていたフラグメントを注入する。
  5. Assert: 完全なメッセージが `onReceive` に届き、**そのあとで** `onReconfigStreams` が発火する。
* 追加で検証するケース
  * 1 つの request に複数 stream が含まれる場合
  * TSN wrap（`lastTsn` が `0xffffffff` 付近をまたぐ）
  * FORWARD-TSN で境界を越えたときに reset が実行されること（PR-SCTP / partial reliability）
  * 重複 request（同じ seq の再送）で状態が二重に変わらず、同じ result が返ること。保留中の再送は `In progress` のまま、実行後の再送は `SuccessPerformed`
  * `lastTsn` 以下の DATA がすでに全部届いている場合は、従来どおりすぐに実行されること（非回帰）
  * 保留中に届いた、対象 stream 宛てで `lastTsn` より大きい DATA が reset 後の stream（SSN=0）として扱われること
  * 不正な seq に `BadSequenceNumber` が返ること
* **統合寄りのテスト**（任意、推奨）。`createConnectedSctpPair({ dropClient: dropDataPacketsAt([...]) })` で 64 KiB 程度のメッセージの最後のフラグメントを落とし、送信直後に `reconfigQueue.push(streamId)` と `transmitReconfigRequest()` を呼ぶ。T3 再送のあとにメッセージが完全に届き、そのあとで両方向の reset が完了すること、association が閉じないことを確認する。
* 共有の Arrange（reset request パケットを組み立てて注入する、ESTABLISHED のモック SCTP を作る、など）は `packages/sctp/tests/utils.ts` にまとめる。Act / Assert には日本語でコメントを付ける（ルート `AGENTS.md` の Do 6）。

## 3. 技術的な実装アプローチ（調査結果のまとめ）

### RFC 6525 の要点

* §5.2.2: Sender's Last Assigned TSN が cumulative acknowledgment point より大きければ、"deferred reset processing" に入らなければならない（MUST）。その間、対象 stream 宛てで `lastTsn` より大きい TSN の DATA は、cumulative point が `lastTsn` に届くまでキューに保持しなければならない（MUST）。届いた時点で reset を実行する（MUST）。deferred に入ったら `In progress` を返す（MUST）。
* §5.2.1: Request Sequence Number は「期待値なら処理」「直前に処理したもの（重複）なら前回の応答を再送」「それ以外は `Error - Bad Sequence Number`」。
* §4.4: result の値は 0 = Success-Nothing to do、1 = Success-Performed、2 = Denied、3 = Error-Wrong SSN、4 = Error-Request already in progress、5 = Error-Bad Sequence Number、6 = In progress。

### 参考実装（dcsctp, Chrome の SCTP）

`StreamResetHandler::HandleResetOutgoing` は、`sender_last_assigned_tsn` が cumulative ack TSN より新しければ `ReassemblyQueue` に deferred reset を登録して `kInProgress` を返す。このとき `last_processed_req_seq_nbr_` は更新しない（再送された request をもう一度評価するため）。DATA を受け取るたびに `MaybeResetStreamsDeferred(cum_ack_tsn)` で reset を実行し、その後の request 再送には `kSuccessPerformed` を返す。werift でもこの構成が素直に実装できる。

### werift での実装方針案

```ts
// sctp.ts（イメージ）
private deferredReset?: {
  request: OutgoingSSNResetRequestParam;
  heldChunks: DataChunk[]; // 対象 stream 宛てで tsn > lastTsn の DATA
};
private lastReconfigResult?: ReconfigResult; // 重複 request に再送する値
```

* `receiveReconfigParam` の `OutgoingSSNResetRequestParam` 分岐を「seq 検証 → 境界判定 → 即時実行 / 保留」に書き換える。実行処理は `performIncomingStreamReset(request)` のような private メソッドに切り出し、即時実行と保留解除の両方から呼ぶ。
* `receiveDataChunk` では、`markReceived` で新規と判定した直後、`getInboundStream` に入れる前に、保留中かつ対象 stream かつ `uint32Gt(chunk.tsn, lastTsn)` なら `heldChunks` に退避する。
* `handleData` のチャンクループ（`sctp.ts:285-287`）を抜けたあと、または `receiveDataChunk` / `receiveForwardTsnChunk` の末尾で、`maybePerformDeferredReset()` を呼ぶ。`receiveDataChunk` は同期メソッド、reset 実行は `sendReconfigParam` などを await する非同期処理なので、**呼び出し位置と await の順序に注意する**。`handleData` の SACK 送信より前に置くか後に置くかも決める。
* TSN の比較はすべて `uint32Gt` / `uint32Gte`（`packages/sctp/src/imports/common` 経由の `packages/common/src/number.ts`）を使い、生の `<` / `>` は使わない。
* inbound stream を削除するときは、残っている `reassembly` の `userData.length` を `advertisedRwnd` に戻す（現状は戻していない）。

## 4. 制約・注意点

* **配信順序の保証**: 境界までのメッセージを全部 `onReceive` に渡してから `onReconfigStreams` を発火する。webrtc 層は `onReconfigStreams` で DataChannel を `closed` にして `dataChannels` から削除するので、順序が逆だと `datachannelReceive` 側でメッセージが捨てられる。
* **ordered / unordered の違い**: ordered で SSN の歯抜けが残っても、cumulative TSN が `lastTsn` に届けば reset を実行する（未完成のメッセージは破棄する）。unordered のチャンクも同じ境界判定で扱う。
* **FORWARD-TSN**: PR-SCTP で境界を飛び越えたときも保留を解消する。そうしないと、reset が来ない、または DataChannel が閉じないまま残る。
* **重複・再送 request の冪等性**: 現状 seq を見ていないため、同じ request の再送で `onReconfigStreams` が 2 回発火したり、逆方向の reset が二重に積まれたりしうる。seq 検証を入れて解消する。`reconfigResponseSeq` は自分が送る request の `responseSequence` フィールドにも使われているので（`sctp.ts:1069-1074`）、更新するタイミングを変えるときは影響を確認する。
* **保留は 1 つだけを想定**: 相手は応答が `Performed` になるまで次の request を出さない前提（seq が単調に増えるため）。保留中に別の seq が届いたら、seq 検証の規則（`BadSequenceNumber`）か `Error - Request already in progress` で応答する。どちらにするかは実装時に決め、テストで固定する。
* **public API の互換性**: `reconfigResult` の既存キー、`onReconfigStreams` のシグネチャ、`reconfigQueue` / `transmitReconfigRequest()`（webrtc 層が直接使っている）は変えない。値を追加するだけなら破壊的変更にはならない。
* **送信側の挙動との相互作用**: werift 同士では、修正後に相手が `In progress` を返すようになる。2.3 を入れないと、受信側の保留が長い（T3 再送待ちで RTO 初期値 3 秒、バックオフあり）ときに、`timerReconfigFailures` の上限で association が `CLOSED` になるおそれがある。2.3 は同じ変更に含めるのが望ましい。
* **Reconfig timer が共有の `this.rto` を変更している**（`sctp.ts:1245`）のは既存の問題。このチケットの範囲外だが、`In progress` 再送の扱いを変えるときに影響が出ないか確認する。
* 修正は `packages/sctp` の中で完結させる（root cause は SCTP 層にある）。webrtc 層に回避策を入れない（ルート `AGENTS.md` の Do 2、`packages/webrtc/AGENTS.md`）。
* `packages/sctp` 用の `AGENTS.md` はないので、ルート `AGENTS.md` の規約（AAA、共有ユーティリティ、日本語コメント）に従う。
* public な挙動が変わるので（RFC 準拠の deferred reset、`reconfigResult` の追加）、`changelog.md` の 🐛 Bug Fixes に追記する。必要なら `npm run doc` で生成ドキュメントを更新する。

## 5. 完了条件

- [ ] `OutgoingSSNResetRequestParam.lastTsn` までの DATA が届いていないと、reset が保留され、`In progress (6)` が返る。
- [ ] 保留中も、対象 stream で `lastTsn` 以下の DATA（再送を含む）が再組立て・配信される。
- [ ] cumulative TSN が DATA または FORWARD-TSN で `lastTsn` に届いた時点で、inbound stream の reset、逆方向の reset の送出、`onReconfigStreams` が実行され、境界までのメッセージは必ずその前に配信される。
- [ ] 保留中に届いた、対象 stream 宛てで `lastTsn` より大きい DATA は、reset 後の stream として扱われる。
- [ ] request seq の検証が入っている。重複 request は状態を変えずに同じ result を返し、不正な seq には `BadSequenceNumber` を返す。
- [ ] TSN wrap を `uint32Gt` / `uint32Gte` で正しく扱う。
- [ ] 自分が送った request に `In progress` が返っても、失敗扱いで association が閉じない（2.3）。
- [ ] 2.4 の回帰テスト（欠けたフラグメントより reset が先に届くケース、複数 stream、TSN wrap、FORWARD-TSN、重複 request、即時実行の非回帰）を AAA 形式・日本語コメントで追加し、通る。
- [ ] `cd packages/sctp && npm test` が通る。
- [ ] SCTP の挙動変更が webrtc の DataChannel close に波及するため、`npm run type` と `npm run test:small` が通る（`packages/webrtc/tests/datachannel/close.test.ts` を含む）。可能なら `npm run e2e` で Chrome との DataChannel close の相互接続も確認する。
- [ ] `npm run format` を実行済みで、`changelog.md` に追記してある。
