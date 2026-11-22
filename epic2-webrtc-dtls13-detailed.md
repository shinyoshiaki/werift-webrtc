# Epic 2: WebRTC DTLS 1.3 opt-in and Chromium interoperability

## 目的

Epic 1 で完成した DTLS 1.3 endpoint を `packages/webrtc` から利用可能にし、SPED や ICE/DTLS の並列起動を導入する前に、通常の WebRTC 接続経路上で DTLS 1.3 を成立させる。

この Epic では、現在の接続シーケンスを維持する。

```text
SDP negotiation
      ↓
ICE connectivity
      ↓
selected candidate pair
      ↓
DTLS
      ↓
SDP fingerprint validation
      ↓
DTLS-SRTP / SCTP
      ↓
DataChannel / RTP / RTCP
```

Epic 2 の目的は、DTLS 1.3 自体の WebRTC 統合と、後続 Epic で実装する SPED / WARP transport optimization を明確に分離することである。

---

## スコープ

### この Epic で実装するもの

- `packages/webrtc` からの DTLS 1.3 明示 opt-in
- DTLS 1.3 only
- DTLS 1.3 preferred + DTLS 1.2 fallback
- DTLS 1.2 default の維持
- `RTCDtlsTransport` への DTLS version policy の伝播
- DTLS 1.3 での SDP fingerprint authentication
- DTLS 1.3 での DTLS-SRTP
- DTLS 1.3 上の SCTP / DataChannel
- DTLS 1.3 上の RTP / RTCP
- DTLS 1.3 stats
- werift ↔ werift WebRTC E2E
- Chromium ↔ werift WebRTC E2E
- DTLS 1.2 / 1.3 共通の browser E2E regression structure

### この Epic では実装しないもの

以下は後続 Epic の責務とする。

- SPED
- DTLS-in-STUN
- nomination 前の DTLS handshake
- ICE / DTLS coordinated startup
- external retransmission mode
- SPED L1 / L2 queue
- ICE RTT と DTLS RTO の同期
- early server application data
- directional early SRTP readiness
- early RTP / RTCP buffering
- SNAP

Epic 2 では、SPED を明示的に無効化した通常の ICE → DTLS 経路のみを対象とする。

---

# 1. `packages/webrtc` DTLS version opt-in API

## 現状

`PeerConfig.dtls` は主に証明書鍵指定のみを扱っており、DTLS protocol version policy を WebRTC 層から指定できない。

## 変更方針

`PeerConfig.dtls` に DTLS version preference を追加する。

例:

```ts
dtls: Partial<{
  keys: DtlsKeys;
  protocolVersions: readonly DtlsVersion[];
}>;
```

利用例:

### DTLS 1.3 only

```ts
const pc = new RTCPeerConnection({
  dtls: {
    protocolVersions: [DtlsVersion.V1_3],
  },
});
```

### DTLS 1.3 preferred + DTLS 1.2 fallback

```ts
const pc = new RTCPeerConnection({
  dtls: {
    protocolVersions: [
      DtlsVersion.V1_3,
      DtlsVersion.V1_2,
    ],
  },
});
```

## 必須仕様

| 設定 | 動作 |
| --- | --- |
| `dtls: {}` | DTLS 1.2 only |
| `[V1_2]` | DTLS 1.2 only |
| `[V1_3]` | DTLS 1.3 only |
| `[V1_3, V1_2]` | DTLS 1.3 preferred + DTLS 1.2 fallback |

追加要件:

- DTLS 1.3 は明示 opt-in とする
- default は DTLS 1.2 のまま
- SPED の有効 / 無効と DTLS version selection を独立させる
- `addressValidation` は WebRTC Public API として公開しない
- ICE-selected path では内部的に `ice-authenticated` を利用する
- `peerIdentityMode` も WebRTC 側では `authenticated-single-peer` とする
- `DtlsVersion` は既存 `packages/dtls` の型を利用し、WebRTC 用に別 enum を作らない
- config clone / round-trip 時に `protocolVersions` 配列を defensive copy する

---

# 2. `RTCDtlsTransport` への protocol version 伝播

## 目的

`RTCPeerConnection` の設定を、実際に生成される `DtlsClient` / `DtlsServer` まで確実に伝播する。

