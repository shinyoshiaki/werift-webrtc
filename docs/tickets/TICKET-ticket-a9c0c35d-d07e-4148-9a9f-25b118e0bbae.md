# packages 以下の scriptc ライブラリビルド可能な Sans-I/O モジュールにマーカーを付け、AGENTS.md でその性質の維持を宣言する

- 調査基準: `ticket/a9c0c35d-…` HEAD `7839e34cf`（develop `739bf515e` + チケットファイル作成のみ）
- 調査環境: Node.js v24.18.0 / Linux x64、`scriptc@0.4.11`（npm latest。`/tmp` に一時インストールして実測。リポジトリには何も追加していない）
- 対象: `packages/{common,ice,dtls,rtp,sctp,webrtc,ice-server}/src`、ルート `AGENTS.md`（必要に応じてパッケージ `AGENTS.md`）

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
| 暗号 / ハッシュ API（`node:crypto`） | 外部 I/O ではないが、scriptc の対応範囲が部分的で、host 実装への依存になるため禁止する（下の「判断が必要な点」も参照） |

- 時刻・乱数・送信・タイマーが必要なら、引数や戻り値（例: `now: number` を受け取り、送るパケットの配列を返す）で呼び出し側から注入する。
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
- 出力の既定先は `.scriptc/<name>`。リポジトリ内で build する場合は `.gitignore` に `.scriptc/` を加える（coverage は何も書き出さないことを確認済み）。

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

### 3.3 マーカー付与候補（第 1 段階: コード変更なしで両条件を満たすもの）

coverage が exit 0 で、Explore 調査（推移的 import を含む I/O 判定）でも pure と判定されたもの。**実装時に 2 章の検証スクリプトで最終確認する。**

| パッケージ | ファイル（`src/` 相対） |
| --- | --- |
| common | `asn1.ts`、`binaryData.ts`、`crc.ts`、`number.ts`、`queue.ts` |
| dtls | `cipher/const.ts`、`cipher/key-exchange.ts`、`cipher/suites/null.ts`、`context/srtp.ts`、`handshake/const.ts`、`handshake/extensions/extendedMasterSecret.ts`、`record/antiReplayWindow.ts`、`record/const.ts` |
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

### 3.4 第 2 段階以降の候補（このチケットでは付与しない。後続チケットで扱う）

- **barrel 由来だけで失敗している約 90 ファイル**: `rtp/src/{codec,rtcp,rtp,srtp/packet}/**`、`dtls/src/{handshake,record/message,record/builder,util/binary}/**`、`webrtc/media/extension/rtpExtension.ts` など。必要な作業:
  1. `common/src/binary.ts` から `random16` / `random32` を別ファイル（例: `common/src/random.ts`）へ分ける。`common/src/index.ts` から引き続き re-export して、公開 API は変えない。
  2. マーカー候補の import を barrel から leaf（`common/src/binary`、`common/src/crc` など）へ書き換える。
  3. `log.ts` に依存しているファイル（`dtls/record/receive.ts`、`dtls/context/dtls.ts` など）は、ログを外すかログ関数を注入する。
- **固有の blocker を持つファイル**: `sctp/chunk.ts`（class 継承の書き換えが必要）、`rtp/rtcp/psfb/index.ts`、`dtls/handshake/extensions/useSrtp.ts`、`ice-server/stun/attributes.ts`（`node:net` の `isIPv4` / `isIPv6`）など。
- **時刻・乱数の注入だけで済みそうなもの**: `dtls/handshake/random.ts`、`webrtc/sdp.ts`（session id の `randomBytes`）、`rtp/extra/processor/jitterBuffer.ts`。

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

## 4. 実装内容

### 4.1 マーカーコメントの仕様

- 書式（1 行、`//` コメント）:

  ```ts
  // werift:sans-io — no I/O, scriptc --lib buildable. Keep it so (see AGENTS.md "Sans-I/O modules").
  ```

  - 機械判定には行頭の `// werift:sans-io` だけを使う。説明文の言い回しは実装時に調整してよいが、全ファイルで同じ文面にする。
  - `/** */` にはしない。TypeDoc が module コメントとして拾い、`npm run doc` の生成物が変わるのを避けるため。
