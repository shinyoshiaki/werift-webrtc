---
ide:
  viewer: review-document
  version: 1
  title: "Epic 1: RFC シーケンスに基づく DTLS 実装解説"
  dock: right
  baseCommit: bff482b914226345ee1229b27f6627762d012072
---
# Epic 1: RFC シーケンスに基づく DTLS 実装解説

規範は **RFC 9147**（DTLS 1.3）+ **RFC 8446**（TLS 1.3）+ verified errata。DTLS 1.2 既定経路は **RFC 6347**、SRTP exporter は **RFC 5764**。実装のフライト図は [packages/dtls/src/index.ts:16](review-file:packages/dtls/src/index.ts:16) の Figure 1 / 3 が一次地図。ハンドラ対応は [packages/dtls/src/engine/v1_3/README.md:1](review-file:packages/dtls/src/engine/v1_3/README.md:1)。

working tree の実装は HEAD `bff482b9`。未コミットの実装差分は無いので、確認は File Viewer を先に使う。

### 略語

| 略語 | 正式名称 |
| --- | --- |
| AAD | Additional Authenticated Data（追加認証データ） |
| ACK | Acknowledgement（DTLS 1.3 の record ContentType 26） |
| AEAD | Authenticated Encryption with Associated Data |
| CCS | ChangeCipherSpec |
| Cert | Certificate |
| CH | ClientHello |
| CH-A | 最初に送った dual-capable ClientHello（HVR 前の original） |
| CID | Connection ID（RFC 9147 unified header の C bit） |
| CKE | ClientKeyExchange（DTLS 1.2 のみ） |
| CV | CertificateVerify |
| DOWNGRD | TLS 1.3 downgrade protection sentinel（`ServerHello.Random` 末尾 8 バイト。`DOWNGRD` \|\| `0x01` / `0x00`） |
| DTLS | Datagram Transport Layer Security |
| ECDHE | Elliptic-Curve Diffie–Hellman Ephemeral |
| EE | EncryptedExtensions |
| EMS | Extended Master Secret（RFC 7627） |
| HKDF | HMAC-based Key Derivation Function（RFC 5869 / RFC 8446 §7.1） |
| HMAC | Hash-based Message Authentication Code |
| HRR | HelloRetryRequest（TLS 1.3 / DTLS 1.3。RFC 8446 §4.1.4） |
| HS | Handshake |
| HVR | HelloVerifyRequest（DTLS 1.2 の cookie challenge。RFC 6347。DTLS 1.3 では使わない） |
| ICE | Interactive Connectivity Establishment |
| KU | KeyUpdate |
| MITM | Man-in-the-Middle |
| PRF | Pseudorandom Function（TLS 1.2 key derivation） |
| PSK | Pre-Shared Key |
| RFC | Request for Comments |
| RRC | Return Routability Check（RFC 9853。本 Epic 対象外） |
| RTO | Retransmission Timeout（RFC 9147 §5.8.2） |
| RTT | Round-Trip Time |
| SH | ServerHello |
| SHD | ServerHelloDone（DTLS 1.2 のみ） |
| SKE | ServerKeyExchange（DTLS 1.2 のみ） |
| SPED | STUN-embedded / WARP の後続 Epic 2 経路（本 Epic 対象外） |
| SRTP | Secure Real-time Transport Protocol（RFC 5764 DTLS-SRTP） |
| TLS | Transport Layer Security |
| TX / RX | transmit / receive（送信 / 受信） |
| 0-RTT | Zero Round-Trip Time（PSK early data。本 Epic では未実装） |

[packages/dtls/src/index.ts:63](review-file:packages/dtls/src/index.ts:63)
[packages/dtls/src/index.ts:107](review-diff:packages/dtls/src/index.ts:commit:bff482b9:107)

---

## 1. 概要

Epic 1 は direct datagram 上の **証明書付き DTLS 1.3 full handshake** を、既存 DTLS 1.2 を壊さずに追加する。RFC が規定する「誰が何をどの順で送るか」と「確定してはいけないタイミング」が、いまのコード分割そのものになっている。

DTLS 1.3 のフライト実装は DTLS 1.2 と同じく `flight/{client,server}/flightN.ts` に分割し、`handshake-flights.ts` は合成スタックの再エクスポートだけを残す。version / peer / RTO の中立ヘルパーは 1.2 association と 1.3 engine で共有する。

| RFC | この実装での役割 |
| --- | --- |
| RFC 9147 | 1.3 wire / record / ACK / cookie / anti-amp / RTO / KeyUpdate / dual 1.2 相互運用 |
| RFC 8446 | key schedule、HRR（HelloRetryRequest）、DOWNGRD、CertificateVerify、KeyUpdate secret |
| RFC 6347 + Errata 5186 | 既定 1.2 flights、HVR（HelloVerifyRequest）cookie、`message_seq` vs record seq |
| RFC 5764 | `EXTRACTOR-dtls_srtp` |
| RFC 9147 Erratum 8108 | **Reported のみ**。higher-epoch ACK は無視。`illegal_parameter` では止めない |

