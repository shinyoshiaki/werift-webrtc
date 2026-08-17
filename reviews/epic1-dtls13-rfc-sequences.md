---
ide:
  viewer: review-document
  version: 1
  title: "Epic 1: RFC シーケンスに基づく DTLS 実装解説"
  dock: right
  baseCommit: ef063d91eaab7f3a564e9ce976d816425401f4f4
---
# Epic 1: RFC シーケンスに基づく DTLS 実装解説

規範は **RFC 9147**（DTLS 1.3）+ **RFC 8446**（TLS 1.3）+ verified errata。DTLS 1.2 既定経路は **RFC 6347**、SRTP exporter は **RFC 5764**。実装のフライト図は [packages/dtls/src/index.ts:16](review-file:packages/dtls/src/index.ts:16) の Figure 1 / 3 が一次地図。ハンドラ対応は [packages/dtls/src/engine/v1_3/README.md:1](review-file:packages/dtls/src/engine/v1_3/README.md:1)。

working tree の実装は HEAD `ef063d91`。未コミットの実装差分はほぼ無いので、確認は File Viewer を先に使う。

[packages/dtls/src/index.ts:63](review-file:packages/dtls/src/index.ts:63)
[packages/dtls/src/index.ts:104](review-diff:packages/dtls/src/index.ts:commit:ef063d91:104)

---

## 1. 概要

Epic 1 は direct datagram 上の **証明書付き DTLS 1.3 full handshake** を、既存 DTLS 1.2 を壊さずに追加する。RFC が規定する「誰が何をどの順で送るか」と「確定してはいけないタイミング」が、いまのコード分割そのものになっている。

| RFC | この実装での役割 |
| --- | --- |
| RFC 9147 | 1.3 wire / record / ACK / cookie / anti-amp / RTO / KeyUpdate / dual 1.2 相互運用 |
| RFC 8446 | key schedule、HRR、DOWNGRD、CertificateVerify、KeyUpdate secret |
| RFC 6347 + Errata 5186 | 既定 1.2 flights、HVR cookie、`message_seq` vs record seq |
| RFC 5764 | `EXTRACTOR-dtls_srtp` |
| RFC 9147 Erratum 8108 | **Reported のみ**。higher-epoch ACK は無視。`illegal_parameter` では止めない |

チケット完了条件との対応:

| 完了条件 | RFC 上の根拠 | 実装入口 |
| --- | --- | --- |
| 1.3 full HS + 双方向 app data | RFC 9147 Figure 3 / §5 | Figure 3 + engine `handshake-flights` |
| `[1.3, 1.2]` fallback | RFC 9147: 1.3 は HVR を使わないが dual client は 1.2 server と相互運用する | association dual + HVR は commit ではない |
| 1.3-only × 1.2-only は version error | RFC 8446 / 9147 `protocol_version(70)` | `ProtocolVersionError` |
| DOWNGRD を弱めない | RFC 8446 §4.1.3 | dual は `[V1_3, V1_2]` のみ |
| 3× anti-amplification | RFC 9147 cookie security | `ANTI_AMPLIFICATION_FACTOR = 3` |
| `EXTRACTOR-dtls_srtp` | RFC 5764 + RFC 8446 §7.5 | 1.3 exporter / 1.2 PRF を分岐 |

公開入口は `DtlsClient` / `DtlsServer`。`selectVersion` と carrier は Public API に出さない。

[packages/dtls/src/index.ts:4](review-file:packages/dtls/src/index.ts:4)
[packages/dtls/src/index.ts:12](review-diff:packages/dtls/src/index.ts:commit:ef063d91:12)

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

状態機械は [packages/dtls/src/engine/v1_3/handshake-flights.ts:124](review-file:packages/dtls/src/engine/v1_3/handshake-flights.ts:124)。dispatch は同ファイル [packages/dtls/src/engine/v1_3/handshake-flights.ts:200](review-file:packages/dtls/src/engine/v1_3/handshake-flights.ts:200)。

