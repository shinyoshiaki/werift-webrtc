# [WEBRTC] RTX with Simulcast not working

## 1. 目的と背景

- werift が **simulcast（RID ベース）の映像を受信する場合**、RTX（RFC 4588 の再送ストリーム）を negotiate しても再送パケットが処理されず、パケットロスから回復できない。
- RTX + NACK 自体は非 simulcast（SSRC ベース、`a=ssrc-group:FID`）では動いているが、simulcast では動かない。`router.ts` にも次のコメントが残っており、未対応であることが分かる。
  - `packages/webrtc/src/media/router.ts` の `registerRtpReceiverByRid()` に「サイマルキャスト利用時のRTXをサポートしていないのでcodecs/encodingsは常に一つ」とある
- `examples/mediachannel/rtx/simulcast_offer.ts` は `video/rtx` と `useRepairedRtpStreamId()` を negotiate する example だが、受信側の経路が対応していないため期待どおりに動かない。
- 目的は、ブラウザ（Chrome / Firefox）から送られる simulcast 映像を受信するとき、**レイヤーごとの RTX SSRC を正しく対応付け、再送パケットを元のレイヤーの track に復元して届けること**と、**NACK をレイヤーごとに正しく送ること**。

## 2. 現状の問題点（コード調査結果）

### 2.1 RTX パケットのルーティングで破棄される（`media/router.ts` `routeRtp`）

simulcast 送信時、ブラウザはレイヤーごとに RTX 用の別 SSRC を使う。RTX パケットには `rtp-stream-id`（rid）ではなく
`urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id`（rrid）拡張が付く。SDP 側には `a=ssrc` / `a=ssrc-group:FID` がない（Chrome の場合）。

`routeRtp` の分岐は次のとおり。

1. `rid` 拡張がある → `ridTable[rid]` → `handleRtpByRid`（**RTX には rid がないのでここに入らない**）
2. `ssrcTable[ssrc]` がある → `handleRtpBySsrc`（**RTX SSRC は登録されていない**）
3. フォールバック: `ridTable` 内の receiver で `trackBySSRC[ssrc]` を探す（**RTX SSRC は `trackBySSRC` にない**）
4. 見つからない → `// bug` で黙って破棄

`repairedRid` は破棄された後に `rtpReceiver.latestRepairedRid` へ保存されるだけで、ルーティングには使われていない。

### 2.2 RTX SSRC と元の媒体 SSRC の対応表がない（`media/rtpReceiver.ts`）

- `handleRTP()` の RTX 復元処理は `ssrcByRtx[rtxSsrc] -> originalSsrc` に依存している。
- `ssrcByRtx` は `prepareReceive()` で `encodings[].rtx.ssrc` から作られる。`transceiverManager.getRemoteRtpParams()` は `media.ssrc.length === 2` のときだけ RTX を設定するため、simulcast では対応表が空になる。
- 仮に RTX パケットが届いても `originalSsrc` が `undefined` になる。その結果 `unwrapRtx(packet, apt, undefined)` で壊れたパケットが生成され、`track = trackBySSRC[undefined]` でも track が見つからない。
- 媒体 SSRC と track の対応（`trackBySSRC`）は、`handleRtpByRid()` が最初の rid 付きパケットを受けた時点で後から学習している。RTX SSRC も同じように後から学習する必要がある。

### 2.3 NACK ハンドラが receiver 単位で 1 つしかない（`media/receiver/nack.ts`）

- `NackHandler` は receiver ごとに 1 インスタンスで、状態として `mediaSourceSsrc` と `newEstSeqNum` を 1 つずつしか持たない。
- simulcast では複数レイヤー（SSRC）のパケットが交互に `addPacket()` されるため、次の問題が起きる。
  - 別 SSRC のシーケンス番号を比較して、**ロスを誤検出する**（偽の大量 NACK）
  - `mediaSourceSsrc` が最後に受けたパケットの SSRC で上書きされ、**NACK の宛先 SSRC がずれる**
  - RTX から復元したパケットで `removeLost()` しても、別レイヤーの状態と混ざって正しく解消されない
- 結果として、RTX が届いても NACK・再送ループが正しく回らない。

### 2.4 その他の関連箇所

