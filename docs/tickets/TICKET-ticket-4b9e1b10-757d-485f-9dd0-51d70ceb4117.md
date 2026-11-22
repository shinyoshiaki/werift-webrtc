# SCTP/DataChannelの送信待ち量・バックプレッシャーを安定した公開APIで扱えるようにする

## 進捗状況（2026-11-22 実装、`0a03984d9` 起点）

- 6ab13832（#870）は develop にマージ済みで、その実装（遅れた `DATA_CHANNEL_ACK` を無視、`ondatachannel` の isolate）を前提にした。
- 4.1〜4.6 を実装した。`SctpSendResult`、`bufferedAmount` の readonly 化と close / stop 後に減算しない意味論、`onbufferedamountlow`、空メッセージ（PPID 56/57）、確立前 close の保持と flush 後の reset、DCEP ACK を `ondatachannel` より先に積む、`closing` イベント、deprecations、README / changelog。
- 4.2 を W3C に合わせた結果、`closing` イベントは相手が stream を reset したときだけ発火し、自分で `close()` した側では発火しない（WPT `RTCDataChannel-close.html` の closing 系 4 subtest が通る。changelog の Breaking changes に記載）。
- DCEP OPEN 未送信の in-band channel を close した場合は、4.2 で許容しているとおり、今と同じくすぐ `closed` になり何も送らない（README / TSDoc に記載）。
- WPT: `RTCDataChannel-bufferedAmount.html` を allowlist に入れた。10 回の実行で毎回 PASS の 24 subtest（Blob 送信の 6 subtest 以外）と、`RTCDataChannel-close.html` の closing 系 4 subtest を baseline に入れた。runner の sandbox に `Blob` を足し、両ファイルを long timeout profile にした。
- **#730（キューの計算量・イベントループ飢餓）とは別の変更**であり、性能やベンチマークは変えていない。changelog にもそう書いた。
- v0.30.0 の作業（`outboundQueue` の private 化、`addBufferedAmount` の削除、3 要素タプル互換の削除）はフォローアップチケット `020426ac-4feb-492c-bd1e-df3d7301c1a6` に起票した。

## 進捗状況（2026-11-19 調査、develop `e069c5c84` 時点）

- **ごく一部だけレビュー中ブランチで修正済み。** レビュー中の `ticket/6ab13832-5312-4d88-b409-66fc84ada0b9`（#815）では、未知の stream に遅れて届いた `DATA_CHANNEL_ACK` を throw せず、ログを出して無視するようになった（`packages/webrtc/src/transport/sctp.ts`）。develop はまだ "channel not found" を throw する。同じブランチで `ondatachannel` handler も `executeIsolated` 経由で呼ばれるようになった。
- **未着手の部分（develop と全レビューブランチ共通）:**
  - `bufferedAmount` がまだ書き込める field のまま（`dataChannel.ts`）。
  - `onbufferedamountlow` と `SctpSendResult` がない。
  - `send("")` が何も送らない（空メッセージを PPID 56/57 にしていない）。
  - association が確立していないときの `dataChannelClose` で、待ち行列のメッセージが捨てられる。
  - DCEP ACK を `onDataChannel` の後でキューに積んでいる。
  - `outboundQueue` / `addBufferedAmount` の deprecate と、`emit("closing")` の修正。
- 6ab13832 が develop にマージされたら、その実装を前提に進める。

---

## 1. 目的と背景

### 背景
- werift 0.26 で `SCTP.outboundQueue` / `SCTP.sentQueue` / `RTCSctpTransport.dataChannelQueue` が `Array` から `FifoQueue` に変わった（#730 の二乗時間問題への対策。`changelog.md` の v0.26.0 Breaking changes に記載済み）。
- 下流の react-x11-components PR #1399 (`src/html/werift-transports.ts`) はこの変更で壊れ、型を `Iterable + push` に緩めて追従した。
- その後、下流は werift 0.27.0 に上げた（commit `5c2141d4`, #1502）。0.27.0 で受信側の RFC 6525 §5.2.2 deferred reset が入ったため、`outboundQueue` / `sentQueue` の走査（ACK 待ち）を**やめた**。
- 下流の現行コード（2026-11-14 時点の main）がまだ werift の内部に触っている箇所は次のとおり。

