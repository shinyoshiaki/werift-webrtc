# dependencies / devDependencies の最新化と、common へ吸収できる依存の削減

## 1. 目的と背景

- npm workspace（`packages/*`、`examples/*`、`import-test`）の `dependencies` / `devDependencies` が 2025 年初頭の版のまま止まっている（例: `typescript 5.7.3`、`@biomejs/biome 1.9.4`、`debug 4.4.0`、`@noble/curves 1.8.1`）。
- メジャー更新が溜まっている（TypeScript 6/7、Biome 2、Vitest 5、knip 6、npm-run-all2 9、@noble/curves 2、@peculiar/x509 2 など）。後で一気に上げるほど移行が大変になるので、今回まとめて上げ、壊れた箇所をすべて直す。
- あわせて、自前で簡単に置き換えられるランタイム依存をなくす（`packages/common` へ吸収するか、Node 標準 API に置き換える）。`werift` の公開パッケージが持ち込む推移的依存と、供給網上のリスクを減らすのがねらい。
- 補足: `packages/webrtc` は `src/imports/*.ts` で他パッケージのソースを相対 import し、`lib/` にまとめてビルドする。そのため、下位パッケージのランタイム依存は **`packages/webrtc/package.json` にも同じものが並んでいる**。依存を増減するときは両方を同時に直す必要がある。

## 2. 確定事項（リリース対象と公開 API の扱い）

### 2.1 リリース対象と PR の向き先

- **PR の base は `develop`** とする（ユーザー決定）。リリース対象は、`develop` から出す次のリリースとする。
- 前提となる現状（2026-10-24 時点で確認）:
  - `rc/0.26.0` はすでに `develop` にマージ済み（`96f22931 Merge branch 'rc/0.26.0' into develop`）で、現時点では `develop` と `rc/0.26.0` が同じコミットを指している。そのため `develop` に向けても、0.26.0 系の変更（`SCTP.outboundQueue` の型変更など）を取りこぼすことはない。
  - チケットブランチは `5606629f` で `rc/0.26.0` を取り込み済みだが、`develop` より 10 コミット遅れている（#782 など）。PR を作る前に `develop` をマージして追従する。`package-lock.json` が衝突した場合は、手で直さず `npm install` で再生成する。
- 版番号: リリース時に決める。今回は破壊的変更（2.2 / 2.3）を含むため、**0.25.x のパッチではなく、0.x のマイナー更新（0.26.0 相当）にする**ことを PR 本文に明記する。`werift-dtls` と `werift-common` も公開 API が変わるので、次の公開時にマイナー版を上げる。
- changelog: `develop` の `changelog.md` の先頭は公開済みの `## v0.25.2` である（npm の `werift@latest` も 0.25.2）。この節には追記せず、先頭に **`## Unreleased`** 節を新設してそこに書く。版番号の見出しへの書き換えはリリース作業で行う。
- `develop` 向けに開いている dependabot PR のうち、今回の更新対象と重なるもの（#742 / #781 e2e の `@vitest/browser` 系、#769 / #770 `packages/ice-server/chrome-e2e` の vitest 系、#779 undici / #780 body-parser（いずれも examples））は、今回の PR がマージされたら不要として close する。PR 本文にもそのことを書く。

### 2.2 `CipherContext.localPrivateKey` の型変更 → 破壊的変更として受け入れる。互換ラッパーは作らない

- **決定**: `localPrivateKey` の型を `@fidm/x509` の `PrivateKey` から、Node 標準の **`crypto.KeyObject`** に変更する。互換ラッパー（`toPEM()` / `sign()` を持つ独自クラス）は**作らない**。`changelog.md` の `⚠️ Breaking changes` に移行方法を書くだけで対応する。
- 根拠:
  - リポジトリ内（`packages/*/src`、`examples`、`e2e`、`integration`）で、`localPrivateKey` を `CipherContext` の外から触る箇所はない。値を設定するのは内部の `parseX509()` だけで、読むのも同じクラス内の `signatureData()` / `generateKeySignature()` だけ。利用者が普段使う API（`RTCPeerConnection`、`RTCCertificate`、`DtlsClient` / `DtlsServer` の `cert` / `key` に PEM 文字列を渡す使い方）には影響しない。
  - `@fidm/x509` の `PrivateKey` には `toPEM()` / `sign()` 以外にも多くのメンバー（`version`、`oid`、`algo`、`keyRaw`、`publicKeyRaw`、`toASN1()`、`toDER()`、`toJSON()`）がある。2 メソッドだけのラッパーでは型の互換性を保てず、「互換っぽく見えて実は違う」中途半端な状態になる。
  - ラッパーを公開型にすると、独自の鍵クラスという保守対象が増え、依存を減らすという目的に反する。
  - `develop` の次のリリースには、すでに破壊的変更（`SCTP.outboundQueue` の型変更）が含まれており、もともとマイナー更新になる。
