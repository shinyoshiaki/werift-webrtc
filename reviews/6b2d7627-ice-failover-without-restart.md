---
ide:
  viewer: review-document
  version: 1
  title: "ICE フェイルオーバー（ICE restart なし）のレビュー"
  dock: right
  baseCommit: 01d2b42b0ca0a1ab6d56a2b4618d56cc97847761
---
# ICE フェイルオーバー（ICE restart なしで次のペアへ移る）のレビュー

## 1. 概要

選択中のペア（`Connection.nominated`）が応答しなくなったとき、werift は従来 30 s の consent 失効で `failed` になり、アプリ側の ICE restart を待つしかありませんでした。今回、libwebrtc と同じ考え方で「ローカルのソケット（`Protocol`）ごとに 1 つの退避先ペア」を選択後も監視し続け、選択中のペアが書き込み不可になると、`controlling` 側が退避先を指名して ICE restart なしで切り替えます。

対象は full ICE の semi-aggressive / renomination のみです。regular nomination、ICE-TCP、ICE-lite では従来の挙動を変えません（[packages/ice/src/ice.ts:3418](review-file:packages/ice/src/ice.ts:3418) の `failoverEnabled()` ほか）。

差分の基準は、チケット worktree に取り込み済みの親チケットのマージコミット `e83850f0e` です。headCommit は `01d2b42b0`（再レビュー 3 回目）です。

### 受け入れテスト（ここだけ見れば不変条件を確認できます）

[packages/ice/tests/ice/failover-matrix.test.ts:56](review-file:packages/ice/tests/ice/failover-matrix.test.ts:56) の 1 ファイルで、次の不変条件を確かめられます。「選択中のペアと経路が異なる（別ソケット、または同じソケットの別リモートアドレスへの）eligible なペアは、順位とロールに関係なく監視され、選択した経路だけが切れたときに使われる」。

| 件 | 確認すること |
| --- | --- |
| [行列 48 件](review-file:packages/ice/tests/ice/failover-matrix.test.ts:67) | ロール {controlling, controlled} × モード {semi-aggressive, renomination} × 代替経路の位置 {別ソケット下位/上位, 同一ソケット下位/上位} × 代替の初期状態 {通る, 10 s 断後に復帰, 60 s 断後に復帰}。controlling は切断から 11 s 以内に代替へ移り、`failed` を経ない（通る上位の代替には切断前に移っている）。controlled は 10 s 以内に代替が有効で check が続き、40 s 前に `failed` にならず、相手の指名だけ（データなし）で 2 s 以内に代替へ移り `connected` に戻る |
| [ロール変更直後](review-file:packages/ice/tests/ice/failover-matrix.test.ts:148) | controlled になった直後も、同一ソケットの上位ペアを監視する |
| [controlled への候補の後着](review-file:packages/ice/tests/ice/failover-matrix.test.ts:178) | 選択後に届いた同一ソケット上位の候補を、退避先として監視する |
| [復帰と同時の切断](review-file:packages/ice/tests/ice/failover-matrix.test.ts:202) | controlling で、長く落ちていた同一ソケット上位が戻った直後に選択経路が切れても、次の 16 s の再試行を待たずに 11 s 以内に移る |
| [リモートの restart](review-file:packages/ice/tests/ice/failover-matrix.test.ts:239) | 相手の ufrag が変わると、古い世代の demote 情報が残らない |

実行: `cd packages/ice && npx vitest run tests/ice/failover-matrix.test.ts`（53 件、1 s 未満、fake timer）。共通の準備処理は [packages/ice/tests/utils.ts:3618](review-file:packages/ice/tests/utils.ts:3618) の `createFailoverMatrixCell` です。

修正を 1 つずつ戻して確かめた検出力:

