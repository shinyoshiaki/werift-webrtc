---
ide:
  viewer: review-document
  version: 1
  title: "ICE restart が新しい設定の意味を守る（e793c42a）"
  dock: right
  baseCommit: c50ace15e1d941fe9bc4022cc067555069185d19
---
# ICE restart が新しい設定の意味を守るようにする（レビュー解説）

## 1. 概要

`setConfiguration()` が起こす ICE restart で、新しい `iceTransportPolicy` / `iceUseTcp` / TURN 設定の意味が守られるようにしました。これまでの restart は、保持していた socket と候補をそのまま新しい generation に持ち込んでいました。そのため `all` から `relay` に変えても、host / srflx 候補が offer と trickle に漏れていました。

最終的な restart の挙動は次の 4 点です。

- 新しい設定で使わない保持 socket は閉じます。再広告、ペア作成、着信チェックへの応答もしません。
- 判定は `packages/ice` の共通関数 1 か所にまとめ、ice 層と webrtc 層の両方から使います。
- `relay` ポリシーは TURN 設定の有無にかかわらず relay 専用です。直接候補への fallback はしません。
- `relay` ポリシーの relay 候補は、`raddr` / `rport` に実アドレスを載せません。

本チケットの前半（gathering 後の `setConfiguration({ iceServers })` を次の restart に反映すること、`needRestart`、TURN credential の再適用）は、これ以前のコミットで実装済みです。この文書は、追加要件 §6 とその後の再レビュー対応を中心に説明します。

**現状**: チケットは承認済みです（`reviewStatus=approved`、レビュー 5/5 回）。このあと develop の取り込みが 5 回あり、現在の HEAD は `c50ace15e` です。取り込みで本チケットのコードは変わっていません。変わったのは、`packages/webrtc/src/transport/ice.ts` の行位置（+9 行）と、changelog の節名（`Unreleased` → `v0.26.0`）だけです。

## 2. 主要変更

### 2.1 判定の共通化（packages/ice）

[packages/ice/src/iceBase.ts:455](review-file:packages/ice/src/iceBase.ts:455) 以降で、次の 4 関数を公開しました。

| 関数 | 役割 |
| --- | --- |
| `mergeIceServerOptions()` | ICE server 設定の merge 規則です。server 系は undefined も含めて置き換え、`forceTurn` / `useTcp` は指定されたときだけ変えます。`Connection.setIceServers()` と webrtc 層が共有します。 |
| `isRelayOnlyGathering()` | relay-only かどうかを `forceTurn` だけで判定します。 |
| `hasTurnServer()` | 使える TURN server と credential が揃っているかを返します。 |
| `isCandidateAllowedByGatherOptions()` | 保持中の候補を、新しい generation で広告・ペア作成してよいかを判定します。 |

判定の中心は [packages/ice/src/iceBase.ts:509](review-diff:packages/ice/src/iceBase.ts:commit:ef4cc01a9:509) です。

- relay 候補は `hasTurnServer()` が真のときだけ許可します。
- relay-only なら host / srflx を拒否します。
- `useTcp` が false なら TCP host を拒否します。

`isRelayOnlyGathering()` が `forceTurn` だけで決まるようになった変更は [packages/ice/src/iceBase.ts:481](review-diff:packages/ice/src/iceBase.ts:commit:13b7d3f0d:481) です。

### 2.2 restart 時の socket 整理（packages/ice）

- [packages/ice/src/ice.ts:797](review-diff:packages/ice/src/ice.ts:commit:ef4cc01a9:797): `gatherCandidates()` は、新しい generation の開始時に除外される保持 socket を `protocols` から外して `close()` します。旧 TURN allocation は従来どおり別に close し、二重に close しないようにしました。
- [packages/ice/src/ice.ts:883](review-diff:packages/ice/src/ice.ts:commit:ef4cc01a9:883): `allowsProvisional()` は、staged generation の gather options で除外される socket を provisional checklist から外します。保持中の TURN allocation を使うのは、TURN server と credential が新しい設定と一致するときだけです。
- [packages/ice/src/ice.ts:958](review-diff:packages/ice/src/ice.ts:commit:ef4cc01a9:958): staged generation 宛ての着信チェックが除外 socket に届いた場合は応答しません。以前は応答を送った後に判定していたため、使わない socket でも応答していました。
- [packages/ice/src/ice.ts:1094](review-file:packages/ice/src/ice.ts:1094): gather と check スケジューリングは、同じ `isRelayOnlyGathering()` を使います。
- `useTcp` を false から true にした restart では、UDP socket を保持しているアドレスにも TCP host 候補を gather します。

### 2.3 relay 候補の `raddr` 秘匿（packages/ice）

