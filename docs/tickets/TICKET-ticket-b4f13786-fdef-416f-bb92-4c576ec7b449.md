# [WebRTC] Do not reuse a transceiver in addTrack after negotiating a sending direction without a track

## 1. 目的と背景

### Problem
Downstream の gifos-app で、Node 参加者の音声が相手に聞こえない問題が報告された。原因は、`addTrack()` が別ストリーム用に確保されていた trackless の transceiver を再利用したことにある。その transceiver はすでに送信方向で交渉済みだった。
(https://github.com/nwcnwc/gifos-app/commit/4573b1a5d1834af4beb972755aafb478dbcdbe94)

- gifos-app では、job の m-line や pipe 予約などの trackless な送信用スロットを `addTransceiver()` で作って交渉している。後から `addTrack()` した本人の声がそのスロットに入り、スロット側の stream 名 (MSID) で送られる。相手ページはそれを別スロットとして扱い、本人の音声として再生しない。
- gifos-app の回避策: `addTrack` / `setLocalDescription` / `setRemoteDescription` の前後に `getTransceivers()` を走査し、`currentDirection` が `sendrecv` / `sendonly` のものに `usedForSender = true` を外から書き込んでいる。**この回避策は公開フィールド `usedForSender` への書き込みに依存しているので、フィールドは書き込み可能なまま残す。**

### 仕様
W3C webrtc-pc `addTrack()` は、`[[Sender]]` を再利用してよい条件を次のように定めている。
https://w3c.github.io/webrtc-pc/#dom-rtcpeerconnection-addtrack

- sender が「送信に使われたことがない」こと。
- より正確には、紐づく transceiver の `[[CurrentDirection]]` が一度も `"sendrecv"` / `"sendonly"` になったことがないこと。
- 加えて `[[SenderTrack]]` が null、kind が一致、`[[Stopping]]` が false であること。

判定は「track を持っていたか」ではなく、「交渉で送信方向になったことがあるか」で行う。Chrome もこの判定をしている。`RtpTransceiver::set_current_direction()` が送信方向のときに `has_ever_been_used_to_send_` を立て、addTrack の再利用候補探索はこのフラグを見る。pranswer での扱いと rollback で戻らないことは、実装時に Chromium のソースで再確認する。

### 現状の develop (HEAD `a71ee5d4d` で確認)
- `packages/webrtc/src/media/rtpTransceiver.ts`
  - `usedForSender = false` (公開フィールド、`doc/classes/RTCRtpTransceiver.md` に記載あり)
  - `setCurrentDirection()` は、送信方向で **かつ `this.sender.track` があるとき** だけ `usedForSender = true` にする。
  - `setDirection()` は、呼ばれた時点の `_currentDirection` が送信方向なら `usedForSender = true` にする。これはヒューリスティックで、アプリが `setDirection` を呼ばない交渉経路は拾えない。
- `packages/webrtc/src/transceiverManager.ts` `addTrack()`
  - `reusableForTrack`: `sender.track == undefined && kind 一致 && !usedForSender && !stopping && !stopped && !rejected && !pendingRejection`
  - 候補を 2 段階で探す。まず `direction` が送信方向のもの (`emptyTrackSenderTransceiver`)、次に送信方向でないもの (`notSendTransceiver`、direction を recvonly→sendrecv / inactive→sendonly に上げる)。どちらもなければ `createdBy: "addTrack"` で新規作成する。
- `currentDirection` を書き込む経路 (すべて `setCurrentDirection()` を通る):
  - local answer / pranswer: `peerConnection.ts` の `# configure direction` (`t.setCurrentDirection(direction)`、1692 行付近)
  - remote answer / pranswer: `transceiverManager.ts` の m-line 適用 (`["answer","pranswer"].includes(type)`、1309 行付近)
  - rollback: `RTCRtpTransceiver.restoreNegotiationState()` は baseline の `currentDirection` に戻す。`TransceiverManager` の rollback (313 行付近) は、トランザクション中に追加した transceiver を `createdNegotiationState` に戻してから `setCurrentDirection(undefined)` する。
  - 停止確定: `commitStopped()` / `negotiationTransaction.ts` commit の `setCurrentDirection("stopped")`

### 再現 (HEAD `a71ee5d4d`、werift 同士、スクリプトで確認済み)
| シナリオ | `currentDirection` | `usedForSender` | `addTrack()` の結果 |
| --- | --- | --- | --- |
| offerer: `addTransceiver("audio")` (sendrecv, trackless) → 交渉 | `sendonly` | `false` | **同じ transceiver を再利用** (バグ) |
| offerer: `addTransceiver("audio", {direction:"sendonly"})` → 交渉 | `sendonly` | `false` | **同じ transceiver を再利用** (バグ) |
| answerer: remote offer が作った transceiver を `direction = "sendrecv"` にして trackless で answer | `sendrecv` | `false` | **同じ transceiver を再利用** (バグ) |
| sendonly で交渉 → `setDirection("inactive")` → 再交渉 | `inactive` | `true` | 新規作成 (`setDirection` のヒューリスティックで偶然正しい) |

`setDirection` を通らない経路では、送信方向で交渉した事実が失われる。例えば、相手の再 offer で `inactive` / `recvonly` になる場合や、`setDirection` を呼ばずに再交渉する場合がこれに当たる。

## 2. 実装すべき変更

1. **送信方向で交渉した履歴を、track と無関係に記録する。**
   - `setCurrentDirection(direction)` が `sendrecv` / `sendonly` を受けたら、`sender.track` の有無に関係なく `usedForSender = true` にする。
   - このフラグは単調に増えるだけにする (sticky)。後の `recvonly` / `inactive` への再交渉、`replaceTrack(null)`、`removeTrack()`、rollback のいずれでも false に戻さない。
2. **`setDirection()` の `usedForSender` 書き込みは削除する。** 1 の変更で包含されるうえ、desired direction (`direction`) の変更を交渉履歴と混同させるためである。
3. **rollback / provisional answer の扱いを仕様と照らして決め、TSDoc とテストに記録する** (方針は 3 章)。
4. **再利用してよいケースは維持する。** 送信方向で交渉したことがない trackless transceiver は、これまでどおり addTrack の再利用対象にする。対象は、remote offer が作った recvonly のもの、`addTransceiver(kind, {direction: "recvonly" | "inactive"})`、未交渉の `addTransceiver(kind)` である。
5. **`replaceTrack()` の挙動は変えない。** 送信方向で交渉済みの trackless transceiver に track を載せたいアプリは、`sender.replaceTrack(track)` を使う。
6. **ドキュメントを更新する。**
   - `usedForSender` の JSDoc を新しい意味に合わせる。例: 「`currentDirection` が一度でも `sendrecv` / `sendonly` になった transceiver。`addTrack()` は再利用しない (W3C addTrack)」。コメントは短くし、根拠はテストへのリンクで示す (直前のチケットの方針)。
   - `npm run doc` で `doc/` を再生成する。
   - `changelog.md` の Unreleased に挙動変更を追記する。内容は「trackless で送信方向に交渉した transceiver を addTrack が再利用しなくなった。その枠に送るには replaceTrack を使う」。既存アプリの挙動が変わるので、"Breaking changes" に入れるかどうかも検討する。

## 3. 技術的アプローチ (調査結果)

### 修正点は 1 か所に集約できる
`currentDirection` の書き込みはすべて `RTCRtpTransceiver.setCurrentDirection()` を通る。local/remote の answer、pranswer、rollback、停止確定のいずれも同じである。このメソッドで送信方向を見たときにフラグを立て、決して下ろさないようにすれば、全経路をまとめて覆える。

```ts
setCurrentDirection(direction: CurrentDirection | undefined) {
  this._currentDirection = direction;
  this.sender.setSendSuppressed(/* 既存のまま */);
  if (direction && direction !== "stopped" && SenderDirections.includes(direction)) {
    this.usedForSender = true; // track の有無は問わない。下ろさない
  }
}
```

### pranswer / rollback の方針 (推奨: 単調な sticky フラグ、スナップショット対象外)
- W3C では pranswer の適用でも `[[CurrentDirection]]` が設定される。そのため、pranswer で送信方向になった時点で「一度でも送信方向になった」が成立する。
- werift は JSEP に従い、`have-local-pranswer` / `have-remote-pranswer` からの rollback を受け付ける (`negotiationTransaction.ts` の遷移表)。W3C の `setLocalDescription` / `setRemoteDescription` は pranswer 状態からの rollback を拒否するので、W3C だけではこの組み合わせの扱いが決まらない。
- 推奨: `usedForSender` は `snapshotNegotiationState()` / `restoreNegotiationState()` の対象に**入れない**。pranswer の後に rollback しても戻さない。理由は次のとおり。
  - pranswer 中は provisional traffic が実際に流れ得るし、相手にはその MID / MSID で送信方向が伝わっている。
  - 保守側に倒した場合の最悪の結果は「新しい transceiver が作られる」だけで、メディアの誤配送は起きない。
  - Chrome の `has_ever_been_used_to_send_` も rollback で戻らない (実装時に要確認)。
  - `createdNegotiationState` へ戻す rollback (トランザクション中に追加された transceiver) も同じ扱いにする。この方針を `usedForSender` の TSDoc と negotiationCase で固定する。
- 確定済みの履歴は、rollback が baseline の `currentDirection` を `setCurrentDirection()` で戻すときにも失われない (sticky なので)。「desired direction (`direction`) と negotiated direction (`currentDirection`) を混同しない」ことは、`setDirection` からフラグ操作を外すことで担保する。

### addTrack 側
- `reusableForTrack` の条件は変えなくてよい。`!usedForSender` の意味が仕様どおりになる。
- 候補の優先順位 (送信方向の候補を先に探す 2 段階探索) は、仕様の「集合の最初の transceiver」とは異なる。ただし本チケットの範囲外とする。変えると #816 の pairing テストなどに影響する。気づいた差分は別チケットにする。
- `noteReusedForAddTrack` / `createdBy: "addTrack"` (#816, #817, #821) の仕組みはそのまま使う。

### 影響範囲
- trackless の `addTransceiver(kind)` (既定 sendrecv) を交渉した後に `addTrack()` で埋めるコードは、新しい transceiver と m-line を作るようになる。`e2e/server/handler/**` の werift 側 `addTrack` 利用 (`removeTrack.ts` など) は、track 付きで送信済みのものを扱っているので、現状でも再利用されず影響はない。`examples/` の HTML はブラウザ側の addTrack なので対象外。
- `tests/pbt/model/generator.ts` の `takeTrack` / `addTrackApi` は、`applies` で `getTransceivers().length < 6` を条件にしている。再利用が減ると transceiver の数が増え、seed ごとの操作列が変わり得る。そのため `pbt:deep` は `--baseline` 付きで develop と比較する。
- WPT `webrtc/RTCPeerConnection-addTrack.https.html` の 2 subtest「…has been used to send should create new sender」「…has not been used to send should reuse the sender」は `wpt/baseline.json` で PASS になっている。修正後も PASS を維持すること。

## 4. 制約・注意点
- `packages/webrtc/AGENTS.md` Do 6 / 7 に従う。
  - 個別テストは `tests/negotiation/cases/` の `negotiationCase` / `describeCases` で書く。`ref`、日本語の `// Arrange:` / `// Act:` / `// Assert:` を付け、description 操作は `c.offer` / `c.setRemote` などを使う。各テストは `expectSessionContinues` で終える。
  - 「どの操作列の後でも、addTrack は送信方向になったことのある transceiver を再利用しない」は操作列に依らない主張なので、model property の oracle (`tests/pbt/model/oracles.ts`) として追加するのが望ましい。各 step 後に観測した `currentDirection` の履歴を transceiver ごとに持ち、`takeTrack` / `addTrackApi` が返した transceiver が新規か、送信方向の履歴がないことを検査する。見つかった失敗は `model/scenes.ts` に短い操作列として残す。
  - werift 自身が作る description だけを使う。他実装の SDP を捏造しない。ブラウザとの比較は WPT と e2e の責務。
- Arrange の共通処理は `tests/negotiation/harness/negotiationTransactionUtils.ts` の既存ヘルパーを再利用する (`addTrackTransceiver`、`createPeerPair` など)。必要なら RTP 到達確認ヘルパー (`tests/issue/705.helpers.ts` の `expectRtpDelivered` 相当) も使う。新しい共通 Arrange はこのファイルに置く。
- モジュールスコープに状態を持たない (root AGENTS.md の Don't)。フラグは transceiver のフィールドのまま持つ。
- `usedForSender` は公開 API で、gifos-app が書き込んでいる。readonly 化や改名はしない。
- 交渉や送信の挙動の変更なので、`npm run test:interop-develop` の対象になる可能性がある。少なくとも `tools/negotiation-diff` で develop と比較し、差分がこのチケットの意図した変化 (transceiver の数と m-line の数) だけであることを確認する。意図した差分は scenarios の契約か期待値として明示する。
- 作業ツリーを checkout / reset / stash しない。develop との比較は `git worktree add --detach` で行う。

## 5. 回帰テスト (追加するケース)
Arrange / Act / Assert の形で書き、各 Act / Assert に日本語コメントを付ける。

1. **trackless の送信方向を交渉した後の addTrack**: `addTransceiver(kind)` (sendrecv) と `{direction:"sendonly"}` のそれぞれについて、交渉後の `addTrack()` が別の sender / transceiver を返すこと。適格な候補がほかにあればそれ、なければ新規 (`createdBy: "addTrack"`)。
2. **sticky 性**: 1 の後に次のことをしても、addTrack が元の transceiver を再利用しないこと。
   - `recvonly` / `inactive` へ再交渉する。自分の `setDirection` 経由と、相手の再 offer 経由の両方を試す。
   - 交渉後に `replaceTrack(track)` → `replaceTrack(null)` を行う。
   - `removeTrack()` を行う。
3. **再利用は維持**: 送信方向で交渉したことのない trackless transceiver は再利用されること。対象は、remote offer 由来の recvonly、`addTransceiver(kind,{direction:"recvonly"|"inactive"})` を交渉したもの、未交渉の `addTransceiver(kind)` である。
4. **answer の経路**: local answer (answerer 側で `direction` を sendrecv にして trackless で answer) と remote answer (offerer 側) の両方。
5. **pranswer / rollback**:
   - pranswer で送信方向 → final answer、の後は再利用しない。
   - pranswer で送信方向 → rollback、の後も再利用しない (3 章の方針)。local pranswer と remote pranswer の両方。
   - トランザクション中に追加された transceiver の rollback (`createdNegotiationState` に戻る経路) も含める。
6. **MID / MSID の経路**: 1, 2 の後に addTrack した track の RTP が、新しい MID と addTrack に渡した stream の MSID で相手に届くこと。元の予約スロット (元の MID / MSID) には流れないこと。再交渉後も成り立つこと。
7. **ブラウザとの比較**: WPT `RTCPeerConnection-addTrack.https.html` の上記 2 subtest が PASS のままであること。必要なら Chrome と werift の組で同じ手順を確認する (e2e、または手元の Playwright スクリプト)。

## 6. 完了条件
- [ ] `setCurrentDirection()` が track の有無に関係なく、送信方向で `usedForSender` を立て、どの経路でも下ろさない。
- [ ] `setDirection()` から `usedForSender` の書き込みを外し、desired direction と negotiated direction を混同しない。
- [ ] pranswer / rollback の方針を `usedForSender` の TSDoc と、テストへのリンクに記録した。
- [ ] 5 章の 1〜6 を negotiationCase で追加し、addTrack の再利用適格性の oracle を model property に追加した (または、追加しない理由を記録した)。
- [ ] 1 章の再現表のバグ 3 行が修正後に「新規作成 / 別 transceiver」になる。
- [ ] `cd packages/webrtc && npm run type && npm test` が通る。
- [ ] `npm run pbt:deep -- --baseline <develop worktree>` の `summary:` が `0 confirmed`。
- [ ] `tools/negotiation-diff` の develop 比較で、意図しない差分がない。
- [ ] `npm run wpt` で `wpt/baseline.json` から後退しない。addTrack の 2 subtest は PASS のまま。
- [ ] `npm run doc` で再生成し、`npm run doc:check` が通る。`changelog.md` を更新した。
- [ ] `npm run format` を実行した。

## 関連
- #817 / #821: addTrack と関連付いた transceiver の rollback (本件の再利用適格性とは別問題)
- #816: addTrack / addTransceiver の生成元と JSEP 5.10 pairing (`createdBy`、`reusedForAddTrack`)
- #705: transceiver の stop と m-line 再利用

## 後続課題 (本チケットの範囲外、未起票)
`webrtc/RTCPeerConnection-setRemoteDescription-tracks.https.html` で見つかった、本件より前からある不足。本件では直していない。
- remote の `MediaStream` が `addtrack` / `removetrack` を発火しない。`wpt/allowlist.json` の `skippedSubtests` に 4 件を登録している。
- 同じ stream ID の remote track に別々の `MediaStream` が渡る。"addTrack() with two tracks and one stream …" の 1 件が FAIL する。上の 4 件の解除には、この共有も必要になる見込み (未検証)。
- remote track の `mute` / `unmute` を待つ 2 件が終わらない。同じく `skippedSubtests` に登録している (原因は未調査)。
- 解消したら該当の `skippedSubtests` を外し、PASS を `wpt/baseline.json` に反映する。
