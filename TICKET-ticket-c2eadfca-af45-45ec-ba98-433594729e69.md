関連箇所をまとめて見て、修正範囲と実装方針が実コードに沿うように整理します。まず `max-message-size` の扱い、DataChannel送信経路、既存テストを確認します。

  │ packages/webrtc/src/sctp.ts

  │ packages/webrtc/src/dataChannel.ts

  │ packages/webrtc/src/peerConnection.ts

  │ "max-message-size|maxMessageSize|message
  │ size|datachannelSend|RTCDataChannel|bufferedAmount" in *.{ts,tsx} (packages,
  │ e2e, examples)

`max-message-size` のSDP解析・生成位置と、実際のSCTP送信経路が見えたので、その間が未接続かを確認します。加えて既存テストの置き場所も見ます。

  │ packages/webrtc/src/transport/sctp.ts

  │ packages/webrtc/src/sctpManager.ts

  │ packages/webrtc/src/sdp.ts

  │ packages/webrtc/tests/integrate/peerConnection.test.ts

  │ packages/webrtc/src/sdp.ts

  │ packages/webrtc/tests/transport/sctp.test.ts

  │ packages/webrtc/src/peerConnection.ts

  │ packages/webrtc/src/peerConnection.ts

  │ packages/webrtc/src/sdpManager.ts

  │ "sctpCapabilities|getCapabilities\(|RTCSctpCapabilities\(|maxMessageSize" in
  │ *.ts (packages/webrtc/src)