| 戻した修正 | 落ちる件 |
| --- | --- |
| controlled は同一ソケットの上位も監視する（[failover.ts:457](review-file:packages/ice/src/failover.ts:457)） | controlled × 同一ソケット上位の 6 件、ロール変更直後、候補の後着 |
| 上位ペアの再試行を 16 s ごとに続ける（[selectionReplacement.ts:147](review-file:packages/ice/src/nomination/selectionReplacement.ts:147)） | controlling × 同一ソケット上位 × 60 s 断の 2 件 |
| 選択断で退避先がないとき、FAILED の上位ペアをすぐ check する（[ice.ts:3255](review-file:packages/ice/src/ice.ts:3255)） | 復帰と同時の切断の 2 件 |
| controlled は選択断のとき、同じ値の指名で置き換える（[selectionReplacement.ts:261](review-file:packages/ice/src/nomination/selectionReplacement.ts:261)） | controlled × semi-aggressive × 下位（別ソケット・同一ソケット）の 6 件 |

## 2. 修正前と修正後の流れ

<div style="font-family:sans-serif;font-size:13px;display:flex;gap:16px;flex-wrap:wrap">
<div style="flex:1;min-width:300px;border:1px solid #888;border-radius:8px;padding:10px">
<b>Before: 選択中ペアが切れると failed</b>
<svg viewBox="0 0 300 330" width="100%" xmlns="http://www.w3.org/2000/svg" font-size="12">
<rect x="20" y="10" width="260" height="38" rx="6" fill="none" stroke="#888"/><text x="150" y="33" text-anchor="middle" fill="currentColor">選択中ペア（host↔host）が応答しなくなる</text>
<line x1="150" y1="48" x2="150" y2="72" stroke="#888"/>
<rect x="20" y="72" width="260" height="38" rx="6" fill="none" stroke="#888"/><text x="150" y="95" text-anchor="middle" fill="currentColor">queryConsent: 5 s 間隔で check</text>
<line x1="150" y1="110" x2="150" y2="134" stroke="#888"/>
<rect x="20" y="134" width="260" height="38" rx="6" fill="none" stroke="#888"/><text x="150" y="157" text-anchor="middle" fill="currentColor">下位ペアは 8.1.2 で FAILED、監視なし</text>
<line x1="150" y1="172" x2="150" y2="196" stroke="#888"/>
<rect x="20" y="196" width="260" height="38" rx="6" fill="#fde2e2" stroke="#c0392b"/><text x="150" y="219" text-anchor="middle" fill="#7b1f14">30 s 後 CONSENT_TIMEOUT</text>
<line x1="150" y1="234" x2="150" y2="258" stroke="#c0392b"/>
<rect x="20" y="258" width="260" height="38" rx="6" fill="#fde2e2" stroke="#c0392b"/><text x="150" y="281" text-anchor="middle" fill="#7b1f14">setState("failed") → ICE restart 待ち</text>
</svg>
</div>
<div style="flex:1;min-width:300px;border:1px solid #888;border-radius:8px;padding:10px">
<b>After: 退避先へ切り替え</b>
<svg viewBox="0 0 300 330" width="100%" xmlns="http://www.w3.org/2000/svg" font-size="12">
<rect x="20" y="10" width="260" height="38" rx="6" fill="none" stroke="#888"/><text x="150" y="33" text-anchor="middle" fill="currentColor">選択中ペア（host↔host）が応答しなくなる</text>
<line x1="150" y1="48" x2="150" y2="72" stroke="#888"/>
<rect x="20" y="72" width="260" height="38" rx="6" fill="#e3f4e5" stroke="#2e8b3d"/><text x="150" y="95" text-anchor="middle" fill="#14471c">未応答 → 900 ms 間隔、5 回かつ 5 s で書き込み不可</text>
<line x1="150" y1="110" x2="150" y2="134" stroke="#2e8b3d"/>
<rect x="20" y="134" width="260" height="38" rx="6" fill="#e3f4e5" stroke="#2e8b3d"/><text x="150" y="157" text-anchor="middle" fill="#14471c">FailoverMonitor: relay の退避先を 2.5 s 間隔で監視済み</text>
<line x1="150" y1="172" x2="150" y2="196" stroke="#2e8b3d"/>
<rect x="20" y="196" width="260" height="38" rx="6" fill="#e3f4e5" stroke="#2e8b3d"/><text x="150" y="219" text-anchor="middle" fill="#14471c">evaluateFailover: USE-CANDIDATE / NOMINATION 指名</text>
<line x1="150" y1="234" x2="150" y2="258" stroke="#2e8b3d"/>
<rect x="20" y="258" width="260" height="38" rx="6" fill="#e3f4e5" stroke="#2e8b3d"/><text x="150" y="281" text-anchor="middle" fill="#14471c">選択を移す。約 5〜10 s、failed を経ない</text>
</svg>
</div>
</div>

