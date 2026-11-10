# [WebRTC] 再オファーで過去のAnswerにより削られたコーデックを再提示できない問題を修正する（#818）

## 1. 目的と背景

- 元Issue: #818（sidorares）「A subsequent offer lists only the codecs negotiated before, where it should list every codec the connection supports」。**妥当**。develop（`b697c73dc`）のコードで確認した。
- 再現手順（Issueから要約）:
  - A は `codecs.video = [VP8(96), VP9(98)]`、B は `[VP8(96)]`。
  - A がOfferする → B がAnswerする（VP8だけ）→ A が `setRemoteDescription(answer)` → A がもう一度 `createOffer()` する。
  - 結果のrtpmapは `["VP8"]` だけ。期待値は `["VP8", "VP9"]`。
- 仕様: RFC 8829（JSEP）§5.2.2 Subsequent Offers は、m= 行と `a=rtpmap` / `a=fmtp` について「codec preferencesで除外されていないフォーマットだけを含め、**現在利用可能なフォーマットはすべて含める**」としている。絞り込むのはAnswerの役割で、Answerの結果で次回Offerの能力が減ってはいけない。
- WPT: `third_party/wpt/webrtc/protocol/codecs-subsequent-offer.https.html` が失敗する（Chrome / Firefox / Safariは通る）。このテストは「VP8だけのremote offer → 応答 → 次の `createOffer()` にVP8とH264が両方含まれる」ことを検証する。
- 影響: 一度でもcodecを絞るAnswerを受けたり返したりすると、そのセッションでは別codecへ移れなくなる。より多くのcodecを受け入れる相手にも、そのcodecを二度と提示できない。

## 2. 現状の構造と根本原因（調査結果）

### codec状態のフィールド

| フィールド | 定義 | 現在の意味 |
| --- | --- | --- |
| `RTCRtpTransceiver.codecs`（`_codecs`） | `src/media/rtpTransceiver.ts:43` | **offer用の能力**と**交渉済みcodec**を兼ねている |
| `pendingLocalOfferCodecs` | `rtpTransceiver.ts:53` | 適用した自分のOfferのcodec。remote answerの検証・解決に使う（`setLocalDescription(offer)` で設定し、remote answerで消す） |
| `codecPreferencesNeedResolution` | `rtpTransceiver.ts:54` | 次回のoffer / answerで再解決する必要があることを示すフラグ。`setCodecPreferences` と local answer後の差分で立つ |
| `codecChangeRevision` | `rtpTransceiver.ts:60` | rollbackしてもアプリのcodec変更を保つための世代番号 |

`transceiver.codecs` を読む箇所（意味を分けると影響するところ）:

- offer / answer SDPの生成: `sdpManager.ts:85-100` の `createMediaDescriptionForTransceiver()`
- 送受信パラメータ: `transceiverManager.ts:681` の `getLocalRtpParams()` と `:693` の `getRemoteRtpParams()`（sender `prepareSend` と receiver / router の登録元）
- 公開API・統計: `rtpTransceiver.ts:345` の `getPayloadType()` と `:366` の `collectCodecStats()`
- テストのinvariant: `tests/negotiation/harness/negotiationTransactionUtils.ts:868`（`transceiver.codecs` を交渉済みとして受信表と照合する）

### codecsが縮む経路

1. **remote answer（#818の本題）**: `remoteMediaApplication.ts:387` → `transceiverManager.setRemoteRTP()`（`:970-1030`）の `transceiver.codecs = codecs`（`:1009`）。`planRemoteRtpCodecs()` で解決したAnswerのcodecだけが入り、`codecPreferencesNeedResolution` は立たない。
2. **local answer**: `peerConnection.ts:1207-1230` で `transceiver.codecs = [...answered.rtp.codecs]` とする。解決結果と異なる場合だけ `resolveAfterAnswer` で `codecPreferencesNeedResolution = true` にする。remote offerがVP8だけのときは解決結果もAnswerも `[VP8]` なので、フラグは立たない（WPTのケース）。
3. **createOffer**: `peerConnection.ts:626-632` は `codecs.length === 0 || codecPreferencesNeedResolution` のときだけ `assignTransceiverCodecs()`（`transceiverManager.ts:624`）を呼ぶ。それ以外は縮んだ `transceiver.codecs` をそのままOfferに使う。

### 既存の副作用（この修正で一緒に解消すべきもの）

