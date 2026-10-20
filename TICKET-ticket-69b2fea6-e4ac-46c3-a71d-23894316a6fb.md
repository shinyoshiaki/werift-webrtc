## Summary

The DTLS server can sign `ServerKeyExchange` and derive handshake keys using the random from the initial cookie-less `ClientHello`, even when the accepted cookie-authenticated `ClientHello` carries a different random.

This has been reproduced against Apple Home / HKSV3 remote H.265 live view: ICE succeeds, but the peer rejects the DTLS handshake with `fatal decrypt_error (51)`.

## Current behavior

In `packages/dtls/src/server.ts`, the cookie-authenticated `ClientHello` is deserialized and accepted, but `cipher.remoteRandom` is not refreshed before Flight 4 is generated.

The current develop code effectively does:

```ts
const clientHello = ClientHello.deSerialize(handshake.fragment);

if (clientHello.cookie.length === 0) {
  flight2(...)(clientHello);
} else if (
  this.dtls.cookie &&
  clientHello.cookie.equals(this.dtls.cookie)
) {
  await new Flight4(...).exec(handshake, ...);
}
```

If the second `ClientHello.random` differs from the first, Flight 4 may therefore use a stale peer random.

## Expected behavior

Once the cookie-authenticated `ClientHello` is accepted, the DTLS server should use that accepted hello's random for the ServerKeyExchange signature and key derivation.

Retransmitting an already-generated Flight 4 should continue to reuse the accepted random / cached flight rather than replacing it again.

## Downstream reproduction and proposed fix

Scrypted users reproduced this with Apple Home HKSV3 remote H.265 live view:

- ICE reaches connected.
- Apple sends a cookie-authenticated ClientHello whose random differs from the initial hello.
- The ServerKeyExchange signature does not verify against the accepted ClientHello.
- Apple returns `fatal decrypt_error (51)`.
- Updating `cipher.remoteRandom` from the accepted cookie-authenticated ClientHello restores remote live view.

A downstream werift fork PR includes a focused regression test that verifies the ECDSA signature for both unchanged and changed ClientHello randoms:

https://github.com/koush/werift-webrtc/pull/4

Related Scrypted report:

https://github.com/koush/scrypted/issues/2167

## Suggested fix

Before creating the first Flight 4 for a valid cookie-authenticated ClientHello, refresh the peer random from that accepted ClientHello, e.g. conceptually:

```ts
if (this.dtls.flight !== 4) {
  this.cipher.remoteRandom = DtlsRandom.from(clientHello.random);
}
```

The exact guard should preserve the already accepted random on Flight 4 retransmission.

## Regression tests

Please cover at least:

1. Initial ClientHello and cookie-authenticated ClientHello use the same random.
2. Cookie-authenticated ClientHello uses a different random.
3. ServerKeyExchange signature verifies against the accepted ClientHello random.
4. Flight 4 retransmission reuses the accepted random and cached messages.

Observed on the current downstream fork and still present in upstream develop as of 2026-10-17.
---

# 詳細化 (2026-10-20 調査)

## 1. 目的と背景

- DTLS サーバー (`DtlsServer`) は HelloVerifyRequest (Flight 2) を返したあと、cookie 付き ClientHello (Flight 3) を受けて Flight 4 (ServerHello / Certificate / ServerKeyExchange / [CertificateRequest] / ServerHelloDone) を送る。
- `cipher.remoteRandom` (= client_random) は **Flight 2 の中でだけ** cookie なし ClientHello から設定されており (`packages/dtls/src/flight/server/flight2.ts:123-124`)、cookie 付き ClientHello を受け入れた時点では更新されない。
- RFC 6347 §4.2.1 はクライアントに「2 回目の ClientHello でも random を含む同じパラメータを使う」ことを要求しているが、Apple Home (HKSV3 remote H.265 live view) はこれと異なる random を送る。一方で cookie 方式は「サーバーは cookie を検証した ClientHello を基準にハンドシェイクを進める (ステートレスに扱える)」前提で設計されているため、**受け入れた (cookie 検証済み) ClientHello の random を使うのが正しい**。
- 古い random を使うと、以下のすべてがクライアント側の値と食い違う。
  - ServerKeyExchange の署名 (`CipherContext.generateKeySignature` → `client_random + server_random + ECDHE params`)。Apple はここで `decrypt_error (51)` を返す。
  - 非 EMS 時の master secret (`prfMasterSecret(pre, remoteRandom, localRandom)`, `flight6.ts`)
  - key block 導出 (`cipher.cipher.init(masterSecret, localRandom, remoteRandom)`)
  - `exportKeyingMaterial` (SRTP 鍵導出, `socket.ts:241-249`)
- なお handshake transcript (`bufferHandshakeCache`) には Flight4 で **2 回目の** ClientHello が積まれる (`flight4.ts:44`) ため、EMS / Finished の計算はすでに受け入れた hello 基準。random だけがずれている状態。

## 2. 実装すべき変更内容