凡例: 赤は問題の経路、緑は今回追加した経路です。灰色は変更のない部分です。退避先がなければ After でも `disconnected` を経て、consent が 30 s 切れた時点で `failed` になります。

要点は次のとおりです。

- 退避先の保持は、8.1.2 で下位ペアを FAILED にする処理と `admitsPair` / `pairLocalProtocol` の変更によります。
- 退避の判断は [packages/ice/src/ice.ts:3478](review-diff:packages/ice/src/ice.ts:3478) の `evaluateFailover` にあります。
- 状態の遷移は [packages/ice/src/ice.ts:3505](review-diff:packages/ice/src/ice.ts:3505) の `updateLinkState` にまとめています。

## 3. 主要変更

### 3.1 `FailoverMonitor`（新規）

[packages/ice/src/failover.ts:170](review-file:packages/ice/src/failover.ts:170) の `FailoverMonitor` が、ソケットごとの退避先、1 本の timer、check のペーシング、書き込み状態の判定を持ちます。ペアごとに `setInterval` を張らず、最も近い時刻に 1 本だけ timer を張ります（leak 対策）。

- 判定関数: [packages/ice/src/failover.ts:53](review-file:packages/ice/src/failover.ts:53)（`isUnwritable` ほか）
- 次回 ping 時刻: [packages/ice/src/failover.ts:89](review-diff:packages/ice/src/failover.ts:89)（`nextPingAt`）。未応答なら 900 ms、そうでなければ安定時の間隔。2.5 s 何も受けなければその時点で check します。
- `FailoverHost` は `Connection` との境界で、`ping` / `validated` / `dropped` / `changed` / `recovered` を渡します。

### 3.2 `Connection` への接続

[packages/ice/src/ice.ts](review-diff:packages/ice/src/ice.ts) の主な変更です。

| 変更 | 場所 |
| --- | --- |
| 対象判定 `failoverEnabled()` | [packages/ice/src/ice.ts:3418](review-file:packages/ice/src/ice.ts:3418) |
| 選択の切り替え（元ペアを demote。3 回連続応答まで戻さない） | [packages/ice/src/ice.ts:2660](review-diff:packages/ice/src/ice.ts:2660) |
| consent 失効時、書き込み可能な退避先があれば `failed` にしない | [packages/ice/src/ice.ts:2085](review-diff:packages/ice/src/ice.ts:2085) |
| ロール変更で consent の進行中 request を中断（`consentRoleEpoch`） | [packages/ice/src/ice.ts:2511](review-diff:packages/ice/src/ice.ts:2511) |
| 指名中の回復でも指名を取り消さない（`failoverNomination`） | [packages/ice/src/ice.ts:3275](review-diff:packages/ice/src/ice.ts:3275) |

### 3.3 定数

[packages/ice/src/iceBase.ts](review-diff:packages/ice/src/iceBase.ts) に libwebrtc の値を移しました。900 ms / 2500 ms / 5 回 / 5000 ms / 2500 ms / 30 s / 3 回。これに加えて、werift 独自の `BACKUP_UNKNOWN_RTT_RESPONSE_TIMEOUT`（3 s）、`FAILOVER_BACKUP_ATTEMPTS`（3）、`FAILOVER_RECOVERY_RESPONSES`（3）を追加しています。

### 3.4 `packages/webrtc`

[packages/webrtc/src/secureTransportManager.ts:715](review-diff:packages/webrtc/src/secureTransportManager.ts:715) で、`connectionState` が `disconnected` から `connected` に戻る遷移を追加しました。全 DTLS transport が connected / closed のときだけ戻ります（W3C の集約どおり）。

### 3.5 テストと E2E、文書

