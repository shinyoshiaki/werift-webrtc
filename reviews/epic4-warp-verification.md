---
ide:
  viewer: review-document
  version: 1
  title: "Epic 4: WARP 対応 WebRTC の検証記録（interop / E2E / 要件とテストの対応）"
  dock: right
  baseCommit: 6b2e88a5d8da5f6f42639ceb2920172f7f8062ec
---
# Epic 4: WARP 対応 WebRTC の検証記録

設計書 [epic4-warp-webrtc-detailed.md](review-file:epic4-warp-webrtc-detailed.md:1) の §29–32（stats）、§40–50（テスト・相互接続）、§53（完了条件）について、実行した検証と、要件ごとのテストの対応をまとめます。対象は `6b2e88a5` に、認証後の SCTP 開始を SPED restart から守る修正（§8）を加えた作業ツリーです。

## 0. 実行環境（2026-10-10）

| 項目 | 値 |
|---|---|
| OS | Linux 7.0.0-34-generic |
| Node.js | v24.18.0 |
| OpenSSL | 3.5.5（27 Jan 2026） |
| Docker | 29.2.1 |
| Go | ホストには無し。Pion harness は `golang:1.24` コンテナでビルド |
| Chromium | Playwright 同梱 chromium-1193（Chrome 140） |
| BoringSSL | `packages/dtls/tests/e2e/boringssl/Dockerfile` の pin revision |

## 1. `client_dual_openssl` 失敗の原因と修正（§49）

**結論: OpenSSL 3.5 の挙動でも、werift の DTLS 1.2 互換性の問題でもありません。テストが固定 UDP ポートを使っていたことが原因です。**

- 失敗していたのは `werift 1.2 client EXTRACTOR-dtls_srtp still works with openssl` です。このテストは `openssl s_server` を `127.0.0.1:55562` の固定ポートで起動していました。
- 調査時、`55562/udp` は別 worktree（`0ad06d37…`）の node プロセスが `*:55562` で使用中でした。そのため OpenSSL は bind に失敗し、テストは handshake のタイムアウトとしてしか失敗を表に出していませんでした。
- 55561 / 55562 / 55555 / 55559 はいずれも Linux の ephemeral port 範囲（`32768–60999`）の中です。無関係なプロセスにランダムに割り当てられ得るので、`warp` でも同じ条件で失敗します。
- 同じ引数（`-dtls1_2 -use_srtp SRTP_AES128_CM_SHA1_80`）で空きポートを使うと、OpenSSL 3.5.5 との handshake は成功しました。OpenSSL 側にも `SRTP Extension negotiated, profile=SRTP_AES128_CM_SHA1_80` と表示され、exporter は 60 byte を返しています。

**修正**

- `packages/dtls/tests/fixture.ts` に共通の Arrange `spawnOpensslDtls12Server()` を追加しました。
  - OS に空きポートを割り当てさせます。
  - 固定 sleep の代わりに OpenSSL の `ACCEPT` 出力を待ちます。
  - 起動に失敗したら、OpenSSL の stderr を含むエラーで失敗させます（最大 3 回まで再試行）。
- 固定ポートを使っていた OpenSSL のテスト 3 ファイル（`client_dual_openssl` / `client` / `certificate_request/client`）をこの helper に移しました。
- `55562` を別プロセスが使用中のまま、3 ファイル・5 テストが 3 回連続で成功しました。

## 2. 外部相互接続と E2E の実行結果（§42–50, §53）

| §53 の項目 | 実行したコマンド | 結果 |
|---|---|---|
| BoringSSL interop（§48） | `cd packages/dtls && npm run test:boringssl:docker` | 5/5 成功（werift client ↔ BoringSSL server と BoringSSL client ↔ werift server の双方向データ、harness・pin の確認） |
| Pion SPED（§47） | `WERIFT_PION_SPED=<built> npm run test:pion-sped`（packages/ice） | 5/5 成功 |
| Pion ICE agent fallback（§47） | `WERIFT_PION_ICE_AGENT=<built> npm run test:pion-ice-agent`（packages/webrtc） | 1/1 成功（非 SPED の Pion に対して同じ flight で direct fallback） |
| 通常 TURN の非回帰（§46） | `npm run test:pion-turn`（packages/ice、Docker の Pion TURN） | relay 系 3/3 成功（UDP relay の ICE、ChannelData の UDP/TCP） |
| 通常 TURN（Chromium） | `examples/turn-loopback`: `npm run chrome-e2e` | 2 files / 3 tests 成功 |
| Chromium regression（§50） | `npm run install:browsers` → `npm run e2e` | 一般 E2E 19 files / 46 tests、DTLS 1.2 モード 12、DTLS 1.3 モード 12 がすべて成功 |
| OpenSSL 1.2 compatibility（§49） | `packages/dtls` の `npm test` | 上記の修正後、`client_dual_openssl` を含めて成功 |
| mediasoup interop（参考） | `integration/werift-mediasoup-interop`: `npm test` / `npm run test:browser` | 7 + 16 / 8 成功 |

