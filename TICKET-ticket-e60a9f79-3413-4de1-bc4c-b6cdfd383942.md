# 詳細化（コードベース調査結果）

## 1. 目的と背景

- 上流 RTP ソースを差し替えても、下流 RTP/SRTP セッションの seq / timestamp タイムラインを連続させたい（例: Ring → HomeKit ゲートウェイで 30 分ごとに上流 WebRTC 接続を作り直す dgreif/ring#1816）。
- werift には既に送信側の連続化ロジックがある。ただし `RTCRtpSender` の private 実装なので、受信した RTP や生の RTP を扱うアプリからは使えない。
  - `packages/webrtc/src/media/rtpSender.ts:129` `freezeRtpContinuityOffsets()`（module-private 関数）
  - 状態は private フィールド: `sequenceNumber` / `timestamp` / `seqOffset` / `timestampOffset` / `rtpContinuityPending` / `pendingTimestampStep`（`rtpSender.ts:191-196`）
  - `replaceRTP(header, discontinuity, timestampStep)`（`rtpSender.ts:627`）と `replaceTrack()`（`rtpSender.ts:477`、pending 化は `:504`）は、`scheduleRtpContinuity()`（`rtpSender.ts:642`）で pending にするだけ。最初に実際に送出したパケットでオフセットを確定する（`dispatchRtp()` `rtpSender.ts:648`、確定処理は `:664-685`）。
- `support-fallback-state` へのリベース（negotiation transaction 化、`469c5ed1` まで）で、`RTCRtpSender` に negotiation のベースライン用 API が追加された。continuity ロジック自体は変わっていない（行番号がずれただけ）。
  - `snapshotSendParams()` / `restoreSendParams()`（`rtpSender.ts:272` / `:299`）: `RTCRtpTransceiver.snapshotNegotiationState()` / `restoreNegotiationState()` から呼ばれる（`rtpTransceiver.ts:200` / `:235`）。対象は cname / mid / headerExtensions / codec / RTX・RED の PT / track.codec など、description 由来の送信パラメータだけで、RTP タイムラインの状態は含まない。
  - `proposeSend()` / `proposedPrimaryCodec`（`rtpSender.ts:294` / `:209`）: remote offer が pending の間、`replaceTrack()` は確定済みの codec と answer で切り替わる予定の codec の両方と互換かを検査する（`rtpSender.ts:487`）。
  - `prepareSend()` の codec 決定は `sendCodecOf()` / `primarySendCodecOf()`（ファイル末尾のヘルパー）に整理された。
- #677 の修正は `7d3e6087`（#679）でマージ済み。その内容は「pending 方式」「`timestampStep` 既定値 1」「`discontinuity` は写像に影響しない」「`header` 引数はオフセット計算に使わない」。テストも `packages/webrtc/tests/media/rtpSender.test.ts:867-1220`（`describe("media/rtpSender RTP continuity")`）に揃っている。本チケットではこの確定済みの意味論をそのまま汎用プリミティブへ切り出し、公開する。

## 2. 実装すべき機能・変更内容

### 2.1 新規: `RtpContinuityRewriter`（`packages/rtp`）

- 配置: `packages/rtp/src/rtp/continuity.ts`。`packages/rtp/src/index.ts` に `export * from "./rtp/continuity";` を追加する。
  - `werift` 本体の `src/index.ts`、`werift/nonstandard` の `src/nonstandard/index.ts` はどちらも `imports/rtp`（= `packages/rtp/src`）を `export *` している。そのため `werift-rtp` / `werift` / `werift/nonstandard` のすべてから利用できる。
  - `extra/processor` の `Processor` 形式にはしない。依存が少なく、sender からも直接使えるコア API とする。必要になればコールバック版のラッパーは後から追加する。
- 推奨 API（チケット本文の案をベースに、#677 の意味論へ合わせたもの）:

```ts
export interface RtpContinuityState {
  /** 直近の出力のうち wrap を考慮して最も進んだ seq（未出力なら undefined） */
  highestOutputSequenceNumber?: number;
  /** 上記に対応する出力 timestamp */
  highestOutputTimestamp?: number;
  seqOffset: number;        // uint16
  timestampOffset: number;  // uint32
  pending?: { timestampStep: number };
  /** switchSource() のたびに +1。世代判定・デバッグ用 */
  generation: number;
}

export interface RtpContinuityRewriterOptions {
  /** 出力 SSRC。指定時のみ書き換える（未指定なら保持） */
  ssrc?: number;
  /** 復元用。別ラッパー・別インスタンス間で連続性を引き継ぐ */
  state?: RtpContinuityState;
}

export class RtpContinuityRewriter {
  constructor(options?: RtpContinuityRewriterOptions);
  /** 次に rewrite される最初のパケットでオフセットを確定する（pending） */
  switchSource(options?: { timestampStep?: number }): void;
  /** 入力を変更せず、clone した RtpPacket を返す */
  rewrite(packet: RtpPacket): RtpPacket;
  /** header を in-place で書き換える（RTCRtpSender など、既に clone 済みの呼び出し元向け） */
  rewriteHeaderInPlace(header: RtpHeader): void;
  /** 現世代の入力 seq/ts → 出力値の変換（RTX の OSN、SR の rtpTimestamp 変換用） */
  translateSequenceNumber(inputSeq: number): number;
  translateTimestamp(inputTimestamp: number): number;
  /** 出力タイムラインを破棄し、新しい世代を最初から始める（次の入力はそのまま通す） */
  reset(): void;
  get state(): RtpContinuityState; // コピーを返す
  toJSON(): Record<string, unknown>; // RtpTimeBase などの既存 processor の慣習に合わせる
}

/** 補助: 経過時間から境界の timestampStep を求める（呼び出し側で任意に使う） */
export function timestampStepFromElapsed(elapsedMs: number, clockRate: number): number;
```

- 意味論（#677 で確定済みの内容と同じにする）:
  - 初回（出力なし）: オフセットは 0 で、そのまま通す（sender の現在の挙動と同じ）。
  - `switchSource()` 後に最初に `rewrite` されたパケット `p` で確定する:
    - `seqOffset = uint16Add(uint16Add(highestOutSeq, 1), -p.seq)`
    - `timestampOffset = uint32Add(uint32Add(highestOutTs, step), -p.ts)`
    - 以後、同じ世代のパケットにはすべて固定オフセットを適用する。パケットごとの差分からオフセットを導き直さない。
  - `timestampStep` の既定値は 1（sender と同じ）。`clockRate` を必須オプションにはしない。境界の時間ギャップを実時間で反映したい呼び出し側（HomeKit など）は、`timestampStepFromElapsed()` で値を求めて渡す。
  - `switchSource()` を、確定前に複数回呼んだ場合は最後の `timestampStep` が勝つ（上書き）。
  - `switchSource()` のヘッダー引数は受け取らない。互換用に受け取るとしても、オフセット計算には使わない。これは #677 で確定済みの「先頭の実送出パケットを基準にする」方式に合わせるため。
- 注意すべき設計差分（現在の sender の潜在的な問題）:
  - 現在の `dispatchRtp()` は `this.sequenceNumber = header.sequenceNumber` を毎パケット無条件に上書きしている（`rtpSender.ts:684-685`）。そのため、切替直前に再順序で古い seq が流れると「直前出力 + 1」が既出の seq と衝突する。
  - rewriter では `uint16Gt` / `uint32Gt`（`packages/common/src/number.ts`）を使い、wrap を考慮して **最も進んだ出力 seq（とその timestamp）** を基準にする。timestamp は「最大 seq の ts」ではなく、wrap を考慮した最大出力 ts を独立に追跡するのが安全。B フレームなどで seq と ts が単調対応しないことがあるため。
  - この変更で sender の挙動がわずかに変わる。既存テストが通ることを確認し、回帰テストを追加する。
