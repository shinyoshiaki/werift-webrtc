# タスク詳細化: Expand RTP packetizer and depacketizer codec coverage

## 1. タスクの目的と背景

`packages/rtp` (werift-rtp) はブラウザ間 WebRTC 以外でも、SIP ゲートウェイ、RTSP カメラ、メディアリレー、録音/録画パイプラインなどで再利用できるように設計されている。しかし現状のコーデック対応は以下の通り偏っており、実務で頻出するペイロード形式を扱えない。

- **Depacketizer のみ存在し、RTP パッケージ内には Packetizer が一切存在しない。**
  - Depacketizer: `packages/rtp/src/codec/` に `H264RtpPayload` / `Vp8RtpPayload` / `Vp9RtpPayload` / `AV1RtpPayload` / `OpusRtpPayload`。
  - Packetizer は `packages/webrtc/src/nonstandard/userMedia/packetizer.ts` にしかなく、WebRTC (mediabunny) に依存しているため、RTP パッケージ単体では使えない。
- 対応コーデック: H.264 / VP8 / VP9 / AV1 / Opus のみ。H.265、G.711 (PCMU/PCMA)、G.722、AAC (RFC 3640)、telephone event (RFC 4733) は未対応。

本タスクでは、RTP パッケージに **汎用コーデックの Packetizer / Depacketizer 一式** を追加し、非 WebRTC 用途 (RTP-over-UDP、SIP/RTSP インジェスト) を例示することを目的とする。

---

## 2. 実装すべき具体的な機能や変更内容

### 2.1 新規コーデック (packages/rtp/src/codec/)

既存の命名・構造規約 (`H264RtpPayload` 型の静的な `deSerialize(buf, fragment?)` と `*Packetizer` 型の `packetize(data, rtpTimestamp)` → `RtpPacket[]`) に従い、各コーデックは **depacketizer と packetizer を同一ファイルに同居** させる (h264.ts と同様の構成)。

| # | ファイル (新規) | Depacketizer | Packetizer | RFC |
|---|---|---|---|---|
| 1 | `codec/h265.ts` | `H265RtpPayload` | `H265Packetizer` | RFC 7798 |
| 2 | `codec/g711.ts` | `PcmuRtpPayload`, `PcmaRtpPayload` | `PcmuPacketizer`, `PcmaPacketizer` | RFC 3551 |
| 3 | `codec/g722.ts` | `G722RtpPayload` | `G722Packetizer` | RFC 3551 |
| 4 | `codec/mp4a.ts` | `AacHbrRtpPayload` | `AacHbrPacketizer` | RFC 3640 |
| 5 | `codec/telephoneEvent.ts` | `TelephoneEventRtpPayload` | `TelephoneEventPacketizer` | RFC 4733 |

#### H.265 / HEVC (RFC 7798)
- 2 バイトのペイロードヘッダ: F(1bit) / Type(6bit) / LayerId(6bit) / TID(3bit)。Type 0 = AP、1 = FU、2–63 = 単一 NAL (H.264 と違い単一 NAL も Type 値 2 以上)。
- **AP (Aggregation Packet)**: ペイロードヘッダ + (非インタリーブモードのため DONL は省略し、`sprop-max-don-diff` が 0 以外の場合は DONL(2バイト) を読み飛ばせるようにする) + [2バイト NAL サイズ + NAL] の繰り返し。キーフレーム時に VPS/SPS/PPS を AP に集約して送る機能を packetizer に持たせる。
- **FU (Fragmentation Unit)**: ペイロードヘッダ (Type=1) + FU ヘッダ (S / E / FuType(6bit)) + NAL ペイロード。S=1 の先頭パケットで元 NAL ヘッダ (LayerId/TID) を復元し、E=1 で組み立て完了 (`fragment` から `payload` へ、H.264 の FU-A と同様のフロー)。F ビットは FU では 1 に設定 (RFC 7798)。
- 入力形式: **Annex-B (start code) と長さ前置 (AVCC 形式)** の両対応。Annex-B 分割は `packages/rtp/src/extra/container/mp4/h264.ts:44` の `H264AnnexBParser` を参考にした H.265 用パーサを `codec/h265.ts` 内に実装。
- depacketizer の出力は H.264 と同じく **Annex-B (00 00 00 01 前置) で連結**。
- `isKeyframe`: NAL type が IRAP (16–21: BLA_W_LP〜CRA_NUT) の場合。
- `isDetectedFinalPacketInSequence`: `header.marker` (H.264 と同一)。
- `isPartitionHead`: FU の S ビット (H.264 と同一)。

