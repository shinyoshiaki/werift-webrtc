# Support multiple configured STUN/TURN URLs instead of silently using only the first

## 1. 目的と背景

### 問題
`RTCPeerConnection({ iceServers })` は W3C の `RTCIceServer[]` 形式（複数サーバー、1 サーバー内の複数 `urls`）を受け付けます。しかし werift は **最初の STUN URL と最初の TURN URL しか使わず**、残りは警告なしで捨てています。そのため、冗長化やフェイルオーバーのために設定した後続サーバーには一度も問い合わせが行きません。

- 下流の Alcove が、4 つのローカルカウンティング STUN/TURN エンドポイントで確認済みです（https://github.com/georgetown-mdi/alcove/pull/2255）。
  - Binding request を受けたのは 1 つ目の STUN だけでした。
  - Allocate を受けたのは 1 つ目の TURN だけでした。
  - 現在の Alcove 側は、この制約を前提に「1 つ目の TURN にだけ credential を登録する」運用をしています。
- 2026-10-17 時点の upstream develop で再現します。
- TURN `300 Try Alternate`（#715）とは別の問題です。こちらは**アプリケーションが明示的に設定した複数サーバー**を扱います。

### この問題が重要な理由
地域ごとの TURN 冗長化、プロバイダーのフェイルオーバー、UDP/TCP/TLS の併記、TURN サービスの移行、一時的なリレー障害への備えといった用途で、複数サーバーを指定するのは一般的です。werift では、後続のサーバーに到達できる状況でも接続に失敗することがあります。

### 根本原因（調査結果）
単数の server フィールドが、設定処理の全レイヤーに通っています。

| レイヤー | 箇所 | 現状 |
| --- | --- | --- |
| webrtc: パース | `packages/webrtc/src/utils.ts` `parseIceServers()` | `!options.stunServer && ...` / `!options.turnServer && ...` で最初の 1 件だけ採用。TURN の `username`/`credential`/`transport` も最初の 1 件分しか保持しない |
| webrtc: transport 解決 | `packages/webrtc/src/utils.ts` `resolveTurnTransport()` | URL の `?transport=` → `config.turnTransport` → `forceTurnTCP` の順で、**単一の** transport を決める |
| webrtc: 適用 | `packages/webrtc/src/secureTransportManager.ts` `resolveIceServerOptions()` / `updateIceServers()` / `createTransport()` | 単数フィールドを `RTCIceGatherer` と `setIceServers` / `deferIceServers` に渡す |
| ice: オプション型 | `packages/ice/src/iceBase.ts` `IceOptions` | `stunServer?`, `turnServer?`, `turnUsername?`, `turnPassword?`, `turnTransport?`（すべて単数） |
| ice: 公開 interface | `packages/ice/src/iceBase.ts` `IceConnection` | `stunServer?: Address; turnServer?: Address;` |
| ice: Connection | `packages/ice/src/ice.ts` `setIceServers()` / `applyStunTurnServersFromOptions()` | 単数フィールドの置換・検証と、`DEFAULT_STUN_SERVER` へのフォールバック |
| ice: gathering | `packages/ice/src/ice.ts` `getCandidatePromises()` | 各ソケットから STUN 1 件に `serverReflexiveCandidate()` を投げ、TURN の Allocate も 1 件だけ（`createStunOverTurnClient`、UDP 失敗時は TCP にフォールバック） |
| ice: 補助 | `gathersFromServers` getter、`reflexiveBySocket: WeakMap<Protocol, Candidate>`（ソケットごとに srflx 1 件） | 単数前提 |

## 2. 実装する機能・変更内容

### 2.1 ICE 層（`packages/ice`）
1. `IceOptions` に複数サーバー用のフィールドを追加します。
   ```ts
   export type TurnServerOptions = {
     address: Address;
     username: string;
     password: string;
     transport?: "udp" | "tcp" | "tls"; // 省略時 "udp"
   };
   stunServers?: Address[];
   turnServers?: TurnServerOptions[];
   ```
   - 既存の `stunServer` / `turnServer` / `turnUsername` / `turnPassword` / `turnTransport` は **後方互換のため残し、`@deprecated` を付けます**。正規化の時点で配列の先頭要素として扱います（`packages/dtls` の examples/tests、`packages/ice/examples/*`、`e2e/server/turn.ts`、`examples/turn-loopback` などが単数形で使っています）。
   - 単数形と複数形が同時に指定された場合のマージ規則（例: 複数形を優先し、単数形は配列の先頭に追加して重複は除去）を決め、JSDoc に書きます。