### 2.1 本体修正 (`packages/dtls`)

- cookie 検証済み ClientHello を受け入れて **最初の** Flight 4 を生成する直前に、`cipher.remoteRandom = DtlsRandom.from(clientHello.random)` で更新する。
- Flight 4 の再送 (`dtls.flight === 4` で `lastMessage` を再送するパス) では **更新しない**。キャッシュ済みの ServerKeyExchange 署名と random を一致させたままにするため。
- `cipher.localRandom` / `localKeyPair` / `namedCurve` / `cipherSuite` / SRTP profile は Flight 2 で決定したものをそのまま使う (本チケットのスコープ外。後述の注意点参照)。

### 2.2 回帰テスト (`packages/dtls/tests`)

最低限、以下をカバーする。

1. 1 回目と 2 回目の ClientHello の random が同じ場合: ServerKeyExchange の署名がその random で検証できる。
2. 2 回目の ClientHello の random が異なる場合: `server.cipher.remoteRandom` が 2 回目の random になる。
3. ServerKeyExchange の署名が、受け入れた (2 回目の) ClientHello の random + `cipher.localRandom` + ServerKeyExchange の公開鍵で検証でき、1 回目の random では検証できない。
4. Flight 4 の再送 (さらに異なる random を持つ cookie 付き ClientHello を再受信) で `remoteRandom` が変わらず、送信バッファが初回の Flight 4 と同一 (`dtls.lastMessage` の再送) である。

## 3. 技術的な実装アプローチ (調査結果)

### 3.1 関連コード

| ファイル | 内容 |
| --- | --- |
| `packages/dtls/src/server.ts` | `client_hello_1` 受信時の分岐。cookie 長 0 → `flight2`、cookie 一致 → `new Flight4(...).exec(handshake, certificateRequest)`、不一致 → ログのみ |
| `packages/dtls/src/flight/server/flight2.ts` | 拡張処理、`localRandom` 生成、`remoteRandom` 設定、cipher suite 選択、`localKeyPair` 生成、cookie 生成 (`dtls.cookie ||= randomBytes(20)`) |
| `packages/dtls/src/flight/server/flight4.ts` | `exec()` 冒頭の `if (this.dtls.flight === 4) { this.send(this.dtls.lastMessage); return; }` が再送ガード。その後 `dtls.flight = 4`、ClientHello を transcript に積み、`sendServerKeyExchange()` で `cipher.generateKeySignature("sha256")` |
| `packages/dtls/src/context/cipher.ts` | `generateKeySignature` / `valueKeySignature` (署名対象の組み立て) |
| `packages/dtls/src/flight/server/flight6.ts` | `client_key_exchange_16` ハンドラで master secret / cipher 初期化に `remoteRandom` を使用 |
| `packages/dtls/src/socket.ts` | `renegotiation()` (接続済み時の ClientHello で context を作り直す)、`exportKeyingMaterial` |

### 3.2 推奨実装

再送ガードと同じ場所に更新処理を置くのが最も安全。`Flight4.exec` に受け入れ済みの `ClientHello` (パース済み) を渡し、**再送ガードの後・`dtls.flight = 4` の前後**で `remoteRandom` を更新する。

```ts
// server.ts
await new Flight4(this.transport, this.dtls, this.cipher, this.srtp).exec(
  handshake,
  clientHello, // 追加: パース済みの accepted ClientHello
  this.options.certificateRequest,
);

// flight4.ts
async exec(handshake: FragmentedHandshake, clientHello: ClientHello, certificateRequest = false) {
  if (this.dtls.flight === 4) {
    log(this.dtls.sessionId, "flight4 twice");
    this.send(this.dtls.lastMessage);
    return;
  }
  // cookie 検証済み ClientHello の random を client_random として採用する
  this.cipher.remoteRandom = DtlsRandom.from(clientHello.random);
  this.dtls.flight = 4;
  ...
}
```

- 代替案: `server.ts` 側で `if (this.dtls.flight !== 4) this.cipher.remoteRandom = ...` とする (チケット原案)。ただし再送判定が 2 箇所に分散するため、Flight4 内に寄せる方を推奨。どちらでも挙動は同等。
- `Flight4` は `packages/dtls/src/index.ts` から export されていない package 内部クラスのため、`exec` のシグネチャ変更は public API に影響しない (呼び出し元は `server.ts` のみ)。
- `DtlsRandom.from(clientHello.random)` は Flight2 と同じ変換なのでそのまま使える。

### 3.3 テスト実装方針