- 一般 E2E の 19 files の内訳は bundle 3、combination 1、datachannel 5（close / datachannel / iceLite / iceTcp / turnRelay）、ice 2（restart / trickle）、mediachannel 8 です。
- DTLS 1.2 / 1.3 モードはそれぞれ `tests/dtls/{datachannel,fingerprint,media}.test.ts` を実行しています。
- SRTP の replay 対策（§4）を入れた後に、`npm run e2e` と mediasoup interop を再実行し、同じ結果を確認しました。

**未実施・範囲外**

- Pion 同士の full SPED orchestration（controlling/controlled、Full/Lite、SPED 上の restart）。設計書 §47 とチケットに従い、upstream の agent inject 対応が前提です。現状の Pion で確認できるのは、上記の非 SPED fallback までです。
- BoringSSL の exporter・KeyUpdate・negative cases（§48）。既存の BoringSSL harness は handshake と双方向データしか確認しません。ローカルでは KeyUpdate / exporter の self テストが成功しています。
- `npm run examples:e2e`（root `examples/` のデモ）は今回実行していません。

## 3. §40 fingerprint security tests

| 要件 | テスト | 補足 |
|---|---|---|
| early DataChannel → mismatch → 上位へ 0 件 | `packages/webrtc/tests/integrate/sped.test.ts` › `WARP fingerprint mismatch releases no real PeerConnection SCTP, RTP, or RTCP` | 実 PeerConnection で `ondatachannel` が 0 件 |
| early RTP → 0 件 | 同上 | `sendRtp(...) > 0`（wire へ送出済み）かつ受信 0 件 |
| early RTCP → 0 件 | 同上 | **今回** `sendRtcp(...) > 0` の確認を追加 |
| mismatch で SPED abort / DTLS close / `failed` | 同上 | **今回追加**。SPED の diagnostics が `disabled`、DTLS 1.3 engine が `closed`、stats が `dtlsState: "failed"` |
| mismatch 時の DTLS 状態 | `packages/webrtc/tests/transport/dtls.test.ts` › `dtls_start_fails_for_mismatched_fingerprint`, `dtls_start_fails_for_mismatched_fingerprint_dtls13`／`packages/webrtc/tests/integrate/dtls13.test.ts` › `DTLS 1.3 fingerprint mismatch は接続を失敗させる` | |
| 認証後の fingerprint 差し替え | `dtls.test.ts` › `接続後の fingerprint 不一致差し替えは旧認証を残さず失敗させる`／`peerConnection.test.ts` › `post-connect fingerprint failure propagates to PeerConnection, SCTP, and DataChannel` | |
| 認証境界で early traffic を保持 | `sped.test.ts` › `WARP early server traffic is held by the real PeerConnection authentication boundary` | 認証前は DataChannel・RTP・RTCP とも 0 件、認証後に配送 |
| `start()` は final ACK を待たない | `dtls.test.ts` › `DTLS 1.3 final ACK 後の restart は上位 handshakeComplete waiter を引き継ぐ` | |

**修正したバグ:** `RTCDtlsTransport.sendRtcp()` は、成功時に `undefined`、失敗時に `0` を返していました（`warp` から存在する不整合）。`sendRtp()` に合わせて、成功時は送信 byte 数を返すようにしました。

## 4. §41 early buffer tests

### application data（DTLS engine / WebRTC gate）

