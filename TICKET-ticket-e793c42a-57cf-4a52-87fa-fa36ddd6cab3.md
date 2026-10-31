# ICE restart: setConfiguration(iceServers) should use updated TURN credentials

## 1. 目的と背景

### 目的

ICE gathering の開始後または完了後に `setConfiguration({ iceServers })` で STUN/TURN サーバを差し替えたとき、次の ICE generation（ICE restart 後の gathering）で**新しいサーバ設定と認証情報**が確実に使われるようにする。あわせて、JSEP（RFC 9429 §4.1.18）に従い、gathering 開始後に iceServers を変更した時点で "needs-ice-restart" ビットを立てる。

### 背景・本番影響

- Alcove/PsiLink（https://github.com/georgetown-mdi/alcove/pull/1678）は有効期限 1 時間の TURN credential を使っている。
- werift は ICE transport 生成時に TURN server/credential を固定し、ICE restart 後もその固定された credential で再 gathering する。
- そのため downstream では 30 分ごとに新しい credential を発行し、`RTCPeerConnection` を丸ごと作り直す回避策を取っている。この作り直しのために、追加のシグナリング ID とオーバーラップ期間が必要になっている。

### 現状の挙動（コード調査結果）

| 箇所 | 挙動 |
| --- | --- |
| `packages/webrtc/src/peerConnection.ts` `setConfiguration()`（概ね L505-520） | `iceServers` / `turnUdpFamily` の変更時に `secureManager.updateIceServers()` を呼ぶだけ。`needRestart` は立てない。 |
| `packages/webrtc/src/secureTransportManager.ts` `updateIceServers()`（L129-） | `gatheringState === "new"` の transport にだけ `setIceServers()` を適用する。gathering 済みの transport はスキップする。 |
| `peerConnection.ts` `restartIce()`（L1150） | `needRestart = true` と `needNegotiation()` だけを実行する。 |
| `peerConnection.ts` `createOffer()`（L526-530） | `iceRestart \|\| needRestart` のとき `secureManager.restartIce()` を呼ぶ。 |
| `secureTransportManager.ts` `restartIce()`（L419-） | 各 `RTCIceTransport.restart()` を呼ぶだけ。**現在の PeerConfig の iceServers を再適用しない**。 |
| `packages/webrtc/src/transport/ice.ts` `RTCIceTransport.setRemoteParams()`（L197-217） | リモートの ufrag/pwd 変更（相手側起点の restart）を検知すると `this.restart()` を直接呼ぶ。SecureTransportManager を経由しないため、この経路でも新しい設定が再適用されない。 |
| `packages/ice/src/ice.ts` `Connection.restart()`（L172-） | `this.protocols` を保持したまま generation/ufrag を更新する（コメント「protocolsはincomingのearlyCheckに使うかもしれないので残す」）。 |
| `ice.ts` `gatherCandidates()`（L239-） | 保持中の**全 protocol（TURN の relay も含む）の `localCandidate`** を新しい generation として再広告する。 |
| `ice.ts` `getCandidatePromises()`（L399-） | host は `protocol.localIp` が重複するアドレスを除外する。TURN は重複チェックが無く、restart のたびに**新しい allocation を追加する**。 |

このため、公開 API の次のフローでは**古い credential A のまま**再 gathering される。

```ts
pc.setConfiguration({ iceServers: freshServers });
pc.restartIce();
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
```

仮に credential を正しく差し替えられたとしても、`gatherCandidates()` が旧 TURN protocol の relay candidate（credential A の allocation）を新しい generation に再広告してしまう。

既存テスト `packages/webrtc/tests/transport/ice.test.ts` の扱い:

- 「gathering 完了後の setConfiguration は live Connection を更新しない」は、`needRestart === false` を**明示的に期待**している。仕様変更に合わせて修正が必要。
- 「ICE restart 後 gatheringState が new なら setConfiguration が反映される」は、内部 API `secureManager.restartIce()` を先に呼んでから `setConfiguration()` する順序でしか検証していない。

