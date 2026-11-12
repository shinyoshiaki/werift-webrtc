# [E2E] 保守されていない Firefox E2E（`e2e/vitest.firefox.config.mts`）を正常に動作させる

## 1. 目的と背景

- `e2e/` には Firefox 用の設定（`vitest.firefox.config.mts`）とスクリプト（`npm run firefox`）がある。しかし CI（`.github/workflows/nodejs.yml` の `npx playwright install chromium` → `npm run ci` → `e2e/run-ci.js` → `chrome:prod`）が実行するのは Chrome だけで、Firefox の E2E は保守されていない。ルートの `README.md`（L32 / L183）は「A Firefox test runner is also included」と書いているので、ドキュメントと実態がずれている。
- 親チケット #269 の確認（2026-11-12、HEAD `7ffcaaf9a`、Firefox 157 / Playwright 1.64.1）では、既定設定の基本テストが全件失敗した。
  - `tests/datachannel/datachannel.test.ts`: 3 件すべて `Test timed out in 20000ms`
  - `tests/mediachannel/sendrecv.test.ts`: すべて `waitVideoPlay timed out`
  - `tests/bundle/*`: すべて失敗
  - `media.peerconnection.ice.obfuscate_host_addresses: false` を追加しても結果は変わらない。
- 一方、同じ環境で Node の werift と Playwright の Firefox を直接つなぐと、DataChannel は成立する。mDNS 秘匿ありでも、STUN を設定しても同じだった。そのため、原因は werift と Firefox の非互換ではなく、**E2E の経路（起動手順、設定、シグナリング）にある**と考えられる。
- werift ↔ Firefox の既知の不具合は、別のサブタスクで扱う。
  1. `a=bundle-only` 未対応（Firefox の `port 0` + `bundle-only` の offer に、`c=` のない answer を返す）
  2. werift 起点の ICE restart の後に Firefox の受信が止まる

  この 2 件に依存するテストは、修正されるまで Firefox ではスキップする（理由とサブタスクを明記する）。

## 2. 調査結果（コードから分かる差分と、有力な原因候補）

### 2.1 `npm run firefox` だけでは e2e サーバーが起動しない（最有力）

| 項目 | Chrome（CI 経路） | Firefox（`npm run firefox`） |
| --- | --- | --- |
| サーバーのビルド | `npm run ci` / `ci:silent` が `npm run build`（`tsc -p tsconfig.server.json` → `lib/`）を実行する | 実行しない |
| サーバーの起動 | `run-ci.js` が空きポートを取り、`E2E_PORT` / `VITE_E2E_PORT` を設定して `run-p server:* chrome:prod` を実行する | 起動しない。`vitest run ./tests ...` だけを実行する |
| 接続先 | `VITE_E2E_PORT`（空きポート） | 未設定なら `tests/fixture.ts` の既定値 `8886` |
| 停止 | `stop.js` の `PUT /stop`（`requestServerStop(port)`） | なし |

- `tests/fixture.ts` はモジュールの読み込み時に `new WebSocketTransport("ws://localhost:<port>")` を作り、各テストは `if (!peer.connected) await new Promise(r => peer.on("open", r))` で待つ。サーバーがなければ `open` は発火しないので、**全テストが `testTimeout`（20s）で落ちる**。これは「全件タイムアウト」「mDNS 設定を変えても変わらない」という観測と一致する。
- 親チケットで別にサーバーを起動していたかどうかは記録がない。そのため、まず「サーバーあり」で再現するかを確かめ、再現しなければ 2.1 を主因と判断する。

### 2.2 `vitest.firefox.config.mts` が Chrome 設定の改修に追従していない

`vitest.config.mts`（Chrome）と比べて、次のものが足りない。

- `fileParallelism: false` がない。Chrome 側のコメントにあるとおり、テストは 1 台のブラウザと e2e サーバー（gstreamer、TURN、UDP ソース）を共有するので、並列実行ではタイミング依存のテストが不安定になる。
- `include` に `tests/**/*.spec.ts` がなく、`exclude`（`**/simulations/**`、`lib/**` など）もない。しかも `npm run firefox` は `./tests` をパスフィルタとして渡している。`run-chrome-prod.js` のコメントにあるとおり、このフィルタは部分一致なので `simulations/tests/gccTwccChrome.sim.test.ts`（Chrome 専用の帯域 sim）も拾ってしまう。
- `firefoxUserPrefs` は `media.navigator.permission.disabled` と `media.navigator.streams.fake` だけ。Chrome の `--disable-features=WebRtcHideLocalIpsWithMdns` に当たる `media.peerconnection.ice.obfuscate_host_addresses: false` などは未設定である。必要かどうかは 2.1 を直した後に判断する。

