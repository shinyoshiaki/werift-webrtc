親・子チケットの内容を確認しました。子チケットの追加内容（既存コーデックの Packetizer 実装と Chrome E2E 検証）を、親チケットの既存セクション（1〜5）を保持したまま、セクション 6 以降として統合し、内部参照も番号整合させます。

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
- 2 バイトのペイロードヘッダ: F(1bit) / Type(6bit) / LayerId(6bit) / TID(3bit)。RFC 7798: Type **48** = AP、**49** = FU、その他 = 単一 NAL（旧メモの Type 0/1 は誤りで RFC を正とする）。AP の PayloadHdr は F=全 NAL の OR、LayerId/TID=最小値。
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
- AU-Header (hbr モード): AU-size 13bit (**バイト単位のサイズそのもの** — RFC 3640 §3.2.1.1 "size in octets"。旧メモの「−1」は誤りで RFC を正とする) + AU-Index / AU-Index-delta 3bit + オプションで AU-CTS-delta / AU-DTS-delta 各 14bit。CTS/DTS はデフォルト aac-hbr では省略し、`AacHbrDepacketizerOptions.ctsDtsPresent` でパース、または AU-headers-length から存在検出できる構造にする。
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
- **AAC-hbr の AU-size はバイト単位のサイズそのもの** (RFC 3640 §3.2.1.1。旧メモの「−1」は不採用)。
- H.265 の AP=Type 48、FU=Type 49 (RFC 7798。旧メモの 0/1 は不採用)。
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

---

## 6. タスクの目的と背景

親チケット（Expand RTP packetizer and depacketizer codec coverage）により、`packages/rtp` には **新規コーデック**（H.265 / G.711 / G.722 / AAC-hbr / telephone-event）の **Packetizer + Depacketizer** と共通基盤 `PacketizerBase` が揃った。一方、**以前から Depacketizer だけ存在していた既存コーデック**については、RTP パッケージ内に Packetizer がまだ無い。

| コーデック | Depacketizer (`packages/rtp/src/codec/`) | Packetizer in `packages/rtp` | Packetizer の現状 |
|---|---|---|---|
| H.264 | `H264RtpPayload` (`h264.ts`) | **未実装** | `packages/webrtc/.../userMedia/packetizer.ts` の `H264Packetizer` のみ（mediabunny 依存） |
| VP8 | `Vp8RtpPayload` (`vp8.ts`) | **未実装** | 同上 `Vp8Packetizer` |
| VP9 | `Vp9RtpPayload` (`vp9.ts`) | **未実装** | 同上 `Vp9Packetizer` |
| AV1 | `AV1RtpPayload` (`av1.ts`) | **未実装** | 同上 `Av1Packetizer` |
| Opus | `OpusRtpPayload` (`opus.ts`) | **未実装** | 同上 `OpusPacketizer` |
| H.265 / PCMU / PCMA / G.722 / AAC / DTMF | あり | **あり**（親チケットで追加済み） | RTP パッケージ単体で利用可 |

README でも明示されている通り、H.264 / VP8 / VP9 / AV1 / Opus の packetize は「see webrtc userMedia」扱いで、**非 WebRTC 用途（RTP-over-UDP、SIP/RTSP、メディアリレー）では `werift-rtp` 単体で送れない**。

本タスクの目的:

1. 上記 5 コーデックについて **RFC / 公式 RTP payload 仕様を調査・原文保存** し、ビットレイアウトと marker / フラグメント規則を確定する。
2. 親チケットで確立した規約（`PacketizerBase`、depacketizer と同一ファイル同居、round-trip テスト、RFC コメント）に従い、**`packages/rtp` に Packetizer を実装**する。
3. webrtc 側の実装は **参照実装・セマンティクスの手本** として使い、mediabunny / `EncodedPacket` に依存しない `Buffer` 入力 API に落とす（webrtc とのクラス統合は行わない。任意の薄いラップは範囲外または後続で可）。

---

## 7. 実装すべき具体的な機能や変更内容

### 7.1 対象コーデックとファイル（既存ファイルへ Packetizer を同居）

| # | ファイル | Depacketizer（既存） | 追加する Packetizer | 仕様 |
|---|---|---|---|---|
| 1 | `codec/vp8.ts` | `Vp8RtpPayload` | `Vp8Packetizer` | **RFC 7741** |
| 2 | `codec/vp9.ts` | `Vp9RtpPayload` | `Vp9Packetizer` | **RFC 9628**（Standards Track, March 2025。旧 draft-ietf-payload-vp9 の RFC 化版。正本は `docs/rfc/rfc9628.txt`） |
| 3 | `codec/av1.ts` | `AV1RtpPayload` | `Av1Packetizer`（命名は既存 webrtc と揃える） | **AV1 RTP spec**（https://aomediacodec.github.io/av1-rtp-spec/） |
| 4 | `codec/opus.ts` | `OpusRtpPayload` | `OpusPacketizer` | **RFC 7587** |
| 5 | `codec/h264.ts` | `H264RtpPayload` | `H264Packetizer` | **RFC 6184** |

いずれも `export class *Packetizer extends PacketizerBase` とし、公開 API は:

```ts
packetize(data: Buffer, rtpTimestamp: number): RtpPacket[]
```

キーフレーム情報などコーデック固有の追加入力は **options / 第 3 引数 / 専用メソッド** で受け、`Packetizer` インタフェースを壊さない（親チケットの `AacHbrPacketizer.packetizeAccessUnits` / `TelephoneEventPacketizer.packetizeStart` と同型の拡張方針）。

### 7.2 各コーデックの Packetizer 要件

#### VP8（RFC 7741）

- **入力**: 1 フレーム分の生 VP8 ビットストリーム（パーティション分割済みでなくてよい。実務は単一パーティション PID=0 を想定）。
- **Payload Descriptor（必須 1 バイト）**:
  - `X|R|N|S|R|PID`
  - フレーム先頭チャンク: **S=1, PID=0**（webrtc 実装は `0x10`）。
  - 後続チャンク: **S=0, PID=0**（`0x00`）。
  - 最小実装では **X=0**（拡張無し）。任意で `Vp8PacketizerOptions` に `pictureId` / `enableExtensions` を足し、X/I/M 付き descriptor を出せるようにしてもよい（depacketizer は既に X/I をパース可能）。
- **フラグメント**: `maxPayloadSize - descriptorLen` で分割。descriptor は各 RTP に付与。
- **marker**: フレーム最終パケットで `true`（`isDetectedFinalPacketInSequence` = `header.marker` と整合）。
- **キーフレーム**: VP8 payload header の **P bit**（`sBit===1 && pid===0` のとき depacketizer が読む）。packetizer は入力フレーム先頭 3 バイトの P を改変しない（エンコーダ出力をそのまま載せる）。オプションで `isKeyframe` を渡す必要は通常なし。
- **round-trip**: `Vp8Packetizer` → `dePacketizeRtpPackets("VP8", packets)` で元フレームに戻ること（descriptor は depacketizer が除去し payload を連結する既存経路）。

#### VP9（RFC 9628 — 確定）

- **仕様正本（調査済み）**: `draft-ietf-payload-vp9` は **RFC 9628**（Category: Standards Track, March 2025, authors Uberti et al.）として公開済み。実装・テストの照合先は **`docs/rfc/rfc9628.txt`**（取得元: `https://www.rfc-editor.org/rfc/rfc9628.txt`）。draft-16 は歴史的参照のみ。`vp9.ts` 冒頭コメントを draft URL から RFC 9628 に更新する。
- **入力**: 1 フレーム分の生 VP9 ビットストリーム。
- **Payload Descriptor（必須 1 バイト以上）**（RFC 9628 の descriptor 節に照合）:
  - 先頭: `I|P|L|F|B|E|V|Z`
  - 最小実装（webrtc 互換・RFC 合法サブセット）:
    - `I=0`（Picture ID 無し）、`L=0`、`F=0`、`V=0`、`Z=0`
    - `P=1` なら inter-predicted（delta）、`P=0` なら key（非 inter）
    - `B=1` フレーム先頭チャンク、`E=1` フレーム末尾チャンク
  - `isKeyframe` / `frameType: "key" | "delta"` を `Vp9PacketizerOptions` または `packetize` の付加引数で受け、P ビットを設定。
- **フラグメント**: `maxPayloadSize - 1`（descriptor 1 バイト）。B/E はチャンク境界で正しく立てる。
- **marker**: 最終パケットで `true`。
- **round-trip**: webrtc の `userMedia.packetizer.test.ts`（VP9）と同等の期待を `packages/rtp/tests/codec/vp9.test.ts` に packetize 側として追加。

#### AV1（AV1 RTP payload format）

