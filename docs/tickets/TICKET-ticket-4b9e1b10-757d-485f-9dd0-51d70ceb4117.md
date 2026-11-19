# SCTP/DataChannelの送信待ち量・バックプレッシャーを安定した公開APIで扱えるようにする

## 1. 目的と背景

### 背景
- werift 0.26 で `SCTP.outboundQueue` / `SCTP.sentQueue` / `RTCSctpTransport.dataChannelQueue` が `Array` から `FifoQueue` に変わった（#730 の二乗時間問題への対策。`changelog.md` の Breaking changes に記載済み）。
- 下流の react-x11-components PR #1399 (`src/html/werift-transports.ts`) はこの変更で壊れ、型を `Iterable + push` に緩めて追従した。下流が非公開の内部に依存している箇所は次の 2 つ。

| 下流の処理 | 触っている内部 | 本当に必要なもの |
| --- | --- | --- |
| `_unacknowledged()`: channel を閉じる前に、送ったデータが ACK されるまで待つ | `channel.bufferedAmount` に加えて `sctp.outboundQueue` / `sctp.sentQueue` を走査し、`chunk.streamId === ch.id` を探す | 「この channel で送ったものがピアに届いた（close しても失われない）」と分かる公開の手段 |
| `_sendEmpty()`: 空メッセージを送る | `dataChannelQueue.push([ch, 56/57, [0]])`、`dataChannelFlush()`、`addBufferedAmount(1)` | `channel.send("")` / `send(Buffer.alloc(0))` が RFC 8831 §6.6 どおりに送れること |

### 目的
- 下流が非公開キューや非公開メソッドに触らずに、フロー制御・ドレイン待ち・graceful close・空メッセージ送信をできるようにする。
- `bufferedAmount` 系の意味論を W3C WebRTC（RTCDataChannel）と WPT `RTCDataChannel-bufferedAmount.html` に合わせ、公開契約として文書化する。
- 内部キューの実装（Array / FifoQueue）を公開契約から外す。
- #730（キューの計算量・イベントループ飢餓）は解決済みで CLOSED。本チケットは API と意味論だけを扱い、性能は扱わない。

## 2. 現状の棚卸し（調査結果）

### 2.1 既存の公開 API（`packages/webrtc/src/dataChannel.ts`）

| API | 現状 | W3C との差 |
| --- | --- | --- |
| `bufferedAmount` | public で**書き込み可能**なフィールド（`bufferedAmount = 0`） | W3C では readonly。外部から書けてしまう |
| `bufferedAmountLowThreshold` | getter / setter あり。0〜2^32-1 の範囲外は `Error` を投げる | おおむね一致（W3C は unsigned long なので範囲外は WebIDL の型変換になる。厳密な挙動は WPT wrapper 側で扱う） |
| `bufferedAmountLow` (`Event`) と `emit("bufferedamountlow")` | 閾値を上から跨いだとき（`> th` から `<= th` へ）に 1 回だけ発火 | 一致。ただし **`onbufferedamountlow` プロパティが無い** |
| `addBufferedAmount(amount)` | **public**。下流が実際に呼んでいる | 内部用であるべき。`@internal` になっていない |
| `send("")` / `send(Buffer.alloc(0))` | `SCTP.send` で `fragments = 0` になり chunk が 1 つも作られず、**黙って破棄される** | RFC 8831 §6.6 と W3C に反する（PPID 56/57 と 1 バイトの 0x00 で送るべき）。受信側は 56/57 に対応済み |
| `onclosing` / `"closing"` イベント | `setReadyState("closing")` は `onclosing()` を呼ぶが `emit("closing")` しない | WPT close テストの addEventListener 版が通らない（本チケットでは優先度低） |
| `RTCSctpTransport` | `bufferedAmount` 相当は無い（W3C にも無い）。`maxMessageSize` はある。`maxChannels` は無い | 送信待ち量は channel 単位の API で足りる。transport 単位の集計は必須ではない |

### 2.2 `bufferedAmount` が減るタイミング（`packages/webrtc/src/transport/sctp.ts`）
- `datachannelSend()` で `+size`（UTF-8 のバイト長）を足す。
- `dataChannelFlush()` が `sctp.send()` に渡し、その Promise が解決したら `-userData.length` を引く。
- `SCTP.send()` が解決するのは、その送信の**最後の chunk が outboundQueue から sentQueue に移ったとき**（ネットワークに渡したとき。`resolveSendWaiters`）。ACK を待つわけではない。これは W3C の「まだネットワークに渡していないバイト数」という定義と一致している。
- PR-SCTP で期限切れになったメッセージは outboundQueue にあるうちに abandon され、`resolveSendWaiterOutOfOrder` で即座に減算される。
- `RTCSctpTransport.stop()` → `discardUnsentMessages()` は、まだ SCTP に渡していないメッセージの分を**減算する**。
- `SCTP.setState(CLOSED)` → `releaseSendWaiters()` は待ち中の `send()` を全部解決するので、**close 後に bufferedAmount が 0 に落ち、`bufferedamountlow` も発火しうる**。
- 未接続の状態での `dataChannelClose()` は `dataChannelQueue.filter()` でキューから除くが、**減算しない**（上の 2 経路と扱いが揃っていない）。