### 2.3 ブラウザの取得

- `ensure-browser.js` は Chrome / Chromium（`chromium`、`chromium-headless-shell`）しか扱わない。Firefox は `npx playwright install firefox` を手で実行する必要がある。インストール先は `browsers-path.js` / `ensureBrowsersPathEnv()` が決める `PLAYWRIGHT_BROWSERS_PATH`（既定は `e2e/.playwright-browsers/`）である。
- `npm run firefox` は `ensureBrowsersPathEnv()` を通らない。このため、`PLAYWRIGHT_BROWSERS_PATH` を自分で設定しないと `~/.cache/ms-playwright` を見にいき、Chrome 用のキャッシュと場所がずれる。

### 2.4 シグナリング（トリクル）での確認点

- 各テストの `pc.onicecandidate = ({ candidate }) => peer.request(..., { type: "candidate", payload: candidate })` は、end-of-candidates の `null` もそのまま送る。サーバー側は `addIceCandidate(payload)` で受ける（`packages/webrtc/src/peerConnection.ts` L1555、`negotiation/remoteCandidates.ts` L94 の `apply()`）。
  - Firefox は収集完了を、`candidate: ""`（空文字）の `RTCIceCandidate` と `null` の両方で通知する。
  - リクエストは `.catch(() => {})` で握りつぶしているので、失敗しても表に出ない。サーバー側の例外は `main.ts` の `console.log(error)` にしか出ない。
  - **`server:prod`（`DEBUG=werift*`）のログで、空文字の candidate がエラーにならないか確認する。** エラーになるなら、W3C の仕様では空文字の candidate は end-of-candidates として受け入れるべきなので、werift 本体の不具合として扱う（判断は 4 章）。
- トリクルの candidate が offer / answer より先に届くことがある（`datachannel_offer` では `init` の前に `candidate` が来る可能性）。そのときは `this.pc` が undefined で例外になる。Chrome では順序が偶然そろっているだけかもしれない。Firefox で再現した場合は、ハンドラ側で queue するか、テスト側で `init` の後に送るように直す（`tests/nativeCandidateQueue.ts` という既存の仕組みがあるので、まず流用を検討する）。

### 2.5 既存のブラウザ判定

- `tests/fixture.ts` の `browserName`（Bowser。Firefox では `"Firefox"`）で、すでに次のテストを分岐またはスキップしている。
  - `red.test.ts`、`codecRtp.test.ts`（Chrome 専用の codec RTP）
  - `reuse.test.ts`、`removeTrack.test.ts`（L36 / L102）
- 新しくスキップを足すときも、同じ書き方（`if (browserName === "Firefox") { it.skip("理由 …", () => {}) }`）にそろえる。

## 3. 実装内容

### Step 1: 起動経路を整備する（E2E 基盤。本チケットで直す）

1. `run-ci.js` を、ブラウザを指定できる形に一般化する。例: `node run-ci.js silent firefox`、または環境変数 `E2E_BROWSER=firefox`。
   - 空きポートの取得、`E2E_PORT` / `VITE_E2E_PORT` の設定、`ensureBrowsersPathEnv()`、`requestServerStop(port)` による停止を、Chrome と同じ処理で共有する。
   - Firefox 用のランナー（例: `run-firefox-prod.js`。`run-chrome-prod.js` と同じ構造で、`vitest run --browser.headless --config vitest.firefox.config.mts --reporter=dot` を実行する）を追加する。
   - サーバーは PID または `/stop` で止める（パターン指定の kill は使わない。root AGENTS.md）。
2. `package.json` の scripts を整理する。
   - `firefox`: サーバーが起動済みのときに使う開発用。`./tests` フィルタを外す。
   - `firefox:prod`: 上のランナー。
   - `ci:firefox`: `install:browsers`（Firefox を含む）→ `build` → `run-ci.js silent firefox`。
   - ルート `package.json` に `e2e:firefox`（`cd e2e && npm i && npm run ci:firefox`）を追加するかどうかも決める。
3. `vitest.firefox.config.mts` を `vitest.config.mts` にそろえる。
   - `include` / `exclude`（simulations と `lib/` の除外）
   - `fileParallelism: false`、`retry: 1`、`testTimeout`
   - 重複を避けるため、共通部分を関数かオブジェクトに切り出して、両方の config から使う形を推奨する。ただし `browser-paths.js` を `require` で読む方式は、Vite のバンドルを避けるために必要なので壊さない。
