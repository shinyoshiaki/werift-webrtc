---
ide:
  viewer: review-document
  version: 1
  title: "ICE restart が新しい設定の意味を守る（e793c42a）"
  dock: right
  baseCommit: 32a2c83e59fe7bf8dacd435f8c6e6784bedf0a9a
---
# ICE restart が新しい設定の意味を守るようにする（レビュー解説）

## 1. 概要

`setConfiguration()` が起こす ICE restart で、新しい `iceTransportPolicy` と `iceUseTcp` の意味が守られるようにしました。これまで restart は、保持している socket と候補をそのまま新しい generation に持ち込んでいました。そのため `all` から `relay` に変えても、host / srflx 候補が offer と trickle に漏れていました。

最終的な restart の挙動は次の 3 点です。

- 除外される保持 socket は閉じ、再広告もペア作成も着信チェックもしません。
- 判定は `packages/ice` の共通関数 1 か所にまとめました。
- 直近の再レビューでの指摘 2 件（relay 候補の `raddr` 漏れ、TURN 設定を変えた後の保持 allocation の扱い）も反映済みです。

本チケットの前半（TURN credential の再適用や、gathering 後の `needRestart`）は、これ以前のコミットで実装済みです。この文書は、追加要件 §6 とその後の再レビュー対応を中心に説明します。

## 2. 主要変更

### 2.1 判定の共通化（packages/ice）

[packages/ice/src/iceBase.ts:455](review-file:packages/ice/src/iceBase.ts:455) と、その下の 3 関数を公開しました。

| 関数 | 役割 |
| --- | --- |
| `mergeIceServerOptions()` | ICE server 設定の merge 規則です。server 系は undefined も含めて置換し、`forceTurn` / `useTcp` は指定時だけ変えます。`Connection.setIceServers()` と webrtc 層が共有します。 |
| `isRelayOnlyGathering()` | `forceTurn` だけで relay-only を判定します。 |
| `hasTurnServer()` | 使える TURN server と credential があるかを返します。 |
| `isCandidateAllowedByGatherOptions()` | 保持中の候補が、新しい generation で広告・ペア作成してよいかを判定します。 |

[packages/ice/src/iceBase.ts:509](review-diff:packages/ice/src/iceBase.ts:509) が判定の中心です。relay 候補は TURN 設定があるときだけ許可します。relay-only なら host / srflx を拒否します。`useTcp` が false なら TCP host を拒否します。

### 2.2 restart 時の socket 整理（packages/ice）

- [packages/ice/src/ice.ts:797](review-diff:packages/ice/src/ice.ts:797) では、`gatherCandidates()` が新しい generation の開始時に、除外される保持 socket を `protocols` から外して `close()` します。旧 TURN allocation は従来どおり別扱いで close します。
- [packages/ice/src/ice.ts:883](review-diff:packages/ice/src/ice.ts:883) の `allowsProvisional()` は、staged generation の gather options で除外される socket を provisional checklist から外します。保持中の TURN allocation は、server と credential が新しい設定と一致するときだけ使います。
- [packages/ice/src/ice.ts:958](review-diff:packages/ice/src/ice.ts:958) では、staged generation の着信チェックのうち除外 socket 宛てのものに応答しません。
- [packages/ice/src/ice.ts:1094](review-diff:packages/ice/src/ice.ts:1094) では、gather と check スケジューリングが同じ `isRelayOnlyGathering()` を使います。
- `useTcp` を false から true にした restart では、UDP socket を保持しているアドレスにも TCP host 候補を gather します。

### 2.3 relay 候補の `raddr` 秘匿

[packages/ice/src/ice.ts:1418](review-diff:packages/ice/src/ice.ts:1418) では、relay ポリシーのときに relay 候補の `relatedAddress` を `0.0.0.0:9`（IPv6 なら `:::9`）にします。TURN サーバーが観測した送信元アドレスを、SDP と trickle に載せないためです。ポート 9 は RFC 8839 §5.1 に従った値です。最初は 0 にしていましたが、この指摘で 9 に直しました。

### 2.4 restart offer / answer の候補絞り込み（packages/webrtc）

[packages/webrtc/src/transport/ice.ts:340](review-diff:packages/webrtc/src/transport/ice.ts:340) の `stageLocalRestart()` が、live 候補の全コピーをやめました。defer 中の ICE server を適用した `gatherOptions` を作り、許可された候補だけを offer / answer に載せます。`gatherOptions` は staged generation に保持し、`stageLocalCredentials()` にも渡します。commit 前に provisional checks が使う socket は、これで commit 後の gathering と一致します。

