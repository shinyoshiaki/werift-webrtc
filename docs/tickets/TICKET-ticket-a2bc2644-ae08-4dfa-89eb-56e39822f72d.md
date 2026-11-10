# [SDP] IPアドレス省略形式のa=rtcpを正しくパース・シリアライズする（#355）

## 元報告と判定

元Issue: #355（tylerlong, "support rtcp without address"）。**妥当（developの実装で確認）**。
関連: #356（RingCentral の SIP/WebRTC ゲートウェイから受け取った offer に `a=rtcp:48037` が含まれる）。

RFC 3605 §2.1 の文法は次のとおりで、アドレス部分は省略できる。

```
rtcp-attribute = "a=rtcp:" port [nettype space addrtype space connection-address] CRLF
```

`m=audio 49170 RTP/AVP 0` / `a=rtcp:53020` は正しい SDP。省略時の RTCP アドレスは media-level の `c=`、それがなければ session-level の `c=` と同じになる。

現在の develop の実装は次のとおり。

- **パース**（`packages/webrtc/src/sdp.ts` L203–209）: `divide(value, " ")` の残りを必ず `ipAddressFromSdp(rest)` に渡す。`a=rtcp:53020` では `rest === ""` になり、`ipAddressFromSdp()`（L591–595）の `/^IN (IP4|IP6) ([^ ]+)$/` にマッチせず `throw new Error("exception")` で落ちる。その結果、`setRemoteDescription()` 全体が失敗する。
- **ポート検証なし**: `Number.parseInt(port)` の結果が `NaN`、0、65536 以上でもそのまま `rtcpPort` に入る。
- **シリアライズ**（L502–507）: `if (this.rtcpPort && this.rtcpHost)` の中でしか `a=rtcp` を出さず、さらに `a=rtcp-mux` も同じ if の内側にある。そのため次の問題がある。
  - アドレスを省略した `a=rtcp:<port>` を保持できない。
  - `a=rtcp` を持たず `a=rtcp-mux` だけを持つ m-section（RFC 8843/JSEP の典型）を再シリアライズすると `a=rtcp-mux` が消える。`RTCPeerConnection.remoteDescription` は `SessionDescription.toJSON()` で再シリアライズするので（`sdpManager.ts` L59–64）、利用者には実際に受け取った SDP と違う内容が見える。

## 1. 目的と背景

- RFC 3605 準拠の SIP/WebRTC ゲートウェイ（RingCentral、FreeSWITCH、Asterisk など）から来る、アドレスを省略した `a=rtcp` を例外なく受け入れて、相互接続できない状態を解消する。
- パースしてからシリアライズしたときに `a=rtcp` と `a=rtcp-mux` の情報が欠けないようにし、`remoteDescription.sdp` の再現性を保つ。
- malformed な `a=rtcp` は原因がわかるエラーで弾く。いまのメッセージは `"exception"` だけで、原因を特定できない。

## 2. 実装すべき変更内容

### 2.1 パース（`SessionDescription.parse` の `case "rtcp"`）

- `value` を空白で分割し、トークン数で分岐する。
  - 1トークン（`<port>`）: `rtcpPort = port`、`rtcpHost = undefined`。
  - 4トークン（`<port> IN IP4|IP6 <address>`）: `rtcpPort = port`、`rtcpHost = address`。
  - それ以外（2・3トークン、5トークン以上、`IN` 以外の nettype、`IP4`/`IP6` 以外の addrtype）はパースエラーにする。
- port は `/^\d+$/` で検証し、1–65535 の範囲外ならエラーにする。ICE を使う場合の慣例値 `9` は有効値。
- エラーメッセージは `a=rtcp` の行の内容を含める（例: `` invalid a=rtcp attribute: "abc IN IP4 1.2.3.4" ``）。
- addrtype とアドレスの組み合わせ（`IP4` なのに `isIPv4` が false、など）をどこまで検証するかは実装時に決める。FQDN は RFC 4566 上 connection-address として有効なので、**IP4/IP6 + 任意トークンは受理する**のが安全（後述 4.3）。
- `a=rtcp` の値を扱う `rtcpAttributeFromSdp()` / `rtcpAttributeToSdp()` のような小さな関数を `sdp.ts` 内に切り出し、単体テストしやすくする。`ipAddressFromSdp()` 自体は `c=` のパースでも使っているので、そちらの挙動は変えない。

### 2.2 シリアライズ（`MediaDescription.toString()`）

- `rtcpPort !== undefined` なら `a=rtcp:<port>` を出力する。`rtcpHost` があるときだけ ` IN IP4|IP6 <host>` を付ける。
- `a=rtcp-mux` は `rtcpMux === true` で独立して出力する（`a=rtcp` の if から外す）。
- 行の順序（`a=msid` → `a=rtcp` → `a=rtcp-mux` → `a=ssrc-group` …）は変えない。werift が生成した SDP の差分を最小限にするため。