## 推奨内部構造

`RTCDtlsTransport` に `PeerConfig` 全体を渡すのではなく、必要な DTLS 設定のみを保持する。

例:

```ts
interface DtlsTransportConfig {
  debug?: DebugConfig;
  protocolVersions?: readonly DtlsVersion[];
}
```

`SecureTransportManager.createTransport()`:

```ts
const dtlsTransport = new RTCDtlsTransport(
  {
    debug: this.config.debug,
    protocolVersions: this.config.dtls.protocolVersions,
  },
  iceTransport,
  this.certificate,
  srtpProfiles,
);
```

`RTCDtlsTransport.start()` 内では、client / server の両方へ同じ policy を渡す。

```ts
new DtlsClient({
  ...
  protocolVersions: this.config.protocolVersions,
  addressValidation: "ice-authenticated",
  peerIdentityMode: "authenticated-single-peer",
});
```

server 側も同様とする。

## 必須条件

- client / server の両 role へ同じ version policy が伝播する
- `[V1_3]` では DTLS 1.3 engine が使用される
- `[V1_3, V1_2]` では peer capability に応じて version が決定される
- opt-in なしでは DTLS 1.2 engine が使用される
- ICE transport の認証モデルを変更しない
- `RTCDtlsTransport.start()` の開始タイミングを変更しない

---

# 3. WebRTC startup ordering の維持

Epic 2 では WARP の latency optimization を導入しない。

既存の概念的な順序:

```ts
await iceTransport.start();
await dtlsTransport.start();
```

を維持する。

## 禁止事項

Epic 2 では以下を行わない。

- ICE nomination 前に ClientHello を生成する
- STUN Binding Request / Response に DTLS を埋め込む
- ICE と DTLS の handshake を並列化する
- DTLS retransmission を ICE に委譲する

これにより、Epic 2 の障害原因を WebRTC-DTLS 1.3 integration に限定する。

---

# 4. SDP fingerprint authentication

## 目的

DTLS 1.3 でも、既存 WebRTC の SDP fingerprint authentication boundary を変更しない。

接続順序は以下を維持する。

```text
DTLS handshake complete
        ↓
remote certificate available
        ↓
SDP fingerprint validation
        ↓
SRTP / SCTP activation
        ↓
RTCDtlsTransport.state = connected
```

## 正常系

```text
DTLS 1.3 handshake success
→ remote certificate available
→ fingerprint match
→ SRTP start
→ SCTP/DataChannel usable
→ connected
```

## 異常系

```text
DTLS 1.3 handshake success
→ fingerprint mismatch
→ RTCDtlsTransport = failed
→ DTLS association close
→ SCTP does not open
→ RTP / RTCP not delivered
```

## 必須条件

- DTLS 1.3 remote certificate を取得できる
- SDP `a=fingerprint` と照合できる
- fingerprint mismatch で接続を失敗させる
- fingerprint validation 前に `connected` にしない
- fingerprint validation 前に application data / media を公開しない

---

# 5. DTLS 1.3 DTLS-SRTP integration

## 方針

Epic 1 で実装された DTLS 1.3 の `EXTRACTOR-dtls_srtp` を、既存 WebRTC SRTP session 構築経路へ接続する。

既存の概念:

```ts
const {
  localKey,
  localSalt,
  remoteKey,
  remoteSalt,
} = dtls.extractSessionKeys(...);
```

を DTLS 1.3 でも成立させる。

Epic 2 では handshake 完了後に一括で SRTP / SRTCP session を構築する。

## 必須確認

- `use_srtp` negotiation が成立する
- selected SRTP profile が双方で一致する
- client write key = server read key
- server write key = client read key
- key / salt split が正しい
- RTP 双方向通信
- RTCP 双方向通信
- SRTP authentication failure が drop される
- replay packet が拒否される
- DTLS 1.2 の SRTP 経路に regression がない

## Epic 2 では行わないこと

以下は WARP WebRTC Epic へ送る。

- inbound / outbound SRTP readiness の分離
- server Finished 後の early outbound SRTP
- fingerprint validation 前の early media queue
- bounded early RTP / RTCP buffer

---

# 6. SCTP / DataChannel integration

## 目的

