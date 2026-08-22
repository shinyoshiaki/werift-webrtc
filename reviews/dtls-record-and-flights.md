---
ide:
  viewer: review-document
  version: 1
  title: "DTLS 1.2 / 1.3 の仕組み（record と flight）"
  dock: right
  baseCommit: 3bf0b1bda91930d7e03c1613df08b5d54d773099
---
# DTLS 1.2 / 1.3 の仕組み（record と flight）

UDP 上では TLS の TCP ストリームが使えない。DTLS は **record** で 1 パケット分の保護単位を切り、**flight** で「まとめて送り、届くまで再送する」単位を切る。一次地図は [packages/dtls/src/index.ts:16](review-file:packages/dtls/src/index.ts:16) の Figure 1（1.2）と [packages/dtls/src/index.ts:63](review-file:packages/dtls/src/index.ts:63) の Figure 3（1.3）。1.3 のファイル対応は [packages/dtls/src/engine/v1_3/README.md:39](review-file:packages/dtls/src/engine/v1_3/README.md:39)。

差の一覧は `reviews/dtls12-vs-dtls13.md`、RFC 順の詳細は `reviews/epic1-dtls13-rfc-sequences.md`。本稿は **record と各 flight だけ** を短く追う。HEAD `3bf0b1bd`。

### 略語

| 略語 | 意味 |
| --- | --- |
| ACK | DTLS 1.3 の record 型 26。flight 完了通知 |
| CCS | ChangeCipherSpec。1.2 だけ。epoch 切替の合図 |
| CH / SH | ClientHello / ServerHello |
| EE | EncryptedExtensions（1.3） |
| HRR | HelloRetryRequest（1.3 Flight 2） |
| HVR | HelloVerifyRequest（1.2 Flight 2） |
| MTU | 1 datagram に載せられる最大サイズ。handshake は fragment に分割 |

[packages/dtls/src/index.ts:107](review-diff:packages/dtls/src/index.ts:commit:3bf0b1bd:107)

---

## 1. 概要

入れ子は次の順。

```text
UDP datagram
  └─ 1 個以上の record（ContentType + epoch + seq + 本体）
       └─ handshake のとき: FragmentedHandshake
            msg_type / length / message_seq / fragment_offset / fragment
```

record は暗号化と並びの単位。flight は「この束が対向に届くまで同じ bytes を再送する」単位。handshake メッセージが MTU を超えると fragment に割れ、対向で再組み立てする。

[packages/dtls/src/record/const.ts:1](review-file:packages/dtls/src/record/const.ts:1)
[packages/dtls/src/record/message/fragment.ts:7](review-file:packages/dtls/src/record/message/fragment.ts:7)
[packages/dtls/src/record/builder.ts:7](review-file:packages/dtls/src/record/builder.ts:7)
[packages/dtls/src/record/builder.ts:19](review-diff:packages/dtls/src/record/builder.ts:commit:3bf0b1bd:19)

公開入口は `DtlsClient` / `DtlsServer`。1.2 は `src/flight`、1.3 は `src/engine/v1_3`。既定は 1.2。1.3 は `protocolVersions` の opt-in。

---

## 2. Record

### 2.1 DTLS 1.2（RFC 6347）

常に **13-byte DTLSPlaintext header**:

```text
type(1) | version(2) | epoch(2) | seq(6) | length(2) | fragment
```

epoch 0 が handshake 平文。client Flight 5 / server Flight 6 の CCS のあと epoch 1 になり、Finished から AES-GCM。nonce / AAD に **epoch を混ぜる**。record seq は epoch 切替で 0 に戻す。handshake の `message_seq` とは別カウンタ（Errata 5186）。

受信は [packages/dtls/src/record/receive.ts:12](review-file:packages/dtls/src/record/receive.ts:12) が datagram を 13-byte header で順に切る。

[packages/dtls/src/record/message/plaintext.ts:21](review-file:packages/dtls/src/record/message/plaintext.ts:21)
[packages/dtls/src/record/message/header.ts:4](review-file:packages/dtls/src/record/message/header.ts:4)
[packages/dtls/src/cipher/suites/aead.ts:62](review-file:packages/dtls/src/cipher/suites/aead.ts:62)
[packages/dtls/src/cipher/suites/aead.ts:68](review-diff:packages/dtls/src/cipher/suites/aead.ts:commit:3bf0b1bd:68)

### 2.2 DTLS 1.3（RFC 9147 §4）