2. `Connection` / `IceConnection` に `stunServers: Address[]` / `turnServers: TurnServerOptions[]` を追加します。
   - 既存の `stunServer` / `turnServer` は、互換用に「先頭要素を返す getter」として残すか、廃止して利用箇所を移行します。どちらにするかを決めます（`IceConnection` は公開 interface なので、互換を残すのが無難です）。
   - `applyStunTurnServersFromOptions()` は、各要素を `validateAddress` で検証し、不正な要素は除外します。STUN が 0 件のときの `DEFAULT_STUN_SERVER` へのフォールバックは**現行仕様のまま**にします（`removeIceAgentServers` ハーネスのコメントもこの前提です）。
   - `setIceServers()` は、サーバー関連フィールドを**部分マージせず完全に置き換える**現行のセマンティクスを、配列フィールドにも適用します（古い TURN credential を残さないため）。
3. `getCandidatePromises()` を複数サーバーに対応させます。
   - **STUN**: IPv4 UDP の各 host ソケット × 各 STUN サーバーへ並列に Binding を送ります。結果の srflx のうち `(host, port)` が同じものは 1 件にまとめます（RFC 8445 §5.1.3 の冗長候補の除去）。異なるマッピングが返った場合（NAT が宛先ごとに別のマッピングを割り当てる場合）は、それぞれを候補として出します。
   - ICE restart 時の再利用ソケット経路（`reusedReflexivePromises`）も複数サーバーに対応させます。`reflexiveBySocket` は「ソケット → srflx 候補の集合」に変更します。restart 時の再広告（`gatherCandidates()` 内の `withGeneration(reflexive)`）も集合の全要素に対して行います。
   - **TURN**: `turnServers` の各要素について、**それぞれ独立した** allocation（ソケット）を並列に作ります。各要素の `username/password/transport` を使い、他のサーバーの credential を混ぜてはいけません。UDP 失敗時の TCP フォールバックは、サーバーごとに現行ロジックを維持します。
   - `gatherRelayOnly`（`forceTurn` かつ TURN 有効）の判定を、「credential を持つ TURN サーバーが 1 件以上あるか」に変えます。
   - どれか 1 つのサーバーが失敗・タイムアウトしても、他のサーバーの候補の生成は止めません（各 Promise を個別に `catch` する現行パターンを維持します）。
   - `stale()`（世代切り替えや close）の扱いは、サーバーごとの各 continuation で現行と同じにします。古い世代の allocation は確実に close します。
4. `gathersFromServers` を `stunServers.length > 0 || turnServers.length > 0` に変更します。
5. （任意）`getGlobalIp(stunServer?)` は単数のままで問題ありません。変更しない場合はスコープ外と明記します。

### 2.2 WebRTC 層（`packages/webrtc`）
1. `parseIceServers()` が以下の配列を返すようにします。
   - `stunServers: Address[]`: 全 `RTCIceServer` × 全 `urls` の `stun:` / `stuns:` URL（重複は除去）。
   - `turnServers: { address, username, password, transport }[]`: 全 `turn:` / `turns:` URL。**URL ごとに、その URL を含む `RTCIceServer` の `username` / `credential` を対応させます**。
   - 設定順を保持します（優先度や表示順の期待に合わせるため）。
2. `resolveTurnTransport()` を TURN の URL ごとに適用します（優先順位: URL の `?transport=` → `config.turnTransport` → `forceTurnTCP` → 未指定なら "udp"）。
3. `secureTransportManager.resolveIceServerOptions()` が配列フィールドを返すようにします。`createTransport()`、`updateIceServers()`（`setIceServers` / `deferIceServers`）、`RTCIceTransport.restart()` での `nextGatherIceServers` の適用は、配列のまま流れるようにします。
4. credential を持たない TURN URL の扱いを決めます。現状は gathering 時に何も言わずにスキップしています（`turnUsername && turnPassword` の判定）。最低でも debug ログを出します。W3C の `InvalidAccessError` を投げるかどうかは、互換性への影響が大きいので**別チケットとして扱うか**ここで判断します。

