# ICE: late TURN relay candidates are not paired with existing remote candidates

## 1. 目的と背景

### 概要

リモート ICE 候補が既に届いた**後**に TURN relay 候補の収集が終わると、その relay 候補は既存のリモート候補とペアにならない。そのため relay 経路は、その ICE セッション中に一度も connectivity check を受けない。

- 再現する流れ: TURN 収集の完了前にシグナリングを進める（例: 最初の host/srflx 候補だけで offer を送る）。相手の answer と候補が先に届き、ICE check が relay 候補なしで始まる。その後 TURN allocation が完了しても、relay ペアは作られない。
- 下流の報告: RelayMessenger/Relay-SDK#326 (https://github.com/RelayMessenger/Relay-SDK/pull/326)
  - werift 0.24.4 で、offer レイテンシを最適化する際に確認された。
  - 本番の Cloudflare TURN では、allocation の完了が SFU の answer 受信より後になることが多い。
- 影響: trickle / early-signaling で TURN が host/srflx より遅いと、有効な relay 経路があっても使われない。host/srflx が通らない NAT 環境（企業 NW、symmetric NAT など）では接続できなくなる。

### 調査で確認した現状（`packages/ice/src/ice.ts`）

| 箇所 | ローカル候補追加時に `pairLocalProtocol()` を呼ぶか |
| --- | --- |
| host UDP（`getCandidatePromises` 内 `localStunPromises`, L455-460 付近） | ✅ 呼ぶ |
| TCP active（L525-531 付近） | ✅ 呼ぶ |
| TCP passive（L503-504 付近） | ❌ 呼ばない（意図的。`tryPair` は passive に対して prflx 以外を除外する） |
| srflx（L555-558 付近） | ❌ 呼ばない（問題なし。srflx は host と同じ `StunProtocol` を base として共有し、ペアは protocol 単位で既に作られている） |
| **TURN relay（L614-637 付近）** | ❌ **呼ばない ← 本件のバグ** |

```ts
// TURN path（現状）
this.ensureProtocol(protocol);
this.protocols.push(protocol);
// ... relay Candidate を構築 ...
this.appendLocalCandidate(protocol.localCandidate);   // pairLocalProtocol がない
```

逆の順序（ローカルが先、リモートが後）は `addRemoteCandidate()` → `pairRemoteCandidate()` が全 `protocols` とペアを作るので問題ない。`connect()` の冒頭でも `remoteCandidates` × `protocols` でペアを作り直している（`findPair` で重複を排除）。そのため、**`connect()` 開始前**に TURN が完了したケースは現状でも救われる。漏れるのは「`connect()` 開始後に TURN が完了したケース」だけである。

### スケジューラ寿命の問題（ペアを作るだけでは不十分）

`connect()` は次の 2 段階で動く。

1. **スケジューリングループ**（L707-711）: `schedulingChecks()` が `false` を返すまで 20ms ごとに回る。
2. **完了待ちループ**（L714-718）: `while (checkList.length > 0 && res === ICE_FAILED) res = await checkListState.get()`

`schedulingChecks()`（L758-795）は WAITING/FROZEN のペアがなければ、`!this.remoteCandidatesEnd` のときだけ `!checkListDone` を返してループを続ける。つまり:

- **リモートの end-of-candidates を受信していない場合**: ループが回り続ける。TURN 経路で `pairLocalProtocol` さえ呼べば、late relay ペア（WAITING）は次の tick で拾われる。
- **リモートの end-of-candidates を受信済みの場合**: 次のどれかに当てはまると、既存ペアを開始し終えた時点でループが終わる。その後に追加された relay ペアは WAITING のまま**誰にも開始されない**。
  - SFU の answer が非 trickle で、候補を SDP にすべて含む
  - `a=end-of-candidates` が付いている
  - `addIceCandidate(null)` が呼ばれた
  - テスト用の `remoteCandidates` setter を使った（`remoteCandidatesEnd = true` になる）
- 完了待ちループは `ICE_FAILED` を受け取っても再度待つ（commit 308d4a93「ice candidate pair failure should not complete/fail the entire checklist」）。そのため、上のケースでは `connect()` は reject もせず**ハングする**。チケット原文の「ICE may fail before…」は、実際には「チェックされないまま待ち続ける」が正しい。
- `checkComplete()`（L1286-1310）は、全ペアが SUCCEEDED/FAILED になった時点で `ICE_FAILED` を put する。ローカル収集の途中かどうかは考慮していない。

