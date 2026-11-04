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
- 公開 API に含まれる enum は 8 個:
  - `werift`: `CandidatePairState`、`classes`、`methods`、`PacketChunk`、`PacketStatus`
  - `werift-ice`: `CandidatePairState`、`classes`、`methods`
  - `werift-rtp`: `PacketChunk`、`PacketStatus`
  - `werift-rtp/extra`: `H264NaluType`（typedoc の対象はメインエントリだけなので、生成ドキュメントには出ていない）
  - `werift-ice-server`: `classes`、`methods`（`src/index.ts` から `export *`）
  - `werift-sctp`: `SCTP_STATE`、`WEBRTC_PPID`
- 非公開の enum は 3 個（`dtls` の `ContentType`、`AlertDesc`、`HandshakeType`）。`packages/dtls/src/index.ts` には、コメントアウトされた定義しかない。
- repo 内での enum 特有の使い方:
  - 逆引き（`Enum[value]`）: `packages/dtls/src/record/receive.ts:89,97` の `AlertDesc[...]` だけ（既知の値かどうかの判定と、ログ出力に使っている）
  - メンバーを型として使う: `packages/rtp/src/rtcp/rtpfb/twcc.ts` に 3 箇所。`RunLengthChunk.type: PacketChunk.TypeTCCRunLengthChunk` と、`RecvDelta.type: PacketStatus.TypeTCCPacketReceivedSmallDelta | …LargeDelta`。どちらも公開クラスのフィールドである
  - `Object.keys/values(Enum)`: 0 件
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

### 2.5 公開 enum の置き換え方の検証（3.1 の根拠）

**外部での使われ方**（2026-11-04 に GitHub のコード検索で確認。インデックスと rate limit の制約があるため網羅的ではない）

- `zfogg/ascii-chat`（`web/discovery/api/_tcp.ts`）は `werift-ice` の `methods.BINDING`、`methods.ALLOCATE`、`classes.REQUEST` を使い、`message.messageClass === classes.RESPONSE` で比較している。
- repo 内の `import-test/sctp.mjs` は `WEBRTC_PPID.STRING` を使っている。
- どちらも値として参照しているだけで、逆引き、メンバーを型として使う書き方、`Object.keys/values` の使用は見つからなかった。

**置き換え方ごとの動作**（TS 6.0.3 の `erasableSyntaxOnly`、Node 26.5.0 / 24.18.0 / 22.21.1 の strip-only 実行、esbuild、typedoc 0.28.20 で確認）

| 置き換え方 | strip-only で実行 | 値の参照・型注釈・`switch` の網羅性チェック | メンバーを型として使う | 逆引き・`Object.keys` が実 enum と同じ | typedoc の `enumerations/` |
| --- | --- | --- | --- | --- | --- |
| L1: `as const` オブジェクト + 同名の union 型 + JSDoc の `@enum` | ○ | ○ | ×（`typeof X.M` にする） | × | ○（`@enum` があれば、ページの構成も内容も変わらない） |
| L2: L1 + 型だけを持つ `declare namespace X { type M = typeof X.M }` | ○ | ○ | ○ | × | ○（ただし `namespaces/X/` のページが別に増える） |
| L3: 逆引きも作るヘルパー関数 + L2 | ○ | ○ | ○ | ○（キーの並びまで同じ） | ×（初期化子が関数呼び出しになるため `@enum` が効かず、`variables/` と `type-aliases/` に分かれる） |

- 3 案とも、実 enum の値と相互に代入できる。旧版の `werift-*` から受け取った値を渡しても型エラーにならない。
- L3 では `keyof typeof X` に数値キー（`0 | 1 | …`）が混ざる。実 enum ではメンバー名だけなので、ここが新しい非互換になる。

**全パッケージで、11 個の enum を L1 の形に機械的に置き換えた試行**（一時 worktree で実施。パラメータプロパティは未変換）

- 型エラーは 35 件で、内訳は次の 3 種類だった。
  - 約 28 件: 変更可能なフィールドがリテラル型に狭まる。`as const` のメンバーは、変数やフィールドに入れても広がらないリテラル型のままになるため、`associationState = SCTP_STATE.CLOSED` は型 `1`、`private _state = CandidatePairState.FROZEN` は型 `0` と推論される。その結果、後続の比較や代入（`ice.ts`、`sctp.ts`、`webrtc/src/transport/*.ts`）でエラーになる。
  - 4 件: `number` を enum 型に代入している。`ice-server/src/stun/message.ts:137` の `new Message(messageType & 0x3eef, …)`、`rtp/src/extra/container/mp4/h264.ts:107`、`twcc.ts:270`、ice のテスト 1 件。実 enum には `number` を代入できるが、リテラルの union 型にはできない。
  - 3 件: メンバーを型として使っている（`twcc.ts:256,354,355`）。
