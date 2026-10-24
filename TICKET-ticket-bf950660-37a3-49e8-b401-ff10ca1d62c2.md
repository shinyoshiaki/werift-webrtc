# dependencies / devDependencies の最新化と、common へ吸収できる依存の削減

## 1. 目的と背景

- workspace（`packages/*`、`examples/*`、`import-test`）と、それに付随する `e2e`、`examples/e2e`、`packages/ice-server/chrome-e2e` の依存を最新化し、それで壊れた箇所をすべて直す。
- 自前で簡単に置き換えられるランタイム依存は、`packages/common` に吸収するか Node 標準 API に置き換えて削除する。公開パッケージが持ち込む推移的依存を減らすためである。
- `packages/rtp`（`werift-rtp`）だけはブラウザでの動作を保証する。
- `packages/webrtc` は、他パッケージのソースを相対 import して `lib/` にまとめている。そのため、下位パッケージのランタイム依存は `packages/webrtc/package.json` にも同じものを書く。

## 2. 確定事項

### 2.1 PR とリリース

- PR の base は `develop`。チケットブランチは `develop` に追従済み（2026-10-24 時点で遅れ 0 コミット）。
- 破壊的変更（2.2 / 2.3）を含むので、次のリリースはマイナー更新（0.26.0 相当）にする。このことを PR 本文に書く。`werift-dtls` / `werift-common` も次の公開時にマイナー版を上げる。
- changelog は `changelog.md` 先頭の `## Unreleased` に書く（公開済みの `## v0.25.2` には追記しない）。
- 重複する dependabot PR（#742、#769、#770、#779、#780、#781）は、この PR のマージ後に close する。

### 2.2 `CipherContext.localPrivateKey` の型は `KeyObject` に変える（破壊的変更）

- `@fidm/x509` の `PrivateKey` から Node 標準の `crypto.KeyObject` に変える。互換ラッパーは作らない。
  - 理由: 外部から使っている箇所がない。2 メソッドだけのラッパーでは、元の型の多くのメンバー（`keyRaw`、`toDER()` など）の互換性を保てない。
- 変えないもの: `RTCCertificate.publicKey` / `privateKey`（PEM 文字列）、`localCert`（DER の `Buffer`）、`parseX509()` のシグネチャ。
- changelog に移行方法を書く: `toPEM()` → `export({ type: "pkcs8", format: "pem" })`、`sign(data, hash)` → `createSign(hash).update(data).sign(key)`。

### 2.3 `debug` は common の自前実装に置き換える（サブセット互換）

- アプリ側の `debug` パッケージで `enable()` しても、werift のログは切り替わらなくなる。これを破壊的変更として受け入れる。代わりに werift が export する `debug.enable()` / `debug.disable()` を案内する。`DEBUG=werift*` 環境変数は従来どおり動く。

| 互換にするもの | 互換にしないもの |
| --- | --- |
| `debug(namespace)` と `log(...args)`、`DEBUG` のパターン（区切り、`*`、`-` による除外）、書式指定子、`debug.enable()` / `disable()` / `enabled()`、`logger.enabled` / `namespace`、Node での色付けと `DEBUG_COLORS` / `NO_COLOR`、ブラウザでの `localStorage.debug` | その他の `DEBUG_*` 環境変数、`extend()`、出力先の差し替え（`log`）、`formatters`、`destroy()`、`useColors`、`inspectOpts` |

- `common` は `rtp` 経由でブラウザでも読み込まれるため、次の条件を満たすこと。
  - `node:util` を import しない。
  - モジュールのトップレベルで `process` に直接触らない（`globalThis.process?.env?.DEBUG` のように存在を確認してから読む）。
  - 出力は、Node では `console.error`、ブラウザでは `console.debug` に任せる。書式指定子は `console` 自身が整形する。
  - `localStorage` へのアクセスは `try` / `catch` で囲む。

### 2.4 `packages/rtp` のブラウザ動作保証