| 下流の処理 | 触っている内部 | 回避している werift の不備 |
| --- | --- | --- |
| `_unsent()` + `close()`: 未送信分が SCTP に渡るまで `ch.close()` を遅らせる | `ch.bufferedAmount`、private の `dataChannelQueue` を走査、`sctp.flush` イベント、`bufferedAmountLowThreshold = 0` を上書き | ① `connecting` 中の `close()` が `dataChannelQueue` の未送信メッセージを捨てる。② `ondatachannel` の中で close すると、DCEP ACK より先に stream が reset され、相手側で `DATA_CHANNEL_ACK` の "channel not found" が throw される |
| `_sendEmpty()`: 空メッセージを送る | `dataChannelQueue.push([ch, 56/57, [0]])`、`dataChannelFlush()`、`addBufferedAmount(1)`、`messagesSent += 1` | ③ `send("")` / `send(Buffer.alloc(0))` が送られない（RFC 8831 §6.6 違反） |

### 目的
- ①〜③を werift 側で直し、下流が `ch.close()` と `ch.send("")` をそのまま呼ぶだけで済むようにする（内部への依存をゼロにする）。
- `bufferedAmount` 系の意味論を W3C WebRTC（RTCDataChannel）と WPT `RTCDataChannel-bufferedAmount.html` に合わせ、公開契約として文書化する。
- 内部キューの実装（Array / FifoQueue）を公開契約から外す。
- #730（キューの計算量・イベントループ飢餓）は解決済みで CLOSED。本チケットは API と意味論だけを扱い、性能は扱わない。

## 2. 決定事項（未確定事項の解消）

### 2.1 非標準 API `unacknowledgedAmount` は今回入れない
- **根拠 1: 下流はもう ACK 量を必要としていない。** ACK 待ち（`sentQueue` の走査）は 0.27.0 対応の `5c2141d4` で削除済み。下流のコメントにも、SCTP に渡ったものは reset の Sender's Last Assigned TSN より前の番号を持ち、相手は 0.27.0 以降それを全部受け取るまで reset を保留する、とある。下流が今待っているのは「未送信（SCTP に渡す前）」だけで、これは標準の `bufferedAmount` で表せる。
- **根拠 2: close できない場面で ACK 量が要るという要件は、下流のコードにも Issue にも無い。** W3C にも相当する API は無い。
- **根拠 3: 「close 前に送ったものは届く」は標準の close で保証できる。** W3C の closing procedure の最初の手順は「pending のメッセージをすべて送り終える」である。それができていないのは werift の不備①②なので、新しい API ではなくそちらを直す（3.3）。
- **やること:** close の契約を TSDoc / README に書き、回帰テストで固定する。将来「close せずに ACK 済み量を知りたい」という具体的な要件が出たら、別チケットで検討する（設計メモとして 3.3 の末尾に残す）。

### 2.2 破壊的変更の扱い（次のリリース v0.29.0 に入れるもの / 予告にとどめるもの）
現在のバージョンは v0.28.0（リリース済み）。0.x の minor は破壊的変更を許してきた（v0.26〜v0.28 に Breaking changes の節がある）。ただし、下流が今も使っている内部は「下流が移行できる版」を 1 つ挟んでから消す。

