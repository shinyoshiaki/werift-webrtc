# Actions run 33861074032 の CI 失敗を修正する

対象: [Node CI / run 33861074032](https://github.com/shinyoshiaki/werift-webrtc/actions/runs/33861074032)

失敗コミット: `ebcbebc7d773c6cff03f24cca3707c285dbe3849` (`feature/polyfill`)

Node のサポート対象下限は 22 とし、GitHub Actions での代表検証は Node 24 のみで行う。Node 22 との互換性は fixture のコマンド設計・ローカル検証で担保し、CI matrix を Node 22/24 の両方で実行することは完了条件にしない。

## 1. タスクの目的と背景

polyfill ブランチへ push された上記コミットで、GitHub Actions の matrix job が失敗した。対象コミット自体は E2E 対象外 example の `examples/untested/` への移動が中心であり、ログ上の失敗箇所はその変更内容ではなく、先行して追加された polyfill 型テストと mediasoup 相互接続 CI のクリーン環境対応にある。修正後はサポート下限を Node 22 に合わせ、Actions の実行対象を Node 24 に整理する。

失敗は次の 3 系統で、それぞれ独立して修正が必要である。

| Job | 失敗箇所 | ログで確認した直接原因 |
| --- | --- | --- |
| `build (18.x)`（修正前の matrix） | `npm run ci` → `test:small` → `packages/webrtc/tests/nonstandard/polyfill.test.ts` | `public polyfill entry compiles with TypeScript DOM lib` が Vitest 既定の 5 秒を超過。再試行後も `Test timed out in 5000ms`。型エラーは出ていない |
| `mediasoup-interop (22.x)` | fixture の `npm run test:small` | Node `v22.23.2` が `--test-isolation=process` を認識せず、`bad option`、exit code 9 |
| `mediasoup-interop (24.x)` | fixture の `npm run test:small` | 親 checkout の TypeScript source を直接 import した際、`packages/common/src/log.ts` から `debug` を解決できず `MODULE_NOT_FOUND` |

このため、目的は polyfill や RTP/DTLS の挙動を変更することではなく、Node 22 以上をサポートするリポジトリの検証を、Node 24 の GitHub Actions と Node 22/24 の双方で利用可能な mediasoup/Playwright fixture コマンドにより、クリーン checkout でも再現可能に完走させることである。

## 2. 実装すべき具体的な機能や変更内容

### 2.1 Node 22/24 共通で動く fixture テストコマンドにする

`integration/werift-mediasoup-interop/package.json` の次の scripts から、明示指定している `--test-isolation=process` を削除する。

- `test:small`
- `test:source-import`
- `test:interop`
- `test:browser`

`--test-concurrency=1` は維持する。Node test runner の既定 isolation は `process` であるため、明示フラグを外しても、テストファイルごとの process isolation と直列実行という現在の意図は維持できる。

Node 22 系では同機能のフラグ名が `--experimental-test-isolation` のままで、`--test-isolation` への rename は Node 23.6.0 で行われた。バージョン分岐や experimental 名への置換は行わず、Node 22/24 の双方で既定値を利用する。Actions では Node 24 のみを実行するが、fixture のコマンドはサポート下限である Node 22 でも動作可能でなければならない。根拠は [Node.js CLI documentation (`--test-isolation`)](https://nodejs.org/api/cli.html#--test-isolationmode) と [Node.js v22 documentation (`--experimental-test-isolation`)](https://nodejs.org/download/release/v22.18.0/docs/api/cli.html#--experimental-test-isolationmode) を参照する。

fixture は独立 submodule なので、修正は `shinyoshiaki/werift-mediasoup-interop` 側へ commit/push したうえで、親リポジトリの `integration/werift-mediasoup-interop` gitlink をその到達可能な commit SHA へ更新する。

### 2.2 mediasoup job で親 werift workspace の依存もインストールする

`.github/workflows/nodejs.yml` の `mediasoup-interop` job に、リポジトリルートを working directory とする `npm ci` を追加する。その後、現在どおり `integration/werift-mediasoup-interop` でも `npm ci` を行う。

両方が必要な理由は次のとおり。

- fixture 自身の `node_modules` は `mediasoup`、`mediasoup-client`、`tsx`、Playwright 等を供給する。
- fixture は build 済み `werift` package ではなく、親 checkout の `packages/webrtc/src/polyfill/index.ts` を `tsx` で直接 import する。
- 親 source から始まる Node の package 解決は `packages/common/src/log.ts` から上位の親 checkout を探索するため、fixture 配下だけで `npm ci` しても `integration/.../node_modules` は探索対象にならない。
- `debug` は `packages/common/package.json` とルート `package-lock.json` に正しく宣言済みであり、依存宣言漏れではない。クリーンな mediasoup job が親 workspace の install を省いていることが原因である。

`debug` だけを fixture の dependencies に重複追加したり、`NODE_PATH` で探索先をねじ曲げたりしない。親 TypeScript source の依存一式は、親 lockfile に基づく root `npm ci` で供給する。

Node 22 の実行は現在、不正 CLI option の解析段階で先に終了している。2.1 の修正後は Node 24 と同じ依存解決経路へ進めるため、Actions では Node 24 を検証しつつ、Node 22 でも同じ fixture コマンドを利用できる状態にする。2.2 は実行対象を限定せず、fixture が親 source を import する経路の依存解決を修正する。

### 2.3 TypeScript compile fixture に限定した現実的な timeout を設定する

`packages/webrtc/tests/nonstandard/polyfill.test.ts` の次の 2 テストは、テストプロセス内で `typescript/bin/tsc` を子プロセス実行するため、通常の単体テストより時間がかかる。

- `public polyfill entry compiles with TypeScript DOM lib`
- `public polyfill entry compiles without DOM lib`

GitHub Actions では DOM ありテストが再試行込み 14.959 秒で失敗し、DOM なしテストも再試行込み 9.207 秒を要した。一方、同じコマンドの手元での実測は約 1.9 秒 / 1.2 秒であり、型エラーではなく、3 worker で他テストと並行する CI runner の負荷に対して Vitest 既定 5 秒が短すぎることが原因である。

対応は以下とする。

- 上記 2 テストだけに 30 秒程度の明示的な test timeout を設定し、全テストの timeout は引き上げない。
- `spawnSync` 側にも有限 timeout を持たせ、TypeScript compiler が本当に停止した場合は無期限に worker を塞がないようにする。
- compiler path 解決、fixture project path 組み立て、プロセス実行の共通 Arrange は、既存の `packages/webrtc/tests/nonstandard/polyfillTestUtils.ts` へ helper として集約する。
- `result.status === 0` の検証を残し、TS2403 / TS2687 / TS2717 等の実際の型エラーを timeout 緩和で見逃さない。子プロセス timeout の場合も、型不一致とは区別できる失敗メッセージにする。
- 変更後のテストでも Act / Assert の日本語コメントを維持する。

### 2.4 CI コマンドの重複を整理する

mediasoup job は現在 `npm run test:small` の直後に `npm test` を実行しているが、fixture の `npm test` は `test:small && test:interop` なので small suite を二度実行する。CI では意図を明確にするため、次のいずれかに統一する。

```text
npm run type
npm run test:small
npm run test:interop
npm run install:browsers
npm run test:browser
```

または、個別ログが不要なら `npm run type` → `npm test` → browser の順とする。推奨は失敗領域が job log から明確になる前者である。テスト範囲は減らさない。

### 2.5 Node サポート方針に合わせて CI matrix を整理する

GitHub Actions の Node matrix から Node 18 と Node 22 の実行枠を外し、Node 24 を検証対象として残す。package の `engines`、README、workflow のコメントなどに Node のサポート方針を記載している箇所があれば、最低サポート Node 22 / CI 検証 Node 24 という表記に同期する。Node 22 を CI matrix から外すことはサポート対象外にすることを意味しないため、fixture の共通コマンドや package の型・テスト実行方法に Node 22 固有の非互換引数を残さない。

### 2.6 対象外だが確認すべき警告

修正前の Node 18 job では root lockfile が `playwright@1.62.1` を解決し、同 package の Node `>=20` engine 警告も出ている。ただし対象 run では install と Chromium download は成功しており、直接の失敗原因は compile fixture の timeout である。Node 24 の代表 CI でも同じ警告が実害化した場合のみ、Playwright の exact version 固定または依存 version の整合を追加対応する。

## 3. 技術的な実装アプローチ（調査結果サマリ）

1. 対象 Actions run の job/step/log を `gh run view` で取得し、3 job の終了点を比較した。
2. Node 22 はテストコードを読み込む前に CLI option で終了している。`--test-isolation=process` を省略しても既定が process isolation なので、互換性だけを直せる。
3. Node 24 は fixture の install/type-check を通過後、最初の runtime source import で `debug` を見失っている。require stack は `packages/common/src/log.ts` → `packages/common/src/index.ts` → `packages/webrtc/src/.../polyfill` で、依存の所有者が親 workspace であることを示している。
4. `.github/workflows/nodejs.yml` を確認すると、通常の `build` job はルートで `npm i` する一方、`mediasoup-interop` job は submodule 内でしか `npm ci` していない。この job 間の install 差がローカル成功 / CI 失敗の差である。
5. 修正前の Node 18 job の失敗テストは `spawnSync` で `tsc -p` を実行し、Vitest config の timeout は既定 5 秒のまま、worker 数は 3、retry は 1 である。ログには compiler diagnostics がなく、時間超過のみが記録されているため、型の回帰ではなく timeout 設計の問題と判断した。matrix を Node 24 に整理した後も同じ compile test の負荷対策を適用する。
6. 修正は `.github/workflows/nodejs.yml`、`packages/webrtc/tests/nonstandard/polyfill.test.ts`、`packages/webrtc/tests/nonstandard/polyfillTestUtils.ts`、および interop submodule の `package.json` / 親 gitlink に限定できる。polyfill 実装、examples の移動内容、RTP/DTLS/SCTP 実装は変更不要である。

## 4. 考慮すべき制約や注意点

- `integration/werift-mediasoup-interop` 配下を変更する前に同ディレクトリの `AGENTS.md` に従う。submodule の修正 commit を公開 repository へ到達可能にしてから親 gitlink を更新する。
- Node 22 はサポート対象として維持するが、GitHub Actions の Node matrix は Node 24 のみにする。CI matrix から Node 22 を外すことを、Node 22 で動作しなくてよいという意味にしない。
- fixture の process isolation と `--test-concurrency=1` は、polyfill のグローバル差し替え、worker/socket/Chromium cleanup、ポート競合を避けるため維持する。
- root `npm ci` と fixture `npm ci` は責務が異なる。片方に統合せず、各 lockfile を使ってそれぞれの依存を再現する。
- `npm install` ではなく CI 向けの `npm ci` を使い、lockfile を暗黙更新しない。
- compile test の timeout は対象 2 件だけに設定する。Vitest 全体の timeout 増加や retry 追加で、他の hang / resource leak を隠さない。
- `spawnSync` は event loop を塞ぐため、Vitest timeout だけでは停止した子プロセスを即座に中断できない。子プロセス自身の timeout も設定する。
- `npm run test:browser` は fake media と loopback ICE を使う現行仕様を維持し、ブラウザ側へ polyfill を注入しない。
- 修正前の `build (18.x)` の `examples e2e` step は今回の失敗により skip されている。Node 24 の代表 CI では部分テストの成功だけで完了とせず、修正後に examples e2e 相当の step まで到達することを確認する。
- 本チケットの修正で package scripts や安定した validation 手順の意味を変更した場合のみ、対応する `AGENTS.md` / README を同期する。単に冗長な CLI option を外しコマンド名が変わらない場合は、不要な文書差分を作らない。

## 5. 完了条件

- [ ] `integration/werift-mediasoup-interop/package.json` の全 Node test scripts が Node 22/24 共通の引数で起動し、`--test-isolation=process` による `bad option` が発生しない
- [ ] `--test-concurrency=1` と既定の process isolation が維持され、fixture のテスト間で WebRTC globals、worker、socket、timer、Chromium process が共有・残留しない
- [ ] interop submodule の修正 commit が remote から取得可能で、親 repository の gitlink がその SHA を指している
- [ ] mediasoup job が親ルートと `integration/werift-mediasoup-interop` の双方で lockfile ベースの `npm ci` を行う
- [ ] クリーン checkout で親 source の runtime import が `debug` を含む werift workspace dependencies を解決できる
- [ ] Node 24 の CI で `npm run type`、`npm run test:small`、`npm run test:interop` が成功する
- [ ] Node 24 の CI で `npm run install:browsers && npm run test:browser` が成功し、既存 B1〜B8 の Playwright Chromium ↔ werift 検証を欠落させない
- [ ] Node 22 で fixture の `npm run type`、`npm run test:small`、`npm run test:interop`、`npm run install:browsers && npm run test:browser` を実行できることを、ローカルまたは別の明示的な互換性検証で確認する（GitHub Actions の Node 22 matrix job は必須としない）
- [ ] `public polyfill entry compiles with TypeScript DOM lib` と `...without DOM lib` が CI 負荷下でも timeout せず、かつ compiler exit status と diagnostics の Assert は維持される
- [ ] TypeScript compiler 子プロセスには有限 timeout があり、停止時に原因が分かる形でテストが失敗する
- [ ] `cd packages/webrtc && npm run type && npm test` が成功する
- [ ] ルートで `npm run type` と `npm run test:small` が成功する
- [ ] `npm run examples:e2e` が Node 24 の代表 CI job で実行され、成功する。Playwright engine 警告が実害化した場合は同じ変更内でサポート version と依存 version を整合させる
- [ ] GitHub Actions の Node CI を再実行し、Node 24 の build と `mediasoup-interop (24.x)` が green になる。Node 22 の Actions job は作成しない
- [ ] 修正が CI/test harness と依存セットアップに限定され、polyfill の公開挙動、examples の配置目的、WebRTC protocol 実装を不要に変更していない
