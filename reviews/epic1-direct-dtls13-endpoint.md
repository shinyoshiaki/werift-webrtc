---
ide:
  viewer: review-document
  version: 1
  title: "Epic 1: Direct DTLS 1.3 endpoint — レビュー解説"
  dock: right
  baseCommit: ef063d91eaab7f3a564e9ce976d816425401f4f4
---
# Epic 1: Direct DTLS 1.3 endpoint — レビュー解説

ブランチ `ticket/5fc64332-b0d1-4ab0-bc1e-4b0f3a26c135`（HEAD `ef063d91`、`origin` より 2 コミット先行）の現状です。チケット完了条件と、複数ラウンドのレビュー指摘、その後の **Docker 内 BoringSSL 相互接続** まで含めて説明します。working tree はクリーンです。実装確認は File Viewer、BoringSSL 修正の差分は `ef063d91` の Diff リンクを使ってください。

---

## 1. 概要

WARP の土台として、`packages/dtls` に **direct datagram 上の完全な DTLS 1.3 エンドポイント** を追加した。既定は DTLS 1.2 のまま。1.3 は `protocolVersions` の明示 opt-in。ICE / SPED / `RTCPeerConnection` 統合はスコープ外だが、後続 Epic 用の **carrier 抽象** と **peer-auth 境界** までは入れている。

チケットの完了条件との対応:

| 完了条件 | 現状 |
| --- | --- |
| werift 同士で 1.3 full HS + 双方向 app data | self E2E（両 role / HRR / mutual auth / KeyUpdate / loss） |
| BoringSSL 両 role interop（AES-128-GCM + X25519） | pin `a204be27` + `dtls13_echo`。Docker で **5/5 成功**。CI `dtls13-boringssl` も必須 |
| OpenSSL `-dtls1_2` 回帰 | 既存 E2E 維持 + dual fallback 両 role |
| `[1.3, 1.2]` → 1.2-only fallback / 1.3-only × 1.2-only は version error | association `selectVersion` + `ProtocolVersionError` |
| 既定 1.2 / WebRTC 非破壊 | `Options` 未指定は `[V1_2]`。`packages/webrtc` のコンストラクタ互換は維持 |
| `EXTRACTOR-dtls_srtp` | 1.3 は TLS 1.3 exporter、1.2 は既存 PRF 経路 |
| carrier + immutable flight + cancelable timer | `DtlsHandshakeCarrier` + close 時の candidate 一括 teardown |

公開入口は従来どおり `DtlsClient` / `DtlsServer`。内部の `selectVersion` や carrier は Public API に出さない。

[packages/dtls/src/index.ts:4](review-file:packages/dtls/src/index.ts:4)
[packages/dtls/src/index.ts:12](review-diff:packages/dtls/src/index.ts:12)
[packages/dtls/README.md:44](review-file:packages/dtls/README.md:44)

---

## 2. 主要変更

### 2.1 バージョン設定と association 層

`Options.protocolVersions` の順序が優先順位。未指定は `[V1_2]`。dual は **`[V1_3, V1_2]` のみ**。`[V1_2, V1_3]` は DOWNGRD と両立しないため normalize する。

[packages/dtls/src/socket.ts:1022](review-file:packages/dtls/src/socket.ts:1022)
[packages/dtls/src/socket.ts:1030](review-diff:packages/dtls/src/socket.ts:1030)
[packages/dtls/src/version.ts:35](review-file:packages/dtls/src/version.ts:35)
[packages/dtls/src/version.ts:51](review-diff:packages/dtls/src/version.ts:51)
[packages/dtls/src/version.ts:105](review-file:packages/dtls/src/version.ts:105)

両 role が同じ `selectVersion(localPreference, peerSupported)` を使う。交差が空なら `ProtocolVersionError`（timeout ではない）。

Server は ClientHello の `supported_versions` を読んで 1.3 / 1.2 を dispatch する。1.3 なら engine に CH を再注入し、1.2 なら既存 flight 経路へ残す。1.2-only × 1.3-only は `protocol_version` alert。lifecycle fatal にするかは **UDP pin ではなく** `hasAssociationPeerAuth()`。

[packages/dtls/src/server.ts:161](review-file:packages/dtls/src/server.ts:161)
[packages/dtls/src/server.ts:236](review-file:packages/dtls/src/server.ts:236)
[packages/dtls/src/server.ts:269](review-diff:packages/dtls/src/server.ts:269)
[packages/dtls/src/server.ts:311](review-file:packages/dtls/src/server.ts:311)