チケット完了条件との対応:

| 完了条件 | RFC 上の根拠 | 実装入口 |
| --- | --- | --- |
| 1.3 full HS + 双方向 app data | RFC 9147 Figure 3 / §5 | Figure 3 + `engine/v1_3/flight/{client,server}` |
| `[1.3, 1.2]` fallback | RFC 9147: 1.3 は HVR（HelloVerifyRequest）を使わないが dual client は 1.2 server と相互運用する | association dual + HVR は commit ではない |
| 1.3-only × 1.2-only は version error | RFC 8446 / 9147 `protocol_version(70)`。ClientHello に `supported_versions` があれば **それだけ** を使う | `selectVersionFromClientHello` + `ProtocolVersionError` |
| DOWNGRD を弱めない | RFC 8446 §4.1.3 | dual は `[V1_3, V1_2]` のみ |
| 3× anti-amplification | RFC 9147 cookie security | `ANTI_AMPLIFICATION_FACTOR = 3` |
| `EXTRACTOR-dtls_srtp` | RFC 5764 + RFC 8446 §7.5 | 1.3 exporter / 1.2 PRF を分岐 |

公開入口は `DtlsClient` / `DtlsServer`。`selectVersion` と carrier は Public API に出さない。

[packages/dtls/src/index.ts:4](review-file:packages/dtls/src/index.ts:4)
[packages/dtls/src/index.ts:12](review-diff:packages/dtls/src/index.ts:commit:bff482b9:12)
[packages/dtls/src/engine/v1_3/handshake-flights.ts:1](review-file:packages/dtls/src/engine/v1_3/handshake-flights.ts:1)
[packages/dtls/src/engine/v1_3/README.md:11](review-file:packages/dtls/src/engine/v1_3/README.md:11)

---

## 2. 主要変更（RFC シーケンス → コード）

### 2.1 RFC 9147 Figure 3 — DTLS 1.3 full handshake

RFC 9147 の full handshake は次の順。実装の `hsPhase` もこの順だけを受理する。

```text
Client                                           Server
   ------                                           ------
ClientHello + key_share     -------->            Flight 1
  supported_versions
                             <--------  HelloRetryRequest*   Flight 2
ClientHello + cookie*       -------->            Flight 3
                             <--------  ServerHello          \
                                          {EncryptedExtensions}
                                          {CertificateRequest*}
                                          {Certificate}        Flight 4
                                          {CertificateVerify}
                                          {Finished}
{Certificate*} {CertificateVerify*}
{Finished}                  -------->            Flight 5
                             <--------  [ACK]
          [Application Data  <------->  Application Data]
```

`{ }` は handshake traffic keys（epoch 2）。1.3 経路では **HelloVerifyRequest / ServerKeyExchange / ClientKeyExchange / ServerHelloDone / ChangeCipherSpec を送らない**（チケット 2.3）。

状態機械は [packages/dtls/src/engine/v1_3/connection-base.ts:56](review-file:packages/dtls/src/engine/v1_3/connection-base.ts:56)。dispatch は [packages/dtls/src/engine/v1_3/flight/dispatch.ts:24](review-file:packages/dtls/src/engine/v1_3/flight/dispatch.ts:24)。

Figure 3 → ファイル（`handshake-flights.ts` は再エクスポートのみ）:

| Flight | RFC | 実装 |
| --- | --- | --- |
| 1 / 3 ClientHello | §5.1、legacy_version `0xfefd`、legacy_cookie 空 | `flight/client/flight1.ts` `sendClientHello` / `flight/server/flight4.ts` `onClientHello` |
| 2 HRR（HelloRetryRequest） | RFC 8446 §4.1.4、最大 1 回 | `flight/server/flight2.ts` `sendHelloRetryRequest` / `flight/client/flight4.ts` の HRR 分岐 |
| 4 Server flight | SH（ServerHello）+ EE（EncryptedExtensions）+ Cert* + CV（CertificateVerify）+ Finished | `flight/server/flight4.ts` `sendServerFlight` / `flight/client/flight4.ts` |
| 5 client Finished | 任意 client Cert | `flight/client/flight5.ts` / `flight/server/flight5.ts` |
| post-HS ACK | RFC 9147 §7 | `record-rx.ts` `handleAck` |
| post-HS KeyUpdate | RFC 9147 §8 | `flight/post-hs.ts` `keyUpdate` / `onKeyUpdate` |

[packages/dtls/src/index.ts:107](review-file:packages/dtls/src/index.ts:107)
[packages/dtls/src/engine/v1_3/flight/client/flight1.ts:29](review-file:packages/dtls/src/engine/v1_3/flight/client/flight1.ts:29)
[packages/dtls/src/engine/v1_3/flight/dispatch.ts:110](review-diff:packages/dtls/src/engine/v1_3/flight/dispatch.ts:commit:bff482b9:110)
[packages/dtls/src/engine/v1_3/connection.ts:1](review-file:packages/dtls/src/engine/v1_3/connection.ts:1)

