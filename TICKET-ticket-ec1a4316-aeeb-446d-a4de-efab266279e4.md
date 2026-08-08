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

結論: **「Chrome がデコードできる RTP を `packages/rtp` Packetizer が出せるか」** と **「Chrome が出した RTP を `packages/rtp` Depacketizer が正しくフレーム化できるか」** は、いずれも現行 CI では未カバー。

### 1.3 成功時の価値

- 親チケット実装が **ブラウザ相互運用可能なペイロード**であることを回帰防止できる。
- 非 WebRTC 用途（RTP-over-UDP / SIP / メディアリレー）でも「Chrome が受けられる形」を保証する基準になる。
- 将来 webrtc の `userMedia/packetizer` を rtp 実装へ差し替える際の受け入れテストにも流用できる。

---

## 2. 実装すべき具体的な機能や変更内容

### 2.1 置き場所（推奨）

ルート E2E ハーネス `e2e/` に追加する（`packages/rtp` 単体には browser harness が無い。`packages/ice-server/chrome-e2e` は ICE/TURN 専用でメディア向きではない）。

| 種別 | パス（案） |
|---|---|
| Server handler | `e2e/server/handler/mediachannel/codecRtp.ts`（または `codec/` 配下に codec 別） |
| 共有 Arrange ユーティリティ | `e2e/server/codecRtpUtils.ts`（GStreamer 生フレーム供給、packetize ループ、PLI、depacketize 集約） |
| Browser tests | `e2e/tests/mediachannel/codecRtp.test.ts`（または codec 別ファイル） |
| 登録 | `e2e/server/main.ts` の `tests` map に handler を追加 |
| 依存 | `e2e` は既に `werift` / `werift-rtp` と GStreamer spawn ヘルパ（`e2e/server/gstreamer.ts`）を持つ |

パッケージ境界:

- **SUT**: `packages/rtp` の `*Packetizer` / `*RtpPayload` / `dePacketizeRtpPackets` /（必要なら）`DepacketizeCallback`。
- **運搬役**: `packages/webrtc` の `RTCPeerConnection` / `MediaStreamTrack.writeRtp` / transceiver / codec ネゴシエーション。
- webrtc 側 `userMedia/packetizer.ts` の実装差し替えは **本タスク範囲外**（親チケットと同じ）。

### 2.2 対象コーデックと優先度

Chrome WebRTC で安定してネゴシエート・デコードできるものに絞る。

| 優先度 | コーデック | MIME（werift 側） | Packetizer E2E | Depacketizer E2E | 備考 |
|---|---|---|---|---|---|
| **P0 必須** | VP8 | `video/VP8`（`useVP8()`） | ○ | ○ | 既存 RTX と同系統。最も安定 |
| **P0 必須** | H.264 | `video/H264` + `packetization-mode=1`（`useH264()`） | ○ | ○ | profile-level-id は既存 `42e01f` を踏襲 |
| **P0 必須** | Opus | `audio/opus`（`useOPUS()`） | ○ | ○ | 音声。再生判定は後述 |
| **P1 推奨** | VP9 | `video/VP9`（`useVP9()`） | ○ | ○ | Chrome 対応。descriptor 最小サブセットが実機で通ること |
| **P2 条件付き** | AV1 | `video/AV1X`（`useAV1X()`） | ○（可能な環境） | ○ | SDP 名 `AV1X` と Chrome 能力の差に注意。失敗時は skip 条件を明文化 |
| **範囲外** | H.265 / PCMU / PCMA / G.722 / AAC / telephone-event | — | — | — | Chrome WebRTC では実質使えない or 対象外。単位テスト + `rtp_over_udp` で足りる |

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

参照実装の手本:

- `examples/mediachannel/codec/vp8.ts` / `h264.ts` / `vp9.ts` / `av1.ts`（`onReceiveRtp` + `*RtpPayload.deSerialize` + PLI）。
- `packages/webrtc/.../recorder/writer/webm.ts`（`DepacketizeCallback` 配線）。

