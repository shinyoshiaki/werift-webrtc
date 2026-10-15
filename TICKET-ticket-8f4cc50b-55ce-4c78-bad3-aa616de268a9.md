## Summary

`UdpTransport` creates a Node/Bun dgram socket but installs no persistent `"error"` listener.

That means a runtime UDP socket error can surface as an uncaught EventEmitter error and terminate the worker/process instead of being handled by the transport/protocol layer.

This was reproduced independently in OpenClaw's werift-backed GPT-Live tests on Linux Bun:

https://github.com/openclaw/openclaw/pull/166465

After one peer intentionally closed, the surviving werift peer still had an in-flight RTP/RTCP send to the now-closed UDP port. Linux returned an ICMP port unreachable; Bun exposed it as:

```text
Error: recvmsg ECONNREFUSED
code: ECONNREFUSED
errno: -111
syscall: recvmsg
```

Because werift's `UdpTransport` had no socket `error` listener, the receiver worker threw. OpenClaw worked around it in the test harness by owning the worker error, but the underlying transport behavior remains.

## Current implementation

Current `develop`, `packages/common/src/transport.ts`:

```ts
private constructor(...) {
  this.socket = createSocket(socketType);
  this.socket.on("message", ...);
}
```

There is no:

```ts
this.socket.on("error", ...)
```

Node-style EventEmitters treat an emitted `error` event with no listener as an uncaught exception.

There is a second lifecycle concern during bind: `UdpTransport.init()` waits only for `"listening"`:

```ts
await new Promise((r) => this.socket.once("listening", r));
```

so a bind-time socket error can also bypass normal promise rejection unless another layer happens to intercept it.

## Why this matters

UDP errors are environment/runtime dependent:

- Linux connected/unconnected UDP + ICMP port-unreachable behavior
- Bun vs Node dgram behavior
- interface/address changes
- bind races / address availability
- local firewall/network changes

A transport library should not let an ordinary socket-level network error become an unowned process-level exception merely because the runtime emits it through the dgram `error` event.

## Expected behavior

`UdpTransport` should always own the socket `error` event.

The exact policy can differ by phase:

### During initialization/bind

A bind error should reject `UdpTransport.init()` cleanly and close the socket.

### During runtime

A socket error should be routed through an explicit transport error path rather than crashing the process.

Possible policies:

- expose an `onError` event/callback to the owning STUN/TURN/ICE layer;
- log and continue for recoverable asynchronous UDP errors such as a transient `ECONNREFUSED`;
- transition the owning protocol/ICE state when an error is transport-fatal.

The important invariant is that no dgram `error` event is left unhandled.

## Reproduction evidence

OpenClaw reproduced the primitive with two werift peers:

1. establish media;
2. close one peer;
3. let the surviving peer send/echo an in-flight RTP/RTCP packet to the closed port;
4. on Linux Bun `1.4.3-canary.1+667c4ab22`, `recvmsg ECONNREFUSED` was emitted by the dgram socket;
5. without a socket error listener, it propagated as an uncaught worker error.

They observed the real ICMP path in 2/3 runs and also forced the same socket error deterministically in their regression test.

The same script under Node 24 did not reproduce the kernel/runtime surface, but the missing listener exists in shared werift code and is therefore a portability/robustness issue.

## Suggested tests

Please add tests for:

1. `UdpTransport.init()` rejects cleanly on bind failure (for example, address/port already in use).
2. A runtime socket `error` event does not become an uncaught process exception.
3. `ECONNREFUSED` after the remote endpoint disappears is handled according to the chosen runtime policy.
4. Closing the transport after an error remains idempotent.
5. No double-settlement between `error`, `close`, and `listening`.
6. Node and Bun CI coverage if Bun is a supported/target runtime.

Related but distinct issues:

- #687: failed UDP TURN allocation leaks its socket
- #374: uncaught TURN transaction failure

This issue is specifically about ownership and propagation of the dgram socket's `error` event.
---

# 詳細化（コードベース調査結果）

## 1. 目的と背景

