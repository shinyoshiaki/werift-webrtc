# タスク詳細化: packages/rtp のコーデック packetizer / depacketizer を Chrome E2E で実機能検証する

## 1. タスクの目的と背景

### 1.1 位置づけ

親チケット（`vp8などの既存のコーデックのpacketizerも仕様を調査して実装する` / ID `631d0756-fe39-4a79-95d2-7f612015576b`）により、`packages/rtp` に以下が揃った（または揃う前提）:

| コーデック | Depacketizer | Packetizer | 仕様 |
|---|---|---|---|
| VP8 | `Vp8RtpPayload` | `Vp8Packetizer` | RFC 7741 |
| VP9 | `Vp9RtpPayload` | `Vp9Packetizer` | RFC 9628 |
| AV1 | `AV1RtpPayload` | `Av1Packetizer` | AV1 RTP |
| Opus | `OpusRtpPayload` | `OpusPacketizer` | RFC 7587 |
| H.264 | `H264RtpPayload` | `H264Packetizer` | RFC 6184 mode=1 |

これらは **単体テスト**（`packages/rtp/tests/codec/*.test.ts`）と **合成 / GStreamer ベクタ**（`tests/data/vector_*.bin`）で round-trip 可能であることが検証される。しかし、それだけでは **実ブラウザ（Chrome）が生成・消費する RTP ペイロードと相互運用できること** は保証されない。

本タスクの目的は、**Chrome ↔ Node(werift) の E2E で `packages/rtp` の Packetizer / Depacketizer が実務的に機能する**ことを、コーデックごとに自動テストで証明すること。

### 1.2 現状ギャップ（コードベース調査結果）

| 既存経路 | 何を検証しているか | 本タスクとの差 |
|---|---|---|
| `packages/rtp/tests/codec/*` | 合成ベクタ・GST ベクタの de/packetize round-trip | **Chrome 非関与** |
| `e2e` の `mediachannel_sendrecv` / `oneway` 等 | Chrome エンコード RTP を werift が `replaceTrack` で返す | **payload を `packages/rtp` で触らない**（透過中継） |
| `e2e` の `mediachannel_rtx` | GStreamer `rtpvp8pay` → `track.writeRtp` → Chrome 再生 | **payloader が GStreamer**。`Vp8Packetizer` ではない |
| `e2e` の `mediachannel_red` | GStreamer `rtpopuspay` → writeRtp | 同上（Opus も GST pay） |
| `examples/mediachannel/codec/{vp8,vp9,h264,av1}.ts` | Chrome 送信を `*RtpPayload.deSerialize` し keyframe を log | **手動デモ**。E2E 自動化・packetize 再送なし |
| `packages/webrtc/.../userMedia/packetizer.ts` | mediabunny `EncodedPacket` 向け独自 Packetizer | 親チケット方針どおり **SUT ではない**（参照実装）。本 E2E の送信側は `packages/rtp` の `*Packetizer` を使う |
| `MediaRecorder` + `DepacketizeCallback` | 受信 RTP を `packages/rtp` depacketizer で WebM 化 | デモ用途。Chrome 固定コーデックの CI アサートではない |
| `packages/webrtc/tests/data/nonstandard/userMedia-e2e/*.webm` | userMedia ファイル再生の単体系 | **webrtc 側 packetizer** 経由。本タスクでは demux のみ流用可 |

結論: **「Chrome がデコードできる RTP を `packages/rtp` Packetizer が出せるか」** と **「Chrome が出した RTP を `packages/rtp` Depacketizer が正しくフレーム化できるか」** は、いずれも現行 CI では未カバー。

### 1.3 成功時の価値

- 親チケット実装が **ブラウザ相互運用可能なペイロード**であることを回帰防止できる。
- 非 WebRTC 用途（RTP-over-UDP / SIP / メディアリレー）でも「Chrome が受けられる形」を保証する基準になる。
- 将来 webrtc の `userMedia/packetizer` を rtp 実装へ差し替える際の受け入れテストにも流用できる。

### 1.4 未確定事項の決着（本改訂で確定）

