# dependencies / devDependencies の最新化と、common へ吸収できる依存の削減

## 1. 目的と背景

- npm workspace（`packages/*`、`examples/*`、`import-test`）の `dependencies` / `devDependencies` が 2025 年初頭の版のまま止まっている（例: `typescript 5.7.3`、`@biomejs/biome 1.9.4`、`debug 4.4.0`、`@noble/curves 1.8.1`）。
- メジャー更新が溜まっている（TypeScript 6/7、Biome 2、Vitest 5、knip 6、npm-run-all2 9、@noble/curves 2、@peculiar/x509 2 など）。後で一気に上げるほど移行が大変になるので、今回まとめて上げ、壊れた箇所をすべて直す。
- あわせて、自前で簡単に置き換えられるランタイム依存をなくす（`packages/common` へ吸収するか、Node 標準 API に置き換える）。`werift` の公開パッケージが持ち込む推移的依存と、供給網上のリスクを減らすのがねらい。
- 補足: `packages/webrtc` は `src/imports/*.ts` で他パッケージのソースを相対 import し、`lib/` にまとめてビルドする。そのため、下位パッケージのランタイム依存は **`packages/webrtc/package.json` にも同じものが並んでいる**。依存を増減するときは両方を同時に直す必要がある。

## 2. 現状調査結果

### 2.1 ランタイム依存（公開パッケージ）

| 依存 | 現行 | 最新 | 使用箇所 | 方針 |
| --- | --- | --- | --- | --- |
| `debug` | 4.4.0（固定） | 4.4.3 | `packages/common/src/log.ts` だけ（`export const debug = Debug.debug`）。各パッケージは `debug("namespace")` を約 31 ファイルで使う。書式指定子（`%o` / `%s` など）は使っていない | **common に自前実装を入れて削除** |
| `buffer` | ^6.0.3 | 6.0.3 | `packages/rtp/src/index.ts` の `import "buffer";` だけ。Node では組み込みの `buffer` に解決されるため、npm パッケージは実質使われていない | **削除**（side-effect import も削除するか、`node:buffer` に変える） |
| `tweetnacl` | ^1.0.3 | 1.0.3 | `dtls/src/cipher/namedCurve.ts`（`nacl.box.keyPair()`）、`dtls/src/cipher/prf.ts`（`nacl.scalarMult`）。X25519 にだけ使っている | **`node:crypto` の X25519 に置き換えて削除** |
| `@noble/curves` | ^1.8.1 | 2.4.0（v2 は ESM-only、Node >=20.19） | `dtls/src/cipher/ec.ts`（P-256 の鍵生成と ECDH） | **`node:crypto.createECDH("prime256v1")` に置き換えて削除**（下記 3.2 参照。v2 に上げると ESM-only・import パス変更・API 名変更の影響が大きいため） |
| `@fidm/x509` | ^1.2.1 | 1.2.1（2022 年以降更新なし） | `dtls/src/context/cipher.ts`（`Certificate.fromPEM().raw`、`PrivateKey.fromPEM()`、`.toPEM()`、`.sign()`）、`webrtc/src/transport/dtls.ts`（`RTCCertificate`）、テスト 2 ファイル | **`node:crypto` の `X509Certificate` / `KeyObject` / `createSign` に置き換えて削除** |
| `@peculiar/x509` | ^1.12.3 | 2.2.0（`reflect-metadata` が依存から外れた） | `dtls/src/context/cipher.ts`（自己署名証明書の生成 `X509CertificateGenerator.createSelfSigned`）、`dtls/examples/*` | **残して 2.x へ更新**（ASN.1/DER で証明書を生成する処理は「簡単に吸収」できる範囲を超える） |
| `multicast-dns` | ^7.2.5 | 7.2.5 | `ice/src/dns/lookup.ts` | **残す**（mDNS / DNS パケット処理を自前で持つのは割に合わない）。`@types/multicast-dns` だけ更新する |
| `mediabunny` | ^1.45.2 | 1.62.1 | `rtp/src/extra/container/mp4`、`webrtc/src/nonstandard/userMedia*`、`polyfill/registers/rtpRtcp.ts` | **残して 1.62.x へ更新** |

### 2.2 ルートの devDependencies

