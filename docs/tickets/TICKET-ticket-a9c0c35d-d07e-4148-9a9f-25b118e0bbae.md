# packages 以下の scriptc ライブラリビルド可能な Sans-I/O モジュールにマーカーを付け、AGENTS.md でその性質の維持を宣言する

- 調査基準: `ticket/a9c0c35d-…` HEAD `7839e34cf`（develop `739bf515e` + チケットファイル作成のみ）
- 調査環境: Node.js v24.18.0 / Linux x64、`scriptc@0.4.11`（npm latest。`/tmp` に一時インストールして実測。リポジトリには何も追加していない）
- 対象: `packages/{common,ice,dtls,rtp,sctp,webrtc,ice-server}/src`、ルート `AGENTS.md`（必要に応じてパッケージ `AGENTS.md`）
- 決定事項（2026-11-11 確定。根拠は 6 章）:
  - `node:crypto` は実行時 import を禁止する（`import type` は可）。
  - scriptc を使わない静的検査は `npm run test:small` に組み込む（`ci` からも実行される）。scriptc を使う検査は手動で行い、AGENTS.md で実行を義務づける。nightly ジョブは作らない。
  - 第 2 段階（barrel の leaf 化、`random16` / `random32` の分離、log 依存の除去など）はこのチケットに含めず、後続チケットにする。

---

## 1. 目的と背景