- 公開されている型も変わる。`CandidatePair.state` の getter は `CandidatePairState` から `0` になり、`SCTP.associationState` は `1` になる（typedoc の差分で確認）。
  - 公開フィールドのうち repo 内で比較されていないものは型エラーにならないので、tsc だけでは見落とす。
- `werift-ice` の typedoc を再生成すると、`enumerations/*.md` のファイル構成と内容は変わらなかった。差分は上の型の狭まりと、union の表記順の揺れだけだった。

## 3. 対応方針（推奨: 案 A）

| 案 | 内容 | 長所 | 短所 |
| --- | --- | --- | --- |
| **A（推奨）** | ソースを erasable syntax だけにし、フラグを全廃する | 追加の依存がない。変換コストがなく、行番号がそのまま保たれる（source map 不要、WPT coverage の行対応もそのまま）。Node 22.18+ / 24 / 26 で同じように動く。TS の `erasableSyntaxOnly` という Node と TS 両方の方向性に合う | 約 300 箇所の機械的な書き換えが必要。公開 enum の型レベルの互換性が一部崩れる（3.1） |
| B | `amaro/transform` ローダーを devDependency に追加し、フラグの代わりに `--import` する | ソースの変更がほぼ不要 | 外部の TS 変換器への依存が戻る（`AGENTS.md` の「third-party runner を再導入しない」方針に反する）。`--enable-source-maps` が必須で、WPT coverage の再検証も必要。`register.mjs` にも `format` を補う修正が要る |
| C | 事前にビルドした `lib/` を実行する | Node の TypeScript 対応に依存しない | examples / WPT / e2e の開発フローが大きく変わり、ソースを直接実行する利点がなくなる |
| D | `devEngines` で `<26` に固定する | 変更が最小 | Node 26 が LTS になるため一時しのぎにしかならない |

- 案 A で進める。案 B は、作業途中で Node 26 での実行がすぐに必要になった場合の一時的な逃げ道としてだけ記録しておき、採用しない。
- 公開パッケージの `engines`（`>=22`）と `devEngines`（`>=22.18.0`）は変えない（22.18 以降は型の除去が既定で有効なため）。

### 3.1 公開 enum の互換方針（確定: L1 で置き換え、互換シムは作らない）

- 公開 enum 8 個（2.2）と非公開 enum 3 個は、どれも 2.5 の L1 の形にする。つまり `as const` オブジェクトと同名の union 型にし、JSDoc に `@enum` を付ける。
- 逆引き用のヘルパーや、メンバー型を残すための `declare namespace` は作らない。
- 実行時の値は 1 つも変えない。
- 互換性の約束は次のとおり。

| 項目 | 方針 | 利用者向けの移行方法（changelog に書く） |
| --- | --- | --- |
| 値の参照（`SCTP_STATE.ESTABLISHED`）、値そのもの、`===` での比較、`switch` | 保つ | 不要 |
| 型注釈での利用（`state: CandidatePairState`）と、`switch` の網羅性チェック | 保つ | 不要 |
| `keyof typeof X`（メンバー名の union） | 保つ | 不要 |
| CJS / ESM の export 名 | 保つ | 不要 |
| 旧版の enum 値との相互代入 | 保つ | 不要 |
| werift の公開 API に出てくる型（フィールド、引数、戻り値）は、旧 enum 名の型のままにする（リテラル型に狭めない） | 保つ（4.2 で必須にする） | 不要 |
| typedoc の `enumerations/X.md` のページ | 保つ（`@enum` で） | 不要 |
| 逆引き（`X[value]`、例: `CandidatePairState[pair.state]`） | 保たない | `Object.entries(X).find(([, v]) => v === value)?.[0]` を使うか、自前で逆引きの map を持つ |
| `Object.keys/values/entries(X)` に数値キーが含まれること | 保たない | 名前だけになる。値の一覧は `Object.values(X)` で取れる |
| メンバーを型として書くこと（`x: PacketChunk.TypeTCCRunLengthChunk`） | 保たない | `typeof PacketChunk.TypeTCCRunLengthChunk` に書き換える |
| `number` 型の値をそのまま代入すること | 保たない | 範囲を確かめてから `as X` で絞り込む |
| `let s = X.A; s = X.B;` のように型注釈なしで代入し直すこと | 保たない | `let s: X = X.A` と型注釈を付ける |

