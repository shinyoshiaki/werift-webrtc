---
ide:
  viewer: review-document
  version: 1
  title: "ICE フェイルオーバー（ICE restart なし）のレビュー"
  dock: right
  baseCommit: 1fad7f60e0f42d21418bac0064c14e07516cca20
---
# ICE フェイルオーバー（ICE restart なしで次のペアへ移る）のレビュー

## 1. 概要

選択中のペア（`Connection.nominated`）が応答しなくなったとき、werift は従来 30 s の consent 失効で `failed` になり、アプリ側の ICE restart を待つしかありませんでした。今回、libwebrtc と同じ考え方で「ローカルのソケット（`Protocol`）ごとに 1 つの退避先ペア」を選択後も監視し続け、選択中のペアが書き込み不可になると、`controlling` 側が退避先を指名して ICE restart なしで切り替えます。

対象は full ICE の semi-aggressive / renomination のみです。regular nomination、ICE-TCP、ICE-lite では従来の挙動を変えません（[packages/ice/src/ice.ts:3179](review-file:packages/ice/src/ice.ts:3179) の `failoverEnabled()` ほか）。

差分の基準は、チケット worktree に取り込み済みの親チケットのマージコミット `e83850f0e` です。headCommit は `1fad7f60e`（第 12 回: 不変条件への整理と行列テスト）です。

### 受け入れテスト（ここだけ見れば目的の達成を確認できます）

[packages/ice/tests/ice/failover-acceptance.test.ts:18](review-file:packages/ice/tests/ice/failover-acceptance.test.ts:18) の 1 ファイルで、チケットの目的「選択中の host 経路が切れても、ICE restart なしで両端が relay 経路へ移り、データが届く（修正前は consent 失効で `failed`）」を確かめられます。実ソケット（werift 同士）とローカルの TURN サーバーを使い、`cutHostPath()` で host ↔ host の経路だけを両方向とも落とします（共通の準備処理は [packages/ice/tests/utils.ts:3711](review-file:packages/ice/tests/utils.ts:3711) の `createFailoverRealPair`）。

| 件 | 確認すること |
| --- | --- |
| [(semi-aggressive / renomination) 1章・F3・F5](review-file:packages/ice/tests/ice/failover-acceptance.test.ts:19) | host 経路で接続しデータが届く → 遮断から 6 s 以内（§15 A。実測 3.9 s）に controlling 側が relay 経路へ移る → controlled 側も同じ 5-tuple に移り、データが双方向に届く → ICE restart なし（`generation` 不変）、両端とも `failed` を経ずに `connected` |

実行: `cd packages/ice && npx vitest run tests/ice/failover-acceptance.test.ts`（2 件、各 4.6〜6.0 s。§15 の前は各 8〜10 s）。10 回連続で通過しました。修正前のリビジョン `e83850f0e` では 2 件とも失敗します（relay 経路へ移らない）。

壊して確かめた箇所: controlling の退避の指名をやめる・書き込み不可を判定しない・退避先を監視しない、の 3 つは 2 件とも失敗。下位への置き換え（`failoverReplaces`）を外す・controlled が同じ値の指名で追従しない、の 2 つは semi-aggressive だけが失敗します（renomination は値の大きい NOMINATION で常に移るため、仕様どおり）。regular nomination は対象外（F7）のため、この件には含めず既存の `failover.test.ts` で確認しています。

### 不変条件の行列テスト

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
| 対象判定 `failoverEnabled()` | [packages/ice/src/ice.ts:3179](review-file:packages/ice/src/ice.ts:3179) |
| 選択の切り替え（元ペアを demote。3 回連続応答まで戻さない） | [packages/ice/src/ice.ts:2301](review-diff:packages/ice/src/ice.ts:2301) |
| consent 失効時、書き込み可能な退避先があれば `failed` にしない | [packages/ice/src/ice.ts:2085](review-diff:packages/ice/src/ice.ts:2085) |
| ロール変更で consent の進行中 request を中断（`consentRoleEpoch`） | [packages/ice/src/ice.ts:2511](review-diff:packages/ice/src/ice.ts:2511) |
| 指名中の回復でも指名を取り消さない（`failoverNomination`） | [packages/ice/src/ice.ts:3259](review-diff:packages/ice/src/ice.ts:3259) |

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