[packages/ice/src/ice.ts:1418](review-diff:packages/ice/src/ice.ts:commit:d9c739269:1418) で、relay ポリシーのときは relay 候補の related address を `0.0.0.0`（IPv6 なら `::`）、ポートを 9 にします。TURN サーバーが観測した送信元アドレスを、SDP と trickle に載せないためです。ポート 9 は RFC 8839 §5.1 に従った値です。最初は 0 にしていましたが、最終レビューの指摘を受けて 9 に直しました（[packages/ice/src/ice.ts:1418](review-diff:packages/ice/src/ice.ts:commit:e97141cb5:1418)）。

develop から取り込んだ `RTCIceCandidate` の parsed fields では、この候補は `relatedAddress: "0.0.0.0"`、`relatedPort: 9` になります（`iceCandidateAttribute.ts` のコードから読み取った結果で、テストでは確認していません）。

### 2.4 restart offer / answer の候補絞り込み（packages/webrtc）

[packages/webrtc/src/transport/ice.ts:352](review-file:packages/webrtc/src/transport/ice.ts:352) の `stageLocalRestart()` は、live 候補を全部コピーするのをやめました（導入時の差分は [packages/webrtc/src/transport/ice.ts:343](review-diff:packages/webrtc/src/transport/ice.ts:commit:32265ae5b:343)）。

- defer 中の ICE server を適用した `gatherOptions` を作り、許可された候補だけを offer / answer に載せます。
- `gatherOptions` は staged generation に保持し、`stageLocalCredentials()` にも渡します。
- これで、commit 前に provisional checks が使う socket が、commit 後の gathering と一致します。

<div style="display:flex;gap:12px;flex-wrap:wrap">
  <div style="flex:1;min-width:260px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px">
    <strong>Before（all → relay の restart）</strong><br>
    offer に host / srflx を全コピー<br>
    保持 socket はそのまま再広告し、着信チェックにも応答<br>
    TURN なしの relay は host / srflx に fallback<br>
    relay 候補の raddr に実アドレス
  </div>
  <div style="flex:1;min-width:260px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px">
    <strong>After</strong><br>
    offer の候補は 0 件、commit 後は relay のみ trickle<br>
    host socket は commit 時に close、staged 宛てのチェックには応答しない<br>
    TURN なしの relay は候補 0 件（接続しない）<br>
    relay 候補の raddr は 0.0.0.0、rport は 9
  </div>
</div>

### 2.5 再レビューでの指摘と対応

§6 の実装後に受けた指摘と、その対応です。

| 指摘 | 対応 | 修正前のコードで失敗したテスト |
| --- | --- | --- |
| [P1] TURN が無い・credential が欠けた relay ポリシーで直接候補を許可する | `isRelayOnlyGathering()` を `forceTurn` だけで判定（`13b7d3f0d`） | ice 9 件、webrtc 2 件 |
| [P2] TURN を削除・変更した後も旧 allocation が provisional checks に使われる | `hasTurnServer()` と TURN の一致判定、staged 宛て着信チェックへの不応答（`ef4cc01a9`） | ice 5 件 |
| [P1] relay 候補の `raddr` から送信元アドレスが公開される | relay ポリシーでは `raddr` を秘匿（`d9c739269`） | ice 2 件、webrtc 2 件 |
| [P2] 秘匿時の `rport 0` が RFC 8839 に合わない | `rport 9` に変更（`e97141cb5`） | （値の変更のみ） |

### 2.6 テスト

- [packages/webrtc/tests/transport/iceRestartConfigMatrix.test.ts:24](review-file:packages/webrtc/tests/transport/iceRestartConfigMatrix.test.ts:24) は、設定 × 出力のマトリクスです。確認するのは `needRestart`、offer の候補種別、trickle、新しい generation、`Connection.options`、TURN username、旧 allocation の close、relay 候補の `raddr`（trickle・generation・`localDescription`）です。
- [packages/webrtc/tests/transport/iceRestartConfigMatrix.test.ts:325](review-file:packages/webrtc/tests/transport/iceRestartConfigMatrix.test.ts:325) は、offer の適用後、answer の前に relay へ変えた場合です。
- [packages/webrtc/tests/transport/iceRestartConfigMatrix.test.ts:378](review-file:packages/webrtc/tests/transport/iceRestartConfigMatrix.test.ts:378) は、初回 gathering での `raddr` 秘匿です（`relay` と `all` の比較）。
- ice 層のテストは [packages/ice/tests/ice/restart-gather-options.test.ts:19](review-file:packages/ice/tests/ice/restart-gather-options.test.ts:19) にあります。
  - 判定関数（TURN なし・credential 欠落・ICE-lite を含む）
  - 除外 socket の close
  - TURN なしの relay で直接候補を出さないこと（初回 gathering と restart）
  - TCP の再 gather
  - staged generation での TURN allocation の扱い（[packages/ice/tests/ice/restart-gather-options.test.ts:338](review-file:packages/ice/tests/ice/restart-gather-options.test.ts:338)）
  - `raddr` 秘匿（[packages/ice/tests/ice/restart-gather-options.test.ts:391](review-file:packages/ice/tests/ice/restart-gather-options.test.ts:391)）
