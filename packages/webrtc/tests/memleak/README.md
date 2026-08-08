# Memory Leak Tests (memleak)

werift-webrtc の主要なユースケースを時間加速で繰り返し実行し、ヒープスナップショットとメモリメトリクスからメモリリークを検出する自動試験です。

**CI 対象外**です。ローカル / 手動でのみ実行してください（`npm run ci` や GitHub Actions には含まれません）。

## 前提

- **Node.js 24 以上**（`v8.writeHeapSnapshot` / `getHeapStatistics` / `--expose-gc` を前提）
- パッケージ依存がインストール済み（リポジトリルートで `npm i`）

## 実行方法

```bash
cd packages/webrtc
npm run memleak
```

短縮スモーク（数サイクル・少量ワークロード）:

```bash
cd packages/webrtc
MEMLEAK_TARGET_HOURS=0.001 \
MEMLEAK_ITERATIONS=5 \
MEMLEAK_WARMUP=1 \
MEMLEAK_SNAPSHOT_INTERVAL=2 \
MEMLEAK_CONN_CYCLES=5 \
npm run memleak
```

合成リーク検出のみ確認したい場合も上記で `synthetic-leak` シナリオが走ります。

## シナリオ

| ID | 内容 | 1 時間相当バジェット（既定） |
| --- | --- | --- |
| `connection` | 接続確立（ICE→DTLS→SCTP）と `close()` のみ | 60 接続（1 接続/分） |
| `datachannel` | DataChannel 接続 → メッセージ送受信 → close | 360,000 メッセージ（100 msg/s） |
| `media` | ビデオ RTP を `writeRtp` で連続送信 → close | 108,000 フレーム（30fps） |
| `synthetic-leak` | 意図的に Buffer を保持して検出ロジックを検証 | n/a |

各シナリオは N サイクル繰り返し、サイクルごとに新規 `RTCPeerConnection` を作成します。

### 時間加速

実時間で 1 時間待つ代わりに、**想定レート以上の速度でパケットを送る**ことで 1 時間相当の処理量を短時間で消化します。

- メディア: 30fps ペーシングなしで `track.writeRtp()` をタイトループ
- DataChannel: RTT 待ちせず一括 `send()`（`bufferedAmount` でバックプレッシャー）
- 接続: ギャップなしで connect → close を連続実行

ICE consent / SCTP RTO / DTLS 再送など**タイマー依存の挙動は実時間のまま**です（本試験の加速対象外）。

## 環境変数

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `MEMLEAK_TARGET_HOURS` | `1` | 実時間相当の目標時間（時間）。処理量バジェットの倍率 |
| `MEMLEAK_ITERATIONS` | `50` | media / datachannel のサイクル数 |
| `MEMLEAK_CONN_CYCLES` | `60 * TARGET_HOURS` | 接続ライフサイクルのサイクル数 |
| `MEMLEAK_SNAPSHOT_INTERVAL` | `10` | 何サイクルごとにヒープスナップショットを取るか（先頭・末尾は常に取得） |
| `MEMLEAK_WARMUP` | `10` | リーク判定から除外するウォームアップサイクル数 |
| `MEMLEAK_SLOPE_THRESHOLD` | `262144` (256KiB) | heapUsed の許容傾き（bytes/cycle） |
| `MEMLEAK_MARGIN_RATIO` | `0.3` | 最終中央値がベースライン中央値を超えてよい割合 |
| `MEMLEAK_ANALYZE` | `on-fail` | `on-fail` / `always` / `never` — スナップショット比較分析の実行契機 |
| `MEMLEAK_ARTIFACTS_DIR` | `artifacts/memleak`（cwd 相対） | レポート・スナップショット出力先 |
| `MEMLEAK_MEDIA_FRAMES` | （自動） | メディア総フレーム数の明示オーバーライド |
| `MEMLEAK_DC_MESSAGES` | （自動） | DataChannel 総メッセージ数の明示オーバーライド |
| `MEMLEAK_INJECT_LEAK_BYTES` | `0` | サイクルごとに保持する合成リーク量（検証用） |
| `MEMLEAK_TEST_TIMEOUT_MS` | `1800000` | シナリオ 1 本あたりの vitest timeout |

## 出力物

実行後、`artifacts/memleak/`（または `MEMLEAK_ARTIFACTS_DIR`）に以下が生成されます。

| ファイル | 内容 |
| --- | --- |
| `report.json` | シナリオ毎の時系列メトリクス、判定、分析結果、スナップショット一覧 |
| `report.csv` | 時系列（heapUsed 等）のフラット表。プロット用 |
| `summary.md` | 人間向け要約 |
| `*.heapsnapshot` | Chrome DevTools で開けるヒープスナップショット |

