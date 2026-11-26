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
| Cert / CV | Certificate / CertificateVerify |
| CH / SH | ClientHello / ServerHello |
| CKE / SKE | ClientKeyExchange / ServerKeyExchange（1.2 だけ） |
| EE | EncryptedExtensions（1.3） |
| HRR | HelloRetryRequest（1.3 Flight 2） |
| HVR | HelloVerifyRequest（1.2 Flight 2） |
| KU | KeyUpdate（1.3 post-HS） |
| MTU | 1 datagram に載せられる最大サイズ。handshake は fragment に分割 |
| SHD | ServerHelloDone（1.2 だけ） |

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

**目的:** 握手を開始し、client の能力（cipher / 拡張 / random）を伝える。まだ「その UDP 送信元が返せる」ことの証明は無い。server はここで suite / ECDHE を **commit しない**（cookie 前の poison を防ぐ）。

| メッセージ | 目的 |
| --- | --- |
| ClientHello | 提案: version、cipher 一覧、client random、extensions（`use_srtp`、EMS、supported_groups など）。鍵交換の公開値はまだ載せない（SKE/CKE が担う） |

[packages/dtls/src/flight/client/flight1.ts:10](review-file:packages/dtls/src/flight/client/flight1.ts:10)
[packages/dtls/src/client.ts:752](review-file:packages/dtls/src/client.ts:752)

### Flight 2 — HelloVerifyRequest

**目的:** return-routability。cookie をそのアドレスへ届け、増幅攻撃と偽送信元を抑える。**version 確定でも鍵確定でもない。** HVR 自身は再送しない。

| メッセージ | 目的 |
| --- | --- |
| HelloVerifyRequest | HMAC(secret, source, CH params) の cookie を渡す。対向が同じ CH を cookie 付きで返せるか試す |

[packages/dtls/src/flight/server/flight2.ts:18](review-file:packages/dtls/src/flight/server/flight2.ts:18)
[packages/dtls/src/flight/server/flight2.ts:18](review-diff:packages/dtls/src/flight/server/flight2.ts:commit:3bf0b1bd:18)

### Flight 3 — ClientHello + cookie

**目的:** 「HVR をそのアドレスで受け取った」ことを示す。中身は Flight 1 と同じ CH に `legacy_cookie` を付けたもの。複数 HVR（re-challenge）を許容する。

| メッセージ | 目的 |
| --- | --- |
| ClientHello（cookie 付き） | 同じ random / 提案のまま cookie をエコーし、server が Flight 4 を始めてよいと示す |

[packages/dtls/src/flight/client/flight3.ts:12](review-file:packages/dtls/src/flight/client/flight3.ts:12)
[packages/dtls/src/flight/client/flight3.ts:17](review-diff:packages/dtls/src/flight/client/flight3.ts:commit:3bf0b1bd:17)

### Flight 4 — ServerHello … ServerHelloDone

**目的:** cookie 検証成功後、はじめて pin / suite / ECDHE を commit し、server 側の選択と身元・鍵材料を平文で渡す。再送 CH2 では **同じ Flight 4 を再送**し、random を作り直さない。

| メッセージ | 目的 |
| --- | --- |
| ServerHello | 選んだ version / cipher / server random / session_id。DOWNGRD が要るときは Random 末尾に入れる |
| Certificate | server の X.509。fingerprint / 署名検証の対象 |
| ServerKeyExchange | ECDHE 公開鍵 + 証明書秘密鍵による署名。PMS の片側と「この Cert の持ち主」を同時に示す |
| CertificateRequest* | 相互認証。client に Cert + CV を要求 |
| ServerHelloDone | server の平文束の終わり。client は Flight 5 を送ってよい |

[packages/dtls/src/flight/server/flight4.ts:26](review-file:packages/dtls/src/flight/server/flight4.ts:26)
[packages/dtls/src/flight/server/commitClientHello.ts:41](review-file:packages/dtls/src/flight/server/commitClientHello.ts:41)
[packages/dtls/src/server.ts:350](review-diff:packages/dtls/src/server.ts:commit:3bf0b1bd:350)

### Flight 5 — ClientKeyExchange … Finished

**目的:** client の ECDHE 片側を渡し、PRF で master secret を作り、CCS で epoch 1 に切り、Finished で transcript を認証する。相互認証なら先に Cert + CV。

| メッセージ | 目的 |
| --- | --- |
| Certificate* | client の X.509（CertificateRequest があったとき） |
| ClientKeyExchange | client の ECDHE 公開鍵。server と合わせて premaster → master secret |
| CertificateVerify* | これまでの handshake を client 秘密鍵で署名。Cert の持ち主であることを示す |
| ChangeCipherSpec | 以降の record を epoch 1 の AEAD で書く合図（handshake メッセージではない） |
| Finished | master secret 由来の verify_data。鍵合意と transcript の一致を証明 |

[packages/dtls/src/flight/client/flight5.ts:37](review-file:packages/dtls/src/flight/client/flight5.ts:37)
[packages/dtls/src/flight/client/flight5.ts:199](review-file:packages/dtls/src/flight/client/flight5.ts:199)

### Flight 6 — CCS + Finished

**目的:** server も epoch 1 に切り替え、同じ transcript を Finished で閉じる。双方 Finished が通れば application（この実装では epoch 1）。

| メッセージ | 目的 |
| --- | --- |
| ChangeCipherSpec | server write を epoch 1 にする合図 |
| Finished | server 側の verify_data。client の Flight 5 と同じ master secret / transcript を確認 |

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

**目的:** 握手を開始し、1.3 の能力と **最初の ECDHE 公開鍵** を同時に出す（1.2 の CKE 相当を CH に前倒し）。アドレス検証前なので server はまだ大きな Flight 4 を増幅しない。