| 論点 | 決定 |
|---|---|
| シナリオ B のフレーム供給 / GStreamer 実行時依存 | **採用: 事前生成した小さい WebM（等）をリポジトリにコミットし、それをソースにする**。CI 実行時に GStreamer は不要。生成は開発時ワンショット（スクリプト化推奨） |
| AV1 の SDP 名（`AV1` vs `AV1X`） | **調査済み → 方針確定（§3.8）**。Chrome は `video/AV1`、werift は現状 `video/AV1X` のみ → **E2E でネゴできるよう SDP 側を対応**する |
| VP9 Chrome 拡張 descriptor | **「割り切り」にしない**。既存パーサは I/L/F/V 等を既に持つ。E2E で不足が露呈したら **調査のうえ depacketizer を追加実装 + 単体テスト**する |
| H.264 profile と黒画面 | **黒画面になってもよい**。H.264 の合否は de/packetize と RTP 配送の機能アサートが主。画素変化必須にしない |

---

## 2. 実装すべき具体的な機能や変更内容

### 2.1 置き場所（推奨）

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

### 2.2 対象コーデックと優先度

| 優先度 | コーデック | MIME（werift 側） | Packetizer E2E | Depacketizer E2E | 備考 |
|---|---|---|---|---|---|
| **P0 必須** | VP8 | `video/VP8`（`useVP8()`） | ○ | ○ | 最も安定 |
| **P0 必須** | H.264 | `video/H264` + `packetization-mode=1`（`useH264()`） | ○ | ○ | 黒画面可（§2.5） |
| **P0 必須** | Opus | `audio/opus`（`useOPUS()`） | ○ | ○ | 音声判定は後述 |
| **P1 推奨** | VP9 | `video/VP9`（`useVP9()`） | ○ | ○ | 拡張 descriptor は必要なら depacketizer 強化 |
| **P1 推奨** | AV1 | **`video/AV1`（標準名）+ 互換で `AV1X`**（§3.8） | ○ | ○ | ネゴ対応後は必須扱いに近づける。HW 無しでも libaom 系なら A は可能なことが多い |
| **範囲外** | H.265 / PCMU / PCMA / G.722 / AAC / telephone-event | — | — | — | 単位テスト + `rtp_over_udp` |

### 2.3 検証シナリオ（コア）

各 P0/P1 コーデックについて、最低次の **2 方向**を自動化する。

#### シナリオ A — Depacketizer（Chrome → Node）

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

#### シナリオ B — Packetizer（Node → Chrome）【確定: 事前 WebM ソース】

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

#### シナリオ C — 再 packetize ループ（推奨・高価値）

```
Chrome 送信 → packages/rtp depacketize → 生フレーム
  → 同一コーデックの packages/rtp Packetizer で再 RTP 化
  → 別 transceiver / 別 PC で Chrome へ返送 → 再生 / 受信確認
```

- Depacketizer と Packetizer を 1 本で同時検証。
- Chrome 拡張 descriptor を depacketize し、**最小合法 descriptor で再送**しても Chrome が扱えること。
- H.264 は SPS/PPS をキーフレームで確保（PLI / バッファ）。**黒画面でも機能アサート優先**。

P0: **VP8 はシナリオ C 必須**。H.264 / Opus は A+B。VP9 / AV1 は A+B（可能なら C）。

### 2.4 フレーム供給（Packetizer 側）— **確定方針: 事前 WebM フィクスチャ**

**禁止**:

- CI / テスト実行時に `rtpvp8pay` 等の **GStreamer RTP payloader 出力をそのまま writeRtp** すること（Packetizer 検証として数えない）。
- 実行時に `gst-launch` 必須とすること。

**採用（確定）**:

1. **開発時**に GStreamer（または同等）で **コーデックごとの小さい WebM / コンテナ**を生成し、リポジトリにコミットする。
2. **E2E 実行時**はファイルを demux し、生フレームを `packages/rtp` Packetizer に渡す。

#### 2.4.1 フィクスチャ仕様（案）

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

#### 2.4.2 実行時 demux → packetize

推奨フロー（e2e server 側）:

1. mediabunny（webrtc が既に依存）または同等で WebM/MP4 を開き、`EncodedPacketSink` で **encoded フレームの raw bytes** を取得。
2. **`createPacketizer`（webrtc userMedia）は使わない**。
3. `new Vp8Packetizer({ payloadType: negotiatedPt, ... }).packetize(Buffer.from(packet.data), rtpTs)` のように **rtp パッケージ API** を呼ぶ。
4. H.264 は Annex-B / AVCC のどちらで demux されるかを確認し、`H264Packetizer` の入力契約に合わせる（必要なら `parameterSets` を decoder config から渡す）。
5. VP9 / AV1 は key/delta を `EncodedPacket` の type から `isKeyframe` / `frameType` にマップ。

シナリオ C はフィクスチャ不要（Chrome がソース）。

### 2.5 コーデック別の E2E チェックポイント

#### VP8（RFC 7741）