`localCandidatesEnd` は `gatherCandidates()` の `Promise.allSettled(candidatePromises)` が終わった時点で `true` になる。TURN が失敗した場合も `true` になる。この値はスケジューラ継続の判定に使える。

### webrtc 層との関係

- `packages/webrtc/src/transport/ice.ts` の `RTCIceGatherer.gather()` は `connection.gatherCandidates()` を待ち、その後 `onIceCandidate(undefined)` を呼ぶ。
- `RTCIceTransport.start()` は `connection.connect()` を await する。`peerConnection.connect()` は収集の完了を待たずに `iceTransport.start()` を呼べるので、本件の競合はそのまま `RTCPeerConnection` 利用者にも起こる。
- 根本原因は `packages/ice` にあるので、修正は `packages/ice` で行う（`packages/webrtc/AGENTS.md` の方針どおり）。

## 2. 実装すべき変更

1. **TURN 経路でのペア形成**
   - `getCandidatePromises()` の TURN ブロックで、`protocol.localCandidate` を構築した後、`appendLocalCandidate()` の前に `this.pairLocalProtocol(protocol)` を呼ぶ（host / TCP active と同じ順序）。
   - 注意: 現状は `localCandidate` の構築前に `protocols.push` している。`tryPair` は `protocol.localCandidate?.canPairWith` に依存するので、`pairLocalProtocol` は `localCandidate` の代入後に呼ぶこと。
   - ペア追加後は `addPair()` 内で `sortCheckList()` が呼ばれる。
2. **ローカル収集中はスケジューラを止めない**
   - `schedulingChecks()` の「さらに候補が来る見込み」の判定に、ローカル側の収集中（`!this.localCandidatesEnd`）を加える。
   - 例: `if (!this.remoteCandidatesEnd || !this.localCandidatesEnd) return !this.checkListDone;`
   - これで `connect()` 実行中に追加された late relay ペアが、次の tick で `checkStart` される。
3. **収集中は check list を Failed にしない**
   - `checkComplete()` の `ICE_FAILED` put を、ローカル収集の完了後（加えてリモートの end-of-candidates の受信後）に限定するかを検討する。完了待ちループは現状 `ICE_FAILED` を無視するので挙動への影響は小さい。ただし `checkListState` に不要なエントリが溜まるのを避ける意味と、RFC 8838 (Trickle ICE) の check list state の考え方に合わせる意味がある。
   - 変える場合も、既存テスト（`ice.test.ts` の失敗系）の期待を壊さないこと。
4. **ノミネート後 / close 後の late candidate の扱い**
   - `this.nominated` が確定済み、または `checkListDone` の後に TURN が完了した場合は、WAITING ペアを追加しない。少なくとも開始しないこと（RFC 8445 §8.1.2 では、ノミネート後は Waiting/Frozen ペアを除去する）。
   - `state === "closed"` の後に TURN allocation が完了した場合の扱いは、既存の close/cleanup の挙動を壊さない範囲で確認する。ペアを追加しないのが望ましい。
5. **ICE restart**
   - `restart()` は `protocols`（TURN を含む）を残し、`localCandidatesEnd = false` にする。
   - restart 後の `gatherCandidates()` 再実行と `connect()` 冒頭の再ペア形成で、既存 TURN protocol が引き続き使われることを確認する（回帰がないこと）。

## 3. 技術的アプローチ（調査結果の要約）

- **最小修正**（必須）: TURN ブロックに `this.pairLocalProtocol(protocol)` を 1 行追加する。end-of-candidates をまだ受信していない trickle フローは、これだけで解消する。
- **完全修正**（必須）: `schedulingChecks()` の継続条件に `!this.localCandidatesEnd` を加える。これで end-of-candidates の受信後でも、ローカル収集が続く間はスケジューラが生き残る。
  - スケジューラは 20ms ポーリングなので、wake 用の新しいイベント機構は不要。
  - `gatherCandidates()` は TURN の失敗や timeout（`turnConnectTimeout`）でも必ず `localCandidatesEnd = true` に到達する。そのためループが永久に続くことはない。
