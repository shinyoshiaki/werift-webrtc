# WebRTC simulations (CI 対象外)

werift peer 同士を **仮想ボトルネック** 経由で接続し、TWCC + GCC の送信帯域推定が
輻輳（遅延・ロス）にどう応答するかを検証するシミュレーションです。

## CI 対象外

- 通常のユニット / integrate テストは `packages/webrtc/tests/` にあります。
- 本ディレクトリは **`npm test` / ルート `npm run ci` に含まれません**。
- 実行は明示的に `npm run test:sim`（本パッケージ）で行います。

## 実行

```bash
cd packages/webrtc
npm run test:sim
```

## 構成

| パス | 内容 |
| --- | --- |
| `helpers/bottleneckLink.ts` | 帯域上限・遅延・キュー溢れロスの仮想リンク |
| `helpers/peerHarness.ts` | TWCC 交渉 + GCC 差し替え済み peer 対の構築 |
| `gcc-twcc-congestion/*.sim.test.ts` | 輻輳誘発 → 帯域低下 → 追従でロス緩和のシナリオ |

## 検証シナリオ（概要）

1. 仮想上限帯域（例: 200 kbps）を超える固定レートで RTP を送る。
2. 遅延増加・ドロップが発生し、GCC の `onAvailableBitrate` が下がる。
3. アプリが推定帯域に送信レートを合わせると、追加ドロップが減少する。

## 関連: Chrome 間シミュレーション

werift ↔ Chrome は `e2e/simulations/`（ネットワーク制限は werift 側 ICE）。

```bash
cd e2e && npm run test:sim
```

## 回帰メモ（BWE）

- `hasTwccReceiveTiming`: `ReceivedWithoutDelta` と `receivedAtMs === 0` を分離（delay サンプル判定）
- 決定的 bitrate 系列テスト: `bandwidthEstimator.test.ts` の「決定的入力での bitrate 系列」
- Probe gating: libwebrtc `GetBandwidthLimitedCause` 相当（underuse/overuse / CorrectedRtt(propagation)>3s / loss decreasing|hold は新規 probe 禁止、loss increasing は estimated×1.5 cap、delay_based は uncapped）。更新順は delay→probe→loss→post-loss cause
- RTT: **min_propagation_rtt** = min(feedback_rtt − (max_recv − recv)) を `UpdatePropagationRtt` へ；IsRttAboveLimit は CorrectedRtt（raw max_feedback_rtt ではない）。>3s は probe 禁止 **および** pin 相当の target ×0.8 drop（1s 間隔・5kbps floor）。初回 `rtpPacketSent` で `UpdatePropagationRtt(send, 0)` を seed し、送信継続中は sender-clock で process
- Playwright ブラウザは `e2e/.playwright-browsers/`（git 管理外）。履歴にもバイナリを含めない
