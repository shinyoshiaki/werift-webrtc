---
ide:
  viewer: review-document
  version: 1
  title: "addTrack() は送信方向で交渉した transceiver を再利用しない"
  dock: right
  baseCommit: f6cc6ed8966ac31f83e3cdfd039adc721119ef83
---
# addTrack() は送信方向で交渉した transceiver を再利用しない

## 概要

`addTrack()` は、`currentDirection` が一度でも `sendrecv` / `sendonly` になった transceiver を、track がなくても再利用しなくなりました。以前は、アプリが別ストリーム用に交渉した trackless の枠へ本人の音声が入り、下流の gifos-app で相手に聞こえない問題が起きていました。`src` の変更は [packages/webrtc/src/media/rtpTransceiver.ts:221](review-diff:packages/webrtc/src/media/rtpTransceiver.ts:commit:18d233ca4:221) を中心にした 1 ファイルだけですが、**既存アプリでは transceiver と m-line が増える場合があります**。

対象は `73e59216d..f6cc6ed89` の差分です。

## 変更前後の流れ

<style>
.at-flow{font-family:var(--review-font);color:var(--review-fg);font-size:13px}
.at-flow .cols{display:flex;gap:12px;flex-wrap:wrap}
.at-flow .col{flex:1;min-width:260px}
.at-flow .box{border:1px solid var(--review-border);border-radius:6px;padding:6px 10px;background:var(--review-surface)}
.at-flow .arrow{text-align:center;color:var(--review-muted);line-height:18px}
.at-flow .bad{border:2px solid var(--review-danger)}
.at-flow .good{border:2px solid var(--review-success)}
.at-flow code{font-family:var(--review-mono)}
.at-flow .legend{color:var(--review-muted);margin-top:8px}
</style>
<div class="at-flow">
<div class="cols">
<div class="col">
<strong>Before</strong>
<div class="box"><code>addTransceiver("audio", {streams:[slot]})</code></div><div class="arrow">↓ offer / answer</div>
<div class="box"><code>setCurrentDirection("sendonly")</code></div><div class="arrow">↓</div>
<div class="box bad">✕ <code>sender.track</code> がないので<br><code>usedForSender = false</code> のまま</div><div class="arrow">↓ <code>addTrack(voiceTrack, voice)</code></div>
<div class="box"><code>reusableForTrack(slot)</code> → true</div><div class="arrow">↓</div>
<div class="box bad">✕ 予約枠を再利用<br>本人の音声が枠の MID に乗る</div>
</div>
<div class="col">
<strong>After</strong>
<div class="box"><code>addTransceiver("audio", {streams:[slot]})</code></div><div class="arrow">↓ offer / answer</div>
<div class="box"><code>setCurrentDirection("sendonly")</code></div><div class="arrow">↓</div>
<div class="box good">✓ track を見ずに<br><code>usedForSender = true</code>（以後下ろさない）</div><div class="arrow">↓ <code>addTrack(voiceTrack, voice)</code></div>
<div class="box"><code>reusableForTrack(slot)</code> → false</div><div class="arrow">↓</div>
<div class="box good">✓ 別の適格な候補か新規 transceiver<br>再交渉後、別の MID と MSID <code>voice</code> で届く</div>
</div>
</div>
<div class="legend">赤 ✕: 問題の箇所。緑 ✓: 修正で変わった箇所。枠線が細いものは変わっていません。図は、ほかに適格な候補がなければ新規作成になる例です。</div>
</div>

分かれ目はフラグを立てる条件だけです。候補を選ぶ [packages/webrtc/src/transceiverManager.ts:617](review-file:packages/webrtc/src/transceiverManager.ts:617) の `reusableForTrack` は変えていません。`!usedForSender` の意味が、W3C `addTrack()` の「送信に使われたことがない」に一致するようになりました。

## 主要変更

### 本体

- [packages/webrtc/src/media/rtpTransceiver.ts:221](review-diff:packages/webrtc/src/media/rtpTransceiver.ts:commit:18d233ca4:221): `setCurrentDirection()` から `sender.track` の条件を外しました。
- [packages/webrtc/src/media/rtpTransceiver.ts:212](review-diff:packages/webrtc/src/media/rtpTransceiver.ts:commit:18d233ca4:212): `setDirection()` はフラグを書かなくなりました。
- [packages/webrtc/src/media/rtpTransceiver.ts:56](review-diff:packages/webrtc/src/media/rtpTransceiver.ts:commit:18d233ca4:56): TSDoc を新しい意味に直し、テストへの `@see` を付けました。生成物は [doc/classes/RTCRtpTransceiver.md](review-diff:doc/classes/RTCRtpTransceiver.md:commit:18d233ca4) です。
- [changelog.md:3](review-diff:changelog.md:commit:18d233ca4:3): Unreleased の Breaking changes に追記しました。

