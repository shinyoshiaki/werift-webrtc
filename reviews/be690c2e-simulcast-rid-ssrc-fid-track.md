---
ide:
  viewer: review-document
  version: 1
  title: "Simulcast: a=ssrc / FID 付き RID 受信を RID のトラック 1 本にそろえる"
  dock: right
  baseCommit: 38b856315447db61186d61c140155f203de2dd29
---
# Simulcast: a=ssrc / FID 付き RID 受信を RID のトラック 1 本にそろえる

## 1. 概要

RID で simulcast を受ける m-line に `a=ssrc` / `a=ssrc-group:FID` があっても、アプリへ渡すトラックは RID ごとの 1 本だけにしました。これまでは high レイヤーの SSRC 用に余計なトラックが 1 本作られ、high の RTX 復元パケットがそちらへ流れていました（Firefox の answer で再現）。

`a=ssrc` は RID を指さないため、SDP からレイヤーを決めず、RID 付きパケットから学習する経路に一本化しました。FID は「RTX SSRC → 媒体 SSRC」の表としてだけ保持し、再交渉（pranswer / rollback / 再 offer）でも壊れないようにしています。

## 2. 修正前の問題と修正後の仕組み

<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px;font-family:sans-serif">
<div style="border:2px solid #d9534f;border-radius:8px;padding:10px">
<b style="color:#d9534f">Before（Firefox の answer）</b>
<ol style="margin:6px 0;padding-left:18px">
<li><code>getRemoteRtpParams</code>: <code>encodings[].ssrc = media.ssrc[0]</code>（high の媒体 SSRC）</li>
<li><code>registerRtpReceiverBySsrc</code> が SSRC のトラックを作成 → <code>onTrack</code> が 3 回</li>
<li>high の媒体は <code>handleRtpByRid</code> で RID トラックへ。ただし <code>trackBySSRC</code> は SSRC のトラックのまま</li>
<li>high の RTX: <code>handleRtxByRid</code> → <code>mediaSsrcOfRtx</code> → <b style="color:#d9534f">SSRC のトラックへ復元</b></li>
<li>RID の <code>high</code> トラックに復元パケットが届かず、NACK と再送が続く</li>
</ol>
</div>
<div style="border:2px solid #2e8b57;border-radius:8px;padding:10px">
<b style="color:#2e8b57">After</b>
<ol style="margin:6px 0;padding-left:18px">
<li><code>receivesByRid(media)</code> が真なら <code>ssrcs = []</code>。SSRC のトラックも媒体 SSRC の経路も作らない</li>
<li><code>onTrack</code> は RID の数だけ（high / low）</li>
<li>媒体パケットの RID から <code>trackBySSRC[media]</code> を RID トラックへ学習</li>
<li>FID は <code>ridRtxPairs</code> → <code>ridFidMediaByRtx</code>。RTX SSRC は受信者へルーティング</li>
<li>RTX は <b style="color:#2e8b57">RID のトラックへ復元</b>（<code>repairedRid</code> / FID 経由）</li>
</ol>
</div>
</div>

<p style="font-size:12px;color:#666">図: 同じ Firefox answer（a=rid ×2、a=ssrc ×4、FID ×2）を受けたときの処理。赤が問題の経路、緑が修正後の経路です。</p>

## 3. 主要変更

### 3.1 SDP から SSRC のトラックを作らない

[packages/webrtc/src/transceiverManager.ts:78](review-file:packages/webrtc/src/transceiverManager.ts:78) に `receivesByRid` を追加しました。`a=rid:<id> send`（制約付き `send max-width=...` を含む）があれば RID 受信と判定します。

変更の核は [packages/webrtc/src/transceiverManager.ts:968](review-diff:packages/webrtc/src/transceiverManager.ts:968) です。RID 受信では `encodings[].ssrc` と RTX の SDP 対応（`media.ssrc` 由来）を作らず、代わりに `ssrcGroup` の FID から `ridRtxPairs` を組み立てます。

### 3.2 FID を RTX SSRC のルーティングと表に使う

[packages/webrtc/src/media/parameters.ts:99](review-diff:packages/webrtc/src/media/parameters.ts:99) に内部用の `ridRtxPairs` を追加しました（`@internal`、公開 API 変更なし）。

