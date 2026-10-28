# latency_budget example のクライアントを React で書き直し、プレイヤー比較型の UI にする

- 対象: `examples/mediachannel/latency_budget/` (親チケット `3d8f36db-…` で追加した "Latency budget with WebRTC + Encoded Transform")
- 種別: example のクライアント書き直し (React) + UX 刷新 + 可視化の追加。server (`server.ts`) は比較 UX に必要な分だけ拡張する
- 参照: https://moq.dev/blog/webrtc-is-still-the-problem/ 、親チケット `docs/tickets/TICKET-ticket-3d8f36db-f399-4e5b-81a7-7842c0b93dd6.md`

## 1. 目的と背景

親チケットの example は、記事の主張 (NetEQ は到着時刻で再生する、音声 NACK が無い、レイテンシ設定が transport に 1 つだけ、など) を、WebRTC + Encoded Transform + 自作 player で再現できることを示した。ただし現在のクライアントには次の問題がある。

- `index.html` + `main.ts` の素の DOM 操作で書かれている。シナリオ A〜D が縦に並び、数値入力と `<pre>` の JSON ダンプしかない。
- 何と何を比べているのかが画面から分かりにくい。比較 (NetEQ と自作 player、budget 500ms と 5000ms) がシナリオごとにばらばらで、同じ条件で並べて聴き比べられない。
- 自作 player の内部 (バッファ、欠番、NACK、回収、concealment、generation の破棄) が数値でしか見えない。オプションを有効にすると何が起きるのかが直感的に伝わらない。

本チケットでは、クライアントを React で書き直し、次の UX のアプリケーションにする。

- **メディアプレイヤーが画面の中心**。既定で 2 つのプレイヤーを横に並べる。
  - 左: **標準的な WebRTC** (Chrome 既定の受信経路 = NetEQ + `<audio>`。NACK なし、budget なし)。設定は固定。
  - 右: **カスタム**。ユーザが自由にオプションを設定し、左と比べる。
- 右端の **「+」ボタン**で、カスタムプレイヤーを右に何個でも追加できる。3 つ以上の設定を同時に比べられる。
- 各オプションを有効にすると、そのオプションがどう働いているかを**実データで動く**グラフィックスで表示する。

すべてのプレイヤーは**同じソース (同じ upstream) と同じネットワーク条件**で動く。違いはプレイヤーのオプションだけなので、記事の論点 (1, 2, 3/4, 5/10, 7, 8) を「左右の差」として見て、聴いて確認できる。

## 2. 実装すべき機能・変更内容