4. `ensure-browser.js` を、Firefox も取得できるようにする。
   - 引数か `E2E_BROWSER` で `firefox` を指定したときは、`npx playwright install firefox` を実行し、`firefox.executablePath()` が存在するかで検証する（`hasPlaywrightChromium()` と同じ形の `hasPlaywrightFirefox()` を作る）。
   - Chrome だけのときの既存の処理（system Chrome を優先、H.264 用の Google Chrome、リトライ）は変えない。

### Step 2: 1 件ずつ再現し、原因を分類する

1. Step 1 の経路で、`tests/datachannel/datachannel.test.ts` の `answer` だけを実行する（`-t answer`、またはファイルを指定）。
2. 失敗したら、次の順に見て、どこで止まるかを特定する。
   1. `peer.on("open")` が発火するか（ブラウザコンソールでの WebSocket 接続）。`localhost` が `::1` に解決される場合は、`127.0.0.1` に統一する（`e2eBaseUrl` はすでに `127.0.0.1` を使っている）。
   2. サーバーのログ（`server:prod`）に、`init` / `answer` / `candidate` のリクエストと、`exec` の例外が出ているか。
   3. Firefox の `iceConnectionState` / `connectionState` と、werift の `iceConnectionState`。
   4. 空文字・`null` の candidate の扱い（2.4）。
   5. mDNS の `.local` 候補（werift が解決できずに捨てていないか）。必要なら `firefoxUserPrefs` に `media.peerconnection.ice.obfuscate_host_addresses: false` を足す。
3. datachannel が通ったら、`mediachannel/sendrecv` → `bundle/*` → 残りの全件、の順に広げる。
4. 失敗するテストは、それぞれ次のどれかに分類し、表にしてチケットに残す（5.3 の表の形）。

| 分類 | 対応 |
| --- | --- |
| E2E 基盤（シグナリング、ハンドラ、設定、テストの書き方） | 本チケットで直す |
| werift 本体: `bundle-only` 未対応 / werift 起点の ICE restart | 既存のサブタスクを参照して、Firefox だけスキップする |
| werift 本体: 新しい不具合（例: 空文字 candidate で例外） | 新しいサブタスクを作って参照し、スキップする。小さく安全に直せるなら、本チケットで直してもよい（`packages/webrtc` のテストを足す） |
| ブラウザ固有でテストの前提が成り立たない（pranswer 未実装、Chrome 専用の codec / RED / simulcast の rid 形式など） | `browserName === "Firefox"` で、理由を書いてスキップする |

### Step 3: テストの修正（必要なものだけ）

- Firefox 固有の形を前提にしていないか確認する。
  - `tests/bundle/tagOnlyCandidates.test.ts`: 親チケットで `bundleCandidates` の名前が `legacy` / `compatible` に変わっている。名前と期待値が揃っているか確認する。Firefox の再 offer は `bundle-only` になるので、Firefox 起点の再交渉を含むケースは、既知サブタスク 1 に依存する。
  - `tests/ice/restart.test.ts`: `ice_restart_node_trigger` は既知サブタスク 2 に依存する。`ice_restart_web_trigger` は Firefox の offer が `bundle-only` を含めば、既知サブタスク 1 に依存する。
  - `addTrack` / `removeTrack` / `reuse` / `simulcast`: Firefox 起点の再 offer で追加する m-line は `bundle-only` になるので、サブタスク 1 に依存する可能性が高い。
- 修正やスキップを足すときは、テストの Arrange / Act / Assert の区切りと日本語コメントを AGENTS.md の規約どおりに付ける。共通の準備は `tests/fixture.ts` にまとめる（Firefox かどうかの判定と、スキップ理由の定数など）。

### Step 4: ドキュメントと保守方針

1. `e2e/AGENTS.md` を新しく作る（root の section 順: Purpose, Scope, Do, Don't, Commands, Validation, Maintenance）。または、既存の README に Firefox の節を足す。書く内容は次のとおり。
   - 単独実行の手順: `npm run ci:firefox`（自動）と、手動手順（`npm run build` → `E2E_PORT=<port> npm run server:prod` → `VITE_E2E_PORT=<port> npm run firefox` → `node stop.js`、または `PUT /stop`）
   - `PLAYWRIGHT_BROWSERS_PATH` と `npm run install:browsers` で Firefox を取得する方法
   - スキップの方針（分類表と、参照するサブタスク）
