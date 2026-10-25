# TWCC 帯域推定アルゴリズムの抽象化と選択可能化（現状実装 + GCC）

## 1. タスクの目的と背景

### 目的

- TWCC（Transport-Wide Congestion Control）フィードバックを入力とする **送信側帯域推定（BWE）** を、単一ハードコード実装から **差し替え可能なアルゴリズム層** に分離する。
- 初期の選択肢として次の 2 つを提供する。
  1. **現行アルゴリズム**（`SenderBandwidthEstimator` + `CumulativeResult` ベースの推定）
  2. **GCC（Google Congestion Control）**（[draft-ietf-rmcat-gcc](https://datatracker.ietf.org/doc/html/draft-ietf-rmcat-gcc-02) を一次仕様とし、libwebrtc を参照実装とする delay-based / loss-based / probe 推定。**GCC として正しく機能すること**を目標とし、libwebrtc との 1:1 の一致は求めない（§2.12）
- TWCC 由来の **推定送信可能帯域（available / target bitrate）が変動したとき、イベントで帯域幅を通知する契約** を公開 API・ドキュメント上で明確化する。

### 背景（プロトコルと実装の役割分担）

[draft-holmer-rmcat-transport-wide-cc-extensions-01](https://datatracker.ietf.org/doc/html/draft-holmer-rmcat-transport-wide-cc-extensions-01) は **フィードバック機構**（transport-wide sequence number と RTCP feedback）を定義する。帯域推定アルゴリズム自体は規定せず、送受信側の観測結果を sender 側アルゴリズムに渡すことが目的である。ドラフト導入部でも GCC / NADA / SCReAM などを send-side で実装できる設計意図が明示されている。

したがって本タスクのスコープは次の切り分けになる。

| 層 | 責務 | 本タスクでの扱い |
| --- | --- | --- |
| TWCC プロトコル（RTP 拡張 + RTCP FB） | 送受信時刻・到達/未到達の観測 | **既存実装を維持**（アルゴリズム差し替えの入力源） |
| 帯域推定アルゴリズム | 観測から送信可能帯域・輻輳状態を推定 | **抽象化し選択可能にする（本タスクの中心）** |
| アプリ / エンコーダ連携 | 推定帯域の購読とビットレート制御 | イベント契約の明確化・既存 example の追随 |

### 現状コードベースの整理

| 領域 | 主なパス | 現状 |
| --- | --- | --- |
| TWCC RTCP / packetResults | `packages/rtp/src/rtcp/rtpfb/twcc.ts` | `TransportWideCC` の serialize/deserialize、`packetResults` で受信時刻復元 |
| TWCC header extension | `packages/rtp/src/rtp/headerExtension.ts`、`packages/webrtc/src/media/extension/rtpExtension.ts` | `useTransportWideCC()` / `serializeTransportWideCC` |
| Receiver 側 feedback 生成 | `packages/webrtc/src/media/receiver/receiverTwcc.ts` | 到着時刻記録、100ms 周期 or 10 パケット超で feedback 送信 |
| Sender 側 BWE（現行） | `packages/webrtc/src/media/sender/senderBWE.ts`、`cumulativeResult.ts` | TWCC 受信後に累積統計から bitrate 推定。mediasoup 由来コメントあり |
| 配線 | `packages/webrtc/src/media/rtpSender.ts` | `readonly senderBWE = new SenderBandwidthEstimator()` で **固定生成**。`rtpPacketSent` / `receiveTWCC` を呼ぶ |
| 利用例 | `examples/mediachannel/simulcast/abr.ts`、`examples/mediachannel/twcc/offer.ts` | `onAvailableBitrate` / `onCongestion` / `onCongestionScore` を購読 |
| 単体テスト | `packages/webrtc/tests/**` | **BWE 自体のテストは未整備**（TWCC パケットの serialize テストは `packages/rtp/tests/rtcp/rtpfb/twcc.test.ts` に存在） |
| REMB | `rtpSender` で `receiverEstimatedMaxBitrate` を保持 | TWCC BWE とは別経路。本タスクの主対象外だが、将来の統合余地あり |

#### 現行推定ロジックの要点（`SenderBandwidthEstimator`）

1. `rtpPacketSent(SentInfo)` で transport-wide seq / size / 送信時刻を保持。
2. `receiveTWCC(TransportWideCC)` で `packetResults` のうち受信済みパケットを `CumulativeResult` に積む。
3. 条件（累積窓の経過 ≥ 100ms かつパケット数 ≥ 20）を満たすと  
   `availableBitrate = min(sendBitrate, receiveBitrate)` を設定。
4. 1 秒超の無更新っぽい窓では congestion counter / score を悪化させるヒューリスティック。
5. イベント:
   - `onAvailableBitrate: Event<[number]>` … setter 経由で発火（単位は bps 相当の整数）
   - `onCongestion: Event<[boolean]>`
   - `onCongestionScore: Event<[number]>`（1〜10、大きいほど悪い）

#### 問題点

- 推定アルゴリズムが `SenderBandwidthEstimator` に密結合しており、**別アルゴリズム（GCC 等）へ差し替えられない**。
- `RTCRtpSender` が常に現行 estimator を new しており、**選択手段がない**。
- `onAvailableBitrate` は存在するが、
  - 値が不変でも setter 経由で毎回 fire する、
  - 公開ドキュメント上「推定送信可能帯域の変動通知」であることの説明が薄い、
  - 単位・タイミング・必須/任意 API がチケット/README レベルで明確でない。
- GCC のような delay-based（遅延勾配）+ loss-based の標準的制御を選べない。

---

## 2. 実装すべき具体的な機能・変更内容

### 2.1 帯域推定アルゴリズムの抽象化

- 送信側 BWE の **共通インターフェース** を定義する（名称は実装時に既存命名へ合わせてよい。例: `BandwidthEstimator` / `SenderSideBwe`）。
- **共通 interface の契約は「推奨変更先帯域幅」の通知に限定する**（決定済み）。輻輳スコアや overuse/underuse など、アルゴリズム固有の意味を持つシグナルは **共通 interface に載せない**。

| 種別 | 内容 |
| --- | --- |
| 入力 | `rtpPacketSent(info: SentInfo)` — 送信サイズ・transport-wide seq・送信時刻 |
| 入力 | `receiveTWCC(feedback: TransportWideCC)` — TWCC feedback の処理 |
| 状態 | `availableBitrate: number`（推定・推奨送信可能帯域。単位 **bps** を明記） |
| イベント（共通・必須） | **`onAvailableBitrate`** — 推奨変更先帯域幅が **変化したとき** に通知（後述 2.3） |
| ライフサイクル | 必要なら `reset()` / dispose 相当（トランスポート再接続時・差し替え時） |

#### アルゴリズム固有イベント（共通 interface 外）

- **現行（legacy）**: 既存の `onCongestion` / `onCongestionScore` は **legacy 実装固有** として維持する。共通 interface の必須メンバにはしない。
- **GCC**: delay-based の overuse / underuse / normal、loss-based の状態、probe 状態などは **GCC 実装固有イベント**（例: `onOveruseDetected`、内部 state 公開、または GCC 専用型への downcast / 具象クラス購読）として分離する。
- アプリが固有イベントを使う場合は、差し替えた具象インスタンス（または type guard）経由で購読する。共通経路は `onAvailableBitrate` のみを前提に書けるようにする。

- **TWCC プロトコル処理**（header extension 付与、`ReceiverTWCC` による feedback 生成、RTCP ルーティング）は現状のまま維持し、**アルゴリズム層だけを差し替える**。
- `SentInfo` / `TransportWideCC` / `Event` など既存型を再利用し、不要な破壊的変更を避ける。

### 2.2 アルゴリズム実装の提供

#### (A) 現行アルゴリズム（デフォルト・決定済み）

- 現行 `SenderBandwidthEstimator` + `CumulativeResult` を **共通 interface 実装**としてリファクタする。`RTCRtpSender` の初期値としてもこれを使う。
- 振る舞い互換を優先（閾値: 100ms / 20 packets、`min(send, recv)`）。
- `onCongestion` / `onCongestionScore` は **legacy 具象の固有イベント**として維持（共通 interface には含めない）。
- 名称例: `LegacyCumulativeBandwidthEstimator` / `CumulativeMinBitrateEstimator` / 既存名の維持 + interface 適合。

#### (B) GCC（libwebrtc を参照実装とする）

> §2.12（2026-10-24）により、完成度は「GCC として正しく機能すること」で判定する。以下の libwebrtc への寄せ方は実装方針として残すが、libwebrtc と同じ処理順・同じ境界値で動くことはテストで固定しない。

- [draft-ietf-rmcat-gcc](https://datatracker.ietf.org/doc/html/draft-ietf-rmcat-gcc-02) を一次仕様とし、加えて **libwebrtc の send-side BWE / GCC 実装（現行の delay-based / loss-based / probe 周辺）を参照実装**として、**可能な限り最大の互換性**を目指す。
- 「簡略 GCC で十分」とはしない。設計・定数・状態遷移・更新式は draft と libwebrtc の双方を突き合わせ、乖離がある場合は **理由をコメントまたは docs に記録**したうえで、実運用で使われる libwebrtc 側の挙動を優先する。
- 本チケットで含める構成目標（必須）:
  - **Delay-based controller**: inter-arrival / delay gradient（Kalman filter 等、libwebrtc 相当のフィルタと overuse detector）、overuse / underuse / normal 判定、AIMD rate control。
  - **Loss-based controller**: TWCC 上の未到達（loss）率に基づく目標ビットレート更新（libwebrtc 現行の loss-based 方針に寄せる）。
  - **最終推定**: delay-based と loss-based の結果を合成（通常は **min** 等、参照実装と同じ結合規則）。
  - **Bandwidth probing**: 初期立ち上がり・回復時に probe で探索できること（probe bitrate controller / probe controller 相当。TWCC の sent 情報と feedback を入力に使える範囲で実装）。
  - **状態・定数の忠実さ**: 窓長、閾値、増加/減少係数、初期 bitrate、clamp 範囲などを可能な限り参照実装に合わせ、マジックナンバーを散在させず名前付き定数に集約する。
- 参照実装の取り扱い:
  - 公式 draft + Chromium / libwebrtc の該当モジュール（例: `modules/congestion_controller` / `goog_cc` 周辺）を調査ソースとする。
  - pure TypeScript へ移植する（C++ バインディングやネイティブ addon は追加しない）。
  - 言語差・時刻分解能差で 1 bit 単位の完全一致が困難な箇所は、**アルゴリズム構造・更新規則・定性的応答の一致**を優先し、既知の数値差はテスト許容誤差またはドキュメントで明示する。
- 依存は pure TypeScript（Node）に収め、ネイティブモジュールを追加しない。

### 2.3 推定帯域変動時のイベント通知の明確化

**共通契約として固定する内容（推奨変更先帯域幅のみ）:**

1. TWCC を用いた送信側推定により **推奨変更先帯域幅（bps）が更新されたとき**、共通 interface の `onAvailableBitrate` で購読者へ通知する。これがアルゴリズム横断の **唯一の必須出力イベント**。
2. 通知ペイロードは少なくとも **`number`（bps）**。必要なら将来 `{ bitrateBps, algorithm, reason }` 拡張を検討するが、初期は既存 `[number]` 互換を優先。
3. **「変動した際」** の意味をコード上でも明確化:
   - 推奨: 前回通知値と **異なる場合のみ** `execute` する（ノイズ購読・不要な ABR 切替を防ぐ）。
   - 初回の有効推定が出たときも通知する。
4. ドキュメント / JSDoc / example で次を明記:
   - 単位は bps
   - TWCC が negotiate され、十分な sample が溜まるまで 0 または未更新の可能性がある
   - アプリの帯域追従は本イベントを購読すれば足りる（既存 `abr.ts` の bitrate ログが参照）。score / congestion は legacy 固有
5. congestion / overuse 等は本節の共通契約に **含めない**（§2.1 の固有イベント方針）。

### 2.4 アルゴリズム選択 API（決定済み）

**採用方式: インスタンス差し替え setter。デフォルトは現行アルゴリズム。**

| 項目 | 方針 |
| --- | --- |
| デフォルト | `RTCRtpSender` 生成時は **現行（legacy）** の estimator を保持。既存利用はそのまま動く |
| 差し替え | `setBandwidthEstimator(impl: BandwidthEstimator)` で **既存 sender** に任意インスタンスを注入 |
| 読み取り | 既存の `senderBWE`（または interface 型の getter）で現在の実装を参照。`readonly` 固定 new はやめ、差し替え可能にする |
| 初期選択（後続要件） | `PeerConfig.bandwidthEstimator` で **新規 sender** の初期実装を `"legacy"` / `"gcc"` / `false` / `"none"` / factory から指定できる。必須オプションではない |

差し替え時の振る舞い（実装で明確化）:

1. 旧インスタンスへの `rtpPacketSent` / `receiveTWCC` 配送を停止する。
2. 可能なら旧インスタンスの `reset` / 購読解放を行い、リークを防ぐ。
3. 新インスタンスはクリーンな状態から推定を開始する（旧状態の暗黙マージはしない。必要なら利用者が自分で状態を作って渡す）。
4. 共通で購読すべきは `onAvailableBitrate`。legacy の `onCongestion*` や GCC 固有イベントは **差し替え後の具象** に付け直す必要があることを docs / JSDoc に書く。

補助として、利用者が `new GccBandwidthEstimator()` や現行クラスを new しやすいよう **具象クラスを public export** する（列挙ファクトリは任意。setter が正式な選択 API）。

### 2.5 配線・互換

- `rtpSender.ts` の `receiveTWCC` / `rtpPacketSent` 呼び出しは **現在保持している interface 実装** 経由に変更。
- 初期値: `senderBWE = new SenderBandwidthEstimator()`（現行）。`setBandwidthEstimator` で差し替え可能。
- property 名 `senderBWE` は維持を推奨（破壊的変更回避）。型は共通 interface。legacy 固有イベントは具象型として利用側で扱う。
- examples:
  - `examples/mediachannel/simulcast/abr.ts` … `onAvailableBitrate` は共通契約として継続。`onCongestionScore` は legacy 具象前提であることを維持 or コメントで明記。GCC 切替例を足す場合は setter + 具象 new を示す。
  - `examples/mediachannel/twcc/offer.ts` … congestion 購読は legacy 固有イベントとして継続確認。

### 2.6 テスト

- Arrange / Act / Assert に従い、共有 fixture は可能な限りユーティリティ化。
- 推奨ケース:
  1. 現行アルゴリズム: 合成 TWCC + SentInfo から `availableBitrate` が期待範囲になる。
  2. 現行アルゴリズム: 帯域が変わったときだけ `onAvailableBitrate` が発火する（2.3 の契約）。
  3. GCC: loss 増加で推定が下がる / delay gradient 悪化（overuse）で推定が下がる / underuse で回復方向に動く。
  4. GCC: probe により初期または低 bitrate 状態から探索的に推定が上がる（参照実装の probe 意図に沿う）。
  5. GCC: 仮想ボトルネックでの決定的シミュレーションにより、混雑・容量変化・ロス・feedback 途絶への **制御応答の傾向**（範囲判定）を回帰する。libwebrtc と同じ処理順・境界値の検証はしない（§2.12）。
  6. 選択 API: `setBandwidthEstimator` で GCC（または別実装）に差し替え後、以降の TWCC / sent が新実装に渡り、`onAvailableBitrate` が新実装から発火する。
  7. 共通 interface に congestion 系イベントが **含まれない** こと、legacy / GCC 固有イベントが具象側に残ることを型またはテストで確認する。
- Act / Assert には日本語コメントを適切な粒度で付与（リポジトリ規約）。

### 2.7 ドキュメント

- 公開 API の JSDoc（`onAvailableBitrate` の単位 bps、変化時のみ、`setBandwidthEstimator` の使い方、固有イベントは具象側である旨）。
- 必要なら `packages/webrtc/README.md` または example に短い節を追加（TWCC negotiate + 帯域購読 + setter で GCC 差し替え）。
- ルート / package `AGENTS.md` は本変更で scripts やパッケージ境界が変わらない限り必須更新ではない。公開 API の説明が README に既にある場合は追随。

### 2.8 ピア間帯域シミュレーションテスト（追加要件・CI 対象外）

2 つの **werift peer** 同士を、仮想的な上限帯域を持つリンク経由で接続し、輻輳時の **ロス / 遅延** が TWCC 経由で GCC に届き、推定送信帯域が下がり、アプリが送信レートを追従すると輻輳が緩和されることを検証する。

| 項目 | 方針 |
| --- | --- |
| 配置 | 既存 `packages/webrtc/tests/**` とは **別ディレクトリ**（`packages/webrtc/simulations/`） |
| 実行 | `cd packages/webrtc && npm run test:sim`（明示実行のみ） |
| CI | **対象外**。`npm test` / ルート `npm run ci` には含めない |
| 構成 | 仮想ボトルネック（帯域上限・遅延・キュー溢れロス）+ TWCC 交渉 + `GccBandwidthEstimator` 差し替え |
| 検証観点 | (1) 容量超過送信でドロップ発生と `onAvailableBitrate` 低下 (2) 推定帯域への追従後に追加ドロップが減少 (3) 容量内低レートではほぼロスしない |

実装上の前提修正（必要に応じて）:

- TWCC RTCP（`TransportWideCC.serialize`）は RFC 3550 の **32-bit アラインメント（必要時 P ビット + パディング）** を満たすこと。未パディングだと SRTCP 復号 / deSerialize が失敗し peer 間で `onAvailableBitrate` が更新されない。

### 2.9 werift ↔ Chrome 帯域シミュレーション（追加要件・CI 対象外）

**Chrome（ブラウザ）と werift（Node）** の間でも、§2.8 と同様に仮想上限帯域下で TWCC + GCC が動作し、送信帯域の低下と輻輳緩和が確認できること。

| 項目 | 方針 |
| --- | --- |
| 配置 | `e2e/simulations/`（通常 e2e の `e2e/tests/` とは分離） |
| 実行 | `cd e2e && npm run test:sim`（明示実行のみ。要ブラウザ / `npm run build`） |
| CI | **対象外**。`e2e` の `ci` / `ci:silent` / `chrome:prod` は `./tests` のみ |
| ネットワーク sim | **werift 側**で実施（ICE `connection.send` に BottleneckLink を装着）。Chrome 側に tc/netem 等は要求しない |
| 構成 | Chrome recvonly + transport-cc 交渉 / werift sendonly + `GccBandwidthEstimator` + 合成 RTP |
| 検証観点 | (1) 容量超過で werift 送信ドロップと `onAvailableBitrate` 低下 (2) 推定追従後の追加ドロップ減少 (3) Chrome `getStats` で RTP 受信を確認 |

### 2.10 PeerConnection オプションと GCC フックの共通化（追加要件）

#### RTCPeerConnection コンストラクタで BandwidthEstimator を指定・無効化できる

`PeerConfig.bandwidthEstimator`（`RTCPeerConnection` コンストラクタ / `setConfiguration`）で、新規 `RTCRtpSender` が使う送信側 BWE を決める。

| 値 | 動作 |
| --- | --- |
| `"legacy"`（デフォルト） | `SenderBandwidthEstimator`（従来どおり） |
| `"gcc"` | `GccBandwidthEstimator`（sender ごとに別インスタンス） |
| `false` / `"none"` | `DisabledBandwidthEstimator`（TWCC BWE 無効。推定 0、probe/pacing/process なし） |
| `() => BandwidthEstimator` | factory。**sender ごとに 1 回**呼ぶ（インスタンス共有禁止） |

- `setConfiguration` で変えた場合は、**その後に作られる sender だけ**に効く。既存 sender は `RTCRtpSender.setBandwidthEstimator` で差し替える。
- 1 sender への直接注入は従来どおり `setBandwidthEstimator`、および `new RTCRtpSender(kind, { bandwidthEstimator })`。

#### rtpSender から GCC 固有実装を外し、BandwidthEstimator に GCC 必要要素を載せる

`RTCRtpSender` は GCC 定数・型ガード・`GccBandwidthEstimator` の duck typing に依存しない。probe / pacing / RTT / process interval / padding サイズはすべて `BandwidthEstimator` 上のメソッド・プロパティ。

- GCC: 実実装（`processIntervalMs = 25`、padding バイト > 0 など）
- Legacy / Disabled: **no-op**（`processIntervalMs === 0`、padding サイズ 0、`shouldTagProbePacket() === false`、`getPacingBitrateBps() === 0`、`setRoundTripTime` / `process` / `setNetworkAvailable` は空）

RTP パケット生成・DTLS 送信・token-bucket 待ちは sender に残す（ワイヤー層）。アルゴリズム判断（何バイトの padding が要るか、pace レート、process 間隔）だけ estimator 側。

#### 完了条件（この追加分）

- [x] `new RTCPeerConnection({ bandwidthEstimator: "gcc" | "legacy" | false | factory })` で各 sender の estimator が選ばれる
- [x] `false` / `"none"` で BWE が無効（推定 0、pacing / probe padding なし）
- [x] `rtpSender.ts` が `estimators/gcc/constants` や GCC 型ガードを import しない
- [x] Legacy は GCC フックを no-op 実装し、既存の unpaced 送信を維持する
- [x] 推定帯域の変化は従来どおり `sender.onAvailableBitrate` で **bps・変化時のみ**通知する

### 2.11 TWCC feedback 正規化と送信経路の構造整理（追加要件・2026-10-21）

#### 背景

5 回のレビューで出た 11 件の指摘は、ほぼ次の 2 系統に集中していた。個別の境界条件を直すと別の反例が出る構造だったため、構造側で解消する。

| 系統 | 該当する指摘 | 根本原因 |
| --- | --- | --- |
| TWCC の 16bit seq の世代解決・重複 ACK | 1-#2, 3-#2, 4, 5 | estimator ごとに「最新の送信 seq から世代を探索」し、受信時刻の近さで重複かどうかを推測していた |
| media の wire seq の再割当・padding | 1-#1, 1-#3, 3-#1, 3-#3 | probe padding を media SSRC・media PT で送っていたため、入力 seq と padding seq の割り込み管理が必要だった |
| 単発 | 1-#4（ライセンス） | 解決済み |

レビュー 5 の残指摘（legacy に corrective feedback を渡すと、100・102 報告後の 101 遅着 + 102 再報告で 3 件ではなく 4 件加算される）も、手元で再現した。

#### 要件

- **A. TWCC feedback の正規化層を 1 つにする（libwebrtc `TransportFeedbackAdapter` 相当）**
  - legacy と GCC の手前に共通の `TwccFeedbackAdapter` を置き、両 estimator はその出力 `{extSeq, sent, received, recvMs?}` だけを使う。
  - feedback の 16bit seq は、直前の feedback を基準にした単調な unwrapper で拡張する（初回は最新送信 seq を基準にする）。最新送信 seq からの世代探索はやめる。
  - 受信と確定した packet は履歴から消し、後の再報告は無視する。受信時刻による重複判定（`kDuplicateAckToleranceMs`）は廃止する。
  - 未受信と報告された packet は履歴に残し、後の feedback で受信へ訂正できるようにする。
  - 履歴の span は 32768 未満に制限し、16bit 番号ごとの候補を常に 1 つにする。
- **B. probe padding を media SSRC の seq 空間から外す**
  - RTX が negotiate されていれば、padding は RTX SSRC・RTX PT・RTX seq で送る。
  - RTX が無い場合は padding を送らず、既知の差分として `GCC_KNOWN_DIFFERENCES` に記録する。
  - media seq は develop と同じ `input + seqOffset`（replaceTrack / onSourceChanged のときだけ変わる）に戻す。`skipSourceSequence`、`usedWireSeqs` などの wire seq allocator と、転送時の padding 除去は削除する。
- **C. 既定の legacy 経路を develop と同じ送信経路にする**
  - `processIntervalMs === 0` かつ padding サイズ 0 の estimator（legacy / disabled）では、送信キュー・キュー上限・pacing / probe 待ちを通さず、develop と同じく直接 DTLS へ書く。
  - corrective feedback は develop の挙動に戻す（dumb receiver。報告済みの番号に遅れて届いた packet は再報告しない）。
- **D. 性質テストで先回りする**
  - 周回・重複・並べ替え・corrective を混ぜた feedback 列で「各送信パケットは受信として高々 1 回だけ数える」「feedback が実際に覆った正しい世代以外には対応づけない」を確認する。
  - seq 側は「epoch 内で出力 seq − 入力 seq が一定（重複・padding 起因の欠番なし）」「切替直後は直前出力 + 1」「注入 padding は RTX SSRC だけ」を確認する。

#### 完了条件（この追加分）

- [x] A: `packages/webrtc/src/media/sender/estimators/twccFeedbackAdapter.ts` を追加し、`SenderBandwidthEstimator` と `GccBandwidthEstimator` の両方が使う。GCC の `finalizedSeqs` / `softLostSeqs` / `kDuplicateAckToleranceMs`、共通 `lookupUnwrappedSentSeq`（`twccSentSeqLookup.ts`）は削除した。
- [x] A: レビュー 5 の再現条件（legacy + corrective feedback）で加算が 3 件になる回帰テストを追加した。
- [x] B: padding は `rtxSsrc` / `rtxPayloadType` / `rtxSequenceNumber` で送る。RTX が無ければ `maybeInjectProbePadding` / `maybeInjectLossPadding` は 0 を返して何も送らない。差分を `GCC_KNOWN_DIFFERENCES` に記録した。
- [x] B: wire seq allocator と転送時の padding 除去を削除し、media seq は `input + seqOffset` に戻した。受信側は develop と同じく padding-only RTX を track に渡さない（TWCC には計上する）。
- [x] C: `needsPacedSendPath()`（`processIntervalMs > 0 || probePaddingPacketBytes > 0`）が false の estimator では、`RTCRtpSender` が送信キューを通さず直接送る。キュー上限も適用しない。estimator 差し替え直後にキューが残っている間だけ、順序維持のためキューの後ろに並べる。
- [x] C: `ReceiverTWCC` の corrective feedback（到着履歴・再報告）を削除した。transport 単位の共有、frontier からの loss 報告、RunLength 分割は維持している。
- [x] D: `tests/media/twccFeedbackAdapter.test.ts`（seed 付き乱数で 8 系列 + legacy / GCC 各 1 系列）と、`tests/media/rtpSender.test.ts` の「sequence properties」（6 系列、legacy / GCC）を追加した。adapter の「受信確定で履歴から消す」「span 上限」を外すと失敗し、padding で `seqOffset` をずらすと seq 側の性質テストが失敗することを確認した。（2026-10-25 に `tests/pbt/twcc/`・`tests/pbt/sender/` へ移した。§2.12「性質テストの共通基盤化」）
- [x] package sim（`npm run test:sim`）で RTX を negotiate し、padding が RTX SSRC にだけ出て media SSRC には出ないことを検証した。

#### develop との差分として残るもの（legacy 既定経路）

既定経路で develop と完全に同一ではない点は、次の不具合修正だけである。

- TSN は送信前に同期的に割り当て、その値を `SentInfo.wideSeq` に使う（develop は await 後に transport の現在値を読むため、BUNDLE で他 sender の TSN を拾うことがあった）。
- 転送元 packet の TWCC / abs-send-time 拡張で、新しく割り当てた値を上書きしない。
- NACK 再送は新しい TSN を割り当てる（develop は元の TSN を再利用していた）。
- padding-only packet は NACK 用の `rtpCache` に入れない。
- `SentInfo.sendingAtMs` は ICE へ渡す直前の時刻を使う。
- legacy の送信履歴は 10 秒の時間窓で捨てる（develop は削除処理が効かず無制限に増えていた）。

### 2.12 GCC テストの方針転換：libwebrtc との 1:1 一致から「GCC として正しく機能すること」へ（追加要件・2026-10-24）

#### 背景

`tests/media/bandwidthEstimator.test.ts` は 8,607 行・221 件で、その大半が「libwebrtc と同じ処理順・同じ境界値で動くこと」を個別の例で固定していた（例: `2999` と `3000` の境界、`clamp→drop` の順序、内部状態遷移、`as any` による内部状態の直接操作 642 か所）。このため、実装の小さな改善でも大量のテストが落ち、テストが実装の写しになっていた。

#### 要件

- GCC の完成度は「**GCC として正しく機能すること**」で判定する。libwebrtc と 1:1 に対応する実装を目指すことは要件にしない。
- **実装側の互換のための処理（境界値や順序の調整）は今回は残し、テストだけ整理する。**
- libwebrtc と同じ処理順・同じ境界値で動くことを検証する厳密なテストは削除する。
- 削除した範囲は次の 3 種類のテストで押さえる。
  1. **GCC の仕様に基づく制御応答テスト**: 仮想ボトルネック（容量・片道遅延・キュー上限・ランダムロス）を通した決定的シミュレーションで、結果の傾向を範囲で判定する。
  2. **不変条件の性質テスト**: ランダムな経路・送信レート・ロス・feedback 途絶を混ぜても成り立つ性質を確認する。
  3. **werift 固有の回帰テスト**: 過去のレビューで見つかった werift の不具合（送信経路・番号・padding・差し替え・停止・TWCC 解釈）は例ベースで残す。

#### 完了条件（この追加分）

- [x] 制御応答テスト（`tests/media/bandwidthEstimator.test.ts` の「GCC 制御応答（仕様ベース）」）を追加した。
  - 容量を超える送信を続けると、2 秒以内に容量付近まで下がる（0 には張り付かない）。
  - 容量に余裕があれば probe padding で 1 秒以内に開始値の 3 倍以上へ上がり、収束後は容量の 70〜115%、キューあふれ 0。
  - 容量が下がると 2 秒以内に追従し、最終値は新容量の 50〜110%。あふれは低下直後の過渡期だけで、追従後の 5 秒間は 0。
  - 容量が回復すると推定が 2 倍以上に上がり、容量を大きく超えない。
  - 片道 300ms の固定遅延だけでは推定を下げない（容量の 60〜120%）。
  - ロス 20% の推定はロス 0% の半分未満で、0 にはならない。
  - TWCC feedback が途絶えると、途絶前の半分未満まで下がり続ける。
- [x] 不変条件の性質テスト（「GCC 不変条件（性質テスト）」24 系列）を追加した。通知値は有限で、`setBitrates` の [min, max] から出ず、同じ値を続けて通知せず、公開値は最後の通知値と一致する。
- [x] シミュレーションは共有の Arrange ユーティリティ `tests/media/gccSimulation.ts` に置いた（1ms 刻みの FIFO ボトルネック、wire 形式の TWCC（250µs 量子化あり）、`RTCRtpSender` と同じ要領の probe padding）。
- [x] テストが GCC の故障を検出できることを、実装を一時的に壊して確認した（確認後に元へ戻した）。
  - overuse 時に減速しない → 2 件失敗
  - probe padding を要求しない → 2 件失敗
  - loss-based を採用しない → 4 件失敗
  - RTT backoff を無効化 → feedback 途絶のテストが失敗
  - 変化時のみ通知をやめる → 性質テスト 24 件すべて失敗
- [x] libwebrtc との 1:1 一致を固定していたテストを削除した。`bandwidthEstimator.test.ts` は 8,607 行・221 件から 2,590 行・84 件（例ベース 53 件 + 制御応答 7 件 + 性質テスト 24 系列）になった。共有ユーティリティ `gccSimulation.ts` は 241 行。
- [x] 実装（`src`）は変更していない。

#### 例ベースから性質テストへの置き換え（2026-10-25）

不変条件として書けるものは、§2.12 で残した例ベースのテストからさらに性質テストへ置き換えた。置き場所と生成器は、次の「性質テストの共通基盤化」で `tests/pbt/` へ移した。

| 置き換えた例ベースのテスト | 性質テスト（系列数） | 確かめる性質 |
| --- | --- | --- |
| legacy の一定レート推定、変化時のみ通知（2 件） | 16 + 8 | 推定値は受信できたパケットの min(送信レート, 受信レート) を独立に再計算した値と一致する。通知は値が変わったときだけ、その値で出る |
| legacy の時間窓 prune、GCC の process 時 prune（2 件） | 12（legacy / GCC 交互） | 送信履歴は時間窓内（legacy 10 秒・GCC 60 秒）、拡張番号は送信順、番号 span は 32768 未満 |
| TWCC の RunLength cursor、gap の wire 往復、周回順の並べ替え（3 件） | 32 + 16 | wire 往復で番号（周回含む）・受信状態・受信時刻（250µs 切り捨ての累積誤差内）が復元される。周回をまたぐ窓を送信順に並べる |
| 24-bit reference_time の周回（1 件） | 16 | 周回付近を前後しても、展開後の時刻差は真の時刻差と一致する |
| 並行 sendRtp の FIFO 直列化（probe なし / あり、2 件） | 8 | DTLS 書き込みは常に 1 本ずつ。TSN は 1 から連番で、wire の順と SentInfo の順が一致する |
| media 番号と padding の衝突（5 件） | 8（legacy / GCC 交互） | 転送 media（gap・並べ替え・重複・上流の padding-only を含む）の番号と中身は source のまま。自前の padding は RTX SSRC だけで連番。NACK 用 cache は padding-only で上書きされない |

- 例ベースで残したもの: 共通契約（型・getter・no-op）、draft の example2（既知の正解ベクトル）、SRTP 往復・RED 後のサイズ・stop 時の commit・TWCC 未交渉時など単一シナリオの回帰、差し替え・停止の競合（特定の割り込み順を再現する回帰）。
- 故障注入での確認（確認後に元へ戻した）:
  - legacy の min を max に変える → 16 件失敗
  - 送信履歴の span 上限を外す → 12 件失敗
  - 送信履歴の時間窓を外す → 12 件失敗
  - RunLength 後の番号 cursor をずらす → 31 件失敗
  - reference_time の後退 wrap / 前進 wrap を無視する → 8 件 / 15 件失敗
  - legacy でも GCC でも FIFO を通さない → 6 件失敗
  - padding で media の番号をずらす → 8 件失敗
  - padding-only を NACK cache に入れる → 3 件失敗
- 最初の生成器では、span 上限・reference_time の後退 wrap・cache 上書きの 3 つの故障を検出できなかった。生成器を強めて（idle を減らし番号の飛びを大きくする、周回付近を前後させる、上流の padding-only を混ぜる）検出できるようにした。
- `bandwidthEstimator.test.ts` は 2,590 行から 2,262 行になった。例ベース 38 件、制御応答 7 件、性質テスト 140 系列（§2.12 の GCC 不変条件 24 系列を含む）、合計 185 ケース（共通基盤化の前の数値）。

#### 性質テストの共通基盤化（追加要件・2026-10-25）

要件: 性質テストは既存の実装と合わせて共通基盤にまとめ、その基盤を使う。

- 共通基盤は既存の `packages/webrtc/tests/pbt/shared/` とした（交渉の性質テスト `fuzz/` / `scenario/` / `model/` が使っていたもの）。
  - `shared/random.ts`: 既存の seed 付き乱数（mulberry32）。`between` / `int` を追加した。乱数列（`next`）は変えていないので、既存の seed は同じ操作を再現する。
  - `shared/seeds.ts`（新規）: `<PREFIX>_SEEDS` / `_SEED` / `_STEPS` から seed 一覧と手順数を決め、1 seed を再現する環境変数（`replay`）を返す。交渉の 3 つの性質テストもこれを使うように変えた（既定値・環境変数名・テスト名は変えていない）。
- TWCC / BWE / 送信経路の性質テストを、規約どおり 1 ディレクトリ 1 性質テストで `tests/pbt/` に移した。生成器は各ディレクトリの `generator.ts` に置き、テスト名に再現用の環境変数を出す。

| ディレクトリ | 性質（各 seed で実行） | 環境変数の接頭辞（CI 既定） | 移動元 |
| --- | --- | --- | --- |
| `tests/pbt/twcc/` | adapter の受信は高々 1 回・正しい世代、estimator に渡る受信も高々 1 回、wire 往復、周回をまたぐ並べ替え、reference_time の展開、送信履歴の窓 | `WERIFT_TWCC`（24 seed × 3,000 step） | `twccFeedbackAdapter.test.ts`、`bandwidthEstimator.test.ts` |
| `tests/pbt/bwe/` | GCC の通知は有限・[min, max] 内・変化時のみ、legacy の推定値は min(送信, 受信) の再計算と一致、legacy の通知は変化時のみ | `WERIFT_BWE`（24 seed × 3 フェーズ） | `bandwidthEstimator.test.ts` |
| `tests/pbt/sender/` | 転送の番号保存・切替の連続・RTX padding の連番・NACK cache、並行送信の FIFO 直列化と TSN 順 | `WERIFT_SENDER`（12 seed × 300 step） | `bandwidthEstimator.test.ts`、`rtpSender.test.ts` |

- 送信経路の 2 つの生成器（`bandwidthEstimator.test.ts` 側と `rtpSender.test.ts` 側）は、track 切替・上流の padding-only・自前の padding を含む 1 つの生成器にまとめた。
- 共通の Arrange（`prepareConnectedSender` / `startGccProbing` など）は `tests/media/twccTestUtils.ts` に移し、例ベースのテストと性質テストの両方から使う。`twccTestUtils.ts` にあった独自の乱数は削除し、`gccSimulation.ts` も共通の乱数を使う（同じ乱数列なので制御応答テストの結果は変わらない）。
- `npm run pbt:deep -- --suite twcc,bwe,sender` で、これらを seed 分割して並列に深く探索できるようにした（`tools/pbt-deep/run.ts`。既定の suite は交渉の 3 つのまま）。`packages/webrtc/AGENTS.md` に置き場所・コマンド・検証手順を追記した。
- 深い探索（300 seed）で legacy 推定の性質が 2 seed で失敗した。原因は性質側の期待値の計算で、受信時間幅を `送信間隔 × 倍率` で求めていたため、`Date.now()` 付近の絶対時刻で作る入力と丸めが 1 bps ずれていた。期待値を入力した時刻の差から求めるように直した（実装の不具合ではない）。
- 故障注入（確認後に元へ戻した）で、移した性質が引き続き失敗することを確認した: 受信確定で履歴から消さない（48 件）、span 上限なし（24 件）、reference_time の後退 wrap を無視（8 件）、RunLength 後の cursor ずれ（23 件）、legacy の min→max（24 件）、変化時のみ通知をやめる（24 件）、FIFO を通さない（11 件）、padding で media 番号をずらす（12 件）、padding-only を cache に入れる（5 件）。

#### 残したテスト（werift 固有の回帰）

- 共通契約: GCC フックの no-op、共通 interface に congestion 系を含めない、`senderBWE` は getter のみ、`onCongestion` の TypeScript 互換。
- legacy: 合成 TWCC での推定範囲、変化時のみ通知、pacing しない、送信履歴の時間窓 prune。
- TWCC 入力の解釈: wire 形式の TWCC、空 TWCC で通知しない、24-bit reference_time の周回、`receivedAtMs = 0` の扱い、周回した probe 番号、送信停止後の履歴 prune。
- `RTCRtpSender` 送信経路: padding（RTX SSRC・padding bit・サイズ・SRTP 往復）、FIFO 直列化、BUNDLE での TSN 順、キュー上限、stop 時の commit、RED 後のサイズ、TWCC 未交渉時、メディア番号の保持、SR octetCount。
- estimator の差し替え・停止: 差し替え後の配送、in-flight の汚染防止、ProcessInterval timer、dispose、ネットワーク可用性の同期。

#### トレードオフ（了承済み）

- Chrome（libwebrtc）との細かな挙動差（立ち上がりの速さ、probe の回数など）は検出しない。
- 判定が範囲なので、わずかな性能劣化は検出しない。範囲はこの時点の実測値（`gccSimulation.ts` での結果）を基準に決めた。
- 実装は libwebrtc の写しのまま残るため、実装の量・複雑さは変わらない。互換のための処理を削るかは別途判断する。

---

## 3. 技術的な実装アプローチ（調査結果の要約）

### 3.1 データフロー（現状・変更後とも同一の骨格）

```
[Sender] RTP + transport-wide seq (RTCDtlsTransport.transportSequenceNumber)
    → 相手 Receiver が ReceiverTWCC で到着時刻記録
    → RTCP TransportWideCC (FMT=15) を返送
    → RTCRtpSender.handleRtcpPacket
    → BandwidthEstimator.receiveTWCC(feedback)
    → availableBitrate 更新 → onAvailableBitrate
```

送信時:

```
RTCRtpSender.sendRtp
  → DTLS/SRTP 送信
  → BandwidthEstimator.rtpPacketSent({ wideSeq, size, sendingAtMs, sentAtMs })
```

### 3.2 抽象化の配置案

```
packages/webrtc/src/media/sender/
  bandwidthEstimator.ts      # 共通 interface（入力 + availableBitrate + onAvailableBitrate のみ）
  cumulativeResult.ts        # 現行用（維持）
  estimators/
    legacyCumulativeBwe.ts   # 現行ロジック + onCongestion / onCongestionScore（固有）
    gccBwe.ts                # GCC + overuse 等の固有イベント
  # 既存 senderBWE.ts は legacy 実装 / re-export / 互換 alias でも可
```

- `RTCRtpSender.setBandwidthEstimator(impl)` は **既存 sender** の差し替え API。新規 sender の初期実装は `PeerConfig.bandwidthEstimator`（後続要件 §2.10）でも選べる。
- `packages/rtp` はプロトコル層のまま（アルゴリズムは webrtc 側）。
- 低レイヤに推定を落とす必要はない（`AGENTS.md` の「manager 的オーケストレーションは webrtc」方針に合致）。

### 3.3 現行アルゴリズムの再利用

- `CumulativeResult` は send/receive interval から bitrate を出す単純統計。現行 estimator のコアなので **legacy 実装内に閉じる**。
- GCC は遅延勾配・ロス率を使うため `CumulativeResult` に依存しない別内部状態を持つ。

### 3.4 GCC 実装の要点（libwebrtc を参照）

- **入力**: 各パケットの `sendingAtMs` / size / wideSeq と TWCC の `receivedAtMs`・到達/未到達。必要なら feedback 欠損の扱いも参照実装に合わせる。
- **Delay-based**:
  - inter-arrival / delay gradient を推定（Kalman filter 等の libwebrtc 相当）。
  - overuse detector で underuse / overuse / normal。
  - AIMD rate controller で上限 bitrate を更新。
- **Loss-based**: 直近窓の loss fraction と参照実装の更新規則に従い target を調整。
- **Probe**: 短時間の高レート探索と結果の取り込み（probe controller 相当）。probation / probe 用パケットをどう送るかは、既存 `SentInfo.isProbation` や sender 配線の拡張要否を実装時に判断し、必要なら最小限の送信側フックを追加する。
- **結合**: delay / loss（および probe 結果）から最終 `targetBitrateBps` を決定し、`availableBitrate` に載せて変動時にイベント。
- **移植方針**:
  1. draft で全体像を固定。
  2. libwebrtc `goog_cc`（または同等モジュール）のコンポーネント境界に合わせて TypeScript モジュール分割。
  3. 定数・状態機械・更新式を可能な限り 1:1 に写す。
  4. 差分は意図的なものだけ残し、理由を記録。
- 簡略版へのフォールバックで完了としない。到達困難な差分のみ「既知の非互換」として明示する。
- 上記の移植方針は実装の進め方であり、テストの合否基準ではない。合否は §2.12 の制御応答テストと不変条件テストで判定する。

### 3.5 イベント実装パターン

- 既存 `Event`（`packages/common`）を継続利用。
- **共通**: `onAvailableBitrate` のみ。setter で常時 fire している現状を改める場合:

```ts
set availableBitrate(v: number) {
  if (v === this._availableBitrate) return;
  this._availableBitrate = v;
  this.onAvailableBitrate.execute(v);
}
```

- **固有**:
  - legacy: `onCongestion` / `onCongestionScore` を具象クラスに残す（`abr.ts` / `twcc/offer.ts` の既存購読を壊さない）。
  - GCC: overuse / underuse / loss 状態などは具象クラスのイベントまたは読み取り専用 state として公開し、共通 interface には載せない。
- 破壊的に「毎回 fire」に依存する利用者がいないか example / リポジトリ内を確認済み: 主に `abr.ts` の `console.log` と score ベース切替。**値変化時のみ**でも問題になりにくい。

### 3.6 選択のデフォルトと差し替え

- デフォルトは **現行（legacy）インスタンス**。GCC への silent なデフォルト変更はしない。
- 利用者が `setBandwidthEstimator(new GccBandwidthEstimator())` のように明示差し替えする。
- 新規 sender は `new RTCPeerConnection({ bandwidthEstimator: "gcc" })` 等でも初期実装を選べる（§2.10）。
- 差し替え後の安定購読は `sender.onAvailableBitrate`（sender ブリッジ）。固有シグナルは具象に再購読。

---

## 4. 考慮すべき制約・注意点

1. **プロトコルとアルゴリズムの混同を避ける**  
   TWCC draft は feedback 形式のみ。GCC は別 draft。Receiver 側 `ReceiverTWCC` を GCC 用に作り替える必要はない（dumb receiver のまま）。

2. **後方互換**  
   - デフォルトは現行 estimator のまま。推定結果・`onCongestion` / `onCongestionScore`（legacy 具象）を維持し、ABR example の閾値（例: congestionScore ≥ 5）を壊さない。  
   - `senderBWE` プロパティ名と `onAvailableBitrate` は維持。  
   - `setBandwidthEstimator` 追加は非破壊。constructor 必須オプションは増やさない。

3. **単位と時刻**  
   - bitrate は **bps**（現行 `CumulativeResult` も `* 8 * 1000`）。  
   - 送信時刻は `milliTime()`、TWCC 受信時刻は feedback 内 delta から ms 復元。GCC 実装時もタイムベースの一貫性に注意。

4. **transport-wide の粒度**  
  - sequence は `RTCDtlsTransport.transportSequenceNumberExtended`（wire は下位 16bit の `transportSequenceNumber`）で **transport 共有・単調増加**。
   - **ReceiverTWCC と TWCC RTCP 配送は DTLS transport 単位**（BUNDLE の audio/video を一つの feedback window で扱う。receiver ごとだと他 stream の TSN が PacketNotReceived になる）。
   - BWE インスタンスは **sender ごと**。受信した TWCC は同一 DTLS transport の全 sender に fan-out し、各 estimator は自分の `SentInfo`（extended TSN キー）のみ処理する。transport 単位の GCC/pacer 統合は非ゴール。

5. **REMB との関係**  
   - 現状 REMB は `receiverEstimatedMaxBitrate` 保持のみで BWE に未統合。本タスクでは必須統合しない。GCC loss-based が REMB を取る設計もあるが、TWCC パスを主とし、REMB 統合は optional / 後続。

6. **GCC の完成度（GCC として正しく機能すること）**  
   - draft-ietf-rmcat-gcc の delay-based・loss-based・probe・結合規則を備え、混雑で下げる・空けば上げる・ロスで下げる・probe で上限を探る・feedback 途絶で安全側へ下げる、という制御応答を満たすこと（§2.12）。
   - libwebrtc は参照実装とし、libwebrtc と 1:1 に一致すること（同じ処理順・同じ境界値・同じ内部状態遷移）は求めない。既存の互換のための処理（境界値や順序の調整）は残すが、テストでは固定しない。
   - 「動く簡略版」で完了としない。pure TypeScript 制約の範囲で、参照実装に無い独自ヒューリスティックの追加は避ける。

7. **パフォーマンス**  
   - `sentInfos` の掃除は現行どおり wideSeq 未満削除。GCC でも履歴窓を有限に保つ。

8. **テスト規約**  
   - Arrange の共通化、Act/Assert の日本語コメント。失敗を握りつぶさない。

9. **Windows 非対応**  
   - ランタイムは Unix 系。追加前提にしない。

10. **公開 API 変更時**  
    - ドキュメント / example を同時更新。不要な README カタログ肥大化は避ける。

11. **共通 interface を帯域通知に薄く保つ**  
    - congestion / overuse / score を共通化するとアルゴリズム間で意味がずれ、誤用しやすい。共通は `onAvailableBitrate` のみ。固有は具象側。

---

## 5. 完了条件

以下をすべて満たしたとき完了とする。

### 機能

- [x] 帯域推定が **インターフェース（または同等の抽象）** として定義され、TWCC 入出力と **`availableBitrate` / `onAvailableBitrate` のみ** が共通契約になっている（congestion 系は共通に含めない）。
  - 根拠: `BandwidthEstimator`（`media/sender/bandwidthEstimator.ts`）。legacy 互換の `onCongestion` は `LegacyCongestionCompatibility` として共通契約の外に置いている。
- [x] **現行アルゴリズム**が abstract の一実装として動き、**デフォルト**で従来と実用上同等の推定を保つ。legacy 固有の `onCongestion` / `onCongestionScore` も具象側で維持する。
  - 根拠: `SenderBandwidthEstimator`（既定・cumulative min(send,recv)）。`PeerConfig.bandwidthEstimator` の既定値は `"legacy"`。
- [x] **GCC アルゴリズム**が abstract の一実装として提供され、TWCC feedback から **delay-based / loss-based / probe** を用いて推定帯域を更新する。GCC 固有状態は具象イベント / state として分離する。
  - 根拠: `GccBandwidthEstimator`（Trendline + overuse + AIMD / LossBased / ProbeController）。
- [x] GCC 実装が draft-ietf-rmcat-gcc の主要コンポーネント（delay-based / loss-based / probe / 結合）を備え、**GCC として正しく機能する**（§2.12 の制御応答テストで判定。libwebrtc との 1:1 一致は求めない）。
  - 根拠: 既知差分は `GCC_KNOWN_DIFFERENCES`（`estimators/gcc/constants.ts`）に記載。ALR 専用 probe、完全な PacedSender、REMB、RR 由来の `updatePacketsLost` 配線は未対応で、差分または今後の課題として扱う。
- [x] 推定送信可能帯域が **変動したとき** `onAvailableBitrate`（共通契約）で **bps** が通知されることが、実装と JSDoc/ドキュメントで明確である（値不変時の不要通知を避ける実装が望ましい）。
  - 根拠: `onAvailableBitrate` は bps が変化したときだけ発火する（JSDoc と `packages/webrtc/README.md`）。
- [x] **`setBandwidthEstimator`（インスタンス差し替え）** が提供され、デフォルトは現行実装、ドキュメントまたは example で差し替え方が分かる。
  - 根拠: `RTCRtpSender.setBandwidthEstimator`。差し替え方は `packages/webrtc/README.md` に記載。
- [x] `PeerConfig.bandwidthEstimator` で新規 sender の estimator を `"legacy"` / `"gcc"` / 無効化 / factory から選べる（§2.10）。
- [x] `rtpSender.ts` が GCC 定数・型ガードを import せず、GCC 必要フックは `BandwidthEstimator` 上（legacy / disabled は no-op）。

### 品質

- [x] 現行 / GCC それぞれについて、合成入力による単体テストが追加されている（`onAvailableBitrate` 発火条件を含む）。
  - 根拠: `tests/media/bandwidthEstimator.test.ts`。
- [x] `setBandwidthEstimator` 差し替え後に新実装へ入力が渡り、共通イベントが新実装から発火することをテストする。
  - 根拠: `tests/media/bandwidthEstimator.test.ts`、`tests/media/rtpSender.test.ts`。
- [x] GCC について、混雑・容量の低下と回復・固定遅延・ロス・feedback 途絶・probe を含む制御応答テストがあり、決定的シミュレーションの範囲判定で回帰できる。
  - 根拠: `tests/media/bandwidthEstimator.test.ts` の「GCC 制御応答（仕様ベース）」7 件と「GCC 不変条件（性質テスト）」24 系列。シミュレーションは `tests/media/gccSimulation.ts`（§2.12）。
- [x] libwebrtc / draft との意図的差分一覧（無ければ「既知差分なし」）が docs または実装コメントで辿れる。
  - 根拠: `GCC_KNOWN_DIFFERENCES`。§2.12 以降は、libwebrtc との違いを把握するための参考情報として扱う（テストの合否基準ではない）。
- [x] `packages/webrtc` の type-check および関連テストが通る（例: `cd packages/webrtc && npm run type` / 追加テスト実行。必要に応じて `npm run test:small`）。
  - 根拠: `cd packages/webrtc && npm run type`、`npm test`、ルートの `npm run type` と `npm run test:small` が成功（2026-10-19）。
- [x] 既存 example（特に `simulcast/abr.ts`、`twcc/offer.ts`）がコンパイル・利用パターンとして破綻しない（legacy 固有イベント購読を含む）。
  - 根拠: ルートの `npm run type`（`tsconfig.json` は `examples` を含む）が成功。`examples/mediachannel/simulcast/abr.ts` と `examples/mediachannel/twcc/offer.ts` もこれでコンパイル確認済み。
- [x] 破壊的変更がある場合は CHANGELOG または README に移行手順を記載。ない場合はデフォルト互換を確認済みであること。
  - 根拠: `changelog.md` の Unreleased「⚠️ Breaking changes」に `senderBWE` の型、transport 単位の TWCC、`filterProbePaddingOnReceiveRtp` の既定値、GCC 送信経路を記載。

### 検証記録（2026-10-19）

- `npm run wpt --workspace packages/webrtc`: 2 回実行し、どちらも **REGRESSION 0**（runner の判定は success。FAIL は既存の upstream baseline）。
  - 1 回目: PASS 429 / FAIL 479 / TIMEOUT 43 / TOTAL 951
  - 2 回目: PASS 422 / FAIL 479 / TIMEOUT 44 / TOTAL 945（timeout したファイルは subtest 数が減るため、総数が実行ごとに揺れる）
- WPT リビジョン一致: `third_party/wpt/.git` が存在しない `/tmp/wpt-gitdir` を指しており `git submodule` では確認できないため、main checkout の module object store（読み取りのみ）で pin `121babb3c1d6a78dd0f638593c82d6cdcd0bcd18` の blob と照合した。runner が使う `webrtc/`（255 ファイル）と `resources/`（171 ファイル）、テストが参照する `common/` / `html/` / `mediacapture-streams/` の 8 ファイルがすべて一致し、余分なファイルもなかった。
- `cd e2e && npm run test:sim`（werift↔Chrome ボトルネック sim）: 2 回とも 1 件成功。
- `packages/webrtc` の `npm run type` / `npm test`（708 件成功・3 件 skip）、ルートの `npm run type` / `npm run test:small`: 成功。

### 検証記録（2026-10-21、§2.11 構造整理後）

- `cd packages/webrtc && npm run type`: 成功。`npm test`: 44 ファイル、738 件成功・3 件 skip。
- ルートの `npm run type` と `npm run test:small`: 成功。
- `cd packages/webrtc && npm run test:sim`: 4 件成功（RTX を negotiate。各シナリオで RTX padding 32〜79 件、media SSRC の padding 0 件）。
- `cd e2e && npm run test:sim`（werift↔Chrome）: 1 件成功。
- Biome（`packages/webrtc` の `src` / `tests` / `simulations`）: 指摘なし。
- WPT は今回再実行していない。

### 検証記録（2026-10-24、§2.12 テスト整理後）

- 作業開始時のリビジョンは `cec474f1`（未コミット変更なし）。変更はテストとドキュメントだけで、`src` の実装は変更していない。
- `cd packages/webrtc && npm run type`: 成功。`npx vitest run tests`: 60 ファイル、980 件成功・3 件 skip。
- `tests/media/bandwidthEstimator.test.ts` を 3 回続けて実行し、3 回とも 84 件成功（シミュレーションは固定シードで決定的）。
- 故障注入（overuse 減速・probe・loss-based・RTT backoff・変化時のみ通知をそれぞれ無効化）で、対応するテストが失敗することを確認した（§2.12）。
- Biome（`tests/media`）: 指摘なし。

### 検証記録（2026-10-25、性質テストへの置き換え後）

- 作業開始時のリビジョンは `6178a6a6`（未コミット変更なし）。変更はテストとチケットだけで、`src` は変更していない（故障注入の一時変更は戻した）。
- `cd packages/webrtc && npm run type`: 成功。`npx vitest run tests`: 60 ファイル、1,081 件成功・3 件 skip。
- `tests/media/bandwidthEstimator.test.ts` を 3 回続けて実行し、3 回とも 185 件成功。
- Biome（`tests/media`）: 指摘なし。

### 検証記録（2026-10-25、性質テストの共通基盤化後）

- 作業開始時のリビジョンは `88d87632`（未コミット変更なし）。変更はテスト・テスト用ツール・`packages/webrtc/AGENTS.md`・チケットだけで、`src` は変更していない（故障注入の一時変更は戻した）。
- `cd packages/webrtc && npm run type`: 成功。`npx vitest run tests`: 63 ファイル、1,165 件成功・3 件 skip。
- `npx vitest run tests/pbt`: 交渉の 3 suite（137 件）と媒体の 3 suite（240 件）がすべて成功。交渉側のテスト名は変わっていない。
- `npm run pbt:deep -- --suite twcc,bwe,sender --seeds 300 --jobs 8`: twcc 1,800 件・bwe 900 件・sender 600 件、すべて成功（22 秒）。
- `npm run pbt:deep -- --seeds 4 --steps 4 --jobs 8`（交渉の 3 suite、分割のパターンが合っているかの確認）: fuzz 10 件・scenario 91 件・model 55 件、すべて成功。
- 失敗した seed は、テスト名に出る環境変数（例: `WERIFT_TWCC_SEED=5 WERIFT_TWCC_SEEDS=1 WERIFT_TWCC_STEPS=3000`）で単独に再現できることを確認した。
- Biome（`tests` / `tools/pbt-deep` / `AGENTS.md`）: 指摘なし。

### ライセンス

- GCC 実装（`packages/webrtc/src/media/sender/estimators/gcc/`）は libwebrtc（BSD-3-Clause + PATENTS）の移植。帰属はルート `NOTICE`、各ファイル先頭の `/*!` ヘッダー、`third_party/libwebrtc-ref/{LICENSE,PATENTS,AUTHORS}`（pin と同じコミットから取得）で示す。

### 未対応・未確認（完了条件外の残課題）

- ALR 専用 probe、完全な PacedSender、REMB の取り込み、RR 由来の loss 配線（`updatePacketsLost`）。
- mediasoup interop、libwebrtc 実行結果との数値比較、E2E 全体実行時の ICE-TCP タイムアウトの原因。
- worktree の `third_party/wpt/.git` の gitdir 破損そのもの（main checkout の module を共有すると HEAD / index が干渉するため修復していない。上記のとおり内容は pin と一致）。
- GCC の送信キュー（`enqueueOutgoing`）と RTX padding の実トラフィック（Chrome 実機・mediasoup）での挙動は、sim と単体テスト以外では未検証。
- RTX を negotiate しない GCC sender は padding を送らない（`GCC_KNOWN_DIFFERENCES`）。media だけで probe cluster を埋められない場合の推定立ち上がりは libwebrtc より遅くなりうる。

### 非ゴール（本チケットでは必須としない）

- NADA / SCReAM 等の第三アルゴリズム実装。
- C++ libwebrtc のランタイムリンクや、Chrome 全体と bit 単位で同一の実行結果保証（言語・時刻源差による微小差は許容）。
- libwebrtc と同じ処理順・同じ境界値・同じ内部状態遷移で動くことを、テストで保証すること（§2.12）。
- エンコーダへの自動 bitrate 強制（アプリ側が `onAvailableBitrate` を購読して制御するのを基本とする）。
- REMB のみに依存するレガシー経路の全面置き換え（GCC が REMB を参照実装どおり取り込む場合は可。必須の別経路統合ではない）。
- Receiver 側 feedback 生成アルゴリズムの刷新（周期・バッチ条件の最適化は、互換に必要な範囲を除き別タスク可）。

---

## 参考リンク・主要ファイル

| 種別 | 参照 |
| --- | --- |
| TWCC draft | https://datatracker.ietf.org/doc/html/draft-holmer-rmcat-transport-wide-cc-extensions-01 |
| GCC draft | https://datatracker.ietf.org/doc/html/draft-ietf-rmcat-gcc-02 |
| libwebrtc 参照 | Chromium / libwebrtc の `goog_cc` / congestion_controller 周辺（実装時に該当パスを確定） |
| 現行 BWE | `packages/webrtc/src/media/sender/senderBWE.ts` |
| 累積統計 | `packages/webrtc/src/media/sender/cumulativeResult.ts` |
| Sender 配線 | `packages/webrtc/src/media/rtpSender.ts` |
| Receiver TWCC | `packages/webrtc/src/media/receiver/receiverTwcc.ts` |
| TWCC RTCP | `packages/rtp/src/rtcp/rtpfb/twcc.ts` |
| 利用例 | `examples/mediachannel/simulcast/abr.ts` |

---

## 実装時の推奨作業順

1. 共通 interface を **入力 + `availableBitrate` + `onAvailableBitrate` のみ** で定義。現行実装を適合（`onCongestion*` は具象に残す）し、帯域イベント「変化時のみ」とテスト。
2. `RTCRtpSender` に `setBandwidthEstimator` を追加。デフォルトは現行インスタンスのまま。差し替え時の配送切替テスト。
3. libwebrtc / draft を調査し、GCC をコンポーネント分割（delay / loss / probe / 結合）で TypeScript 移植。固有イベントは GCC 具象側。定数・状態機械を可能な限り 1:1 に寄せる。
4. 決定的入力・制御応答テスト + 既知差分の記録。
5. JSDoc / example 更新（setter 差し替え例、共通 vs 固有イベントの説明）、`packages/webrtc` の type とテストで検証。

---

## 決定事項（詳細化で確定）

| 項目 | 決定 |
| --- | --- |
| アルゴリズム選択 API | **`setBandwidthEstimator`** で既存 sender を差し替え。デフォルトは **現行（legacy）**。後続要件で **`PeerConfig.bandwidthEstimator`** による新規 sender の初期指定・無効化も追加 |
| 共通 interface のイベント | **推奨変更先帯域幅（`onAvailableBitrate`）のみ** |
| congestion / overuse 等 | **アルゴリズム固有イベントとして分離**（legacy の `onCongestion*` は具象維持、GCC は固有 state/event） |
| ピア間シミュレーション | **`packages/webrtc/simulations/`** で仮想帯域制限 + GCC/TWCC を検証。**CI 対象外**（`npm run test:sim`） |
| Chrome シミュレーション | **`e2e/simulations/`** で werift↔Chrome。ネットワーク制限は **werift 側 ICE**。**CI 対象外**（`cd e2e && npm run test:sim`） |
| TWCC feedback の照合 | 共通の **`TwccFeedbackAdapter`** が一度だけ正規化し、legacy / GCC はその出力だけを使う。受信確定で履歴から消し、受信時刻で重複を推測しない（§2.11） |
| probe / loss padding | **RTX SSRC** でだけ送る。RTX が無ければ送らない（既知差分）。media seq は `input + seqOffset` のまま（§2.11） |
| legacy / disabled の送信経路 | develop と同じ**直接送信**（送信キュー・pacing なし）。送信キューは GCC など pacing する estimator だけ（§2.11） |
| ReceiverTWCC の corrective feedback | **持たない**（dumb receiver。§4.1 と非ゴールに合わせる）（§2.11） |
| GCC のテストの合否基準 | **GCC として正しく機能すること**（制御応答・不変条件・werift 固有の回帰）。libwebrtc と同じ処理順・境界値の検証はしない。実装側の互換のための処理は残す（§2.12） |
