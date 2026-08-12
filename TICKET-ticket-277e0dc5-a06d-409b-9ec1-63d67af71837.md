# werift DTLS 1.3 Epic 1 自律レビュー・修正指示

- 本チケット種別: **自律レビュー + 根本修正**（Epic 1 完了ゲート）
- 親チケット: `5fc64332-b0d1-4ab0-bc1e-4b0f3a26c135` — *Epic 1: Direct DTLS 1.3 endpoint を実行する*
- 対象リポジトリ: `shinyoshiaki/werift-webrtc`
- 対象ブランチ: `ticket/5fc64332-b0d1-4ab0-bc1e-4b0f3a26c135`
- 基準ブランチ: `develop`
- 主対象: `packages/dtls`（ICE / WebRTC 統合はスコープ外。ただし既定 1.2 回帰を壊さないこと）
- 親チケットファイル: `TICKET-ticket-5fc64332-b0d1-4ab0-bc1e-4b0f3a26c135.md`
- 親 Issue: [shinyoshiaki/werift-webrtc#659](https://github.com/shinyoshiaki/werift-webrtc#659) Epic 1 節

---

## 1. タスクの目的と背景

### 1.1 目的

対象ブランチ上の **DTLS 1.3 / 1.2 fallback / dual association / handshake carrier** 実装を、親 Epic 1 の完了条件を基準に網羅的にレビューし、問題があれば **再現テスト → 根本修正 → 回帰・interop 確認** まで完了させる。

最終ゴールは「指摘ケースだけ通る局所 if」ではなく、次を一貫した **association 状態機械** として成立させることである。

| 軸 | 一貫させたい内容 |
| --- | --- |
| lifecycle | initial → probing → committed12/13 → closed |
| version negotiation | HVR は候補分岐のみ。version commit は ServerHello / HRR |
| carrier ownership | UDP `onData` と `carrier.inject` が同一 association dispatcher を通る |
| candidate ownership | 1.2 / 1.3 candidate の timer・flight・callback を association が一括管理 |
| public API | `isDtls13` / `send` / `close` / exporter / `keyUpdate` / `remoteCertificate` が active association と一致 |

### 1.2 背景

- 親 Epic 1 は WARP の土台として **direct datagram 上の完全 DTLS 1.3 エンドポイント**を `packages/dtls` に実装する。
- 対象ブランチは既に大規模実装済み（`develop...対象branch` で約 +22k / −0.3k、主要追加は `engine/v1_3/*`・`carrier/*`・`version.ts`・大量 e2e）。
- dual client は HVR 後に **1.3 CH-A を park** し、**1.2 cookie path と並行 probing** する設計になっている。

```text
                  +----------------------+
                  | original DTLS1.3 CH-A|
                  +----------+-----------+
                             |
                            HVR
                             |
                   dual association probing
                     /                 \
                    /                   \
          parked DTLS 1.3          DTLS 1.2 cookie
             candidate               candidate
                    \                   /
                     \                 /
                      ServerHello等で
                       version commit
                             |
                    committed13 / 12
```

- 既知 P1 修正の履歴が多数ある（peer pin、pre-cookie DoS、HVR 後 1.3 復帰、alert 誤抑制、probing 中 close 等）。**既知パッチの確認だけでは不十分**で、同根の未発見不整合を自律探索する。
- 本チケットの作業ブランチは `ticket/277e0dc5-...`。レビュー対象コード本体は `ticket/5fc64332-...`（本ブランチの親に相当。先端は CI 追随コミット `eaca3de4` 含む場合あり）。

### 1.3 スコープ

| 含む | 含まない |
| --- | --- |
| dual association lifecycle / version commit / close / race | SPED 本体（Epic 2） |
| carrier.inject 経路の demux 一貫性 | `RTCPeerConnection` 統合（Epic 3） |
| 必須テスト追加・既存回帰 | SNAP / 0-RTT / CID / PQ KEX |
| BoringSSL 1.3 / OpenSSL 1.2 interop 実行 | Epic 4 全故障注入マトリクス |
| public API と internal association の整合 | Windows 専用対応 |

### 1.4 既知の危険パターン（探索ガイド）

次は例であり、これ以外も探索する。

1. `engine13` と `parkedEngine13` の分裂で public API が active candidate を見失う
2. UDP 直パスは通るが `DtlsHandshakeCarrier.inject()` が association を迂回する
3. close / error / version commit / fallback で candidate 片方だけ cleanup され timer・flight・handler が残る
4. dual 中に 1.2/1.3 が同時生存しているのに boolean / 単一参照だけで状態管理している
5. version commit 後も losing candidate の callback / timer / inject handler が残る
6. stale / spoofed unauthenticated packet が別 candidate を壊す
7. loss / reorder / duplicate / late packet による「通常順序では起きない」遷移
8. `send` / `close` / `isDtls13` / exporter / `remoteCertificate` / `keyUpdate` が内部状態と不一致
9. hard close と soft version transition の cleanup 責務混在
10. custom carrier ownership が engine / parked / association に分散
11. actionable fatal alert を timeout に変換する、または正常 version transition を `onError` に漏らす

---

## 2. 実装すべき具体的な機能や変更内容

### 2.1 作業の性質

本チケットは **新規プロトコル実装チケットではない**。親 Epic 1 実装の **自律監査・欠陥修正・テスト強化・完了証明** である。

進め方は次の固定順。

1. 親チケット完了条件を表に落とす  
2. `develop...ticket/5fc64332-...` 差分全体を読む  
3. association 状態遷移図を現状コードから起こす  
4. 各 state の ownership 表を作る  
5. invariant を列挙し、packet fault / carrier path を注入  
6. **再現テストを先に追加**  
7. association-level 操作へ集約して根本修正  
8. package test → BoringSSL/OpenSSL → root `npm run ci`

### 2.2 コードベース現状サマリ（調査結果）

#### 主要エントリ

| 領域 | パス | 役割 |
| --- | --- | --- |
| Public socket | `packages/dtls/src/socket.ts` | `DtlsSocket`、`isDtls13`、`send`/`close`/`exporter` の 1.2/1.3 分岐、`bridgeEngine13` |
| Dual client association | `packages/dtls/src/client.ts` | `dualPhase`、`parkedEngine13`、`associationInject`、commit12/13、UDP demux |
| Server association | `packages/dtls/src/server.ts` | ClientHello 上の `selectVersion`、1.3 reinject |
| 1.3 engine | `packages/dtls/src/engine/v1_3/*` | park / unpark / releaseForVersionFallback / flights / record RX |
| Carrier | `packages/dtls/src/carrier/{types,direct}.ts` | `inject` / `setInjectHandler` / timer / close |
| Version API | `packages/dtls/src/version.ts` | `normalizeProtocolVersions`（`[V1_2,V1_3]` → `[V1_3,V1_2]`） |
| Dual e2e | `packages/dtls/tests/e2e/self13_dual_hvr_resume.test.ts` | HVR race、alert、close probing、carrier inject 1.3 |
| BoringSSL | `packages/dtls/tests/e2e/boringssl/*` | pin `0bcc1e8473a1264b4de88e05a651763dc9a71b09` |

#### 現行 dual phase（実装値）

```ts
// packages/dtls/src/client.ts
type DualPhase = "none" | "probing" | "committed12" | "committed13";
```

| phase | 意味（現状） |
| --- | --- |
| `none` | dual probing 前、または close 後に reset された状態 |
| `probing` | HVR 後。`parkedEngine13` あり、`engine13 === undefined`、1.2 cookie path 進行可 |
| `committed12` | 1.2 SH 確定。`releaseForVersionFallback()` で parked 1.3 停止 |
| `committed13` | 1.3 SH/HRR 確定。unpark または dualResume prime で `engine13` 復帰 |

**ギャップ:** 推奨設計の `"closed"` / `"initial"` が独立 phase として存在しない。`close()` は `dualPhase` を probing → `none` に戻し、明示 closed ではない。

#### 現行 ownership（観測）

| リソース | initial (1.3/dual start) | probing | committed13 | committed12 | close 後 |
| --- | --- | --- | --- | --- | --- |
| transport RX | 1.3 engine `onData` | association `udpOnMessage` | unpark で engine に戻る | association `handleUdpDatagram`（1.2） | engine hard close で transport close |
| carrier inject | engine handler | `bindInjectToAssociation` → `associationInject` | unpark で engine handler | `releaseForVersionFallback` が **no-op handler** | carrier.close() |
| 1.3 retransmit | engine pendingFlight | parked 維持 | active engine | 停止 | 停止必須 |
| 1.2 Flight1 timer | なし | dual cookie Flight1 | `dtls.flight=99` で停止意図 | 1.2 flight 継続 | `dtls.flight=99` + transport close |
| public `isDtls13` | true（engine13 あり） | **false**（engine13 無し） | true | false | false |
| public `send` | 1.3 | 1.2 path に落ちうる（未 connect） | 1.3 | 1.2 | 不可 |

#### 既に入っている修正（確認対象・再発防止）

| コミット趣旨 | 対応コード / テストの目安 |
| --- | --- |
| probing 中 `close()` で parked 1.3 が止まらない | `DtlsClient.closeAllDtls13Candidates` / `close()`、e2e `close() during probing...` |
| dual 中に 1.2 fatal alert を無条件 discard | `udpOnMessage` は **illegal_parameter のみ**抑制、`handshake_failure` e2e |
| HVR と本物 1.3 応答の競合で別 CH state に復帰 | park + dualResume=CH-A、`setupChAThenSpoofedHvr` |
| HVR 後 dual が 1.3 に戻れない | `resumeDtls13FromDualPath` / unpark |
| carrier.inject が association を迂回 | `associationInject` + e2e `carrier.inject of 1.3 SH...` |
| peer pin / pre-cookie DoS | server / engine peer pin、`anti_amp` / `pre_cookie_*` tests |

### 2.3 必須で行うレビュー項目（チェックリスト）

#### A. Association lifecycle 一括 teardown

**確認:** association が所有する **全 candidate** を必ず一括 hard-teardown できるか。

現状:

- `closeAllDtls13Candidates()` が `engine13` + `parkedEngine13` を Set で close
- `DtlsClient.close()` が dual Flight1 を `dtls.flight = 99` で止め、13 candidates を先に teardown

**追加で見る点:**

- [ ] close 後 phase が実質 closed として不変（再 inject / RTO / onConnect / onError が起きない）
- [ ] 1.2 candidate 側の retransmit timer（`flight/*`）も漏れなく停止
- [ ] epoch prune timer（1.3）停止
- [ ] custom carrier が `isClosed()===true` かつ schedule no-op
- [ ] Event 購読（`bridgeEngine13` の onConnect/onError/onClose）が dead candidate から public へ漏れない
- [ ] `DtlsSocket.close()`（親）と `DtlsClient.close()` の責務差で server/client 不整合がないか

局所 if で「parked も close」するだけでは不十分。`disposeCandidate` / `closeAssociation` 相当へ集約されているかを評価し、散在していればリファクタする。

#### B. Carrier RX ownership

**確認:** 次が常に同一 dispatcher か。

```text
transport.onData ----\
                      > association RX dispatcher
carrier.inject ------/
```

現状:

- probing 突入時に `transport.socket.onData = this.udpOnMessage` と `engine.bindInjectToAssociation(associationInject)` を設定
- `associationInject` → `udpOnMessage`（1.3 SH demux / alert filter / 1.2 path）
- **committed13 の unpark** は inject/onData を **engine 直結に戻す**（association を通らない）
- **committed12 の release** は inject を **空 handler** にする（carrier 経由 RX が死ぬ）

**要検証・要修正候補:**

- [ ] probing 中 `carrier.inject(genuine 1.3 SH/HRR)` → `committed13` + `isDtls13===true` + `send` 成功（既存 e2e あり。回帰維持）
- [ ] probing 中 `carrier.inject(genuine 1.2 SH)` → `committed12` + parked 1.3 停止 + 1.2 data 成功（**必須テスト不足**）
- [ ] commit12 後に carrier.inject が association 1.2 path に入るか（現状 no-op の可能性 → **P1 疑い**）
- [ ] commit13 後 late 1.2 packet が public error を起こさない
- [ ] close 直後 / 同時の inject が最終 closed を壊さない

#### C. Version commit と losing candidate

- [ ] commit は **ServerHello / HRR（1.3 selected）** または **正当な 1.2 SH（DOWNGRD 検査後）** のみ
- [ ] HVR 単独で version 確定しない（現状: probing へ）
- [ ] commit13: 1.2 Flight 停止、`isDtls13===true`、exporter/cert/keyUpdate が 1.3
- [ ] commit12: parked 1.3 完全停止、CH-A RTO なし、inject が dead engine を指さない
- [ ] late losing packet が phase / public を巻き戻さない
- [ ] version commit を `onError` に漏らさない（HVR soft の `DtlsVersionSelected` は filter）

#### D. Alert 処理

禁止パターン:

```ts
if (probing && fatalAlert) {
  return; // 全部捨てる — 禁止
}
```

許容は **必要最小限**（現状: epoch-0 fatal `illegal_parameter` のみ）。  
`handshake_failure` / `protocol_version` / `bad_certificate` 等は actionable のまま public `onError`。  
description ごとの場当たり例外を増やさず、candidate provenance / commit state で解決する。

#### E. Version API

サポート:

- `[V1_2]`（default）
- `[V1_3]`
- `[V1_3, V1_2]`

`[V1_2, V1_3]` は `normalizeProtocolVersions` で `[V1_3, V1_2]` へ正規化（現状維持）。  
DOWNGRD を弱めて 1.2-first dual を成立させない。

#### F. Public API 整合

| API | 期待 |
| --- | --- |
| `isDtls13` | **committed** 1.3 のときのみ true（probing 中 false は正しい） |
| `send` | active committed engine のみ。probing 中の誤 1.2 送信で壊さない |
| `close` | 全 candidate + carrier + timers |
| `extractSessionKeys` / `exportKeyingMaterial` | active version の exporter |
| `remoteCertificate` | active engine |
| `keyUpdate` | 1.3 only。committed12 では throw のまま可 |

### 2.4 推奨リファクタ（局所 if より優先）

可能なら association-level 操作へ集約する。

```ts
type AssociationPhase =
  | "initial"
  | "probing"
  | "committed12"
  | "committed13"
  | "closed";

// 例（名称は実装都合で可）
commitVersion(version, datagram?)
disposeCandidate(candidate, mode: "hard" | "soft")
closeAssociation()
dispatchInboundDatagram(bytes, peer?)
```

望ましい所有構造:

```text
Association (DtlsClient 内 or 抽出モジュール)
 ├─ phase
 ├─ DTLS 1.2 candidate (legacy flight state)
 ├─ DTLS 1.3 candidate (active | parked)
 ├─ carrier RX dispatcher
 ├─ transport RX dispatcher
 ├─ version commit
 ├─ candidate cancellation
 └─ close / fatal teardown
```

**エンジンは association-wide な version decision をしない。**  
1.3 engine の `tryParkDualProbe` は「soft HVR を association に伝える」まで。commit は client association 側。

避けるもの:

- `as any` で state machine 穴埋め
- private field をテストから大量操作する前提の設計（現状 e2e は `(client as any).dualPhase` 多用 — 段階的に test hook / 観測 API を検討）
- boolean 増殖、alert description ごとの例外
- `engine13` / `parkedEngine13` / legacy 間の cleanup コピペ
- version commit 処理の複数箇所重複
- losing candidate の late callback を「無視するだけ」

### 2.5 必須追加テスト

既存 `self13_dual_hvr_resume.test.ts` 等に加え、**少なくとも**次を満たす。  
Arrange / Act / Assert + **Act/Assert の日本語コメント**（リポジトリ規約）。

#### Test 1 — probing 中の close（既存あり → 強化・回帰）

```text
CH-A → HVR → dual probing → client.close() → RTO 進行
```

確認:

- parked engine closed
- pending flight なし
- custom carrier closed
- CH-A 追加送信なし
- `onError` / `onConnect` なし

fake timer が安全なら優先。現状は real timer + `INITIAL_RTO_MS` 待機。

#### Test 2 — carrier.inject 経由 1.3 commit（既存あり → 維持）

```ts
clientCarrier.inject(serverResponse, peer)
```

確認: probing → commit13 → `isDtls13 === true` → `await client.send(...)` 双方向。

#### Test 3 — carrier.inject 経由 1.2 commit（**未整備 → 必須追加**）

```text
HVR → probing → legitimate DTLS 1.2 ServerHello via carrier.inject → commit12
```

確認:

- parked 1.3 停止・1.3 retransmission なし
- `isDtls13 === false`
- 1.2 data 送受信成功
- carrier inject が association 1.2 path を通る（no-op にならない）

#### Test 4 — late losing-candidate packet（**未整備 → 必須追加**）

- **commit12 後:** late 1.3 HRR/SH → 1.3 に戻らない、`onConnect` 二重なし、state 不変
- **commit13 後:** late 1.2 SH / alert / HVR → 1.2 に戻らない、public error 誤発火なし

#### Test 5 — close と packet arrival の race（**未整備 → 必須追加**）

```text
probing → close() → 直後 carrier.inject(...)
probing → inject と close がほぼ同時
```

最終 state は必ず closed（再 connect なし、timer なし、error/connect なし）。

### 2.6 回帰マトリクス（壊していないこと）

最低限:

| シナリオ | 参照テスト / 手段 |
| --- | --- |
| default → DTLS 1.2 | `tests/e2e/self.test.ts` 等 |
| 1.3-only ↔ 1.3-only | `self13*.test.ts` |
| dual ↔ dual → 1.3 | dual / matrix |
| dual client ↔ 1.2-only server → 1.2 | `self13_dual_hvr_resume` HVR→1.2 |
| 1.3-only ↔ 1.2-only → version error（timeout ではない） | matrix / mismatch tests |
| X25519 / P-256 | `self13_p256` / ecdsa |
| HRR | self13 / peer_pin_hrr |
| client certificate | certificate_request / self13 |
| KeyUpdate | self13 |
| exporter `EXTRACTOR-dtls_srtp` | vectors + self |
| large cert / loss / reorder / duplicate | self13_large_cert / self13_loss |
| anti-replay / ACK | record tests / plaintext_ack |
| custom carrier / external retransmit | carrier_external_association |
| OpenSSL DTLS 1.2 | client/server e2e / `client_dual_openssl` |
| BoringSSL DTLS 1.3 | `npm run test:boringssl`（require 付き） |

### 2.7 修正時のファイル優先度

| 優先 | ファイル | 理由 |
| --- | --- | --- |
| P0 | `src/client.ts` | dual phase / demux / close / commit |
| P0 | `src/engine/v1_3/connection.ts` | park/unpark/release/bindInject |
| P0 | `src/engine/v1_3/connection-base.ts` | fail / tryParkDualProbe / timers |
| P0 | `src/carrier/direct.ts` + `types.ts` | inject ownership / close |
| P1 | `src/socket.ts` | public API 分岐・bridge |
| P1 | `src/server.ts` | server dual selectVersion |
| P1 | `tests/e2e/self13_dual_hvr_resume.test.ts` | 必須シナリオ集約 |
| P2 | `src/version.ts` | normalize / DOWNGRD 維持確認 |

---

## 3. 技術的な実装アプローチ（調査結果）

### 3.1 現状アーキテクチャ判断

- **1.2 と 1.3 の mutable crypto state は分離済み**（1.3 は `engine/v1_3`、1.2 は `DtlsContext`/`CipherContext`/`flight/*`）。
- **association 層は `DtlsClient` に埋め込み**で、独立クラスではない。phase と candidate 管理は動いているが、RX rebinding が phase ごとにエンジン直結 / no-op へ散らばる。
- **HVR park 設計は意図的**（RFC 9147 の CH-A 再送維持）。破棄して 1.2 専用に切り替える旧方針より正しい。問題は ownership 一貫性。
- **soft vs hard cleanup の二系統**がある:
  - hard: `close()` / `fail()` → carrier.close + transport.close
  - soft: `releaseForVersionFallback()` → flight/timer 停止、inject detach、**carrier は再利用可**
  - park: flight/timer **維持**、public engine13 を外す

### 3.2 推奨修正アプローチ

1. **Inbound を常に association dispatcher に寄せる**  
   commit 後も `dispatchInboundDatagram` が version/phase を見て active candidate に振る。  
   unpark 時に engine へ onData を独占させない、または engine 独占でも **closed/committed ガードを association 側に残す**。

2. **commit12 後の carrier.inject**  
   no-op ではなく association の 1.2 `handleUdpDatagram` へ接続する。  
   soft dispose は「1.3 candidate を死なす」だけで「carrier を殺す」ではない。

3. **phase に `closed` を導入（推奨）**  
   close 後の全 RX を即 drop。`none` への戻しは再接続設計がない限り避ける。

4. **candidate 集合の単一ソース**  
   `active13 | parked13 | legacy12` を列挙可能にし、`closeAssociation` が常に全 teardown。

5. **イベント購読の lifecycle**  
   dispose 時に bridge 購読を切る、または candidate generation token で stale callback を無効化。

6. **テスト戦略**  
   - まず必須 3–5 の failing test  
   - 次に dual e2e 全通  
   - `cd packages/dtls && npm run type && npm test`  
   - BoringSSL require 実行  
   - root `npm run ci`

### 3.3 検証コマンド

```bash
# 高速・修正ループ
cd packages/dtls
npm run type
npm test
# 絞り込み例
npx vitest run ./tests/e2e/self13_dual_hvr_resume.test.ts

# BoringSSL（pin 再現ビルド後）
# packages/dtls/tests/e2e/boringssl/fetch-and-build-boringssl.sh
cd packages/dtls && npm run test:boringssl
# または WERIFT_REQUIRE_BORINGSSL=1

# OpenSSL DTLS 1.2 回帰（環境に openssl が必要）
# 既存 e2e client/server / client_dual_openssl を npm test 内または個別実行

# リポジトリ全体
cd /workspace && npm run ci
```

BoringSSL revision pin: `packages/dtls/tests/e2e/boringssl/BORINGSSL_REVISION`  
（調査時点: `0bcc1e8473a1264b4de88e05a651763dc9a71b09`）

**禁止:** timeout 延伸だけ、assert 弱体化、skip 追加で緑にする。

### 3.4 状態機械（レビュー時に必ず更新する図）

実装後も次をドキュメント or テストコメントで同期する。

```text
[initial]
   | connect() CH-A (1.3 or dual)
   v
[wait_server / dual none]
   | HVR (unauth) & dual offers 1.2
   v
[probing]  -- close() --> [closed]
   |                    ^
   | commit13 (SH/HRR)  |
   +--------> [committed13] -- close() --+
   |                                    |
   | commit12 (1.2 SH)                  |
   +--------> [committed12] -- close() -+
```

各矢印で **誰が timer/flight/inject/public API を持つか** を表更新すること。

---

## 4. 考慮すべき制約や注意点

### 4.1 プロトコル / セキュリティ

- HVR は **認証されない**。version 確定に使わない。
- dual 中の spoofed HVR + 後から来る genuine 1.3 SH を壊さない（CH-A transcript / ECDHE 維持）。
- DOWNGRD sentinel を dual→1.2 で必ず検査。弱体化禁止。
- peer pin / anti-amplification / pre-cookie isolation の既存 P1 修正を回帰させない。
- unauthenticated alert の扱いを description 列挙で肥大化させない。

### 4.2 API / 互換

- 既定 `protocolVersions` 省略 = **DTLS 1.2 only**（WebRTC `packages/webrtc/src/transport/dtls.ts` を壊さない）。
- `DtlsClient` / `DtlsServer` コンストラクタ互換。追加 options は optional。
- `handshakeCarrier` は **Internal options**（`createDtlsClientInternal`）。Public `Options` に露出しない現状を維持。
- draft codepoint / 内部 queue を安定 Public API に出さない。

### 4.3 Carrier / 将来 SPED

- Epic 2 は同一 `DtlsHandshakeCarrier` に SPED を差す前提。
- soft version transition で **injected carrier を close しない**（既存コメント・テスト `injected carrier survives HVR soft fallback`）。
- ただし hard association close では carrier を必ず close。
- inject path と UDP path の意味論を揃え、SPED だけ別 state machine にしない。

### 4.4 テスト規約

- Arrange / Act / Assert の三層。
- Arrange 共通化は utility へ（`setupChAThenSpoofedHvr` 等を拡張）。
- Act / Assert に日本語コメント。
- private を `(as any)` で読むのは最小限。可能なら観測用の内部テスト API を `internal.ts` 経由に限定。

### 4.5 実行環境

- Runtime: Linux / macOS 等 Unix 系（Windows native 非対応）。
- BoringSSL は skip を成功扱いしない。pin + harness で実行。
- OpenSSL 1.2 E2E も実行可能な環境で確認。実行不能なら **未確認** と明記（推測 PASS 禁止）。

### 4.6 作業ブランチ注意

- レビュー対象: `ticket/5fc64332-b0d1-4ab0-bc1e-4b0f3a26c135`
- 先端に CI 追随コミット（`eaca3de4` 等）がある場合は **対象 tip を最新化してから** 試験する。
- develop 追従 merge が必要な場合は dual/association 衝突に注意。

---

## 5. 完了条件

### 5.1 本チケット固有（association / review）

| ID | 条件 | 判定 |
| --- | --- | --- |
| R1 | association が全 candidate を一括 teardown できる（probing close 含む） | PASS 必須 |
| R2 | UDP と `carrier.inject` が同一 demux 方針（少なくとも probing と commit 経路） | PASS 必須 |
| R3 | probing / committed12 / committed13 / closed の invariant がコード+テストで保証 | PASS 必須 |
| R4 | 必須テスト 1–5 が追加または既存で網羅されすべて成功 | PASS 必須 |
| R5 | actionable 1.2 fatal alert を probing 中に timeout 化していない | PASS 必須 |
| R6 | version API が `[V1_2]`/`[V1_3]`/`[V1_3,V1_2]`、DOWNGRD 非弱体化 | PASS 必須 |
| R7 | 既知パターン以外の自律発見問題を P0/P1（と関連 P2）まで解消 | PASS 必須 |
| R8 | 特殊ケース専用 if の寄せ集めではなく lifecycle が一貫 | PASS 必須 |

### 5.2 親 Epic 1 完了条件（再確認必須）

#### 機能

- [ ] werift 同士が direct datagram 上で DTLS 1.3 full handshake（両 role）と双方向 app data
- [ ] BoringSSL と DTLS 1.3 両 role interop（pin 済み revision、再現ビルド）
- [ ] OpenSSL `-dtls1_2` 既存 E2E と DTLS 1.2 unit が通る
- [ ] `[1.3,1.2]` が 1.2-only に fallback、1.3-only×1.2-only は version error
- [ ] KeyUpdate 後も epoch 混線なし
- [ ] デフォルト 1.2 挙動不変（WebRTC 経路含む）
- [ ] `EXTRACTOR-dtls_srtp` exporter 正常（1.2/1.3）

#### 品質・アーキテクチャ・docs

- [ ] vector / loss / negative / actionable fail テスト群
- [ ] 1.2/1.3 crypto state 非共有、carrier 最小 interface、Public API 清潔、コンストラクタ互換
- [ ] BoringSSL docs + DTLS 1.3 opt-in docs（`packages/dtls/README.md` 等）

#### 検証実行

- [ ] `cd packages/dtls && npm run type && npm test` 成功
- [ ] BoringSSL interop 成功（skip で成功扱いしない）
- [ ] 必要に応じ root `npm run ci` 成功

### 5.3 最終報告フォーマット（作業終了時必須）

#### 発見した問題

重要度順 **P0 / P1 / P2 / P3**。  
**既知指摘**と**自律発見**を明確に区別する。

各問題:

- 発生条件
- root cause
- なぜ既存テストで検出されなかったか
- 修正方針
- 追加したテスト
- regression 影響

#### テスト結果

最低限次を **コマンドと結果**で記録（未実行は「未確認」、推測 PASS 禁止）:

```text
packages/dtls type
packages/dtls test
OpenSSL DTLS1.2
BoringSSL DTLS1.3 client/server
root npm run ci
```

#### 最終判定表

親 Epic 完了条件 + 本チケット R1–R8 を

```text
PASS | FAIL | 未確認
```

で一覧化する。

### 5.4 終了ゲート

次をすべて満たすまで作業終了しない。

1. すべての **P0 / P1** が解消  
2. association lifecycle / carrier ownership 関連の **P2** が解消  
3. 必須テスト 1–5 が緑  
4. `packages/dtls` type+test 緑  
5. BoringSSL interop 緑（または実行不能理由を明示し **未確認** — その場合 Epic 完了とはみなさない）  
6. OpenSSL 1.2 回帰が緑または未確認を明示  
7. 最終報告が上記フォーマットで埋まっている  

---

## 6. 参考

- 親チケット: `TICKET-ticket-5fc64332-b0d1-4ab0-bc1e-4b0f3a26c135.md`
- Issue #659 Epic 1: Direct DTLS 1.3 endpoint
- `docs/plan/research-warp.txt` §2.1–2.5, §3.1–3.3, §4–5
- RFC 9147 / RFC 8446 / RFC 5764 DTLS-SRTP
- 実装: `packages/dtls/src/{client,server,socket,carrier,engine/v1_3,version}.*`
- Dual e2e: `packages/dtls/tests/e2e/self13_dual_hvr_resume.test.ts`
- BoringSSL: `packages/dtls/tests/e2e/boringssl/README.md`
- WebRTC 暗黙依存: `packages/webrtc/src/transport/dtls.ts`

---

## 7. 調査時点の Residual Risk（着手時の仮説・要実証）

以下は **コード読解に基づく疑い**であり、着手後に再現テストで確定/棄却すること。

| ID | 疑い | 重要度仮説 | 根拠 |
| --- | --- | --- | --- |
| H1 | commit12 後 `releaseForVersionFallback` が inject を no-op にし、carrier 経路の 1.2 RX が死ぬ | P1 | `connection.ts` release + client `commitDualTo12` |
| H2 | commit13 unpark が onData/inject を engine 直結にし、association の late-packet ポリシーを迂回しうる | P2 | `unparkFromDualProbe` |
| H3 | phase に `closed` がなく、close 後 `none` へ戻るため invariant が弱い | P2 | `closeAllDtls13Candidates` |
| H4 | `bridgeEngine13` 購読が dispose で外れず、stale onConnect/onError のリスク | P1–P2 | `socket.ts` bridge + park 生存 |
| H5 | 必須テスト 3–5（inject 1.2 commit / late losing / close race）未整備 | P1（カバレッジ） | dual e2e 一覧 |
| H6 | 1.2 Flight retransmit と parked CH-A RTO の二重 ownership が close レースで片肺残存 | P1 | dual Flight1 + parked engine |

既知修正済みとして再発確認するもの: probing close、illegal_parameter 限定 suppress、CH-A+HVR race、carrier inject 1.3 commit。