- **入力**: 1 サンプル分の OBU 列（size field 付き / 無しの両方を受けられること。webrtc の `splitAv1Obus` 相当を `av1.ts` に移すか共有する）。
- **Aggregation Header（1 バイト）**: `Z|Y|W|N|-|-|-`
  - `Z`: 先頭 OBU element が前パケットからの継続フラグメント
  - `Y`: 末尾 OBU element が次パケットへ続く
  - `W`: 要素数（webrtc 互換では単一要素時 `W=1`、size 無しで element 本体のみ）
  - `N`: 新しい coded video sequence の先頭（キーフレーム時、かつフレーム内最初のパケットのみ 1）
  - **制約**: `N=1` と `Z=1` の同時は禁止（既存 deSerialize が throw）
- **処理**:
  1. サンプルを OBU に分割
  2. 各 OBU が `maxPayloadSize - 1` に収まるなら 1 RTP（Z=0,Y=0）
  3. 超える場合はフラグメント列（先頭 Z=0 Y=1、中間 Z=1 Y=1、末尾 Z=1 Y=0）
  4. フレーム最終 RTP に **marker=true**
- **キーフレーム**: `N` ビット + 呼び出し側の key 指示（`Av1PacketizerOptions.isKeyframe` または packetize 付加引数）。
- **getFrame との整合**: packetize → `dePacketizeRtpPackets("AV1", …)` / `AV1RtpPayload.getFrame` で元 OBU 列に復元（webrtc テストの期待と同等）。
- webrtc 側の `createAv1AggregationHeader` / `splitAv1Obus` を **rtp パッケージへ移植**し、重複ロジックの正を rtp 側にする。

#### Opus（RFC 7587）

- **ペイロードヘッダ無し**。RTP ペイロード = Opus パケットそのもの。
- **通常 1 RTP = 1 Opus パケット**（webrtc `OpusPacketizer` と同じ）。
- MTU 超過時の扱い:
  - Opus は実務上 MTU 未満が普通。超過時は **1 パケットのまま送る**か、**明示エラー**にするかを仕様コメントで固定（推奨: `maxPayloadSize` を超えたら throw して呼び出し側に TOC 分割を委ねる、または G.711 と同様に単純分割は **しない** — RFC 上 Opus の TOC を壊す単純分割は不可）。
- **marker**: `true`（1 パケット完結。`isDetectedFinalPacketInSequence` は常に true と整合）。
- 静的ではない動的 PT（実務デフォルト 96 前後）。`PacketizerBase` の `payloadType` オプションで指定。クロック 48000Hz は定数として export してよい（`OPUS_CLOCK_RATE = 48000`）。

#### H.264（RFC 6184）

- **packetization-mode=1（Non-Interleaved）** を実装対象とする（Single NAL / **STAP-A** / FU-A）。mode 0 のみ・Interleaved（FU-B/MTAP）は送信側の必須範囲外。
- **入力**:
  - **Annex-B**（start code）: 既存 `H264AnnexBParser`（`packages/rtp/src/extra/container/mp4/h264.ts`）を利用。
  - **AVCC 長さ前置**: `naluLengthSize`（デフォルト 4）で NAL 分割（webrtc / H265Packetizer と同型）。
- **Single NAL**: NAL 全体が `maxPayloadSize` 以下なら NAL をそのまま RTP ペイロード。
- **FU-A**（Type=28）: NAL が MTU 超過時。fuIndicator = `(nalHeader & 0xe0) | 28`、fuHeader = S/E/R|Type。S/E と marker（最終 NAL の最終フラグメントのみ）は webrtc `H264Packetizer` と同じ。
- **キーフレーム時の SPS/PPS 付与（確定: STAP-A 優先、フォールバックは個別 Single NAL）** — 本スコープに含む（follow-up にしない）:
  1. `parameterSets?: Buffer[]`（生 SPS/PPS NAL、start code 無し）を options で受け取る。サンプル内に既に SPS/PPS（type 7/8）が含まれる場合は二重付与しない。
  2. IDR（または key 指示）時、未含まれる parameter sets を NAL 列先頭へ前置する。
  3. **先頭の連続 parameter-set NAL が 2 本以上あり、STAP-A に収まる場合は STAP-A（Type=24）で集約送信**する。レイアウトは RFC 6184 §5.7.1: STAP-A header (F/NRI/Type=24) + 繰り返し `[16-bit NALU size][NAL]`。F/NRI は集約 NAL から RFC の規則で導出（既存 depacketizer の STAP-A 経路と round-trip）。
  4. **STAP-A にできない場合**（1 本のみ、または `1 + Σ(2+len)` が `maxPayloadSize` 超過で 2 本以上を詰められない）は **個別 Single NAL で先行送信**する（webrtc `H264Packetizer` と同経路）。
  5. 上記は **`H265Packetizer` の AP 集約ロジックと同じ方針**（`h265.ts` の parameter-set AP 試行 → 失敗時は個別送信）。実装コメントと README に「keyframe 時 SPS/PPS は STAP-A 優先、不可時は Single NAL」と明記し、実装と文書を一致させる。
  6. STAP-A の必須テスト: SPS+PPS が 1 STAP-A に載る合成ベクタ → depacketize で Annex-B 連結復元。MTU を極端に小さくしてフォールバック（個別 Single NAL）になるケースも 1 本以上。
- **出力整合**: depacketizer は Single/STAP-A/FU-A を **Annex-B 連結**で返す。round-trip は「入力 NAL 内容」と「Annex-B 出力の NAL 本体」の一致で検証（start code の有無差に注意）。
- **isKeyframe**: NAL type 5（IDR）— 既存 `H264RtpPayload.isKeyframe` と整合。

### 7.3 共通基盤の再利用（新規 `base.ts` 変更は最小）

既に親チケットで追加済み:

- `Packetizer` インタフェース
- `PacketizerBase`（`maxPayloadSize` デフォルト `MTU=1200`、`random16()` 初期シーケンス、`buildPacket`、uint16 wrap）

本タスクでは原則 **変更不要**。必要なら:

- 共通ヘルパ（例: `splitIntoChunks(buf, size)`）を `base.ts` または codec 内 private に置く程度。
- webrtc の `BasePacketizer` との統合・依存方向の逆転は **しない**（親チケット 2.3 と同じ。rtp ← webrtc の依存を壊さない）。

### 7.4 レジストリ / export

- `packages/rtp/src/codec/index.ts` は既に `export * from "./vp8"` 等があるため、**ファイル内に Packetizer を export すれば public API に載る**。
- `depacketizerCodecs` / `dePacketizeRtpPackets` は **変更不要**（受信側は既存）。
- packetizer 用の中央レジストリは現状無い。必要なら任意で `packetizerCodecs` や factory を足してよいが **必須ではない**（親チケットの新規コーデックも factory 無し）。

### 7.5 webrtc パッケージとの関係

| 項目 | 本タスクの扱い |
|---|---|
| `userMedia/packetizer.ts` の既存クラス | **追加要件（§12）により削除し `packages/rtp` へ統合済み** |
| mediabunny `EncodedPacket` | rtp 側 API に持ち込まない（webrtc 側の薄いアダプタで変換） |
| webrtc を rtp の Packetizer に差し替え | **追加要件（§12）として本チケットで実施**。回帰は `npm run test:small` + userMedia 系 + Chrome E2E |
| `packages/webrtc/src/media/codec.ts` | 本タスクで必須の定数追加なし（useVP8 等は既存想定） |

### 7.6 仕様（RFC / ドラフト）の入手と照合

親チケットと同様、**原文を `docs/rfc/` に保存して照合必須**:

| ファイル | 内容 | 取得元 | 状態 |
|---|---|---|---|
| `docs/rfc/rfc7741.txt` | VP8 | https://www.rfc-editor.org/rfc/rfc7741.txt | 実装時に配置 |
| `docs/rfc/rfc6184.txt` | H.264 | https://www.rfc-editor.org/rfc/rfc6184.txt | 実装時に配置 |
| `docs/rfc/rfc7587.txt` | Opus | https://www.rfc-editor.org/rfc/rfc7587.txt | 実装時に配置 |
| **`docs/rfc/rfc9628.txt`** | **VP9（正本）** | **https://www.rfc-editor.org/rfc/rfc9628.txt** | **確定**（draft-ietf-payload-vp9 の RFC 化。Standards Track, March 2025） |
| `docs/rfc/av1-rtp-spec.txt` または HTML のテキスト保存 | AV1 RTP | https://aomediacodec.github.io/av1-rtp-spec/ | 実装時に配置 |