- ミューテーション方針（受け入れ条件 "No mutation surprises"）:
  - `rewrite()` は `packet.clone()` を返し、入力は変更しない。
  - `RtpPacket.clone()` は浅いコピー（`packages/rtp/src/rtp/rtp.ts:281`）で、`payload` Buffer と `header.extensions` / `csrc` 配列は共有される。この点を TSDoc に明記する。rewriter が書き換えるのはプリミティブ（seq / ts / ssrc）だけ。
  - in-place 版は名前（`rewriteHeaderInPlace`）で変更することを明示する。

### 2.2 `RTCRtpSender` の内部置き換え

- `freezeRtpContinuityOffsets()` と、関連する private フィールド（`timestampOffset`, `seqOffset`, `rtpContinuityPending`, `pendingTimestampStep`）を `RtpContinuityRewriter` のインスタンス 1 つに置き換える。
  - `replaceRTP()` / `scheduleRtpContinuity()` → `rewriter.switchSource({ timestampStep })` と `rtpCache = []`（RTX 履歴のクリアは sender の責務として残す）。
  - `dispatchRtp()` は既に clone 済みなので `rewriteHeaderInPlace(header)` を使う。SSRC と PT の書き換えは sender 側に残す（`header.ssrc = this.ssrc`, `header.payloadType = codec.payloadType`）。
  - `detachTrack()`（`rtpSender.ts:515-516`）と `stop()`（`rtpSender.ts:527`）が `rtpContinuityPending = false` にしている意味も保つ。`replaceTrack(null)` → 再アタッチ時に `this.sequenceNumber != undefined` なら pending にする、という既存の流れを rewriter の state で表現する。
  - `this.sequenceNumber` / `this.timestamp` を参照している箇所（stats、`replaceTrack` の判定、ログ）は `rewriter.state` 経由にするか、従来どおり最後の出力値を別に保持する。stats の意味が変わらないように注意する。
- `replaceTrack()` の順序は維持する。codec 互換検査（`sendPrimaryCodec` と `proposedPrimaryCodec`）で `InvalidModificationError` を投げる場合は、その前に `switchSource()` を呼ばない。拒否された差し替えで continuity が pending にならないようにするため。
- negotiation のベースラインとの関係:
  - rewriter の状態は `snapshotSendParams()` / `restoreSendParams()` に**含めない**。出力 RTP タイムラインは送出済みパケットに紐づく live な状態で、description の rollback で巻き戻すと、送信済みの seq を再利用することになる。`NEGOTIATION_TRANSACTION.md` の「Sender SSRC → sender は application state」と同じ扱い。
  - negotiation の commit / rollback で送信 codec（PT）が変わっても、continuity は切り替えない。PT の書き換えは引き続き sender 側の `header.payloadType = codec.payloadType`（`rtpSender.ts:681`）で行う。
  - これらの方針を、`restoreSendParams()` 付近のコメントか rewriter の TSDoc に 1 行で明記する。
- 公開 API の `replaceRTP(header, discontinuity, timestampStep)` のシグネチャと TSDoc は互換のまま維持する。

### 2.3 ドキュメント・例

- relay 型の例を 1 つ追加する（受け入れ条件）。推奨は `examples/mediachannel/rtp_forward` 系の派生、または `packages/rtp/examples/node/continuity/relay.ts`。
  - 2 つの上流（A → B）の受信 track から 1 つの UDP/下流へ転送する。A を閉じて B へ切り替えるときに `switchSource()` を呼び、下流の seq / ts が連続することをログで示す。
  - root の `examples/` に追加する場合、`examples/e2e` のカタログには入れない（ブラウザが不要な Node 専用デモのため）。あるいは `examples/untested/` 方針に従う。`examples/AGENTS.md` を確認すること。