### 2.2 Dual 交渉（HVR は最終選択ではない）

Client の dual 状態機械:

`none → probing → committed12 | committed13 | closed`

HVR は 1.2 cookie path を開くシグナルだけ。version 確定は ServerHello / HRR。

[packages/dtls/src/client.ts:49](review-file:packages/dtls/src/client.ts:49)
[packages/dtls/src/client.ts:70](review-diff:packages/dtls/src/client.ts:70)

HVR 後の要点:

1. **CH-A を捨てない。** `dualResume` は legacy cookie なしの original ClientHello + ECDHE。
2. **CH-A の RTO を止めない。** `tryParkDualProbe()` は pendingFlight / retransmit を残す。
3. **cookie 付き CH は一時経路。** 1.3 resume には使わない。
4. **RX は association が所有。** probing 中の `carrier.inject` は parked engine 直結ではなく `udpOnMessage` demux。
5. **probing 中の alert 抑制は illegal_parameter (47) のみ。** 正当な `handshake_failure` は即 fail。

[packages/dtls/src/engine/v1_3/connection-base.ts:947](review-file:packages/dtls/src/engine/v1_3/connection-base.ts:947)
[packages/dtls/src/engine/v1_3/connection-base.ts:962](review-diff:packages/dtls/src/engine/v1_3/connection-base.ts:962)
[packages/dtls/src/client.ts:186](review-file:packages/dtls/src/client.ts:186)
[packages/dtls/src/client.ts:703](review-file:packages/dtls/src/client.ts:703)
[packages/dtls/src/client.ts:724](review-diff:packages/dtls/src/client.ts:724)
[packages/dtls/src/client.ts:1359](review-file:packages/dtls/src/client.ts:1359)
[packages/dtls/src/client.ts:1436](review-file:packages/dtls/src/client.ts:1436)

1.2 確定時は parked 1.3 を soft dispose し、carrier は close しない。association hard-close で初めて carrier を閉じる。

[packages/dtls/src/client.ts:258](review-file:packages/dtls/src/client.ts:258)
[packages/dtls/src/client.ts:304](review-file:packages/dtls/src/client.ts:304)
[packages/dtls/src/client.ts:312](review-diff:packages/dtls/src/client.ts:312)

レビューで壊れていた経路（spoofed HVR と本物の 1.3 SH/HRR の race、CH-A 再送消失、version commit の偽 `onError`、injected carrier の close 再利用）は、上記の park + association-owned RX で閉じている。回帰は `self13_dual_hvr_resume.test.ts`。

[packages/dtls/tests/e2e/self13_dual_hvr_resume.test.ts:57](review-file:packages/dtls/tests/e2e/self13_dual_hvr_resume.test.ts:57)

### 2.3 DTLS 1.3 engine

1.2 の flight / PRF / explicit-nonce AEAD は触らず、1.3 は別エンジン。

- wire `0xfefc`、ClientHello.legacy_version `0xfefd`
- `TLS_AES_128_GCM_SHA256`、X25519 必須 + P-256
- HKDF / `dtls13` Expand-Label / transcript / Finished
- unified ciphertext header、epoch 0/2/3、epoch 1 は予約未使用
- ACK = 26、HRR + cookie、KeyUpdate
- CID (C=1) 拒否
- 3× anti-amplification、fragment / ACK / epoch の上限

[packages/dtls/src/engine/v1_3/types.ts:12](review-file:packages/dtls/src/engine/v1_3/types.ts:12)
[packages/dtls/src/engine/v1_3/handshake-flights.ts:539](review-file:packages/dtls/src/engine/v1_3/handshake-flights.ts:539)
[packages/dtls/src/engine/v1_3/handshake-flights.ts:556](review-diff:packages/dtls/src/engine/v1_3/handshake-flights.ts:556)

RTO は RFC 9147 §5.8.2 に寄せた。

| 条件 | 値 |
| --- | --- |
| RTT unknown | 1000ms（`use_srtp` 設定時 400ms） |
| RTT known | 1.5 × RTT |
| backoff | 再送ごとに ×2、上限 60s |

`DirectHandshakeCarrier` は未測定 RTT を 0 として扱い、偽の 100ms sample は使わない。