- **VP9 仕様正本の調査結果（確定）**: IETF datatracker / rfc-editor 上、VP9 RTP payload は **RFC 9628** として 2025-03 に Standards Track 公開済み。`vp9.ts` の旧コメント（draft-ietf-payload-vp9-16）は実装時に RFC 9628 へ更新。draft ファイルを `docs/rfc/` に残す必要は無い（正本は rfc9628.txt のみ）。
- 各実装ファイル冒頭に仕様 ID と主要セクションをコメント（既存 `vp8.ts` / `vp9.ts` / `av1.ts` / `h264.ts` のコメントを拡充）。
- テストコメントに「RFC 7741 §4.x」「RFC 9628」「AV1 RTP §4.4」等の参照を残す。
- **仕様の正は `docs/rfc/`**。webrtc 実装と RFC が食い違う場合は RFC を優先し、差分をテストコメントに記録（webrtc 側の最小 descriptor は RFC の合法サブセットであることが多い）。

### 7.7 テスト

| ファイル | 内容 |
|---|---|
| `tests/codec/vp8.test.ts`（**新規**） | descriptor 最小形、フラグメント、marker、round-trip、キーフレーム（P=0）検出 |
| `tests/codec/vp9.test.ts`（**拡張**） | 既存 parse テストに加え packetize round-trip / B·E·P・marker |
| `tests/codec/av1.test.ts`（**拡張**） | OBU 分割・フラグメント Z/Y/N・marker・getFrame round-trip（webrtc テストの移植） |
| `tests/codec/opus.test.ts`（**新規**） | 単一パケット round-trip、PT/marker、MTU 超過時の契約 |
| `tests/codec/h264.test.ts`（**拡張**） | Single NAL / FU-A / **STAP-A（SPS+PPS 集約）** / STAP-A 不可時の Single NAL フォールバック / Annex-B と長さ前置 / IDR keyframe / round-trip |

方針（親チケットと同じ）:

- **合成ベクタ**（RFC 図・既知ビット）+ 可能なら **GStreamer 生成ベクタ**を `tests/data/` にコミット。
- テスト本体は GStreamer 無しで `vitest` 実行可能。
- Arrange / Act / Assert。Act・Assert に**日本語コメント**。共通 Arrange は `tests/utils.ts` 等に集約。
- 不正入力（短すぎる H.264 NAL、AV1 の N∧Z、負の maxPayloadSize は Base で既存）は予測可能に失敗。

### 7.8 テストベクタ生成スクリプト（任意〜推奨）

`packages/rtp/tools/generateVectors/` を拡張:

| コーデック | GStreamer の目安 |
|---|---|
| VP8 | `vp8enc ! rtpvp8pay` |
| VP9 | `vp9enc ! rtpvp9pay`（プラグイン可用性に依存） |
| H.264 | `x264enc ! rtph264pay` |
| Opus | `opusenc ! rtpopuspay` |
| AV1 | 環境依存（`av1enc` / `rav1enc` + payloader）。難しければ合成ベクタのみで完了条件を満たす |

- 成果物は `tests/data/vector_vp8.bin` 等としてコミット。`VECTOR_SOURCE.md` を更新。
- GStreamer が無い CI でもテストは通る。

### 7.9 統合例・ドキュメント

- `examples/node/rtp_over_udp/send.ts` / `recv.ts`: codec 引数に `vp8` / `vp9` / `av1` / `opus` / `h264` を追加し、Node dgram の round-trip 自己検証（親チケット例の延長）。
- `packages/rtp/README.md`: 対応表の「(see webrtc userMedia)」を **パッケージ内 Packetizer 名** に更新。使用例を 1〜2 コーデック分追記。
- `changelog.md`: werift-rtp に既存コーデック packetizer 追加を追記。
- API ドキュメント: `cd packages/rtp && npm run doc`。

---

## 8. 技術的な実装アプローチ（調査結果）

### 8.1 現状マップ

| 項目 | 場所 | メモ |
|---|---|---|
| Packetizer 共通基盤 | `packages/rtp/src/codec/base.ts` | 親チケット済み。本タスクはこれを継承 |
| 手本（rtp 内） | `h265.ts` の `H265Packetizer`、`g711.ts` の単純分割 | 同居・options・エラー処理の型 |
| 手本（webrtc） | `packages/webrtc/src/nonstandard/userMedia/packetizer.ts` | VP8/VP9/AV1/Opus/H264 の **動く最小実装** |
| webrtc の round-trip テスト | `packages/webrtc/tests/nonstandard/userMedia.packetizer.test.ts` | VP9 / AV1 の期待値を rtp テストへ移植可能 |
| Depacketize 集約 | `codec/index.ts` の `dePacketizeRtpPackets` | VP8/VP9/H264 は `basicCodecParser`（payload 連結）、AV1 は `getFrame` |
| Annex-B パーサ | `extra/container/mp4/h264.ts` の `H264AnnexBParser` | H264Packetizer が利用 |
| MTU | `packages/rtp/src/const.ts` `MTU = 1200` | |
| ビット操作 | `common`: `BitWriter` / `BitWriter2` / `getBit` / `BitStream` | VP9 descriptor・AV1 header 組み立て |
| leb128 | `codec/leb128.ts` + `av1.ts` の decode | AV1 OBU size |
| 既存例 | `examples/node/rtp_over_udp/` | 現状 pcmu/pcma/g722/aac/h265 のみ |

### 8.2 webrtc 実装から読み取れる最小 wire セマンティクス

実装を RFC と照合する起点（合法サブセット）:

**VP8**（`Vp8Packetizer`）:

- descriptor 1 バイトのみ。先頭 `0x10`（S=1）、継続 `0x00`。
- chunkSize = maxPayloadSize - 1。marker = 最終チャンク。

**VP9**（`Vp9Packetizer`）:

- descriptor 1 バイト: I=L=F=V=Z=0、P=delta なら 1、B=先頭、E=末尾。
- Picture ID / layer / SS は送らない（depacketizer はそれらをパース可能だが packetizer 最小形は省略）。

**AV1**（`Av1Packetizer`）:

- 常に W=1 の単一 element。aggregation header + OBU（フラグメント）本体。
- key の最初のパケットのみ N=1。最終パケット marker=1。

**Opus**:

- 生ペイロード 1 パケット、marker=true。

**H.264**（`H264Packetizer`）:

- mode=1、AVCC config / `parameterSets` から SPS/PPS、key 時に先頭付与。
- webrtc 側は **常に個別 Single NAL**（STAP-A 未使用）。rtp 側の確定方針は **STAP-A 優先 + 不可時 Single NAL**（`H265Packetizer` の AP と同型）。depacketizer は既に STAP-A を完全サポートしているため、送信側を揃えるだけで round-trip 可能。

### 8.3 Depacketizer 側の落とし穴（packetizer が合わせるべき点）

- **VP8**: `basicCodecParser` は各パケットの `payload`（descriptor 除去後）を `Buffer.concat`。PID 複数パーティションは未使用前提でよいが、S/PID は RFC 通りに立てる。`payloadHeaderExist`（S=1,PID=0）のときだけフレームヘッダの size/P を読む — 先頭チャンクに生フレーム先頭が来ること。
- **VP9**: `isKeyframe = !pBit && bBit && (!sid || !lBit)`。packetizer の P/B と整合させる。
- **AV1**: `getFrame` がフラグメントを連結し OBU を再 serialize。packetizer の Z/Y と fragment 境界がずれると復元失敗。
- **H.264**: FU-A は `fragment` をまたぎ、E=1 で Annex-B 化。Single NAL は 1 パケットで完結。marker でフレーム区切り。
- **Opus**: 常に final。複数 RTP を 1 フレームにまとめない。

### 8.4 推奨作業順序

1. RFC / ドラフトを `docs/rfc/` に配置し、VP8→Opus→VP9→H.264→AV1 の順で該当節を読む（単純→複雑）。
2. `OpusPacketizer`（最短）→ `Vp8Packetizer` → `Vp9Packetizer` → `H264Packetizer` → `Av1Packetizer`。
3. 各コーデックで **packetize → dePacketizeRtpPackets round-trip テスト**を先に赤で書き、実装で緑にする。
4. webrtc の VP9/AV1 テスト期待を rtp に移植して回帰防止。
5. （推奨）`generateVectors` 拡張とベクタコミット。
6. `rtp_over_udp` 例・README・changelog・typedoc。
7. `cd packages/rtp && npm run type && npm test`。

### 8.5 実装時の再利用ポイント

- H.264 の FU-A 組み立ては webrtc `H264Packetizer` と H.265 FU の両方を参照。
- H.264 の **STAP-A 集約**は `H265Packetizer` の parameter-set AP 試行ブロック（`h265.ts` の「Try to aggregate…」）をそのまま移植し、AP header を STAP-A header（Type=24）+ 2 バイト長に置き換える。
- AV1 の `splitAv1Obus` / aggregation header は webrtc から **rtp にコピーして単一の正本**にする（webrtc 差し替えは任意）。
- VP8/VP9 のチャンク分割ループは G.711 の単純分割と同型 + descriptor 前置。
- VP9 のビット配置・B/E/P は **RFC 9628** の該当節で照合（draft 番号は使わない）。