- [packages/webrtc/src/media/router.ts:516](review-diff:packages/webrtc/src/media/router.ts:516): RTX SSRC だけを受信者へ登録します。保留中の記述では、受信者がすでに学習した経路を上書きしません。
- [packages/webrtc/src/media/router.ts:730](review-diff:packages/webrtc/src/media/router.ts:730): SDP で経路が決まっている RTX でも、repaired RID を持つなら `handleRtxByRid` へ渡します（`readsRepairedRid`）。

### 3.3 RTX の復元先を RID から引く

[packages/webrtc/src/media/rtpReceiver.ts:140](review-diff:packages/webrtc/src/media/rtpReceiver.ts:140) 付近が中心です。

- `ridFidMediaByRtx`: 確定済み FID の RTX SSRC → 媒体 SSRC。パケットごとに RID を導出し、束縛状態を持たないので表の変更で古い状態が残りません。
- `mediaSsrcOfRtx`: repaired RID、FID の媒体 SSRC を持つ RID、既存の RID 束縛の順に RID を決めます。RID が退役させた RTX SSRC は捨てます。
- 媒体 SSRC が切り替わったとき、FID の RTX SSRC は束縛を外さず、新しい媒体 SSRC の穴だけを復元します。
- 再交渉: `stagedRidFidTable` に最新の保留記述の FID 表全体を持ち、確定で置換、rollback で `snapshotReceiveTables` / `restoreReceiveTables` から戻します。

状態の扱いは [packages/webrtc/src/negotiationTransaction.ts:147](review-diff:packages/webrtc/src/negotiationTransaction.ts:147) の設計コメントに追記しました。

### 3.3.1 確定で外れた FID の RTX SSRC の経路を解放する（最新コミット 38b856315）

再レビュー指摘への修正です。再交渉の確定で FID の組が外れた RTX SSRC に SDP 由来の経路が残ると、BUNDLE の別 m-line が同じ SSRC を MID と repaired RID 付きで使っても、古い受信者へ届いてしまいます。

- [packages/webrtc/src/media/rtpReceiver.ts:1432](review-diff:packages/webrtc/src/media/rtpReceiver.ts:1432): `takeDroppedFidRtxSsrcs` を追加。確定で FID の組が外れ、かつ他の記述（FID、トラック SSRC、`a=ssrc` の RTX 対応）にも残っていない RTX SSRC を返します。rollback のスナップショット復元と reset では記録を空にします。
- [packages/webrtc/src/media/router.ts:604](review-diff:packages/webrtc/src/media/router.ts:604): `releaseDroppedFidRtx` が、その SSRC の SDP 由来の経路と `stagedSsrc` / `provisionalSsrc` を外します。パケットから学習した経路は残します。以降のパケットは未知の SSRC として MID と repaired RID で振り分けられます。
- [packages/webrtc/src/negotiationTransaction.ts:345](review-diff:packages/webrtc/src/negotiationTransaction.ts:345): 確定処理で、各受信者が FID 表を確定した後に呼びます。設計コメントも更新しました。
- テスト: [packages/webrtc/tests/media/firefoxSimulcastRepairedRidRoute.test.ts](review-file:packages/webrtc/tests/media/firefoxSimulcastRepairedRidRoute.test.ts) に 2 件。外れた RTX SSRC が repaired RID の指す RID のトラックへ学習で復元されるケースと、BUNDLE の別 m-line が使うケースです。共有 Arrange は [packages/webrtc/tests/media/rtpReceiverTestUtils.ts](review-file:packages/webrtc/tests/media/rtpReceiverTestUtils.ts) に追加しています。

### 3.4 a=rid の制約の保持

[packages/webrtc/src/sdp.ts:291](review-diff:packages/webrtc/src/sdp.ts:291) で `a=rid:high send max-width=1280` の制約を `restrictions` として保持し、再出力します。answer 側では offerer の制約を落とします（[packages/webrtc/src/sdpManager.ts:1094](review-diff:packages/webrtc/src/sdpManager.ts:1094)）。direction に制約が混ざって RID 受信を取り逃すのを防ぐための変更です。

### 3.5 E2E

