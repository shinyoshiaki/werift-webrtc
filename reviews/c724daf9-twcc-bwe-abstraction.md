---
ide:
  viewer: review-document
  version: 1
  title: "TWCC 帯域推定の抽象化（legacy / GCC）レビュー解説"
  dock: right
  baseCommit: f6fe27c57109f2744520a637fe14270722cda48a
---
# TWCC 帯域推定の抽象化（legacy / GCC）レビュー解説

## 1. 概要

送信側の帯域推定（BWE）を `BandwidthEstimator` interface の背後に分離し、既定の legacy と GCC を選べるようにしました。推定帯域が変わったときは、全実装に共通の `onAvailableBitrate`（単位 bps）で通知します。TWCC のプロトコル処理（header extension の付与、`ReceiverTWCC` の feedback 生成、RTCP ルーティング）は維持し、差し替えるのはアルゴリズム層だけです。

今回の最終承認（レビュー 4 周目、head `f6fe27c57`）では、transport 切替まわりの境界を詰めています。具体的には次の 3 点です。

- 切替時に経路依存の状態だけを捨てる。
- 長い TSN 欠落後も feedback を再開する。
- TWCC は受信元 transport にいる sender だけに配送する。

<div style="display:flex;gap:10px;align-items:stretch;font-size:13px">
  <div style="flex:1;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px"><strong>Before</strong><br>RTCRtpSender が <code>SenderBandwidthEstimator</code> を直接保持。アルゴリズムは 1 つで固定。変動通知の契約は暗黙。</div>
  <div style="flex:1;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px"><strong>After</strong><br><code>BandwidthEstimator</code> 経由。<code>"legacy"</code> / <code>"gcc"</code> / <code>false</code> / factory を <code>PeerConfig</code> で選択。<code>onAvailableBitrate</code> が唯一の必須出力。</div>
</div>

## 2. 主要変更

### 2.1 抽象化と選択 API

- interface 定義: [packages/webrtc/src/media/sender/bandwidthEstimator.ts:76](review-file:packages/webrtc/src/media/sender/bandwidthEstimator.ts:76)。必須は `onAvailableBitrate`、`rtpPacketSent`、`receiveTWCC` などです。`resetNetworkRoute` は任意です。
- 変動通知の共通ヘルパ: [packages/webrtc/src/media/sender/bandwidthEstimator.ts:341](review-file:packages/webrtc/src/media/sender/bandwidthEstimator.ts:341)。前回通知値と異なるときだけ `execute` します。
- 選択ファクトリ: [packages/webrtc/src/media/sender/createBandwidthEstimator.ts](review-file:packages/webrtc/src/media/sender/createBandwidthEstimator.ts:27)。`PeerConfig.bandwidthEstimator`（[packages/webrtc/src/api/peerConfig.ts:145](review-file:packages/webrtc/src/api/peerConfig.ts:145)、既定 `"legacy"`）から sender ごとに 1 インスタンスを作ります。
- 実行中の差し替え: [packages/webrtc/src/media/rtpSender.ts:525](review-file:packages/webrtc/src/media/rtpSender.ts:525) の `setBandwidthEstimator`。sender 側の `onAvailableBitrate` は橋渡しされ、差し替え後も購読し直す必要はありません。
- 実装: legacy は [legacyCumulativeBwe.ts:32](review-file:packages/webrtc/src/media/sender/estimators/legacyCumulativeBwe.ts:32)、GCC は [gccBwe.ts:102](review-file:packages/webrtc/src/media/sender/estimators/gcc/gccBwe.ts:102) と `estimators/gcc/` 配下（trendline、AIMD、loss-based、probe など）です。
- 両者に共通の TWCC feedback 正規化: [twccFeedbackAdapter.ts:62](review-file:packages/webrtc/src/media/sender/estimators/twccFeedbackAdapter.ts:62)。

### 2.2 今回（4 周目）の変更

<svg viewBox="0 0 640 150" width="100%" role="img" aria-label="transport 切替時の処理">
  <g fill="none" stroke="var(--review-border)"><rect x="6" y="20" width="140" height="44" rx="6"/><rect x="190" y="20" width="170" height="44" rx="6" stroke="var(--review-accent)"/><rect x="404" y="6" width="230" height="40" rx="6"/><rect x="404" y="58" width="230" height="40" rx="6"/></g>
  <g stroke="var(--review-muted)"><line x1="146" y1="42" x2="190" y2="42"/><line x1="360" y1="42" x2="404" y2="26"/><line x1="360" y1="42" x2="404" y2="78"/></g>
  <g fill="var(--review-fg)" font-size="12" text-anchor="middle"><text x="76" y="46">transport 切替</text><text x="275" y="38">resetBweForNewTransport</text><text x="275" y="54">（世代 bump + 状態初期化）</text><text x="519" y="30">resetNetworkRoute() があれば優先</text><text x="519" y="82">なければ reset()</text></g>
  <g fill="var(--review-muted)" font-size="12"><text x="6" y="125">resetNetworkRoute: 履歴・TSN 起点・推定・probe を捨て、setBitrates の min/max は保つ</text></g>