1.3 メッセージ型:

[packages/dtls/src/handshake/const.ts:10](review-file:packages/dtls/src/handshake/const.ts:10)
[packages/dtls/src/record/const.ts:6](review-file:packages/dtls/src/record/const.ts:6)

### 2.2 ClientHello / ServerHello の MUST（RFC 9147）

Server が CH を受けたときの必須検査:

1. `legacy_version` は **DTLS 1.2 (`0xfefd`)**。wire の 1.3 は `supported_versions` で運ぶ。
2. `compression_methods` は **`[0]` のみ**。
3. **`legacy_cookie` は空**。非空なら abort（`illegal_parameter`）。DTLS 1.3 の cookie は extension 44。
4. TLS compatibility mode は使わない。`legacy_session_id` は空をエコー。

<!-- review-bookmark id="bm_1a017415022-417792a8" title="2.2 ClientHello / ServerHello の MUST（RFC" -->
[packages/dtls/src/engine/v1_3/flight/server/flight4.ts:64](review-file:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:64)
[packages/dtls/src/engine/v1_3/flight/server/flight4.ts:82](review-diff:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:commit:bff482b9:82)

ServerHello 側も `legacy_version == 0xfefd`、`compression_method == 0`、session_id echo。

[packages/dtls/src/engine/v1_3/flight/client/flight4.ts:50](review-file:packages/dtls/src/engine/v1_3/flight/client/flight4.ts:50)
[packages/dtls/src/engine/v1_3/flight/client/flight4.ts:50](review-diff:packages/dtls/src/engine/v1_3/flight/client/flight4.ts:commit:bff482b9:50)

HRR（HelloRetryRequest）判定は RFC 8446 の特殊 Random:

```text
CF21AD74E59A6111BE1D8C021E65B891C2A211167ABB8C5E079E09E2C8A8339C
```

[packages/dtls/src/engine/v1_3/types.ts:183](review-file:packages/dtls/src/engine/v1_3/types.ts:183)
[packages/dtls/src/engine/v1_3/flight/client/flight4.ts:79](review-file:packages/dtls/src/engine/v1_3/flight/client/flight4.ts:79)
[packages/dtls/src/handshake/random.ts:35](review-file:packages/dtls/src/handshake/random.ts:35)

### 2.3 Version 交渉（RFC 8446 `supported_versions` + RFC 8446 §4.1.3 DOWNGRD）

Wire:

- record / selected 1.3 = `0xfefc`
- CH/SH の legacy field = `0xfefd`
- 実選択は extension 43

[packages/dtls/src/version.ts:10](review-file:packages/dtls/src/version.ts:10)
[packages/dtls/src/version.ts:35](review-file:packages/dtls/src/version.ts:35)

両 role が同じ `selectVersion(localPreference, peerSupported)`。交差が空なら timeout ではなく `ProtocolVersionError`（alert `protocol_version(70)`）。

ClientHello の解釈は **extension の有無だけ** で決まる。cipher suite は version 信号に使わない。

```text
supported_versions あり
  → peerVersionsFromSupportedVersionsWire(list) のみ
    local [1.2], peer [1.3]         → protocol_version（HVR を送らない）
    local [1.2], peer [1.3, 1.2]    → DTLS 1.2
    present だが unknown-only / 空   → overlap なし
supported_versions なし
  → legacy DTLS 1.2 のみ
```

1.2-only server も dual server も、association は同じ `selectVersionFromClientHello()` を先に実行する。`0x1301` だけのヒューリスティックは使わない（外部 DTLS 1.3 client は `0x1301+0x1302` を offer し得る）。

[packages/dtls/src/version.ts:105](review-file:packages/dtls/src/version.ts:105)
[packages/dtls/src/version.ts:126](review-diff:packages/dtls/src/version.ts:commit:bff482b9:126)
[packages/dtls/src/server.ts:163](review-file:packages/dtls/src/server.ts:163)
[packages/dtls/src/server.ts:238](review-file:packages/dtls/src/server.ts:238)

1.3 engine 側も cipher 選択の前に `supported_versions` を読む（1.2-only CH を `handshake_failure` に落とさない）。

[packages/dtls/src/engine/v1_3/flight/server/flight4.ts:109](review-file:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:109)

**DOWNGRD（RFC 8446 §4.1.3 / RFC 9147 が DTLS 1.2 へも適用）:**

```text
1.3-capable server が 1.2 を選ぶ
  → ServerHello.Random[24..31] = DOWNGRD || 0x01
1.3 を offer した client が sentinel を見る
  → abort（MITM が supported_versions を削った可能性）
```

そのため dual 公開仕様は **`[V1_3, V1_2]` のみ**。`[V1_2, V1_3]` は normalize する。1.3-capable 同士が「意図的に 1.2」を同じ dual CH で成立させることは、DOWNGRD と両立しない。