### 2.3 ドキュメントとテスト基盤
- `IceOptions` / `Connection` / `IceConnection` / `parseIceServers` の TypeDoc（`doc/`、`packages/ice/doc/`）を `npm run doc` で再生成します。
- 複数サーバーに対応したことと、単数形オプションの deprecation を README か CHANGELOG 相当の箇所に記載します。

## 3. 技術的アプローチ（調査結果のまとめ）

- **データの流れ**: `PeerConfig.iceServers` → `parseIceServers` → `resolveIceServerOptions` → `RTCIceGatherer`/`Connection` options → `Connection.applyStunTurnServersFromOptions` → `getCandidatePromises`。この全段で「単数 → 配列」に置き換えるのが中心です。
- **互換レイヤー**: ICE 層では `normalizeIceServerOptions(options)` のような関数を 1 か所に置き、単数形と複数形の両方から `{stunServers, turnServers}` を作ります。constructor と `setIceServers` の両方からこの関数を呼び、検証とデフォルトを揃えます（現在の `applyStunTurnServersFromOptions` と同じ考え方です）。
- **並列 gathering**: 既存の `candidatePromises` + `Promise.allSettled` + `closedSignal` の構造に、サーバー数分の Promise を足すだけで済みます。STUN 側は `stunGatherTimeout`、TURN 側は `turnConnectTimeout` とトランザクションのタイムアウトで上限が決まるため、到達できないサーバーがあっても gathering 完了（end-of-candidates）が無期限に止まることはありません。ただし完了は最も遅いサーバーを待つので、その旨を記載します。
- **STUN の同一ソケット並列リクエスト**: `StunProtocol.request` は transaction ID で応答を突き合わせるので、1 つのソケットから複数サーバーへ同時に送れます。
- **Foundation**: `candidateFoundation(type, transport, baseAddress)` はサーバーの IP を含みません。RFC 8445 §5.1.1.3 では、サーバー IP が違えば foundation も別にすべきとされています。srflx は base が同じなので、同じマッピングは除去で 1 件になり、異なるマッピングは foundation が同じになります（実害は frozen 制御の粒度が変わる程度）。relay は relayed IP を base にしているので、通常はサーバーごとに別の値になります。必要ならキーにサーバーアドレスを加えます（任意の改善）。
- **既存テストへの影響**: 以下は単数フィールドを直接 assert や代入をしているので、移行か互換 getter での維持が必要です。
  - `packages/webrtc/tests/utils.test.ts`（`parseIceServers` の戻り値）
  - `packages/webrtc/tests/transport/ice.test.ts`（`connection.turnServer`、`options.turnUsername` など）
  - `packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts` `removeIceAgentServers()`（`connection.stunServer = undefined` を代入。配列化した場合は空配列を代入する形に変更が必要）
  - `packages/ice/tests/ice/setIceServers.test.ts`、`restart-gather.test.ts`、`turn*.test.ts`、`consent-restart.test.ts`、`ice.test.ts`
- **テスト用ローカルサーバー**: `packages/ice/tests/utils.ts` の `createLocalStunServer(host)` / `createLocalTurnServer(host)`（`werift-ice-server` の `NodeStunServer` / `NodeTurnServer`、port 0）で、独立したエンドポイントを複数立てられます。リクエスト数のカウントは、これらをラップするか、既存の `createRecordingTransport` 系を流用して Arrange ユーティリティとして共通化します。TURN の credential は現在 `TURN_TEST_USERNAME` 固定なので、**サーバーごとに異なる credential を指定できる引数**を `createLocalTurnServer` に追加します。

## 4. 制約・注意点