---

## 9. 考慮すべき制約や注意点

### 9.1 スコープ

- **In scope**: 5 コーデックの Packetizer、仕様原文、テスト、ドキュメント、例の拡張、（推奨）ベクタ生成。
- **Out of scope**:
  - webrtc `userMedia` の mediabunny 除去（packetizer の重複統合は追加要件 §12 で In scope）
  - VP9 flexible mode + scalability structure の完全送信、VP8 の複数 PID パーティション高度制御（最小合法サブセットで可。拡張はオプション）
  - H.264 interleaved mode（FU-B/MTAP）、packetization-mode=0 専用最適化
  - 新規 npm 依存の追加
  - WPT やブラウザ SDP ネゴシエーション変更

### 9.2 セマンティクスの一貫性（親チケット 4.2 踏襲）

- シーケンス: パケット毎 +1（uint16 wrap）、初期 `random16()` または options。
- タイムスタンプ: 呼び出し元指定、同一フレームのフラグメント間で不変。
- marker: フレーム最終パケット（Opus は単パケットで true）。
- `maxPayloadSize` デフォルト 1200。descriptor / FU ヘッダ分を引いたチャンクサイズを使うこと（オーバーラン禁止）。

### 9.3 RFC / 実装の落とし穴

- **VP8**: X=0 のとき拡張バイト無し。S は「パーティション先頭」でありフレーム先頭と一致させる（PID=0 の単一パーティションモデル）。
- **VP9（RFC 9628）**: B/E と RTP marker の両方を立てる（受信側は marker でフレーム確定）。P ビットの意味を key/delta と取り違えない。仕様コメントは draft ではなく **RFC 9628** を指す。
- **AV1**: N と Z の同時 1 禁止。W=0 と W=1 で size field の要否が変わる — webrtc 互換の W=1 経路を先に完成させる。
- **Opus**: ペイロードを盲目的に MTU 分割すると TOC が壊れデコード不能。分割しない or エラー。
- **H.264**: FU-A の Type フィールドは **元 NAL type**（indicator の type は 28）。NRI/F は元ヘッダから継承。depacketizer 出力は Annex-B なので round-trip 比較方法に注意。
- **H.264 STAP-A**: 集約は **2 NAL 以上**が必要（1 NAL だけの STAP-A は作らない）。サイズ超過時は無理に詰めず Single NAL フォールバック。STAP-A 内の 16-bit 長フィールド境界を必ず検証（既存 deSerialize の STAP-A ループと対称）。
- **VP8 depacketizer の T/K 読み飛ばし**（`vp8.ts` 94–99 行付近）は既存の受信実装。packetizer 最小形は T/K を送らないため影響薄いが、拡張 descriptor を足す場合は depacketizer のオフセット計算と突き合わせる。

### 9.4 堅牢性

- 空入力: 空配列を返すか throw かをコーデック間で揃え、テストで固定（H265 は空 NAL で `[]` の例あり）。
- `maxPayloadSize` がヘッダ長以下: 明確な Error（親の PacketizerBase / H265 と同様）。
- AV1 OBU size がバッファを超える: throw（既存 split ロジック）。
- 無制限 `Buffer.concat` ループを避け、境界チェックを先に行う。

### 9.5 テスト規約（AGENTS.md）

- Arrange / Act / Assert。
- Act / Assert に日本語コメント。
- Arrange ユーティリティの重複禁止（共有ファイルへ）。
- 失敗を握りつぶさない。

### 9.6 検証コマンド

```bash
# 必須
cd packages/rtp && npm run type && npm test

# 例（任意）
# send/recv に vp8 等を追加後
RUN_SELF_TEST=1 npx tsx examples/node/rtp_over_udp/recv.ts _ vp8

# ベクタ再生成（任意・GStreamer 必要）
# tools/generateVectors/README.md および tests/data/VECTOR_SOURCE.md に従う
```

webrtc を触らない場合はルートの `test:small` は必須ではない。触る場合は `npm run type` と `npm run test:small`。

---

## 10. 完了条件

1. **`Vp8Packetizer` / `Vp9Packetizer` / `Av1Packetizer` / `OpusPacketizer` / `H264Packetizer`** がそれぞれ対応する `packages/rtp/src/codec/*.ts` に実装され、`PacketizerBase` を継承している。
2. 各コーデックで **packetize → 既存 depacketizer / `dePacketizeRtpPackets` の round-trip テストが合格**する（合成ベクタ必須。GStreamer ベクタは推奨）。
3. **仕様原文が `docs/rfc/` に追加**され（**rfc7741 / rfc6184 / rfc7587 / rfc9628** + AV1 RTP）、実装・テストにセクション参照コメントがある。ビットレイアウト・marker・フラグメント規則が原文と照合済み。VP9 の正本は **RFC 9628**（draft ではない）。
4. **VP8**: 最小 descriptor（S/PID）、MTU 分割、最終 marker、キーフレーム時の P ビットが depacketizer の `isKeyframe` と整合。
5. **VP9**: B/E/P と marker が RFC 9628 と整合し、key/delta を指定して round-trip できる。`vp9.ts` 先頭コメントが RFC 9628 を指す。
6. **AV1**: OBU 分割と Z/Y/N、最終 marker、key 時 N=1 のみ、が webrtc 既存テストと同等に検証される。N∧Z は拒否。
7. **Opus**: 生ペイロード 1 RTP、marker=true。MTU 超過時の契約（エラー等）がテストで固定。
8. **H.264**: Annex-B と長さ前置の両入力、Single NAL と FU-A、キーフレーム / IDR 検出。**SPS/PPS は STAP-A 優先（不可時 Single NAL）** が実装・テスト・README で一致している。
9. 不正入力が**予測可能な例外**で失敗し、無限ループ・無制限確保が無い。
10. **シーケンス / タイムスタンプ / marker / maxPayloadSize** が親チケットの他 Packetizer と一貫。
11. `packages/rtp/README.md`・`changelog.md`・typedoc（`npm run doc`）が更新され、表から「packetizer は webrtc のみ」記述が消えている（または該当行がパッケージ内 API を指す）。
12. （推奨）`examples/node/rtp_over_udp` が新 packetizer の少なくとも 1 つ以上（できれば VP8 と H.264 または Opus）で Node ピア round-trip 可能。
13. 検証: **`cd packages/rtp && npm run type && npm test` が全て成功**。
14. **子タスク（Chrome E2E による de/packetizer 実機能検証）の完了条件も満たす**（詳細は §11.5）。

---

## 11. 子タスク: packages/rtp のコーデック packetizer / depacketizer を Chrome E2E で実機能検証する

### 11.1 タスクの目的と背景

#### 11.1.1 位置づけ

本タスクの §7（packetizer 実装）により、`packages/rtp` に以下が揃った（または揃う前提）:

| コーデック | Depacketizer | Packetizer | 仕様 |
|---|---|---|---|
| VP8 | `Vp8RtpPayload` | `Vp8Packetizer` | RFC 7741 |
| VP9 | `Vp9RtpPayload` | `Vp9Packetizer` | RFC 9628 |
| AV1 | `AV1RtpPayload` | `Av1Packetizer` | AV1 RTP |
| Opus | `OpusRtpPayload` | `OpusPacketizer` | RFC 7587 |
| H.264 | `H264RtpPayload` | `H264Packetizer` | RFC 6184 mode=1 |

これらは **単体テスト**（`packages/rtp/tests/codec/*.test.ts`）と **合成 / GStreamer ベクタ**（`tests/data/vector_*.bin`）で round-trip 可能であることが検証される。しかし、それだけでは **実ブラウザ（Chrome）が生成・消費する RTP ペイロードと相互運用できること** は保証されない。

本子タスクの目的は、**Chrome ↔ Node(werift) の E2E で `packages/rtp` の Packetizer / Depacketizer が実務的に機能する**ことを、コーデックごとに自動テストで証明すること。

#### 11.1.2 現状ギャップ（コードベース調査結果）