[packages/dtls/src/engine/v1_3/types.ts:15](review-file:packages/dtls/src/engine/v1_3/types.ts:15)
[packages/dtls/src/engine/v1_3/flight-tx.ts:322](review-file:packages/dtls/src/engine/v1_3/flight-tx.ts:322)
[packages/dtls/src/engine/v1_3/flight-tx.ts:328](review-diff:packages/dtls/src/engine/v1_3/flight-tx.ts:328)

ACK の higher-epoch RecordNumber は **無視**する。Erratum 8108 は Reported のみなので `illegal_parameter` では止めない。コメントも「8108 準拠」ではない。

[packages/dtls/src/engine/v1_3/record-rx.ts:580](review-file:packages/dtls/src/engine/v1_3/record-rx.ts:580)
[packages/dtls/src/engine/v1_3/record-rx.ts:606](review-diff:packages/dtls/src/engine/v1_3/record-rx.ts:606)

### 2.4 Carrier 抽象（Epic 2 の差し込み口）

能力はチケットどおり。`handshakeCarrier` は安定 `Options` には出さず、`createDtlsClientInternal` 経由。

[packages/dtls/src/carrier/types.ts:26](review-file:packages/dtls/src/carrier/types.ts:26)
[packages/dtls/src/carrier/types.ts:36](review-diff:packages/dtls/src/carrier/types.ts:36)
[packages/dtls/src/socket.ts:1056](review-file:packages/dtls/src/socket.ts:1056)

soft version transition では `carrier.close()` しない。probing 中の `close()` は `engine13` と `parkedEngine13` を一括 hard-close する。

### 2.5 DTLS 1.2 cookie / commit / sequence（回帰強化）

generic DTLS の cookie / anti-amplification は 1.2 側も 1.3 と同じ思想に揃えた。

**CH1:** HVR のみ。HMAC cookie = peer + ClientHello 不変フィールド。cipher / SRTP / random / ECDHE は書かない。

[packages/dtls/src/flight/server/flight2.ts:18](review-file:packages/dtls/src/flight/server/flight2.ts:18)
[packages/dtls/src/handshake/extensions/cookie.ts:162](review-file:packages/dtls/src/handshake/extensions/cookie.ts:162)
[packages/dtls/src/handshake/extensions/cookie.ts:180](review-diff:packages/dtls/src/handshake/extensions/cookie.ts:180)

**CH2:** cookie 検証成功後にだけ transactional commit → pin → Flight4。再送 CH2 は cached Flight4 のみ（serverRandom / ECDHE を再生成しない）。

[packages/dtls/src/flight/server/commitClientHello.ts:35](review-file:packages/dtls/src/flight/server/commitClientHello.ts:35)
[packages/dtls/src/flight/server/commitClientHello.ts:155](review-file:packages/dtls/src/flight/server/commitClientHello.ts:155)
[packages/dtls/src/flight/server/commitClientHello.ts:181](review-diff:packages/dtls/src/flight/server/commitClientHello.ts:181)
[packages/dtls/src/server.ts:328](review-file:packages/dtls/src/server.ts:328)
[packages/dtls/src/server.ts:382](review-file:packages/dtls/src/server.ts:382)
[packages/dtls/src/context/dtls.ts:37](review-file:packages/dtls/src/context/dtls.ts:37)

**sequence の分離（Errata 5186）:**

- handshake `message_seq` は受信 ClientHello に合わせる
- epoch 0 の **record sequence はリセットしない**（HVR2 が HVR1 の replay に見えないようにする）

[packages/dtls/src/flight/server/flight2.ts:33](review-file:packages/dtls/src/flight/server/flight2.ts:33)
[packages/dtls/src/flight/server/flight4.ts:46](review-file:packages/dtls/src/flight/server/flight4.ts:46)
[packages/dtls/src/flight/server/flight4.ts:82](review-diff:packages/dtls/src/flight/server/flight4.ts:82)

Client は 2 回目 HVR を処理できる。`hvrGeneration` で古い Flight3 retransmit を止める。

[packages/dtls/src/flight/client/flight3.ts:17](review-file:packages/dtls/src/flight/client/flight3.ts:17)
[packages/dtls/src/flight/client/flight3.ts:36](review-diff:packages/dtls/src/flight/client/flight3.ts:36)