| 要件 | テスト |
|---|---|
| records limit | `packages/dtls/tests/e2e/self13_early_server_appdata.test.ts` › `maxEarlyAppDataRecords option drops overflow before markConnected`／`early_data_buffer.test.ts` › `preserves order and drops the newest packet on overflow` |
| byte limit | **今回追加:** `self13_early_server_appdata.test.ts` › `maxEarlyAppDataBytes option drops the newest record over the byte cap`、`early_data_buffer.test.ts` › `drops the newest packet when the byte cap would be exceeded` |
| retention timeout | `early_data_buffer.test.ts` › `drops the complete ordered queue when its head expires`、`expires the queue even when the retention timer fires before the wall clock reaches the deadline`、`snapshot reports expiry without waiting for the retention timer`／`dtls.test.ts` › `DTLS internal early data is included in WARP stats until expiry` |
| exact ordering | `early_data_buffer.test.ts` › `preserves order and drops the newest packet on overflow`／`self13_early_server_appdata.test.ts`（全ケースで受信順を `toEqual` で確認） |
| overflow で handshake を失敗させない | `self13_early_server_appdata.test.ts` › `maxEarlyAppDataRecords option drops overflow before markConnected`（`errors` が空） |
| timeout で handshake を失敗させない | **今回追加:** `self13_early_server_appdata.test.ts` › `2 s retention expiry discards early data without failing the handshake` |
| authentication failure cleanup | `early_data_buffer.test.ts` › `abort cleanup prevents the retention timer from mutating state`／`sped.test.ts` › `WARP fingerprint mismatch releases …` |
| close cleanup | `dtls.test.ts` › `stop は DTLS engine を close し early queue と carrier を破棄する`、`application gate は deliver 中の close で残りを破棄する` |
| ICE restart cleanup | `dtls.test.ts` › `application gate restart は旧 queue と retention timer を即時破棄する`、`drain 中の restart は terminal abort せず新 attempt 用に gate を開き直す` |

### media（`earlyMediaPolicy`）

| 要件 | テスト |
|---|---|
| drop / buffer policy、packet limit | `dtls.test.ts` › `pre-auth early media policy=%s enforces bounds and abort cleanup` |
| byte limit、timeout | **今回追加:** `dtls.test.ts` › `pre-auth early media buffer は byte 上限と 2 秒 retention を適用する` |
| authentication failure | `sped.test.ts` › `WARP fingerprint mismatch releases …`／`dtls.test.ts` › `未認証・旧世代の pre-auth media は buffer せず破棄する` |
| close / restart | `dtls.test.ts` › `media drain 中の close は残りを配送せず closed のままにする`、`start 前の media buffer は ICE restart で queue と timer を破棄する`、`media drain 中の ICE restart は残りを drop 統計へ計上する` |

**修正したバグ（retention timer）:** Node の timer は monotonic clock で動くため、`Date.now()` が期限に届く約 1ms 前に発火することがあります。旧実装はこのとき何も破棄せず、timer も再武装しなかったので、期限切れの early data が次の `push` / `drain` まで残っていました（全件実行時に retention テストが断続的に失敗した原因）。timer が早く発火した場合は再武装し、`snapshot()` / `packets` でも読み出し時に期限を評価するようにしました。

- 修正は commit `beb5606e` に入っています。`EarlyDataBuffer` は `snapshot()` と `packets` で `expire(Date.now())` を評価し、timer callback は期限前に発火した場合に `armTimer()` で再武装します（`packages/dtls/src/engine/v1_3/early-data-buffer.ts`）。
- E2E テスト（`2 s retention expiry …`）は固定の `setTimeout(1500)` を使わず、保持を観測した時刻から 2 秒以上経った後に stats を読みます。stats は読み出し時に期限を評価するので、timer の発火時刻には依存しません。
- timer 経路の単体テスト（`early_data_buffer.test.ts`）: 早期発火時の再武装、timer 未発火でも `snapshot()` が期限切れを反映すること、`takeOne` 後に新しい先頭の期限で timer が再武装されること。
- 確認: `packages/dtls` の全件を 4 本同時（retry なし）で各 443/443 成功、`npm run test:small` を 3 回連続で成功。

上限値（256 records / 256 KiB / 2 s）は `EARLY_DATA_LIMITS`（`packages/dtls/src/engine/v1_3/types.ts`）に一元化しています。application gate・media buffer・DTLS engine は、いずれもこの定数から上限を取ります。

