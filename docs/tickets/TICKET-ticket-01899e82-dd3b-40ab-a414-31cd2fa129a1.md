# Node 26 で `--experimental-transform-types` が廃止されたことへの対応

## 元の description

（詳細なし）タイトル: Node 26 では --experimental-transform-types が廃止されているのでプロジェクトでどうすべきか対応を検討して対応する

## 1. 目的と背景

- Node.js 26.0.0 で `--experimental-transform-types` が削除された（nodejs/node#61803）。代わりの機能はなく、今後提供される予定もない。Node が標準で実行できるのは、型注釈を消すだけで済む構文（erasable syntax）だけになった。この型の除去（type stripping）は v24.12.0 / v25.2.0 で stable になっている。
- werift は前回の依存更新チケット（`TICKET-ticket-bf950660-…` の 2.5）で `tsx` などをやめ、「`--experimental-transform-types` + `tools/node-ts/register.mjs`（拡張子なし import 用の resolve hook）」で TypeScript を直接実行する方式に移った。この方式を選んだ理由は、strip-only モードでは enum とパラメータプロパティを実行できないことだった。
- その結果、Node 26 では repo 内の TypeScript 直接実行（examples、e2e サーバー、WPT runner、各種ツール、VS Code のデバッグ構成）がすべて起動できない。偶数系の Node 26 は、リリーススケジュール上 2026-10 に LTS になる系列なので、「Node 26 を使わない」という回避策は長くは続けられない。
- 公開パッケージ（`lib/` のビルド済み JS）は `tsc` / `esbuild` でビルドするため、利用者側には影響しない。影響するのは repo 内の開発・テスト・ツールの実行経路だけである。

## 2. 調査結果（2026-11-04、基準リビジョン `ab3ee42eb`、ローカルの Node 26.5.0 / 24.18.0 で確認）

### 2.1 Node 26 の挙動

| 確認内容 | 結果 |
| --- | --- |
| `node --experimental-transform-types x.ts` | `bad option` で exit 9（起動前に失敗） |
| `NODE_OPTIONS=--experimental-transform-types` | `is not allowed in NODE_OPTIONS` で exit 9 |
| フラグなしで enum を含むファイルを実行 | `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript enum is not supported in strip-only mode` |
| `module.stripTypeScriptTypes(code, { mode: "transform" })` | `ERR_INVALID_ARG_VALUE`（指定できるのは `'strip'` だけ。API 側の transform も削除されている） |
| `--experimental-strip-types` | 受け付けられる（何もしない）。型の除去は既定で有効 |
| フラグを外して `npm run test:node-ts` 相当を実行 | 成功（`register.test.mjs` は JS で書かれているため） |
| フラグを外して `wpt:list` を実行 | `packages/webrtc/src/dataChannel.ts:48` で `TypeScript parameter property is not supported in strip-only mode` |

### 2.2 strip-only では実行できない構文

各パッケージで `tsc --noEmit -p tsconfig.json --erasableSyntaxOnly`（TS 6.0.3）を実行し、TS1294 エラーを重複を除いて数えた。

| 範囲 | パラメータプロパティ | enum | ファイル数 |
| --- | --- | --- | --- |
| `packages/common/src` | 9 | 0 | 3 |
| `packages/ice/src` | 33 | 1 | 6 |
| `packages/ice-server/src` | 6 | 2 | 3 |
| `packages/dtls/src` (+examples 1) | 67 (+1) | 3 | 26 (+1) |
| `packages/rtp/src` (+examples 1) | 53 (+1) | 3 | 30 (+1) |
| `packages/sctp/src` (+tests 2) | 21 (+2) | 2 | 5 (+2) |
| `packages/webrtc/src` (+tests 3) | 92 (+3) | 0 | 24 (+2) |
| `e2e/server`（grep による概数） | 約 8 | 0 | 約 6 |

- 合計で約 300 箇所。パラメータプロパティを使うクラスは約 132 個。`namespace` / `module` / `import x = require()` / デコレーターは 0 件。
- enum 11 個の一覧:
  - `ice`: `CandidatePairState`
  - `ice-server`: `classes`、`methods`
  - `dtls`: `ContentType`、`AlertDesc`、`HandshakeType`
  - `rtp`: `PacketChunk`、`PacketStatus`、`H264NaluType`
  - `sctp`: `WEBRTC_PPID`、`SCTP_STATE`