- 保証する範囲: `werift-rtp` のメインエントリ（`common` の re-export を含む）を、Vite と `vite-plugin-node-polyfills` でバンドルしたときにブラウザで動くこと。
- 保証しない範囲: `werift-rtp/extra` と、Node 組み込みモジュールの polyfill なしでの動作。後者には `Buffer` の明示 import や `crypto` / `dgram` / `net` を使う部分の分離が必要なので、別チケットにする。
- `buffer` は残す。`packages/rtp` と `packages/webrtc` の `"buffer": "^6.0.3"`、および `packages/rtp/src/index.ts` の `import "buffer";` を維持する（ブラウザ向けのバンドラーが `Buffer` を補うのに使う）。
- 検証のため、ローカルの `packages/rtp/src` をブラウザで動かすテストを追加する。既存の `e2e/tests/mediachannel/red.test.ts` は npm に公開済みの `werift-rtp` を使っているので、ローカルの変更を検証できない。

### 2.5 TypeScript の直接実行は Node.js のネイティブ実行にする

- workspace 内（ルート、`packages/*`、`e2e`、`examples`、`examples/*`、`packages/ice-server/chrome-e2e`、`integration/werift-mediasoup-interop`）で `tsx` / `ts-node` / `ts-node-dev` を使っている箇所を、Node.js のネイティブ実行に置き換え、これらのパッケージを削除する。Vitest、`tsc`、`esbuild`、typedoc は対象外。`loadtest/` と `benchmark/` は workspace 外なので触らない。
- 方式: リポジトリ内に置く resolve hook と `--experimental-transform-types` を組み合わせる。
  - 理由: 相対 import 約 1,549 箇所に拡張子がない。また、標準の strip-only モードでは enum（公開 API にも含まれる）とパラメータプロパティを実行できない。
  - 事前検証で、hook とこのフラグを使えば `rtp` の読み込みと `wpt:list` が動くことを確認した。
- 開発環境に必要な Node は 22.18.0 以上（CI は 24.x）。ルートの `package.json` に `devEngines` を追加する。公開パッケージの `engines`（`>=22`）は変えない。

## 3. 現状（2026-10-24 時点の作業ツリー）

### 3.1 完了済み（コードで確認。テストは未実行）

- **依存の削除**: `debug`、`tweetnacl`、`@noble/curves`、`@fidm/x509` を削除した。DTLS は `node:crypto` に移行済み（`localPrivateKey: KeyObject`、`prf.test.ts` を追加）。`vi.mock("debug")` と `chrome-e2e/types/debug.d.ts` も削除した。
- **依存の更新**:
  - `@peculiar/x509` 2.2 と `reflect-metadata`（`dtls` / `webrtc`）
  - `mediabunny` 1.62
  - TypeScript 6.0.3
  - Biome 2.6.2（設定も移行済み）
  - Vitest 5.0.5（`vitest.workspace.mjs` は削除）
  - typedoc 0.28.20 / typedoc-plugin-markdown 4.14.1
  - knip 6
  - npm-run-all2 9
  - `@types/node` 22.20.x
  - `esbuild` を `packages/webrtc` に明示的に追加
  - `ts-node` / `ts-node-dev` / `organize-imports-cli` を削除
- **tsconfig**: `module: commonjs` と `moduleResolution: bundler` の組み合わせに移行した。
- **周辺の package.json**: `e2e`、`examples`、`examples/e2e`、`import-test`、`packages/ice-server/chrome-e2e` を更新した。
- **ドキュメント**: `changelog.md` に `## Unreleased` を追加し、README に `debug.enable()` を追記した。
- **掃除**: `packages/*/src` に残っていた古いビルド成果物（git 管理外の `.js` / `.d.ts`）は、もう残っていない。

### 3.2 残作業

| # | 内容 | 現状 |
| --- | --- | --- |
| R1 | `buffer` を元に戻す（2.4） | `rtp` / `webrtc` の依存と `import "buffer";` が削除されたまま |
| R2 | `common/src/log.ts` をブラウザでも動くようにする（2.3） | `node:util` を import しており、トップレベルで `process.env` / `process.stderr` を参照している |
| R3 | ローカルの `rtp` を検証するブラウザテストを追加する（2.4） | 未着手 |
| R4 | Node.js ネイティブ実行への移行（2.5） | 未着手。`tsx` がルート / `chrome-e2e` / `turn-loopback` などに残っている |
| R5 | changelog の修正 | `buffer` を削除したという記述と、`ts-node` → `tsx` の記述を、R1 / R4 の内容に合わせて直す |
| R6 | 全体の検証 | 6 章のコマンドをすべて実行する |

