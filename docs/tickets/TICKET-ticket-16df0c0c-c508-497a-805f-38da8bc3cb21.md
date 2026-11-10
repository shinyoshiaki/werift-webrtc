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
- MIDが一致しないときの `unassociated` の条件に `createdBy === "addTrack"`（相当）を追加する。`mid == null && !stopping && !stopped` は維持する。`mLineIndex === index` を優先する順序も維持してよい（同じ生成元の中でだけ優先する）。
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

### 2.5 既定動作と互換性（実装前に要判断）
- 現状、answer側で「SRDの前に `addTransceiver` → offerのm-lineと自動ペアリング → `onTrack` / `sender` をそのまま使う」というwerift独自の便利な挙動に多くのコードが依存している。
  - examples: `examples/mediachannel/sendrecv/answer.ts`、`examples/mediachannel/simulcast/answer.ts`、`examples/mediachannel/simulcast/multiple_answer.ts` など
  - e2e handler: `e2e/server/handler/mediachannel/{sendrecv,oneway,reuse,codecRtp,simulcast}.ts`、`e2e/server/handler/bundle/*.ts`、`e2e/server/handler/combination/allmedia.ts`、`e2e/server/handler/ice/restart.ts`、`e2e/simulations/**`
  - tests: `packages/webrtc/tests/integrate/mediaChannel.test.ts`、`tests/negotiation/harness/negotiationTransactionUtils.ts`、`tests/pbt/scenario/scenarios.ts`、`tests/pbt/fuzz/episodes.ts`、`tests/media/codecResolution.test.ts` など
- ルート `AGENTS.md` の Do 5 は「upstream WPTだけの厳密な挙動は `tools/wpt-runner/*` のラッパーに置き、`src` の既定はweriftの便利な挙動を保つ」と定めている。一方、この不具合はWPTに限らず、実際のperfect negotiationを壊している。
- 推奨: `mLineReuse` と同じく **構築時に固定するPeerConfigオプション** を追加する（例: `transceiverPairing: "jsep" | "legacy"`）。
  - 案A（推奨、チケットの完了条件どおり）: 既定を `"jsep"` にする。changelogの ⚠️ Breaking changes に移行方法（answer側は `ontrack` / `onRemoteTransceiverAdded` で受け取ったtransceiverを使う、`addTrack` を使う、または `transceiverPairing: "legacy"`）を書き、上記のexamples / e2e / テストを移行する。
  - 案B（非破壊）: 既定を `"legacy"` にし、`"jsep"` をopt-inにする。WPTラッパー（`tools/wpt-runner/runner.ts:534` の `WptRTCPeerConnection`）で `"jsep"` を既定にする。perfect negotiationを使う人には `"jsep"` を案内する。
- どちらの案でも、`"legacy"` の場合は現在の `findTransceiver` の挙動を保ち、`planCodecs` / `apply` の一致（2.4）は両モードで満たす。

## 3. 技術調査メモ

| 箇所 | 現状 | 変更点 |
| --- | --- | --- |
| `negotiation/remoteMediaApplication.ts:243` `findTransceiver` | MIDが不一致なら、kindが同じ未関連付けtransceiverをmLineIndex優先で選ぶ | 生成元 `addTrack` だけに絞る（モード依存） |
| `negotiation/remoteMediaApplication.ts:90` `planCodecs` | 独自の `associated` Setで同じ `findTransceiver` を呼ぶ | 共通の対応付け関数を使い、rollback後の状態で解決する |
| `negotiation/remoteMediaApplication.ts:137` `associate` | 候補がなければremote transceiverを作る。関連付けなかった予約位置を解除する | 変更なし（新しい対応付け結果を使う） |
| `transceiverManager.ts:435` `addTransceiver` | 生成元の区別がない（`remoteMLineIndex` でremote起因かどうかだけ分かる） | 生成元を引数で受け取り記録する |
| `transceiverManager.ts:511` `addTrack` | 再利用の経路と、新規作成（L580）の経路がある | 新規作成だけ `addTrack` 起源にする。remote起源を再利用したら記録する |
| `transceiverManager.ts:203` rollback（`heldByApplication`） | トラック付きのremote transceiverを残し、MIDを外す | 残したtransceiverを `addTrack` 起源に昇格する |
| `media/rtpTransceiver.ts:259` `heldByApplication` | トラックの有無で判定する | 生成元の判定には使わない |
| `peerConnection.ts:1644/1721` | planはrollback前、applyはrollback後に実行する | 2.4で整合させる |
| `negotiation/negotiationNeeded.ts` | 変更ごとの連番。stableに戻ったときに再評価する | 関連付けなかった `addTransceiver` 分は、answer確定後に `negotiationneeded` が発火することを確認する（変更不要の見込み） |
| `wpt/allowlist.json` | `RTCRtpTransceiver.https.html` / perfect-negotiation系は未登録 | 該当subtestを追加する（モード次第でラッパー設定も） |

## 4. 制約・注意点