#### シナリオ B — Packetizer（Node → Chrome）

```
エンコード済みフレーム供給（下記 2.4）
  → packages/rtp *Packetizer.packetize(frame, rtpTimestamp)
  → MediaStreamTrack.writeRtp(RtpPacket)
  → WebRTC → Chrome ontrack
  → waitVideoPlay(track) または音声相当の再生確認
```

必須アサート:

1. Chrome が **実際に再生できる**（黒画面固定で終わらない）。映像は既存 `e2e/tests/fixture.ts` の `waitVideoPlay`（canvas 画素ハッシュ変化）。
2. 使用 Packetizer が **`packages/rtp` のクラス**であること（import 経路をテストコード上で固定。GStreamer `rtp*pay` を使わない）。
3. 複数パケットにフラグメントされる十分なフレームサイズを少なくとも 1 コーデックで含む（例: 低 `maxPayloadSize` または大解像度）— marker / S・B/E / FU-A / Z·Y が実路で効くこと。
4. タイムスタンプがクロックレートに沿って進むこと（VP8/H264/VP9/AV1: 90000、Opus: 48000）。

#### シナリオ C — 再 packetize ループ（推奨・高価値）

```
Chrome 送信 → packages/rtp depacketize → 生フレーム
  → 同一コーデックの packages/rtp Packetizer で再 RTP 化
  → 別 transceiver / 別 PC で Chrome へ返送 → waitVideoPlay
```

- **Depacketizer と Packetizer を 1 本の E2E で同時検証**できる。
- Chrome が吐いた実ペイロード（拡張 descriptor 含む可能性）を depacketize し、**最小合法 descriptor で再送信しても Chrome がデコードできる**ことを示す。
- H.264 は SPS/PPS がストリーム内または `parameterSets` で揃っていること。欠ける場合は PLI 後の IDR を待つ / 先頭キーフレームをバッファする。

P0 では **VP8 でシナリオ C を必須**にし、H.264 / Opus は A+B、VP9 は A+B（可能なら C）が現実的。

### 2.4 フレーム供給（Packetizer 側）

**禁止**: `rtpvp8pay` / `rtph264pay` / `rtpopuspay` 等の **GStreamer RTP payloader の出力をそのまま writeRtp** する経路を、本タスクの「Packetizer 検証」として数えること（それは既存 RTX/RED と同型で SUT が違う）。

**許可する供給源**（優先順）:

1. **GStreamer でコーデックビットストリームのみ生成**し、Node が `*Packetizer` で RTP 化  
   - 例（概念）:  
     - VP8: `videotestsrc ! … ! vp8enc ! …` → フレーム境界付きバッファ  
     - H.264: `x264enc` / `openh264enc` + `h264parse` → Annex-B AU  
     - Opus: `audiotestsrc ! opusenc` → Opus packet  
   - 既存 `spawnGstreamerPipeline` は `gst-launch-1.0` の pipeline 文字列向け。**appsink で pull する**場合は `e2e/server/codecRtpUtils.ts` に専用 spawn / UDP 中継 / ファイル落ちを用意する。  
   - 簡易案: GST で raw RTP **ではなく** raw file / Unix pipe にフレームを書き、Node が読む。実装コストと CI 安定性で選択。
2. **事前コミットした短いエンコード済みクリップ**（`e2e/fixtures/media/` 等）を読み、Packetizer に渡す。CI に GStreamer が無い場合のフォールバック。  
   - 親チケットの `packages/rtp/tests/data/vector_*_expected.bin` は depacketize 後のメディアであり、Chrome 再生用の「正当なビットストリーム」として使える場合がある。ただし長さ・キーフレーム有無を確認すること。
3. **シナリオ C**（Chrome 自身のエンコード結果を depacketize したフレーム）— 外部エンコーダ不要で最も CI 親和性が高い。