## 2. 実装すべき機能・変更内容

1. **gathering 開始後の iceServers 変更で restart-needed ビットを立てる（JSEP §4.1.18）**
   - `setConfiguration()` で `iceServers`（と、サーバ設定に影響する `turnUdpFamily` / `iceTransportPolicy` など）が**実際に変わった**場合で、かつ gathering が開始済み／完了済みの transport が 1 つでもあれば `needRestart = true` にする。
   - 変更前後の正規化済み iceServers を比較し、同じ値の再設定（例: `setConfiguration(pc.getConfiguration())`）では restart を発生させない。
2. **restart された transport へ、gathering 前に最新設定を再適用する**
   - 公開 `restartIce()` → `createOffer()`、`createOffer({ iceRestart: true })`、`setConfiguration()` による自動 restart、相手側起点の restart（`setRemoteParams` 経由）のすべての経路で、新しい generation の gathering 開始前に `resolveIceServerOptions()`（と `forceTurn` / `useTcp` / `turnUdpFamily`）を Connection に反映する。
3. **旧 TURN protocol と relay candidate を新しい generation に持ち込まない**
   - TURN 設定（server / username / password / transport）が変わった場合は、旧設定で確立した TURN protocol の relay candidate を新しい generation で再広告しない。
   - 不要になった旧 allocation は close（deallocate）してリークを防ぐ。
   - TURN を削除した場合（STUN のみへの置換）は、新しい generation に relay candidate を一切出さない。
4. **WHIP の既存挙動を維持する**
   - 初回 gathering 前（`gatheringState === "new"`）の `setConfiguration()` は、従来どおり既存 gatherer に stage するだけにし、`needRestart` は立てない。
5. **ドキュメント更新**
   - `setConfiguration()` / `restartIce()` の JSDoc（`npm run doc` で `doc/classes/RTCPeerConnection.md` に反映）に、TURN credential ローテーションの手順と自動 restart の挙動を追記する。
   - `updateIceServers()` のコメントにある RFC 8829 の参照を RFC 9429 に更新する。

## 3. 技術的な実装アプローチ（調査結果のまとめ）

### 3.1 restart-needed ビット（`packages/webrtc/src/peerConnection.ts`）

- `setConfiguration()` の `deepMerge` より前に、変更前の `parseIceServers(this.config.iceServers)` 相当（または正規化済み `iceServers` の deep-equal 比較用スナップショット）を保持しておく。
- `deepMerge` の後に、変化の有無と `secureManager.iceTransports.some(t => t.gatheringState !== "new")` を評価する。
  - gathering 済みの transport がある場合 → `this.needRestart = true`。
  - `"new"` の transport → 従来どおり `updateIceServers()` で stage する。
- `negotiationneeded` を発火するかどうかは要判断（§4 参照）。最低限 `needRestart` を立てれば、次の `createOffer()` で restart が行われる。

### 3.2 restart 時の再適用

案 A（推奨・最小）: **gathering 直前に再適用する**

- `SecureTransportManager.gatherCandidates()`（L549-）で、`gatheringState === "new"` の各 transport に対して gather 前に `updateIceServers()` 相当（`resolveIceServerOptions()` + `forceTurn` / `useTcp` / `turnUdpFamily`）を適用する。
- `createOffer` 経由・`setRemoteParams` 経由のどちらの restart 経路も最終的にここを通る。WHIP（createOffer → setConfiguration → setLocalDescription）もそのまま動く。
- ただし `RTCIceTransport.gather()` を直接呼ぶ経路（テストなど）は対象外になる。

案 B: **restart 時に再適用する**

- `SecureTransportManager.restartIce()` で `transport.restart()` の直後に `updateIceServers()` を呼ぶ。
- 相手側起点の restart にも対応するため、`RTCIceTransport` に restart 通知用の `Event`（例: `onRestart`）を追加し、`createTransport()` 内で購読して再適用する。
- 既存の manager 型オーケストレーションと custom `Event` パターンに沿う。

