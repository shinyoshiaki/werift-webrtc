# examples のうち werift+ブラウザ完結ものと ffmpeg/gstreamer 使用ものを vitest + playwright で自動テストする

ルート `examples/` のデモを、実際の Node サーバ実装とブラウザ HTML を起動したまま vitest + Playwright で煙試験する仕組みを入れる。外部サービスや認証が要るものは対象外。ルート `e2e/` のプロトコル再実装スイートとは別系統にする。

## 1. タスクの目的と背景

werift の公開デモは `examples/` にあり、典型形は **Node 側 `tsx` で WebSocket シグナリング + `RTCPeerConnection`、ブラウザ側 HTML が `ws://localhost:8888` に接続** する。親チケット（polyfill）により、Node 側メディア供給は `installPolyfill` + `createRtpRtcpRegister` / `createMp4WebmRegister` へ移行済みのものが増えている。一方でこれらのデモ自体を自動実行する経路は無い。

既存のブラウザ試験は別目的で既にある。

| 場所 | 役割 | デモファイルを起動するか |
| --- | --- | --- |
| ルート `e2e/` | protoo シグナリングと独自 handler による **プロトコル** 相互接続（`@vitest/browser` + Playwright） | しない。`examples/` を再実装している |
| `examples/turn-loopback/chrome-e2e` | TURN/TLS デモ専用。vitest から `playwright` の `chromium.launch` で SPA を操作 | そのパッケージだけ |
| `packages/ice-server/chrome-e2e` | ICE/TURN パッケージ単体の Chrome 相互接続 | しない |
| `integration/werift-mediasoup-interop` の `test:browser` | mediasoup Router 上の polyfill client ↔ Chromium | しない |

ギャップは、**リポジトリの `examples/*.ts` + `*.html` が今も手元で動くか** を CI が知らないこと。HTML は CDN 上の React 16 / Babel 5 に依存し、ポートはほぼ `8888` 固定、プロセスは終了せず、ffmpeg/gst を spawn したまま残る。手動確認では回帰（polyfill 移行、シグネチャ破壊、codec 設定）を拾えない。

目的は次のデモだけを自動試験すること。

1. **werift（Node）とブラウザで完結するもの** — 追加のクラウド、API キー、外部シグナリング、外部 TURN が不要。
2. **ffmpeg / GStreamer を使うもの** — ソースが `gst-launch-1.0` または `ffmpeg` で、対向はブラウザまたは werift レコーダ。

Heroku、Ring、Google Nest、空の TURN 資格情報、手動 SDP 貼り付け、Node 同士のみのベンチマーク等は **試験しない**。`packages/*/examples` も本チケットの対象外（ルート `examples/` に限る）。

親チケットとの関係: Node 側 `getUserMedia` は polyfill 経路が正規。本チケットは polyfill 本体を実装しない。ブラウザへ polyfill を注入しない（親チケット 6.4 と同じ。Chromium のネイティブ `RTCPeerConnection` と fake media を使う）。

## 2. 実装すべき具体的な機能や変更内容

### 2.1 新しいハーネスの置き場所

`examples/e2e/` に ** vitest 3.0.5 + playwright 1.55.1** の Node 側ハーネスを新設する。`@vitest/browser` は使わない。既存 HTML を page として開く必要があるため、`examples/turn-loopback/chrome-e2e` と同じ **Node vitest が `chromium.launch` する** 形にする。

推奨構成:

```
examples/e2e/
  package.json
  vitest.config.mts
  playwright.config.ts          # Chromium launch / fake media args
  ensure-browser.js             # e2e/ および turn-loopback と同型
  tsconfig.json
  tests/
    helpers/                    # Arrange ユーティリティをここに集約（1 ディレクトリ）
      catalog.ts                # 対象 / 非対象の明示リスト
      spawnExample.ts           # tsx で example を spawn、ログ待ち、停止
      serveClient.ts            # 静的 HTML または Vite でクライアント配信
      openPage.ts               # Playwright context（fake media, insecure localhost）
      waitPeer.ts               # ICE / DataChannel / inbound RTP 待ち
      cleanup.ts                # gst / ffmpeg / ws サーバ / browser context
    datachannel/*.test.ts
    mediachannel/*.test.ts
    ice/*.test.ts
    save_to_disk/*.test.ts
    ffmpeg-gstreamer/*.test.ts
```