| 項目 | 決定 | 理由 |
| --- | --- | --- |
| `bufferedAmount` の readonly 化 | **v0.29.0 で実施**（getter だけにする。Breaking changes に記載） | 外から書くと内部の加減算が壊れ、閾値通知も狂う。下流は読むだけで、書く利用者は想定しにくい。getter だけにすると strict mode での代入は TypeError になるので、changelog に明記する |
| close / stop 後に減算しない意味論 | **v0.29.0 で実施**（Breaking changes に記載） | W3C / WPT の期待（`should not decrease after closing the peer connection`）と一致する。下流の `_unsent()` が close / stop 後の 0 落ちに頼っていたのは①の回避のためで、①を直せば不要になる。また、送っていないものが 0 に落ちると「送れた」と誤解させるので、フロー制御の契約として危険 |
| `SCTP.send()` の戻り値 | **v0.29.0 で実施。破壊的変更として扱わない**（`Promise<void>` を `Promise<SctpSendResult>` に広げる。Features に記載） | 戻り値を広げるだけなので、`await` するだけの呼び出し側は影響を受けない。`sctp.send` を `() => Promise<void>` の関数で差し替えているコードだけが型エラーになりうるので、そのことを一文書く |
| `SCTP.outboundQueue` の private 化 | **v0.29.0 では `@deprecated` と `@internal` にとどめ、private 化は v0.30.0** | 下流はもう使っていない（`5c2141d4` で削除）。ただし v0.26.0 の changelog で「readonly の公開フィールド」と移行手順まで案内したばかりなので、すぐ消すと werift-sctp を直接使う利用者が混乱する。予告を 1 版挟む |
| `addBufferedAmount` の削除 | **v0.29.0 では `@deprecated` と `@internal` にとどめ、挙動も変えない。削除は v0.30.0** | 下流の現行 `_sendEmpty()` が呼んでいる。③を直した v0.29.0 で下流は `send("")` に移れるので、移行できる版を 1 つ挟んでから消す |

- `RTCSctpTransport.dataChannelQueue` / `dataChannelFlush` はもともと private なので、互換性の約束はしない。ただし v0.29.0 では、下流の現行 `_sendEmpty()`（3 要素のタプルを push して `dataChannelFlush()` を呼ぶ）が動き続けるようにする（タプルに要素を足すなら省略可能にし、無いときは今の挙動にする）。v0.30.0 では考慮しない。
- v0.30.0 で行う作業（`outboundQueue` の private 化、`addBufferedAmount` の削除）は、このチケットの完了条件に含めない。changelog の予告と、フォローアップチケットの起票までを完了条件とする。

## 3. 現状の棚卸し（調査結果）

### 3.1 既存の公開 API（`packages/webrtc/src/dataChannel.ts`）

| API | 現状 | W3C との差 |
| --- | --- | --- |
| `bufferedAmount` | public で**書き込み可能**なフィールド（`bufferedAmount = 0`） | W3C では readonly |
| `bufferedAmountLowThreshold` | getter / setter あり。0〜2^32-1 の範囲外は `Error` を投げる | おおむね一致（WebIDL の厳密な型変換は WPT wrapper 側で扱う） |
| `bufferedAmountLow` (`Event`) と `emit("bufferedamountlow")` | 閾値を上から跨いだとき（`> th` から `<= th` へ）に 1 回だけ発火 | 一致。ただし **`onbufferedamountlow` プロパティが無い** |
| `addBufferedAmount(amount)` | **public**。下流が呼んでいる | 内部用であるべき |
| `send("")` / `send(Buffer.alloc(0))` | `SCTP.send` で `fragments = 0` になり chunk が作られず、**黙って破棄される**（③） | RFC 8831 §6.6 違反。受信側は PPID 56/57 に対応済み。ただし受信側の `bytesReceived` は 1 を足している |
| `onclosing` / `"closing"` イベント | `setReadyState("closing")` は `onclosing()` を呼ぶが `emit("closing")` しない | WPT close テストの addEventListener 版が通らない（本チケットのついでに直す） |
| `RTCSctpTransport` | `bufferedAmount` 相当は無い（W3C にも無い） | channel 単位の API で足りる |