- 互換性を保つもの（変えない）:
  - `RTCCertificate.publicKey` / `privateKey`: PEM 文字列のまま。`privateKey` は PKCS#8（`-----BEGIN PRIVATE KEY-----`）で出力し、改行コードなどの形式も従来と同等にする。現行の出力とテストで比較する。
  - `CipherContext.localCert`: DER の `Buffer` のまま。
  - `parseX509(certPem, keyPem, signatureHash)` のシグネチャ。
- changelog に書く移行方法:
  - `localPrivateKey.toPEM()` → `localPrivateKey.export({ type: "pkcs8", format: "pem" })`
  - `localPrivateKey.sign(data, hash)` → `createSign(hash).update(data).sign(localPrivateKey)`
- あわせて、`werift-dtls` / `werift` の `.d.ts` から `@fidm/x509` の型参照がなくなることを確認する（`lib/**/*.d.ts` を grep する）。

### 2.3 `debug` の互換範囲 → 「`DEBUG` 環境変数で制御する使い方」と「よく使われる API」だけ保つ

- **決定**: `werift-common` の `debug` を、`debug` パッケージの**サブセット互換**の自前実装にする。互換にする範囲は次の表のとおり。
- **受け入れる挙動変化**: 利用者がアプリ側の `debug` パッケージで `require("debug").enable("werift*")` としても、werift のログは**切り替わらなくなる**。これは破壊的変更として changelog に書く。
  - 根拠: werift は `debug@4.4.0` を**固定版**で依存していたため、アプリ側の `debug` と同じインスタンスになるのは npm の重複排除がたまたま効いたときだけだった。この連動はもともと保証された挙動ではない。
  - 代わりに、werift が export する `debug.enable()` / `debug.disable()` を案内する（`import { debug } from "werift"; debug.enable("werift*");`）。
  - 起動時に `DEBUG` 環境変数を指定する方法（README に書かれている `DEBUG=werift* node your-app.js`）は、これまでどおり動く。

| 機能 | 対応 | 補足 |
| --- | --- | --- |
| `debug(namespace)` でロガーを作り、`log(...args)` で出力 | ✅ 互換 | 既存の呼び出し約 31 ファイルは変更しない |
| `DEBUG` 環境変数（カンマ / 空白区切り、`*` ワイルドカード、`-` 先頭の除外） | ✅ 互換 | 除外指定は一致指定より優先する（`debug` と同じ） |
| 書式指定子（`%s` `%d` `%i` `%f` `%j` `%o` `%O` `%%`） | ✅ 互換 | `util.formatWithOptions` に任せる。`%o` は `debug` の 1 行表示と細部が異なってよい（リポジトリ内では書式指定子を使っていない） |
| `debug.enable(namespaces)` / `debug.disable()`（戻り値は直前の設定文字列）/ `debug.enabled(name)` | ✅ 互換 | 実行時に切り替えられる。`enable()` は `process.env.DEBUG` に書き戻さない（werift の中だけで状態を持つ） |
| `logger.enabled`（読み取り） / `logger.namespace` | ✅ 互換 | `enable()` / `disable()` の後も正しい値を返す。全体の設定世代番号を持たせ、ロガー側は世代が変わったときだけ再判定する。ログ無効時の呼び出しは、世代比較 1 回だけで返す（ホットパス対策） |
| 色付け | ✅ 簡易対応 | `process.stderr.isTTY` のとき、namespace のハッシュから 6 色程度の ANSI 色を選んで namespace に付け、行末に `+Nms` を付ける。TTY でないときは、`debug` と同じく先頭に ISO 8601 時刻を付け、色は付けない |
| `DEBUG_COLORS` | ✅ 対応 | `no` / `false` / `0` / `disabled` で色を無効にし、それ以外の値で強制的に有効にする。`NO_COLOR` が設定されている場合も無効にする |
| `DEBUG_HIDE_DATE` / `DEBUG_DEPTH` / `DEBUG_SHOW_HIDDEN` などのその他の `DEBUG_*` | ❌ 非対応 | changelog に「非対応」と明記する |
| `logger.extend()` / `logger.log` / `debug.log` による出力先の差し替え / `debug.formatters` / `logger.destroy()` / `logger.color` / `useColors` / `inspectOpts` | ❌ 非対応 | リポジトリ内で使っていない。必要になったら別チケットで対応する |
| ブラウザ版の `localStorage.debug` | ❌ 非対応 | werift は Node 専用 |