- Depacketizer: Chrome の X/I 拡張付きでも `Vp8RtpPayload` が descriptor を剥がして payload 連結（既存実装は X/I/L/T/K をパース済み）。E2E で破綻したら修正。
- Packetizer: 先頭 `0x10`、継続 `0x00`、最終 marker。
- シナリオ C 必須。

#### H.264（RFC 6184 mode=1）

- Node は H.264 のみ negotiate（`useH264()`、`packetization-mode=1`、既存 `profile-level-id=42e01f` でよい）。
- Depacketizer: Single / STAP-A / FU-A → Annex-B。キーフレーム検出。
- Packetizer: フィクスチャ demux → `H264Packetizer`。SPS/PPS 付与は実装どおり。
- **合否**: フレーム depacketize / packetize 成功と RTP 配送。**`waitVideoPlay` の画素変化・黒画面回避は必須にしない**（「黒画面になっても良い」）。

#### Opus（RFC 7587）

- 1 RTP = 1 packet、marker=true。MTU 超過 throw 契約は E2E では踏まないサイズのフィクスチャ。
- 再生: `waitAudioPlay`（Analyser）または stats。

#### VP9（RFC 9628）— depacketizer 方針【確定】

**現状調査結果（コード）**:

- `Vp9RtpPayload.parseRtpPayload` は RFC 9628 の主要フィールドを実装済み:
  - 必須 octet: I|P|L|F|B|E|V|Z
  - I → Picture ID（1/2 byte, M bit）
  - L → layer indices + non-flex 時 TL0PICIDX
  - F∧P → P_DIFF 連鎖
  - V → Scalability structure（N_S/Y/G、幅高、N_G、pg）
- `packages/rtp/tests/codec/vp9.test.ts` に PictureId / Layer / RefIdx / SS の合成テストあり。

**本タスクでの扱い（割り切り禁止）**:

1. シナリオ A で Chrome 実パケットを depacketize。失敗・壊れたフレーム長・例外があれば **根因を調査**。
2. 不足フィールドや境界バグなら **`vp9.ts` を追加実装**し、**再現ベクタを単体テストに固定**してから E2E を緑にする。
3. 「payload が取れれば拡張は無視でよい」という事前割り切りは **採用しない**（既に拡張を読む実装があるため、壊れているなら直す）。
4. Packetizer 側は引き続き最小 descriptor でよい。再送後の再生は C で確認。

VP8 も同様に X 拡張は既存。E2E で問題が出たら同方針で修正。

#### AV1 — SDP 名と E2E【確定方針は §3.8】

- ペイロード: Z/Y/W/N、キー時 N=1、`getFrame` 整合。
- ネゴ: Chrome は `AV1`、werift は現状 `AV1X` → **§3.8 の対応を本タスクに含む**（ネゴ不能のまま skip で逃さないことを目標。どうしても環境が無い場合のみ skip）。

### 2.6 テストコード規約（リポジトリ AGENTS.md 準拠）

- **Arrange / Act / Assert**。
- Arrange（PC 作成・codec 固定・PLI・WebM 読み・demux）は **`e2e/server/codecRtpUtils.ts` と `e2e/tests/fixture.ts` に集約**。
- Act / Assert に **日本語コメント**。
- protoo method 名は `mediachannel_codec_rtp_vp8` 等で一意。
- handler `done` で PC / timer / ファイルハンドル解放（GStreamer プロセスは実行時不要なら無し）。

### 2.7 変更が必要になり得る rtp / webrtc 側

| 変更 | 条件 |
|---|---|
| `packages/rtp` VP9/VP8/AV1 depacketizer 修正 | Chrome 実パケットで破綻したとき（本タスク範囲内） |
| `useAV1()` 追加または `useAV1X` の mime を `video/AV1` に寄せる / 両方 advertise | **AV1 E2E のために本タスクで実施（§3.8）** |
| `findCodecByMimeType` の AV1↔AV1X エイリアス | 上記の代替または併用 |
| webrtc userMedia packetizer 置換 | **範囲外** |

### 2.8 ドキュメント

- フィクスチャ生成手順と「CI では生成不要」を短く記載。
- `packages/rtp/README.md` に Chrome E2E への一行リンク。
- H.264 黒画面許容をテストコメントに明記。

---

## 3. 技術的な実装アプローチ（調査サマリ）

### 3.1 E2E ハーネスの構造