- werift のプロトコル層には、パケットの parse / serialize、ヘッダ拡張、replay window、輻輳制御（GCC）推定器など、**I/O を持たない純粋なロジック**が多くある。一方で、同じパッケージの中に socket・timer・`Event` 通知・`crypto`・ログ出力を持つファイルが混ざっていて、どのファイルが純粋なのかはコードを読まないと分からない。
- [scriptc](https://github.com/vercel-labs/scriptc)（Vercel Labs、Apache-2.0、experimental）は、TypeScript をネイティブ実行ファイルや static archive / Wasm reactor にコンパイルするツールで、`scriptc build --lib --profile <p.json>` のライブラリモードを持つ。I/O を持たず、scriptc のコンパイル可能なサブセットに収まるモジュールは、Node.js なしでネイティブ / Wasm ライブラリとして再利用できる。
- 狙い:
  1. **今その性質を満たしているファイル**をファイル先頭のマーカーコメントで明示し、機械的に検出できるようにする。
  2. `AGENTS.md` で「マーカー付きファイルは Sans-I/O かつ scriptc ライブラリビルド可能な状態を保つ」と宣言し、エージェントや人がそのファイルに I/O（timer / socket / `Event` / ログ / 乱数 / 時刻）を持ち込んで性質を壊すのを防ぐ。
  3. 宣言が形骸化しないように、マーカー付きファイルを検証するスクリプトを用意する。

## 2. 用語の定義（このチケットで確定させる）

### Sans-I/O（このリポジトリでの定義）

マーカー付きファイルは、ファイル自身と、それが**実行時に import するすべてのファイル**（`import type` は除く）について、次をすべて満たす。

| 禁止するもの | 例 |
| --- | --- |
| ネットワーク / ファイル / プロセス | `dgram` `net` `tls` `fs` `os` `child_process` `worker_threads` `dns`、`process.*`、`Transport` 実装への依存 |
| 時刻・タイマー | `Date.now()` / 引数なしの `new Date()`、`performance.now()`、`setTimeout` / `setInterval` / `setImmediate`、`timers` |
| 乱数 | `Math.random()`、`crypto.randomBytes` など |
| 非同期と通知 | `async` / `Promise`、カスタム `Event` クラス（`common/src/event.ts`）、`events` の EventEmitter |
| 副作用のあるログ | `common/src/log.ts`（`debug()` は `process.env` / `stderr` / `Date.now` を使う） |
| 暗号 / ハッシュ API（`node:crypto` / `crypto` の**実行時** import。hash / HMAC も含めてすべて） | `createCipheriv` `createDecipheriv` `createHmac` `createHash` `timingSafeEqual` `randomBytes` など。`import type { CipherGCMTypes } from "crypto"` のような型だけの import は許可する（6 章の決定 1） |

- 時刻・乱数・送信・タイマーが必要なら、引数や戻り値（例: `now: number` を受け取り、送るパケットの配列を返す）で呼び出し側から注入する。
- 暗号が必要なら、マーカー付きファイルでは interface（例: `encrypt(key, iv, data): Uint8Array`）を `import type` で受け取るだけにする。`node:crypto` を使う実装はマーカーのないファイルに置き、呼び出し側から渡す。
- `Buffer` は**許可**する。scriptc は `Buffer` / `DataView` / 数値の typed array / `bigint` / `Map` / `Set` / class / closure / union を lower でき、既存コードの大半は `Buffer` を前提にしているため。

### scriptc ライブラリビルド可能

マーカー付きファイルが、次の両方を満たすこと。

1. `scriptc coverage --fail-on blockers <file>` が exit 0 で、**reached と unreached のどちらにも blocker がない**（`--print diagnostics` の JSON で判定する）。
2. 各パッケージの scriptc 検証用エントリ（後述）から実際に呼ばれる経路で、`scriptc coverage --fail-on blockers` が通り、`scriptc build --lib --profile` で static archive（`<name>.lib.a`）を生成できる。

> 1 だけでは足りない。ファイル単体の coverage は export された関数本体を十分に解析しないことがある。例: `dtls/src/helper.ts` は単体では「2 statements, fully static」だが、`getObjectSummary()` を呼ぶエントリから解析すると `Object.entries` が SC2020 blocker になる。

## 3. 調査結果

### 3.1 scriptc の仕様（実測と公式ドキュメント）

- CLI（`scriptc --help`、0.4.11）:
  - `scriptc coverage <file>`: そのファイルのうちどれだけが静的にコンパイルできるかと、できない理由を出す。`--fail-on blockers|node-islands|dynamic-slots|…` を付けると exit code で判定できる。`--print diagnostics` はバージョン付きの JSON を出す。
  - `scriptc build --lib --profile <p.json>`: ライブラリモード。入力ファイルは取らず、`--emit` / `--optimization` / `--strip` などは指定できない。
- `--lib` profile の最小構成（実測で `common/src/number.ts` から `werift_number.lib.a`（約 3.8MB）と `.ll` の生成に成功）:

  ```json
  {
    "profile_format": 1,
    "name": "werift_number",
    "emission": "llvm",
    "entry": "<abs path>/packages/common/src/number.ts",
    "abi": { "prefix": "werift_", "init_symbol": "werift_init", "sink_register_symbol": "werift_sink" },
    "exports": [
      { "export": "uint16Add", "symbol": "werift_uint16_add", "params": ["f64", "f64"], "returns": "f64" },
      { "export": "uint32Gt",  "symbol": "werift_uint32_gt",  "params": ["f64", "f64"], "returns": "bool" }
    ]
  }
  ```

  - `emission` は `"llvm"` 以外を受け付けない（C emission は削除済み）。
  - `callbacks` が空なのに `callback_register_symbol` を書くと SC4001 になる。
  - export の ABI 型は `f64` `bool` `u8` `u32` `i32` `i64` `u64` `string` `bytes` `cstring` `void` だけ。**class instance は ABI 越しに渡せない**ので、class ベースの API（`RtpPacket` など）は `bytes -> bytes` の薄い facade 関数で包む必要がある。
  - ライブラリモードは async / Promise / timer を扱えない。この点は Sans-I/O の定義と一致する。
- 型チェックが通らないと解析しない。リポジトリの `node_modules`（`@types/node`）がある状態で実行すること。`@types/node` がない一時 worktree では型の世界が変わり、`localStorage.getItem` や `dgram.SocketType` が TS エラーになる。
- 検証用エントリ自体は `.mts` にする（パッケージが CommonJS なので、`.ts` で ESM 構文を書くと SC1013）。
- npm パッケージ: `scriptc@0.4.11` は `bin/scriptc.exe` と platform 別の optional dependency（`@scriptc/cli-*`、`llvm-*`、`runtime-*`）から成り、`engines.node >= 24`。サイズが大きい。Windows（`win32-x64-msvc`）向けもあるが、werift は Windows を対象にしていない。
- 出力の既定先は `.scriptc/<name>`。`-o` で出力先を指定できるので、4.2 では `os.tmpdir()` 配下に出す（coverage は何も書き出さないことを確認済み）。

### 3.2 全ファイルの実測（`--fail-on blockers`、直接の I/O 参照がない 202 ファイル）

直接の I/O 参照（上表の API と `Event` / `.subscribe(` / `.execute(`）を grep で除外した 202 ファイルに `scriptc coverage --fail-on blockers` を 8 並列で実行した（約 1.5 分）。

| 結果 | 件数 |
| --- | --- |
| exit 0（blocker なし） | 71 |
| exit 1（blocker あり） | 120 |
| exit 134（scriptc 自体が abort / core dump） | 11（`ice/src/index.ts`、`webrtc/src/{index,sdpManager}.ts`、`webrtc/src/media/{router,codecCompatibility,index}.ts`、`webrtc/src/api/peerConfig.ts` など。いずれも Sans-I/O 候補ではない） |

blocker の発生源（その blocker を含むファイル数）:

| 発生源 | 件数 | 内容 |
| --- | --- | --- |
| `common/src/log.ts` | 111 | spread 引数（SC1090）、`localStorage.getItem`（SC2020）、`process` の dynamic slot |
| `common/src/event.ts` | 108 | `Event<[Error]>` の `EventExecute` 型（SC2009） |
| その他（ファイル固有） | 少数 | `sctp/chunk.ts`（継承フィールドの再宣言、program 外 class の継承、static member の class 値経由読み出し）、`rtp/rtcp/psfb/index.ts`、`dtls/handshake/extensions/useSrtp.ts`、`dtls/cipher/suites/aead.ts`、`ice-server/stun/attributes.ts`、`rtp/extra/container/mp4/container.ts`（`mediabunny` の SC2013）、`webrtc/helper.ts`、`webrtc/media/parameters.ts`（unreached の `Object.assign`）など |

- **90 ファイルは `log.ts` / `event.ts` だけが原因で失敗している。** これらは `import … from "../../../common/src"` や `./imports/common`（`common/src/index.ts` の barrel）を経由して、`event` / `log` / `network` / `transport` まで実行時に読み込んでいる。
- 一時 worktree で import を leaf ファイルへ書き換えて確認した:
  - `rtp/src/rtp/rtp.ts`: `common/src` を `common/src/binary` に変えると exit 0 になる（99% static）。
  - `sctp/src/chunk.ts`: crc を `common/src/crc` から直接 import しても、class 継承に関する固有の blocker（SC1090 ×15）が残る。
- `common/src/binary.ts` は scriptc 上は 100% static だが、`random16()` / `random32()` のために `crypto.randomBytes` を import している。そのため Sans-I/O ではない。

### 3.2.1 `node:crypto` の実測（決定 1 の根拠）

| 確認したこと | 結果 |
| --- | --- |
| crypto を使う既存ファイル（`rtp/srtp/cipher/{ctr,gcm}.ts`、`dtls/cipher/{prf,suites/aead}.ts`、`ice-server/stun/message.ts`）の coverage | すべて exit 1。ただし原因は crypto ではなく、barrel 経由の `log.ts` / `event.ts`（87〜89% static） |
| `.mts` の probe で `createCipheriv`（aes-128-ctr / aes-128-gcm、`setAAD` / `getAuthTag`）、`createHmac`（sha1 / sha256）、`createHash`（md5）、`timingSafeEqual`、`randomBytes` を使う | coverage は 100% static で exit 0 |
| 同じ API を `--lib` でビルドする | `createCipheriv` / `createDecipheriv` は **SC4005**（「library mode requires an async_free module graph」。v1 のライブラリ成果物は event loop / thread を持たない）で拒否された。`createHmac` だけなら `.lib.a` を生成できた |

- **coverage は SC4005 を検出しない。** coverage が通っても `--lib` ビルドで落ちることがあるので、4.2 の `--lib` smoke は省略できない。
- crypto を許可しても、SRTP / SRTCP / DTLS の AEAD のような AES を使う層は、scriptc 0.4.11 のライブラリモードでは条件 2 を満たせない。許可して得られるのは、HMAC / hash だけを使う STUN の integrity 程度に限られる。

### 3.3 マーカー付与候補（第 1 段階: コード変更なしで両条件を満たすもの）

coverage が exit 0 で、Explore 調査（推移的 import を含む I/O 判定）でも pure と判定されたもの。合計 **56 ファイル**。

- TypeScript AST（`typescript` 6.0.3 の `createSourceFile`）で実行時 import の閉包も確認した。一覧の外への実行時 import は `dtls/cipher/suites/null.ts → abstract.ts` の 1 件だけだった。
- `abstract.ts` は `import type … from "crypto"` があったため最初の grep で外れていたが、型だけの import なので許可される。coverage も 100% static だったので一覧に加えた。
- **実装時に 4.2 の検証スクリプトで最終確認する。**

| パッケージ | ファイル（`src/` 相対） |
| --- | --- |
| common | `asn1.ts`、`binaryData.ts`、`crc.ts`、`number.ts`、`queue.ts` |
| dtls | `cipher/const.ts`、`cipher/key-exchange.ts`、`cipher/suites/{abstract,null}.ts`、`context/srtp.ts`、`handshake/const.ts`、`handshake/extensions/extendedMasterSecret.ts`、`record/antiReplayWindow.ts`、`record/const.ts` |
| ice | `stun/const.ts`、`stun/tcpFrame.ts`、`turn/credential.ts` |
| ice-server | `stun/const.ts` |
| rtp | `const.ts`、`codec/assertPayload.ts`、`codec/leb128.ts`、`rtcp/rtpfb/const.ts`、`rtcp/rtpfb/twccReferenceTime.ts`、`srtp/{const,error,replay,session}.ts`、`srtp/cipher/index.ts`、`extra/container/mp4/{chunk,exp-golomb,h264,sps-parser}.ts`、`extra/container/ogg/{parser,writer}.ts`、`extra/container/webm/ebml/{ebml,id,typedArrayUtils}.ts` |
| sctp | `const.ts`、`param.ts` |
| webrtc | `errors.ts`、`media/extension/rtcpFeedback.ts`、`negotiation/{iceRestartRequest,internalState}.ts`、`media/sender/estimators/gcc/` の 13 ファイル（`acknowledgedBitrateEstimator` `aimdRateControl` `alrDetector` `bandwidthLimitedCause` `constants` `interArrivalDelta` `intervalBudget` `linkCapacityEstimator` `lossBasedBwe` `overuseDetector` `probeController` `rttBasedBackoff` `trendlineEstimator`。`gccBwe.ts` と `index.ts` は `Event` を使うので除く） |

coverage は通るが**付与しない**もの（理由付き）:

- `dtls/context/transport.ts`: `Transport` の adapter で、I/O 境界そのもの。
- `dtls/helper.ts`: 呼び出し経路から解析すると `Object.entries` が blocker になる（2 章の注記）。
- `webrtc/media/parameters.ts`: unreached に `Object.assign` の blocker がある。
- `rtp/extra/processor/{dtxCallback,interface}.ts`: callback 型の processor 基盤。`dtxCallback.ts` が import する `dtx.ts` は I/O 判定で除外されている（scriptc は timer などを lower できるため、coverage が通っても Sans-I/O とは限らない例）。
- `webrtc/polyfill/*`、`webrtc/api/peerConnectionEvents.ts`: ブラウザ API / `Event` 型の表面で、Sans-I/O ライブラリとして切り出す意味が薄い。
- barrel（`index.ts`、`imports/*.ts`）と、実行時コードを持たない型専用ファイル（`common/type.ts`、`dtls/typings/domain.ts`、`webrtc/types/domain.ts` など）: 付与しなくてよい。`import type` は closure 判定の対象外にする。barrel にはマーカーを付けない。

### 3.4 対象外: 第 2 段階以降の後続チケット（決定 3）

このチケットではコードの書き換えをせず、マーカーも付けない。以下を後続チケットとして起票する。起票は、このチケットの PR マージ後にチケット管理側で行う。PR 本文にはこの一覧を「後続」として載せる。

| 後続 | 内容 | 主な対象 | 公開 API への影響 |
| --- | --- | --- | --- |
| A. barrel の leaf 化と `random` の分離 | 1. `common/src/binary.ts` の `random16` / `random32` を `common/src/random.ts` などへ移す（`common/src/index.ts` から re-export を続けるので公開 API は変わらない）。<br>2. 候補ファイルの import を `../../../common/src` / `./imports/common` から leaf（`common/src/binary`、`common/src/crc` など）へ書き換える。 | barrel 由来だけで失敗している約 90 ファイル（`rtp/src/{codec,rtcp,rtp,srtp/packet}/**`、`dtls/src/{handshake,record/message,record/builder,util/binary}/**`、`webrtc/media/extension/rtpExtension.ts` など） | なし（re-export を維持） |
| B. log・時刻・乱数の注入 | `log.ts` への依存をやめる（ログ関数を注入するか、戻り値で状態を返す）。`Date` / `randomBytes` を引数で受け取る。 | `dtls/record/receive.ts`、`dtls/context/dtls.ts`、`dtls/handshake/random.ts`、`webrtc/sdp.ts`（session id）、`rtp/extra/processor/jitterBuffer.ts` | 内部 API の引数が増える可能性がある。公開 API はデフォルト値で互換を保つ |
| C. scriptc 固有の blocker の解消 | class 継承（フィールドの再宣言、program 外 class の継承、static member の class 値経由読み出し）を書き換える。`Object.entries` / `Object.assign` を置き換える。 | `sctp/chunk.ts`、`rtp/rtcp/psfb/index.ts`、`dtls/handshake/extensions/useSrtp.ts`、`dtls/helper.ts`、`webrtc/media/parameters.ts` | `sctp/chunk.ts` の class 階層は sctp パッケージの export に含まれるため要確認 |
| D. 暗号 provider の注入 | AES-CTR / GCM / HMAC を interface 越しに受け取る形にする（決定 1 による）。scriptc の `--lib` が `createCipheriv` を扱えない（SC4005）ので、ネイティブ化する場合は host 側の callback で提供する。 | `rtp/srtp/{cipher,context}/**`、`ice-server/stun/message.ts`、`ice/stun/message.ts`、`dtls/cipher/**` | 内部構造の変更が大きい。A〜C の後に要否を判断する |
| E. `node:net` の除去 | `isIPv4` / `isIPv6` を純粋な実装に置き換える。 | `ice-server/stun/{attributes,ip}.ts` | なし |

- A がほかの後続の前提になる（leaf 化しないと barrel 経由の `log` / `event` で必ず blocker になる）。
- 後続でファイルが条件を満たしたら、そのチケットでマーカーを付ける。

### 3.5 リポジトリ側の前提

- 既存のパッケージ `AGENTS.md` は `rtp` `webrtc` `ice-server` の 3 つだけ（`common` `ice` `dtls` `sctp` にはない）。どれも Purpose / Scope / Do / Don't / Commands / Validation / Maintenance の章立て。
- ルート `AGENTS.md` の Do 3 に「asynchronous notifications through the custom `Event` class」とある。Sans-I/O ファイルでは `Event` を使えないので、例外を明記する必要がある。
- ファイル先頭の既存の慣習:
  - `/*!` の libwebrtc ライセンスヘッダ（GCC 15 ファイル、`rtp/rtcp/rtpfb/transportWideSequence.ts`）
  - `// RFC NNNN — Title`（rtp codec）
  - `/** … */` の doc コメント（17 ファイル）
  - `// Adapted from ts-crc32 (MIT)`（`crc.ts`）
  - パケット図のコメント（`sctp/chunk.ts`、`sctp/param.ts`）
  - `@module` / SPDX / `biome-ignore` の慣習はない。
- formatter は Biome 2.6.2。先頭のコメントは保持される。ただし**先頭コメントの直後に空行がないと、import の並べ替えで最初の import と一緒に動く**。
- Node.js は `devEngines >= 22.18.0`、CI は 24.x / 26.x。scriptc の npm wrapper は Node 24 以上が必要。
- CI（`.github/workflows/nodejs.yml`、`push` / `pull_request` / `workflow_dispatch`）は `npm run ci` を実行する。`ci` は `type:all build test doc wpt wpt:coverage`、`test` は `test:small e2e` で、`test:small` に入れたものは CI でも動く。ルートのツールのテストは、`test:node-ts`（`node --test tools/node-ts/register.test.mjs`）が別ステップで動く前例がある。schedule（nightly）で動く workflow はない。
- ルート devDependencies に `typescript` 6.0.3 と `npm-run-all2`（`run-s`）がある。静的検査は追加の依存なしで書ける。

## 4. 実装内容

### 4.1 マーカーコメントの仕様

- 書式（1 行、`//` コメント）:

  ```ts
  // werift:sans-io — no I/O, scriptc --lib buildable. Keep it so (see AGENTS.md "Sans-I/O modules").
  ```

  - 機械判定には行頭の `// werift:sans-io` だけを使う。説明文の言い回しは実装時に調整してよいが、全ファイルで同じ文面にする。
  - `/** */` にはしない。TypeDoc が module コメントとして拾い、`npm run doc` の生成物が変わるのを避けるため。
- 位置: **ファイルの 1 行目**。既存の `/*!` ライセンスヘッダ、RFC コメント、パケット図よりも前に置く。直後に既存ヘッダがなく import が続く場合は空行を 1 行入れる（Biome の import 並べ替え対策）。
- このチケットでは 3.3 の候補にだけ付与する（決定 3）。

### 4.2 検証スクリプト

検証は 2 つに分ける。scriptc を使わない**静的検査**は常に実行し、scriptc を使う**ビルド検査**は手動で実行する（決定 2）。

ファイル構成（ルート `tools/` の `.mjs`。`tools/node-ts/` と同じく、TypeScript runner なしで素の `node` で動かす）:

| パス | 役割 |
| --- | --- |
| `tools/sans-io/check.mjs` | 静的検査の本体。マーカーの列挙、閉包判定、禁止 API の検査を export し、CLI としてはリポジトリ全体を検査する |
| `tools/sans-io/check.test.mjs` | 静的検査のテスト（`node:test`） |
| `tools/sans-io/testUtil.mjs` | テスト共通の Arrange（一時ディレクトリに fixture のファイルを書き出す helper）。root `AGENTS.md` Do 6 に従い 1 ファイルにまとめる |
| `tools/sans-io/scriptc.mjs` | scriptc のビルド検査。固定バージョンの定数 `SCRIPTC_VERSION = "0.4.11"` を持つ |
| `tools/sans-io/scriptc/<pkg>.entry.mts` | パッケージごとの facade エントリ（`bytes` / 数値の関数でマーカー付きモジュールを包む） |
| `tools/sans-io/scriptc/<pkg>.exports.json` | facade の C ABI export 一覧（`export` / `symbol` / `params` / `returns`） |

- facade を `packages/<pkg>/` ではなく `tools/` に置く理由: パッケージの `files`（`lib` のみ）、tsconfig の `include`（`src` / `tests`）、Biome の対象に影響させないため。scriptc 自体がエントリを型チェックする。

ルート `package.json` の scripts:

| script | 内容 | 実行される場面 |
| --- | --- | --- |
| `sans-io:check` | `node tools/sans-io/check.mjs` | `test:small` から（ローカル + CI） |
| `test:sans-io` | `node --test tools/sans-io/check.test.mjs` | `test:small` から（ローカル + CI） |
| `test:workspaces` | `npm run test --workspaces --if-present`（今の `test:small` の中身） | `test:small` から |
| `test:small` | `run-s sans-io:check test:sans-io test:workspaces` に変更 | 今と同じ（`test` → `ci` → CI） |
| `sans-io:scriptc` | `node tools/sans-io/scriptc.mjs` | **手動のみ**（Node 24 以上） |

#### 静的検査（`sans-io:check`、Node 22.18 以上、追加依存なし）

- 実装にはルート devDependency の `typescript`（`ts.createSourceFile`）を使い、AST で判定する。コメントと文字列は AST 上で自然に除外される。
- 実測では 56 ファイルの閉包判定に約 0.2 秒かかった。
- 処理:
  1. **マーカーの列挙**: `packages/*/src/**/*.ts` のうち、1 行目が `// werift:sans-io` で始まるファイルを集める。1 行目以外にマーカーがあるファイルもエラーにする（付け間違いの検出）。
  2. **閉包判定**: 実行時 import と re-export（`import type`、`export type`、全 specifier が `type` 付きの named import は除外）が、すべてマーカー付きファイルへ解決されること。次はどれもエラーにする:
     - Node builtin（`node:` の有無を問わない）、外部 npm パッケージ、barrel（`index.ts`、`imports/*.ts`）、マーカーのないファイル
     - 動的な `import()` と `require()`
  3. **禁止 API**: 次をグローバル参照として使っていたらエラーにする。
     - `setTimeout` `setInterval` `setImmediate` `clearTimeout` `clearInterval` `clearImmediate` `queueMicrotask`
     - `process` `performance` `fetch` `localStorage` `globalThis`
     - `Math.random`、`Date.now`、引数なしの `new Date()`
     - `async` 修飾子、`await`、`Promise`
     - `Event` と `node:crypto` は閉包判定（2）で検出する。
     - 判定は**グローバル参照だけ**を対象にする（ローカル宣言や import で束縛された名前、プロパティ名、メソッド名は除く）。正規表現で実装すると誤検出する。56 候補を grep した結果、一致したのは誤検出の 2 件だけだった。`gcc/probeController.ts:547` の `process(nowMs: number)` メソッドと、`gcc/constants.ts` の文字列リテラル中の単語である。
  4. 違反は `file:line: 理由` の形で全件出力し、exit 1 にする。
- テスト（`check.test.mjs`、Arrange / Act / Assert、Act / Assert のコメントは日本語）で最低限次を確認する:
  - 正常系: マーカー付き同士の import、`import type` による builtin や未マーカーファイルの参照
  - 異常系: マーカーのないファイルの実行時 import、barrel 経由の import、`node:crypto` の実行時 import、`setTimeout` / `Date.now()` / `async` の追加、2 行目以降のマーカー

#### ビルド検査（`sans-io:scriptc`、手動、Node 24 以上）

- `npx --yes scriptc@${SCRIPTC_VERSION}` で起動する。**devDependencies には入れない。** 初回は約 550MB（`@scriptc/cli-*` 163MB、`runtime-*` 250MB、`llvm-*` 60MB、wrapper 83MB。linux-x64-gnu の実測）をダウンロードする。
- Node 24 未満で実行したら、理由を表示して exit 1 にする（黙ってスキップしない）。
- 処理:
  1. 静的検査を先に実行し、失敗したら中断する。
  2. **coverage**: マーカー付きファイルごとに `scriptc coverage --fail-on blockers --print diagnostics` を並列実行し、reached / unreached のどちらにも blocker がないことを確認する。exit 134（scriptc の crash）も失敗にする。
  3. **`--lib` smoke**:
     - パッケージごとに `<pkg>.exports.json` と絶対パスの `entry` から profile を `os.tmpdir()` 配下へ生成する（`emission: "llvm"`、`abi.prefix` は `werift_<pkg>_`）。
     - `scriptc build --lib --profile <tmp>/profile.json -o <tmp>/<pkg>.lib.a` が成功し、`.lib.a` ができることを確認する。
     - 出力はリポジトリの外に置くので、`.gitignore` の変更は不要。
  4. facade の網羅: 静的検査と同じ AST 解析で、各パッケージのマーカー付きファイルのうち実行時 export を持つものが、すべて `<pkg>.entry.mts` から（直接か推移的に）実行時 import されていることを確認する。coverage が SC4005 のようなライブラリモード固有のエラーを検出せず、ファイル単体の coverage が export の本体を取りこぼす（`dtls/helper.ts`）ことへの対策。
- facade は主要 API（parse → serialize の round trip、推定器の 1 ステップ更新など）を、ファイルごとに最低 1 つ呼べばよい。全 export を ABI に出す必要はない。class instance は ABI を越えられないので、facade の中で生成して `bytes` / 数値で返す。

### 4.3 AGENTS.md の更新

- **ルート `AGENTS.md`**（リポジトリ全体の規約なのでルートに置く）:
  - Do に「Sans-I/O modules」の項目を追加する。内容:
    - 1 行目に `// werift:sans-io` があるファイルは、Sans-I/O（2 章の定義）で scriptc ライブラリビルド可能な状態を保つ。
    - I/O、時刻、乱数、`Event`、ログ、`async`、`node:crypto` を含む Node builtin の実行時 import、barrel import を持ち込まない。必要なものは引数・戻り値・`import type` した interface で注入する。
    - 実行時に import してよいのはマーカー付きファイルだけ。
    - 新しく条件を満たしたファイルにはマーカーを付ける。
  - Do 3（`Event` で通知する規約）に「Sans-I/O modules を除く」と追記する。
  - Don't に追加する: 性質を壊す変更をするためにマーカーを黙って外さない。外す場合は理由を PR に書き、呼び出し側の分離（I/O を外側に出す）を先に検討する。
  - Commands の表に追加する:
    - `npm run sans-io:check`（Sans-I/O の静的検査。`test:small` に含まれる）
    - `npm run sans-io:scriptc`（scriptc のビルド検査。手動、Node 24 以上、初回は大きなダウンロードがある）
    - `test:small` の行の説明に「Sans-I/O の静的検査を含む」と足す。
  - Validation に追加する:
    - マーカー付きファイル、マーカーの付け外し、`tools/sans-io/**` を変更したら、`npm run sans-io:check` と `npm run test:sans-io` を実行する（`test:small` でも実行される）。
    - さらに `npm run sans-io:scriptc` を Node 24 以上で実行し、結果を PR に書く。
    - CI は scriptc を実行しないので、この手動検査を省略しない。
- **パッケージ `AGENTS.md`**:
  - 既存の `rtp` `webrtc` `ice-server` には、ルートの規約を参照する 1 行だけを Do に足す（ファイル一覧は書かない。一覧はマーカーそのものが正とする）。
  - `common` `ice` `dtls` `sctp` に、このためだけの `AGENTS.md` を新しく作ることはしない。ルートの規約で足りる。
- Maintenance 規約に従い、`AGENTS.md` の章立ては変えない。

### 4.4 その他

- `.gitignore` は変更しない。scriptc の出力は `os.tmpdir()` 配下に置き、coverage は何も書き出さない。
- `knip.json` は変更しない。`entry` / `project` が `packages/**` だけなので、`tools/sans-io/**` は対象外になる。
- `changelog.md` / README: 公開 API は変わらないので必須ではない。開発者向けの一文を入れるかどうかは任意。
- `npm run doc`: `//` コメントは生成ドキュメントに影響しないはず。念のため 1 パッケージで差分が出ないことを確認する。

## 5. 制約と注意点

- **scriptc は experimental（0.4.x）。** 診断コードと対応範囲はバージョンで変わる。バージョンを固定し、`AGENTS.md` には「固定バージョンで検証する」とだけ書く（細かい対応表は書かない）。
- **coverage が通ることと Sans-I/O であることは別の条件。** scriptc は `crypto` / timer / `events` などの Node API も一部 lower できるので、coverage が通っても I/O を持つことがある（`dtxCallback.ts` の例）。closure 判定と禁止 API 検査は必ず併用する。
- **ファイル単体の coverage は export の本体を取りこぼすことがある**（`dtls/helper.ts`）。**coverage はライブラリモード固有の SC4005 も検出しない**（`createCipheriv` の例）。facade エントリ経由の `--lib` smoke を省略しない。
- **barrel の再 export が最大の障害。** マーカー付きファイルは `imports/common.ts` や `common/src/index.ts` を経由してはならない。このチケットでは import の書き換えをしない（決定 3）。
- **静的検査はビルド検査の代わりにならない。** I/O・時刻・乱数・`Event`・閉包の崩れは CI の静的検査で止まる。scriptc 固有の非対応構文（`Object.entries`、spread 引数、class 継承の一部など）は手動の `sans-io:scriptc` でしか検出できない。AGENTS.md の Validation で手動実行を義務づけて補う。
- `test:small` を `run-s` の連結に変えるので、`npm run test:small` の失敗出力の先頭に静的検査の結果が出る。workspace のテストより先に実行し、短時間で失敗させる。
- 既存のファイル先頭コメント（`/*!` ライセンス、RFC 番号、パケット図）は消さず、マーカーをその上に 1 行足すだけにする。
- 公開 API（`random16` の export 元など）、`build`、型生成（`type:public`）に影響する変更は第 1 段階では行わない。
- 検証で使う一時 worktree は `git worktree add --detach` で作り、終わったら削除する（root `AGENTS.md` Do 7）。scriptc の出力先はリポジトリの外か、gitignore したディレクトリにする。
- 長い検証の前には、revision・未コミット差分・意図を書き残す（root `AGENTS.md` Do 8）。
- 検証用エントリは `.mts` にする（SC1013）。type-check の対象に入れるなら tsconfig の `include` を確認し、`erasableSyntaxOnly` に反しない書き方にする。

## 6. 決定事項と根拠

### 決定 1: `node:crypto` の実行時 import を禁止する（`import type` は許可）

- **許可しても得るものがほとんどない。** crypto を最も使う SRTP / SRTCP（AES-CTR / GCM）と DTLS AEAD は、scriptc 0.4.11 の `--lib` で `createCipheriv` / `createDecipheriv` が SC4005 になる（3.2.1）。crypto を許可しても、条件 2（ライブラリビルド可能）を満たせない。
- **許可範囲が不安定になる。** `createHmac` / `createHash` は今は `--lib` で通るが、API ごとの許可リストを experimental な scriptc のバージョンに合わせて保守することになる。しかも coverage は SC4005 を検出しないので、境界が黙って動く。
- **規則を単純にできる。** 乱数（`randomBytes`）はもともと禁止で、同じ `crypto` module にある。「Node builtin の実行時 import は一律禁止、`import type` は可」という 1 つの規則にすれば、閉包判定だけで機械的に検出できる。
- **Sans-I/O の一般的な設計と合う。** 暗号は host が提供する能力として、interface で注入する（rustls / quinn-proto の crypto provider と同じ考え方）。Wasm やネイティブに移すときも、host 側の実装（scriptc の `callbacks`）に差し替えられる。
- **今の影響はない。** 56 候補に crypto を実行時 import するファイルはない。`dtls/cipher/suites/abstract.ts` の `import type { CipherGCMTypes } from "crypto"` は許可される。
- crypto を使う層を Sans-I/O にする作業は、後続 D（暗号 provider の注入）で扱う。

### 決定 2: 静的検査は `test:small` に組み込む。scriptc の検査は手動にし、nightly にはしない

- 静的検査を `test:small` に入れる理由:
  - 追加の依存がない（`typescript` は既存の devDependency）。決定的で、約 0.2 秒で終わる。Node 22.18 以上で動く。
  - `test:small` は、root `AGENTS.md` が cross-package の変更で要求する検証コマンドで、`test` → `ci` 経由で CI（Node 24.x / 26.x）でも動く。エージェントのローカル検証と CI の両方で、I/O の持ち込みと閉包の崩れという主な退行を止められる。
  - `ci` だけに入れると、ローカルの通常の検証（`test:small`）で検出できない。
- scriptc の検査を CI / nightly に入れない理由:
  - 実行ごとに約 550MB のダウンロードがあり、ネットワークに依存する。npm wrapper は Node 24 以上が必要で、`devEngines`（22.18 以上）と合わない。
  - experimental（0.4.x）で、今回も 11 ファイルで scriptc 自体が crash（exit 134）した。バージョンを上げるたびに診断が変わる。CI に入れると werift と関係のない失敗が混ざる。
  - リポジトリに schedule の workflow がない。nightly の失敗は PR の作者に結びつかず、放置されやすい。
  - その代わり、マーカー付きファイルを変更したときの `sans-io:scriptc` の手動実行と PR への結果の記載を、`AGENTS.md` の Validation で義務づける。
- 見直す条件: scriptc が 1.0 になったとき、または後続 A でマーカー付きファイルが大きく増えたとき。その時点で、Node 24 の CI job（`paths` で `packages/*/src/**` と `tools/sans-io/**` に限定）の追加を検討する。

### 決定 3: 第 2 段階はこのチケットに含めず、後続チケット A〜E（3.4）にする

- **タイトルの範囲と合う。** このチケットは「ビルドでき、Sans-I/O といえる」ファイルに印を付け、性質の維持を宣言するもの。満たさないファイルを満たすように書き換えるのは、別の性質の変更になる。
- **規模とリスクが違う。** A だけでも rtp / dtls / webrtc の約 90 ファイルの import を書き換える。B は内部 API の引数を変え、C は sctp の公開 class 階層に触れる。どれも e2e / WPT（`npm run ci`、`npm run e2e`）までの検証が必要になる。一方このチケットはコメント・ツール・ドキュメントの追加だけで、`npm run type` / `npm run test:small` で検証できる。混ぜるとレビューと bisect が難しくなる。
- **第 1 段階は第 2 段階に依存しない。** 56 候補の実行時 import は閉じている（3.3 で AST により確認済み）。
- **順序として先に土台が要る。** このチケットで入る静的検査と `sans-io:scriptc` があれば、後続の各チケットは「書き換え → マーカー付与 → 検査が通る」の単位で少しずつ進められる。

## 7. 完了条件

- [ ] 4.1 の書式のマーカーが、3.3 の 56 候補（検査で最終確認したもの）の 1 行目にあり、既存のヘッダコメントを壊していない。検査で除外したファイルがあれば、理由を PR に書いている。
- [ ] `npm run sans-io:check` が通る（Node 22.18 以上）。対象は全マーカー付きファイルの閉包判定と禁止 API 検査。
- [ ] `npm run test:sans-io` が通る。4.2 の正常系・異常系（未マーカーファイルの実行時 import、barrel、`node:crypto`、`setTimeout` / `Date.now()` / `async`、2 行目のマーカー）がテストされ、テストは Arrange / Act / Assert で書かれ、共通の Arrange は `testUtil.mjs` にまとまっている。
- [ ] `test:small` が `sans-io:check` → `test:sans-io` → workspace テストの順で実行され、`npm run test:small` が通る。
- [ ] `npm run sans-io:scriptc` を Node 24 以上で実行すると、`scriptc@0.4.11` で次がすべて成功する。結果は PR に記載する。
  - 全マーカー付きファイルの coverage（reached / unreached とも blocker 0、crash なし）
  - 各パッケージの facade の網羅確認
  - `scriptc build --lib` smoke（`.lib.a` の生成）
- [ ] Node 24 未満で `sans-io:scriptc` を実行すると、理由を表示して exit 1 になる。
- [ ] ルート `AGENTS.md` に次の追記がある:
  - Sans-I/O の宣言（維持の義務、`node:crypto` を含む Node builtin の実行時 import の禁止、注入の方針、マーカーの付け外しのルール）
  - `Event` 規約の例外
  - Commands への `sans-io:check` / `sans-io:scriptc` の追加
  - Validation（マーカー付きファイルを変更したら `sans-io:scriptc` を手動で実行し、PR に記載する）
  
  既存のパッケージ `AGENTS.md`（rtp / webrtc / ice-server）にはルートへの参照がある。
- [ ] `npm run format` の後もマーカーが 1 行目に残っている。
- [ ] `npm run type` が通る。`npm run doc` の生成物にマーカー由来の差分がない。
- [ ] PR 本文に、後続チケット A〜E（3.4）を「対象外 / 後続」として記載している。