`examples/package.json` はワークスペース対象外（root `workspaces` は `examples/*`）。ハーネスは `examples/e2e` を独立 package にし、ルートから `cd examples/e2e && npm i && npm run ci:silent` で起動する。`examples/turn-loopback` の既存 chrome-e2e は移さない。

ルート `package.json` にスクリプトを追加する。

| スクリプト | 内容 |
| --- | --- |
| `examples:e2e` | `cd examples/e2e && npm i && npm run ci:silent` |
| `examples:e2e:install` | Playwright Chromium の ensure |

`test:small` には入れない（Chromium / gst / ffmpeg が要る）。GitHub Actions `.github/workflows/nodejs.yml` の既存 `build` job に、gstreamer に加えて **`ffmpeg` パッケージ** を apt し、`npm run examples:e2e` を実行する。`test:small` や WPT とは独立したステップでよい。ルート `npm run e2e`（プロトコルスイート）には混ぜない。

`AGENTS.md`（ルート）の Commands / Validation に `examples:e2e` を追記する。`examples/` に短い `AGENTS.md` を新設し、対象カタログと検証コマンドを書く。

### 2.2 1 ケースの実行モデル

各テストは次の順。Arrange は `tests/helpers` に寄せ、Act / Assert に日本語コメントを付ける（ルート AGENTS.md の試験規約）。

1. **Arrange**: 空き確認のうえ、カタログ記載の Node エントリを `tsx` で spawn する。標準出力に既存の `start` ログ（または WebSocket の listen）が出るまで待つ。続けてクライアントを HTTP で配信する（`file://` は WebSocket / getUserMedia が壊れるので使わない）。
2. **Act**: Playwright Chromium で HTML を開き、デモが自動で行うシグナリング・接続・メディア取得を待つ。ボタン操作が必要な画面だけ `data-testid` 相当の操作を足す（既存 turn-loopback 以外の Babel HTML はマウント直後に接続するものが多い）。
3. **Assert**: 種別ごとの必須検証（2.5）。
4. **Cleanup**: `finally` で page/context、Node 子プロセス、そのプロセスが生やした `gst-launch-1.0` / `ffmpeg` を止める。未処理 rejection とポート占有を残さない。ルート `e2e/server/gstreamer.ts` の stop（SIGINT → SIGTERM → SIGKILL）を参考にする。

制約:

- `fileParallelism: false`。大半がポート `8888` / `8878` 固定のため並列禁止。
- `testTimeout` は 60s 以上（turn-loopback chrome-e2e に合わせる）。
- retry は 1 回まで（既存 e2e / turn-loopback と同じ）。失敗を隠す多段 retry はしない。
- Chromium のみ。Firefox、Native Windows、実カメラ/マイクは対象外。
- launch args はルート `e2e/vitest.config.mts` に合わせる: `--use-fake-ui-for-media-stream`、`--use-fake-device-for-media-stream`、`--ignore-certificate-errors`、`--allow-insecure-localhost`。コンテナで Chromium が sandbox 拒否したらそのときだけ `--no-sandbox`（親チケット 6.2: 不要なら足さない）。
- ブラウザへ `installPolyfill` しない。
- STUN `stun.l.google.com` を HTML が書いていても、loopback host candidate で接続できるなら外部 STUN 成功を必須にしない。

### 2.3 クライアントの配信方法

HTML は二系統ある。

**A. Babel インライン HTML**（`datachannel/answer.html` 等）  
React 16 / ReactDOM / babel-core 5 / regenerator を unpkg / cdnjs / jsdelivr から読む。CI の CDN 依存を避けるため、ハーネスが当該 URL を **route してローカル vendor に差し替える**（または静的サーバが同じパスで配る）。デモ HTML 自体の script URL 書き換えは必須にしない。

**B. Vite 風 `index.html` + `main.tsx`**（`mediachannel/codec`、`save_to_disk/dtx`、`encodedTransform`、`mediachannel/red/record`、`red/adaptive`、`dash/client`）  
これらのディレクトリに package.json は無い。ハーネスの Arrange で **Vite dev server を一時起動** し、そのルートを example ディレクトリにする。追加の製品依存ではなく、リポジトリ内の Vite（`examples/turn-loopback` が使用）をハーネス devDependency にする。

