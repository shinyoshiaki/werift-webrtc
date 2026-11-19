---
ide:
  viewer: review-document
  version: 1
  title: "#815 DataChannel Stream ID を DTLS role で決める"
  dock: right
  baseCommit: 8f91dfff24dec99d3cf1c28173eb2faa76fe0bb1
---
# #815 DataChannel の Stream ID を DTLS role で決める変更のレビュー

## 1. 概要

DataChannel の Stream ID の偶奇を、ICE role ではなく **DTLS role**（RFC 8832 §6: client が偶数、server が奇数）で決めるようにしました。あわせて、ID を確定する時期を「SCTP が ESTABLISHED になった後」から「DTLS role が決まった時点」へ前倒ししました（W3C webrtc-pc 4.4.1.6 step 2.2.6）。`setLocalDescription` / `setRemoteDescription` の Promise が resolve する時点で `channel.id` が見えます。

副作用として、in-band チャネル（`negotiated` が `true` でない）の `createDataChannel(label, { id })` は `id` を無視します。固定 ID が必要なら `negotiated: true` を使います。これは `changelog.md` に記載済みです。

## 2. 修正前の問題と修正後の流れ

<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px">
<div style="border:2px solid #c0392b;border-radius:8px;padding:10px">
<b style="color:#c0392b">Before（問題あり）</b>
<ol>
<li><code>createDataChannel()</code>: <code>id</code> は <code>undefined</code></li>
<li>answer 適用（<code>a=setup:passive</code> など）。DTLS role が確定</li>
<li><span style="color:#c0392b">ここでは採番しない。Promise が resolve しても <code>id</code> は <code>undefined</code></span></li>
<li>SCTP が ESTABLISHED になる</li>
<li><code>dataChannelFlush()</code> が <span style="color:#c0392b">ICE role（<code>isServer ? 0 : 1</code>）</span>で採番して OPEN を送る</li>
<li><span style="color:#c0392b">ICE role と DTLS role の対応が逆だと偶奇が相手と衝突</span>。衝突した OPEN は黙って ACK される</li>
</ol>
</div>
<div style="border:2px solid #27ae60;border-radius:8px;padding:10px">
<b style="color:#27ae60">After（修正後）</b>
<ol>
<li><code>createDataChannel()</code>: <code>id</code> は <code>undefined</code>。<code>unannounced</code> に積む</li>
<li>answer 適用で <code>dtlsTransport.role</code> が確定</li>
<li><span style="color:#27ae60"><code>onRoleChange</code> / <code>assignDataChannelIds()</code> → <code>assignPendingStreamIds()</code> が DTLS role の偶奇で最小の空き ID を予約</span>。Promise が resolve する前に <code>id</code> が見える</li>
<li>SCTP が ESTABLISHED になる</li>
<li><code>dataChannelFlush()</code> は<span style="color:#27ae60">送信専用</span>。予約済みの ID で OPEN を送る</li>
<li>自分の偶奇の ID への OPEN は ACK せず stream reset で拒否する</li>
</ol>
</div>
</div>

*凡例: 赤は問題のある箇所、緑は変更した箇所。どちらも「role が決まる → ID が決まる → OPEN を送る」を同じ順に並べています。*

## 3. 主要変更

### 3.1 DTLS role の変更通知

[packages/webrtc/src/transport/dtls.ts:282](review-diff:packages/webrtc/src/transport/dtls.ts:282) で `role` を getter / setter にしました。値が変わると、[packages/webrtc/src/transport/dtls.ts:186](review-file:packages/webrtc/src/transport/dtls.ts:186) の `onRoleChange` が同期的に発火します。リスナーの例外は握りつぶさず `executeIsolated` でログに残します。リモート answer、ローカル answer、`start()` が `auto` を解決する場合のどれでも、role を書く箇所は変えずに通知できます。

### 3.2 ID の予約と送信の分離（中核）

[packages/webrtc/src/transport/sctp.ts:388](review-diff:packages/webrtc/src/transport/sctp.ts:388) の `idParity` が、`client` は 0、`server` は 1、`auto` は未定を返します。