[packages/dtls/src/version.ts:51](review-file:packages/dtls/src/version.ts:51)
[packages/dtls/src/version.ts:65](review-file:packages/dtls/src/version.ts:65)
[packages/dtls/src/socket.ts:1010](review-file:packages/dtls/src/socket.ts:1010)
[packages/dtls/src/flight/server/flight4.ts:82](review-file:packages/dtls/src/flight/server/flight4.ts:82)
[packages/dtls/src/flight/server/flight4.ts:82](review-diff:packages/dtls/src/flight/server/flight4.ts:commit:bff482b9:82)
[packages/dtls/src/client.ts:1274](review-file:packages/dtls/src/client.ts:1274)
[packages/dtls/src/handshake/random.ts:57](review-file:packages/dtls/src/handshake/random.ts:57)

### 2.4 Dual 1.2/1.3 — RFC 9147 の「HVR（HelloVerifyRequest）は 1.3 では使わない」をどう実装したか

RFC 9147 は DTLS 1.3 で **HelloVerifyRequest を使わず HRR（HelloRetryRequest）を使う**。同時に **dual 1.2/1.3 client は 1.2 server と相互運用できる必要がある**。

実装の解釈:

```text
HVR  = 「対向は 1.2 cookie path を開いた」という未認証シグナル
       最終 version ではない

version 確定 = ServerHello / HRR（1.3）または 1.2 ServerHello + DOWNGRD 検査
```

association 状態:

```text
none → probing → committed12 | committed13 | closed
```

[packages/dtls/src/client.ts:51](review-file:packages/dtls/src/client.ts:51)
[packages/dtls/src/client.ts:62](review-diff:packages/dtls/src/client.ts:commit:bff482b9:62)

1.3 engine が HVR を受けたとき、1.3-only なら `ProtocolVersionError`。dual なら `DtlsVersionSelected(V1_2)` で association に返し、**CH-A を捨てない**。

[packages/dtls/src/engine/v1_3/flight/dispatch.ts:116](review-file:packages/dtls/src/engine/v1_3/flight/dispatch.ts:116)
[packages/dtls/src/engine/v1_3/connection-base.ts:966](review-file:packages/dtls/src/engine/v1_3/connection-base.ts:966)
[packages/dtls/src/client.ts:707](review-file:packages/dtls/src/client.ts:707)
[packages/dtls/src/client.ts:707](review-diff:packages/dtls/src/client.ts:commit:bff482b9:707)

競合シーケンス（レビューで直した RFC 9147 loss recovery）:

```text
client                         dual / 1.3 server
  CH-A (legacy_cookie=empty) ------>
       <---- spoofed/stale HVR
  park CH-A (same random / ECDHE)
  CH-A + 1.2 cookie -------------->   (1.2 path のみ)
       <---- SH/HRR for CH-A ------   (遅延・ロス後も可)
  unpark CH-A → DTLS 1.3
```

RFC 9147 の再送モデルは「応答が落ちたら ClientHello を再送し、server が応答を再送する」。HVR で CH-A の RTO を止めると、このモデルが壊れる。だから `tryParkDualProbe()` は pendingFlight を残す。

1.3 server は非空 `legacy_cookie` の CH を **MUST abort** する。probing 中の cookie CH が 1.3-only server に当たると `illegal_parameter(47)` が返る。association は **probing 中の 47 だけ**落とし、`handshake_failure` など正当な 1.2 fatal は即 fail。commit したら抑制を閉じる。

### 2.5 HRR（HelloRetryRequest）+ cookie + group（RFC 8446 §4.1.4 / RFC 9147 §5.1）

```text
CH1 (key_share が空、または server が別 group を選ぶ)
  → HRR { cookie*, selected_group* }     ※ stateless、RTO キャッシュしない
CH2 ≒ CH1 except RFC 8446 §4.1.4 が許す差
  cookie 検証 → 失敗なら illegal_parameter（この試行だけ）
  selected_group は client supported_groups ∩ server groups
  HRR は高々 1 回
```

[packages/dtls/src/engine/v1_3/flight/server/flight2.ts:60](review-file:packages/dtls/src/engine/v1_3/flight/server/flight2.ts:60)
[packages/dtls/src/engine/v1_3/flight/server/flight4.ts:240](review-file:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:240)
[packages/dtls/src/engine/v1_3/flight/server/flight4.ts:240](review-diff:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:commit:bff482b9:240)
[packages/dtls/src/engine/v1_3/flight/client/flight4.ts:110](review-file:packages/dtls/src/engine/v1_3/flight/client/flight4.ts:110)

HRR transcript は CH1 を `message_hash` で置き換える（RFC 8446 §4.4.1）。

[packages/dtls/src/engine/v1_3/transcript.ts:22](review-file:packages/dtls/src/engine/v1_3/transcript.ts:22)

Cookie は HMAC(secret, peer, CH hash, expiry)。RFC 9147 の「cookie は client address に依存する」。address 検証前の TX は受信の **3 倍以内**。

