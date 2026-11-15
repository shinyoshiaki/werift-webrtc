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
- [ ] 交渉済みcodecは、codec設定が非対称な相手に対しても交渉済みの形式（PT・fmtp・rtcp-fb）のまま再提示される。設定codecとの対応付けは交渉と同じ述語（`negotiatesAs`）を使い、非対称な構成でのdevelopとの差分は「以前のanswerで削られたcodecが増える」とBUNDLE内のPT衝突回避だけ（§10）。

## 9. 追加要件: 方向変更で交渉済みcodecを失わない（レビュー7回目の打開策）

### 9.1 背景と原因

- レビュー7回目で、交渉済みtransceiverの `direction = "inactive"` 後の `createOffer()` が `NotSupportedError` になる回帰が指摘された。同じ原因で、`removeTrack()`（`sendonly` → `inactive`）や、方向付きcodec（`direction: "sendonly"` / `"recvonly"`）の反対方向への変更でも失敗する。developでは同じ操作が成功する。
- developは交渉済みtransceiverのcodecを「空、または再解決フラグが立ったときだけ再解決」し、それ以外は交渉済み集合をそのまま再提示していた。そのため再オファーで `assertCodecsSupported` が走らず、失敗しなかった。
- 前回までの実装（`resolveOfferCodecs`）は交渉済みtransceiverのcodecを**毎回能力集合からゼロで再計算**していた。そのため、能力計算の入力すべて（方向フィルタ、固定source、preferences、RTX/REDの参照、BUNDLEのPT空間、再解決フラグの寿命）が再オファーの新しい失敗面になった。レビューはこれを1入力ずつ指摘し（PT衝突、選好の消失、REDの欠落、`inactive`）、対応も1ケースずつだった。
- `filterCodecsByDirection` は `inactive` にどの方向付きcodecも一致させず、`sendonly` / `recvonly` のcodecは反対方向で空になる。

### 9.2 ルール（「ゼロから再計算」から「交渉済み集合に能力を足す」へ）

交渉済みtransceiverの再オファーのcodecは、次の和とする（`TransceiverManager.resolveOfferCodecs` → `withNegotiatedCodecs` → `keepNegotiatedPayloadTypes`）。

1. 交渉済みの `transceiver.codecs`。**方向では絞らない**（方向変更や `removeTrack()` では交渉済みcodecをm-lineから外さない。外すのはanswerだけ）。preferencesと固定sourceは交渉済みcodecにも適用する。
2. 現在の方向での能力集合（方向フィルタ・source・preferences適用後）のうち、まだ含まれないもの。

- 順序はpreferences、なければ設定の順（初回offerと同じ）。交渉済みcodecは交渉済みPTのまま。
- RTX / REDは、primaryが残り、かつ能力集合にあるか同じprimaryで交渉済みのときに残す。
- 和が空になるのはcodec変更（preferences / addTrack）で何も残らない場合だけで、初回offerと同じ `NotSupportedError` にする。変更がないのに空になる場合は、交渉済み集合をそのまま提示する（develop互換）。
- `inactive` のtransceiverは全設定codecを使える（`filterCodecsByDirection`）。初回からinactiveで方向付きcodecだけの構成が `NotSupportedError` になる既存問題も解消する。
- ルールは `resolveOfferCodecs` / `withNegotiatedCodecs` / `NegotiationTransaction` のTSDocと `changelog.md` に記載した。

### 9.3 developとの差分（提出前に全列挙で確認）

`/tmp/diff818/matrix.ts`（一時スクリプト）を、developの一時worktree（`41773f4dc`）とHEADで同じ入力に対して実行し、`compare.ts` で行ごとに分類した。

- 入力: codec構成10種（方向付きVP8 / VP9の組み合わせ、RTX、fmtpなしRED、H264+VP8）× answerer 2種（VP8だけ / 同じ構成）× 初回の方向4種 × 操作15種（方向4種、`removeTrack`、`removeTrack`+`addTrack`、preferences、preferences解除、preferences+inactive、H264固定sourceへの `replaceTrack` / `addTrack`、m-line追加2種、`stop`）× 操作する側2種 = 2400行。
- 各行: 初回offer、操作、再オファー（throwするか、各m-lineのPTとcodec）、再交渉の確定結果。

結果は 9.5 に記載する。

