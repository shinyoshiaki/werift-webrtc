## Summary

werift's TURN client does not follow a TURN `300 Try Alternate` response containing `ALTERNATE-SERVER`.

This is an interoperability problem with TURN deployments that intentionally redirect an initial Allocate request to a regional or unicast relay.

A concrete production example is Microsoft Minecraft Realms: the Realm TURN endpoint returns `300 Try Alternate` on the first Allocate. Native libwebrtc follows the redirect and connects; werift 0.24.4 treats the response as a terminal `TransactionFailed`, gathers no relay candidate, and ICE eventually times out.

## Current behavior

`TurnProtocol.connectionMade()` sends Allocate through:

```ts
await this.requestWithRetry(request, this.server)
```

but `requestWithRetry()` only handles:

- `401 Unauthorized`
- `438 Stale Nonce`

All other TURN error responses are rethrown.

Current logic:

```ts
if (
  ((errorCode === 401 && realm) || (errorCode === 438 && this.realm)) &&
  nonce
) {
  // retry auth
} else {
  throw error;
}
```

The STUN attribute implementation already supports:

```ts
[0x8023, "ALTERNATE-SERVER", packAddress, unpackAddress]
```

so the missing piece is redirect handling in the TURN client.

## Standards behavior

RFC 8656 §7.4 says that on Allocate error `300 (Try Alternate)`, the client SHOULD try the Allocate request with the server specified by `ALTERNATE-SERVER` before trying other servers.

https://www.rfc-editor.org/rfc/rfc8656.html

RFC 8489 §10 defines the redirect procedure:

- retry against `ALTERNATE-SERVER`
- use the same transport protocol
- reuse the credentials that would have been used for the original server
- prevent redirect loops (a server already tried for this request within the last five minutes must not be followed again)
- for TLS/DTLS, honor `ALTERNATE-DOMAIN` when applicable

https://www.rfc-editor.org/rfc/rfc8489.html#section-10

## Downstream reproduction

PrismarineJS/node-nethernet reproduced this on a real Minecraft Bedrock Realm:

- stock werift 0.24.4: Realm connection times out
- native `@roamhq/wrtc` / libwebrtc: succeeds
- werift 0.24.4 plus a downstream pre-probe that rewrites the TURN URL to the returned `ALTERNATE-SERVER`: join + reconnect succeed with a live packet stream

Downstream PR:
https://github.com/PrismarineJS/node-nethernet/pull/29

The downstream workaround sends an unauthenticated Allocate probe, parses `300 + ALTERNATE-SERVER`, rewrites the configured TURN URL, and then lets werift perform its normal 401 authentication flow against the alternate server.

## Expected behavior

For an initial Allocate:

1. send Allocate to configured TURN server
2. receive `300 Try Alternate` with `ALTERNATE-SERVER`
3. consider the current transaction failed
4. retry Allocate against the alternate using the same transport protocol and credentials
5. continue normal `401 -> authenticated Allocate` handling
6. gather the relay candidate normally

## Implementation considerations

### UDP

For UDP, the existing transport can send to another server address, so the redirect can likely update the TURN server target and retry with a fresh transaction ID.

### TCP / TLS

For stream transports, following the redirect requires reconnecting the underlying transport to the alternate server. TLS also needs the RFC 8489 `ALTERNATE-DOMAIN` certificate-validation behavior.

It would be reasonable to land UDP support first if stream-transport redirect handling needs a separate change, but the API/logic should avoid silently treating 300 as authentication failure.

### Loop prevention

Track redirect targets for an allocation/request and reject ping-pong redirects as required by RFC 8489.

## Tests

Suggested tests:

1. Allocate receives `300 + ALTERNATE-SERVER` -> retries alternate
2. alternate returns `401` -> normal nonce/realm authentication succeeds
3. successful Allocate returns relay candidate from alternate
4. `300` without `ALTERNATE-SERVER` fails cleanly
5. redirect loop is rejected
6. credentials are preserved across the redirect
7. UDP redirect interoperability test
8. TCP/TLS redirect tests if supported in the same change

This issue is present on current `develop` and is confirmed against werift 0.24.4 in downstream production interoperability testing.
---

# 詳細化（コードベース調査結果）

## 1. 目的と背景