| Flight | RFC | 実装 |
| --- | --- | --- |
| 1 / 3 ClientHello | §5.1、legacy_version `0xfefd`、legacy_cookie 空 | `sendClientHello` / `onClientHello` |
| 2 HRR | RFC 8446 §4.1.4、最大 1 回 | `sendHelloRetryRequest` / `onServerHello` の HRR 分岐 |
| 4 Server flight | SH + EE + Cert* + CV + Finished | `sendServerFlight` / `onServerHello` … |
| 5 client Finished | 任意 client Cert | `onFinished` client path |
| post-HS ACK | RFC 9147 §7 | `handleAck` |
| post-HS KeyUpdate | RFC 9147 §8 | `keyUpdate` / `onKeyUpdate` |

[packages/dtls/src/engine/v1_3/handshake-flights.ts:270](review-file:packages/dtls/src/engine/v1_3/handshake-flights.ts:270)
[packages/dtls/src/engine/v1_3/handshake-flights.ts:270](review-diff:packages/dtls/src/engine/v1_3/handshake-flights.ts:commit:ef063d91:270)
[packages/dtls/src/engine/v1_3/handshake-flights.ts:1312](review-file:packages/dtls/src/engine/v1_3/handshake-flights.ts:1312)

1.3 メッセージ型:

[packages/dtls/src/handshake/const.ts:10](review-file:packages/dtls/src/handshake/const.ts:10)
[packages/dtls/src/record/const.ts:6](review-file:packages/dtls/src/record/const.ts:6)

### 2.2 ClientHello / ServerHello の MUST（RFC 9147）

Server が CH を受けたときの必須検査:

1. `legacy_version` は **DTLS 1.2 (`0xfefd`)**。wire の 1.3 は `supported_versions` で運ぶ。
2. `compression_methods` は **`[0]` のみ**。
3. **`legacy_cookie` は空**。非空なら abort（`illegal_parameter`）。DTLS 1.3 の cookie は extension 44。
4. TLS compatibility mode は使わない。`legacy_session_id` は空をエコー。

[packages/dtls/src/engine/v1_3/handshake-flights.ts:534](review-file:packages/dtls/src/engine/v1_3/handshake-flights.ts:534)
[packages/dtls/src/engine/v1_3/handshake-flights.ts:552](review-diff:packages/dtls/src/engine/v1_3/handshake-flights.ts:commit:ef063d91:552)

ServerHello 側も `legacy_version == 0xfefd`、`compression_method == 0`、session_id echo。

[packages/dtls/src/engine/v1_3/handshake-flights.ts:1320](review-file:packages/dtls/src/engine/v1_3/handshake-flights.ts:1320)
[packages/dtls/src/engine/v1_3/handshake-flights.ts:1320](review-diff:packages/dtls/src/engine/v1_3/handshake-flights.ts:commit:ef063d91:1320)

HRR 判定は RFC 8446 の特殊 Random:

```text
CF21AD74E59A6111BE1D8C021E65B891C2A211167ABB8C5E079E09E2C8A8339C
```

[packages/dtls/src/engine/v1_3/types.ts:153](review-file:packages/dtls/src/engine/v1_3/types.ts:153)
[packages/dtls/src/engine/v1_3/handshake-flights.ts:1357](review-file:packages/dtls/src/engine/v1_3/handshake-flights.ts:1357)

### 2.3 Version 交渉（RFC 8446 `supported_versions` + RFC 8446 §4.1.3 DOWNGRD）

Wire:

- record / selected 1.3 = `0xfefc`
- CH/SH の legacy field = `0xfefd`
- 実選択は extension 43

[packages/dtls/src/version.ts:10](review-file:packages/dtls/src/version.ts:10)
[packages/dtls/src/version.ts:35](review-file:packages/dtls/src/version.ts:35)

両 role が同じ `selectVersion(localPreference, peerSupported)`。交差が空なら timeout ではなく `ProtocolVersionError`（alert `protocol_version(70)`）。