## 5. §29–32 stats / diagnostics

実装は `packages/webrtc/src/transport/dtls-stats.ts`（`buildDtlsTransportStats`）です。型 `RTCTransportStats`（`packages/webrtc/src/media/stats.ts`）には、§29 の全 field があります。

| field / 要件 | テスト |
|---|---|
| `warpSpedState`（active / fallback / disabled / probing） | `sped.test.ts` › `WARP early server opt-in でも DataChannel と diagnostics が成立する`（active）、`non-SPED peer へ fallback して handshake が完了する`（fallback）、`WARP fingerprint mismatch releases …`（disabled、**今回追加**）／`packages/ice/tests/sped/direct-handshake.test.ts` › `handshake 中の ICE restart は direct-ready を破棄して external に戻す`（probing、**今回追加**） |
| `warpCarrier`（direct / sped） | 同上。`sped` は direct-ready 前の probing として **今回追加** |
| `warpHandshakeRttMs` = `peerAuthenticatedAt − handshakeStartedAt`（§31） | **今回追加:** `sped.test.ts` › `WARP diagnostics は認証時刻差・累計再送・ICE generation を read-only に公開する` |
| `warpDtlsRetransmissions` = DTLS の `totalRetransmitCount`（§30） | 同上（**今回追加**）。engine 側の累計は `self13_rx_generation.test.ts` |
| `warpSpedRetransmissions` = SPED runtime の累計（§30, §32） | 同上（**今回追加**） |
| `warpEarlyBuffered*` / `warpEarlyDropped*` | `dtls.test.ts` › `DTLS internal early data is included in WARP stats until expiry` ほか |
| `warpEarlyServerSendUsed` | **今回追加:** `WARP fingerprint mismatch releases …`。認証前に送った server 側は `true`、client 側は `false` |
| `iceGeneration` | **今回追加:** `WARP diagnostics は …`。restart 後に `+1` され、ICE の generation と一致する |
| stats は read-only snapshot | **今回追加:** 同テストで `getStats()` を 2 回呼んでも値が変わらず、内部状態（state / readiness / SPED snapshot / generation）も変化しない |

既知の制限: DTLS 1.2 の association では、`warpDtlsRetransmissions` は常に `0` です。累計カウンタ `totalRetransmitCount` は DTLS 1.3 engine だけが持っていて、§30 も DTLS 1.3 の flight を対象としています。

## 6. §42–45 の補足

- **§42 row 7/8 と §43 の parity:**
  - **今回追加:** `sped.test.ts` › `SPED [1.3,1.2] answerer=%s は DTLS 1.2-only peer へ fallback し、DataChannel が DTLS role の parity で双方向に通る`（`client` / `server` の 2 ケース）。
  - 両方の role で、次を確認します。
    - DTLS 1.2 への fallback。
    - text / binary を複数件、双方向に送り、送信順のまま届くこと。
    - stream ID の parity（DTLS client = 偶数、server = 奇数）。
- **§44 replay rejection:**
  - **今回実装:** RFC 3711 §3.3.2 の受信側 replay window（64）を SRTP / SRTCP の receive context に追加しました（`packages/rtp/src/srtp/replay.ts`）。
  - replay は `SrtpReplayError`（`SrtpAuthenticationError` のサブクラス）として扱い、WebRTC の既存の破棄経路で捨てます。
  - window に記録するのは認証が通った packet だけです。改ざん packet では window は進みません。
  - 新しい SSRC の window も、認証が通った後にだけ作ります。未知の SSRC を持つ偽造 packet を大量に送られても、受信側の状態（replay window / ROC 状態）は増えません（`未知 SSRC の認証失敗 packet を大量に受けても受信側の状態は増えない`、AES-CM / AES-GCM の SRTP と SRTCP）。
  - window の数は、相手が認証済みで送った SSRC の数で決まり、上限はありません。既存の SSRC ごとの ROC 状態（`srtpSSRCStates`）と同じ寿命・同じ増え方なので、replay 対策によって新たに無制限になった状態はありません。上限の導入は今回のスコープ外とします。
  - テストは `packages/rtp/tests/srtp/replay.test.ts` です。AES-CM と AES-GCM の両方で、replay・ROC をまたぐ rollover・改ざん・SRTCP を確認しています。