- `packages/rtp/README.md` に短い使用例を追加し、`npm run doc` で `doc/` を再生成する（`RTCRtpSender.md` の差分も確認する）。

## 3. 技術的な実装アプローチ（調査まとめ）

| 項目 | 既存資産 | 方針 |
| --- | --- | --- |
| wrap 演算 | `uint16Add` / `uint32Add`（BigInt）/ `uint16Gt` / `uint32Gt`（`packages/common/src/number.ts`） | そのまま使う。`packages/rtp` からは `../imports/common` 経由で import する |
| オフセット確定 | `freezeRtpContinuityOffsets`（`rtpSender.ts:129`） | rewriter へ移す。基準を「最後の出力」から「最も進んだ出力」へ変える |
| pending 方式 | `scheduleRtpContinuity` / `dispatchRtp` | `switchSource()` + 最初の `rewrite` で確定 |
| 状態の直列化 | `RtpTimeBase.toJSON()`（`extra/processor/rtpTime.ts`） | `state` getter / `toJSON` / コンストラクタでの `state` 復元 |
| negotiation の snapshot | `snapshotSendParams` / `restoreSendParams`（`rtpSender.ts:272-317`）、`RTCRtpTransceiver.snapshotNegotiationState`、`packages/webrtc/NEGOTIATION_TRANSACTION.md` | rewriter の状態は snapshot の対象外にする（live な application state） |
| テストのヘルパー | `packages/webrtc/tests/fixture.ts`（`createConnectedRtpSender`, `sentRtpHeaders`）、`packages/rtp/tests/utils.ts` | rtp 側の Arrange ヘルパー（RTP パケット生成、フレーム列・wrap 近傍列の生成）は `packages/rtp/tests/utils.ts` に集約する |

### RTCP / SSRC などとの関係（TSDoc と README に明記する）

| 項目 | rewriter の責務 | 呼び出し側の責務・推奨 |
| --- | --- | --- |
| SSRC | `ssrc` オプション指定時だけ書き換える。未指定なら保持 | 下流で SSRC を固定したい relay は `ssrc` を指定する。sender は自前で設定する |
| Payload Type | 扱わない | 上流と下流で PT が違う場合は、呼び出し側で書き換える（sender は `codec.payloadType`） |
| RTX | 扱わない。`translateSequenceNumber()` を提供する | 上流 RTX を転送する場合は、OSN を現世代のオフセットで変換する。切替時は RTX 履歴を破棄する（sender は `rtpCache = []` を継続）。RTX 自身の seq 空間は別に管理する（`rtxSequenceNumber`） |
| 下流からの NACK | 逆写像は提供しない（前世代の seq は別ソースのため、意味を持たない） | 出力 seq をキーにした自前の履歴から再送する（sender の `rtpCache` と同じ） |
| RTCP SR | 扱わない。`translateTimestamp()` を提供する | 上流 SR をそのまま転送しない。下流側で書き換え後の rtpTimestamp と現在の NTP から SR を自前で生成する（sender の `rtpTimestamp` は書き換え後の値。テスト `rtpSender.test.ts:1173`）。上流 SR を転送する場合は、rtpTimestamp を `translateTimestamp()` で変換し、SSRC も揃える |
| TWCC（transport-wide seq） | 扱わない | トランスポートごとに独立に採番する（sender は `dtlsTransport.transportSequenceNumber`）。上流の TWCC 拡張は転送時に除去するか、付け替える |
| 連続切替 | 世代ごとに固定オフセットを再確定する | — |

## 4. 制約・注意点