[packages/dtls/src/version.ts:105](review-file:packages/dtls/src/version.ts:105)
[packages/dtls/src/version.ts:105](review-diff:packages/dtls/src/version.ts:commit:ef063d91:105)
[packages/dtls/src/server.ts:161](review-file:packages/dtls/src/server.ts:161)

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
[packages/dtls/src/socket.ts:1022](review-file:packages/dtls/src/socket.ts:1022)
[packages/dtls/src/flight/server/flight4.ts:82](review-file:packages/dtls/src/flight/server/flight4.ts:82)
[packages/dtls/src/flight/server/flight4.ts:82](review-diff:packages/dtls/src/flight/server/flight4.ts:commit:ef063d91:82)
[packages/dtls/src/client.ts:1274](review-file:packages/dtls/src/client.ts:1274)
[packages/dtls/src/handshake/random.ts:43](review-file:packages/dtls/src/handshake/random.ts:43)

### 2.4 Dual 1.2/1.3 — RFC 9147 の「HVR は 1.3 では使わない」をどう実装したか

RFC 9147 は DTLS 1.3 で **HelloVerifyRequest を使わず HRR を使う**。同時に **dual 1.2/1.3 client は 1.2 server と相互運用できる必要がある**。

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

[packages/dtls/src/client.ts:49](review-file:packages/dtls/src/client.ts:49)
[packages/dtls/src/client.ts:70](review-diff:packages/dtls/src/client.ts:commit:ef063d91:70)

1.3 engine が HVR を受けたとき、1.3-only なら `ProtocolVersionError`。dual なら `DtlsVersionSelected(V1_2)` で association に返し、**CH-A を捨てない**。

[packages/dtls/src/engine/v1_3/handshake-flights.ts:205](review-file:packages/dtls/src/engine/v1_3/handshake-flights.ts:205)
[packages/dtls/src/client.ts:703](review-file:packages/dtls/src/client.ts:703)
[packages/dtls/src/client.ts:703](review-diff:packages/dtls/src/client.ts:commit:ef063d91:703)

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

### 2.5 HRR + cookie + group（RFC 8446 §4.1.4 / RFC 9147 §5.1）

```text
CH1 (key_share が空、または server が別 group を選ぶ)
  → HRR { cookie*, selected_group* }     ※ stateless、RTO キャッシュしない
CH2 ≒ CH1 except RFC 8446 §4.1.4 が許す差
  cookie 検証 → 失敗なら illegal_parameter（この試行だけ）
  selected_group は client supported_groups ∩ server groups
  HRR は高々 1 回
```

[packages/dtls/src/engine/v1_3/handshake-flights.ts:649](review-file:packages/dtls/src/engine/v1_3/handshake-flights.ts:649)
[packages/dtls/src/engine/v1_3/handshake-flights.ts:752](review-file:packages/dtls/src/engine/v1_3/handshake-flights.ts:752)
[packages/dtls/src/engine/v1_3/handshake-flights.ts:752](review-diff:packages/dtls/src/engine/v1_3/handshake-flights.ts:commit:ef063d91:752)
[packages/dtls/src/engine/v1_3/handshake-flights.ts:1389](review-file:packages/dtls/src/engine/v1_3/handshake-flights.ts:1389)

HRR transcript は CH1 を `message_hash` で置き換える（RFC 8446 §4.4.1）。

[packages/dtls/src/engine/v1_3/transcript.ts:21](review-file:packages/dtls/src/engine/v1_3/transcript.ts:21)

Cookie は HMAC(secret, peer, CH hash, expiry)。RFC 9147 の「cookie は client address に依存する」。address 検証前の TX は受信の **3 倍以内**。

[packages/dtls/src/engine/v1_3/types.ts:12](review-file:packages/dtls/src/engine/v1_3/types.ts:12)
[packages/dtls/src/engine/v1_3/flight-tx.ts:287](review-file:packages/dtls/src/engine/v1_3/flight-tx.ts:287)
[packages/dtls/src/engine/v1_3/flight-tx.ts:304](review-diff:packages/dtls/src/engine/v1_3/flight-tx.ts:commit:ef063d91:304)