既存 SCTP transport が DTLS 1.3 の application-data record 上でも正常動作することを確認する。

## 必須確認

- SCTP association が正常に確立する
- DataChannel が open する
- Chromium → werift message
- werift → Chromium message
- werift ↔ werift bidirectional message
- 複数 message の順序
- large DataChannel message の既存挙動に regression がない

Epic 2 では SNAP や SCTP early startup は実装しない。

---

# 7. Stats の DTLS 1.3 対応

## 変更

`formatDtlsVersion()` に DTLS 1.3 を追加する。

```ts
if (version.major === 0xfe && version.minor === 0xfc) {
  return "DTLS 1.3";
}
```

## 必須 stats

成功した DTLS 1.3 connection で少なくとも以下を取得できること。

```ts
expect(transport.tlsVersion).toBe("DTLS 1.3");
expect(transport.dtlsState).toBe("connected");
```

cipher についても implementation が返す canonical name を assert する。

例:

```ts
expect(transport.dtlsCipher).toBe("TLS_AES_128_GCM_SHA256");
```

SRTP profile も可能な限り確認する。

## 目的

「接続成功したので DTLS 1.3 のはず」という間接判定を禁止する。

self E2E / browser E2E の両方で negotiated version を明示的に assert する。

---

# 8. werift ↔ werift WebRTC E2E

## 新規テスト

例えば以下の専用 integration test を追加する。

```text
packages/webrtc/tests/integrate/dtls13.test.ts
```

ただし共通 fixture は既存 integration test の仕組みを再利用する。

## Version matrix

| Case | Peer A | Peer B | Expected |
| --- | --- | --- | --- |
| 1 | `[V1_3]` | `[V1_3]` | DTLS 1.3 |
| 2 | `[V1_3, V1_2]` | `[V1_3]` | DTLS 1.3 |
| 3 | `[V1_3, V1_2]` | `[V1_2]` | DTLS 1.2 |
| 4 | `[V1_2]` | `[V1_2]` | DTLS 1.2 |
| 5 | `[V1_3]` | `[V1_2]` | protocol-version failure |

## 成功ケースで確認するもの

- DTLS handshake
- negotiated version
- DTLS cipher
- DTLS role
- fingerprint authentication
- DataChannel ping / pong
- RTP bidirectional
- RTCP send / receive
- SRTP profile
- connection state
- close

## JSEP / DTLS role

offerer / answerer の組み合わせだけでなく、実際の DTLS role が client / server の両方になるケースを含める。

最低限:

```text
offerer = DTLS server
answerer = DTLS client
```

```text
offerer = DTLS client
answerer = DTLS server
```

の両方向を検証する。

---

# 9. Browser E2E の基本方針

## 重要要件

Browser E2E は DTLS 1.3 専用テストを別実装として追加しない。

既存 browser E2E harness を DTLS version parameterized にし、同一のテスト実装で DTLS 1.2 と DTLS 1.3 の双方を実行する。

目的:

- DTLS 1.3 の新規相互接続確認
- DTLS 1.2 の browser interop regression 防止
- テストコード重複の防止
- version ごとの差分を browser launch/config のみに閉じ込める

---

# 10. Browser E2E version parameterization

## 共通 test case model

例:

```ts
type BrowserDtlsTestCase = {
  name: string;
  weriftVersions: readonly DtlsVersion[];
  chromiumMode: "dtls12" | "dtls13";
  expectedWeriftVersion: "DTLS 1.2" | "DTLS 1.3";
  expectedChromiumVersion: "FEFD" | "FEFC";
};
```

## 最低限の matrix

| Case | werift | Chromium | Expected |
| --- | --- | --- | --- |
| DTLS 1.2 baseline | `[V1_2]` | DTLS 1.2 | FEFD |
| DTLS 1.3 opt-in | `[V1_3]` | DTLS 1.3 only | FEFC |
| 1.3 preferred | `[V1_3, V1_2]` | DTLS 1.3 only | FEFC |
| 1.2 fallback | `[V1_3, V1_2]` | DTLS 1.2 only | FEFD |

---

# 11. Chromium launch configuration

DTLS version に応じて Chromium launch option を切り替える。

## DTLS 1.3 case

Chromium / libwebrtc を DTLS 1.3 only に固定する。

例:

```text
WebRTC-ForceDtls13/Only/
```

接続成功だけではなく、実際に FEFC が negotiated されたことを stats で検証する。

## DTLS 1.2 case

Chromium 側を DTLS 1.2 only に固定する利用可能な field trial / test configuration を使用する。

実際の Chromium revision に合わせ、使用する field trial 名と挙動を test helper 内に集約する。

## SPED

Epic 2 の browser E2E では必ず SPED / ICE-DTLS combined handshake を無効化する。

例:

```text
WebRTC-IceHandshakeDtls/Disabled/
```

この設定により、Epic 2 の browser interop は通常の ICE → DTLS 接続のみを検証する。

---

# 12. Browser E2E test structure

DTLS 1.2 / 1.3 用にテストコードを複製しない。

例:

```text
e2e/
  tests/
    dtls/
      fixture.ts
      datachannel.test.ts
      media.test.ts
      fingerprint.test.ts
```

fixture で version matrix を展開する。

```ts
for (const testCase of browserDtlsCases) {
  describe(testCase.name, () => {
    // common tests
  });
}
```

または既存 `datachannel` / `mediachannel` test を parameterized に拡張してもよい。

## 原則

以下のような構造は避ける。

```text
datachannel-dtls12.test.ts
datachannel-dtls13.test.ts
media-dtls12.test.ts
media-dtls13.test.ts
```

DTLS version 以外の signaling / ICE / media test logic は共有する。

---

# 13. Browser E2E offerer / answerer matrix

DTLS 1.2 / 1.3 の双方で以下を実行する。

```text
Chromium offerer
      ↓
werift answerer
```

```text
werift offerer
      ↓
Chromium answerer
```

最終的な最低 matrix:

```text
DTLS 1.2
  Chromium offerer → werift answerer
  werift offerer   → Chromium answerer

DTLS 1.3
  Chromium offerer → werift answerer
  werift offerer   → Chromium answerer
```

これにより WebRTC offerer / answerer と DTLS client / server role の両側を検証する。

---

# 14. Browser E2E negotiated version assertion

接続成功だけでは test pass にしない。

## DTLS 1.2

werift:

```ts
expect(weriftTransport.tlsVersion).toBe("DTLS 1.2");
```

Chromium:

```ts
expect(chromiumTransport.tlsVersion).toBe("FEFD");
```

## DTLS 1.3

werift:

```ts
expect(weriftTransport.tlsVersion).toBe("DTLS 1.3");
```

Chromium:

```ts
expect(chromiumTransport.tlsVersion).toBe("FEFC");
```

fallback test でも必ず version を assert する。

---

# 15. Browser E2E DataChannel

DTLS 1.2 / 1.3 の双方で同じ test logic を実行する。

## Chromium offerer → werift answerer

確認:

- DataChannel open
- Chromium → werift `ping`
- werift → Chromium `pong`
- negotiated DTLS version
- fingerprint validation
- SCTP association success

## werift offerer → Chromium answerer

同じ条件を逆方向でも確認する。

---

# 16. Browser E2E media

DataChannel だけでは Epic 2 の完了条件としない。

DTLS-SRTP integration を確認するため、DTLS 1.2 / 1.3 の双方で media を通す。

## Chromium → werift RTP

例:

```text
fake audio/video track
      ↓
Chromium SRTP
      ↓
werift decrypt
      ↓
RTP receive assertion
```

確認:

- RTP packet received
- authentication success
- packet count > 0
- expected SSRC / payload type
- negotiated DTLS version

## werift → Chromium RTP

```text
werift RTP
      ↓
werift SRTP
      ↓
Chromium decrypt
      ↓
inbound-rtp stats
```

確認:

```text
packetsReceived > 0
```

## RTCP

少なくとも以下のいずれか、可能なら双方を確認する。

- werift が Chromium から RTCP を受信
- Chromium stats に RTCP-driven remote-inbound / RTT 等が反映される

---

# 17. Browser E2E fingerprint failure

少なくとも以下の2ケースを持つ。

```text
DTLS 1.2 + fingerprint mismatch
→ failed
```

```text
DTLS 1.3 + fingerprint mismatch
→ failed
```

確認:

- DataChannel が open しない
- RTP を application へ配送しない
- `RTCDtlsTransport.state` が `connected` にならない
- failure reason が診断可能

---

# 18. Browser E2E source import policy

既存 browser E2E は repository 内の werift source code を直接 import する構造を維持する。

そのため、Epic 2 のために以下は行わない。

- `e2e/package.json` の `werift` dependency を `file:` に変更
- npm published package をテスト対象へ切り替え
- `npm pack` artifact を必須にする

## 完了条件

Browser E2E は既存 repository-local source import 経路を維持し、その同じコードに対して DTLS 1.2 / 1.3 の parameterized test を実行する。

`e2e/package.json` はこの目的では変更しない。

---

# 19. Regression / failure tests

## DTLS 1.2 default regression

```ts
const pc = new RTCPeerConnection();
```

では DTLS 1.2 を使用する。

必須 assertion:

```text
opt-inなし
→ FEFD
→ DTLS 1.2
```

## Version mismatch

```text
werift [V1_3]
vs
werift [V1_2]
```

期待:

```text
protocol-version failure
```

timeout を合格扱いしない。

## Fingerprint mismatch

```text
DTLS handshake success
→ SDP fingerprint mismatch
→ failed
→ SCTP openしない
→ media deliveryしない
```

## ICE restart

Epic 2 では SPED state reset は対象外だが、通常の ICE restart 後に新しい DTLS association が成立することを確認する。

```text
ICE restart
→ new selected pair
→ new DTLS association
→ expected DTLS version
→ DataChannel / media usable
```

---

# 20. 推奨実装順序

```text
E2-1
Public config
  PeerConfig.dtls.protocolVersions
        ↓
E2-2
SecureTransportManager propagation
        ↓
E2-3
RTCDtlsTransport → DtlsClient / DtlsServer propagation
        ↓
E2-4
DTLS 1.3 stats (FEFC)
        ↓
E2-5
fingerprint + DTLS-SRTP integration
        ↓
E2-6
werift ↔ werift DataChannel
        ↓
E2-7
werift ↔ werift RTP / RTCP
        ↓
E2-8
browser E2E version parameterization
        ↓
E2-9
Chromium ↔ werift DataChannel (1.2 / 1.3)
        ↓
E2-10
Chromium ↔ werift RTP / RTCP (1.2 / 1.3)
        ↓
E2-11
fallback / mismatch / fingerprint / restart regression
        ↓
Epic 2 complete
```

---

# 21. 実装単位の推奨分割

Epic 2 内を PR / task レベルへ分ける場合は、以下の順が扱いやすい。

## Task A: WebRTC DTLS version configuration

対象:

- `peerConnection.ts`
- `secureTransportManager.ts`
- `transport/dtls.ts`

内容:

- `protocolVersions` Public config
- config cloning
- transport propagation
- default DTLS 1.2 regression

## Task B: DTLS 1.3 WebRTC transport integration

対象:

- `transport/dtls.ts`
- stats
- SRTP setup

内容:

- DTLS 1.3 handshake through selected ICE pair
- fingerprint
- DTLS-SRTP
- stats FEFC
- failure handling

## Task C: werift self WebRTC E2E

内容:

- version matrix
- role matrix
- DataChannel
- RTP / RTCP
- fallback
- mismatch
- ICE restart

## Task D: Browser E2E parameterization

内容:

- common DTLS 1.2 / 1.3 test case definition
- Chromium launch configuration
- version assertions
- SPED disabled
- existing source import structure maintained

## Task E: Chromium interoperability

内容:

- offerer / answerer both directions
- DTLS 1.2
- DTLS 1.3
- DataChannel
- media
- fingerprint failure
- fallback

---

# 22. Epic 2 完了条件

## Public API / compatibility

- [ ] `packages/webrtc` から `[DtlsVersion.V1_3]` を明示 opt-in できる
- [ ] `[DtlsVersion.V1_3, DtlsVersion.V1_2]` を指定できる
- [ ] opt-in なしでは DTLS 1.2 のまま
- [ ] DTLS version selection と SPED option が独立している
- [ ] config clone / round-trip で protocol version 配列を正しく保持する
- [ ] existing ICE → DTLS sequential startup を変更していない

## werift ↔ werift

