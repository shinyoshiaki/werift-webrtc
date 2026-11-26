---
ide:
  viewer: review-document
  version: 1
  title: "werift 起点の ICE restart と Firefox: answer 前の check の引き継ぎ"
  dock: right
  baseCommit: e72cbd57e66bc22d1466ae8a1632fa1d6d4ae07a
---
# werift 起点の ICE restart で Firefox への送信が止まる不具合の修正

## 1. 概要

answer の適用前に新しい ufrag 宛てに届いた connectivity check を、restart の commit 後に再生するようにしました。修正前はこの check から学んだ内容が commit で消えていました。Firefox の restart answer には候補がなく、成功した check も再送されないため、werift は新しい generation の pair を作れず、Firefox へ RTP も DataChannel も送れませんでした。

変更は ICE 層の内部に閉じています。`Connection` の公開 API と `iceBase.ts` は変えておらず、SDP の出力も変わらない想定です。比較範囲はベースの `develop`（`7ca1d86aa`）から HEAD の `e72cbd57e` までです。

## 2. 修正前と修正後の流れ

<div style="font-family:var(--review-font);border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px;padding:8px;margin-bottom:12px">
<strong>Before: 受けた check が commit で消える</strong>
<svg viewBox="0 0 730 420" width="100%" role="img" aria-label="修正前の restart の流れ" style="font-family:var(--review-mono)">
<text x="100" y="16" fill="var(--review-fg)" font-size="12" text-anchor="middle">Firefox (controlled)</text><text x="542" y="16" fill="var(--review-fg)" font-size="12" text-anchor="middle">werift Connection (controlling)</text>
<g stroke="var(--review-border)"><line x1="100" y1="26" x2="100" y2="412"/><line x1="372" y1="26" x2="372" y2="412"/></g>
<line x1="100" y1="48" x2="372" y2="48" stroke="var(--review-muted)" stroke-width="1.5" /><path d="M372 48 l-8 -4 v8 z" fill="var(--review-muted)"/><text x="236" y="42" fill="var(--review-muted)" font-size="12" text-anchor="middle">① restart offer（新 ufrag）</text>
<rect x="372" y="34" width="340" height="28" rx="6" fill="var(--review-surface)" stroke="var(--review-muted)" stroke-width="1.5"/><text x="542" y="51" fill="var(--review-fg)" font-size="12" text-anchor="middle">stageLocalCredentials()</text>
<line x1="100" y1="94" x2="372" y2="94" stroke="var(--review-muted)" stroke-width="1.5" /><path d="M372 94 l-8 -4 v8 z" fill="var(--review-muted)"/><text x="236" y="88" fill="var(--review-muted)" font-size="12" text-anchor="middle">② check（新 ufrag 宛て）</text>
<line x1="372" y1="118" x2="100" y2="118" stroke="var(--review-muted)" stroke-width="1.5" /><path d="M100 118 l8 -4 v8 z" fill="var(--review-muted)"/><text x="236" y="112" fill="var(--review-muted)" font-size="12" text-anchor="middle">Binding success（再送はもう来ない）</text>
<rect x="372" y="78" width="340" height="62" rx="6" fill="var(--review-surface)" stroke="var(--review-muted)" stroke-width="1.5"/><text x="542" y="95" fill="var(--review-fg)" font-size="12" text-anchor="middle">provisionalChecklist.checkIncoming()</text><text x="542" y="111" fill="var(--review-fg)" font-size="12" text-anchor="middle">prflx と pair を provisional に記録</text><text x="542" y="127" fill="var(--review-fg)" font-size="12" text-anchor="middle">（check 自体は保存しない）</text>
<line x1="100" y1="170" x2="372" y2="170" stroke="var(--review-muted)" stroke-width="1.5" /><path d="M372 170 l-8 -4 v8 z" fill="var(--review-muted)"/><text x="236" y="164" fill="var(--review-muted)" font-size="12" text-anchor="middle">③ answer（候補なし）</text>
<rect x="372" y="154" width="340" height="78" rx="6" fill="var(--review-surface)" stroke="var(--review-danger)" stroke-width="1.5"/><text x="542" y="171" fill="var(--review-fg)" font-size="12" text-anchor="middle">restart() → provisionalChecklist.end()</text><text x="542" y="187" fill="var(--review-fg)" font-size="12" text-anchor="middle">checkList / earlyChecks は空</text><text x="542" y="203" fill="var(--review-fg)" font-size="12" text-anchor="middle">prflx・pair・受けた指名をすべて破棄</text><text x="542" y="219" fill="var(--review-fg)" font-size="12" text-anchor="middle">（引き継ぎ先がない）</text>
<rect x="372" y="242" width="340" height="46" rx="6" fill="var(--review-surface)" stroke="var(--review-muted)" stroke-width="1.5"/><text x="542" y="259" fill="var(--review-fg)" font-size="12" text-anchor="middle">commitLocalCredentials(ufrag)</text><text x="542" y="275" fill="var(--review-fg)" font-size="12" text-anchor="middle">資格情報だけを live にする</text>
<rect x="372" y="298" width="340" height="62" rx="6" fill="var(--review-surface)" stroke="var(--review-danger)" stroke-width="1.5"/><text x="542" y="315" fill="var(--review-fg)" font-size="12" text-anchor="middle">connect()</text><text x="542" y="331" fill="var(--review-fg)" font-size="12" text-anchor="middle">remote 候補なし → checkList が空</text><text x="542" y="347" fill="var(--review-fg)" font-size="12" text-anchor="middle">ICE negotiation failed</text>
<line x1="372" y1="386" x2="100" y2="386" stroke="var(--review-danger)" stroke-width="1.5" stroke-dasharray="6 5"/><path d="M100 386 l8 -4 v8 z" fill="var(--review-danger)"/><text x="236" y="380" fill="var(--review-danger)" font-size="12" text-anchor="middle">④ werift からの送信なし</text><text x="542" y="391" fill="var(--review-danger)" font-size="12" text-anchor="middle">nominated なし → 送れない</text>
<text x="365" y="414" fill="var(--review-muted)" font-size="11" text-anchor="middle">赤 = 問題の箇所 ／ 灰 = 正常な処理</text>
</svg></div>
<div style="font-family:var(--review-font);border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px;padding:8px;margin-bottom:12px">
<strong>After: 受けた check を commit 後の checklist で再生する</strong>
<svg viewBox="0 0 730 420" width="100%" role="img" aria-label="修正後の restart の流れ" style="font-family:var(--review-mono)">
<text x="100" y="16" fill="var(--review-fg)" font-size="12" text-anchor="middle">Firefox (controlled)</text><text x="542" y="16" fill="var(--review-fg)" font-size="12" text-anchor="middle">werift Connection (controlling)</text>
<g stroke="var(--review-border)"><line x1="100" y1="26" x2="100" y2="412"/><line x1="372" y1="26" x2="372" y2="412"/></g>
<line x1="100" y1="48" x2="372" y2="48" stroke="var(--review-muted)" stroke-width="1.5" /><path d="M372 48 l-8 -4 v8 z" fill="var(--review-muted)"/><text x="236" y="42" fill="var(--review-muted)" font-size="12" text-anchor="middle">① restart offer（新 ufrag）</text>
<rect x="372" y="34" width="340" height="28" rx="6" fill="var(--review-surface)" stroke="var(--review-muted)" stroke-width="1.5"/><text x="542" y="51" fill="var(--review-fg)" font-size="12" text-anchor="middle">stageLocalCredentials()</text>
<line x1="100" y1="94" x2="372" y2="94" stroke="var(--review-muted)" stroke-width="1.5" /><path d="M372 94 l-8 -4 v8 z" fill="var(--review-muted)"/><text x="236" y="88" fill="var(--review-muted)" font-size="12" text-anchor="middle">② check（新 ufrag 宛て）</text>
<line x1="372" y1="118" x2="100" y2="118" stroke="var(--review-muted)" stroke-width="1.5" /><path d="M100 118 l8 -4 v8 z" fill="var(--review-muted)"/><text x="236" y="112" fill="var(--review-muted)" font-size="12" text-anchor="middle">Binding success（再送はもう来ない）</text>
<rect x="372" y="78" width="340" height="62" rx="6" fill="var(--review-surface)" stroke="var(--review-success)" stroke-width="1.5"/><text x="542" y="95" fill="var(--review-fg)" font-size="12" text-anchor="middle">provisionalChecklist.checkIncoming()</text><text x="542" y="111" fill="var(--review-fg)" font-size="12" text-anchor="middle">prflx と pair を provisional に記録</text><text x="542" y="127" fill="var(--review-fg)" font-size="12" text-anchor="middle">＋ receivedChecks に check を保存</text>
<line x1="100" y1="170" x2="372" y2="170" stroke="var(--review-muted)" stroke-width="1.5" /><path d="M372 170 l-8 -4 v8 z" fill="var(--review-muted)"/><text x="236" y="164" fill="var(--review-muted)" font-size="12" text-anchor="middle">③ answer（候補なし）</text>
<rect x="372" y="154" width="340" height="78" rx="6" fill="var(--review-surface)" stroke="var(--review-success)" stroke-width="1.5"/><text x="542" y="171" fill="var(--review-fg)" font-size="12" text-anchor="middle">restart() → provisionalChecklist.end()</text><text x="542" y="187" fill="var(--review-fg)" font-size="12" text-anchor="middle">checkList / earlyChecks は空</text><text x="542" y="203" fill="var(--review-fg)" font-size="12" text-anchor="middle">end() の前に endedStagedChecks へ退避</text><text x="542" y="219" fill="var(--review-fg)" font-size="12" text-anchor="middle"></text>
<rect x="372" y="242" width="340" height="46" rx="6" fill="var(--review-surface)" stroke="var(--review-success)" stroke-width="1.5"/><text x="542" y="259" fill="var(--review-fg)" font-size="12" text-anchor="middle">commitLocalCredentials(ufrag)</text><text x="542" y="275" fill="var(--review-fg)" font-size="12" text-anchor="middle">ufrag 一致なら carriedChecks へ移す</text>
<rect x="372" y="298" width="340" height="62" rx="6" fill="var(--review-surface)" stroke="var(--review-success)" stroke-width="1.5"/><text x="542" y="315" fill="var(--review-fg)" font-size="12" text-anchor="middle">connect()</text><text x="542" y="331" fill="var(--review-fg)" font-size="12" text-anchor="middle">answer の remote ufrag を照合して再生</text><text x="542" y="347" fill="var(--review-fg)" font-size="12" text-anchor="middle">checkIncoming() → prflx pair を作る</text>
<line x1="372" y1="386" x2="100" y2="386" stroke="var(--review-success)" stroke-width="1.5" /><path d="M100 386 l8 -4 v8 z" fill="var(--review-success)"/><text x="236" y="380" fill="var(--review-success)" font-size="12" text-anchor="middle">④ triggered check（USE-CANDIDATE）</text><text x="542" y="391" fill="var(--review-success)" font-size="12" text-anchor="middle">nominated → RTP / DataChannel 再開</text>
<text x="365" y="414" fill="var(--review-muted)" font-size="11" text-anchor="middle">緑 = 修正で変わった箇所 ／ 灰 = 変更なし</text>
</svg></div>

