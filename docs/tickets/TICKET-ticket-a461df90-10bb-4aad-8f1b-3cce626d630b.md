# [E2E] 保守されていない Firefox E2E（`e2e/vitest.firefox.config.mts`）を正常に動作させる

> 2026-11-15 最新化（HEAD `0e88b2d43`）。前回からの主な変化:
> - Firefox E2E の実行・記録ランナー `npm run firefox:record`（`e2e/run-firefox.js`）が入った。実行記録は `e2e/firefox-runs/` にコミットされる（`03a719478` / `abfb3dd3e`）。
> - サブタスク 1（bundle-only、`21a27c92`）は完了し、修正 `5d901e2e0` は HEAD に入っている。
> - 「Firefox E2E は CI に入れない」方針が決まった（ユーザー指示、`03a719478`）。
>
> これに合わせて D1 を改め、D3 を追加した。Step 1 / Step 4 / 5 章も書き直した。

## 1. 目的と背景

- `e2e/` には Firefox 用の設定（`vitest.firefox.config.mts`）とスクリプトがある。CI（`.github/workflows/nodejs.yml` → `npm run ci` → `e2e/run-ci.js` → `chrome:prod`）が実行するのは Chrome だけである。ルートの `README.md`（L32 / L183）は「a Firefox test runner」と書いているが、実際には全件失敗する。
- Firefox E2E を CI に入れない方針は維持する。代わりに、ローカルで実行した記録をコミットして履歴を残す。そのための仕組みとして `npm run firefox:record` がすでに用意されている（D3）。本チケットの目的は、**この経路で Firefox E2E が通る状態にすること**である。
- コミット済みの実行記録（`e2e/firefox-runs/`）によると、いまも全件失敗している。どちらの記録も Firefox 157.0 / Playwright 1.64.1 / vitest 5.0.5 / Node v24.22.2 で取得しており、bundle-only の修正を含むコミットで実行している。

| 記録 | コミット | 対象 | 結果 |
| --- | --- | --- | --- |
| `20261114T025126Z-8000795be-dirty.json` | `8000795be` | 全件 | 23 ファイル・44 件のうち **passed 0**、failed 42、skipped 2。途中で止まった（unfinished 1: `bundle/max-compat > bundle_max_compat_answer`）。5 分間テストイベントが来ず、idle 上限で停止した |
| `20261115T032934Z-f9b9a763b-dirty.json` | `f9b9a763b` | `tests/datachannel/datachannel.test.ts` | 3 件すべて `Test timed out in 20000ms`（retry 込み） |

- 一方、同じ環境で Node の werift と Playwright の Firefox を直接つなぐと、交渉と DataChannel / RTP が成立する。親チケット #269 の確認と、`e2e/tools/firefoxBundleOnly.ts` の確認の両方で成立した。そのため、原因は werift と Firefox の非互換ではなく、**E2E の経路（vitest browser mode、設定、シグナリング、テストの書き方）にある**と考えられる。
- werift ↔ Firefox の既知の不具合は、別のサブタスクで扱う。どちらも親チケット #269（`190063e8-99d9-410f-89ca-cee8cf6423a1`）の §9.6 で見つかったものである。本チケットでは新しく作らない。

| # | チケット ID | タイトル | 状態（2026-11-15） | スキップ文言の固定タグ |
| --- | --- | --- | --- | --- |
| 1 | `21a27c92-7ca2-4075-bd29-246f95715de2` | [SDP/BUNDLE] Firefox の `a=bundle-only` m-line を拒否扱いし、`c=` のない answer を返して交渉が失敗する | **done**（review approved）。修正 `5d901e2e0` は本ワークツリーの HEAD に入っているが、`origin/develop`（`41773f4dc`）にはまだ入っていない | 不要（D1） |
| 2 | `ef1c086e-1a6f-479e-8940-822231b4f359` | [ICE] werift 起点の ICE restart の後、Firefox が werift からの RTP / DataChannel を受け取れなくなる | review レーン（未完了） | `[firefox-known:ice-restart]` |

