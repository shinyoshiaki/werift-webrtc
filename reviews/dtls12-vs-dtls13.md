---
ide:
  viewer: review-document
  version: 1
  title: "DTLS 1.2 と DTLS 1.3 の違い（RFC × 実装）"
  dock: right
  baseCommit: c90e50877dab2cc8d5cb70d144be4277b8fcf3ec
---
# DTLS 1.2 と DTLS 1.3 の違い（RFC × 実装）

規範は **RFC 6347**（DTLS 1.2）対 **RFC 9147**（DTLS 1.3）+ **RFC 8446**（TLS 1.3 の handshake / key schedule）。SRTP exporter はどちらも **RFC 5764** の label `EXTRACTOR-dtls_srtp`。フライト図の一次地図は [packages/dtls/src/index.ts:16](review-file:packages/dtls/src/index.ts:16)（Figure 1 = 1.2）と [packages/dtls/src/index.ts:63](review-file:packages/dtls/src/index.ts:63)（Figure 3 = 1.3）。1.3 ハンドラ対応は [packages/dtls/src/engine/v1_3/README.md:1](review-file:packages/dtls/src/engine/v1_3/README.md:1)。

シーケンスを RFC 順に辿る解説は `reviews/epic1-dtls13-rfc-sequences.md`。本稿は **1.2 と 1.3 が wire 上どう違うか** を、werift の二つのエンジン（`src/flight` と `src/engine/v1_3`）に照らし合わせて並べる。

HEAD は `c90e5087`。未コミットの実装差分は無いので、確認は File Viewer を先に使う。

### 略語

| 略語 | 正式名称 |
| --- | --- |
| ACK | Acknowledgement（DTLS 1.3 の record ContentType 26） |
| AEAD | Authenticated Encryption with Associated Data |
| CCS | ChangeCipherSpec |
| CH | ClientHello |
| CID | Connection ID |
| DOWNGRD | TLS 1.3 downgrade protection sentinel（`ServerHello.Random` 末尾） |
| EE | EncryptedExtensions |
| HKDF | HMAC-based Key Derivation Function |
| HRR | HelloRetryRequest（1.3。RFC 8446 §4.1.4） |
| HVR | HelloVerifyRequest（1.2。RFC 6347。1.3 では使わない） |
| PRF | Pseudorandom Function（TLS 1.2 key derivation） |
| RTO | Retransmission Timeout |
| SH | ServerHello |

[packages/dtls/src/index.ts:107](review-diff:packages/dtls/src/index.ts:commit:c90e5087:107)

---

## 1. 概要

DTLS 1.3 は「1.2 の record に TLS 1.3 handshake を載せたもの」ではない。handshake のメッセージ集合、cookie の置き場、record header、epoch の意味、鍵導出、再送完了の合図がすべて別仕様になる。werift はそれを **別エンジン** として実装し、公開 API（`DtlsClient` / `DtlsServer`）だけを共有する。

| 世代 | RFC | このリポジトリ |
| --- | --- | --- |
| DTLS 1.2 | RFC 6347 + Errata 5186 | `packages/dtls/src/flight/{client,server}` + `record/message` + `cipher/prf` |
| DTLS 1.3 | RFC 9147 + RFC 8446 | `packages/dtls/src/engine/v1_3` + `record/v1_3` + `cipher/tls13` |
| 共通 association | 両方 | `DtlsClient` / `DtlsServer`、`version.ts`、`peer.ts`、`retransmission.ts` |

既定は 1.2。1.3 は `protocolVersions` の明示 opt-in。dual は `[V1_3, V1_2]` のみ（DOWNGRD のため）。

<!-- review-bookmark id="bm_1a026a97f5f-0ee62a68" title="1. 概要" -->
[packages/dtls/src/index.ts:4](review-file:packages/dtls/src/index.ts:4)
[packages/dtls/src/socket.ts:1008](review-file:packages/dtls/src/socket.ts:1008)
[packages/dtls/src/engine/v1_3/connection.ts:1](review-file:packages/dtls/src/engine/v1_3/connection.ts:1)
[packages/dtls/src/engine/v1_3/connection.ts:1](review-diff:packages/dtls/src/engine/v1_3/connection.ts:commit:c90e5087:1)

---

## 2. 主要変更（1.2 と 1.3 の対比）

### 2.1 Handshake シーケンス