WebSocket 先は HTML に `ws://localhost:8888` とハードコードされている。テストは example の listen ポートと一致させる。ポートを変えるために全 HTML を書き換えるのは本チケットの範囲外。必要ならハーネスが HTML をメモリ上で `localhost:<catalog.port>` に置換して配信してよい。

### 2.4 対象カタログ（試験する）と除外（試験しない）

カタログは `examples/e2e/tests/helpers/catalog.ts` にコードとして持ち、README / `examples/AGENTS.md` と一致させる。

#### 試験する: werift + ブラウザ（追加クラウドなし）

ペアは「Node エントリ → ブラウザ HTML」。同一 HTML を複数サーバが共有してよい。

| Node | ブラウザ | 検証の核 |
| --- | --- | --- |
| `datachannel/offer.ts` | `datachannel/answer.html` | DataChannel ping/pong |
| `datachannel/answer.ts` | `datachannel/offer.html` | 同上（役割逆） |
| `datachannel/string.ts` | `datachannel/string.html` | 文字列 DC |
| `close/dc/closed.ts` | `close/dc/closed.html` | DC close 後の状態 |
| `close/dc/closing.ts` | `close/dc/closing.html` | closing |
| `close/pc/closed.ts` | `close/pc/closed.html` | PC close |
| `close/pc/closing.ts` | `close/pc/closing.html` | PC closing |
| `certificate/offer.ts` | `certificate/answer.html` | 固定証明書で接続 + 映像 |
| `ice/restart/offer.ts` | `ice/restart/answer.html` | ICE restart 後も接続 |
| `ice/trickle/offer.ts` | `ice/trickle/answer.html` | trickle + 映像 |
| `ice/trickle/dc.ts` | `ice/trickle/dc.html` | trickle + DC |
| `mediachannel/sendrecv/offer.ts` | `sendrecv/answer.html` | 双方向 AV |
| `mediachannel/sendrecv/answer.ts` | `sendrecv/offer.html` | 役割逆 |
| `mediachannel/sendrecv/multi_offer.ts` | `multi_answer.html` | 複数トラック |
| `mediachannel/recvonly/offer.ts` | `recvonly/answer.html` | ブラウザ→werift 片方向。UDP 転送先 4002 は assert しなくてよい（受信 RTP があれば可） |
| `mediachannel/recvonly/multi_offer.ts` | `multi_answer.html` | 複数 |
| `mediachannel/recvonly/dump.ts` | `recvonly/answer.html` | キーフレーム受信で process.exit する。ハーネスは exit 0 を成功とみなす |
| `mediachannel/rtp_forward/offer.ts` | `rtp_forward/answer.html` | 受信 RTP（転送先 1234 の gst は必須にしない） |
| `mediachannel/pubsub/offer.ts` | `pubsub/answer.html` | publish / subscribe |
| `mediachannel/sdp/offer.ts` | `sdp/answer.html` | SDP 経路 |
| `mediachannel/sdp/offer_offer.ts` | `answer_answer.html` | offer/offer |
| `mediachannel/rtx/offer.ts` | `rtx/answer.html` | RTX |
| `mediachannel/rtx/simulcast_offer.ts` | `simulcast_offer.html` 側の対向 | simulcast+RTX の片側 |
| `mediachannel/simulcast/offer.ts` | `simulcast/answer.html` | rid 受信 |
| 他 `simulcast/{answer,select,multiple,abr,twcc,multiple_answer}.ts` と対応 HTML | 同ディレクトリ | 代表 2〜3 本を必須、残りは同一ヘルパで追加 |
| `mediachannel/twcc/offer.ts` | `twcc/answer.html` | TWCC sendrecv |
| `mediachannel/twcc/multitrack.ts` | `multitrack.html` | 複数 |
| `mediachannel/red/sendrecv.ts` | `red/sendrecv.html` | RED（ブラウザ同士ではなく werift 対向） |
| `mediachannel/red/recv.ts` | `red/recv.html` | 受信 |
| `mediachannel/codec/{vp8,vp9,h264,av1}.ts` | Vite で `codec/index.html` | コーデックごと。AV1 は Chrome 側未対応なら skip してよい |
| `save_to_disk/{vp8,vp9,h264,opus,av1x,pipeline}.ts` | `save_to_disk/answer.html` | ブラウザ canvas 映像を録画。出力ファイルが 0 バイトでないこと。終了後に一時ファイル削除 |
| `save_to_disk/mp4/{h264,opus,av}.ts` | 同上（ポート 8878） | MP4 出力 |
| `save_to_disk/dtx/server.ts` | Vite `dtx/index.html` | DTX |
| `save_to_disk/encodedTransform/server.ts` | Vite `encodedTransform/index.html` | encoded transform |
| `interop/server.ts` | `interop/index.html` | 同一プロセス内 HTTP `/offer`。外部 pion は使わない |