- ペアの作成を共通化するため、「protocol を `protocols` に追加し、ペアを作り、候補を通知する」処理をヘルパーにまとめる（例: `registerLocalProtocol(protocol)`）。そうすれば今後の候補種別で同じ漏れが起きにくい。ただし、passive TCP がペアを作らない仕様は維持する（`tryPair` 側で除外されるので、共通化しても挙動は変わらない）。
- `forceTurn` の場合、`schedulingChecks` の WAITING 探索は `StunProtocol` のペアを除外する。late relay ペアは TURN protocol なので対象になる。これも確認する。
- iceLite は TURN を収集しない（`gatherIceLite`）。lite 側の待機ループ（`checkListState` 待ち）は本件の影響を受けない。

## 4. 制約・注意点

- **回帰防止**: relay 候補を `connect()` の前に収集し終えた既存ケース（`turn.test.ts` の relay-only 接続など）の挙動を変えないこと。`findPair` による重複排除を維持する。
- **ハングの防止**: スケジューラの継続条件を広げると、`localCandidatesEnd` が `true` にならない経路があった場合に `connect()` が抜けなくなる。`gatherCandidates()` を呼ばずに `connect()` した場合は、既存どおり例外を投げる（`localCandidatesStart` のチェック）。`close()` 時はループが `state === "closed"` で抜ける。この 2 点を確認する。
- **ノミネート済みセッションへの影響**: late relay ペアがノミネート後に追加されて check が走ると、不要なトラフィックや、`checkComplete` での誤った状態遷移を招く恐れがある。
- **TURN の UDP 失敗から TCP へのフォールバック**: フォールバックで作られた protocol も同じ経路でペアを作ること。
- **テスト規約（AGENTS.md）**: Arrange / Act / Assert の 3 フェーズで書き、Act / Assert には日本語コメントを付ける。Arrange 用ユーティリティは `packages/ice/tests/utils.ts` に集約する（`createTestConnection`, `createLocalTurnServer`, `TURN_TEST_USERNAME/PASSWORD` などの既存ヘルパーを再利用する）。
  - TURN 完了を遅らせる仕組みは、ローカル TURN サーバのレスポンス遅延、またはテスト用ヘルパーで決定的に制御する。タイミング依存で flaky にならないようにする。
- `packages/ice` には `AGENTS.md` がないので、ルートの `AGENTS.md` に従う。公開 API は変えないので docs の更新は原則不要。ただし挙動が変わるので、README の trickle 説明などに関連記述があれば確認する。

## 5. 回帰テスト案（`packages/ice/tests/ice/` に追加。例: `turn-late-candidate.test.ts`）

1. リモート候補を先に追加し、その後 TURN 候補を収集する → relay ペアが `checkList` に作られる。
2. `connect()` 実行中に TURN が完了する → relay ペアが実際に check され（`IN_PROGRESS` → `SUCCEEDED`）、接続が成立する。
3. リモートの end-of-candidates を受信済みで、host/srflx ペアがすべて失敗し、TURN はまだ収集中 → `connect()` はスケジューリングを続け、relay 経由で成功する（host 側ペアを失敗させるには、`filterCandidatePair` や到達不能なリモート候補を使う）。
4. relay 候補をリモート候補より先に収集する → 既存どおりペアが作られ、接続できる（重複ペアができない）。
5. end-of-candidates を受信しても、ローカル収集中はスケジューリングが止まらない。収集の完了後は従来どおりループが終わる（ハングしない）。
6. （任意）ノミネート後に TURN が完了しても、新しいペアが check されず `nominated` が変わらない。

## 6. 完了条件

- [ ] `getCandidatePromises()` の TURN 経路（UDP/TCP/TLS とフォールバックを含む）で、既存のリモート候補とのペアが作られる。
- [ ] `connect()` 実行中に追加された late relay ペアがスケジュールされ、connectivity check を受ける。
- [ ] リモートの end-of-candidates を受信済みでも、ローカル収集が終わるまでスケジューラ / check list が終了・失敗しない。収集の完了後は従来どおり終わる。
- [ ] ノミネート後や close 後の late candidate が、不要な check や状態遷移を起こさない。
- [ ] 上記の回帰テストを追加し、AAA 構成・日本語コメント・共通 Arrange ユーティリティの規約を守っている。
- [ ] `cd packages/ice && npm run type && npm test` が通る。
- [ ] ICE の挙動変更が webrtc に波及するので、`npm run type` と `npm run test:small` が通る。可能なら `npm run e2e` で trickle / TURN 系の回帰がないことを確認する。