### 3.6 第 12 回の変更（不変条件への整理）

これまで指摘ごとに点で直してきた「eligible な経路があるのに監視されない／使われない」を、1 つの不変条件に整理しました。行列テストで 3 つの未修正の穴（A・B・C）が見つかり、次の 3 点で直しています。

| 穴 | 条件 | 修正 | 場所 |
| --- | --- | --- | --- |
| A | controlled、同一ソケットに上位のリモート。上位が一度も check されず、選択断で `disconnected`、consent 失効で `failed` | 同一ソケットの別リモートは順位に関係なく退避先の候補にする。上位を除外するのは、自分で選択を上へ移す agent（controlling かつ semi-aggressive / renomination、`movesSelectionUp()`）だけ | [packages/ice/src/failover.ts:457](review-diff:packages/ice/src/failover.ts:457)、[packages/ice/src/ice.ts:3210](review-diff:packages/ice/src/ice.ts:3210) |
| B | controlling、同一ソケット上位が 60 s 以上落ちてから復帰。再試行が 5 回で止まり、復帰を拾えない | failover 有効中は 16 s ごとに再試行を続ける（`retriesForever`）。選択断で退避先がないときは、FAILED の上位ペアをすぐ check する（`checkFailedOutranking`） | [packages/ice/src/nomination/selectionReplacement.ts:147](review-diff:packages/ice/src/nomination/selectionReplacement.ts:147)、[packages/ice/src/nomination/selectionReplacement.ts:175](review-diff:packages/ice/src/nomination/selectionReplacement.ts:175)、[packages/ice/src/ice.ts:3255](review-diff:packages/ice/src/ice.ts:3255) |
| C | controlled、semi-aggressive、相手が下位の退避先を USE-CANDIDATE だけ（データなし）で指名。切り替わらず 40 s で `failed` | 選択が down（`selectionDown`）で、nomination の値が等しく、指名されたペアが SUCCEEDED なら置き換える。libwebrtc の controlled が書き込み可否を優先度より先に比べるのと同じ | [packages/ice/src/nomination/selectionReplacement.ts:261](review-diff:packages/ice/src/nomination/selectionReplacement.ts:261) |

テスト側では、[packages/ice/tests/ice/semi-aggressive.test.ts](review-diff:packages/ice/tests/ice/semi-aggressive.test.ts) の 2 件を新しい規則に合わせて書き換えています。「再試行は 5 回で止まる」は「5 回目の後も 16 s ごとに続く」に、「ロール変更で再試行が止まる」は「controlled になった側は上位ペアとしての再 check（ICE-CONTROLLING / USE-CANDIDATE）を送らない」になりました。同一ソケットの退避先としての監視（ICE-CONTROLLED、指名なし）は続きます。

### 3.7 第 13 回の変更（§15: 退避先への切り替えの高速化 A・B・C）

両方向の断から退避まで約 5〜10 s かかっていたのを、libwebrtc に合わせて短くしました。テストは [packages/ice/tests/ice/failover-detection.test.ts:41](review-file:packages/ice/tests/ice/failover-detection.test.ts:41) の 1 ファイル（20 件）にまとめています。