| 依存 | 現行 | 最新 | 注意点 |
| --- | --- | --- | --- |
| `typescript` | 5.7.3 | **7.0.2**（Go ネイティブ版）/ 6.0.3 | `typedoc@0.28` の peer は `typescript 5.0〜6.0.x` まで。**TS 7 にすると `npm run doc` が動かない**ので、**6.0.x に揃える**のが現実的。TS 6 では `moduleResolution: node10`（`module: commonjs` 指定時の暗黙の既定値）、`baseUrl`、`types` の自動読み込みなどが deprecated になったり既定値が変わったりする（下記 3.3） |
| `@biomejs/biome` | 1.9.4 | 2.6.2 | `biome.json` の書式が変わる（`files.ignore` → `files.includes` に否定パターン、ルールの移動・改名、`organizeImports` → `assist`）。`npx @biomejs/biome migrate --write` で移行し、その後の `npm run format` で出る差分を確認する |
| `vitest` / `@vitest/coverage-v8` | 4.1.11 | 5.0.5 | Node `^22.12 || ^24 || >=26`、vite 6.4 以上が必要。ルートの `vitest.workspace.mjs` は `defineWorkspace` を使っている（Vitest 4 以降で廃止済みの API で、現在は使われていない可能性が高い）。整理するか、`projects` 形式へ移行する |
| `typedoc` / `typedoc-plugin-markdown` | 0.27.7 / 4.4.2 | 0.28.20 / 4.14.1 | プラグインは `typedoc 0.28.x` が前提。`npm run doc` で再生成し、`doc/` と `packages/*/doc` の差分を確認する |
| `knip` | ^5.44.1 | 6.42.1 | 設定ファイル（`knip.json`、`e2e/knip.json`、`examples/knip.json`）の互換性を確認する |
| `npm-run-all2` | ^7.0.2 | 9.0.4 | **engines が `node ^22.22.2 || ^24.15.0 || >=26`**。CI は Node 24.x なので問題ないが、ローカル開発の要件が上がる |
| `tsx` | ^4.19.3 | 4.23.15 | マイナー更新 |
| `@types/node` | ^22.13.4 | 26.6.5 | `engines.node >=22` に合わせて **22.x 系の最新（22.20.x）に留める**ことを推奨。24 以降の型を使うと Node 22 にない API を誤って使う恐れがある |
| `organize-imports-cli` | ^0.10.0 | 1.0.2（Node >=22.12、ESM） | 各パッケージの `unused` スクリプトでだけ使う。Biome 2 の import 整理（assist）で代わりがきくため、**削除を検討**する |
| `ts-node` / `ts-node-dev` | 10.9.2 / 2.0.0 | 更新停滞 | ルートの `datachannel` / `media`、`dtls` / `sctp` / `ice` の example スクリプトで使っている。**tsx に統一して削除**することを推奨（TS 6 との相性問題も避けられる） |
| `esbuild` | 未宣言（vite / tsx 経由で 0.25.1 が hoist されている） | 0.28.2 | `packages/webrtc` の `compile:esm` が直接使っている。**`packages/webrtc` かルートの devDependencies に明示的に追加する** |
| `istanbul-*`、`v8-to-istanbul`、`@jridgewell/trace-mapping` | 固定版 | マイナー差分あり | `packages/webrtc/tools/wpt-runner/coverageProvider.ts` で使用。`npm run wpt:coverage` で動作を確認する |
| `packageManager` | npm@11.1.0 | — | ローカルは npm 11.16。必要なら更新する |

### 2.3 workspace 以外の package.json

