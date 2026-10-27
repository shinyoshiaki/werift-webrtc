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
  5. ドキュメントとの不整合がある。`packages/sctp/package.json` の `client` / `server` スクリプトが、存在しない `examples/client.ts` / `examples/server.ts` を指している（実在するのは `ping.ts` / `pong.ts`）。
  6. **`packages/*/examples`（dtls / ice / rtp / sctp、計 33 ファイル）は、ほとんどテストされていない。** テストから使われているのは次の 2 つだけ。
     - `packages/rtp/tests/examples/ffmpegVfrStream.test.ts`: `examples/node/pacer/ffmpeg-vfr-stream.ts` を spawn している。
     - `packages/dtls/tests/e2e/ice.test.ts`: `examples/transport/ice.ts` を import している。

     型検査も一部しか効いていない。`tsconfig.json` の `include` に入っているのは dtls の `examples` と rtp の `examples/node/pacer` だけで、ice / sctp の examples は型検査されていない。`packages/rtp/examples/browser/` は workspace 外の Parcel プロジェクトで、依存が `werift-rtp ^0.8.4` のまま放置されている（最後の実質的な変更は 2025-02 の "wip"）。

#### 目的

- **root の `examples/` と `packages/{dtls,ice,rtp,sctp}/examples/` の実行可能な example を、すべて CI で動作確認する。** カタログへの載せ忘れは CI で検出する（スコープの決定は 2.0）。
- 自動テストできないもの（外部サービス、認証情報、手動操作が必要なもの）は、それぞれの examples ルート直下の `snippets/` に移す（root は `examples/snippets/`、パッケージは `packages/<pkg>/examples/snippets/`）。snippets も少なくとも型検査だけは CI で守る。
- `untested/` は廃止する。重複している example や役目を終えた example は削除し、構造を単純にする。

### 2. 実装すべき変更内容

#### 2.0 スコープの確定: `packages/*/examples` も含める

**決定: タイトルの「全ての examples」には `packages/{dtls,ice,rtp,sctp}/examples` も含める。** ただしテストとファイルの配置はパッケージごとに閉じる。root の harness にパッケージの example を取り込むことはしない。

理由:

- タイトルが「全て」と明言している。パッケージの examples を外すと、型検査もテストもない example が 33 ファイル残り、目的（網羅性を仕組みで保証する）を満たせない。
- パッケージの examples は大半が Node 単体（UDP ペア、gst、self-test モード）で完結する。テストの書き方には rtp の `ffmpegVfrStream.test.ts` と `tests/utils.ts` の `runExample()` という前例があるので、作業量は見積もれる範囲に収まる（2.4 の分類で、テスト化するのは約 17 entrypoint）。
- root の `examples/AGENTS.md` には「`packages/*/examples` are out of scope for this harness」とある。この記述は **root harness（`examples/e2e`）の範囲**を述べたもので、パッケージの examples を CI テストから外すという意味ではない。そのため、root harness に混ぜずにパッケージ側でテストすれば両立する。

検討が必要だった 3 点の結論:

| 論点 | 結論 | 理由 |
| --- | --- | --- |
| **パッケージのテストが依存している entrypoint**<br>`packages/dtls/examples/transport/ice.ts`（`tests/e2e/ice.test.ts` が import）<br>`packages/rtp/examples/node/pacer/ffmpeg-vfr-stream.ts`（`tests/examples/ffmpegVfrStream.test.ts` が spawn） | **パスを変えずに残す。** どちらもテスト済みとして台帳（後述）に登録する。`transport/ice.ts` は entrypoint ではなく helper なので、「テストから import されている helper」として扱う。`dtls/examples/ice/{offer,answer}.ts` を削除しても、`transport/ice.ts` は `tests/e2e/ice.test.ts` が使い続けるので残す | 移動すると既存テスト、`packages/rtp/README.md`、`packages/rtp/tsconfig.json` の `include`、example 内のコメント（`Automated check:`）をまとめて書き換えることになり、得るものがない |
| **網羅性ガードの走査範囲** | **examples のルートごとに 1 つのガードを置く。** root の `examples/`（ガードは `examples/e2e`）と、`packages/{dtls,ice,rtp,sctp}/examples/`（ガードは各パッケージの `tests/examples/inventory.test.ts`）。共通する走査・照合のロジックは依存なしの `tools/examples-inventory/inventory.mjs` に 1 つだけ置き、両方から使う | root harness は `test:small` に混ぜられないが（AGENTS.md の Don't）、パッケージのテストは `npm test` → `test:small` → CI で必ず実行される。ガードをそれぞれのテスト経路に置けば、追加時の検出漏れがない。パッケージをまたぐ走査をしないので、パッケージの境界（AGENTS.md の「package-local」原則）も守れる |
| **snippets の配置先** | **パッケージごとに置く**（`packages/<pkg>/examples/snippets/`）。root の `examples/snippets/` には集めない | パッケージの examples は `../src` を相対 import するパッケージ内部のコードで、root に移すと import が `../../packages/<pkg>/src` に変わる。そうなるとパッケージの tsconfig の型検査から外れ、パッケージの境界も越える。「`examples/snippets` 以下」というタイトルの規約は、各 examples ルートからの相対パスとしてそのまま満たせる |