どちらの案でも、`updateIceServers()` の options に `turnTlsOptions` を含めるかどうかを `createTransport()` と揃えて確認すること。

### 3.3 旧 TURN protocol の扱い（`packages/ice/src/ice.ts`）

- `Connection.setIceServers()` で TURN の識別子（server / username / password / transport）が変わったことを記録する。または `StunOverTurnProtocol` 側に生成時の TURN 設定を保持させる（`protocol.type === "turn"` で判別できる。`packages/ice/src/turn/protocol.ts` L68 / L165）。
- `gatherCandidates()` の再広告ループで、現在の TURN 設定と一致しない TURN protocol は再広告しない。対象の protocol は `this.protocols` から除去して `close()` する（`TurnProtocol.close()` は refresh timer を止めて transport を閉じる。L709）。
- 参考: 現状は TURN 設定が変わっていなくても、restart のたびに「旧 relay の再広告 + 新しい allocation の追加」が起きている。同じ設定のときは旧 allocation を再利用して新規 allocation を省くか、旧 allocation を閉じるかを決めること（本チケットのスコープ内で、少なくとも重複・リークを悪化させないこと）。
- 旧 TURN protocol を close するタイミング:
  - `Connection.restart()` は `nominated` をクリアするので、restart 開始時点で旧ペアはすでに送信に使われない。
  - 「restart が始まるまでは既存経路を使える」を満たすため、close は `restart()` 時点ではなく、新しい generation の `gatherCandidates()` 開始時以降に行う。

### 3.4 テスト

- `packages/ice/tests/utils.ts` の `createLocalTurnServer()` を拡張し、`credentials`（複数ユーザー）や、認証に使われた username を記録する `getPassword` を Arrange オプションとして受け取れるようにする（`NodeTurnServer` は `getPassword` を受け付ける。`packages/ice-server/src/node/turnServer.ts` L100-104）。
- Arrange 処理（TURN サーバ構築、PC 構築から gathering 完了まで）は `packages/webrtc/tests/utils.ts` などの共通ユーティリティに切り出す。
- Act / Assert には日本語コメントを付ける。

## 4. 制約・注意点

- **公開 API の挙動変更**: gathering 後の `setConfiguration({ iceServers })` が、次の `createOffer()` で自動的に ICE restart を引き起こすようになる。既存テスト「gathering 完了後の setConfiguration は live Connection を更新しない」の `needRestart === false` の期待を、仕様に合わせて変更する。live Connection を即時に書き換えない点は維持する。
- **answerer 側**: `needRestart` は `createOffer()` でしか消費されない。answerer が `setConfiguration()` だけを呼んだ場合、新しい設定が使われるのは、相手が restart offer を送ってきたとき（`setRemoteParams` 経由）になる。ここでも 3.2 の再適用が必要になる。
- **negotiationneeded**: JSEP は needs-ice-restart ビットを立てることだけを規定している。`setConfiguration()` から `negotiationneeded` を発火するかどうかは Chrome などのブラウザ挙動を確認して決め、実装コメントに根拠を残す。WPT（`packages/webrtc/tools/wpt-runner/list.ts`）には現状 setConfiguration / restartIce の関連エントリは無いが、追加する場合も、厳密な挙動は `tools/wpt-runner` の wrapper 内にとどめる。
- **既存経路の維持**: restart が始まるまで（`createOffer()` 内で restart が実行されるまで）は、既存の nominated pair と TURN allocation を壊さないこと。`setConfiguration()` の時点では live Connection に触れない。
- **BUNDLE / 複数 transport**: `iceTransports` は stopped でない transceiver と SCTP の transport を対象にする。全 transport で一貫して restart と再適用が行われること。
- **srflx の既知の制約**: restart 後は host protocol を再利用するため、`getCandidatePromises()` のアドレスフィルタで STUN 問い合わせが行われず、**新しい srflx candidate が出ない**（L413-419 と `localStunPromises` の依存関係による）。STUN のみへの置換テストで「新しい STUN サーバから srflx が出る」ことまで検証する場合は、この制約への対応が必要になる。スコープに含めるか、別チケットに切り出すかを判断すること（最低限、旧 TURN の relay が出ないことと、Connection の stunServer が更新されていることは検証する）。
- **パッケージ境界**: TURN protocol の世代管理は `packages/ice` で、restart の配線は `packages/webrtc` で行う（根本原因のあるパッケージで修正する）。
- `iceCandidatePoolSize > 0` は未サポートのため考慮しない。
- 広範な catch-and-ignore は追加しない。TURN close の失敗はログに出す程度にとどめる。