推奨: **P0 はシナリオ C を主軸**にし、シナリオ B の「外部エンコード + Packetizer」は VP8 を 1 本以上（GStreamer 利用可能時）追加する。GStreamer 不在時は `it.skip` または env フラグ（例: `E2E_GST_CODEC=1`）でオプトインし、CI の必須パスはシナリオ A + C にする。

### 2.5 コーデック別の E2E チェックポイント

#### VP8（RFC 7741）

- Depacketizer: `S`/`PID` 付き Chrome ペイロードを `Vp8RtpPayload` / `dePacketizeRtpPackets("VP8", …)` で復元。キーフレームは payload header の **P bit**（既存 `isKeyframe`）。
- Packetizer: フレーム先頭チャンク `descriptor=0x10`（S=1）、後続 `0x00`、最終 `marker=true`。
- 再 packetize 後も Chrome が再生できること。

#### H.264（RFC 6184 mode=1）

- Node PC の `codecs.video` は **H.264 のみ**（`useH264()` 相当、`packetization-mode=1`）。
- Depacketizer 出力は Annex-B 連結。Single / STAP-A / FU-A いずれも `H264RtpPayload` 経路でフレーム化できること。
- Packetizer 再送時: キーフレームに SPS/PPS が含まれること（サンプル内 or `parameterSets`）。STAP-A 優先実装が実機でも問題ないこと。
- Chrome の profile 不一致で黒画面になる場合は `profile-level-id=42e01f` と level-asymmetry を維持し、必要なら送信側制約をドキュメント化。

#### Opus（RFC 7587）

- 1 RTP = 1 Opus packet、`marker=true`。
- Packetizer は `maxPayloadSize` 超過で throw する契約のまま。E2E では MTU 未満の実 Opus のみ。
- 再生確認: `waitVideoPlay` は使えない。次のいずれか:
  - `AudioContext` + `AnalyserNode` で一定時間エネルギー閾値超え（推奨）
  - または Node 側 depacketize 件数 + Chrome `getStats` の `bytesReceived` / `packetsReceived` 増加（最低限）
- 共有 Arrange に `waitAudioPlay(track)` を `e2e/tests/fixture.ts` へ追加するのが望ましい。

#### VP9（RFC 9628）

- 最小 descriptor（I=L=F=V=Z=0、B/E/P）で再送しても再生できること。
- key / delta の P ビットが depacketizer の解釈と矛盾しないこと。

#### AV1（条件付き）

- werift は `video/AV1X`。Chrome が offer/answer で選べるか環境依存。
- ネゴ失敗時は **fail ではなく skip**（理由をログ）。成功時のみ Z/Y/N と marker、キー時 N=1 を間接的に再生で確認。

### 2.6 テストコード規約（リポジトリ AGENTS.md 準拠）

- **Arrange / Act / Assert** の 3 相。
- Arrange の peer 作成・codec 固定・PLI タイマー・GStreamer 起動は **`e2e/server/codecRtpUtils.ts`（および browser 側は `tests/fixture.ts`）に集約**し、codec テスト間で複製しない。
- Act / Assert に **日本語コメント**を適切な粒度で付ける（操作意図と検証点）。
- protoo の label / method 名は既存同様 `mediachannel_codec_rtp_vp8` のように一意にする。
- handler は `done` で GStreamer / PC / UDP / timer を確実に破棄（`mediachannel_rtx` の `done` パターン）。

### 2.7 変更が不要なもの

- `packages/rtp` の Packetizer / Depacketizer **本体の仕様変更**は原則不要（バグ発見時のみ fix。本タスクの主成果は E2E）。
- `depacketizerCodecs` レジストリ変更は不要。
- `docs/rfc/` 追加は親チケット側。本タスクでは RFC 番号をテストコメントに参照する程度。
- Firefox E2E（`vitest.firefox.config.mts`）は必須にしない（タイトルが Chrome 指定）。

### 2.8 ドキュメント