| epoch | record の形 | 中身 |
| --- | --- | --- |
| 0 | 1.2 と同じ 13-byte plaintext | CH / HRR / SH |
| 1 | **使わない**（PSK/0-RTT 用の予約） | — |
| 2 | unified header + AEAD | `{EE, Cert, CV, Finished}` |
| 3+ | 同上 | application / KeyUpdate。4 以降は再鍵 |

unified header は先頭 3 bit `001`。CID（C=1）は拒否。seq は header 上で `sn_key` により暗号化。nonce は `write_iv XOR left-pad64(seq)`。**epoch は nonce に入れない**。内側は InnerPlaintext（本体 + ContentType）。

[packages/dtls/src/engine/v1_3/connection-base.ts:112](review-file:packages/dtls/src/engine/v1_3/connection-base.ts:112)
[packages/dtls/src/record/v1_3/header.ts:1](review-file:packages/dtls/src/record/v1_3/header.ts:1)
[packages/dtls/src/record/v1_3/record.ts:93](review-file:packages/dtls/src/record/v1_3/record.ts:93)
[packages/dtls/src/cipher/tls13/aead.ts:40](review-file:packages/dtls/src/cipher/tls13/aead.ts:40)
[packages/dtls/src/cipher/tls13/aead.ts:61](review-diff:packages/dtls/src/cipher/tls13/aead.ts:commit:3bf0b1bd:61)

送受信の入口:

- 送信: [packages/dtls/src/engine/v1_3/flight-tx.ts:33](review-file:packages/dtls/src/engine/v1_3/flight-tx.ts:33) `sendHandshakeFlight`（epoch 0 は plaintext、2 以降は encrypt）
- 受信: [packages/dtls/src/engine/v1_3/record-rx.ts:39](review-file:packages/dtls/src/engine/v1_3/record-rx.ts:39) `handleDatagram` → 再組み立て → dispatch

1.3 だけ ContentType **ACK = 26** がある。handshake 型ではない。

[packages/dtls/src/engine/v1_3/record-rx.ts:592](review-file:packages/dtls/src/engine/v1_3/record-rx.ts:592)
[packages/dtls/src/engine/v1_3/record-rx.ts:616](review-diff:packages/dtls/src/engine/v1_3/record-rx.ts:commit:3bf0b1bd:616)

---

## 3. DTLS 1.2 flights（RFC 6347 Figure 1）

タイマー再送の土台は [packages/dtls/src/flight/flight.ts:15](review-file:packages/dtls/src/flight/flight.ts:15)。線形 RTO（0.5s, 1s, 1.5s…）。HVR 自身は再送しない（client が CH を再送する）。

[packages/dtls/src/flight/flight.ts:120](review-file:packages/dtls/src/flight/flight.ts:120)
[packages/dtls/src/flight/flight.ts:120](review-diff:packages/dtls/src/flight/flight.ts:commit:3bf0b1bd:120)

### Flight 1 — ClientHello

client が CH を送る。cipher / random / ECDHE はまだ server に commit しない（cookie 前の poison を防ぐ）。

[packages/dtls/src/flight/client/flight1.ts:10](review-file:packages/dtls/src/flight/client/flight1.ts:10)
[packages/dtls/src/client.ts:752](review-file:packages/dtls/src/client.ts:752)

### Flight 2 — HelloVerifyRequest

server が cookie だけ返す。HMAC(secret, source, CH params)。**crypto はまだ作らない**。

[packages/dtls/src/flight/server/flight2.ts:18](review-file:packages/dtls/src/flight/server/flight2.ts:18)
[packages/dtls/src/flight/server/flight2.ts:18](review-diff:packages/dtls/src/flight/server/flight2.ts:commit:3bf0b1bd:18)

### Flight 3 — ClientHello + cookie

client が同じ CH に cookie を付けて再送。複数 HVR を許容する。

[packages/dtls/src/flight/client/flight3.ts:12](review-file:packages/dtls/src/flight/client/flight3.ts:12)
[packages/dtls/src/flight/client/flight3.ts:17](review-diff:packages/dtls/src/flight/client/flight3.ts:commit:3bf0b1bd:17)

### Flight 4 — ServerHello … ServerHelloDone

cookie 検証成功後、はじめて pin / suite / ECDHE を commit。平文で SH + Certificate + ServerKeyExchange + ServerHelloDone（任意で CertificateRequest）。再送 CH2 では **同じ Flight 4 を再送**し、random を作り直さない。