RFC 6347 Figure 1 は **HVR → cookie CH → SH+Cert+SKE+SHD → CKE+CCS+Finished → CCS+Finished**。RFC 9147 Figure 3 は **任意の HRR → SH+{EE+Cert+CV+Finished} → {Finished} → ACK**。1.3 は HelloVerifyRequest / ServerKeyExchange / ClientKeyExchange / ServerHelloDone / ChangeCipherSpec を送らない。

```text
1.2 Flight 2 = HelloVerifyRequest（cookie challenge）
1.3 Flight 2 = HelloRetryRequest*（cookie および/または selected_group。高々 1 回）

1.2 Flight 4 = 平文の SH + Cert + SKE + SHD
1.3 Flight 4 = 平文 SH の直後から {EncryptedExtensions … Finished}（epoch 2）
```

実装もディレクトリが分かれる。1.2 はクラス `Flight1` など、1.3 は `this: Dtls13Host` の関数。

[packages/dtls/src/flight/client/flight1.ts:10](review-file:packages/dtls/src/flight/client/flight1.ts:10)
[packages/dtls/src/engine/v1_3/flight/client/flight1.ts:28](review-file:packages/dtls/src/engine/v1_3/flight/client/flight1.ts:28)
[packages/dtls/src/engine/v1_3/flight/dispatch.ts:16](review-file:packages/dtls/src/engine/v1_3/flight/dispatch.ts:16)
[packages/dtls/src/engine/v1_3/flight/dispatch.ts:23](review-diff:packages/dtls/src/engine/v1_3/flight/dispatch.ts:commit:c90e5087:23)

Handshake 型番号も世代で分かれる。1.2 専用は `hello_verify_request=3` / `server_key_exchange=12` / `server_hello_done=14` / `client_key_exchange=16`。1.3 専用は `encrypted_extensions=8` / `key_update=24` / `message_hash=254`。ACK は handshake ではなく **record ContentType 26**。

[packages/dtls/src/handshake/const.ts:1](review-file:packages/dtls/src/handshake/const.ts:1)
[packages/dtls/src/record/const.ts:1](review-file:packages/dtls/src/record/const.ts:1)

### 2.2 Version の運び方

1.2 は record / Hello の version field がそのまま `0xfefd`。1.3 は **legacy field をわざと 1.2 (`0xfefd`) のまま**にし、実選択は extension 43 `supported_versions` で運ぶ。selected 1.3 の record version は `0xfefc`。

```text
legacy_version（CH/SH）     = 0xfefd   両方
record version（1.3 確定後） = 0xfefc
実選択                      = supported_versions（無い CH は legacy 1.2 のみ）
```

cipher suite は version 信号に使わない。1.2-only server が `0x1301` だけ見て 1.3 と決めつけると、外部 client の `0x1301+0x1302` が HVR に落ちる。association は `selectVersionFromClientHello()` が extension だけを見る。

[packages/dtls/src/version.ts:10](review-file:packages/dtls/src/version.ts:10)
[packages/dtls/src/version.ts:105](review-file:packages/dtls/src/version.ts:105)
[packages/dtls/src/server.ts:238](review-file:packages/dtls/src/server.ts:238)
[packages/dtls/src/server.ts:244](review-diff:packages/dtls/src/server.ts:commit:c90e5087:244)
[packages/dtls/src/engine/v1_3/flight/server/flight4.ts:107](review-file:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:107)

**DOWNGRD（RFC 8446 §4.1.3）** は 1.3-capable server が 1.2 を選んだときに ServerHello.Random 末尾へ入れる。1.3 を offer した client が見たら abort。だから公開 dual は `[V1_3, V1_2]` だけ。

[packages/dtls/src/version.ts:51](review-file:packages/dtls/src/version.ts:51)
[packages/dtls/src/flight/server/flight4.ts:82](review-file:packages/dtls/src/flight/server/flight4.ts:82)
[packages/dtls/src/flight/server/flight4.ts:82](review-diff:packages/dtls/src/flight/server/flight4.ts:commit:c90e5087:82)

### 2.3 Cookie / アドレス検証

