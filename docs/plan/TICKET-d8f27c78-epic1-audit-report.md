# Epic 1 自律監査 最終報告

- Ticket: `d8f27c78-9492-4da8-a225-6e21e974b1b9`
- Parent Epic: `5fc64332-b0d1-4ab0-bc1e-4b0f3a26c135`
- Branch: `ticket/d8f27c78-9492-4da8-a225-6e21e974b1b9`
- Scope: `packages/dtls` association / DTLS 1.2 / 1.3 / dual / WebRTC ICE default 1.2

## 修正結果

### 発見した問題

| ID | 重要度 | 概要 | 対応 |
| --- | --- | --- | --- |
| A | P1 | `commitClientHelloToAssociation` の partial poison | validate → apply 分離 |
| B | P1 | address pin と peer-auth の混同 | `PeerIdentityMode` + `allowsAssociationPeer` |
| C | P1 | stale HVR / Flight3 generation | `hvrGeneration` + Flight3 1 本 assert |
| D | P1 | Flight4 再送で ECDHE 再生成 | Flight5 handler cache 冪等化 |
| E | P1 | Flight5 再送で masterSecret 再 init | Flight6 handler cache 冪等化 |
| F | P1 | 重複 ServerHello で Flight5 差し替え | 既存 instance 再利用 |
| G | P2 | renegotiation が旧 retransmit timer を破棄しない | `abortLegacy12Flight` + AbortController |
| H | P1 | 接続後 epoch-0 再注入では Flight5 を検証できない | pre-connect Flight4 再注入テスト |
| I | P1 | `Flight.transmit` の stale async send | `flightTxGeneration` |
| J | P1 | 1.3 エンジンに `peerIdentityMode` 未伝播 | 全 engine 生成経路へ伝播 |
| K | P1 | dual → 1.2 後 `isAssociationPeer` が 5-tuple 一致必須 | `authenticated-single-peer` は常に許可 |
| L | P2 | 1.3 RTO が `flightId` 世代を見ない | RTO コールバック / late send を `flightId` で無効化 |

### 根本原因

1. **transactionality / mutate-before-validate** — CH commit と Flight handler 副作用
2. **duplicate retransmission semantics** — 再送は cache 再送であり鍵再生成ではない
3. **peer authentication vs address pin** — ICE は 5-tuple を渡さない。1.3 候補消失後の dual dispatcher も同じ policy が必要
4. **timer / async send ownership** — 1.2 は `flightTxGeneration`、1.3 は `flightId` + `closed`、dual fallback は `releaseForVersionFallback`

### 実装変更

- `packages/dtls/src/flight/client/flight5.ts` / `server/flight6.ts` — handler 冪等化
- `packages/dtls/src/client.ts` / `server.ts` — Flight 非置換、`peerIdentityMode` 伝播、`isAssociationPeer` 共通化
- `packages/dtls/src/socket.ts` — `matchesPinnedPeer` / `hasAssociationPeerAuth`
- `packages/dtls/src/engine/v1_3/{types,connection-base,record-rx,flight-tx}.ts` — peer gate + RTO generation
- `packages/webrtc/src/transport/dtls.ts` — `authenticated-single-peer` + `ice-authenticated`
- Public API: `PeerIdentityMode` / `Options.peerIdentityMode`（破壊的変更なし）

### 追加した回帰テスト

| テスト | 再現 | 修正前 FAIL 理由 | 修正後保証 |
| --- | --- | --- | --- |
| `self12_commit_transactional` | 失敗 CH2 | EMS/cipher が毒される | rollback + 再握手 |
| `self12_peer_authenticated_transport` | addressless ICE | pin 混同で RX/API 破綻 | HS / app / fatal / close / mismatch / dual→1.2 |
| `self13_peer_identity_mode` | addressless / 別 addr | 1.3 demux が drop | app / fatal / close_notify / datagram 拒否 |
| dual→1.2 alternate-addr | commit12 後に 5-tuple 改変 | `isAssociationPeer` が pin 必須 | dispatcher + app data |
| `self12_hvr_stale_retransmit` | HVR1→HVR2→stale RTO | cookie1 再送 | Flight3 WAITING が 1 本 |
| `self12_flight4_preconnect_no_rehandle` | 接続前 Flight4 再注入 | ECDHE 再生成 | identity 不変 |
| `self12_flight6_dup_cke` | CKE/Finished 二重 | masterSecret 再派生 | cache 冪等 |
| `self12_flight_tx_generation` | close 後 send reject | stale error | generation で無視 |
| `rto_from_rtt` stale flightId | 旧 RTO 発火 | 新 flight を再送し得る | 再送ゼロ |

### 実行結果

| command | result |
| --- | --- |
| `cd packages/dtls && npm run type` | PASS |
| `cd packages/dtls && npm test` | PASS（368 passed / 1 skipped） |
| `WERIFT_REQUIRE_BORINGSSL=1` boringssl interop（`npm test` 内） | PASS（5 / 両 role） |
| OpenSSL DTLS 1.2（`client` / `server` / `client_dual_openssl`） | PASS（dtls suite 内） |
| `git diff --check` | PASS |
| workspace `npm run test:small` | 今回未再実行（dtls のみ変更） |

OpenSSL / BoringSSL の CI 位置:

- BoringSSL 両 role: `.github/workflows/nodejs.yml` job `dtls13-boringssl`（必須、`WERIFT_REQUIRE_BORINGSSL=1`）
- OpenSSL 1.2: `packages/dtls` の `client.test.ts` / `server.test.ts` / `client_dual_openssl.test.ts`（`npm test` / `npm run ci` に含まれる。binary 不在時は skip になり得る）

### 残存リスク

- DTLS 1.2 ServerKeyExchange 署名検証は未実装（Epic 1 外の認証ギャップ）
- Association 独立クラス化は未実施（Epic 2 候補）
- `authenticated-single-peer` を素の UDP に誤設定すると 5-tuple demux が緩い（公開型とドキュメントで意図は明示）
- 一部 e2e は短い wall-clock wait を併用（generation / intercept 主体）

### Epic 1 完了条件

| Gate | Result | Evidence |
| --- | --- | --- |
| werift self DTLS 1.3 両 role | PASS | `self13.test.ts` |
| protected app data bidirectional | PASS | self13 / peerAuth / self12 |
| BoringSSL interop 両 role | PASS | `tests/e2e/boringssl/interop.test.ts`（5） |
| OpenSSL DTLS 1.2 regression | PASS | client / server / client_dual_openssl |
| dual → 1.2 fallback | PASS | `self13_dual_hvr_resume` / peerAuth dual |
| dual → 1.3 | PASS | `self13_dual_hvr_resume` |
| version mismatch actionable | PASS | dual + peerAuth mismatch |
| KeyUpdate / exporter | PASS | self13 KeyUpdate tests |
| WebRTC default DTLS 1.2 | PASS | ice.test + RTCDtlsTransport mode |
| cookie/address validation | PASS | cookie_binding / anti_amp |
| lifecycle terminal / timer cleanup | PASS | lifecycle + timer + RTO generation |
| duplicate/loss/reorder | PASS | loss + Flight4/6 dup + HVR gen |
| Public API compatibility | PASS | 破壊的 API 変更なし |