#### G.711 PCMU / PCMA (RFC 3551)
- ペイロードヘッダ無し、生の 8bit サンプル列。
- **静的 PT / クロックレートを定数として正しく表現**: PCMU = PT 0 / 8000Hz、PCMA = PT 8 / 8000Hz (クラス定数または module 定数として export)。
- Depacketizer: ペイロードをそのまま返す (Opus と同型)。`isDetectedFinalPacketInSequence` は常に true。
- Packetizer: MTU 超過時に単純分割 (20ms=160バイト単位が実務のデフォルト、`frameDurationInMs` 等のオプションで調整可能)。

#### G.722 (RFC 3551 §4.5.2)
- **RTP タイムスタンプのクロックは 8000Hz** (コーデック自体は 16kHz サンプリングだが、RFC 3551 により RTP クロックは 8000Hz。ここを 16000 にしないこと)。
- 静的 PT = 9。ペイロードは生データ (G.711 と同じ扱い)。

#### AAC-hbr (RFC 3640)
- **AU Header Section**: 先頭に 16bit の `AU-headers-length` (bit 単位、16 の倍数) があり、続いて各 AU の AU-Header が並ぶ。
- AU-Header (hbr モード): AU-size 13bit (**バイト単位のサイズ − 1**。低レートモードの bit 単位と混同しない) + AU-Index / AU-Index-delta 3bit + オプションで AU-CTS-delta / AU-DTS-delta 各 14bit。CTS/DTS オプションは最小実装では省略し、パース時に存在検出できる構造にする。
- **MTU より大きい AU はフラグメンテーション**: 先頭フラグメントのみ AU Header Section を持ち、後続フラグメントは生データのみ (RFC 3640 §3.2.6)。
- 複数 AU を 1 パケットに連結可能 (AU-header を各 AU に付与)。
- レジストリ名: `MPEG4-GENERIC` (SDP の encoding name に合わせる。H.264 の `MPEG4/ISO/AVC` と同様の命名思想)。
- Depacketizer: AU-header-length を検証して (16bit 以上、16 の倍数、バッファ内) AU サイズの総和がバッファを超えないことを確認してから連結する。

#### RFC 4733 named telephone event (DTMF)
- ペイロード 4 バイト固定: event(8bit) / E(end of event, 1bit) / R(reserved, 1bit) / volume(6bit) / duration(16bit)。
- **"lower-level RTP primitive"** として、`RtpPacket` への de/serialize を持つ軽量クラス `TelephoneEventRtpPayload` を実装。`serialize()` 付き (既存 codec は deSerialize のみなので、本クラスは双方向 API を備えた例になる)。
- **marker はイベント最初のパケットで 1** (RFC 4733。通常の「最終パケットで marker=1」とは逆なので注意)。Packetizer 側は `packetize(event, volume, duration, ...)` で開始/継続/終了の 3 パターン (または開始時に marker) を生成。
- 動的 PT (実務デフォルト 101)、クロックはネゴシエーション依存 (通常 8000Hz、SDP では `telephone-event/8000` や `/48000` があり得る)。
- 単一パケット完結 (フレーム概念が無い) ため、`dePacketizeRtpPackets` のフレーム集約には載せず、クラス単体での利用を主とする (判断根拠をコメントで残す)。

### 2.2 レジストリ / ジェネリックパイプラインへの組み込み

`packages/rtp/src/codec/index.ts` を更新:

- 新規コードの `export *` 追加 (index.ts 経由で `src/index.ts` からも自動公開される)。
- `depacketizerCodecs` (index.ts:78) と `dePacketizeRtpPackets` の switch (index.ts:53) に追加:
  - `H265` → `H265RtpPayload`
  - `PCMU` / `PCMA` → 各ペイロード
  - `G722` → `G722RtpPayload`
  - `MPEG4-GENERIC` → `AacHbrRtpPayload`
  - (telephone event は上記の通りフレーム集約対象外)
