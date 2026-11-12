# [JSEP] remote offerがaddTransceiver作成の未関連付けtransceiverを誤再利用する問題を修正する（#816）

## 元報告・判定
元Issue: #816（sidorares, "setRemoteDescription(offer) pairs an m-section with a transceiver that addTransceiver made"）。**妥当（developのコード上で確認）**。glare/perfect negotiationへの影響あり。今回、独立テスト未実施。

報告の再現手順（werift 0.26.0 / Node 24）:

```js
const a = new RTCPeerConnection({ iceServers: [] }), b = new RTCPeerConnection({ iceServers: [] });
a.addTransceiver("audio");
await a.setLocalDescription(await a.createOffer());
const own = b.addTransceiver("audio", { direction: "sendrecv" });
await b.setRemoteDescription(a.localDescription);
console.log(b.getTransceivers().length, own.mid); // 実際: 1 "0" / 期待: 2 null
```

報告で失敗しているWPT（Chrome / Firefox / Safari は pass）:
- `webrtc/RTCPeerConnection-perfect-negotiation.https.html`、`-stress-glare.https.html`、`-stress-glare-linear.https.html`（"have direction expected sendonly but got sendrecv"）
- `webrtc/RTCRtpTransceiver.https.html` の `checkAddTransceiverNoTrackDoesntPair` / `checkAddTransceiverWithTrackDoesntPair` / `checkAddTransceiverThenReplaceTrackDoesntPair`

## 1. 目的と背景

- RFC 8829（JSEP）§5.10 では、remote offerのm-sectionが既存のどのtransceiverとも関連付けられていない（MIDが一致しない）とき、関連付けてよいのは **`addTrack` が作成し、まだ関連付けられておらず、停止していない同じkindのtransceiver** だけ。`addTransceiver` で作ったtransceiverは、トラックの有無に関係なく関連付けない。候補がなければremote offer用のtransceiverを新しく作る。
- werift の `findTransceiver()` は、MIDが一致しないとき **同じkindで未関連付けのtransceiverならどれでも** 割り当てる（`unassociated.find((t) => t.mLineIndex === index) ?? unassociated[0]`）。そのため、アプリが `addTransceiver` で指定した方向とMIDが相手のofferで上書きされる。
- perfect negotiationのglareでは、両側の `addTransceiver` が相手のofferに取られ、`sendonly` を指定したtransceiverが `sendrecv` になる。

## 2. 実装すべき変更内容

### 2.1 transceiverの生成元を記録する
- `RTCRtpTransceiver` に内部フィールドを追加し、生成時に記録する。例: `/** @internal */ createdBy: "addTrack" | "addTransceiver" | "remote"`、またはJSEPの用語に合わせた `createdByAddTrack: boolean`。
  - `TransceiverManager.addTrack()`（`packages/webrtc/src/transceiverManager.ts:511`）が **新しく作る** 経路（`this.addTransceiver(track, …)`, L580付近）→ `addTrack`
  - `TransceiverManager.addTransceiver()`（L435）の通常経路 → `addTransceiver`
  - `RemoteMediaApplication.associate()` から `remoteMLineIndex` 付きで作る経路（`remoteMediaApplication.ts:193`）→ `remote`
- `addTrack()` が既存transceiverを再利用する経路（`emptyTrackSenderTransceiver` / `notSendTransceiver`）では生成元を **変えない**。`addTransceiver("audio",{direction:"recvonly"})` の後に `addTrack` した場合はペアリング対象外で、Chromeの `created_by_addtrack` と同じ扱い。
- 判定にはトラックの現在値（`sender.track`、`heldByApplication`）もMIDも使わない。`replaceTrack()` でトラックを付けても生成元は変わらない（`checkAddTransceiverThenReplaceTrackDoesntPair`）。
- 生成元はアプリの操作で決まる属性なので、`snapshotNegotiationState()` / `restoreNegotiationState()` には含めない。含めるとrollbackで巻き戻ってしまう。下の例外を除く。