| | DTLS 1.2 | DTLS 1.3 |
| --- | --- | --- |
| メカニズム | HelloVerifyRequest + **legacy_cookie** | HelloRetryRequest + **cookie extension 44** |
| CH の cookie 欄 | CH2 で非空 | **MUST 空**。非空は `illegal_parameter` |
| server 状態 | CH1 では crypto を commit しない | cookie は stateless（CH hash + peer + expiry） |
| 増幅制限 | cookie 後に Flight 4 | 検証前 TX は受信の **3 倍**（`ANTI_AMPLIFICATION_FACTOR`） |

1.2 HVR は [packages/dtls/src/flight/server/flight2.ts:18](review-file:packages/dtls/src/flight/server/flight2.ts:18)。1.3 は legacy_cookie 空を MUST とし、cookie は HRR extension。

[packages/dtls/src/engine/v1_3/flight/server/flight4.ts:82](review-file:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:82)
[packages/dtls/src/engine/v1_3/flight/server/flight2.ts:60](review-file:packages/dtls/src/engine/v1_3/flight/server/flight2.ts:60)
[packages/dtls/src/handshake/extensions/cookie.ts:8](review-file:packages/dtls/src/handshake/extensions/cookie.ts:8)
[packages/dtls/src/handshake/extensions/cookie.ts:238](review-file:packages/dtls/src/handshake/extensions/cookie.ts:238)
[packages/dtls/src/engine/v1_3/types.ts:13](review-file:packages/dtls/src/engine/v1_3/types.ts:13)
[packages/dtls/src/engine/v1_3/flight-tx.ts:269](review-diff:packages/dtls/src/engine/v1_3/flight-tx.ts:commit:c90e5087:269)

dual client が 1.2 server から HVR を受けても、それは version commit ではない。1.3 engine は dual なら `DtlsVersionSelected(V1_2)` で CH-A を残し、1.2 cookie path と並行する。

[packages/dtls/src/engine/v1_3/flight/dispatch.ts:105](review-file:packages/dtls/src/engine/v1_3/flight/dispatch.ts:105)
[packages/dtls/src/client.ts:51](review-file:packages/dtls/src/client.ts:51)

### 2.4 Record layer

1.2 は常に 13-byte DTLSPlaintext header（type + version + epoch16 + seq48 + length）。暗号後も explicit nonce を payload 先頭に置き、AAD / nonce に **epoch を混ぜる**。

[packages/dtls/src/record/message/plaintext.ts:21](review-file:packages/dtls/src/record/message/plaintext.ts:21)
[packages/dtls/src/record/message/header.ts:4](review-file:packages/dtls/src/record/message/header.ts:4)
[packages/dtls/src/cipher/suites/aead.ts:62](review-file:packages/dtls/src/cipher/suites/aead.ts:62)
[packages/dtls/src/cipher/suites/aead.ts:68](review-diff:packages/dtls/src/cipher/suites/aead.ts:commit:c90e5087:68)

1.3 は epoch 0 だけ従来の plaintext。epoch 2 以降は **unified header**（先頭 3 bit `001`）。CID（C=1）は未実装で拒否。AAD は送出 header。nonce は `write_iv XOR left-pad64(seq)`。**epoch は nonce に入れない**。sequence number は header 上で暗号化（`sn_key`）。

[packages/dtls/src/record/v1_3/header.ts:1](review-file:packages/dtls/src/record/v1_3/header.ts:1)
[packages/dtls/src/record/v1_3/header.ts:75](review-file:packages/dtls/src/record/v1_3/header.ts:75)
[packages/dtls/src/cipher/tls13/aead.ts:40](review-file:packages/dtls/src/cipher/tls13/aead.ts:40)
[packages/dtls/src/cipher/tls13/aead.ts:61](review-diff:packages/dtls/src/cipher/tls13/aead.ts:commit:c90e5087:61)
[packages/dtls/src/cipher/tls13/keySchedule.ts:15](review-file:packages/dtls/src/cipher/tls13/keySchedule.ts:15)

1.3 受信は epoch ごとに `AntiReplayWindow`。1.2 受信 path には未統合（回帰回避）。

[packages/dtls/src/record/antiReplayWindow.ts:10](review-file:packages/dtls/src/record/antiReplayWindow.ts:10)

### 2.5 Epoch の意味

| epoch | DTLS 1.2（この実装） | DTLS 1.3（RFC 9147） |
| --- | --- | --- |
| 0 | handshake plaintext | DTLSPlaintext |
| 1 | CCS 後の application（Finished から） | **予約。PSK/0-RTT。未使用** |
| 2 | （使わない） | handshake traffic |
| 3 | （使わない） | 初期 application |
| 4+ | （使わない） | KeyUpdate 後。`nextAppEpoch` は 1 を飛ばす |