- `extra/processor/depacketizer.ts` の `DepacketizeBase` は `dePacketizeRtpPackets` を経由するため、レジストリ追加だけで H.265/G.711/G.722/AAC の受信パイプラインに載る。

### 2.3 Packetizer の共通基盤 (packages/rtp/src/codec/)

RTP パッケージ初の Packetizer となるため、`webrtc` の `BasePacketizer` (packages/webrtc/src/nonstandard/userMedia/packetizer.ts:76) のセマンティクスを踏襲した共通基盤を `codec/base.ts` に追加する:

- `PacketizerBase`: `maxPayloadSize` (デフォルト `MTU` = 1200、`packages/rtp/src/const.ts`)、初期シーケンス番号 `random16()` (`common` から)、`buildPacket(payload, timestamp, marker)` で 1 パケット毎にシーケンス番号を +1 (uint16 wrap)。
- インターフェース: `interface Packetizer { packetize(data: Buffer, rtpTimestamp: number): RtpPacket[] }` (コーデック毎に必要な追加引数は個別オプションで)。
- 既存 webrtc 側 `BasePacketizer` との統一は行わない (依存関係を壊さないため。セマンティクスだけ揃える)。

### 2.4 webrtc パッケージの定数補助 (最小限)

`packages/webrtc/src/media/codec.ts` に静的 PT を持つ補助を追加:

- `usePCMA`: audio/PCMA, clockRate 8000, payloadType 8
- `useG722`: audio/G722, clockRate 8000, payloadType 9
- (usePCMU は既存: PT 0 / 8000Hz)
- H.265 / AAC の webrtc ネゴシエーション対応 (SDP 拡張、`userMedia` の packetizer 追加) は **本タスクの範囲外** とし、`supportedCodecs` リストも変更しない。RTP パッケージの再利用範囲で完結させる。

### 2.5 統合例 (非 WebRTC ユースケース)

`packages/rtp/examples/node/` に **plain RTP-over-UDP** の送受信例を追加。**検証は Node 製の別 UDP ピアで代替検証する方針に決定 (GStreamer には依存しない)**:

- `examples/node/rtp_over_udp/`:
  - **送信側** (`send.ts`): 新 packetizer で PCMU/G.722/AAC/H.265 を RTP 化し、`dgram` の UDP ソケットで宛先へ送出。
  - **受信側** (`recv.ts`): Node 製の別 UDP ピア (別プロセス、または同一プロセス内の別 dgram ソケット) から RTP を受信し、新 depacketizer でフレーム化して送信前データとの round-trip を自己検証。
  - 送信側と受信側を 127.0.0.1 のエフェメラルポートで接続し、外部ツール無しで動作・検証できる構成を基本とする。別プロセスとしての送受信は `npm run example` 相当のスクリプトで起動手順を示す。
- 参考として既存 `depaketize/gst.ts` の dgram 連携パターンは踏襲可能だが、実行・検証の必須条件にはしない。GStreamer は **テストベクタ生成 (後述 §2.7 / §3.3) にのみ**使用する。

### 2.6 ドキュメント / 公開 API の更新

- `packages/rtp/README.md`: 対応コーデック一覧と簡単な使用例 (packetize / depacketize) を追記。
- API ドキュメント再生成: `cd packages/rtp && npm run doc` (typedoc → `packages/rtp/doc`)。
- ルート `changelog.md`: 既存フォーマットに従い werift-rtp の機能追加として追記。

### 2.7 テストベクタ生成スクリプト (GStreamer)

外部リポジトリ (pion/rtp) や Wireshark pcap からの調達に依存せず、**GStreamer (`gst-launch-1.0`) で全コーデックのテストベクタを生成するスクリプトを実装して実行する**方針に決定:

- `packages/rtp/tools/generateVectors/`: `gst-launch-1.0` の各コーデック用ペイローダが `udpsink` へ送出する RTP を、既存 `depaketize/gst.ts` と同様に Node (dgram) で受信し、**各 RTP パケットのペイロードを生バイナリとして `packages/rtp/tests/data/` に保存**する。
- 生成物 (ベクタ) は**リポジトリにコミット**し、テスト本体 (`vitest`) は GStreamer 無しで実行できる (CI ではコミット済みベクタのみ使用)。再生成は手動でスクリプトを実行する。
- パイプライン例・代替手段は §3.3 に詳述。

### 2.8 仕様 (RFC) の入手と仕様照合による検証

**RFC 原文を `docs/rfc/` 以下にダウンロードして保存し、実装と仕様の正しさを検証することを必須要件とする**:

- 対象 RFC を **rfc-editor.org のテキスト版 (`https://www.rfc-editor.org/rfc/rfc<num>.txt`) からダウンロード** し、`docs/rfc/rfc<num>.txt` としてコミットする:
  - `rfc3551.txt` (PCMU / PCMA / G.722 の静的 PT・クロックレート)
  - `rfc3640.txt` (AAC / MPEG4-GENERIC の AU Header Section)
  - `rfc4733.txt` (named telephone event)
  - `rfc7798.txt` (H.265 / HEVC の AP / FU / 単一 NAL)
- 既存の `docs/rfc/rfc8445.txt` / `rfc8656.txt` と同じ慣習に従う (ファイルは RFC のまま配置し、パッケージに同梱しない)。
- **仕様照合の進め方**:
  - 各コードは実装ファイルの冒頭に RFC 番号と対応セクション (§4.3 の落とし穴リストの根拠となる箇所) をコメントで残す (vp9.ts が draft 番号をコメントしている慣習と同様)。
  - 合成ベクタや GStreamer 生成ベクタの期待値は、RFC 本文の図・具体例 (RFC 7798 付録 A、RFC 3640 §3.3.6 など) と突き合わせ、テストコメントに参照セクションを残す。
  - 実装・テストのレビュー時は `docs/rfc/` の原文を正として、ビットレイアウト・静的 PT/クロック・marker 規則のズレを検出する。

---

## 3. 技術的な実装アプローチ (調査結果)

### 3.1 既存のコード配置と規約

| 項目 | 場所 | 内容 |
|---|---|---|
| Depacketizer 基底 | `packages/rtp/src/codec/base.ts` | `DePacketizerBase`: `payload` / `fragment?` / `static deSerialize(buf, fragment?)` / `static isDetectedFinalPacketInSequence(header)` / `get isKeyframe` / `get isPartitionHead` |
| H.264 実装 (手本) | `packages/rtp/src/codec/h264.ts` | FU-A の `fragment` 蓄積 → E=1 でヘッダ復元し Annex-B 化。`stap_a` のサイズ検証。`isDetectedFinalPacketInSequence` は marker |
| 音声 (Opus) | `packages/rtp/src/codec/opus.ts` | フラグメント無し。`isDetectedFinalPacketInSequence` は常に true |
| レジストリ | `packages/rtp/src/codec/index.ts:53,78` | `dePacketizeRtpPackets` switch + `depacketizerCodecs` (大文字/小文字対応) |
| ジェネリック受信パイプライン | `packages/rtp/src/extra/processor/depacketizer.ts` | `DepacketizeBase` がレジストリ経由でフレーム化。シーケンス欠落検知・再同期も内蔵 |
| Packetizer の手本 | `packages/webrtc/src/nonstandard/userMedia/packetizer.ts:76` | `BasePacketizer`: `random16()` 初期シーケンス、`buildPacket(payload, timestamp, marker)`、MTU=1200、marker はフレーム最終パケット、H.264 は FU-A (fuIndicator/fuHeader) と STAP 相当のパラメータセット先頭付与 |
| MTU 定数 | `packages/rtp/src/const.ts` | `MTU = 1200` |
| Annex-B パーサ | `packages/rtp/src/extra/container/mp4/h264.ts:44` | `H264AnnexBParser`。H.265 の Annex-B 分割の参考実装 |
| 共通ユーティリティ | `packages/common/src/binary.ts` | `BitWriter` / `getBit` / `bufferWriter` / `bufferReader` / `paddingBits` / `BitStream`。`random16` は `common/src/network.ts` |
| leb128 | `packages/rtp/src/codec/leb128.ts` | AV1 で使用 (H.265 では不要だが参考) |
| テストの手本 | `packages/rtp/tests/codec/h264.test.ts` | `describe("packages/rtp/tests/codec/h264.test.ts")` 形式。既知 wire ベクタ (pion/rtp 由来) を検証 |
| 既存 DTMF フィクスチャ | `packages/rtp/tests/data/rtp_dtmf.bin` | PT 101 / 4 バイトペイロード。RFC 4733 depacketizer の wire ベクタに流用可能 (`tests/rtp/packet.test.ts:64`) |
| 非 WebRTC 例 | `packages/rtp/examples/node/depaketize/gst.ts` | dgram + `gst-launch-1.0` で RTP-over-UDP 受信 + depacketize する既存パターン |
| RFC 原文の保管 | `docs/rfc/` | `rfc8445.txt` / `rfc8656.txt` を既に保持。本タスクで `rfc3551` / `rfc3640` / `rfc4733` / `rfc7798` を追加 (rfc-editor.org のテキスト版) |