[e2e/tests/fixture.ts:13](review-diff:e2e/tests/fixture.ts:13) で `firefoxKnownIssue.simulcastSsrcTrack` を削除し、[e2e/tests/mediachannel/simulcast.test.ts:1](review-diff:e2e/tests/mediachannel/simulcast.test.ts:1) の Firefox 用 skip を外しました。`grep -rn "firefox-known:simulcast-ssrc-track" e2e/tests` は 0 件です。

## 4. テスト

| ファイル | 内容 |
| --- | --- |
| [packages/webrtc/tests/media/firefoxSimulcastSsrc.test.ts:25](review-file:packages/webrtc/tests/media/firefoxSimulcastSsrc.test.ts:25) | answer / offer の両方でトラック数と両レイヤーの RTX 復元先を確認。媒体 SSRC 切替、遅延 RTX、再 offer、pranswer、rollback の各ケース |
| [packages/webrtc/tests/media/firefoxSimulcastFidMatrix.test.ts:29](review-file:packages/webrtc/tests/media/firefoxSimulcastFidMatrix.test.ts:29) | FID の変更と到着順の組み合わせ |
| [packages/webrtc/tests/media/firefoxSimulcastRepairedRidRoute.test.ts:20](review-file:packages/webrtc/tests/media/firefoxSimulcastRepairedRidRoute.test.ts:20) | `readsRepairedRid` を通る経路 |
| [packages/webrtc/tests/media/rtpReceiverTestUtils.ts](review-file:packages/webrtc/tests/media/rtpReceiverTestUtils.ts) | 共有の Arrange |

## 5. 判断理由

- **SDP から RID と a=ssrc を対応付けない**: `a=ssrc` に RID の属性がなく、推測すると誤った対応になります。既存の RID 学習に任せます（チケットの方針どおり）。
- **FID を媒体 SSRC の経路としては使わない**: 使うのは RTX SSRC のルーティングと「どの媒体を修復するか」だけです。RID の確定は媒体パケットの RID で行います。
- **RTX の RID を束縛せずパケットごとに導出**: 再交渉で FID 表が変わっても、解除し忘れた束縛が残りません。

## 6. レビュアーが確認すべき点・リスク

- 3.3.1 の経路解放は、確定後に外れた RTX SSRC にだけ働きます。他の記述が同じ SSRC を使い続ける場合は解放しません。この「他の記述」の判定条件が十分か確認してください。
- `onTrack` の回数が変わるのは「RID 受信 + a=ssrc あり」のときだけです。非 simulcast、Chrome 形式、offer 側の送信は `receivesByRid` が偽なら従来の経路です。
- 公開 API の変更はありません（`ridRtxPairs` と `restrictions` は内部用）。`changelog.md` と docs の更新は差分にありません。この判断でよいか確認してください。
- 再交渉まわりの状態が増えています（`ridFidMediaByRtx`、`stagedRidFidTable`、スナップショット）。確定・rollback の対称性を [packages/webrtc/src/media/rtpReceiver.ts:600](review-diff:packages/webrtc/src/media/rtpReceiver.ts:600) 付近で見てください。
- RID 受信なのに RID 拡張なしで届く SSRC パケットは、SDP 由来の SSRC トラックがなくなったため、学習済みトラックだけで扱います。
- ICE の既知の失敗（`ice/failover` 2 件、`ice/nomination` 4 件）は本チケットの差分と無関係で、develop でも再現します（チケット 7 節）。

## 7. 検証結果

このドキュメント作成中に新たに実行したテストはありません。以下は、リポジトリに残る記録から確認できた内容です。

- Firefox の simulcast 単体記録 [e2e/firefox-runs/20261121T034729Z-149b8bcf6.json](review-file:e2e/firefox-runs/20261121T034729Z-149b8bcf6.json): 3 件 passed / 0 failed（`mediachannel_simulcast_rtx_answer` を含む）。
- 全スイートの記録 `20261121T032323Z-affd1237e.json`: simulcast 3 件は通過、ICE の既知失敗のみ残る。
- 最新コミット 38b856315 のテスト（firefoxSimulcastRepairedRidRoute 追加 2 件）は、この作業では再実行していません。
- `packages/webrtc` の `npm test`、`npm run type`、`npm run test:small`、Chrome の `npm run e2e` の結果は、この作業では再確認していません（最終承認時の結果に委ねます）。
