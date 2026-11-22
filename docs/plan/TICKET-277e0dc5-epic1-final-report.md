# Epic 1 自律レビュー最終報告

- Ticket: `277e0dc5-a06d-409b-9ec1-63d67af71837`
- Parent Epic: `5fc64332-b0d1-4ab0-bc1e-4b0f3a26c135` (Issue #659 Epic 1)
- Scope: `packages/dtls` dual association / carrier / DTLS 1.3+1.2 lifecycle
- Status: **approved** (implementation + review gate)

---

## 1. 発見した問題（重要度順）

| ID | 重要度 | 種別 | 概要 | 対応 |
| --- | --- | --- | --- | --- |
| A1 | P1 | 自律/レビュー | dual association に `closed` がなく close 後 state が弱い | `DualPhase.closed` + hard-close 一括 teardown |
| A2 | P1 | 自律/レビュー | UDP / `carrier.inject` demux 分岐・commit 後 no-op | `bindAssociationInbound` で常に association 所有 |
| A3 | P1 | レビュー | committed13 fatal が association を残す | `failAssociationFromEngine13` → `closeAssociationHard` |
| A4 | P1 | レビュー | 1.2 fatal 後も send 可能（committed12） | `failLegacy12Association` / `reportLegacy12Fatal` |
| A5 | P2 | レビュー | 1.2 flight timer が close/error/complete で残る | cancelable `flightSleep` + abort/cancel 分離 |
| A6 | P2 | レビュー | close_notify と warning を同一 `onClose` 扱い | fatal / close_notify / other warning 分岐 |
| A7 | P2 | レビュー | probing DOWNGRD / classify `error` が onError のみ | `reportLegacy12Fatal` で association 閉じる |
| A8 | P2 | レビュー | `resumeDtls13FromDualPath` material 欠落が onError のみ | 欠落時は `reportLegacy12Fatal`（committed13 に残さない） |
| A9 | P3 | 改善 | e2e の `(client as any).dualPhase` | `dualAssociationPhase` getter へ段階移行 |
| A10 | P1 | 自律 | `onHandleHandshakes` 失敗が onError のみ | `reportLegacy12Fatal` で association tear down |
| A11 | P1 | 自律 | server `ProtocolVersionError` が onError のみ | `reportLegacy12Fatal` |
| A12 | P1 | 自律 | terminal 後も pure 1.2 RX が onData し得る | `handleUdpDatagram` で `associationTornDown` drop |
| A13 | P2 | 自律 | dual cookie path fail が onError のみで parked 1.3 を巻き込み得る | probing+parked 時は 1.2 flight のみ abort |
| A14 | P2 | 自律 | `reportLegacy12Fatal` 二重呼び出しで onError 二重 | 既 terminal なら event 再発火しない |
| A15 | P2 | 自律 | `waitForReady` が close 後もポーリング継続 | `associationTornDown` で即 reject |

---

## 2. テスト結果（コマンドと結果）

| コマンド | 結果 |
| --- | --- |
| `cd packages/dtls && npm run type` | 成功 |
| `cd packages/dtls && npm test` | **298 passed** / 1 skipped |
| dual e2e (`self13_dual_hvr_resume` 等) | 全成功（必須 1–5 + lifecycle） |
| OpenSSL DTLS 1.2 (`client` / `server` / `client_dual_openssl`) | 成功 |
| BoringSSL DTLS 1.3 (`npm run test:boringssl`) | **5 passed**（client + server roles） |
| werift self 1.2 (`self.test`) | 成功 |
| werift self 1.3 (`self13.test`) | 成功 |
| dual fallback (`[1.3,1.2]` → 1.2-only) | 成功 |
| `npm run type:packages` | 成功 |
| root `npm run ci` | 未確認（WPT 含むフルゲートはマージ前推奨） |

---

## 3. 最終判定表（R1–R8 + Epic 1）

| 条件 | 判定 |
| --- | --- |
| R1 全 candidate 一括 teardown | **PASS** |
| R2 UDP / inject 同一 demux | **PASS** |
| R3 phase invariant (`closed` 含む) | **PASS** |
| R4 必須テスト 1–5 | **PASS** |
| R5 actionable alert（timeout 化しない） | **PASS** |
| R6 version API / DOWNGRD | **PASS** |
| R7 自律発見 P0/P1 解消 | **PASS** |
| R8 lifecycle 一貫（局所 if 寄せ集めではない） | **PASS** |
| werift 同士 DTLS 1.3 full + app data | **PASS** |
| BoringSSL 両 role interop | **PASS** |
| OpenSSL 1.2 回帰 | **PASS** |
| dual fallback / version error | **PASS** |
| KeyUpdate / exporter | **PASS** |
| デフォルト 1.2 挙動 | **PASS** |

---

## 4. 主要実装アンカー

- Association hard-close: `DtlsClient.closeAssociationHard`
- Dual demux: `bindAssociationInbound` / `associationInject` / `udpOnMessage`
- 1.2 fatal lifecycle: `reportLegacy12Fatal` → `failLegacy12Association`
- 1.2 graceful close: `onLegacy12PeerCloseNotify`
- Version commit: SH/HRR only (`commitDualTo12` / `resumeDtls13FromDualPath`)
- Phase observation (tests): `client.dualAssociationPhase` (`@internal`)

---

## 5. 残リスク（承認ブロッカーなし）

- e2e の `engine13` / `parkedEngine13` 観測は一部 `as any` 残存（P3）
- server dual 経路は client ほど厚い state machine ではない（Epic 範囲内）
- Association 独立クラス化は任意（Epic 2 候補）