### 2.6 Peer-auth（WebRTC ICE 回帰）

ICE は DTLS に source address を渡さない。UDP pin だけで peer-auth を表すと、接続後の protected `close_notify` / fatal が pre-auth 扱いされて無視される。

対応:

- `Transport.peerAuthenticated`
- WebRTC `IceTransport.peerAuthenticated = true`
- `hasAssociationPeerAuth()` = pin **または** authenticated-single-peer
- version-error 経路も同じ abstraction（1.3-only client × 1.2-only server が ICE でも双方 terminal）

[packages/common/src/transport.ts:333](review-file:packages/common/src/transport.ts:333)
[packages/common/src/transport.ts:346](review-diff:packages/common/src/transport.ts:346)
[packages/dtls/src/socket.ts:240](review-file:packages/dtls/src/socket.ts:240)
[packages/dtls/src/engine/v1_3/connection-base.ts:772](review-file:packages/dtls/src/engine/v1_3/connection-base.ts:772)
[packages/webrtc/src/transport/dtls.ts:693](review-file:packages/webrtc/src/transport/dtls.ts:693)
[packages/webrtc/src/transport/dtls.ts:699](review-diff:packages/webrtc/src/transport/dtls.ts:699)

### 2.7 UdpTransport hot path

通常の IP 宛 `send()` は fire-and-forget のまま。`close_notify` だけ `sendAndWait` / `flushTransportSend`。ICE / WebRTC の送信経路は変えていない。

[packages/common/src/transport.ts:95](review-file:packages/common/src/transport.ts:95)
[packages/common/src/transport.ts:105](review-diff:packages/common/src/transport.ts:105)
[packages/common/src/transport.ts:354](review-file:packages/common/src/transport.ts:354)

### 2.8 Interop harness（Docker で実測済み）

canonical は `packages/dtls/tools/boringssl-dtls13/` のみ。旧 pin `0bcc1e84…` は GitHub / googlesource に存在しなかったため、実在する

`a204be272595867e7069221050f19697a0cf66ad`

へ更新した。

[packages/dtls/tools/boringssl-dtls13/BORINGSSL_REVISION:1](review-file:packages/dtls/tools/boringssl-dtls13/BORINGSSL_REVISION:1)
[packages/dtls/tools/boringssl-dtls13/BORINGSSL_REVISION](review-diff:packages/dtls/tools/boringssl-dtls13/BORINGSSL_REVISION:commit:ef063d91)
[packages/dtls/tests/e2e/boringssl/README.md:14](review-file:packages/dtls/tests/e2e/boringssl/README.md:14)

ビルドスクリプトの実測で直した点:

| 問題 | 対応 |
| --- | --- |
| `../../../` が `packages/third_party` を指していた | `packages/dtls/third_party/boringssl` |
| googlesource clone が HTTP 400/500 | 既定を GitHub。失敗時のみ googlesource |
| フル `ninja` が GCC 12 で `ssl_test` 失敗 | `-DBUILD_TESTING=OFF` + `ninja ssl crypto bssl` |

[packages/dtls/tools/boringssl-dtls13/fetch-and-build-boringssl.sh:17](review-file:packages/dtls/tools/boringssl-dtls13/fetch-and-build-boringssl.sh:17)
[packages/dtls/tools/boringssl-dtls13/fetch-and-build-boringssl.sh:19](review-diff:packages/dtls/tools/boringssl-dtls13/fetch-and-build-boringssl.sh:commit:ef063d91:19)
[packages/dtls/tools/boringssl-dtls13/fetch-and-build-boringssl.sh:60](review-file:packages/dtls/tools/boringssl-dtls13/fetch-and-build-boringssl.sh:60)
[packages/dtls/tools/boringssl-dtls13/install.sh:16](review-file:packages/dtls/tools/boringssl-dtls13/install.sh:16)

`dtls13_echo` は TLS 1.3 スイートを `SSL_CTX_set_strict_cipher_list` に渡さない（BoringSSL では TLS 1.2 専用 API で `NO_CIPHER_MATCH`）。交渉結果を `check_negotiated()` で検証する。stderr は unbuffered。