- 既存 `RTCRtpSender` の公開挙動（`replaceRTP` / `replaceTrack` / `onSourceChanged`）と #677 のテスト群（`rtpSender.test.ts:867` 以降）を回帰させない。
- 「最も進んだ出力」基準にすると、sender の境界の挙動がわずかに変わる（再順序パケットが最後だった場合）。これは修正扱いとし、テストで明示する。
- 32bit 演算は `uint32Add`（BigInt）で行う。`>>> 0` などの手書き演算と混在させない。性能が問題になる場合でも、正しさを優先する（ホットパスなので、必要なら `(a + b) >>> 0` 相当の Number 演算へ置き換え、等価であることをテストで保証する）。
- `rewrite()` は入力を変更しない。payload / extensions は共有されることを TSDoc に書く。
- シグナリング層の再接続やリトライ方針は実装しない（スコープ外）。
- RTX / SR / TWCC の自動処理はしない（上表のとおり、責務の境界を文書化するにとどめる）。
- テストは Arrange / Act / Assert の 3 フェーズで書き、Act / Assert には日本語コメントを付ける。Arrange のユーティリティは `packages/rtp/tests/utils.ts`（rtp）と `packages/webrtc/tests/fixture.ts`（webrtc）に集約する。
- `packages/webrtc/AGENTS.md` Do 6〜7（リベースで追加）: router / receiver / sender のテーブルに触れる negotiation の変更では、`NEGOTIATION_TRANSACTION.md` に従い、property search を実行する必要がある。本チケットは送信 RTP の書き換えだけで、negotiation の状態を変えない。ただし `rtpSender.ts` を変更するので、webrtc の `npm test` 全体（negotiation の property テストを含む）が通ることを確認する。snapshot に状態を追加しない限り、深い property search は必須ではない。
- 変更前後の sender の挙動（再順序境界など）を比べるときは、AGENTS.md Do 15 に従って一時 worktree（`git worktree add --detach <tmp> <rev>`）で行う。active worktree を checkout / reset / stash しない。
- `packages/rtp` には `AGENTS.md` がない。scripts は `npm run type` / `npm test`（`vitest run ./tests`）。

## 5. 完了条件

- [ ] `packages/rtp/src/rtp/continuity.ts` に `RtpContinuityRewriter`（と `timestampStepFromElapsed`）を実装し、`werift-rtp` / `werift` / `werift/nonstandard` から import できる。
- [ ] 切替ごとに固定オフセットで変換し、基準は wrap を考慮した最大出力 seq / ts。16bit seq / 32bit ts の wrap に対して安全。
- [ ] `rewrite()` が非破壊（clone を返す）であること、in-place 版があること、浅いコピーである点が TSDoc に明記されている。
- [ ] `state` の取得・復元、`reset()` による新しい世代の開始ができる。
- [ ] `packages/rtp/tests/rtp/continuity.test.ts` で次を検証する:
  - 同一 timestamp の複数パケット（映像フレーム）
  - 欠落
  - 重複
  - 再順序
  - 切替直前の再順序（衝突しないこと）
  - seq / ts の wrap 跨ぎ（境界値 0xffff / 0xffffffff）
  - 連続した複数回の切替
  - 確定前の `switchSource` 多重呼び出し
  - state の復元
  - `reset`
  - 入力が変更されないこと
- [ ] `RTCRtpSender` が rewriter を内部で使い、`freezeRtpContinuityOffsets` を削除。既存の continuity テストがすべて通り、再順序境界の回帰テストを追加する。
- [ ] rewriter の状態が `snapshotSendParams()` / `restoreSendParams()` に含まれず、negotiation の rollback で出力タイムラインが巻き戻らない。codec 互換検査で拒否された `replaceTrack()` では continuity が pending にならない。どちらも webrtc 側のテストで確認する。
- [ ] RTCP / SSRC / PT / RTX / SR / TWCC / 連続切替の責務境界が TSDoc と `packages/rtp/README.md` に記載されている。
- [ ] A → B の上流差し替えで下流 RTP が連続する relay 例を追加し、`doc/` を再生成する。
- [ ] 検証: `cd packages/rtp && npm run type && npm test`、`cd packages/webrtc && npm run type && npm test`（negotiation の property / regression テストを含む）。パッケージを跨ぐ公開 API の変更なので、`npm run type` と `npm run test:small` も実行する。
