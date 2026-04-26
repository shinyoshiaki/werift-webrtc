## 1. タスクの目的と背景

werift-webrtc の DataChannel 送信処理が、**相手 SDP の `a=max-message-size` で宣言された受信上限を見ずに送信している**ため、相手実装に想定外のサイズのメッセージを届けてしまいます。  
werift-webrtc 自身が直ちに壊れる類の不具合ではありませんが、**相手が宣言値を前提に固定長バッファ等を使っている場合、相手側で異常動作や脆弱性を誘発しうる**ため、送信側で拒否すべきです。

RFC 8841 Section 6.1 では、`max-message-size` は **その SDP を送る側が「受信できる最大 SCTP user message size」** を示す属性であり、**SCTP endpoint MUST NOT send a message larger than the maximum size indicated by the peer** とされています。  
つまりこの値は「双方で 1 つに合意する対称パラメータ」ではなく、**ローカル送信時には remote が広告した値を尊重する**ことが本質です。

コード調査の結果、現状は以下です。

- `packages/webrtc/src/sdp.ts` で `a=max-message-size` は **SDP 解析・生成できている**
- `packages/webrtc/src/sdpManager.ts` ではローカル SDP に `a=max-message-size:65536` を載せているが、現状は固定値でありユーザ設定できない
- しかし `packages/webrtc/src/sctpManager.ts` / `packages/webrtc/src/peerConnection.ts` で、**remote SDP の `sctpCapabilities.maxMessageSize` が送信制御に反映されていない**
- 実際の送信経路である `packages/webrtc/src/dataChannel.ts` の `RTCDataChannel.send()` と `packages/webrtc/src/transport/sctp.ts` の `datachannelSend()` に、**サイズ上限チェックが存在しない**

## 2. 実装すべき具体的な機能や変更内容

### 必須変更

1. **remote の `max-message-size` を送信判定用の peer 受信上限として保持する**
   - `application` m-line の remote SDP から取得した `sctpCapabilities.maxMessageSize` を、SCTP 送信処理から参照できる場所に保持する
   - 実装箇所の第一候補は `RTCSctpTransport`、設定箇所の第一候補は `SctpTransportManager.setRemoteSCTP()`
   - 命名は `remoteMaxMessageSize` など、**「peer が受信可能と宣言した上限」** であることが分かるものを優先する
   - remote SDP に属性がない場合は **RFC 8841 Section 6.1 に従い 65536 bytes (64K)**、`a=max-message-size:0` の場合は **無制限** として扱う

2. **DataChannel 送信前にサイズ検証を入れる**
   - `RTCDataChannel.send(data)` の呼び出し時点、または `RTCSctpTransport.datachannelSend()` の入口で、**送信しようとしている 1 メッセージのバイト長**を算出し、**peer が広告した受信上限**を超える場合は送信失敗にする
   - 失敗時は **キュー投入しない / bufferedAmount を増やさない / 統計を加算しない**

3. **文字列サイズの算出をバイト基準で統一する**
   - 現状 `RTCDataChannel.send()` は `Buffer.byteLength(data)` を使っている一方、`datachannelSend()` は `data.length` を使っており、**マルチバイト文字列で不整合**が起きる
   - 上限制御では必ず **`Buffer.byteLength()` / `Buffer.length` ベース**で統一する

4. **エラー時の挙動を明確にする**
   - このコードベースは DOMException ではなく `Error` を投げる実装が多いため、まずは **同期的に `Error` を throw** する方針が安全
   - メッセージは `max-message-size exceeded` 相当の明確な文言にする

5. **werift が広告する local の `max-message-size` を PeerConfig で設定可能にする**
   - `packages/webrtc/src/peerConnection.ts` の `PeerConfig` に、werift 自身が local SDP で広告する `max-message-size` の設定項目を追加する
   - 既定値は従来どおり **65536 bytes (64K)** を維持し、未指定時の互換性を壊さない
   - `0` を指定した場合は **無制限** として `a=max-message-size:0` を広告できるようにする
   - この設定は **local が相手に広告する受信上限** であり、remote の `max-message-size` を見る送信制御とは別概念として扱う

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
- RFC 8841 Section 6.1 では、`max-message-size` は **各 endpoint が自分の受信上限を相手に伝える属性** であり、値は **direction ごとに独立** してよい
- RFC 8841 Section 10.3 でも、**answer 側の `max-message-size` は offer の値と独立** と明記されている
- WebRTC 仕様の `RTCSctpTransport.maxMessageSize` は `remote max-message-size` と実装自身の送信可能サイズから導出されるが、今回の不具合の直接原因は **peer が広告した受信上限が送信経路に配線されていないこと**
- そのため、修正の本質は **「SDP 解析」ではなく「peer が広告した受信上限を送信ロジックへ配線すること」**

