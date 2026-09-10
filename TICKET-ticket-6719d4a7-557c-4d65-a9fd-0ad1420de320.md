# Full × Lite の SPED handshake timeout を仕様準拠の direct/hybrid 搬送で解消する

- 親チケット: `71cc0e0d-e203-4057-816d-a89b993faf26`（Epic 4: WARP-enabled WebRTC transport）
- 調査 HEAD: `f1f847bee37ba1af85795708332471865fe9fb9a`
- 主対象: `packages/ice`、`packages/webrtc`（DTLS engine の変更は必要な場合だけ）
- 対象外: TURN relay 上の WARP/SPED

## 1. タスクの目的と背景

### 目的

`sped: true` の実 `RTCPeerConnection` を ICE Full × ICE Lite で接続したとき、ICE は `connected` なのに DTLS が `connecting` のまま 30 秒で timeout する経路をなくし、DTLS role の両向きで DataChannel の双方向通信を確実に成立させる。

単に timeout を延長したり ICE-Lite に Binding Request を送らせたりせず、RFC 8445、SPED draft-00、RFC 9147 の liveness と送信規則に沿って carrier の切替条件を修正する。

### 調査結果

対象テストは `packages/webrtc/tests/integrate/sped.test.ts` の次のケースである。

```ts
test("Full × Lite で SPED handshake と双方向 app data", ...)
```

今回の調査環境では、同テストの単独実行 20 回はすべて成功し、同ファイル全 44 テストも成功した。一方で HEAD 上の 30 秒 timeout が別実行で確認されているため、常時再現する機能欠落ではなく、DTLS flight 生成と最後の通常 ICE Binding の順序に依存する race と扱う。修正前に barrier を使った決定的な再現テストを追加し、反復成功だけを修正根拠にしない。

現在の実装は次の性質を持つ。

- `RTCDtlsTransport.startWithSped()` は `DirectHandshakeCarrier` の wire 送信を止め、retransmission mode を `external` にする。
- `SpedSession` の L1 は `onFlightCreated` で更新され、`Connection.flushSpedCarry()` が L1 搬送専用の追加 Binding Request を生成する。
- `packages/ice/docs/sped-draft00.md` は「nomination 後も handshake 完了まで埋め込みを継続し、DTLS timer は再開しない」という独自プロファイルを明記している。
- ICE-Lite は Request を生成しないため、最後の通常 Binding Response が作られた後に Lite 側または peer 側の新 flight が L1 に入ると、次の自然な SPED 搬送機会がない。
- この状態では raw DTLS も抑止され、DTLS RTO も停止している。追加 carry Request が race、loss、generation 変更等で機会を失うと、ICE だけが connected になり DTLS は永久に connecting のままになる。

代表的な停止パターンは次のとおり。

```text
Full が Binding Request を送信
  -> Lite が Binding Response を返す
  -> Full/Lite のどちらかで次 DTLS flight を生成
  -> 通常 ICE check / nomination は終了済み
  -> Lite は RFC 上 Request を生成しない
  -> carrier は wireSendEnabled=false、DTLS RTO は external のまま
  -> L1 に flight が残り、DTLS connecting のまま停止
```

### 仕様から採用する方針