| 既存経路 | 何を検証しているか | 本子タスクとの差 |
|---|---|---|
| `packages/rtp/tests/codec/*` | 合成ベクタ・GST ベクタの de/packetize round-trip | **Chrome 非関与** |
| `e2e` の `mediachannel_sendrecv` / `oneway` 等 | Chrome エンコード RTP を werift が `replaceTrack` で返す | **payload を `packages/rtp` で触らない**（透過中継） |
| `e2e` の `mediachannel_rtx` | GStreamer `rtpvp8pay` → `track.writeRtp` → Chrome 再生 | **payloader が GStreamer**。`Vp8Packetizer` ではない |
| `e2e` の `mediachannel_red` | GStreamer `rtpopuspay` → writeRtp | 同上（Opus も GST pay） |
| `examples/mediachannel/codec/{vp8,vp9,h264,av1}.ts` | Chrome 送信を `*RtpPayload.deSerialize` し keyframe を log | **手動デモ**。E2E 自動化・packetize 再送なし |
| `packages/webrtc/.../userMedia/packetizer.ts` | mediabunny `EncodedPacket` 向け独自 Packetizer | 本タスク §7.5 の方針どおり **SUT ではない**（参照実装）。本子タスクの送信側は `packages/rtp` の `*Packetizer` を使う |
| `MediaRecorder` + `DepacketizeCallback` | 受信 RTP を `packages/rtp` depacketizer で WebM 化 | デモ用途。Chrome 固定コーデックの CI アサートではない |
| `packages/webrtc/tests/data/nonstandard/userMedia-e2e/*.webm` | userMedia ファイル再生の単体系 | **webrtc 側 packetizer** 経由。本子タスクでは demux のみ流用可 |

結論: **「Chrome がデコードできる RTP を `packages/rtp` Packetizer が出せるか」** と **「Chrome が出した RTP を `packages/rtp` Depacketizer が正しくフレーム化できるか」** は、いずれも現行 CI では未カバー。

#### 11.1.3 成功時の価値

- 本タスクの実装（§7）が **ブラウザ相互運用可能なペイロード**であることを回帰防止できる。
- 非 WebRTC 用途（RTP-over-UDP / SIP / メディアリレー）でも「Chrome が受けられる形」を保証する基準になる。
- 将来 webrtc の `userMedia/packetizer` を rtp 実装へ差し替える際の受け入れテストにも流用できる。

#### 11.1.4 未確定事項の決着（本改訂で確定）

| 論点 | 決定 |
|---|---|
| シナリオ B のフレーム供給 / GStreamer 実行時依存 | **採用: 事前生成した小さい WebM（等）をリポジトリにコミットし、それをソースにする**。CI 実行時に GStreamer は不要。生成は開発時ワンショット（スクリプト化推奨） |
| AV1 の SDP 名（`AV1` vs `AV1X`） | **調査済み → 方針確定（§11.3.8）**。Chrome は `video/AV1`、werift は現状 `video/AV1X` のみ → **E2E でネゴできるよう SDP 側を対応**する |
| VP9 Chrome 拡張 descriptor | **「割り切り」にしない**。既存パーサは I/L/F/V 等を既に持つ。E2E で不足が露呈したら **調査のうえ depacketizer を追加実装 + 単体テスト**する |
| H.264 profile と黒画面 | **黒画面になってもよい**。H.264 の合否は de/packetize と RTP 配送の機能アサートが主。画素変化必須にしない |

---

### 11.2 実装すべき具体的な機能や変更内容

#### 11.2.1 置き場所（推奨）

ルート E2E ハーネス `e2e/` に追加する（`packages/rtp` 単体には browser harness が無い。`packages/ice-server/chrome-e2e` は ICE/TURN 専用でメディア向きではない）。

| 種別 | パス（案） |
|---|---|
| Server handler | `e2e/server/handler/mediachannel/codecRtp.ts`（または `codec/` 配下に codec 別） |
| 共有 Arrange ユーティリティ | `e2e/server/codecRtpUtils.ts`（WebM demux→packetize ループ、PLI、depacketize 集約） |
| メディアフィクスチャ | `e2e/fixtures/media/`（または `packages/rtp/tests/data/e2e-media/`）に **短い WebM 等をコミット** |
| フィクスチャ生成スクリプト | `e2e/tools/generateCodecFixtures.sh`（または `packages/rtp/tools/`）— **開発者マシン / ドキュメント用**。CI では実行しない |
| Browser tests | `e2e/tests/mediachannel/codecRtp.test.ts`（または codec 別ファイル） |
| 登録 | `e2e/server/main.ts` の `tests` map に handler を追加 |
| 依存 | `e2e` は既に `werift` / `werift-rtp` を持つ。**実行時 GStreamer 必須にしない** |

パッケージ境界:

- **SUT**: `packages/rtp` の `*Packetizer` / `*RtpPayload` / `dePacketizeRtpPackets` /（必要なら）`DepacketizeCallback`。
- **運搬役**: `packages/webrtc` の `RTCPeerConnection` / `MediaStreamTrack.writeRtp` / transceiver / codec ネゴシエーション。
- **demux のみ** mediabunny 等を e2e 側で使ってよい（フレーム取得）。**packetize は必ず `packages/rtp`**。webrtc `userMedia/packetizer.ts` は SUT にしない。
- webrtc 側 packetizer の実装差し替えは **本タスク範囲外**。

#### 11.2.2 対象コーデックと優先度

| 優先度 | コーデック | MIME（werift 側） | Packetizer E2E | Depacketizer E2E | 備考 |
|---|---|---|---|---|---|
| **P0 必須** | VP8 | `video/VP8`（`useVP8()`） | ○ | ○ | 最も安定 |
| **P0 必須** | H.264 | `video/H264` + `packetization-mode=1`（`useH264()`） | ○ | ○ | 黒画面可（§11.2.5） |
| **P0 必須** | Opus | `audio/opus`（`useOPUS()`） | ○ | ○ | 音声判定は後述 |
| **P1 推奨** | VP9 | `video/VP9`（`useVP9()`） | ○ | ○ | 拡張 descriptor は必要なら depacketizer 強化 |
| **P1 推奨** | AV1 | **`video/AV1`（標準名）+ 互換で `AV1X`**（§11.3.8） | ○ | ○ | ネゴ対応後は必須扱いに近づける。HW 無しでも libaom 系なら A は可能なことが多い |
| **範囲外** | H.265 / PCMU / PCMA / G.722 / AAC / telephone-event | — | — | — | 単位テスト + `rtp_over_udp` |

#### 11.2.3 検証シナリオ（コア）

各 P0/P1 コーデックについて、最低次の **2 方向**を自動化する。

##### シナリオ A — Depacketizer（Chrome → Node）

```
Chrome (getUserMedia / canvas / fake device)
  → WebRTC (指定 codec のみ negotiate)
  → Node: track.onReceiveRtp
  → packages/rtp: DepacketizeCallback または 手動バッファ + dePacketizeRtpPackets
  → アサート
```

必須アサート:

1. **ネゴシエートされた codec** が意図どおり（SDP / selected codec / 受信 PT）。
2. **一定時間内に 1 フレーム以上** depacketize 成功（`data.length > 0`）。
3. 映像: **キーフレームを少なくとも 1 回**検出（`isKeyframe === true`）。PLI を定期送信（既存 example と同様 1–3s 間隔）。
4. 映像: marker 付き最終パケットでフレーム境界が閉じること（`DepacketizeCallback` の `isFinalPacketInSequence: (h) => h.marker`）。
5. 不正・空ペイロードでテストプロセスが落ちないこと（ログのみ可）。
6. VP9/VP8: Chrome が拡張 descriptor を付けていても **例外なく payload 境界が正しく取れ**、フレームが連結できること（不足時は depacketizer 修正）。

参照実装の手本:

- `examples/mediachannel/codec/vp8.ts` / `h264.ts` / `vp9.ts` / `av1.ts`
- `packages/webrtc/.../recorder/writer/webm.ts`（`DepacketizeCallback` 配線）

##### シナリオ B — Packetizer（Node → Chrome）【確定: 事前 WebM ソース】

```
コミット済み短い WebM（等）を demux
  → 1 フレーム（または 1 Opus packet）の Buffer
  → packages/rtp *Packetizer.packetize(frame, rtpTimestamp)
  → MediaStreamTrack.writeRtp(RtpPacket)
  → WebRTC → Chrome ontrack
  → 再生 / 受信アサート
```

必須アサート:

1. 使用 Packetizer が **`packages/rtp` のクラス**であること（GStreamer `rtp*pay` 不使用。webrtc userMedia packetizer 不使用）。
2. Chrome 側で **RTP を受信しデコード経路に載る**こと。  
   - 映像（VP8/VP9/AV1）: 可能なら `waitVideoPlay`。失敗しても **stats の packets/bytesReceived 増加 + Node 側送信フレーム数**で足りる場合あり。  
   - **H.264: 黒画面でも合格可**。必須は「packetize した RTP が Chrome に届き、selected codec が H264」および（可能なら）デコーダエラーで即死しない程度。画素ハッシュ変化は **任意**。  
   - Opus: `waitAudioPlay` 相当または stats。