あわせて、パッケージ側の作業を root 側と同じ PR に入れるか分けるかを決める。**推奨は PR を 2 段階に分けること**（root 側を 1 本目、パッケージ側を 2 本目にし、どちらも本チケットの完了条件に含める）。共通ロジック（`tools/examples-inventory`）は 1 本目に入れる。

#### 2.1 テスト基盤の刷新（`examples/e2e`）

| # | 変更 | 内容 |
| --- | --- | --- |
| A | **網羅性ガード（inventory test）** | 走査と照合は `tools/examples-inventory/inventory.mjs` の共通ロジックを使う（2.0）。`examples/` 以下の entrypoint（`*.ts` / `*.tsx` / `*.html`）を走査し、どの entrypoint も「カタログの `node` / `html`」か「カタログが参照するクライアントの補助ファイル（`main.tsx`、`util.ts` など）」のどちらかに当たることを検証する。どちらでもない entrypoint があれば fail させる。除外は `snippets/`、`e2e/`、`turn-loopback/`（別 harness）、`node_modules` に限る。ブラウザを起動しない軽量テストにし、`examples:e2e` の最初に実行する。 |
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

#### 2.4 `packages/*/examples` の分類と処理（推奨案）

テストは各パッケージの `tests/examples/*.test.ts` に書き、パッケージの `npm test`（→ root の `test:small` → CI）で実行する。example を spawn する処理には、rtp の `tests/utils.ts` にある `runExample()` を使う。共有の Arrange は各パッケージの `tests/examples/utils.ts` に置き、パッケージ間で import しない。