- ルートまたは `e2e` 近傍に短い説明を足す場合: 新規シナリオ名、実行コマンド、GStreamer オプトイン、対象コーデック表。
- `packages/rtp/README.md` に「Chrome E2E: `npm run e2e`（mediachannel codec RTP）」程度の一行リンクがあれば十分。
- 詳細な feature カタログを AGENTS.md にコピーしない（ルート AGENTS.md の Don't）。

---

## 3. 技術的な実装アプローチ（調査サマリ）

### 3.1 E2E ハーネスの構造

- **Server**: `e2e/server/main.ts` が protoo `Room` 上で handler インスタンスを method 名でディスパッチ。
- **Browser**: Vitest + Playwright Chromium（`e2e/vitest.config.mts`）。fake media device フラグ済み（`--use-fake-device-for-media-stream`）。
- **実行**: ルート `npm run e2e` → `e2e` で `ci:silent`（server + `chrome:prod` 並列、`E2E_PORT` 動的割当）。
- **映像再生判定**: `waitVideoPlay` が video→canvas の画素 SHA-1 変化を待つ。タイムアウトは vitest `testTimeout: 20_000`（必要なら codec テストだけ延長）。

### 3.2 既存「RTP 注入」パターン（流用）

`e2e/server/handler/mediachannel/rtx.ts`:

1. `randomPort()` + UDP bind  
2. `MediaStreamTrack({ kind: "video" })` + `addTrack`  
3. UDP 受信で `RtpPacket.deSerialize` → `track.writeRtp`  
4. GStreamer 終了は `stopGstreamerProcess`  

本タスクでは 3 の直前に **自前 Packetizer** を挟む（または GST を止め、タイマーでフレームを packetize）。

### 3.3 codec 固定ネゴシエーション

```ts
new RTCPeerConnection({
  dtls: { keys: await DtlsKeysContext.get() },
  codecs: {
    video: [useVP8() /* or useH264 / useVP9 / useAV1X */],
    audio: [useOPUS()],
  },
});
```

- Chrome 側も `RTCRtpTransceiver.setCodecPreferences` または capabilities 並び替えで **同一 codec を優先**すると flaky が減る（`red.test.ts` が capabilities を触る先例あり）。
- Packetizer の `payloadType` は **ネゴ後の answer/offer で確定した PT** を使う（固定 96 決め打ちは避ける）。`PacketizerBase` options の `payloadType` を PC 確立後に設定、または `buildPacket` 相当で header を上書き。

### 3.4 Depacketize 集約

推奨 API:

```ts
import { DepacketizeCallback } from "werift-rtp/extra"; // または webrtc 経由 re-export
// video:
new DepacketizeCallback("VP8", {
  isFinalPacketInSequence: (h) => h.marker,
});
```

- `onReceiveRtp` ごとに `input({ rtp })`。
- 出力 `frame` で `isKeyframe` / `data` を収集し、Promise を resolve。
- 単体パケット検査だけなら `Vp8RtpPayload.deSerialize` でもよいが、**フレーム復元**まで見るなら `DepacketizeCallback` / `dePacketizeRtpPackets` が本命。

### 3.5 再 packetize 時の注意

| 項目 | 方針 |
|---|---|
| シーケンス番号 | 受信 seq を再利用せず、**送信 Packetizer が独自に採番**（`PacketizerBase`） |
| タイムスタンプ | 受信 RTP timestamp をそのまま再利用してよい（同じクロック） |
| SSRC | 送信 track / sender の SSRC に合わせる（必要なら packet 生成後に header.ssrc を設定） |
| VP8/VP9 拡張 | Chrome が PictureID 等を付けていても depacketize で落とし、最小 descriptor で再送 |
| H.264 | Annex-B のまま `H264Packetizer` へ。parameter set 欠損時は key 待ち |
| AV1 | `getFrame` 出力を `Av1Packetizer` へ。`isKeyframe` を options で渡す |

### 3.6 音声 wait の実装方針