## 1.1 決定事項

### D1. bundle-only と `bundle/*` の扱い → **サブタスク 1 は修正済みなので、`bundle/*` は全件通すことを完了条件にする**（前回の「(b) スキップして完了」から改めた）

- サブタスク 1 は完了しており、修正（`packages/webrtc/src/sdpManager.ts` の `acceptBundleOnlyMedia()`、`sdp.ts` の `bundleOnly` / `acceptedBundleOnly`、`remoteMediaApplication.ts` の tag 再選択）は HEAD に入っている。そのため、`[firefox-known:bundle-only]` によるスキップは**想定しない**。
- `max-bundle` / `max-compat` / `disable` の全件、`tagOnlyCandidates`、Firefox 起点の再 offer を含む `addTrack` などで bundle-only が原因に見える失敗が出た場合は、21a27c92 の回帰か取りこぼしとして扱う。調べ方は次のとおり。
  1. `cd e2e && node --import ../tools/node-ts/register.mjs tools/firefoxBundleOnly.ts --scenario all` を実行し、直接接続で `first` / `reoffer` / `restart` が PASS するかを確かめる。
  2. PASS する場合は、E2E 経路の問題として本チケットで直す。
  3. FAIL する場合は、`ticket create-subtask` で #269 の下にサブタスクを作り（D2）、`[firefox-known:<名前>]` でスキップする。
- 本チケットでも、`packages/webrtc/src` の bundle 処理は変えない（4 章）。
- 本チケットのブランチを develop に出すのは、21a27c92 の修正が develop にマージされた後にする。HEAD は 21a27c92 の修正を含む #269 のブランチを取り込んでいるため、先に出すと差分に他チケットの変更が混ざる。

### D2. 参照するサブタスクと固定タグ → **残るのは ice-restart の 1 件。新規作成は、見つかった場合だけ**

- スキップ文言には、固定タグと**チケット ID の先頭 8 文字**を入れる。
  - 例: `it.skip("[firefox-known:ice-restart] ef1c086e: werift 起点の restart 後に Firefox の受信が止まる", ...)`
- タグと理由の文言は `tests/fixture.ts` に定数として 1 か所でまとめる（例: `firefoxKnownIssue.iceRestart`）。各テストはその定数を使う。
  - サブタスク 2（`ef1c086e`）には、「直ったら `grep -rn "firefox-known:ice-restart" e2e/tests` で対象を探してスキップを外す」と一行追記する（本チケットの作業に含める）。
  - サブタスク 1 は完了済みなので、追記は不要になった。
- 上の件に当てはまらない werift 本体の不具合が新しく見つかった場合は、`ide-cli ticket create-subtask` で親チケット #269 の下にサブタスクを作り、`[firefox-known:<短い名前>]` のタグを足す。
- ブラウザの仕様で前提が成り立たないもの（pranswer 未実装、Chrome 専用の codec / RED など）には `[firefox-unsupported:<機能>]` を付け、チケットは参照しない。既存のスキップ（`red` / `codecRtp` / `reuse` / `removeTrack`）にも同じ形のタグを付けて揃える（2.5）。

### D3. 実行経路と CI → **`npm run firefox:record` を正式な経路とし、CI には入れない**

- ユーザーの指示（`03a719478`: 「firefox の E2E テストを CI の実行対象外にするのは維持したい」）により、`nodejs.yml` に Firefox ジョブは**追加しない**。前回 Step 4.3 で推奨していた別ジョブ / nightly / subset の案は取り下げる。
- 実行と検証は `cd e2e && npm run firefox:record [-- <vitest args>]` で行う。この経路は次のことを 1 コマンドで行う。
  - Firefox の取得
  - TypeScript ソースのままのサーバー起動（空きポート、`E2E_PORT` / `VITE_E2E_PORT`）
  - vitest の実行（`vitest.firefox.record.config.mts`）
  - `/stop` → PID によるサーバー停止
  - 記録の保存と古い記録の削除（既定で 20 件まで残す）