- werift の TURN クライアント（`packages/ice/src/turn/protocol.ts`）は Allocate に対する `300 Try Alternate` を終端エラー（`TransactionFailed`）として扱うため、リダイレクト型の TURN デプロイ（例: Minecraft Realms）で relay 候補が得られず ICE がタイムアウトする。
- RFC 8656 §7.4 / RFC 8489 §10 に従い、**Allocate に限り** `ALTERNATE-SERVER` へ同一トランスポート・同一クレデンシャルで再試行し、ループを防止する。
- 下流（PrismarineJS/node-nethernet#29）の「事前プローブで TURN URL を書き換える」ワークアラウンドを不要にすることがゴール。

## 2. 現状のコード（調査結果）

| 箇所 | 内容 |
| --- | --- |
| `packages/ice/src/turn/protocol.ts` `TurnProtocol.connectionMade()` | Allocate を `requestWithRetry(request, this.server)` で 1 回送るだけ。 |
| 同 `requestWithRetry()` | `401`（REALM+NONCE あり）/ `438`（既存 realm あり）を **1 回だけ** 再送。再送先は常に `this.server`。それ以外の `TransactionFailed` は rethrow。Allocate / Refresh / CreatePermission / ChannelBind で共用。 |
| 同 `request()` | `integrityKey` があると同一 `Message` に USERNAME/REALM/NONCE/MESSAGE-INTEGRITY/FINGERPRINT を `setAttribute` で追記する。`resolveRequestTarget()` は `addressEquals(addr, this.server)` または stream の場合 `selectServerEndpoint()`（初回解決結果を `pinnedServerEndpoint` に固定、`serverEndpointSelection` にキャッシュ）を使う。 |
| 同 `createTurnClient()` | `transport` 種別ごとに `UdpTransport.init(selectTurnUdpSocketType(address, udpFamily))` / `TcpTransport.init(address)` / `TlsTransport.init(address, tlsOptions)` を作り `TurnProtocol` に渡す。失敗時は `turn.close()` してから rethrow。 |
| `packages/ice/src/stun/transaction.ts` `Transaction.responseReceived()` | `expectedAddr` と送信元が一致しない応答は無視。`integrityKey` 指定時は MESSAGE-INTEGRITY のない応答も無視。ERROR クラスは `TransactionFailed(message, addr)` で reject。 |
| `packages/ice-server/src/stun/attributes.ts` | `0x8023 ALTERNATE-SERVER`（`packAddress`/`unpackAddress`、IP literal の `[host, port]`）と `0x8003 ALTERNATE-DOMAIN`（文字列）は定義済み。`packages/ice/src/stun/attributes.ts` は re-export。 |
| `packages/ice/src/ice.ts` (~L578) | `createStunOverTurnClient` が UDP で失敗すると同じサーバへ TCP でフォールバック。300 を処理しないと TCP でも同じ 300 を受けて失敗する。 |
| `packages/common/src/transport.ts` `TlsTransport` | `tls.connect({...options, host, port})`。`servername` は未指定（Node は host から SNI / 証明書検証名を決める）。 |
| `packages/ice-server/src/turn/protocol.ts` | テスト用リファレンス TURN サーバ。300 を返す機能は無い。 |

## 3. 実装すべき変更

### 3.1 Allocate リダイレクト処理（`TurnProtocol`）

- `connectionMade()` に Allocate 専用のリダイレクトループを追加する（`requestWithRetry()` 自体は Refresh/CreatePermission/ChannelBind と共用なので 300 を追わせない）。
  1. 現在のサーバへ Allocate（既存の 401/438 処理込み）。
  2. `TransactionFailed` かつ `ERROR-CODE` が `300` の場合:
     - `ALTERNATE-SERVER` が無い → リダイレクトせず失敗（エラーメッセージで 300 / ALTERNATE-SERVER 欠落と分かるようにする。認証失敗と誤認させない）。
     - 既に試行済みのサーバ（`addressEquals` で正規化比較、初期サーバの解決済み端点も含む）→ ループとして失敗。
     - 最大リダイレクト回数（例: 3〜5）を超える → 失敗。
     - それ以外 → 現在のサーバを `ALTERNATE-SERVER` に切り替え、**新しい Allocate Message（新トランザクション ID）** を作って再試行。
  3. 成功レスポンスから `XOR-RELAYED-ADDRESS` / `XOR-MAPPED-ADDRESS` / `LIFETIME` を読み、以降は通常どおり `refresh()`。