```ts
// Arrange: AudioContext + MediaStreamSource + Analyser
// Act: 一定間隔で getByteTimeDomainData / getByteFrequencyData
// Assert: RMS または peak が閾値を超えたら成功
```

ヘッドレス Chromium + fake device でも `audiotestsrc` 系の注入や、Chrome→再送ループなら無音にならない設定を選ぶ。

### 3.7 依存関係

| 依存 | 用途 |
|---|---|
| Playwright Chromium / system Chrome | 既存 e2e |
| GStreamer（任意） | シナリオ B の外部エンコード |
| `werift` workspace パッケージ | PC / track（`e2e/server/index.ts` は workspace の `packages/webrtc` を re-export） |
| `werift-rtp` | Packetizer / Depacketizer（workspace 解決を確認。必要なら e2e の import を相対パス `../../packages/rtp/src` に統一） |

実装時は **e2e がビルド済み lib を見るか source を見るか**を既存 handler に合わせる（`e2e/server/index.ts` は webrtc source 直参照）。

---

## 4. 考慮すべき制約や注意点

### 4.1 何が「成功」か（偽陽性の排除）

- **透過 loopback の再生成功だけでは不合格**。必ず `packages/rtp` の API を呼んだ証拠（depacketize フレーム数 / packetize 後の descriptor 検証）をアサートに含める。
- GStreamer `rtp*pay` 経路を Packetizer 合格に使わない。
- シナリオ A だけで「Chrome が送れた」ことと「depacketizer が壊れていない」ことは言えるが、**Packetizer の Chrome 互換は B または C が必須**。

### 4.2 環境・フレーク

- fake media device は動きが単調 → `waitVideoPlay` が変化を検出できるよう、**再送側で videotestsrc や canvas 時計**など時間変化するソースを使う（シナリオ C なら Chrome の入力が fake でもエンコード変化はあるが、静的だと弱い）。
- PLI 無しだと keyframe 待ちでタイムアウトしがち。受信開始直後から PLI。
- `testTimeout` 20s は ICE + キーフレーム待ちで足りない場合あり。codec スイートは 30–60s を許容するか retry を活かす（既存 `retry: 1`）。
- 並列 file 実行で UDP port / GStreamer が競合しないよう `randomPort` と process 管理を徹底。
- CI に GStreamer が無い／不完全な場合の **必須パスとオプトインパス**を分ける。

### 4.3 コーデック相互運用の落とし穴

- **H.264**: profile-level-id、packetization-mode、SPS/PPS 欠落、FU-A 境界。
- **VP9**: 最小 descriptor のみ実装。Chrome 送信の拡張付きを depacketize できるか（既存 depacketizer の X/I 等サポート範囲を超える入力は「フレーム payload が取れれば可」と割り切る）。
- **AV1**: `AV1` vs `AV1X` の SDP、ハードウェア有無。
- **Opus**: RED と混在させない（本タスクは pure Opus）。dtx / fec は範囲外。
- **クロック**: G.722 のような罠は対象外。Opus 48000 / video 90000 を timestamp 進行に使う。

### 4.4 パッケージ境界

- `packages/rtp` に webrtc 依存を持ち込まない（E2E は e2e アプリが両方を束ねる）。
- mediabunny / `EncodedPacket` を rtp Packetizer API に繋がない。
- バグ修正が rtp 本体に及ぶ場合は、対応する **単体テストも追加**してから E2E を緑にする（根本原因修正。テスト無効化で逃げない）。

### 4.5 セキュリティ・リソース

- GStreamer / PC のリークは e2e server の `cleanupGstreamerProcesses` と handler `done` で回収。
- 無限バッファ（depacketize で marker が来ない）を防ぐため、テスト側に **上限時間とバッファ長**を設ける。

### 4.6 範囲外（明示）

- Firefox / Safari 相互運用。
- H.265 / G.711 / G.722 / AAC / DTMF の Chrome E2E。
- webrtc `userMedia/packetizer` の rtp 実装への置換。
- 画質・遅延・ロス耐性の性能ベンチ（再生可否とフレーム復元が主）。
- Simulcast / SVC 層の詳細（単一 layer で十分）。

