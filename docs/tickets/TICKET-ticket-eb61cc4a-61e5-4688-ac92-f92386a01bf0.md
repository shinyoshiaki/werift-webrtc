# WARP 非依存の SCTP / SRTP 修正を develop へバックポートする

元チケット: `71cc0e0d-e203-4057-816d-a89b993faf26`（epic4-warp-webrtc-detailed、ブランチ `epic4-warp-webrtc-detailed`）。
WARP（DTLS readiness / early data / SPED / DTLS role 基準の SCTP）に依存せず、develop の既存実装にもそのまま存在する問題の修正だけを develop へ移す。

## 対象

### 1. SCTP の INIT 衝突と verification tag（`packages/sctp/src/sctp.ts`）

develop の問題:
- `start()` 前に相手の INIT に INIT_ACK で答えると相手の verification tag を覚え、その後 `start()` で送る自分の INIT にもその tag を付ける。RFC 9260 §8.5.1 (A) では INIT の verification tag は 0 でなければならず、受信側は破棄し得る。
- initiator（COOKIE-WAIT / COOKIE-ECHOED）は相手の INIT と COOKIE_ECHO を無視する。両端が INIT を送る衝突（RFC 9260 §5.2.1、usrsctp / dcsctp は両端から INIT を送る）で、相手の INIT に答えた後に自分も initiator になると、どちらも ESTABLISHED に進めなくなる。
- 相手の INIT で確立済みでも、遅れた `start()` が INIT を送り直す。
- `init()` は INIT の送信完了後に T1 と COOKIE-WAIT へ入るため、送信中に届いた INIT_ACK を捨て、送信失敗時は T1 が動かず再送されない。COOKIE_ECHO も同様に送信後に COOKIE-ECHOED へ入る。

修正:
- INIT は常に tag 0 で送る。自分の tag が付いた INIT（旧 werift が送る）も受け付ける。
- initiator も相手の INIT に INIT_ACK で答え、その後の COOKIE_ECHO を受け入れて T1 を止める。
- 相手の INIT で確立済みなら `start()` は INIT を送らない。
- INIT / COOKIE_ECHO は状態遷移と T1 開始を送信前に行い、送信失敗は T1 の再送に任せる。COOKIE_ACK は送信前に ESTABLISHED へ進む。

対象外（WARP 固有）: `SCTPSendPermissionRevokedError` / `cancelStart()` / `startCommitted` / `startPassiveFallbackInit()` / `retransmitStartNow()`、DTLS role 基準の SCTP 開始側と DataChannel stream ID の割り当て。

### 2. SRTP / SRTCP の受信 replay 保護（`packages/rtp/src/srtp`）

develop の問題: 受信側に RFC 3711 §3.3.2 の replay list がなく、認証に通る同じ SRTP / SRTCP パケットを再送されると何度でも上位へ渡す。

修正: SSRC ごとに 1024 パケット（`SRTP_REPLAY_WINDOW_SIZE`。libwebrtc と同じで、RFC 3711 の最小値 64 より広く、遅れた NACK 再送も受理できる）の replay window（`SrtpReplayWindow`）を持ち、既に受け取った index と window より古い index を `SrtpReplayError`（`SrtpAuthenticationError` の subclass）で拒否する。window は認証成功後にだけ作成・更新し、偽造パケットで状態が増えないようにする。

## 調査したがバックポートしないもの

- DTLS `[1.3, 1.2]` client の extended_master_secret 提示、ICE restart 中の旧 selected pair 保持、`IceTransport.close()` の二重 close guard: develop に DTLS 1.3 / WARP の datagram gate がない、または develop に既に同じ guard がある。
- DataChannel stream ID の割り当て変更と SCTP の passive fallback INIT: Epic 4 で SCTP の開始側を DTLS role に変えたことに伴う変更。develop は ICE role のまま。

## 完了条件

- [ ] 各問題を develop 上のテストで再現し（修正前に失敗）、修正後に成功することを確認する。
- [ ] テストは Arrange / Act / Assert で書き、Arrange は各 package の `tests/utils.ts` に置く。Act / Assert に日本語コメントを付ける。
- [ ] `packages/sctp`、`packages/rtp`、`packages/webrtc` のテストと型検査、`npm run doc:check` を実行する。
- [ ] 公開 API 追加（`SrtpReplayError`、`SrtpReplayWindow`、`SRTP_REPLAY_WINDOW_SIZE`）に合わせて生成 docs と `changelog.md` を更新する。