### 2.2 `findTransceiver()` の候補を絞る
対象は `packages/webrtc/src/negotiation/remoteMediaApplication.ts:243`。
- MID一致（`byMid`）の探索と `port === 0` の早期returnはそのまま残す。
- `transceiverPairing === "jsep"`（既定）のとき、MIDが一致しないときの `unassociated` の条件に `createdBy === "addTrack"`（相当）を追加する。`"legacy"` のときは現在の条件のまま（2.5）。`mid == null && !stopping && !stopped` は維持する。`mLineIndex === index` を優先する順序も維持してよい（同じ生成元の中でだけ優先する）。
- 候補がなければ既存処理（`displaced` 判定 → `addTransceiver(..., { remoteMLineIndex: i })`）で新しいtransceiverを作る。これでローカルの `addTransceiver` 側は `mid === null` のまま残る。
- `releaseUnassociatedReservations()`（`transceiverManager.ts:419`）は、関連付けなかった `addTransceiver` 起源のtransceiverの予約位置を解除する既存処理なので、そのまま使えるはず。解除後、次のlocal offerで末尾に追加されることを確認する。

### 2.3 rollbackで残ったtransceiverの扱い
- remote offerで作られ、アプリが `addTrack` でトラックを付けた（`heldByApplication`）transceiverは、rollback後も残る（`transceiverManager.ts:203`）。W3C / JSEP §4.1.8.2では、このtransceiverはMIDを外して残し、次のofferで再び関連付けできるようにする。ChromeはrollbackのときにこのtransceiverをAddTrack起源へ昇格させる（`reused_for_addtrack` → `created_by_addtrack`）。
- 方針: remote起源のtransceiverが `addTrack()` で再利用されたことを記録し（例: `reusedForAddTrack`）、rollbackで残すときに生成元を `addTrack` に変える。perfect negotiationでpolite側がrollbackした後も、相手のre-offerと再び関連付けられる。
- 一方、アプリが交渉中に追加した `addTransceiver` 起源のtransceiverは、rollbackでMIDとm-lineを失う（`transceiverManager.ts` の該当ループ）。その後のremote offerでは生成元が `addTransceiver` なので関連付けない。これが #816 のglareの本体。

### 2.4 `planCodecs` と `apply` の対応付けを一致させる（重要）
- `peerConnection.ts:1644` の `planCodecs(remoteSdp)` は **暗黙のrollbackより前** に実行され、`apply()`（L1721付近）は暗黙のrollback / `negotiation.begin()` の **後** に実行される。
- glare（`have-local-offer` 中にSRD(offer)）では、rollback前のローカル `addTransceiver` transceiverは、自分のpending offerで付いたMID（例 `"0"`）を持っている。相手のofferも同じMID `"0"` を使うと、plan側では `byMid` が一致してローカルtransceiverのcodec / preference / source trackでcodecを解決してしまう。apply側はrollback後に `mid == null` になり、新しいremote transceiverを作る。結果としてcodecPlanとtransceiverが一致しない。
- 対策案（推奨）: 対応付けを純関数 `matchRemoteMedia(remoteSdp, view)` に切り出し、`planCodecs` と `associate` で共有する。`view` は「暗黙のrollback後に見える状態」を返すものにする。暗黙のrollbackが起きる場合は、transceiverのMID / mLineIndexとして、negotiation snapshotのbaseline値か `createdNegotiationState` の値を使う。交渉中に追加したtransceiverなら `mid = null` になる。
- 代替案: 暗黙のrollbackが起きるケースだけ、rollback後に `planCodecs` をやり直す。ただしrollback前にcodec非互換などを検証して拒否する既存の設計（コメント "Resolve codec compatibility before implicit rollback"）が崩れるので、採用するなら理由を記録する。
- どちらの案でも、1つのoffer内で同じtransceiverを複数のm-lineに割り当てない（既存の `associated` Setを維持する）。

### 2.5 既定動作と互換性（決定済み）

**決定: 案A（既定をJSEP準拠にする破壊的変更）を採用する。** 公開PeerConfigオプション `transceiverPairing: "jsep" | "legacy"` を追加し、既定を `"jsep"` にする。現行の挙動は `"legacy"` でopt-inする。changelogでは ⚠️ Breaking changes として扱う。