## 4. 残作業の実装方針

### R1. `buffer` を元に戻す

- `packages/rtp/package.json` と `packages/webrtc/package.json` に `"buffer": "^6.0.3"` を戻す。
- `packages/rtp/src/index.ts` の先頭に `import "buffer";` を戻す。

### R2. `log.ts` をブラウザでも動くようにする

- 環境の判定は `typeof process !== "undefined" && process.versions?.node` で行う。
- 設定の読み込み元: Node では `process.env.DEBUG`、ブラウザでは `localStorage.getItem("debug")`。
- 出力: Node では `console.error`。stderr が TTY のときは色付きの namespace と `+Nms`、そうでないときは ISO 時刻を付ける。ブラウザでは `console.debug` で、色は付けない。namespace の接頭辞は、第 1 引数が文字列ならその先頭に連結し、そうでなければ別の引数として先頭に入れる。
- テスト用の出力差し替え（`setDebugWriterForTest`）は残し、`@internal` にする。
- テストを追加する: `process` がない環境（`globalThis.process` をスタブ）で import しても例外にならないこと、`localStorage.debug` で有効化できること。

### R3. `rtp` のブラウザテスト

- `packages/ice-server/chrome-e2e` と同じ構成で `packages/rtp/browser-e2e/` を作る。独自の `package.json` に、`vitest` 5、`@vitest/browser-playwright`、`playwright`、`vite-plugin-node-polyfills` を入れる。
- `packages/rtp/package.json` に `test:browser` を追加し、CI（`.github/workflows/nodejs.yml`）でも実行する。
- スモークテストの内容:
  - `../src/index.ts` を import できる
  - RTP / RTCP / RED の serialize / deserialize
  - SRTP の暗号化と復号の往復
  - `debug()` が `localStorage.debug` の有無にかかわらず例外を投げず、有効時は `console.debug` に出力される

### R4. Node.js ネイティブ実行への移行

- **hook**: ルート直下に `tools/node-ts/register.mjs` を新設し、`module.registerHooks` の同期 `resolve` で `import` と `require` の両方を扱う。
  - 対象は、親が `.ts` 系のファイルで、`node_modules` の外を指す相対 / 絶対パスの指定子だけ。
  - 解決する順序: 拡張子なし → `X.ts`、`.js` / `.mjs` / `.cjs` → 同名の `.ts` / `.mts` / `.cts`、ディレクトリ → `X/index.ts`。`.js` と `.ts` が両方あるときは `.ts` を優先する。
  - `require` 経由の場合は、`file://` URL ではなくファイルパスで返す。
  - hook のテストを `node --test` で書く。
- **共通フラグ**: `node --experimental-transform-types --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import <相対パス>/tools/node-ts/register.mjs`。子プロセスに伝わらないよう、`NODE_OPTIONS` ではなく各スクリプトに直書きする。
- **置き換え方**:
  - `tsx [--tsconfig X] f` → `node <共通フラグ> f`
  - `tsx watch` → `node --watch <共通フラグ>`
  - `tsx --test` → `node --test <共通フラグ>`
  - `--import tsx` → `<共通フラグ>`
- **置き換える箇所**:
  - スクリプト:
    - ルート: `datachannel` / `debug` / `example` / `media`
    - `packages/webrtc`: `wpt*` / `pbt:deep`
    - `packages/dtls` / `packages/sctp`: `client` / `server`
    - `packages/ice`: `start`
    - `packages/ice-server/chrome-e2e`: `server`
    - `e2e`: `server` / `server:dev` / `test:tools`
    - `examples/turn-loopback`: `server`
    - `integration/werift-mediasoup-interop`: `test:*`（そのディレクトリの `AGENTS.md` に従う）
  - コード・設定:
    - `packages/rtp/tests/utils.ts`
    - `examples/e2e/tests/helpers/spawnExample.ts`
    - `examples/turn-loopback/docker/entrypoint.sh`（Docker イメージに hook が含まれるかも確認する）
    - `.vscode/launch.json`
  - 実行例を書いたコメントとドキュメント:
    - `packages/rtp/README.md`
    - `packages/rtp/examples/node/**`
    - `packages/rtp/tools/generateVectors/**`
    - `packages/rtp/tests/data/VECTOR_SOURCE.md`
    - `packages/sctp/tests/bench/burstTransfer.ts`
    - `packages/webrtc/tools/{negotiation-diff,wpt-runner}/*.ts`
    - `e2e/server/codecRtpUtils.ts`