- `tests/server.test.ts` (既存の `describe("server")`) に追加、または `tests/server.clientHelloRandom.test.ts` 等を新設。
- Arrange 用ユーティリティは AGENTS.md の方針に従い 1 ファイルに集約する (例: `packages/dtls/tests/utils.ts` を新設し、既存 `tests/fixture.ts` の証明書と並べて再利用可能にする)。想定するユーティリティ:
  - 送信バッファを配列に記録するフェイク `Transport` (`send` を記録、`onData`/`close` はダミー)。実 UDP を使う場合は `UdpTransport.init("udp4")` でも可だが、送信内容を検証するためフェイクが扱いやすい。
  - ECDSA 証明書付きの `DtlsServer` を生成するヘルパー (`CipherContext.createSelfSignedCertificateWithKey` 相当の既存 API を利用、`signatureHash: { hash: sha256_4, signature: ecdsa_3 }`)。
  - `random` / `cookie` / cipherSuites / extensions (`EllipticCurves`, `Signature`) を指定して `ClientHello` の `FragmentedHandshake` を作るビルダー (`ClientHello#toFragment()` を利用)。
- Act: `server.onHandleHandshakes([fragment])` もしくは private の `handleHandshakes` を経由して 1 回目 → `server.dtls.cookie` を使って 2 回目を投入。
  - `Flight4.exec` は内部の `transmit()` で最大 ~27 秒の再送ループを `await` するため、**テストでは結果の Promise を await しない** か、`Flight.RetransmitCount` / タイマー (`vi.useFakeTimers()`) で制御し、テスト終了時に `server.close()` で後始末する。
- Assert:
  - フェイク Transport が受け取った Flight 4 のレコードから ServerKeyExchange をパース (`ServerKeyExchange.deSerialize`)、もしくは `server.dtls.handshakeCache` から取得。
  - 署名対象 `client_random(32) || server_random(32) || 0x03 || named_curve(2) || pubkey_len(1) || pubkey` を組み立て、証明書の公開鍵で `crypto.verify("sha256", data, publicKey, signature)` が true になることを確認 (ECDSA は DER 署名)。1 回目の random では false になることも確認。
  - 再送ケースでは 3 回目の ClientHello 投入後に `remoteRandom` 不変、送信バッファが `dtls.lastMessage` と同一であることを確認。
- Act / Assert には日本語コメントを付ける (AGENTS.md 規約)。

## 4. 制約・注意点

- **再送時の不変性**: Flight 4 のキャッシュ (`dtls.lastMessage`) に含まれる署名は初回の random で作られている。再送時に `remoteRandom` を書き換えると署名と鍵導出が不整合になるため、更新は初回生成時のみ。
- **他パラメータの差異**: 2 回目の ClientHello で curves / signature_algorithms / use_srtp / EMS / cipher suites が変わるケースは現状 Flight 2 の値のまま。RFC 上は同一であるべきで、本チケットでは random のみを対象とする (必要なら別チケット化)。EMS フラグ (`dtls.remoteExtendedMasterSecret`) も Flight 2 時点の値である点に留意。
- **renegotiation**: 接続済みで ClientHello を受けると `renegotiation()` で `dtls`/`cipher` を作り直し、`dtls.cookie` が消えるため cookie 付き hello は "wrong state" になる。既存挙動で本修正の影響なし。
- **Flight 6 以降の遅延 ClientHello**: `dtls.flight` が 6 の状態で cookie 付き hello が再到着した場合の既存挙動 (Flight 4 の再生成) は今回変更しない。ガードを `flight !== 4` にするか Flight4 内に置くかで差が出ないことを確認する。
- **クライアント側**: `packages/dtls/src/flight/client/flight3.ts` は Flight 1 の ClientHello (`dtls.lastFlight`) に cookie だけを付けて再送しており、random は変わらない (RFC 準拠)。今回はサーバー側のみの修正。
- AGENTS.md 規約: root cause を修正し、テストを skip/緩和しない。package-local の修正に閉じる (`packages/webrtc` 側の変更は不要の見込み)。
- `packages/dtls` には `AGENTS.md` が存在しない (root の AGENTS.md に従う)。

## 5. 完了条件

- [ ] cookie 検証済み ClientHello を受け入れて最初の Flight 4 を生成する際、`cipher.remoteRandom` がその ClientHello の random に更新される。
- [ ] Flight 4 再送時は `remoteRandom` とキャッシュ済みメッセージ (`dtls.lastMessage`) が変わらない。
- [ ] 上記 2.2 の回帰テスト 4 ケースが `packages/dtls/tests` に追加され、Arrange ユーティリティが共有ファイルに集約、Act/Assert に日本語コメントがある。
- [ ] テストが実 UDP 再送タイマーでハングせず、`vitest` のデフォルトタイムアウト (5 秒) 内に完了する。
- [ ] `cd packages/dtls && npm run type && npm test` が成功 (既存 e2e: openssl / self / certificate_request を含む)。
- [ ] DTLS は `packages/webrtc` から利用される protocol 変更のため、`npm run type` と `npm run test:small` も成功する。
- [ ] (可能なら) Scrypted / Apple Home HKSV3 での remote live view 復旧を downstream で確認 (参考: https://github.com/koush/werift-webrtc/pull/4)。

### 検証コマンド

```sh
cd packages/dtls && npm run type && npm test
npm run type
npm run test:small
```
