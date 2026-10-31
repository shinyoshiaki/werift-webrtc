---
ide:
  viewer: review-document
  version: 1
  title: "Epic 4: WARP 対応 WebRTC transport 統合の解説"
  dock: right
  baseCommit: 2e046861f49c9b779022ac93abe8c5ff4bb7a891
---
# Epic 4: WARP 対応 WebRTC transport 統合（再レビュー 4 回目の解説）

## 1. 概要

`sped: true` の接続で ICE と DTLS 1.3 を並行して進めつつ、**SDP fingerprint の検証前には application data・RTP・RTCP を上位へ一件も渡さない**ように、`RTCPeerConnection` 層へ統合しました。そのために DTLS 1.3 の準備状態を 3 段階（書き込み可・相手認証済み・handshake 完了）に分け、WebRTC 側の gate でそれぞれを使い分けています。

今回の差分（直近 3 コミット、`10959a75c`〜[`2e046861f`](review-file:epic4-warp-webrtc-detailed.md:1)）は、レビュー指摘を受けた次の 3 点の修正です。

- DTLS 1.3 server が、最終 ACK を実際に送る前に完了と判定していた問題の修正
- ICE の closed 通知 Promise がエージェントの寿命のあいだ残る問題の修正
- 書き込み可能になった時点を、SCTP と独立に DTLS transport へ反映

仕様の全体は [epic4-warp-webrtc-detailed.md](review-file:epic4-warp-webrtc-detailed.md:1) と [TICKET-epic4-warp-webrtc-detailed.md](review-file:TICKET-epic4-warp-webrtc-detailed.md:1) にあります。このブランチは `develop` に対して 460 ファイル、約 16 万行の差分があります。そのため、この文書は構造の説明と今回の修正点に絞っています。

## 2. 構成

```text
RTCPeerConnection          接続試行・ICE/DTLS/SCTP orchestration
  └─ RTCDtlsTransport      SDP fingerprint、application/media release gate
       └─ DtlsSocket       DTLS version selection、暗号学的 readiness
            └─ ICE/SPED    carrier、nomination、ICE generation
```

<div style="display:flex;gap:12px;flex-wrap:wrap">
  <div style="flex:1;min-width:220px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px">
    <strong>Before</strong><br>DTLS の <code>connected</code> が「書き込める」「相手を認証した」「完了した」を兼ねる。<code>onConnect</code> 直後に early data が fingerprint 検証前に上位へ届き得る。
  </div>
  <div style="flex:1;min-width:220px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px">
    <strong>After</strong><br><code>writeReady</code> / <code>peerHandshakeAuthenticated</code> / <code>handshakeComplete</code> を単調増加で分離。受信側は fingerprint 検証後にだけ gate を開く。
  </div>
</div>

## 3. 主要変更

### 3.1 DTLS 1.3 readiness の 3 段階化（packages/dtls）

`readiness` は単調増加する状態で、`writeReady = true` の遷移は [packages/dtls/src/engine/v1_3/connection-base.ts:1026](review-file:packages/dtls/src/engine/v1_3/connection-base.ts:1026) にあります。初期値は [packages/dtls/src/engine/v1_3/connection-base.ts:97](review-file:packages/dtls/src/engine/v1_3/connection-base.ts:97) です。SDP の概念は DTLS engine に持ち込んでいません。証明書や Finished の検証完了を、WebRTC の peer 認証完了とは見なしません。

### 3.2 受信側の gate（packages/webrtc）

- [packages/webrtc/src/transport/dtls-application-gate.ts:4](review-file:packages/webrtc/src/transport/dtls-application-gate.ts:4) の `InboundApplicationGate` が、fingerprint 検証前の application data を保留します。
- [packages/webrtc/src/transport/dtls-fingerprint.ts:46](review-file:packages/webrtc/src/transport/dtls-fingerprint.ts:46) が SDP fingerprint を検証します。
- [packages/webrtc/src/transport/dtls.ts:1073](review-file:packages/webrtc/src/transport/dtls.ts:1073) は検証を呼ぶ側です。
- SRTP は outbound と inbound の許可を分けています（[packages/webrtc/src/transport/dtls-srtp.ts](review-file:packages/webrtc/src/transport/dtls-srtp.ts)、`updateSrtpPermissions()` は [packages/webrtc/src/transport/dtls.ts:204](review-file:packages/webrtc/src/transport/dtls.ts:204) から呼ばれます）。inbound は gate が開いた後だけ復号・配送します。

### 3.3 SPED carrier と最終 ACK（今回の主な修正）

DTLS 1.3 server は、client の Finished を受けると最終 ACK を送ります。DTLS engine は、その送信が成功した時点で「ACK 済み」と見なして完了を判定します。

従来の `IceSpedTransport.sendInternal()` は、ICE の application path が未成立のとき、record をキューに積んで直ちに成功を返していました。その結果、ACK がキューに残ったまま server だけが完了し、相手は完了しない状態になり得ました。

