# werift `ticket/5fc64332-b0d1-4ab0-bc1e-4b0f3a26c135` 重要レビュー指摘

対象ブランチ: `ticket/5fc64332-b0d1-4ab0-bc1e-4b0f3a26c135`  
基準ブランチ: `develop`

## 結論

**Request Changes / 現状のままでは merge 非推奨。**

DTLS 1.3 の record layer、HKDF/key schedule、full handshake、KeyUpdate、replay protection、loss/reorder、BoringSSL harness まで広く実装されている一方、チケットが要求する version negotiation、HRR、signature negotiation、anti-amplification にプロトコル上の問題がある。

特に以下の P1 指摘は merge blocker とすることを推奨する。

---

## 1. [P1] `[1.3, 1.2]` fallback が `supported_versions` negotiation になっていない

現在の dual-stack client は `[V1_3, V1_2]` の場合、まず DTLS 1.3 engine を起動する。

しかし DTLS 1.3 engine が送信する ClientHello の `supported_versions` は DTLS 1.3 のみであり、DTLS 1.2 を同時提示しない。

その後、

- `HelloVerifyRequest`
- `ProtocolVersionError`
- protocol version 関連のエラー文字列

などを受けた場合に DTLS 1.3 engine を破棄し、同じ UDP transport 上で DTLS 1.2 handshake を新規開始している。

### 問題点

これはチケットで意図されている「共通 association 層で `supported_versions` に基づいて version selection を行う」方式ではなく、

> 1.3-only handshake を一度失敗させてから 1.2 を再試行する

方式になっている。

特に unauthenticated な DTLS 1.2 `HelloVerifyRequest` が downgrade trigger になり得る点は避けたい。

### 推奨修正

- `[V1_3, V1_2]` の ClientHello では両 version を `supported_versions` に提示する。
- association 層で peer と local preference の共通集合から version を決定する。
- version selection 後に DTLS 1.2 / 1.3 engine へ dispatch する。
- `HelloVerifyRequest` やエラー文字列 regex を downgrade decision に利用しない。

---

## 2. [P1] `protocolVersions` の「順序 = 優先順位」を server が守っていない

Public API では `protocolVersions` の順序が preference order と定義されている。

しかし dual server は、client が DTLS 1.3 を `supported_versions` に含んでいれば、server 自身の配列順に関係なく DTLS 1.3 engine へ切り替える。

例えば:

```ts
protocolVersions: [DtlsVersion.V1_2, DtlsVersion.V1_3]
```

でも client が 1.3 を提示すると 1.3 を選択し得る。

一方 client 側では先頭 version によって初期 engine が決まるため、client/server で API の意味も非対称になっている。

### 推奨修正

共通の version selection 関数を用意する。

```ts
selectVersion(
  localPreference: readonly DtlsVersion[],
  peerSupported: readonly DtlsVersion[],
): DtlsVersion
```

両 role で同一の selection semantics を利用する。

最低でも以下をテストする。

- `[1.3, 1.2]`
- `[1.2, 1.3]`
- `[1.3]`
- `[1.2]`
- intersection なし

---

## 3. [P1] HRR の group negotiation が RFC 8446 の意味論を満たしていない

server は `key_share` に利用可能な share がない場合、`this.groups[0]` をそのまま HRR の `selected_group` にしている。

しかし client の `supported_groups` extension を解析していない。

client 側も HRR で指定された group を、自身が最初に宣言した supported groups に含むか検証せず、新しい key pair を生成している。

### 問題例

- server: X25519 only
- client: P-256 only

でも server が X25519 を HRR で指定し、client が X25519 key pair を生成することで接続できてしまう可能性がある。

これは group negotiation ではない。

### 推奨修正

server:

1. ClientHello の `supported_groups` を parse。
2. `clientSupportedGroups ∩ serverGroups` を求める。
3. intersection が空なら handshake failure。
4. intersection 内で、最初の ClientHello の `key_share` に無い group のみ HRR で選択。

client:

- original `supported_groups` を保持する。
- original `key_share` groups を保持する。
- HRR の selected group が自身の advertised supported groups に含まれることを検証する。
- HRR selected group が最初から key_share に含まれていた場合は拒否する。
- 2回目の HRR を拒否する。

---

## 4. [P1] `signature_algorithms` が実際には negotiation されていない

ClientHello に `signature_algorithms` extension は存在するが、server はその値を handshake state に保存して CertificateVerify algorithm の選択に利用していない。

現在の送信 algorithm はほぼ local private key type のみで決まる。

- RSA key → `rsa_pss_rsae_sha256`
- EC key → `ecdsa_secp256r1_sha256`

また mutual auth の CertificateRequest 側も、peer と default schemes の intersection が存在するか確認するだけで、実際に選択された集合を CertificateVerify 生成へ反映していない。

### 問題例