### 3.2 各コーデックの wire フォーマット要点 (RFC から)

> 各項目の根拠は `docs/rfc/` に保存した RFC 原文 (rfc3551 / rfc3640 / rfc4733 / rfc7798) であり、実装・テストの照合に使用する。

- **H.265**: ペイロードヘッダ 2 バイト固定 (F/Type/LayerId/TID)。AP=0 / FU=1 / 単一 NAL=2–63。AP は DONL 省略時「2 バイトサイズ + NAL」列。FU ヘッダは S/E/FuType。IRAP = type 16–21。
- **PCMU=PT0/8000Hz、PCMA=PT8/8000Hz、G.722=PT9/8000Hz** (RFC 3551 の静的割当。G.722 のクロックは 8kHz)。
- **AAC-hbr**: AU-headers-length (bit、16 の倍数) → AU-Header 列 (AU-size=バイト−1、13bit)。先頭フラグメントのみヘッダ。
- **telephone event**: event/E/R/volume/duration の 4 バイト。marker はイベント先頭パケットのみ。

### 3.3 テストベクタの調達方針 (GStreamer による一括生成)

外部リポジトリ (pion/rtp) や Wireshark pcap からの調達には依存しない。**GStreamer (`gst-launch-1.0`) で全コーデックのテストベクタを生成するスクリプトを実装し、実行して成果物をコミット**する:

- **生成スクリプト** `packages/rtp/tools/generateVectors/`: `gst-launch-1.0` のペイローダが `udpsink` へ送出する RTP を Node (dgram) で受信し、各パケットの **ペイロードを生バイナリで `tests/data/` に保存** する (既存 `depaketize/gst.ts` と同じ連携方式)。
  - **H.265**: `videotestsrc ! video/x-raw,width=640,height=480,format=I420 ! x265enc ! rtph265pay ! udpsink` (環境に x265enc が無い場合は、コミット済みの H.265 Annex-B エレメンタリストリームを `filesrc ! h265parse ! rtph265pay` で入力)。単一 NAL / AP / FU の各モードを収録。
  - **PCMU**: `audiotestsrc ! audioconvert ! audio/x-raw,rate=8000,channels=1 ! mulawenc ! rtppcmupay ! udpsink`
  - **PCMA**: `audiotestsrc ! audioconvert ! audio/x-raw,rate=8000,channels=1 ! alawenc ! rtppcmapay ! udpsink`
  - **G.722**: `audiotestsrc ! audioconvert ! audio/x-raw,rate=16000,channels=1 ! g722enc ! rtpg722pay ! udpsink`
  - **AAC (MPEG4-GENERIC / aac-hbr)**: `audiotestsrc ! audioconvert ! audio/x-raw,rate=48000,channels=2 ! avenc_aac ! rtpgstpay` 相当 (`rtpmp4gpay`) で AU ヘッダ付きペイロードを収録。AU が MTU を超える設定 (`max-size-time` 等) でフラグメンテーションも収録。
  - **DTMF**: 標準 GStreamer に telephone-event RTP ペイローダが無いため、この 1 コーデックのみ Node 側で合成した固定ベクタ (既存 `rtp_dtmf.bin` と同一形式) をコミットする。
