# e2e Chrome ↔ werift 帯域シミュレーション（CI 対象外）

Chrome（ブラウザ）と werift（Node）の間で TWCC + GCC の帯域推定を検証します。
**ネットワーク制限は werift 側 ICE `send` に仮想ボトルネックを装着**して再現します。

## CI 対象外

| コマンド | 対象 |
| --- | --- |
| `npm run ci` / `ci:silent` / `chrome:prod` | `./tests` のみ（本ディレクトリを含まない） |
| `npm run test:sim` | **本シミュレーションのみ** |

## 実行

```bash
cd e2e
npm run test:sim
```

`test:sim` は内部で次を実行します。

1. `install:browsers` — Chromium を `e2e/.playwright-browsers/` に確保
2. `build` — サーバ TS を compile
3. `simulations/run-sim.js` — サーバ + vitest を起動し、**同じ** `PLAYWRIGHT_BROWSERS_PATH` を子プロセスへ引き継ぐ

手動でパスを export する必要はありません（`run-ci` / `run-chrome-prod` と同じ worktree ローカルキャッシュ）。

```bash
# ブラウザのみ先に入れる場合
npm run install:browsers
# vitest だけ再実行する場合（run-sim 経由推奨）
npm run chrome:sim
```

## 構成

| パス | 内容 |
| --- | --- |
| `server/simulations/bottleneckLink.ts` | 帯域上限・遅延・キュー溢れロス（werift 側） |
| `server/simulations/gccTwccChrome.ts` | protoo ハンドラ（GCC + TWCC + 合成 RTP） |
| `simulations/tests/*.sim.test.ts` | Chrome ブラウザ側シナリオ |
| `simulations/run-sim.js` | サーバ + vitest 起動（`PLAYWRIGHT_BROWSERS_PATH` 引き継ぎ） |
| `ensure-browser.js` | 共有: ローカルキャッシュ path 解決 + install |

## シナリオ概要

1. werift が TWCC 付き offer を送り、Chrome が recvonly answer。
2. 接続後、werift の ICE `send` に上限帯域（例: 200 kbps）ボトルネックを装着。
3. 容量超過の固定レートで RTP を送り、ドロップと `onAvailableBitrate` 低下を確認。
4. 推定帯域に送信レートを追従させ、**適応期のドロップ率・追加ドロップ数が輻輳期より厳密に低下**することを確認。

### 補足

- 本 sim では **NACK を交渉しない**（輻輳期の損失に対する Chrome NACK/RTX 再送嵐が、適応後のドロップ緩和検証を隠すため）。
- 適応計測は probe abort / キュー排水の settle 後に開始する（`markAdaptStart`）。
- ブラウザは `npm run install:browsers`（= `ensure-browser.js`）で `e2e/.playwright-browsers/` に取得する（git 管理外）。`test:sim` / `chrome:sim` / `ci` はこの path を共有する。
