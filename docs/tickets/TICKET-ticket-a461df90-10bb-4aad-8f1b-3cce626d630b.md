# [E2E] 保守されていない Firefox E2E（`e2e/vitest.firefox.config.mts`）を正常に動作させる

## 1. 目的と背景

- `e2e/` には Firefox 用の設定（`vitest.firefox.config.mts`）とスクリプト（`npm run firefox`）がある。しかし CI（`.github/workflows/nodejs.yml` の `npx playwright install chromium` → `npm run ci` → `e2e/run-ci.js` → `chrome:prod`）が実行するのは Chrome だけで、Firefox の E2E は保守されていない。ルートの `README.md`（L32 / L183）は「A Firefox test runner is also included」と書いているので、ドキュメントと実態がずれている。
- 親チケット #269 の確認（2026-11-12、HEAD `7ffcaaf9a`、Firefox 157 / Playwright 1.64.1）では、既定設定の基本テストが全件失敗した。
  - `tests/datachannel/datachannel.test.ts`: 3 件すべて `Test timed out in 20000ms`
  - `tests/mediachannel/sendrecv.test.ts`: すべて `waitVideoPlay timed out`
  - `tests/bundle/*`: すべて失敗
  - `media.peerconnection.ice.obfuscate_host_addresses: false` を追加しても結果は変わらない。
- 一方、同じ環境で Node の werift と Playwright の Firefox を直接つなぐと、DataChannel は成立する。mDNS 秘匿ありでも、STUN を設定しても同じだった。そのため、原因は werift と Firefox の非互換ではなく、**E2E の経路（起動手順、設定、シグナリング）にある**と考えられる。
- werift ↔ Firefox の既知の不具合は、別のサブタスクで扱う。どちらも親チケット #269（`190063e8-99d9-410f-89ca-cee8cf6423a1`）の §9.6 で見つかったもので、チケットは**作成済み**である（2026-11-12 に `ide-cli ticket list` で確認）。本チケットでは新しく作らない。

| # | チケット ID | タイトル | スキップ文言の固定タグ |
| --- | --- | --- | --- |
| 1 | `21a27c92-7ca2-4075-bd29-246f95715de2` | [SDP/BUNDLE] Firefox の `a=bundle-only` m-line を拒否扱いし、`c=` のない answer を返して交渉が失敗する | `[firefox-known:bundle-only]` |
| 2 | `ef1c086e-1a6f-479e-8940-822231b4f359` | [ICE] werift 起点の ICE restart の後、Firefox が werift からの RTP / DataChannel を受け取れなくなる | `[firefox-known:ice-restart]` |

  この 2 件に依存するテストは、修正されるまで Firefox ではスキップする（理由とサブタスクを明記する。1.1 の決定事項 D1 / D2）。

## 1.1 決定事項（未確定事項の解消）

### D1. bundle-only に依存する `bundle/*` の扱い → **(b) スキップして完了とする**

- 本チケットでは `packages/webrtc/src` の bundle-only 対応は**行わない**。Firefox 起点の `bundle-only` offer が原因で通らないケースは、`[firefox-known:bundle-only]` のタグを付けて Firefox だけスキップする。それをもって完了とする。
- 理由:
  - bundle-only 対応はサブタスク 1（`21a27c92-…`）の範囲である。そのチケットはすでに、RFC 8843 §6 / §7.3.3 に沿った answer の生成という negotiation 変更として切り出されている。negotiation 変更には `tools/negotiation-diff`、`npm run pbt:deep`、WPT の確認が必要（`packages/webrtc/AGENTS.md`）。これを E2E 基盤の修正と同じ変更に混ぜると、レビューと切り戻しの単位が大きくなる。
  - 本チケットの目的は「Firefox E2E を回せる状態にし、werift 本体の不具合を E2E で検出できるようにする」ことである。サブタスク 1 の修正を検証する経路を先に用意するので、順序としては本チケットが先になる。
  - 親チケット §9.6 によれば、Firefox が `bundle-only` を使うのは「`max-bundle` の初回 offer」「再 offer で追加する m-line」「ICE restart の offer」に限られる。werift 起点の offer と、`max-compat` / `disable` での Firefox 起点の初回 offer は、bundle-only に依存しない。そのため `bundle/*` の大半は本チケットだけで通るはずである。
- 依存が想定されるケースは次のとおり（作業時に実測して 5.3 の表で確定する）。
  - `tests/bundle/max-bundle.test.ts` の Firefox 起点の offer ケース（`bundlePolicy: "max-bundle"` で `pc.createOffer()`。L84– の 2 件目）
  - `tests/bundle/tagOnlyCandidates.test.ts` のうち、Firefox 起点の再 offer を含むもの
  - `tests/ice/restart.test.ts` の `ice_restart_web_trigger`（Firefox の restart offer は bundle-only を含む）
  - `addTrack` / `removeTrack` / `reuse` / `simulcast` のうち、Firefox 起点の再 offer で m-line を足すもの