3. 複数パケットにフラグメントされる十分なフレームを少なくとも 1 コーデックで含む（`maxPayloadSize` を下げる等）。
4. タイムスタンプがクロックに沿って進む（video 90000 / Opus 48000）。

##### シナリオ C — 再 packetize ループ（推奨・高価値）

```
Chrome 送信 → packages/rtp depacketize → 生フレーム
  → 同一コーデックの packages/rtp Packetizer で再 RTP 化
  → 別 transceiver / 別 PC で Chrome へ返送 → 再生 / 受信確認
```

- Depacketizer と Packetizer を 1 本で同時検証。
- Chrome 拡張 descriptor を depacketize し、**最小合法 descriptor で再送**しても Chrome が扱えること。
- H.264 は SPS/PPS をキーフレームで確保（PLI / バッファ）。**黒画面でも機能アサート優先**。

P0: **VP8 はシナリオ C 必須**。H.264 / Opus は A+B。VP9 / AV1 は A+B（可能なら C）。

#### 11.2.4 フレーム供給（Packetizer 側）— **確定方針: 事前 WebM フィクスチャ**

**禁止**:

- CI / テスト実行時に `rtpvp8pay` 等の **GStreamer RTP payloader 出力をそのまま writeRtp** すること（Packetizer 検証として数えない）。
- 実行時に `gst-launch` 必須とすること。

**採用（確定）**:

1. **開発時**に GStreamer（または同等）で **コーデックごとの小さい WebM / コンテナ**を生成し、リポジトリにコミットする。
2. **E2E 実行時**はファイルを demux し、生フレームを `packages/rtp` Packetizer に渡す。

##### フィクスチャ仕様（案）

| ファイル（例） | 内容 | 用途 |
|---|---|---|
| `e2e/fixtures/media/vp8.webm` | 短い VP8（+ 任意で無音）| B: VP8Packetizer |
| `e2e/fixtures/media/vp9.webm` | 短い VP9 | B: Vp9Packetizer |
| `e2e/fixtures/media/av1.webm` | 短い AV1 | B: Av1Packetizer |
| `e2e/fixtures/media/h264.mp4` または annex-B 付き | 短い H.264（Constrained Baseline 推奨だが必須ではない） | B: H264Packetizer |
| `e2e/fixtures/media/opus.webm` | 短い Opus | B: OpusPacketizer |

制約:

- **数秒以内・低解像度**（例: 320×240、2–5 秒）でリポジトリ肥大を避ける。
- **キーフレームを先頭付近に含む**こと。
- 生成コマンドを `e2e/tools/generateCodecFixtures.sh`（等）と短い README に残す。例（目安）:

```bash
# VP8 + Opus の短い WebM（開発マシンに GStreamer があるときのみ）
gst-launch-1.0 -e videotestsrc num-buffers=60 ! video/x-raw,width=320,height=240,framerate=30/1 \
  ! vp8enc deadline=1 ! webmmux name=mux ! filesink location=vp8.webm \
  audiotestsrc num-buffers=50 ! audioconvert ! opusenc ! mux.
```

既存資産の流用:

- `packages/webrtc/tests/data/nonstandard/userMedia-e2e/vp8-opus.webm` / `h264-opus.mp4` を **コピーまたはシンボリックで e2e フィクスチャにしてもよい**。足りない VP9/AV1/単独 Opus は新規生成。

##### 実行時 demux → packetize

推奨フロー（e2e server 側）:

1. mediabunny（webrtc が既に依存）または同等で WebM/MP4 を開き、`EncodedPacketSink` で **encoded フレームの raw bytes** を取得。
2. **`createPacketizer`（webrtc userMedia）は使わない**。
3. `new Vp8Packetizer({ payloadType: negotiatedPt, ... }).packetize(Buffer.from(packet.data), rtpTs)` のように **rtp パッケージ API** を呼ぶ。
4. H.264 は Annex-B / AVCC のどちらで demux されるかを確認し、`H264Packetizer` の入力契約に合わせる（必要なら `parameterSets` を decoder config から渡す）。
5. VP9 / AV1 は key/delta を `EncodedPacket` の type から `isKeyframe` / `frameType` にマップ。

シナリオ C はフィクスチャ不要（Chrome がソース）。

#### 11.2.5 コーデック別の E2E チェックポイント

##### VP8（RFC 7741）

- Depacketizer: Chrome の X/I 拡張付きでも `Vp8RtpPayload` が descriptor を剥がして payload 連結（既存実装は X/I/L/T/K をパース済み）。E2E で破綻したら修正。
- Packetizer: 先頭 `0x10`、継続 `0x00`、最終 marker。
- シナリオ C 必須。

##### H.264（RFC 6184 mode=1）

- Node は H.264 のみ negotiate（`useH264()`、`packetization-mode=1`、既存 `profile-level-id=42e01f` でよい）。
- Depacketizer: Single / STAP-A / FU-A → Annex-B。キーフレーム検出。
- Packetizer: フィクスチャ demux → `H264Packetizer`。SPS/PPS 付与は実装どおり。
- **合否**: フレーム depacketize / packetize 成功と RTP 配送。**`waitVideoPlay` の画素変化・黒画面回避は必須にしない**（「黒画面になっても良い」）。

##### Opus（RFC 7587）

- 1 RTP = 1 packet、marker=true。MTU 超過 throw 契約は E2E では踏まないサイズのフィクスチャ。
- 再生: `waitAudioPlay`（Analyser）または stats。

##### VP9（RFC 9628）— depacketizer 方針【確定】

**現状調査結果（コード）**:

- `Vp9RtpPayload.parseRtpPayload` は RFC 9628 の主要フィールドを実装済み:
  - 必須 octet: I|P|L|F|B|E|V|Z
  - I → Picture ID（1/2 byte, M bit）
  - L → layer indices + non-flex 時 TL0PICIDX
  - F∧P → P_DIFF 連鎖
  - V → Scalability structure（N_S/Y/G、幅高、N_G、pg）
- `packages/rtp/tests/codec/vp9.test.ts` に PictureId / Layer / RefIdx / SS の合成テストあり。

**本子タスクでの扱い（割り切り禁止）**:

1. シナリオ A で Chrome 実パケットを depacketize。失敗・壊れたフレーム長・例外があれば **根因を調査**。
2. 不足フィールドや境界バグなら **`vp9.ts` を追加実装**し、**再現ベクタを単体テストに固定**してから E2E を緑にする。
3. 「payload が取れれば拡張は無視でよい」という事前割り切りは **採用しない**（既に拡張を読む実装があるため、壊れているなら直す）。
4. Packetizer 側は引き続き最小 descriptor でよい。再送後の再生は C で確認。

VP8 も同様に X 拡張は既存。E2E で問題が出たら同方針で修正。

##### AV1 — SDP 名と E2E【確定方針は §11.3.8】

- ペイロード: Z/Y/W/N、キー時 N=1、`getFrame` 整合。
- ネゴ: Chrome は `AV1`、werift は現状 `AV1X` → **§11.3.8 の対応を本子タスクに含む**（ネゴ不能のまま skip で逃さないことを目標。どうしても環境が無い場合のみ skip）。

#### 11.2.6 テストコード規約（リポジトリ AGENTS.md 準拠）

- **Arrange / Act / Assert**。
- Arrange（PC 作成・codec 固定・PLI・WebM 読み・demux）は **`e2e/server/codecRtpUtils.ts` と `e2e/tests/fixture.ts` に集約**。
- Act / Assert に **日本語コメント**。
- protoo method 名は `mediachannel_codec_rtp_vp8` 等で一意。
- handler `done` で PC / timer / ファイルハンドル解放（GStreamer プロセスは実行時不要なら無し）。

#### 11.2.7 変更が必要になり得る rtp / webrtc 側

| 変更 | 条件 |
|---|---|
| `packages/rtp` VP9/VP8/AV1 depacketizer 修正 | Chrome 実パケットで破綻したとき（本子タスク範囲内） |
| `useAV1()` 追加または `useAV1X` の mime を `video/AV1` に寄せる / 両方 advertise | **AV1 E2E のために本子タスクで実施（§11.3.8）** |
| `findCodecByMimeType` の AV1↔AV1X エイリアス | 上記の代替または併用 |
| webrtc userMedia packetizer 置換 | **範囲外** |

#### 11.2.8 ドキュメント

- フィクスチャ生成手順と「CI では生成不要」を短く記載。
- `packages/rtp/README.md` に Chrome E2E への一行リンク。
- H.264 黒画面許容をテストコメントに明記。

---

### 11.3 技術的な実装アプローチ（調査サマリ）

#### 11.3.1 E2E ハーネスの構造