`currentDirection` の書き込みは `setCurrentDirection()` を通ります。呼び出し元は、local の answer / pranswer（[packages/webrtc/src/peerConnection.ts:1698](review-file:packages/webrtc/src/peerConnection.ts:1698)）、remote の answer / pranswer（[packages/webrtc/src/transceiverManager.ts:1309](review-file:packages/webrtc/src/transceiverManager.ts:1309)）、rollback（[packages/webrtc/src/transceiverManager.ts:313](review-file:packages/webrtc/src/transceiverManager.ts:313) と [packages/webrtc/src/media/rtpTransceiver.ts:300](review-file:packages/webrtc/src/media/rtpTransceiver.ts:300)）、停止の確定（[packages/webrtc/src/negotiationTransaction.ts:337](review-file:packages/webrtc/src/negotiationTransaction.ts:337) など）です。そのため、修正を 1 か所に置くだけで全経路に効きます。

### テスト

- 回帰ケース: [packages/webrtc/tests/negotiation/cases/negotiationTransactionAddTrackReuse.test.ts:23](review-file:packages/webrtc/tests/negotiation/cases/negotiationTransactionAddTrackReuse.test.ts:23) に 19 件あります。再利用しないケース、再利用を維持するケース、pranswer と rollback、RTP が届く MID / MSID を確認します。
- 共通 Arrange と到達確認: [packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts:3860](review-file:packages/webrtc/tests/negotiation/harness/negotiationTransactionUtils.ts:3860) の `createReservedSendSlot` と `expectRtpOutsideReservedSlot` です。後者は、予約枠に RTP が漏れないことも確認します。
- model property の oracle: [packages/webrtc/tests/pbt/model/oracles.ts:382](review-diff:packages/webrtc/tests/pbt/model/oracles.ts:commit:18d233ca4:382) は、各操作後に送信方向を観測した transceiver が `addTrack()` から返らないことを検査します。固定シーン 3 件は [packages/webrtc/tests/pbt/model/scenes.ts:741](review-diff:packages/webrtc/tests/pbt/model/scenes.ts:commit:18d233ca4:741) にあります。
- 不安定だった RTP 確認の修正: [packages/webrtc/tests/negotiation/cases/negotiationTransactionAddTrackReuse.test.ts:200](review-diff:packages/webrtc/tests/negotiation/cases/negotiationTransactionAddTrackReuse.test.ts:commit:f6cc6ed89:200)

最後の修正の理由は次のとおりです。このケースは受信側 a の接続だけを待ち、b から RTP を 1 回だけ送っていました。a が `connected` でも b の DTLS が `connecting` の間があり、その間の RTP は捨てられます。一時テストでこの時点に送ると、8 回すべて失われました。現在は届くまで再送し、MID の対応も確認します。レビューで失敗した回は接続状態の記録がないので、同じ原因だったというのは推定です。

### develop との比較ツール

[packages/webrtc/tools/negotiation-diff/addTrackScenarios.ts:100](review-diff:packages/webrtc/tools/negotiation-diff/addTrackScenarios.ts:commit:016a41fd0:100) に 11 行を追加しました。8 行は意図した差、3 行は両側で同じになる対照です。

| 行の種類 | このブランチの期待値 | develop の期待値（`--expect develop`） |
| --- | --- | --- |
| 送信方向で交渉済み（8 行） | 新しい sender。transceiver 2、m-line 2 | 枠の sender を再利用。transceiver 1、m-line 1 |
| 対照（3 行） | 再利用。1 / 1 | 同じ |

相手の再 offer で枠が inactive になる行は、develop では再利用した枠にメディアが流れません。この点も期待値にしています（`silentOnDevelop`）。形と通信の有無を照合する処理は [packages/webrtc/tools/negotiation-diff/scenarios.ts:516](review-diff:packages/webrtc/tools/negotiation-diff/scenarios.ts:commit:016a41fd0:516) です。

### WPT の allowlist

[packages/webrtc/wpt/allowlist.json:4](review-diff:packages/webrtc/wpt/allowlist.json:commit:016a41fd0:4) で、`setRemoteDescription-tracks` の終わらない 6 subtest を skip にしました。本件より前からある不具合への対応です。`MediaStream` が `EventTarget` になった `5023f7aae` の後、werift が発火しない `addtrack` を待ち続け、後続の baseline subtest が報告されなくなっていました。内訳は `addtrack` 待ち 2 件、`removetrack` 待ち 2 件、track の mute / unmute 待ち 2 件です。`baseline.json` は変えていません。

## 判断理由

