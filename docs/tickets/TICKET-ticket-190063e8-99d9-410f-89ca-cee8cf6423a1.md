# [ICE/SDP] ICE restartを伴わないBUNDLE再交渉で候補を繰り返し広告する問題を改善する（#269）

## 1. 目的と背景

- 元Issue: #269（koush）。**妥当な最適化課題（developで再現可能）**。
- werift はローカルSDPを作るとき、m-line ごとに、その m-line が使う ICE transport の全 candidate と `a=end-of-candidates` を書いている。BUNDLE で全 m-line が 1 つの transport を共有していても、同じ candidate 一覧が m-line の数だけ繰り返される。そのため、長く続く BUNDLE 接続で addTrack などの再交渉を重ねると、SDP サイズが「m-line 数 × candidate 数」に比例して大きくなる。
- スコープは**冗長な SDP 候補列挙（と、それに伴うトリクルの重複）の削減**に限る。ICE 再交渉そのものの不具合とは扱わない。#270（未使用ソケットの累積）とは独立している。

### 現状の実測（develop `9234d0b74`、ローカル 2 PC、STUN なし、BUNDLE 確立後に video を 1 本ずつ追加して再オファー）

| 時点 | m-line 数 | `a=candidate` 行 | `a=end-of-candidates` | SDP bytes |
| --- | --- | --- | --- | --- |
| 初回 offer（収集後の localDescription） | 2 | 24 | 2 | 3,793 |
| 再オファー 1 | 3 | 36 | 3 | 5,724 |
| 再オファー 3 | 5 | 60 | 5 | 9,586 |
| 再オファー 5 | 7 | 84 | 7 | 13,448 |

transport は 1 つで、candidate は 12 個しかない。それでも m-line が 1 本増えるたびに約 1.9KB（12 candidates + eoc）増える。BUNDLE の非tag m-line に載っている candidate はすべて重複である。

## 2. 現行コードの根拠

| 箇所 | 内容 |
| --- | --- |
| `packages/webrtc/src/sdpManager.ts` `addTransportDescription()`（L192–235） | `describedLocalGeneration()` が返す generation の `candidates` / `complete` / `parameters` を、**m-line 単位で無条件に** `media.iceCandidates` / `iceCandidatesComplete` / `iceParams` に設定している。BUNDLE の tag かどうかは判定していない。 |
| 同 `createMediaDescriptionForTransceiver()` L131 / `createMediaDescriptionForSctp()` L185 | `buildOfferSdp()` / `buildAnswerSdp()` で m-line を作るたびに、上の関数を呼んでいる。 |
| 同 `buildAnswerSdp()` L921–927 | pending proposal 用に用意した transport（`transportByMid`）で、もう一度 `addTransportDescription()` を呼ぶ。 |
| 同 `setLocal()` L1176–1240 | 候補収集や end-of-candidates のたびに、`_localDescription` の全 m-line を `addTransportDescription(..., { applied })` で書き直す（`peerConnection.ts` L878– の `onIceCandidate` 購読から呼ばれる）。 |
| 同 `negotiatedBundleTags`（L795） | 確定した answer の BUNDLE tag（group の先頭 MID）。`buildOfferSdp()` の group 順序付けで使われている。 |
| `packages/webrtc/src/transport/ice.ts` `describedLocalGeneration()`（L278） | live または staged（ICE restart）の generation から、credentials・candidates・complete を返す。 |
| `packages/webrtc/src/negotiation/bundleTopology.ts` `isBundledNonTag()`（L83） | 受信側はすでに、**非tag m-line の candidate と ICE/DTLS パラメータを無視する**（`remoteMediaApplication.ts` L494–525、`remoteCandidates.ts` L244）。そのため werift 同士なら、送信側で非tag の candidate を省いても受信結果は変わらない。 |
| `packages/webrtc/src/peerConnection.ts` L1412–1451 | offer/answer/pranswer の適用後、`takePreparedCandidateTransports()` で新しく用意した transport の candidate をまとめてトリクルし直す。同じ generation の既存 transport は対象外。ICE restart のときは `emitStagedIceCandidates()` / `emitCommittedIceCandidates()` が新しい generation を通知する。 |

## 3. 仕様上の位置づけ（実装前に条文を再確認すること）

- **RFC 8843（BUNDLE）§7** と **RFC 8859** の TRANSPORT カテゴリ: BUNDLE を交渉した後は、candidate などのトランスポート属性を tag の m-section にだけ載せ、他の bundled m-section には載せない、という扱い。JSEP（RFC 8829）§5.2.2 / §5.3.2（subsequent offer / answer）の bundled m-section の扱いも合わせて確認する。
  → **非tag m-line の candidate と end-of-candidates を省くのは仕様に沿う方向**であり、第一の改善対象とする。