- [packages/webrtc/src/transport/sctp.ts:427](review-diff:packages/webrtc/src/transport/sctp.ts:427) の `assignPendingStreamIds()`: `unannounced`（OPEN 未送信）のチャネルへ ID を予約します。
- [packages/webrtc/src/transport/sctp.ts:413](review-file:packages/webrtc/src/transport/sctp.ts:413) の `allocateStreamId()`: 同じ偶奇の最小の空き ID を選びます。登録済みの negotiated / remote / 予約済みを飛ばすので、close 後の ID 再利用も効きます。上限は `0..65534` と、SCTP が交渉した `maxChannels` の小さい方です。空きがなければチャネルを `closed` にし、`error`（`OperationError`）と `close` を発火します（[packages/webrtc/src/dataChannel.ts:147](review-diff:packages/webrtc/src/dataChannel.ts:147) の `failWithError`）。
- [packages/webrtc/src/transport/sctp.ts:268](review-diff:packages/webrtc/src/transport/sctp.ts:268): `onRoleChange` を購読し、予約を解放して取り直します。
- [packages/webrtc/src/transport/sctp.ts:754](review-diff:packages/webrtc/src/transport/sctp.ts:754) の `dataChannelFlush()`: 採番をやめ、ID のないチャネルは待機キューに残します。
- [packages/webrtc/src/transport/sctp.ts:473](review-file:packages/webrtc/src/transport/sctp.ts:473) の `releaseUnannouncedStreamIds()`: rollback や association リセットで、OPEN 未送信の予約を返します。

### 3.3 description 適用時の採番

[packages/webrtc/src/peerConnection.ts:916](review-diff:packages/webrtc/src/peerConnection.ts:916) の `assignDataChannelIds()` を、ローカル適用（[packages/webrtc/src/peerConnection.ts:1685](review-file:packages/webrtc/src/peerConnection.ts:1685)）とリモート適用（[packages/webrtc/src/peerConnection.ts:2130](review-file:packages/webrtc/src/peerConnection.ts:2130)）で呼びます。rollback 後に role が維持されたままのときは `onRoleChange` が発火しないため、この呼び出しで補います。

### 3.4 in-band の `id` 無視

[packages/webrtc/src/sctpManager.ts:153](review-diff:packages/webrtc/src/sctpManager.ts:153) で、`negotiated` が `true` でないとき `id` を捨てて debug ログを 1 行残します。throw も警告もしません（W3C とブラウザの挙動に合わせています）。

### 3.5 衝突する OPEN の拒否

- [packages/webrtc/src/transport/sctp.ts:510](review-diff:packages/webrtc/src/transport/sctp.ts:510): ローカルが使用中の streamId への OPEN は ACK せず、そのチャネルを閉じます。
- [packages/webrtc/src/transport/sctp.ts:520](review-diff:packages/webrtc/src/transport/sctp.ts:520): ローカル未使用でも、自分の DTLS role の偶奇の streamId への OPEN は、相手の偶奇違反として stream reset で閉じます。

### 3.6 stream reset の方向管理（RFC 8831 §6.7）

reset の方向（`outgoing` / `incoming`）を [packages/sctp/src/sctp.ts:135](review-diff:packages/sctp/src/sctp.ts:135) の `onReconfigStreams` で渡し、[packages/webrtc/src/transport/sctp.ts:294](review-diff:packages/webrtc/src/transport/sctp.ts:294) の `onStreamsReset` が両方向の reset がそろうまで ID を保持します。ID を再利用したチャネルが、古いチャネルへの reset を受けないようにするためです。

直近のレビュー指摘（チケット 9.5）への対応として、旧 werift 相手で reset が `reverseResetTimeout`（5 秒）内に来ない場合、その stream を [packages/webrtc/src/transport/sctp.ts:110](review-diff:packages/webrtc/src/transport/sctp.ts:110) の `awaitingPeerReset` に入れ、reset が来るまで再利用しません。

### 3.7 周辺の堅牢化

