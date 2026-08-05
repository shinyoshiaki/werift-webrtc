# Epic 1: Direct DTLS 1.3 endpoint を実行する

- 親 Issue: [shinyoshiaki/werift-webrtc#659](https://github.com/shinyoshiaki/werift-webrtc/issues/659)
- 参考調査: `docs/plan/research-warp.txt`
- ベース: `develop`（調査 rev: `e651fd12891e262515ac8999d6fb105a1c0fa9ab`）
- 主対象パッケージ: **`packages/dtls`**（Epic 1 では ICE/WebRTC 統合はスコープ外）

---

## 1. タスクの目的と背景

### 目的

WARP（WebRTC Abridged Roundtrip Protocol）対応の土台として、**direct datagram 上で動く完全な DTLS 1.3 エンドポイント**を `packages/dtls` に実装する。

Epic 1 完了時点で、werift は次を満たす必要がある。

1. 証明書認証付き DTLS 1.3 full handshake を client/server 両 role で完了できる。
2. 保護済み application data を双方向交換できる。
3. **werift 同士**および **BoringSSL** との相互接続が成立する。
4. 既存 **DTLS 1.2（OpenSSL E2E 含む）** が回帰しない。

### 背景

- 現行 werift は **DTLS 1.2 のみ**（wire version `0xfefd` 相当、`DtlsContext.version = { major: 254, minor: 253 }`）。
- ハンドシェイクは `flight1`〜`flight6` + `HelloVerifyRequest` の 6-flight 構成で、TLS 1.2 PRF / explicit-nonce AEAD に依存している。
- WARP は DTLS 1.3（1-RTT 証明書付き full handshake）・SPED・SNAP の組み合わせで接続遅延を削減する。Issue #659 全体はそのフルスタックだが、**Epic 1 は direct transport 上の DTLS 1.3 完結エンドポイント**に限定する。
- 暗号プリミティブ・codec・record・handshake・最小 association を別 Epic に分割すると「外部接続可能なプロトコル端点」が得られないため、Issue 方針どおり **1 Epic に束ねる**。

### Epic 境界（何をやらないか）

| 対象外 | 担当 Epic |
| --- | --- |
| SPED / STUN 埋め込み / ICE 並行起動 | Epic 2 |
| `RTCPeerConnection` 統合・fingerprint 連携・early media 配送ポリシー | Epic 3 |
| 故障注入マトリクス全体・リリース docs 最終整備 | Epic 4 |
| SNAP / PSK client 0-RTT / CID / RFC 9853 RRC / PQ KEX | 本 Issue 全体でも初期対象外 |

Epic 1 では **SPED を前提にしない**が、後続 Epic が差し込める **transport 非依存 carrier の最小 interface** までは用意する。

---

## 2. 実装すべき具体的な機能や変更内容

### 2.1 バージョン設定と実験オプション

`packages/dtls/src/socket.ts` の `Options` を拡張する（名称は既存慣例に合わせてよいが挙動は固定）。

```ts
export enum DtlsVersion {
  V1_2 = "1.2",
  V1_3 = "1.3",
}

// Options に相当する追加フィールド
protocolVersions?: readonly DtlsVersion[]; // 順序 = 優先順位
addressValidation?: "dtls-cookie" | "ice-authenticated" | "none";
```

| 要件 | 内容 |
| --- | --- |
| デフォルト | **DTLS 1.2 only**（現状互換）。1.3 は明示 opt-in |
| 選択パターン | 1.3 only / `[1.3, 1.2]` fallback / 1.2 only |
| 失敗形態 | 1.3-only × 1.2-only は **timeout ではなく protocol-version エラー** |
| renegotiation | 1.3 確立後の DTLS 1.2 renegotiation は拒否 |
| Public API | draft codepoint や内部 queue を安定 API に出さない |

### 2.2 バージョン非依存 association 層とエンジン分離

現行 `DtlsClient` / `DtlsServer` / `DtlsSocket` / `flight/*` を **DTLS 1.2 エンジン**として残し、外側に共通 association を置く。

**共通層の責務**

- 証明書・SRTP profile（`use_srtp`）・datagram lifecycle・共通 Event（`onConnect` / `onData` / `onError` / `onClose`）
- バージョン選択（`supported_versions` ネゴシエーション）
- carrier 抽象への送受信

**分離必須の可変状態（1.2 と 1.3 で共有しない）**

- epoch / record sequence / handshake transcript
- read/write key / replay window / flight timer

**現行コードのギャップ（調査結果）**

| 箇所 | 現状 | Epic 1 での対応 |
| --- | --- | --- |
| `context/dtls.ts` | version 固定、単一 epoch/sequence/flight | 1.2 engine 用 state に閉じ込め、1.3 用 state を新設 |
| `flight/*` + `flight.ts` | HelloVerify 含む 6-flight、固定再送 timer | Dtls12 adapter として維持。1.3 は ACK 駆動 state machine |
| `record/message/plaintext.ts` / `receive.ts` | 13-byte DTLS 1.2 header 固定 | versioned parser + unified ciphertext header |
| `cipher/prf.ts` / `suites/aead.ts` | TLS 1.2 PRF、explicit nonce、13-byte AAD | HKDF + DTLS 1.3 nonce/AAD を別実装 |
| `cipher/const.ts` | `0xc02b` / `0xc02f` のみ | `TLS_AES_128_GCM_SHA256 (0x1301)` 等を追加 |
| `handshake/const.ts` | 1.2 handshake types のみ | EncryptedExtensions / ACK / KeyUpdate 等を追加 |
| `record/antiReplayWindow.ts` | 単体テストはあるが受信 path 未使用 | 1.3 では epoch ごと必須統合 |
| `Options` | version 設定なし | `protocolVersions` 等を追加 |

### 2.3 DTLS 1.3 handshake プリミティブ

RFC 9147 / RFC 8446（および RFC 9147 verified errata）に従い実装する。

**必須 wire / extension / crypto**

- wire version `0xfefc`、`ClientHello.legacy_version = 0xfefd`
- extensions: `supported_versions`, `supported_groups`, `key_share`, `signature_algorithms`, 必要なら `signature_algorithms_cert`, 既存 `use_srtp`
- cipher: **`TLS_AES_128_GCM_SHA256 (0x1301)`**（初期必須）
- groups: **X25519**（必須）、**P-256**
- signatures: `ecdsa_secp256r1_sha256`、TLS 1.3 用 **RSA-PSS**
- 任意: `CertificateRequest` + 相互証明書認証
- 任意: key-share 用 `HelloRetryRequest` + 第 2 `ClientHello`

**禁止（1.3 経路では送らない）**

`HelloVerifyRequest` / `ServerKeyExchange` / `ClientKeyExchange` / `ServerHelloDone` / `ChangeCipherSpec`

**重要**: 既存 DTLS 1.2 の RSA PKCS#1 `CertificateVerify` を 1.3 に流用しない。

**full handshake 順序**

1. ClientHello  
2. （任意）HRR + 第 2 ClientHello  
3. ServerHello  
4. EncryptedExtensions  
5. （任意）CertificateRequest  
6. Certificate  
7. CertificateVerify  
8. server Finished  
9. （任意）client Certificate / CertificateVerify  
10. client Finished  
11. final DTLS ACK  

### 2.4 Transcript と TLS 1.3 key schedule

既存 `prf.ts` の master-secret モデルとは独立に実装する。

- `HKDF-Extract` / DTLS 1.3 `HKDF-Expand-Label`（label prefix **`dtls13`**）
- early / handshake / master secret
- client/server handshake traffic secret、application traffic secret
- Finished key / verify data、exporter master secret、traffic secret update
- DTLS-SRTP exporter: **`EXTRACTOR-dtls_srtp`**

**transcript に含めないもの**

record header / fragment metadata / 再送 duplicate / DTLS ACK /（後続）SPED CRC ACK

transcript は **再構成済み完全 handshake message** のみから計算する。

### 2.5 DTLS 1.3 record layer

- epoch 0: `DTLSPlaintext`
- DTLS 1.3 unified ciphertext header + `DTLSInnerPlaintext`
- truncated record sequence 復元、16-bit sequence、explicit length
- DTLS 1.3 固有 nonce / AAD
- coalesced record の順次パースと厳格な長さ検証
- epoch ごとの独立 read/write key・sequence・replay window
- epoch 割当: 0=plaintext, **1=予約・未使用**, 2=handshake, 3=初期 application, 4+=KeyUpdate
- content type **ACK = 26**（partial / implicit / final-flight / empty ACK）
- ロス・reorder 時の再送
- `KeyUpdate` と旧 epoch key の有界保持・破棄
- **CID 非対応**（C=1 は誤解釈せず明示拒否）

### 2.6 最小 direct association / carrier

後続 SPED 差し込みのための最小 interface（形状は実装都合で可変、能力は必須）。

```ts
interface DtlsHandshakeDatagram {
  readonly bytes: Buffer;
  readonly flightId: number;
  readonly packetIndex: number;
  readonly retransmittable: boolean;
}

interface DtlsHandshakeCarrier {
  send(packet: DtlsHandshakeDatagram): Promise<void>;
  inject(bytes: Buffer): void;
  getMtu(): number;
  updateRtt(rttMs: number): void;
  setRetransmissionMode(mode: "internal" | "external"): void;
}
```

**必須能力**

- 生成後不変の serialized flight bytes（防御的 copy）
- flight 作成 / handshake 完了イベント
- cancel 可能な timer
- handshake datagram と application datagram の経路分離
- direct carrier での dynamic MTU（現行 `FragmentedHandshake.chunk()` の 1280 固定を置き換え可能にする）
- close / error / handshake 完了時の timer・pending task 全 cancel

Epic 1 では retransmission mode は主に **`internal`** で完結させる。`external` は interface と timer 停止/再開の骨格まででよい（実 SPED 駆動は Epic 2）。

### 2.7 テスト実装（Epic 1 の核）

codec / vector だけでは完了とみなさない。**接続可能なエンドポイント同士**で検証する。

#### A. 単体・vector（必須だが不十分）

- HKDF、transcript hash、traffic secret、Finished、exporter
- encrypted record、sequence reconstruction、replay、ACK、KeyUpdate
- CID なし unified header、coalesced / fragment / invalid input の negative test

#### B. werift-to-werift（direct datagram、必須）

独立 client/server プロセスまたは同等の endpoint 分離で:

- 両 role 方向
- DTLS 1.3 only / 1.3 preferred + 1.2 fallback
- X25519 / P-256
- HRR あり・なし
- client certificate あり・なし
- 双方向 application data
- KeyUpdate 後の双方向 data
- loss / reorder / duplicate
- large certificate / multi-record flight
- 1.3-only × 1.2-only の明確な version error

既存 `tests/e2e/self.test.ts` パターンを 1.3 向けに拡張する。

#### C. BoringSSL interop（P0・必須）

- revision pin + CMake/Ninja 再現ビルド
- 環境変数 override（例: `WERIFT_BORINGSSL_BSSL`）
- werift client × BoringSSL server、BoringSSL client × werift server
- 証明書付き full handshake、`TLS_AES_128_GCM_SHA256`、X25519、双方向 data
- 可能なら P-256 / mutual auth / KeyUpdate / exporter 比較
- 失敗時は alert / flight ログを残して fail（catch-and-ignore 禁止）

#### D. OpenSSL DTLS 1.2 regression（必須維持）

既存 `tests/e2e/client.test.ts` / `server.test.ts` / `certificate_request/*` の `-dtls1_2` を維持・必要なら拡張:

- 1.2 only 両 role
- 1.3 preferred 設定が 1.2 peer に fallback
- 既存 DTLS-SRTP exporter 回帰（1.2 経路）

---

## 3. 技術的な実装アプローチ（調査結果サマリ）

### 3.1 推奨実装順序（Epic 1 内）

Issue / `research-warp.txt` §3.3 を Epic 1 範囲に切り出すと次の順が安全。

1. **設定と共通 association 骨格**  
   `DtlsVersion` / `protocolVersions` を追加し、既存 1.2 を adapter 経由で動かす（挙動変更なし）。
2. **carrier / flight 不変化 / cancel timer / dynamic MTU**  
   1.2 経路でも使える共通基盤を先に入れる。
3. **TLS 1.3 message/extension codec + transcript + HKDF**  
   deterministic vector test を先に通す。
4. **record protection（unified header, AEAD, epoch, replay, ACK, KeyUpdate）**  
   `antiReplayWindow` を受信 path に統合。
5. **client/server full handshake state machine + 1.2 fallback**  
   direct UDP で self interop。
6. **BoringSSL harness** と OpenSSL 1.2 regression 確認。

巨大一括置換を避け、**versioned boundary ごとにレビュー可能な差分**にする。

### 3.2 現行依存関係の再利用方針

| 再利用 | 新規・分離 |
| --- | --- |
| `@noble/curves` / `tweetnacl` による X25519・P-256 | TLS 1.3 RSA-PSS CertificateVerify |
| 既存 `use_srtp` extension codec | DTLS 1.3 exporter 実装（TLS 1.2 `exportKeyingMaterial` とは別） |
| `UdpTransport`（`packages/common`） | `DtlsHandshakeCarrier` direct 実装 |
| OpenSSL spawn E2E パターン | BoringSSL spawn harness |
| `Event` ベース通知（`onConnect` 等） | readiness の細分化は Epic 3 中心（Epic 1 は connected + data で可。内部 writeReady 等は実装都合で先置き可） |

### 3.3 外部 interop の確定方針（Epic 1）

| peer | 役割 | Epic 1 |
| --- | --- | --- |
| **BoringSSL** | DTLS 1.3 外部参照 | **必須** |
| **werift self** | 回帰主軸 | **必須** |
| **OpenSSL** | DTLS 1.2 regression | **必須維持** |
| pion | SPED/ICE | Epic 2 以降 |
| libwebrtc / libsrtp2 | — | 不要 |

### 3.4 ディレクトリ案（実装時の目安）

既存 tree を壊さず、例えば次のように分離する（名称は実装時調整可）。

```
packages/dtls/src/
  association/          # 共通 lifecycle / version select
  engine/v1_2/          # 既存 flight を adapter
  engine/v1_3/          # handshake SM, ACK, KeyUpdate
  cipher/tls13/         # HKDF, key schedule, AEAD-13
  record/v1_3/          # unified header, inner plaintext
  carrier/              # direct carrier (+ 将来 external)
```

既存パスを段階的に移動しても、**Public export（`index.ts` の `DtlsClient` / `DtlsServer`）互換**を優先する。

---

## 4. 考慮すべき制約や注意点

### Protocol / security

- 規範は RFC 9147 + RFC 8446 + verified errata。
- generic `werift-dtls` は cookie / anti-amplification を維持。address validation 前は server 送信量を受信量の **3 倍以内**に制限。HRR は cookie 省略時も動作。
- fragment / reassembly / ACK / retransmission / old epoch key に **件数・bytes・時間の上限**を設ける。
- cached flight `Buffer` は防御的 copy（呼び出し側による破壊を防ぐ）。
- epoch 1 は予約のみ。PSK / client 0-RTT を「実装した」と宣言しない。不要 extension は reject/decline。

### Compatibility

- **デフォルトは DTLS 1.2**。opt-in なしで挙動を変えない。
- `packages/webrtc` の `RTCDtlsTransport` が現状の `DtlsClient`/`DtlsServer` を使う前提を壊さない（Epic 1 完了後も 1.2 既定で WebRTC が動くこと）。
- Public API 変更時は `packages/dtls/src/index.ts` と README を同時更新。
- DTLS protocol fallback（1.3→1.2）と、後続の SPED carrier fallback を混同しない。

### テスト規約（AGENTS.md）

- Arrange / Act / Assert の三段階。
- 再利用 Arrange は package 内の単一 utility に集約。
- Act / Assert に日本語コメントを適切な粒度で付ける。
- 失敗を catch-and-ignore しない。

### 検証コマンド（package 優先）

```bash
cd packages/dtls && npm run type && npm test
# 変更が common に及ぶ場合
npm run type && npm run test:small
```

BoringSSL harness は必須 CI では未導入時 fail、ローカルでは skip with reason を許容（Issue 方針）。

### スコープ漏れ防止

- Epic 1 で ICE/SPED/PeerConnection に手を広げすぎない。carrier interface の「骨格」までに留める。
- early server application data（server Finished 後・client Finished 前の epoch 3 送信）は WARP 要件だが、**Epic 1 では record/key が成立し self で送受信できること**を優先。WebRTC fingerprint ゲート付き配送は Epic 3。

---

## 5. 完了条件

### 機能

- [ ] werift 同士が direct datagram 上で DTLS 1.3 full handshake（両 role）を完了し、双方向 protected application data を交換できる。
- [ ] BoringSSL と DTLS 1.3 両 role interop が成功する（pin 済み revision、再現ビルド、env override 文書化）。
- [ ] OpenSSL `-dtls1_2` 既存 E2E と DTLS 1.2 unit test が通る。
- [ ] `[1.3, 1.2]` が 1.2-only peer に fallback し、1.3-only × 1.2-only は version error で失敗する（timeout ではない）。
- [ ] KeyUpdate 後も epoch state を混線させず双方向 data が通る。
- [ ] デフォルト（opt-in なし）の DTLS 1.2 挙動が変わっていない。

### 品質・テスト

- [ ] HKDF / transcript / secrets / Finished / exporter / record / replay / ACK / KeyUpdate の deterministic vector test がある。
- [ ] loss / reorder / duplicate / large cert / multi-record / HRR / mutual auth の self connection test がある。
- [ ] CID=1・truncated・oversized 等の negative test がある。
- [ ] handshake 失敗・version mismatch・timeout が actionable なログ付きで fail する。

### アーキテクチャ

- [ ] DTLS 1.2 / 1.3 の mutable crypto state が共有されていない。
- [ ] 最小 `DtlsHandshakeCarrier`（または同等）が direct 経路で動作し、immutable flight bytes と cancel 可能 timer を持つ。
- [ ] draft 内部実装詳細が安定 Public API に露出していない。

### 検証実行

- [ ] `cd packages/dtls && npm run type && npm test` 成功。
- [ ] 必要に応じて workspace `npm run type` / `npm run test:small`。
- [ ] BoringSSL interop harness が成功（または必須 CI 定義と docs が揃い、ローカル skip 条件が明示）。

### ドキュメント

- [ ] BoringSSL の revision / ビルド / 起動 / `WERIFT_BORINGSSL_BSSL` が `packages/dtls` 近傍 docs に再現可能に記載されている。
- [ ] DTLS 1.3 の opt-in 方法と「デフォルト 1.2」が README または同等 docs に記載されている（詳細 WARP 説明の完成は Epic 4 でも可だが、Epic 1 API の使い方は最低限必要）。

---

## 参考

- Issue #659 Epic 1 節: Direct DTLS 1.3 endpoint
- `docs/plan/research-warp.txt` §2.1–2.5, §3.1–3.3, §4–5
- [RFC 9147](https://www.rfc-editor.org/rfc/rfc9147.html) / [RFC 8446](https://www.rfc-editor.org/rfc/rfc8446.html)
- [RFC 5764 DTLS-SRTP](https://www.rfc-editor.org/rfc/rfc5764.html)
- 現行実装: `packages/dtls/src/{socket,client,server,flight,cipher,record,context}/*`
- 現行 E2E: `packages/dtls/tests/e2e/{self,client,server,certificate_request}/*`