</svg>

- 経路依存の状態だけを初期化: [rtpSender.ts:569](review-diff:packages/webrtc/src/media/rtpSender.ts:569) で `resetNetworkRoute()` を優先します。GCC 側は [gccBwe.ts:943](review-diff:packages/webrtc/src/media/sender/estimators/gcc/gccBwe.ts:943) で `reset()` 後に min / max を再適用します。以前は `reset()` でアプリ指定の帯域制約まで失われていました。
- TWCC の配送先: [router.ts:510](review-diff:packages/webrtc/src/media/router.ts:510)。受信元 transport が分かるときは、その transport に今いる sender だけに配送し、SSRC fallback で別 transport の sender を選びません。TSN は transport ごとの番号空間なので、移動後に届いた旧 transport の feedback を新しい sender に渡すと誤推定になります。
- 長い欠落後の再開: [receiverTwcc.ts:108](review-diff:packages/webrtc/src/media/receiver/receiverTwcc.ts:108)。拡張 TSN で報告窓を分けます。最大長の報告後は開始番号を進めます。
- `TwccFeedbackAdapter` の時刻の取り決め（age / span を照合時に保証）は 345e235d5 で入っています。

## 3. 判断理由

- **インスタンス差し替え方式を採用**: factory / setter なら、アプリが GCC の初期値や制約を与えたインスタンスを注入できます。列挙値だけの切替は、`setBitrates` など固有設定を渡せません。`PeerConfig` には preset と factory の両方を用意しました。
- **共通契約は `onAvailableBitrate` のみ**: legacy の `onCongestion` や GCC の overuse 状態は実装固有で、共通 interface に含めると他方が嘘の値を返すことになります。固有イベントは具象インスタンスで購読します。
- **`resetNetworkRoute` を任意にした**: 既存の自作 estimator を壊さないよう、未実装なら `reset()` に fallback します。
- **GCC の完成度基準**: チケット §2.12 により「GCC として正しく機能すること」で判定し、libwebrtc との 1:1 一致は求めません。

## 4. レビュアーが確認すべき点・リスク

- 公開 API の追加: `PeerConfig.bandwidthEstimator`、`RTCRtpSender.setBandwidthEstimator`、`BandwidthEstimator.resetNetworkRoute`。生成ドキュメント（`doc/`）と `changelog.md` が揃っているか確認してください。
- 既定は legacy で、しきい値（100ms / 20 packets、`min(send, recv)`）を維持しています。既存利用者の挙動が変わらないことが前提です。
- 3 つの境界が影響範囲です。transport 切替時の状態初期化と世代 bump、TWCC の配送先、`ReceiverTWCC` の窓分割です。外部 estimator が `resetNetworkRoute` を持たない場合は、`reset()` でアプリ制約が失われます。
- factory は sender ごとに呼ばれます。同じインスタンスを複数 sender で共有できません。
- 差分が大きい（`develop` 比で 296 ファイル、うち `third_party/libwebrtc-ref` は参照用の取り込み）ので、`packages/webrtc/src/media` を中心に読むことを勧めます。
- このチケットの関連文書は次の 3 つです。
  - [reviews/c724daf9-twcc-gcc-mechanism.md](review-file:reviews/c724daf9-twcc-gcc-mechanism.md): TWCC と legacy / GCC の仕組みを、実装の呼び出し順とファイルの行で追う解説。
  - [reviews/c724daf9-gcc-vs-legacy.html](review-file:reviews/c724daf9-gcc-vs-legacy.html): 同じ TWCC から legacy と GCC が別の値を出す様子の図解。数値は [reviews/c724daf9-gcc-vs-legacy.trace.ts](review-file:reviews/c724daf9-gcc-vs-legacy.trace.ts) で現在の実装と照合できます。
  - [reviews/c724daf9-twcc-tests.md](review-file:reviews/c724daf9-twcc-tests.md): テストの層と各テストの役割。

## 5. 検証結果

- 実行した: `cd packages/webrtc && npx vitest run tests/media`（head `f6fe27c57`、作業ツリーは clean）。**12 ファイル、241 テストすべて成功**。対象は [router.test.ts](review-file:packages/webrtc/tests/media/router.test.ts)、[bandwidthEstimator.test.ts](review-file:packages/webrtc/tests/media/bandwidthEstimator.test.ts) など、この周回の変更に対応するテストです。
- この文書の作成にあたっては実行していない: `npm run type`、`npm run test:small` 全体、E2E、WPT、Chrome 相互接続シミュレーション（CI 対象外）。各コミットのメッセージ上の検証結果は、この文書では再確認していません。