#### 決定理由
1. **WPT専用の厳密化ではない。** ルート `AGENTS.md` Do 5 の対象は「upstream WPTだけの厳密な挙動」。この不具合は、ブラウザとの実際のperfect negotiation / glareで、アプリが指定した方向（`sendonly`）を `sendrecv` に変えてしまう相互接続の誤り。Do 11（仕様・互換性から正しい側を決める）に従い、仕様の側に揃える。Chrome / Firefox / Safari はすべてJSEPどおりの挙動。
2. **案B（既定はlegacyのまま、JSEPはopt-in）では既定の経路に不具合が残る。** W3Cが推奨するperfect negotiationパターンを既定設定で使うと、方向が黙って壊れたままになる。チケットの完了条件（ローカルの `addTransceiver` の方向とMIDが上書きされない）も、opt-inでは既定の状態で満たせない。
3. **`werift/polyfill` と整合する。** polyfillはweriftをブラウザ互換の `RTCPeerConnection` グローバルとして入れる（#816の報告者もこの使い方）。ブラウザ向けに書かれたコードが期待するのはJSEPの挙動なので、既定が `"legacy"` だとpolyfill利用者が壊れる。
4. **リポジトリに前例がある。** v0.25.0 の `mLineReuse` は、既定を仕様・相互接続に正しい `"compatible"` に変え、旧挙動を `"aggressive"` でopt-inにしたBreaking changeだった（`changelog.md` v0.25.0）。構築時に固定する、値を検証する、`setConfiguration()` で変更できない、という仕組みも同じものを使える。`keyFrameRequestRouting` は既定を `"compatible"` に保ったが、これは既定でも相互接続を壊さない拡張で、本件とは性質が違う。
5. **移行が簡単。** 1行の `transceiverPairing: "legacy"`、`addTrack()` への置き換え、またはremote側で作られたtransceiverを使う、のいずれかで移行できる（下記）。

案Bを採らない理由: 破壊的変更を避けられるが、上の 2・3 の不具合が既定に残る。WPTラッパーだけ `"jsep"` にすると、WPTの結果が既定の挙動を表さなくなる。

#### オプション仕様
- 名前: `transceiverPairing`。remote offerのm-sectionをローカルのtransceiverとどう関連付けるかを表す。
- 型: `export type TransceiverPairing = "jsep" | "legacy"`。値の一覧は `TransceiverPairingModes`（`MLineReuseModes` と同じ形、`packages/webrtc/src/api/peerConfig.ts:175`）。
  - `"jsep"`（既定）: RFC 8829 §5.10。MIDが一致しないm-sectionと関連付くのは、`addTrack()` が作成した（またはrollbackでそれに昇格した、2.3）、未関連付けで停止していない同じkindのtransceiverだけ。それ以外はremote offer用のtransceiverを新しく作る。
  - `"legacy"`: v0.27.0 までの挙動。同じkindで未関連付けのtransceiverなら、生成元に関係なく関連付ける（mLineIndexの一致を優先する）。glareでは方向が上書きされることがあると、TSDocとREADMEに明記する。
- `PeerConfig` に追加し（`mLineReuse` の隣）、`generateDefaultPeerConfig()` で `"jsep"` にする。正規化と検証も `mLineReuse` と同じにする。不正な値は `TypeError`、`setConfiguration()` で値を変えようとしたら `InvalidModificationError`。
- `TransceiverManager` / `RemoteMediaApplication` へは、構築時に値として渡す（`mLineReuse` が `SDPManager` に渡る `peerConnection.ts:280` と同じ方式）。
- `"legacy"` で変わらないのは関連付けのルール（2.2）だけにする。生成元の記録（2.1）とplan / applyの一致（2.4）は両モードで有効にする。`"legacy"` は旧挙動に戻すための移行用の値で、非推奨にするかどうかは本チケットでは決めない。
- WPTラッパー（`tools/wpt-runner/runner.ts:534`）では値を上書きしない。既定の `"jsep"` がそのまま試験される。