| メッセージ | 目的 |
| --- | --- |
| ClientHello | `legacy_version=0xfefd`、`legacy_cookie` 空。`supported_versions` で実 version。cipher `0x1301`。`key_share` で ECDHE。`signature_algorithms` / `use_srtp` など |

[packages/dtls/src/engine/v1_3/flight/client/flight1.ts:28](review-file:packages/dtls/src/engine/v1_3/flight/client/flight1.ts:28)
[packages/dtls/src/engine/v1_3/flight/client/flight1.ts:28](review-diff:packages/dtls/src/engine/v1_3/flight/client/flight1.ts:commit:3bf0b1bd:28)

### Flight 2 — HelloRetryRequest*（任意・最大 1 回）

**目的:** 1.2 の HVR に相当する「小さな挑戦」だが、置き場が違う。cookie でアドレス検証し、必要なら `selected_group` で key_share をやり直させる。stateless。RTO キャッシュしない。SH と同じ handshake 型で、Random が HRR 定数なら HRR。

| メッセージ | 目的 |
| --- | --- |
| HelloRetryRequest | cookie extension 44 および/または `selected_group`。CH2 が満たすべき条件を指示する。version の最終確定ではない（本物の SH が確定） |

[packages/dtls/src/engine/v1_3/flight/server/flight2.ts:60](review-file:packages/dtls/src/engine/v1_3/flight/server/flight2.ts:60)
[packages/dtls/src/engine/v1_3/types.ts:183](review-file:packages/dtls/src/engine/v1_3/types.ts:183)

<!-- review-bookmark id="bm_1a02745a65c-a6dc11e8" title="Flight 2 — HelloRetryRequest*（任意・最大 1 回）" -->
### Flight 3 — ClientHello + cookie*

**目的:** HRR の条件を満たした CH を出し、server が Flight 4 を増幅してよい状態にする。`legacy_cookie` は空のまま（cookie は extension）。

| メッセージ | 目的 |
| --- | --- |
| ClientHello | Flight 1 と同じ形 + cookie extension。group を変えられたときは新しい `key_share`。CH1 との差は RFC 8446 §4.1.4 が許す範囲だけ |

server 受信は [packages/dtls/src/engine/v1_3/flight/server/flight4.ts:56](review-file:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:56) `onClientHello`。cookie 無しなら Flight 2 を返し、検証後に Flight 4 へ進む。

[packages/dtls/src/engine/v1_3/flight/server/flight4.ts:82](review-file:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:82)
[packages/dtls/src/engine/v1_3/flight/server/flight4.ts:236](review-diff:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:commit:3bf0b1bd:236)

### Flight 4 — ServerHello + {EE … Finished}

**目的:** version / cipher / ECDHE を確定し、handshake traffic keys（epoch 2）を立て、server の身元と Finished までを **同じ束** で送る。SH だけ平文。残りは `{ }`。CCS / SKE / SHD は無い。server は自分の Finished 後に epoch 3 で app を送ってよい。

client は [packages/dtls/src/engine/v1_3/flight/client/flight4.ts:41](review-file:packages/dtls/src/engine/v1_3/flight/client/flight4.ts:41) `onServerHello` で HRR か本物の SH かを Random で分ける。

| メッセージ | 目的 |
| --- | --- |
| ServerHello | 選んだ 1.3（`supported_versions`）、cipher、server `key_share`。これと CH の key_share から handshake secret が立つ |
| EncryptedExtensions | SH に出せない拡張（`use_srtp` など）。handshake keys で保護 |
| CertificateRequest* | 相互認証。client に Cert + CV を要求 |
| Certificate | server 身元（TLS 1.3 の Cert 形式） |
| CertificateVerify | transcript を server 秘密鍵で署名（`rsa_pkcs1_*` 禁止） |
| Finished | handshake traffic secret の verify_data。server 側握手の完了と transcript 認証 |

[packages/dtls/src/engine/v1_3/flight/server/flight4.ts:452](review-file:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:452)
[packages/dtls/src/engine/v1_3/flight/server/flight4.ts:505](review-diff:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:commit:3bf0b1bd:505)
[packages/dtls/src/engine/v1_3/flight/server/flight4.ts:655](review-file:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:655)

### Flight 5 — {Certificate* CertificateVerify* Finished}

**目的:** server Finished を検証したあと、client 側の握手を閉じ application keys（epoch 3）へ進む。CKE / CCS は無い（鍵はすでに SH の key_share）。

| メッセージ | 目的 |
| --- | --- |
| Certificate* | client 身元（CertificateRequest があったとき） |
| CertificateVerify* | client が transcript を署名 |
| Finished | client handshake traffic secret の verify_data。これが通ると双方 epoch 3 |

[packages/dtls/src/engine/v1_3/flight/client/flight5.ts:14](review-file:packages/dtls/src/engine/v1_3/flight/client/flight5.ts:14)
[packages/dtls/src/engine/v1_3/flight/server/flight5.ts:7](review-file:packages/dtls/src/engine/v1_3/flight/server/flight5.ts:7)
[packages/dtls/src/engine/v1_3/flight/client/flight5.ts:117](review-diff:packages/dtls/src/engine/v1_3/flight/client/flight5.ts:commit:3bf0b1bd:117)

### Post-HS — ACK と KeyUpdate

**目的:** handshake 後の損失回復と再鍵。1.2 の Flight 6 CCS に相当する「切替合図」は無く、ACK が再送を止め、KeyUpdate が app 鍵を回す。

| メッセージ | 目的 |
| --- | --- |
| ACK（record 26） | 受信した RecordNumber を列挙し、対向の pending flight 再送を止める。handshake 型ではない |
| KeyUpdate | application traffic secret を更新。現行 write keys で送り、ACK まで新 keys では送らない |

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