- この方針を選んだ理由:
  - 前例: 依存更新チケット（`TICKET-ticket-bf950660-…` の 2.2）では、「外部から使っている箇所がない」ことを理由に互換ラッパーを作らなかった。今回も、外部で確認できた使い方は値の参照だけで（2.5）、L1 で保てない機能が使われている例は見つかっていない。
  - L1 は Node / TS が推奨する標準的な書き方で、余計な宣言が増えない。typedoc の出力位置も変わらないので、生成ドキュメントへのリンクも壊れない。
  - L2 は、メンバー型 37 個分の宣言を維持する手間と、typedoc に `namespaces/` のページが増えることに見合う利用実績がない。
  - L3 は typedoc の enum ページがなくなり、`keyof typeof X` に新しい非互換を生む。完全な互換にはならない。
  - `enum` のまま残す方法（`declare enum` / `const enum` を含む）は、strip-only の実行では値が存在しないか実行できないので、選択肢にならない。
- リリースの扱い:
  - changelog は、`changelog.md` の先頭（`# Changelog` の直後、`## v0.26.0` の上）に `## Unreleased` を新しく作って書く。`## v0.26.0` は公開済みなので追記しない。
  - 型レベルの破壊的変更を含むので、`## Unreleased` の中の `### ⚠️ Breaking changes` に載せる。
  - 影響するパッケージ（`werift`、`werift-ice`、`werift-ice-server`、`werift-rtp`、`werift-sctp`）は、次の公開時にマイナー版を上げる。
- 後からメンテナーがこの方針を覆して互換性を強めたい場合も、L2 と L3 は 2.5 で動作を確認済みなので、そのまま採用できる。どちらにしても 4.2 の型注釈ルールは必要である。

## 4. 実装内容

### 4.1 パラメータプロパティを明示的なフィールドにする（約 132 クラス）

- 書き換えの形: `constructor(private readonly a: A, public port = 5000) {}` を、`private readonly a: A; port: number;` の宣言と、コンストラクタ内の `this.a = a; this.port = port;` に分ける。
- 守ること:
  - 可視性・`readonly`・JSDoc・既定値・省略可能（`?`）をそのまま残す。
  - 派生クラスでは、代入を `super(...)` の直後に置く。
  - 基底クラスのコンストラクタが設定するプロパティをサブクラスで宣言し直す場合は、`declare` を付ける。`useDefineForClassFields` があると `undefined` で上書きされてしまうため。
  - 代入はコンストラクタ本体の先頭に置き、既存の処理より前に済ませる（パラメータプロパティの評価順と同じにするため）。
- 対象: `packages/*/src`、`packages/*/tests`、`packages/*/examples`、`e2e/server`。

### 4.2 enum を `as const` オブジェクトと同名の型にする（11 個、方針は 3.1）

```ts
/**
 * (既存の説明があれば残す)
 * @enum
 */
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

- 定義の書き換え:
  - メンバーの値（`0x000` などの書き方も含む）と、各メンバーの JSDoc はそのまま残す。
  - `@enum` は既存の JSDoc に追記する。JSDoc がなければ新しく作る。
  - 初期化子はオブジェクトリテラルのまま書く。関数呼び出しにすると、typedoc の `@enum` が効かなくなる。
- 型注釈を付ける（必須）: 旧 enum のメンバーで初期化している変更可能なフィールド・変数には、すべて旧 enum 名の型注釈を付ける。
  - 例: `SCTP.associationState: SCTP_STATE = SCTP_STATE.CLOSED`、`CandidatePair._state: CandidatePairState = CandidatePairState.FROZEN`。
  - 公開フィールドは、repo 内で比較されていなければ tsc がエラーを出さない。そのため、`= <旧enum名>.<メンバー>` で初期化している箇所を検索して、漏れなく確認する。
- `number` を代入している箇所: `ice-server/src/stun/message.ts:137`、`rtp/src/extra/container/mp4/h264.ts:107`、`rtp/src/rtcp/rtpfb/twcc.ts:270` など。今のロジックを変えずに `as X` で型を合わせる（実行時の判定は追加しない）。
- メンバーを型として使っている箇所（`twcc.ts:256,354,355`）は、`typeof PacketChunk.TypeTCCRunLengthChunk` の形に書き換える。
- `AlertDesc` の逆引きは、`packages/dtls/src/record/const.ts` に非公開の関数を作って置き換える。
  - 関数の形は `alertDescName(value: number): string | undefined`。`receive.ts` での「既知の値かどうか」の判定と、ログ出力の両方をこの関数で行う。
  - `dtls` の `src/index.ts` からは export しない。
- `changelog.md` の `## Unreleased` > `### ⚠️ Breaking changes` に、3.1 の表の「保たない」行とその移行方法を書く。

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
- `changelog.md` の先頭に `## Unreleased` を新しく作り、次を書く（公開済みの `## v0.26.0` には追記しない）。
  - `### ⚠️ Breaking changes`: 公開 enum を const オブジェクトに移行したこと（3.1 の表の「保たない」行と、その移行方法）
  - `### 🧪 Testing & tooling`: フラグの廃止と Node 26 への対応