### 3.2 `bufferedAmount` が減るタイミング（`packages/webrtc/src/transport/sctp.ts`）
- `datachannelSend()` で `+size`（UTF-8 のバイト長）を足す。`dataChannelFlush()` が `sctp.send()` に渡し、その Promise が解決したら `-userData.length` を引く。
- `SCTP.send()` が解決するのは、その送信の**最後の chunk が outboundQueue から sentQueue に移ったとき**（ネットワークに渡したとき）。ACK は待たない。W3C の定義と一致している。
- PR-SCTP で期限切れになったものは outboundQueue にあるうちに abandon され、すぐ減算される。
- `RTCSctpTransport.stop()` → `discardUnsentMessages()` は、まだ SCTP に渡していない分を**減算する**。
- `SCTP.setState(CLOSED)` → `releaseSendWaiters()` は待ち中の `send()` を全部解決するので、**close 後に bufferedAmount が 0 に落ち、`bufferedamountlow` も発火しうる**。
- 未接続のときの `dataChannelClose()` は `dataChannelQueue.filter()` でキューから**捨て**（①）、減算しない。channel はすぐ `closed` になる。

### 3.3 close と未送信 / 未 ACK のデータ
- association が確立していれば、`dataChannelFlush()` は同期的に `SCTP.send()` に渡し、`SCTP.send()` は最初の `await` より前に TSN を振って outboundQueue に積む。だから `close()` の時点で送ったものはすべて reset の `senderLastTsn = localTsn - 1` に含まれ、相手は 0.27.0 以降の deferred reset でそれを全部受け取ってから reset する。送信側の `close` は Success - Performed を受けたときに来る。
- 不備①: 未接続（`connecting`、または association の張り直し中）に `close()` すると、キューのメッセージは捨てられ、channel はすぐ `closed` になる。確立後の `dataChannelFlush()` も `closing` / `closed` の channel のメッセージを捨てる。
- 不備②: 受信した `DATA_CHANNEL_OPEN` を処理するとき、`onDataChannel.execute(channel)` が DCEP ACK を積むより**前**に呼ばれる。そのハンドラの中で `close()` すると reset が先に出て、ACK は `closing` の channel のものとして flush で捨てられるか、reset の後に届く。相手側の `DATA_CHANNEL_ACK` 処理は、channel が見つからないと `throw new Error("channel not found")` する（async の受信ハンドラなので unhandled rejection になる）。

### 3.4 既存のテストと WPT
- `packages/webrtc/tests/datachannel/{send,burst,close}.test.ts`、`tests/transport/sctp.test.ts`。"stop discards unsent messages and releases bufferedAmount" は 2.2 の意味論の変更で期待が反転する。
- 共通の Arrange は `packages/webrtc/tests/utils.ts` にある（`createDataChannelPair`, `awaitMessage`, `waitUntil`, `createIndexedMessages`, `collectChannelMessages`）。SCTP 側は `packages/sctp/tests/utils.ts`（`sentQueueOf` など）。
- WPT: `third_party/wpt/webrtc/RTCDataChannel-bufferedAmount.html` は `packages/webrtc/wpt/allowlist.json` に入っていない。`RTCDataChannel-send.html` は disabled、`RTCDataChannel-close.html` は一部の subtest だけ baseline に入っている。

## 4. 実装内容

方針: 標準 API（`send` / `close` / `bufferedAmount` / `bufferedAmountLowThreshold` / `bufferedamountlow` / `close` イベント）だけで下流の用途を満たす。非標準 API は追加しない（2.1）。

### 4.1 空メッセージ送信の修正（③）
- `RTCSctpTransport.datachannelSend()` / `dataChannelFlush()` で、長さ 0 の string は `WEBRTC_STRING_EMPTY`(56)、長さ 0 の Buffer は `WEBRTC_BINARY_EMPTY`(57) にし、ペイロードを `Buffer.from([0])` にして送る。
- `bufferedAmount` は増やさない（WPT `should stay at zero for empty string/buffer sent`）。減算は「足した量」で行う。キューのタプルに省略可能な加算量を持たせ、省略時は `userData.length` にする（2.2 のとおり下流の現行コードとの互換のため）。
- `messagesSent` は +1、`bytesSent` は +0。受信側の `bytesReceived` は PPID 56/57 のとき 0 を足す。
- `SCTP.send()` に長さ 0 の `userData` が来たら、chunk を作らずにすぐ `"sent"` で解決する、と TSDoc に書く（上位で 1 バイトにするので通常は来ない）。

