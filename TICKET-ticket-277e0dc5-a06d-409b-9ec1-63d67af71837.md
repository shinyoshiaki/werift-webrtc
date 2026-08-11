# werift DTLS 1.3 Epic 1 自律レビュー・修正指示

対象リポジトリ:

* `shinyoshiaki/werift-webrtc`

対象ブランチ:

* `ticket/5fc64332-b0d1-4ab0-bc1e-4b0f3a26c135`

基準ブランチ:

* `develop`

対象チケット:

* `TICKET-ticket-5fc64332-b0d1-4ab0-bc1e-4b0f3a26c135.md`

## 目的

対象ブランチのDTLS 1.3 / DTLS 1.2 fallback / dual association / carrier実装について、チケットの要件を基準に網羅的にレビューしてください。

既知のレビュー指摘を機械的に直すだけではなく、同じ原因から派生する未発見の問題を自律的に探索してください。

問題を発見した場合は、原因を特定し、再現テストを追加したうえで修正し、関連する回帰試験まで実行してください。

最終的に「指摘されたケースだけ通る特殊処理」ではなく、association lifecycle・version negotiation・carrier ownershipの状態機械として一貫した実装にしてください。

---

## 最重要方針

### 1. 既知の問題だけを修正して終了しない

特に以下のようなパターンを探索してください。

* ある状態では `engine13` が存在し、別の状態では `parkedEngine13` 等の別フィールドに退避されることで、public APIがactive associationを見失う
* UDP direct pathでは正常だが、`DtlsHandshakeCarrier.inject()` 経由ではassociation layerを迂回する
* `close()` / error / version commit / fallback時に一方のcandidateだけcleanupされ、timer、pending flight、carrier handler、transport handler等が残る
* dual negotiation中にDTLS 1.2と1.3の双方が同時に生存するにもかかわらず、booleanや単一engine参照だけで状態を管理している
* versionがcommitした後もlosing candidateのcallback、timer、carrier handler、event subscriptionが残る
* stale / spoofed unauthenticated packetが別candidateの状態を壊す
* packet loss、reorder、duplicate、late packetによって「通常順序なら発生しない」状態遷移が起きる
* public `send()`, `close()`, `isDtls13`, `extractSessionKeys()`, `remoteCertificate`, `keyUpdate()` 等が、内部association状態と食い違う
* direct UDPと将来SPED carrierで処理経路が異なり、同じpacketが異なるstate machineを通る
* errorをtimeoutに変えてしまう、または正常なversion transitionをpublic `onError`として漏らす
* hard closeとsoft version transitionのcleanup責務が混在している
* custom/injected carrierのownershipがold engine / new engine / associationの複数箇所に分散する

上記は例です。これらに限定せず探索してください。

---

# 現在特に疑わしい領域

現在の実装ではHVR受信後にDTLS 1.3 engineを破棄せずparkし、DTLS 1.2 cookie pathと並行して探索する方式になっています。

概念的には以下です。

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

この構造を前提に、associationがcandidateの所有権とlifecycleを正しく管理できているか確認してください。

## 既知の要注意点

### A. probing中の `close()`

HVR後には、

```ts
parkedEngine13 = engine
engine13 = undefined
dualPhase = "probing"
```

のような状態になります。

この状態でpublic `close()`が`engine13`だけを見ている場合、

* parked 1.3 engine
* pending CH-A flight
* retransmission timer
* epoch prune timer
* injected carrier
* carrier callback
* event subscription

等が残る可能性があります。

ただし、この具体例だけをpatchするのではなく、

**「associationが所有するすべてのcandidateを必ず一括teardownできる設計」**

になっているかを確認してください。

### B. carrier RX ownership

`DtlsHandshakeCarrier.inject()` がparked engineへ直接接続されたままだと、

```text
SPED/custom carrier
    |
    inject()
    |
parkedEngine13
```

となり、`DtlsClient`側のassociation version dispatcherを迂回する可能性があります。

その場合、

* `dualPhase` が `probing` のまま
* `engine13` が `undefined` のまま
* parked engineだけがconnectedになる
* public `onConnect`だけ発火する
* `isDtls13 === false`
* public `send()`がDTLS 1.2 pathへ入る

といった壊れた状態が成立し得ます。

direct UDPだけでなく、

```ts
carrier.inject(...)
```

を明示的に使ったテストを作って確認してください。

---

# 推奨する設計方針

局所的なif追加より、association layerを明確にしてください。

例えば以下のような責務分離を検討してください。

```ts
type AssociationPhase =
  | "initial"
  | "probing"
  | "committed12"
  | "committed13"
  | "closed";
```

