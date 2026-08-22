# Epic 1: Direct DTLS 1.3 endpoint を実行する

- 親 Issue: [shinyoshiaki/werift-webrtc#659](https://github.com/shinyoshiaki/werift-webrtc#659)
- 参考調査: `docs/plan/research-warp.txt`（§2.1–2.5, §3.1–3.3, §4–5）
- ベース: `develop`（調査 rev: `e651fd12891e262515ac8999d6fb105a1c0fa9ab`）
- 主対象パッケージ: **`packages/dtls`**（Epic 1 では ICE/WebRTC 統合はスコープ外）
- 公開入口: `packages/dtls/src/index.ts` の `DtlsClient` / `DtlsServer` / `DtlsSocket`

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

- 現行 werift は **DTLS 1.2 のみ**（wire version `0xfefd`）。`DtlsContext.version` は `{ major: 255 - 1, minor: 255 - 2 }` 固定。
- ハンドシェイクは `flight1`〜`flight6` + `HelloVerifyRequest` の 6-flight 構成で、TLS 1.2 PRF / explicit-nonce AEAD に依存している。
- WARP は DTLS 1.3（1-RTT 証明書付き full handshake）・SPED・SNAP の組み合わせで接続遅延を削減する。Issue #659 全体はそのフルスタックだが、**Epic 1 は direct transport 上の DTLS 1.3 完結エンドポイント**に限定する。
- 暗号プリミティブ・codec・record・handshake・最小 association を別 Epic に分割すると「外部接続可能なプロトコル端点」が得られないため、Issue 方針どおり **1 Epic に束ねる**。
- 後続 Epic（SPED / PeerConnection）は、本 Epic が提供する **version 分離エンジン** と **carrier 抽象** の上に載せる。

### Epic 境界（何をやらないか）

| 対象外 | 担当 Epic |
| --- | --- |
| SPED / STUN 埋め込み / ICE 並行起動 | Epic 2 |
| `RTCPeerConnection` 統合・fingerprint 連携・early media 配送ポリシー | Epic 3 |
| 故障注入マトリクス全体・リリース docs 最終整備 | Epic 4 |
| SNAP / PSK client 0-RTT / CID / RFC 9853 RRC / PQ KEX | 本 Issue 全体でも初期対象外 |

Epic 1 では **SPED を前提にしない**が、後続 Epic が差し込める **transport 非依存 carrier の最小 interface** までは用意する。

**Epic 1 で「やらないが、後から壊れないようにしておく」もの**

- epoch 1 は予約・未使用のまま（PSK/0-RTT を実装済みと宣言しない）。
- `external` retransmission mode は interface + timer 停止/再開の骨格のみ（SPED 駆動は Epic 2）。
- early server application data（server Finished 後・client Finished 前の epoch 3 送信）は record/key が成立すれば self で送受信可能なレベルまで。WebRTC fingerprint ゲート付き配送は Epic 3。

---

## 2. 実装すべき具体的な機能や変更内容

### 2.1 バージョン設定と実験オプション

`packages/dtls/src/socket.ts` の `Options` を拡張する（名称は既存慣例に合わせてよいが挙動は固定）。

**現状の `Options`（抜粋）**

```ts
export interface Options {
  transport: Transport;
  srtpProfiles?: SrtpProfile[];
  cert?: string;
  key?: string;
  signatureHash?: SignatureHash;
  certificateRequest?: boolean;
  extendedMasterSecret?: boolean;
  // protocolVersions / addressValidation は未存在
}
```

**追加する型・フィールド**

```ts
export enum DtlsVersion {
  V1_2 = "1.2",
  V1_3 = "1.3",
}

// Options に相当する追加フィールド
protocolVersions?: readonly DtlsVersion[]; // 順序 = 優先順位。未指定時は [V1_2]
addressValidation?: "dtls-cookie" | "ice-authenticated" | "none";
// 既定: generic dtls は "dtls-cookie"。WebRTC 側で ICE 認証済みにするのは Epic 2/3
```

| 要件 | 内容 |
| --- | --- |
| デフォルト | **DTLS 1.2 only**（現状互換）。1.3 は明示 opt-in |
| 選択パターン | 1.3 only / `[1.3, 1.2]` fallback / 1.2 only |
| 失敗形態 | 1.3-only × 1.2-only は **timeout ではなく protocol-version エラー**（alert `protocol_version(70)` 相当を検討） |
| renegotiation | 1.3 確立後の DTLS 1.2 renegotiation は拒否。既存 `DtlsSocket.renegotiation()` は 1.2 経路のみ |
| Public API | draft codepoint や内部 queue を安定 API に出さない |

### 2.2 バージョン非依存 association 層とエンジン分離

現行 `DtlsClient` / `DtlsServer` / `DtlsSocket` / `flight/*` を **DTLS 1.2 エンジン**として残し、外側に共通 association を置く。

**共通層の責務**

- 証明書・SRTP profile（`use_srtp`）・datagram lifecycle・共通 Event（`onConnect` / `onData` / `onError` / `onClose`）
- バージョン選択（`supported_versions` ネゴシエーション）
- carrier 抽象への送受信
- Public 入口の維持: `new DtlsClient(options)` / `new DtlsServer(options)` が WebRTC からそのまま使えること

**分離必須の可変状態（1.2 と 1.3 で共有しない）**

- epoch / record sequence / handshake transcript
- read/write key / replay window / flight timer

**現行コードのギャップ（本ワークツリーで再確認済み）**

| 箇所 | 現状 | Epic 1 での対応 |
| --- | --- | --- |
| `context/dtls.ts` | version 固定 `0xfefd`、単一 epoch/sequence/flight/handshakeCache | 1.2 engine 用 state に閉じ込め、1.3 用 state を新設 |
| `flight/*` + `flight.ts` | HelloVerify 含む 6-flight、固定再送 timer | Dtls12 adapter として維持。1.3 は ACK 駆動 state machine |
| `flight/server/flight2.ts` | extension type **43**（`supported_versions`）を log のみ（`// todo dtls1.3`） | 1.3 エンジンで正式に解釈・選択。1.2 経路では無視継続可 |
| `record/message/plaintext.ts` / `receive.ts` | 13-byte DTLS 1.2 header 固定。`receive.ts` は offset 11 で length を読む | versioned parser + unified ciphertext header |
| `cipher/prf.ts` / `suites/aead.ts` | TLS 1.2 PRF、`exportKeyingMaterial` は `prfPHash`、explicit nonce + 13-byte AAD | HKDF + DTLS 1.3 nonce/AAD を **別モジュール**で実装（既存を書き換えない） |
| `cipher/const.ts` | suite `0xc02b` / `0xc02f` のみ。`SignatureScheme` は `rsa_pkcs1_sha256` と `ecdsa_secp256r1_sha256` のみ | `TLS_AES_128_GCM_SHA256 (0x1301)`、TLS 1.3 用 RSA-PSS scheme 等を追加 |
| `handshake/const.ts` | 1.2 handshake types のみ（EncryptedExtensions / ACK / KeyUpdate なし） | 1.3 types を追加 |
| `record/const.ts` | ContentType は CCS/alert/handshake/appData のみ | **ACK = 26** を追加 |
| `record/antiReplayWindow.ts` | 単体テストのみ。**受信 path から未 import**（`grep` で確認） | 1.3 では epoch ごと必須統合。1.2 への適用は回帰を避け任意 |
| `record/message/fragment.ts` | `chunk()` 既定 MTU が **1280 − IP/UDP − handshake overhead** 固定 | carrier `getMtu()` から分割サイズを取る |
| `socket.ts` `Options` | version 設定なし | `protocolVersions` / `addressValidation` を追加 |
| `packages/webrtc/.../transport/dtls.ts` | `new DtlsServer` / `new DtlsClient` を options 既定で生成 | Epic 1 では **触らない**。既定 1.2 のまま WebRTC が動くこと |

### 2.3 DTLS 1.3 handshake プリミティブ

RFC 9147 / RFC 8446（および RFC 9147 verified errata）に従い実装する。

**必須 wire / extension / crypto**

| 項目 | 値 / 内容 |
| --- | --- |
| wire version | `0xfefc`（record/legacy 表記は RFC 9147 に従う） |
| ClientHello.legacy_version | `0xfefd` |
| extensions | `supported_versions`(43), `supported_groups`, `key_share`, `signature_algorithms`, 必要なら `signature_algorithms_cert`, 既存 `use_srtp` |
| cipher（初期必須） | **`TLS_AES_128_GCM_SHA256 (0x1301)`** |
| groups | **X25519（必須）**、**P-256**（既存 `@noble/curves` / `tweetnacl` を再利用） |
| signatures | `ecdsa_secp256r1_sha256`、TLS 1.3 用 **RSA-PSS**（`rsa_pss_rsae_sha256` 等）。**既存 PKCS#1 CertificateVerify を流用しない** |
| 任意 | `CertificateRequest` + 相互証明書認証 |
| 任意 | key-share 用 `HelloRetryRequest` + 第 2 `ClientHello` |

**禁止（1.3 経路では送らない）**

`HelloVerifyRequest` / `ServerKeyExchange` / `ClientKeyExchange` / `ServerHelloDone` / `ChangeCipherSpec`

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

既存 `prf.ts` の master-secret モデルとは独立に実装する（推奨: `cipher/tls13/`）。

- `HKDF-Extract` / DTLS 1.3 `HKDF-Expand-Label`（label prefix **`dtls13`** ※ TLS は `tls13`）
- early / handshake / master secret
- client/server handshake traffic secret、application traffic secret
- Finished key / verify data、binder master secret、traffic secret update
- DTLS-SRTP exporter: label **`EXTRACTOR-dtls_srtp`**（TLS 1.3 exporter 経路。現行 `exportKeyingMaterial` の PRF 経路とは分離）

**transcript に含めないもの**

record header / fragment metadata / 再送 duplicate / DTLS ACK /（後続）SPED CRC ACK

transcript は **再構成済み完全 handshake message** のみから計算する。

### 2.5 DTLS 1.3 record layer

- epoch 0: `DTLSPlaintext`
- DTLS 1.3 unified ciphertext header + `DTLSInnerPlaintext`
- truncated record sequence 復元、16-bit sequence、explicit length
- DTLS 1.3 固有 nonce / AAD（1.2 の 13-byte AAD + explicit nonce と混在させない）
- coalesced record の順次パースと厳格な長さ検証（現行 `parsePacket` の 1.2 固定 offset を流用しない）
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

**direct carrier 実装の足場**

- 送受信は既存 `Transport`（`packages/common` の `UdpTransport` 等）を包む。
- `packages/webrtc` の ICE transport 差し替えは **しない**（Epic 2/3）。

### 2.7 テスト実装（Epic 1 の核）

codec / vector だけでは完了とみなさない。**接続可能なエンドポイント同士**で検証する。

#### A. 単体・vector（必須だが不十分）

- HKDF、transcript hash、traffic secret、Finished、binder
- encrypted record、sequence reconstruction、replay、ACK、KeyUpdate
- CID なし unified header、coalesced / fragment / invalid input の negative test
- DTLS-SRTP exporter の deterministic vector（RFC / 既知ベクトル）

#### B. werift-to-werift（direct datagram、必須）

独立 client/server プロセスまたは同等の endpoint 分離で（既存 `tests/e2e/self.test.ts` を 1.3 向けに拡張）:

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

#### C. BoringSSL interop（P0・必須）

- revision pin + CMake/Ninja 再現ビルド（`third_party` または CI スクリプト）
- 環境変数 override（例: `WERIFT_BORINGSSL_BSSL`）
- werift client × BoringSSL server、BoringSSL client × werift server
- 証明書付き full handshake、`TLS_AES_128_GCM_SHA256`、X25519、双方向 data
- 可能なら P-256 / mutual auth / KeyUpdate / exporter 比較
- 失敗時は alert / flight ログを残して fail（catch-and-ignore 禁止）
- 配置案: `packages/dtls/tests/e2e/boringssl/` + 近傍 README

#### D. OpenSSL DTLS 1.2 regression（必須維持）

既存 `tests/e2e/client.test.ts` / `server.test.ts` / `certificate_request/*` の `-dtls1_2` を維持・必要なら拡張:

- 1.2 only 両 role
- 1.3 preferred 設定が 1.2 peer に fallback
- 既存 DTLS-SRTP exporter 回帰（1.2 経路: `extractSessionKeys` / `EXTRACTOR-dtls_srtp`）

---

## 3. 技術的な実装アプローチ（調査結果サマリ）

### 3.1 推奨実装順序

Issue / `research-warp.txt` §3.3 を Epic 1 範囲に切り出すと次の順が安全（§2.8 と対応）。

1. **設定と共通 association 骨格** — 既存 1.2 を adapter 経由で動かす（挙動変更なし）。
2. **carrier / flight 不変化 / cancel timer / dynamic MTU** — 1.2 経路でも使える共通基盤を先に入れる。
3. **TLS 1.3 message/extension codec + transcript + HKDF** — deterministic vector test を先に通す。
4. **record protection** — `antiReplayWindow` を 1.3 受信 path に統合。
5. **client/server full handshake state machine + 1.2 fallback** — direct UDP で self interop。
6. **BoringSSL harness** と OpenSSL 1.2 regression 確認。

### 3.2 現行依存関係の再利用方針

| 再利用 | 新規・分離 |
| --- | --- |
| `@noble/curves` / `tweetnacl` による X25519・P-256（`prfPreMasterSecret` 等） | TLS 1.3 RSA-PSS CertificateVerify、TLS 1.3 SignatureScheme |
| 既存 `use_srtp` extension codec（`handshake/extensions/useSrtp.ts`） | DTLS 1.3 exporter（TLS 1.2 `exportKeyingMaterial` / `prfPHash` とは別） |
| `UdpTransport`（`packages/common`） | `DtlsHandshakeCarrier` direct 実装 |
| OpenSSL spawn E2E パターン（`tests/e2e/client|server.test.ts`） | BoringSSL spawn harness |
| `Event` ベース通知（`onConnect` / `onData` 等） | readiness の細分化は Epic 3 中心（Epic 1 は connected + data で可。内部 writeReady 等は実装都合で先置き可） |
| `@fidm/x509` / `@peculiar/x509` | Certificate / CertificateVerify の 1.3 署名検証パス |
| Node `crypto`（`createCipheriv` 等） | AES-128-GCM 自体は再利用可。nonce/AAD/key 導出は 1.3 用に分離 |

### 3.3 外部 interop の確定方針（Epic 1）

| peer | 役割 | Epic 1 |
| --- | --- | --- |
| **BoringSSL** | DTLS 1.3 外部参照 | **必須（P0）** |
| **werift self** | 回帰主軸 | **必須（P1 だが必須条件）** |
| **OpenSSL** | DTLS 1.2 regression | **必須維持**（1.3 interop 対象には含めない） |
| pion | SPED/ICE | Epic 2 以降 |
| libwebrtc / libsrtp2 / wolfSSL | — | 不要 / 対象外 |

### 3.4 ディレクトリ案（実装時の目安）

既存 tree を壊さず、例えば次のように分離する（名称は実装時調整可）。

```
packages/dtls/src/
  association/          # 共通 lifecycle / version select
  engine/v1_2/          # 既存 flight を adapter（段階的移動可）
  engine/v1_3/          # handshake SM, ACK, KeyUpdate
  cipher/tls13/         # HKDF, key schedule, AEAD-13
  record/v1_3/          # unified header, inner plaintext
  carrier/              # direct carrier (+ 将来 external)
```

既存パスを段階的に移動しても、**Public export（`index.ts` の `DtlsClient` / `DtlsServer`）互換**を優先する。内部移動時は `packages/webrtc` が `werift-dtls` の Public API のみに依存している前提を崩さない。

### 3.5 実装上の技術ポイント（調査から得た判断）

1. **1.2 と 1.3 の record parser を分岐する入口を早めに作る**  
   現行 `parsePacket` は length を offset 11 固定で読むため、unified header を混ぜると壊れる。受信の最初の分岐（version / content type / C bit）を共通 association 側に置く。

2. **key schedule は vector-first**  
   handshake SM より先に HKDF-Expand-Label（`dtls13` prefix）と Finished verify_data の RFC ベクトルを固定すると、後の interop 切り分けが楽。

3. **`flight2.ts` の type 43 stub はヒントに過ぎない**  
   ログのみでネゴシエーションしていない。1.3 エンジン側に正規の `supported_versions` 処理を置き、1.2 engine は現状維持でよい。

4. **exporter の 1.3 経路**  
   `socket.exportKeyingMaterial` / `extractSessionKeys` は 1.2 PRF 依存。1.3 接続時は TLS 1.3 exporter に切り替えるか、association 層で分岐する。WebRTC の SRTP 導出が後続 Epic で使うため、Public メソッドの意味を壊さない。

5. **BoringSSL は spawn E2E**  
   既存 OpenSSL と同様 child process。revision pin と `WERIFT_BORINGSSL_BSSL` を docs に固定。未導入ローカルは skip with reason、必須 CI では fail。

---

## 4. 考慮すべき制約や注意点

### Protocol / security

- 規範は RFC 9147 + RFC 8446 + verified errata。
- generic `werift-dtls` は cookie / anti-amplification を維持。address validation 前は server 送信量を受信量の **3 倍以内**に制限。HRR は cookie 省略時も動作。
- fragment / reassembly / ACK / retransmission / old epoch key に **件数・bytes・時間の上限**を設ける。
- cached flight `Buffer` は防御的 copy（呼び出し側による破壊を防ぐ）。TypeScript 上 Buffer は mutable である点に注意。
- epoch 1 は予約のみ。PSK / client 0-RTT を「実装した」と宣言しない。不要 extension は reject/decline。
- CID（C=1）は拒否。将来 RFC 9853 RRC は本 Epic 対象外。

### Compatibility

- **デフォルトは DTLS 1.2**。opt-in なしで挙動を変えない。
- `packages/webrtc` の `RTCDtlsTransport` が現状の `DtlsClient`/`DtlsServer` を使う前提を壊さない（Epic 1 完了後も 1.2 既定で WebRTC が動くこと）。Epic 1 で `packages/webrtc` を変更する必要はない。
- Public API 変更時は `packages/dtls/src/index.ts` と README を同時更新。
- DTLS protocol fallback（1.3→1.2）と、後続の SPED carrier fallback を混同しない。
- 既存 README の `onConnect =` 代入例は現行 `Event` API と不整合だが、本 Epic の主対象ではない（触るなら subscribe 形に直す程度に留める）。

### テスト規約（root `AGENTS.md`）

- Arrange / Act / Assert の三段階。
- 再利用 Arrange は package 内の単一 utility に集約（例: `tests/fixture.ts` や新規 `tests/helpers/*`）。
- Act / Assert に日本語コメントを適切な粒度で付ける。
- 失敗を catch-and-ignore しない。

### 検証コマンド（package 優先）

```bash
cd packages/dtls && npm run type && npm test
# 変更が common に及ぶ場合
npm run type && npm run test:small
```

| コマンド | 用途 |
| --- | --- |
| `cd packages/dtls && npm run type` | 型チェック |
| `cd packages/dtls && npm test` | unit + E2E（OpenSSL 依存ケース含む） |
| `cd packages/dtls && npm run ci` | type + test |
| BoringSSL harness | 必須 CI では未導入時 fail、ローカルでは skip with reason（Issue 方針） |

### スコープ漏れ防止

- Epic 1 で ICE/SPED/PeerConnection に手を広げすぎない。carrier interface の「骨格」までに留める。
- early server application data は **record/key が成立し self で送受信できること**を優先。WebRTC fingerprint ゲート付き配送は Epic 3。
- SNAP / ベンチマーク / wolfSSL / OpenSSL 1.3 interop は対象外。

### 実装時の未確定（小さく決めてよいこと）

| 項目 | 推奨デフォルト |
| --- | --- |
| `protocolVersions` 未指定時 | `[DtlsVersion.V1_2]` |
| version mismatch のエラー型 | 既存 `onError` に載せる `Error`（message に protocol version を明示）。必要なら専用 subclass |
| BoringSSL revision | 実装開始時に pin し docs に記載（floating HEAD 禁止） |

---

## 5. 完了条件

### 機能

- [ ] werift 同士が direct datagram 上で DTLS 1.3 full handshake（両 role）を完了し、双方向 protected application data を交換できる。
- [ ] BoringSSL と DTLS 1.3 両 role interop が成功する（pin 済み revision、再現ビルド、env override 文書化）。
- [ ] OpenSSL `-dtls1_2` 既存 E2E と DTLS 1.2 unit test が通る。
- [ ] `[1.3, 1.2]` が 1.2-only peer に fallback し、1.3-only × 1.2-only は version error で失敗する（timeout ではない）。
- [ ] KeyUpdate 後も epoch state を混線させず双方向 data が通る。
- [ ] デフォルト（opt-in なし）の DTLS 1.2 挙動が変わっていない（WebRTC 経路を含む回帰を壊さない）。
- [ ] 1.3 接続時も `EXTRACTOR-dtls_srtp` exporter が vector または self 比較で正しい（1.2 経路の既存 exporter も回帰なし）。

### 品質・テスト

- [ ] HKDF / transcript / secrets / Finished / exporter / record / replay / ACK / KeyUpdate の deterministic vector test がある。
- [ ] loss / reorder / duplicate / large cert / multi-record / HRR / mutual auth の self connection test がある。
- [ ] CID=1・truncated・oversized 等の negative test がある。
- [ ] handshake 失敗・version mismatch・timeout が actionable なログ付きで fail する。
- [ ] 新規テストが Arrange / Act / Assert と日本語コメント規約に従っている。

### アーキテクチャ

- [ ] DTLS 1.2 / 1.3 の mutable crypto state が共有されていない。
- [ ] 最小 `DtlsHandshakeCarrier`（または同等）が direct 経路で動作し、immutable flight bytes と cancel 可能 timer を持つ。
- [ ] draft 内部実装詳細が安定 Public API に露出していない。
- [ ] `DtlsClient` / `DtlsServer` の既存コンストラクタ互換が保たれている（追加 options は optional）。

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
- RFC 9147 verified errata: https://errata.rfc-editor.org/search/?rfc_number=9147
- 現行実装: `packages/dtls/src/{socket,client,server,flight,cipher,record,context}/*`
- 現行 E2E: `packages/dtls/tests/e2e/{self,client,server,certificate_request}/*`
- WebRTC 利用側（回帰の暗黙依存）: `packages/webrtc/src/transport/dtls.ts`