#### 移行（同じ変更で行う）
アプリ側の移行パターン（README・changelogに載せる）:
- answer側で送受信する場合: SRDの前に `addTransceiver()` せず、`addTrack(track)` を使う（JSEPでもofferと関連付く）。または、SRDの後に `pc.getTransceivers()` / `ontrack` / `onRemoteTransceiverAdded` で得たremote側のtransceiverに `direction` を設定し、`sender.replaceTrack()` する。
- 方向を固定した受信専用transceiverをSRDの前に作っていた場合: remote側のtransceiverの `direction` を設定する。
- すぐ移行できない場合: `new RTCPeerConnection({ transceiverPairing: "legacy" })`。

リポジトリ内の移行対象（answer側で「SRDの前に `addTransceiver`」していて、自動の関連付けに頼っている箇所）は、次の候補を1件ずつ確認する。原則として `"legacy"` は付けずに書き換える。
- examples: `examples/mediachannel/sendrecv/answer.ts`、`examples/mediachannel/simulcast/answer.ts`、`examples/mediachannel/simulcast/multiple_answer.ts`、`examples/untested/**` の該当箇所
- e2e handler: `e2e/server/handler/mediachannel/{sendrecv,oneway,reuse,codecRtp,simulcast}.ts`、`e2e/server/handler/bundle/{disable,max-compat,max-bundle}.ts`、`e2e/server/handler/combination/allmedia.ts`、`e2e/server/handler/ice/restart.ts`、`e2e/simulations/**`
- tests: `packages/webrtc/tests/integrate/mediaChannel.test.ts`、`tests/negotiation/harness/negotiationTransactionUtils.ts`、`tests/negotiation/cases/negotiationTransaction{,Regression}.test.ts`、`tests/pbt/scenario/scenarios.ts`、`tests/pbt/fuzz/episodes.ts`、`tests/media/{codecResolution,peerConfigBandwidthEstimator}.test.ts`
- 確認の手順: `"jsep"` にした状態で `npm test`、`npm run e2e`、`npm run examples:e2e` を実行し、失敗したものを上の移行パターンで直す。失敗の原因が関連付けの変更でないもの（offer側の処理など）は、別の不具合として扱う。

## 3. 技術調査メモ

| 箇所 | 現状 | 変更点 |
| --- | --- | --- |
| `negotiation/remoteMediaApplication.ts:243` `findTransceiver` | MIDが不一致なら、kindが同じ未関連付けtransceiverをmLineIndex優先で選ぶ | `"jsep"` では生成元 `addTrack` だけに絞る。`"legacy"` では現在のまま |
| `api/peerConfig.ts:160/175/301/474/495` | `mLineReuse` の型、値の一覧、既定値、検証、再設定の禁止 | 同じ形で `transceiverPairing` を追加する（既定 `"jsep"`） |
| `peerConnection.ts:280` | `mLineReuse` を `SDPManager` に渡す | `transceiverPairing` を `TransceiverManager` / `RemoteMediaApplication` に渡す |
| `negotiation/remoteMediaApplication.ts:90` `planCodecs` | 独自の `associated` Setで同じ `findTransceiver` を呼ぶ | 共通の対応付け関数を使い、rollback後の状態で解決する |
| `negotiation/remoteMediaApplication.ts:137` `associate` | 候補がなければremote transceiverを作る。関連付けなかった予約位置を解除する | 変更なし（新しい対応付け結果を使う） |
| `transceiverManager.ts:435` `addTransceiver` | 生成元の区別がない（`remoteMLineIndex` でremote起因かどうかだけ分かる） | 生成元を引数で受け取り記録する |
| `transceiverManager.ts:511` `addTrack` | 再利用の経路と、新規作成（L580）の経路がある | 新規作成だけ `addTrack` 起源にする。remote起源を再利用したら記録する |
| `transceiverManager.ts:203` rollback（`heldByApplication`） | トラック付きのremote transceiverを残し、MIDを外す | 残したtransceiverを `addTrack` 起源に昇格する |
| `media/rtpTransceiver.ts:259` `heldByApplication` | トラックの有無で判定する | 生成元の判定には使わない |
| `peerConnection.ts:1644/1721` | planはrollback前、applyはrollback後に実行する | 2.4で整合させる |
| `negotiation/negotiationNeeded.ts` | 変更ごとの連番。stableに戻ったときに再評価する | 関連付けなかった `addTransceiver` 分は、answer確定後に `negotiationneeded` が発火することを確認する（変更不要の見込み） |
| `wpt/allowlist.json` | `RTCRtpTransceiver.https.html` / perfect-negotiation系は未登録 | 該当subtestを追加する。ラッパーでは値を上書きしない（既定の `"jsep"` で試験する） |