- 公開 API に含まれる enum（typedoc の `enumerations/` に出ているもの）:
  - `werift`: `CandidatePairState`、`classes`、`methods`、`PacketChunk`、`PacketStatus`
  - `werift-ice`: `CandidatePairState`、`classes`、`methods`
  - `werift-rtp`: `PacketChunk`、`PacketStatus`
  - `werift-ice-server`: `classes`、`methods`（`src/index.ts` から `export *`）
  - `werift-sctp`: `SCTP_STATE`、`WEBRTC_PPID`
- 逆引き（`Enum[value]`）を使っているのは `packages/dtls/src/record/receive.ts:89,97` の `AlertDesc[...]` だけ。`Object.keys/values(Enum)` の使用や、enum メンバーを型として使う箇所は見つからなかった（いずれも値として使われている）。
- 全 tsconfig が `useDefineForClassFields: true`。パラメータプロパティを使うクラスで、フィールド初期化子がパラメータプロパティを即時に読む箇所は 0 件だった（TypeScript API で走査）。`this.` を含む初期化子は 11 件あるが、どれもパラメータプロパティより前に宣言されたフィールドを参照しているだけなので、書き換えても順序の問題は起きない。

### 2.3 フラグを使っている箇所（生成ドキュメント・changelog・サブモジュールを除いて 73 箇所）

- npm scripts:
  - ルート `package.json`: `datachannel`、`debug`、`example`、`media`、`test:node-ts`
  - `packages/dtls`: `client`、`server`
  - `packages/ice`: `start`
  - `packages/sctp`: `client`、`server`
  - `packages/webrtc`: `pbt:deep`、`wpt:list`、`wpt`、`wpt:coverage`
  - `e2e`: `server`、`server:dev`、`test:tools`
  - `examples/turn-loopback`: `server`
  - `packages/ice-server/chrome-e2e`: `server`
- 子プロセスを起動するときの引数:
  - `packages/webrtc/tools/wpt-runner/runner.ts:356`
  - `packages/webrtc/tools/wpt-runner/coverage.ts:34`
  - `packages/rtp/tests/utils.ts:841`
  - `examples/e2e/tests/helpers/spawnExample.ts:148`
- シェルスクリプト・IDE 設定: `examples/turn-loopback/docker/entrypoint.sh:329`、`.vscode/launch.json`（5 構成）
- ドキュメント・使い方のコメント:
  - ルート `AGENTS.md:31`（Don't 節）
  - `packages/rtp/README.md`、`packages/rtp/examples/node/rtp_over_udp/{README.md,recv.ts,send.ts}`、`packages/rtp/examples/node/pacer/ffmpeg-vfr-stream.ts`
  - `packages/rtp/tools/generateVectors/*`、`packages/rtp/tests/data/VECTOR_SOURCE.md`
  - `packages/webrtc/tools/negotiation-diff/{compare,run,scenarios}.ts`、`packages/sctp/tests/bench/burstTransfer.ts`
- 生成物: `doc/_media/**`、`packages/rtp/doc/README.md`（`npm run doc` で再生成する）
- サブモジュール `integration/werift-mediasoup-interop`（別リポジトリ）: `package.json` の `test:*` 4 本と README（計 5 箇所）
- CI（`.github/workflows/nodejs.yml`）は Node `24.x` だけで、Node 26 のジョブはない。

### 2.4 代わりのローダー（amaro）の実現性

- npm の `amaro@1.3.0`（Node 公式の SWC ラッパー。Node 26 には 1.1.10 が同梱）は `amaro/transform` というローダーを提供している。
- これをそのまま `--import` で読み込んでも、`register.mjs` の resolve が `format` を返さずに `shortCircuit` するため、amaro の load hook が `context.format` で TypeScript を判定できず、何もせずに素通しする。結果として失敗する。
- `.ts` の場合に `format: "module-typescript"` を補う hook を間に挟むと、Node 26 でも `wpt:list` が成功した。案 B は技術的には可能である。

## 3. 対応方針（推奨: 案 A）

| 案 | 内容 | 長所 | 短所 |
| --- | --- | --- | --- |
| **A（推奨）** | ソースを erasable syntax だけにし、フラグを全廃する | 追加の依存がない。変換コストがなく、行番号がそのまま保たれる（source map 不要、WPT coverage の行対応もそのまま）。Node 22.18+ / 24 / 26 で同じように動く。TS の `erasableSyntaxOnly` という Node と TS 両方の方向性に合う | 約 300 箇所の機械的な書き換えが必要。公開 enum の互換性が一部崩れる（4.2） |
| B | `amaro/transform` ローダーを devDependency に追加し、フラグの代わりに `--import` する | ソースの変更がほぼ不要 | 外部の TS 変換器への依存が戻る（`AGENTS.md` の「third-party runner を再導入しない」方針に反する）。`--enable-source-maps` が必須で、WPT coverage の再検証も必要。`register.mjs` にも `format` を補う修正が要る |
| C | 事前にビルドした `lib/` を実行する | Node の TypeScript 対応に依存しない | examples / WPT / e2e の開発フローが大きく変わり、ソースを直接実行する利点がなくなる |
| D | `devEngines` で `<26` に固定する | 変更が最小 | Node 26 が LTS になるため一時しのぎにしかならない |