- 前回 Step 1 にあった `run-ci.js` の一般化、`run-firefox-prod.js`、`ci:firefox`、ルートの `e2e:firefox` は**作らない**。ルートの AGENTS.md の Validation が、Firefox E2E は `npm run firefox:record` で実行し、その記録をコミットすることとしているので、それに従う。
- 完了の根拠は、**修正後のコミットで取った全件の記録**（`vitestArgs: []`、`outcome: completed`）をコミットすることとする（5 章）。

## 2. 調査結果（コードと実行記録から分かること）

### 2.1 起動経路（`firefox:record` で解決済み。開発用の `npm run firefox` は残っている）

| 項目 | Chrome（CI 経路） | Firefox `npm run firefox:record`（`run-firefox.js`） | Firefox `npm run firefox` |
| --- | --- | --- | --- |
| サーバー | `npm run build` → `run-ci.js` が `lib/` を起動 | `node --import ../tools/node-ts/register.mjs ./server/main.ts` を直接 spawn する（ビルド不要） | 起動しない |
| ポート | 空きポート → `E2E_PORT` / `VITE_E2E_PORT` | 同じ | 未設定なら `8886` |
| ブラウザ | `ensure-browser.js`（Chromium のみ） | `ensureFirefox()` が `playwright install firefox` を実行する | 取得しない |
| 停止 | `stop.js` の `PUT /stop` | `/stop` → PID。vitest はプロセスグループの PID で止める | なし |
| 設定 | `vitest.config.mts` | `vitest.firefox.record.config.mts`（Firefox 設定 + `firefox-run-reporter.mjs`） | `vitest.firefox.config.mts` に `./tests` のパスフィルタ |

- サーバーの起動の欠如は、`firefox:record` で解消した。それでも全件失敗しているので、**失敗の主因はサーバーの起動ではない**。これは親チケットでの手動確認の結果とも一致する。
- `npm run firefox` は、サーバーが起動済みのときに使う開発用として残す。ただし `./tests` のフィルタは部分一致で `simulations/tests` も拾うので外す（3 章 Step 1）。

### 2.2 `vitest.firefox.config.mts` が Chrome 設定に追従していない（未解決）

`vitest.config.mts`（Chrome）と比べて、次のものが足りない。

- `// fileParallelism: false,` がコメントアウトのままである。全件の記録を見ると、ファイルが入り混じった順で開始されている（`iceTcp` → `simulcast` → `close` → `restart` → …）。つまり**ファイル並列で動いている**。テストは 1 台のブラウザと 1 つの e2e サーバー（gstreamer、TURN、UDP ソース）を共有するので、並列実行そのものが全件タイムアウトの有力な原因候補である（2.6）。
- `include` は `tests/**/*.test.ts` だけで、Chrome にある `tests/**/*.spec.ts` がない。`exclude`（`**/simulations/**`、`lib/**` など）もない。
- `firefoxUserPrefs` は `media.navigator.permission.disabled` と `media.navigator.streams.fake` だけである。Chrome の `--disable-features=WebRtcHideLocalIpsWithMdns` に当たる `media.peerconnection.ice.obfuscate_host_addresses: false` は未設定である。親チケットでは、これを足しても datachannel の結果は変わらなかった。必要かどうかは、直列化した後に判断する。
- `vitest.firefox.record.config.mts` は `mergeConfig(firefox, …)` で Firefox 設定を継承する。そのため、設定の修正は `vitest.firefox.config.mts` の側で行えば、record 経路にも反映される。

### 2.3 ブラウザの取得

- `PLAYWRIGHT_BROWSERS_PATH` の既定は、`browsers-path.js` が決める `e2e/node_modules/.cache/ms-playwright` である（前回の記載 `e2e/.playwright-browsers/` は誤りだったので訂正する）。
- Firefox の取得は `run-firefox.js` の `ensureFirefox()` が受け持つ。`ensure-browser.js`（Chromium 専用）は**変更しない**。前回の Step 1-4 にあった `hasPlaywrightFirefox()` の追加は不要になった。

### 2.4 シグナリング（トリクル）での確認点（未確認）