## 4. 制約・注意点

- **negotiation変更のルール**（`packages/webrtc/AGENTS.md` Do 6〜8）に従う。
  - 新しいルール（生成元による関連付けの条件、rollbackでの昇格、planとapplyの一致）は、`NegotiationTransaction` / `TransceiverManager` / `RemoteMediaApplication` のTSDocに書き、テストで検証する。別のドキュメントには書かない。
  - 不変条件（`assertNegotiationInvariants`）が「`addTransceiver` 起源なのにremote MIDと関連付いている」という状態を検出できるようにする。
  - 個別テストは `tests/negotiation/cases/` に `describeCases` / `negotiationCase` 形式で書く。日本語の `// Arrange:` / `// Act:` / `// Assert:` を付け、最後は `expectSessionContinues` で終える。werift自身が作るdescriptionだけを使い、他の実装のSDPは手で作らない。
  - 操作列に依存する主張（glare・rollback後も関連付けが壊れない）はmodel propertyのoracle（`tests/pbt/model/oracles.ts`）とgenerator（`model/generator.ts`）に追加する。generatorに `addTransceiver` と `addTrack` の生成元の違いと、glareの操作を入れる。
  - `tools/negotiation-diff` で develop と比較する。比較は一時worktreeで行い、作業中のworktreeでは行わない。
    - `run.ts:79` の `CONFIGS` に `"legacyPairing"`（`{ transceiverPairing: "legacy" }`）を追加する。**この設定では develop との差分を0件にする**（旧挙動が保たれていることの証明）。develop では未知のキーとして無視され、旧挙動で動くことを確認する。
    - 既定の設定（`"jsep"`）で出る差分は、#816 の種類のもの（ローカルの `addTransceiver` がremote offerと関連付かなくなり、transceiverの数・MID・方向が変わる、glareで方向が保たれる）に限る。差分を1件ずつ分類し、その種類だけを想定された差分として `compare.ts` の判定ルールか `scenarios.ts` の契約に記録する。それ以外の差分は0件にする。
    - `lib.ts:121` の初期セッションはoffer側が `addTransceiver` し、answer側は `onRemoteTransceiverAdded` を使うので、既定でも変わらない見込み。
- 1つのoffer内で同じtransceiverを複数のm-lineに割り当てない。拒否されたm-line（port 0）、m-lineの再利用（`displaced`）、BUNDLE、re-offer、replacement offer（`negotiation.replace`）、pranswerの判定を変えない。
- 生成元は公開APIではない内部状態にする（`@internal` または非公開フィールド）。公開するならdocs / changelogに書く。
- `enum` は使わず、`as const` のオブジェクトと同名のunion型で書く（erasableSyntaxOnly）。
- 既定の挙動を変え、公開オプションも追加するので、同じ変更で次を更新する。
  - `packages/webrtc/README.md`: `mLineReuse` の節の近くに `transceiverPairing` の節を追加する。内容は表（`"jsep"` / `"legacy"` ごとに、関連付くtransceiver、glareでの方向）と移行パターン。
  - `changelog.md`: 次のリリースの ⚠️ Breaking changes と 🚀 Features（`PeerConfig.transceiverPairing`）に書く。v0.25.0 の `mLineReuse` と同じ書き方で、「旧挙動に戻すには `transceiverPairing: "legacy"`」を太字にする。
  - `PeerConfig.transceiverPairing` のTSDoc、影響するexamples、`npm run doc` による生成docs。
- ルート `AGENTS.md` Do 5 との関係（JSEPを既定にしても違反ではないこと、2.5の理由1）を、PRの説明にも書く。

## 5. 回帰テスト