`examples/turn-loopback` は **既存 `npm run chrome-e2e` のまま**。本ハーネスに複製しない。カタログには「既存経路でカバー」と書く。

#### 試験する: ffmpeg / GStreamer

| Node | 対向 | 外部バイナリ |
| --- | --- | --- |
| `mediachannel/sendonly/offer.ts` | `sendonly/answer.html` | `gst-launch-1.0` videotestsrc VP8 → polyfill RTP register |
| `mediachannel/sendonly/ffmpeg.ts` | `sendonly/answer.html` | `ffmpeg` lavfi testsrc libvpx RTP |
| `mediachannel/red/send.ts` | `red/send.html` | gst opus → RED |
| `mediachannel/red/record/gst.ts` | Vite `record/index.html` | gst |
| `save_to_disk/gstreamer.ts` | `answer.html` | gst で mux |
| `save_to_disk/gst/recoder.ts` | `gst/index.html` | gst |
| `save_to_disk/packetloss/gst.ts` | `packetloss/index.html` | gst |
| `save_to_disk/rtp.ts` | ブラウザなし（gst audiotestsrc → 録画） | gst。polyfill 移行後の API で動くこと。まだ `Navigator.getUdpMedia` なら **先に polyfill 経路へ直してから** 試験する（親 2.7 / 2.10） |
| `interop/client.ts` + `interop/server.ts` | Node 同士 + gst | 外部 URL ではなくローカル `server.ts` を Arrange で立てる |

`mediachannel/sendonly/multi_offer.ts` はポート 5000/5001 の RTP を待つが自分では gst を生やさない。試験するなら Arrange で videotestsrc を 2 本 spawn する。ソースを足さないまま skip しない（「ffmpeg/gstreamer を使うもの」に含める）。

`mediachannel/sendonly/av.ts` は `createMp4WebmRegister({ path: "~/Downloads/test.webm" })` で個人パス固定。CI では動かない。**環境変数（例 `WERIFT_EXAMPLE_MEDIA_PATH`）でパスを上書きする 1 行変更を example に入れ**、リポジトリ内フィクスチャ（`packages/webrtc/tests/data/nonstandard/userMedia-e2e` の webm/mp4、無ければハーネスが短い生成ファイルを置く）を渡して試験する。上書きを入れない場合はカタログで skip 理由を明記する。

#### 試験しない（その他依存・非対象）

| パス | 理由 |
| --- | --- |
| `datachannel/heroku-*`、`ice/trickle/heroku-*`、`mediachannel/sendrecv/heroku-*` | 外部 Heroku socket.io |
| `datachannel/manual.ts` + `manual.html` | 手動 SDP |
| `datachannel/local.ts` | ブラウザなし（werift 同士） |
| `benchmark/` | ベンチマーク。ブラウザなし |
| `getStats/demo.ts` | Node 同士の API デモ |
| `google-nest/` | googleapis + `credential.env` |
| `ring/` | `ring-client-api` |
| `ice/turn/trickle_offer.ts` | TURN URL/資格情報が空。外部 TURN 必須 |
| `dash/` | ローカル完結に見えるが DASH 再生クライアントと別 HTTP が必要。初回対象から外し、必要なら後続チケット |
| `playground/` | 実験用 |
| `save_to_disk/dump.ts` | ローカル RTP dump 再生。ブラウザも gst もなし |
| `save_to_disk/encrypt/` | EME |
| `save_to_disk/react-client/` | 追加フロント構成 |
| `packages/*/examples` | 本チケット範囲外 |
| `examples/turn-loopback` | 既存 chrome-e2e |