---

## 5. 完了条件

1. **`e2e` に Chrome 向け codec RTP シナリオが追加**され、`e2e/server/main.ts` に handler が登録されている。
2. **P0（VP8 / H.264 / Opus）** について、少なくとも:
   - **シナリオ A（Depacketizer）**: Chrome 送信を `packages/rtp` でフレーム化し、非空フレームと（映像は）キーフレームをアサート。
   - **シナリオ B または C（Packetizer）**: `packages/rtp` の `*Packetizer` が生成した RTP を Chrome が再生（映像は `waitVideoPlay`、音声は `waitAudioPlay` 相当）。
3. **VP8 はシナリオ C（depacketize → re-packetize → 再生）が必須**で通る。
4. **P1 VP9** は A +（B または C）が通る。通らない環境依存がある場合は理由付きで issue/コメント化し、スキップ条件をテストに限定（P0 をスキップで逃さない）。
5. **P2 AV1** は実装済みなら A を試み、ネゴ不可時は skip。無理に fail にしない方針がテストコメントで共有されている。
6. Packetizer 検証経路で **GStreamer `rtp*pay` を SUT に使っていない**（使うならエンコードのみ）。
7. Arrange 共通化・Act/Assert 日本語コメントが AGENTS.md のテスト規約に沿っている。
8. handler 終了時に **PC / timer / GStreamer / socket が解放**され、連続実行でポート枯渇しない。
9. 検証コマンド:
   - 開発時: 対象テストに絞った vitest 実行（可能なら）。
   - 完了時: **`cd e2e && npm run type`** およびルート **`npm run e2e`**（または `cd e2e && npm run ci:silent`）で **新規シナリオを含む E2E が成功**。
   - rtp 本体をバグ修正した場合: **`cd packages/rtp && npm run type && npm test`** も成功。
10. ドキュメントに実行方法と対象コーデックが短い形で残っている（e2e README または rtp README の一行以上）。

### 受け入れの読み方

| 結果 | 意味 |
|---|---|
| 単体テストのみ緑 | **本タスク未完了** |
| 既存 sendrecv のみ緑 | **本タスク未完了**（rtp de/packetizer 未行使） |
| A+C が P0 で緑 | **最低ライン達成** |
| A+B+C と VP9 まで緑 | **完了として十分** |

---

## 参考: 親チケット・既存資産との境界

| 項目 | 親チケット（packetizer 実装） | 本チケット（Chrome E2E） |
|---|---|---|
| 成果物 | `packages/rtp/src/codec/*Packetizer` + 単体/ベクタ | `e2e` シナリオ + 必要なら rtp の互換バグ修正 |
| 仕様調査 / `docs/rfc/` | 必須 | 参照のみ |
| GStreamer | ベクタ生成 | 任意のフレーム供給（payloader は使わない） |
| webrtc userMedia packetizer | 参照実装・置換しない | 同様に SUT にしない |
| 新規コーデック H265 等 | 別親（coverage 拡張） | Chrome E2E 対象外 |

### 主な参照パス

- `packages/rtp/src/codec/{vp8,vp9,av1,opus,h264}.ts` — SUT
- `packages/rtp/src/extra/processor/depacketizerCallback.ts` — 受信集約
- `e2e/server/handler/mediachannel/rtx.ts` — writeRtp + GStreamer 管理の型
- `e2e/tests/fixture.ts` — `waitVideoPlay` / peer
- `examples/mediachannel/codec/*.ts` — Chrome→deSerialize の手動プロトタイプ
- `packages/webrtc/src/media/codec.ts` — `useVP8` / `useH264` / `useVP9` / `useAV1X` / `useOPUS`
- `packages/rtp/examples/node/rtp_over_udp/` — Node 単体 packetizer 使用例（ブラウザなし）
