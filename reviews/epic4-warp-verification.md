---
ide:
  viewer: review-document
  version: 1
  title: "Epic 4: WARP 対応 WebRTC の検証記録（interop / E2E / 要件とテストの対応）"
  dock: right
  baseCommit: 142abf107d1130a05a84601abb70a9e2e41f87f6
---
# Epic 4: WARP 対応 WebRTC の検証記録

設計書 [epic4-warp-webrtc-detailed.md](review-file:epic4-warp-webrtc-detailed.md:1) の §29–32（stats）、§40–50（テスト・相互接続）、§53（完了条件）について、実行した検証と、要件ごとのテストの対応をまとめます。対象は `f296d38e` に、server の完了判定を「Finished を含む全 record の ACK 送信成功」に改めた修正（§10.4）を加えた作業ツリーです。

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

## 9. レビュアー向け証跡（`aa1f76ba` 時点）

レビューごとに担当が変わっても、同じ根拠をリポジトリの中から再確認できるように、P1 の検出性・再現コマンド・取りこぼしの点検・最終検証をまとめます。`/tmp` のスクリプトは使いません。

### 9.1 P1 とテストの対応

| P1 の内容（レビュー 11） | 対応するテスト | `aa1f76ba` | 修正を外した場合 |
|---|---|---|---|
| `sped:true`・DTLS 1.3・early outbound 無効、DTLS 接続済み・SCTP COOKIE_WAIT 中に INIT_ACK を 1 回落として offerer が restart → `connecting → failed → connecting → connected` | `packages/webrtc/tests/integrate/transportFaultMatrix.test.ts` › `'SPED early=off' は SCTP 障害注入と ICE restart で failed にならない` › `answerer DTLS=client` / `answerer DTLS=server` › `restart=cookie-wait drop=INIT_ACK` | 成功 | 失敗（`expected [ 'connecting', 'failed', … ] to not include 'failed'`） |
| 認証前に始めた early start が、認証後も COOKIE_WAIT のまま restart で取り消される | `packages/webrtc/tests/transport/sctp.test.ts` › `認証前に始めた early start は認証前だけ取り消され、認証後の SPED reset では維持される (authenticated=true)` | 成功 | 失敗 |

- **マトリクスが P1 を検出できることの確認:** `packages/webrtc/src/transport/sctp.ts` だけを修正前（`6b2e88a5`）に一時的に戻すと、マトリクス 90 件のうち **13 件が失敗**した。HEAD では 0 件。
  - 失敗した 13 件: `SPED early=off` × 両 role の `restart=cookie-wait`、`restart=cookie-wait drop=INIT_ACK`、`restart=cookie-wait failSend=INIT_ACK`、`restart=cookie-echoed`、`restart=cookie-echoed drop=COOKIE_ACK`（10 件）と、`SPED early=on` の `restart=cookie-echoed` 系 3 件。
  - P1 と同じシナリオ（`SPED early=off` × `restart=cookie-wait drop=INIT_ACK`）は「`failed` を含まない」の検証で失敗する。マトリクスの restart は INIT 送信時（DTLS 認証後・SCTP COOKIE_WAIT）に起きるので、P1 と同じタイミングになる。
- **そのまま実行できるコマンド:**

```bash
# HEAD: 90/90 成功（--retry=0、約 50 秒）
cd packages/webrtc
npx vitest run tests/integrate/transportFaultMatrix.test.ts --retry=0

# 修正を外した場合: 13 件失敗（確認後に元へ戻す）
git show 6b2e88a5:packages/webrtc/src/transport/sctp.ts > src/transport/sctp.ts
npx vitest run tests/integrate/transportFaultMatrix.test.ts --retry=0
git checkout -- src/transport/sctp.ts
```

### 9.2 同じ種類の取りこぼしの点検

SCTP 側で認証状態を見ずに `cancelStart` へ進む経路は、`SCTPSendPermissionRevokedError`（送信権限の取消し）による送信失敗だけである。このエラーが認証後の association に届くかを点検した。