- 案 A で進める。案 B は、作業途中で Node 26 での実行がすぐに必要になった場合の一時的な逃げ道としてだけ記録しておき、採用しない。
- 公開パッケージの `engines`（`>=22`）と `devEngines`（`>=22.18.0`）は変えない（22.18 以降は型の除去が既定で有効なため）。

## 4. 実装内容

### 4.1 パラメータプロパティを明示的なフィールドにする（約 132 クラス）

- 書き換えの形: `constructor(private readonly a: A, public port = 5000) {}` を、`private readonly a: A; port: number;` の宣言と、コンストラクタ内の `this.a = a; this.port = port;` に分ける。
- 守ること:
  - 可視性・`readonly`・JSDoc・既定値・省略可能（`?`）をそのまま残す。
  - 派生クラスでは、代入を `super(...)` の直後に置く。
  - 基底クラスのコンストラクタが設定するプロパティをサブクラスで宣言し直す場合は、`declare` を付ける。`useDefineForClassFields` があると `undefined` で上書きされてしまうため。
  - 代入はコンストラクタ本体の先頭に置き、既存の処理より前に済ませる（パラメータプロパティの評価順と同じにするため）。
- 対象: `packages/*/src`、`packages/*/tests`、`packages/*/examples`、`e2e/server`。

### 4.2 enum を `as const` オブジェクトと同名の型にする（11 個）

```ts
export const CandidatePairState = {
  FROZEN: 0,
  WAITING: 1,
  IN_PROGRESS: 2,
  SUCCEEDED: 3,
  FAILED: 4,
} as const;
export type CandidatePairState =
  (typeof CandidatePairState)[keyof typeof CandidatePairState];
```

- 互換が保たれるもの: 値としての参照（`CandidatePairState.FROZEN`）、型注釈（`state: CandidatePairState`）、値そのもの。
- 互換が崩れるもの:
  - 逆引き（`CandidatePairState[0]`）
  - enum メンバーを型として書くこと（`x: CandidatePairState.FROZEN` は `typeof CandidatePairState.FROZEN` にする必要がある）
  - `Object.keys/values` の結果（数値 enum の逆引きキーがなくなる）
  - 公開 enum が typedoc の `enumerations/` から `variables/` と `type-aliases/` に移ること
- `AlertDesc` は逆引きを使っているので、名前を引く手段（逆引きの map か、関数）を用意して `receive.ts` を置き換える。
- 公開 enum の変更は破壊的変更として扱う。`changelog.md` の `## Unreleased` に、移行方法（逆引きの代わり、型として書く場合の書き方）を書く。

### 4.3 再発防止

- `"erasableSyntaxOnly": true` を追加する対象:
  - `packages/*/tsconfig.json`（`tsconfig.production.json` は `extends` で引き継ぐ）
  - `e2e/tsconfig*.json`、`examples/e2e/tsconfig.json`、`packages/ice-server/chrome-e2e/tsconfig*.json`
- これにより `npm run type` / `type:all` で違反を検出できる。
- 任意: Biome の `style/noEnum` と `style/noParameterProperties` を有効にする。
- `tools/` 配下（wpt-runner、pbt-deep、negotiation-diff、generateVectors）は tsconfig の `include` に入っていない。現時点で違反は 0 件だが、`include` に加えるかどうかを実装時に判断する。

### 4.4 フラグを外す

- 2.3 に挙げた scripts、子プロセスの起動引数、シェルスクリプト、`.vscode/launch.json`、コメントから `--experimental-transform-types` を削除する。
- `--disable-warning=ExperimentalWarning` と `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON` は残す。Node 22.18〜24.11 では、型の除去自体がまだ ExperimentalWarning を出すため。
- `tools/node-ts/register.mjs` は変更しない（resolve hook はこれまでどおり必要）。

### 4.5 ドキュメントと CI