- `packages/common/src/transport.ts` の `UdpTransport` は ICE の host candidate（`StunProtocol`）と UDP TURN クライアント（`createTurnClient`）の両方で使われる、werift の UDP 送受信の土台。
- 現状 `UdpTransport` は dgram socket の `"error"` を一切購読していない。Node/Bun の EventEmitter はリスナーなしの `error` を uncaught exception として投げるため、ネットワーク環境・ランタイム依存の UDP エラー 1 件でプロセス／worker が落ちる。
- 同じファイル内の `StreamTransport`（TCP/TLS）は、接続時の `once("error")` と常駐の `on("error")`（log）の両方をすでに持っている。UDP 側だけ抜けていて、ファイル内で非対称になっている。
- 目的は「`UdpTransport` が生成した socket の `error` イベントは必ず transport 自身が引き受ける」という不変条件を作ること。bind 時のエラーは `init()` の reject、ランタイムのエラーは明示的なエラー経路に振り分ける。

### 調査で確認した事実（Node v24.21.0, Linux）

| 確認内容 | 結果 |
| --- | --- |
| 使用中ポートへ `bind()` し、`error` リスナーがない | `EADDRINUSE` が **uncaught exception** になる（現行 `init()` の `once("listening")` は永久に解決しない） |
| callback なしの `socket.send()`（`UdpTransport.send` の高速パス）で `EMSGSIZE` | Node では **黙って捨てられ、`error` は emit されない**。callback 付きなら callback にエラーが渡る |
| close 済み socket に `close()` | `ERR_SOCKET_DGRAM_NOT_RUNNING` を同期 throw（現行 `close()` は try/catch で resolve するので問題なし） |
| Bun | 非同期 ICMP port unreachable を `recvmsg ECONNREFUSED` として socket の `error` に emit する（Issue 記載。ローカル環境には Bun がないため未再現） |

→ Node ではランタイムの `error` が出にくいが、bind 失敗は Node でも確実にプロセスが落ちる経路。テストでは `socket.emit("error", ...)` で決定的に再現する必要がある。

## 2. 実装すべき変更

### 2.1 `UdpTransport`（`packages/common/src/transport.ts`）— 必須

1. **常駐の `error` リスナー**
   - constructor で `createSocket()` の直後に `this.socket.on("error", ...)` を登録する。
   - ハンドラでは debug log を出し、後述の `onError` で通知する。**socket は閉じない**（UDP の `ECONNREFUSED` 等は一過性で、socket はそのまま使えるため）。
   - `closed === true` の後に届いた error は log のみ、通知はしない。
2. **エラー通知経路の追加（公開 API への追加のみ）**
   - `readonly onError = new Event<[Error]>()` を `UdpTransport` に追加する（root `AGENTS.md` の「独自 `Event` クラスによる非同期通知」パターンに合わせる。`Event` は同じ `packages/common/src/event.ts` にある）。
   - `Transport` interface には **optional** で追加するか、追加しない（カスタム transport 実装を壊さないため。必須にはしない）。
3. **`init()` の bind ライフサイクル修正**
   - `listening` と `error` を 1 回だけ settle する Promise にする（`StreamTransport.connect()` の `settled` / `settle()` パターンを流用）。settle 時に一時リスナーを `off` で外す。
   - bind エラー時は socket を close してから reject する。
   - `bind()` の同期 throw（例: `ERR_SOCKET_ALREADY_BOUND`、不正な引数）も reject に変換する。
   - 一時の `once("error")` と常駐の `on("error")` が並ぶため、bind エラーが `onError` にも二重に流れないよう、init 完了前は常駐ハンドラから通知しない（例: `listening` フラグを見る）。
4. **`static init()` の失敗時クリーンアップ**
   - `TcpTransport.init` / `TlsTransport.init` と同じく `try { await transport.init() } catch { await transport.close(); throw }` にする。
   - `findPort()` が `"port not found"` を投げると、constructor で作った socket が現状閉じられずに残るので、それも塞ぐ。
5. **`close()` の冪等性**
   - 2 回目以降、または error 後の close も必ず resolve すること。現状は close 済みで `socket.close()` が throw → catch → resolve で成り立っているが、`once("close", r)` のリスナーが残る。`closed` が立っていれば即 resolve する早期 return を入れて明確にする。
   - bind 失敗後（未 listening）の close も resolve すること。

### 2.2 上位レイヤー（`packages/ice`）— 推奨・最小限