### 9.4 回帰テスト

- [x] `tests/issue/818.test.ts`: レビュー7回目の表の各行（sendonly / sendrecv方向付きVP8での `inactive` と `removeTrack()`、sendonly codecでの `recvonly`、recvonly codecでの `sendonly`、VP8 + sendonly VP9での `inactive`、初回inactive + sendonly codec（track付き `addTransceiver` を含む））。再オファーが投げず、PTと順序を保ち、確定後もセッションが続くことを確認する。修正前のHEADでは8件とも失敗する。
- [x] `tests/media/codecResolution.test.ts`: `withNegotiatedCodecs` の単体テスト（方向で外れた交渉済みcodecの追加、preferences / sourceで除外されたcodecは戻らない、交渉済みなしでは能力集合のまま）。
- [x] model property: oracle `offerCapability` に「交渉済みtransceiverの `createOffer()` はthrowせず、preferences / 固定sourceで外れない交渉済みcodecをdirectionによらず含む」を追加した。`generator.ts` には方向変更があり、`removeTrack` の操作を追加した。

### 9.5 developとの差分の結果

2400行のうち、developとの差分は次のとおり。**HEADだけが失敗する行（再オファーのthrow、確定の失敗）は0件。**

| 分類 | 行数 | 内容 |
| --- | --- | --- |
| 同一 | 1650 | |
| codecが増える | 259 + 48 | 方向で外れていた交渉済みcodec、または以前のanswerで外れたcodecを再提示する（意図した追加）。48行は確定結果も増えたcodecを含む |
| developはthrow、HEADは成功 | 57 | `inactive` や反対方向への変更、preferences変更後の再オファーで、developが `NotSupportedError` を出していた |
| 初回offerが成功するようになった | 180 | 初回から `inactive` で方向付きcodecだけの構成（既存問題の解消） |
| PTだけが変わる | 16 | answererが preferences / `addTrack` 後に再オファーすると、developは設定上のPTに戻す。HEADは交渉済みPTを保つ（RFC 3264 §8.3.2、本チケットの意図） |
| 固定sourceでcodecが減る | 8 | H264+VP8で交渉後、H264固定sourceに `replaceTrack` した再オファー。developはVP8も提示するが、相手がVP8を選ぶとanswerer側だけ確定し、offerer側の `setRemoteDescription(answer)` が `NotSupportedError` になる（developで確認）。HEADはH264だけを提示する（固定source制約の適用、本チケットの意図） |
| 初回offerの変化に連なる差分 | 180 | `inactive` が全codecを使えるようになり、初回offerの内容が変わった行。例えば `vp8(sendonly)+vp9` を `inactive` で始めると、developはVP9だけを提示し、HEADはVP8+VP9を提示してVP8で交渉する。以降の操作は別の交渉済み状態から始まる。codecが減って見える27行（H264固定sourceへの `replaceTrack` が交渉済みVP8に合わず `InvalidModificationError` になる2行を含む）は、すべてこの構成の行 |
| 拒否されたm-lineの `transceiver.codecs` | 2 | VP8だけの相手に、H264固定sourceの `addTrack` 後のH264だけのofferを出すと、answerがm-lineを拒否する（port 0、`stopped`、両方とも同じ）。developは適用されなかったofferの解決結果（H264）を残し、HEADは直前の交渉済みcodec（VP8）を残す（`createOffer()` は `transceiver.codecs` を変えない、本チケットの意図） |

### 9.6 検証結果（レビュー7回目の対応）

| 確認 | 結果 |
| --- | --- |
| `tests/issue/818.test.ts` | 19件成功。追加8件は修正前のHEADで失敗 |
| `cd packages/webrtc && npm test` | 89ファイル、1857件成功、5件スキップ |
| `npm run type`（rootとwebrtc） | エラー0 |
| `tools/negotiation-diff`（60 seed、`--mutate 0.3`、develop `41773f4dc` と比較） | regression 0、divergence 0、hang 0、state difference 0 |
| `npm run pbt:deep`（2回） | fuzz / model は失敗0。scenario は1回目に seed 12 が失敗扱い（単独とshardで再実行すると成功）、他はflaky。leak の heap seed 4 は2回とも失敗（下記） |
| `npm run wpt` | regression 0。`codecs-subsequent-offer` はPASS |

