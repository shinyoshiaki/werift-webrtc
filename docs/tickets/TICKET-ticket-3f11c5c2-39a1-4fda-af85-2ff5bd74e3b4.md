# 全ての examples を CI でテストする基盤づくりと examples ディレクトリの整理

全ての examples を CI でテストする新しい基盤を作り、実際にテストする。自動テストできないものは `examples/snippets/` 以下に移す。
あわせて examples のディレクトリ構造を整理する。役割が重複しているものや必要性の薄いものは、この機会に削除する。

---

## 詳細化（エージェント調査結果）

関連 GitHub Issue: タイトルにも説明にも Issue 番号や URL がないため特定できなかった。以下は 2026-10-27 時点の `develop` 相当（`f179b490`）のコードを調査してまとめた。

### 1. 目的と背景

#### 現状

- `examples/e2e` に vitest + Playwright の smoke harness が既にある（#689 で導入、`3ac7f4b4`）。CI（`.github/workflows/nodejs.yml` の `examples e2e` ステップ）では `npm run examples:e2e` として実行されている。
  - テスト対象は `examples/e2e/tests/helpers/catalog.ts` の約 60 エントリ（704 行）。`examples/AGENTS.md` のカタログ表と手作業で同期している。
- テストしない example は `examples/untested/` に集めている（34 ファイル）。外部サービス依存、手動 SDP、WIP、playground、重複などが混在しており、「テストできない」ものと「不要」なものの区別がない。
- 次の穴がある。
  1. **網羅性を保証する仕組みがない。** 新しい example を追加してカタログに載せ忘れても CI は通る。実際に、どこからも参照されていない entrypoint がある（`mediachannel/red/record/server.ts`、`save_to_disk/packetloss/vp8.ts`）。
  2. **examples の型検査が CI にない。** ルートの `tsconfig.json` は `examples` を include しているが、どのスクリプトもこれを使っていない。`npm run type` は workspaces の `type` だけを実行し、`examples` workspace には `type` スクリプトがない。`examples/e2e` の `type` も harness 自身しか検査しない。そのため `untested/` 以下は API が変わっても壊れたまま気づけない。
  3. **`examples/turn-loopback` の `chrome-e2e` が CI で動いていない。** ローカル完結（Docker 不要）の harness なのに、`nodejs.yml` から呼ばれていない。
  4. Node 単体で完結する example（`untested/datachannel/local.ts`、`untested/getStats/demo.ts` など）でも、ブラウザ前提のカタログに入れられないため `untested/` に置かれている。
  5. ドキュメントとの不整合がある。`packages/sctp/package.json` の `client` / `server` スクリプトが存在しない `examples/client.ts` / `examples/server.ts` を指している（実在するのは `ping.ts` / `pong.ts`）。これは範囲外だが、ついでに直せる候補として挙げておく。

#### 目的

- **`examples/` 以下の実行可能な example は、すべて CI で動作確認されている**状態にする。カタログへの載せ忘れは CI で検出する。
- 自動テストできないもの（外部サービス、認証情報、手動操作が必要なもの）は `examples/snippets/` に移し、少なくとも型検査だけは CI で守る。
- `untested/` は廃止する。重複している example や役目を終えた example は削除し、構造を単純にする。

### 2. 実装すべき変更内容

#### 2.1 テスト基盤の刷新（`examples/e2e`）

| # | 変更 | 内容 |
| --- | --- | --- |
| A | **網羅性ガード（inventory test）** | `examples/` 以下の entrypoint（`*.ts` / `*.tsx` / `*.html`）を走査し、どの entrypoint も「カタログの `node` / `html`」か「カタログが参照するクライアントの補助ファイル（`main.tsx`、`util.ts` など）」のどちらかに当たることを検証する。どちらでもない entrypoint があれば fail させる。除外は `snippets/`、`e2e/`、`turn-loopback/`（別 harness）、`node_modules` に限る。ブラウザを起動しない軽量テストにし、`examples:e2e` の最初に実行する。 |
| B | **Node 単体 example 用のケース** | `ExampleKind` に Node 単体で完結するもの（例: `node-exit`。spawn して `expectExit: 0` とログマーカーを検証する）を追加する。対象は `datachannel/local.ts`、`getStats/demo.ts`、`save_to_disk/dump.ts` などで、昇格させるもの（2.2 参照）をこれでテストする。gst を使う既存の `node-gst` とは分ける。 |
| C | **examples の型検査** | `examples/tsconfig.json`（または `examples/e2e` 側の別 project）を用意し、`snippets/` も含めて全 example を `tsc --noEmit` で検査する。`examples/package.json` に `type` を追加すると root の `npm run type`（workspaces）に入る。重い依存が入るのを避けたい場合は、`examples/e2e` の `type` から参照する形にする。どちらにするかは実装時に決める（推奨は前者。API の破壊的変更を `npm run type` の段階で検出できるため）。 |
| D | **turn-loopback を CI に組み込む** | `nodejs.yml` に `cd examples/turn-loopback && npm run chrome-e2e` を追加する。ポート競合を避けるため、`examples:e2e` とは直列に実行する。 |
| E | **カタログの扱い** | `catalog.ts` は 1 ファイル 700 行あるので、カテゴリ別（`catalog/datachannel.ts`、`catalog/mediachannel.ts` など）に分割する。`excluded` から `untested/` を消し、`snippets/` に置き換える。テスト本体（`tests/<category>/*.test.ts`）の Arrange / Act / Assert 構成と日本語コメントの規約は維持する。 |