- 各テストの `pc.onicecandidate = ({ candidate }) => peer.request(..., { type: "candidate", payload: candidate })` は、end-of-candidates の `null` もそのまま送る。サーバー側は `addIceCandidate(payload)` で受ける。
  - Firefox は収集完了を、`candidate: ""`（空文字）の `RTCIceCandidate` と `null` の両方で通知する。
  - リクエストは `.catch(() => {})` で握りつぶしているので、失敗しても表に出ない。サーバー側の例外は `main.ts` の `console.log(error)` にしか出ない。
  - `firefox:record` のサーバーは `DEBUG` を付けずに起動する。調べるときは `DEBUG=werift* npm run firefox:record -- <file>` で、空文字の candidate がエラーにならないかを確かめる。エラーになる場合は、W3C の仕様では空文字の candidate は end-of-candidates として受け入れるべきなので、werift 本体の不具合として扱う。
- トリクルの candidate が offer / answer より先に届くと、`this.pc` が undefined のまま例外になる。Firefox で再現した場合は、まず既存の `tests/nativeCandidateQueue.ts` を流用できないか検討する。

### 2.5 既存のブラウザ判定とスキップ（タグ未付与）

`tests/fixture.ts` の `browserName`（Bowser。Firefox では `"Firefox"`）で、次のものを分岐またはスキップしている。

| ファイル | 現状 | 問題 |
| --- | --- | --- |
| `mediachannel/red.test.ts` L7 | `it.skip("skip", …)` | 理由もタグもない |
| `mediachannel/codecRtp.test.ts` L201 | `it.skip("skip firefox — Chrome-only codec RTP interop", …)` | タグがない |
| `mediachannel/reuse.test.ts` L28 | `describe` の中で `return` する | テストが 1 件もないので、記録で **moduleErrors `No test found in suite`** になり、Firefox の実行全体が失敗扱いになる。`it.skip` に置き換える |
| `mediachannel/removeTrack.test.ts` L36 / L102 | `if (browserName !== "Firefox") it(...)`。テストを定義しない | スキップとして記録に残らない。理由もない |

- `removeTrack` は親チケットで `compatible` / `aggressive` の 2 モードに分かれた（`2ab14b5e3` / `0f95417e8`）。スキップの文言も、モードごとに付ける。

### 2.6 実行記録から分かる失敗の内訳（`20261114T025126Z-8000795be-dirty.json`、44 件）