- 次のテストは、bundle-only を理由にスキップしてはならない: `max-bundle.test.ts` の werift 起点の offer ケース、`max-compat.test.ts`、`disable.test.ts` の全件。これらが通らないときは、E2E 基盤の問題か新しい不具合として調べる。
- スキップする根拠が bundle-only であることは、その場で確かめる。確認方法: Firefox の `setRemoteDescription(answer)` が `c= connection line not specified` で失敗すること、または送受信される SDP に `a=bundle-only` があること。確かめたらテスト結果の表に書く。推測だけでスキップしない。

### D2. 参照するサブタスクと固定タグ → **作成済みの 2 件を参照する。新規作成はしない**

- 参照先は 1 章の表の 2 件に決める。スキップ文言には、固定タグと**チケット ID の先頭 8 文字**を入れる。
  - 例: `it.skip("[firefox-known:bundle-only] 21a27c92: Firefox の max-bundle offer は a=bundle-only を使う", ...)`
  - 例: `it.skip("[firefox-known:ice-restart] ef1c086e: werift 起点の restart 後に Firefox の受信が止まる", ...)`
- タグと理由の文言は `tests/fixture.ts` に定数として 1 か所でまとめる（例: `firefoxKnownIssue.bundleOnly` / `firefoxKnownIssue.iceRestart`）。各テストはその定数を使う。サブタスクが直ったら `grep -rn "firefox-known:bundle-only" e2e/tests` で解除の対象を探し、スキップを外す。この手順をサブタスク 1 / 2 の完了条件に足してもらうよう、それぞれのチケットに一行追記する（本チケットの作業に含める）。
- 上の 2 件に当てはまらない werift 本体の不具合が新しく見つかった場合は、本チケットの作業で `ide-cli ticket create-subtask` を使い、親チケット #269 の下にサブタスクを作る。タグは `[firefox-known:<短い名前>]` の形で足す。
- ブラウザの仕様で前提が成り立たないもの（pranswer 未実装など）は、`[firefox-unsupported:<機能>]` のタグを使い、チケットは参照しない。既存のスキップ（`red` / `codecRtp` / `reuse` / `removeTrack`）にも、同じ形のタグを付けて揃える。

## 2. 調査結果（コードから分かる差分と、有力な原因候補）

### 2.1 `npm run firefox` だけでは e2e サーバーが起動しない（保守性の問題。観測した失敗の主因ではない。下の追記を参照）

| 項目 | Chrome（CI 経路） | Firefox（`npm run firefox`） |
| --- | --- | --- |
| サーバーのビルド | `npm run ci` / `ci:silent` が `npm run build`（`tsc -p tsconfig.server.json` → `lib/`）を実行する | 実行しない |
| サーバーの起動 | `run-ci.js` が空きポートを取り、`E2E_PORT` / `VITE_E2E_PORT` を設定して `run-p server:* chrome:prod` を実行する | 起動しない。`vitest run ./tests ...` だけを実行する |
| 接続先 | `VITE_E2E_PORT`（空きポート） | 未設定なら `tests/fixture.ts` の既定値 `8886` |
| 停止 | `stop.js` の `PUT /stop`（`requestServerStop(port)`） | なし |

- `tests/fixture.ts` はモジュールの読み込み時に `new WebSocketTransport("ws://localhost:<port>")` を作り、各テストは `if (!peer.connected) await new Promise(r => peer.on("open", r))` で待つ。サーバーがなければ `open` は発火しないので、**全テストが `testTimeout`（20s）で落ちる**。これは「全件タイムアウト」「mDNS 設定を変えても変わらない」という観測と一致する。
- **（2026-11-12 追記・事実訂正）親チケットの確認では、サーバーを起動したうえで Firefox を実行していた。その状態で全件失敗しているので、観測した失敗の主因は 2.1 ではない。** 実行条件は次のとおり。
  - `cd e2e && npm run build` の後、`E2E_PORT=8931 node lib/e2e/server/main.js` をバックグラウンドで起動した（`start { port: 8931, ... }` を確認）。
  - `E2E_PORT=8931 VITE_E2E_PORT=8931 PLAYWRIGHT_BROWSERS_PATH=<private> npx vitest run --config vitest.firefox.config.mts --browser.headless --retry=0 <file>` で実行した。Firefox 157（Playwright 1.64.1、build v1555）。
  - このとき `tests/datachannel/datachannel.test.ts` は 3 件すべて `Test timed out in 20000ms`、`tests/mediachannel/sendrecv.test.ts` は `waitVideoPlay timed out` になった。`media.peerconnection.ice.obfuscate_host_addresses: false` を加えても同じだった。
  - `bundle/max-bundle.test.ts` では、mDNS 秘匿を無効にすると Firefox が `SIPCC ... c= connection line not specified` を出した。これは bundle-only サブタスク（21a27c92）の不具合で、少なくとも bundle 系では SDP の交換まで進んでいる。
  - サーバーのログは `start` 行のみで、`DEBUG` を付けていないため、リクエストが届いたかは記録していない。最初の調査では `DEBUG=werift*` と protoo のログを有効にし、`open`・各リクエスト・ICE 状態のどこで止まるかを確かめる。