- **判定は交渉結果で行う。** track の有無（旧実装）や `setDirection()` の呼び出し（旧ヒューリスティック）では、相手の再 offer などで送信の履歴が落ちます。希望する方向の `direction` と、交渉結果の `currentDirection` も分けられます。
- **フラグは rollback の対象にしない。** werift は pranswer 状態からの rollback を受け付けます。pranswer の間はメディアが流れる可能性があり、相手にも送信方向が伝わっています。残す側に倒した場合の影響は、transceiver が余分に作られることです。rollback で復元する案は、この理由で採りませんでした。作成時の状態に戻る経路でも同じです。
- **`usedForSender` は書き込み可能な公開フィールドのままにする。** gifos-app の回避策が `true` を書き込んでいるため、readonly 化や改名はしていません。
- **候補の探索順は変えない。** 送信方向の候補を先に探す 2 段階の探索は、仕様の「最初の 1 件」と異なります。本件の範囲外です。
- **WPT は待ち続ける subtest だけを skip する。** イベント発火の実装は別の変更になるため、チケットの後続課題に記録しました。6 件全部を登録したのは、ファイルが時間切れになると SKIP も結果に表示されないためです。

## レビュアーが確認すべき点・リスク

1. **互換性が変わります。** trackless の `addTransceiver(kind)`（既定は sendrecv）を交渉してから `addTrack()` で埋めるコードは、別の transceiver を受け取ります。answerer が trackless で `sendrecv` を返した場合も同じです。新規作成になると m-line が増え、再交渉が必要です。枠に送るには `transceiver.sender.replaceTrack(track)` を使います。`replaceTrack()` の挙動は変えていません。
2. **rollback しても再利用できるようになりません。** pranswer で一度送信方向になれば、`currentDirection` が戻ってもフラグは残ります。
3. **「下ろさない」は werift 内部の動作です。** フィールドは書き込めるので、アプリが `false` を代入すれば再利用の対象に戻ります。
4. **Chrome との一致には未確認の部分があります。** 実装時の Chromium ソース確認では、`has_ever_been_used_to_send_` は direction で立ち、下ろすセッターはありませんでした。pranswer でも立つかは確認できていません。changelog の「a pranswer's included」は werift の挙動の説明です。直後の Chrome への言及を、pranswer の一致の根拠にはしないでください。
5. **WPT の skip は不具合の修正ではありません。** 対象ファイルは対応時点で PASS 7 / FAIL 1 / SKIP 6 でした。残る FAIL は、同じ stream ID の track に別々の `MediaStream` が渡る問題です。`addtrack` / `removetrack` が発火しない問題と、mute / unmute 待ちが終わらない問題（原因は未調査）も残ります。後続課題はチケット末尾にあり、別チケットは起票していません。

## 検証結果

この解説を作る作業では、テストを実行していません。以下はレビュー履歴にある実装担当とレビュー担当の報告です。この作業中、作業ツリーでは別プロセスの `npm run ci` が実行中でした。その結果はここに含めていません。

### 最終承認レビュー（3 回目、`f6cc6ed89`）

| 検証 | 報告された結果 |
| --- | --- |
| `packages/webrtc` の type と `npm test` | 成功（150 files、3450 tests） |
| `pbt:deep` | 0 confirmed。heap leak の seed 2、4 は develop でも再現 |
| WPT | baseline からの後退なし。addTrack は 12/12 PASS |
| `doc:check`、隔離 worktree での format と doc 再生成 | `doc:check` は成功。対象と生成 docs に追加差分なし |
| negotiation-diff | 固定シナリオは両側が各期待形状に一致。5 seed は差分 0。**200 seed は中断し、未完了** |

### 実装担当の補足

- 追加時点のテストを修正前のコードで実行すると、19 件中 15 件が失敗しました。自分の direction で recvonly / inactive にするケースと `removeTrack()` のケースは、旧ヒューリスティックにより修正前も成功します。
- `dbf6ab17e`（develop の取り込み後）では、negotiation-diff の 29 シナリオが両側の期待値に一致しました。200 seed でも退行、hang、状態差は 0 件でした。比較相手は `73e59216d` です。`dbf6ab17e` から `f6cc6ed89` までの変更は、テスト 2 ファイルとチケット文書だけです。
- 同じ時点の `pbt:deep` は、develop の再実行が既定の 3 回では heap leak 2 件が `2 confirmed` となり失敗しました。`--baseline-runs 10` では `0 confirmed` です。両側 6 回ずつの増加量はほぼ重なり、閾値は変えていません。ルートから実行すると `--baseline` が落ちる出力があったため、この結果は `packages/webrtc` で直接実行したものです。
- RTP 確認の修正後、該当ケースは `--retry=0` で 40 回、CPU 負荷下で 30 回、すべて成功しました。追加テストのファイル全体も 10 回すべて成功しました。`npm test` は通常設定で 3 回、`--retry=0` で 2 回実行し、毎回 3450 passed、194 skipped でした。
