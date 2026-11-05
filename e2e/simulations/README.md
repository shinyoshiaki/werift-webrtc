# e2e Chrome ↔ werift 帯域シミュレーション（CI 対象外）

Chrome（ブラウザ）と werift（Node）の間で TWCC + GCC の帯域推定を検証します。ボトルネックの作り方が違う 2 種類があります。

| シナリオ                | ボトルネック                                                                        | コマンド                 |
| ----------------------- | ----------------------------------------------------------------------------------- | ------------------------ |
| werift 側（既定）       | werift の ICE `send` に仮想ボトルネックを装着                                       | `npm run test:sim`       |
| Chrome 受信側（Docker） | Chrome を別 network namespace に置き、カーネルの `tc` で werift → Chrome 方向を絞る | `npm run test:sim:netns` |

## CI 対象外

| コマンド                                   | 対象                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `npm run ci` / `ci:silent` / `chrome:prod` | `./tests` のみ（本ディレクトリを含まない）                           |
| `npm run test:sim`                         | **werift 側ボトルネックのシミュレーションのみ**                      |
| `npm run test:sim:netns`                   | **Chrome 受信側ボトルネックのシミュレーションのみ**（Docker が必要） |

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

| パス                                                       | 内容                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| `../packages/webrtc/simulations/helpers/bottleneckLink.ts` | 帯域上限・遅延・キュー溢れロス（werift 側。package の peer 間 sim と共有） |
| `server/simulations/gccTwccChrome.ts`                      | protoo ハンドラ（GCC + TWCC + 合成 RTP）                                   |
| `simulations/tests/*.sim.test.ts`                          | Chrome ブラウザ側シナリオ                                                  |
| `simulations/run-sim.js`                                   | サーバ + vitest 起動（`PLAYWRIGHT_BROWSERS_PATH` 引き継ぎ）                |
| `ensure-browser.js`                                        | 共有: ローカルキャッシュ path 解決 + install                               |

## シナリオ概要

1. werift が TWCC 付き offer を送り、Chrome が recvonly answer。
2. 接続後、`RTCDtlsTransport.sendRtp` が使う ICE `connection.send` に上限帯域（例: 200 kbps）ボトルネックを装着する（制御パケットではなくメディア RTP を `byKind.rtp` で識別）。
3. 容量超過の固定レートで RTP を送り、**RTP ドロップ**と `onAvailableBitrate` 低下、Chrome `packetsReceived` を確認。
   輻輳期は `mediaPacingEnabled = false`（生成レートをワイヤーへ）。probe 間隔は切らない。
4. 追従期は pacer を戻し、推定帯域に送信レートを合わせ、**適応期の RTP ドロップ率・追加ドロップ数が輻輳期より厳密に低下**することを確認。

### 補足

- 本 sim では **NACK を交渉しない**（輻輳期の損失に対する Chrome NACK/RTX 再送嵐が、適応後のドロップ緩和検証を隠すため）。
- 適応計測は probe abort / キュー排水の settle 後に開始する（`markAdaptStart`）。
- ブラウザは `npm run install:browsers`（= `ensure-browser.js`）で `e2e/.playwright-browsers/` に取得する（git 管理外）。`test:sim` / `chrome:sim` / `ci` はこの path を共有する。

## Chrome 受信側ボトルネック（Docker、`simulations/netns/`）

Chrome の受信経路そのものにボトルネックを置きます。werift の送信経路には手を入れないので、本物の Chrome の TWCC 応答を相手に GCC を試せます。

```bash
cd e2e
npm run test:sim:netns
```

### 前提

- Docker が使え、`--privileged` のコンテナを起動できること（network namespace・veth・`tc` をコンテナ内で作るため）。ホストのネットワーク設定は変更しません。
- repo の依存がホストでインストール済みであること（コンテナは repo をマウントしてそのまま使います）。
- 初回は公式イメージ `mcr.microsoft.com/playwright:v<e2e の Playwright の版>-noble` を取得し、`iproute2` と Node 24 を足したイメージ `werift-e2e-netns:<版>` を作ります（2 回目以降はキャッシュ）。Node 24 を入れるのは、Playwright イメージ既定の Node 26 に `--experimental-transform-types` が無いためです。

### 構成

| パス                          | 内容                                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `netns/run-netns-sim.js`      | ホスト側ランナー。イメージを作り、特権コンテナで `in-container.sh` を実行する                                                                      |
| `netns/Dockerfile`            | 公式 Playwright イメージ + `iproute2` + Node 24                                                                                                    |
| `netns/in-container.sh`       | `chrome` namespace と veth（`vw` ⇔ `vc`）を作り、`vw` の送信に `netem`（遅延）+ `tbf`（帯域・キュー）を掛けて、シナリオを `node --test` で実行する |
| `netns/chrome-in-netns.sh`    | Playwright の Chromium を `chrome` namespace で起動するラッパー                                                                                    |
| `netns/netnsSession.ts`       | 共通の準備（`tc` の変更、werift sendonly + GCC ⇔ Chrome recvonly の接続、合成 VP8 の送信と 1 秒ごとの計測）                                        |
| `netns/chromeNetnsGcc.sim.ts` | シナリオ                                                                                                                                           |

### シナリオ

| シナリオ                                                               | 確かめること                                                                                                                     |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 200 kbit に 700 kbps を固定で送る（RTX なし）                          | 3 秒以内に推定が容量付近まで下がり、0 に張り付かない                                                                             |
| 深いキュー（100 KB）で 3 Mbit → 1 Mbit、アプリは推定に追従（RTX あり） | probe で素早く上がり、遅延で輻輳を検出して容量の 50〜110% に収まる。容量低下後は 1 Mbit 付近以下に下がり、ロスは受信数の 5% 未満 |
| 1 Mbit にランダムロス 20%、アプリは推定に追従（RTX あり）              | ロスなしの推定の 70% 未満まで下がる                                                                                              |

判定は計測値のまわりの範囲で、libwebrtc と同じ値かは見ません。各シナリオの 1 秒ごとの推定と Chrome の `getStats` は `[netns-sim]` 行に JSON で出ます。

### Chrome の起動オプションでは代用できない

libwebrtc の `WebRTC-FakeNetworkReceiveConfig` / `WebRTC-FakeNetworkSendConfig`（`--force-fieldtrials`）は、Chromium 140 / 156・Google Chrome 149 で効きませんでした（ロス 50% を指定しても受信ロス 0）。`chrome://version` には有効な field trial として出るので、指定自体は届いています。DevTools の通信制限（`Network.emulateNetworkConditions`）は WebRTC の UDP には効かないとされており、試していません。