| 失敗メッセージ | 件数 | 主なテスト |
| --- | --- | --- |
| `Test timed out in 20000ms`（15s / 30s を含む） | 32 | datachannel / sendrecv / oneway / bundle/* / trickle / restart / turnRelay / iceTcp / iceLite / close / rtx / addTrack / allmedia / simulcast(offer) |
| `peer connection did not connect: failed` | 3 | `recordPlayback`（video / av）、`recordPlaybackOgg` |
| `request timeout`（protoo） | 3 | `removeTrack` の `offer_replace_second*` |
| `waitVideoPlay` / `waitFramesDecoded` のタイムアウト | 3 | `vp8Playback`（file / dummy）、`tagOnlyCandidates` |
| `expected 'v=0…mozilla…' not to contain 'a=ssrc-group:FID'` | 1 | `simulcast_rtx_answer`（Firefox の SDP 形式を前提にしていない。テストの前提の問題） |
| スキップ | 2 | `codecRtp`、`red` |

- 最も基本的な `datachannel > answer` まで一様にタイムアウトしている。`request timeout` や `peer connection … failed` も混ざっているので、まず並列実行（2.2）と、`peer.on("open")` / シグナリングの到達（2.4）を疑う。
- 単独ファイルの記録（`20261115T032934Z`、datachannel のみ）でも 3 件ともタイムアウトしている。したがって、並列化だけが原因ではない。単独ファイルで失敗する原因の特定を最優先にする（Step 2）。
- 全件の実行は idle 上限（5 分間テストイベントなし）で止まった。止まったのは `bundle_max_compat_answer` を開始した直後である。テストが `testTimeout` を超えて止まる事象が Firefox で起きている。`afterEach` での `pc.close()` 漏れや、`new Promise(async (done) => …)` の resolve 漏れがないかも確かめる。

## 3. 実装内容

### Step 1: 設定と開発用スクリプトを Chrome にそろえる（E2E 基盤）

1. `vitest.firefox.config.mts` を `vitest.config.mts` にそろえる。
   - `include`（`*.spec.ts` を含める）、`exclude`（`**/simulations/**`、`lib/**` など）
   - `fileParallelism: false`（コメントアウトを外す）、`retry: 1`、`testTimeout`
   - 共通部分は関数かオブジェクトに切り出し、両方の config から使う形を推奨する。ただし、`browser-paths.js` を `require` で読む方式は Vite のバンドルを避けるために必要なので壊さない。また `vitest.firefox.record.config.mts` の `mergeConfig` が引き続き動くようにする。
2. `package.json` の `firefox` スクリプトから `./tests` フィルタを外す（サーバー起動済みのときの開発用）。`firefox:record` と `firefox:record:prune` はそのまま使う。

### Step 2: 1 ファイルずつ再現し、原因を特定する

1. `cd e2e && DEBUG=werift* npm run firefox:record -- tests/datachannel/datachannel.test.ts -t answer` で、最小のケースだけを実行する。
2. 次の順に見て、どこで止まるかを特定する。
   1. `peer.on("open")` が発火するか。`fixture.ts` は `ws://localhost:<port>` に接続するが、サーバーの待ち受け確認は `127.0.0.1`（`waitForPort`）で行い、`e2eBaseUrl` も `127.0.0.1` を使っている。Firefox で `localhost` が `::1` に解決されて接続できない可能性があるので、`127.0.0.1` に統一するかを確かめる。
   2. サーバーのログに、`init` / `answer` / `candidate` のリクエストと、`exec` の例外が出ているか。
   3. Firefox の `iceConnectionState` / `connectionState` と、werift の `iceConnectionState`。
   4. 空文字・`null` の candidate の扱い（2.4）。
   5. mDNS の `.local` 候補（werift が解決できずに捨てていないか）。必要なら `firefoxUserPrefs` に `media.peerconnection.ice.obfuscate_host_addresses: false` を足す。
3. datachannel が通ったら、`mediachannel/sendrecv` → `bundle/*` → 残りの全件、の順に広げる。原因の切り分けのために `tests/` 外のログ用コードを足した場合は、完了前に外す。
4. 失敗するテストは、それぞれ次のどれかに分類し、5.3 の表に残す。

| 分類 | 対応 |
| --- | --- |
| E2E 基盤（設定、シグナリング、ハンドラ、テストの書き方） | 本チケットで直す |
| werift 本体: werift 起点の ICE restart | `ef1c086e` を参照し、`[firefox-known:ice-restart]` で Firefox だけスキップする |
| werift 本体: bundle-only に見える失敗 | D1 の手順で `tools/firefoxBundleOnly.ts` を使って切り分ける。直接接続で再現する場合だけ、新しいサブタスクを作ってスキップする |
| werift 本体: 新しい不具合（例: 空文字 candidate で例外） | `ticket create-subtask` で #269 の下にサブタスクを作り、`[firefox-known:<名前>]` でスキップする。数行で直せて negotiation の形を変えないもの（例: 空文字 candidate を end-of-candidates として受け入れる）に限り、本チケットで直してもよい。その場合は `packages/webrtc` のテストを足す |
| ブラウザ固有でテストの前提が成り立たない（pranswer 未実装、Chrome 専用の codec / RED、`a=ssrc-group:FID` などの SDP 形式） | `[firefox-unsupported:<機能>]` を付けて `browserName === "Firefox"` でスキップするか、Firefox の形式も受け入れるように期待値を直す |

### Step 3: テストの修正（必要なものだけ）

- `tests/fixture.ts` に、Firefox の判定とスキップ理由の定数（`firefoxKnownIssue.iceRestart`、`firefoxUnsupported.<機能>`）をまとめる。
- 既存のスキップを 2.5 の表のとおりに直す。とくに `reuse.test.ts` の `return` は、`it.skip` に置き換える（moduleErrors を消す）。
- 個別の確認点:
  - `ice/restart.test.ts`: `ice_restart_node_trigger` は `ef1c086e` に依存する。`ice_restart_web_trigger`（Firefox の restart offer は bundle-only を含む）は、21a27c92 の修正で通るはずなので、スキップせずに通す。
  - `bundle/tagOnlyCandidates.test.ts`: `bundleCandidates` の名前は `legacy` / `compatible` である（`65625a861`）。テスト名と期待値が揃っているか確かめる。
  - `mediachannel/simulcast.test.ts` の `simulcast_rtx_answer`: Firefox の offer に `a=ssrc-group:FID` が入ることを前提にしていない。Firefox の simulcast RTX の形式に合わせて期待値を分けるか、`[firefox-unsupported:*]` にするかを決める。
  - `removeTrack` / `addTrack` / `reuse`: Firefox 起点の再 offer で足す m-line は bundle-only になるが、21a27c92 で対応済みである。これを理由にスキップしない。
- 修正やスキップを足すときは、Arrange / Act / Assert の区切りと日本語コメントを AGENTS.md の規約どおりに付ける。

### Step 4: ドキュメント

1. `e2e/AGENTS.md` を新しく作る（root の section 順: Purpose, Scope, Do, Don't, Commands, Validation, Maintenance）。`e2e/` にはまだ AGENTS.md がない。書く内容は次のとおり。
   - Firefox の実行は `npm run firefox:record`、記録の扱いは `firefox-runs/README.md` を参照する
   - 開発用の手動手順: `E2E_PORT=<port> npm run server` → `VITE_E2E_PORT=<port> npm run firefox` → `node stop.js` または `PUT /stop`
   - スキップの方針（タグの形と分類表、`tests/fixture.ts` の定数）
   - 記録に載せるコマンドの一覧は `package.json` にあるものだけにする
2. ルート `README.md` の L32 / L183 の Firefox の記述を実態に合わせて直す。書く内容は、ローカルの記録付きランナーがあり CI 対象外であること、どこまで通るか。
3. ルート `AGENTS.md` の Commands / Validation には、すでに `firefox:record` が載っている。コマンドが変わった場合だけ最後に更新する。
4. サブタスク 2（`ef1c086e`）に、スキップを解除する手順（D2 の grep）を追記する。

## 4. 制約・注意点

- **Chrome E2E を壊さない**: `vitest.config.mts` と共通化するときは、Chrome の既定の挙動（`npm run e2e` / `npm run ci` / CI の `npx playwright install chromium`）を変えない。`run-ci.js`、`run-chrome-prod.js`、`ensure-browser.js` は原則として触らない。
- **CI に Firefox を入れない**（D3）。`nodejs.yml` は変更しない。
- **記録の仕組みを壊さない**: `run-firefox.js`、`firefox-run-record.js`、`firefox-run-reporter.mjs`、`firefox-runs-prune.js` を変えた場合は、`npm run test:tools`（`tools/tests/firefoxRunRecord.test.js`）を通し、`firefox-runs/README.md` も更新する。記録の JSON は手で編集しない。
- **werift の挙動を E2E のために変えない**: ハンドラ（`server/handler/*`）とテストの修正は、シグナリングの不具合（順序、null の扱い、例外の握りつぶし）を直す範囲に限る。`packages/webrtc/src` を変えるのは「本体の不具合」と分類したものだけにし、そのときは package テストを足し、`npm run type` / `npm run test:small` を通す。bundle 処理（21a27c92 の範囲）は変えない。ハンドラ側で SDP を書き換えて回避することもしない。
- `.catch(() => {})` による例外の握りつぶしは、原因の調査を難しくする。少なくとも調査中はログに出す。直すなら、テストが失敗として扱えるようにする（root AGENTS.md「broad catch-and-ignore を避ける」）。
- サーバーやブラウザは PID か `/stop` で止める。`npm run clean`（`pkill -9 gst-launch`）、`pkill -f`、`killall` は使わない。`firefox:record` を途中で止めるときは SIGINT を送る（記録は保存される）。
- 全件の実行は最大 60 分かかることがある（`FIREFOX_E2E_TIMEOUT_MIN`）。始める前に、リビジョン、未コミットの変更、目的を書いておく（root AGENTS.md Do 8）。
- 記録のファイル名に `-dirty` が付くと、そのコミットだけでは再現できない。完了の根拠にする記録は、**修正をコミットした後のクリーンな状態**で取る。
- Playwright の Firefox のバージョンは `e2e/package.json` の `playwright`（`^1.64.1`）で決まる。Firefox のために `playwright` を上げる場合は、Chrome にも影響するので、Chrome の E2E も回す。
- TypeScript は erasable syntax だけで書く（`enum` とパラメータプロパティは使わない）。`tsx` などのランナーは入れない。

## 5. 完了条件

### 5.1 動作

- [ ] `vitest.firefox.config.mts` が Chrome 設定と同じ `include` / `exclude` / `fileParallelism: false` / `retry: 1` になっている。`npm run firefox` に `./tests` フィルタがない。
- [ ] 修正をコミットした後のクリーンな HEAD で `cd e2e && npm run firefox:record` を全件実行し、次を満たす記録（`-dirty` なし、`vitestArgs: []`）がコミットされている。
  - `outcome: completed`、`runEnded: true`、`unfinished: []`、`moduleErrors: []`
  - `result: passed`（failed 0）
- [ ] Firefox で、`datachannel`（answer / offer / binary echo）、`mediachannel/sendrecv`、`bundle/*`（`max-bundle` / `max-compat` / `disable` の全件）、`ice/restart` の `ice_restart_web_trigger` が通る（スキップ不可）。
- [ ] スキップは `browserName === "Firefox"` の `it.skip` で行い、D2 の固定タグ（`[firefox-known:*]` + チケット ID の先頭 8 文字、または `[firefox-unsupported:*]`）が付いている。理由のないスキップや、テストを定義しないだけの分岐は残っていない。
- [ ] スキップ理由の定数が `tests/fixture.ts` に 1 か所でまとまっている。`ef1c086e` に解除の手順（grep するタグ）を追記している。
- [ ] 全件の記録を 2 回取り、同じ結果になっている（`retry: 1` の範囲で安定している）。2 回目の記録もコミットする。

### 5.2 回帰

- [ ] Chrome の E2E（`npm run e2e`）に回帰がない。
- [ ] `cd e2e && npm run type` と `npm run test:tools` が通る。
- [ ] `npm run format` を実行した。`packages/webrtc/src` を変えた場合は、`npm run type` と `npm run test:small` が通る。

### 5.3 ドキュメント

- [ ] `e2e/AGENTS.md` に、Firefox の実行手順（`firefox:record` と手動手順）とスキップの方針が書いてある。
- [ ] ルート `README.md` の Firefox の記述が実態に合っている。
- [ ] 本チケットに、テストごとの結果の表（テスト、Firefox の結果、分類、参照先）と、根拠にした記録のファイル名が書いてある。

| テスト | Firefox の結果 | 分類 | 参照 / 備考 |
| --- | --- | --- | --- |
| （作業時に記入） | | | |

## 6. 検証コマンド

- `cd e2e && npm run type && npm run test:tools`
- `cd e2e && npm run firefox:record -- tests/datachannel/datachannel.test.ts`（ファイル単位で再現）
- `cd e2e && npm run firefox:record`（Firefox の全件。記録をコミットする）
- `cd e2e && node --import ../tools/node-ts/register.mjs tools/firefoxBundleOnly.ts --scenario all`（bundle-only の切り分けが必要なときだけ）
- `npm run e2e`（Chrome。最後に全件）
- `npm run format`
- `packages/webrtc` を変えた場合: `npm run type`、`npm run test:small`