- **§44 auth tag failure / ROC:** rtp package の unit テストで確認しています（`Rejects tampered SRTP auth tag without advancing rollover state`、`TestRolloverCount` など）。E2E 相当の確認は、上記の replay テストの rollover ケースです。
- **§45 ICE restart:** `sped.test.ts` › `handshake 開始後の ICE restart でも datachannel が開く`、`ICE restart 後も datachannel が使える`、`dtls13.test.ts` › `ICE restart 後も DTLS 1.3 の DataChannel / RTP / RTCP が使える`、上記の `iceGeneration` テスト、Chromium E2E の `tests/ice/restart.test.ts`。

**未カバーとして残るもの**

- §42 row 1/2 の「SPED on・Full×Full」を DTLS role ごとに確認する専用テスト。現状は `spedTiming.test.ts` の `回答側の DTLS %s 開始が遅れても…` が両 role をカバーしていますが、DTLS 開始の遅延条件付きです。
- §43 の「early disabled 時に writeReady から peerAuthenticated まで送信を保留する」を DataChannel レベルで確認するテスト。
- §45 の「restart 後に新しい selected pair へ切り替わったこと」を直接確認するテスト。

## 7. `sped:false` 非回帰の証跡

チケットの追加要件（`TICKET-epic4-warp-webrtc-detailed.md` §6）への対応です。レビュー 10 の指摘どおり、SPED/early 用に入れた中断処理が `sped:false` の既定経路にも作用していました。点検で、指摘 4 件のほかに 3 か所の回帰を見つけて修正しました。

### 7.1 SPED/early 用の処理が既定経路から届くかの点検（`warp...HEAD`）

| # | 仕組み | 箇所 | 修正前に `sped:false` から届いたか | 対応 |
|---|---|---|---|---|
| 1 | restart 時の `onEarlyApplicationAttemptCancelled` 発火 | `packages/webrtc/src/transport/dtls.ts` `syncAttemptToIceGeneration` | **届いていた**（この関数は SPED transport では早期 return するため、非 SPED 専用） | 発火を削除（指摘 1） |
| 2 | 同イベントの発火（session abort / fallback flight / generation 変更） | `dtls.ts` `startWithSped` の SPED hook | 届かない（SPED 専用） | 変更なし |
| 3 | `onEarlyApplicationSendRevoked`（early 送信許可の取消し） | `dtls.ts` `updateWarpConfig` | **届き得た**（`sped:false` でも `allowEarlyServerData` を true→false に変更できた） | 設定検証で到達不能にし、`isDtlsTransportSped` でも限定 |
| 4 | 送信失敗による SCTP `cancelStart`（INIT_ACK 送信、T1 再送、`retransmitStartNow`） | `packages/sctp/src/sctp.ts` | **届いていた**（任意の送信失敗で association を閉じた） | `SCTPSendPermissionRevokedError` のときだけ取消し（指摘 2） |
| 5 | INIT 送信失敗で CLOSED + reject | `sctp.ts` `start` | **届いていた** | 取消しのときだけ CLOSED。それ以外は損失として T1 が再送（`warp` でも未到達だった既存の弱点も解消） |
| 6 | 古い attempt の `connect()` 失敗を捨てる | `dtls.ts` `startSerial` / `startWithSped` | **届いていた**（`start()` が終わらない） | attempt に関係なく現在の失敗として `failed` / reject（指摘 3） |
| 7 | DTLS 受信を現 generation の認証済み pair に限定 | `dtls-ice-transport.ts` | **届いていた**（handshake 中の restart で相手の最終 flight を捨て、DTLS が完了しない） | 非 SPED では前 generation の選択 pair（RFC 8445 §9）からの DTLS も受理 |
| 8 | DTLS 1.3 engine の受信世代フィルタ | `dtls.ts` `bindDtlsSocketEvents` | **届いていた**（非 SPED の DTLS 1.3） | SPED transport だけに設定 |
| 9 | SPED/WARP 設定の検証 | `peerConnection.ts` | `connect()` 内だけで、呼び出し側にエラーが返らない | constructor / `setConfiguration` で同期的に throw（指摘 4） |
| 10 | fingerprint gate（`InboundApplicationGate`） | `dtls.ts` | 届く（全経路の security invariant として意図どおり） | 変更なし。非 SPED は認証後にしか受信しないため挙動差なし |
| 11 | media 受信の generation / 認証判定 | `dtls.ts` `onIceDatagram` | 届く | 前 generation の選択 pair を許可済み（既存対応）。マトリクスで確認 |
| 12 | DTLS `connected` 時の `retransmitStartNow` | `packages/webrtc/src/transport/sctp.ts` | 届く | 非 SPED は SCTP 開始が DTLS `connected` 後なので、再送の前倒しだけ。マトリクスで確認 |