### 推奨アプローチ

1. `RTCSctpTransport` に peer の受信上限を保持するフィールド/メソッドを追加
   - 例: `setRemoteMaxMessageSize(size?: number)`
   - 属性未指定時の既定値は **RFC 8841 準拠で 65536 bytes (64K)**
   - `a=max-message-size:0` は **無制限** として扱う
   - ここで保持するのは **remote が受信可能と広告した値** であり、**local が広告した値との min を事前計算した「対称交渉値」ではない** ことを明確にする

2. 送信サイズ検証用の共通ヘルパーを 1 箇所に集約
   - 例: `getDataByteLength(data)` / `assertSendableMessageSize(size)`
   - `RTCDataChannel.send()` と `datachannelSend()` で別々に長さを解釈しない

3. チェックは **stats 更新前** に行う
   - 現状は `RTCDataChannel.send()` が先に `messagesSent` / `bytesSent` を加算しており、transport 側で throw すると統計が壊れる
   - そのため、**検証 → enqueue 成功 → stats 更新** の順に直すのが自然

4. テストは 2 層で追加
   - **機能テスト**: SDP を munging して remote answer の `a=max-message-size:10` を注入し、`send(Buffer.alloc(1024))` が失敗すること
   - **回帰テスト**: 上限超過時に `bufferedAmount` / `messagesSent` / `bytesSent` が増えないこと
   - **仕様テスト**: remote SDP で `a=max-message-size` を省略した場合は 65536 bytes 扱い、`a=max-message-size:0` の場合は無制限扱いになること
   - **文字列テスト**: マルチバイト文字列で `string.length` ではなく実バイト長で判定されること

### テスト実装のヒント

- `packages/webrtc/tests/issue/142.test.ts` のように、**raw SDP を文字列で与えるパターン**が既にある
- DataChannel の送受信テストは `packages/webrtc/tests/datachannel/send.test.ts` と `packages/webrtc/tests/integrate/peerConnection.test.ts` に寄せるのが既存構成に合う

## 4. 考慮すべき制約や注意点

- **仕様解釈**
  - `a=max-message-size` は **「その endpoint が受信できる上限」** の広告であり、ローカル送信時は **remote が広告した値** を見る
  - `a=max-message-size` 未指定: **RFC 8841 Section 6.1 により 65536 bytes (64K)**
  - `a=max-message-size:0`: **無制限**
  - answer の `max-message-size` は offer と独立であり、**local の広告値をそのまま remote 送信制御に使わない**
  - 上限超過時は **送信失敗** が期待動作
- **互換性**
  - 既存の通常サイズ送信は壊さない
  - ローカル SDP の既定広告値 `65536` は今回の修正でも既定のまま維持しつつ、PeerConfig で上書き可能にする
- **再ネゴシエーション**
  - offer/answer の更新で remote の `a=max-message-size` が変わった場合、**最新の remote description の値** に追従する
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
- `a=max-message-size` 未指定時は **RFC 8841 準拠で既定値 `65536`** として扱われ、既存の通常送信テストが通る
- `a=max-message-size:0` を無制限として解釈できる
- マルチバイト文字列でも **実バイト長** ベースで正しく上限判定される
- `PeerConfig.maxMessageSize` で werift が local SDP に広告する `a=max-message-size` を任意の値へ変更でき、未指定時は **65536**、`0` 指定時は **無制限** を広告できる
- `packages/webrtc` の既存 DataChannel/PeerConnection テストに回帰がない

以上を踏まえると、この修正は **「SDP で既に取得できている peer の `max-message-size` を RTCSctpTransport の送信判定へ正しく配線し、RFC 8841 に沿った送信前バイト長チェックと統計整合性を保証する」** タスクとして定義するのが適切です。

## Requirements

- weriftが広告するmax-message-sizeの設定をpackages/webrtc/src/peerConnection.tsのPeerConfigに追加して任意の値をユーザが設定できるようにしてください
- 既定値は65536のまま維持し、`0` を含む任意の non-negative integer を広告値として指定できるようにしてください