- このエラーを投げるのは、`packages/webrtc/src/transport/sped.ts` の early 送信経路（`applicationWriteReady` だけが立っている間の early application 送信と、early 送信キュー）と、`packages/webrtc/src/transport/dtls.ts` の `sendData` の未認証拒否（`readiness.peerAuthenticated` が false の場合だけ）である。
- 認証後の SPED 送信は `sped.ts` の `send` / `sendApplication` から `sendInternal` の `applicationReady` 分岐を通る。経路がまだ使えない場合はキューに入れるだけで（`waitForWire=false`）、失敗はログに出すだけで SCTP には伝わらない。
- `applicationReady` は `markApplicationReady()` で立つ。これは DTLS の `onConnect` / handshake 完了の hook から呼ばれ、WebRTC の認証（fingerprint 検証は `waitForPeerHandshakeAuthenticated` の後に行う）より遅くならない。
- 以上から、認証後の association がこのエラーで取り消される経路は見つからなかった。認証後に届く cancel / revoke イベントは、`packages/webrtc/src/transport/sctp.ts` の `cancelEarlyStart` が DTLS `connected` を確認して無視する（§8.2）。

### 9.3 最終検証（`aa1f76ba` + JSDoc 修正の作業ツリー）

| コマンド | 結果 |
|---|---|
| `npm run type` | 成功 |
| `npm run lint:imports` | 成功 |
| `npm run test:small` | 成功（webrtc 685 / 4 skipped、DTLS 445 / 1 skipped、ICE 302 / 8 skipped、rtp 125、SCTP 65、ice-server 45 ほか） |
| `npx vitest run tests/integrate/transportFaultMatrix.test.ts --retry=0`（packages/webrtc） | 90/90 成功（約 46 秒） |
| `npm run doc:check` | 成功 |
| `npm run e2e` | 成功（一般 E2E 46、DTLS 1.2 / 1.3 モード各 12） |
| `npm run wpt --workspace packages/webrtc` | 成功（後退なし） |

## 10. DTLS 1.3 の最終 ACK 再送と readiness waiter（承認後レビューの指摘への対応）

### 10.1 最終 ACK の再送で server の完了待機が解決しない

- **原因:** server の `handshakeComplete` は `packages/dtls/src/engine/v1_3/record-rx.ts` の `finishHandshakeRecordAck` の中でだけ確定していた。client Finished の処理中に carrier の世代が変わり、最初の ACK 送信が reject すると、その失敗は旧世代のものとして捨てられる。client は Finished を再送し、server は replay / 重複 handshake の経路で再 ACK する。しかしこの経路は ACK を送るだけで完了を確定しなかったため、client は完了しても server は `handshakeComplete=false` のまま待機が解決しなかった。
- **修正:** 完了判定（server・client Finished 受信済み・未 ACK の record なし）を `completeServerHandshakeIfAcked` にまとめ、`finishHandshakeRecordAck` と、replay / 重複 handshake への再 ACK が成功した後の両方から呼ぶ。
- **回帰テスト:** `packages/dtls/tests/e2e/self13_final_ack_retry.test.ts` › `e2e/self13 最初の最終 ACK が失敗しても、再送 Finished への ACK 成功で server が handshakeComplete になる`。server の受信 datagram に carrier 世代を付け、client Finished 処理中に世代を進めて最初の ACK 送信を reject させる。修正前は server の `waitForHandshakeComplete` が timeout、修正後は両側が完了しエラーもない。

### 10.2 到達済み readiness の waiter が close 後に reject する

- **原因:** `packages/dtls/src/socket.ts` の `waitForSelectedReadiness`（設定に DTLS 1.3 を含む場合に使う）は、到達済みの milestone より先に association の終了を判定していた。接続・完了後に close すると、readiness は全項目 true なのに 3 つの waiter が reject した。1.2-only の経路（`waitForLegacyReadiness`）は到達済みなら即時 resolve するので、両者が食い違っていた。
- **修正:** 要求された milestone が到達済みなら、終了状態より先に即時 resolve する（readiness は latch という §8.4 の契約どおり）。
- **回帰テスト:** `packages/dtls/tests/e2e/self_readiness_latch.test.ts`（旧 `self12_readiness_latch.test.ts` を拡張）› `e2e/self readiness latch ($name)`。`DTLS 1.3`、`dual client → 1.2 server`、`DTLS 1.2` のそれぞれで、handshake 完了 → 両側 close の後に readiness が true のままで、3 つの waiter がすべて resolve することを確認する。修正前は `DTLS 1.3` と `dual client → 1.2 server` が失敗し、`DTLS 1.2` だけが成功していた。

### 10.3 検証

| コマンド | 結果 |
|---|---|
| `npm run type`、`npm run lint:imports` | 成功 |
| `npm run test:small` | 成功（DTLS 448 / 1 skipped、webrtc 685 / 4 skipped、ICE 302、rtp 125、SCTP 65 ほか） |
| `packages/dtls` 全件 `--retry=0` | 448 passed / 1 skipped |
| `cd packages/dtls && npm run test:boringssl:docker` | 5/5 成功 |
| `npm run doc`（差分なし）、`npm run e2e`（一般 46、DTLS 1.2 / 1.3 モード各 12）、`npm run wpt --workspace packages/webrtc`（後退なし） | 成功 |