### 7.2 障害注入マトリクス（`warp` / 修正前 / 修正後）

- テスト: `packages/webrtc/tests/integrate/transportFaultMatrix.test.ts`。Arrange は `tests/integrate/warpArrange.ts` の `runSctpFaultScenario`。
- 構成: 既定設定（`sped:false`）の 2 つの PeerConnection と negotiated DataChannel。DTLS は既定（1.2）と 1.3 の 2 通り、answerer の DTLS role は client / server の 2 通りで、各シナリオ 4 回。
- 判定: 一度も `failed` にならず、DataChannel が双方向に届き、最終状態が両側 `connected` であること。
- 比較: 同じ helper を `warp`（`3404daf8`）と修正前 HEAD（`2fd3ce19`）の一時 worktree にコピーして実行し、`connectionState` の遷移を記録しました。

| restart | 障害 | `warp` | 修正前 HEAD (`2fd3ce19`) | 修正後 |
|---|---|---|---|---|
| DTLS 接続中 | なし | 4/4 | 4/4 | 4/4 |
| SCTP COOKIE_WAIT 中（INIT 送信時） | なし | 4/4 | 0/4（failed 3、未到達 2） | 4/4 |
| SCTP COOKIE_WAIT 中（INIT 送信時） | `INIT_ACK` を喪失 | 4/4 | 0/4（failed 3、未到達 2） | 4/4 |
| SCTP COOKIE_ECHOED 中（COOKIE_ECHO 送信時） | なし | 4/4 | 2/4（failed 2、未到達 2） | 4/4 |
| SCTP COOKIE_ECHOED 中（COOKIE_ECHO 送信時） | `COOKIE_ACK` を喪失 | 4/4 | 2/4（failed 2、未到達 2） | 4/4 |
| なし | `INIT_ACK` を喪失 | 4/4 | 4/4 | 4/4 |
| なし | `COOKIE_ACK` を喪失 | 4/4 | 4/4 | 4/4 |
| なし | `INIT` の送信失敗 | 0/4（未到達 4） | 0/4（failed 4、未到達 4） | 4/4 |
| なし | `INIT_ACK` の送信失敗 | 4/4 | 0/4（failed 4、未到達 4） | 4/4 |
| なし | `COOKIE_ECHO` の送信失敗 | 4/4 | 4/4 | 4/4 |
| SCTP COOKIE_WAIT 中（INIT 送信時） | `INIT_ACK` の送信失敗 | 4/4 | 0/4（failed 3、未到達 4） | 4/4 |

- 合計: `warp` 40/44、修正前 24 件が回帰（`failed` 21、未到達 3）、修正後 44/44。
- 修正前の典型的な遷移は、offerer `connecting → failed → connecting`、answerer `connecting` のまま（DataChannel 未到達）でした。
- `warp` で失敗する `INIT` 送信失敗の 4 件は既存の弱点です（INIT を 1 回送れないと T1 が始まらない）。今回の SCTP 側の整理（#5）で解消しました。

### 7.3 修正と回帰テスト