- **Server**: `e2e/server/main.ts` + protoo。
- **Browser**: Vitest + Playwright Chromium（fake media device 済み）。
- **実行**: ルート `npm run e2e` → `e2e` の `ci:silent`。
- **映像判定**: `waitVideoPlay` は VP8/VP9/AV1 で優先利用。H.264 は任意。

#### 11.3.2 既存「RTP 注入」パターン（流用）

`e2e/server/handler/mediachannel/rtx.ts` の `MediaStreamTrack` + `writeRtp` + `done` クリーンアップを踏襲。UDP/GStreamer pay 部分を **フィクスチャ demux + rtp Packetizer** に置き換える。

#### 11.3.3 codec 固定ネゴシエーション

```ts
new RTCPeerConnection({
  dtls: { keys: await DtlsKeysContext.get() },
  codecs: {
    video: [useVP8() /* or useH264 / useVP9 / useAV1(+AV1X) */],
    audio: [useOPUS()],
  },
});
```

- Chrome 側も `setCodecPreferences` で同一 codec を優先（`red.test.ts` 先例）。
- Packetizer の `payloadType` は **ネゴ確定後の PT** を使う。

#### 11.3.4 Depacketize 集約

```ts
new DepacketizeCallback("VP8", {
  isFinalPacketInSequence: (h) => h.marker,
});
```

フレーム復元まで見るなら `DepacketizeCallback` / `dePacketizeRtpPackets` が本命。

#### 11.3.5 再 packetize 時の注意

| 項目 | 方針 |
|---|---|
| シーケンス番号 | 送信 Packetizer が独自採番 |
| タイムスタンプ | 受信 timestamp 再利用可 |
| SSRC | 送信 track に合わせる |
| VP8/VP9 拡張 | depacketize で除去し最小 descriptor で再送 |
| H.264 | Annex-B + 必要なら parameterSets |
| AV1 | `getFrame` → `Av1Packetizer` + isKeyframe |

#### 11.3.6 音声 wait

`AudioContext` + `AnalyserNode` でエネルギー閾値、または `getStats` の受信増分。

#### 11.3.7 フィクスチャ demux（実行時）

- webrtc の `getUserMedia({ buffer })` は内部で **webrtc packetizer** を使うため、**そのまま SUT 経路にしてはならない**。
- 同じ mediabunny の demux API だけを e2e ユーティリティから呼び、bytes を rtp Packetizer に渡す。
- 参考: `packages/webrtc/src/nonstandard/userMedia.ts` の `EncodedPacketSink` 利用箇所（packetize 呼び出しを rtp 側に差し替えるイメージ）。

#### 11.3.8 AV1 SDP 名の差異 — 調査結果と対応方針【確定】

##### 調査結果