- **生成物はリポジトリにコミット** し、テスト本体は GStreamer 無しで実行できる。スクリプトには必要なプラグイン (`gst-plugins-good` の mulawenc/alawenc、`gst-plugins-ugly` の x265enc 等) と起動手順をコメントで明記する。
- 補助として各モードの構造を検証する**合成ベクタ**も併用:
  - H.265: RFC 7798 付録 A のサンプルパケット構造を基に、単一 NAL / AP / FU の round-trip ベクタ (pion/rtp の `h265p packet` ベクタがあれば移植、h264.test.ts と同様のクレジット付き)。
  - AAC: RFC 3640 §3.3.6 の AU ヘッダ例 + フラグメンテーション (MTU 超過 AU → 複数 RTP) の round-trip。
  - DTMF: `tests/data/rtp_dtmf.bin` + 手組み 4 バイトベクタ。
- 全コーデック: **シーケンス番号連番・マーカ位置・MTU 分割境界** の検証 (既存 packetizer との一貫性)。

### 3.4 作業順序の目安

0. **RFC 入手**: rfc-editor.org から `rfc3551` / `rfc3640` / `rfc4733` / `rfc7798` を `docs/rfc/` に追加 → 1. `codec/base.ts` に `PacketizerBase` 追加 → 2. 音声系 (g711 / g722、単純) → 3. telephoneEvent → 4. mp4a (AAC) → 5. h265 (最複雑) → 6. レジストリ更新 → 7. **ベクタ生成スクリプト (`tools/generateVectors/`) の実装・実行 (GStreamer)** → 8. テスト (コミット済みベクタ + 合成ベクタ) → 9. webrtc 補助定数 → 10. 例 (Node UDP ピア) + ドキュメント。各ステップで §2.8 の仕様照合を行う。

---

## 4. 考慮すべき制約や注意点

### 4.1 堅牢性 (Malformed payloads)
- **無制限な確保・無終端ループを禁止**: AP の NAL サイズフィールド、AAC の AU-size、H.265 の FU 連結 (`Buffer.concat` の繰り返し) は、すべて「読み取り位置 + サイズ > バッファ長」を先に検証し、異常時は例外 (または `fragment` 破棄) で predictable に失敗させる。AGENTS.md の「Fix root causes. Do not silence failing tests」に従い、catch-and-ignore にしない。
- `deSerialize` は入力の最小長 (H.265: 2 バイト、DTMF: 4 バイト) を検証すること。

### 4.2 セマンティクスの一貫性
- シーケンス番号: パケット毎に +1 (uint16 wrap)。初期値は `random16()`。
- タイムスタンプ: 呼び出し元が指定し、フラグメント間で不変 (既存 packetizer と同一)。
- マーカ: フレーム最終パケット (DTMF のみ先頭で 1 という RFC 4733 の特例)。
- MTU: デフォルト 1200 (`const.ts` の `MTU`)、`maxPayloadSize` オプションで変更可。
- H.265 depacketizer の出力は Annex-B 連結 (H.264 と同一仕様)。既存コードが期待する形式を崩さない。

### 4.3 RFC の落とし穴
- **G.722 の RTP クロックは 8000Hz** (16kHz ではない)。
- **AAC-hbr の AU-size はバイト単位−1** (低レートモードの bit 単位と区別)。
- H.265 の単一 NAL は Type 2–63 (Type 0=AP, 1=FU は H.264 と意味が違う)。
- AP の DONL は非インタリーブ (DON 無し) を前提にしつつ、DONL 付き入力の耐性だけ持たせる。
- DTMF の marker は「イベント開始」で 1。
- **仕様の正しさは `docs/rfc/` の RFC 原文を根拠に検証する**: ビットレイアウト・静的 PT/クロック・marker 規則は、実装前に必ず該当セクション (RFC 7798 §4.4 系、RFC 3640 §3.3.6、RFC 4733 §2 など) で確認する。セクション番号は実装・テストのコメントに残し、レビューで突き合わせる。