- [ ] `addTransceiver("audio",{direction:"sendrecv"})` → 同じkindのremote offerをSRDすると、transceiverは2個で、ローカル側のMIDは `null`、方向は `sendrecv` のまま（#816の再現コード）。
- [ ] `addTransceiver(track)`、および `addTransceiver(kind)` → `replaceTrack(track)` も、remoteのm-sectionと自動で関連付かない。
- [ ] `addTransceiver(kind,{direction:"recvonly"})` → `addTrack(track)` で再利用したtransceiverも関連付かない（生成元は `addTransceiver` のまま）。
- [ ] `addTrack(track)` が新しく作った未関連付けtransceiverは、RFCどおりremote offerと関連付き、方向は `sendrecv` に交渉される。
- [ ] 関連付かなかった `addTransceiver` 側は、answer確定後に `negotiationneeded` が発火し、次のlocal offerで新しいm-lineとして追加される（m-lineの順序とMIDが重複しないこと）。
- [ ] 同じMIDのre-offer、port 0の拒否、複数のm-section（audio + video、同じkind 2本）、1 offer内で同じtransceiverを二重に割り当てないこと。
- [ ] glare: 両側が `addTransceiver(sendonly)` → 衝突 → polite側の暗黙のrollback → SRD(offer)。方向が `sendonly` のまま残り、最終的に両方向でメディアが流れる。codecPlanとapplyの対応付けが一致する（ローカルのpending MIDと相手のMIDが同じケースを含む）。
- [ ] rollback: remote起源のtransceiverに `addTrack` → rollback → 相手のre-offerで再び関連付く。
- [ ] WPT: `RTCRtpTransceiver.https.html` の `checkAddTransceiver*DoesntPair` 3件と、`RTCPeerConnection-perfect-negotiation.https.html` の setup 2件（`setup connects` / `setup connects with roles reversed`）を `wpt/allowlist.json` と `wpt/baseline.json` に追加し、全体 `npm run wpt` を繰り返して回帰 0。glare 系 subtest（`perfect-negotiation.https.html` の `glare` / `glare with roles reversed`、stress-glare 2ファイル）は gate に入れない（7章、別チケット cd89d492）。glare での方向の保持は `tests/negotiation/cases/negotiationTransactionPairing.test.ts` と model の固定シーン（`tests/pbt/model/scenes.ts` の #816 glare）で検証する。
- [ ] `transceiverPairing: "legacy"` の回帰テスト: #816 の再現コードで、transceiverが1個、ローカル側のMIDが `"0"` になる（v0.27.0 と同じ）。主要なケース（addTransceiverとの関連付け、複数m-section）は `"jsep"` / `"legacy"` の2モードを表で比べるテストにする（`negotiationTest` のfixtureを使う）。
- [ ] `PeerConfig` の検証: 既定は `"jsep"`。不正な値は `TypeError`。`setConfiguration()` で値を変えると `InvalidModificationError`、同じ値なら成功（`tests/issue/705.test.ts` の "issue 705: mLineReuse configuration" と同じ形。構成の検証は `tests/issue/816.test.ts` に置き、negotiationの挙動のケースは `tests/negotiation/cases/` に置く）。
- [ ] 移行したexamples / e2e / テストが `"legacy"` を付けずに通る。
- [ ] negotiationのharness（`negotiationTransactionUtils.ts`）、PBTのscenario / fuzz / modelは、既定の `"jsep"` で動く。modelのgeneratorには、構成の軸として `"legacy"` も入れる。

## 6. 検証コマンド

- `cd packages/webrtc && npm run type && npm test`
- `cd packages/webrtc && npm run pbt:deep`（レビュー前）と `tools/negotiation-diff` による develop との比較
- `npm run wpt`（allowlistを変更したため）、必要に応じて `npm run wpt:coverage`
- 既定の挙動を変え、公開APIも追加するので: `npm run type`、`npm run test:small`、`npm run e2e`、`npm run examples:e2e`、`npm run doc`
- `tools/negotiation-diff`: `--configs` で `legacyPairing` だけを指定すると差分0件。既定の設定では差分を分類する（4章）

## 完了条件

