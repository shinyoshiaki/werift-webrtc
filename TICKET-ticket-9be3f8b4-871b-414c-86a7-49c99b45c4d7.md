# [rtp][SRTP] NACK再送によるROCの誤更新で後続RTPの認証失敗が継続する

- 元報告: #764（Android libwebrtc 受信側で `auth_fail` が大量に発生し、映像が復旧しなかった）
- 関連: #94（過去の負 ROC 対策。`rolloverCounter--` 分岐の由来）
- 調査リビジョン: worktree `HEAD` = `c228aac1`（`develop` 系列。Issue 記載の `a81bf81de719` と対象コードは同一）
- 主な修正対象: `packages/rtp`（SRTP context）。結合テストは `packages/webrtc`
- 調査範囲: コードを読み、現行の ROC 更新条件を状態遷移シミュレーションで再現した。Android 実機や他の実装との E2E は実施していない。

---

## 1. 目的と背景

### 1.1 目的

SRTP の ROC（Rollover Counter）を「**各パケットに使う推定 ROC**」と「**SSRC ごとの最高 index（確定状態）**」に分ける。パケットの処理順（NACK 再送、ネットワーク上の順不同、重複）に左右されずに正しい ROC で暗号化・認証・復号できるようにする。一度 ROC がずれると、それ以降の全パケットで相手の認証が失敗し続ける。この状態を根本から解消する。

### 1.2 現状コード（調査結果）

| 箇所 | 現状 |
| --- | --- |
| `packages/rtp/src/srtp/context/context.ts:183-205` `updateRolloverCount()` | 今処理しているパケットの seq を、そのまま共有状態 `rolloverCounter` / `lastSequenceNumber` に書き込む。判定は「直前に処理した seq」との ±100（`MaxROCDisorder`）比較だけ。`seq === 0 && last > 100` なら無条件に `ROC++` する。`last < 100 && seq > 65435` なら `ROC--` する（#94 対策。0 未満にはしない）。 |
| `context.ts:157-167` `getSrtpSsrcState()` / `:233-238` `SrtpSsrcState` | `{ ssrc, rolloverCounter, lastSequenceNumber, rolloverHasProcessed? }`。`rolloverCounter` は「このパケット用」と「最新確定値」を兼ねている。 |
| `packages/rtp/src/srtp/context/srtp.ts:12-18` `encryptRtp()` | 毎回 `updateRolloverCount()` で共有状態を書き換え、その値で暗号化する。 |
| `srtp.ts:20-43` `decryptRtp()` | 状態をコピーして更新し、認証・復号に成功したときだけ書き戻す（#584 で導入した性質。維持する）。ただし推定ロジックが同じなので、順不同パケットで誤った値をコミットすることがある（後述 1.3-C）。 |
| `packages/rtp/src/srtp/cipher/ctr.ts:32-80`, `gcm.ts:30-60, 149-158` | ROC は引数で受け取る。`writeUInt32BE(roc)` を使うため、負値や 2^32 以上を渡すと例外になる。cipher 側の修正は不要。 |
| `packages/webrtc/src/media/rtpSender.ts:827-860` Generic NACK | `rtpCache` から元パケットを取り出し、`rtxPayloadType` があれば `wrapRtx`（別 SSRC・別 seq）で包む。**RTX がなければ元の SSRC/seq のまま** `dtlsTransport.sendRtp()` に渡す。 |
| `rtpSender.ts:89, 761` | `RTP_HISTORY_SIZE = 128`。cache は `seq % 128` で上書きされるので、**再送できるのは直近 128 パケット以内の seq だけ**。 |
| `packages/webrtc/src/transport/dtls.ts:462-482` `sendRtp()` | `this.srtp.encrypt()` を同期で呼ぶ。例外は catch してログに出し、`0` を返す。 |
| `dtls.ts:422-431` 受信 | `SrtpAuthenticationError` なら破棄。それ以外の例外は再 throw する。 |

`Context` 自体はパッケージの index から export されていない。ただし `SrtpSession.localContext/remoteContext` 経由で参照でき、`srtpSSRCStates` はテストからも参照されている（`srtp.test.ts:152-170`, `gcm.test.ts:174`）。

### 1.3 再現した不具合（現行の条件をそのまま JS で再現して確認）