- `StunProtocol.connectionMade()`（`packages/ice/src/stun/protocol.ts`）と `TurnProtocol`（`packages/ice/src/turn/protocol.ts` の `transport.onData` を設定している箇所付近）で、UDP transport の `onError` を購読して各モジュールの debug namespace で log する。
- 今回は ICE の状態遷移（candidate 破棄、connection state の変更など）は行わない。「落ちない」ことと「上位に届く経路」を作るところまで。fatal 判定と状態遷移は別チケットにする。
- `ice.ts` の host candidate 収集（`StunProtocol.connectionMade` を try で囲んでいる箇所）は、bind 失敗が reject になれば既存の catch で処理される。現状は、`portRange` 指定時の `findPort()` → `bind()` 間の TOCTOU 競合で `EADDRINUSE` が起きると、uncaught exception か `init()` の永久待ちになる。

### 2.3 スコープ外（必要なら別チケット）

- `packages/rtp/src/transport.ts` / `packages/sctp/src/transport.ts` の `UdpTransport`：外部から渡された socket をラップしているだけで、socket の所有者は呼び出し側なので対象外。
- `packages/ice-server`（`server.ts`, `turnServer.ts`）、`packages/webrtc/src/utils.ts`、`nonstandard/navigator.ts`、`polyfill/sourceIo.ts` の `createSocket` 利用箇所：所有者もライフサイクルも別なので個別に精査する。
- `findPort()` の TOCTOU（空きを確認して close してから再 bind する）の根本解決やリトライ。今回は bind 失敗が正しく reject されるところまで。
- #687（UDP TURN allocation 失敗時の socket リーク）、#374（TURN transaction 失敗の uncaught）。
- Bun の CI 追加：現行 CI（`.github/workflows/nodejs.yml`）は Node 24.x のみで、`engines` も `node >=22`。Bun は公式サポート対象ではないので、CI 追加は別途判断する。

## 3. 技術的アプローチ（実装イメージ）

```ts
// packages/common/src/transport.ts（イメージ）
export class UdpTransport implements Transport {
  readonly onError = new Event<[Error]>();
  private listening = false;

  private constructor(...) {
    this.socket = createSocket(socketType);
    this.socket.on("message", ...);
    this.socket.on("error", (error) => {
      log("udp socket error", error);
      if (this.closed || !this.listening) return; // bind 中は init() 側で扱う
      this.onError.execute(error);
    });
  }

  static async init(type, options = {}) {
    const transport = new UdpTransport(type, options);
    try {
      await transport.init();
      return transport;
    } catch (error) {
      await transport.close();
      throw error;
    }
  }

  private async init() {
    const address = interfaceAddress(...);
    const port = this.options.port ?? (this.options.portRange ? await findPort(...) : undefined);
    await new Promise<void>((resolve, reject) => {
      const settle = (error?: Error) => {
        this.socket.off("listening", onListening);
        this.socket.off("error", onError);
        error ? reject(error) : resolve();
      };
      const onListening = () => { this.listening = true; settle(); };
      const onError = (error: Error) => settle(error);
      this.socket.once("listening", onListening);
      this.socket.once("error", onError);
      try {
        this.socket.bind({ port, address });
      } catch (error) {
        settle(error as Error);
      }
    });
  }

  close = () =>
    new Promise<void>((r) => {
      if (this.closed) return r(); // 冪等
      this.closed = true;
      ...既存処理
    });
}
```

- `Event.execute` は購読者を同期で呼ぶ。購読者が throw すると socket の `error` ハンドラから例外が漏れるので、`onData` と同じように try/catch で囲んで log する。
- `port: undefined` を `bind({ address })` と同じ挙動にできるかは確認が必要。気になるなら既存の 3 分岐を残し、Promise 内で `bind` を呼ぶ形にする。
- `closed` の後に emit された error（close 処理中に届く非同期 ICMP など）は通知しない。

## 4. 制約・注意点