### 2.6 RFC 6347 Figure 1 — DTLS 1.2（既定経路）

```text
ClientHello          -------->   Flight 1
                     <-------    HelloVerifyRequest   Flight 2
ClientHello+cookie   -------->   Flight 3
                     <-------    SH + Cert + SKE + SHD  Flight 4
CKE + CCS + Finished -------->
                     <-------    CCS + Finished         Flight 6
```

[packages/dtls/src/index.ts:16](review-file:packages/dtls/src/index.ts:16)

**CH1 では association crypto を commit しない**（RFC 6347 cookie = return-routability）。cookie は HMAC(secret, source, CH params excluding legacy_cookie)。CH2 で検証成功して初めて pin / suite / random / ECDHE / EMS を一括 commit。

[packages/dtls/src/flight/server/flight2.ts:18](review-file:packages/dtls/src/flight/server/flight2.ts:18)
[packages/dtls/src/handshake/extensions/cookie.ts:146](review-file:packages/dtls/src/handshake/extensions/cookie.ts:146)
[packages/dtls/src/handshake/extensions/cookie.ts:162](review-diff:packages/dtls/src/handshake/extensions/cookie.ts:commit:ef063d91:162)
[packages/dtls/src/flight/server/commitClientHello.ts:35](review-file:packages/dtls/src/flight/server/commitClientHello.ts:35)

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
[packages/dtls/src/flight/server/flight2.ts:33](review-diff:packages/dtls/src/flight/server/flight2.ts:commit:ef063d91:33)
[packages/dtls/src/flight/server/flight4.ts:46](review-file:packages/dtls/src/flight/server/flight4.ts:46)

Client は複数 HVR を処理できる（RFC 6347）。`hvrGeneration` で古い Flight3 RTO を止める。

[packages/dtls/src/flight/client/flight3.ts:17](review-file:packages/dtls/src/flight/client/flight3.ts:17)
[packages/dtls/src/flight/client/flight3.ts:17](review-diff:packages/dtls/src/flight/client/flight3.ts:commit:ef063d91:17)

### 2.7 Transcript と key schedule（RFC 8446 §4.4.1 / §7.1、RFC 9147 label）

Transcript に含めない: record header、fragment metadata、再送 duplicate、ACK。ハッシュ入力は `msg_type(1) || length(3) || body`（DTLS の `message_seq` / fragment 欄は除く）。

[packages/dtls/src/engine/v1_3/transcript.ts:4](review-file:packages/dtls/src/engine/v1_3/transcript.ts:4)
[packages/dtls/src/engine/v1_3/transcript.ts:4](review-diff:packages/dtls/src/engine/v1_3/transcript.ts:commit:ef063d91:4)

```text
Early Secret     = HKDF-Extract(0, PSK=0)
Handshake Secret = HKDF-Extract(Derive-Secret(ES,"derived",""), ECDHE)
  c/s hs traffic = Derive-Secret(HS, "c/s hs traffic", Hello transcript)
Master Secret    = HKDF-Extract(Derive-Secret(HS,"derived",""), 0)
  app traffic / exporter / resumption
```

Expand-Label の prefix は TLS の `tls13 ` ではなく **`dtls13`**。

[packages/dtls/src/cipher/tls13/hkdf.ts:4](review-file:packages/dtls/src/cipher/tls13/hkdf.ts:4)
[packages/dtls/src/cipher/tls13/hkdf.ts:50](review-file:packages/dtls/src/cipher/tls13/hkdf.ts:50)
[packages/dtls/src/cipher/tls13/keySchedule.ts:35](review-file:packages/dtls/src/cipher/tls13/keySchedule.ts:35)
[packages/dtls/src/cipher/tls13/keySchedule.ts:47](review-diff:packages/dtls/src/cipher/tls13/keySchedule.ts:commit:ef063d91:47)