1.2 は CCS の直後に `this.dtls.epoch = 1` して record seq を 0 に戻す。1.3 は CCS が無いので、SH 後に epoch 2、Finished 後に epoch 3 へ進む。

[packages/dtls/src/flight/client/flight5.ts:209](review-file:packages/dtls/src/flight/client/flight5.ts:209)
[packages/dtls/src/flight/server/flight6.ts:103](review-file:packages/dtls/src/flight/server/flight6.ts:103)
[packages/dtls/src/engine/v1_3/connection-base.ts:112](review-file:packages/dtls/src/engine/v1_3/connection-base.ts:112)
[packages/dtls/src/engine/v1_3/flight/post-hs.ts:42](review-file:packages/dtls/src/engine/v1_3/flight/post-hs.ts:42)
[packages/dtls/src/engine/v1_3/flight/server/flight4.ts:505](review-diff:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:commit:c90e5087:505)

### 2.6 暗号スイートと key schedule

1.2 の cipher は ECDHE + AES-GCM の TLS 1.2 スイート（`0xc02b` / `0xc02f`）。master secret は PRF（Extended Master Secret あり）。transcript は handshake レコードの連結。

[packages/dtls/src/cipher/const.ts:18](review-file:packages/dtls/src/cipher/const.ts:18)
[packages/dtls/src/cipher/prf.ts:8](review-file:packages/dtls/src/cipher/prf.ts:8)

1.3 の AEAD スイートは handshake と独立した 0x13xx。この実装は **`TLS_AES_128_GCM_SHA256` (`0x1301`) のみ**。鍵は HKDF、Expand-Label の prefix は TLS の `tls13 ` ではなく **`dtls13`**。transcript は `msg_type || length || body`（DTLS の message_seq / fragment 欄は除く）。CertificateVerify に `rsa_pkcs1_*` は使わない。

[packages/dtls/src/engine/v1_3/flight/client/flight1.ts:39](review-file:packages/dtls/src/engine/v1_3/flight/client/flight1.ts:39)
[packages/dtls/src/cipher/tls13/hkdf.ts:4](review-file:packages/dtls/src/cipher/tls13/hkdf.ts:4)
[packages/dtls/src/cipher/tls13/hkdf.ts:8](review-diff:packages/dtls/src/cipher/tls13/hkdf.ts:commit:c90e5087:8)
[packages/dtls/src/engine/v1_3/transcript.ts:4](review-file:packages/dtls/src/engine/v1_3/transcript.ts:4)
[packages/dtls/src/cipher/tls13/signature.ts:67](review-file:packages/dtls/src/cipher/tls13/signature.ts:67)

SRTP の label は両方 `EXTRACTOR-dtls_srtp`。中身だけ分岐する。1.3 は RFC 8446 exporter、1.2 は既存 PRF。Public `extractSessionKeys` の意味は変えない。

[packages/dtls/src/cipher/tls13/keySchedule.ts:221](review-file:packages/dtls/src/cipher/tls13/keySchedule.ts:221)
[packages/dtls/src/socket.ts:773](review-file:packages/dtls/src/socket.ts:773)
[packages/dtls/src/socket.ts:810](review-diff:packages/dtls/src/socket.ts:commit:c90e5087:810)
[packages/dtls/src/engine/v1_3/connection.ts:174](review-file:packages/dtls/src/engine/v1_3/connection.ts:174)

### 2.7 ChangeCipherSpec と「いつ暗号化が始まるか」

1.2 は CCS が epoch 切替の合図。client Flight 5 / server Flight 6 が CCS を平文で送り、直後の Finished から epoch 1。

[packages/dtls/src/flight/client/flight5.ts:199](review-file:packages/dtls/src/flight/client/flight5.ts:199)
[packages/dtls/src/flight/server/flight6.ts:85](review-file:packages/dtls/src/flight/server/flight6.ts:85)
[packages/dtls/src/record/const.ts:2](review-file:packages/dtls/src/record/const.ts:2)

1.3 に CCS は無い。ServerHello まで epoch 0、EncryptedExtensions 以降は handshake traffic keys（epoch 2）。server は自分の Finished のあと epoch 3 で application を送ってよい（0.5-RTT）。