- leak heap seed 4（`-t "heap seed"` で単独実行すると再現、slope 19〜21 KiB/cycle、上限16）は、developの一時worktreeでも同じく失敗する（18.4 / 19.5 KiB/cycle）。修正前のHEADも同じ（19.2 / 19.4）。本チケットの変更によるものではない既存の問題で、範囲外とする。
- `packages/rtp/tests/codec/vp8.test.ts` に混入していたroot formatによるimport順の差分は、developの内容に戻した。

## 10. 追加要件: 交渉済みcodecを交渉済みの形式のまま再提示する（非対称な相手、レビュー9回目の打開策）

### 10.1 背景と原因

- レビュー8〜10回目は、BUNDLE内のPT共有判定（H264の `packetization-mode` / `profile-level-id`、REDの参照先、`rtcp-fb`）を1次元ずつ指摘した。8〜10回目の対応で、PTを共有できるのは `rtpmap`・`fmtp`・`rtcp-fb` がすべて同じcodecだけとした（`samePayloadMapping`、RFC 8859 の IDENTICAL-PER-PT）。
- レビュー9回目以降の指摘（H264 level差で確定PTが移る）を含め、**根本原因はcodecの「同一性」を判定する述語が経路ごとに食い違っていたこと**だった。
  - 交渉（answer作成・remote answer適用、`resolveRemoteCodecSet`）は、localとremoteのcodecを**MIME typeだけ**で対にする。確定した `transceiver.codecs` には**remote側のcodecオブジェクト**（remoteのPT・fmtp・rtcp-fb）が入る。
  - 再オファー（`withNegotiatedCodecs` / `keepNegotiatedPayloadTypes`）は、`isCodecCompatible`（MIME + clockRate + channels + H264のmode / profile）で「交渉済みcodecの設定上の対応物」を探していた。見つかると**設定上の形式に書き換えて**提示していた。developは `transceiver.codecs` をそのまま再提示していたので、この書き換えは起きなかった。
  - その結果、実装自身が `samePayloadMapping` で「fmtp / rtcp-fbが違えば別codec」と定義しているのに、交渉済みPTのfmtp / rtcp-fbを再オファーで書き換えていた（RFC 3264 §8.3.2 のPT不変則に違反）。
- 非承認レビューは毎回「両peerのcodec設定が**非対称**な公開APIシナリオ」をHEADとdevelopで比較していた。一方、修正側の自己検証（9.3の2400行マトリクス、`tools/negotiation-diff`、model property）はどれも**両peerに同じ設定**を渡しており、この次元を含んでいなかった。

修正前（`b527549ac`）に再現した非対称な相手との差分（設定変更なしの再オファー、answerer側）:

| 非対称な相手との交渉後の再オファー | develop | 修正前のHEAD |
| --- | --- | --- |
| H264 level差（相手 42e01f/98、自分 42e00d/96） | 98 / 42e01f を維持 | 96 / 42e00d に変わり、確定PTも96へ移る |
| 同上 + VP8併設 | 98を維持 | H264が97へ移る |
| H264 packetization-mode差 | 98 / mode 1 を維持 | 96 / mode 0 へ |
| opus fmtp差（相手 `minptime=10;useinbandfec=1`、自分 `stereo=1`） | fmtpを維持 | 同じPT 111のfmtpが `stereo=1` に変わる |
| VP8 rtcp-fb差（相手 nack/pli/remb、自分なし） | feedbackを維持 | 同じPT 100のrtcp-fbが消える |
| 設定にH264が2本（mode 1/96、mode 0/97）、相手は mode 0/98 | 98だけ | 96 mode 1 を追加提示し、相手のMIMEだけの照合で確定codecが mode 1/96 に切り替わる |

### 10.2 ルール

**交渉済みcodecは交渉済みの形式（PT・fmtp・rtcp-fb）のまま再提示し、設定上の対応物は交渉が使う述語と同じ述語で対応付ける。**