- テストのしやすさのため、**内部用**に出力先を差し替える関数を `log.ts` に用意する（例: `setDebugWriterForTest`。公開 API として案内しない名前にするか、`@internal` を付けて typedoc から除外する）。`ice/tests/ice/turn-protocol-lifecycle.test.ts` の `vi.mock("debug")` は、これか `vi.mock` による `common/src/log` のモックに置き換える。

## 3. 現状調査結果

### 3.1 ランタイム依存（公開パッケージ）

| 依存 | 現行 | 最新 | 使用箇所 | 方針 |
| --- | --- | --- | --- | --- |
| `debug` | 4.4.0（固定） | 4.4.3 | `packages/common/src/log.ts` だけ（`export const debug = Debug.debug`）。各パッケージは `debug("namespace")` を約 31 ファイルで使う。書式指定子（`%o` / `%s` など）は使っていない | **common に自前実装を入れて削除** |
| `buffer` | ^6.0.3 | 6.0.3 | `packages/rtp/src/index.ts` の `import "buffer";` だけ。Node では組み込みの `buffer` に解決されるため、npm パッケージは実質使われていない | **削除**（side-effect import も削除するか、`node:buffer` に変える） |
| `tweetnacl` | ^1.0.3 | 1.0.3 | `dtls/src/cipher/namedCurve.ts`（`nacl.box.keyPair()`）、`dtls/src/cipher/prf.ts`（`nacl.scalarMult`）。X25519 にだけ使っている | **`node:crypto` の X25519 に置き換えて削除** |
| `@noble/curves` | ^1.8.1 | 2.4.0（v2 は ESM-only、Node >=20.19） | `dtls/src/cipher/ec.ts`（P-256 の鍵生成と ECDH） | **`node:crypto.createECDH("prime256v1")` に置き換えて削除**（下記 4.2 参照。v2 に上げると ESM-only・import パス変更・API 名変更の影響が大きいため） |
| `@fidm/x509` | ^1.2.1 | 1.2.1（2022 年以降更新なし） | `dtls/src/context/cipher.ts`（`Certificate.fromPEM().raw`、`PrivateKey.fromPEM()`、`.toPEM()`、`.sign()`）、`webrtc/src/transport/dtls.ts`（`RTCCertificate`）、テスト 2 ファイル | **`node:crypto` の `X509Certificate` / `KeyObject` / `createSign` に置き換えて削除** |
| `@peculiar/x509` | ^1.12.3 | 2.2.0（`reflect-metadata` が依存から外れた） | `dtls/src/context/cipher.ts`（自己署名証明書の生成 `X509CertificateGenerator.createSelfSigned`）、`dtls/examples/*` | **残して 2.x へ更新**（ASN.1/DER で証明書を生成する処理は「簡単に吸収」できる範囲を超える） |
| `multicast-dns` | ^7.2.5 | 7.2.5 | `ice/src/dns/lookup.ts` | **残す**（mDNS / DNS パケット処理を自前で持つのは割に合わない）。`@types/multicast-dns` だけ更新する |
| `mediabunny` | ^1.45.2 | 1.62.1 | `rtp/src/extra/container/mp4`、`webrtc/src/nonstandard/userMedia*`、`polyfill/registers/rtpRtcp.ts` | **残して 1.62.x へ更新** |