- 修正の核は [packages/webrtc/src/transport/sped.ts:232](review-diff:packages/webrtc/src/transport/sped.ts:232) です。制御 record（最終 ACK・alert）は、application path がなくても、相手の record が届いた認証済み pair へ直接送ります（`pinHandshakePath` は [packages/webrtc/src/transport/sped.ts:241](review-file:packages/webrtc/src/transport/sped.ts:241)）。
- 認証済み pair がなければ、キューが実際に送ってから解決します。
- キューの flush にも同じ規則を適用しています（[packages/webrtc/src/transport/sped.ts:539](review-diff:packages/webrtc/src/transport/sped.ts:539)）。
- application record は従来どおり application path を待ち、呼び出し元を止めません。

### 3.4 DTLS transport の write 準備反映

[packages/webrtc/src/transport/dtls.ts:989](review-diff:packages/webrtc/src/transport/dtls.ts:989) で、core の書き込み可能状態を SCTP と独立に反映します。media のみの early server 送信がこれに依存します。送信の許可自体は `updateSrtpPermissions()` が決めます。

### 3.5 ICE の close 通知

[packages/ice/src/ice.ts:1056](review-diff:packages/ice/src/ice.ts:1056) で、常に pending のままだった `closedSignal` Promise をやめました。代わりに、待機ごとに `closing` の abort listener を張って外す `untilSettledOrClosed()` を使います。ICE restart を繰り返しても、完了済みの gathering とその candidate を close 用 Promise が保持し続けません。leak テストの増加分への対応です。

### 3.6 そのほかの構成

`packages/dtls` は DTLS 1.3 本体（handshake、record、server/client、version selection、retransmission）です。`packages/ice/src/sped` は SPED の runtime と draft-00 の codec・session です。`packages/rtp`・`packages/sctp` は replay 判定や SCTP の role 依存の修正です。stats は [packages/webrtc/src/transport/dtls-stats.ts](review-file:packages/webrtc/src/transport/dtls-stats.ts) にまとめています。

## 4. 判断理由

- **readiness を 3 つに分けた理由:** `onConnect` 一つでは、書き込み可能・fingerprint 検証済み・最終 ACK 配送済みを区別できません。区別できないと、検証前の配送が起き得ます。
- **最終 ACK を認証済み pair で直接送る理由:** 「キューに積んだ時点で成功」にすると DTLS の完了判定が実送信とずれます。nomination 中に await すると、ICE の Binding 処理（SPED の inject を await する）と相互に待ち合う恐れがあります。認証済み pair で送ればこの待ち合いは起きません。
- **WPT 向けの厳格化を分離した理由:** AGENTS.md の方針どおり、WPT 専用の strict 挙動は `tools/wpt-runner` に閉じています。
- **スコープ外:** TURN relay 上の WARP は対象外です。既存実装は削除していません。汎用の SDP/BUNDLE 再交渉などは別チケット [TICKET-webrtc-existing-negotiation-issues.md](review-file:TICKET-webrtc-existing-negotiation-issues.md:1) に分離しています。

## 5. レビュアーが確認すべき点・リスク

- 制御 record が application path 成立前に送られる経路（[packages/webrtc/src/transport/sped.ts:232](review-file:packages/webrtc/src/transport/sped.ts:232)）。SPED の認証順序は変えていないか、`application` フラグで制御 record と application record を取り違えていないかを確認してください。
- 公開 API・設定は [packages/webrtc/src/api/peerConfig.ts](review-file:packages/webrtc/src/api/peerConfig.ts) に追加があります。`doc/`、`packages/*/doc`、`changelog.md` が一致しているか確認してください。
- `RTCDtlsTransport` の大規模なリファクタ（`dtls-*.ts` への分割）があります。既存の `sped: false` 経路を回帰させていないかを見てください。
- early server outbound は明示 opt-in です。既定値が変わっていないことを確認してください。
- Pion との相互接続は未検証です（後述）。

## 6. 検証結果

既存の検証記録 [reviews/epic4-warp-verification.md](review-file:reviews/epic4-warp-verification.md:1) の末尾（§15、`fa7cf5c77` + 最終 ACK 修正の作業ツリー）に、実行済みの結果があります。以下はそこからの転記で、**この文書の作成時に再実行したものではありません**。

| 確認 | 結果 |
|---|---|
| `--retry 0`: common / ice / dtls / rtp / sctp / webrtc / ice-server | 65 / 405 / 462 / 408 / 71 / 1,160 / 45 passed |
| `transportFaultMatrix.test.ts` | 90/90 |
| `type`・`lint:imports`・`doc:check` | 成功 |
| `e2e` | 63 + 18 |
| `wpt` | REGRESSION 0（PASS 442） |
| leak property（seed 1〜200） | 450 passed |
| heap property（seed 1〜8、200 cycle） | 8/8 成功 |

最終 ACK 修正の回帰テストは [packages/webrtc/tests/integrate/spedFinalAck.test.ts](review-file:packages/webrtc/tests/integrate/spedFinalAck.test.ts:1) と [packages/webrtc/tests/transport/sped.test.ts](review-file:packages/webrtc/tests/transport/sped.test.ts:1) です。どちらも修正を外すと失敗します。

**未実施・未確認:**

- Pion との相互接続。自動ビルドが「local pion-sped is missing or incompatible」で起動しませんでした。
- 上記の数値は、最新 HEAD（`2e046861f`）での再実行ではありません。HEAD の直近コミットの内容が検証記録と完全に一致するかは、この文書では確認していません。