| 場所 | 主な更新対象 | 注意点 |
| --- | --- | --- |
| `examples/package.json` | express 4→5、dotenv 16→18、yargs 17→18、got 11→16（ESM-only）、googleapis 144→188、ring-client-api 13→14、sdp-transform 2→3 | example コードの API 変更に対応する。got / googleapis / ring-client-api の各 example を個別に確認する |
| `examples/e2e`、`examples/turn-loopback` | vite 6→8、@vitejs/plugin-react 4→6（vite 8 が必須）、vitest 5、vite-plugin-node-polyfills 0.28、playwright 1.64、react 19.3 | `npm run examples:e2e` で確認する |
| `e2e/package.json` | `@vitest/browser 3.2.4` → 5.x（`@vitest/browser-playwright` へ分割済み）、`werift ^0.24.3-alpha.0`、`werift-rtp ^0.8.4`、express 5.3、npm-run-all2 9、playwright 1.64 | `e2e/vitest.config.mts` の `/// <reference types="@vitest/browser/providers/playwright" />` や provider 指定を、Vitest 5 の browser provider 形式に移行する。`ts-node-dev` を使っている `server` スクリプトも tsx へ移す |
| `packages/ice-server/chrome-e2e` | vitest 5.0.0 → 5.0.5、`@vitest/browser-playwright` | 軽微 |
| `import-test` | `werift 0.22.7` | 公開版との互換性テスト用。最新公開版（0.25.x）に上げるかどうかを判断する |
| `integration/werift-mediasoup-interop` | 版を固定している | そのディレクトリの `AGENTS.md` に従う。必要がなければ今回は対象外でもよい |
| `website`、`loadtest`、`benchmark` | Docusaurus 2 beta、TS 4 など | workspace 外の旧資産。**対象外**（移行コストが大きく、今回の目的から外れる）とし、チケットに明記する |

## 3. 実装方針

### 3.1 `debug` を common に吸収する

- `packages/common/src/log.ts` に、`debug` 互換の最小実装を入れる。
  - `debug(namespace)` は、`(...args) => void` の形で呼べるロガー関数を返す。
  - `process.env.DEBUG` を解釈する。区切りはカンマまたは空白、`*` はワイルドカード、先頭の `-` は除外指定。README の `DEBUG=werift* node your-app.js` がそのまま動くこと。
  - 出力先は `process.stderr`。`util.formatWithOptions` で整形し、namespace と前回出力からの経過時間（`+Nms`）を付ける。色付けは TTY のときだけ行うか、省略してよい。
  - `enabled` の判定はロガー生成時に一度だけ行う。ログ無効時は no-op として、ホットパス（RTP/SCTP）のオーバーヘッドを増やさない。
  - `debug.enable(ns)` / `debug.disable()` / `logger.enabled` など、外部から使われていそうなプロパティの互換性も検討する。`werift` は `common` を re-export しているため、**`debug` は公開 API** になっている。
- `packages/*/package.json` の `"debug"` をすべて削除する（common, dtls, ice, ice-server, rtp, sctp, webrtc）。
- `packages/ice/tests/ice/turn-protocol-lifecycle.test.ts` の `vi.mock("debug", ...)` を、新しい実装に合わせて書き換える（`common/src/log` のモック、またはロガー差し替えの仕組み）。
- `packages/ice-server/chrome-e2e/types/debug.d.ts` が不要になれば削除する。
- `common` にテストを追加する（namespace の一致判定、除外指定、無効時に何も出力しないこと）。Arrange / Act / Assert の 3 フェーズで書き、Act / Assert には日本語コメントを付ける。

### 3.2 `tweetnacl` と `@noble/curves` を `node:crypto` に置き換える

- P-256（`ec.ts`）
  - 鍵生成: `const ecdh = createECDH("prime256v1"); ecdh.generateKeys();`。`getPublicKey()` は非圧縮 65 バイト（0x04 付き）を返し、noble の `getPublicKey(priv, false)` と同じ形式になる。
  - 共有秘密: `createECDH("prime256v1").setPrivateKey(priv).computeSecret(pub)` は x 座標 32 バイトを返す。noble の `getSharedSecret(...).subarray(1)` と等価。
- X25519（`namedCurve.ts` / `prf.ts`）
  - `generateKeyPairSync("x25519")` で鍵を作り、生の 32 バイトを取り出す（JWK の `d` / `x`、または DER の末尾 32 バイト）。
  - 共有秘密は `diffieHellman({ privateKey, publicKey })` で計算する。生の鍵は、固定の DER プレフィックス（PKCS8: `302e020100300506032b656e04220420`、SPKI: `302a300506032b656e032100`）を付けて `createPrivateKey` / `createPublicKey` に渡す。