| ID | 経路 | 入力列（同一 SSRC） | 結果 |
| --- | --- | --- | --- |
| A | 送信（Issue 記載） | `65534, 65535, 0..151, 再送0, 152` | 再送 0 と 152 が ROC=2 になる（正しくは 1）。**以後ずっと +1 ずれたまま**で、次の折り返し後も 3（正しくは 2）。 |
| A' | 送信（werift の実経路） | `65535, 0..120, 再送0, 121` | A と同じ。`RTP_HISTORY_SIZE=128` のため、werift の sender で実際に起こるのは **最後に送った seq が 101〜127 のときに seq 0 の NACK が来る**場合。 |
| B | 送信 | `65534, 65535, 0..99, 再送65535, 100` | 再送 65535 は ROC=0（正しい）。しかし直後の 100 以降が **ROC=0 のまま**になる（正しくは 1）。次の通常パケットが 100 未満なら `ROC++` で戻るので、ずれ続けるのは条件が狭いケースだけ。 |
| C | **受信**（werift 側の decrypt） | `65534, 0..99, 遅延65535, 100..` | 65535 が ROC=0 で認証に成功し、`last=65535, ROC=0` がコミットされる。後続の 100.. は ROC=0 で認証に失敗し、失敗はコミットされないため状態が戻らない。**以後永続的に受信不能**（シミュレーションでは 65,937 パケットすべて失敗）。RTX なし再送だけでなく、**通常のネットワーク上の順不同でも起こる**。 |
| C' | 受信 | `..., 0..120, 再送0, 121..` | 再送 0 だけ ROC=2 で認証に失敗して捨てられる（後続には影響しない）。 |

根本原因: RFC 3711 §3.3.1 / Appendix A は、パケットの index を「最高 index `s_l` から半周（`0x8000`）以内にある前周・現周・次周のどれか」として推定し、**新しいパケットのときだけ** `s_l`/ROC を進める。現行実装はこの区別をしておらず、直前に処理したパケットとの差分で共有 ROC を増減させている。

---

## 2. 実装すべき変更内容

### 2.1 `packages/rtp/src/srtp/context/context.ts`

1. **状態の意味を変える**: `SrtpSsrcState.rolloverCounter` / `lastSequenceNumber` は「これまで受け入れた最高 index の ROC / seq」（RFC の `ROC` / `s_l`）だけを表すようにする。互換性のためフィールド名は残す（テストや `SrtpSession` 経由の参照があるため）。初期化済みかどうかは `rolloverHasProcessed`（またはそれに相当するフラグ）で判定する。新しいフィールドを足す場合も `ssrc` は残す。
2. **推定する（副作用なし）**: `estimateRolloverCounter(sequenceNumber, state): number` などの純粋関数を追加する。RFC 3711 Appendix A の手順に従う:
   ```text
   未初期化            → v = 0
   s_l < 0x8000:  seq - s_l > 0x8000 ? v = ROC - 1 : v = ROC
   s_l >= 0x8000: s_l - 0x8000 > seq ? v = ROC + 1 : v = ROC
   ```
   - `v = ROC - 1` かつ `ROC == 0`（前周を指すが表現できない）: **v を 0 に丸め、最高 index は更新しない**。#94 の「負の ROC を cipher に渡さない」は維持する。
   - `v = ROC + 1` かつ `ROC == 0xFFFFFFFF`: これ以上表現できない（2^48 パケットに相当し、再鍵化が必要）。暗号化は `Error` で拒否する（`dtls.sendRtp` が catch する）。復号は `SrtpAuthenticationError` 相当で拒否し、受信経路をクラッシュさせない。
3. **確定する**: `commitPacketIndex(sequenceNumber, roc, state)` などで、拡張 index `roc * 0x10000 + seq`（最大 48bit なので `Number` で正確に扱える）が現在の最高 index より大きいとき、または未初期化のときだけ `rolloverCounter = roc`、`lastSequenceNumber = seq` に更新する。古いパケット・重複・丸めたパケットでは状態を変えない。
4. **既存 API の扱い**: `updateRolloverCount(seq, s)` は public メソッドなので、すぐには消さない。「推定してから確定し、**パケット ROC を戻り値で返す**」互換ラッパーにする（`@deprecated` を付けるのは任意）。新しいコードからは使わない。`MaxROCDisorder` は不要になれば削除する。

### 2.2 `packages/rtp/src/srtp/context/srtp.ts`

- `encryptRtp()`: `const roc = estimate(seq, s)` → `cipher.encryptRtp(header, payload, roc)` → `commit(seq, roc, s)` の順にする。暗号化に使うのは**必ず推定 ROC**。
- `decryptRtp()`: 既存の state（なければ一時的な初期 state）から ROC を推定して復号し、**認証・復号に成功した後でだけ** `commit` する。未知の SSRC で認証に失敗したときに state を作らない性質（`srtp.test.ts:220-231`, `gcm.test.ts:174`）を維持する。

### 2.3 `packages/webrtc`