### 2.3 有効 RTCP アドレスの扱い

- 省略時の `rtcpHost` は `undefined` のまま保持する。継承した値で埋めるとシリアライズ時に省略形式を保持できなくなるため、継承値は書き込まない。
- 有効アドレスは「`rtcpHost ?? media.host ?? session.host`」で解決できる。werift の内部では `rtcpHost` を参照していない（grep の結果、参照は `sdpManager.ts` L102 の書き込みだけ）。そのため**新しい公開 getter は必須ではない**。追加する場合は `SessionDescription` 側に置くヘルパー（session.host が必要なため）とし、TSDoc で RFC 3605 の継承規則を説明する。追加するかどうかは実装時に判断し、追加した場合は `npm run doc` と changelog の更新を伴う。

### 2.4 拒否・停止 m-line の `rtcpMux` を削除（4.1 で決定）

- `createRejectedMediaDescription()`（`sdpManager.ts` L162）の `media.rtcpMux = true;` を削除する。2.2 を適用した後も、拒否・停止 m-line（port 0）の出力に `a=rtcp-mux` が現れないようにするため。
- 同じ関数の TSDoc に 1 行足す。内容は「拒否 m-line は RTP/RTCP を流さないので `a=rtcp` / `a=rtcp-mux` を載せない。#705 以降の出力形式を保つ」。

### 2.5 `MediaDescription` の TSDoc

- `rtcpPort` / `rtcpHost` / `rtcpMux` に、`rtcpHost` が `undefined` のときは `c=` を継承する（RFC 3605）ことと、`rtcpMux` が `a=rtcp` と独立していることを TSDoc で書く。生成ドキュメント `doc/classes/MediaDescription.md` は `npm run doc` で再生成する。

## 3. 技術調査結果

| 箇所 | 現状 | 変更 |
| --- | --- | --- |
| `packages/webrtc/src/sdp.ts` L203–209 `case "rtcp"` | `ipAddressFromSdp(rest)` を必ず呼ぶ | トークン数で分岐し、port を検証する |
| `packages/webrtc/src/sdp.ts` L502–507 | `rtcpPort && rtcpHost` のときだけ `a=rtcp` と `a=rtcp-mux` を出す | 両者を別々に出力する |
| `packages/webrtc/src/sdp.ts` L591–595 `ipAddressFromSdp` | `throw new Error("exception")` | `c=` 用なので挙動は維持する（メッセージ改善は任意） |
| `packages/webrtc/src/sdp.ts` L597–600 `ipAddressToSdp` | `isIPv4` 以外はすべて `IP6` | `a=rtcp` でも再利用する（FQDN の扱いは 4.3） |
| `packages/webrtc/src/sdpManager.ts` L102–104 | RTP m-section は常に `rtcpHost="0.0.0.0"`、`rtcpPort=9`、`rtcpMux=true` | 変更不要（出力は同じ） |
| `packages/webrtc/src/sdpManager.ts` L139–169 `createRejectedMediaDescription` | `rtcpMux = true` だが `rtcpPort` が未設定なので、**今は `a=rtcp-mux` が出ていない** | L162 の `media.rtcpMux = true;` を削除し、出力を今と同じに保つ（4.1、決定済み） |
| `createMediaDescriptionForSctp` | `rtcpMux` 未設定（false） | 影響なし |

- `divide()`（`helper.ts`）は `split` 後に残りを join するだけなので、トークンを厳密に検証するには `value.split(" ")` で直接扱う方が素直。連続した空白や末尾の空白は、RFC 4566 の文法では単一の SP なのでエラー扱いでよい。ただし実機の SDP で問題が出るなら、`trim` してから分割することも検討する。
- RingCentral の SDP（#356）は session-level に `c=IN IP4 208.87.41.111` があり、media-level には `c=` がなく、`a=rtcp-mux` と `a=rtcp:48037` を併記している。この SDP は `rtcpHost === undefined` で、有効アドレスは session の `208.87.41.111` になる。#356 の本題（ssrc なし offer での `ssrcReceiver not found`）は別問題なので、このチケットでは扱わない。

## 4. 制約・注意点

### 4.1 werift が生成する SDP の変化 → **決定: 案 A（拒否 m-line の `rtcpMux = true` を削除し、生成 SDP をバイト単位で今と同じに保つ）**

`a=rtcp-mux` を独立して出力すると、`createRejectedMediaDescription()` が作る拒否・停止 m-line（port 0）に新しく `a=rtcp-mux` が付いてしまう。検討した 2 案は次のとおり。