[packages/dtls/src/engine/v1_3/types.ts:13](review-file:packages/dtls/src/engine/v1_3/types.ts:13)
[packages/dtls/src/handshake/extensions/cookie.ts:238](review-file:packages/dtls/src/handshake/extensions/cookie.ts:238)
[packages/dtls/src/engine/v1_3/flight-tx.ts:270](review-file:packages/dtls/src/engine/v1_3/flight-tx.ts:270)
[packages/dtls/src/engine/v1_3/flight-tx.ts:283](review-diff:packages/dtls/src/engine/v1_3/flight-tx.ts:commit:bff482b9:283)

### 2.6 RFC 6347 Figure 1 — DTLS 1.2（既定経路）

<!-- review-bookmark id="bm_1a01744b959-69a12fa6" title="2.6 RFC 6347 Figure 1 — DTLS 1.2（既定経路）" -->
```text
ClientHello          -------->   Flight 1
                     <-------    HelloVerifyRequest   Flight 2
ClientHello+cookie   -------->   Flight 3
                     <-------    SH + Cert + SKE + SHD  Flight 4
                                 (ServerHello / Certificate /
                                  ServerKeyExchange / ServerHelloDone)
CKE + CCS + Finished -------->   (ClientKeyExchange / ChangeCipherSpec)
                     <-------    CCS + Finished         Flight 6
```

[packages/dtls/src/index.ts:16](review-file:packages/dtls/src/index.ts:16)

**CH1 では association crypto を commit しない**（RFC 6347 cookie = return-routability）。cookie は HMAC(secret, source, CH params excluding legacy_cookie)。CH2 で検証成功して初めて pin / suite / random / ECDHE / EMS を一括 commit。

[packages/dtls/src/flight/server/flight2.ts:18](review-file:packages/dtls/src/flight/server/flight2.ts:18)
[packages/dtls/src/handshake/extensions/cookie.ts:147](review-file:packages/dtls/src/handshake/extensions/cookie.ts:147)
[packages/dtls/src/handshake/extensions/cookie.ts:159](review-diff:packages/dtls/src/handshake/extensions/cookie.ts:commit:bff482b9:159)
[packages/dtls/src/flight/server/commitClientHello.ts:41](review-file:packages/dtls/src/flight/server/commitClientHello.ts:41)

再送 CH2 は cached Flight4 のみ。serverRandom / ECDHE を作り直すと RFC 6347 の通常ロス回復が Finished mismatch になる。

**Errata 5186:** RFC 6347 本文の「record sequence を ClientHello に合わせる」は、実際には **handshake `message_seq`**。record seq を HVR ごとに 0 へ戻すと、replay window 付き peer が HVR2 を捨てる。

```text
                epoch   record_seq   message_seq
HVR1              0         1              0
HVR2              0         2              1   ← record は単調増加
ServerHello       0         3              2   ← message_seq は最終 CH に対応
Certificate       0         4              3
```

[packages/dtls/src/flight/server/flight2.ts:33](review-file:packages/dtls/src/flight/server/flight2.ts:33)
[packages/dtls/src/flight/server/flight2.ts:33](review-diff:packages/dtls/src/flight/server/flight2.ts:commit:bff482b9:33)
[packages/dtls/src/flight/server/flight4.ts:46](review-file:packages/dtls/src/flight/server/flight4.ts:46)

Client は複数 HVR を処理できる（RFC 6347）。`hvrGeneration` で古い Flight3 RTO を止める。

<!-- review-bookmark id="bm_1a0174d8c70-a3edd0e8" title="2.6 RFC 6347 Figure 1 — DTLS 1.2（既定経路）" -->
[packages/dtls/src/flight/client/flight3.ts:17](review-file:packages/dtls/src/flight/client/flight3.ts:17)
[packages/dtls/src/flight/client/flight3.ts:17](review-diff:packages/dtls/src/flight/client/flight3.ts:commit:bff482b9:17)

### 2.7 Transcript と key schedule（RFC 8446 §4.4.1 / §7.1、RFC 9147 label）

Transcript に含めない: record header、fragment metadata、再送 duplicate、ACK。ハッシュ入力は `msg_type(1) || length(3) || body`（DTLS の `message_seq` / fragment 欄は除く）。

[packages/dtls/src/engine/v1_3/transcript.ts:4](review-file:packages/dtls/src/engine/v1_3/transcript.ts:4)
[packages/dtls/src/engine/v1_3/transcript.ts:4](review-diff:packages/dtls/src/engine/v1_3/transcript.ts:commit:bff482b9:4)

```text
Early Secret     = HKDF-Extract(0, PSK=0)
Handshake Secret = HKDF-Extract(Derive-Secret(ES,"derived",""), ECDHE)
  c/s hs traffic = Derive-Secret(HS, "c/s hs traffic", Hello transcript)
Master Secret    = HKDF-Extract(Derive-Secret(HS,"derived",""), 0)
  app traffic / exporter / resumption
```

Expand-Label の prefix は TLS の `tls13 ` ではなく **`dtls13`**。

