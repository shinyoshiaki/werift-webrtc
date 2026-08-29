# Issue #681: `RTCPeerConnection.close()` の SCTP ABORT 送信順を修正する

対象: [shinyoshiaki/werift-webrtc#681](https://github.com/shinyoshiaki/werift-webrtc/issues/681)

## 1. タスクの目的と背景

`RTCPeerConnection.close()` が SCTP 関連付けを切る前に DTLS / ICE を破棄しており、仕様が要求する **SCTP ABORT を下位トランスポートが生きているうちに送る** ことができない。これを修正する。

WebRTC の `close()` は DataChannel の graceful close ではない。アプリケーションが

```ts
dataChannel.send("bye");
peerConnection.close();
```

で `"bye"` の到達を期待してはいけない（WenChat 側は HTTP シグナリングへ teardown 意図を移した）。一方で、werift は仕様どおり **ABORT 自体は DTLS/ICE 破棄前に送る** 必要がある。

### 再現している順序（現状 `develop`）

```text
RTCPeerConnection.close()
  -> transceiverManager.close()          // RTP sender/receiver 停止。ICE はまだ生きている
  -> secureManager.close()
       -> RTCDtlsTransport.stop()
            -> onStateChange("closed")   // SCTP association を CLOSED にする
            -> RTCIceTransport.stop()
                 -> IceConnection.close() // nominated 破棄、socket close
  -> sctpManager.close()
       -> RTCSctpTransport.stop()
            -> SCTP.stop()
                 -> abort() は association が既に CLOSED なら呼ばれない
                 -> 呼ばれても IceConnection.send() は no-op
```

該当コード:

```1228:1243:packages/webrtc/src/peerConnection.ts
  async close() {
    if (this.isClosed) return;

    this.isClosed = true;
    this.pendingRemoteCandidates.length = 0;
    this.setSignalingState("closed");

    this.transceiverManager.close();

    await this.secureManager.close();
    await this.sctpManager.close();
    // ...
  }
```

ABORT が届かない原因は順序入れ替えだけでは説明しきれず、次の **2 段の遮断** がある。

1. `RTCDtlsTransport.stop()` は ICE 停止の前に `onStateChange("closed")` を必ず発火する。`RTCSctpTransport` はこれに反応して `SCTP.setState(CLOSED)` する。その後の `SCTP.stop()` は `associationState !== CLOSED` のときだけ `abort()` するため、ABORT 自体がスキップされる。
2. 仮に `abort()` が走っても、`IceConnection.close()` 後は `nominated` が消え `canSendApplicationData()` が false になる。`IceConnection.send()` は例外を投げず return するだけなので、ABORT は「成功したように見えて」ワイヤに乗らない。

WenChat 由来の古い SCTP `send()` キュー問題（T3-rtx 中に queue して即 return）は `v0.22.2+` で outbound queue flush 待ちに直済みで、**本チケットの対象外**。

## 2. 実装すべき具体的な機能や変更内容

### In scope

- `RTCPeerConnection.close()` の破棄順を、仕様の意図に合わせて次にする。

```text
signalingState = closed
  -> stop RTP / transceivers
  -> close SCTP / send AbortChunk   // DTLS/ICE はまだ使える
  -> close DTLS
  -> close ICE
```

- 具体的には `packages/webrtc/src/peerConnection.ts` の `close()` で

  `await this.secureManager.close(); await this.sctpManager.close();`

  を

  `await this.sctpManager.close(); await this.secureManager.close();`

  に入れ替えるのが主変更。SCTP 未使用時（`sctpTransport` なし）は `SctpTransportManager.close()` が no-op 相当なので、常に SCTP close を先に呼んでよい。

- DataChannel のみ、および **max-bundle（メディアと SCTP が同一 DTLS/ICE を共有）** の両方で、`pc.close()` 時にリモートへ `AbortChunk`（SCTP chunk type 6）が届き、その時点ではローカル ICE がまだ閉じていないことをテストで固定する。
- `close()` が graceful flush API になっていないこと（ABORT であり SHUTDOWN ではないこと、未送信 DATA の到達を保証しないこと）をテストで確認する。

### Out of scope

- DTLS `close_notify`（`RTCDtlsTransport.stop()` の `// todo impl send alert`）。仕様上は SCTP ABORT の後に DTLS を閉じるが、本 issue は ABORT 順序のみを扱う。
- DataChannel 個別 `close()` の RE-CONFIG / stream reset（既存 `datachannel/close.test.ts`）。
- 古い `SCTP.send()` の outbound queue 即 return 問題。
- `RTCPeerConnection.close()` をアプリケーションメッセージの到達保証 API にすること。
- 公開 API のシグネチャ変更、WPT allowlist 追加（パケット単位の ABORT 観測は upstream WPT に無い）。

### テスト

既存の GitHub issue 回帰は `packages/webrtc/tests/issue/{141,142}.test.ts`、DataChannel ペア構築は `packages/webrtc/tests/utils.ts` の `createDataChannelPair`。本 issue はパケット観測を含む結合テストなので、次を推奨する。

- 追加ファイル: `packages/webrtc/tests/issue/681.test.ts`
- Arrange の共通化: 2 ピア接続・AbortChunk 観測・ICE close 順序記録は、同ファイル内のユーティリティ（または `tests/utils.ts` へ抽出）にまとめる。複数テストで同じセットアップを複製しない。
- Act / Assert には日本語コメントを付ける（AGENTS.md のテスト規約）。

最低限のケース:

1. DataChannel 確立後に local `pc.close()`。リモート SCTP が `AbortChunk` を受信する（`SCTP` の `receiveChunk` / `handleData` を観測、または `parsePacket` で type 6 を検出）。同時に local `IceConnection.close` より **先に** ABORT 送信が起きていること。
2. `bundlePolicy: "max-bundle"` かつ audio transceiver + DataChannel で同一 DTLS 共有でも同様。
3. `close()` 経路で送られるのは `AbortChunk` であり `ShutdownChunk` ではないこと。未 await の `dataChannel.send(...)` の到達を assert しない（到達してもよいし、しなくてもよい）。

観測の実装ヒント:

- local: `pc.sctpTransport.sctp.sendChunk` と `pc.sctpTransport.dtlsTransport.iceTransport.connection.close` の呼び出し順を記録する。
- remote: `AbortChunk` 受信、または `sctp.stateChanged.closed` が ABORT 由来で発火すること。ICE を先に閉じると remote は ABORT を見ずにタイムアウトしうるので、受信側 assert には十分な待ちと失敗時の明確なメッセージを付ける。

## 3. 技術的な実装アプローチ（調査結果）

プロトコル層は `ICE -> DTLS -> SCTP`。`close()` だけが逆順になっている。

| 層 | 現行の close 時の動き | ABORT との関係 |
| --- | --- | --- |
| `TransceiverManager.close()` | `forceStop()` で RTP sender/receiver のループを止めるだけ | ICE/DTLS は触らない。先に呼んでよい |
| `SecureTransportManager.close()` | 全 `RTCDtlsTransport.stop()` | DTLS state closed 発火 + ICE close。**SCTP より後であるべき** |
| `SctpTransportManager.close()` | `RTCSctpTransport.stop()` → `SCTP.stop()` → `abort()` | `AbortChunk` を `BridgeDtls.send` → `RTCDtlsTransport.sendData` → `IceConnection.send` で出す |

`SCTP.stop()` / `abort()`（`packages/sctp/src/sctp.ts`）:

- `isStopping = true` のあと、association が CLOSED でなければ `abort()`。
- `abort()` は `new AbortChunk()` を `sendChunk()`。失敗は log して握る。
- `sendChunk()` は `this.state === "closed"` なら即 return。`SCTP_STATE.CLOSED` だと connection state も `"closed"` になる。
- `stop()` は outbound queue を flush しない。`isStopped` が立つと `transmit()` は return する。仕様の abrupt close と一致。
- 受信側が `AbortChunk` を見ると `setState(CLOSED)` するだけ（SHUTDOWN ハンドシェイクはしない）。

BUNDLE:

- 既定 `bundlePolicy` は `"max-compat"`。リモートが BUNDLE 対応ならメディアと SCTP は同一 `RTCDtlsTransport` を共有する（`peerConnection.ts` の `findOrCreateTransport` / `setRemoteDescription`）。
- `SctpTransportManager.close()` は SCTP だけ止め、共有 DTLS/ICE は止めない。順序入れ替え後も、メディア停止 → SCTP ABORT → 共有 DTLS/ICE 破棄、の順になる。
- `max-bundle` 専用テストは共有トランスポートを明示するため残す。

防御的な追加は必須ではない。順序を直せば DTLS `onStateChange("closed")` の SCTP CLOSED 遷移は ABORT 後に起きる。`SCTP.stop()` を CLOSED 後も abort するよう変えるのは過剰。

公開 API・型・SDP は変えない。ドキュメント再生成も不要。

## 4. 考慮すべき制約や注意点

- **graceful にしない。** `SCTP.stop()` を SHUTDOWN シーケンスや outbound flush 待ちに変えない。`SCTP.send()` の queue flush 待ち（既存）と `close()` の abrupt を混同しない。
- **BUNDLE 共有トランスポート。** SCTP close 実装が DTLS/ICE まで止めないこと（現状は止めていない）。`transceiverManager.close()` が ICE を止めないこと（現状 `forceStop` は RTP のみ）。
- **SCTP 未確立。** association 未確立だと `sendChunk` が `invalid remote port` 等で失敗しうる。`abort()` は既に catch している。順序入れ替え後も壊さない。
- **DataChannel 状態。** `SCTP` が CLOSED になると `RTCSctpTransport` が各チャネルを `"closed"` にする。ABORT 後でよい。個別 `channel.close()`（RE-CONFIG）とは別経路。
- **`IceConnection.send()` の silent drop。** close 後は throw しない。テストは「abort() が reject しなかった」だけでは不十分で、**送信時点の ICE state** か **リモート受信** を見る。
- **既存 close テスト**（`tests/integrate/peerConnection.test.ts` の `test_close_datachannel`、`tests/datachannel/close.test.ts`）はチャネル単位 close。回帰として残しつつ、PC `close()` の ABORT は新規テストで見る。
- テスト規約: Arrange 再利用、Act/Assert の日本語コメント、失敗を握りつぶさない。
- 検証はパッケージローカル優先: `cd packages/webrtc && npm test`（新規テストを含む）、必要なら `npm run type`。全スタック `npm run ci` は不要（公開 API / 他パッケージ変更なし）。SCTP パケット実装自体は変えない想定。

## 5. 完了条件

- [ ] `RTCPeerConnection.close()` が SCTP（ABORT）→ DTLS → ICE の順で破棄する。
- [ ] DataChannel 確立済みの 2 ピアで、local `close()` によりリモートが `AbortChunk` を受信する。
- [ ] その ABORT 送信時点で local ICE は未 close（`IceConnection.close()` より前）。
- [ ] max-bundle（メディア + DataChannel で DTLS 共有）でも同様。
- [ ] `close()` が SHUTDOWN / outbound flush 待ちになっていない（未送信アプリメッセージの到達を保証しない）。
- [ ] `packages/webrtc/tests/issue/681.test.ts`（名称はこれに準ずる）が Arrange / Act / Assert と日本語コメント付きで上記を固定している。
- [ ] `cd packages/webrtc && npm test` が新規・既存 DataChannel/close 系を含めて通る。src 変更がある場合は `cd packages/webrtc && npm run type` も通る。
- [ ] 公開 API・既定の DataChannel `send()` flush 待ち・個別チャネル close の挙動を変えていない。
