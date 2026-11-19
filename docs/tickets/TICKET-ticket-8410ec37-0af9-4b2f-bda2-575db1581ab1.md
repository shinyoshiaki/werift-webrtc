# [ICE] Check empty sdpMid fallback to sdpMLineIndex for Pion interoperability

## Problem（原文）
A downstream report from dTelecom/server-sdk-node describes ICE candidate addition failing against Pion when `sdpMid: ""` is supplied together with a valid `sdpMLineIndex`. The downstream workaround removes the empty MID and resolves by m-line index.

In current `develop`, `packages/webrtc/src/negotiation/remoteCandidates.ts` appears to select MID lookup whenever `typeof sdpMid === "string"`, including the empty string, instead of falling back to the index. It is not yet established whether the empty MID is standards-valid in this scenario, so the desired behavior should be determined before changing validation.

## Scope（原文）
This is an interoperability investigation, not a claim that every empty MID must be accepted. Distinct from #705 (unsupported RTP m-lines in SDP answers).

---

## 1. 目的と背景

- Pion（`pion/webrtc`）とそれを使う SFU（LiveKit 系の dTelecom など）は、trickle candidate を `ICECandidate.ToJSON()` の結果として送る。Pion v4 の `ToJSON()` は `SDPMid: &c.SDPMid, SDPMLineIndex: &c.SDPMLineIndex` を返し（`icecandidate.go`、確認済み）、`ICECandidateInit` のフィールドは `*string` / `*uint16` である（`icecandidateinit.go`、確認済み）。つまり、MID を持たない candidate は **null ではなく `sdpMid: ""`** として JSON に出る。
- werift の `addIceCandidate()` は `""` を「MID 指定あり」とみなす。`""` を mid に持つ m-line は存在しないので、`OperationError("Media section for sdpMid was not found")` で reject される。下流は `sdpMid` を消して index に委ねる workaround で回避している。
- 目的は次の 3 点。
  1. 空 MID + 有効 index の扱いを、仕様・ブラウザ・互換性の観点で決める。
  2. 決めた挙動を **1 か所で一貫して** 実装する。
  3. BUNDLE / 非 BUNDLE のどちらでも、candidate が誤った m-line（誤った ICE transport）に入らないことを回帰テストで固定する。

## 2. 現状のコード調査結果

### 2.1 `sdpMid` を判定する箇所（両方とも `typeof sdpMid === "string"`）

| 箇所 | 役割 | `sdpMid: ""` での挙動 |
| --- | --- | --- |
| `packages/webrtc/src/negotiation/remoteCandidates.ts` `apply()` の `targetMedia`（L101-108） | candidate を current と pending のどちらの ICE generation（ufrag）に送るかを選ぶ | `muxId === ""` の m-line は無いので `[]` になる。`matchesUfrag` が常に false になり、`pending ?? current` が選ばれる（restart や部分 BUNDLE split のときに generation を誤選択する余地がある） |
| `packages/webrtc/src/secureTransportManager.ts` `resolveCandidateMediaIndices()`（L443-453） | 対象 m-line の index を解決し、`usernameFragment` で絞り込む | `findIndex` が -1 になり、`OperationError("Media section for sdpMid was not found")` で reject される。**下流で起きている失敗はこれ** |

- 入口は `RTCPeerConnection.addIceCandidate()`（`peerConnection.ts` L1820-）。ここで `normalizeCandidateUfrag()`（`remoteCandidates.ts`）を通したあと、remote description が無ければ `remoteCandidates.queued` に積み、あれば `remoteCandidates.apply()` を呼ぶ。キューは `validateQueued()`（`secure.addIceCandidate` を直接呼ぶ）と `flushQueued()`（`apply` を呼ぶ）で処理される。
- `IceCandidate.fromJSON()`（`transport/ice.ts` L1379-1380）は `sdpMid` を `?? undefined` で保持する。ただし `addIceCandidate()` が `targetMedia.rtp.muxId` で上書きするので、`""` が記録に残ることはない。
- `RTCIceCandidate` のコンストラクタと `toJSON()` は `sdpMid: ""` をそのまま保持する（ブラウザと同じ形なので変更不要）。
- SDP パーサー（`sdp.ts` L219）は `a=mid:`（空値）を `muxId = ""` として保持する。一方、`getTransportByMid()` は falsy な mid に対して transport を返さない。そのため、空の `a=mid` を持つ remote SDP はもともとサポート外である（このチケットでは扱わない）。
- werift 自身が送出する candidate の `sdpMid` は、`allocateMid()` が割り当てた非空の mid か `undefined` である（`handleNewIceCandidate`）。werift 同士の通信には影響しない。