<div style="display:flex;gap:12px;flex-wrap:wrap">
  <div style="flex:1;min-width:260px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px">
    <strong>Before（all → relay の restart）</strong><br>
    offer に host / srflx を全コピー<br>
    保持 socket はそのまま再広告<br>
    relay 候補の raddr に実アドレス
  </div>
  <div style="flex:1;min-width:260px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px">
    <strong>After</strong><br>
    offer の候補は 0 件、commit 後は relay のみ trickle<br>
    host socket は commit 時に close<br>
    relay 候補の raddr は 0.0.0.0:9
  </div>
</div>

### 2.5 テスト

- [packages/webrtc/tests/transport/iceRestartConfigMatrix.test.ts:24](review-file:packages/webrtc/tests/transport/iceRestartConfigMatrix.test.ts:24) は設定 × 出力のマトリクスです。`needRestart`、offer の候補種別、trickle、新しい generation、`Connection.options`、TURN username、旧 allocation の close を確認します。
- [packages/webrtc/tests/transport/iceRestartConfigMatrix.test.ts:325](review-file:packages/webrtc/tests/transport/iceRestartConfigMatrix.test.ts:325) は offer 適用後・answer 前の relay 化を確認します。
- [packages/webrtc/tests/transport/iceRestartConfigMatrix.test.ts:378](review-file:packages/webrtc/tests/transport/iceRestartConfigMatrix.test.ts:378) は初回 gathering での `raddr` 秘匿を確認します。
- [packages/ice/tests/ice/restart-gather-options.test.ts:19](review-file:packages/ice/tests/ice/restart-gather-options.test.ts:19) は ice 層の単体テストです。判定関数、除外 socket の close、provisional checks、TCP の再 gather、TURN allocation の扱い、`raddr` 秘匿を含みます。
- 共通の Arrange は [packages/webrtc/tests/utils.ts](review-file:packages/webrtc/tests/utils.ts) と [packages/ice/tests/utils.ts](review-file:packages/ice/tests/utils.ts) にあります。

公開 API 追加（`isCandidateAllowedByGatherOptions` / `isRelayOnlyGathering` / `hasTurnServer` / `mergeIceServerOptions`）は `doc/` と `packages/ice/doc/` に反映済みです。[changelog.md](review-file:changelog.md) も更新しています。

## 3. 判断理由

- **判定の一本化。** 以前は restart 経路ごとに「どの候補を出すか」がばらばらで、漏れの原因になりました。新規 gathering と同じ条件を 1 関数にし、ice と webrtc の両方から呼ぶ構造にしました。
- **`isRelayOnlyGathering` は TURN の有無を見ない。** 当初は「TURN が揃っているときだけ relay-only」でしたが、再レビュー後に `forceTurn` だけで決める形へ変えました。TURN が無い relay ポリシーで host へフォールバックすると、アドレスが漏れるためです。このとき候補は 0 件になります。
- **commit 前の設定変更は commit 時の gathering に反映する。** 「offer 作成時の設定で固定し、変更は次の restart に回す」案も実装しました。しかし既存仕様 `[2.6-T3b]` と矛盾したため採用しませんでした。offer が announce した host 候補は、commit 時に socket を閉じるので、チェックに失敗するだけです。

## 4. レビュアーが確認すべき点・リスク

- **挙動の互換性。** relay ポリシーでの restart や `iceUseTcp` を false にした restart では、保持 socket が閉じられます。ユーザーが明示的に設定を変えたときに限った挙動です。
- **TURN なしの relay ポリシー。** 候補が 0 件になり、host へフォールバックしなくなりました（`isRelayOnlyGathering` の意味変更）。初回 gathering の挙動も変わるため、既存利用者への影響を確認してください。
- **公開 API の追加。** ice パッケージから 4 関数が export されます。
- **`raddr` の値。** relay ポリシーでは `0.0.0.0:9` になります。相手の実装がこれを問題にしないかを確認してください。
- **srflx の既知の制約。** チケット §4 のとおり、restart 後は host protocol を再利用するので、新しい srflx は出ません。この対応は本変更の範囲外です。

## 5. 検証結果

この文書の作成時には、テストや型チェックを再実行していません。コードとテストの内容は差分から読み取り、結果は書いていません。チケット §6.4 が求める次の検証は、各コミット時点の実行結果を確認してください。

- `cd packages/ice && npm run type && npm test`
- `cd packages/webrtc && npm run type && npm test`
- ルートで `npm run type && npm run test:small`

「修正前のコードでは all→relay と `iceUseTcp` の計 3 行が失敗する」という完了条件の確認結果も、この文書では確認していません。