- `router.ts` `registerRtpReceiverByRid()`: `params.codecs[0]` を固定で track の codec にしている。RTX/RED が先頭に来る場合を考慮していない（`registerRtpReceiverBySsrc` と同様に `deliveredTrackCodec()` を使うべき）。
- `router.ts` `routeRtcp()` に `// todo simulcast` がある。SR は `ssrcTable` を引くが、rid 経由で学習した SSRC は `ssrcTable` に登録されないため、SR が receiver に届かない場合がある（2.1 の修正と同時に整合を取る）。
- `RTCRtpReceiver.getStats()` の inbound-rtp は `remoteStreams[ssrc]` を SSRC ごとに保持している。RTX SSRC 分が独立した inbound-rtp として出ないように（または仕様どおり retransmitted 系の値に集計されるように）扱いを確認する。

## 3. 実装すべき変更内容

### 3.1 受信ルーティング（`packages/webrtc/src/media/router.ts`）

- `routeRtp` で `repaired-rtp-stream-id`（`RTP_EXTENSION_URI.repairedRtpStreamId`）を解決する。rrid が `ridTable` に存在すれば次の処理を行う。
  - RTX SSRC を `ssrcTable` に登録する（以降 rrid 拡張が付かなくなっても SSRC で引ける）
  - receiver に「RTX SSRC → rrid（→ 対応レイヤーの媒体 SSRC）」を学習させる
  - receiver の RTX 受信ハンドラへ渡す
- rid / rrid 拡張は、ブラウザが RTCP RR を受けた後に省略されることがある（既存コメント「simulcast after send receiver report」）。そのため、**最初の rid / rrid 付きパケットで SSRC を `ssrcTable` に登録する**ように変更し、フォールバック探索（`// bug` 分岐）に依存しないようにする。
- `registerRtpReceiverByRid()` の track codec 決定で `deliveredTrackCodec()` を使い、RTX/RED を除外する。古いコメントも更新する。

### 3.2 受信処理（`packages/webrtc/src/media/rtpReceiver.ts`）

- RID ベースの RTX 対応表を追加する。例:
  - `rtxSsrcByRid` / `ssrcByRid`（rid → 媒体 SSRC、`handleRtpByRid` で学習）
  - rrid 付き RTX 受信時に `ssrcByRtx[rtxSsrc] = ssrcByRid[rrid]` を登録する
- 媒体 SSRC がまだ学習されていない段階で rrid 付き RTX が届いた場合の扱いを決める（破棄、または rid 学習後に解決）。
- `handleRTP()` の RTX 分岐で `originalSsrc` が未解決ならパケットを破棄する（壊れたパケットを流さない）。`rtxCodec` が見つからない場合のガードも追加する。
- `resyncCodecs()` で `ssrcByRtx` をクリアすると、学習済みの RID 由来 RTX 対応も消える。再交渉時に RID 由来の対応を保持するか再学習させるか、方針を明確にする。

### 3.3 NACK（`packages/webrtc/src/media/receiver/nack.ts`）

- `NackHandler` の状態（`newEstSeqNum`, `_lost`, `mediaSourceSsrc`）を **媒体 SSRC 単位**に分離する。receiver 内で `Map<ssrc, NackHandler>` を持つか、`NackHandler` 内で SSRC ごとの状態を持つ。
- `onPacketLost` イベントと `nackCountBySsrc` 統計の互換性を維持する（`receiver.onPacketLost` は public）。
- `close()` で SSRC ごとのタイマーをすべて停止する（memleak に注意）。

### 3.4 Example / ドキュメント

- `examples/mediachannel/rtx/simulcast_offer.ts` と `simulcast_answer.html` で、RTX 付き simulcast が実際に動くことを確認する。必要なら修正する。
- 公開挙動が変わるため、関連 docs / changelog を更新する（`changelog.md`）。

## 4. 技術的アプローチ（推奨）

1. **unit テストで再現する**（`packages/webrtc/tests/media/router.test.ts` / `rtpReceiver.test.ts`）
   - Arrange: 「simulcast recv transceiver（rid: high/low）+ VP8 + RTX codec + rid/rrid 拡張」を作る helper を共通 Arrange utility に切り出す（AGENTS.md の方針。既存の `tests/utils.ts` または `tests/fixture.ts` など 1 ファイルに集約）。
   - Act: rid 付き媒体パケット → rrid 付き RTX パケット（`wrapRtx` で生成）の順に `routeRtp` する。
   - Assert: 復元後のパケットが該当 rid の track の `onReceiveRtp` に、元の SSRC・シーケンス番号・PT で届くことを確認する。