- **案 A（採用）**: `media.rtcpMux = true` を削除し、生成 SDP を今と同じに保つ。
- 案 B（不採用）: 拒否 m-line にも `a=rtcp-mux` を出す。negotiation テスト・negotiation-diff の更新と、E2E での相互接続確認が必要になる。

案 A を選んだ根拠（コードで確認済み）:

1. **`rtcpMux` を読むコードがない。** `packages/` 全体を grep すると、`.rtcpMux` が出てくるのは書き込み 2 か所（`sdpManager.ts` L104 と L162）、パース（`sdp.ts` L211）、シリアライズ（`sdp.ts` L504）だけだった。拒否 m-line の `rtcpMux = true` は出力にしか効かず、削除しても挙動は変わらない。
2. **今の出力形式は実機で確認済み。** `rtcpMux = true` は #705 対応（`816195b7c` 非対応 RTP m-line を Answer 側で reject し、停止済み位置を再利用する）で入った。このとき `rtcpPort` を設定していないので、拒否 m-line に `a=rtcp-mux` は**一度も出力されたことがない**。Chrome との reuse / removeTrack E2E（`e2e/tests/mediachannel/reuse.test.ts` など）も、`a=rtcp-mux` なしの形で通っている。案 B はこの出力を変えるので、相互接続をもう一度確かめる必要が出るが、得るものがない。
3. **拒否 m-line は RTP/RTCP を流さない**（port 0、RFC 3264 §6）。RTCP を多重化するかどうかを宣言する意味がない。BUNDLE / rtcp-mux の扱いは、生きている m-line の `a=rtcp:9 IN IP4 0.0.0.0` + `a=rtcp-mux`（L102–104、変更なし）で決まる。
4. **このチケットの目的は SDP の「パース・再シリアライズの忠実性」だけ。** 生成 SDP の形式を変える案 B はスコープ外の挙動変更になる。

案 A を選んだ場合の影響範囲:

- **werift が生成する SDP**（offer / answer / 拒否 m-line / SCTP m-line）は develop とバイト単位で同じ。`rtcpMuxPolicy: "require"` を前提とした BUNDLE / ICE の接続挙動も変わらない。
- **変わるのは、パースしてから再シリアライズする SDP だけ。** 具体的には `remoteDescription.sdp` と、ユーザーが文字列で渡した `setLocalDescription()` の SDP。ここでは入力にあった `a=rtcp-mux` と `a=rtcp:<port>` が残るようになる。たとえば Chrome の拒否 m-line に `a=rtcp-mux` があれば、remote 側の表示に残る。これは入力に忠実になるという改善で、回帰ではない。
- negotiation の不変条件、`tools/negotiation-diff` の再利用契約、PBT の generator / wireMutations には手を入れない。

### 4.2 パースを厳しくすることによる後方互換

今まで `NaN` で通っていた不正な port（例: `a=rtcp:abc`）が新しくエラーになる。`a=rtcp` は werift 内部では使っていないので、エラーにせず無視する方針もありうる。ただしリポジトリ方針（protocol validation を黙らせない）と元チケットの方針 3 に従い、**エラーにする**。どちらにしたかと変更内容は changelog に書く。

### 4.3 FQDN・addrtype の保持

`ipAddressToSdp()` は `isIPv4` が false のものをすべて `IP6` として出力する。そのため `a=rtcp:53020 IN IP4 host.example.com` は `IN IP6 host.example.com` に化ける。この問題は `c=` にも以前からある。このチケットの最低ラインは IPv4 / IPv6 リテラルの round trip とする。FQDN で addrtype を保持するには、`rtcpAddressType` のような新フィールドを足す必要があり、公開 API が増える。その場合は別チケットに切り出すか、実装時にスコープを判断して記録する。

### 4.4 リポジトリ規約

- テストは Arrange / Act / Assert で書き、Act / Assert には日本語コメントを付ける。Arrange 用の SDP 組み立ては、そのテスト領域で 1 つの共有ユーティリティにまとめる（例: `packages/webrtc/tests/sdpUtils.ts`）。
- 他の実装の SDP を作るテストは `tests/negotiation/cases` に置かない（package AGENTS.md）。パーサーの単体テストは `tests/sdp.test.ts`、#356 の実 SDP は `tests/issue/355.test.ts` に置く。
- `enum` やパラメータプロパティは使わない（erasableSyntaxOnly）。
- 公開型の TSDoc を変えたら `npm run doc` で再生成し、`changelog.md` に Bug fix として追記する。

## 5. 回帰テスト

`packages/webrtc/tests/sdp.test.ts`（パーサーとシリアライザーの単体テスト）:

- [ ] `a=rtcp:53020` → `rtcpPort === 53020`、`rtcpHost === undefined`。再シリアライズすると `a=rtcp:53020` がそのまま出る。
- [ ] `a=rtcp:53020 IN IP4 192.0.2.1` の round trip。
- [ ] `a=rtcp:53020 IN IP6 2001:db8::1` の round trip。
- [ ] media-level の `c=` だけがある場合、session-level の `c=` だけがある場合、両方ある場合に、`rtcpHost` が `undefined` のまま残り、`media.host` / `session.host` から有効アドレスを解決できる。ヘルパーを追加した場合はその戻り値も確認する。
- [ ] `a=rtcp-mux` だけ（`a=rtcp` なし）の場合、`rtcpMux === true`、`rtcpPort === undefined` で、再シリアライズ後も `a=rtcp-mux` が残る。
- [ ] `a=rtcp:9 IN IP4 0.0.0.0` と `a=rtcp-mux` を併記した場合の round trip（werift 自身が生成する形）。
- [ ] invalid な値がわかりやすいエラーになる: `a=rtcp:`、`a=rtcp:abc`、`a=rtcp:0`、`a=rtcp:65536`、`a=rtcp:53020 IN`、`a=rtcp:53020 IN IP4`、`a=rtcp:53020 IN IP5 1.2.3.4`、`a=rtcp:53020 XX IP4 1.2.3.4`、`a=rtcp:53020 IN IP4 1.2.3.4 extra`。

`packages/webrtc/tests/issue/355.test.ts`:

- [ ] #356 の RingCentral offer（`c=` は session-level だけ、`a=rtcp-mux` と `a=rtcp:48037`）が `SessionDescription.parse` で例外にならない。
- [ ] 同じ offer を `RTCPeerConnection.setRemoteDescription()` に渡すと成功し、`createAnswer()` まで進む。`remoteDescription.sdp` に `a=rtcp:48037` と `a=rtcp-mux` が残っている。

既存テスト:

- [ ] `tests/issue/141.test.ts`、`142.test.ts`、`tests/integrate/peerConnection.test.ts`（`a=rtcp:10101 IN IP4 203.0.113.100` など）が変更なしで通る。
- [ ] `tests/issue/705.test.ts` / `705-reuse.test.ts`（拒否・停止 m-line）が変更なしで通る。

案 A の出力互換を固定するテスト（`tests/issue/705.test.ts` の既存ケースに Assert を追加する）:

- [ ] Answer 側で非対応 RTP m-line を reject したとき、拒否 m-section（port 0）に `a=rtcp-mux` と `a=rtcp:` が含まれない。
- [ ] `stop()` した transceiver が次の offer で port 0 になったとき、その m-section に `a=rtcp-mux` と `a=rtcp:` が含まれない。
- [ ] 同じ SDP 内の生きている RTP m-section には、`a=rtcp:9 IN IP4 0.0.0.0` と `a=rtcp-mux` が今までどおり含まれる。

## 6. 検証コマンド

```bash
cd packages/webrtc
npm run type
npx vitest run tests/sdp.test.ts tests/issue/355.test.ts
npm test
```

- 公開 API や TSDoc を変えた場合は、ルートで `npm run type`、`npm run test:small`、`npm run doc` も実行する。
- 4.1 で案 A に決めたので、生成 SDP は変わらない。`npm run pbt:deep`、`npm run e2e`、negotiation-diff の再利用契約の更新は**必須ではない**。`npm test` にはパッケージの negotiation テストと PBT の固定シーンが含まれるので、これで生成形式の回帰を検出できる。
- 任意: 生成 SDP が変わっていないことを裏付けたい場合は、`tools/negotiation-diff`（`run.ts` 冒頭の手順、一時 worktree で develop と比較）を `--check` 付きで実行し、差分 0 を確認する。
- 最後に `npm run format` を実行する。

## 7. 完了条件

- [ ] RFC 3605 のアドレス省略形式（`a=rtcp:<port>`）とアドレス付きの形式（IPv4 / IPv6）を、例外なくパースできる。
- [ ] パースした内容をシリアライズすると、`a=rtcp` と `a=rtcp-mux` が欠けずに出力される（省略形式は省略形式のまま）。
- [ ] `a=rtcp-mux` の出力が `a=rtcp` の有無に依存しない。
- [ ] malformed な port、アドレス、余分なトークンが、行の内容を含むパースエラーになる。
- [ ] #356 の RingCentral SDP を `setRemoteDescription()` できる。
- [ ] 拒否・停止 m-line の `rtcpMux = true` を削除し（4.1 案 A）、werift が生成する SDP が develop と同じであることをテストで固定する。拒否 m-section に `a=rtcp-mux` / `a=rtcp:` が出ず、生きている RTP m-section には今までどおり出ることを確認する。
- [ ] 既存の negotiation・統合・#705 テストが、期待値を変えずにすべて通る。
- [ ] TSDoc、`doc/`、`changelog.md` を更新する（公開 API に変更がある場合）。