- 共通の Arrange は [packages/webrtc/tests/utils.ts](review-file:packages/webrtc/tests/utils.ts) と [packages/ice/tests/utils.ts](review-file:packages/ice/tests/utils.ts) にまとめています。

追加した公開 API（`isCandidateAllowedByGatherOptions` / `isRelayOnlyGathering` / `hasTurnServer` / `mergeIceServerOptions`）は、`doc/` と `packages/ice/doc/` に反映しました。[changelog.md](review-file:changelog.md) の `v0.26.0` 節にも挙動の変更を記載しています（develop の取り込みで、`Unreleased` から節名が変わりました）。

## 3. 判断理由

- **判定を 1 か所にまとめた。** 以前は restart の経路ごとに「どの候補を出すか」がばらばらで、それが漏れの原因でした。新規 gathering と同じ条件を 1 つの関数にし、ice と webrtc の両方から呼ぶ構造にしました。
- **`isRelayOnlyGathering` は TURN の有無を見ない。** 当初は「TURN が揃っているときだけ relay-only」でしたが、再レビューを受けて `forceTurn` だけで決める形に変えました。TURN の無い relay ポリシーで host に fallback すると、アドレスが漏れるためです。このとき候補は 0 件になります。ICE-lite は relay 候補を gather しないので、ICE-lite で relay ポリシーを使った場合も候補は 0 件です。
- **保持中の TURN allocation は、同じ TURN 設定でだけ使う。** TURN を削除したり別の credential に変えたりした世代では、commit 前の provisional checks でも旧 allocation を使いません。
- **`raddr` は秘匿値に置き換える。** 直接候補を除外しても、relay 候補の `raddr` から公開アドレスが分かってしまうためです。値は RFC 8839 §5.1 の `0.0.0.0` / `::` とポート 9 です。`all` ポリシーでは従来どおり実アドレスを出します。
- **commit 前の設定変更は commit 時の gathering に反映する。** 「offer 作成時の設定で固定し、変更は次の restart に回す」案も実装しました。しかし既存の仕様 `[2.6-T3b]` と矛盾したため、採用しませんでした。offer で announce した host 候補は、commit 時に socket を閉じるので、チェックに失敗するだけです。

## 4. レビュアーが確認すべき点・リスク

- **互換性。** relay ポリシーへの restart や、`iceUseTcp` を false にした restart では、保持 socket が閉じられます。ユーザーが明示的に設定を変えたときだけの挙動です。
- **TURN なしの relay ポリシー。** 候補が 0 件になり、host に fallback しなくなりました。初回 gathering の挙動も変わるので、既存の利用者への影響を確認してください。ICE-lite と relay ポリシーの組み合わせも同じく候補 0 件です。
- **公開 API の追加。** ice パッケージから 4 つの関数が export されます。
- **`raddr` の値。** relay ポリシーでは `raddr 0.0.0.0 rport 9` になります。ブラウザとの相互接続では確認していません。
- **TURN allocation の解放。** 旧 allocation の close はクライアント側のソケットを閉じるだけで、TURN サーバーに解放要求（Refresh lifetime=0）を送っていません。サーバー側では期限切れになるまで残ります。
- **srflx の既知の制約。** チケット §4 のとおり、restart 後は host protocol を再利用するので、新しい srflx は出ません。この対応は本変更の範囲外です。

## 5. 検証結果

この文書を更新した時点の HEAD `c50ace15e` で実行しました（作業ツリーに未コミットの変更なし）。

| 検証 | 結果 |
| --- | --- |
| `npm run type`（ワークスペース全体） | exit 0 |
| `npm run test:small` | exit 0。ice 298 件成功・5 件 skip、webrtc 1129 件成功・5 件 skip、ほかの workspace もすべて成功 |
| ice: `restart-gather-options.test.ts` + `turn-restart.test.ts` | 36 件成功 |
| webrtc: `iceRestartConfigMatrix.test.ts` + `transport/ice.test.ts` | 43 件成功・2 件 skip |

修正前のコードで新しいテストが失敗することは、各修正の時点で確認しました（§2.5 の表）。マトリクステストを最初に作ったときにも、修正前のコードを一時 worktree で動かし、3 行（all → relay と `iceUseTcp` の行）が失敗することを確認しています。これらは今回は再実行していません。

未実行: `pbt:deep`、`npm run e2e`、ブラウザとの相互接続、WPT。