[packages/dtls/src/flight/server/flight4.ts:26](review-file:packages/dtls/src/flight/server/flight4.ts:26)
[packages/dtls/src/flight/server/commitClientHello.ts:41](review-file:packages/dtls/src/flight/server/commitClientHello.ts:41)
[packages/dtls/src/server.ts:350](review-diff:packages/dtls/src/server.ts:commit:3bf0b1bd:350)

### Flight 5 — ClientKeyExchange … Finished

client が CKE（ECDHE）→ 任意 Cert/CV → **CCS** → epoch 1 の Finished。PRF で master secret。

[packages/dtls/src/flight/client/flight5.ts:37](review-file:packages/dtls/src/flight/client/flight5.ts:37)
[packages/dtls/src/flight/client/flight5.ts:199](review-file:packages/dtls/src/flight/client/flight5.ts:199)

### Flight 6 — CCS + Finished

server が CCS → epoch 1 の Finished。双方 Finished が通れば application（この実装では epoch 1）。

[packages/dtls/src/flight/server/flight6.ts:24](review-file:packages/dtls/src/flight/server/flight6.ts:24)
[packages/dtls/src/flight/server/flight6.ts:85](review-file:packages/dtls/src/flight/server/flight6.ts:85)
[packages/dtls/src/flight/server/flight6.ts:103](review-diff:packages/dtls/src/flight/server/flight6.ts:commit:3bf0b1bd:103)

Figure 2（session resume、cookie なし 3 flight）は RFC にあるが、証明書付き full HS が本実装の既定経路。

---

## 4. DTLS 1.3 flights（RFC 9147 Figure 3）

ハンドラは関数（`this: Dtls13Host`）。期待するメッセージ順は [packages/dtls/src/engine/v1_3/flight/dispatch.ts:23](review-file:packages/dtls/src/engine/v1_3/flight/dispatch.ts:23)。RTO は RFC 倍増（`computeDtlsRtoMs`）。HVR / CCS / SKE / CKE / SHD は送らない。

[packages/dtls/src/engine/v1_3/flight/dispatch.ts:16](review-file:packages/dtls/src/engine/v1_3/flight/dispatch.ts:16)
[packages/dtls/src/engine/v1_3/flight-tx.ts:325](review-diff:packages/dtls/src/engine/v1_3/flight-tx.ts:commit:3bf0b1bd:325)

### Flight 1 — ClientHello + key_share

legacy_version は `0xfefd`、`legacy_cookie` は空。実 version は `supported_versions`。cipher は `0x1301`。key_share を載せる。

[packages/dtls/src/engine/v1_3/flight/client/flight1.ts:28](review-file:packages/dtls/src/engine/v1_3/flight/client/flight1.ts:28)
[packages/dtls/src/engine/v1_3/flight/client/flight1.ts:28](review-diff:packages/dtls/src/engine/v1_3/flight/client/flight1.ts:commit:3bf0b1bd:28)

### Flight 2 — HelloRetryRequest*（任意・最大 1 回）

cookie および/または `selected_group`。stateless。RTO キャッシュしない。SH と同じ型だが Random が RFC 8446 の HRR 定数。

[packages/dtls/src/engine/v1_3/flight/server/flight2.ts:60](review-file:packages/dtls/src/engine/v1_3/flight/server/flight2.ts:60)
[packages/dtls/src/engine/v1_3/types.ts:183](review-file:packages/dtls/src/engine/v1_3/types.ts:183)

### Flight 3 — ClientHello + cookie*

Flight 1 と同じ `sendClientHello`。cookie extension と（必要なら）新しい key_share。`legacy_cookie` は空のまま。

server 受信は [packages/dtls/src/engine/v1_3/flight/server/flight4.ts:56](review-file:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:56) `onClientHello`。cookie 無しなら Flight 2 を返し、検証後に Flight 4 へ進む。

[packages/dtls/src/engine/v1_3/flight/server/flight4.ts:82](review-file:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:82)
[packages/dtls/src/engine/v1_3/flight/server/flight4.ts:236](review-diff:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:commit:3bf0b1bd:236)

### Flight 4 — ServerHello + {EE … Finished}

SH だけ epoch 0。その直後から handshake keys（epoch 2）で EncryptedExtensions、任意 CertificateRequest、Certificate、CertificateVerify、Finished。server は Finished 後に epoch 3 で app を送ってよい。

client は [packages/dtls/src/engine/v1_3/flight/client/flight4.ts:41](review-file:packages/dtls/src/engine/v1_3/flight/client/flight4.ts:41) `onServerHello` で HRR か本物の SH かを Random で分ける。