### 3.2 ルートの devDependencies

| 依存 | 現行 | 最新 | 注意点 |
| --- | --- | --- | --- |
| `typescript` | 5.7.3 | **7.0.2**（Go ネイティブ版）/ 6.0.3 | `typedoc@0.28` の peer は `typescript 5.0〜6.0.x` まで。**TS 7 にすると `npm run doc` が動かない**ので、**6.0.x に揃える**のが現実的。TS 6 では `moduleResolution: node10`（`module: commonjs` 指定時の暗黙の既定値）、`baseUrl`、`types` の自動読み込みなどが deprecated になったり既定値が変わったりする（下記 4.4） |
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

### 3.3 workspace 以外の package.json

| 場所 | 主な更新対象 | 注意点 |
| --- | --- | --- |
| `examples/package.json` | express 4→5、dotenv 16→18、yargs 17→18、got 11→16（ESM-only）、googleapis 144→188、ring-client-api 13→14、sdp-transform 2→3 | example コードの API 変更に対応する。got / googleapis / ring-client-api の各 example を個別に確認する |
| `examples/e2e`、`examples/turn-loopback` | vite 6→8、@vitejs/plugin-react 4→6（vite 8 が必須）、vitest 5、vite-plugin-node-polyfills 0.28、playwright 1.64、react 19.3 | `npm run examples:e2e` で確認する |
| `e2e/package.json` | `@vitest/browser 3.2.4` → 5.x（`@vitest/browser-playwright` へ分割済み）、`werift ^0.24.3-alpha.0`、`werift-rtp ^0.8.4`、express 5.3、npm-run-all2 9、playwright 1.64 | `e2e/vitest.config.mts` の `/// <reference types="@vitest/browser/providers/playwright" />` や provider 指定を、Vitest 5 の browser provider 形式に移行する。`ts-node-dev` を使っている `server` スクリプトも tsx へ移す |
| `packages/ice-server/chrome-e2e` | vitest 5.0.0 → 5.0.5、`@vitest/browser-playwright` | 軽微 |
| `import-test` | `werift 0.22.7` | 公開版との互換性テスト用。最新公開版（0.25.x）に上げるかどうかを判断する |
| `integration/werift-mediasoup-interop` | 版を固定している | そのディレクトリの `AGENTS.md` に従う。必要がなければ今回は対象外でもよい |
| `website`、`loadtest`、`benchmark` | Docusaurus 2 beta、TS 4 など | workspace 外の旧資産。**対象外**（移行コストが大きく、今回の目的から外れる）とし、チケットに明記する |

## 4. 実装方針

### 4.1 `debug` を common に吸収する

- `packages/common/src/log.ts` に、**2.3 で確定した互換範囲**の自前実装を入れる。`WeriftError` はそのまま残す。
  - `debug(namespace)` は、呼び出し可能な関数オブジェクトを返す。プロパティは `enabled`（getter）と `namespace` を持つ。`debug` 関数自体には `enable` / `disable` / `enabled` を生やす。
  - 型は、export する `Debugger` / `DebugFactory` 相当の自前型で定義する（`@types/debug` には依存しない）。
  - 設定の解決: モジュール読み込み時に `process.env.DEBUG` を一度だけ解釈し、`enable()` / `disable()` で上書きする。一致・除外パターンは正規表現にコンパイルしてキャッシュする。
  - 判定の高速化: 全体の設定世代番号を持たせる。各ロガーは、自分が判定したときの世代と現在の世代が同じなら、キャッシュした `enabled` をそのまま使う。無効時は整形・時刻取得を一切しない。
  - 出力: `process.stderr.write`。TTY かどうかで色付きの形式（`  <色付き namespace> message +Nms`）と時刻付きの形式（`<ISO 時刻> namespace message`）を切り替え、`DEBUG_COLORS` / `NO_COLOR` を反映する。