- [ ] DTLS 1.3 が両 DTLS role で成立する
- [ ] DTLS 1.3 only が成立する
- [ ] DTLS 1.3 preferred + DTLS 1.2 fallback が成立する
- [ ] DTLS 1.3 only vs DTLS 1.2 only が protocol-version error になる
- [ ] DataChannel が双方向に通る
- [ ] RTP が双方向に通る
- [ ] RTCP が双方向に通る
- [ ] DTLS 1.3 exporter から SRTP / SRTCP session が正常に構築される
- [ ] fingerprint mismatch が WebRTC 接続を失敗させる
- [ ] ICE restart 後に新しい DTLS association が成立する
- [ ] werift stats が negotiated version を正しく返す

## Browser E2E structure

- [ ] Browser E2E harness が DTLS version parameterized になっている
- [ ] DTLS 1.2 と DTLS 1.3 が同じ test implementation を共有する
- [ ] DTLS 1.2 / 1.3 用の signaling / media test code を複製していない
- [ ] Chromium launch configuration の version 差分を helper / fixture に集約している
- [ ] Epic 2 browser test では SPED を確実に無効化している
- [ ] 既存 repository-local werift source import 構造を維持している
- [ ] `e2e/package.json` の werift dependency をこの目的では変更していない

## Chromium interoperability

- [ ] Chromium offerer → werift answerer を DTLS 1.2 で確認
- [ ] Chromium offerer → werift answerer を DTLS 1.3 で確認
- [ ] werift offerer → Chromium answerer を DTLS 1.2 で確認
- [ ] werift offerer → Chromium answerer を DTLS 1.3 で確認
- [ ] DTLS 1.2 で Chromium `tlsVersion === "FEFD"` を確認
- [ ] DTLS 1.3 で Chromium `tlsVersion === "FEFC"` を確認
- [ ] werift 側も `DTLS 1.2` / `DTLS 1.3` を stats で確認
- [ ] Chromiumとの DataChannel が DTLS 1.2 / 1.3 双方で双方向に通る
- [ ] Chromiumとの RTP が DTLS 1.2 / 1.3 双方で通る
- [ ] Chromiumとの RTCP 経路が DTLS 1.2 / 1.3 双方で成立する
- [ ] fingerprint mismatch を DTLS 1.2 / 1.3 双方で拒否する
- [ ] `[V1_3, V1_2]` × Chromium DTLS 1.3 で DTLS 1.3 が選択される
- [ ] `[V1_3, V1_2]` × Chromium DTLS 1.2 で DTLS 1.2 fallback が成立する

## Regression

- [ ] Epic 1 の DTLS 1.3 self tests が全て成功する
- [ ] BoringSSL DTLS 1.3 interoperability が成功する
- [ ] OpenSSL DTLS 1.2 interoperability が成功する
- [ ] DTLS 1.2 WebRTC browser E2E に regression がない
- [ ] default WebRTC behavior に regression がない

---

# 23. Epic 2 完了時の状態

Epic 2 完了時点では、以下が成立していること。

```text
                         ┌───────────────────┐
                         │ RTCPeerConnection │
                         └─────────┬─────────┘
                                   │
                         DTLS version opt-in
                                   │
                         ┌─────────▼─────────┐
                         │   ICE completed   │
                         └─────────┬─────────┘
                                   │
                         ┌─────────▼─────────┐
                         │ DTLS 1.2 or 1.3   │
                         └─────────┬─────────┘
                                   │
                    SDP fingerprint validation
                                   │
                 ┌─────────────────┴─────────────────┐
                 │                                   │
        ┌────────▼────────┐                 ┌────────▼────────┐
        │ DTLS-SRTP       │                 │ SCTP / DataChan │
        │ RTP / RTCP      │                 │                 │
        └─────────────────┘                 └─────────────────┘
```

この時点では、ICE と DTLS はまだ直列である。

次の Epic で初めて、

```text
ICE connectivity check
        +
SPED
        +
DTLS handshake
```

を並行化する。

これにより Epic 3 で問題が発生した場合に、

- DTLS 1.3 protocol implementation
- WebRTC integration
- DTLS-SRTP
- Chromium interoperability

は Epic 2 ですでに正常と判断でき、SPED / ICE integration に原因を限定しやすくなる。
