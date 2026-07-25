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
npm run install:browsers   # 初回
npm run build
npm run test:sim
```

## 構成

| パス | 内容 |
| --- | --- |
| `server/simulations/bottleneckLink.ts` | 帯域上限・遅延・キュー溢れロス（werift 側） |
| `server/simulations/gccTwccChrome.ts` | protoo ハンドラ（GCC + TWCC + 合成 RTP） |
| `simulations/tests/*.sim.test.ts` | Chrome ブラウザ側シナリオ |
| `simulations/run-sim.js` | サーバ + vitest 起動 |

## シナリオ概要

1. werift が TWCC 付き offer を送り、Chrome が recvonly answer。
2. 接続後、werift の ICE `send` に上限帯域（例: 200 kbps）ボトルネックを装着。
3. 容量超過の固定レートで RTP を送り、ドロップと `onAvailableBitrate` 低下を確認。
4. 推定帯域に送信レートを追従させ、追加ドロップが減ることを確認。