- 2.1（`npm run firefox` がサーバーを起動しない）は、上の失敗の原因ではない。ただし、単独実行の手順と保守性の問題としては残るので、3 章の整備対象とする。

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
| werift 本体: `bundle-only` 未対応 | `21a27c92` を参照し、`[firefox-known:bundle-only]` で Firefox だけスキップする（D1。本チケットで本体は直さない） |
| werift 本体: werift 起点の ICE restart | `ef1c086e` を参照し、`[firefox-known:ice-restart]` で Firefox だけスキップする |
| werift 本体: 新しい不具合（例: 空文字 candidate で例外） | `ticket create-subtask` で #269 の下にサブタスクを作り、`[firefox-known:<名前>]` でスキップする（D2）。数行で直せて negotiation の形を変えないもの（例: 空文字 candidate を end-of-candidates として受け入れる）に限り、本チケットで直してもよい。その場合は `packages/webrtc` のテストを足す |
| ブラウザ固有でテストの前提が成り立たない（pranswer 未実装、Chrome 専用の codec / RED / simulcast の rid 形式など） | `[firefox-unsupported:<機能>]` を付け、`browserName === "Firefox"` でスキップする |

### Step 3: テストの修正（必要なものだけ）

- Firefox 固有の形を前提にしていないか確認する。
  - `tests/bundle/tagOnlyCandidates.test.ts`: 親チケットで `bundleCandidates` の名前が `legacy` / `compatible` に変わっている。名前と期待値が揃っているか確認する。Firefox の再 offer は `bundle-only` になるので、Firefox 起点の再交渉を含むケースは、既知サブタスク 1（`21a27c92`、`[firefox-known:bundle-only]`）に依存する。
  - `tests/ice/restart.test.ts`: `ice_restart_node_trigger` は既知サブタスク 2（`ef1c086e`、`[firefox-known:ice-restart]`）に依存する。`ice_restart_web_trigger` は Firefox の offer が `bundle-only` を含めば、既知サブタスク 1（`21a27c92`、`[firefox-known:bundle-only]`）に依存する。
  - `addTrack` / `removeTrack` / `reuse` / `simulcast`: Firefox 起点の再 offer で追加する m-line は `bundle-only` になるので、サブタスク 1（`21a27c92`）に依存する可能性が高い。
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
- `bundle-only`（`21a27c92`）と ICE restart（`ef1c086e`）の 2 サブタスクが直ったら、スキップを外す必要がある。スキップ文言には D2 の固定タグ（`[firefox-known:bundle-only]` / `[firefox-known:ice-restart]`）とチケット ID を入れ、grep で見つけられるようにする。
- bundle-only 対応（`packages/webrtc/src` の SDP 生成・解釈）は本チケットの範囲外（D1）。E2E を通すために、ハンドラ側で SDP を書き換えて回避することもしない（werift の不具合を隠すことになるため）。

## 5. 完了条件

### 5.1 動作

- [ ] `npm run ci:firefox`（仮称）を 1 コマンドで実行すると、ビルド、サーバー起動、Firefox の取得、テスト、サーバー停止まで完了する。
- [ ] Firefox で、`datachannel`（answer / offer / binary echo）と `mediachannel/sendrecv` が全件通る。
- [ ] `bundle/*` は、`max-compat.test.ts` と `disable.test.ts` の全件、および `max-bundle.test.ts` の werift 起点の offer ケースが通る。`max-bundle` の Firefox 起点の offer ケースなど bundle-only に依存するものは、D1 の確認方法で根拠を確かめたうえで `[firefox-known:bundle-only]`（`21a27c92`）を付けてスキップしていればよい。本チケットでは `packages/webrtc/src` の bundle-only 対応を求めない。
- [ ] 通らないテストは、`browserName === "Firefox"` でスキップし、D2 の固定タグ（`[firefox-known:*]` / `[firefox-unsupported:*]`）と、参照するチケット ID（`firefox-known` のとき）を書いている。理由のない失敗は残っていない。
- [ ] スキップ理由の定数が `tests/fixture.ts` に 1 か所でまとまっている。サブタスク `21a27c92` / `ef1c086e` に、スキップを解除する手順（grep するタグ）を追記している。
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