> W3C / WPT の期待: 「`bufferedAmount` は channel が閉じても 0 に戻らない」（`bufferedAmount should not decrease immediately after initiating closure` / `...after closing the peer connection`）。現状の stop / CLOSED 経路はこれに反する。

### 2.3 close と未 ACK データ
- `dataChannelClose()` は `reconfigQueue` に stream を積み、`transmitReconfigRequest()` が Outgoing SSN Reset Request（`senderLastTsn = localTsn - 1`）を送る。
- ピアは RFC 6525 §5.2.2 に従い、`senderLastTsn` までのデータを受け取るまで reset を保留する（werift の受信側も `deferredReset` で実装済み）。
- 送信側の channel が `closed` になるのは Success - Performed を受けたとき（`completeOutgoingReset` → `onReconfigStreams`）。
- したがって**信頼チャネルでは「送信側の `close` イベント = close() 前に送ったデータがピアに届いた」が成り立つはず**。下流の `_unacknowledged()` は、この保証を werift が公開契約として示していないことによる回避策と考えられる。この保証は回帰テストで裏付ける必要がある。
- 部分信頼チャネルでは abandon されたデータは届かなくてよい（FORWARD-TSN で飛ばされる）。

### 2.4 既存のテストと WPT
- `packages/webrtc/tests/datachannel/{send,burst,close}.test.ts`、`tests/transport/sctp.test.ts`（stop で bufferedAmount を解放するテストがあり、上記の意味論を変えるならこのテストも更新が必要）。
- 共通の Arrange は `packages/webrtc/tests/utils.ts` にある（`createDataChannelPair`, `awaitMessage`, `waitUntil`, `createIndexedMessages`, `collectChannelMessages`）。
- WPT: `third_party/wpt/webrtc/RTCDataChannel-bufferedAmount.html` は `packages/webrtc/wpt/allowlist.json` に**入っていない**。`RTCDataChannel-send.html` は disabled、`RTCDataChannel-close.html` は一部の subtest だけ baseline に入っている。

## 3. 実装内容

方針: 標準 API（`bufferedAmount` / `bufferedAmountLowThreshold` / `bufferedamountlow` / `close` イベント）で下流の 2 つの用途を賄えるようにする。werift 独自の公開 API は、それで足りないと分かった場合にだけ追加する。

### 3.1 空メッセージ送信の修正（root cause）
- `RTCSctpTransport.datachannelSend()` / `dataChannelFlush()` で、長さ 0 の string は `WEBRTC_STRING_EMPTY`(56)、長さ 0 の Buffer は `WEBRTC_BINARY_EMPTY`(57) にし、ペイロードを `Buffer.from([0])` にして送る。
- `bufferedAmount` は増やさない（増減とも 0。WPT `should stay at zero for empty string/buffer sent`）。減算は「送ったペイロード長」ではなく「足した量」で行う。キューの要素に加算量を持たせるのが簡単。
- `messagesSent` は +1、`bytesSent` は +0。受信側の `bytesReceived` は今 `data.length`（1）を足しているので、56/57 のときは 0 にする。
- `SCTP.send()` が長さ 0 の `userData` を受けたとき、chunk を作らず Promise が即解決する現状の挙動は、SCTP 単体 API として明文化するか、assert にする（上位で 1 バイト化するので通常は来ない）。

### 3.2 `bufferedAmount` 系の公開契約を整える
- `bufferedAmount` を getter だけ（readonly）にし、内部の値は private フィールドに移す。代入していた箇所は内部メソッド経由にする。
- `addBufferedAmount()` は TSDoc で `@internal` にする。削除や改名は下流を壊すので changelog で予告し、次の minor で非公開化する（同じ変更内で消すかどうかはレビューで決める）。
- `onbufferedamountlow?: Callback` を追加し、`bufferedAmountLow.execute()` / `emit("bufferedamountlow")` と同時に呼ぶ（`onopen` などと同じパターン）。
- close / stop 時の扱いを W3C に揃える。
  - channel が `closing` / `closed` になった後、送られないまま捨てられた分（`discardUnsentMessages`、未接続時の `dataChannelClose` の filter、`releaseSendWaiters` 由来の解決）は**減算しない**。closed になった後は `bufferedamountlow` を発火させない。
  - 一方、`closing` の間に実際にネットワークへ渡った分（reset 前に送られたデータ）は減算してよい（WPT は「close 直後に減らない」ことだけを見ている）。
  - 減算するかどうかを区別するため、`SCTP.send()` が「送った / abandon された / 停止で捨てられた」を区別して返すようにする（例: `Promise<"sent" | "abandoned" | "discarded">`。`werift-sctp` 内の変更）。abandon（PR-SCTP の期限切れ）は W3C 上「送信を試みた」扱いで減算する。
  - これは挙動の変更（`tests/transport/sctp.test.ts` の "stop discards unsent messages and releases bufferedAmount" の期待が反転する）。changelog に載せる。convenience を残す理由がないか、`git log -S discardUnsentMessages` で導入意図を確認してから決める。