[packages/dtls/src/engine/v1_3/flight/server/flight4.ts:655](review-file:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:655)
[packages/dtls/src/engine/v1_3/flight/client/flight5.ts:117](review-file:packages/dtls/src/engine/v1_3/flight/client/flight5.ts:117)

### 2.8 再送完了の合図と再鍵

1.2 は「次フライトが来た = 前フライトは届いた」とタイマーで再送する。専用 ACK record は無い。

1.3 は ContentType **ACK = 26** で RecordNumber を列挙する。empty ACK は何も完了させない。ACK 自身より高い epoch の番号は適用しない（plaintext ACK で encrypted flight を閉じない）。Erratum 8108（Reported）の `illegal_parameter` 案は採用しない。

[packages/dtls/src/engine/v1_3/record-rx.ts:586](review-file:packages/dtls/src/engine/v1_3/record-rx.ts:586)
[packages/dtls/src/engine/v1_3/record-rx.ts:616](review-diff:packages/dtls/src/engine/v1_3/record-rx.ts:commit:c90e5087:616)

再鍵も別物。1.2 は新しい handshake。1.3 は post-handshake **KeyUpdate**。現行 write keys で送り、ACK まで新 keys では送らない。Public API の `keyUpdate()` は 1.3 接続だけ。

[packages/dtls/src/engine/v1_3/flight/post-hs.ts:49](review-file:packages/dtls/src/engine/v1_3/flight/post-hs.ts:49)
[packages/dtls/src/engine/v1_3/flight/post-hs.ts:58](review-diff:packages/dtls/src/engine/v1_3/flight/post-hs.ts:commit:c90e5087:58)
[packages/dtls/src/socket.ts:833](review-file:packages/dtls/src/socket.ts:833)

### 2.9 RTO

RFC の定数（未知 RTT 1000ms、DTLS-SRTP 400ms、既知 RTT は 1.5×、再送は倍増）は [packages/dtls/src/retransmission.ts:1](review-file:packages/dtls/src/retransmission.ts:1) に置き、**1.3 `flight-tx` だけが使う**。

1.2 `Flight.transmit` は線形 `1000 * ((retransmitCount + 1) / 2)`（0.5s, 1s, 1.5s…）のまま。dual probing で CH-A 再送と cookie CH 再送が同時発火して 1.3 `illegal_parameter` が漏れるのを避けるため。

[packages/dtls/src/retransmission.ts:23](review-file:packages/dtls/src/retransmission.ts:23)
[packages/dtls/src/engine/v1_3/flight-tx.ts:325](review-file:packages/dtls/src/engine/v1_3/flight-tx.ts:325)
[packages/dtls/src/engine/v1_3/flight-tx.ts:331](review-diff:packages/dtls/src/engine/v1_3/flight-tx.ts:commit:c90e5087:331)
[packages/dtls/src/flight/flight.ts:120](review-file:packages/dtls/src/flight/flight.ts:120)

### 2.10 コード配置（mutable state を混ぜない）

RFC 上も epoch / transcript / keys / replay は別プロトコル世代なので、実装も共有しない。共有してよいのは version-neutral helper（`peer.ts` / `retransmission.ts` / `DtlsRandom.bytes32`）と association 入口だけ。

1.3 側のフライト分割は mixin の多段継承ではなく、`Dtls13Connection extends Dtls13ConnectionBase` の 1 段 + 関数割り当て。

[packages/dtls/src/engine/v1_3/README.md:22](review-file:packages/dtls/src/engine/v1_3/README.md:22)
[packages/dtls/src/engine/v1_3/AGENTS.md:14](review-file:packages/dtls/src/engine/v1_3/AGENTS.md:14)
[packages/dtls/src/engine/v1_3/host.ts:1](review-file:packages/dtls/src/engine/v1_3/host.ts:1)
[packages/dtls/src/engine/v1_3/connection.ts:66](review-diff:packages/dtls/src/engine/v1_3/connection.ts:commit:c90e5087:66)

1.2 server が 1.3 を選んだときは、既存 1.2 flight を進めず ClientHello を 1.3 engine に再注入する。

[packages/dtls/src/server.ts:244](review-file:packages/dtls/src/server.ts:244)

---

## 3. 判断理由