- `assignTransceiverCodecs()` は `createOffer()` の中で `transceiver.codecs` を**直接書き換える**。再解決が必要なとき、適用されないかもしれないOfferのために、交渉済みの `codecs` が設定値（設定上のPT）に置き換わる。その間 `getPayloadType()`、統計、後続の `prepareSend(getLocalRtpParams())` が未確定の集合を見る。
- remote offerに応答した場合、交渉済みcodecは**remote側のPT**を持つ（例: WPTではVP8=100）。設定から単純に再解決するとVP8は96になり、再オファーでPTが変わる。

### 根本原因

「次のofferで提示できる能力」（`config.codecs[kind]` ∩ source制約 ∩ preferences、direction filter込み）と、「現在確定している交渉済みcodec」（直近のanswerで確定した集合）を、同じ `transceiver.codecs` で扱っている。

## 3. 実装内容

### 3.1 状態の分離（`RTCRtpTransceiver` / `TransceiverManager`）

- `transceiver.codecs` は**交渉済み（current / provisional）codec**の意味に固定する。`getLocalRtpParams` / `getRemoteRtpParams` / `getPayloadType` / 統計の意味は変えない。
- offer用の集合は `transceiver.codecs` に書き戻さない。`TransceiverManager` に純関数的なresolverを追加し、offer生成のたびに計算する（例: `resolveOfferCodecs(transceiver): RTCRtpCodecParameters[]`）。
  - 入力: `filterCodecsByDirection(kind, direction)`、`getTrackSourceCodecs(sender.track)`、`codecPreferences`、交渉済みの `transceiver.codecs`（PTを保つため）。
  - 能力判定とエラーは今の `assertCodecsSupported()` / `resolveCodecs()`（`media/codecCompatibility.ts:192-230`）を使う。
- 初回（`currentDirection` が未設定で交渉済みcodecがない）は今と同じ結果にする。差分を出さないことが、`tools/negotiation-diff` と既存テストを守る前提になる。

### 3.2 `createOfferNow()`（`peerConnection.ts:626-632`）

- 「`codecs.length === 0` のときだけ解決する」条件をやめ、毎回offer用集合を再解決する。
- SDP生成器にはoffer用集合を渡す。`createMediaDescriptionForTransceiver(transceiver, direction, codecs?)` に引数を追加するか、`buildOfferSdp` 側で集合を受け取る。`transceiver.codecs` は使わない。
- PTの整合（RFC 3264 §8.3.2、`sdpManager.ts:475` の `assertStablePayloadTypes` と同じ考え方）:
  - 交渉済みのprimary codec（MIME・clockRate・channels・H264のprofile等が `isCodecCompatible` で一致するもの）は**交渉済みのPT**で提示する。
  - 再追加するcodecは設定上のPTを使う。交渉済みPTや同じBUNDLE内の他m-lineのPTと衝突する場合は空いている動的PT（96-127、足りなければ35-63）を割り当てる。
  - RTXの `apt` とREDの `parameters`（`pt/pt`）は、primaryのPTを付け替えた後の値に書き換える。`resolveRemoteCodecSet` と同じく、参照するprimaryが残らないRTX / REDは落とす。
  - codecの順序はpreferences、なければ設定の順にする（今の初回Offerと同じ）。交渉済みcodecを先頭に寄せるかどうかは実装時に決め、テストで固定する。互換のため、初回と同じ順を推奨する。
- `createOffer()` を呼ぶだけ（未適用）では、`transceiver.codecs`、sender、receiver、router が変わらないこと。

### 3.3 適用・確定・rollback

- `setLocalDescription(offer)`（`peerConnection.ts:1172-1177`）は今と同じく、`pendingLocalOfferCodecs = description.media[index].rtp.codecs` を記録する。これがremote answer解決（`planRemoteRtpCodecs`、`descriptionValidation.ts:200`）の基準になるので、VP9を選ぶAnswerを受け入れられる。
- 再オファー中（`have-local-offer`）は送受信中のcodecを変えない。`transceiver.codecs` は確定済みのまま保つ。remote pranswer / answerの適用（`setRemoteRTP`）でだけ更新し、answerで確定する（今の `prepareSend` / `resyncCodecs` の流れを使う）。
- local answer経路（`peerConnection.ts:1207-1230, 1276-1278`）の `resolveAfterAnswer` / `codecPreferencesNeedResolution` は「answer用候補の再解決要求」に役割を絞る。offerは毎回再解決するので、offer側ではフラグに依存しない。`createAnswerNow()`（`:1958-1990`）の条件 `codecs.length !== 0 && !codecPreferencesNeedResolution → skip` との関係を整理する。
- `markCodecsForResolution()`（`rtpTransceiver.ts:74`）が `_codecs = []` で交渉済みcodecを消している点を見直す。preferences変更やaddTrackのたびに交渉済み集合が空になると、統計や `getPayloadType` が一時的に空を返す。分離後は「再解決要求フラグ + revision」だけにできるか検討する。
- rollback: `snapshotNegotiationState` / `restoreNegotiationState`（`rtpTransceiver.ts:190-235`）が交渉済み `codecs` と `pendingLocalOfferCodecs` を以前の確定値に戻すことを確認する。offer用集合を状態として持たない設計なら、snapshotに追加するものはない。
- 公開APIの `getPayloadType()` / codec統計は、確定codecだけを返し続けること。