送信制限値の流れを追うと、SDPでは保持している一方で `RTCSctpTransport` へ反映されていません。公開APIや既存パターンも見て、どこに状態を置くのが自然かを詰めます。

  │ packages/webrtc/src/index.ts

  │ packages/webrtc/src/sdp.ts

  │ packages/sctp/src/sctp.ts


  │ "\.maxMessageSize\b|maxMessageSize\b|sctpTransport\.|RTCSctpTransport" in
  │ *.ts (packages/webrtc/src, packages/webrtc/tests)

  │ packages/webrtc/src/sdpManager.ts

  │ packages/webrtc/tests/utils.ts

  │ packages/webrtc/package.json

  │ "createDataChannelPair\(|awaitMessage\(|onDataChannel|stateChanged.subscribe
  │ \(|send\(" in *.test.ts (packages/webrtc/tests)

  │ "**/*datachannel*" in packages/webrtc/tests, e2e

  │ packages/webrtc/tests/datachannel/send.test.ts

  │ packages/webrtc/tests/integrate/datachannel.test.ts

  │ e2e/tests/datachannel/datachannel.test.ts

  │ e2e/server/handler/datachannel/datachannel.ts

  │ "TypeError|OperationError|InvalidStateError|bufferedAmountLowThreshold|throw
  │ new Error\(|error\.execute\(|RTCErrorEvent" in *.ts (packages/webrtc/src,
  │ packages/webrtc/tests)

● Fetching web content https://w3c.github.io/webrtc-pc/#dom-rtcdatachannel-send · url: "https://w3c…

● Web Search (MCP: github-mcp-server) · WebRTC RTCDataChannel send max-message-size expected behavi…

仕様寄りの挙動も一度だけ確認します。特に `a=max-message-size` の扱いは「超過時に送信失敗」が基本ですが、`0` の意味の解釈だけは実装方針に影響するので押さえます。

  │ "65536|a=max-message-size|sctp-port:5000|application" in *.test.ts
  │ (packages/webrtc/tests)

● Web Search (MCP: github-mcp-server) · RFC 8831 6.6 max message size send operation MUST fail · qu…

● Web Search (MCP: github-mcp-server) · RFC 8841 a=max-message-size 0 means unlimited WebRTC data c…

  │ packages/webrtc/tests/integrate/mix.test.ts

  │ "sctpCapabilities|SessionDescription\.parse|localDescription!\.sdp|setRemote
  │ Description\(|setLocalDescription\(" in *.test.ts (packages/webrtc/tests)

既存テストは DataChannel 単体・統合の両方があるので、今回の修正もその2層で書けそうです。最後に `a=max-message-size` をテストでどう差し込めるかだけ絞って見ます。

  │ packages/webrtc/tests/issue/142.test.ts

  │ "sctpCapabilities" in *.test.ts (packages/webrtc/tests)

  │ "setRemoteDescription\(\{ type: "answer"|setRemoteDescription\(\{ type:
  │ "offer"|sdp: .*replace\(|createAnswer\(\).*setLocalDescription|createOffer\(
  │ \).*setLocalDescription" in *.test.ts (packages/webrtc/tests)

実装方針の最後の論点は「相手が `a=max-message-size` を出さない場合の既定値」です。ここを誤ると互換性に影響するので、そこだけ確認してからタスク化します。

  │ "65536" in *.ts (packages/webrtc/src, packages/webrtc/tests)

● Web Search (MCP: github-mcp-server) · RFC 8841 default max-message-size if absent SDP data channe…

● Web Search (MCP: github-mcp-server) · WebRTC a=max-message-size absent default 65536 RFC 8841 · q…

# タスク詳細化: peer の `a=max-message-size` を尊重する修正

## 1. タスクの目的と背景

werift-webrtc の DataChannel 送信処理が、**相手 SDP の `a=max-message-size` で宣言された受信上限を見ずに送信している**ため、相手実装に想定外のサイズのメッセージを届けてしまいます。  
werift-webrtc 自身が直ちに壊れる類の不具合ではありませんが、**相手が宣言値を前提に固定長バッファ等を使っている場合、相手側で異常動作や脆弱性を誘発しうる**ため、送信側で拒否すべきです。

コード調査の結果、現状は以下です。

- `packages/webrtc/src/sdp.ts` で `a=max-message-size` は **SDP 解析・生成できている**
- `packages/webrtc/src/sdpManager.ts` ではローカル SDP に `a=max-message-size:65536` を載せている
- しかし `packages/webrtc/src/sctpManager.ts` / `packages/webrtc/src/peerConnection.ts` で、**remote SDP の `sctpCapabilities.maxMessageSize` が送信制御に反映されていない**
- 実際の送信経路である `packages/webrtc/src/dataChannel.ts` の `RTCDataChannel.send()` と `packages/webrtc/src/transport/sctp.ts` の `datachannelSend()` に、**サイズ上限チェックが存在しない**

## 2. 実装すべき具体的な機能や変更内容

### 必須変更

1. **remote の `max-message-size` を交渉結果として保持する**
   - `application` m-line の remote SDP から取得した `sctpCapabilities.maxMessageSize` を、SCTP 送信処理から参照できる場所に保持する
   - 実装箇所の第一候補は `RTCSctpTransport`、設定箇所の第一候補は `SctpTransportManager.setRemoteSCTP()`

2. **DataChannel 送信前にサイズ検証を入れる**
   - `RTCDataChannel.send(data)` の呼び出し時点、または `RTCSctpTransport.datachannelSend()` の入口で、**送信しようとしている 1 メッセージのバイト長**を算出し、remote 上限を超える場合は送信失敗にする
   - 失敗時は **キュー投入しない / bufferedAmount を増やさない / 統計を加算しない**

3. **文字列サイズの算出をバイト基準で統一する**
   - 現状 `RTCDataChannel.send()` は `Buffer.byteLength(data)` を使っている一方、`datachannelSend()` は `data.length` を使っており、**マルチバイト文字列で不整合**が起きる
   - 上限制御では必ず **`Buffer.byteLength()` / `Buffer.length` ベース**で統一する

4. **エラー時の挙動を明確にする**
   - このコードベースは DOMException ではなく `Error` を投げる実装が多いため、まずは **同期的に `Error` を throw** する方針が安全
   - メッセージは `max-message-size exceeded` 相当の明確な文言にする

### 変更対象として有力なファイル

| ファイル | 役割 |
|---|---|
| `packages/webrtc/src/transport/sctp.ts` | remote 上限の保持、送信サイズ検証の中核 |
| `packages/webrtc/src/sctpManager.ts` | remote SDP から `max-message-size` を transport に反映 |
| `packages/webrtc/src/dataChannel.ts` | 送信前の stats 更新順序見直し |
| `packages/webrtc/tests/datachannel/send.test.ts` | 送信失敗の回帰テスト |
| `packages/webrtc/tests/integrate/peerConnection.test.ts` または `tests/issue/*` | SDP 交渉込みの統合回帰テスト |

## 3. 技術的な実装アプローチを調査し結果を簡潔にまとめる

### 調査結果

- `a=max-message-size` 自体はすでに `SessionDescription.parse()` で `MediaDescription.sctpCapabilities` に入っている
- ローカル側は `RTCSctpTransport.getCapabilities()` により常に `65536` を広告している
- ただし remote 側の `sctpCapabilities` は **送信経路まで届いていない**
- そのため、修正の本質は **「SDP 解析」ではなく「交渉結果を送信ロジックへ配線すること」**

### 推奨アプローチ

1. `RTCSctpTransport` に remote 受信上限を保持するフィールド/メソッドを追加
   - 例: `setRemoteMaxMessageSize(size?: number)`
   - 属性未指定時の既定値は **65536 bytes**
   - `a=max-message-size:0` は **無制限** として扱う

2. 送信サイズ検証用の共通ヘルパーを 1 箇所に集約
   - 例: `getDataByteLength(data)` / `assertSendableMessageSize(size)`
   - `RTCDataChannel.send()` と `datachannelSend()` で別々に長さを解釈しない

3. チェックは **stats 更新前** に行う
   - 現状は `RTCDataChannel.send()` が先に `messagesSent` / `bytesSent` を加算しており、transport 側で throw すると統計が壊れる
   - そのため、**検証 → enqueue 成功 → stats 更新** の順に直すのが自然

4. テストは 2 層で追加
   - **機能テスト**: SDP を munging して remote answer の `a=max-message-size:10` を注入し、`send(Buffer.alloc(1024))` が失敗すること
   - **回帰テスト**: 上限超過時に `bufferedAmount` / `messagesSent` / `bytesSent` が増えないこと

### テスト実装のヒント

- `packages/webrtc/tests/issue/142.test.ts` のように、**raw SDP を文字列で与えるパターン**が既にある
- DataChannel の送受信テストは `packages/webrtc/tests/datachannel/send.test.ts` と `packages/webrtc/tests/integrate/peerConnection.test.ts` に寄せるのが既存構成に合う

## 4. 考慮すべき制約や注意点

- **仕様解釈**
  - `a=max-message-size` 未指定: **65536 bytes**
  - `a=max-message-size:0`: **無制限**
  - 上限超過時は **送信失敗** が期待動作
- **互換性**
  - 既存の通常サイズ送信は壊さない
  - ローカル SDP の広告値 `65536` を今回の修正で不用意に変えない
- **副作用**
  - 失敗送信で `bufferedAmount`、`messagesSent`、`bytesSent` が増えると別の不整合になる
- **文字列長**
  - `string.length` ではなく **実バイト長** で判定する
- **スコープ管理**
  - 今回は **peer が広告した受信上限の尊重** が主目的であり、DataChannel 全般の state validation 追加など別論点まで広げない
- **再現コードの扱い**
  - 添付の `max_message_size_server.ts` は手動再現には有用だが、修正受け入れの主軸は **自動テスト** に置くべき

## 5. 完了条件

- remote SDP の `a=max-message-size` が送信経路に反映される
- remote が `a=max-message-size:10` を広告した状態で、10 bytes 超の DataChannel メッセージ送信が **ローカルで失敗** する
- 上限超過時に **送信キューへ積まれず**、`bufferedAmount` / `messagesSent` / `bytesSent` が増えない
- `a=max-message-size` 未指定時は既定値 `65536` として扱われ、既存の通常送信テストが通る
- `a=max-message-size:0` を無制限として解釈できる
- `packages/webrtc` の既存 DataChannel/PeerConnection テストに回帰がない

以上を踏まえると、この修正は **「SDP で既に取得できている `max-message-size` を RTCSctpTransport の送信判定へ正しく配線し、送信前バイト長チェックと統計整合性を保証する」** タスクとして定義するのが適切です。