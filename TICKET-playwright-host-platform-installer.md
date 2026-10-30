# Playwright 未対応 OS での browser install 補助を独立した変更として入れる

Epic 4（`TICKET-epic4-warp-webrtc-detailed.md` §8）から切り出したチケット。WARP の要件とは無関係で、Epic 4 のレビューでは #3（`env` の重複指定）と #8（develop merge で `env` の指定が消えた）の指摘源になっていたため、Epic 4 の差分からは `warp` の状態に戻した。

## 目的とスコープ

Playwright が未対応の Linux ディストリビューションで、`npm run install:browsers` と `e2e` の browser install が対応 OS 向けの build を選べるようにする。

- 対象: `scripts/install-playwright-browsers.js`、`scripts/playwright-host-platform.js`（新規）、`e2e/ensure-browser.js`、`e2e/vitest.config.mts`、`e2e/vitest.dtls.config.mts`、e2e の browsers path helper。
- 旧実装は `git show f9af8671`（host platform override）と `git show 75cc9345`（e2e 側の browsers path）で確認できる。そのまま戻さず、次の問題を直してから入れる。

## Epic 4 で見つかった問題

1. `scripts/install-playwright-browsers.js` の `spawnSync` に `env` が 2 回指定され、`playwrightInstallEnv()` の結果が後の `env` で上書きされていた（レビュー #3）。
2. develop merge の conflict 解消で `e2e/ensure-browser.js` の install 呼び出しから `env: playwrightInstallEnv()` が消え、import だけが残った（レビュー #8）。
3. `e2e/playwright-browsers.js` は develop の `e2e/browsers-path.js` と同じ役割の重複モジュールで、`withE2ePlaywrightBrowsersPath` の import は使われていなかった。

## 要件

- override の環境変数は呼び出しごとに 1 度だけ合成し、`PLAYWRIGHT_BROWSERS_PATH` と一緒に子プロセスへ渡す。
- e2e の browsers path は develop の `e2e/browsers-path.js` に一本化し、重複モジュールを作らない。
- override が必要かは Playwright の版ごとに判断する。`e2e` が使う 1.64.1 は `ubuntu26.04-x64` を定義しており、Ubuntu 26.04 では override なしで Chromium を解決できた。`examples/turn-loopback/chrome-e2e` の 1.59.1 には定義がない。

## 完了条件

- [ ] 子プロセスの環境を捕捉するテストで、override と `PLAYWRIGHT_BROWSERS_PATH` の両方が届くことを確認する。
- [ ] 未使用の import と重複モジュールがない。
- [ ] `npm run install:browsers` と `npm run e2e` が、対応 OS と未対応 OS（override が必要な版）の両方で成功する。