### 2.2 既存のポリシーとテスト

- `transport/iceCandidateAttribute.ts` の TSDoc に「Not adopted: the W3C constructor TypeError when both `sdpMid` and `sdpMLineIndex` are null（werift の利便性を維持。strict は WPT runner 側）」とある。空 MID の扱いも、同じ「werift 既定 API の互換挙動」として文書化する前例になる。
- `peerConnection.ts` の L113-134 に W3C 互換ノートがあり、`addIceCandidate()` が `sdpMid` / `sdpMLineIndex` / `usernameFragment` を検証すると書かれている。
- upstream WPT（`third_party/wpt/webrtc/RTCPeerConnection-addIceCandidate.html`）には **空の `sdpMid` を使う subtest は無い**（`sdpMid: 'invalid'` → OperationError と、両方 null → TypeError のみ）。したがって、正規化を入れても `wpt/baseline.json` の subtest は変わらない見込みである（要確認）。
- WPT runner の `addIceCandidate` override（`tools/wpt-runner/runner.ts` L768-）は、remote description が無いときの InvalidStateError だけを担当している。
- 既存の addIceCandidate ルーティングテストは `tests/integrate/peerConnection.test.ts`（L434-）にある。BUNDLE 2 m-line の SDP fixture `addIceCandidateWptSdp`（L975-）はファイルローカルで、mid は `a1` / `v1`、ufrag は m-line ごとに別である。
- `packages/webrtc/AGENTS.md` Do 6 により、`tests/negotiation/cases` には他実装の description や candidate を捏造して置けない。Pion 形の candidate fixture は `tests/integrate/`（または `tests/issue/`）に置く。
- Pion を相手にする E2E ハーネスはリポジトリに無い（`e2e/` は Chrome / Firefox、`integration/` は mediasoup のみ）。

## 3. 仕様とブラウザの挙動（調査結果と未確認事項）

| 対象 | `sdpMid: ""` + 有効な `sdpMLineIndex` | 確度 |
| --- | --- | --- |
| W3C webrtc-pc `addIceCandidate` | 「If candidate.sdpMid is not null → mid が一致しなければ OperationError / Else, if sdpMLineIndex is not null → index」。`""` は null ではないので MID の分岐に入り、index へのフォールバックは無い。**仕様に厳密に従えば OperationError**。また RFC 5888 の `identification-tag` は token（1 文字以上）なので、mid `""` はそもそも有効な値ではない | 手順の構造は確認済み。spec の原文の引用は実装時に再確認する |
| libwebrtc（Chrome） | ネイティブ側の `sdp_mid` は `std::string` で、null と `""` を区別しない。`SdpOfferAnswerHandler::FindContentInfo`（`pc/sdp_offer_answer.cc`）は `!candidate->sdp_mid().empty()` のときだけ mid で検索し、それ以外は `sdp_mline_index` で解決する、と記憶している。→ **index へフォールバックする** | **未検証**（記憶ベース）。実装時にソースを確認する |
| Firefox | `PeerConnection.sys.mjs` の `_addIceCandidate` が `sdpMid \|\| ""` を渡し、`JsepSessionImpl::AddRemoteIceCandidate` は mid が空なら level（index）を使う、と記憶している | **未検証**。実装時に searchfox で確認する |
| Pion `AddICECandidate` | 受信側は candidate 文字列だけを使い、`SDPMid` / `SDPMLineIndex` はほぼ見ない（単一 ICE transport のため） | **未検証** |

→ 仕様は reject を求める。一方、主要ブラウザ（libwebrtc 系）はおそらく index にフォールバックし、実際に流通している Pion の送出形式は `""` である。この食い違いは、「werift の既定 API は互換挙動、strict は WPT runner」という既存の方針（root AGENTS.md Do 5）で吸収できる。

## 4. 方針の決定（推奨案）

### 4.1 選択肢の比較