1. **二つの RFC を一つの record/flight 状態機械に押し込まない。** CCS・HVR・explicit nonce と unified header・HRR・ACK は両立しない。engine を分け、association だけが version を選ぶ。
2. **version と cipher を混ぜない。** RFC 8446 は `supported_versions` があればそれだけを使う。1.2-only server の 1.3 判定を `0x1301` に頼ると外部 1.3 client が壊れる。
3. **DOWNGRD を弱めない。** 1.3-capable が 1.2 を選ぶなら sentinel 必須。公開 dual を 1.3 優先だけにする。
4. **cookie の置き場を混同しない。** 1.3 の `legacy_cookie` 非空は abort。1.2 の HVR cookie は dual の一時経路で、CH-A を捨てない。
5. **1.2 RTO を RFC 9147 倍増に揃えない。** dual 再送の同時発火が 1.3 illegal_parameter を漏らす。1.3 だけ `computeDtlsRtoMs`。
6. **verified errata だけ MUST。** 8108 は Reported。higher-epoch ACK は無視し、準拠宣言しない。

[packages/dtls/src/peer.ts:36](review-file:packages/dtls/src/peer.ts:36)
[packages/dtls/src/version.ts:126](review-file:packages/dtls/src/version.ts:126)

---

## 4. リスク（差が残っている箇所）

- **1.2 受信に record anti-replay は未統合。** RFC 6347 は window を規定する。1.3 は epoch ごと必須。self 1.2 は duplicate record seq を検出できない。
- **1.2 Flight RTO は RFC の倍増と共有していない。** 意図的。dual probing の再送衝突回避。
- **1.3 ClientHello の cipher は `0x1301` だけ。** association は `supported_versions` で判定するので外部の `0x1302` 併記は通る。engine 自身の suite 選択は `0x1301` 必須。
- **PSK / 0-RTT / CID / RRC は未実装。** epoch 1 予約、C=1 拒否。実装済みと宣言しない。
- **1.2 に KeyUpdate 相当は無い。** `socket.keyUpdate()` は 1.3 以外で throw。
- **OpenSSL DTLS 1.3 interop は対象外。** 1.3 外部参照は BoringSSL。1.2 外部参照は OpenSSL `-dtls1_2`。

---

## 5. 検証結果

対比を直接見るテスト入口:

| 観点 | テスト |
| --- | --- |
| version / DOWNGRD / dual normalize | [packages/dtls/tests/version/selectVersion.test.ts:14](review-file:packages/dtls/tests/version/selectVersion.test.ts:14) |
| 1.2-only × 1.3-only CH（HVR を出さない） | [packages/dtls/tests/e2e/self12_peer_authenticated_transport.test.ts:430](review-file:packages/dtls/tests/e2e/self12_peer_authenticated_transport.test.ts:430) |
| 1.3 full HS + KeyUpdate + exporter | [packages/dtls/tests/e2e/self13.test.ts:1](review-file:packages/dtls/tests/e2e/self13.test.ts:1) |
| dual HVR は commit ではない | [packages/dtls/tests/e2e/self13_dual_hvr_resume.test.ts:183](review-file:packages/dtls/tests/e2e/self13_dual_hvr_resume.test.ts:183) |
| RFC 9147 RTO（1.3） | [packages/dtls/tests/retransmission.test.ts:11](review-file:packages/dtls/tests/retransmission.test.ts:11) |
| BoringSSL DTLS 1.3 | [packages/dtls/tests/e2e/boringssl/interop.test.ts:116](review-file:packages/dtls/tests/e2e/boringssl/interop.test.ts:116) |
| dual → OpenSSL 1.2 | [packages/dtls/tests/e2e/client_dual_openssl.test.ts:10](review-file:packages/dtls/tests/e2e/client_dual_openssl.test.ts:10) |

直近検証（HEAD `c90e5087`）:

```text
cd packages/dtls && npm run type && npm test
→ 382 passed | 1 skipped
```

Figure 1 / 3 の読み比べは [packages/dtls/src/index.ts:16](review-file:packages/dtls/src/index.ts:16) から [packages/dtls/src/index.ts:63](review-file:packages/dtls/src/index.ts:63)。実装確認は File Viewer、コミット差分は [packages/dtls/src/index.ts](review-diff:packages/dtls/src/index.ts:commit:c90e5087) から辿れる。