CertificateVerify は RFC 8446 §4.4.3。**`rsa_pkcs1_*` は禁止**。RSA は `rsa_pss_rsae_sha256` のみ。既存 1.2 PKCS#1 経路は流用しない。

[packages/dtls/src/cipher/tls13/signature.ts:69](review-file:packages/dtls/src/cipher/tls13/signature.ts:69)
[packages/dtls/src/cipher/tls13/signature.ts:69](review-diff:packages/dtls/src/cipher/tls13/signature.ts:commit:ef063d91:69)

SRTP（RFC 5764）は label **`EXTRACTOR-dtls_srtp`**。1.3 は RFC 8446 §7.5 exporter、1.2 は既存 PRF。Public `extractSessionKeys` の意味は変えない。

[packages/dtls/src/cipher/tls13/keySchedule.ts:221](review-file:packages/dtls/src/cipher/tls13/keySchedule.ts:221)
[packages/dtls/src/engine/v1_3/connection.ts:108](review-file:packages/dtls/src/engine/v1_3/connection.ts:108)
[packages/dtls/src/socket.ts:777](review-file:packages/dtls/src/socket.ts:777)
[packages/dtls/src/socket.ts:783](review-diff:packages/dtls/src/socket.ts:commit:ef063d91:783)

### 2.8 Record layer（RFC 9147 §4）

| epoch | 用途 |
| --- | --- |
| 0 | DTLSPlaintext |
| **1** | **予約・未使用**（PSK/0-RTT を実装済みと宣言しない） |
| 2 | handshake traffic |
| 3 | 初期 application |
| 4+ | KeyUpdate 後。`nextAppEpoch` は 1 を飛ばす |

[packages/dtls/src/engine/v1_3/handshake-flights.ts:1914](review-file:packages/dtls/src/engine/v1_3/handshake-flights.ts:1914)

Unified header（§4.1）: 固定 bit `001`、**C=1（CID）は拒否**。AAD は送出 header。nonce は `write_iv XOR left-pad64(seq)`。**epoch は nonce に入れない**（1.2 の 13-byte AAD + explicit nonce と混ぜない）。

[packages/dtls/src/record/v1_3/header.ts:1](review-file:packages/dtls/src/record/v1_3/header.ts:1)
[packages/dtls/src/record/v1_3/header.ts:75](review-file:packages/dtls/src/record/v1_3/header.ts:75)
[packages/dtls/src/cipher/tls13/aead.ts:40](review-file:packages/dtls/src/cipher/tls13/aead.ts:40)
[packages/dtls/src/cipher/tls13/aead.ts:61](review-diff:packages/dtls/src/cipher/tls13/aead.ts:commit:ef063d91:61)
[packages/dtls/src/record/v1_3/record.ts:70](review-file:packages/dtls/src/record/v1_3/record.ts:70)

1.3 受信 path は epoch ごとに `AntiReplayWindow`。1.2 受信 path への適用は回帰回避のため未統合（チケットどおり任意）。

### 2.9 ACK と KeyUpdate（RFC 9147 §7 / §8）

- ContentType **ACK = 26**
- empty ACK は何も完了させない（未 ACK flight を再送）
- ACK 自身の epoch より高い RecordNumber は **適用しない**（plaintext ACK で encrypted flight を完了させない）
- Erratum 8108（Reported）は higher-epoch を `illegal_parameter` にする案。verified ではないので **無視**し、準拠宣言もしない

[packages/dtls/src/engine/v1_3/record-rx.ts:580](review-file:packages/dtls/src/engine/v1_3/record-rx.ts:580)
[packages/dtls/src/engine/v1_3/record-rx.ts:606](review-diff:packages/dtls/src/engine/v1_3/record-rx.ts:commit:ef063d91:606)

KeyUpdate: **現行 write keys で送り、ACK が来るまで新 keys では送らない**（§8）。`update_requested` なら応答 KU を先に送る。

