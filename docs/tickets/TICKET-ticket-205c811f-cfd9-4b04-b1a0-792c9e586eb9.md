# ICE: ペアの選び方に RTT・受信状態・切り替え抑制を入れる（libwebrtc の ICE controller 相当）

親チケット: 05c13603-5044-4cc6-8d8f-7cc322c68db1（semi-aggressive nomination / renomination）の §10 で「後続タスク」とした項目 4。

**前提**: サブタスク 6b2d7627-9106-41e3-95ed-692fc4828d3f「ICE: 選択中のペアが切れたら ICE restart なしで次のペアへ移る（libwebrtc 互換のフェイルオーバー）」（項目 3）の常時監視（選択後も複数のペアの疎通・RTT を測り続ける仕組み）が入ってから着手する。

## 1. 目的と背景

- 親チケットの semi-aggressive / renomination では、controlling 側の werift は「選択より優先度の高いペアの check が成功したら移る」だけで、基準は候補ペアの priority（RFC 8445 §6.1.2.3）しかない。
- priority は候補の種類（host / srflx / relay）と local preference で決まり、実際の RTT や損失とは一致しないことがある。たとえば relay どうし（TURN/UDP の複数サーバー）、IPv4 / IPv6、複数インターフェースの場合。
- libwebrtc（Chrome）の ICE controller は、疎通・受信状態、ネットワークコスト、priority、RTT を順に比べ、受信状態の変化には切り替えの保留時間を設けて、頻繁な切り替えを避けている。

## 2. 現状（親チケット HEAD 時点）

| 項目 | 現状 |
| --- | --- |
| controlling の置き換え | `replacesSelectedPair()`: semi-aggressive は `outranks()`（priority）だけ。renomination は `evaluateSelection()` の最良 valid ペア（priority 順） |
| controlled の選択 | 指名の値 → 直近にデータを受けたペア（§10 T1）→ priority |
| RTT | `CandidatePair.rtt` / `totalRoundTripTime` に check の RTT を記録しているが、選択には使っていない |
| 切り替えの抑制 | 上位にしか移らないので行ったり来たりはしない。下位へ移る仕組み（項目 3）を入れると抑制が必要になる |
| 監視 | 選択後は上位ペアの check と、選択中のペアの consent だけ（項目 3 で拡張予定） |

## 3. libwebrtc の挙動（main、2026-11-13 取得のソースで確認）

`basic_ice_controller.cc`:

- `ShouldSwitchConnection`（497〜552 行付近）:
  1. 送信可能でない接続には移らない
  2. ネットワーク上の好み・コストが劣り、受信もしていない接続には移らない（たまたま良く見えるだけかもしれないため）
  3. `CompareConnections` で比べる（下記）。新しい接続の方が受信状態だけで勝ち、その差が `receiving_switching_delay` 未満の間は保留し、後で再判定する（recheck event）
  4. 比較で同等なら、RTT が `kMinImprovement`（10 ms）以上良くなる場合だけ移る
- `CompareConnections`（721 行付近）: 状態（書き込み可能・書き込み状態・受信）→ controlled なら指名の値と最終受信時刻 → `CompareConnectionCandidates`（ネットワークコスト、priority、generation）
- 最初の選択にも抑制がある（`HandleInitialSelectDampening`）

## 4. 要件（案）

| # | 要件 |
| --- | --- |
| M1 | controlling の置き換え判定を「状態 → priority → RTT」の順にする。priority が同じペアどうしでは、RTT が一定以上（例: 10 ms）良い場合だけ移る |
| M2 | 受信状態の変化による切り替えに保留時間を設ける（libwebrtc の `receiving_switching_delay` 相当）。保留中に元のペアが回復すれば移らない |
| M3 | 置き換えの判定は、check の成功時だけでなく、RTT の更新時・受信状態の変化時にも行う（項目 3 の監視スケジューラに載せる） |
| M4 | RTT の値は単発でなく平滑化した値を使う（`totalRoundTripTime / roundTripTimeMeasurements` か指数移動平均）。外れ値 1 回で切り替えない |
| M5 | 切り替えのたびに、semi-aggressive は USE-CANDIDATE、renomination は NOMINATION の値を増やして指名する（親チケットと同じ）。controlled 側の追従は §10 T1 のまま |
| M6 | 既定値は libwebrtc に合わせる。閾値と保留時間を `IceOptions` に出すかは要検討 |