- `packages/*/package.json` の `"debug"` をすべて削除する（common, dtls, ice, ice-server, rtp, sctp, webrtc）。
- `packages/ice/tests/ice/turn-protocol-lifecycle.test.ts` の `vi.mock("debug", ...)` を置き換える（2.3 末尾のとおり）。
- `packages/ice-server/chrome-e2e/types/debug.d.ts` が不要になれば削除する。
- `common` にテストを追加する。Arrange / Act / Assert の 3 フェーズで書き、Act / Assert には日本語コメントを付ける。出力先の差し替えなどの Arrange は、common のテスト用ユーティリティにまとめる。テストする観点は次のとおり。
  - `DEBUG` のパターン一致（`werift*`、完全一致、カンマ / 空白区切り、`-` 除外の優先）
  - 未指定のとき何も出力しないこと
  - `enable()` / `disable()` の後に、既存ロガーの `enabled` と出力が切り替わること、`disable()` の戻り値
  - 書式指定子の整形
  - TTY / 非 TTY / `DEBUG_COLORS=0` での出力形式
- README のデバッグログの節（`DEBUG=werift* node your-app.js`）に、実行時に切り替える方法（`import { debug } from "werift"; debug.enable("werift*")`）を追記する。アプリ側の `debug` パッケージでは切り替えられない点も書く。

### 4.2 `tweetnacl` と `@noble/curves` を `node:crypto` に置き換える

- P-256（`ec.ts`）
  - 鍵生成: `const ecdh = createECDH("prime256v1"); ecdh.generateKeys();`。`getPublicKey()` は非圧縮 65 バイト（0x04 付き）を返し、noble の `getPublicKey(priv, false)` と同じ形式になる。
  - 共有秘密: `createECDH("prime256v1").setPrivateKey(priv).computeSecret(pub)` は x 座標 32 バイトを返す。noble の `getSharedSecret(...).subarray(1)` と等価。
- X25519（`namedCurve.ts` / `prf.ts`）
  - `generateKeyPairSync("x25519")` で鍵を作り、生の 32 バイトを取り出す（JWK の `d` / `x`、または DER の末尾 32 バイト）。
  - 共有秘密は `diffieHellman({ privateKey, publicKey })` で計算する。生の鍵は、固定の DER プレフィックス（PKCS8: `302e020100300506032b656e04220420`、SPKI: `302a300506032b656e032100`）を付けて `createPrivateKey` / `createPublicKey` に渡す。
- 置き換えたコードは、DTLS パッケージ内（`dtls/src/cipher/ec.ts` など既存のファイル）に置くのが自然。common には置かない（DTLS 固有の暗号処理であり、common は protocol 非依存のユーティリティ層のため）。
- 回帰テスト: 既知のテストベクタ（RFC 7748 の X25519、P-256 の ECDH）で共有秘密が一致することを確認する。dtls の e2e テストと webrtc の DTLS テストが通ることも確認する。

### 4.3 `@fidm/x509` を `node:crypto` に置き換える

- `Certificate.fromPEM(pem).raw` → `new X509Certificate(pem).raw`
- `cert.publicKey.toPEM()` → `x509.publicKey.export({ type: "spki", format: "pem" })`
- `PrivateKey.fromPEM(pem)` → `createPrivateKey(pem)`（`KeyObject`）
- `privateKey.toPEM()` → `export({ type: "pkcs8", format: "pem" })`
- `privateKey.sign(data, hash)` → `createSign(hash).update(data).sign(keyObject)`。ECDSA 署名は DER 形式で出力されるため、従来の出力形式と一致するかを確認する。
- **公開 API への影響**（2.2 で確定）: `CipherContext.localPrivateKey` の型を `KeyObject` に変える。互換ラッパーは作らない。`RTCCertificate.publicKey` / `privateKey`（PEM 文字列）、`localCert`（DER の `Buffer`）、`parseX509()` のシグネチャは維持する。
  - `signatureData()` / `generateKeySignature()` の内部実装は、`createSign(hash).update(data).sign(this.localPrivateKey)` に統一する（従来は PEM 文字列に戻してから署名していたが、その往復をなくす）。
  - 置き換え前後で、同じ鍵・同じデータから得た署名を相手側の公開鍵で `verify` できること、`RTCCertificate.privateKey` の PEM 出力が従来と同等であることを、単体テストで確認する。