[packages/dtls/src/engine/v1_3/handshake-flights.ts:1921](review-file:packages/dtls/src/engine/v1_3/handshake-flights.ts:1921)
[packages/dtls/src/engine/v1_3/handshake-flights.ts:1928](review-diff:packages/dtls/src/engine/v1_3/handshake-flights.ts:commit:ef063d91:1928)
[packages/dtls/src/cipher/tls13/keySchedule.ts:207](review-file:packages/dtls/src/cipher/tls13/keySchedule.ts:207)

### 2.10 RTO（RFC 9147 §5.8.2）

| 条件 | RFC | 実装 |
| --- | --- | --- |
| RTT unknown | initial 1000ms | `INITIAL_RTO_MS` |
| DTLS-SRTP profile | default 400ms | `use_srtp` 設定時 `DTLS_SRTP_INITIAL_RTO_MS` |
| RTT known（ICE 等） | 1.5 × RTT | `RTO_FACTOR = 1.5` |
| 再送 | 倍増 | `base * 2^retransmitCount`、上限 60s |

`DirectHandshakeCarrier` の未測定 RTT は 0。偽の 100ms sample は使わない。

[packages/dtls/src/engine/v1_3/types.ts:15](review-file:packages/dtls/src/engine/v1_3/types.ts:15)
[packages/dtls/src/engine/v1_3/flight-tx.ts:322](review-file:packages/dtls/src/engine/v1_3/flight-tx.ts:322)
[packages/dtls/src/engine/v1_3/flight-tx.ts:328](review-diff:packages/dtls/src/engine/v1_3/flight-tx.ts:commit:ef063d91:328)

### 2.11 1-RTT 後の application data と early server data

RFC 9147 は server Finished 後・client Finished 前の epoch 3 送信を許す。self では送受信できる。WebRTC fingerprint ゲートは Epic 3。

[packages/dtls/src/engine/v1_3/handshake-flights.ts:1304](review-file:packages/dtls/src/engine/v1_3/handshake-flights.ts:1304)

reorder で Finished 前に epoch-3 app data が来る場合は小さな buffer（RFC は buffer または discard）。

[packages/dtls/src/engine/v1_3/types.ts:72](review-file:packages/dtls/src/engine/v1_3/types.ts:72)

---

## 3. 判断理由

1. **HVR を version commit にしない。** RFC 9147 は 1.3 で HVR を使わない。同時に dual client の 1.2 相互運用は必須。未認証 HVR で CH-A / ECDHE を捨てると、遅延 SH/HRR と RFC の再送モデルが両立しない。
2. **DOWNGRD を弱めない。** 1.3-capable server の 1.2 選択は sentinel 必須。公開 dual を 1.3 優先だけにし、API と RFC を一致させた。
3. **1.2 と 1.3 の mutable state を共有しない。** epoch / transcript / keys / replay / timer は RFC 上も別プロトコル世代。既存 1.2 PRF / explicit-nonce を書き換えない。
4. **CH1 で association に commit しない。** RFC 6347 cookie は「その address で cookie を受信できた」ことの証明。pre-cookie の共有 cipher state は別 source の CH で poison できる。
5. **handshake seq と record seq を混ぜない。** Errata 5186。record seq 巻き戻しは anti-replay 付き peer（OpenSSL `-dtls1_2`）で HVR2 を殺す。
6. **verified errata だけ MUST 扱い。** 8108 は Reported。higher-epoch ACK 無視を仕様として明示し、誤って準拠宣言しない。
7. **cookie は address + CH に bind。** RFC 6347 の HMAC(Secret, Client-IP, Client-Parameters) 例と RFC 9147 cookie security。検証前の TX は 3×。
8. **peer-auth と 5-tuple pin を分ける。** RFC の cookie/address validation は generic UDP 向け。ICE は既に peer 認証済みで source を渡さない。lifecycle（`protocol_version` / close_notify）を pin だけで決めると WebRTC 既定 1.2 が RFC の abort 意味を失う。