- **RFC 8839 §4.4.1.1.2 など**（ICE 実行中の既存ストリームを再オファーする場合）: 「通知済みのローカル候補をすべて含める」という要求がある。Completed 後の扱い（選択ペアのローカル候補だけにするか）は RFC 5245 §9.1.2.2 と RFC 8839 で違いがあるため、要確認。
  → **tag m-line の candidate まで省くのは仕様上グレー**なので、既定では行わない（下の Phase B）。
- **W3C webrtc-pc**: `localDescription` / `pending|currentLocalDescription` は、収集済みのローカル候補を含んでいる必要がある。tag m-line に全候補が残っていればこの要件は満たせる。WPT に影響が出るかは `npm run wpt` で確認する。

## 4. 実装内容

### Phase A（本チケットの必須範囲）: BUNDLE 非tag m-line の candidate / end-of-candidates を省く

1. **判定ロジック**を `SDPManager` に追加する。例: `omitsBundledCandidates(media, dtlsTransport, description)`。次の**すべて**を満たすときだけ省く。
   - `bundlePolicy !== "disable"`
   - 確定 answer の BUNDLE group が存在する（`negotiatedBundleTags` が空でない）。最初の offer、pranswer の段階、BUNDLE がまだ確定していない状態では省かない。
   - 当該 m-line の MID が、生成中の description の BUNDLE group に含まれていて、しかも group の tag ではない（offer では `orderBundleMids()` 後の先頭、answer では `buildAnswerBundleGroups()` の先頭）。
   - 当該 m-line の transport が tag m-line の transport と**同一**である。pending-only transport（max-compat / balanced で新しく追加した m-line、BUNDLE owner の変更、`transportByMid` で別の transport が割り当てられたもの）は対象外とし、従来どおり全候補を載せる。
   - port ≠ 0（rejected m-line にはもともと candidate を載せていない）
2. **適用箇所**: `addTransportDescription()` の candidate 設定部分に判定を入れる。tag は group から決まるので、m-line ごとに呼ぶ時点ではまだ group が確定していない。そのため次のどちらかの方法で処理する。
   - (a) `buildOfferSdp()` / `buildAnswerSdp()` の最後、group を付けた後に「非tag の `iceCandidates = []`、`iceCandidatesComplete = false`」をまとめて適用する後処理関数を通す。
   - (b) `setLocal()` の再描画（候補収集時の refresh）でも同じ後処理を呼ぶ。そうしないと、`createOffer()` の戻り値と、収集後の `localDescription` で形が変わってしまう。
3. **維持するもの**: `a=ice-ufrag` / `a=ice-pwd` / `a=ice-options:trickle` / `a=fingerprint` / `a=setup` / `a=mid` / BUNDLE group は、すべての m-line に今までどおり出力する。werift 自身の受信側が m-line ごとの ufrag で同じ generation かどうかを判定し（`deliverSameGenerationDescription`）、検証も m-line ごとに行っているため。`c=` / port は discard（`0.0.0.0` / 9）のまま変えない。
4. **end-of-candidates**: tag m-line にだけ出力する。受信側はすでに `completeSharedTransportMedia()` で group 全体に反映している。
5. **トリクル**: 同じ generation の再交渉で既存の candidate が `icecandidate` イベントとして再発火しないことを、テストで固定する（現状でも発火しない想定）。新しい transport や ICE restart のときの通知（`takePreparedCandidateTransports` / `emitStagedIceCandidates`）は変えない。
6. **ICE restart**: 新しい generation の candidate は tag m-line に必ず載ること、非tag を省いても restart が完了することを確認する。
7. **設定**（後方互換のため）: `PeerConfig` に `mLineReuse` / `keyFrameRequestRouting` と同じ形の選択式オプションを追加する。名前の例は `bundleCandidates: "compatible" | "tagOnly"`。
   - 既定値をどちらにするかは、Chrome / Firefox / mediasoup interop の E2E 結果を見て決める。安全側の案は `"compatible"`（現行の動作）を既定にし、仕様準拠の `"tagOnly"` を opt-in にするもの。既定値を `"tagOnly"` に切り替えるなら changelog で明示する。
   - WPT 固有の厳密な挙動が必要な場合は、`tools/wpt-runner/*` のラッパー内に閉じ込める（root AGENTS.md Do 5）。

### Phase B（任意・分割可）: tag m-line の同一 generation 候補も省く

- ICE が connected/completed で、ICE restart がなく、transport も変わっていない subsequent offer/answer に限り、tag m-line に選択ペアのローカル候補だけを載せる（または候補を載せない）モード。
- RFC 8839 の「Running 中は全候補を含める」要求、W3C の localDescription の要件、非 Trickle の相手（`canTrickleIceCandidates === false`）との兼ね合いがあるため、**既定にはせず opt-in に限る**。本チケットで扱わず、別チケットに分けてもよい。

## 5. 制約・注意点

- **negotiation 変更として扱う**（`packages/webrtc/AGENTS.md` Do 6–8）。
  - 作成した description を後で適用・再適用するときの形が変わるため、`tools/negotiation-diff` で develop と比較し、差分 0 を保つ。差分が出る場合は、その差分が意図したものだと説明できること。
  - レビュー前に `npm run pbt:deep` を実行する。