[packages/dtls/src/cipher/tls13/hkdf.ts:4](review-file:packages/dtls/src/cipher/tls13/hkdf.ts:4)
[packages/dtls/src/cipher/tls13/hkdf.ts:8](review-file:packages/dtls/src/cipher/tls13/hkdf.ts:8)
[packages/dtls/src/cipher/tls13/keySchedule.ts:35](review-file:packages/dtls/src/cipher/tls13/keySchedule.ts:35)
[packages/dtls/src/cipher/tls13/keySchedule.ts:47](review-diff:packages/dtls/src/cipher/tls13/keySchedule.ts:commit:bff482b9:47)

CertificateVerify は RFC 8446 §4.4.3。**`rsa_pkcs1_*` は禁止**。RSA は `rsa_pss_rsae_sha256` のみ。既存 1.2 PKCS#1 経路は流用しない。

[packages/dtls/src/cipher/tls13/signature.ts:67](review-file:packages/dtls/src/cipher/tls13/signature.ts:67)
[packages/dtls/src/cipher/tls13/signature.ts:72](review-diff:packages/dtls/src/cipher/tls13/signature.ts:commit:bff482b9:72)

SRTP（RFC 5764）は label **`EXTRACTOR-dtls_srtp`**。1.3 は RFC 8446 §7.5 exporter、1.2 は既存 PRF。Public `extractSessionKeys` の意味は変えない。

[packages/dtls/src/cipher/tls13/keySchedule.ts:221](review-file:packages/dtls/src/cipher/tls13/keySchedule.ts:221)
[packages/dtls/src/engine/v1_3/connection.ts:106](review-file:packages/dtls/src/engine/v1_3/connection.ts:106)
[packages/dtls/src/socket.ts:773](review-file:packages/dtls/src/socket.ts:773)
[packages/dtls/src/socket.ts:778](review-diff:packages/dtls/src/socket.ts:commit:bff482b9:778)

### 2.8 Record layer（RFC 9147 §4）

| epoch | 用途 |
| --- | --- |
| 0 | DTLSPlaintext |
| **1** | **予約・未使用**（PSK/0-RTT を実装済みと宣言しない） |
| 2 | handshake traffic |
| 3 | 初期 application |
| 4+ | KeyUpdate 後。`nextAppEpoch` は 1 を飛ばす |

[packages/dtls/src/engine/v1_3/flight/post-hs.ts:43](review-file:packages/dtls/src/engine/v1_3/flight/post-hs.ts:43)

Unified header（§4.1）: 固定 bit `001`、**C=1（CID）は拒否**。AAD は送出 header。nonce は `write_iv XOR left-pad64(seq)`。**epoch は nonce に入れない**（1.2 の 13-byte AAD + explicit nonce と混ぜない）。

<!-- review-bookmark id="bm_1a01c770930-f18fdef2" title="2.8 Record layer（RFC 9147 §4）" -->
[packages/dtls/src/record/v1_3/header.ts:1](review-file:packages/dtls/src/record/v1_3/header.ts:1)
[packages/dtls/src/record/v1_3/header.ts:30](review-file:packages/dtls/src/record/v1_3/header.ts:30)
[packages/dtls/src/cipher/tls13/aead.ts:40](review-file:packages/dtls/src/cipher/tls13/aead.ts:40)
[packages/dtls/src/cipher/tls13/aead.ts:61](review-diff:packages/dtls/src/cipher/tls13/aead.ts:commit:bff482b9:61)
[packages/dtls/src/record/v1_3/record.ts:70](review-file:packages/dtls/src/record/v1_3/record.ts:70)

1.3 受信 path は epoch ごとに `AntiReplayWindow`。1.2 受信 path への適用は回帰回避のため未統合（チケットどおり任意）。

### 2.9 ACK と KeyUpdate（RFC 9147 §7 / §8）

- ContentType **ACK = 26**
- empty ACK は何も完了させない（未 ACK flight を再送）
- ACK 自身の epoch より高い RecordNumber は **適用しない**（plaintext ACK で encrypted flight を完了させない）
- Erratum 8108（Reported）は higher-epoch を `illegal_parameter` にする案。verified ではないので **無視**し、準拠宣言もしない

[packages/dtls/src/engine/v1_3/record-rx.ts:578](review-file:packages/dtls/src/engine/v1_3/record-rx.ts:578)
[packages/dtls/src/engine/v1_3/record-rx.ts:604](review-diff:packages/dtls/src/engine/v1_3/record-rx.ts:commit:bff482b9:604)

KeyUpdate: **現行 write keys で送り、ACK が来るまで新 keys では送らない**（§8）。`update_requested` なら応答 KU（KeyUpdate）を先に送る。

[packages/dtls/src/engine/v1_3/flight/post-hs.ts:50](review-file:packages/dtls/src/engine/v1_3/flight/post-hs.ts:50)
[packages/dtls/src/engine/v1_3/flight/post-hs.ts:56](review-diff:packages/dtls/src/engine/v1_3/flight/post-hs.ts:commit:bff482b9:56)
[packages/dtls/src/cipher/tls13/keySchedule.ts:207](review-file:packages/dtls/src/cipher/tls13/keySchedule.ts:207)

### 2.10 RTO（Retransmission Timeout、RFC 9147 §5.8.2）