公開 STUN だけを書いているデモは「その他依存」にしない（loopback で足りるため）。

### 2.5 必須 Assert（種別）

親チケット 6.1 と同じ方針: 映像の画質評価や `HTMLVideoElement.play()` 完了だけに頼らない。werift が出す VP8 を Chrome がデコードできない場合がある。

| 種別 | 必須 |
| --- | --- |
| DataChannel | `readyState === "open"` のあと、ping/pong 相当のメッセージが少なくとも 1 往復。HTML の log 配列、または `page.evaluate` で `rtc` 上の channel |
| メディア（ブラウザが受信） | `RTCPeerConnection` が `connected`、かつ受信 inbound RTP（`getStats` の `packetsReceived > 0`、または seq/ts 変化）。canvas スナップショット変化（`e2e/tests/fixture.ts` の `waitVideoPlay`）は **追加の弱い確認** にして必須にしない |
| メディア（werift が受信 / 録画） | サーバログまたは出力ファイル。`MediaRecorder` 系は非空ファイル + プロセスが例外終了していないこと |
| ffmpeg/gst 送信 | 子プロセスが即 exit していないこと + 対向の inbound RTP |
| close/closing | デモが示す終段状態（`closed` / `closing`）まで進む |
| ICE restart | restart 後も `connected` または DC/映像が再開 |

多くの Babel HTML はグローバル `let rtc` に `RTCPeerConnection` を入れている。`page.evaluate` で `rtc.connectionState` / `getStats` を読むヘルパを Arrange 側に 1 つ置く。`data-testid` を全 HTML に足す作業は必須にしない。

### 2.6 example コード側の許容変更

原則としてデモの説明用コードは大きく書き換えない。試験のために許す最小変更:

- `sendonly/av.ts` のメディアパスを環境変数で上書き
- 未移行の `Navigator.getUdpMedia` / 非標準 `getUserMedia({ path })` を polyfill に合わせる（親チケットの残り。本ハーネスの前提）
- プロセスがテストから止められないものに限り、SIGTERM で WebSocket サーバと gst/ffmpeg を閉じる（無い場合はハーネスがプロセスグループ kill）
- 出力ファイルを `os.tmpdir()` または example 配下の gitignore 済みディレクトリへ（リポジトリを汚さない）

デモを protoo 化したり、ルート `e2e/` handler に移植して「同じシナリオ」だけ通すのは **不可**。必ずカタログのファイルを spawn する。

### 2.7 ドキュメント

- ルート `AGENTS.md`: `examples:e2e` コマンドと、example 変更時は対象カタログの試験を回す旨
- 新 `examples/AGENTS.md`: 対象/非対象、ハーネスの起動、ffmpeg/gst が PATH に要ること
- `.github/workflows/nodejs.yml`: `ffmpeg` インストールと `npm run examples:e2e`
- `examples/e2e` の短い README（スクリプトと fake media 前提）

## 3. 技術的な実装アプローチ（調査結果サマリ）

