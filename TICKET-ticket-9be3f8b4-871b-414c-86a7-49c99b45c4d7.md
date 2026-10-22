## 概要

元報告: #764（本Issueは `develop` の実装を再確認し、原因・修正範囲・受け入れ条件を日本語で整理したもの）。

**RTXを使わず、元のSSRC/sequence numberでNACK再送する場合**、古いRTPパケットをSRTPで再暗号化すると、最新の送信ROC（Rollover Counter）が再送の順序に引きずられて誤更新されることがある。特にsequence number `0` の遅延再送でROCが二重加算されると、その後の通常送信まで誤ったROCで暗号化され、相手側で認証失敗が続いて映像が停止し得る。

元IssueではAndroid libwebrtc受信側で `auth_fail` 等が大量発生し、映像が復旧しなかったと報告されている。こちらで確認できたのは**現行コード上の欠陥とROC状態遷移の再現**であり、Android実機とのE2E再現は未実施。

- 確認ブランチ: `develop`
- 確認コミット: [`a81bf81de719`](https://github.com/shinyoshiaki/werift-webrtc/commit/a81bf81de719e881c0a96b2958bba2e1815e8e8d)
- 主な修正対象: `packages/rtp`（必要に応じて `packages/webrtc` のNACK経由の結合テストも追加）

## 原因（実装確認済み）

1. [`Context.updateRolloverCount()`](https://github.com/shinyoshiaki/werift-webrtc/blob/a81bf81de719e881c0a96b2958bba2e1815e8e8d/packages/rtp/src/srtp/context/context.ts#L183-L205) は暗号化対象パケットの到着順をそのまま共有状態 `rolloverCounter` / `lastSequenceNumber` に反映する。特に `sequenceNumber === 0 && lastSequenceNumber > 100` の場合、遅延再送でも `rolloverCounter++` してしまう。
2. [`SrtpContext.encryptRtp()`](https://github.com/shinyoshiaki/werift-webrtc/blob/a81bf81de719e881c0a96b2958bba2e1815e8e8d/packages/rtp/src/srtp/context/srtp.ts#L12-L17) が毎回この処理を呼び、更新された共有ROCで暗号化する。
3. [`RTCRtpSender` のGeneric NACK処理](https://github.com/shinyoshiaki/werift-webrtc/blob/a81bf81de719e881c0a96b2958bba2e1815e8e8d/packages/webrtc/src/media/rtpSender.ts#L763-L794) はキャッシュしたRTPを[`RTCDtlsTransport.sendRtp()`](https://github.com/shinyoshiaki/werift-webrtc/blob/a81bf81de719e881c0a96b2958bba2e1815e8e8d/packages/webrtc/src/transport/dtls.ts#L452-L467)経由で再送する。RTXペイロードタイプが利用可能な場合は別のRTX SSRC/sequence numberに包むが、**RTXを使わない場合は元のSSRC/sequence numberのまま**SRTPを再暗号化する。
4. 通常送信で一度越えたROC境界を、後続の古いパケットがもう一度越えたものとして扱う。また、折り返し直前の遅延再送ではROCを減らす分岐もあり、根本的には「対象パケット用の推定ROC」と「SSRCごとの最新確定ROC」が混在している。関連: #94（過去の負ROC対策）。

## 最小再現と期待値

同一SSRCで、送信側の `updateRolloverCount` に以下のsequence numberを順に渡す（`0` の最初の通常送信分は失われ、後にNACKで再送された想定）。

```text
通常送信:       65534, 65535, 0, 1, ..., 151
遅延NACK再送:                          0
次の通常送信:                           152
```

| 処理 | 正しいパケットROC | 現行コードのROC |
| --- | ---: | ---: |
| 通常送信 `65535` | 0 | 0 |
| 通常送信 `0` | 1 | 1 |
| 通常送信 `151` | 1 | 1 |
| **遅延再送 `0`** | **1** | **2** |
| **次の通常送信 `152`** | **1** | **2** |

現行のROC更新条件を使用した状態遷移で再現を確認。上記はコード単位の検証であり、リポジトリのテストスイートや受信機との通信を実行したという意味ではない。

## 修正方針

**パケットごとに使うROCの推定と、最新パケットの状態更新を分離する。** RFC 3711 [§3.3.1](https://www.rfc-editor.org/rfc/rfc3711.html#section-3.3.1) / Appendix A の半周（`0x8000`）を基準にしたパケットインデックス推定を参考にする。

1. SSRCごとに**最新の拡張パケットインデックス**を表す `highestSeq` と `highestRoc`（または同等の48bit index）を保持する。既存の `rolloverCounter` を「現在処理中のパケット用」と「最新確定値」の両方に使わない。
2. パケットの16bit `sequenceNumber` と最新の `highestSeq/highestRoc` から、そのパケットに適用する `packetRoc`（前周・現周・次周のいずれか）を算出する。暗号化／認証には**必ずこの `packetRoc`**を使う。
3. 推定した拡張index `packetRoc * 65536 + sequenceNumber` が既存の最高indexより**新しい場合にのみ**最新状態を進める。遅延再送／重複／順不同パケットでは最新状態を変更しない。初回パケットはROC 0で初期化し、初期sequence numberが0付近/65535付近のどちらでも扱えるようにする。
4. `decryptRtp()` でも同様に、パケット用ROCを推定して認証・復号し、**認証成功後にだけ**最新状態をコミットする。現行の[コピー状態→認証成功後に反映](https://github.com/shinyoshiaki/werift-webrtc/blob/a81bf81de719e881c0a96b2958bba2e1815e8e8d/packages/rtp/src/srtp/context/srtp.ts#L20-L41)という性質は維持する。認証失敗で状態が進む変更は不可。
5. ROC=0での前周推定は負値を暗号化器に渡さないよう扱いを定義し、符号なし32bitの範囲とSRTPの再鍵化上限を考慮する。元Issueのパッチ例をそのまま転記するのではなく、**推定ROCと確定ROCを別フィールド／戻り値で表現**する実装を推奨する。

## テスト／受け入れ条件

- [ ] 上記の `65534 → 65535 → 0..151 → 再送0 → 152` で、再送0と後続152の双方がROC=1となり、保持する最高indexが後退／二重加算されない。
- [ ] 折り返し**直前**の番号（例: `65535`）を折り返し後に遅延再送したときは、その再送にROC=0、後続の通常送信にROC=1を使用する。
- [ ] 通常の順不同・重複、初回sequence numberが高い場合、複数回の正常なロールオーバーを検証する。
- [ ] AES-128-CM/HMAC-SHA1とAES-128-GCMの双方で、再送前後のSRTP認証・復号が成功する。認証失敗時に受信側の最高indexが変化しない。
- [ ] `packages/rtp/tests/srtp/context/context.test.ts` の従来テストで仮定している「古いパケットを処理すると保存ROCが減る」という意味論を、新しい推定ROC／最新ROCの区別に合わせて見直す。
- [ ] `packages/webrtc` でRTXなしのNACK再送経路を1ケース検証し、RTXあり（別SSRC/sequence number）も退行しない。
- [ ] 既存のSRTPテストおよび通常のメディア送受信に退行がない。

### 対象外

RTXのネゴシエーション仕様変更、RTCP NACK生成アルゴリズムの変更、SRTP replay windowの新規実装はこのIssueの修正範囲に含めない。