> 「新しい基盤」はゼロからの作り直しではなく、既存 harness（spawn・Playwright・STUN fixture・vendor・gst/ffmpeg skip 制御）を土台にして、A〜D を足して網羅性を**仕組みで保証する**ことと解釈する。既存の helpers（`spawnExample.ts`、`openPage.ts`、`waitPeer.ts`、`stunFixture.ts`）は安定して動いているので、作り直すと回帰のリスクが高い。

#### 2.2 `examples/untested/` の分類と処理（推奨案）

| 現在のパス | 処理 | 理由 |
| --- | --- | --- |
| `datachannel/heroku-{offer,answer}.{ts,html}` | 削除 | Heroku シグナリング（`serene-anchorage-28732.herokuapp.com`）に依存しており、`datachannel/offer|answer` と役割も重複している |
| `ice/trickle/heroku-{offer.ts,answer.html}` | 削除 | 同上（`ice/trickle/*` と重複） |
| `mediachannel/sendrecv/heroku-{offer.ts,answer.html}` | 削除 | 同上（`mediachannel/sendrecv/*` と重複） |
| `mediachannel/rtx/simulcast_{answer.ts,offer.html}` | 削除 | テスト済みの `mediachannel/rtx/simulcast_offer.ts` と重複している |
| `mediachannel/wip_lipsync/*` | 削除 | WIP のまま完成していない |
| `playground/{signaling,test}/*` | 削除 | 実験用で、example としての役割がない |
| `save_to_disk/react-client/*` | 削除 | `save_to_disk/answer.html` の別クライアントにすぎず、重複している |
| `benchmark/datachannel.ts` | 削除。または root の `benchmark/` へ移動 | root の `benchmark/` に DataChannel のベンチ（`datachannel-*.ts`）が既にある。移すなら `benchmark/README.md` に追記する |
| `datachannel/local.ts` | **昇格** → `datachannel/local.ts`（`node-exit`） | Node 単体で完結し、テストできる |
| `getStats/demo.ts` | **昇格** → `getStats/demo.ts`（`node-exit`） | Node 単体で完結する。root README からリンクされている |
| `save_to_disk/dump.ts` | **昇格**（`node-exit`）。または削除 | `assets/rtp/vp8/dump_*.rtp` を読む Node 単体スクリプト。実行時の cwd 前提を確認してから決める |
| `interop/relay.ts` | 昇格を検討（`node-gst`）。難しければ snippets | UDP 5000 の RTP を中継する。gst を送信元にすればテストできる可能性がある |
| `datachannel/manual.{ts,html}` | snippets | 手動で SDP をコピー＆ペーストする |
| `ice/turn/trickle_{offer.ts,answer.html}` | snippets | 外部 TURN サーバーが必要。ローカル TURN fixture を用意すればテストできるが、本チケットでは見送る |
| `google-nest/server.ts` | snippets | Google API の認証情報（`credential.env`）が必要 |
| `ring/*` | snippets | Ring アカウントが必要 |
| `dash/*` | snippets | DASH 配信は検証の基準を作るのが難しい（`examples/AGENTS.md` でもカタログ除外と明記） |
| `mediachannel/red/adaptive/*` | snippets。または削除 | 実験的な adaptive RED。`mediachannel/red/*` と部分的に重複している |
| `save_to_disk/encrypt/eme.*` | snippets | EME はカタログ除外と明記されている |

- snippets では元のカテゴリ構造を保つ（例: `snippets/ring/`、`snippets/datachannel/manual.ts`）。各ディレクトリ、または `snippets/README.md` に「自動テストできない理由」と「手動での実行手順」を書く。
- 移動に伴い、相対 import（`../../../packages/webrtc/src` など）の深さを直す。直したことは型検査（2.1 C）で確認する。

#### 2.3 テスト済み examples の重複整理（推奨案。最終判断は実装時）