| 案 | 長所 | 短所 |
| --- | --- | --- |
| A. `""` を常に「MID なし」とみなす | 単純 | `sdpMid: ""` かつ index なしの end-of-candidates が「全 m-line」に広がる。仕様では reject される入力を広く受け入れてしまう |
| **B. `sdpMid === ""` かつ `sdpMLineIndex` が数値のときだけ、MID なしとして index で解決する（推奨）** | Pion / 下流の問題を直す。Chrome の挙動（推定）と一致する。index が無い場合は仕様どおり reject のままにでき、受け入れ範囲が最小で済む | 仕様の厳密な挙動からは外れる（文書化が必要） |
| C. `""` を明確なエラーメッセージで reject する | 仕様に厳密 | 下流の問題が直らない。Chrome 互換でもない |

### 4.2 推奨する挙動（案 B）

| 入力 | 挙動 |
| --- | --- |
| `sdpMid` が非空文字列 | 現行どおり MID で検索する（index は無視。WPT の「Invalid sdpMLineIndex should be ignored if valid sdpMid is provided」を維持） |
| `sdpMid === ""` かつ `sdpMLineIndex` が数値 | **MID なしとして扱い、index で解決する**。範囲外の index は現行どおり `OperationError("Media section for sdpMLineIndex was not found")` |
| `sdpMid === ""` かつ `sdpMLineIndex` が null / undefined | 正規化しない。仕様どおり OperationError。メッセージは「sdpMid is empty and no sdpMLineIndex was given」のように原因が分かるものにする（end-of-candidates も同じ） |
| `sdpMid` が null / undefined | 現行どおり |

- `usernameFragment`（プロパティ、または candidate 文字列の `ufrag` トークン）があれば、index で選んだ m-line の ufrag と照合し、一致しなければ現行どおり OperationError にする。これが「index が誤った m-line を指していた」ことを検出する最後の砦になる。
- WPT runner の wrapper には strict な reject を **追加しない**。この入力を検証する upstream subtest が無いので、追加しても dead code になる。spec との差異は TSDoc に「Not adopted」として明記する。将来 upstream にテストが追加されたら wrapper 側で strict にする、と書いておく。

## 5. 実装すべき変更

1. **正規化ヘルパーを 1 つ追加する**（`remoteCandidates.ts` の `normalizeCandidateUfrag` の隣。例: `normalizeEmptyCandidateMid(message)`）
   - `RTCIceCandidate` インスタンスは `toJSON()` してから、`RTCIceCandidateInit` はコピーしてから `sdpMid` を外す（`normalizeCandidateUfrag` と同じ流儀で、呼び出し元のオブジェクトを変更しない）。
   - `RTCPeerConnection.addIceCandidate()` で `normalizeCandidateUfrag()` の直後、**キューに積む前** に適用する。こうすれば `apply()`（generation 選択）、`validateQueued()`、`flushQueued()`、`secure.addIceCandidate()` のすべてが同じ正規化済みの値を見る。
   - 代案: `remoteCandidates.targetMedia` と `resolveCandidateMediaIndices` の両方が使う「target 解決関数」を共通化してもよい。その場合も、2 か所の判定が食い違わないことをテストで保証する。
2. **空 MID かつ index なしの場合のエラーメッセージを改善する**（`resolveCandidateMediaIndices`）。エラーの型は OperationError のまま。
3. **TSDoc とドキュメントを更新する**
   - `RemoteCandidates` クラスの TSDoc（「`sdpMid`, else `sdpMLineIndex`」の箇所）に、空 MID の扱いを書く。
   - `peerConnection.ts` の W3C 互換ノート（L119 付近）に、「`sdpMid: ""` + 数値 index は index で解決（libwebrtc / Pion 互換、W3C では OperationError）」を追記する。
   - `iceCandidateAttribute.ts` の「Not adopted」段落に、同じ趣旨の 1 文を追加する（任意。互換ノートを 1 か所に集約するならそちらを参照するだけでもよい）。
   - `changelog.md`: v0.28.0 はリリース済みなので、次リリースのセクション（無ければ作る）の Bug Fixes に追記する。
   - 公開 API の型は変わらないので、`npm run doc` は TSDoc の差分が出る場合だけ実行する。

## 6. テスト（回帰 fixture）

