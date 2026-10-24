# dependencies / devDependencies の最新化と、common へ吸収できる依存の削減

## 1. 目的と背景

- workspace（`packages/*`、`examples/*`、`import-test`）と、それに付随する `e2e`、`examples/e2e`、`packages/ice-server/chrome-e2e` の依存を最新化し、それで壊れた箇所をすべて直す。
- 自前で簡単に置き換えられるランタイム依存は、`packages/common` に吸収するか Node 標準 API に置き換えて削除する。公開パッケージが持ち込む推移的依存を減らすためである。
- `packages/rtp`（`werift-rtp`）だけはブラウザでの動作を保証する。
- `packages/webrtc` は、他パッケージのソースを相対 import して `lib/` にまとめている。そのため、下位パッケージのランタイム依存は `packages/webrtc/package.json` にも同じものを書く。

## 2. 確定事項

### 2.1 マージ先とリリース（参考）

- PR の作成は、このチケットの完了条件に含めない。以下は、PR を出すときの参考情報。
- マージ先は `develop`。チケットブランチは `develop` に追従済み（2026-10-24 時点で遅れ 0 コミット）。
- 破壊的変更（2.2 / 2.3）を含むので、次のリリースはマイナー更新（0.26.0 相当）にする。`werift-dtls` / `werift-common` も次の公開時にマイナー版を上げる。
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

R1〜R6 はすべて実施済み。4 章は実装方針の記録として残す。

### 3.1 実施内容

- **依存の削除**: `debug`、`tweetnacl`、`@noble/curves`、`@fidm/x509`、`ts-node`、`ts-node-dev`、`tsx`、`organize-imports-cli`。DTLS は `node:crypto`（`localPrivateKey: KeyObject`）。
- **依存の更新**: `@peculiar/x509` 2.2 + `reflect-metadata`、`mediabunny` 1.62、TypeScript 6.0.3、Biome 2.6.2、Vitest 5.0.5、typedoc 0.28.20 / typedoc-plugin-markdown 4.14.1、knip 6、npm-run-all2 9、`@types/node` 22.20.x、`esbuild`（`packages/webrtc` に明示）。周辺の `package.json` / lockfile も更新済み。
- **R1**: `rtp` / `webrtc` の `"buffer": "^6.0.3"` と `import "buffer";` を維持。
- **R2**: `common/src/log.ts` は `node:util` もトップレベルの `process` 参照も持たない。`tests/browserLog.test.ts` で `process` なし・`localStorage.debug`・`localStorage` 例外を検証。
- **R3**: `packages/rtp/browser-e2e/`（Vitest browser + Playwright + `vite-plugin-node-polyfills`）。`setup/localStorageDebug.ts` で読み込み前に `localStorage.debug` を設定し、有効 / 無効 / `debug.enable()` を検証。`npm run test:browser --workspace packages/rtp` を CI に追加。`packages/rtp/vitest.config.mts` で Node 実行から `browser-e2e/**` を除外。
- **R4**: `tools/node-ts/register.mjs`（`.` / `..` 指定子にも対応）と `register.test.mjs`（`npm run test:node-ts`、CI に追加）。全スクリプト・`.vscode/launch.json`・コメント / ドキュメントを置換。`devEngines` 追加。
  - ネイティブ ESM 化で表面化した問題を修正: `import { Server } from "ws"` → `WebSocketServer`（examples 66 箇所）、`yargs` 18 の default import + `hideBin`、examples の `__dirname` → `import.meta.dirname`、`coverageProvider.ts` の istanbul 系を default import に変更（`tsc` の commonjs と Node ESM の両立）、`spawnExample.ts` の `existsSync` import 欠落。
  - `packages/rtp/tests` は Vitest 専用なので `__dirname` に戻した（`import.meta` は `module: commonjs` の `tsc` でエラーになる）。
  - `integration/werift-mediasoup-interop`（submodule）: `scripts/register-werift-ts.mjs` を追加し、`WERIFT_REPO_ROOT` → 親 checkout → sibling の順で werift の hook を読み込む。`test:*` を Node ネイティブ実行に置換、`tsx` を削除、README を更新。submodule を `63bc5d51` にコミットし、親の gitlink も更新した。submodule のブランチ `ticket/bf950660-37a3-49e8-b401-ff10ca1d62c2` は remote に push 済みで、fresh clone から gitlink のコミットを取得できることを確認した。
  - `import-test/test-cjs.cjs` を追加し、`import-test` の `npm test` で ESM（`test.mjs`）と CJS（`test-cjs.cjs`）の両方の import 経路を継続検証する。