- **negotiation変更のルール**（`packages/webrtc/AGENTS.md` Do 6〜8）に従う。
  - 新しいルール（生成元による関連付けの条件、rollbackでの昇格、planとapplyの一致）は、`NegotiationTransaction` / `TransceiverManager` / `RemoteMediaApplication` のTSDocに書き、テストで検証する。別のドキュメントには書かない。
  - 不変条件（`assertNegotiationInvariants`）が「`addTransceiver` 起源なのにremote MIDと関連付いている」という状態を検出できるようにする。
  - 個別テストは `tests/negotiation/cases/` に `describeCases` / `negotiationCase` 形式で書く。日本語の `// Arrange:` / `// Act:` / `// Assert:` を付け、最後は `expectSessionContinues` で終える。werift自身が作るdescriptionだけを使い、他の実装のSDPは手で作らない。
  - 操作列に依存する主張（glare・rollback後も関連付けが壊れない）はmodel propertyのoracle（`tests/pbt/model/oracles.ts`）とgenerator（`model/generator.ts`）に追加する。generatorに `addTransceiver` と `addTrack` の生成元の違いと、glareの操作を入れる。
  - `tools/negotiation-diff` で develop と比較する。**既定の挙動を変える（案A）と差分が出る**ので、想定された差分として、比較のシナリオか比較ルールを更新して記録する。比較は一時worktreeで行い、作業中のworktreeでは行わない。
- 1つのoffer内で同じtransceiverを複数のm-lineに割り当てない。拒否されたm-line（port 0）、m-lineの再利用（`displaced`）、BUNDLE、re-offer、replacement offer（`negotiation.replace`）、pranswerの判定を変えない。
- 生成元は公開APIではない内部状態にする（`@internal` または非公開フィールド）。公開するならdocs / changelogに書く。
- `enum` は使わず、`as const` のオブジェクトと同名のunion型で書く（erasableSyntaxOnly）。
- 公開の挙動を変える（案A）またはオプションを追加するので、`packages/webrtc/README.md` の該当節、`changelog.md`、影響するexamplesを同じ変更で更新する。`npm run doc` で生成docsも更新する。

## 5. 回帰テスト

- [ ] `addTransceiver("audio",{direction:"sendrecv"})` → 同じkindのremote offerをSRDすると、transceiverは2個で、ローカル側のMIDは `null`、方向は `sendrecv` のまま（#816の再現コード）。
- [ ] `addTransceiver(track)`、および `addTransceiver(kind)` → `replaceTrack(track)` も、remoteのm-sectionと自動で関連付かない。
- [ ] `addTransceiver(kind,{direction:"recvonly"})` → `addTrack(track)` で再利用したtransceiverも関連付かない（生成元は `addTransceiver` のまま）。
- [ ] `addTrack(track)` が新しく作った未関連付けtransceiverは、RFCどおりremote offerと関連付き、方向は `sendrecv` に交渉される。
- [ ] 関連付かなかった `addTransceiver` 側は、answer確定後に `negotiationneeded` が発火し、次のlocal offerで新しいm-lineとして追加される（m-lineの順序とMIDが重複しないこと）。
- [ ] 同じMIDのre-offer、port 0の拒否、複数のm-section（audio + video、同じkind 2本）、1 offer内で同じtransceiverを二重に割り当てないこと。
- [ ] glare: 両側が `addTransceiver(sendonly)` → 衝突 → polite側の暗黙のrollback → SRD(offer)。方向が `sendonly` のまま残り、最終的に両方向でメディアが流れる。codecPlanとapplyの対応付けが一致する（ローカルのpending MIDと相手のMIDが同じケースを含む）。
- [ ] rollback: remote起源のtransceiverに `addTrack` → rollback → 相手のre-offerで再び関連付く。
- [ ] WPT: `RTCRtpTransceiver.https.html` の `checkAddTransceiver*DoesntPair` 3件と、perfect-negotiation系3ファイルを `wpt/allowlist.json` に追加し、`npm run wpt` が通る。
- [ ] （案Aの場合）移行したexamples / e2eが通る。（案Bの場合）`"legacy"` モードで既存の挙動が保たれる回帰テスト。

## 6. 検証コマンド

- `cd packages/webrtc && npm run type && npm test`
- `cd packages/webrtc && npm run pbt:deep`（レビュー前）と `tools/negotiation-diff` による develop との比較
- `npm run wpt`（allowlistを変更したため）、必要に応じて `npm run wpt:coverage`
- 既定の挙動を変える場合: `npm run type`、`npm run test:small`、`npm run e2e`、`npm run examples:e2e`

## 完了条件

- ローカルで `addTransceiver` したtransceiverの送受信方向とMIDが、相手のoffer（glareとrollbackを含む）で上書きされない。
- remote offerの未知MIDと関連付くのは、`addTrack` が作った（またはrollbackでそれに昇格した）、未関連付けで停止していない同じkindのtransceiverだけ。
- `planCodecs` と `apply` は同じ対応付けを使い、暗黙のrollbackがある場合も一致する。
- 上記の回帰テスト、negotiationの不変条件とproperty、WPTのallowlistの追加分がすべて通る。
- 既定の挙動（案A / 案B）を決め、README・changelog・examples・生成docsが実装と一致している。
