# 既存 WebRTC SDP・メディア互換性と E2E の問題を個別に解消する

- 状態: 未実装（Epic 4 から切り出し）。このファイルは後続作業用のチケットであり、IDE に新規チケットを登録したものではない。
- 元チケット: [Epic 4](TICKET-ticket-71cc0e0d-e203-4057-816d-a89b993faf26.md)、PR #713。
- 比較基準: `warp` の `64aef07db002d905f6fa08b5d9faf39b9949e45b`。
- 切り出し前の実装・テスト: `0656419a1ab8cc0f6a4e785e24b9ddd89607c071`。
- ローカル保存先: `backup/epic4-before-scope-cleanup-20260923`。旧実装には下記の回帰があるため、そのまま再適用しない。

## 目的とスコープ

WARP 導入とは独立した既存の SDP・メディア実装の制約と E2E の問題を扱う。まず比較基準上で各問題を再現し、独立した変更単位で実装・レビューする。Epic 4 の実装を戻す際に、それらの修正に依存していた追加機能・専用テストも一緒に除外した。これは検証成功のためのテスト無効化ではなく、実装範囲の分離である。

### 1. SDP negotiation の transaction と association 更新

対象: `peerConnection.ts`、`sdpManager.ts`、`sdp.ts`、`secureTransportManager.ts`、`sctpManager.ts`、`transport/sctp.ts`。

- partial BUNDLE、確立後の split/join/tag 変更、独立 ICE credentials、候補の m-line ごとの routing。
- pending/current SDP と ICE・DTLS・SCTP の所有関係を分離し、検証失敗時の破壊的変更を避ける。
- `tls-id` と setup/fingerprint の association 更新規則、SCTP port 変更・port 0 後の再開。
- 元実装の限界は上記基準コミットの `setRemoteDescription()` が各 m-line の transport/parameters を即時更新し、SDP rollback が transport graph を復元しないことから確認できる。すべての組合せの実行再現は後続タスクで行う。

再実装時に必須の回帰条件:

- remote offer 後の `addTransceiver("video")` を remote rollback で消さず、停止もしない。remote 作成とアプリ作成を区別する。
- offer → pranswer では current SDP に昇格せず、異なる応答先の final answer と rollback を受け付ける。migration/retirement/plan clear は final answer で行う。
- ICE restart offer 後の local answer 失敗で、current/pending SDP、signalingState、generation/credentials、candidate/pair、旧 RTP/DataChannel を保持し、正しい answer の再試行が成功する。
- 既存 transport/association は、すべての失敗し得る処理が終わるまで退役させない。

### 2. extmap と RTP session ごとの routing

対象: `media/extmap.ts`（切り出し前に追加）、`media/router.ts`、`media/parameters.ts`、sender/receiver/transceiver、SDP parser/serializer。

- 基準実装は header extension の direction/attributes を保持せず、ID を m-line ごとに割り当て、router の extension/SSRC/RID table は PC 共通である。
- BUNDLE 単位の ID 整合性、既存 ID の維持、4096–4351 support indication と runtime ID の分離、unsupported ID の予約、重複・方向・answer 照合を設計する。
- BUNDLE transport 変更時の sender/receiver、RTCP feedback、ReceiverTWCC を同時に移す。
- 基準実装の convenience API を回帰させず、WPT 専用の厳格化は wrapper 内に限定する。

### 3. track identity とアプリ callback の通知境界

対象: `common/src/event.ts`、`webrtc/src/dataChannel.ts`、`media/rtpReceiver.ts`、`media/rtpTransceiver.ts`、`transceiverManager.ts`。

- 基準実装の `Event.execute()` は同期例外を呼び出し元へ伝播し、後続 subscriber を実行しない。内部 protocol event を黙殺する変更は行わない。
- 安定した track identity、track event の順序、callback 例外の隔離は必要なアプリ境界だけで設計する。
- RID 別 track を一つにする場合は simulcast API/E2E と一緒に設計する。両 sender へ同じ全 RID track を接続してはならない。
- high/low の異なる sequence number 系列が混ざらず、RID 省略後も SSRC 対応が維持されることを RTP レベルで検証する。

