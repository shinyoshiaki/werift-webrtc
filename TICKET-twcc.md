ide-cli スキルを確認し、指定された親・子 ticket file の内容を照合して、子チケット側の追加・更新だけを親へ統合します。

# TWCC 帯域推定アルゴリズムの抽象化と選択可能化（現状実装 + GCC）

[更新済みの親 ticket file](</var/sak/host-home/code/werift-webrtc.worktree/c724daf9-5f79-4e30-bd50-7b27c8951844/TICKET-ticket-c724daf9-5f79-4e30-bd50-7b27c8951844.md>)

## 追加要件（PeerConnection オプションと GCC フックの共通化）

### RTCPeerConnection コンストラクタで BandwidthEstimator を指定・無効化できる

`PeerConfig.bandwidthEstimator`（`RTCPeerConnection` コンストラクタ / `setConfiguration`）で、新規 `RTCRtpSender` が使う送信側 BWE を決める。

| 値 | 動作 |
| --- | --- |
| `"legacy"`（デフォルト） | `SenderBandwidthEstimator`（従来どおり） |
| `"gcc"` | `GccBandwidthEstimator`（sender ごとに別インスタンス） |
| `false` / `"none"` | `DisabledBandwidthEstimator`（TWCC BWE 無効。推定 0、probe/pacing/process なし） |
| `() => BandwidthEstimator` | factory。**sender ごとに 1 回**呼ぶ（インスタンス共有禁止） |

- `setConfiguration` で変えた場合は、**その後に作られる sender だけ**に効く。既存 sender は `RTCRtpSender.setBandwidthEstimator` で差し替える。
- 1 sender への直接注入は従来どおり `setBandwidthEstimator`、および `new RTCRtpSender(kind, { bandwidthEstimator })`。

### rtpSender から GCC 固有実装を外し、BandwidthEstimator に GCC 必要要素を載せる

`RTCRtpSender` は GCC 定数・型ガード・`GccBandwidthEstimator` の duck typing に依存しない。probe / pacing / RTT / process interval / padding サイズはすべて `BandwidthEstimator` 上のメソッド・プロパティ。

- GCC: 実実装（`processIntervalMs = 25`、padding バイト > 0 など）
- Legacy / Disabled: **no-op**（`processIntervalMs === 0`、padding サイズ 0、`shouldTagProbePacket() === false`、`getPacingBitrateBps() === 0`、`setRoundTripTime` / `process` / `setNetworkAvailable` は空）

RTP パケット生成・DTLS 送信・token-bucket 待ちは sender に残す（ワイヤー層）。アルゴリズム判断（何バイトの padding が要るか、pace レート、process 間隔）だけ estimator 側。

### 完了条件（この追加分）

- [x] `new RTCPeerConnection({ bandwidthEstimator: "gcc" | "legacy" | false | factory })` で各 sender の estimator が選ばれる
- [x] `false` / `"none"` で BWE が無効（推定 0、pacing / probe padding なし）
- [x] `rtpSender.ts` が `estimators/gcc/constants` や GCC 型ガードを import しない
- [x] Legacy は GCC フックを no-op 実装し、既存の unpaced 送信を維持する
- [x] 推定帯域の変化は従来どおり `sender.onAvailableBitrate` で **bps・変化時のみ**通知する