図の要点は次のとおりです。

- 分かれ目は `restart()` です。修正前は `provisionalChecklist.end()` が、staged generation の受けた内容をすべて捨てていました。
- 修正後は check そのもの（`[Message, Address, Protocol]`）を残し、`connect()` で通常の `checkIncoming()` に渡します。prflx 候補の学習と triggered check は既存の経路が担います。
- werift 側で commit を起こすのは [packages/webrtc/src/transport/ice.ts:621](review-file:packages/webrtc/src/transport/ice.ts:621) の `restart()` と、直後の `commitLocalCredentials()` です。このファイルは変更していません。

チケット 10.1 節の調査では、ログ出力で処理が遅れ、Firefox の check が commit の後に届いた回は成功しました。トリクルでも、Firefox が新しい候補を送るため修正前から成功しています。

## 3. 主要変更

### 3.1 check の記録（`provisional.ts`）

- [packages/ice/src/provisional.ts:578](review-diff:packages/ice/src/provisional.ts:578): 応答対象の check を `receivedChecks` に記録します。記録位置は `allows()` と remote ufrag の判定より後です。除外されるソケットの check や、既知の remote ufrag と異なる check は残りません。
- [packages/ice/src/provisional.ts:688](review-diff:packages/ice/src/provisional.ts:688): `rememberStagedCheck` は上限を 32 件（`MAX_CARRIED_CHECKS`）にします。pranswer がない時点では相手の ufrag が分からないため、次の規則で正しい check が押し出されるのを防ぎます。
  - 送信元 ufrag、アドレス、ソケットが同じ check は、新しいもので置き換えます。
  - ただし、保存済みの check が指名（USE-CANDIDATE / NOMINATION）を持つ場合は置き換えません。
  - 満杯なら、最も多くの件数を持つ送信元 ufrag の最古の 1 件を捨てます。