- 置き換えたコードは、DTLS パッケージ内（`dtls/src/cipher/ec.ts` など既存のファイル）に置くのが自然。common には置かない（DTLS 固有の暗号処理であり、common は protocol 非依存のユーティリティ層のため）。
- 回帰テスト: 既知のテストベクタ（RFC 7748 の X25519、P-256 の ECDH）で共有秘密が一致することを確認する。dtls の e2e テストと webrtc の DTLS テストが通ることも確認する。

### 3.3 `@fidm/x509` を `node:crypto` に置き換える

- `Certificate.fromPEM(pem).raw` → `new X509Certificate(pem).raw`
- `cert.publicKey.toPEM()` → `x509.publicKey.export({ type: "spki", format: "pem" })`
- `PrivateKey.fromPEM(pem)` → `createPrivateKey(pem)`（`KeyObject`）
- `privateKey.toPEM()` → `export({ type: "pkcs8", format: "pem" })`
- `privateKey.sign(data, hash)` → `createSign(hash).update(data).sign(keyObject)`。ECDSA 署名は DER 形式で出力されるため、従来の出力形式と一致するかを確認する。
- **公開 API への影響**: `CipherContext.localPrivateKey` の型は `@fidm/x509` の `PrivateKey` で、`werift` から re-export されている。`KeyObject` に変えると型が変わる（破壊的変更）。そのため `changelog.md` に記載し、必要に応じて互換用のラッパー（`toPEM()` / `sign()` を持つ小さなクラス）を用意するかを判断する。`RTCCertificate.publicKey` / `privateKey` が PEM 文字列であることは維持する。
- テスト（`dtls/tests/e2e/certificate_request/self.test.ts`、`webrtc/tests/transport/dtls.test.ts`）も `node:crypto` に移す。

### 3.4 TypeScript 6 への移行

- すべての `tsconfig*.json`（ルート、`packages/*`、`e2e`、`examples`）で、`module: "commonjs"` の暗黙の `moduleResolution: node10` が deprecated エラーにならないようにする。
  - 推奨: `module: "commonjs"` + `moduleResolution: "bundler"`（TS 6 でこの組み合わせが許可されているかは要確認）、または `module: "node16"` / `"nodenext"`。CJS の出力形式（`lib/*.js` + `lib/*.mjs`）と `package.json` の `exports` を変えないものを選ぶ。
  - 回避策として `ignoreDeprecations: "6.0"` を使うのは最終手段とする。使った場合はその理由をコメントに残す。
- TS 6 の既定値変更（`types` の扱い、`strict` 既定、`rootDir` 推論、`esModuleInterop` の強制など）で生じる型エラーを根本から直す。
- `typedoc 0.28` + `typedoc-plugin-markdown 4.14` で `npm run doc` を再生成する。

### 3.5 Biome 2 への移行

- `npx @biomejs/biome migrate --write` で `biome.json` を変換する。`examples/biome.json` と `e2e/biome.json` はルートからコピーして使うため（`format:examples` / `format:e2e` スクリプト）、変換後のルート設定で問題がないか確認する。
- Biome 2 で新たに検出されるルールは、既存方針（現在 off にしているルール群）に合わせて設定で揃える。自動修正の差分は、意味を変えない範囲だけ適用する。
- `organize-imports-cli` を削除する場合は、各パッケージの `unused` スクリプトを削除するか、Biome の assist に置き換える。

### 3.6 Vitest 5 / ブラウザ E2E

- `packages/*/vitest.config.mts` と `packages/webrtc/tests/memleak/memleak.vitest.config.mts` が Vitest 5 で動くことを確認する。
- ルートの `vitest.workspace.mjs` を削除するか、`vitest.config` の `projects` へ移行する。
- `e2e` の `@vitest/browser@3` → `vitest@5` + `@vitest/browser-playwright` に移行し、config の `browser.provider` 指定を新形式に直す。

### 3.7 作業順序（推奨）