- ESM として読み込まれるため、`__dirname` / `require` を使うファイル（`wpt-runner/coverageProvider.ts`、`negotiation-diff/{run,scenarios}.ts`、`pbt-deep/run.ts`、`turn-loopback/server/main.ts`）は、`import.meta.dirname` / `createRequire` に置き換える。
- 最後に `tsx` を全 `package.json` から削除し、ルートに `devEngines: { runtime: { name: "node", version: ">=22.18.0" } }` を追加する。

## 5. 制約・注意点

- 受け入れる破壊的変更は 2.2 と 2.3 だけ。それ以外の公開 API は変えない。
- `packages/rtp/src` と `packages/common/src` には、Node 専用の新しい API（`node:util`、トップレベルでの `process` 参照など）を持ち込まない。
- 依存を増減するときは、下位パッケージと `packages/webrtc/package.json` を同時に直す。
- 型エラーやテスト失敗を、`any`、`ignoreDeprecations`、テストの skip で黙らせない。
- テストは Arrange / Act / Assert の 3 フェーズで書く。Arrange は共通ユーティリティにまとめ、Act / Assert には日本語コメントを付ける。
- `doc/` と `packages/*/doc` は手で編集せず、`npm run doc` で再生成する。
- スクリプトを変えたら、関係する `AGENTS.md` も更新する（`packages/rtp` の `test:browser` など）。
- 対象外: `website/`、`loadtest/`、`benchmark/`、`third_party/`。

## 6. 完了条件

- [x] `debug`、`tweetnacl`、`@noble/curves`、`@fidm/x509`、`ts-node`、`ts-node-dev`、`organize-imports-cli` が依存から削除されている。
- [x] `CipherContext.localPrivateKey` が `KeyObject` になり、DTLS の鍵交換・署名が `node:crypto` で動く。
- [x] 3.1 の依存更新が反映され、changelog に `## Unreleased` がある。
- [ ] R1: `buffer` の依存と `import "buffer";` が `rtp` / `webrtc` に戻っている。
- [ ] R2: `log.ts` が `node:util` を import しておらず、トップレベルで `process` を参照していない。ブラウザ相当の環境でのテストがある。
- [ ] R3: `packages/rtp` の `test:browser` が Chromium で成功し、CI でも実行されている。
- [ ] R4: `tools/node-ts/register.mjs` とそのテストがある。`devEngines` がある。`tsx` が全 `package.json` から削除されている。`git grep -nE "\btsx (watch|--)|ts-node|--import tsx|TSX_"` に、古い起動方法が残っていない（`changelog.md` の過去の節、`loadtest/`、`benchmark/` を除く）。
- [ ] R5: changelog の `buffer` と `tsx` に関する記述が実態と一致している。
- [ ] R6: 次がすべて成功する。
  - `npm run type`（`type:all`）、`npm run build`、`npm run test:small`
  - `npm run doc`（再生成した結果をコミットする）
  - `npm run wpt` / `npm run wpt:coverage`
  - `npm run e2e`、`npm run examples:e2e`、`packages/ice-server` の `chrome-e2e`、`examples/turn-loopback` の `server`
  - `cd import-test && npm test`（CJS / ESM の両方）
  - `npm run format` を実行して差分が出ない
  - 環境の都合で実行できないものがあれば、その旨と代わりに確認した内容を PR に書く。
- [ ] PR の base が `develop` で、PR 本文にマイナー更新が必要なことと、close する dependabot PR を書いている。