`.gitignore` により `artifacts/` はコミット対象外です。

## 指標の意味

| 指標 | 意味 |
| --- | --- |
| **Wall clock** | 実際にかかった実時間 |
| **Equivalent time** | 処理量 ÷ 想定レート（例: 108,000 frames ÷ 30fps = 3600s）。「1 時間相当」の判定に使う |
| **Workload** | 送信したメッセージ数 / フレーム数 / 接続数 |
| **heapUsed slope** | ウォームアップ後の heapUsed（移動中央値）に対する線形回帰の傾き（bytes/cycle） |
| **Baseline / Final median** | ウォームアップ直後数点 / 最終数点の heapUsed 中央値 |
| **activeTimerHandles** | `process._getActiveHandles` 上の Timeout/Immediate 数（補助メトリクス） |

> Equivalent time は処理量ベースの等価目安であり、実運用トラフィックパターンと完全には一致しません。

## 判定ロジック

1. 各サイクル終了後に `global.gc()` を強制し、`process.memoryUsage()` / `v8.getHeapStatistics()` をサンプリング
2. ウォームアップ（既定 10 サイクル）を除外
3. heapUsed の移動中央値（窓 5）に線形回帰を適用（傾き + 決定係数 R²）
4. 次のいずれかで **FAIL（リーク疑い）**:
   - **傾き判定**: ウォームアップ後サンプル ≥ 8 かつ R² ≥ 0.6 かつ 傾き > `MEMLEAK_SLOPE_THRESHOLD`（既定 256KiB/cycle）
   - **マージン判定**: 最終中央値 > ベースライン中央値 × (1 + `MEMLEAK_MARGIN_RATIO`)（既定 30%）

単発の GC ゆらぎに強くするため、単一サンプルではなく複数サンプルの中央値・移動平均を使い、傾きは R² が低いノイズ系列では採用しません。閾値は誤検知を避けるため余裕を持たせています。

## 「実時間 1 時間相当」の確認手順

1. 既定のまま `npm run memleak` を実行する（`MEMLEAK_TARGET_HOURS=1`）
2. `summary.md` または `report.json` で各シナリオの **Equivalent time ≥ 3600s** を確認する
3. **Wall clock** が数分〜十数分程度（環境依存）で終わっていれば、時間加速が効いている

## リーク検出時のトリアージ

1. **summary.md** の「リーク箇所の分析」を見る  
   - `analyze.ts` が早期/後期スナップショットを比較し、クラス別ノード数の増加上位を出す  
   - 例: `RTCPeerConnection(+12)`, `Timeout(+40)` など
2. **Chrome DevTools** で該当の `.heapsnapshot` を開く  
   - Chromium → DevTools → Memory → Load  
   - 増加していたクラスの retainer（誰が参照を握っているか）を確認
3. **ソース調査**  
   - 該当クラスの `close()` / イベント購読解除 / タイマー clear 漏れを疑う  
   - 接続ライフサイクル（コントロール）だけ増えるなら下位トランスポート、media だけなら RTP 経路、などシナリオ差分で切り分ける
4. **分析の限界**  
   - ノード数比較は「毎サイクル生成・廃棄される型」のリークを捉えやすい  
   - 既存オブジェクトへの参照追加や external/arrayBuffers 領域だけ増えるケースは heapUsed トレンド側で検知する

既定では分析は **リーク判定時のみ** 実行します（5MB×2 枚のパースコストのため）。常時実行は `MEMLEAK_ANALYZE=always`。

## 既定テストスイートとの関係

- 既定の `vitest.config.mts` は `**/tests/memleak/**` を exclude する
- `npm test` / `npm run test:small` / `npm run ci` では実行されない
- 専用 config: `tests/memleak/memleak.vitest.config.mts`（`fileParallelism: false`, `retry: 0`, `--expose-gc`）

## トラブルシュート

| 症状 | 対処 |
| --- | --- |
| `global.gc is not exposed` | config の `poolOptions.forks.execArgv` を確認。フォールバック: `NODE_OPTIONS=--expose-gc npm run memleak` |
| DataChannel receive timeout | `MEMLEAK_DC_MESSAGES` を減らす、またはマシン負荷を下げる |
| ディスク不足 | スナップショット間隔を広げる（`MEMLEAK_SNAPSHOT_INTERVAL`）、または `artifacts/memleak` を削除 |
| 誤検知（フレーク） | `MEMLEAK_WARMUP` を増やす / `MEMLEAK_SLOPE_THRESHOLD` や `MEMLEAK_MARGIN_RATIO` を緩和 |