| 指摘 | 修正 | 回帰テスト |
|---|---|---|
| 1. restart で一時的に `failed` | #1、#7、#8 | マトリクスの restart 系。修正前は失敗、修正後は成功 |
| 2. 送信失敗で association を閉じる | #4、#5。`SCTPSendPermissionRevokedError` を SCTP に追加し、SPED early 送信キューと DTLS の未認証送信拒否だけがこの型を投げる | `packages/sctp/tests/sctp.test.ts` › `T1 再送の送信失敗は確定前かつ送信許可の取消しのときだけ start を取り消す`、`INIT 送信失敗 (%s) は送信許可の取消しのときだけ association を閉じる`。マトリクスの送信失敗系 |
| 3. restart 後の `connect()` 失敗で `start()` が終わらない | #6 | `packages/webrtc/tests/transport/dtls.test.ts` › `handshake 中の ICE restart 後に connect が失敗したら start は failed で reject する`（修正前は timeout） |
| 4. 設定検証が `connect()` の中だけ | #9 | `packages/webrtc/tests/integrate/sped.test.ts` › `不正な WARP 設定 ($name) は constructor で同期的に throw する`、`setConfiguration の不正な WARP 設定は throw し、設定を変更しない`。「`connect()` で失敗する」ことを前提にした旧テスト 4 件は削除 |

**検証:** `npm run type`、`lint:imports`、`npm run test:small` が成功しました（webrtc 637、SCTP 65、ICE 302、DTLS 444、rtp 125 ほか）。WebRTC・SCTP・ICE・DTLS・rtp の各パッケージは retry なしでも成功しています。`npm run e2e`（一般 E2E 46、DTLS 1.2 / 1.3 モード各 12）と `npm run wpt --workspace packages/webrtc`（後退なし）も成功しました。

## 8. SPED restart による SCTP 開始の取消し（レビュー 11 への対応）

### 8.1 原因

- **指摘（再現済み）:** `sped:true`、DTLS 1.3、early outbound 無効で、DTLS 接続済み・SCTP の COOKIE_WAIT 中に offerer が restart すると、`connecting → failed → connecting → connected` になる。
  - SPED の reset（`dtls.ts` の `onSessionReset`）は `onEarlyApplicationAttemptCancelled` を無条件に発火し、WebRTC 側の SCTP transport はそれを受けると開始の種類に関係なく `cancelStart()` していた。認証後に始めた通常の SCTP 開始まで取り消されていた。
- **点検で見つけた追加の不具合（未報告）:** 同じ条件で restart を COOKIE_ECHOED 中に行うと、early outbound の有効・無効に関係なく接続が完了しない（`connecting` のまま）。
  - DTLS client 側（SCTP では passive 側）は association を DTLS 接続前に待受け状態にしておく。reset でこの passive association が取り消され、新しい association に置き換わると、すでに送った INIT_ACK の cookie 鍵が失われる。相手の COOKIE_ECHO の再送は検証できず、黙って捨てられる。
  - `warp` でもこのシナリオは完了しない（後述の表）。回帰ではないが、§5 の「認証完了後の ICE restart で既存 DTLS/SCTP が利用可能なまま」に該当するので修正した。

### 8.2 修正

- `packages/webrtc/src/transport/sctp.ts`: early の取消し（`onEarlyApplicationAttemptCancelled` と `onEarlyApplicationSendRevoked` の両方）を、次の両方を満たす association だけに限定した。
  1. DTLS が `connected`（= fingerprint 認証済み）になる前に開始した association（`preAuthenticationStarts`）。
  2. DTLS server 側（INIT を送る active 側）の association。early の送信許可で SCTP を送るのは DTLS server だけで、DTLS client の passive association は待受けにすぎない。
  3. 取消しの時点で DTLS がまだ `connected`（認証済み）でないこと。認証前に始めた early start も、認証後まで COOKIE_WAIT が続けば、その後の再送は通常の認証済み送信なので取り消さない（レビュー 11 の確認レビューで残った指摘）。
- 取り消さない場合は、reset で落ちた可能性のある応答を待たずに、保留中の INIT / COOKIE_ECHO をすぐ再送する（`retransmitStartNow`。保留がなければ何もしない）。
- 回帰テスト: `packages/webrtc/tests/transport/sctp.test.ts` › `認証前に始めた early start は認証前だけ取り消され、認証後の SPED reset では維持される (authenticated=$authenticatedBeforeCancel)`。DTLS server が `connecting` で SCTP を開始した後、取消し通知の前に `connected` になった場合は association を維持し、なっていない場合は取り消すことを確認する（修正前は `authenticated=true` が失敗）。end-to-end では認証直後まで COOKIE_WAIT を保つタイミングを安定して作れないため、条件そのものを単体で固定した。
- §7.1 の表の #2・#3・#12 に関わる経路で、SPED でも認証後の SCTP 開始が取り消されなくなる。