### 4.2 close の closing procedure を W3C に揃える（①②）
- `dataChannelClose()`:
  - 未接続でも、その channel のメッセージを `dataChannelQueue` に残し、`closing` にする。association が確立したら、`dataChannelFlush()` で先にそれらを SCTP に渡し、その後で reset 要求を積む（`reconfigQueue` へ入れるのは flush の後）。
  - `dataChannelFlush()` は `closing` の channel のメッセージを捨てずに送る（`closed` の channel のものは捨てる）。
  - association が確立しないまま transport が stop / close した場合は `closed` にし、残ったメッセージは捨てる（bufferedAmount は減らさない。4.3）。
  - DCEP OPEN をまだ送っていない（相手が channel を知らない）in-band channel を close した場合は、今と同じく reset を送らずに `closed` にしてよい。そのとき DCEP OPEN とユーザーメッセージは送らない。
- `DATA_CHANNEL_OPEN` の受信処理: ACK を `dataChannelQueue` に積んでから `onDataChannel.execute()` を呼ぶ（または ACK を先に flush する）。ハンドラの中で close しても、ACK が reset より前に出るようにする。
- `DATA_CHANNEL_ACK` の受信で channel が見つからない場合は、`throw` をやめて `log` して無視する（すでに閉じた channel への遅れた ACK は正常に起こりうる）。
- 契約を `RTCDataChannel.close()` の TSDoc と README に書く。
  - `close()` より前に `send()` したメッセージは、association が確立していなくても捨てられず、reset より前に SCTP に渡される。信頼チャネルなら、送信側で `close` が来た時点でピアに届いている（RFC 6525 Sender's Last Assigned TSN と deferred reset による）。部分信頼チャネルでは abandon されたものは届かない。
  - `RTCPeerConnection.close()` は ABORT なので、未達のデータは失われる。確実に届けたいなら、各 channel の `close` を待ってから `pc.close()` する。
- 設計メモ（今回は実装しない）: 将来 ACK 済み量の API が必要になったら、SCTP が stream ごとに未 ACK バイト数を O(1) で数え（sentQueue は走査しない）、`RTCDataChannel` の非標準 getter として公開する案がある。

### 4.3 `bufferedAmount` 系の公開契約を整える
- `bufferedAmount` を getter だけ（readonly）にし、値は private フィールドに持つ。
- `addBufferedAmount()` は `@deprecated` と `@internal` にし、挙動は変えない（削除は v0.30.0）。内部では新しい private メソッドを使う。
- `onbufferedamountlow?: Callback` を追加し、`bufferedAmountLow.execute()` / `emit("bufferedamountlow")` と一緒に呼ぶ（`onopen` などと同じパターン）。
- close / stop の意味論:
  - 送られないまま捨てた分（`discardUnsentMessages`、association の CLOSED による `releaseSendWaiters`、4.2 の確立しないままの close）は**減算しない**。`closed` の後は `bufferedamountlow` を発火しない。
  - `closing` の間に実際にネットワークへ渡った分は減算する（4.2 で送るようにしたもの）。
  - PR-SCTP で abandon されたものは、W3C 上「送信を試みた」ものとして減算する（今と同じ）。
  - これを区別するため、`SCTP.send()` は `SctpSendResult`（`"sent" | "abandoned" | "discarded"`）で解決する。`as const` オブジェクトと同名の union 型で定義し、`werift-sctp` の index から export する。
- `bufferedAmountLowThreshold` の範囲チェックは今のままにする。WebIDL の厳密な変換が必要なら `tools/wpt-runner/*` の wrapper で行う（AGENTS Do 5）。