- **examples の監査対応**: `npm audit fix`（`examples`）で推移依存を更新し、9 件（moderate 2 / high 7）から 3 件（high 3）に減らした。残りは `ring-client-api@14.3.0` が固定する `werift@0.22.4` → `ip@2.0.1` の既存 upstream 依存で、`ip` に修正版がなく、`npm audit fix --force` は `ring-client-api` を 9.13.0 へダウングレードするため適用しない。あわせて `@types/node` を他の manifest と同じ `^22.20.5` に揃え（lock は `22.20.5`）、`npm run doc` で `doc/_media/examples/` のミラーも再生成した。
- **R5**: changelog の `buffer` / `tsx` / `localStorage.debug` の記述を実態に合わせた。
- **追加の互換修正**: `@fidm/x509` はインデント付き PEM を受け付けていたが `node:crypto` は拒否する（`examples/certificate/offer.ts` が接続できなくなっていた）。`werift-dtls` に `normalizePem()` を追加し、`CipherContext.parseX509` と `RTCCertificate` で使用。テスト `packages/dtls/tests/context/cipher.test.ts` を追加。changelog の `### Fixes` に記載。
- **vendor の復元**: 過去の `fmt` コミット（ea7d720c）で `examples/e2e/vendor/*.js` が書き換わり、ブラウザページが `E is not a constructor` で動かなくなっていた。`develop` の内容に戻した（現在の Biome 設定では vendor は対象外）。vendor と生成 doc 内のコピーは `.gitattributes` で `-whitespace` に指定し、`git diff --check` の空白誤検出を避けた。
- **AGENTS.md**: ルートに `npm run test:node-ts` とサードパーティ TS ランナー禁止の方針を追記。

### 3.2 検証結果

| コマンド | 結果 |
| --- | --- |
| `npm run format`（2 回目で差分なし） | 成功 |
| `npm run type:all` / `npm run build` / `npm run test:small` | 成功 |
| `cd import-test && npm test` | 成功（ESM と CJS の両方。CJS は `test-cjs.cjs` で継続検証） |
| `npm run doc` | 成功（再生成済み。`doc/_media/examples/package.json` / `package-lock.json` のミラーも更新） |
| `npm run wpt` / `npm run wpt:coverage` | 成功 |
| `npm run e2e` | 21 files / 63 tests 成功 |
| `npm run examples:e2e` | 6 files / 65 tests 成功 |
| `packages/ice-server` の `chrome-e2e` | 成功（`test:small` 内で実行） |
| `npm run test:browser --workspace packages/rtp` | 3 tests 成功 |
| `npm run test:node-ts` | 4 tests 成功 |
| `examples/turn-loopback` の `server` | 起動ログを確認（20 秒で停止） |
| mediasoup-interop `type` / `test:small` / `test:source-import` | 成功 |
| mediasoup-interop `test:interop` | 27 件中 20 件成功。失敗 7 件はすべて `mediasoup-legacy`（3.19.2）で、このホスト（kernel 7）向けの prebuilt worker がなく、`pip` もないためビルドできない環境要因（`spawn ... mediasoup-worker ENOENT`）。`mediasoup` 3.26 のケースはすべて成功 |
| `git diff --check develop...HEAD` | 成功（vendor は属性で除外） |
| fresh clone + `git submodule update --init integration/werift-mediasoup-interop` | 成功（親 gitlink の `63bc5d51` をチェックアウト） |
| `npm audit --prefix examples --omit=dev` | 3 件（high 3）。`npm audit fix` で 9 件から 6 件を解消。残りは `ring-client-api@14.3.0` → `werift@0.22.4` → `ip@2.0.1` の既存 upstream 依存 |

- 環境メモ: ホスト共有の `~/.cache/ms-playwright` が別プロセスにより実行中に削除されるため、Playwright 系は `PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers` で実行した。
- 環境メモ: コンテナに ssh がないため、submodule の push は `gh` の HTTPS 認証で行った。fresh clone 検証では `git@github.com:` を `https://github.com/` に読み替えた。`third_party/wpt` は巨大なため fresh clone の対象から外した（gitlink は `develop` から変更なし）。
- `npm audit` の残りは今回の更新前から存在する upstream の推移的依存（`ring-client-api` が固定する公開済み `werift` の `ip`）で、`ip` 側に修正版がない。`--force` は `ring-client-api` の大幅なダウングレードになるため適用せず、ring-client-api 側の更新待ちとして記録する。

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
- [x] R1: `buffer` の依存と `import "buffer";` が `rtp` / `webrtc` に戻っている。
- [x] R2: `log.ts` が `node:util` を import しておらず、トップレベルで `process` を参照していない。ブラウザ相当の環境でのテストがある。
- [x] R3: `packages/rtp` の `test:browser` が Chromium で成功し、CI でも実行されている。
- [x] R4: `tools/node-ts/register.mjs` とそのテストがある。`devEngines` がある。`tsx` が全 `package.json` から削除されている。`git grep -nE "\btsx (watch|--)|ts-node|--import tsx|TSX_"` に、古い起動方法が残っていない（`changelog.md` の過去の節、`loadtest/`、`benchmark/` を除く）。`integration/werift-mediasoup-interop` の変更は commit `63bc5d51` に含まれ、親の gitlink に反映され、remote の `ticket/bf950660-37a3-49e8-b401-ff10ca1d62c2` ブランチから取得できる。
- [x] R5: changelog の `buffer` と `tsx` に関する記述が実態と一致している。
- [x] R6: 次がすべて成功する。
  - `npm run type`（`type:all`）、`npm run build`、`npm run test:small`
  - `npm run doc`（再生成した結果をコミットする）
  - `npm run wpt` / `npm run wpt:coverage`
  - `npm run e2e`、`npm run examples:e2e`、`packages/ice-server` の `chrome-e2e`、`examples/turn-loopback` の `server`
  - `cd import-test && npm test`（CJS / ESM の両方）
  - `npm run format` を実行して差分が出ない
  - 環境の都合で実行できないものがあれば、その旨と代わりに確認した内容をこのチケットに記録する。
