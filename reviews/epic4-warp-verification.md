---
ide:
  viewer: review-document
  version: 1
  title: "Epic 4: WARP 対応 WebRTC の検証記録（interop / E2E / 要件とテストの対応）"
  dock: right
  baseCommit: 60149c242dd18f44d8f8c5db4db1aa36abea1e95
---
# Epic 4: WARP 対応 WebRTC の検証記録

設計書 [epic4-warp-webrtc-detailed.md](review-file:epic4-warp-webrtc-detailed.md:1) の §29–32（stats）、§40–50（テスト・相互接続）、§53（完了条件）について、実行した検証と、要件ごとのテストの対応をまとめます。対象は `60149c24` に本記録の変更を加えた作業ツリーです。

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
| retention timeout | `early_data_buffer.test.ts` › `drops the complete ordered queue when its head expires`／`dtls.test.ts` › `DTLS internal early data is included in WARP stats until expiry` |
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
  - テストは `packages/rtp/tests/srtp/replay.test.ts` です。AES-CM と AES-GCM の両方で、replay・ROC をまたぐ rollover・改ざん・SRTCP を確認しています。
- **§44 auth tag failure / ROC:** rtp package の unit テストで確認しています（`Rejects tampered SRTP auth tag without advancing rollover state`、`TestRolloverCount` など）。E2E 相当の確認は、上記の replay テストの rollover ケースです。
- **§45 ICE restart:** `sped.test.ts` › `handshake 開始後の ICE restart でも datachannel が開く`、`ICE restart 後も datachannel が使える`、`dtls13.test.ts` › `ICE restart 後も DTLS 1.3 の DataChannel / RTP / RTCP が使える`、上記の `iceGeneration` テスト、Chromium E2E の `tests/ice/restart.test.ts`。

**未カバーとして残るもの**

- §42 row 1/2 の「SPED on・Full×Full」を DTLS role ごとに確認する専用テスト。現状は `spedTiming.test.ts` の `回答側の DTLS %s 開始が遅れても…` が両 role をカバーしていますが、DTLS 開始の遅延条件付きです。
- §43 の「early disabled 時に writeReady から peerAuthenticated まで送信を保留する」を DataChannel レベルで確認するテスト。
- §45 の「restart 後に新しい selected pair へ切り替わったこと」を直接確認するテスト。