- `npm run doc` で typedoc（`doc/`、`packages/*/doc`）を再生成する。
- `.github/workflows/nodejs.yml` の matrix に `26.x` を追加する。全ジョブで重い場合は、少なくとも `type` / `test:small` / `test:node-ts` / `wpt:list` を 26.x で実行する。

### 4.6 サブモジュール `integration/werift-mediasoup-interop`

- 別リポジトリなので、そちらの `AGENTS.md` に従い、別 PR でフラグを外してから submodule のポインタを更新する。
- `WERIFT_REPO_ROOT` で古い werift のチェックアウト（enum を含む）を指したときの扱い（Node 24 なら従来のフラグで動く）を、README に書いておく。

## 5. 制約・注意点

- 書き換えは振る舞いを変えないリファクタリングに限る。`lib/` の出力 JS や `.d.ts` は変わるが、実行時の値は変わらないこと。
- 公開型が意図せず狭まっていないかは、tsc だけでは確認しきれない（2.5）。`develop` を一時 worktree でビルドし、各パッケージの `lib/**/*.d.ts` と比べる。
  - 想定される差分: enum 宣言が const 宣言と type 宣言に変わること、パラメータプロパティが明示的なフィールドに変わること。
  - 想定外の差分: 旧 enum 名だった型がリテラル型（`0`、`1` など）に変わっていること。見つけたら 4.2 の型注釈を追加する。
- `useDefineForClassFields: true` の下では、宣言の位置によってプロパティの定義順（`JSON.stringify` や `util.inspect` の出力順）が変わることがある。順序に依存するテストやシリアライズがないか確認する。
- import の扱いは strip-only でも transform でも同じで、型だけの import は `import type` で書かれている必要がある。現状は transform モードで動いているので新たな問題は起きないはずだが、Node 26 で全エントリポイントを実際に起動し、`does not provide an export named` が出ないことを確かめる。
- upstream WPT 向けの厳密な挙動は、引き続き `packages/webrtc/tools/wpt-runner/*` の中だけに置く（今回のタスクでは触らない）。
- テストを追加・変更する場合は、Arrange / Act / Assert の形で書き、Act / Assert に日本語のコメントを付ける（例: `AlertDesc` の名前の引き方、公開 const の値が変わっていないこと）。
- Vitest、`tsc`、`esbuild`、typedoc は自前で変換するので、今回のフラグ廃止の影響は受けない。
- 長時間の検証（`wpt`、`e2e`、`examples:e2e`）を始める前に、リビジョン、未コミットの変更、意図を記録する（`AGENTS.md` の Do 8）。
- 対象外: npm scripts の長いコマンドを共通ラッパーにまとめること（必要なら別チケットにする）、`loadtest/` と `benchmark/`（workspace の外）。

## 6. 完了条件

