# [WebRTC] addTrack後にreplaceTrack(null)したtransceiverがremote rollbackで消える問題を修正する（#817）

## 1. 目的と背景

### 元報告・判定
- 元Issue: [#817](https://github.com/shinyoshiaki/werift-webrtc/issues/817)（sidorares、OPEN）。**妥当**。
- `develop` の `2bf74a9b0` で Issue の最小再現を実行し、**再現を確認した**（下表）。
- W3C WebRTC 1.0 の rollback 手順では、remote offer の適用で作られた transceiver のうち **`addTrack()` で track が付けられたことのないもの**だけを除去する。いま sender が何を持っているかは判定に使わない。
- WPT `webrtc/RTCPeerConnection-setRemoteDescription-rollback.html`（`?rest`）の
  `"rollback of a remote offer should keep a transceiver without tracks"` が失敗する。Chrome / Firefox / Safari はこのテストに合格する。

### 現状挙動（`develop` 2bf74a9b0 での実測）
`a.addTransceiver("audio")` → `a` の offer → `b.setRemoteDescription(offer)` → 下の操作 → `b.setRemoteDescription({type:"rollback"})`

| `b` での操作（pending 中） | rollback後の数 / 同一object / `stopped` | W3C の期待 | 判定 |
| --- | --- | --- | --- |
| 何もしない | 0 / - / true | 除去 | OK |
| `addTrack(track)` | 1 / 同一 / false | 保持 | OK |
| `addTrack(track)` → `sender.replaceTrack(null)` | **0 / - / true** | 保持 | **NG（#817）** |
| `addTrack(track)` → `removeTrack(sender)` | **0 / - / true** | 保持 | **NG（同じ原因）** |
| `addTrack(track)` → `transceiver.stop()` | 1 / 同一 / false（`stopping === true` は保持） | 保持し、stopは残す | OK |
| `sender.replaceTrack(track)` だけ（addTrackなし） | 1 / 同一 / false | 除去（WPT `?interop-2026` "should remove touched transceiver"） | werift独自の便宜挙動（§4-1を参照） |

### 原因
- [`rtpTransceiver.ts` L253–261](../../packages/webrtc/src/media/rtpTransceiver.ts) の `heldByApplication` は `!!this.sender.track` の**現在値**しか見ない。
- [`transceiverManager.ts` `restoreNegotiationState()` L169–255](../../packages/webrtc/src/transceiverManager.ts)（L203 の分岐）は、この値が false なら remote offer が作った transceiver（`added` = `NegotiationTransaction.resources.remoteCreated`）を `removeRemoteTransceiver()` で除去する。
- `addTrack` 済みの transceiver に `sender.replaceTrack(null)` や `removeTrack()`（`sender.detachTrack()`）を呼ぶと、外れるのは今の track だけ。「`addTrack` で取得した」というアプリ操作の事実は残るはずなのに、rollback はそれを判定できない。

## 2. 実装する変更

1. **持続フラグを追加する**: アプリが `addTrack()` で transceiver に track を付けたことを、`sender.track` の現在値とは別に記録する。
   - `replaceTrack(null)` / `removeTrack()` / `stop()` ではクリアしない。
   - rollback の snapshot / restore の**対象外**にする。アプリ操作なので、rollback を越えて残す。
   - 記録には既存の `reusedForAddTrack` / `createdBy: "addTrack"` を使う（§3「フラグの置き場所」、§6）。
2. **`TransceiverManager.addTrack()`（L511–）で記録する**: 既存 transceiver を再利用する 2 つの分岐（`emptyTrackSenderTransceiver` / `notSendTransceiver`）で記録する。`addTransceiver(track)` にフォールバックする分岐もアプリ起源なので記録してよい。ただし、アプリ起源の transceiver は remote 生成集合に入らないため、rollback での除去判定には影響しない。
3. **rollback の保持判定を変える**: `heldByApplication` を「`addTrack` で取得済み **または** sender が今 track を持つ」にする。
   - remote 生成かつ未取得のものだけを除去する。
   - 保持したものは既存の L203–212 の経路をそのまま通す（作成時状態へ戻し、MID / mLineIndex を外し、`notifiedRemoteTrack` を削除する）。stop / sender を不当に失効させない。
4. **remote 起源かどうかの識別**: 新しいフラグは作らない。既存の `NegotiationTransaction.resources.remoteCreated`（`rememberRemoteTransceiver()`）をそのまま使う。replacement offer の `carried`、`restoreCheckpoint` の差分集合も同じ集合から導かれるので、一貫性が保たれる。
5. **ドキュメント（TSDoc）を更新する**（AGENTS: ルールは実装の TSDoc に書く）
   - `rtpTransceiver.ts` の `heldByApplication` の TSDoc。"As in develop, only a track counts" を新しい規則に書き換える。stop / direction / codec preferences だけでは保持しない点は残す。
   - `transceiverManager.ts` のクラス TSDoc（L109–112 "Rollback removes it unless the application attached a track (`heldByApplication`)"）。
   - `negotiationTransaction.ts` L170 の表の `TransceiverManager` 行（"transceivers the application uses (`heldByApplication`)"）。
6. **`changelog.md`**: 次バージョンの 🐛 Bug fixes に追記する（#817）。

## 3. 技術的アプローチ（調査結果）

### フラグの置き場所
当初は `src/negotiation/internalState.ts` のモジュールスコープの WeakSet に置いたが、追加要件（§6）によりモジュールスコープの状態はやめた。
- remote 生成の transceiver に `addTrack()` を使うと、既存の `reusedForAddTrack`（`TransceiverManager.noteReusedForAddTrack()`）が立つ。rollback が除去するのは remote 生成のものだけなので、このフラグで判定できる。新しいフラグは作らない。
- `addTrack()` が新しく作った transceiver は `createdBy: "addTrack"` で判定する。どちらもインスタンスの状態で、snapshot / restore の対象外。

```ts
// rtpTransceiver.ts
get heldByApplication() {
  return (
    this.createdBy === "addTrack" ||
    this.reusedForAddTrack ||
    !!this.sender.track
  );
}
```

### 既存の `!!sender.track` 条件は残す（互換性）
- `tests/pbt/model/generator.ts` の `attachTrack` / `answerAfterChange` は `sender.replaceTrack(track)` で remote 生成 transceiver に track を付け、`w.oracles.application(t)` で「保持される」と期待している。
- `tools/negotiation-diff/run.ts` の `remoteOfferAppOpRollback`（`appOp: "replaceTrack"`）も、develop の「保持」と一致している必要がある。
- そのため `!!sender.track` を外して W3C 厳密挙動（`?interop-2026` "should remove touched transceiver"）にすると、既存のプロパティテストと develop 比較が壊れる。AGENTS Do 5（厳密挙動は wpt-runner wrapper へ）にも反する。**このチケットでは OR 条件にして #817 だけを直す。**

### 影響を受ける経路の確認
| 経路 | 場所 | 修正後の期待 |
| --- | --- | --- |
| 明示 rollback | `NegotiationTransaction.rollback()` → `restoreState(baseline, remoteCreated, …)` | 取得済みは保持し、未取得は除去する |
| replacement offer（implicit） | `NegotiationTransaction.replace()` | `carried` は従来どおり作成時状態へ戻す。carried でない取得済みは L203 の経路で保持する |
| 失敗操作の巻き戻し | `restoreCheckpoint()`（`before` に無い remoteCreated だけを対象にする） | 同じ判定。checkpoint 中の addTrack も保持する |
| `stop()` 後の rollback | `restoreNegotiationState` の `applicationStopRevision` | `stopping` は残す（復活させない）。保持判定は flag と track のどちらでも成立する |
| sender の状態 | `restoreSendParams()` は track を戻さず codec だけを戻す | `replaceTrack(null)` 後も track は null のまま。`addTrack` の direction 変更（`_direction`）は snapshot 対象外なので保持される |

### 回帰テストの配置（`packages/webrtc/AGENTS.md` Do 6 に従う）
- 「どの操作列の後でも、アプリが使った transceiver は rollback で残る」という主張は、**model property の oracle と generator と scene** に置く。
  - `tests/pbt/model/generator.ts`: remote offer の pending 中に `pc.addTrack()` で remote 生成 transceiver を取得するステップ（`w.oracles.application(t)` を呼ぶ）を追加する。続けて track を外すステップ（`sender.replaceTrack(null)` / `pc.removeTrack(sender)`）を追加する。既存の `addTrack` ステップは実際には `addTransceiver(track)` なので、名前の衝突に注意する。
  - `tests/pbt/model/scenes.ts`: #817 の操作列を短い scene として固定する。`["a","offer"]`, `["b","addTrack…",{index:0}]`, `["b","detachTrack",{index:0}]`, `["b","rollback"]`, `["a","offer"]`。removeTrack 版も同様に作る。
  - `tests/pbt/model/oracles.ts` の rollback oracle（L566–630 付近、`applicationTransceivers` が残ることを検証）は既存のまま有効。必要なら「保持した transceiver は同一 object で `stopped === false`」を明示的に検証する項目を追加する。
- 既存の scene "rollback … removes the transceiver it created after the application's stop / direction / codecPreferences (as develop)" が引き続き通ること（未取得なら除去）。
- Arrange 用ユーティリティが必要なら `tests/negotiation/harness/negotiationTransactionUtils.ts` の `createKeptRemoteTransceiver()` を拡張・再利用する。テストの Act / Assert には日本語コメントを付ける。
- **WPT**: `packages/webrtc/wpt/allowlist.json` の `RTCPeerConnection-setRemoteDescription-rollback.html`（`?rest`）の `subtests` に `"rollback of a remote offer should keep a transceiver without tracks"` を追加し、`npm run wpt` で `baseline.json` を更新する。
  - 同じ `?rest` の "should keep a transceiver" と "…created by addtrack" は `receiver.transport === null` も検証する。実測では保持した transceiver の `receiver.transport` は非 null のままなので、このチケットの範囲外とする（必要なら別チケット）。

## 4. 制約・注意点

1. **W3C 厳密挙動とのずれ**: `addTrack` なしの `replaceTrack(track)` で保持される werift の挙動は残す。`?interop-2026` の "should remove touched transceiver" は引き続き不合格で、allowlist には入れない。これを直すかどうかは別途決める（develop 比較と既存 oracle の見直しが必要）。
2. **develop との意図的な差分**: 「addTrack → replaceTrack(null) / removeTrack → rollback」だけが develop と違う結果になる。
   - `tools/negotiation-diff` の既存 op（`remoteOfferAppOpRollback` は先に `replaceTrack(null)` を呼んでから `appOp` を実行する）では、`appOp: "addTrack"` も最終的に track を持つ。このため差分は 0 のままのはず。`--check` と比較の差分数が 0 であることを確認する（AGENTS Do 8、一時 worktree で実施）。
   - 新しい op をこの比較ツールに足すと develop との差分として検出される。足す場合は意図的な差分として扱う。基本は model property 側でカバーする。
3. **フラグの寿命**: `remoteCreated` は transaction 単位なので、フラグは sticky（クリアしない）でよい。後続の transaction では、remote 生成集合に入らない transceiver のフラグは判定に使われない。replacement offer で carried された transceiver は同じ transaction 内なので、フラグが残っていることが正しい。
4. **leak**: 判定に使う状態は transceiver 自身のフィールドなので、transceiver の寿命に従う。`tests/pbt/leak` の `leakFootprint` に新しい metric は不要。
5. **公開 API**: 新しいフラグは internal に留める。`doc/` の再生成は不要の見込み。公開クラスにフィールドを足した場合は `npm run doc` で再生成する。
6. **Arrange / Act / Assert**: 日本語コメント、共有 Arrange ユーティリティの再利用（root / package AGENTS）。
7. **作業手順**: 長時間の検証（`pbt:deep`、`wpt`）の前に、revision・未コミット差分・意図を記録する（root AGENTS Do 8）。develop との比較は `git worktree add --detach` で作った一時 worktree で行う。

## 5. 完了条件

- [ ] SRD(remote offer) → `addTrack` → `sender.replaceTrack(null)` → SRD(rollback) の後、`getTransceivers().length === 1` で、元と同一の object、`stopped === false`、`mid === null`。
- [ ] 上の `replaceTrack(null)` の代わりに `removeTrack(sender)` を使っても同じく保持される。
- [ ] `addTrack` しなかった remote 生成 transceiver は rollback で除去される。stop / direction / codecPreferences だけの scene も従来どおり除去される。
- [ ] track を保持したままの rollback、`replaceTrack(track)` だけでの保持（互換挙動）、別 transceiver への `addTrack`、複数回の rollback / replacement offer、`stop()` 後の rollback（`stopping` が残る）が回帰しない。
- [ ] model property に generator ステップと #817 の scene を追加し、oracle で検証する。
- [ ] WPT allowlist に "rollback of a remote offer should keep a transceiver without tracks" を追加し、`npm run wpt` が PASS し、`baseline.json` を更新する。
- [ ] `heldByApplication` / `TransceiverManager` / `NegotiationTransaction` の TSDoc を新しい規則に更新し、`changelog.md` に追記する。
- [ ] 検証: `cd packages/webrtc && npm run type && npm test`、`npm run pbt:deep`、`npm run wpt`、`tools/negotiation-diff` で develop との差分数が 0 で `--check` が成功、`npm run format`。
- **最終条件:** アプリが `addTrack` で使った transceiver を、track の瞬間値によって rollback で誤って削除しない。

## 6. 追加要件: モジュールスコープの状態をなくす

レビュー中のコードメモ（`internalState.ts` 行 56「グローバルスコープの変数を状態管理に使うのは避けたい」）を受けて追加した要件。`packages/webrtc/src` のモジュールスコープの可変状態を洗い出し、次のすべてを状態の寿命の持ち主に移す。再発防止の指示を `AGENTS.md` に入れる。

### 対象と対応
| # | 場所（修正前） | 対応 |
| --- | --- | --- |
| A1 | `negotiation/internalState.ts` `attachedByAddTrack`（WeakSet） | 削除。`heldByApplication` は `createdBy === "addTrack" \|\| reusedForAddTrack \|\| !!sender.track`（§3） |
| A2 | `negotiation/internalState.ts` `applicationStops`（WeakMap） | `RTCRtpTransceiver` の `private _applicationStopRevision` と `@internal` getter `applicationStopRevision` に移す。`internalState.ts` には型と `ridRouteKey` だけが残る |
| B3 | `media/track.ts` `sourceCodecsByTrack` / `sourceCodecsCapturedByTrack` | `MediaStreamTrack` の `@internal` フィールド `sourceCodecs` / `sourceCodecsCaptured` に移す。公開関数 `setTrackSourceCodecs` / `getTrackSourceCodecs` / `captureTrackSourceCodecs` の signature は変えない |
| B4 | `media/receiver/receiverTwcc.ts` `receiverTwccByTransport` | DTLS transport ごとの共有 TWCC と参照数を `RTCDtlsTransport` の `@internal sharedReceiverTWCC` に移す |
| B5 | `polyfill/sourceIo.ts` `let udpSocketFactory` / `setUdpSocketFactory()` | 削除。`udp` source の `@internal createSocket` option で渡す。テスト（`withUdpSocketCounter`）は register に factory を渡す |
| B6 | `nonstandard/dummyMedia.ts` `let nextDummySourceId` | 削除。各 dummy source が作成時に SSRC・初期 sequence・初期 PictureID を乱数で決める（RFC 3550 5.1 / 8.1）。当初は作る側ごとに `sourceId` を数える形にしたが、別々の `MediaDevices` の source が同じ SSRC・sequence になる回帰があったため（レビュー指摘）、採番をやめた。`tests/nonstandard/navigator.test.ts` で別々の `MediaDevices` の 4 source の SSRC が異なることを確認する |

### 残すもの（プロセス全体で共有するのが仕様）
- `polyfill/sourceIo.ts` `streamHubs`: キーはアプリの stream で、1 つの reader でしか読めないため共有が必要。宣言に理由のコメントを付ける。
- `RTCDtlsTransport.localCertificate` / `localCertificatePromise`: 既定の `certificateScope: "process"` の公開キャッシュ。
- `navigator`（公開シングルトン）、dtls の `Flight.RetransmitCount` / `DtlsSocket.AlertSendTimeoutMs`（公開 static 設定値）。インスタンスごとの設定にするのは API 変更なので別途。

### 再発防止
- root `AGENTS.md` の Don't に「モジュールスコープ（最上位の `let`、モジュールレベルの `Map` / `Set` / `WeakMap` / `WeakSet`・カウンタ・キャッシュ、書き換え可能な `static`）に実行時の状態を置かない。持ち主のインスタンスのフィールド（`private` か `@internal`）に置き、テスト用の差し替え口は option で渡す。仕様で共有するものは宣言に理由を書く」を追加する。
- `packages/webrtc/tests/moduleState.test.ts` で `packages/webrtc/src` を検査する。許可リスト外の宣言、許可リストに残った消えた宣言、検出パターン自体の誤りを検出する。

### 完了条件（追加分）
- [ ] 上表 A1〜B6 のモジュールスコープの状態が `packages/webrtc/src` からなくなり、`moduleState.test.ts` が通る。
- [ ] 公開 API（公開関数の signature、生成 docs）が変わらない。生成 docs の差分は `heldByApplication` の TSDoc だけ。
- [ ] root `AGENTS.md` に再発防止の指示がある。
- [ ] 検証: `npm run type`、`cd packages/webrtc && npm test`、`npm run pbt:deep -- --suite model,leak`（失敗 seed は develop と比較）、`npm run wpt`、`tools/negotiation-diff/scenarios.ts --check 1`、`npm run doc`、`npm run format`。