| パッケージ / パス | 処理 | テスト方法 / 理由 |
| --- | --- | --- |
| dtls `examples/server.ts` + `client.ts` | **テスト** | server を起動して `start` を待ち、client を起動する。双方の `hello from server` / `hello from client` を待つ。UDP 4444 固定なので、同じポートを使うテストと並列に走らせない |
| dtls `examples/transport/ice.ts` | **そのまま残す**（helper） | `tests/e2e/ice.test.ts` から import されている。台帳には「テストが import する helper」として登録する |
| dtls `examples/ice/{offer,answer}.ts` | **削除** | readline による手動の candidate 交換と公開 STUN に依存している。ICE 上の DTLS は `tests/e2e/ice.test.ts` でカバー済みで、ice の `offer` / `answer` とも重複している |
| ice `examples/{offer,answer}.ts` | **snippets**（`packages/ice/examples/snippets/`） | readline による手動の candidate 交換。`Connection` 単体の使い方を示す唯一の手動デモなので残す。動作は `tests/example.test.ts` 相当でカバーされている |
| ice `examples/aioice.ts` | **snippets** | Python の aioice ピア（WebSocket シグナリング）が必要 |
| ice `examples/{turn,turn_turn,ice_turn}.ts` | **テスト** | `tests/utils.ts` の `createLocalTurnServer()`（`NodeTurnServer`、`port: 0`）を起動して試す。example は `127.0.0.1:3478` と `username` / `password` を固定で持っているので、環境変数で上書きできるようにする（例: `WERIFT_EXAMPLE_TURN_ADDRESS`。既定値は現状のまま）。`turn.ts` はアドレスが `127.0.0.1` 以外のときだけ `getGlobalIp()` を呼ぶので、ローカルなら外部ネットワークに出ない |
| rtp `examples/node/pacer/ffmpeg-vfr-stream.ts` | **そのまま残す**（テスト済み） | `tests/examples/ffmpegVfrStream.test.ts` |
| rtp `examples/node/rtp_over_udp/{recv,send}.ts` | **テスト** | `RUN_SELF_TEST=1` で codec ごと（pcmu / h265 / aac / vp8 / vp9 / av1 / opus）に実行し、exit 0 を確認する。`send.ts` は `recv.ts` と組み合わせ、ephemeral ポートでの往復も確認する |
| rtp `examples/node/record/{audio,video,video_enc,av,packetlost,packetlost_gst}.ts` | **テスト**（gst） | gst の `udpsink` から受けて録画し、10 秒前後で `stop` する。`stop` ログ、出力ファイルが空でないこと、`ffprobe` による検証を確認する。gst がなければローカルでは skip、`CI=true` では fail にする |
| rtp `examples/node/depaketize/gst.ts` | **テスト**（gst）。または削除 | 自分では終了しないので、depacketize のログを待ってから停止する。`record/*` と役割が重なるなら削除する |
| rtp `examples/node/record/video_enc_file.ts` | **削除** | `../../../webrtc/src` の `getUserMedia` を import していて、rtp パッケージの境界を越えている（rtp の tsconfig でも型検査されていない）。ファイル入力からの送出は、root の `mediachannel/sendonly/av.ts` でカバー済み |
| rtp `examples/browser/red/customEncoder/*` | **テスト**（`packages/rtp/browser-e2e`）。無理なら snippets | `RedEncoder` を独自の distance で使うブラウザ例。browser-e2e（vitest の browser mode、CI の `RTP browser smoke test`）に、example のロジックを読み込んで RED のエンコード・デコード結果を確かめるテストを足す。example を再実装せずに済む形（export された関数を呼ぶなど）が作れなければ snippets にする |
| rtp `examples/browser/red/encodedTransform/*` | **削除** | root の `save_to_disk/encodedTransform` と `mediachannel/red/*` と重複している |
| rtp `examples/browser/{package.json,tsconfig.json}` | **削除**（または browser-e2e に吸収） | workspace 外の Parcel プロジェクトで、`werift-rtp ^0.8.4` のまま放置されている |
| sctp `examples/ping.ts` + `pong.ts` | **テスト** | pong（UDP 5678 を bind）を起動してから ping を起動し、双方のメッセージのログを待つ |

- 型検査: `packages/{ice,sctp,rtp}/tsconfig.json` の `include` に `examples` を加え、snippets を含めて `npm run type` で検査する。rtp の browser example は DOM lib が要るので、`examples/browser` を node 側の include から外し、browser-e2e 側の tsconfig で検査する。
- 台帳: 各パッケージの `tests/examples/catalog.ts` に `{ path, coveredBy }`（`coveredBy` はテストファイル、または「helper として import」）を並べる。`inventory.test.ts` は、`snippets/` 以外のファイル集合と台帳が一致することを検証する。

#### 2.5 ドキュメントと参照の更新

- `examples/AGENTS.md`: Scope の `untested/` の記述を `snippets/` に置き換える。カタログ表の更新、網羅性ガードの説明、snippets の追加ルール（理由の記載が必須）を加える。
- `examples/e2e/README.md`: スクリプトと構成の変更を反映する。
- `README.md`（root）: Examples 表の `examples/untested/getStats` と `examples/untested` の行を更新する（`getStats` の新パス、`snippets` の説明）。
- `.claude/webrtc-statics-api.md`: `examples/untested/getStats/demo.ts` への参照を更新する。
- `.vscode/launch.json`: `packages/ice/examples/turn_turn.ts`、`examples/interop/{client,server}.ts` を参照している。移動・削除する場合は直す。
- パッケージ側:
  - `packages/sctp/package.json` の `client` / `server` を `examples/ping.ts` / `examples/pong.ts` に直す。
  - `packages/dtls/package.json` の `client` / `server` は現状のまま有効。
  - `packages/rtp/README.md`（`examples/node/rtp_over_udp/`、pacer への言及）と `packages/rtp/examples/node/rtp_over_udp/README.md` を新しいテスト手順に合わせる。
  - `packages/rtp/AGENTS.md` に examples のテスト規約（`tests/examples/`、台帳、snippets）を追記する。dtls / ice / sctp には AGENTS.md がないので、新設はしない。