カタログに載っているものでも、役割が重複している example は削減する。判断基準は次のとおり。「API・機能の違いを示しているか」「別の example で同じことを確認できていないか」「README やドキュメントから参照されていないか」。

| 対象 | 推奨 |
| --- | --- |
| `save_to_disk/{vp8,vp9,h264,opus,av1x}.ts` | ほぼ同じ構造で、codec と出力パスだけが違う。代表（`vp8` と `opus`、必要なら `av1x`）を残して削除する。または codec を引数で切り替える 1 ファイルにまとめる |
| `save_to_disk/memo.txt`、`mediachannel/recvonly/memo.txt`、`mediachannel/sendonly/README.txt` | gst / ffmpeg のコマンドメモ。各ディレクトリの `README.md` にまとめるか削除する |
| `mediachannel/red/record/server.ts`、`save_to_disk/packetloss/vp8.ts` | カタログから参照されていない。テストを追加するか削除する（網羅性ガードで必ず検出される） |
| `mediachannel/simulcast/twcc.ts` | `mediachannel/twcc/*` と重複していないか確認する |
| `mediachannel/codec/*` と `save_to_disk/*` の codec 別ファイル | 送受信と録画という役割の違いを確認してから決める |

削除するものごとに `catalog.ts` のエントリと `examples/AGENTS.md` の表を同時に消す。

#### 2.4 ドキュメントと参照の更新

- `examples/AGENTS.md`: Scope の `untested/` の記述を `snippets/` に置き換える。カタログ表の更新、網羅性ガードの説明、snippets の追加ルール（理由の記載が必須）を加える。
- `examples/e2e/README.md`: スクリプトと構成の変更を反映する。
- `README.md`（root）: Examples 表の `examples/untested/getStats` と `examples/untested` の行を更新する（`getStats` の新パス、`snippets` の説明）。
- `.claude/webrtc-statics-api.md`: `examples/untested/getStats/demo.ts` への参照を更新する。
- `.vscode/launch.json`: 参照先が消える場合は直す（`examples/turn_turn.ts` は既に存在しない）。
- root `package.json` の `datachannel` / `debug` / `example` / `media` スクリプトが指すファイルを削除・移動するなら、合わせて直す。
- `examples/package.json` の依存: Heroku 系を削除すれば `socket.io-client` が不要になる可能性がある。snippets に残すもの（`ring-client-api`、`googleapis`、`xmlbuilder2`、`benchmark` など）とあわせて knip で棚卸しする。
- `changelog.md` の `## Unreleased` に examples の再編（移動・削除）を記録する。
- 生成 docs（`doc/_media/...`）は手で編集せず、`npm run doc` で再生成する。

### 3. 技術的な実装アプローチ（調査結果）

- **既存 harness の構成**
  - `tests/helpers/spawnExample.ts`: `node --experimental-transform-types --import tools/node-ts/register.mjs` で起動し、STUN redirect の preload を付ける。
  - `runExample.ts`: `withExample(entry, fn, ctx)` で起動・ページ表示・後始末をまとめて行う。
  - `openPage.ts`: 共有 Chromium を使う。fake media で動かし、polyfill は注入しない。
  - `serveClient.ts`: Babel / Vite のクライアントを配信する。
  - `waitPeer.ts`: 状態待ちのヘルパー。
  - `globalSetup.ts`: ローカル STUN fixture（`127.0.0.1:19302`）を立てる。
  - 実行は `fileParallelism: false`、`maxWorkers: 1`、`retry: 1`。多くのデモが 8888 / 8878 を bind するため直列で動かす。
- **網羅性ガードの実装案**
  - `tests/inventory/inventory.test.ts` で `fs.readdirSync` を再帰的に回し、entrypoint 候補を列挙する。
  - `catalog` の `node[]` と `html` に加えて、Vite クライアントのディレクトリ内の補助ファイル（`html` と同じディレクトリにある `main.tsx`、`util.ts`）を「カバー済み」とみなす。
  - root の `examples/util.ts` のような共有ユーティリティは、import されていればカバー済みとする。判定は「カバー済みファイルから import されている」とするのが確実。
  - 差分があれば fail させる。`snippets/` が空でないこと、各 snippet ディレクトリに理由が書かれていることも検証できる。
- **Node 単体 example**
  - 既存の `kind: "process-exit"` と `node-gst`（`client: "none"`）の実装を流用し、`binary` 不要の `node-exit` を追加する。
  - `getStats/demo.ts` や `local.ts` が終了するかどうかを確認する。終了しないなら `waitLog` でマーカーを待ってから停止する（`stopAfterOutput` 相当）。