- `bufferedAmountLowThreshold` の範囲チェックは現状のままにし、WebIDL の厳密な変換が必要なら `tools/wpt-runner/*` の wrapper 側で行う（AGENTS Do 5）。

### 3.3 graceful close（ドレイン待ち）の契約を明文化する
- `RTCDataChannel.close()` の TSDoc と README に、次の契約を書く。
  - `close()` を呼ぶ前に `send()` したメッセージは、信頼チャネルなら送信側で `close` が発火する前にピアへ届けられる（RFC 6525 の Sender's Last Assigned TSN による）。部分信頼チャネルでは abandon されたものは届かない。
  - 送信バッファの空き待ちには `bufferedAmount` / `bufferedAmountLowThreshold` / `bufferedamountlow` を使う。
  - 「ACK まで待つ」は `close()` を呼んでから `close` イベントを待つことで実現する。`RTCPeerConnection.close()` は ABORT なので未達データは失われる。データを確実に届けたいなら、各 channel の `close` を待ってから `pc.close()` する。
- 回帰テスト（3.5）でこの保証が成り立たないと分かったら、先に SCTP 側（reset 要求のタイミング、`senderLastTsn`、`dataChannelQueue` にまだ残っているデータの扱い）を直す。
- 標準 API で用途が満たせない場合（例: close せずに「ここまで ACK された」を知りたい）に限り、werift 独自 API の追加を検討する。案は `RTCDataChannel` の非標準 getter `unacknowledgedAmount`（ACK されていないバイト数。SCTP が stream ごとのカウンタを持ち、sentQueue の走査は不要）。下流の要件を確認してから決め、入れるなら TSDoc に「非標準」と明記する。

### 3.4 内部キューを公開契約から隠す
- `SCTP.outboundQueue`（現在 `readonly` で public）と `RTCSctpTransport.dataChannelQueue` / `dataChannelFlush`（private だが `["..."]` やキャストで触られている）に TSDoc `@internal` を付け、「型と構造は予告なく変わる」と書く。
- `SCTP.outboundQueue` を private にするのは breaking なので、changelog に移行先（3.2 / 3.3 の公開 API）を書いてから行う。`packages/sctp/tests/burst.test.ts` は `outboundQueue.length` を読んでいるので、テスト用の accessor（`tests/utils.ts` の `sentQueueOf` と同じ形）に寄せる。
- `FifoQueue` の re-export（`werift-sctp` の index）は他でも使われるので残す。

### 3.5 回帰テスト（Arrange / Act / Assert、Act と Assert には日本語コメント）
共通の Arrange（channel pair の生成、cwnd/rwnd で送信を詰まらせる、パケットロスを入れる、閾値を設定する）は、`packages/webrtc/tests/utils.ts`、または DataChannel 用の共通ファイル 1 つ（例: `tests/datachannel/utils.ts`）にまとめる。

| ケース | 確認すること |
| --- | --- |
| 閾値を跨ぐ | 複数回 `send()` → 閾値を上から跨いだときに `bufferedamountlow` / `onbufferedamountlow` / `bufferedAmountLow` が 1 回ずつ発火する。閾値ちょうどの値、閾値 0、閾値を後から変えた場合、各メッセージ送信後に発火すること（WPT の 3 ケースに相当） |
| 空メッセージ | `send("")` / `send(Buffer.alloc(0))` がピアで `""` / 空 Buffer として届く。`bufferedAmount` は 0 のまま。stats が正しい |
| 送信中の close（信頼） | 大量に `send()` → すぐ `close()` → 送信側の `close` までに全メッセージが順番どおり届く。`close()` 直後に `bufferedAmount` が減っていない |
| 送信中の pc.close / transport stop | 閉じた後に `bufferedAmount` が減らず、`bufferedamountlow` も発火しない（新しい意味論） |
| 再送 | ロスを入れても全メッセージが届き、`bufferedAmount` が 0 に戻る。ACK 前（sentQueue にある間）にすでに減っている（= W3C の「ネットワークに渡したら減る」） |
| 部分信頼 | `maxRetransmits` / `maxPacketLifeTime` で abandon されたメッセージも `bufferedAmount` から減り、閾値を跨げば通知される。close 後の扱いは信頼チャネルと同じ |
| 内部に依存しない | 上のテストは、内部キューを触らずに公開 API だけで書けること自体を確認する（下流の用途を公開 API だけで再現する） |