- [ ] `grep -rn "experimental-transform-types"` の結果が、`changelog.md` の過去の記述、`third_party/`、このチケット文書、別リポジトリのサブモジュール `integration/werift-mediasoup-interop`（別チケットで対応。4.6）を除いて 0 件になる（生成ドキュメントも再生成済み）。
- [ ] `packages/*` / `e2e` / `examples/e2e` / `chrome-e2e` の tsconfig に `erasableSyntaxOnly: true` が入り、`npm run type` と `npm run type:all` が通る。
- [ ] Node 26.x で次がすべて通る: `npm run test:node-ts`、`npm run test:small`、`npm run wpt:list`、`npm run wpt`、`npm run wpt:coverage`、`npm run e2e`、`npm run examples:e2e`。
- [ ] Node 24.x（CI の既定）でも同じコマンドが通る。Node 22.18+ で少なくとも `test:node-ts` と `wpt:list` が通る。
- [ ] 公開 enum 8 個が 3.1 の互換方針（L1）で置き換わっている。値はすべて変わっておらず、「保つ」とした項目は維持されている。
- [ ] `lib/**/*.d.ts` を `develop` のビルドと比べ、旧 enum 名だった公開フィールド・引数・戻り値の型がリテラル型に狭まっていない（少なくとも `CandidatePair.state` と `SCTP.associationState` は旧 enum 名の型のまま）。
- [ ] 再生成した typedoc で、`enumerations/` のページ（`CandidatePairState`、`classes`、`methods`、`PacketChunk`、`PacketStatus`）がそのまま残っている。
- [ ] `AlertDesc` の逆引きを、非公開の `alertDescName()` に置き換えている。テストで次を確認している: 既知の値なら名前を返し、未知の値なら `undefined` を返すこと。公開 const の代表的な値（`SCTP_STATE.ESTABLISHED === 4` など）が変わっていないこと。
- [ ] `.github/workflows/nodejs.yml` に Node 26.x のジョブがある。
- [ ] ルートの `AGENTS.md`、README、typedoc を更新している。
- [ ] `changelog.md` の先頭に新しく作った `## Unreleased` に、Breaking changes（移行方法を含む）と Testing & tooling が書かれている。公開済みの `## v0.26.0` は変更していない。
- [ ] `npm run format` を実行済み。
- [ ] サブモジュール `werift-mediasoup-interop` 側の対応について、PR を出すか、別チケットにするかが決まり、記録されている。

## 参考

- [Node.js v26.0.0 release](https://nodejs.org/ja/blog/release/v26.0.0)
- [Node.js Modules: TypeScript（v26 の changelog に `--experimental-transform-types` の削除、#61803）](https://nodejs.org/api/typescript.md)
- [nodejs/help#5153（v26 でフラグがなくなった件）](https://github.com/nodejs/help/issues/5153)
- [nodejs/learn#87（ガイドからフラグの記述を削除）](https://github.com/nodejs/learn/pull/87)
- [nodejs/amaro（`amaro/transform` ローダー）](https://github.com/nodejs/amaro)

## 7. 実施結果（2026-11-04、基準リビジョン `c01c5be59`）

- パラメータプロパティ 298 箇所（132 クラス）を TypeScript API を使った書き換えスクリプトで明示的なフィールドに変換した。フィールド宣言はクラス本体の先頭に置き、tsc が出力していたプロパティの定義順と同じにしている。
- enum 11 個を 3.1 の L1 形式に置き換えた。`lib/**/*.d.ts` を基準リビジョンのものと比べて、想定外の差分（リテラル型への狭まり）がないことを確認した。
- サブモジュール `integration/werift-mediasoup-interop`（4.6）: この変更には含めず、別チケットにする。サブモジュールは別リポジトリなので、そちらでフラグを外す PR を出してから、ポインタを更新する。それまでは、CI の `mediasoup-interop` ジョブを Node 24.x だけで動かす（matrix に 26.x を足していないのはこのため）。
- 検証: Node 26.13.0 / 24.21.0 で `type:all`、`test:node-ts`、`test:small`、`wpt:list`、`wpt`、`wpt:coverage`、`e2e`、`examples:e2e`（68/68）を実行した。Node 22.23.4 では `test:node-ts` と `wpt:list` を実行した。
- `e2e` について: Node 24 / 26 のどちらでも `packetize_vp9` が 1 件失敗する（`waitVideoPlay` が 30 秒でタイムアウト）。2026-11-04 に、専用の `PLAYWRIGHT_BROWSERS_PATH` を使い、基準リビジョン（develop `c9906b16a`）の一時 worktree と変更後で、このテスト 1 件だけを同じ手順で実行したところ、どちらも同じ失敗になった。以前に 66/66 で通った記録は、この環境では再現しなかった。基準リビジョンでも落ちるため、この変更による回帰ではなく、実行環境の Chrome が VP9 を再生できないことによる失敗と判断している。残り 65 件は成功する。VP9 が再生できる環境での 66/66 の確認は未実施。