- `setLocal()` の `applied` 分岐（max-compat で最初に tag だった m-line が別の transport に移ったとき、その credentials を保持するロジック）を壊さない。
- rollback では pending description を捨てて current に戻るので、判定の基準は確定 answer（`negotiatedBundleTags`）だけにし、pending の状態を見ない。
- BUNDLE の tag が変わる場合（tag の m-line を stop/reject して別の MID が tag になる場合）、新しい tag の m-line は必ず全候補を持つこと。
- 相手が BUNDLE を部分的に拒否したり、group から m-line を外したりして transport が分かれた後の offer では、分かれた m-line に自分の候補を載せる。
- ICE-lite（自分または相手）でも、tag m-line の候補と `a=ice-lite` は従来どおり出力する。
- コーデック、RTP ヘッダ拡張、SSRC、direction の再交渉には影響させない。
- 既存アプリが、非tag m-line の `a=candidate` を前提に SDP を解析しているかもしれない（SFU 連携など）。このため設定で切り替えられるようにし、README（`packages/webrtc/README.md` と `doc/README.md` の `mLineReuse` 節と同じ形式）と `changelog.md` に記載する。
- `enum` は使わない。`as const` のオブジェクトと同名の union 型（`@enum` タグ付き）で定義する（root AGENTS.md）。
- テスト用サーバーやブラウザは、パターン指定の kill ではなく PID で止める。

## 6. テスト計画

| 観点 | 置き場所（AGENTS.md の規約に従う） |
| --- | --- |
| BUNDLE 確立後に addTrack / removeTrack / createDataChannel で再交渉（restart なし）しても、`a=candidate` の総数が transport の候補数のまま一定で、非tag の m-line に candidate と eoc がないこと | `tests/negotiation/cases/` の `negotiationCase` ケース（Arrange/Act/Assert のコメントは日本語、最後に `expectSessionContinues`） |
| 「`tagOnly` のときは、どの操作列の後でも、確定 BUNDLE の非tag かつ tag と同じ transport の m-line に candidate がない」 | `tests/pbt/model/oracles.ts` の oracle として追加 |
| 同じ generation の再交渉で `icecandidate` が再発火しないこと（SDP とトリクルの両方で重複がないこと） | model oracle（trickle 系）または個別ケース |
| ICE restart 後、新しい generation の候補が tag m-line とトリクルで通知され、接続が続くこと | negotiation case |
| BUNDLE の owner（tag）変更、max-compat / balanced での新しい m-line、bundlePolicy `disable`、rollback、pranswer、ICE-lite で接続できること | negotiation case（具体的な BUNDLE/ICE 値を使うので個別テスト） |
| `"compatible"` で現行の出力と完全に一致すること（後方互換） | 同上、または `tests/sdp.test.ts` |
| Chrome / Firefox との再交渉の相互接続（tagOnly） | `e2e/`（他実装の SDP は `tests/negotiation/cases` で捏造しない） |
| SDP サイズと候補数の測定（上の表の再現と改善の確認）。ソケット数は #270 の範囲なので、増えていないことの確認だけ行う | 測定スクリプトまたはテストのログ |

## 7. 検証コマンド

- `cd packages/webrtc && npm run type && npm test`
- `cd packages/webrtc && npm run pbt:deep`
- `tools/negotiation-diff`（develop との比較。`git worktree add --detach` で作った一時 worktree で実行する）
- `npm run wpt`（localDescription の候補要件の回帰確認）
- `npm run e2e`（Chrome との再交渉）。`integration/werift-mediasoup-interop` に影響がありそうなら、その AGENTS.md の手順にも従う。
- `npm run format`、公開 API を変えた場合は `npm run doc`

## 8. 完了条件

- [ ] `tagOnly`（仮称）で、ICE restart なしの BUNDLE 接続に m-line を N 本追加して再交渉しても、`a=candidate` の総数が transport の候補数（上の実測では 12）のまま一定で、SDP サイズの増加が m-line 本体の分だけになる。
- [ ] 非tag の m-line に `a=candidate` / `a=end-of-candidates` がなく、`ice-ufrag` / `ice-pwd` / `fingerprint` / `setup` / `mid` は残っている。
- [ ] 最初の offer、BUNDLE 未確定、pranswer、rollback、tag の変更、transport の分離、bundlePolicy `disable` では、従来どおり全候補を出力する（fallback）。
- [ ] ICE restart で新しい generation の候補が確実に通知され、接続が続く。
- [ ] 同じ generation の再交渉で、トリクルによる重複通知がない。
- [ ] `"compatible"` の出力が develop と一致する（既定値をどうするか決め、その理由を changelog に記録する）。
- [ ] package テスト、`pbt:deep`、negotiation-diff、WPT、E2E（Chrome）がすべて通る。
- [ ] README、`doc/`、`changelog.md` にオプションと挙動を記載する。