2. router / receiver の修正（3.1, 3.2）。
3. NACK の SSRC 分離（3.3）。2 レイヤーのパケットを交互に投入しても偽ロスが出ないこと、ロス時に正しい `mediaSourceSsrc` の NACK が出ることを `tests/media/nack.test.ts` で検証する。
4. RTX 拡張の解決には既存の `rtpHeaderExtensionsParser` と `RTP_EXTENSION_URI.repairedRtpStreamId` をそのまま使う（`rtp` パッケージの変更は原則不要）。`unwrapRtx` / `wrapRtx` は `packages/rtp` の既存実装を使う。
5. 可能であれば e2e（`e2e/server/handler/mediachannel/simulcast.ts`）に RTX + rrid を negotiate するシナリオを追加し、Chromium から simulcast を受信して track が届くことを確認する。

## 5. 制約・注意点

- **後方互換**: 非 simulcast（SSRC ベース、`ssrc-group:FID`）の RTX 経路と既存の simulcast（RTX なし）経路を回帰させない。
- **rid 拡張の省略**: Chrome は RR 受信後に rid / rrid / mid 拡張を付けなくなることがある。SSRC の学習は最初の拡張付きパケットで確実に行う。
- **rrid 拡張が negotiate されていない場合**: RTX SSRC を rid と対応付けられない。その場合は無理に推測せずに破棄し、ログを出す。必要なら answer 側で RTX と rrid を整合させる方針を検討する（RTX を残しつつ rrid を外す answer は不整合になるため）。
- **Firefox**: simulcast でも `a=ssrc` 行を出す場合がある。`getRemoteRtpParams()` の `media.ssrc.length === 2` 前提とも衝突しないか確認する。
- **TWCC**: `handleRTP` は RTX パケットでも TWCC を処理している（transport-wide なので問題ない）。`setupTWCC(packet.header.ssrc)` が最初に届いた SSRC（RTX の可能性あり）で初期化される点は確認する。
- **RTCP**: RTX SSRC を `ssrcTable` に登録すると、RR / SR のルーティングにも影響する。`routeRtcp` の挙動を確認する。
- **memleak**: SSRC ごとの NACK タイマー・対応表を増やすため、`stop()` / `unregisterTransceiver()` で確実に解放する。
- **既存パターン**: 通知は独自の `Event` クラスを使う。広範な catch-and-ignore は使わない。テストは Arrange / Act / Assert の 3 フェーズで書き、Act / Assert に日本語コメントを付ける。
- WPT 専用の厳格挙動は `tools/wpt-runner/*` に閉じ込め、`src` に漏らさない。
- **保証範囲（追加要件、§8 参照）**:
  - SDP に RTX の対応（`ssrc-group:FID`）がない RTX は、RID の**現在の**媒体 SSRC で NACK が検出した欠落に応えるものだけを復元する。
  - 再交渉なしの媒体 SSRC 変更は、その RID の復元状態のリセットとして扱う。旧 SSRC の NACK 要求・欠落の台帳・RTX の対応を同時に捨て、旧媒体 SSRC と旧媒体を修復した RTX SSRC の遅着パケットは破棄する（判別できないパケットの破棄は妥当とする）。
  - seq と timestamp の基点が同じストリーム（RFC 3550 §5.1 違反）は判別の対象外とする。

## 6. 完了条件