- **ランナー**: 既存 HTML を URL として開く必要があるので `@vitest/browser`（テスト自体がブラウザ内）ではなく、turn-loopback と同じ Node vitest + `playwright` `chromium.launch`。バージョンはリポジトリの既存ピン（vitest `3.0.5`、playwright `^1.55.1`）に合わせる。
- **起動**: ルートから `tsx examples/...` が既定の手実行方法。ハーネスも同じ（`tsx` はルート devDependency）。`examples/package.json` の `ws` / `express` に依存する。
- **シグナリング**: ほぼ `ws` の 1 ポート。`interop/server.ts` だけ HTTP POST `/offer`。ダッシュボード系は別ポート。
- **メディア Node 側**: `sendonly/offer.ts` / `ffmpeg.ts` / `red/send.ts` / `interop/client.ts` は既に `installPolyfill` + `createRtpRtcpRegister`。ブラウザ側 getUserMedia は fake device。
- **gst/ffmpeg**: CI と sysbox イメージは `gstreamer1.0-tools` とプラグイン一式済み。**`ffmpeg` バイナリは未インストール**（libav*-dev のみ）。`ffmpeg.ts` を通すなら workflow とローカル手順に `ffmpeg` を足す。
- **ポート**: `8888` が最多、`save_to_disk` は `8878`、`sendonly/av.ts` は `8881`、`ice/turn` は `8889`（非対象）。直列実行が前提。
- **アセット**: ルート `examples/` に mp4/webm は無い。polyfill の e2e アセットは `packages/webrtc/tests/data/nonstandard/userMedia-e2e`（実行時 cwd 依存）。ファイル再生デモ用フィクスチャはハーネス側でパスを解決する。
- **既存 e2e との差分**: ルート `e2e` は sendrecv / simulcast / rtx / red / datachannel / ice trickle・restart を **別実装** でカバー済み。本ハーネスはデモファイルの回帰用で、プロトコル網羅の置き換えではない。

## 4. 考慮すべき制約や注意点

- 実行環境は Linux / macOS 等 Unix のみ。Native Windows は対象外。
- Chromium を `test:small` や WPT に混ぜない。
- ブラウザに werift polyfill を入れない。fake device のみ。OS カメラ評価・映像品質 MOS は対象外。
- STUN/TURN を新たに足さない。loopback host candidate。
- `gst-launch-1.0` / `ffmpeg` が無いマシンでは該当テストを skip し、メッセージで理由を出す。CI では skip せず失敗させる。
- spawn した gst/ffmpeg は example が握っていないことがある。ハーネスはプロセスグループまたは `pkill` 相当の追跡で回収する（e2e の `cleanupGstreamerProcesses`）。
- Babel 5 のブラウザ変換は遅い。タイムアウトに含める。vendor 差し替え後も初回コンパイル待ちを Act に書く。
- グローバル `rtc` が無い TSX 画面は Vite 側の video 要素 / ログ DOM を待つ。無理に全 HTML を改修しない。
- 親チケット未完了の公開 API に依存するデモは、polyfill が入った `feature/polyfill` 前提で動かす。
- `dash` / `playground` / EME は初回カタログ外。後から足すなら catalog.ts だけ拡張できる形にする。
- 長時間化: カタログ全本を直列 60s 上限だと数十本で CI が伸びる。実装時は共通ヘルパでケースを薄くし、simulcast 系は代表例を必須・同一パターンの残りは同じヘルパ呼び出しでよい。

## 5. 完了条件

- [ ] `examples/e2e` に vitest + Playwright（Node `chromium.launch`）ハーネスがあり、`@vitest/browser` で既存 HTML を捨てていない
- [ ] Arrange ヘルパが `tests/helpers` に集約され、Act / Assert に日本語コメントがある
- [ ] カタログ（試験する / しない）が `catalog.ts` と `examples/AGENTS.md` で一致している
- [ ] 対象の werift+ブラウザ デモを、当該 `.ts` を spawn + 当該 HTML を開いて少なくとも DataChannel または inbound RTP / 接続状態で検証している
- [ ] 対象の ffmpeg/gst デモを、実バイナリ経路で検証している（モックしない）
- [ ] Heroku / Ring / Google Nest / 空 TURN / 手動 SDP / Node のみベンチ / `packages/*/examples` を試験していない
- [ ] ブラウザへ polyfill を注入していない
- [ ] 各テストの `finally` で browser context、example プロセス、gst/ffmpeg、一時ファイルを残さない
- [ ] 直列実行（固定ポート）でポート衝突しない
- [ ] Babel HTML の React/Babel CDN をテスト実行が外部 CDN 必須にしていない（vendor または route）
- [ ] ルートに `examples:e2e` があり `test:small` には含まれない
- [ ] GitHub Actions が `ffmpeg` と既存 gstreamer を入れたうえで `examples:e2e` を実行する
- [ ] ルート `AGENTS.md` と `examples/AGENTS.md` がコマンドと対象範囲を書いている
- [ ] `examples/turn-loopback` の試験を本ハーネスに複製していない
- [ ] `cd examples/e2e && npm run type` と `npm run ci:silent` が、対象カタログに対して成功する