- 位置: **ファイルの 1 行目**。既存の `/*!` ライセンスヘッダ、RFC コメント、パケット図よりも前に置く。直後に既存ヘッダがなく import が続く場合は空行を 1 行入れる（Biome の import 並べ替え対策）。
- 第 1 段階では 3.3 の候補にだけ付与する。

### 4.2 検証スクリプト

- 例: `tools/scriptc/check-sans-io.mjs`。ルート `package.json` に `"scriptc:check"` を追加する。
- 処理:
  1. **マーカーの列挙**: `packages/*/src/**/*.ts` のうち、1 行目が `// werift:sans-io` のファイルを集める。
  2. **closure 判定**（scriptc なしで実行でき、高速）:
     - マーカー付きファイルの実行時 import（`import type` / `export type` は除外）が、すべてマーカー付きファイルへ解決されること。
     - barrel（`index.ts`、`imports/*.ts`）、Node builtin、外部 npm パッケージの import がないこと。
  3. **禁止 API の静的検査**: 2 章の表の識別子（`setTimeout`、`Date.now`、`process.`、`Math.random`、`new Event`、`async` など）。コメントと文字列は除外する。
  4. **scriptc 判定**:
     - 各マーカー付きファイルに `scriptc coverage --fail-on blockers --print diagnostics` を並列実行する。
     - reached / unreached を問わず blocker が 0 であること。
     - exit 134（scriptc の crash）も失敗として扱う。
  5. **ライブラリビルドの smoke**:
     - パッケージごとに `packages/<pkg>/scriptc/entry.mts`（マーカー付きモジュールを `bytes` / 数値の facade 関数で包み、class API も呼び出し経路に乗せる）と `profile.json` を置く。
     - `scriptc build --lib --profile` で `.lib.a` が出力先（`$TMPDIR` か gitignore した `.scriptc/`）に生成されることを確認する。
     - facade は主要 API（parse → serialize の round trip など）を最低 1 つずつ通せばよい。全 export を ABI に出す必要はない。
- scriptc は `npx --yes scriptc@<固定バージョン>` で起動し、**devDependencies には入れない**（Node 24 以上が必要、バイナリが大きい、experimental）。バージョンはスクリプト内の定数で固定し、上げるときは全マーカーファイルを再検証する。
- 手順 2 と 3 は scriptc なしで動くので、`--no-scriptc`（または別 script `scriptc:check:static`）で単独実行できるようにする。これを `npm run test:small` か `ci` に組み込むかは、後述の「判断が必要な点」で決める。

### 4.3 AGENTS.md の更新

- **ルート `AGENTS.md`**（リポジトリ全体の規約なのでルートに置く）:
  - Do に「Sans-I/O modules」の項目を追加する。内容:
    - 1 行目に `// werift:sans-io` があるファイルは、Sans-I/O（2 章の定義）で scriptc ライブラリビルド可能な状態を保つ。
    - I/O、時刻、乱数、`Event`、ログ、`async`、barrel import を持ち込まない。必要なものは引数・戻り値で注入する。
    - 実行時に import してよいのはマーカー付きファイルだけ。
    - 新しく条件を満たしたファイルにはマーカーを付ける。
  - Do 3（`Event` で通知する規約）に「Sans-I/O modules を除く」と追記する。
  - Don't に追加する: 性質を壊す変更をするためにマーカーを黙って外さない。外す場合は理由を PR に書き、呼び出し側の分離（I/O を外側に出す）を先に検討する。
  - Commands の表に `npm run scriptc:check` を追加する（`scriptc:check:static` を作るならそれも）。
  - Validation に追加する: マーカー付きファイルを変更したら `npm run scriptc:check` を実行する。Node 24 以上が必要。
- **パッケージ `AGENTS.md`**:
  - 既存の `rtp` `webrtc` `ice-server` には、ルートの規約を参照する 1 行だけを Do に足す（ファイル一覧は書かない。一覧はマーカーそのものが正とする）。
  - `common` `ice` `dtls` `sctp` に、このためだけの `AGENTS.md` を新しく作ることはしない。ルートの規約で足りる。
- Maintenance 規約に従い、`AGENTS.md` の章立ては変えない。