- サーバ切替時の状態更新:
  - `this.server`（以降 Refresh / CreatePermission / ChannelBind / `resolveRequestTarget` の比較に使われる）を alternate に更新する。設定値を残したい場合は `configuredServer` 等の読み取り専用フィールドを別途持つ。
  - `pinnedServerEndpoint` / `serverEndpointSelection` をリセットし、alternate（IP literal）を新しい端点として固定する。
  - `nonce` / `realm` / `integrityKey` はサーバ固有なのでクリアし、alternate では未認証 Allocate → `401` → 認証付き Allocate の通常フローに戻す。`username` / `password` は保持（RFC 8489 §10「クレデンシャルを再利用」）。
- 同一 `Message` の使い回しは避ける。認証済みリクエストに対して 300 が返った場合、既に MESSAGE-INTEGRITY / FINGERPRINT 付きの Message に再度 `addMessageIntegrity` すると HMAC が古い属性を含んで計算される恐れがあるため、試行ごとに `LIFETIME` + `REQUESTED-TRANSPORT` だけの Allocate を新規生成する。

### 3.2 トランスポート別の扱い

- **UDP**: 同じソケットのまま送信先を alternate に変える。`resolveRequestAddress(alt, transport.addressFamily)` が `AddressFamilyMismatch` を投げる場合（udp4 ソケットに IPv6 alternate 等）はそのまま失敗させる（握りつぶさない）。
- **TCP/TLS**: 既存の接続は別サーバに繋がっているため再接続が必要。推奨方式:
  - `TurnProtocol` の `options` に `reconnect?: (server: Address, alternateDomain?: string) => Promise<Transport>` のようなファクトリを追加し、`createTurnClient()` がトランスポート生成ロジック（`connectTimeoutMs` / `tlsOptions` を含む）を渡す。
  - 切替時は旧 transport を close → 新 transport を生成 → `transport.onData` を再設定 → `tcpBuffer` をリセット。
  - TLS は証明書検証名を `ALTERNATE-DOMAIN` があればそれ、無ければ元の設定ホスト名にする（`tlsOptions.servername` を設定。元が IP literal の場合 SNI に IP は使えないため `servername` は付けず、検証方法を明記する）。
  - ファクトリ未指定の stream トランスポート（`new TurnProtocol(...)` を直接使うケース）では、明確なエラーで失敗させる。
  - 範囲が膨らむ場合は UDP を先行マージし、TCP/TLS は「300 + ALTERNATE-SERVER を受けたが stream redirect 未対応」という明確なエラーで失敗させる形でも可（チケット本文の方針どおり）。
- 300 応答の認証: 認証済みリクエストに対する 300 は既存の `Transaction` が MESSAGE-INTEGRITY 無しの応答を無視する（＝タイムアウト）挙動になる。RFC 8489 §10 の意図とも整合するため変更不要だが、テストで挙動を固定しておく。

### 3.3 エラー型

- `packages/ice/src/exceptions.ts` に、リダイレクト失敗を表す型（例: `TurnRedirectError` / `reason: "missing-alternate" | "loop" | "too-many" | "unsupported-transport"`）を追加するか、既存の `TransactionFailed` を保持したまま分かりやすいメッセージで rethrow する。`ice.ts` の UDP→TCP フォールバックは現状どおり動作すること（UDP でリダイレクトに成功すればフォールバック不要）。

### 3.4 ドキュメント

- `packages/ice/README.md` 等に TURN の 300 Try Alternate 対応（対応トランスポート、ループ防止、ALTERNATE-DOMAIN）を追記。公開 API（`TurnProtocol.server` の意味、新 option）を変える場合は doc コメントも更新。

## 4. テスト方針

- 配置: `packages/ice/tests/ice/turn-try-alternate.test.ts`（新規）。Arrange ヘルパーは `packages/ice/tests/utils.ts` に集約（例: `createTurnTryAlternateResponse(request, alternate, alternateDomain?)`、300 を返す UDP / stream のミニ TURN サーバ。既存 `createStreamTurnServer` / `createTurnSuccessResponse` / `createRecordingTransport` を拡張・再利用）。
- AAA 構成、Act / Assert に日本語コメント（リポジトリ規約）。
- ケース:
  1. UDP: Allocate に `300 + ALTERNATE-SERVER` → alternate へ新トランザクション ID で再送される。
  2. alternate が `401` → REALM/NONCE で認証付き Allocate が成功し、`relayedAddress` / `mappedAddress` が alternate の応答値になる（実サーバ: 300 を返すフェイクサーバ + `createLocalTurnServer`（`NodeTurnServer`）を alternate にする統合テストが望ましい）。
  3. 300 後の Refresh / CreatePermission / ChannelBind / ChannelData の送信先が alternate（`serverEndpoint` が alternate）。
  4. `300` で `ALTERNATE-SERVER` 無し → 401 扱いにならずクリーンに失敗し、transport が close される（`createTurnClient` の既存クリーンアップ）。
  5. A→B→A のピンポン / 自分自身へのリダイレクト → ループとして失敗。
  6. 最大リダイレクト回数超過で失敗。
  7. username/password が保持され、旧サーバの nonce/realm が alternate に送られない。
  8. udp4 ソケットに IPv6 alternate → `AddressFamilyMismatch` で失敗。
  9. TCP/TLS（同一変更で対応する場合）: 新しい接続で alternate に Allocate、TLS で `ALTERNATE-DOMAIN` / 元ホスト名で証明書検証される（`checkServerIdentity` 記録パターンは `turn-server-endpoint.test.ts` に既存）。
  10. 既存の 401/438 テスト・`turn-*.test.ts` が回帰しないこと。