[packages/dtls/src/socket.ts:240](review-file:packages/dtls/src/socket.ts:240)
[packages/dtls/src/engine/v1_3/types.ts:97](review-file:packages/dtls/src/engine/v1_3/types.ts:97)

---

## 4. リスク（RFC との残差）

- **DTLS 1.2 受信 path に record anti-replay は未統合。** RFC 6347 は replay window を規定する。1.3 は epoch ごと必須。1.2 は「回帰を避け任意」。self 1.2 は duplicate record seq を検出できない。OpenSSL re-HVR は対向側 window で担保。
- **dual probing は RFC が想定する「1.3 は HRR、1.2 は HVR」の交差点。** cookie CH は 1.3-only server に 47 を誘発し得る。抑制は probing + description 47 に閉じているが、並行 candidate は後続変更で再発しやすい。
- **PSK / 0-RTT / CID / RRC は未実装。** epoch 1 予約、C=1 拒否。実装済みと宣言しない。
- **Erratum 8108 を採用していない。** 将来 Verified になった場合、higher-epoch ACK を fatal にする変更が必要。
- **OpenSSL DTLS 1.3 interop は対象外。** 外部 1.3 参照は BoringSSL。
- **`external` retransmission は骨格のみ。** RFC の RTO を SPED が駆動するのは Epic 2。

---

## 5. 検証結果

RFC シーケンスに対応するテスト入口:

| RFC 観点 | テスト |
| --- | --- |
| version / DOWNGRD / `[1.2,1.3]` normalize | [packages/dtls/tests/version/selectVersion.test.ts:14](review-file:packages/dtls/tests/version/selectVersion.test.ts:14) |
| HVR は commit ではない / CH-A 再送 / 遅延 SH | [packages/dtls/tests/e2e/self13_dual_hvr_resume.test.ts:57](review-file:packages/dtls/tests/e2e/self13_dual_hvr_resume.test.ts:57) |
| RFC 6347 cookie bind / 別 peer 拒否 | [packages/dtls/tests/e2e/self12_cookie_binding.test.ts:244](review-file:packages/dtls/tests/e2e/self12_cookie_binding.test.ts:244) |
| CH2 再送で Flight4 を再生成しない | [packages/dtls/tests/e2e/self12_ch2_retransmit_flight4.test.ts:44](review-file:packages/dtls/tests/e2e/self12_ch2_retransmit_flight4.test.ts:44) |
| Errata 5186 message_seq + record_seq 単調増加 / OpenSSL re-HVR | 1.2 HVR wire テスト + OpenSSL `-dtls1_2` |
| RFC 9147 §5.8.2 RTO | [packages/dtls/tests/handshake/tls13/rto_from_rtt.test.ts:8](review-file:packages/dtls/tests/handshake/tls13/rto_from_rtt.test.ts:8) |
| HKDF / transcript / Finished / exporter vectors | `packages/dtls/tests` の tls13 vector |
| RFC 9147 両 role + BoringSSL | [packages/dtls/tests/e2e/boringssl/interop.test.ts:116](review-file:packages/dtls/tests/e2e/boringssl/interop.test.ts:116) |
| RFC 6347 dual → OpenSSL 1.2 | [packages/dtls/tests/e2e/client_dual_openssl.test.ts:10](review-file:packages/dtls/tests/e2e/client_dual_openssl.test.ts:10) |

直近検証（実装報告時）:

```text
cd packages/dtls && npm test
→ 371+ passed（環境により skip あり）

npm run type && npm run test:small
→ 成功

Docker: npm run test:boringssl → 5/5
```

フライト図の読み方は [packages/dtls/src/index.ts:63](review-file:packages/dtls/src/index.ts:63) と [packages/dtls/src/engine/v1_3/README.md:19](review-file:packages/dtls/src/engine/v1_3/README.md:19)。実装確認は File Viewer、コミット差分は [packages/dtls/src/index.ts](review-diff:packages/dtls/src/index.ts:commit:ef063d91) から辿れる。