### 4.4 その他

- `.gitignore` に `.scriptc/` を追加する（リポジトリ内で build する場合）。
- `changelog.md` / README: 公開 API は変わらないので必須ではない。開発者向けの一文を入れるかどうかは任意。
- `npm run doc`: `//` コメントは生成ドキュメントに影響しないはず。念のため 1 パッケージで差分が出ないことを確認する。

## 5. 制約と注意点

- **scriptc は experimental（0.4.x）。** 診断コードと対応範囲はバージョンで変わる。バージョンを固定し、`AGENTS.md` には「固定バージョンで検証する」とだけ書く（細かい対応表は書かない）。
- **coverage が通ることと Sans-I/O であることは別の条件。** scriptc は `crypto` / timer / `events` などの Node API も一部 lower できるので、coverage が通っても I/O を持つことがある（`dtxCallback.ts` の例）。closure 判定と禁止 API 検査は必ず併用する。
- **ファイル単体の coverage は export の本体を取りこぼすことがある**（`dtls/helper.ts`）。facade エントリ経由の判定を省略しない。
- **barrel の再 export が最大の障害。** マーカー付きファイルは `imports/common.ts` や `common/src/index.ts` を経由してはならない。第 1 段階では import の書き換えをしない。
- 既存のファイル先頭コメント（`/*!` ライセンス、RFC 番号、パケット図）は消さず、マーカーをその上に 1 行足すだけにする。
- 公開 API（`random16` の export 元など）、`build`、型生成（`type:public`）に影響する変更は第 1 段階では行わない。
- 検証で使う一時 worktree は `git worktree add --detach` で作り、終わったら削除する（root `AGENTS.md` Do 7）。scriptc の出力先はリポジトリの外か、gitignore したディレクトリにする。
- 長い検証の前には、revision・未コミット差分・意図を書き残す（root `AGENTS.md` Do 8）。
- 検証用エントリは `.mts` にする（SC1013）。type-check の対象に入れるなら tsconfig の `include` を確認し、`erasableSyntaxOnly` に反しない書き方にする。

## 6. 判断が必要な点（実装開始前に決める）

1. **`node:crypto` の扱い**: 2 章では禁止にした。許可すれば SRTP の context（AES-CTR / GCM）や STUN の HMAC も候補に入るが、それは「純粋な計算だが host の実装に依存する」領域になる。推奨は禁止のままにして、暗号は呼び出し側から注入すること。
2. **CI への組み込み**: 推奨は、scriptc を使わない静的検査（closure + 禁止 API）を `npm run test:small` か `ci` に入れ、scriptc を使う判定は手動または nightly にすること。
3. **第 2 段階（barrel 解消、`random` の分離）をこのチケットに含めるか**: 推奨は別チケット。第 1 段階は「規約と検査の土台 + 今満たしているファイルへの付与」に絞る。

## 7. 完了条件

- [ ] 4.1 の書式のマーカーが、3.3 の候補（検証スクリプトで最終確認したもの）の 1 行目にあり、既存のヘッダコメントを壊していない。
- [ ] `npm run scriptc:check` を Node 24 以上で実行すると、全マーカー付きファイルについて次が成功する: closure 判定、禁止 API 検査、`scriptc coverage --fail-on blockers`（reached / unreached とも blocker 0）、各パッケージの `scriptc build --lib` smoke（`.lib.a` の生成）。
- [ ] マーカーのないファイルを実行時に import する、または `setTimeout` などを追加すると、検証スクリプトが失敗する（スクリプト自体のテスト、または手動確認の手順を PR に記載する）。
- [ ] ルート `AGENTS.md` に、Sans-I/O の宣言（維持の義務、注入の方針、マーカーの付け外しのルール）、`Event` 規約の例外、Commands / Validation への追記がある。既存のパッケージ `AGENTS.md` にはルートへの参照がある。
- [ ] `npm run format` の後もマーカーが 1 行目に残っている。
- [ ] `npm run type` と `npm run test:small` が通る。`npm run doc` の生成物にマーカー由来の差分がない。
- [ ] 第 2 段階の候補（3.4）を後続チケットとして起票するか、このチケットの「対象外」に明記している。