- `negotiatesAs(configured, negotiated)`（`codecCompatibility.ts`、export）を、交渉がcodecを対にする述語（MIME typeの一致）として1か所に置いた。`resolveRemoteCodecSet` のインライン比較もこの関数に置き換え、交渉と再オファーの述語を同じ関数にした。
- `withNegotiatedCodecs`: 方向で外れた交渉済みcodecの設定上の対応物を `negotiatesAs` で探す（以前は `isCodecCompatible`）。
- `keepNegotiatedPayloadTypes`:
  1. 設定codecを交渉済みcodecと、**まず `isCodecCompatible`（同じ形式）で、次に `negotiatesAs`（MIME type）で**対応付ける。対応したら**交渉済みcodecのオブジェクトそのもの**を置く（PT・fmtp・rtcp-fbは交渉済みのまま）。
  2. 対応相手の交渉済みcodecが別の設定codecに取られている同じMIME typeの設定codecは、「covered」として再提示しない。再提示すると、相手がMIME typeだけで照合して確定codecの形式が切り替わる（表の最終行）。
  3. 以前のanswerで外れたcodec（別MIME type）は従来どおり再提示する（#818）。PTは設定値、BUNDLE内で別codecが使っていれば空きPT。
  4. 提示したprimaryに対する交渉済みRTX / REDは、交渉済みのオブジェクトをそのまま置く（REDの比較は両辺 `?? ""`）。
- この結果、developとの差分は「以前のanswerで削られたcodecが増える」方向と、BUNDLE内のPT衝突回避（追加m-lineが、別m-lineで別の形式に使われているPTを避ける）だけに閉じる。非対称な相手に対しては、交渉済みm-lineの再オファーがdevelopと同一になる。
- 既知の制限（develop互換）: 同じMIME typeで形式の違うcodec（H264 mode 0 / mode 1 など）のうち、交渉で選ばれなかったものは再提示しない。交渉がMIME typeだけで対にするためで、交渉側の対応付けを形式単位にするのは本チケットの範囲外とする。
- ルールは `negotiatesAs` / `withNegotiatedCodecs` / `keepNegotiatedPayloadTypes` / `TransceiverManager.resolveOfferCodecs` / `NegotiationTransaction`（Codecs行）のTSDocと `changelog.md` の#818項に記載した。

### 10.3 回帰テスト

- [x] `tests/issue/818.test.ts`: 公開APIの非対称な2者（H264 level差、opus fmtp差、VP8 rtcp-fb差、設定H264 2本 vs 相手1本）。接続済みセッションで、answererの再オファーのrtpmap / fmtp / rtcp-fbが初回answerと同一であること、確定後もPT・fmtp・rtcp-fbが変わらないこと、`expectSessionContinues`（ハーネスが本体の後に実行）を確認する。修正前のHEAD（`b527549ac`）では4件とも失敗する。
- [x] `tests/issue/818.test.ts` の `rtcp-fb collision` ケース: 期待値を新ルールに合わせた（既存m-lineは交渉済みの `98 VP8`（feedbackあり）だけ、追加m-lineは `96 VP8`（feedbackあり）と `97 VP8`（feedbackなし））。修正前のHEADでは失敗する。
- [x] `tests/media/codecResolution.test.ts`: 交渉済みcodecが別fmtp / 別feedbackでもそのオブジェクトが置かれる、同じ形式 → MIME typeの順で対応付く、同じMIME typeの別の設定codecは再提示しない（covered）、交渉済みRTXがそのまま置かれる、`negotiatesAs` がMIME typeだけで対にする。
- [x] model property: oracle `offerCapability` に「交渉済みprimary codecは、PT・parameters・rtcpFeedbackがofferと一致する」を追加した。あわせて、peer bのcodec設定を別の形式にする非対称の軸（`asymmetricModelConfig`: VP8のPT 120 + NACK/PLIだけ、H264 level 42e00d、Opus `stereo=1`）を、pairingと同じく独立したseed streamで25%のシーンに入れた。修正前のHEADでは100 seed中 seed 87 がこのoracleで失敗し、修正後は100 seedすべて成功する。

### 10.4 自己検証への「非対称な相手」次元の追加（再発防止）