- **本体コードの変更は原則不要**。RTX なしの再送は元の SSRC/seq のまま SRTP に渡り、rtp 層の修正で正しい ROC になる。`RTP_HISTORY_SIZE = 128` は半周 32768 よりずっと小さいので、再送パケットの推定 ROC は送信時の ROC と必ず一致する。
- `rtpSender` 側でパケットごとに ROC を cache する方法は取らない。rtp 層で直せば SRTP の利用者全体（受信側 C を含む）に効き、RFC にも合うため。

### 2.4 テスト

AGENTS.md に従い、Arrange / Act / Assert の 3 フェーズで書き、Act / Assert には日本語コメントを付ける。Arrange 用ユーティリティは共有ファイルに置く。

**`packages/rtp`**（共有 Arrange: `packages/rtp/tests/utils.ts` に、プロファイルを指定して SrtpContext の送受信ペアを作る helper と、seq 列を流して各パケットの ROC と状態を記録する helper を置く。`srtp.test.ts` の `buildTestContext` も移すかどうかを検討する）

- `tests/srtp/context/context.test.ts`: `TestRolloverCount*` を、推定 ROC と最高 index を分けて検証する表形式のテストに書き直す。
  - A: `65534, 65535, 0..151, 再送0, 152` → 再送 0 と 152 がどちらも ROC=1、最高 index は `(1, 152)`
  - B: `65534, 65535, 0..99, 再送65535, 100` → 再送は ROC=0、100 は ROC=1、最高 index は後退しない
  - 順不同・重複（例 `10, 12, 11, 11, 13`）で ROC と最高 index が変わらない／正しく進む
  - 初回 seq が高い場合（`65535 → 0` で ROC=1）と、初回 seq が 0 の場合（`0 → 65535` は 0 に丸めて未コミット、続く `1` は ROC=0）
  - 3 回以上の正常な折り返し（ROC 0→1→2→3）
  - 半周境界（差がちょうど `0x8000` と `0x8001`）の判定
  - ROC 上限（`ROC=0xFFFFFFFF, s_l=65535` に `seq=0`）で拒否される
  - **意味が変わる点**: 現行テスト `0 → 65535 → 1` は `1` で ROC=1 を期待しているが、新しい意味では ROC=0 になる。現行 `65530 → 0 → 65530` で「保存 ROC が 0 に戻る」とする期待も、「パケット ROC=0・保存 ROC=1 のまま」に変える。
- `tests/srtp/context/srtp.test.ts`（AES-128-CM/HMAC-SHA1）と `tests/srtp/cipher/gcm.test.ts`（AES-128-GCM）:
  - 送信 context で A/B の列を暗号化し、受信 context で全パケット（再送を含む）の復号に成功する
  - 受信側の順不同 C（`..0..99, 遅延65535, 100..`）で、遅延パケットと後続のどちらも復号できる
  - 改ざんした再送パケットは `SrtpAuthenticationError` になり、受信側の state（最高 index）が変わらない
  - 既存の RFC テストベクタ（`TestRTPLifecyleNewAlloc` など）が変わらず通る

**`packages/webrtc`**（共有 Arrange: `tests/fixture.ts`。`createConnectedRtpSender` に、`dtls.sendRtp` を実際の `SrtpSession` で暗号化し、鍵を入れ替えたペアの `SrtpSession` で復号するループバックを追加する。復号できたパケットと認証失敗を記録する）

- `tests/media/rtpSender.test.ts`:
  - RTX なし: 入力 seq を `65535, 0..120` で送る（初期 `seqOffset=0` なので出力 seq と同じ）→ `GenericNack(lost:[0])` → `121` を送る。再送 0 と 121 がどちらも受信側で認証・復号に成功する。
  - RTX あり（既存 `createConnectedRtpSender({ rtx: true })`）: RTX が別 SSRC/seq で送られ、メディア SSRC の後続パケットも復号できる（退行していないことの確認）。

### 2.5 ドキュメント

- 公開 API の形は変えない方針なので、README やサンプルの更新は不要の見込み。`updateRolloverCount` に deprecated を付ける場合は JSDoc に後継 API を書く。`packages/rtp` には `AGENTS.md` がない。scripts を変えない限り guide の更新は不要。

---

## 3. 技術的な実装アプローチ（調査まとめ）

- **RFC 3711 Appendix A の推定で送受信をそろえる**: libsrtp（Android/Chrome の libwebrtc）の受信側は `srtp_index_guess` で同じ半周基準の推定を行う。送信側も同じ規則で ROC を決めれば、相手の推定と必ず一致する。werift の sender は seq を連続させている（RTP continuity の実装）ので、送信 index は単調に増える。そのため半周以内の再送は送信時の ROC を正確に再現できる。
- **推定と確定を分けるインターフェース例**:
  ```ts
  // 副作用なし: このパケットに使う ROC
  estimateRolloverCounter(seq: number, s: SrtpSsrcState): number;
  // 新しい場合だけ最高 index を進める
  commitPacketIndex(seq: number, roc: number, s: SrtpSsrcState): void;
  ```
  `decryptRtp` は「推定 → 復号 → 成功したら commit」、`encryptRtp` は「推定 → 暗号化 → commit」にする。コピーした state を `Object.assign` する現在の方式は不要になる（新規 SSRC の state は成功後に作る）。