[packages/dtls/tools/boringssl-dtls13/native/dtls13_echo.c:137](review-file:packages/dtls/tools/boringssl-dtls13/native/dtls13_echo.c:137)
[packages/dtls/tools/boringssl-dtls13/native/dtls13_echo.c:174](review-diff:packages/dtls/tools/boringssl-dtls13/native/dtls13_echo.c:commit:ef063d91:174)
[packages/dtls/tools/boringssl-dtls13/native/dtls13_echo.c:300](review-file:packages/dtls/tools/boringssl-dtls13/native/dtls13_echo.c:300)

werift client × BoringSSL server は、UDP echo が先に届いて child stderr が遅れるレースがあった。テストは cipher / group 行を待つ。

[packages/dtls/tests/e2e/boringssl/interop.test.ts:184](review-file:packages/dtls/tests/e2e/boringssl/interop.test.ts:184)
[packages/dtls/tests/e2e/boringssl/interop.test.ts:184](review-diff:packages/dtls/tests/e2e/boringssl/interop.test.ts:commit:ef063d91:184)

OpenSSL dual fallback は両 role:

- werift `[1.3, 1.2]` client → `s_server -dtls1_2`
- `s_client -dtls1_2` → werift `[1.3, 1.2]` server

[packages/dtls/tests/e2e/client_dual_openssl.test.ts:10](review-file:packages/dtls/tests/e2e/client_dual_openssl.test.ts:10)
[packages/dtls/tests/e2e/client_dual_openssl.test.ts:138](review-diff:packages/dtls/tests/e2e/client_dual_openssl.test.ts:138)

---

## 3. 判断理由

1. **1.2 と 1.3 の mutable state を共有しない。** 既存 WebRTC 経路を壊さず、1.3 の record / key schedule を独立に検証できる。
2. **HVR を version commit に使わない。** RFC 9147 は 1.3 で HVR を使わず HRR を使う。dual client は 1.2 server と相互運用する必要がある一方、spoofed/stale HVR で 1.3 candidate を捨ててはいけない。
3. **`[1.2, 1.3]` を公開 dual にしない。** 1.3-capable server が 1.2 を選ぶと DOWNGRD が必須で、dual client は abort する。DOWNGRD を弱めるより dual を 1.3 優先だけにする方が RFC と API が一致する。
4. **peer-auth と 5-tuple pin を分ける。** pin は UDP TX/RX ルーティング。ICE は address を渡さないので、lifecycle（alert / version error / close_notify）は別の認証境界が要る。
5. **CH1 では association に commit しない。** cookie 前の共有 state は別 source からの CH で poison できる。validate → apply の transactional commit が必要。
6. **handshake seq と record seq を混ぜない。** Errata 5186 は RFC 6347 の「record sequence」が実際には `message_seq` だと訂正している。record seq を HVR ごとに 0 へ戻すと、replay window 付き peer が HVR2 を捨てる。
7. **verified errata だけを MUST 扱いする。** 8108 は Reported。higher-epoch ACK を無視する現行は仕様として明示し、誤って準拠宣言しない。
8. **UDP hot path を DTLS close のために変えない。** チケットは common 変更時に workspace 回帰を要求するが、realtime 全経路の semantics 変更は Epic 1 の対価として大きすぎる。
9. **TLS 1.3 cipher を BoringSSL の TLS 1.2 cipher list API に載せない。** `ssl.h` も「TLS 1.3 ciphers do not participate in this mechanism」と明記している。交渉後検証の方が pin 更新に耐える。
10. **存在しない pin を残さない。** 再現ビルドの前提が壊れる。GitHub 上で取れる実コミットに差し替えた。

---

## 4. リスク

- **BoringSSL P0 は Docker で両 role を通した。** 以前の「ローカル未ビルドだと skip だけで証明できない」状態は、このセッションのコンテナ実行で解消している。CI job `dtls13-boringssl` は引き続き必須。
- **googlesource は不安定。** clone 既定を GitHub にした。pin fetch が両方失敗すると checkout できない。
- **OpenSSL DTLS 1.3 interop は対象外。** チケットどおり。1.3 外部参照は BoringSSL のみ。
- **dual probing 中の cookie CH は 1.3-only server に `illegal_parameter` を誘発し得る。** probing では epoch-0 の 47 だけ落とす。抑制ウィンドウは `committed12/13` で閉じるが、並行 probe の設計自体が複雑で、後続変更で再発しやすい。
- **DTLS 1.2 受信 path に record anti-replay はまだ無い。** 1.3 は epoch ごと必須。1.2 は「回帰を避け任意」。
- **`external` retransmission は骨格のみ。** SPED 駆動は Epic 2。carrier の inject / soft-detach / association demux を壊すと Epic 2 が先に折れる。
- **early server app data は self 送受信まで。** WebRTC fingerprint ゲート付き配送は Epic 3。
- **working tree はクリーン。** 未コミット Diff は空。BoringSSL 修正は [fetch-and-build-boringssl.sh](review-diff:packages/dtls/tools/boringssl-dtls13/fetch-and-build-boringssl.sh:commit:ef063d91) など `ef063d91` の Diff を使う。