associationが最低限以下を所有する形が望ましいです。

```text
Association
 ├─ phase
 ├─ DTLS 1.2 candidate
 ├─ DTLS 1.3 candidate
 ├─ carrier RX dispatcher
 ├─ transport RX dispatcher
 ├─ version commit
 ├─ candidate cancellation
 └─ close / fatal teardown
```

carrierやtransportから受信したpacketは、可能な限り同一のassociation dispatcherへ入り、

```text
transport.onData ----\
                      > association RX dispatcher
carrier.inject ------/
```

となるようにしてください。

その後associationが、

```text
1.3 candidateへ渡す
1.2 candidateへ渡す
versionをcommitする
unauthenticated packetをdropする
```

を判断する方が望ましいです。

engine自身がassociation-wideなversion decisionを行わないよう注意してください。

---

# 必須のstate invariant

実装後、最低限以下をコードとテストで保証してください。

## probing

```text
phase = probing
```

なら、

* DTLS 1.3 candidateが存在する
* original CH-A retransmissionが可能
* DTLS 1.2 candidateも進行可能
* publicにはまだversion確定を通知しない
* carrier / UDP両方の受信がassociation dispatcherを通る

## committed13

```text
phase = committed13
```

なら、

* active public engineはDTLS 1.3
* DTLS 1.2 candidateのflight/timerを停止
* `isDtls13 === true`
* `send()` / exporter / remoteCertificate / keyUpdateがactive 1.3 associationへ向く
* losing candidateのcallbackが後から状態を変更しない

## committed12

```text
phase = committed12
```

なら、

* parked DTLS 1.3 candidateを完全に停止
* CH-A retransmission timerを停止
* carrier RX handlerがdead engineを指さない
* 以後の1.2 fatal alert等を抑制しない

## closed

```text
phase = closed
```

なら、

* DTLS 1.2 / 1.3すべて停止
* retransmission timerゼロ
* epoch prune timer停止
* pending flightなし
* carrier handlerがdead associationを呼ばない
* transport RX handlerがdead associationを呼ばない
* close後に`onConnect` / `onError` / retransmitが発生しない

---

# 必須テスト

既存テストに加え、少なくとも以下を追加してください。

## 1. probing中のclose

```text
CH-A送信
↓
HVR
↓
dual probing
↓
client.close()
↓
RTO時間を進める
```

確認事項:

* parked engineがclosed
* pending flightなし
* custom carrierも適切にclosed
* CH-A追加送信なし
* `onError`なし
* `onConnect`なし

fake timerが安全に使えるならfake timerを優先してください。

---

## 2. carrier.inject経由の1.3 commit

UDP `onData`ではなく明示的に、

```ts
clientCarrier.inject(serverResponse, peer)
```

で genuine DTLS 1.3 HRR / ServerHelloを投入してください。

HVR後の`probing`状態から、

```text
carrier.inject
→ association dispatcher
→ commit13
```

となることを確認します。

接続後は必ず、

```ts
expect(client.isDtls13).toBe(true)
await client.send(...)
```

まで検証してください。

public APIから正常にDTLS 1.3 dataが送受信できることを確認してください。

---

## 3. carrier.inject経由の1.2 commit

同様にcustom carrier pathで、

```text
HVR
→ probing
→ legitimate DTLS1.2 ServerHello
→ commit12
```

を確認してください。

commit後、

* parked 1.3 candidate停止
* 1.3 retransmissionなし
* public `isDtls13 === false`
* 1.2 data送受信成功

まで確認してください。

---

## 4. late losing-candidate packet

### commit12後

遅れて届いたoriginal CH-A向け1.3 HRR/ServerHelloを投入し、

* 1.3へ戻らない
* `onConnect`二重発火なし
* stateを書き換えない

こと。

### commit13後

遅れて届いた1.2 ServerHello / alert / HVRを投入し、

* 1.2へ戻らない
* public errorを誤発火しない

こと。

---

## 5. closeとpacket arrivalのrace

```text
probing
close()
直後に
carrier.inject(...)
```

および、

```text
probing
carrier.inject(...)
と
close()
がほぼ同時
```

を試験してください。

最終stateが必ずclosedになることを保証してください。

---

# alert処理

dual probing中のunauthenticated DTLS 1.2 HVR / DTLS 1.3 rejectionについては、必要最小限だけ抑制してください。

以下のような実装は禁止です。

```ts
if (probing && fatalAlert) {
  return;
}
```

本物のDTLS 1.2 peerによる、

* `handshake_failure`
* `protocol_version`
* `bad_certificate`
* その他actionable fatal alert

をtimeoutへ変換してはいけません。