| 案 | 内容 | 場所 |
| --- | --- | --- |
| A 受信途絶 | 選択中のペアが 2.5 s + 1 s 何も受けず、check が 1 回以上未応答なら、controlling は受信している（weak でない）退避先へ指名する。controlled は同じ状態で、同じ強さの USE-CANDIDATE に従う。遮断から約 3.9 s | [packages/ice/src/failover.ts:160](review-file:packages/ice/src/failover.ts:160)、[packages/ice/src/ice.ts:2844](review-file:packages/ice/src/ice.ts:2844) |
| B 経路の消失 | UDP の送信の経路エラー（`PATH_BROKEN_SEND_ERRORS`）、TURN allocation の喪失（TCP/TLS の切断・Refresh の失敗）を `Protocol.onPathBroken` で報告し、その経路のペアをすぐ書き込み不可にする。STUN は常に、データは 100 ms に 1 個、完了コールバックつきで送る | [packages/ice/src/stun/protocol.ts:24](review-file:packages/ice/src/stun/protocol.ts:24)、[packages/ice/src/turn/protocol.ts:351](review-file:packages/ice/src/turn/protocol.ts:351)、[packages/ice/src/ice.ts:2964](review-file:packages/ice/src/ice.ts:2964)、[packages/common/src/transport.ts:511](review-file:packages/common/src/transport.ts:511) |
| C 閾値 | `IceOptions.failover` / `PeerConfig.iceFailover`（`unwritableMinChecks`・`unwritableTimeout`・`receivingTimeout`・`receivingSwitchingDelay`、既定値は libwebrtc） | [packages/ice/src/iceBase.ts:479](review-file:packages/ice/src/iceBase.ts:479)、[packages/ice/src/failover.ts:36](review-file:packages/ice/src/failover.ts:36)、[packages/webrtc/src/api/peerConfig.ts:181](review-file:packages/webrtc/src/api/peerConfig.ts:181) |

作業中に、consent の最初の check が無受信 2.5 s の規則に従っていない漏れ（§14 までの D3 にもあったもの）を見つけて直しました（[packages/ice/src/consent.ts:296](review-file:packages/ice/src/consent.ts:296)）。新しい選択の直後に切れた経路は、最初の check が 4〜6 s 後になっていました。このため受け入れテストの切り替えが 4.7〜6.5 s にばらついていました。直した後は 3.9 s で一定です。各仕組みを 1 か所ずつ壊して、対応するテストが落ちることをチケット §15.7 に記録しています。

## 4. 判断理由

- **点修正をやめ、不変条件と行列テストにした**。指摘が毎回同じ族（監視されない／使われない）だったためです。例外は「自分で選択を上へ移す agent の上位ペアは `SelectionReplacement` に任せる」の 1 つだけにしました。
- **退避先の単位はローカルの `Protocol` ごとに 1 ペア**。同じソケットの host と srflx は経路が同じなので分けません。すべての valid ペアを監視する案は、ping がペア数に比例して増えるため採用しませんでした。
- **書き込み不可の判定は 5 回かつ 5 s**。libwebrtc の `CONNECTION_WRITE_CONNECT_FAILURES` / `_TIMEOUT` に合わせています。consent の間隔（5 s）自体は短くせず、弱い状態のときだけ 900 ms にします。
- **RTT やネットワークコストでの切り替えは入れない**。切り替えの理由は「書き込み不可」と「受信途絶」（§15 A、libwebrtc の receiving）に限ります。受信途絶には未応答の check を条件にしたので、idle の接続や、応答が期限内に届く遅い経路では切り替わりません。
- **インターフェースの消失の定期的な確認は入れない**（§15 B）。アドレスが消えると次の送信が経路エラーになるので、データが流れていれば 100 ms 以内、idle でも次の check で検知できるためです。
- **対象外は従来どおり**。regular nomination は RFC 8445 §8.1.1 が再指名を認めないため、ICE-TCP と ICE-lite は退避の前提が合わないためです。

## 5. レビュアーが確認すべき点・リスク