### 3.2 引き継ぎの受け渡し（`ice.ts`）

check は `receivedChecks` → `endedStagedChecks` → `carriedChecks` の順に移ります。

- [packages/ice/src/ice.ts:770](review-diff:packages/ice/src/ice.ts:770): `restart()` は `end()` の前に記録を退避します。pranswer で checks を始めた（`started`）generation は対象外です。
- [packages/ice/src/ice.ts:983](review-diff:packages/ice/src/ice.ts:983): `commitLocalCredentials()` は、退避した ufrag が commit する ufrag と一致し、`earlyChecksDone` が false のときだけ `carriedChecks` に移します。
- [packages/ice/src/ice.ts:1946](review-diff:packages/ice/src/ice.ts:1946): `connect()` は通常の `earlyChecks` より先に再生します。送信元が answer の remote ufrag と一致しない check は捨てます。
- 破棄する経路は、置き換えの offer（[packages/ice/src/ice.ts:942](review-diff:packages/ice/src/ice.ts:942)）、`restartRemote()`（[packages/ice/src/ice.ts:914](review-diff:packages/ice/src/ice.ts:914)）、`close()`（[packages/ice/src/ice.ts:2308](review-diff:packages/ice/src/ice.ts:2308)）です。次の `restart()` も `carriedChecks` を空にします。rollback は staged generation を先に捨てるため、退避する対象がありません。