### 10.4 Finished の ACK が未送信のまま server が完了する（承認後レビューの再指摘）

- **原因:** `sendAck()` は送信前に ACK 対象を queue から取り出す。`sendWithBudget` が throw すると対象は queue に戻らず、送信中・失敗した ACK の record は queue にも ACK 済みにも残らなかった。§10.1 の完了判定は「queue が空」だけを見ていたため、相互認証で最終 flight が Certificate・CertificateVerify・Finished に分かれ、世代変更と初回 ACK の送信失敗が重なると、先行 record の再 ACK が成功しただけで、Finished の ACK が一度も送れていないのに server が `handshakeComplete=true` を通知していた（client は `false`、最終 flight は保留のまま）。
- **修正:**
  - `unackedHandshakeRecords`（`connection-base.ts`）: 受理した handshake record を記録し、その record を含む ACK の送信が成功したときだけ消す（`flight-tx.ts` の `sendAck`）。送信中・失敗した ACK の record は残る。
  - `sendAck` は送信が throw した場合も ACK 対象を queue に戻す（後続の ACK、たとえば相手の再送への ACK で必ず送り直す）。
  - server の完了判定（`record-rx.ts` の `completeServerHandshakeIfAcked`）に「`unackedHandshakeRecords` が空」を加え、Finished を含む全 record の ACK 送信成功を条件にした。
- **回帰テスト:** `packages/dtls/tests/e2e/self13_final_ack_retry.test.ts` › `e2e/self13 相互認証で Finished の ACK が送れていない間は server を handshakeComplete にしない`。
  - 相互認証で最終 flight を 3 record に分ける。
  - Finished を含む ACK だけを、`sendAck` が対象を queue から取り出した後の `sendWithBudget` で 2 回失敗させる（初回は世代変更と重ねる）。
  - 先行 record だけの ACK は成功させる。
  - `onHandshakeComplete` の時点で Finished の ACK 送信が成功済みであること、その後に両側が完了することを確認する。
  - 修正前は「Finished の ACK 未送信のまま完了」で失敗した（先行 record の ACK は成功していた）。
- **検証:** `packages/dtls` 全件 `--retry=0`（449 passed / 1 skipped）、`npm run type`、`lint:imports`、`npm run test:small`（DTLS 449、webrtc 685、ICE 302 ほか）、`npm run test:boringssl:docker`（5/5）、`npm run e2e`（46、DTLS 1.2 / 1.3 モード各 12）、`npm run wpt --workspace packages/webrtc`（後退なし）、`npm run doc`（差分なし）が成功。

## 11. レビュー範囲と承認基準の固定（チケット §8 への対応）

対象は `142abf10` に、installer 関連を `warp` に戻した変更（§11.1）とチケット文書の更新を加えた作業ツリーです。比較元の `warp` は `de84c1b9` です。

### 11.1 installer 関連を `warp` に戻した（A-1）

レビュー #8 の指摘（`e2e/ensure-browser.js` の install から `env: playwrightInstallEnv()` が消え、import だけが残った）は、develop merge の conflict 解消で生じたものです。installer は WARP の要件と無関係なので、直さずにこのチケットから外しました。

| ファイル | 対応 |
|---|---|
| `e2e/ensure-browser.js`、`e2e/vitest.config.mts`、`e2e/vitest.dtls.config.mts`、`scripts/install-playwright-browsers.js` | `warp` の内容に戻した |
| `e2e/playwright-browsers.js`（develop の `e2e/browsers-path.js` と重複）、`scripts/playwright-host-platform.js` | 削除した（`warp` に存在しない） |

再導入は `TICKET-playwright-host-platform-installer.md` で扱います。戻した後も、Ubuntu 26.04 では `npm run install:browsers` と `npm run e2e`（63 + 18 件）が成功しました。e2e の Playwright 1.64.1 は `ubuntu26.04-x64` を定義しているためです。

### 11.2 merge 残骸の点検（C）

```bash
git diff --stat warp -- e2e scripts integration        # 出力なし
git diff warp --submodule=short -- integration third_party   # 出力なし
npm run lint:imports                                    # all imports are at the file header
```