1. 依存の削除・置き換え（`debug`、`buffer`、`tweetnacl`、`@noble/curves`、`@fidm/x509`）を、まず現行のツールチェーンで実装し、テストを通す。
2. ランタイム依存のマイナー・メジャー更新（`mediabunny`、`@peculiar/x509@2`、`multicast-dns` 型）。
3. ツールチェーンの更新（TypeScript 6 → Biome 2 → Vitest 5 → typedoc → knip / npm-run-all2 / tsx / esbuild 明示 / ts-node 系の削除）。
4. `e2e`、`examples`、`examples/e2e`、`import-test`、`ice-server/chrome-e2e` の更新。
5. `npm run doc` の再生成、`changelog.md` / README / `AGENTS.md`（スクリプトを変えた場合）の更新。

## 4. 制約・注意点

- **Node の対応範囲**: `engines.node >=22` を維持する前提で進める。依存の更新で Node 22.12 未満が切り捨てられる場合（Vitest 5、knip 6、organize-imports-cli 1.x、npm-run-all2 9 は dev 専用なので許容範囲）は、**ランタイム依存では起こさない**。`@noble/curves@2` の ESM-only 化は、この観点からも置き換え（削除）で回避する。
- **公開 API の互換性**: `werift` は `common` と `dtls` を `export *` しているため、`debug` や `CipherContext` のフィールド型の変更は公開 API の変更になる。破壊的変更が避けられない場合は `changelog.md` に明記する。
- **パッケージ間の依存の一致**: 下位パッケージから依存を削除したら、`packages/webrtc/package.json` からも同時に削除する。逆に依存を追加するときも同様にする。
- **ESM ビルド**: `compile:esm` は `--packages=external` で外部パッケージを import として残す。依存が減った後に、`node lib/index.mjs` と `import-test` が通ることを確認する。
- **生成物**: `doc/` と `packages/*/doc` は手で編集せず、`npm run doc` で再生成する。
- **WPT**: wpt-runner の strict shim は `packages/webrtc/tools/wpt-runner/*` に閉じ込め、`src` に漏らさない。
- **テストの規約**: 新規・修正するテストは Arrange / Act / Assert で書く。Arrange は共通ユーティリティに切り出し、Act / Assert には日本語コメントを付ける。
- **失敗を握りつぶさない**: 型エラーやテスト失敗を `any` キャスト、`ignoreDeprecations`、テストの skip で黙らせない。やむを得ない場合は理由を残す。
- **lock ファイル**: ルートの `package-lock.json` に加え、`examples/`、`e2e/`、`import-test/`、`examples/e2e`、`packages/ice-server/chrome-e2e` の各 lock も更新する。
- **対象外**: `website/`、`loadtest/`、`benchmark/`、`third_party/` は今回の対象外とする。`integration/werift-mediasoup-interop` は、そのディレクトリの方針に従い必要な場合だけ更新する。

## 5. 完了条件

- [ ] `npm outdated`（ルート workspace）で、意図的に据え置いたもの以外に更新漏れがない。据え置いたもの（例: `@types/node` を 22.x に留める、`typescript` を 6.0.x に留める）は、理由をこのチケットまたは PR に記載している。
- [ ] `debug`、`buffer`、`tweetnacl`、`@noble/curves`、`@fidm/x509` が、すべての `packages/*/package.json` の `dependencies` から削除されている。
- [ ] `packages/common` に debug 互換ロガーがあり、`DEBUG=werift*` でログが出る。未指定時は出ない。どちらもテストで確認している。
- [ ] X25519 / P-256 の鍵交換と、証明書のパース・署名が `node:crypto` で動き、テストベクタによる単体テストがある。
- [ ] `esbuild` が明示的な devDependency として宣言されている。
- [ ] `npm run type`（`type:all` を含む）、`npm run build`、`npm run test:small` が成功する。
- [ ] `npm run doc` で生成ドキュメントを再生成し、コミットしている。
- [ ] `npm run wpt` と `npm run wpt:coverage` が成功する。
- [ ] `npm run e2e` と `npm run examples:e2e` が成功する（環境的に実行できない場合は、その旨と代わりの確認内容を記載する）。
- [ ] `import-test`（`cd import-test && npm test`）で CJS / ESM 両方の import が成功する。
- [ ] `npm run format` が差分なく通る（Biome 2 の設定に移行済み）。
- [ ] `changelog.md` に、依存の削除・更新と公開 API の変更点（`CipherContext.localPrivateKey` の型など）を記載している。スクリプトを変えた場合は、関係する `AGENTS.md` も更新している。