- ローカルで `addTransceiver` したtransceiverの送受信方向とMIDが、相手のoffer（glareとrollbackを含む）で上書きされない。
- remote offerの未知MIDと関連付くのは、`addTrack` が作った（またはrollbackでそれに昇格した）、未関連付けで停止していない同じkindのtransceiverだけ。
- `planCodecs` と `apply` は同じ対応付けを使い、暗黙のrollbackがある場合も一致する。
- 上記の回帰テスト、negotiationの不変条件とproperty、WPTのallowlistの追加分がすべて通る。WPT の gate は全体実行で安定するもの（`RTCRtpTransceiver` 3件と `perfect-negotiation.https.html` の setup 2件）に限る。glare 系 subtest（`perfect-negotiation.https.html` の glare 2件、stress-glare 2ファイル）の gate は本チケットの完了条件に含めない（別チケット cd89d492 の完了条件）。
- `npm run pbt:deep` は、失敗した seed を develop と本ブランチで同じ回数ずつ単独で再実行し、本ブランチだけで新たに再現する失敗がないこと（表をレビュー依頼に添える）。develop でも失敗する seed 50（VP8 の `transport-cc`）は別チケット 046b4db0 で扱い、本チケットの判定から除く。
- 操作チェーン（`enqueueDescriptionOperation`）の解放順序と `negotiationneeded` の発火条件は変えない（7章）。
- `PeerConfig.transceiverPairing`（既定 `"jsep"`、opt-in `"legacy"`）が実装されている。`"legacy"` では v0.27.0 と同じ関連付けになる（negotiation-diff の `legacyPairing` 設定で差分0件）。
- リポジトリ内のexamples / e2e / テストが `"legacy"` に頼らずJSEPの挙動へ移行されている。README・changelog（Breaking changesと移行方法）・TSDoc・生成docsが実装と一致している。

## 7. 追加要件：範囲を #816 に戻す（打開策 案A、2026-11-12 決定）

### 背景（分析結果）
- レビューが通らなかった直近の原因（PBT seed 263 の回帰）は、#816 の pairing 変更ではなくコミット `a29d5c0` だった。`a29d5c0` は stress-glare の WPT を安定させるために、操作チェーンの解放（`enqueueDescriptionOperation` の `releaseDone`）を `setImmediate` で遅らせ、`negotiationneeded` を「stable かつ chain が空」のときだけ発火させる変更で、本チケットの範囲外。
- seed 263 の再現率（同じハーネス・同じ条件で 10 回ずつ）: develop 4/10（ICE 候補数の小さな揺れ）、`6c86d0f` 6/10（同じ揺れのみ）、`a29d5c0` 10/10（offer の保留中に `currentLocalDescription` が変わる不変条件違反）。
  - 原因1（潜在バグ）: ICE restart の end-of-candidates で local description を描き直す `sdpManager.setLocal()` が、MID で見つからないとき m-line の位置で transceiver を探し直す。そのため、保留中の offer がその位置を再利用した生きている transceiver を拾ってしまい、port 0 の m-line に `a=ice-options:trickle` が書き込まれる。
  - 原因2: `setImmediate` で ICE restart の候補シグナリングと接続確認の順序が変わり、`prflx` 候補が増える（12→33）。
- stress-glare の不安定さ（全体実行で約 2 割失敗）は develop にもある操作チェーンの競合で、#816 を直しても解消しない。
- `pbt:deep` は develop でも seed 50（VP8 の `transport-cc` 不一致）で exit 1 になり、レビューのたびに「既知かどうか」の判断が揺れていた。