次の変更は、ID の採番変更に付随して入っています。差分が大きい要因なので、重点を置く範囲を決める参考にしてください。

- リスナー例外の隔離（`executeIsolated` / `notifySafely`）: `dataChannel.ts`、`peerConnection.ts`、`sctpManager.ts` の各所
- `RTCPeerConnection.close()` が未採番チャネルも閉じる（[packages/webrtc/src/transport/sctp.ts:902](review-diff:packages/webrtc/src/transport/sctp.ts:902) の `closeUnannouncedChannels`）
- closing 中のメッセージ破棄、未知 stream への ACK の無視（例外を投げない）、`createDataChannel` が close 後に `assertNotClosed` で失敗する

## 4. 判断理由

| 論点 | 採用 | 採らなかった案 |
| --- | --- | --- |
| 偶奇の根拠 | DTLS role（RFC 8832） | ICE role の推定。`a=setup` を明示すると逆転する |
| 採番時期 | role 確定時（W3C 4.4.1.6） | ESTABLISHED 後。answer 適用直後に `id` が見えない |
| role の通知 | `RTCDtlsTransport.onRoleChange` | role を書く 3 箇所（remote answer、local answer、DTLS start）に呼び出しを散らす案 |
| in-band の `id` | 無視。WPT 専用 shim は不要 | 受け入れる。相手の ID と衝突しうる |
| ID の選び方 | 最小の空き ID | 単調増加。close 後の再利用が崩れる |
| `SCTP.isServer`（INIT 側の決定） | ICE role のまま。ID の偶奇と切り離した | DTLS role に合わせる。影響範囲が広い |

## 5. レビュアーが確認すべき点・リスク

- **互換性**: in-band で `id` を渡している既存利用者は、ID が自動採番に変わります。`changelog.md` に移行手順（`negotiated: true`）があります。`RTCDataChannel` を直接構築する内部 API は対象外です。
- **API の変更**: `RTCDtlsTransport.role` は getter / setter になり、`onRoleChange` が増えました。`SCTP.onReconfigStreams` は第 2 引数に方向が付き、`isOutgoingResetPending` が増えました（`packages/sctp` は再利用可能な層なので、公開 API として扱ってよいか確認してください）。
- **旧 werift 相手**: ordered データを送っていない stream では、reset が返らず ID が association の終了まで使えません。in-band は別の ID が割り当たり、negotiated で同じ ID を作ると `OperationError` になります。これは意図した代償です。
- **rollback**: 予約済みで OPEN 未送信の ID を `id = undefined` に戻します。rollback 後に同じ role が維持された場合の再採番は `assignDataChannelIds()` が担います。
- **diff の規模**: ticket 範囲の差分は `packages/` で 11 ファイル、約 2,500 行の追加です。半分以上はテスト（`tests/issue/815.*`）です。
- **docs**: `doc/` と `packages/*/doc` の再生成、README の更新は、この差分には含まれていません。公開 API の変更に当たるか、確認してください。
- **未確認**: `RTCDataChannel-close.html` は PASS 2 / FAIL 9 / TIMEOUT 1 で、baseline の範囲内です。

## 6. 検証結果

私はこの文書の作成時に次を実行しました。

- `cd packages/webrtc && npx vitest run tests/issue/815`: 3 ファイル・74 件がすべて通過（HEAD `f15b64744`）。

以下はチケットファイル（9.4 と 9.5）に実装者が記録した結果で、私は再実行していません。

- `npm run type`: 通過
- `npm run test:small`: 全パッケージ通過（sctp 389 件、webrtc 2,198 件通過、5 件スキップ）
- `npm run pbt:deep`: fuzz / scenario / model はすべて通過。leak は heap seed 2 と 4 だけが失敗しますが、develop でも同じ水準で失敗する既知の問題です。
- `npm run wpt`: 10 回実行して回帰 0 件。`RTCDataChannel-id` は毎回 5/5 PASS。baseline は変更していません。
- `npm run e2e`: 26 ファイル・75 件が通過
- 未実施: Firefox E2E（`npm run firefox:record`）。