- **型検査**
  - examples は `../../packages/webrtc/src` を相対 import している。そのため tsconfig は root の設定（`moduleResolution: bundler`、`jsx: react`、`DOM` lib）を踏襲する。
  - ブラウザ側の `.tsx`（Vite クライアント）と Node 側の `.ts` で lib や types が衝突する場合は、`tsconfig.node.json` と `tsconfig.client.json` に分ける。turn-loopback が同じやり方をしている。
- **CI**
  - `nodejs.yml` の `build` ジョブに、`examples` の type（2.1 C で workspace に入れれば `npm run ci` 内で実行される）と `turn-loopback chrome-e2e` を追加する。
  - gst / ffmpeg は既にインストールされている。`CI=true` のときは binary がなければ skip ではなく fail になる既存の挙動を維持する。

### 4. 制約・注意点

- **範囲**: 対象は root の `examples/` に限る。`packages/*/examples`（dtls / ice / rtp / sctp）はパッケージ層の開発用スクリプトで、一部は各パッケージのテストが使っている（`packages/dtls/tests/e2e/ice.test.ts`、`packages/rtp/tests/examples/ffmpegVfrStream.test.ts`）。そのため本チケットでは扱わず、別チケットに切り出す。「全ての examples」に含めるかどうかは着手前に確認する。
- `examples/AGENTS.md` の Don't を守る。
  - Chromium に werift polyfill を注入しない。
  - `examples/e2e/package.json` に `test` を追加しない（追加すると root の `test:small` に混ざる）。
  - root の `npm run e2e` や `test:small` に混ぜない。
  - Heroku / Ring / Nest / 手動 SDP / DASH / playground / EME をカタログに入れない。
- smoke テストは example 本体（Node の `.ts` と HTML）を起動すること。`/e2e` 側でデモを再実装しない。
- 外部ネットワークに依存しないこと。新たにテストする example も、公開 STUN（`stun.l.google.com:19302`。fixture にリダイレクトされる）を使うか、STUN なしにする。
- テスト用の都合で example の内容を不自然に変えない。ポートやパスを変える必要がある場合は、環境変数で上書きする（既存の `WERIFT_EXAMPLE_MEDIA_PATH` と同じ方式）。
- 移動や削除で、外部から参照されている URL が切れる。
  - GitHub Pages: `https://shinyoshiaki.github.io/werift-webrtc/examples/datachannel/answer` と `.../mediachannel/pubsub/answer`。README、`website/docs/api/index.md`、ja i18n から参照されている。
  - GitHub の `tree/master/examples`。
  - これらは移動しない。
- サーバーやブラウザを止めるときは、`pkill -f` / `killall` ではなく PID か runner の stop 経路を使う。
- active worktree で checkout / reset / stash をしない。比較が必要なら一時 worktree を使う。
- テストの追加・変更は Arrange / Act / Assert で書き、Act / Assert には日本語でコメントを付ける。共有の Arrange は `tests/helpers/` に置く。
- CI 時間が延びる（turn-loopback の追加と Node 単体ケースの追加）。延びた分の実測値を PR に書く。

### 5. 完了条件

- [ ] `examples/untested/` がなくなっている。旧 `untested/` の各ファイルは「昇格（テスト対象）」「`examples/snippets/` へ移動」「削除」のどれかに処理され、その一覧が PR に書かれている。
- [ ] `examples/snippets/` の各 example について、自動テストできない理由と手動での実行手順が README（または AGENTS.md の表）に書かれている。
- [ ] 網羅性ガードのテストがある。`snippets/` 以外にあってカタログに載っていない entrypoint があれば fail することを確かめている（一時的にダミーファイルを置いて fail を確認する）。
- [ ] Node 単体の example（少なくとも `datachannel/local.ts` と `getStats/demo.ts`）がカタログでテストされている。
- [ ] `snippets/` を含む全 example の型検査が CI で実行され、通っている。
- [ ] `examples/turn-loopback` の `chrome-e2e` が CI で実行されている。
- [ ] 重複していた example（2.3）を整理し、削除したものはカタログ、AGENTS.md の表、参照元から消えている。
- [ ] `README.md`、`examples/AGENTS.md`、`examples/e2e/README.md`、`.claude/webrtc-statics-api.md`、root `package.json` のスクリプト、`changelog.md`（Unreleased）が新しい構成と一致している。生成 docs は `npm run doc` で再生成している。
- [ ] 次のコマンドが成功している。
  - `cd examples/e2e && npm run type`
  - `npm run examples:e2e`（`CI=true` で gst / ffmpeg を含む）
  - `cd examples/turn-loopback && npm run chrome-e2e`
  - `npm run type`
  - `npm run format`（2 回目に差分が出ないこと）