- **`disconnected` の新設**: 以前は `ice.ts` の型にしかなかった状態に入る経路を足しました。`iceConnectionState` / `connectionState` が `connected → disconnected → connected` と動きます。アプリ側のイベント処理に影響する可能性があります。
- **consent 周りの変更**: failover 対象では、前の consent request の結果を待たずに次を送ります（高 RTT で退避が遅れないため）。要求は取り消さず、それぞれの応答待ちで結果を出します。[packages/ice/src/ice.ts:2183](review-file:packages/ice/src/ice.ts:2183) 付近が最も複雑です。
- **退避先の check は USE-CANDIDATE / NOMINATION を付けない**。指名は切り替えのときだけです。
- **controlled 側**: 自分では指名せず、相手の指名とデータに従います（親チケット §10 T1）。監視と状態遷移は行います。
- **退避先の応答待ち 3 s**: 従来の 1 s では RTT が 1 s を超える退避先が有効にならないため、libwebrtc の `DEFAULT_RTT` に合わせた独自の値です。
- **差分に含まれる範囲外の変更**: memleak のハーネス修正（`tests/memleak/scenarios.ts`）は、この環境の loopback の受信バッファあふれで media シナリオが失敗していたための修正です。leak 判定は変えていません。
- **上位ペアの再試行が無期限になった**: failover 有効中は 16 s ごとのタイマーが選択の続く間ずっと残ります。close とロール変更では止まること、対象外（ICE-TCP など）では従来どおり 5 回で止まることを確認してください（[packages/ice/tests/ice/semi-aggressive.test.ts](review-diff:packages/ice/tests/ice/semi-aggressive.test.ts)）。
- **controlled の置き換え条件が広がった**: 選択が down のとき、同じ値の USE-CANDIDATE で置き換わります。選択が生きている間の挙動は変わりません。
- **§15 の切り替えの前倒し**: 3.5 s 以上何も届かない経路は、書き込み不可を待たずに切り替わります。戻りには従来どおり 3 回連続の応答が必要です。短い閾値（C）を選ぶと、短い損失でも切り替わります。
- **§15 の送信の確認**: STUN と、ソケットごとに 100 ms に 1 個のデータを、完了コールバックつきで送るようになりました（Node.js はコールバックなしの UDP の送信エラーを捨てるため）。IP アドレス宛ての送信は、従来どおり reject しません。
- **公開 API**: 追加した定数が `iceBase.ts` から export され、生成ドキュメントに載ります。メソッドや型の変更は確認できていません。

## 6. 検証結果

§15（第 13 回）の後の結果（作業前のリビジョン `aaacc5263`、変更は未コミット。詳細はチケット §15.9）:

| コマンド | 結果 |
| --- | --- |
| `cd packages/ice && npm test` | 1197 件通過 |
| `npm run type` | 通過 |
| `npm run test:small` | 通過（webrtc 2152 件を含む） |
| `npm run e2e` | 27 ファイル / 77 件通過（Chrome の failover は単独でも 2 件通過、各 4.2 s） |
| `npm run wpt` | PASS 582、退行 0 |
| `npm run memleak` | 未実施 |

以下は第 12 回までの結果です。

チケット §13.7 に記載された実施結果です。この文書の作成時には再実行していません（作業前のリビジョンは `fc09f02bd`）。

| コマンド | 結果 |
| --- | --- |
| `cd packages/ice && npm test` | 54 ファイル / 1099 件通過 |
| `failover-matrix.test.ts` | 修正前は 51 件中 16 件失敗、修正後は 53 件通過（5 回連続） |
| `npm run type` | 通過 |
| `npm run test:small` | 通過（webrtc 1838 件を含む） |
| `npm run e2e` | 26 ファイル / 76 件通過 |
| `npm run wpt` | PASS 577、退行 0 |
| `npm run memleak`（既定設定） | connection・media・renegotiation は PASS、合成 leak は想定どおり検出。datachannel は受信 timeout で失敗（この環境の UDP 受信バッファあふれによる既知の問題で、第 5 回に変更前のコードでも再現と記録） |

未確認事項: memleak の datachannel の失敗が今回の変更と無関係であることは、第 5 回の記録に依拠しています。この回では変更前との比較を行っていません。