## 5. 影響範囲

- `packages/ice/src/ice.ts`: `replacesSelectedPair()`、`evaluateSelection()`、項目 3 の監視スケジューラ
- `packages/ice/src/iceBase.ts`: RTT の平滑化値（`CandidatePair`）、オプションを足す場合は `IceOptions`
- `packages/webrtc`: オプションを露出する場合は `PeerConfig`
- 統計（`getStats()` の `currentRoundTripTime` との整合）

## 6. テスト（案）

1. 単体（fake timer、RTT を注入できる harness）: priority が同じ 2 ペアで、RTT が 10 ms 以上良いペアへ移る、10 ms 未満なら移らない
2. 単体: 受信状態の差だけで勝つペアへの切り替えは保留時間の間保留され、元のペアが回復すれば移らない
3. 単体: 外れ値 1 回の RTT では移らない
4. 実ソケット: 片方の経路にだけ遅延を注入し（テスト用の UDP 中継など）、遅い経路から速い経路へ両端が移る
5. 既存の semi-aggressive / renomination / consent のテストに退行がない

## 7. 完了条件

- [ ] M1〜M6 が実装され、6 のテストが追加されて通る
- [ ] `npm run type`、`npm run test:small`、`npm run e2e` で退行がない
- [ ] `changelog.md` と生成ドキュメントを更新する（オプションを足した場合）

## 7.1 受け入れテスト

`packages/ice/tests/ice/selection-acceptance.test.ts` を追加しました。

- **Before → After:** priority が同じ 2 本の relay の一方で接続しているとき、選択中の relay だけが遅くなるとします。従来は priority だけで判断するので遅い relay に留まりました。今は controlling 側が平滑化 RTT を比べて速い relay を指名し、両端がそこへ移ってデータが届きます。semi-aggressive と renomination で同じ期待です。
- **準備処理:** 実ソケットとローカル TURN を使い、relay ごとに UDP 中継を置きます。共通の準備処理は `tests/utils.ts` の `createRttSwitchRealPair` で、backup のペアを取り出す `relayPairOf` を足しました。
- **実行結果:** 10 回連続で通過しました（1 回あたり 2 件で約 20 秒）。

一時 worktree で実装を 1 か所ずつ壊し、受け入れテストが落ちることを確かめました。

| 壊した箇所 | 結果 |
| --- | --- |
| M1: `shouldSwitch` の RTT 比較を無効にする | 両モードとも失敗（速い relay へ移らない） |
| M3: `onLinkChanged` での `switching.evaluate()` をやめる | 両モードとも失敗 |
| M4: `recordRoundTrip` で RTT 標本を記録しない | 両モードとも失敗（前提の「backup の RTT が測れる」で止まる） |
| M5: 切り替え時に `selection.nominate` しない | 両モードとも失敗 |

- **修正前のリビジョンとの比較:** していません。修正前には `smoothedRtt` がないので、テストは前提確認の段階で落ちます。これでは priority だけで判断する挙動を確かめられないため、M1 を壊した結果で代わりとしました。
- **M2（受信状態の保留）を外した理由:** 実ソケットでは「2.5 s の無受信」「未応答の確定」「保留 1 s」の境界を安定して作れません。M2 は `tests/ice/selection-controller.test.ts` の fake timer のテストで確認しています。

## 8. 未確定事項

1. `receiving_switching_delay` などの libwebrtc の既定値（定数の定義ファイルは未確認）
2. RTT の平滑化の方法と、比較に使う閾値
3. 閾値・保留時間を `IceOptions` / `PeerConfig` に出すか
4. ネットワークコスト（Wi-Fi / 携帯回線）は Node.js から取れないので扱わない、で良いか
5. 項目 3（フェイルオーバー）と同じタスクにまとめるか、この順で分けたままにするか