- **index の比較**: `roc * 65536 + seq` は 2^48 未満で `Number.MAX_SAFE_INTEGER` 内に収まる。BigInt は不要。
- **変更範囲**: `context.ts` と `srtp.ts` の 2 ファイル、および rtp/webrtc のテストと fixture。cipher（ctr/gcm）、SRTCP（`srtcpIndex` は別管理）、`rtpSender` 本体には触れない。

---

## 4. 制約・注意点

- **#584 の性質を維持する**: 認証に失敗したパケットで state を進めない。未知の SSRC について認証失敗で state を作らない。
- **#94 の性質を維持する**: cipher に負の ROC を渡さない（ROC=0 で前周と推定した場合は 0 に丸め、コミットしない）。
- **意味の変更（後方互換）**: `srtpSSRCStates[ssrc].rolloverCounter` が「最後に処理したパケットの ROC」から「最高 index の ROC」に変わる。外部から参照している利用者がいれば挙動が変わるので、PR に明記する。`updateRolloverCount` は互換ラッパーとして残す。
- **大きな seq ジャンプ**: 半周（32768）を超える前方へのジャンプは、RFC どおり「前周の古いパケット」と解釈される。現行の ±100 ヒューリスティックとは結果が変わる。受信側の libsrtp と同じ解釈なので相互運用上は正しい。werift の sender は seq を連続させるため、通常は発生しない。
- **ROC 上限**: 2^32-1 を超える前に SRTP の再鍵化が必要（RFC 3711 §9.2）。現実には到達しないが、`writeUInt32BE` の例外ではなく、明示的なエラーとして拒否する。
- **受信側の初期化**: 最初に受信したパケットを ROC=0 として初期化する。送信側の最初の数パケットが折り返しをまたいで失われた場合の救済は対象外（RFC の制約）。
- **並行性**: NACK ハンドラは `feedback.lost.forEach(async ...)` で `sendRtp` を並行に呼ぶが、`srtp.encrypt` は同期処理なので、推定と確定の間に別のパケットが割り込むことはない。
- **AGENTS.md の規約**: 根本原因を直し、テストを無効化しない。Arrange は共有 utility に置く。他リビジョンとの比較が必要なら別の worktree を使う（active worktree で checkout/stash しない）。
- **対象外**: RTX ネゴシエーション仕様の変更、RTCP NACK 生成アルゴリズムの変更、SRTP replay window の新規実装、Android 実機での E2E。

---

## 5. 完了条件

- [ ] `estimate`（副作用なし）と `commit`（新しい場合だけ更新）が分かれ、`encryptRtp` / `decryptRtp` が推定 ROC だけで暗号処理を行う。
- [ ] 再現 A（`65534 → 65535 → 0..151 → 再送0 → 152`）で、再送 0 と 152 がどちらも ROC=1 になり、最高 index が後退も二重加算もしない。
- [ ] 再現 B（折り返し後に `65535` を遅れて再送）で、再送は ROC=0、後続の通常送信は ROC=1 になる。
- [ ] 再現 C（受信側の順不同 `0..99 → 遅延65535 → 100..`）で、遅延パケットと後続のどちらも復号でき、受信が止まらない。
- [ ] 順不同、重複、初回 seq が高い場合、初回 seq が 0 の場合、3 回以上の折り返し、半周境界、ROC=0 での前周推定（丸めて未コミット）、ROC 上限での拒否をユニットテストで検証している。
- [ ] AES-128-CM/HMAC-SHA1 と AES-128-GCM の両方で、再送の前後で認証・復号に成功する。改ざんした再送では受信側の最高 index が変わらない。
- [ ] `context.test.ts` の従来テストを新しい意味（推定 ROC と最高 index の区別）に合わせて書き直し、変更理由をテスト名かコメントに書いている。
- [ ] `packages/webrtc` で、RTX なしの NACK 再送（実 SRTP ループバック）の後に後続パケットが復号できる。RTX ありも退行していない。
- [ ] 共有 Arrange（`packages/rtp/tests/utils.ts`, `packages/webrtc/tests/fixture.ts`）を使い、Act / Assert に日本語コメントがある。
- [ ] 検証: `cd packages/rtp && npm run type && npm test`、`cd packages/webrtc && npm run type && npm test`。最後に `npm run type` と `npm run test:small`。可能なら `npm run e2e` でブラウザとのメディア送受信に退行がないことも確認する。