- **公開 API**: `UdpTransport.onError` の追加は後方互換。`Transport` interface に必須プロパティを足すとカスタム transport（`createStunOverTurnClient` 等に渡されるもの）が壊れるので、足すなら optional にする。
- **既存挙動を変えない**: ランタイムエラーで socket を自動 close しない（DTLS/SRTP が乗っている経路で、一過性の `ECONNREFUSED` を理由に通信全体を止めない）。送信の高速パス（callback なし `send`）は性能のため維持する。
- **Node と Bun の差**: Node では callback なし `send` のエラーは emit されず捨てられる（検証済み）。Bun は ICMP 由来のエラーを `error` として出す。テストはランタイムの差に依存しないよう、`socket.emit("error", err)` で注入する。
- **二重 settle 防止**: `listening` → その後の `error`、`error` → `close`、init 中の `close()` 呼び出し、の各順序で Promise が 1 回だけ settle し、未処理 reject や uncaught が出ないこと。
- **エラーの握りつぶし禁止**（root `AGENTS.md` Do #11, #12）: 広く catch して無視するのではなく、log と `onError` で上位に見える形にする。
- テストは Arrange / Act / Assert の 3 フェーズで書き、Act / Assert に日本語コメントを付ける。Arrange 用ユーティリティ（使用中ポートを占有する dgram socket の作成、ECONNREFUSED 相当のエラーオブジェクト生成など）は `packages/common/tests/utils.ts` にまとめる。
- `packages/common` には `AGENTS.md` がないので、root の `AGENTS.md` に従う。`packages/ice` を変更する場合も同様。

## 5. テスト計画

`packages/common/tests/transport.test.ts` に `describe("UdpTransport socket error handling")` を追加する。vitest は uncaught exception / unhandled rejection があると run を失敗にするので、「落ちないこと」はそれで検証できる。

1. **bind 失敗で reject**: `127.0.0.1` の任意ポートを別の dgram socket で占有し、`UdpTransport.init("udp4", { port, interfaceAddresses: { udp4: "127.0.0.1" } })` が `code: "EADDRINUSE"` で reject されること。uncaught が出ないこと。
2. **ランタイム error で落ちない**: init 済み transport の `socket.emit("error", <recvmsg ECONNREFUSED 相当>)` で例外が出ず、`onError` が 1 回呼ばれ、`closed === false` のままであること。
3. **error 後も送受信を継続できる**: 2 の後、loopback のピアと送受信できること（ECONNREFUSED を一過性として扱う方針の確認）。
4. **close の冪等性**: error 後の `close()` を 2 回呼んでも両方 resolve すること。bind 失敗後の close も resolve すること。
5. **二重 settle なし**: `listening` 後に error を emit しても `init()` の結果が変わらないこと。close 後の error は `onError` に届かず、例外にもならないこと。
6. **`findPort` 失敗時の後始末**（任意）: `portRange` に空きがないケースで reject され、socket が閉じられていること。
7. （ice を変更した場合）`packages/ice/tests` に、`StunProtocol` の transport で error を emit しても例外にならないことの軽いテスト。Arrange は `packages/ice/tests/utils.ts` に置く。

## 6. 完了条件

- [ ] `UdpTransport` が生成するすべての dgram socket に、生存期間全体で `error` リスナーが付いている。
- [ ] bind 失敗（`EADDRINUSE` 等、`bind()` の同期 throw を含む）で `UdpTransport.init()` が reject し、socket が close されている。uncaught exception も init の永久待ちも起きない。
- [ ] `findPort()` 失敗時も socket がリークしない。
- [ ] ランタイムの socket error が `onError`（`Event<[Error]>`）と debug log で観測でき、socket は使い続けられる。
- [ ] `close()` が冪等で、error 後や bind 失敗後でも resolve する。
- [ ] `listening` / `error` / `close` の間で二重 settle がない。
- [ ] （推奨）`StunProtocol` / `TurnProtocol` が `onError` を購読して log する。
- [ ] 5 章のテストを Arrange/Act/Assert 形式（日本語コメント付き）で追加し、Arrange ユーティリティを `tests/utils.ts` に集約している。
- [ ] 検証コマンドが通る:
  - `cd packages/common && npm run type && npm test`
  - ice を変更した場合: `cd packages/ice && npm run type && npm test`
  - 公開 API の追加を含むので: ルートで `npm run type` と `npm run test:small`
- [ ] Bun での確認は任意（CI 対象外）。確認できた場合は PR に結果を書く。