## 5. 完了条件

- [ ] 公開 API のフロー `setConfiguration({ iceServers: [TURN B] })` → `restartIce()` → `createOffer()` → `setLocalDescription()` で、新しい TURN allocation が **credential B で認証される**（ローカル TURN サーバ側で認証に使われた username が B であることを確認する）。
- [ ] `restartIce()` を呼ばずに、gathering 完了後の `setConfiguration({ iceServers })` → `createOffer()` だけでも ICE restart が行われる（ufrag/pwd が変わる）。restart は 1 回だけで、credential B が使われる。
- [ ] gathering 完了後に iceServers が実際に変わった場合は `needRestart === true`。同一の iceServers を再設定した場合は `needRestart === false`。
- [ ] restart 後の新しい generation の local candidates に、旧 credential A の allocation に由来する relay candidate が含まれない。旧 TURN protocol は close される。
- [ ] TURN A → STUN のみへの置換: 新しい generation に relay candidate が出ず、Connection の TURN server/credential がクリアされる。
- [ ] TURN 削除・TURN → TURN（server 変更）のケースもテストでカバーする。
- [ ] 相手側起点の ICE restart（リモート offer の ufrag 変更）でも、answerer の gathering に最新の iceServers が使われる。
- [ ] WHIP フロー（createOffer → setConfiguration → setLocalDescription）が従来どおり動き、`needRestart` が立たない（既存テストが green）。
- [ ] 既存テスト `packages/webrtc/tests/transport/ice.test.ts` の「gathering 完了後」テストを新仕様（live Connection は不変、`needRestart === true`）に更新する。
- [ ] テストは Arrange / Act / Assert の 3 フェーズで書き、Arrange は共通ユーティリティに切り出し、Act / Assert に日本語コメントを付ける。
- [ ] `setConfiguration()` / `restartIce()` の JSDoc を更新し、`npm run doc` で docs を再生成する。
- [ ] 検証: `cd packages/ice && npm run type && npm test`、`cd packages/webrtc && npm run type && npm test`、cross-package 変更として `npm run type` と `npm run test:small` を実行する。

## 6. 追加要件（レビュー 7 回目の P1 と再発防止）

### 6.1 背景

- 7 回目のレビューで P1 が指摘された。`iceTransportPolicy` を `all` → `relay` に変えて restart すると、restart offer の SDP と commit 後の trickle に host / srflx 候補が漏れる（`Connection.options.forceTurn` は `true` まで届いている）。
- 原因は 2 か所。
  - webrtc `RTCIceTransport.stageLocalRestart()` が live な候補を全部コピーしている。
  - ice `Connection.gatherCandidates()` の再広告ループが、保持中の protocol を無条件に再広告している。
- `iceUseTcp: true → false` にも同じ穴がある。
- 構造的な原因: restart を起こす条件を「STUN/TURN 関連の全設定」に広げた。一方で、restart 経路が新しい設定の意味を守っているかは検証していなかった。テストも `needRestart` と `Connection.options` しか見ていなかった。

### 6.2 実装要件

1. **判定を 1 か所にまとめる**（`packages/ice`）
   - 「新規 gathering で出る候補か」の判定を共通関数にする。新規 gathering の `gatherRelayOnly` / `useTcp` と同じ条件で判定する。
   - TURN が無いときの relay ポリシーは、従来どおり host にフォールバックする。