`e2e/`・`scripts/`・submodule にチケット外の差分は残っていません。差分全体は 156 ファイル（+83,454 / −1,694）で、そのうち 11 ファイル・+63,347 行が `docs/rfc`・`docs/w3c` の参考資料（チケット §8 でレビュー対象外）です。残るチケット外の差分は、`package.json`・`import-test/package.json` の非 auditing install（`4393d889`）と `AGENTS.md`（develop merge 由来）です。merge のたびにこの 3 コマンドを実行し、結果をこの節に追記します。

### 11.3 leak probe の計測方針と `warp` との比較

leak property（P2）が報告した `ice.remoteCandidates` / `ice.checkList` の +1 は 2 つの原因の重なりでした。

1. **実際の漏れ（修正済み）:** `restartRemote()` の後、相手の旧 generation の遅れた check（USERNAME の送信側が旧 remote ufrag）が現行 generation として扱われ、新しい checklist に prflx candidate と pair を作っていました。`packages/ice/src/ice.ts` で退役した remote ufrag を最大 4 個覚え、その check には成功応答だけを返して candidate と pair を作らないようにしました（旧経路の consent は RFC 8445 §9 のとおり維持）。`packages/ice/tests/ice/restart-generation.test.ts` が、`restart()` / `restartRemote()` の両方で旧 generation の prflx と pair が残らないことを固定します（修正を外すと失敗）。
2. **環境依存の揺らぎ（漏れではない）:** この環境は複数 NIC（Tailscale の 100.124.146.41 を含む）を持ち、host candidate のソケットが wildcard に bind されています。192.168.0.100 のソケットから相手の Tailscale アドレスへ送った check は、送信元が 100.124.146.41 になり、相手はそれを prflx として学習します。学習するかは、その低優先度の pair が ICE 完了前に check されるかで変わり、次の restart で破棄されます。そこで leak probe では、シグナリングされた candidate と pair を厳密に数え（`ice.remoteCandidates`、`ice.checkList`）、prflx は上限付きで数えます（`ice.prflxCandidates` は相手の host IP 数 × host port 数、`ice.prflxPairs` はさらに × local socket 数）。

あわせて、前回追加した固定 cycle 専用の template に `fixedOnly` を付け、seed の抽選から外しました。追加前と同じく、各 seed は `warp` と同じ cycle を引きます。

**seed ごとの失敗率（各 10 回、`--retry 0`、cycle seed のみ）**

| seed | `warp` | 修正前（`27a2717e`） | ICE 修正 + `fixedOnly` | さらに計測方針 |
|---|---|---|---|---|
| 10 | 2/10 | 1/10 | 0/10 | 0/10 |
| 107 | 0/10 | 6/10 | 0/10 | 0/10 |
| 179 | 0/10 | 0/10 | 4/10 | 0/10 |
| 175 | 0/10 | 2/10 | 6/10 | 0/10 |

修正前の列は、追加した template のせいで `warp` と異なる cycle を引いていました（seed 107 の失敗 cycle に「BUNDLE split offer rolled back on both sides」が含まれていた）。`fixedOnly` を付けた後の 2 列は `warp` と同じ cycle です。`warp` の seed 10 の失敗も同じ「+1 prflx」で、`warp` でも再現する揺らぎです。

### 11.4 固定の検証コマンドの結果

| コマンド | 結果 |
|---|---|
| `npm run type` | 成功 |
| `npm run lint:imports` | 成功 |
| `npm run test:small` | 成功（DTLS 462、ICE 402、RTP 405、SCTP 71、WebRTC 1,128 など。失敗 0） |
| `npm run doc:check` | 成功 |
| `npm run e2e` | 成功（63 + 18） |
| `npm run wpt --workspace packages/webrtc` | 成功（PASS 442 / FAIL 534 / TIMEOUT 39、REGRESSION 0。baseline に対する非回帰であり、upstream WPT 全件の成功ではない） |
| leak property（seed 1〜200、`--retry 0`） | 成功（450 passed、200 skipped は opt-in の heap 検査 P3。約 945 秒） |

未実施: Pion SPED の opt-in 相互接続は、自動ビルドが「local pion-sped is missing or incompatible」で起動しなかったため、今回は確認できていません（このセッションの前半では 5/5 成功）。


### 11.5 remote だけの ICE restart で旧経路の RTP が破棄される（レビューの再指摘への対応）

**原因:** `packages/ice/src/ice.ts` の `restartRemote()`（相手だけが資格情報を変えた description を適用したときの経路）は、`restart()` と違って旧選択 pair を `previousSelectedPairs` に残さず、`nominated` と checklist を消していました。そのため `RTCDtlsTransport` の受信ゲートは、相手がまだ送り続けている旧経路の RTP を「未認証 pair・旧選択 pair でもない」として破棄し、新 pair が認証されるまで音声と映像が途切れていました。