### 4.4 スコープ・パッケージ境界
- 新規依存パッケージを追加しない (Node >= 10、dgram は組み込み)。
- `webrtc` パッケージへの変更は `usePCMA` / `useG722` の定数補助のみに留める。SDP ネゴシエーション / userMedia packetizer への H.265/AAC 追加は範囲外。
- AGENTS.md #14: WPT 用の strict シムを `src` 側に漏らさない (WPT は今回対象外)。
- テストは Arrange / Act / Assert の 3 フェーズで書き、Act/Assert には**日本語コメント**を付ける。Arrange 用共通ユーティリティ (RTP パケット組み立てなど) は `tests/utils.ts` に集約する。

### 4.5 検証コマンド
- パッケージ内: `cd packages/rtp && npm run type && npm test`
- クロスパッケージ (webrtc 補助定数変更時): `npm run type` と `npm run test:small`
- 例の実行・検証: **Node 製の別 UDP ピアで自己検証** (GStreamer 不要)。
- テストベクタ生成・再生成時のみ: GStreamer (`gst-launch-1.0`) が必要。生成スクリプト `packages/rtp/tools/generateVectors/` に実行手順と必要プラグインを明記し、成果物はコミット済み (開発/CI 環境に GStreamer が無くてもテストは実行可能)。
- 仕様照合: `docs/rfc/` の RFC 原文と、実装・テストに残したセクション参照を突き合わせる (手動レビュー + コメント参照)。RFC のダウンロードは rfc-editor.org から一度行いコミットするため、通常のビルド・テストには不要。

---

## 5. 完了条件

1. 各コーデックの **packetization / depacketization テストが既知 wire-format ベクタで合格** する (`tests/codec/h265.test.ts`, `g711.test.ts`, `g722.test.ts`, `aac.test.ts`, `telephoneEvent.test.ts`)。ベクタは GStreamer 生成スクリプト (`packages/rtp/tools/generateVectors/`) の成果物を `tests/data/` にコミットした実パケットと、RFC を基にした合成ベクタで構成され、**テスト本体は GStreamer 無しで実行できる**。
2. H.265 が **Annex-B と長さ前置の両入力**、**AP / FU / 単一 NAL** を処理できる。AP によるパラメータセット (VPS/SPS/PPS) 集約が packetizer にあり、キーフレーム検出 (IRAP 16–21) が正しい。
3. AAC が **AU Header Section (hbr: AU-size=バイト−1) のパース** と、**MTU 超過 AU のフラグメンテーション** (先頭のみヘッダ付与) を正しく処理する。
4. **PCMU (PT 0 / 8000Hz)、PCMA (PT 8 / 8000Hz)、G.722 (PT 9 / 8000Hz)** の静的 PT・クロックレート定数が公開され、テストで検証される。
5. 不正ペイロード (AP サイズ超過、AU-headers-length 不正、短すぎる入力) が**予測可能な例外で失敗**し、無制限なメモリ確保・無限ループがないこと。
6. **シーケンス番号 / タイムスタンプ / マーカ / MTU 挙動** が既存 packetizer と一貫している (テストで担保)。
7. `packages/rtp/src/codec/index.ts` のレジストリ (`depacketizerCodecs` + `dePacketizeRtpPackets`) に新コーデックが登録され、`packages/rtp/src/index.ts` の **public export と API ドキュメント (typedoc 再生成) に全コーデックが記載**される。README と `changelog.md` も更新。
8. **非 WebRTC の統合例** (`examples/node/rtp_over_udp/` 等) が動作し、**Node 製の別 UDP ピアとの送受信 round-trip** を確認できる (GStreamer 不要)。
9. **テストベクタ生成スクリプト** (`packages/rtp/tools/generateVectors/`) が実装され、実行して H.265 / PCMU / PCMA / G.722 / AAC (DTMF は合成) のベクタを `tests/data/` に生成・コミットできる。
10. **RFC 原文が `docs/rfc/` に追加されている** (`rfc3551` / `rfc3640` / `rfc4733` / `rfc7798`)。各実装・テストに RFC のセクション参照コメントが残り、ビットレイアウト・静的 PT/クロック・marker 規則が RFC 原文と照合済みである。
11. 検証: `cd packages/rtp && npm run type && npm test` が全て成功。webrtc 定数追加後は `npm run type` / `npm run test:small` も成功。