### 4.4 内部キューを公開契約から外す
- `SCTP.outboundQueue` に `@deprecated`（v0.30.0 で private にする旨と、代わりに公開 API を使う旨）と `@internal` を付ける。
- `RTCSctpTransport.dataChannelQueue` / `dataChannelFlush` に「private。構造は予告なく変わる」と TSDoc で書く。
- werift 自身のテスト（`packages/sctp/tests/burst.test.ts` が `outboundQueue.length` を読んでいる）は、`packages/sctp/tests/utils.ts` のテスト用 accessor（`sentQueueOf` と同じ形の `outboundQueueOf`）に寄せ、v0.30.0 で private にしても壊れないようにする。
- `FifoQueue` の re-export は残す。

### 4.5 回帰テスト（Arrange / Act / Assert、Act と Assert には日本語コメント）
共通の Arrange（channel pair の生成、cwnd/rwnd で送信を詰まらせる、ロスを入れる、閾値を設定する、未接続の channel を作る）は `packages/webrtc/tests/utils.ts`、または DataChannel 用の共通ファイル 1 つにまとめる。どのテストも公開 API だけで書き、それによって下流の用途を公開 API だけで再現できることを示す。

| ケース | 確認すること |
| --- | --- |
| 閾値を跨ぐ | `bufferedamountlow` / `onbufferedamountlow` / `bufferedAmountLow` が、上から跨いだときに 1 回ずつ発火する。閾値ちょうど、閾値 0、閾値を後から変えた場合、各メッセージ送信後（WPT の 3 ケースに相当） |
| 空メッセージ | `send("")` / `send(Buffer.alloc(0))` がピアで `""` / 空 Buffer として、前後のメッセージと順番どおりに届く。`bufferedAmount` は 0 のまま。stats が正しい |
| 接続中の close（①） | 接続前に `send()` × N → `close()` → 接続 → 全メッセージがピアに届き、その後で両側に `close` が来る |
| 確立後の送信中 close | 大量に `send()` → すぐ `close()` → 送信側の `close` までに全メッセージが順番どおり届く。`close()` 直後に `bufferedAmount` が減っていない |
| ondatachannel の中で close（②） | 受信側がハンドラの中で `close()` → 開いた側で例外も unhandled rejection も出ず、両側が `closed` になる |
| pc.close / transport stop | 閉じた後に `bufferedAmount` が減らず、`bufferedamountlow` も発火しない |
| 再送 | ロスを入れても全メッセージが届き、`bufferedAmount` が 0 に戻る。ACK 前にもう減っている |
| 部分信頼 | `maxRetransmits` / `maxPacketLifeTime` で abandon されたものも減算され、閾値を跨げば通知される |
| 旧 `_sendEmpty` 互換 | 3 要素のタプルを `dataChannelQueue` に push して `dataChannelFlush()` を呼んでも、今と同じく送られる（v0.29.0 だけの互換テスト。v0.30.0 で削除） |

- SCTP 単体のテスト（`packages/sctp/tests`）で、`send()` の結果（sent / abandoned / discarded）を確認する。
- WPT: `RTCDataChannel-bufferedAmount.html` を `wpt/allowlist.json` に追加し、10 回のフルランで毎回通る subtest を baseline に入れる。`RTCDataChannel-close.html` の closing イベント系 subtest も見直す。

### 4.6 ドキュメント
- `packages/webrtc/README.md`（DataChannel の節）に、バックプレッシャーの例（high/low water mark と `bufferedamountlow`）、graceful close の手順と保証、空メッセージを書く。
- TSDoc: `bufferedAmount`, `bufferedAmountLowThreshold`, `onbufferedamountlow`, `send()`, `close()`, `SCTP.send()` / `SctpSendResult`, deprecated になる各 API。
- `changelog.md` の次版（v0.29.0）の節:
  - Breaking changes: `bufferedAmount` の readonly 化、close / stop 後に減算しないこと。
  - Fixes: 空メッセージの送信、接続中の close でメッセージが捨てられること、ondatachannel の中での close、遅れた DCEP ACK による throw。
  - Features: `onbufferedamountlow`、`SCTP.send()` の戻り値。
  - Deprecations: `addBufferedAmount`、`SCTP.outboundQueue`（v0.30.0 で削除 / private 化）。
  - #730（性能）とは別の変更であると書く。