- ルートの `AGENTS.md:31` を「`node --import <rel>/tools/node-ts/register.mjs`（strip-only、erasable syntax のみ）」に改める。必要であれば、各パッケージの `AGENTS.md` や README の実行例も合わせる。
- `changelog.md` の `## Unreleased` に次を書く: フラグの廃止、Node 26 対応、公開 enum から const オブジェクトへの移行（Breaking）。
- `npm run doc` で typedoc（`doc/`、`packages/*/doc`）を再生成する。
- `.github/workflows/nodejs.yml` の matrix に `26.x` を追加する。全ジョブで重い場合は、少なくとも `type` / `test:small` / `test:node-ts` / `wpt:list` を 26.x で実行する。

### 4.6 サブモジュール `integration/werift-mediasoup-interop`

- 別リポジトリなので、そちらの `AGENTS.md` に従い、別 PR でフラグを外してから submodule のポインタを更新する。
- `WERIFT_REPO_ROOT` で古い werift のチェックアウト（enum を含む）を指したときの扱い（Node 24 なら従来のフラグで動く）を、README に書いておく。

## 5. 制約・注意点

- 書き換えは振る舞いを変えないリファクタリングに限る。`lib/` の出力 JS や `.d.ts` は変わるが、実行時の値は変わらないこと。
- `useDefineForClassFields: true` の下では、宣言の位置によってプロパティの定義順（`JSON.stringify` や `util.inspect` の出力順）が変わることがある。順序に依存するテストやシリアライズがないか確認する。
- import の扱いは strip-only でも transform でも同じで、型だけの import は `import type` で書かれている必要がある。現状は transform モードで動いているので新たな問題は起きないはずだが、Node 26 で全エントリポイントを実際に起動し、`does not provide an export named` が出ないことを確かめる。
- upstream WPT 向けの厳密な挙動は、引き続き `packages/webrtc/tools/wpt-runner/*` の中だけに置く（今回のタスクでは触らない）。
- テストを追加・変更する場合は、Arrange / Act / Assert の形で書き、Act / Assert に日本語のコメントを付ける（例: `AlertDesc` の名前の引き方、公開 const の値が変わっていないこと）。
- Vitest、`tsc`、`esbuild`、typedoc は自前で変換するので、今回のフラグ廃止の影響は受けない。
- 長時間の検証（`wpt`、`e2e`、`examples:e2e`）を始める前に、リビジョン、未コミットの変更、意図を記録する（`AGENTS.md` の Do 8）。
- 対象外: npm scripts の長いコマンドを共通ラッパーにまとめること（必要なら別チケットにする）、`loadtest/` と `benchmark/`（workspace の外）。

## 6. 完了条件

- [ ] `grep -rn "experimental-transform-types"` の結果が、`changelog.md` の過去の記述と `third_party/` を除いて 0 件になる（生成ドキュメントも再生成済み）。
- [ ] `packages/*` / `e2e` / `examples/e2e` / `chrome-e2e` の tsconfig に `erasableSyntaxOnly: true` が入り、`npm run type` と `npm run type:all` が通る。
- [ ] Node 26.x で次がすべて通る: `npm run test:node-ts`、`npm run test:small`、`npm run wpt:list`、`npm run wpt`、`npm run wpt:coverage`、`npm run e2e`、`npm run examples:e2e`。
- [ ] Node 24.x（CI の既定）でも同じコマンドが通る。Node 22.18+ で少なくとも `test:node-ts` と `wpt:list` が通る。
- [ ] 公開 const（旧 enum）の値と型注釈での使い方が変わっていない。`AlertDesc` の名前の引き方を置き換え、テストで確認している。
- [ ] `.github/workflows/nodejs.yml` に Node 26.x のジョブがある。
- [ ] ルートの `AGENTS.md`、README、`changelog.md`（Breaking と移行方法を含む）、typedoc を更新している。
- [ ] `npm run format` を実行済み。
- [ ] サブモジュール `werift-mediasoup-interop` 側の対応について、PR を出すか、別チケットにするかが決まり、記録されている。

## 参考

- [Node.js v26.0.0 release](https://nodejs.org/ja/blog/release/v26.0.0)
- [Node.js Modules: TypeScript（v26 の changelog に `--experimental-transform-types` の削除、#61803）](https://nodejs.org/api/typescript.md)
- [nodejs/help#5153（v26 でフラグがなくなった件）](https://github.com/nodejs/help/issues/5153)
- [nodejs/learn#87（ガイドからフラグの記述を削除）](https://github.com/nodejs/learn/pull/87)
- [nodejs/amaro（`amaro/transform` ローダー）](https://github.com/nodejs/amaro)