- テスト（`dtls/tests/e2e/certificate_request/self.test.ts`、`webrtc/tests/transport/dtls.test.ts`）も `node:crypto` に移す。

### 4.4 TypeScript 6 への移行

- すべての `tsconfig*.json`（ルート、`packages/*`、`e2e`、`examples`）で、`module: "commonjs"` の暗黙の `moduleResolution: node10` が deprecated エラーにならないようにする。
  - 推奨: `module: "commonjs"` + `moduleResolution: "bundler"`（TS 6 でこの組み合わせが許可されているかは要確認）、または `module: "node16"` / `"nodenext"`。CJS の出力形式（`lib/*.js` + `lib/*.mjs`）と `package.json` の `exports` を変えないものを選ぶ。
  - 回避策として `ignoreDeprecations: "6.0"` を使うのは最終手段とする。使った場合はその理由をコメントに残す。
- TS 6 の既定値変更（`types` の扱い、`strict` 既定、`rootDir` 推論、`esModuleInterop` の強制など）で生じる型エラーを根本から直す。
- `typedoc 0.28` + `typedoc-plugin-markdown 4.14` で `npm run doc` を再生成する。

### 4.5 Biome 2 への移行

- `npx @biomejs/biome migrate --write` で `biome.json` を変換する。`examples/biome.json` と `e2e/biome.json` はルートからコピーして使うため（`format:examples` / `format:e2e` スクリプト）、変換後のルート設定で問題がないか確認する。
- Biome 2 で新たに検出されるルールは、既存方針（現在 off にしているルール群）に合わせて設定で揃える。自動修正の差分は、意味を変えない範囲だけ適用する。
- `organize-imports-cli` を削除する場合は、各パッケージの `unused` スクリプトを削除するか、Biome の assist に置き換える。

### 4.6 Vitest 5 / ブラウザ E2E

- `packages/*/vitest.config.mts` と `packages/webrtc/tests/memleak/memleak.vitest.config.mts` が Vitest 5 で動くことを確認する。
- ルートの `vitest.workspace.mjs` を削除するか、`vitest.config` の `projects` へ移行する。
- `e2e` の `@vitest/browser@3` → `vitest@5` + `@vitest/browser-playwright` に移行し、config の `browser.provider` 指定を新形式に直す。

### 4.7 作業順序（推奨）

0. `develop` に追従する（2.1）。
1. 依存の削除・置き換え（`debug`、`buffer`、`tweetnacl`、`@noble/curves`、`@fidm/x509`）を、まず現行のツールチェーンで実装し、テストを通す。
2. ランタイム依存のマイナー・メジャー更新（`mediabunny`、`@peculiar/x509@2`、`multicast-dns` 型）。
3. ツールチェーンの更新（TypeScript 6 → Biome 2 → Vitest 5 → typedoc → knip / npm-run-all2 / tsx / esbuild 明示 / ts-node 系の削除）。
4. `e2e`、`examples`、`examples/e2e`、`import-test`、`ice-server/chrome-e2e` の更新。
5. `npm run doc` の再生成、`changelog.md` / README / `AGENTS.md`（スクリプトを変えた場合）の更新。

## 5. 制約・注意点