**修正:** 旧選択 pair を残す処理を `retainSelectedPairs()` にまとめ、`restart()` と `restartRemote()` の両方で呼びます。残した pair は、従来どおり media の受信にだけ使い（DTLS の認証経路には使わない）、新しい generation の認証済み datagram が届いた時点で解放されます（RFC 8445 §9）。

**回帰テスト（修正を外すと両方失敗）:**

| テスト | 内容 |
|---|---|
| `packages/ice/tests/ice/restart-previous-pair.test.ts`「remote だけの restart でも…」 | `restartRemote()` と新しい remote 資格情報の適用後、新候補が届く前の旧経路の datagram が `fromPreviousSelectedPair` として識別される |
| `packages/webrtc/tests/integrate/iceRestartContinuity.test.ts` | 公開 API で、相手だけが資格情報を変えて候補を省いた answer を `setRemoteDescription()` で適用した後の 250 ms 間も RTP を受け取り続ける（修正前は 0 パケット） |

**固定の検証コマンド（§8 の一式、`9bce67d6` + 本修正の作業ツリー）:** `type`・`lint:imports`・`doc:check` 成功、`test:small` 成功（ICE 403、WebRTC 1,129 ほか失敗 0）、`e2e` 63 + 18 成功、`wpt` REGRESSION 0（PASS 442）、leak property seed 1〜200 は 450 passed。

### 11.6 両端の選択経路が異なると SPED の DTLS が破棄される（レビューの再指摘への対応）

**原因:** `packages/webrtc/src/transport/sped.ts` の `IceSpedTransport` は、DTLS 接続後に受け取る record を「自分の選択経路」（`ice.nominated`、nominated / remoteNominated な pair、handshake で固定した `lastPath`）に限っていました。送信経路は相手が選ぶため、複数インターフェースで両端が別の pair（IPv4 / IPv6 など）を選ぶと、相手が使う現世代・認証済みの経路の record まで破棄され、SCTP が進まず DataChannel が開きませんでした。`transportFaultMatrix.test.ts` を `--retry 0` で実行すると、HEAD では `restart=cookie-echoed` 系の 2 件が 20 秒で失敗しました（この環境では Tailscale を含む複数インターフェースで選択が分かれる）。

**修正:** その制限（`isSelectedApplicationPath`）を削除し、受信条件を `allowsAuthenticatedDtlsDelivery` の検証（現世代・認証済み pair・protocol と送信元 5-tuple の一致）だけにしました。どの valid pair で届いたデータも受け取る、という RFC 8445 §12.1 のとおりです。旧世代・未認証 pair・送信元不一致の record は従来どおり破棄します。送信側（`Connection.send()` が consent の取れた選択 pair だけを使う）は変えていません。

**回帰テスト:**

| テスト | 内容 | 修正前 | 修正後 |
|---|---|---|---|
| `packages/webrtc/tests/integrate/spedPathSelection.test.ts` | 127.0.0.1 と ::1 だけを候補にした実 SPED 接続で、受信側と送信側に別 family を選ばせ（送信側の経路は受信側の選択 pair でも handshake 経路でもない）、DataChannel のメッセージが届く | 3/3 失敗 | 3/3 成功 |
| `packages/webrtc/tests/transport/sped.test.ts`「両端の選択経路が IPv4 / IPv6 に分かれても…」 | 自分は IPv6、相手は IPv4 を選ぶ。相手の認証済み pair の record は届き、旧世代・未認証 pair・送信元不一致は届かない | 失敗 | 成功 |
| `packages/webrtc/tests/integrate/transportFaultMatrix.test.ts`（`--retry 0`） | 障害注入マトリクス 90 件 | 88/90 | 90/90 |

自分の選択 pair 以外を破棄することを確かめていた単体テスト 2 件（restart 中の未 nomination の pair、TCP の別 pair）は、この誤った制限を固定していたため、受け取ることを確かめる内容に改めました。

**固定の検証コマンド（§8 の一式、`89e8bdad` + 本修正の作業ツリー）:** `type`・`lint:imports`・`doc:check` 成功、`test:small` 成功（WebRTC 1,130、ICE 403 ほか失敗 0）、`e2e` 63 + 18 成功、`wpt` REGRESSION 0（PASS 442）、leak property seed 1〜200 は 450 passed。