2. ルート `README.md` の L32 / L183 の Firefox の記述を、実態（どこまで通るか、CI に入っているか）に合わせて直す。ルートの `AGENTS.md` の Commands 表に `e2e:firefox` を足す場合は、最後に更新する（root AGENTS.md の Maintenance）。
3. CI への組み込み方を決めて、理由を本チケットに書く。推奨案は次のとおり。
   - `nodejs.yml` に **別ジョブ `e2e-firefox`** を作る。Chrome の `npm run ci` とは独立させ、最初は `continue-on-error: true` か `workflow_dispatch` / nightly で回して、安定したら必須にする。
   - 理由: Chrome の E2E の実行時間を増やさないこと、Firefox / Playwright の更新による壊れ方を Chrome の結果と分けること、既知サブタスクが直るまでスキップが多いこと。
   - 別案: datachannel / sendrecv / bundle の subset だけを PR ごとに回す。採用しない場合は、その理由も書く。

## 4. 制約・注意点

- **Chrome E2E を壊さない**: `vitest.config.mts`、`run-ci.js`、`run-chrome-prod.js`、`ensure-browser.js` を共通化するときは、Chrome の既定の挙動（`npm run e2e` / `npm run ci` / CI の `npx playwright install chromium`）を変えない。`E2E_BROWSER` が未指定なら Chrome とする。
- **werift の挙動を E2E のために変えない**: ハンドラ（`server/handler/*`）とテストの修正は、シグナリングの不具合（順序、null の扱い、例外の握りつぶし）を直す範囲に限る。`packages/webrtc/src` を変えるのは「本体の不具合」と分類したものだけにし、そのときは package テストを足し、`npm run type` / `npm run test:small` を通す。
- `.catch(() => {})` による例外の握りつぶしは、原因の調査を難しくする。少なくとも調査中はログに出し、直すならテストが失敗として扱えるようにする（root AGENTS.md「broad catch-and-ignore を避ける」）。
- サーバーやブラウザは PID か `/stop` で止める。`npm run clean`（`pkill -9 gst-launch`）は使わない。
- Playwright の Firefox のバージョンは `e2e/package.json` の `playwright` で決まる（現在 `^1.64.1`）。Firefox のために `playwright` を上げる場合は、Chrome にも影響するので、Chrome の E2E も回す。
- TypeScript は erasable syntax だけで書く（`enum` とパラメータプロパティは使わない）。`tsx` などのランナーは入れない。
- `bundle-only` と ICE restart の 2 サブタスクが直ったら、スキップを外す必要がある。スキップ理由にサブタスクを書いておき、検索で見つけられるようにする（例: スキップ文言に `firefox-bundle-only` のような固定のタグを入れる）。

## 5. 完了条件

### 5.1 動作

- [ ] `npm run ci:firefox`（仮称）を 1 コマンドで実行すると、ビルド、サーバー起動、Firefox の取得、テスト、サーバー停止まで完了する。
- [ ] Firefox で、`datachannel`（answer / offer / binary echo）、`mediachannel/sendrecv`、`bundle/*`（`max-bundle` / `max-compat` / `disable`）が通る。
- [ ] 通らないテストは、`browserName === "Firefox"` でスキップし、理由（既知サブタスク、新しいサブタスク、ブラウザ未対応）を書いている。理由のない失敗は残っていない。
- [ ] 2 回続けて実行しても、同じ結果になる（`retry: 1` の範囲で安定する）。

### 5.2 回帰

- [ ] Chrome の E2E（`npm run e2e`）に回帰がない。
- [ ] `cd e2e && npm run type` と `npm run test:tools` が通る。
- [ ] `npm run format` を実行した。`packages/webrtc/src` を変えた場合は、`npm run type` と `npm run test:small` が通る。

### 5.3 ドキュメント

- [ ] `e2e/` の AGENTS.md または README に、Firefox の単独実行手順（自動・手動）、`PLAYWRIGHT_BROWSERS_PATH`、ブラウザの取得方法、スキップの方針が書いてある。
- [ ] ルート `README.md` の Firefox の記述が実態に合っている。
- [ ] CI に組み込むかどうか（別ジョブ / nightly / subset）と、その理由が本チケットに書いてある。組み込むなら `nodejs.yml` に反映している。
- [ ] 本チケットに、テストごとの結果の表（テスト、Firefox の結果、分類、参照先）を残している。

| テスト | Firefox の結果 | 分類 | 参照 / 備考 |
| --- | --- | --- | --- |
| （作業時に記入） | | | |

## 6. 検証コマンド

- `cd e2e && npm run type && npm run test:tools`
- `cd e2e && npm run ci:firefox`（Firefox。仮称）
- `npm run e2e`（Chrome。最後に全件）
- `npm run format`
- `packages/webrtc` を変えた場合: `npm run type`、`npm run test:small`