配置: `packages/webrtc/tests/integrate/` に専用ファイル（例: `remoteCandidateTarget.test.ts`）を作る。共有の Arrange（SDP fixture、Pion 形の candidate ビルダー、「candidate がどの m-line に入ったか」を判定するヘルパー）は 1 つのユーティリティファイル（例: `remoteCandidateTargetUtils.ts`）にまとめる。必要なら、`peerConnection.test.ts` のローカル fixture（`addIceCandidateWptSdp` と `isCandidateLineBetween`）もこのユーティリティへ移して共用する。各テストは Arrange / Act / Assert で書き、Act と Assert に日本語のコメントを付ける。

必須ケース:

| # | トポロジー | 入力 | 期待 |
| --- | --- | --- | --- |
| 1 | BUNDLE 2 m-line（m-line ごとに ufrag が別） | Pion 形 `{candidate, sdpMid: "", sdpMLineIndex: 0}` | m-line 0 の `a=candidate` に入り、m-line 1 には入らない。m-line 0 の ICE transport に届く |
| 2 | 同上 | `{sdpMid: "", sdpMLineIndex: 1}` | m-line 1 にだけ入る |
| 3 | 同上 | `{sdpMid: "", sdpMLineIndex: 0, usernameFragment: <m-line 1 の ufrag>}`（または candidate 文字列の `ufrag` が不一致） | OperationError。どの m-line にも記録されない |
| 4 | 同上 | `{sdpMid: "", sdpMLineIndex: 5}`（範囲外） | OperationError |
| 5 | 同上 | `{sdpMid: ""}`（index なし。candidate あり / end-of-candidates の両方） | OperationError（改善後のメッセージ）。全 m-line へ広がらない |
| 6 | 同上 | `RTCIceCandidate` インスタンス（`new RTCIceCandidate({..., sdpMid: "", sdpMLineIndex: 0})`） | #1 と同じ。呼び出し元のインスタンスは変更されない |
| 7 | 同上 | remote description 適用 **前** に Pion 形 candidate を追加 | キューに積まれ、SRD 後に #1 と同じ m-line に入る。SRD は reject されない |
| 8 | 非 BUNDLE（`bundlePolicy: "disable"`、または BUNDLE group の無い remote offer。m-line ごとに transport が別） | `{sdpMid: "", sdpMLineIndex: 1}` | m-line 1 の transport だけに届き、m-line 0 の transport には届かない |
| 9 | 回帰 | 非空の `sdpMid` + 誤った index | 現行どおり MID が優先される（既存の WPT 相当の挙動を維持） |

任意ケース（リスクの洗い出し用）:
- ICE restart 中（pending の re-offer で ufrag が変わる）に、`sdpMid: ""` + index + 旧 ufrag の candidate を追加すると、current の generation に送られることを確認する（`apply()` の `targetMedia` が正規化済みの値を見ていることの確認）。
- 実際の werift ⇔ Pion の接続テストは、リポジトリに Go / Pion ハーネスが無いので **スコープ外** とし、必要なら follow-up にする。

## 7. 制約・注意点

- **誤った m-line への割り当てリスク**: 環境によっては、Pion が送る `sdpMLineIndex` が常に 0 になる可能性がある（呼び出し元は未確認）。
  - BUNDLE（Pion / LiveKit の通常構成）では、全 m-line が tag の transport を共有するので、index 0 でも正しい transport に届く。
  - m-line 0 が rejected（port 0）だと、`isRejectedMedia` の経路で candidate は受理されるが、どの transport にも届かない（黙って捨てられる）。仕様上は index が指す m-line に従うのが正しい挙動なので、変更はしない。この挙動はテストか TSDoc で明示する。
  - 非 BUNDLE で Pion が全 m-line を同じ ufrag / 単一 transport で扱う構成では、index 0 の candidate は m-line 0 の transport にしか届かない。これは既存の制約で、このチケットでは解決しない（ufrag 照合でも区別できない）。ドキュメントに既知の制約として残す。