```mermaid
flowchart TD
  A["carriedChecks の 1 件"] --> B{"送信元 ufrag が<br/>remoteUsername と一致"}
  B -- いいえ --> X["捨てる"]
  B -- はい --> C{"受信ソケットが<br/>protocols に残る"}
  C -- はい --> D["checkIncoming()"]
  C -- いいえ --> E{"relay の<br/>ソケットだった"}
  E -- はい --> F["learnPeerReflexive()<br/>応答も指名の引き継ぎもしない"]
  E -- いいえ --> X
```

### 3.3 閉じた TURN allocation の扱い

commit で TURN allocation が差し替わると、その allocation では応答できません。この場合は [packages/ice/src/ice.ts:3743](review-diff:packages/ice/src/ice.ts:3743) の `learnPeerReflexive` が相手のアドレスだけを prflx 候補にし、現在のソケットから確認します。旧 pair への指名は引き継ぎません。

チケット 10.2 節には「今も使っているソケットに届いたものだけを再生する」とだけあり、この relay の分岐は書かれていません。`checkIncoming()` で再生しないという意味では一致しますが、アドレスは学習される点に注意してください。

### 3.4 テスト、リーク監視、changelog

- [packages/ice/tests/ice/restart-early-checks.test.ts:12](review-diff:packages/ice/tests/ice/restart-early-checks.test.ts:12): 7 ケースを追加しました。内容は、主ケース（nominate と双方向のデータ）、置き換えの offer、rollback、別の remote ufrag、別 ufrag の check 64 件による容量超過、指名の保持、閉じた relay です。
- [packages/ice/tests/utils.ts:4547](review-diff:packages/ice/tests/utils.ts:4547): 共通の Arrange です。`b` は check を終えたあと再送せず指名を待ち、answer は使える候補を持ちません。`incomingCheckTimeout` は 1 秒です。
- [packages/webrtc/tests/pbt/leak/leakProbe.ts:491](review-diff:packages/webrtc/tests/pbt/leak/leakProbe.ts:491): leak probe に `ice.carriedChecks` を追加しました。`endedStagedChecks` の件数も合算します。
- [changelog.md:61](review-diff:changelog.md:61): `## Unreleased` の Bug Fixes に記載しました。初回レビューでは公開済みの `v0.28.0` 節にあると指摘され、`e72cbd57e` で移しています。

`0767eeacb` と `e72cbd57e` の差は changelog とチケットだけで、コードとテストは同じです。

## 4. 判断理由

- **check を再生する方式（チケットの案 1）**: 初回接続の early check と同じ `checkIncoming()` を通るため、prflx の学習、triggered check、指名の反映を作り直さずに済みます。
- **provisional の prflx 候補を live に移す方式（案 2）は不採用**: answer が届くまで remote ufrag が分からず、live の pair が持つ ufrag 照合の条件と整合させる処理が必要になります。
- **タイマーでの再送や Firefox だけの分岐は不採用**: チケットが対症療法として除外しています。原因は werift が受信内容を捨てることにあります。
- **`started` の generation を除外**: pranswer の経路は `nominationHint` で経路を引き継ぎます。この既存の挙動を変えないためです。
- **webrtc の negotiation case は追加しない**: werift 同士の answer には候補が入るため再現しません。他実装の SDP の形を `tests/negotiation/cases` で作ることも禁止されています（チケット 10.2 節）。