2. **ice 層**: restart 後の generation では、新しい設定で除外される保持 socket（host UDP / TCP）を close して外す。除外した socket は再広告も、ペアの作成も、着信チェックの受け付けもしない。
3. **webrtc 層**: restart offer / answer の候補は、その generation が gather に使う設定（defer された ICE server を適用した options）で絞り込む。relay ポリシーに変えた場合は、offer の候補は 0 件で、commit 後に relay だけを trickle する。
4. **provisional checks**: staged generation の gather options で除外される socket は、provisional checklist にも使わない。
5. **commit 前の設定変更**: restart offer の作成後、commit 前に `setConfiguration()` で設定が変わった場合は、既存仕様 `[2.6-T3b]`（`negotiationTransactionCoverageIce.test.ts`）どおり、その restart の commit 時の gathering に最新設定を反映する。offer が announce 済みで、新しい設定では除外される host 候補は、commit 時に socket を close するため、チェックに失敗するだけになる。
   - 当初は「offer 作成時の設定で固定し、変更は次の restart に回す」案で実装した。しかし `[2.6-T3b]` と矛盾したため、この案は採らなかった。
6. **`iceUseTcp: false → true`** の restart で、UDP socket を保持しているアドレスにも TCP host 候補を gather する。
7. ICE server の merge 規則（server 系は undefined も含めて置換し、`forceTurn` / `useTcp` は指定されたときだけ変える）は、ice の共通関数を `Connection.setIceServers()` と webrtc で共有する。
8. relay-only 時の check スケジューリングも同じ判定（`isRelayOnlyGathering`）を使う。

### 6.3 テスト要件（設定 × 出力マトリクス）

- 共通の Arrange ユーティリティを使って、表形式のテストを作る。
- 行（変更の種類）:
  - TURN A→B
  - TURN→STUN のみ、STUN→TURN
  - `iceTransportPolicy` の all→relay、relay→all
  - `iceUseTcp` の true↔false
  - `turnTransport` の udp→tcp
  - `turnTlsOptions` / `turnUdpFamily` の設定と解除
  - 同じ値の再設定
- 列（確認する出力）:
  - `needRestart` と、実際に restart したか
  - restart offer の SDP に載る候補の種類
  - commit 後に trickle される候補の種類
  - 新しい generation の候補の種類
  - `Connection.options`
  - TURN の認証 username
  - 旧 allocation が close されたか
- ice 層の単体テストも作る。
  - 判定関数
  - 除外 socket の close とペアへの不参加
  - provisional checks での除外
  - TCP の再 gather
- 「restart offer 作成後、answer 前の `setConfiguration()`」のテストも作る。
- 差分に `/code-review high` をかける。観点は「`setConfiguration` が起こす restart のすべてで、新しい設定の意味が守られているか」で、指摘を修正する。

### 6.4 検証要件

- `npm ci` で依存を lockfile（TypeScript 6.0.3 / Biome 2.6.2）に揃えてから検証する。
- 次の検証を実行して結果を記録する。
  - `cd packages/ice && npm run type && npm test`
  - `cd packages/webrtc && npm run type && npm test`
  - ルートで `npm run type && npm run test:small`
- 公開 API の追加（`isCandidateAllowedByGatherOptions` / `isRelayOnlyGathering` / `mergeIceServerOptions`）は `npm run doc` で docs に反映する。
- 修正は 1 つのコミットにまとめる。

### 6.5 追加の完了条件

- [ ] all→relay の restart で、restart offer の候補が 0 件、commit 後の trickle と新しい generation が relay のみになり、保持していた host socket が close される。
- [ ] `iceUseTcp` true→false で TCP host 候補が出ず、TCP socket が close される。false→true で TCP host 候補が出る。
- [ ] 設定 × 出力マトリクスの全行が green。修正前のコードでは all→relay と `iceUseTcp` の 2 行（計 3 行）が失敗することを確認する。
- [ ] offer 適用後・answer 前の relay 化は、その restart の commit 時の gathering に反映される（relay のみになり、host socket は close される）。既存の `[2.6-T3b]` も green のまま。
- [ ] 6.4 の検証がすべて通る。