ただし、alert単体では「どのcandidateへの応答か」を完全には識別できない可能性があります。その場合は、alert descriptionだけのad-hoc判定を増やすより、candidate state / packet provenance / commit stateの設計を見直してください。

---

# version API

Public APIとしてサポートする設定は、

```ts
[V1_2]
[V1_3]
[V1_3, V1_2]
```

としてください。

入力された、

```ts
[V1_2, V1_3]
```

をサポートする場合は `[V1_3,V1_2]` へ正規化する現在の方針を維持してください。

DOWNGRD protectionを弱めて1.2-first dualを成立させないでください。

---

# regression確認

最低限以下を壊していないことを確認してください。

* default options → DTLS 1.2
* 1.3-only ↔ 1.3-only
* dual ↔ dual → 1.3
* dual client ↔ 1.2-only server → 1.2 fallback
* 1.3-only ↔ 1.2-only → timeoutではなくprotocol version error
* X25519
* P-256
* HRR
* client certificate
* KeyUpdate
* exporter / `EXTRACTOR-dtls_srtp`
* large certificate
* loss
* reorder
* duplicate
* anti-replay
* ACK
* custom carrier
* external retransmission mode
* OpenSSL DTLS 1.2 regression
* BoringSSL DTLS 1.3 interop

---

# BoringSSL / OpenSSL

Epic 1の完了条件として、

* werift ↔ werift
* werift client ↔ BoringSSL server
* BoringSSL client ↔ werift server
* OpenSSL DTLS 1.2 regression

を必ず確認してください。

BoringSSL interopをskipして「成功」と扱わないでください。

revision pinを使って再現可能な形で実行してください。

---

# CI / 実行

まずpackage単位で高速に回してください。

```bash
cd packages/dtls
npm run type
npm test
```

修正中は関連testを絞ってよいですが、最後はDTLS package全体を実行してください。

その後リポジトリrootから必要なCIを実行してください。

```bash
npm run ci
```

BoringSSL interop harnessも別途必ず実行してください。

失敗した場合は、

```text
原因調査
→ 修正
→ 同じ試験を再実行
```

を成功するまで繰り返してください。

既存テストのtimeoutを伸ばすだけ、assertを弱めるだけ、skip追加で通すことは禁止します。

---

# レビュー方法

コードを読んで終わりにしないでください。

以下の順で進めてください。

1. チケットの完了条件を整理する
2. `develop...対象branch` の差分全体を見る
3. DTLS association stateを状態遷移図として整理する
4. 各stateで誰が以下を所有するか表にする

   * transport RX
   * carrier RX
   * retransmit timer
   * pending flight
   * crypto state
   * public API
5. lifecycle invariantを列挙する
6. packet loss / reorder / duplicate / stale packetを各state transitionへ注入する
7. custom carrier経路でも同じ試験をする
8. 問題を再現するtestを先に追加する
9. 根本原因を修正する
10. regression testを実行する
11. BoringSSL/OpenSSL interopを実行する
12. 全CIを実行する

---

# コード品質

以下を避けてください。

* `as any` を利用したstate machineの穴埋め
* private fieldを大量にテストから直接操作する設計
* boolean flagの増殖
* alert descriptionごとの場当たり的例外追加
* `engine13` / `parkedEngine13` / legacy engine間でcleanup処理をコピペ
* transport handler / carrier handlerを書き換える場所の分散
* version commit処理の複数箇所への重複
* losing candidateからのlate callbackを無視するだけの対処

可能なら、

```ts
commitVersion(...)
disposeCandidate(...)
closeAssociation(...)
dispatchInboundDatagram(...)
```

のようなassociation-level operationへ集約してください。

---

# 最終報告

作業終了時に以下を報告してください。

## 発見した問題

重要度順に、

* P0
* P1
* P2
* P3

で列挙してください。

既知の指摘以外に自律的に発見したものを明確に区別してください。

## 各問題について

* 発生条件
* root cause
* なぜ既存テストでは検出されなかったか
* 修正方針
* 追加したテスト
* regression影響

を説明してください。

## テスト結果

実行したコマンドと結果を明記してください。

少なくとも、

```text
packages/dtls type
packages/dtls test
OpenSSL DTLS1.2
BoringSSL DTLS1.3 client/server
root npm run ci
```

について結果を書いてください。

実行できなかった項目がある場合は、成功したと推測せず明記してください。

## 最終判定

チケットの各完了条件に対して、

```text
PASS
FAIL
未確認
```

を表にしてください。

すべてのP0/P1問題と、今回のassociation lifecycle / carrier ownershipに関係するP2問題が解消されるまで作業を終了しないでください。