- 正規化は werift 既定 API の互換挙動である。WPT の strict 挙動を `src` に入れてはならず、逆に互換挙動のために WPT の結果を落としてもならない（root AGENTS.md Do 5）。`npm run wpt` で `RTCPeerConnection-addIceCandidate*.html` が baseline から後退しないことを確認する。
- `src/negotiation/*` に触れるので、negotiation 変更の扱いになる。`packages/webrtc` の `npm test`（PBT の固定シーンを含む）を実行する。generation 選択（`apply()`）に影響するなら、レビュー前に `npm run pbt:deep` も実行する。Pion 形の fixture は `tests/negotiation/cases` に置かない（AGENTS.md Do 6）。
- 受け入れる入力を最小に保つ。`sdpMid: ""` + index なしは受け入れない。`" "` などの空白だけの MID は正規化しない（RFC 5888 の token ではないが、`""` と同列に扱う根拠が無い）。
- このチケットは #705（answer 中の未サポート RTP m-line）とは別件で、混ぜない。
- 実装前に、§3 の「未検証」の項目（libwebrtc `FindContentInfo`、Firefox `_addIceCandidate` / `AddRemoteIceCandidate`、Pion `AddICECandidate`）をソースで確認する。結果が推奨案の前提（ブラウザは index へフォールバックする）と違えば、§4 の決定を見直す。

## 8. 完了条件

- [ ] §3 の未検証の項目をソースで確認し、その結果（ブラウザの挙動と仕様との差異）をこのチケットか PR 本文に記録した。
- [ ] 空 MID の扱い（推奨は案 B）を決め、互換性と仕様のトレードオフを TSDoc（`RemoteCandidates`、`peerConnection.ts` の互換ノート）に記載した。
- [ ] 正規化を `addIceCandidate()` の入口（キューに積む前）の 1 か所で行い、`apply()` の generation 選択と `resolveCandidateMediaIndices()` が同じ解決結果になる。
- [ ] `sdpMid: ""` + index なしは OperationError のままで、原因が分かるメッセージになっている。
- [ ] §6 の必須ケース 1〜9 を Arrange / Act / Assert と日本語コメント付きで追加し、共有 Arrange を 1 つのユーティリティファイルにまとめた。
- [ ] BUNDLE と非 BUNDLE の両方で、candidate が誤った m-line / transport に入らないことをテストで確認した。
- [ ] `cd packages/webrtc && npm run type && npm test` が通る（`host-dependent` な既知の失敗はベースラインと比較する）。
- [ ] `npm run wpt` で addIceCandidate 系の subtest が baseline から後退しない。
- [ ] `changelog.md` の次リリースのセクションに Bug Fix として記載し、`npm run format` を実行した。

## 9. 実装時の確認結果（§3 の未検証項目）

| 対象 | ソースで確認した挙動 | 出典 |
| --- | --- | --- |
| libwebrtc | `SdpOfferAnswerHandler::FindContentInfo` は `!candidate->sdp_mid().empty()` のときだけ mid で検索する（一致しなければ INVALID_PARAMETER）。空なら `sdp_mline_index() >= 0` で index 解決（範囲外は INVALID_RANGE）。両方無ければ「Neither sdp_mline_index nor sdp_mid specified.」 → **空 MID は index へフォールバック** | `pc/sdp_offer_answer.cc`（webrtc-sdk/webrtc の master ミラー） |
| Firefox | `PeerConnection.sys.mjs` の `_addIceCandidate` が `sdpMid \|\| ""` を渡す。`JsepSessionImpl::AddRemoteIceCandidate` は `!mid.empty()` なら mid、そうでなく level があれば `GetTransceiverForLevel`、どちらも無ければ OperationError → **空 MID は index へフォールバック** | gecko-dev master |
| Pion v4 | `AddICECandidate` は candidate 文字列だけを使い、`SDPMid` / `SDPMLineIndex` を読まない（`newICECandidateFromICE(cand, "", 0)`）。`ToJSON()` は `SDPMid: &c.SDPMid`（`string` フィールドへのポインタ）なので、MID 未記録なら `""` が出る | `peerconnection.go`, `icecandidate.go`（master） |
| W3C webrtc-pc | 「`candidate.sdpMid` is not null」で MID 分岐に入り、一致しなければ OperationError。`""` は null ではないので index 分岐に入らない → **仕様に厳密なら reject**（ステップ構造からの推論） | https://w3c.github.io/webrtc-pc/ |

→ 前提（主要ブラウザは index へフォールバック）が確認できたので、§4 の案 B で実装した。仕様との差異は `normalizeEmptyCandidateMid`（`remoteCandidates.ts`）と `peerConnection.ts` の W3C 互換ノートに記載した。upstream WPT（`third_party/wpt/webrtc`）に空の `sdpMid` を使う subtest は無い（grep で確認）ので、WPT runner の wrapper は追加していない。