- 単体と実ソケット: [packages/ice/tests/ice/failover.test.ts:19](review-file:packages/ice/tests/ice/failover.test.ts:19)。共通の Arrange は [packages/ice/tests/utils.ts](review-diff:packages/ice/tests/utils.ts) です。
- E2E（Chrome が controlled）: [e2e/tests/ice/failover.test.ts:94](review-file:e2e/tests/ice/failover.test.ts:94)
- 状態遷移のテスト: [packages/webrtc/tests/transport/ice.test.ts](review-diff:packages/webrtc/tests/transport/ice.test.ts)
- memleak の media シナリオのハーネス修正: [packages/webrtc/tests/memleak/scenarios.ts](review-diff:packages/webrtc/tests/memleak/scenarios.ts)
- 挙動の記載: [packages/ice/README.md:94](review-file:packages/ice/README.md:94)、[changelog.md](review-diff:changelog.md)。生成ドキュメント（`doc/`、`packages/ice/doc`）は `npm run doc` で更新しています。

## 4. 判断理由

- **退避先の単位はローカルの `Protocol` ごとに 1 ペア**。同じソケットの host と srflx は経路が同じなので分けません。すべての valid ペアを監視する案は、ping がペア数に比例して増えるため採用しませんでした。
- **書き込み不可の判定は 5 回かつ 5 s**。libwebrtc の `CONNECTION_WRITE_CONNECT_FAILURES` / `_TIMEOUT` に合わせています。consent の間隔（5 s）自体は短くせず、弱い状態のときだけ 900 ms にします。
- **RTT やネットワークコストでの切り替えは入れない**。切り替えの理由は「書き込み不可」に限ります。
- **対象外は従来どおり**。regular nomination は RFC 8445 §8.1.1 が再指名を認めないため、ICE-TCP と ICE-lite は退避の前提が合わないためです。

## 5. レビュアーが確認すべき点・リスク

- **`disconnected` の新設**: 以前は `ice.ts` の型にしかなかった状態に入る経路を足しました。`iceConnectionState` / `connectionState` が `connected → disconnected → connected` と動きます。アプリ側のイベント処理に影響する可能性があります。
- **consent 周りの変更**: failover 対象では、前の consent request の結果を待たずに次を送ります（高 RTT で退避が遅れないため）。要求は取り消さず、それぞれの応答待ちで結果を出します。[packages/ice/src/ice.ts:2183](review-file:packages/ice/src/ice.ts:2183) 付近が最も複雑です。
- **退避先の check は USE-CANDIDATE / NOMINATION を付けない**。指名は切り替えのときだけです。
- **controlled 側**: 自分では指名せず、相手の指名とデータに従います（親チケット §10 T1）。監視と状態遷移は行います。
- **退避先の応答待ち 3 s**: 従来の 1 s では RTT が 1 s を超える退避先が有効にならないため、libwebrtc の `DEFAULT_RTT` に合わせた独自の値です。
- **差分に含まれる範囲外の変更**: memleak のハーネス修正（`tests/memleak/scenarios.ts`）は、この環境の loopback の受信バッファあふれで media シナリオが失敗していたための修正です。leak 判定は変えていません。
- **公開 API**: 追加した定数が `iceBase.ts` から export され、生成ドキュメントに載ります。メソッドや型の変更は確認できていません。

## 6. 検証結果

チケットの実施結果（第 4 回）に記載された内容です。この文書の作成時には再実行していません。

| コマンド | 結果 |
| --- | --- |
| `npm run type` | 通過 |
| ice の全テスト | 547 件通過 |
| `npm run test:small` | 通過（webrtc 1729 件を含む） |
| `npm run e2e` | 25 ファイル / 73 件通過（Chrome が controlled の退避を含む） |
| `npm run wpt` | 退行 0。全体実行で `protocol/bundle.https.html` が 1 回 timeout したが、単独 3 回は従来どおり PASS 1 で、負荷による timeout と判断 |
| `npm run memleak`（既定設定） | media・datachannel・connection・renegotiation が PASS。synthetic-leak は想定どおり検出 |

未確認事項: Chrome が controlled のとき、prune 済みの下位接続への退避に追従するかは、ticket の記載では `e2e/tests/ice/failover.test.ts` で確認済みです（semi-aggressive / renomination とも）。