- **Server**: `e2e/server/main.ts` + protoo。
- **Browser**: Vitest + Playwright Chromium（fake media device 済み）。
- **実行**: ルート `npm run e2e` → `e2e` の `ci:silent`。
- **映像判定**: `waitVideoPlay` は VP8/VP9/AV1 で優先利用。H.264 は任意。

### 3.2 既存「RTP 注入」パターン（流用）

`e2e/server/handler/mediachannel/rtx.ts` の `MediaStreamTrack` + `writeRtp` + `done` クリーンアップを踏襲。UDP/GStreamer pay 部分を **フィクスチャ demux + rtp Packetizer** に置き換える。

### 3.3 codec 固定ネゴシエーション

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

### 3.4 Depacketize 集約

```ts
new DepacketizeCallback("VP8", {
  isFinalPacketInSequence: (h) => h.marker,
});
```

フレーム復元まで見るなら `DepacketizeCallback` / `dePacketizeRtpPackets` が本命。

### 3.5 再 packetize 時の注意

| 項目 | 方針 |
|---|---|
| シーケンス番号 | 送信 Packetizer が独自採番 |
| タイムスタンプ | 受信 timestamp 再利用可 |
| SSRC | 送信 track に合わせる |
| VP8/VP9 拡張 | depacketize で除去し最小 descriptor で再送 |
| H.264 | Annex-B + 必要なら parameterSets |
| AV1 | `getFrame` → `Av1Packetizer` + isKeyframe |

### 3.6 音声 wait

`AudioContext` + `AnalyserNode` でエネルギー閾値、または `getStats` の受信増分。

### 3.7 フィクスチャ demux（実行時）

- webrtc の `getUserMedia({ buffer })` は内部で **webrtc packetizer** を使うため、**そのまま SUT 経路にしてはならない**。
- 同じ mediabunny の demux API だけを e2e ユーティリティから呼び、bytes を rtp Packetizer に渡す。
- 参考: `packages/webrtc/src/nonstandard/userMedia.ts` の `EncodedPacketSink` 利用箇所（packetize 呼び出しを rtp 側に差し替えるイメージ）。

### 3.8 AV1 SDP 名の差異 — 調査結果と対応方針【確定】

#### 調査結果