### 2.1 画面構成

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Header: タイトル / 記事リンク / 環境 (transformApi, Chrome version) / ? │
├──────────────────────────────────────────────────────────────────────────┤
│ Source bar: [ソース選択] [録音] [Speak] [Interrupt] [Start/Stop]       │
│             ネットワーク条件 (下りロス) / upstream (budget, ロス)       │
├──────────────────────────────────────────────────────────────────────────┤
│ ┌─ Player 1 ──────┐ ┌─ Player 2 ──────┐ ┌─ Player 3 ─────┐  ┌───┐       │
│ │ Standard WebRTC │ │ Custom          │ │ Custom (copy)  │  │ + │       │
│ │ [波形 / レベル] │ │ [波形 / レベル] │ │ ...            │  └───┘       │
│ │ 🔈 solo         │ │ 🔈 solo         │ │                │              │
│ │ 主要メトリクス  │ │ 主要メトリクス  │ │                │              │
│ │ 可視化パネル    │ │ 可視化パネル    │ │                │              │
│ │ オプション(固定)│ │ オプション      │ │       [×]      │              │
│ └─────────────────┘ └─────────────────┘ └────────────────┘              │
│                               ← 横スクロール (scroll-snap) →           │
├──────────────────────────────────────────────────────────────────────────┤
│ Footer/Drawer: 記事の主張との対応表、制約 (README の要約)              │
└──────────────────────────────────────────────────────────────────────────┘
```

- プレイヤーカードは同じ幅で横に並べる。画面幅を超えたら横スクロール (`scroll-snap`) にする。「+」カードは常に最右端に置く。
- 狭い画面 (タブレット・tailnet 越しのスマホ) では、カードを 1 枚ずつスワイプして見られる。

### 2.2 ソースとネットワーク条件 (全プレイヤー共通)

比較を公平にするため、ソースとネットワーク条件はプレイヤーごとではなく Source bar で 1 つだけ設定する。全プレイヤーに同じものをかける。

| 項目 | 選択肢 | 既存の実装との対応 |
|---|---|---|
| ソース | **Live mic** (マイク → werift → 全プレイヤーへ relay) | publisher + subscriber role (シナリオ C) |
| | **AI answer (burst)** (録音を sleep なしで送る) | tts role, `pace: "burst"` (シナリオ B) |
| | **AI answer (realtime)** (従来の sleep 20ms pacing) | tts role, `pace: "realtime"` |
| 録音 | 「Record 5s」ボタン。AI answer の再生元を作る | publisher + `record: true` (シナリオ A) |
| Interrupt | AI answer の再生中に割り込み (barge-in) | tts の `interrupt` (シナリオ D) |
| 下りロス | なし / バースト (`intervalMs`, `durationMs`) / プリセット | subscriber の `loss` → `DebugConfig.outboundBurstLoss` |
| upstream | NACK budget の表示、upstream ロス、SDP munging (audio NACK) | publisher の `loss` / `budgetMs` / `enableOpusNack` |

- AI answer の再生元が無いとき (未録音)、Speak は無効にし、先に Record するよう案内する。
- upstream の NACK budget は既存どおり「最も budget が大きい subscriber」に追従する (`updateUpstreamBudget`)。Source bar に現在値を表示する。
- upstream の結果 (シナリオ A: lost / recovered / unrecovered / accounting) は Source bar の「Upstream」詳細に出す。`accounting.status` が `unverified` のときは理由と一緒に表示し、推定値は出さない (親チケット §6)。

### 2.3 プレイヤーカード

#### 共通要素
- **メディア表示**: 出力音声の波形とレベルメーター (`AnalyserNode`)。音声だけの example なので、これを「メディアプレイヤーの画面」として大きく表示する。
  - カスタム player: `BudgetPlayer` の AudioWorkletNode の後段に `AnalyserNode` を挿す。
  - 標準 (native): 受信 track を `createMediaStreamSource` に通して `AnalyserNode` を挿す。NetEQ 出力のレベルが見える。
- **Solo / Mute**: 同時に鳴ると比較できないので、既定では 1 プレイヤーだけを鳴らす (solo)。カードをクリックすると solo が切り替わる。キーボードの `1`〜`9` でも切り替えられる。
- **状態バッジ**: connecting / buffering / playing / stalled / concealed / flushed。
- **主要メトリクス** (3〜4 個を大きく表示。詳細は折りたたみ):
  - 実効遅延 (`delayMs` / native は `jitterBufferDelayMs`)
  - 欠落 / 回収 / concealment (`missingFrames` / `recoveredFrames` / `concealedFrames`、native は `packetsLost` / `concealedSamples`)
  - 破棄 (`lateDiscardedFrames` / native は `packetsDiscarded`)
  - 再生速度 (`playbackRate`、native は `removedSamplesForAcceleration` 由来の加速量)
- **オプションパネル** (2.4)。標準プレイヤーでは読み取り専用で、「Chrome の既定値」と説明を付ける。
- 追加したプレイヤー (3 枚目以降) には削除 (×) を付ける。既定の 2 枚は削除できない。

#### 「+」ボタン
- 押すと、最後のカスタムプレイヤーの設定を複製したカードを右に追加する。同時に、プリセット選択 (2.4) を開く。
- 実行中に追加した場合は、そのプレイヤーだけ接続する。Live mic なら途中から購読し、開始位置は werift の `start` 通知に従う (`awaitStart`)。AI answer なら次の Speak から参加する。
- PeerConnection・Encoded Transform worker・`AudioDecoder` をプレイヤーごとに持つので、上限を設ける (例: 6)。上限に達したら「+」を無効にし、理由をツールチップで示す。

### 2.4 プレイヤーのオプション

| オプション | 値 | 標準 (左) | カスタム既定 | 実装 (既存) | 記事 # |
|---|---|---|---|---|---|
| 再生エンジン | `native` (NetEQ, `<audio>`) / `player` (Encoded Transform + WebCodecs + AudioWorklet) | native | player | `subscribe(..., output)` | 3, 4 |
| latency budget (`maxDelayMs`) | 0〜10000ms | — (NetEQ 任せ) | 5000 | `BudgetPlayer` + DataChannel `budget` | 1, 5, 7, 10 |
| 最小遅延 (`minDelayMs`) | 0〜1000ms | — | 100 | `BudgetPlayer.setDelay` | 7 |
| アプリ層 NACK | on / off | off | on | `nack` コールバック → DataChannel → `RTCRtpSender.retransmit({ maxAgeMs })` | 1, 2 |
| generation 判定 | CSRC / 制御通知のみ (`ignoreCsrc`) | — | CSRC | `BudgetPlayer.interrupt`, `ignoreCsrc` | 8 |

- **プリセット**: `Standard WebRTC` / `Speech-to-speech (500ms)` / `STT→LLM→TTS (5000ms)` / `Custom`。親チケットのシナリオ C の 2 系統をワンクリックで再現できるようにする。
- 再生エンジンが `native` のときは、budget・minDelay・アプリ層 NACK を無効表示にし、「NetEQ はこの設定を受け付けない (playout-delay は音声に効かない)」と説明する。この「設定できないこと」自体が記事の主張 #7 の可視化になる。
- 実行中の変更:
  - `minDelayMs` / `maxDelayMs`: 再接続せずに反映する (`setDelay` + DataChannel `budget` の再送)。
  - 再生エンジンとアプリ層 NACK: そのプレイヤーだけ再接続する。再接続中はカードに表示する。
- 各オプションの横に `?` を置き、記事のどの主張に対応するか、werift / player のどこで実現しているかを短く説明する (README の対応表と同じ内容)。

### 2.5 動的な可視化 (オプションごと)

**すべて実際に観測したデータで描画し、それらしく見せるだけのアニメーションは使わない**。データが無いとき (feature 非対応、`unverified` など) は描画せず、理由を表示する。

| # | 可視化 | 表示する条件 | 内容 | データ源 |
|---|---|---|---|---|
| V1 | **再生バッファのタイムライン** | engine=player | 横軸はメディア時間。中央に再生位置、右に未来を置き、フレームを 20ms のブロックで並べる。色: 受信済 / 欠番 (穴) / NACK 待ち / 回収済 (再送で埋まった) / concealment / 期限切れ破棄 / 再生済。`minDelay` と `maxDelay` (budget の期限) を縦線で示し、穴が期限線を越えると concealment に変わる様子が見える | worklet のバッファのスナップショット (2.6) |
| V2 | **NACK の往復** | アプリ層 NACK=on | seq の帯 (直近 N パケット)。穴を検出すると NACK を送ったマークを付け、再送が届くと回収の線を引く。budget を超えて諦めた穴は赤で表示する。送った NACK 数 / 回収 / 諦めのカウンタを付ける | `BudgetPlayer` のイベント (2.6) + server `stats` (`retransmitted`, `refused`) |
| V3 | **到着時刻とメディア時刻** | 常に | 横軸は壁時計、縦軸はメディア時間。到着 (点) と再生 (線) を描く。burst では到着が垂直に近く、player の再生線は傾き 1 を保つ。native はこの図の代わりに NetEQ の stats (jitter buffer 遅延、加速/減速サンプル、破棄数) の時系列を描く | player: frame の `receiveTime`/到着時刻と再生位置。native: `getStats()` を 250ms ごとに取得 |
| V4 | **遅延の推移** | 常に | 実効遅延の時系列。player は `minDelay`〜`maxDelay` の帯を重ね、遅延が帯の中で伸び縮みする様子を見せる (後ろへのずらし、無音区間での詰め) | `delayMs` / `jitterBufferDelayMs` |
| V5 | **generation** | AI answer ソースで interrupt したとき | V1 のブロックを generation ごとに色分けする。interrupt で旧 generation のブロックが消える (flush)。CSRC で判定したか、制御通知で判定したかを表示する | `flushedFrames`, `generation`, `oldGenerationPlayed`, スナップショットの `gen` |
| V6 | **ネットワーク** (Source bar) | 下りロス / upstream ロスがあるとき | 全プレイヤー共通のロス窓を時間軸に描く。各カードの V1/V2 の穴と時刻が対応して見える | ロス設定 + server からのロス適用通知 (2.6) |

- 描画は Canvas 2D と `requestAnimationFrame` を使う。グラフ用ライブラリは入れない (依存を増やさない。CDN にも依存しない)。
- `prefers-reduced-motion` のときは補間アニメーションを止め、フレームを間引いて更新する。タブが非表示のときは描画を止める。
- 凡例と色は全プレイヤーで共通にする。色だけに頼らず、ブロックの形 (穴は枠線のみ、concealment は斜線) でも区別できるようにする。

### 2.6 エンジン (非 React 部) の拡張

React 化は UI 層に留める。親チケットで検証済みの再生・集計ロジックは挙動を変えない。

- **`player-worklet.js`**: 可視化を購読しているときだけ、バッファのスナップショット (`{ pos, len, state, seq, gen }[]`、再生位置、遅延) を一定周期 (目安 20〜30Hz) で `port.postMessage` する。購読していないときは送らない。既存の `stats` (100ms ごと) は変えない。
- **`player.ts` (`BudgetPlayer`)**: 可視化用のイベントを購読できるようにする (例: `onEvent((e) => ...)`)。イベントは frame 到着 (seq, rtpTimestamp, 到着時刻, 再送か)、穴の検出、NACK 送信、回収、諦め、flush。リングバッファで直近分だけ保持し、メモリを増やし続けない。出力の後段に `AnalyserNode` を挿せるよう、出力ノードを公開する。
- **`main.ts` の分割**:
  - シナリオ関数 (`runA`〜`runD`、`publish`、`subscribe`、`nativeStats`、`summarize`) は React に依存しない `scenarios.ts` (仮) に移す。
  - `window.latencyBudget` と `window.__latencyBudgetResult` は**互換を保って**公開を続ける (既存 smoke test のため)。
  - 比較 UI 用のセッション管理 (ソース 1 つ + プレイヤー N 個の接続、再接続、solo) は `comparison.ts` (仮) に置く。React からは hook (`useComparison` など) 経由で使う。
- **server.ts** (比較 UX のための拡張):
  - **比較グループ**: AI answer では、全プレイヤー (tts セッション) が同じ瞬間に同じ応答を受け取る必要がある。join に `group` を持たせ、`speak` / `interrupt` をグループ内の全 tts セッションへ同時に配る。クライアントから N 個の WebSocket に順に送る方式は、開始時刻がずれるので採らない。
  - **tts 経路のロスとアプリ層 NACK**: 現状の tts role は `loss` も control DataChannel も持たない。AI answer ソースでも下りロスと NACK の差を比べられるよう、subscriber role と同じ処理を tts にも通す (`outboundBurstLoss`、DataChannel `budget` / `nack`、`retransmit({ maxAgeMs })`、送信履歴サイズ)。重複させず、subscriber の control channel 処理を関数に切り出して共用する。
  - **ロス適用の通知 (V6)**: debug ロスで落とした seq・時刻 (またはロス窓) を、対応するセッションに `stats` で通知する。可視化は推定ではなく、この通知で描く。
- プレイヤー 1 つにつき PC・WebSocket を 1 つ持つ (既存の `connect` をそのまま使う)。`AudioContext` は 1 つを共有する (既存の `audioContext()`)。

### 2.7 デザイン

- ダークテーマを基調にし、CSS 変数でトークン化する (色、余白、角丸、影、フォントサイズ)。ライトテーマは `prefers-color-scheme` で切り替える。
- スタイルは example 内の CSS ファイル (例: `app.css`) に置く。CSS フレームワークや外部フォント (CDN) は使わない。smoke test は CDN に依存できない (`examples/AGENTS.md`)。
- 標準プレイヤーは落ち着いた色、カスタムプレイヤーはアクセント色で区別する。カード上部に「Standard WebRTC (Chrome default)」「Custom #n」のラベルを付ける。
- 最初に Chrome の autoplay 制限で `AudioContext` を開始する必要がある。初回は中央に大きな「Start」ボタンを出し、押すと開始する (ユーザ操作)。
- マイクを使うので、ヘッドホン推奨の注意を最初に一度表示する (AEC の制約、親チケット §2.1)。
- アクセシビリティ: すべての入力に `<label>`、ボタンに `aria-label`、solo 状態を `aria-pressed` で示す。キーボードだけで操作できるようにする。

### 2.8 smoke test / README / catalog

- `examples/e2e/tests/mediachannel/latency_budget.test.ts` の既存のシナリオ A〜D の Assert は、`window.latencyBudget` 経由でそのまま通ること。
- 比較 UI の smoke を追加する (同ファイル、または `latency_budget_ui.test.ts`)。
  - Arrange: 既存の `withExample` と `examples/e2e/tests/helpers/latencyBudget.ts` に UI 用 helper を足す (`clickStart`, `addPlayer` など)。
  - Act / Assert (日本語コメント):
    - 既定でプレイヤーが 2 枚 (Standard と Custom) あり、Standard のオプションは編集できない。
    - 「+」で 3 枚目が追加され、Custom の設定が複製される。× で削除できる。
    - 下りロスをかけて AI answer (burst) を Speak すると、Standard は native stats (`packetsDiscarded > 0`)、Custom は `playedFrames` が増え `playbackRate ≈ 1`、budget 5000 で NACK on のカードは `recoveredFrames > 0`。
    - Live mic で budget 500 / 5000 の 2 カードを並べると、5000 側の `recoveredFrames` が多く、遅延も大きい。
    - 可視化が実データで更新されている。canvas に `data-frames-drawn` などのカウンタを持たせ、増えることを確認する。ピクセル比較はしない。
  - 比較 UI の結果は `window.__latencyBudgetResult.players` (プレイヤー ID ごとのオプションと stats) にも公開し、DOM の文字列ではなくこちらを Assert する。
- `examples/AGENTS.md` の catalog 表と `examples/e2e/tests/helpers/catalog.ts` を同時に更新する。HTML のパスは `index.html` のままで、Check 列の説明を変える。
- `README.md` (example):
  - 画面の説明 (スクリーンショットは任意)、操作手順 (Start → Record → Speak / Live mic → カード追加 → 比較) を書く。
  - 各オプションと可視化の対応、記事の主張との対応表を、新しい UI の言葉で書き直す。
  - Run 手順に、React を解決するための `npm i --prefix examples` を足す。
  - 「Still browser limits」「What the custom player takes over from NetEQ」は残す。

## 3. 技術調査の結果 (要約)

### 3.1 現状の構成 (`examples/mediachannel/latency_budget/`)

| ファイル | 役割 | 本チケットでの扱い |
|---|---|---|
| `index.html` | シナリオ A〜D の入力欄と `<pre>` | `<div id="root">` + `main.tsx` に置き換える |
| `main.ts` (~560 行) | シナリオ関数、DOM 操作、`window.latencyBudget` | シナリオ関数を `scenarios.ts` に移し、DOM 操作を捨てる |
| `player.ts` / `player-worklet.js` | 自作 player (`BudgetPlayer`)。worklet は 100ms ごとに `stats` を post | スナップショットとイベント購読を追加する。挙動は変えない |
| `signaling.ts` | `connect`、`enableOpusNack`、`tapReceiver`、`gateSender`、`transformApi` | そのまま使う |
| `encodedFrames.ts` / `transform-worker.ts` / `sendGate.ts` | Encoded Transform (受信 tap、送信ゲート) | そのまま使う |
| `sendRange.ts` / `liveEdge.ts` / `unwrap.ts` / `decodeOrder.ts` / `subscriptionStart.ts` / `webmFrames.ts` | server と player の検証済みロジック。e2e の unit test (`examples/e2e/tests/mediachannel/*.test.ts`) から import される | **移動しない** (import パスを壊さない) |
| `server.ts` | role `publisher` / `subscriber` / `tts`。tts は socket ごとに独立して `speak` し、`loss` と control DataChannel を持たない | 比較グループ、tts のロスと NACK、ロス通知を追加する |
| `vite.config.mts` | 手動起動用 (HTTPS, 0.0.0.0, `/signaling` proxy) | React 用の JSX 設定を追加する (3.2) |

### 3.2 React / Vite まわり

- `examples/package.json` に `react` / `react-dom` 19 と型があり、追加の依存は要らない。既存の React 例 (`mediachannel/codec/main.tsx`、`save_to_disk/dtx/main.tsx`、`save_to_disk/encodedTransform/main.tsx`) は `import React` + `createRoot` の形で書かれている。
- smoke test の Vite (`examples/e2e/tests/helpers/serveClient.ts` の `startViteServer`) は `configFile: false` で `@vitejs/plugin-react` を使い、`127.0.0.1` の HTTP で配信する。そのため smoke では `vite.config.mts` は読まれず、signaling は `ws://localhost:8888` に直接つながる (`signaling.ts`)。
- 手動起動 (`cd examples/e2e && npx vite ../mediachannel/latency_budget`) では `vite.config.mts` が使われる。`@vitejs/plugin-react` は `examples/e2e/node_modules` にしか無く、config の位置からは解決できない。
  - **推奨**: 既存の React 例と同じく `import React` (classic runtime、ルート `tsconfig.json` の `"jsx": "react"`) で書く。plugin なしでも両方の起動方法で動く。automatic runtime を使う場合は `vite.config.mts` に JSX の runtime 設定を入れ、両方の起動方法で確認する。
  - `react` は `examples/node_modules` から解決されるので、手動起動には `npm i --prefix examples` が必要 (README に書く)。
- worker (`transform-worker.ts`) と AudioWorklet (`player-worklet.js`) の読み込み方 (`new URL(..., import.meta.url)`) は、React 化しても変えない。

### 3.3 比較 UI を成り立たせるための前提

- **同時性**: AI answer の比較は、全プレイヤーが同じ瞬間にバーストを受け取らないと V3 の比較が崩れる。server 側でグループに一斉送信する (2.6)。
- **公平性**: 下りロスは subscriber ごとに `DebugConfig.outboundBurstLoss` を設定する。ロス窓の位相はセッション開始時刻に依存するので、グループの開始時刻を基準にそろえる。そろえられない場合は、ずれていることを V6 に表示する。
- **upstream の共有**: Live mic では publisher は 1 つで、全プレイヤーが同じ upstream の relay を受ける。upstream NACK budget は最大の subscriber budget に追従する (既存)。プレイヤーを追加・削除したら、この値が変わることを Source bar に表示する。
- **native の可視化**: NetEQ の内部は見えない。`getStats()` の `inbound-rtp` (`jitterBufferDelay` / `jitterBufferEmittedCount`、`concealedSamples`、`removedSamplesForAcceleration`、`insertedSamplesForDeceleration`、`packetsDiscarded`、`nackCount`) の時系列だけで描く。player と同じ図に見せかけない。
- **リソース**: 1 プレイヤー = PC 1 本 + WebSocket 1 本 + transform worker + `AudioDecoder`。`AudioContext` は共有する。上限 6 枚程度なら問題ない見込み。上限値はエージェントが自マシンの Chromium で上限枚数を同時再生したときの CPU 使用率と worklet の underrun (`stalledMs`) を測って決め、測定値を README に残す。実機での体感確認はユーザが行う (5.2)。

## 4. 制約・注意点

- **検証済みロジックを壊さない**: 親チケット §6 (送信側の事実との照合、`unverified` 表示、16bit 折り返し、開始通知、`late` の計上) で直した player / server のロジックは、React 化で書き換えない。UI は stats とイベントを表示するだけにする。
- **可視化は実データだけで描く**: 推定や演出用のアニメーションで「動いているように見せる」ことはしない。観測できない値は表示しないか、`unverified` / `unsupported` と理由を表示する。
- **ブラウザの限界を隠さない**: Standard (native) を不当に悪く見せる演出はしない。native に設定できない項目は「設定できない」と明示する (記事 #7)。README の「Still browser limits」を維持する。
- `examples/AGENTS.md`:
  - catalog (`catalog.ts` と AGENTS.md の表) を同時に更新する。
  - smoke は catalog の Node `.ts` と Vite root を起動する。`/e2e` 側でデモを再実装しない。
  - CDN に依存しない。werift polyfill を Chromium に注入しない。
- テストは Arrange / Act / Assert で書き、Act / Assert に日本語コメントを付ける。共有 Arrange は `examples/e2e/tests/helpers/latencyBudget.ts` に置く。
- 既存の smoke test (`window.latencyBudget.runA`〜`runD`) の互換を保つ。API 名や戻り値を変える場合は、テストと README を同時に直す。
- `server.ts` の変更は example 内に留める。`packages/webrtc` の公開 API を変える必要が出たら、親チケット同様 `changelog.md`・生成ドキュメント (`npm run doc`)・既定値の互換を守る (現時点では不要の見込み)。
- 別マシン (tailnet) から開く構成 (`vite.config.mts` の HTTPS、`/signaling` proxy、ICE 環境変数) を維持する。React 化後も HTTPS 経由で動くことを、エージェントは 5.1 の非 loopback 確認で、ユーザは 5.2 の別マシン確認で確かめる。
- autoplay 制限: `AudioContext` の開始とマイク取得はユーザ操作の中で行う。smoke では `window.latencyBudget.audioContext()` を使う既存の方法に合わせる。
- パフォーマンス: 可視化のスナップショットは購読中だけ送る。描画は `requestAnimationFrame` で行い、React の state を毎フレーム更新しない (canvas を ref で直接描く)。イベント履歴はリングバッファで上限を持つ。
- `npm run format` (biome) を通す。

## 5. 完了条件

### 確認の分担 (着手前に確定)

実装エージェントは、別マシンの実機ブラウザを操作できず、音声を聴くこともできない。そこで確認を次のように分ける。

- **エージェント**: 5.1 をすべて満たした時点で実装完了として報告する。人の目と耳が要る確認は、自動の Assert と、自マシンの Chromium で撮ったスクリーンショットに置き換える。
- **ユーザ**: エージェントの報告後に、5.2 の受け入れ確認を行う。問題があれば同じチケットで修正を依頼する。
- エージェントは 5.2 を実施したと書かない。報告には「5.2 はユーザ確認待ち」と明記し、確認手順のチェックリスト (5.2 をそのまま) を付ける。5.2 が未実施であることは、エージェントの完了を妨げない。
  - 親チケット §6.6 の「未確認・制約を残さない」の例外にあたる。理由は観測手段が無いこと (別マシンの実機が無い、音声出力を聴けない) であり、報告にこの理由を書く。
- 5.1 で自動化できる確認を 5.2 に回さない。5.2 に残すのは、聴感、実機の別マシン経由の通信、目視でのデザイン評価だけにする。

| 確認項目 | エージェント (5.1) | ユーザ (5.2) |
|---|---|---|
| tailnet 上の別マシンから HTTPS で動くか | 自マシンの非 loopback アドレス (tailnet IP、無ければ LAN IP) で `vite.config.mts` の HTTPS サーバを開き、headless Chromium から全ソースを 1 回ずつ実行する。secure context、`wss://<host>/signaling` の proxy、非 loopback の ICE を確認する | 別マシンの Chrome で開き、全ソースを実行する |
| solo 切り替えで聴き比べられるか | solo のプレイヤーだけ出力が鳴っていることを Assert する。solo の `AnalyserNode` の RMS > 0 で、他のプレイヤーは出力 gain = 0 / `muted` | 実際に聴いて、差 (NetEQ の早送り・欠落、budget による回収) が分かる |
| V1 / V3 / V5 が見えるか | 可視化の入力データを Assert し (2.8)、各状態のスクリーンショットを撮る | スクリーンショットではなく実画面で動きを見て、意図が伝わるか評価する |
| デザイン | スクリーンショット (既定 2 枚、+ で 3 枚、狭い幅) を撮って報告に添付する | 見た目を評価する |
| Chrome のバージョン | 検証に使った Playwright Chromium のバージョンを README に記録する | 確認した Chrome のバージョンと OS をエージェントに伝える (エージェントが README に追記する) か、自分で追記する |

### 5.1 エージェントの完了条件

- [ ] `examples/mediachannel/latency_budget/` のクライアントが React (`main.tsx` + コンポーネント) で書き直され、`index.html` は root 要素だけになっている。
- [ ] 既定で 2 枚のプレイヤー (左: Standard WebRTC = native NetEQ、設定固定。右: Custom) が並ぶ。「+」でカスタムプレイヤーを右に追加でき、追加分は × で削除できる。上限に達したら「+」が無効になる。
- [ ] ソース (Live mic / AI answer burst / AI answer realtime)、録音、Speak、Interrupt、ネットワーク条件が Source bar にあり、全プレイヤーに同じ条件でかかる。AI answer は server のグループ一斉送信で同時に始まる。
- [ ] Custom プレイヤーで、再生エンジン・`minDelayMs`・`maxDelayMs`・アプリ層 NACK・generation 判定・プリセットを設定できる。budget と minDelay は再接続なしで反映される。native を選ぶと、効かない項目が理由付きで無効になる。
- [ ] 可視化 V1〜V6 が、該当オプションの有効時に実データで動く。次を smoke test で Assert する (可視化に渡したデータと描画カウンタを確認し、ピクセル比較はしない)。
  - burst ソースで、Standard は native stats の破棄・加速が増え、Custom は `playbackRate` ≈ 1 (V3)。
  - 下りロス下で、NACK on の Custom は回収済みブロックが現れ、budget 500 では期限を越えた穴が concealment になる (V1, V2)。
  - Interrupt の後、スナップショットに旧 generation のブロックが残らない (V5)。
- [ ] 上の 3 状態 (V3 の burst、V1/V2 のロス下、V5 の Interrupt 直後) と、デザイン確認用 (既定 2 枚、+ で 3 枚、幅 390px 程度の狭い画面) のスクリーンショットを、自マシンの Chromium で撮って報告に添付している。撮影は使い捨てのスクリプトで行い、画像はコミットしない (README に載せる場合を除く)。
- [ ] solo の切り替えで、solo のプレイヤーだけが鳴っている (`AnalyserNode` の RMS > 0、他は gain 0 / muted) ことを smoke test で Assert している。各カードの波形・レベルメーターが描画カウンタで更新されている。
- [ ] 非 loopback の HTTPS 確認: `vite.config.mts` で起動した HTTPS サーバに、自マシンの非 loopback アドレスから headless Chromium (自己署名証明書は `ignoreHTTPSErrors`) で接続し、全ソースを 1 回ずつ実行して音声が届いている。実行したコマンドと結果を報告に書く。smoke test (catalog) には入れない。
- [ ] 上限枚数を同時再生したときの CPU 使用率と `stalledMs` を自マシンで測り、上限値の根拠として README に残している。
- [ ] 既存の smoke test (シナリオ A〜D) が通る。比較 UI の smoke test (2.8) を追加し、`window.__latencyBudgetResult.players` を Assert している。
- [ ] `examples/AGENTS.md` の catalog 表、`catalog.ts`、example の `README.md` を更新している。README には操作手順、オプション・可視化と記事の主張の対応、Run 手順の `npm i --prefix examples` を書く。検証に使った Chromium のバージョンも記録する。
- [ ] 検証コマンドが通る。
  - `cd examples/e2e && npm run type && npm run ci:silent` (または `npm run examples:e2e`)
  - TSX の型確認: `npm run type` は workspace の `type` script だけを実行し、`examples` (script なし) は見ない。ルート `tsconfig.json` (`include` に `examples` があり `"jsx": "react"`) で `npx tsc --noEmit -p tsconfig.json` を実行し、本 example のファイルにエラーが無いことを確認する。
  - `npm run format`
  - `packages/*` を変更した場合のみ: 該当パッケージのテストと `npm run test:small`
- [ ] 完了報告に「5.2 はユーザ確認待ち」と、5.2 のチェックリストを載せている。

### 5.2 ユーザの受け入れ確認 (エージェントの報告後)

- [ ] tailnet 上の別マシンの Chrome から HTTPS (`tailscale cert` の証明書、または自己署名) で開き、Live mic / AI answer burst / AI answer realtime を実行できる。
- [ ] solo を切り替えて聴き比べ、Standard と Custom の差 (burst で NetEQ が早送り・欠落する、budget の大きい Custom が回収する) が耳で分かる。
- [ ] V1 / V3 / V5 の動きを実画面で見て、オプションの働きが伝わる。
- [ ] デザインと、狭い画面 (タブレット・スマホ) での操作感に問題が無い。
- [ ] 確認した Chrome のバージョンと OS を README に記録する (エージェントに伝えて追記させてもよい)。