### 3.4 相互作用の確認項目

- `setCodecPreferences([])` での解除（`rtpTransceiver.ts:66-79`）: 解除後の再オファーで全能力が戻る。
- preferencesでVP8だけに制限した場合: 再オファーにVP9は**戻らない**。
- 固定encoded source（`getTrackSourceCodecs`）とtrackの差し替え（`replaceTrack` / `addTrack`）: source制約が変わると、offer集合もそれに従う。共通codecがなければ今と同じ `NotSupportedError` にする（`codecResolution.test.ts:135, 503` の挙動を保つ）。
- direction filter（`filterCodecsByDirection` の `sendonly` / `recvonly` codec）: 再オファーでdirectionを変えると、集合もそれに従う。
- 共通codecがない場合の拒否（`planRemoteRtpCodecs` の空plan → port 0 answer / `InvalidAccessError`、Issue #705）と `pendingRejection` に影響しない。
- `negotiationneeded`: offer集合が交渉済み集合より大きいことだけを理由に、`negotiationneeded` を出し続けないこと（`codecResolution.test.ts:384` の「preferencesの意味が変わったときだけ要求する」を保つ）。
- BUNDLE内の複数m-lineでのPT一意性と、header extension IDの安定性（`assertStableHeaderExtensionIds`）。

## 4. 制約・注意点

- **Negotiation変更の扱い**（`packages/webrtc/AGENTS.md` Do 6-8）:
  - 新しいルール（「offerは毎回能力から解決し、交渉済みPTを保つ」「`createOffer()` は送受信状態を変えない」）は、実装箇所のTSDoc（`NegotiationTransaction` / `TransceiverManager`）に書き、テストで検証する。別ドキュメントには書かない。
  - pending中のlive値の扱いが変わる場合は、先に `expectedLive` の表（`negotiationTransactionUtils.ts`）を更新する。
  - `assertNegotiationInvariants`（`negotiationTransactionUtils.ts:868`）は `transceiver.codecs` を交渉済みとして扱う。今回の分離はこの前提を強めるので、invariantに「stableでの `transceiver.codecs` は current local / remote の交渉済み集合と一致する」を追加できるか検討する。
  - `tools/negotiation-diff` で `codecSubset` mutation（`mutations.ts:150`）を含むシナリオを流すと、再オファーの内容がdevelopと変わる。差分が意図どおりか（regression / state difference 0）を確認し、意図した差分なら `compare.ts` の説明に追記する。比較は一時worktree（`git worktree add --detach`）で行い、アクティブなworktreeでは行わない。
  - レビュー前に `npm run pbt:deep` を実行する。
- **後方互換**: 外部から `transceiver.codecs` を読むコード（examplesやユーザーコード）は、交渉済みの意味のまま動く。初回Offer・初回Answerの内容はdevelopと同じにする。
- **WPT**: このWPTはH264を前提にしているが、werift既定の映像codecはVP8だけ（`media/codec.ts:96-103`）。allowlistに追加するには、WPTランナーのラッパー（`tools/wpt-runner/runner.ts:533` の `createPeerConnectionWrapper`）でブラウザ相当のcodec設定（VP8 + H264など）を与える必要がある。既定の `src` の挙動は変えない（root AGENTS Do 5）。ラッパーの変更が他のallowlist対象の結果を変えないか、`npm run wpt` で確認する。WPT作業の前に `git submodule update --init --recursive` を実行する。
- `erasableSyntaxOnly`: `enum` やparameter propertiesを使わない。
- テストはArrange / Act / Assertで書き、Act / Assertには日本語コメントを付ける。negotiationテストは `describeCases` / `negotiationCase`（`ref` 付き）で書き、`expectSessionContinues` で終える。werift同士で作ったdescriptionだけを使う（他実装のSDPは捏造しない。WPTのremote offerはWPT側で扱う）。

## 5. 回帰テスト