詳しい調査記録は [docs/tickets/TICKET-ticket-bfc84a9e-9ca3-4900-8210-00854f576265.md:107](review-file:docs/tickets/TICKET-ticket-bfc84a9e-9ca3-4900-8210-00854f576265.md:107) 以降にあります。

## 5. レビュアーが確認すべき点とリスク

1. **再生ループと early check の処理の違い**: [packages/ice/src/ice.ts:1949](review-file:packages/ice/src/ice.ts:1949) では `settleSpedUnconfirmed` と `maybeSendSpedFallback` を呼びません。直後の `earlyChecks` のループは呼びます。restart で SPED runtime が reset され、DTLS は張り直さないため影響は小さいという見立てですが、SPED と restart の組み合わせは未検証です。
2. **32 件の上限が守る範囲**: 1 つの誤った ufrag からの大量の check は、別の ufrag の check を押し出しにくい作りです。一方、全送信元が 1 件ずつで満杯の場合は、先に登録された送信元の check から落ちます。テストが確かめているのは、1 つの別 ufrag から 64 件届く場合です。
3. **挙動の変化**: answer の前に check を受けた restart では、commit 後の checklist に prflx の pair が加わります。answer に候補がある相手でも同じです。commit 時に `nominated` を捨て、再指名まで送信しない仕様は変えていません。
4. **relay の分岐のテスト**: テストは `carriedChecks` に偽の relay `Protocol` を直接入れています。実際の TURN サーバーで allocation が差し替わる流れは通していません。
5. **Firefox の確認範囲**: 次節のとおり、現行コードで直結確認できたのは Firefox が初回の offer を出す構成です。
6. **別件の DTLS 不具合**: werift が初回の offer を出し、Firefox が DTLS client になる構成では、HelloVerifyRequest に Firefox が `decode_error` を返します。ベースでも再現すると報告されており、この差分は dtls に触れていません。別チケットでの調査が推奨されています。

## 6. 検証結果

実行者と対象リビジョンを分けて示します。「レビュー」の行はチケットのレビュー記録からの転記で、この文書の作成時には再実行していません。

### この文書の作成時（`e72cbd57e`）

- `packages/ice` で `npx vitest run tests/ice/restart-early-checks.test.ts tests/ice/provisional.test.ts`: 2 ファイル、15 件がすべて成功しました。
- これ以外のテスト、型検査、E2E は実行していません。

### 最終承認レビュー（`e72cbd57e`）

| 項目 | 結果 |
| --- | --- |
| ICE / WebRTC テスト | 2,411 件 / 3,272 件が成功 |
| workspace の型検査 | 成功 |
| Chrome / DTLS E2E | 108 件が成功 |
| ICE deep search | 50,800 件が成功 |
| WebRTC deep search | fuzz / model / scenario と leak の構造検査は成功。heap slope の seed 2 / 4 は失敗し、develop でも同じ seed が失敗 |
| negotiation-diff | 10 seeds × 12 steps で regressions / divergences / hangs が 0。80 seeds の実行は seed 11 で時間切れのため中断 |

### 初回レビュー（`0767eeacb`、コードは HEAD と同じ）

- Firefox 157 の直結確認: ベースは 2/18、修正後は **18/18** が成功しました（3 ポリシー × `legacy` / `compatible` × 3 回）。条件は、Firefox が初回の offer を出し（werift が DTLS client）、各側が gathering の完了後に SDP を渡す方式です。restart 後の受信パケット数の増加と DataChannel の往復を確認しています。トリクルと、werift が初回の offer を出す構成は含みません。
- 主ケースは、ベースにテストと utils だけを入れると `ICE negotiation failed` で失敗しました。
- Chrome の restart E2E は `--retry=0` の 5 回で 10/10 が成功しました。全体は 71 件成功、6 件失敗で、失敗した relay 関連の 6 件はベースでも失敗しています。
- heap slope の seed 2 / 4 は、この回の単独再実行ではベースと HEAD の両方で成功しました。最終レビューやチケット 10.4 節の結果（develop でも失敗）と異なるため、結果が安定しない検査として扱ってください。

最終承認レビューは、現行コードでの Firefox 直結を再実施できていないことを懸念に挙げています。上の 18/18 は同じコードに対する初回レビューの結果で、構成は限られます。

### 移植前の参考値（`dc95a5a49` を基準にした別ブランチ）

チケット 10.3 節では、Firefox の直結確認（vanilla とトリクル）が 36/36、80 seeds × 12 steps の negotiation-diff が差分 0 でした。チケット 9 章の完了条件の一部はこの結果に基づきます。現行コードの結果ではありません。