- `tools/negotiation-diff/lib.ts` の `session()` に、peer bだけに足す設定 `extraB` を追加した。
- `tools/negotiation-diff/run.ts` の設定軸に、非対称構成4種を追加した: `asymmetricPt`（bのPTが別）、`asymmetricH264`（bのH264がlevel 42e00d / mode 0 の2本）、`asymmetricOpus`（bのOpus fmtpが `stereo=1;useinbandfec=1`）、`asymmetricFeedback`（bのVP8 / H264にrtcp-fbなし）。
- 公開APIの非対称マトリクス（一時スクリプト `/tmp/asym818/asym.test.ts`）: codec構成14種（上の表の6行、逆向き2種、PT差で以前のanswerが削ったVP9、RTXの非対称2種、REDの非対称、方向付きcodec、対称）× 再オファーする側2種（offerer / answerer）× 操作4種（なし、`inactive`、m-line追加、2回続けて再オファー）= 112行。各行で初回answer、再オファー、2回目のanswer、両peerの確定codec（PT・fmtp・rtcp-fb）を記録し、develop（`41773f4dc`）・修正前のHEAD（`b527549ac`）・修正後で比較した。

| 比較（112行） | developと同一 | codecが増える（#818） | 追加m-lineがPT衝突を避ける | 交渉済みの形式が変わる |
| --- | --- | --- | --- | --- |
| 修正前のHEAD | 52 | 28 | 0 | **32** |
| 修正後 | 85 | 24 | 3 | **0** |

- 「追加m-lineがPT衝突を避ける」3行（`opusFmtp` / `vp8FbSelfNone` / `vp8FbRemoteNone` のanswerer + m-line追加）は、既存m-lineが相手の形式（例: `111 opus minptime=10;useinbandfec=1`）を交渉済みのまま提示し、追加m-lineの設定codec（`stereo=1`）が同じPTを使えないため空きPTへ移る行。developは同じPT 111に別のfmtpを載せていた（RFC 8859違反）。既存m-lineの再オファーと確定codecはdevelopと同一。
- 修正前のHEADが「codecが増える」とした行のうち4行（`h264Two` のofferer側）は、修正後developと同一になった。相手のMIMEだけの照合で mode 1/96 が確定しているため、mode 0 はcoveredとして再提示しない（10.2の既知の制限）。
- `tools/negotiation-diff` の非対称構成4種（各15 seed、12 step）をdevelop（`41773f4dc`）の一時worktreeと比較した。4種ともregression 0、divergence 0、hang 0、HEADだけの失敗0、transceiver state difference 0。

### 10.5 検証結果（§10の対応）

対象は `b527549ac` に未コミットの変更（`codecCompatibility.ts`、`transceiverManager.ts`、`negotiationTransaction.ts`、テスト、model property、`tools/negotiation-diff`、ドキュメント）を加えた状態。

| 確認 | 結果 |
| --- | --- |
| `npm run type`（rootとwebrtc） | エラー0 |
| `cd packages/webrtc && npm test` | 89ファイル、1871件成功、5件スキップ（ICE系の環境要因による失敗はこの機体では出なかった） |
| 新規・更新テスト | `818.test.ts` の非対称4件と `rtcp-fb collision` は修正前のHEAD（`b527549ac`）で失敗し、修正後に成功 |
| model property（100 seed） | 成功。修正前のHEADでは seed 87 が新しいoracle（交渉済みの形式）で失敗 |
| 公開APIの非対称マトリクス（112行） | 交渉済みの形式が変わる行は0（修正前のHEADは32）。差分はcodecの追加24行とPT衝突回避3行だけ（10.4） |
| `tools/negotiation-diff`（非対称4構成 × 15 seed、develop比較） | regression / divergence / hang / failure / state difference すべて0 |
| `npm run pbt:deep` | fuzz・scenario・modelは失敗0（flakyは単独で成功）。leakは heap seed 4 だけが失敗し、developの一時worktreeでも同じく失敗する（18.56 KiB/cycle、上限16、既存の問題。9.6参照） |
| `npm run wpt` | regression 0。`codecs-subsequent-offer` はPASS |

- 1回目の `pbt:deep` で、model / leak の seed 171 が失敗した。原因はテストの設定だった。非対称構成のVP8をPT 120にしていたが、wire mutation `codecRenumbered` もH264を「未使用」のPT 120へ移すため、同じPTに2つのcodecが載る不正なSDPができていた（修正前のHEADでも同じく失敗）。非対称構成のVP8をPT 110に変えて解消した。scenario seed 214 は単独で3回、所属shard（seed 211〜217）で2回再実行し、すべて成功した（並列負荷下のflaky）。
- 一時スクリプトと結果は `/tmp/asym818`（`asym.test.ts`、`classify.py`、`dev.json` / `head.json` / `final.json`）と `/tmp/nd818` に残した。