- **後方互換**: `packages/ice` の `IceOptions` / `IceConnection` / `Connection` は公開 API です。単数形をいきなり削除せず、deprecate して配列へ正規化します。`packages/dtls` や examples の単数形の使用はそのまま動く必要があります。
- **setConfiguration と ICE restart のセマンティクスを維持**: gathering 前（`gatheringState === "new"`）なら即時に反映し、gathering 済みなら次の ICE restart で反映します（`deferIceServers` → `restart()`）。置き換えは完全置換で、TURN を削除したときは allocation と credential が残らないことを保証します。restart 時には既存の relay を close して新しく allocation します（`gatherCandidates()` 冒頭の処理）が、これを**全 TURN 分**行います。
- **リソースリーク**: TURN の allocation がサーバー数分に増えます。stale、close、restart のどの経路でも、すべての allocation と refresh タイマーを解放します。`packages/webrtc` の `npm run memleak`（ローカルのみ）で確認するのが望ましいです。
- **`iceTransportPolicy: "relay"`**: relay-only のときに、credential のある TURN が 1 件でもあれば host と srflx を出さない現行の挙動を維持します。
- **グローバルオプション**: `turnTlsOptions`、`turnUdpFamily`、`turnConnectTimeout`、`portRange`、`interfaceAddresses` は全 TURN サーバーに共通で適用します（サーバーごとに設定できる必要はありません）。
- **スコープ外**: TURN `300 Try Alternate`（#715）、`stuns:` の TLS 実装、`credentialType`、W3C の `iceServers` 入力検証の厳格化。厳格な WPT 用の挙動を加える場合は、ルートの AGENTS.md の規約どおり `packages/webrtc/tools/wpt-runner/*` に閉じ込めます。
- **テストの規約**: Arrange / Act / Assert の 3 フェーズで書きます。Arrange のユーティリティは共通ファイル（`packages/ice/tests/utils.ts` など）にまとめ、Act / Assert には日本語コメントを付けます。
- **WebRTC 側のマネージャーパターン**: サーバー解決は `SecureTransportManager` に集約したままにし、`RTCIceTransport` 側は options を受け渡すだけにします。

## 5. 完了条件

### 機能
- [ ] 複数の `RTCIceServer` と、1 サーバー内の複数 `urls` に含まれる**有効な STUN/TURN URL がすべて** gathering に参加する。
- [ ] TURN の各 URL に、その URL を含む `RTCIceServer` の `username` / `credential` が対応付けられ、別サーバーの credential が送られない。
- [ ] TURN の UDP/TCP/TLS の各バリアントを同時に設定しても、それぞれ設定どおりの transport で Allocate する。
- [ ] 1 つ目のサーバーに到達できなくても、到達できる後続サーバーから srflx / relay 候補が生成され、gathering が完了する。
- [ ] `setConfiguration()`（gathering 前と後）と ICE restart で、新しいサーバー一覧に完全に置き換わり、古い TURN の allocation と credential が残らない。
- [ ] 単数形の `IceOptions`（`stunServer` / `turnServer` / `turnUsername` / `turnPassword` / `turnTransport`）を使う既存コードが、そのまま動く。

### テスト（ローカルの独立したカウンティングエンドポイントを使用）
- [ ] `packages/ice`: 2 つの STUN サーバーの両方が Binding request を受ける。
- [ ] `packages/ice`: 2 つの TURN サーバーの両方が Allocate request を受け、relay 候補が 2 件できる。
- [ ] `packages/ice`: credential が異なる 2 つの TURN サーバーで、各サーバーが自分の credential で認証に成功する（取り違えると 401 になる構成で検証する）。
- [ ] `packages/ice`: 1 つ目が到達できないアドレス（閉じたポートなど）で 2 つ目が正常な場合に、2 つ目の候補が生成される。
- [ ] `packages/ice`: 同じマッピングを返す 2 つの STUN で、srflx 候補が重複しない。
- [ ] `packages/ice`: ICE restart / `setIceServers` で複数サーバーが置き換わり、古い allocation が close される。
- [ ] `packages/webrtc`: `parseIceServers` の unit test（複数 `RTCIceServer`、`urls` 配列、STUN と TURN の混在、transport クエリ、URL と credential の対応、重複除去）。
- [ ] `packages/webrtc`: 実際の `RTCPeerConnection` で複数の TURN/STUN を設定し、すべてのエンドポイントに問い合わせが届く結合テスト（`tests/transport/ice.test.ts` などに追加）。
- [ ] 既存テストを新しいフィールドへ移行する（ハーネスの `removeIceAgentServers` を含む）。
- [ ] Arrange は共通ユーティリティにまとまっており、Act / Assert に日本語コメントがある。

### 検証コマンド
- [ ] `cd packages/ice && npm run type && npm test`
- [ ] `cd packages/webrtc && npm test`
- [ ] ICE と webrtc の両パッケージと公開 API を変更するので、`npm run type` と `npm run test:small` を実行する。
- [ ] `npm run doc` で TypeDoc を更新し、`IceOptions` などの新しいフィールドと deprecation が反映されている。
- [ ] 可能なら `npm run e2e`（TURN を使う E2E: `e2e/server/turn.ts`）で回帰がないことを確認する。