[packages/dtls/src/engine/v1_3/flight/server/flight4.ts:452](review-file:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:452)
[packages/dtls/src/engine/v1_3/flight/server/flight4.ts:505](review-diff:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:commit:3bf0b1bd:505)
[packages/dtls/src/engine/v1_3/flight/server/flight4.ts:655](review-file:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:655)

### Flight 5 — {Certificate* CertificateVerify* Finished}

client が server Finished を検証してから、任意の client 証明書と Finished を epoch 2 で送る。server が受け取ると双方 epoch 3。

[packages/dtls/src/engine/v1_3/flight/client/flight5.ts:14](review-file:packages/dtls/src/engine/v1_3/flight/client/flight5.ts:14)
[packages/dtls/src/engine/v1_3/flight/server/flight5.ts:7](review-file:packages/dtls/src/engine/v1_3/flight/server/flight5.ts:7)
[packages/dtls/src/engine/v1_3/flight/client/flight5.ts:117](review-diff:packages/dtls/src/engine/v1_3/flight/client/flight5.ts:commit:3bf0b1bd:117)

### Post-HS — ACK と KeyUpdate

Flight 5 のあと server は ACK を返す（record 26）。以降どちらかが KeyUpdate を送り、ACK が来るまで **新しい write keys では送らない**。

[packages/dtls/src/engine/v1_3/flight/post-hs.ts:5](review-file:packages/dtls/src/engine/v1_3/flight/post-hs.ts:5)
[packages/dtls/src/engine/v1_3/flight/post-hs.ts:49](review-file:packages/dtls/src/engine/v1_3/flight/post-hs.ts:49)
[packages/dtls/src/engine/v1_3/flight/post-hs.ts:58](review-diff:packages/dtls/src/engine/v1_3/flight/post-hs.ts:commit:3bf0b1bd:58)

1.2 との対応（番号は一致しない）:

```text
1.2 F1 CH          ≈ 1.3 F1 CH
1.2 F2 HVR         ≠ 1.3 F2 HRR（cookie の置き場も違う）
1.2 F3 CH+cookie   ≈ 1.3 F3 CH + cookie ext
1.2 F4 平文サーバ束 ≈ 1.3 F4 の SH だけが平文、残りは epoch 2
1.2 F5 CKE+CCS+Fin ≈ 1.3 F5 Finished（CKE/CCS なし。鍵は SH の key_share）
1.2 F6 CCS+Fin     ≈ 1.3 の ACK（CCS なし）
```

---

## 5. 判断理由

1. **record と flight を混ぜない。** record は保護と並び、flight は再送束。handshake `message_seq` を record seq に合わせない（Errata 5186）。
2. **1.2 と 1.3 の record 状態を共有しない。** epoch 1 の意味が正反対（1.2 は app、1.3 は予約）。
3. **1.3 Flight 2 を HVR にしない。** cookie は extension。`legacy_cookie` 非空は abort。

[packages/dtls/src/engine/v1_3/AGENTS.md:14](review-file:packages/dtls/src/engine/v1_3/AGENTS.md:14)

---

## 6. リスク

- 1.2 受信に anti-replay window は未統合。1.3 は epoch ごとにある。
- 1.3 は CID / PSK / 0-RTT 未実装。epoch 1 と C=1 は使わない。
- 1.2 RTO は線形のまま（dual 再送衝突回避）。1.3 だけ RFC 倍増。

---

## 7. 検証結果

| 見たいもの | 入口 |
| --- | --- |
| Figure 1 / 3 | [packages/dtls/src/index.ts:16](review-file:packages/dtls/src/index.ts:16) |
| 1.2 CH2 再送で Flight 4 を再生成しない | [packages/dtls/tests/e2e/self12_ch2_retransmit_flight4.test.ts:18](review-file:packages/dtls/tests/e2e/self12_ch2_retransmit_flight4.test.ts:18) |
| 1.3 両 role + HRR / KeyUpdate | [packages/dtls/tests/e2e/self13.test.ts:1](review-file:packages/dtls/tests/e2e/self13.test.ts:1) |
| ACK / higher-epoch 無視 | `packages/dtls/tests` の tls13 ACK 系 |

File Viewer で record / flight を開き、差分は [packages/dtls/src/index.ts](review-diff:packages/dtls/src/index.ts:commit:3bf0b1bd) から辿れる。