server が CertificateRequest で ECDSA のみを許可しても、RSA certificate を持つ client が RSA-PSS CertificateVerify を送る可能性がある。

### 推奨修正

handshake state に以下を保持する。

```ts
peerSignatureSchemes
certificateRequestSignatureSchemes
```

送信時は、

```text
local certificate/key capability
∩
peer-advertised signature schemes
```

から algorithm を選択する。

受信 CertificateVerify についても `DEFAULT_SIGNATURE_SCHEMES` ではなく、実際にその handshake で提示した scheme 集合に対して検証する。

---

## 5. [P1] 3× anti-amplification enforcement に bypass path がある

handshake flight と retransmission は `consumeSendBudget()` を通しているが、以下は直接 transport へ送信している。

- `sendAck()`
- `sendFatalAlert()`
- `sendProtocolVersionAlert()`

特に `sendAck()` は `bytesSent` を加算するだけで、送信前 budget check を行っていない。

### 問題点

チケットでは generic DTLS server について、address validation 前の送信量を受信量の3倍以内に制限することが要求されている。

現在の構造では ACK や alert を利用して aggregate outbound bytes が制限を超える可能性がある。

### 推奨修正

全 outbound path を共通メソッドへ統合する。

```ts
sendWithBudget(record: Buffer): Promise<void>
```

以下のすべてを通す。

- HRR
- ServerHello
- handshake flights
- retransmission
- ACK
- alerts

### 追加テスト

address validation 前に duplicate / malformed / replay handshake records を大量投入し、

```text
totalServerBytesSent <= 3 * totalClientBytesReceived
```

を確認する。

---

## 6. [P2] ACK accumulator が current flight に限定されていない

`receivedRecordNumbers` は `sendAck()` 実行時にのみ clear される。

flight transition 時には clear されないため、以前の flight の record number が後続 ACK に混入する可能性がある。

### 推奨修正

ACK bookkeeping を flight 単位にする。

例:

```ts
currentReceivedFlightRecords
```

flight boundary と ACK state を明示的に関連付ける。

---

## 7. [P2] carrier skeleton が stable Public API に露出している

package root から以下が export されている。

- `DtlsHandshakeCarrier`
- `DtlsHandshakeDatagram`
- `RetransmissionMode`
- `DirectHandshakeCarrier`

また DTLS 1.3 connection から `handshakeCarrier` getter も公開されている。

### 問題点

チケットでは carrier abstraction 自体は Epic 2 への拡張ポイントとして必要だが、draft 内部実装詳細を stable Public API に出さないことも完了条件になっている。

### 推奨修正

Epic 1 では package root export から除外し、internal / test-only API として扱う。

関連する生成ドキュメントも public docs から除外する。

---

## 8. [P2] OpenSSL DTLS 1.2 fallback regression test が不足している

既存 OpenSSL `-dtls1_2` client/server regression は維持されている。

ただしチケットでは、

> 1.3 preferred 設定が 1.2 peer に fallback

することも OpenSSL regression の一部として要求されている。

現在の fallback test は主に werift 1.3/1.2 client × werift 1.2 server。

### 追加推奨テスト

```text
werift client
protocolVersions = [V1_3, V1_2]

      ×

openssl s_server -dtls1_2
```

で DTLS 1.2 接続が成立することを検証する。

併せて DTLS 1.2 の `EXTRACTOR-dtls_srtp` regression も明示的に残す。

---

## 9. [P2] true large-certificate full-handshake E2E が不足している

small MTU を利用した handshake fragmentation / multi-record E2E は存在する。

一方 large certificate test は、主に random 8KB buffer を `Certificate13` codec で roundtrip する unit test であり、実際の X.509 certificate を使った full handshake ではない。

### 推奨修正

数KB級の実 X.509 certificate fixture、または複数 certificate entry を利用して、

- fragmentation
- multi-record
- reassembly
- CertificateVerify
- Finished
- application data

まで full E2E で確認する。

# Merge gate 推奨

少なくとも以下の P1 項目を merge blocker とする。

- [ ] version negotiation を single-handshake / `supported_versions` ベースに修正
- [ ] `protocolVersions` preference order を client/server 共通 semantics にする
- [ ] HRR supported-groups validation を RFC 準拠にする
- [ ] CertificateVerify signature scheme を実際に negotiate する
- [ ] 全 outbound packet を anti-amplification accounting に統合する

その後、以下の P2 も Epic 1 完了前に対応することを推奨する。

- [ ] ACK bookkeeping を current flight 単位にする
- [ ] carrier draft API を stable package export から外す
- [ ] OpenSSL 1.2 peer への `[1.3,1.2]` fallback E2E を追加
- [ ] true large-certificate full E2E を追加
- [ ] scope 外差分を分離

## 最終検証

```bash
cd packages/dtls

npm run type
npm test
npm run test:boringssl
```

加えて GitHub Actions の dedicated `dtls13-boringssl` job と root regression が green であることを merge 条件とする。