- **Node の対応範囲**: `engines.node >=22` を維持する前提で進める。依存の更新で Node 22.12 未満が切り捨てられる場合（Vitest 5、knip 6、organize-imports-cli 1.x、npm-run-all2 9 は dev 専用なので許容範囲）は、**ランタイム依存では起こさない**。`@noble/curves@2` の ESM-only 化は、この観点からも置き換え（削除）で回避する。
- **公開 API の互換性**: `werift` は `common` と `dtls` を `export *` しているため、`debug` や `CipherContext` のフィールド型の変更は公開 API の変更になる。今回受け入れる破壊的変更は、2.2（`localPrivateKey` の型）と 2.3（アプリ側の `debug` パッケージと連動しなくなること、非対応 API）の 2 点に限る。それ以外の公開 API（`RTCCertificate`、`DtlsClient` / `DtlsServer` のオプション、`debug(namespace)` の呼び出し方）は変えない。
- **パッケージ間の依存の一致**: 下位パッケージから依存を削除したら、`packages/webrtc/package.json` からも同時に削除する。逆に依存を追加するときも同様にする。
- **ESM ビルド**: `compile:esm` は `--packages=external` で外部パッケージを import として残す。依存が減った後に、`node lib/index.mjs` と `import-test` が通ることを確認する。
- **生成物**: `doc/` と `packages/*/doc` は手で編集せず、`npm run doc` で再生成する。
- **WPT**: wpt-runner の strict shim は `packages/webrtc/tools/wpt-runner/*` に閉じ込め、`src` に漏らさない。
- **テストの規約**: 新規・修正するテストは Arrange / Act / Assert で書く。Arrange は共通ユーティリティに切り出し、Act / Assert には日本語コメントを付ける。
- **失敗を握りつぶさない**: 型エラーやテスト失敗を `any` キャスト、`ignoreDeprecations`、テストの skip で黙らせない。やむを得ない場合は理由を残す。
- **lock ファイル**: ルートの `package-lock.json` に加え、`examples/`、`e2e/`、`import-test/`、`examples/e2e`、`packages/ice-server/chrome-e2e` の各 lock も更新する。
- **対象外**: `website/`、`loadtest/`、`benchmark/`、`third_party/` は今回の対象外とする。`integration/werift-mediasoup-interop` は、そのディレクトリの方針に従い必要な場合だけ更新する。

## 6. 完了条件

- [ ] `npm outdated`（ルート workspace）で、意図的に据え置いたもの以外に更新漏れがない。据え置いたもの（例: `@types/node` を 22.x に留める、`typescript` を 6.0.x に留める）は、理由をこのチケットまたは PR に記載している。
- [ ] `debug`、`buffer`、`tweetnacl`、`@noble/curves`、`@fidm/x509` が、すべての `packages/*/package.json` の `dependencies` から削除されている。
- [ ] PR の base が `develop` になっていて、`develop` との衝突を解消している。PR 本文に、次のリリースをマイナー更新にする必要があることと、close 対象の dependabot PR を書いている。
- [ ] `packages/common` に、2.3 の表で ✅ とした範囲の debug 互換ロガーがある。`DEBUG=werift*` でログが出ること、未指定時は出ないこと、`debug.enable()` / `disable()` で実行中に切り替わること、`logger.enabled`、書式指定子、色付け / `DEBUG_COLORS` をテストで確認している。
- [ ] X25519 / P-256 の鍵交換と、証明書のパース・署名が `node:crypto` で動き、テストベクタによる単体テストがある。
- [ ] `CipherContext.localPrivateKey` が `KeyObject` 型になっている。ビルドした `lib/**/*.d.ts` に `@fidm/x509` への参照が残っていない。`RTCCertificate.publicKey` / `privateKey` の PEM 出力が従来と同等であることをテストで確認している。
- [ ] `esbuild` が明示的な devDependency として宣言されている。
- [ ] `npm run type`（`type:all` を含む）、`npm run build`、`npm run test:small` が成功する。
- [ ] `npm run doc` で生成ドキュメントを再生成し、コミットしている。
- [ ] `npm run wpt` と `npm run wpt:coverage` が成功する。
- [ ] `npm run e2e` と `npm run examples:e2e` が成功する（環境的に実行できない場合は、その旨と代わりの確認内容を記載する）。
- [ ] `import-test`（`cd import-test && npm test`）で CJS / ESM 両方の import が成功する。
- [ ] `npm run format` が差分なく通る（Biome 2 の設定に移行済み）。
- [ ] `changelog.md` の先頭に新設した `## Unreleased` 節（公開済みの `## v0.25.2` には追記しない）に、次の内容を記載している。
  - `### ⚠️ Breaking changes`: `CipherContext.localPrivateKey` の型変更とその移行方法、`debug` がアプリ側の `debug` パッケージと連動しなくなることと代わりの API、非対応の `DEBUG_*` / API
  - 依存の削除・更新の一覧
- [ ] README のデバッグログの節に、`debug.enable()` の使い方を追記している。スクリプトを変えた場合は、関係する `AGENTS.md` も更新している。