### 追加要件
1. `a29d5c0` の本体変更（`peerConnection.ts` の操作チェーンの遅延解放、`negotiation/negotiationNeeded.ts` の `operationsPending` 条件）を取り除き、`6c86d0f` の状態に戻す。WPT ランナー（iframe 代替など）の変更は残す。
2. WPT の gate は全体実行で安定するものに限る。対象は `RTCRtpTransceiver.https.html ?rest` の 3 件と、`RTCPeerConnection-perfect-negotiation.https.html` の `setup connects` / `setup connects with roles reversed`。
   - 当初案では `perfect-negotiation.https.html` の `glare` も対象だったが、`a29d5c0` を取り除いた状態の全体 `npm run wpt` 10 回のうち 1 回、同じ操作チェーンの競合（`Cannot read properties of null (reading 'type')`）で失敗し回帰判定になった。そのため `glare` も gate から外し、allowlist の `reason` に cd89d492 への依存を書く（2026-11-12 実測）。
   - `-stress-glare.https.html` と `-stress-glare-linear.https.html` は allowlist で `enabled: false`（gate なし）にし、baseline から外す。理由として別チケット cd89d492 への依存を allowlist の `reason` に書く。ファイル自体は自動検出で実行され続け、長いタイムアウトのまま結果を確認できる。
   - 元報告の「perfect-negotiation 系 3 ファイルの gate」という完了条件は、上の範囲に変更する（5章・完了条件を更新済み）。glare での方向の保持は、決定的なテスト（`negotiationTransactionPairing.test.ts` の glare ケース、model の固定シーン `#816 glare`）で検証する。
3. 別チケットに分ける。
   - **cd89d492**「[W3C] operations chainの解放順序と暗黙rollbackの競合を直しperfect-negotiation stress-glareのWPT gateを戻す」: 操作チェーンの競合、原因1（`sdpManager.setLocal()` の位置での探し直し）と決定的な再現ケース、原因2（`prflx` 増加）の解消、glare 系 subtest（`perfect-negotiation.https.html` の glare 2件と stress-glare 2ファイル）の gate の復帰。
   - **046b4db0**「[PBT] pbt:deep seed 50でVP8のRTCP feedbackにtransport-ccが残る不一致を解消する」: oracle か実装の修正、または既知の基準としての登録。
4. 再レビューを依頼する前に、`pbt:deep` で失敗した seed を develop と本ブランチで同じ回数ずつ単独で再実行した表を作り、レビュー依頼に添える。判定は「本ブランチだけで新たに再現する失敗がないこと」。

### 検証記録（2026-11-12、HEAD `cd3ac9b3b` に 7章 1・2 の未コミット変更を当てた状態）
- 全体 `npm run wpt`（他の負荷なし）: gate を setup 2件に絞る前の 10 回では回帰 1 回（`Perfect negotiation glare`、`null.type`）。絞った後は 20 回連続で回帰 0。gate 対象 5 件（setup 2件、DoesntPair 3件）は 30 回すべて PASS。gate 外の glare 系は 20 回中 10 回で 1 件以上 FAIL（`perfect-negotiation.https.html` の `glare` は 3 回、`glare with roles reversed` は 6 回）。
- `pbt:deep --jobs 8`: 本ブランチは model と leak の seed 50 で FAILED、develop は scenario の seed 52 で FAILED。両側の FAILED / flaky の seed を、それぞれ単独で 10 回ずつ交互に再実行した結果:

| suite / seed | 同じ seed で同じ操作列か | develop | 本ブランチ | 失敗の内容 |
| --- | --- | --- | --- | --- |
| model 50 | いいえ（model generator を変更） | 0/10 | 10/10 | VP8 の RTCP feedback に `transport-cc` が残る。最小シーン（既存の操作 3 個）は develop で 10/10 失敗（046b4db0） |
| leak 50 | いいえ（model generator を使う） | 0/10 | 10/10 | model 50 と同じ `transport-cc` の不一致 |
| model 275 | いいえ | 6/10 | 4/10 | 両側とも `expectSessionContinues` 未実行（同じ種類） |
| model fixed「BUNDLE merged its m-lines」 | はい | 2/10 | 0/10 | develop だけの揺れ |
| leak heap seed 4 | はい | 5/10 | 5/10 | 両側とも heap の傾きが閾値 16.00 KiB/cycle をわずかに超える（16.01〜16.25） |
| scenario 52 | はい | 1/10 | 0/10 | develop だけの揺れ（signalingState の列の不一致） |
| scenario 73 / 121 / 158 / 161 / 230 / 251 / 263 / 295 | はい | 0/10 | 0/10 | 単独ではすべて通過 |

- 判定: 本ブランチだけで新たに再現する失敗はない（seed 50 は develop の最小シーンで再現する既存の不一致）。