| 側 | encoding name / mimeType | 根拠 |
|---|---|---|
| **AV1 RTP 仕様** | SDP `a=rtpmap` の encoding name は **`AV1`** | [AV1 RTP payload format](https://aomediacodec.github.io/av1-rtp-spec/) § SDP mapping |
| **Chrome / 現行ブラウザ** | capabilities / SDP は **`video/AV1`** | 2021 以降 AV1X→AV1 移行完了（[discuss-webrtc PSA: AV1X will be replaced with AV1](https://groups.google.com/g/discuss-webrtc/c/ACmDgZEAooc)）。MDN も WebRTC AV1 を Chrome 113+ 等で記載 |
| **werift 現状** | `useAV1X()` → **`video/AV1X` のみ**（`packages/webrtc/src/media/codec.ts`）。`supportedCodecs` も AV1X | 歴史的な実験名のまま |
| **ネゴ照合** | `findCodecByMimeType` は **完全一致**（`mimeType.toLowerCase()` 同士） | `packages/webrtc/src/peerConnection.ts` — `video/av1` ≠ `video/av1x` なので **マッチしない** |

補足:

- MediaRecorder 側は受信 codec 名 `av1x` を WebM の `"AV1"` にマップしている（`webm.ts`）が、**SDP ネゴとは別経路**。
- userMedia のソース codec `av1` → 期待 mime `video/av1x` も AV1X 前提。

##### 対応方針（本子タスクに含む）

優先順（上から推奨）:

1. **`useAV1()` を追加**（`mimeType: "video/AV1"`）し、`supportedCodecs` / デフォルト video リストに **`useAV1()` を主、必要なら `useAV1X()` を後方互換で残す**。
2. E2E の Node PC は **`codecs.video: [useAV1()]`**（または AV1 と AV1X の両方）で offer/answer。Chrome の `video/AV1` と一致させる。
3. 既存の `AV1X` のみのリモートに備え、**`findCodecByMimeType`（または codec マッチ層）で `AV1` ↔ `AV1X` を同一コーデックとしてエイリアス**するかを実装時に判断:
   - **最小**: E2E と新規コードは `video/AV1` のみ使い、エイリアス無し。
   - **互換重視**: マッチ関数で name 正規化（`av1x` → `av1`）し、旧 peer ともつながる。
4. rtp パッケージの de/packetizer レジストリ名 `"AV1"` はそのまま（ペイロード形式は SDP 名と独立）。
5. ドキュメント / changelog: 「SDP は AV1 が正。AV1X は legacy alias」と短く記載。

##### E2E での扱い

- AV1 フィクスチャ WebM を用意しシナリオ B を実施。
- シナリオ A は Chrome が AV1 エンコード可能な環境で実施（近年の Chromium はソフトエンコード可のことが多い）。
- **ネゴ失敗が `AV1X` のみ advertise が原因ならバグ / 未対応として修正**（skip で逃げない）。
- エンコーダ自体が完全に無い古い Chromium に限り skip 可（理由をログ）。通常 CI の Playwright Chromium では AV1 対応を前提にトライする。

#### 11.3.9 依存関係

| 依存 | 用途 |
|---|---|
| Playwright Chromium | 既存 e2e |
| コミット済み WebM/MP4 | シナリオ B のフレーム源 |
| GStreamer | **フィクスチャ生成時のみ**（CI 実行時不要） |
| mediabunny（e2e/webrtc 経由） | demux のみ |
| `packages/rtp` | SUT packetize / depacketize |
| `packages/webrtc` | PC / track /（AV1 SDP 修正） |

---

### 11.4 考慮すべき制約や注意点

#### 11.4.1 何が「成功」か（偽陽性の排除）

- **透過 loopback の再生成功だけでは不合格**。`packages/rtp` API を呼んだ証拠をアサートに含める。
- GStreamer `rtp*pay` や webrtc userMedia packetizer を Packetizer 合格に使わない。
- シナリオ A のみでは Packetizer 未検証 → **B または C が必須**。

#### 11.4.2 環境・フレーク

- 実行時 GStreamer 非依存になったため、**CI の GST 有無問題は解消**（フィクスチャ欠落だけが失敗理由）。
- fake media は動きが単調 → シナリオ C では PLI と十分な待機。シナリオ B はフィクスチャに動きのある videotestsrc 由来を推奨。
- `testTimeout` は codec スイートで 30–60s を許容してよい。
- 並列実行時の PC リークに注意。

#### 11.4.3 コーデック相互運用

- **H.264**: 黒画面許容。profile チューニングは必須作業にしない。de/packetize と配送を見る。
- **VP9**: 拡張 descriptor は既存実装あり。E2E 失敗時は **追加実装**（割り切り禁止）。
- **VP8**: 同様に X 拡張は既存。問題時は修正。
- **AV1**: SDP は `AV1` を正とする対応を本子タスクに含む（§11.3.8）。
- **Opus**: pure Opus。RED 混在なし。

#### 11.4.4 パッケージ境界

- `packages/rtp` に webrtc 依存を持ち込まない。
- mediabunny は e2e demux に限定。rtp Packetizer の引数は `Buffer`。
- rtp 修正時は **単体テスト追加後に E2E**。

#### 11.4.5 リソース

- フィクスチャは小さく保つ。巨大 raw をコミットしない。
- depacketize バッファに上限時間を設ける。

#### 11.4.6 範囲外

- Firefox / Safari。
- H.265 / G.711 / G.722 / AAC / DTMF の Chrome E2E。
- webrtc userMedia packetizer の rtp への置換。
- H.264 の黒画面解消・画質保証。
- 性能ベンチ、Simulcast/SVC 詳細。
- **CI 上での GStreamer インストール必須化**（生成は開発時のみ）。

---

### 11.5 完了条件

1. **`e2e` に Chrome 向け codec RTP シナリオが追加**され、`main.ts` に handler 登録済み。
2. **コーデック別の小さい WebM/MP4 フィクスチャがリポジトリにあり**、生成スクリプトまたは手順が文書化されている（CI はファイルを読むだけ）。
3. **P0（VP8 / H.264 / Opus）**:
   - **シナリオ A**: Chrome → `packages/rtp` depacketize で非空フレーム（映像は keyframe 1 回以上）。
   - **シナリオ B**: フィクスチャ → `packages/rtp` Packetizer → Chrome 受信（H.264 は黒画面可、画素変化は任意）。
4. **VP8 はシナリオ C 必須**で通る。
5. **P1 VP9**: A + B（または C）。Chrome 拡張 descriptor で失敗した場合は depacketizer 修正 + 単体テストまで含め緑。
6. **AV1**:
   - SDP が Chrome とネゴ可能（**`video/AV1` 対応**、必要なら AV1X エイリアス）。
   - A および B（フィクスチャ）を実施。ネゴ不能を AV1X 放置のまま skip しない。
7. Packetizer 経路で **GStreamer payloader / webrtc userMedia packetizer を SUT に使っていない**。
8. Arrange 共通化・Act/Assert 日本語コメントが規約どおり。
9. handler 終了時にリソース解放。
10. 検証:
    - `cd e2e && npm run type`
    - ルート `npm run e2e`（または `cd e2e && npm run ci:silent`）で新規シナリオ成功
    - rtp / webrtc の SDP・depacketizer を直した場合: 該当パッケージの `npm run type && npm test`（webrtc は `test:small` 相当）も成功
11. README にフィクスチャと E2E の短い記載。

#### 受け入れの読み方

| 結果 | 意味 |
|---|---|
| 単体テストのみ緑 | **未完了** |
| 既存 sendrecv のみ緑 | **未完了** |
| フィクスチャ無しで実行時 GST 依存のまま | **方針違反（未完了）** |
| AV1 が AV1X のまま Chrome とネゴできず skip のみ | **AV1 項目未完了** |
| P0 の A+B、VP8 の C、VP9/AV1 対応済み | **完了** |

### 11.6 本子タスクと本タスク本体（packetizer 実装）との境界

| 項目 | 本タスク本体（packetizer 実装 / §7–§10） | 本子タスク（Chrome E2E） |
|---|---|---|
| 成果物 | `packages/rtp` Packetizer + 単体/ベクタ | `e2e` シナリオ + フィクスチャ + 必要なら rtp/webrtc 互換修正 |
| 仕様 / `docs/rfc/` | 必須 | 参照 + テストコメント |
| GStreamer | ベクタ生成 | **フィクスチャ事前生成のみ**（実行時不要） |
| AV1 SDP | 対象外だった | **本子タスクで `AV1` 対応** |
| webrtc userMedia packetizer | 参照・置換しない | 同様（demux のみ流用可） |

#### 主な参照パス（子タスク）

- `packages/rtp/src/codec/{vp8,vp9,av1,opus,h264}.ts` — SUT
- `packages/rtp/src/extra/processor/depacketizerCallback.ts` — 受信集約
- `packages/rtp/tests/codec/vp9.test.ts` — VP9 拡張 descriptor 単体
- `packages/webrtc/src/media/codec.ts` — `useVP8` / `useH264` / `useVP9` / `useAV1X`（→ `useAV1` 追加）
- `packages/webrtc/src/peerConnection.ts` — `findCodecByMimeType`
- `e2e/server/handler/mediachannel/rtx.ts` — writeRtp パターン
- `e2e/tests/fixture.ts` — `waitVideoPlay`
- `examples/mediachannel/codec/*.ts` — Chrome→deSerialize プロトタイプ
- `packages/webrtc/tests/data/nonstandard/userMedia-e2e/` — 既存短いメディアの参考
- `packages/rtp/examples/node/rtp_over_udp/` — Node 単体 packetizer 例

---

## 12. 追加要件: webrtc userMedia packetizer と packages/rtp の重複統合

### 12.1 目的

`packages/webrtc/src/nonstandard/userMedia/packetizer.ts` は `packages/rtp` の Packetizer と同じ RTP ペイロード生成を独自に実装していた。二重実装のため、rtp 側で直した不具合（AV1 の OBU 集約など）が webrtc 側に残っていた。重複を洗い出して `packages/rtp` を唯一の実装とし、webrtc 側は mediabunny `EncodedPacket` から rtp Packetizer への変換だけを持つ。

### 12.2 重複一覧と統合先

| # | webrtc（統合前） | packages/rtp（統合先） | 差分と扱い |
|---|---|---|---|
| 1 | `BasePacketizer`（random16 の連番、uint16 wrap、`buildPacket`） | `codec/base.ts` `PacketizerBase` | 同等。PT は `codec.payloadType ?? 96`、MTU 1200 を options で渡す |
| 2 | `OpusPacketizer`（毎 packet marker=1） | `codec/opus.ts` `OpusPacketizer` | rtp は talkspurt 先頭のみ marker。**webrtc の挙動を維持**するため、アダプタで毎回 `startTalkspurt()` を呼ぶ。1200 byte 超は rtp に合わせて例外 |
| 3 | `Vp8Packetizer` | `codec/vp8.ts` `Vp8Packetizer` | 同一ビット列 |
| 4 | `Vp9Packetizer`（P bit は `packet.type`） | `codec/vp9.ts` `Vp9Packetizer` | 同一。`frameType: packet.type` を渡す |
| 5 | `Av1Packetizer`、`createAv1AggregationHeader`、`splitAv1Obus` | `codec/av1.ts` の同名 API | rtp 側は TD 除去、size field 除去、OBU 集約（W=1..3。Chrome が 1 temporal unit を 1 フレームとして扱う）。N bit は **webrtc の挙動を維持**し、アダプタで `startsNewCodedVideoSequence: packet.type === "key"` を渡す（av1C だけに SH を持つソースへの配慮） |
| 6 | `H264Packetizer`、`splitH264Sample`、`looksLikeAnnexB`、`readUintLength`、`containsH264ParameterSets` | `codec/h264.ts` `H264Packetizer`、`splitH264NalUnits`、`selectMissingH264ParameterSets` | rtp 側の仕様を採用する。SPS/PPS は STAP-A に集約し、欠けている型だけを補完し、AUD の後ろに挿入する。NAL type ≥14 は落とさない。avcC があれば `inputFormat: "length-prefixed"`、無ければ `"auto"`。keyframe 判定は `packet.type === "key"` |
| 7 | `parseAvcDecoderConfiguration`、`toDescriptionBuffer`（webrtc）と `parseAvcDecoderConfiguration`、`toBuffer`（`e2e/server/codecRtpUtils.ts`） | **新規** `codec/h264.ts` `parseAvcDecoderConfigurationRecord` | 3 箇所の重複を 1 つにする。戻り値は `naluLengthSize` / `sps` / `pps` / `parameterSets`。途中で切れた avcC は部分結果を返さず例外にする |

webrtc 側に残すもの（rtp に置くべきでない、webrtc 固有の処理）: `Packetizer` インターフェース（`EncodedPacket` 入力）、`createPacketizer`、`toSupportedMimeType`、`supportedSourceCodecs`、`getH264PacketizationMode`（SDP fmtp の解釈。mode≠1 は従来どおり例外）、`toBuffer`（`Uint8Array` から `Buffer` への変換）。

### 12.3 完了条件

- [x] webrtc の `userMedia/packetizer.ts` に codec ペイロード生成ロジックが残っていない（全 codec が `packages/rtp` の Packetizer に委譲される）
- [x] avcC パーサが `packages/rtp` の `parseAvcDecoderConfigurationRecord` に一本化され、webrtc と e2e の重複が削除されている
- [x] 単体テスト: rtp は avcC パーサ（正常系、byteOffset を持つ view、切れた入力）と H264Packetizer との連携。webrtc は AV1 の Z/Y 集約、avcC 付き H.264 の STAP-A、mode≠1 の拒否、Opus marker と PT、VP8 の連番。Arrange は `tests/utils.ts` と `userMediaTestUtils.ts` に集約する
- [x] `userMedia.test.ts` の H.264 待機条件を packet 数からフレーム数（marker 区切り）に変更（STAP-A 化で packet 数が変わるため）
- [x] `changelog.md` に統合と wire 上の挙動差分を記載
- [x] `npm run type` / `npm run test:small` / Chrome E2E が成功

## 参考：親チケットとの境界

| 親チケット | 本チケット |
|---|---|
| 新規コーデック（H265, G711, G722, AAC, DTMF）の de/packetizer | **既存**コーデック（H264, VP8, VP9, AV1, Opus）の **packetizer 追加** |
| `PacketizerBase` 新設 | それを **再利用** |
| webrtc に usePCMA/useG722 | webrtc 変更は原則不要 |
| 新規 RFC 3551/3640/4733/7798 | 追加で **7741 / 6184 / 7587 / 9628（VP9） / AV1 RTP** |