## 5. 制約・注意点

- リダイレクトは **Allocate のみ**。Refresh / CreatePermission / ChannelBind で 300 が返っても追わない（allocation はサーバに紐づくため）。
- `requestWithRetry` は共用かつテストで差し替えられている（`turn-protocol-isolation.test.ts` が `turn.requestWithRetry = ...` で上書き）ため、シグネチャ変更は慎重に。
- サーバ端点の固定（#21e4893e「pin the TURN server endpoint」）の不変条件を壊さない: リダイレクト確定後は alternate に固定し、その後 DNS で動かない。
- RFC 8489 の「5 分以内に試行済みのサーバ」は 1 回の Allocate 試行（`TurnProtocol` インスタンス）単位の visited セットで実装すれば十分。プロセス全体のキャッシュは不要。
- catch-and-ignore 禁止（AGENTS.md）。リダイレクト失敗は原因が分かる形で throw。
- ネイティブ Windows 非対応、Node.js のみ。
- `packages/ice` には `AGENTS.md` が無いため root の規約に従う。`packages/ice-server` をテスト用に拡張する場合は同パッケージの `AGENTS.md`（Sans-IO 維持）に従う。

## 6. 完了条件

- [ ] UDP TURN で Allocate の `300 + ALTERNATE-SERVER` を受けると alternate へ再試行し、`401` 認証を経て relay 候補が収集される。
- [ ] 以降の Refresh / CreatePermission / ChannelBind / データ送信が alternate 宛てになる。
- [ ] `ALTERNATE-SERVER` 欠落・ループ・回数超過・ファミリ不一致が明確なエラーで失敗し、transport がリークしない。
- [ ] TCP/TLS は再接続で対応（ALTERNATE-DOMAIN 考慮）するか、未対応である旨の明確なエラーで失敗する（どちらにしたかを PR に明記）。
- [ ] 上記テストを追加（AAA + 日本語コメント、Arrange は `tests/utils.ts` に集約）。
- [ ] `cd packages/ice && npm run type && npm test` が通る。`ice.ts` 経由の挙動に影響するため `npm run type` と `npm run test:small` も通る。
- [ ] README / doc コメントを更新。


---

# 追加要件（レビュー指摘対応）

- [x] 複数の ALTERNATE-SERVER（RFC 8489 §10: ファミリごと等）を保持し、トランスポートのアドレスファミリで到達可能な先頭候補を使う（packages/ice-server の parseMessage が Message.alternateServers に全件保持。TurnProtocol は同一ファミリ優先、無ければ先頭）。IPv6→IPv4 / IPv4→IPv6 のどちらの順でも udp4 で成功する回帰テストを追加。
- [x] ループ検出の tried に、ホスト名指定時の初回リクエストで解決・固定された端点を含める（リクエスト後に記録）。localhost→自身のIP のリダイレクトを UDP/TCP とも 1 回の Allocate でループとして拒否するテストを追加。A→B→A は既存テストで検証。
- [x] README に複数 ALTERNATE-SERVER の選択とホスト名解決後IPのループ検出を追記。
- [x] RFC 8489 §14.5/§14.6: MESSAGE-INTEGRITY 以降の属性（MESSAGE-INTEGRITY-SHA256 / FINGERPRINT を除く）を parseMessage で無視し、署名範囲外に追記した ERROR-CODE=300 / ALTERNATE-SERVER によるリダイレクトを防止。追記攻撃の回帰テストと、署名範囲内の複数 ALTERNATE-SERVER 選択テストを追加。