- [ ] rrid 付き RTX パケットが該当 rid の track に、**元の SSRC / シーケンス番号 / payloadType に復元されて**届く（unit テストあり）
- [ ] rid / rrid 拡張が省略された後続パケット（媒体・RTX とも）も、正しい track / RTX 復元経路に届く（unit テストあり）
- [ ] 媒体 SSRC 未学習、rrid 未知、apt codec 不在の RTX パケットが、例外や壊れたパケットを流さずに破棄される
- [ ] NACK が媒体 SSRC ごとに独立して管理され、複数レイヤーを同時に受信しても偽ロスや宛先 SSRC の誤りが発生しない（`nack.test.ts` に追加）
- [ ] `registerRtpReceiverByRid()` で生成される track の codec が RTX/RED ではなく媒体 codec になる。古い「RTX 未サポート」コメントを削除・更新する
- [ ] 既存の非 simulcast RTX と RTX なし simulcast のテストが通る
- [ ] `examples/mediachannel/rtx/simulcast_offer.ts` で Chrome から RTX 付き simulcast を受信・中継できることを手動確認する（可能なら e2e シナリオを追加し `npm run e2e` で確認）
- [ ] `cd packages/webrtc && npm run type && npm test` が通る。public な受信挙動の変更なので、`npm run type` と `npm run test:small` も通す
- [ ] 必要に応じて `cd packages/webrtc && npm run memleak` でリークがないことを確認する（ローカル、Node 24+）
- [ ] `changelog.md` など関連ドキュメントを更新する
- [ ] NACK の要求と RTX の検証が同じ欠落の台帳を使い、「NACK が (媒体 SSRC, seq) を要求している間は、その RTX を検証できる」ことを unit テストで確認する（欠落後に後続 1024 個以上を受信してから届く RTX を含む）
- [ ] 同じ RID で同時に扱う媒体 SSRC は 1 つで、SSRC 変更時に旧 SSRC の NACK・台帳・RTX 対応が同時に解放されることをテストで確認する
- [ ] property テストの復元の判定基準が `receiver.nack` の要求リストであり、生成器が §8 のケースを含む
- [ ] 修正報告に、すべての保持上限と「なぜ NACK の要求を途中で切らないか」の一覧を載せる

## 7. 主な関連ファイル

| ファイル | 内容 |
| --- | --- |
| `packages/webrtc/src/media/router.ts` | `routeRtp` / `registerRtpReceiverByRid` / `routeRtcp` |
| `packages/webrtc/src/media/rtpReceiver.ts` | `handleRtpByRid` / `handleRTP`（RTX 復元）/ `ssrcByRtx` / `resyncCodecs` |
| `packages/webrtc/src/media/receiver/nack.ts` | `NackHandler`（SSRC 単位への分離） |
| `packages/webrtc/src/transceiverManager.ts` | `getRemoteRtpParams`（RTX encodings 生成）、simulcast receiver 登録 |
| `packages/webrtc/tests/media/router.test.ts`, `rtpReceiver.test.ts`, `nack.test.ts` | 追加テスト |
| `examples/mediachannel/rtx/simulcast_offer.ts`, `simulcast_answer.html` | 動作確認用 example |
| `e2e/server/handler/mediachannel/simulcast.ts`, `e2e/tests/mediachannel/simulcast.test.ts` | e2e（RTX シナリオ追加候補） |

## 8. 追加要件（レビュー 9 以降の打開策）

レビューが通らなかった根本原因は、「NACK がまだ再送を要求している」状態と「届いた RTX を復元できる」状態が、別々の上限で別々に保持・破棄されていたことにある。個々の上限を直すのではなく、両者の状態をそろえる構造に変える。

1. **要求と復元の状態をひとつにそろえる。**
   - 欠落の台帳を NACK の欠落検出と同じ場所（`media/receiver/nack.ts`）で作る。欠落ごとに番号と前後の受信パケットの timestamp を記録する。
   - 台帳の保持範囲は NACK の要求範囲以上にする（seq の距離の上限は 0x8000）。台帳から欠落を捨てるときは、必ず NACK の要求も同時に止める。
   - 守る性質: 「NACK が (SSRC, seq) を要求している間は、その RTX を検証できる」。受信済みパケットのリング、窓 1024、隙間の記録、`firstExt` のような独立した境目は持たない。
2. **同じ RID で同時に扱う媒体 SSRC を 1 つにする。**
   - 再交渉なしで媒体 SSRC が変わったら、ストリームのリセットとして扱い、旧 SSRC の NACK、欠落の台帳、RTX の対応を同時に捨てる。
   - 切り替えの途中で届いた旧 SSRC の RTX は破棄する。
   - RID ごとに複数の媒体 SSRC を持つリストと、複数候補の判定は持たない。
3. **保証範囲を §5 に明記する**（§5「保証範囲」）。
4. **テストの判定基準を NACK に変える。**
   - property テストの復元の判定基準を、実装を写した判定（`repairable`）から `receiver.nack` の要求リストに変える。
   - 生成器に次のケースを加える: 後続 1024 個以上の受信後に届く RTX、5 回以上の SSRC 切り替えと遅れて届く RTX、seq と timestamp の基点が同じストリーム（この場合は誤った SSRC に配信しないことだけを確認し、パケット単体で判別できない到着は対象外とする）。
5. **修正報告に上限の一覧を載せる。** すべての保持上限について、なぜ NACK の要求を途中で切らないか（または、切るときは台帳も同時に捨てるか）を表にする。