RFC 定数と `computeDtlsRtoMs` は [packages/dtls/src/retransmission.ts:1](review-file:packages/dtls/src/retransmission.ts:1) に置き、1.3 `flight-tx` が呼ぶ。`types.ts` は互換 re-export。

| 条件 | RFC | 実装 |
| --- | --- | --- |
| RTT unknown | initial 1000ms | `INITIAL_RTO_MS` |
| DTLS-SRTP profile | default 400ms | `use_srtp` 設定時 `DTLS_SRTP_INITIAL_RTO_MS` |
| RTT known（ICE 等） | 1.5 × RTT | `RTO_FACTOR = 1.5` |
| 再送 | 倍増 | `base * 2^retransmitCount`、上限 60s |

`DirectHandshakeCarrier` の未測定 RTT は 0。偽の 100ms sample は使わない。

DTLS 1.2 `Flight.transmit` はこの関数を使わない。線形 `1000 * ((retransmitCount + 1) / 2)`（0.5s, 1s, 1.5s…）のまま。dual probing で CH-A 再送と cookie CH 再送が同時発火して 1.3 `illegal_parameter` が漏れるのを避けるため。

[packages/dtls/src/retransmission.ts:23](review-file:packages/dtls/src/retransmission.ts:23)
[packages/dtls/src/engine/v1_3/flight-tx.ts:318](review-file:packages/dtls/src/engine/v1_3/flight-tx.ts:318)
[packages/dtls/src/engine/v1_3/flight-tx.ts:325](review-diff:packages/dtls/src/engine/v1_3/flight-tx.ts:commit:bff482b9:325)
[packages/dtls/src/flight/flight.ts:120](review-file:packages/dtls/src/flight/flight.ts:120)

### 2.11 1-RTT 後の application data と early server data

RFC 9147 は server Finished 後・client Finished 前の epoch 3 送信を許す。self では送受信できる。WebRTC fingerprint ゲートは Epic 3。

[packages/dtls/src/engine/v1_3/flight/server/flight4.ts:632](review-file:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:632)

reorder で Finished 前に epoch-3 app data が来る場合は小さな buffer（RFC は buffer または discard）。

[packages/dtls/src/engine/v1_3/types.ts:75](review-file:packages/dtls/src/engine/v1_3/types.ts:75)

---

## 3. 判断理由

1. **HVR を version commit にしない。** RFC 9147 は 1.3 で HVR を使わない。同時に dual client の 1.2 相互運用は必須。未認証 HVR で CH-A / ECDHE を捨てると、遅延 SH/HRR と RFC の再送モデルが両立しない。
2. **DOWNGRD を弱めない。** 1.3-capable server の 1.2 選択は sentinel 必須。公開 dual を 1.3 優先だけにし、API と RFC を一致させた。
3. **version 交渉と cipher 交渉を混ぜない。** RFC 8446 は ClientHello に `supported_versions` があるとき、server はそれだけを使う。1.2-only server が `0x1301` のみを 1.3-only 判定に使うと、`0x1301+0x1302` の正当な 1.3 CH が HVR に落ちる。
4. **1.2 と 1.3 の mutable state を共有しない。** epoch / transcript / keys / replay / timer は RFC 上も別プロトコル世代。既存 1.2 PRF / explicit-nonce を書き換えない。フライト分割と version-neutral helper（`peer.ts` / `retransmission.ts` / `DtlsRandom.bytes32`）は共有しても、wire 状態は混ぜない。
5. **CH1 で association に commit しない。** RFC 6347 cookie は「その address で cookie を受信できた」ことの証明。pre-cookie の共有 cipher state は別 source の CH で poison できる。
6. **handshake seq と record seq を混ぜない。** Errata 5186。record seq 巻き戻しは anti-replay 付き peer（OpenSSL `-dtls1_2`）で HVR2 を殺す。
7. **verified errata だけ MUST 扱い。** 8108 は Reported。higher-epoch ACK 無視を仕様として明示し、誤って準拠宣言しない。
8. **cookie は address + CH に bind。** RFC 6347 の HMAC(Secret, Client-IP, Client-Parameters) 例と RFC 9147 cookie security。検証前の TX は 3×。
9. **peer-auth と 5-tuple pin を分ける。** RFC の cookie/address validation は generic UDP 向け。ICE は既に peer 認証済みで source を渡さない。lifecycle（`protocol_version` / close_notify）を pin だけで決めると WebRTC 既定 1.2 が RFC の abort 意味を失う。

[packages/dtls/src/peer.ts:36](review-file:packages/dtls/src/peer.ts:36)
[packages/dtls/src/socket.ts:240](review-file:packages/dtls/src/socket.ts:240)
[packages/dtls/src/engine/v1_3/types.ts:168](review-file:packages/dtls/src/engine/v1_3/types.ts:168)

---

## 4. リスク（RFC との残差）