---

## 5. 検証結果

### パッケージ / workspace（実装報告時）

```text
cd packages/dtls && npm test
→ 371 passed | 4 skipped

npm run type && npm run test:small
→ 成功（common / ice / webrtc 含む）
```

### Docker 内 BoringSSL interop（今回追加で実測）

イメージ `werift-dtls-boringssl-e2e:latest`（Node 18 + cmake/ninja）。ワークスペースをマウントし pin ビルド後:

```text
cd packages/dtls && npm run test:boringssl
→ Test Files  1 passed (1)
   Tests      5 passed (5)
```

- werift client × BoringSSL server: HS + 双方向 data + `TLS_AES_128_GCM_SHA256` / X25519
- BoringSSL client × werift server: 同上

DTLS 1.3 本体の handshake / record 実装は、この実行では変更不要だった。失敗していたのは pin・clone パス・CMake 対象・harness の cipher API・stderr レース。

レビューで追加・強化したテストの入口:

| 観点 | ファイル |
| --- | --- |
| version 選択 / `[1.2,1.3]` normalize | [packages/dtls/tests/version/selectVersion.test.ts:14](review-file:packages/dtls/tests/version/selectVersion.test.ts:14) |
| HVR race / CH-A 再送 / delayed onError / carrier inject | [packages/dtls/tests/e2e/self13_dual_hvr_resume.test.ts:57](review-file:packages/dtls/tests/e2e/self13_dual_hvr_resume.test.ts:57) |
| 1.2 cookie bind / 別 peer 拒否 | [packages/dtls/tests/e2e/self12_cookie_binding.test.ts:244](review-file:packages/dtls/tests/e2e/self12_cookie_binding.test.ts:244) |
| CH2 再送で Flight4 を再生成しない | [packages/dtls/tests/e2e/self12_ch2_retransmit_flight4.test.ts:44](review-file:packages/dtls/tests/e2e/self12_ch2_retransmit_flight4.test.ts:44) |
| transactional commit | [packages/dtls/tests/e2e/self12_commit_transactional.test.ts:118](review-file:packages/dtls/tests/e2e/self12_commit_transactional.test.ts:118) |
| ICE-like peer-auth / version error | [packages/dtls/tests/e2e/self12_peer_authenticated_transport.test.ts:127](review-file:packages/dtls/tests/e2e/self12_peer_authenticated_transport.test.ts:127) |
| HVR generation cancel | [packages/dtls/tests/e2e/self12_hvr_generation_cancel.test.ts:13](review-file:packages/dtls/tests/e2e/self12_hvr_generation_cancel.test.ts:13) |
| OpenSSL dual 両 role | [packages/dtls/tests/e2e/client_dual_openssl.test.ts:10](review-file:packages/dtls/tests/e2e/client_dual_openssl.test.ts:10) |
| RTO | [packages/dtls/tests/handshake/tls13/rto_from_rtt.test.ts:8](review-file:packages/dtls/tests/handshake/tls13/rto_from_rtt.test.ts:8) |
| BoringSSL 両 role + stderr wait | [packages/dtls/tests/e2e/boringssl/interop.test.ts:116](review-file:packages/dtls/tests/e2e/boringssl/interop.test.ts:116) |

使い方と pin は docs 済み。

[packages/dtls/README.md:106](review-file:packages/dtls/README.md:106)
[packages/dtls/README.md:106](review-diff:packages/dtls/README.md:106)
[packages/dtls/tests/e2e/boringssl/README.md:1](review-file:packages/dtls/tests/e2e/boringssl/README.md:1)
[packages/dtls/tests/e2e/boringssl/README.md:45](review-diff:packages/dtls/tests/e2e/boringssl/README.md:commit:ef063d91:45)