- 最後に `npm run doc` で `doc/` を作り直す。

## 5. 制約と注意点
- **W3C / WPT との整合**: 厳密な WebIDL 例外などは `tools/wpt-runner/*` に置き、`src` の便利な挙動（`connecting` 中の `send()` をキューに積むなど）は残す。bufferedAmount と close の意味論は、下流がフロー制御に使う契約なので `src` 側で W3C に合わせる。
- **後方互換**: 2.2 の表に従う。v0.29.0 では、下流の現行アダプタ（`_sendEmpty` / `_unsent`）が壊れないことを、4.5 の互換テストと下流のコードを読むことで確認する。`_unsent()` は close 後に `bufferedAmount` が 0 に落ちることを待たない（close の前だけを見る）ので、意味論を変えても影響しない。
- **#730 と分ける**: 計算量・イベントループ・ベンチマーク（`packages/sctp/tests/bench`, `burst-benchmark.mjs`）は扱わない。4.2 の flush 順序を変えても、flush は 1 回の同期パスのままにし、メッセージごとに O(1) を保つ。
- **SCTP の不変条件**: `flightSize` の不変条件、TSN の順序、FORWARD-TSN、`sendWaiters` を先頭から解決すること、reset 要求の `senderLastTsn` が flush 済みデータを含むことを壊さない。
- **reset と flush の順序**: 4.2 では「channel のメッセージを SCTP に渡す → reset を積む」の順を必ず守る。association が張り直されたとき（`resetAssociation`）に、`closing` の channel のメッセージが新しい association に漏れないことも確認する（既存の "reconnect does not announce a channel closed while stopped" と同じ観点）。
- **erasable syntax**: `SctpSendResult` は `enum` ではなく `as const` オブジェクトと union 型で書く。パラメータプロパティも使わない。
- **ホスト依存のテスト失敗**: この環境で HEAD でも落ちる既知のテスト（tcp active-only、setConfiguration、modern_sdp）とは区別して報告する。
- 比較は一時 worktree で行う（`git worktree add --detach`）。アクティブな worktree の checkout / stash はしない。

## 6. 完了条件
- [ ] 下流の 2 つの用途（未送信分を残さない close、空メッセージ送信）が、`ch.close()` と `ch.send("")` / `ch.send(Buffer.alloc(0))` を呼ぶだけで実現でき、`dataChannelQueue` / `dataChannelFlush` / `addBufferedAmount` / `outboundQueue` / `sentQueue` / `sctp.flush` に触る必要がない。その方法が README と TSDoc に書かれている。
- [ ] 空メッセージが PPID 56/57 で送られ、`bufferedAmount` は 0 のまま、stats も正しい。
- [ ] `connecting` 中の close や ondatachannel の中での close でもメッセージが失われず、例外も出ない（4.2）。
- [ ] `bufferedAmount` が readonly で、閾値跨ぎ・close・stop・再送・部分信頼での増減と通知が 4.5 のテストで固定され、`onbufferedamountlow` がある。
- [ ] 非標準の ACK 量 API は追加しない。そう決めた理由（2.1）を TSDoc の close 契約に反映している。
- [ ] 2.2 の表のとおり、v0.29.0 の Breaking / Features / Fixes / Deprecations が changelog にあり、v0.30.0 で行う `outboundQueue` の private 化と `addBufferedAmount` の削除をフォローアップチケットとして起票している。
- [ ] v0.29.0 で下流の現行アダプタ（`_sendEmpty` の 3 要素タプル）が動き続けることを互換テストで確認している。
- [ ] WPT `RTCDataChannel-bufferedAmount.html` が allowlist に入り、安定して通る subtest が baseline に入っている。
- [ ] #730（性能）とは別のものとして changelog と本チケットに書いてある。
- [ ] 検証: `cd packages/sctp && npm test`、`cd packages/webrtc && npm test && npm run type`、`npm run type`、`npm run test:small`、`npm run wpt` と `npm run wpt:coverage`（allowlist / baseline を変えるため）、`npm run format`、`npm run doc`。