### 8.3 障害注入マトリクス（SPED、DTLS 1.3）

- `transportFaultMatrix.test.ts` に SPED（early outbound 無効 / 有効）を追加し、§7.2 の `sped:false`（既定 / 1.3）と合わせて 4 構成 × role 2 通り × 11 シナリオ = 88 件を常設した。シナリオは並行実行で約 50 秒。
- 比較は §7.2 と同じ方法（`warp` は一時 worktree に helper をコピー）。各シナリオは early 無効 / 有効 × role 2 通りの 4 回。

| restart | 障害 | `warp` | 修正前 (`6b2e88a5`) | 修正後 |
|---|---|---|---|---|
| DTLS 接続中 | なし | 4/4 | 4/4 | 4/4 |
| SCTP COOKIE_WAIT 中（INIT 送信時） | なし | 4/4 | 2/4（failed 2） | 4/4 |
| SCTP COOKIE_WAIT 中（INIT 送信時） | `INIT_ACK` を喪失 | 4/4 | 2/4（failed 2） | 4/4 |
| SCTP COOKIE_ECHOED 中（COOKIE_ECHO 送信時） | なし | 0/4（未到達 4） | 0/4（未到達 4） | 4/4 |
| SCTP COOKIE_ECHOED 中（COOKIE_ECHO 送信時） | `COOKIE_ACK` を喪失 | 0/4（未到達 4） | 0/4（未到達 4） | 4/4 |
| なし | `INIT_ACK` を喪失 | 0/4（未到達 4） | 4/4 | 4/4 |
| なし | `COOKIE_ACK` を喪失 | 0/4（未到達 4） | 4/4 | 4/4 |
| なし | `INIT` の送信失敗 | 0/4（未到達 4） | 4/4 | 4/4 |
| なし | `INIT_ACK` の送信失敗 | 0/4（未到達 4） | 4/4 | 4/4 |
| なし | `COOKIE_ECHO` の送信失敗 | 0/4（未到達 4） | 4/4 | 4/4 |
| SCTP COOKIE_WAIT 中（INIT 送信時） | `INIT_ACK` の送信失敗 | 4/4 | 2/4（failed 2） | 4/4 |

- 合計: `warp` 16/44、修正前 30/44、修正後 44/44。修正前の `failed` 6 件はいずれも early outbound 無効（指摘のケース）で、両 DTLS role で発生していた。
- `warp` の SPED 経路は、restart なしの障害でも完了しないものが多い（`warp` 単体でも `packages/webrtc/tests/integrate/sped.test.ts` の 10 件が失敗する）。

### 8.4 その他の対応

- **認証後の ICE restart で selected pair が実際に変わることの恒久テスト:** `transportFaultMatrix.test.ts` › `$name: 認証後の ICE restart` › `新しい selected pair (別ポート) へ移り、同じ SCTP association を維持する`（`sped:false` と SPED）。restart 後に、両側の generation が +1 になること、nominated pair のオブジェクト・ローカルポート・リモートポートがすべて変わること、SCTP association が同一のまま ESTABLISHED で双方向に通信できること、一度も `failed` にならないことを確認する。
- **DTLS 1.2 readiness のライフサイクル:** `packages/dtls/src/socket.ts` の 1.2 readiness は `connected` から毎回導出していたため、close や renegotiation で false に戻っていた。1.3 engine と同じく、最初の接続で 3 つの milestone を一度だけ true にし、以後は戻さない latch にした（終了は `onClose` / `onError` で通知）。テスト: `packages/dtls/tests/e2e/self12_readiness_latch.test.ts`（修正前は失敗）。
- **`EARLY_APP_DATA_UNLIMITED` の説明:** 「上限なしで onConnect まで保持」としていたが、実装には 2 秒の retention がある。外れるのは record / byte の上限だけで、retention は適用されると書き直した（`types.ts`、`socket.ts` の `Options`）。

**検証:** `npm run type`、`lint:imports`、`npm run test:small`（webrtc 685、DTLS 445、SCTP 65、ICE 302、rtp 125 ほか）、`npm run doc`、`npm run e2e`（一般 46、DTLS 1.2 / 1.3 モード各 12）、`npm run wpt --workspace packages/webrtc`（後退なし）が成功。