### 4. E2E 自体の既存問題

対象: `e2e/ensure-browser.js`、`e2e/tests/mediachannel/{simulcast,removeTrack}.test.ts`、対応する server handler。

- simulcast テストの一方の track 再生後の早期 close、例外の reject/cleanup、過剰な capture constraints を見直す。
- removeTrack の確認対象を固定 index ではなく実際の MID で選ぶ。
- Playwright の未対応 OS の扱いを整理する。切り出した Ubuntu 26 向け workaround は x64 固定であり、OS/architecture ごとの確認が必要。
- ブラウザーの「再生できた」だけでレイヤー分離成功と扱わない。
- `tests/bundle/max-bundle.test.ts` の `bundle_max_bundle_answer` が Chromium 149 で20秒タイムアウトする。切り出し後の全38件中この1件が失敗し、基準 `64aef07d` の隔離 worktree でも同じケースが失敗した（対になる offer ケースは成功）。この既存失敗も本チケットで調査する。

## Epic 4 に残す変更

DTLS readiness、fingerprint gate、early application/media queue、directional SRTP、DTLS role 基準の SCTP、early start の取消・再試行、SPED/direct fallback、Full/Lite、ICE generation 分離、stats を残す。複数 m-line の fingerprint/ICE が BUNDLE tag を上書きしない最小限の処理と、不要 transport の WARP queue/timer cleanup も認証境界のために残す。SDP staging に依存せず、別 pair の成功応答から既に認証された SPED 固定経路の handshake 再送を再開できる処理も残す（application の nomination/consent 条件は維持）。CI の依存 install の非 auditing 化は WARP 検証の実行基盤として残す。

## 完了条件

- [ ] 各問題を基準コミットで再現し、期待結果・実際の結果を記録する。
- [ ] 上記 1〜4 を個別にレビュー可能な変更へ分割する。
- [ ] rollback/pranswer/ICE restart 失敗注入と RID 別 RTP の回帰テストを追加する。
- [ ] 通常 DTLS 1.2、DTLS 1.3、SPED 有効/無効の接続を回帰させない。
- [ ] package tests/type、workspace type/test:small、doc:check、該当 E2E/WPT を実行し、既存失敗・外部依存 skip を成功と区別して報告する。

## 参照方法

旧変更は `git diff 64aef07d 0656419a -- <対象ファイル>` で確認できる。旧 PR の rollback/pranswer/RID 指摘はこの拡張の回帰であり、基準ブランチに元からあるバグと混同しない。Epic 4 側では拡張の撤去と互換性テストで対処する。

## 切り出し時の検証記録（2026-09-23）

- `legacyCompatibility.test.ts` の rollback / pranswer / RID 分離3件は、基準 `64aef07d` と切り出し後では成功し、切り出し前 `0656419a` では3件とも失敗した。
- `npm run ci` の型・doc:check・build・package tests は成功（WebRTC 348 passed / 4 skipped）。通常実行は Playwright の Ubuntu 26 非対応で E2E 起動時に停止した。
- 検証時のみ `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64` を指定したブラウザーE2Eは37 passed / 1 failed。上記 max-bundle 失敗は基準側でも再現した。OS workaround を実装へ戻してはいない。
- `npm run wpt` / `npm run wpt:coverage` は成功。これは設定済み baseline に対する非回帰であり、全 upstream WPT 成功を意味しない。
- 単独 SPED 全47件検証の1回で early-server stats が active ではなく fallback となった。該当ケースの単独再実行と後続の全packageテストでは成功したが、診断値の揺らぎは未解明。
- Pion SPED / ICE agent / TURN の opt-in 相互接続は今回未実行。