- `examples/AGENTS.md` の Scope にある「`packages/*/examples` are out of scope for this harness」は残す。そのうえで「パッケージの examples は各パッケージの `tests/examples` でテストする」と書き足す。
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
- **共通の走査ロジック（`tools/examples-inventory/inventory.mjs`）**
  - 依存のない ESM にし、`listEntrypoints(root, { exclude })` と `diffCoverage(entrypoints, covered)` を提供する。
  - root の harness（TypeScript）からも、各パッケージの vitest からも import できる。`tools/node-ts` と同じく、`tools/` 直下に置く。
  - 除外の既定値は `snippets/`、`node_modules/`、`*.d.ts`。`*.md` / `*.json` / `*.txt` は entrypoint として扱わない。
- **パッケージの example テスト**
  - `packages/rtp/tests/utils.ts` の `runExample(relativePath, { env, timeoutMs })` が前例になる。cwd はパッケージルートで、`tools/node-ts/register.mjs` を通して spawn する。dtls / ice / sctp でも同じ形の helper を各パッケージの `tests/examples/utils.ts` に置く（パッケージ間で import しない）。
  - ペア型の example（dtls server/client、sctp ping/pong）は固定ポートを bind する。並列実行される他のテストと衝突しないよう、1 ファイルにまとめて `describe.sequential` にする。または環境変数でポートを上書きできるようにする。
  - gst / ffmpeg が必要なもの（rtp の record）は、root harness と同じ規則にする。ローカルで binary がなければ skip、`CI=true` なら fail。CI の build ジョブには gst / ffmpeg が既に入っている。
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

- **範囲**: root の `examples/` と `packages/{dtls,ice,rtp,sctp}/examples/` が対象（2.0 で確定）。`packages/webrtc` / `common` / `ice-server` には examples ディレクトリがないので対象外。`integration/` と `benchmark/`（root）も対象外。
- パッケージ側の作業はパッケージの境界を守る。
  - パッケージの example を root の harness や root の `examples/snippets/` に移さない。
  - テスト helper をパッケージ間で import しない。共有してよいのは依存なしの `tools/examples-inventory` だけ。
- パッケージの example テストは `test:small` で実行されるので、所要時間とローカル環境依存（gst）に気を付ける。1 ケースあたり録画待ちの 10 秒程度に抑える。binary がなければローカルでは skip する。
- `packages/dtls/examples/transport/ice.ts` と `packages/rtp/examples/node/pacer/ffmpeg-vfr-stream.ts` のパスは変えない（既存テストが参照している）。
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
- [ ] `packages/{dtls,ice,rtp,sctp}/examples/` の各ファイルが、2.4 に従って「テスト」「helper として残す」「`packages/<pkg>/examples/snippets/` へ移動」「削除」のどれかに処理されている。
- [ ] 各パッケージの `tests/examples/inventory.test.ts` がある。台帳にない example を置くと fail することを確かめている（root と同じく、ダミーファイルで確認する）。
- [ ] パッケージの examples（snippets を含む。rtp の browser example は browser-e2e 側）が、各パッケージの `npm run type` で型検査されている。
- [ ] `packages/sctp/package.json` の `client` / `server` が実在する example を指している。`packages/rtp/README.md` と `packages/rtp/AGENTS.md` が新しい構成と一致している。
- [ ] 次のコマンドが成功している。
  - `cd packages/{dtls,ice,rtp,sctp} && npm test`（`CI=true`、gst / ffmpeg あり）
  - `npm run test:browser --workspace packages/rtp`（customEncoder をテストに含めた場合）
  - `npm run test:small`
  - `cd examples/e2e && npm run type`
  - `npm run examples:e2e`（`CI=true` で gst / ffmpeg を含む）
  - `cd examples/turn-loopback && npm run chrome-e2e`
  - `npm run type`
  - `npm run format`（2 回目に差分が出ないこと）