| 側 | encoding name / mimeType | 根拠 |
|---|---|---|
| **AV1 RTP 仕様** | SDP `a=rtpmap` の encoding name は **`AV1`** | [AV1 RTP payload format](https://aomediacodec.github.io/av1-rtp-spec/) § SDP mapping |
| **Chrome / 現行ブラウザ** | capabilities / SDP は **`video/AV1`** | 2021 以降 AV1X→AV1 移行完了（[discuss-webrtc PSA: AV1X will be replaced with AV1](https://groups.google.com/g/discuss-webrtc/c/ACmDgZEAooc)）。MDN も WebRTC AV1 を Chrome 113+ 等で記載 |
| **werift 現状** | `useAV1X()` → **`video/AV1X` のみ**（`packages/webrtc/src/media/codec.ts`）。`supportedCodecs` も AV1X | 歴史的な実験名のまま |
| **ネゴ照合** | `findCodecByMimeType` は **完全一致**（`mimeType.toLowerCase()` 同士） | `packages/webrtc/src/peerConnection.ts` — `video/av1` ≠ `video/av1x` なので **マッチしない** |

補足:

- MediaRecorder 側は受信 codec 名 `av1x` を WebM の `"AV1"` にマップしている（`webm.ts`）が、**SDP ネゴとは別経路**。
- userMedia のソース codec `av1` → 期待 mime `video/av1x` も AV1X 前提。

#### 対応方針（本タスクに含む）

優先順（上から推奨）:

1. **`useAV1()` を追加**（`mimeType: "video/AV1"`）し、`supportedCodecs` / デフォルト video リストに **`useAV1()` を主、必要なら `useAV1X()` を後方互換で残す**。
2. E2E の Node PC は **`codecs.video: [useAV1()]`**（または AV1 と AV1X の両方）で offer/answer。Chrome の `video/AV1` と一致させる。
3. 既存の `AV1X` のみのリモートに備え、**`findCodecByMimeType`（または codec マッチ層）で `AV1` ↔ `AV1X` を同一コーデックとしてエイリアス**するかを実装時に判断:
   - **最小**: E2E と新規コードは `video/AV1` のみ使い、エイリアス無し。
   - **互換重視**: マッチ関数で name 正規化（`av1x` → `av1`）し、旧 peer ともつながる。
4. rtp パッケージの de/packetizer レジストリ名 `"AV1"` はそのまま（ペイロード形式は SDP 名と独立）。
5. ドキュメント / changelog: 「SDP は AV1 が正。AV1X は legacy alias」と短く記載。

#### E2E での扱い

- AV1 フィクスチャ WebM を用意しシナリオ B を実施。
- シナリオ A は Chrome が AV1 エンコード可能な環境で実施（近年の Chromium はソフトエンコード可のことが多い）。
- **ネゴ失敗が `AV1X` のみ advertise が原因ならバグ / 未対応として修正**（skip で逃げない）。
- エンコーダ自体が完全に無い古い Chromium に限り skip 可（理由をログ）。通常 CI の Playwright Chromium では AV1 対応を前提にトライする。

### 3.9 依存関係

| 依存 | 用途 |
|---|---|
| Playwright Chromium | 既存 e2e |
| コミット済み WebM/MP4 | シナリオ B のフレーム源 |
| GStreamer | **フィクスチャ生成時のみ**（CI 実行時不要） |
| mediabunny（e2e/webrtc 経由） | demux のみ |
| `packages/rtp` | SUT packetize / depacketize |
| `packages/webrtc` | PC / track /（AV1 SDP 修正） |

---

## 4. 考慮すべき制約や注意点

### 4.1 何が「成功」か（偽陽性の排除）

- **透過 loopback の再生成功だけでは不合格**。`packages/rtp` API を呼んだ証拠をアサートに含める。
- GStreamer `rtp*pay` や webrtc userMedia packetizer を Packetizer 合格に使わない。
- シナリオ A のみでは Packetizer 未検証 → **B または C が必須**。

### 4.2 環境・フレーク

- 実行時 GStreamer 非依存になったため、**CI の GST 有無問題は解消**（フィクスチャ欠落だけが失敗理由）。
- fake media は動きが単調 → シナリオ C では PLI と十分な待機。シナリオ B はフィクスチャに動きのある videotestsrc 由来を推奨。
- `testTimeout` は codec スイートで 30–60s を許容してよい。
- 並列実行時の PC リークに注意。

### 4.3 コーデック相互運用

- **H.264**: 黒画面許容。profile チューニングは必須作業にしない。de/packetize と配送を見る。
- **VP9**: 拡張 descriptor は既存実装あり。E2E 失敗時は **追加実装**（割り切り禁止）。
- **VP8**: 同様に X 拡張は既存。問題時は修正。
- **AV1**: SDP は `AV1` を正とする対応を本タスクに含む（§3.8）。
- **Opus**: pure Opus。RED 混在なし。

### 4.4 パッケージ境界

- `packages/rtp` に webrtc 依存を持ち込まない。
- mediabunny は e2e demux に限定。rtp Packetizer の引数は `Buffer`。
- rtp 修正時は **単体テスト追加後に E2E**。

### 4.5 リソース

- フィクスチャは小さく保つ。巨大 raw をコミットしない。
- depacketize バッファに上限時間を設ける。

### 4.6 範囲外

- Firefox / Safari。
- H.265 / G.711 / G.722 / AAC / DTMF の Chrome E2E。
- webrtc userMedia packetizer の rtp への置換。
- H.264 の黒画面解消・画質保証。
- 性能ベンチ、Simulcast/SVC 詳細。
- **CI 上での GStreamer インストール必須化**（生成は開発時のみ）。

---

## 5. 完了条件

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

### 受け入れの読み方

| 結果 | 意味 |
|---|---|
| 単体テストのみ緑 | **未完了** |
| 既存 sendrecv のみ緑 | **未完了** |
| フィクスチャ無しで実行時 GST 依存のまま | **方針違反（未完了）** |
| AV1 が AV1X のまま Chrome とネゴできず skip のみ | **AV1 項目未完了** |
| P0 の A+B、VP8 の C、VP9/AV1 対応済み | **完了** |

---

## 参考: 親チケット・既存資産との境界

| 項目 | 親チケット（packetizer 実装） | 本チケット（Chrome E2E） |
|---|---|---|
| 成果物 | `packages/rtp` Packetizer + 単体/ベクタ | `e2e` シナリオ + フィクスチャ + 必要なら rtp/webrtc 互換修正 |
| 仕様 / `docs/rfc/` | 必須 | 参照 + テストコメント |
| GStreamer | ベクタ生成 | **フィクスチャ事前生成のみ**（実行時不要） |
| AV1 SDP | 対象外だった | **本タスクで `AV1` 対応** |
| webrtc userMedia packetizer | 参照・置換しない | 同様（demux のみ流用可） |

### 主な参照パス

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