- SCTP 単体のテスト（`packages/sctp/tests`）では、`send()` が返す結果の区別（sent / abandoned / discarded）を確認する。
- WPT: `RTCDataChannel-bufferedAmount.html` を `wpt/allowlist.json` に追加し、毎回通る subtest を baseline に入れる（10 回のフルランで安定を確かめてから）。`RTCDataChannel-close.html` の bufferedAmount 関連 subtest も確認する。

### 3.6 ドキュメント
- `packages/webrtc/README.md`（または DataChannel の節）に、バックプレッシャーの使い方の例（high/low water mark と `bufferedamountlow`）、graceful close の手順、空メッセージを書く。
- 公開 API の TSDoc（`bufferedAmount`, `bufferedAmountLowThreshold`, `onbufferedamountlow`, `close()`, `send()`）。
- `changelog.md`: 空メッセージ送信の修正、`bufferedAmount` の readonly 化、close / stop 時の意味論の変更、`addBufferedAmount` / `outboundQueue` の `@internal` 化と非公開化の予告。
- 最後に `npm run doc` で `doc/` を作り直す。

## 4. 制約と注意点
- **W3C / WPT との整合**: 厳密な WebIDL 例外などは `tools/wpt-runner/*` に置き、`src` の便利な挙動（例: `connecting` 中の `send()` をキューに積む）は残す。ただし bufferedAmount の意味論は下流がフロー制御に使う契約なので、`src` 側で W3C に合わせる。
- **後方互換**: `bufferedAmount` の readonly 化、close 時の減算をやめること、`outboundQueue` の非公開化は、いずれも下流（react-x11-components）に影響する。changelog で移行先を示し、内部 API を本当に消すのは一段階遅らせることを検討する。
- **#730 と分ける**: キューの計算量・イベントループ飢餓・ベンチマーク（`packages/sctp/tests/bench`, `burst-benchmark.mjs`）は扱わない。新しく足す per-stream カウンタなど（3.3 の任意案）は O(1) で更新し、sentQueue を走査しない。
- **SCTP の不変条件を守る**: `flightSize` の不変条件（`assertFlightSizeInvariant` 系）、TSN の順序、FORWARD-TSN、`sendWaiters` を先頭から解決することを壊さない。`SCTP.send()` の戻り値の型を変えるなら、werift-sctp を直接使う利用者向けに changelog に書く。
- **erasable syntax**: `enum` やパラメータプロパティは使わない（戻り値の種別は `as const` オブジェクトと union 型で書く）。
- **ホスト依存のテスト失敗**: この環境で HEAD でも落ちる既知のテスト（tcp active-only、setConfiguration、modern_sdp）とは区別して報告する。
- 比較は一時 worktree で行う（`git worktree add --detach`）。アクティブな worktree の checkout / stash はしない。

## 5. 完了条件
- [ ] 下流の 2 つの用途（ドレイン / ACK 待ちのあとの close、空メッセージ送信）を、`outboundQueue` / `sentQueue` / `dataChannelQueue` / `dataChannelFlush` / `addBufferedAmount` に触らず、公開 API（標準 API。不足が確認された場合だけ非標準 API）で実現でき、その方法が README / TSDoc に書かれている。
- [ ] `send("")` / `send(Buffer.alloc(0))` が PPID 56/57 で相互運用でき、`bufferedAmount` が 0 のままである。
- [ ] `bufferedAmount` が readonly で、閾値跨ぎ・close・stop・再送・部分信頼での増減と通知が 3.5 のテストで固定されている。
- [ ] 信頼チャネルで「`close()` 前に送ったデータは送信側の `close` までに届く」ことがテストで保証されている（成り立たなければ SCTP 側を修正済み）。
- [ ] 内部キューが `@internal` と明記され、changelog に移行先と非公開化の予定が書かれている。
- [ ] WPT `RTCDataChannel-bufferedAmount.html` が allowlist に入り、安定して通る subtest が baseline に入っている。
- [ ] #730（性能）とは別のものとして changelog と本チケットに書いてある。
- [ ] 検証: `cd packages/sctp && npm test`、`cd packages/webrtc && npm test && npm run type`、`npm run type`、`npm run test:small`、`npm run wpt`（allowlist / baseline を変える場合は `npm run wpt:coverage` も）、`npm run format`、`npm run doc`。