| 仕様 | 本タスクで守る事項 |
| --- | --- |
| [RFC 8445 §2.5, §6.1.1, §7](https://www.rfc-editor.org/rfc/rfc8445.html#section-6.1.1) | Full × Lite では Full が controlling、Lite が controlled。Lite は STUN server として応答するだけで connectivity check を生成しない。 |
| [RFC 8445 §7.3.2, §8.2](https://www.rfc-editor.org/rfc/rfc8445.html#section-7.3.2) | Lite は `USE-CANDIDATE` を受理して pair を nominated/selected にする。 |
| [RFC 8445 §12.1](https://www.rfc-editor.org/rfc/rfc8445.html#section-12.1) | Full は valid pair 上で direct data を送信できる。Lite は valid list が揃う前に direct data を送信しない。 |
| [draft-hancke-webrtc-sped-00 §3.3.1, §4.4](https://datatracker.ietf.org/doc/html/draft-hancke-webrtc-sped-00#section-4.4) | valid ICE pair と direct send が利用可能になった後は、DTLS を通常の pair 上で送信してよい。SPED は最適化であり、接続成立を追加 Binding に依存させない。 |
| [draft-hancke-webrtc-sped-00 §5.4, §5.7, §6](https://datatracker.ietf.org/doc/html/draft-hancke-webrtc-sped-00#section-6) | 最初の Binding Response 後に通常 DTLS 送信/RTOを再開する。自然に送られる Binding には SPED を併用できるが、DTLS 搬送だけを目的とする packet を増やさない。 |
| [RFC 9147 §5.8, §7](https://www.rfc-editor.org/rfc/rfc9147.html#section-5.8) | direct 移行後は DTLS の flight timer と ACK による通常の loss recovery を有効にする。重複した同一 record は replay として安全に処理する。 |

本タスクでは、最初から SPED を捨てるのではなく、次の **hybrid policy** を採用する。

1. direct-send 条件成立前は、現状どおり handshake datagram を L1 に保持し、raw DTLS と内部 RTO を止める。
2. Full は current generation の authenticated かつ source-symmetric な最初の Binding Response により valid pair が得られた時点で、その pair への raw DTLS と内部 RTO を有効にする。
3. Lite は `USE-CANDIDATE` を認証・受理し valid/selected pair が得られた時点で、その pair への raw DTLS と内部 RTO を有効にする。Lite が Binding Request を生成することはない。
4. SPED session は handshake 完了まで active のままとし、ICE が通常の理由で送る Binding Request/Response には L1/L2 を引き続き載せる。ただし L1 を運ぶためだけの追加 Binding は生成しない。
5. non-SPED peer の `fallback` と、SPED 対応 peer で direct DTLS を併用する本 transition は別状態として扱う。

## 2. 実装すべき具体的な機能や変更内容

### 2.1 current generation の direct-handshake readiness を追加する

`packages/ice/src/sped/runtime.ts` に、SPED peer 対応判定や fallback とは独立した、generation 単位で一度だけ成立する direct-handshake readiness を追加する。名称は既存パターンに合わせてよいが、概念上は次に相当する。

```ts
interface SpedDirectHandshakeReadiness {
  generation: number;
  pair: CandidatePair;
  ready: boolean;
}
```

- 同一 generation / association pair に対して冪等にする。
- `peerSupport === "supported"` のまま direct を許可できるようにし、`fallbackStarted` や `session.state = "fallback"` を流用しない。
- stale generation、非 association pair、relay pair、未認証 pair からは遷移させない。
- hook を介して WebRTC 側の `IceSpedTransport` と DTLS carrier に通知する。SPED internals を public barrel へ export しない。

### 2.2 Full 側は安全な最初の Binding Response で direct を有効化する

`packages/ice/src/ice.ts` の `checkStart()` で successful response を処理する順序を明確にする。

```text
transaction ID / MESSAGE-INTEGRITY 検証済み Response
  -> current generation と checklist ownership を確認
  -> response source と pair.remoteAddr の symmetry を確認
  -> responsesReceived / valid pair 情報を更新
  -> SPED direct-handshake readiness を通知
  -> SPED ACK/DATA を処理して DTLS へ await inject
  -> nomination / pair state を更新
```

- RFC 8445 §7.2.5.2.1 の source symmetry 確認より前に、direct permission の付与や SPED DATA の inject をしない。
- direct readiness は DATA の有無に依存させない。DATA が無ければ既存の non-SPED fallback が同じ authenticated pair 上で進む。
- readiness 通知を DATA inject より前に行い、Response 内の server flight を処理して生成された次 flight が、その場で direct 送信可能になるようにする。

### 2.3 Lite 側は nomination 受理後だけ direct を有効化する

`Connection.checkIncoming()` の ICE-Lite 分岐で、認証済み `USE-CANDIDATE` を受理して pair を `SUCCEEDED` / nominated にした後、同じ current-generation pair を direct-handshake ready とする。

- `USE-CANDIDATE` のない最初の check を受けただけでは Lite の direct 送信を許可しない。
- Lite の `requestsSent` および wire 上の Binding Request は常に 0 のままとする。
- nomination 前に DTLS flight が生成済みなら L1/pending flight に保持し、nomination 後の通常 DTLS timer または次の正規送信で回収する。

### 2.4 `IceSpedTransport` を埋め込み専用から hybrid carrier にする

`packages/webrtc/src/transport/sped.ts` と `packages/webrtc/src/transport/dtls.ts` を次の状態に分ける。

```text
probing / no valid pair
  handshake: SPED L1 only
  wire send: disabled
  DTLS RTO: external

direct-handshake ready
  handshake: authenticated pair へ raw DTLS を送信
  natural ICE Binding: SPED L1/L2 も付加
  DTLS RTO: internal

DTLS authenticated/complete
  application/media: 既存の fingerprint・early-data・consent gate に従う
```

- `DirectHandshakeCarrier.setWireSendEnabled(true)` だけでは、現状の `IceSpedTransport.sendInternal()` が `session.embedding` 中の送信を捨てるため不十分。handshake control record に限って direct-ready pair へ送れる明示状態/APIを追加する。
- direct-ready pair は通知時に固定し、別 candidate や address-only の推測へ勝手に切り替えない。
- raw DTLS handshake と application/SRTP/SRTCP permission を分離する。direct readiness は `allowEarlyServerData` を暗黙に有効化せず、fingerprint gate も迂回しない。
- direct 移行時に carrier を `internal` に戻し、既存 pending flight の retransmission timer を再 arm する。必要なら pending flight を同じ serialized bytes で即時送信できる package-private helper を設けるが、flight を再生成・再 serialize しない。
- SPED 経由と direct 経由で同一 DTLS record が重複しても、DTLS 1.3 record replay/ACK 処理に委ね、二重 handshake event や二重 readiness を発火しない。

### 2.5 L1 専用の追加 Binding Request を廃止する

`packages/ice/src/ice.ts` から次の synthetic carry 制御を削除する。

- `spedCarryInFlight`
- `spedCarryQueued`
- `spedSolicitPeerCarry`
- `maybeFlushSpedCarry()`
- `flushSpedCarry()`
- `selectSpedCarryPair()`

併せて `packages/ice/src/internal/sped-bind.ts` / `internal/sped.ts` の `registerSpedCarryMaybeFlush()`、`requestSpedCarryMaybeFlush()` と呼び出しを削除する。`onFlightCreated` は L1 の置換だけを行い、ICE transaction を新規生成しない。

通常の connectivity check、nomination、triggered check、consent check が送信される場合の `decorateOutgoing()` は維持する。SPED active 中の「送信する Binding には DATA を付ける」という draft §4.2 と、「SPED のためだけに packet を増やさない」を両立させる。

### 2.6 lifecycle・fallback・diagnostics を分離する

- handshake 中の ICE restart では direct-handshake readiness と固定 pair を破棄し、新 generation を `wire disabled + external RTO` から開始する。
- old generation の遅延 Response、timer、inject、direct-ready callback は新 generation の carrier を有効化しない。
- DTLS 接続済み association の ICE restart は既存 Epic 4 方針どおり association を再作成せず、新 selected pair へ rebind する。
- close / abort / fingerprint mismatch / fatal DTLS error では direct permission と timer を破棄する。
- non-SPED / DTLS 1.2 への direct fallback は `warpSpedState: "fallback"` のまま維持する。
- SPED 対応 peer との hybrid/direct path は `warpSpedState: "active"` とし、実際に handshake の wire carrier が direct へ移った後は `warpCarrier: "direct"` とする。handshake 完了時に誤って `"sped"` へ戻さない。

### 2.7 回帰テストを deterministic にする

Arrange helper は `packages/webrtc/tests/integrate/sped.test.ts` 内の既存共通 helper 群、または package 内の単一共通 utility に置く。Act / Assert には既存ルールどおり日本語コメントを付ける。

追加・更新するテスト:

1. `packages/ice/tests/sped/restart.test.ts` 等で、L1 更新だけでは新規 `protocol.request()` が呼ばれないことを確認する。現在 synthetic carry を期待する 2 ケースは新 policy に置き換える。
2. Full は source-symmetric な最初の authenticated Binding Response の後だけ direct-ready になることを確認する。stale generation、異なる source、unauthenticated response、relay は拒否する。
3. Lite は `USE-CANDIDATE` 前に direct send せず、受理後にだけ ready になること、および Binding Request を 1 件も生成しないことを確認する。
4. 実 `RTCPeerConnection` の Full × Lite を、`setup:passive`（Full=DTLS client）と `setup:active`（Lite=DTLS client）の両方で実行する。
5. barrier で「最後の通常 Binding の組み立て後に次の DTLS flight が生成される」順序を強制し、追加 Binding なしで DTLS connected、DataChannel open、text/binary の双方向 ordering が成立することを確認する。
6. direct に切り替わった最初の client Finished または final ACK を 1 回 drop し、RFC 9147 の内部 RTO/ACK により timeout 前に回復することを確認する。
7. wire spy で、direct-ready 前の raw DTLS は 0、ready 後は raw DTLS が存在し、SPED のためだけの非 nomination Binding Request が増えていないことを確認する。
8. 既存の「handshake 全体を生 DTLS に出さない」assertion は、「valid pair 前は出さない／ready 後は direct を許す」という phase-aware assertion に更新する。large flight、TCP、multi-candidate の期待値も同様に見直す。

## 3. 技術的な実装アプローチ

### 推奨する変更順

1. `SpedRuntime` に generation/pair-bound な direct readiness と hook を追加し、ICE 単体テストで遷移条件を固定する。
2. `checkStart()` の successful Response 処理を source symmetry 検証後に並べ替え、Full の readiness を SPED inject 前に通知する。
3. ICE-Lite の nomination 受理箇所から readiness を通知する。
4. `IceSpedTransport` に handshake-only direct path を追加し、carrier の wire/RTO を同じ transition で切り替える。
5. synthetic carry の state、WeakMap callback、追加 transaction と、それを前提にしたテストを削除する。
6. 実 PC の両 DTLS role、loss、restart、diagnostics を検証し、package documentation を更新する。

### 主な変更ファイル

| ファイル | 変更の中心 |
| --- | --- |
| `packages/ice/src/ice.ts` | Response の安全な処理順、Lite nomination hook、synthetic carry 削除 |
| `packages/ice/src/sped/runtime.ts` | generation/pair-bound direct readiness、fallback と独立した diagnostics |
| `packages/ice/src/sped/draft00/session.ts` | 必要なら active のまま direct 併用を表す内部状態。ただし wire state を L1/L2 state と混同しない |
| `packages/ice/src/internal/sped.ts` | WebRTC carrier への package-private hook、`onFlightCreated` の副作用縮小 |
| `packages/ice/src/internal/sped-bind.ts` | carry 起動用 WeakMap API の削除 |
| `packages/webrtc/src/transport/sped.ts` | authenticated pair に限定した handshake-only direct send |
| `packages/webrtc/src/transport/dtls.ts` | carrier wire/RTO transition、restart/abort、diagnostics |
| `packages/ice/tests/sped/*` | direct readiness と「追加 Binding なし」の単体テスト |
| `packages/webrtc/tests/integrate/sped.test.ts` | Full/Lite 両 DTLS role、決定的 race、loss、双方向 app data |
| `packages/ice/docs/sped-draft00.md` | 旧「handshake 完了まで external」「extra L1 carry」方針を hybrid policy に更新 |

DTLS engine は、既存の `external -> internal` で pending flight timer を再 arm する処理をまず再利用する。即時 pending-flight send 等が不可欠と判明した場合だけ `packages/dtls/src/engine/v1_3` を変更し、同ディレクトリの一段継承制約を守る。

## 4. 考慮すべき制約や注意点

### Protocol / security

- ICE-Lite に Binding Request を生成させない。Full/Lite の role を DTLS role、offerer/answerer と混同しない。
- Response source symmetry、MESSAGE-INTEGRITY、transaction、current generation を確認する前に SPED DATA を inject したり direct carrier を開いたりしない。
- direct-ready は handshake control record の permission であり、DataChannel/RTP/RTCP の pre-auth permission ではない。SDP fingerprint 前の上位配送ゼロを維持する。
- `Connection.send()` の consent/selected-pair 規則は変更しない。handshake 専用 internal send path だけを拡張する。
- L1/L2 と RFC 9147 の record ACK/pending flight は別物のままにする。direct 移行時に DTLS pending state を作り直さない。
- Full の valid pair 前、Lite の valid list/nomination 前、generation restart 後の再認証前には raw DTLS を出さない。
- `fallback` は「peer が SPED 非対応または DTLS 1.2 direct を選択」として維持し、SPED 対応 peer の hybrid transition を fallback と記録しない。

### Compatibility / scope

- `sped: false` の ICE -> DTLS 直列経路、DTLS 1.2、通常 TURN relay、Chromium/OpenSSL interop を回帰させない。
- TURN relay 上の SPED/WARP は本タスクで実装しない。relay pair を direct-readiness の新条件へ混ぜない。
- `PeerConfig.sped` 以外の public opt-in を追加せず、`IceOptions.sped`、SPED codepoint、L1/L2、carrier internals を public API にしない。
- synthetic carry の削除後も、通常 ICE pacing・nomination・consent message の SPED decoration は維持する。
- reported timeout がこの調査実行では再現しなかったため、テスト時間の延長、単なる反復成功、任意 sleep を修正完了の根拠にしない。
- test code は Arrange / Act / Assert の三相、再利用可能な Arrange helper の集約、Act / Assert の日本語コメントというリポジトリ規約に従う。

## 5. 完了条件

### 機能・仕様

- [ ] Full × Lite の Full は controlling、Lite は controlled のままで、Lite が Binding Request を 1 件も送らない。
- [ ] Full は current-generation・authenticated・source-symmetric な最初の successful Binding Response 後にだけ handshake direct send と DTLS RTO を有効化する。
- [ ] Lite は認証済み `USE-CANDIDATE` の受理前には direct send せず、valid/selected pair 確立後にだけ有効化する。
- [ ] L1 の生成や SPED DATA の受信を理由とする synthetic Binding Request が存在しない。
- [ ] 自然に送信される Binding Request/Response は、handshake 中であれば引き続き draft-00 の DATA/ACK 規則で decorate される。
- [ ] direct transition 後は pending DTLS flight が RFC 9147 の timer/ACK で回復し、1 packet loss で無期限停止しない。
- [ ] `setup:passive` と `setup:active` の双方で Full × Lite の DTLS 1.3 handshake、DataChannel open、text/binary・複数 message の双方向 ordering が成立する。
- [ ] direct-ready 前は raw DTLS handshake が 0、ready 後は authenticated pair 上だけに raw DTLS が送られる。
- [ ] `warpSpedState` は supported peer で `active`、`warpCarrier` は direct 移行後 `direct`、non-SPED fallback は `fallback/direct` を示す。
- [ ] handshake 中の ICE restart で旧 generation の readiness、pair、timer、inject が無効化され、新 generation で再接続できる。
- [ ] fingerprint mismatch/close/abort 後に handshake direct permission、application/media permission、timer が残らない。

### 回帰テスト

- [ ] barrier で問題の順序を強制するテストが修正前コードで失敗し、修正後コードで 30 秒 timeout なしに成功する。
- [ ] direct client Finished または final ACK を 1 回 drop するテストが内部 DTLS retransmission を観測して成功する。
- [ ] Full × Full、Lite × Full、large/fragmented flight、TCP ICE、multi-candidate、duplicate/reorder、non-SPED fallback、DTLS 1.2 fallback、ICE restart の既存 SPED テストが成功する。
- [ ] `sped: false` の通常 DataChannel と TURN relay の既存テストが成功する。

### 検証コマンド

```bash
cd packages/ice && npm run type && npm test
cd packages/webrtc && npm run type && npm test
cd packages/dtls && npm run type && npm test
npm run type
npm run test:small
npm run doc:check
```

flake 確認として、対象の deterministic integration test を同一 process または shell loop で最低 20 回実行し、全回成功することも確認する。実装が `packages/dtls/src/engine/v1_3` に及ぶ場合は、可能なら `cd packages/dtls && npm run test:boringssl:docker` も実行する。