配置: negotiation系は `tests/negotiation/cases/negotiationTransactionCoverageCodecs.test.ts`（または新しいcase file）、codec解決の単体は `tests/media/codecResolution.test.ts`、Issue再現は `tests/issue/818.test.ts`（既存の `705.test.ts` などの慣例に合わせる）。

- [ ] **#818再現**: A=[VP8, VP9]、B=[VP8] で、初回Offer → VP8だけのAnswer → Aの次回OfferにVP8とVP9が両方載る。VP8のPTは初回と同じ。
- [ ] **再交渉でVP9へ移れる**: BがVP9に対応する構成（またはBのpreferences変更）で次回AnswerがVP9を選べる。Answerを確定する前（`have-local-offer` 中）のsender codec / 受信表 / `transceiver.codecs` は以前のVP8のままで、確定後はVP9になる。
- [ ] **answerer側（WPT相当）**: werift同士で、BがVP8だけのOfferを出す → AがAnswerする → Aの次回Offerに、Aの設定codec（VP8 + H264等）が全部載る。VP8はBのPTのまま。
- [ ] **preferencesで制限**: `setCodecPreferences([VP8])` のあとはVP9が復活しない。`setCodecPreferences([])` で解除すると復活する。
- [ ] **RTX / RED**: RTX付きVP8+VP9の構成で、再オファーにVP9用のRTXが復活し、`apt` が正しいPTを指す。REDは参照するprimaryが揃っているときだけ載る。PTが衝突する場合は再割当され、`assertStablePayloadTypes` に違反しない。
- [ ] **rollback**: 再オファーを `setLocalDescription({type:"rollback"})` すると、`transceiver.codecs`、`pendingLocalOfferCodecs`、sender / receiver が以前の確定値に戻る。
- [ ] **未適用のcreateOffer**: `createOffer()` だけでは `transceiver.codecs`、`getPayloadType()`、codec統計が変わらない。
- [ ] **固定source**: H264固定sourceのtrackがある場合、再オファーはsource互換のcodecに限られる（既存の挙動を保つ）。
- [ ] **WPT**: `webrtc/protocol/codecs-subsequent-offer.https.html` を `packages/webrtc/wpt/allowlist.json` に追加し（必要ならwrapperのcodec設定も）、`baseline.json` / `coverage-baseline.json` を更新する。
- [ ] model property: 再オファーのcodec集合に関する性質（「stable後のofferは能力集合 ∩ preferencesを含む」）をoracle（`tests/pbt/model/oracles.ts`）として追加できるか検討する。見つかった失敗は `model/scenes.ts` に短い操作列として追加する。

## 6. 検証コマンド

作業開始時に、リビジョン・未コミット差分・意図を記録してから実行する（root AGENTS Do 8）。

| 目的 | コマンド |
| --- | --- |
| 型チェック | `cd packages/webrtc && npm run type` |
| パッケージテスト（negotiation propertyを含む） | `cd packages/webrtc && npm test` |
| 深いproperty探索（レビュー前） | `cd packages/webrtc && npm run pbt:deep` |
| WPT | `cd packages/webrtc && npm run wpt`（baselineを変えた場合は `npm run wpt:coverage` も） |
| developとの比較 | 一時worktreeで `tools/negotiation-diff`（手順は `run.ts` のヘッダー） |
| 横断確認 | `npm run type` と `npm run test:small` |
| 整形 | `npm run format` |

## 7. ドキュメント

- `changelog.md` の次バージョンの Bug fixes に追記する（後続Offerが、以前のAnswerで外れたcodecを含め、サポートする全codecを再提示するようになる。preferencesは引き続き適用される）。
- 公開APIのシグネチャが変わる場合（例: `createMediaDescriptionForTransceiver` の引数）は `npm run doc` で再生成する。

## 8. 完了条件

- [ ] 交渉結果でtransceiverのcodec能力が失われず、後続Offerがサポートする全codecを再提示する（codec preferencesと固定source制約は適用したまま）。
- [ ] 再オファーで交渉済みcodecのPTが保たれ、RTX `apt` / RED参照が整合し、BUNDLE内でPTが衝突しない。
- [ ] `createOffer()`、`setLocalDescription(offer)`、rollbackでは、送受信中のcodec（sender / receiver / router / `transceiver.codecs`）が変わらない。新しいAnswerを確定したときだけ反映される。
- [ ] 上記の回帰テストがすべて追加されて通る。`npm run type` / `npm test` / `npm run pbt:deep` / `npm run wpt` が通る。
- [ ] `tools/negotiation-diff` のdevelop比較でregression / hang / state differenceが0。意図した差分は説明されている。
- [ ] 新しいルールが実装のTSDocとテストに記録され、`changelog.md` が更新されている。