- **DTLS 1.2 受信 path に record anti-replay は未統合。** RFC 6347 は replay window を規定する。1.3 は epoch ごと必須。1.2 は「回帰を避け任意」。self 1.2 は duplicate record seq を検出できない。OpenSSL re-HVR は対向側 window で担保。
- **DTLS 1.2 Flight RTO は RFC 6347 / 9147 の倍増と共有していない。** 1.3 だけ `computeDtlsRtoMs`。1.2 線形タイマーは dual CH-A / cookie-CH 再送の同時発火回避。
- **dual probing は RFC が想定する「1.3 は HRR、1.2 は HVR」の交差点。** cookie CH は 1.3-only server に 47 を誘発し得る。抑制は probing + description 47 に閉じているが、並行 candidate は後続変更で再発しやすい。
- **werift の 1.3 ClientHello は cipher を `0x1301` だけ送る。** association は `supported_versions` で判定するので外部 1.3 client（`0x1302` 併記）は通る。1.3 engine 自身の suite 選択は依然 `0x1301` 必須。
- **PSK / 0-RTT / CID / RRC は未実装。** epoch 1 予約、C=1 拒否。実装済みと宣言しない。
- **Erratum 8108 を採用していない。** 将来 Verified になった場合、higher-epoch ACK を fatal にする変更が必要。
- **OpenSSL DTLS 1.3 interop は対象外。** 外部 1.3 参照は BoringSSL。
- **`external` retransmission は骨格のみ。** RFC の RTO を SPED が駆動するのは Epic 2。

---

## 5. 検証結果

RFC シーケンスに対応するテスト入口:

<!-- review-bookmark id="bm_1a023c4a9c3-15964baf" title="5. 検証結果" -->
| RFC 観点 | テスト |
| --- | --- |
| version / DOWNGRD / `[1.2,1.3]` normalize | [packages/dtls/tests/version/selectVersion.test.ts:14](review-file:packages/dtls/tests/version/selectVersion.test.ts:14) |
| `supported_versions` wire（absent = legacy 1.2） | [packages/dtls/tests/version/supported_versions_wire.test.ts:57](review-file:packages/dtls/tests/version/supported_versions_wire.test.ts:57) |
| 1.2-only server × 1.3-only CH（`0x1301+0x1302`、HVR なし） | [packages/dtls/tests/e2e/self12_peer_authenticated_transport.test.ts:430](review-file:packages/dtls/tests/e2e/self12_peer_authenticated_transport.test.ts:430) |
| 1.3-only × 1.2-only → 双方 `ProtocolVersionError` | [packages/dtls/tests/e2e/self12_peer_authenticated_transport.test.ts:337](review-file:packages/dtls/tests/e2e/self12_peer_authenticated_transport.test.ts:337) |
| HVR は commit ではない / CH-A 再送 / 遅延 SH | [packages/dtls/tests/e2e/self13_dual_hvr_resume.test.ts:183](review-file:packages/dtls/tests/e2e/self13_dual_hvr_resume.test.ts:183) |
| RFC 6347 cookie bind / 別 peer 拒否 | [packages/dtls/tests/e2e/self12_cookie_binding.test.ts:244](review-file:packages/dtls/tests/e2e/self12_cookie_binding.test.ts:244) |
| CH2 再送で Flight4 を再生成しない | [packages/dtls/tests/e2e/self12_ch2_retransmit_flight4.test.ts:18](review-file:packages/dtls/tests/e2e/self12_ch2_retransmit_flight4.test.ts:18) |
| Errata 5186 message_seq + record_seq 単調増加 / OpenSSL re-HVR | 1.2 HVR wire テスト + OpenSSL `-dtls1_2` |
| RFC 9147 §5.8.2 RTO | [packages/dtls/tests/handshake/tls13/rto_from_rtt.test.ts:20](review-file:packages/dtls/tests/handshake/tls13/rto_from_rtt.test.ts:20) / [packages/dtls/tests/retransmission.test.ts:11](review-file:packages/dtls/tests/retransmission.test.ts:11) |
| HKDF / transcript / Finished / exporter vectors | `packages/dtls/tests` の tls13 vector |
| RFC 9147 両 role + BoringSSL | [packages/dtls/tests/e2e/boringssl/interop.test.ts:116](review-file:packages/dtls/tests/e2e/boringssl/interop.test.ts:116) |
| RFC 6347 dual → OpenSSL 1.2 | [packages/dtls/tests/e2e/client_dual_openssl.test.ts:10](review-file:packages/dtls/tests/e2e/client_dual_openssl.test.ts:10) |

直近検証（HEAD `bff482b9`）:

```text
cd packages/dtls && npm run type && npm test
→ 382 passed | 1 skipped

Docker: npm run test:boringssl → 5/5
```

フライト図の読み方は [packages/dtls/src/index.ts:63](review-file:packages/dtls/src/index.ts:63) と [packages/dtls/src/engine/v1_3/README.md:21](review-file:packages/dtls/src/engine/v1_3/README.md:21)。実装確認は File Viewer、コミット差分は [packages/dtls/src/index.ts](review-diff:packages/dtls/src/index.ts:commit:bff482b9) から辿れる。
