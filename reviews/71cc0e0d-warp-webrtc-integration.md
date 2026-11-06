---
ide:
  viewer: review-document
  version: 1
  title: "Epic 4: WARP 対応 WebRTC transport 統合の解説"
  dock: right
  baseCommit: 9633c96628d9d28952ddd47df5318a4ed8b4d1ea
---
# Epic 4: WARP 対応 WebRTC transport 統合（最終承認時の解説）

## 1. 概要

`sped: true` の接続で ICE と DTLS 1.3 を並行して進めつつ、**SDP fingerprint の検証前には application data・RTP・RTCP を上位へ一件も渡さない**ように、`RTCPeerConnection` 層へ統合したブランチです。仕様は [epic4-warp-webrtc-detailed.md](review-file:epic4-warp-webrtc-detailed.md:1) と [TICKET-epic4-warp-webrtc-detailed.md](review-file:TICKET-epic4-warp-webrtc-detailed.md:1) にあります。

このブランチは `develop` に対して約 480 ファイル、約 16 万行の差分があります。そのため、この文書は全体の構造を短く示したうえで、**最終の `develop` マージ（`8be1f7a44`）以降のレビュー修正**を中心に説明します。前回（HEAD `35c940f7a`）までの 8 件に加え、今回の再レビュー（2 回目、HEAD `9633c9662`）で、ICE restart 後の KeyUpdate の ACK が送れず接続が失敗する問題（⑨・⑩）を直しました。この 2 件で指摘がすべて解消され、最終承認に至りました。

前回までの解説で扱った内容（DTLS 1.3 の readiness を 3 段階に分けた設計、受信側の gate、SPED の最終 ACK の送り方など）の詳細は [reviews/epic4-warp-verification.md](review-file:reviews/epic4-warp-verification.md:1) と [reviews/epic4-warp-rfc-implementation.md](review-file:reviews/epic4-warp-rfc-implementation.md:1) にあります。

## 2. 全体構成

```text
RTCPeerConnection          接続試行・ICE/DTLS/SCTP orchestration
  └─ RTCDtlsTransport      SDP fingerprint、application/media release gate
       └─ DtlsSocket       DTLS version selection、暗号学的 readiness
            └─ ICE/SPED    carrier、nomination、ICE generation
```

DTLS の準備状態は単調増加する 3 段階（`writeReady` / `peerHandshakeAuthenticated` / `handshakeComplete`）に分かれています。WebRTC 側の gate は、このうち SDP fingerprint の検証後にだけ受信を開きます。TURN relay 上の WARP と、汎用の SDP/BUNDLE 再交渉は、チケットのスコープ外です。

## 3. レビュー修正（①〜⑧は前回まで、⑨・⑩が今回の再レビュー）

<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px">
  <div style="padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px"><strong>① P1 setConfiguration</strong><br>WARP 無効でも <code>ReferenceError</code>。変数の受け取り漏れ。</div>
  <div style="padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px"><strong>② P2 経路選択テスト</strong><br>準備条件が保証されず、タイムアウトしていた。</div>
  <div style="padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-warning);border-radius:6px"><strong>③ SPED transport の解放</strong><br>stop 時に ICE 購読が残る。</div>
  <div style="padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-warning);border-radius:6px"><strong>④ ICE の二重 close</strong><br>マージで guard が消えていた。</div>
  <div style="padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px"><strong>⑤ 旧 werift と SCTP</strong><br>INIT 送信側が食い違うと DataChannel が開かない。</div>
  <div style="padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-warning);border-radius:6px"><strong>⑥ 完了条件の検証</strong><br>early 保留・接続マトリクス・旧リリース相互接続のテスト追加。</div>
  <div style="padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px"><strong>⑦ P1 遅れた nomination</strong><br>最終 ACK が placeholder 宛先で失効し DTLS が失敗。</div>
  <div style="padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px"><strong>⑧ P2 readiness / doc:check</strong><br>途中 close で到達状態が書き換わる。JSDoc 配置で doc:check 失敗。</div>
  <div style="padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px"><strong>⑨ ICE restart と KeyUpdate（今回）</strong><br>別の 5-tuple へ移ると ACK の宛先が合わず、2 秒で失効し DTLS が失敗。</div>
  <div style="padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px"><strong>⑩ 旧候補が一覧に残る場合（今回）</strong><br>⑨の修正では、未認証のまま残った旧候補を宛先として維持してしまう。</div>
</div>

### 3.1 `setConfiguration()` の例外（①）

`mergePeerConfiguration()` の戻り値を受け取っておらず、`normalizedConfig` が未定義のまま参照されていました。`pc.setConfiguration({ iceServers: [] })` が WARP 無効でも `ReferenceError` になる回帰です。[packages/webrtc/src/peerConnection.ts:534](review-diff:packages/webrtc/src/peerConnection.ts:534) で戻り値を受け取るようにしました。あわせて、`sped` や `warp` の不正な組み合わせが constructor と `setConfiguration()` で同期的に throw し、設定を変更しないことを [packages/webrtc/src/api/peerConfig.ts:124](review-file:packages/webrtc/src/api/peerConfig.ts:124) の JSDoc と README に明記しました。

### 3.2 transport 停止時の解放（③・④）

- **SPED transport（③）:** [packages/webrtc/src/transport/dtls.ts:1468](review-diff:packages/webrtc/src/transport/dtls.ts:1468) の `runStop()` の `finally` で、ICE 停止の後に SPED transport を閉じて参照を外します。`dtls.close()` が失敗しても、ICE の datagram / state 購読が残りません。close_notify を拒否しないよう、閉じるのは ICE 停止の後です。
- **ICE の二重 close（④）:** `warp` ブランチにあった `if (this.closed) return;` と `ice.state !== "closed"` の guard が、`IceTransport` のファイル分割時にマージで落ちていました。[packages/webrtc/src/transport/dtls-ice-transport.ts:72](review-diff:packages/webrtc/src/transport/dtls-ice-transport.ts:72) に戻しました。DTLS socket は teardown のたびに `transport.close()` を呼ぶ設計（"Double-close is fine"）なので、この guard に依存しています。

### 3.3 旧 werift との SCTP 互換（⑤）

現行は DTLS server を SCTP の INIT 送信側にします。一方、公開済みの旧 werift は ICE role で決めます。両者の対応がずれると、両端が INIT を送って互いに無視するか、両端が INIT を待つだけになり、association が確立しませんでした。

<div style="display:flex;gap:12px;flex-wrap:wrap">
  <div style="flex:1;min-width:240px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px">
    <strong>Before</strong><br>initiator は相手の INIT / COOKIE_ECHO を無視。passive は INIT を待つだけ。→ 15 秒経っても DataChannel が開かない。
  </div>
  <div style="flex:1;min-width:240px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px">
    <strong>After</strong><br>initiator は INIT に INIT_ACK で答える（RFC 9260 §5.2.1）。DTLS client は認証の 1 秒後に INIT が届かなければ自分で送る。→ 3 秒未満で開く。
  </div>
</div>

- [packages/sctp/src/sctp.ts:422](review-diff:packages/sctp/src/sctp.ts:422): COOKIE-WAIT / COOKIE-ECHOED の initiator が相手の INIT を受け付けます。続く COOKIE_ECHO の受理は [packages/sctp/src/sctp.ts:560](review-diff:packages/sctp/src/sctp.ts:560) にあります。
- [packages/sctp/src/sctp.ts:1517](review-diff:packages/sctp/src/sctp.ts:1517): `startPassiveFallbackInit()` は、相手の INIT が未着で `CLOSED` のときだけ INIT を送ります。
- [packages/webrtc/src/transport/sctp.ts:41](review-diff:packages/webrtc/src/transport/sctp.ts:41): `PASSIVE_INIT_FALLBACK_MS = 1000` と、DTLS client 側のタイマー（[packages/webrtc/src/transport/sctp.ts:585](review-file:packages/webrtc/src/transport/sctp.ts:585)）です。認証前には送りません。DTLS client には early 送信の許可がないためです。

### 3.4 SPED / ICE-TCP で nomination が遅れる場合（⑦）

DTLS client は `connect()` の時点で宛先を固定します。pair の選択前は placeholder（port 0）が `127.0.0.1:0` として保持されます。handshake 後・nomination 前の最終 ACK は、この宛先で認証済み pair を照合するため一致せず、キューに 2 秒残って失効し、DTLS が致命的エラーになっていました。ICE-TCP の regular nomination では、nomination だけが遅れる状況が実際に起きます。

[packages/webrtc/src/transport/sped.ts:616](review-diff:packages/webrtc/src/transport/sped.ts:616) の `resolveAuthenticatedSendPair()` で、port 0 の宛先を「宛先なし」として扱い、現世代の認証済み pair へ送ります。実在する宛先の照合規則は変えていません。判定は [packages/webrtc/src/transport/sped.ts:704](review-file:packages/webrtc/src/transport/sped.ts:704) の `isPlaceholderAddress()` です。この処理は、今回の ⑨ で `send()` から `resolveAuthenticatedSendPair()` へ移りました（送信時とキューの flush の両方で効かせるため）。

### 3.5 handshake 途中の close と readiness（⑧）

1.3 engine を破棄した後の `readiness` が、DTLS 1.2 用の単一 latch を 3 つの milestone すべてに適用していました。そのため、最終 ACK 未受信の client では `handshakeComplete` が true になり、server では到達済みの `writeReady` が false に戻っていました。

[packages/dtls/src/socket.ts:1219](review-diff:packages/dtls/src/socket.ts:1219) の `retireSelectedEngine13()` が、破棄前に milestone ごとの到達状態を保存します。保存値は [packages/dtls/src/socket.ts:150](review-file:packages/dtls/src/socket.ts:150) の `readiness` getter が使います。呼び出しは `failAssociationFromEngine13`（[packages/dtls/src/socket.ts:1267](review-file:packages/dtls/src/socket.ts:1267)）、`onEngine13PeerOrLocalClose`（[packages/dtls/src/socket.ts:1304](review-file:packages/dtls/src/socket.ts:1304)）、client の `closeAllDtls13Candidates`（[packages/dtls/src/client.ts:294](review-file:packages/dtls/src/client.ts:294)）の 3 か所です。

最後のコミット（`35c940f7a`）では、`unbridgeEngine13()` の JSDoc の直後に別の JSDoc が入って生成 docs が崩れ、`npm run doc:check` が失敗していた点を直しました。

### 3.6 ICE restart で別の 5-tuple へ移った後の KeyUpdate（⑨・⑩、今回）

DTLS が保持する宛先は、経路ではなく association の相手を指します。ICE restart で別の 5-tuple（例: IPv4 から IPv6）へ移っても、この宛先は更新されません。nomination が遅れている間に KeyUpdate を受けると、その ACK の宛先に一致する認証済み pair がなく、キューに 2 秒残って失効し、DTLS が致命的エラーになっていました。`warp` ではこの経路が宛先を使わず `ice.send()` を呼んでいたため、同じ状況でも失敗しません。

<div style="display:flex;gap:12px;flex-wrap:wrap">
  <div style="flex:1;min-width:240px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px">
    <strong>Before（⑨の最初の修正後）</strong><br>一覧に無い宛先だけを「宛先なし」にする。旧候補（IPv4）が未認証のまま一覧に残ると、DTLS の旧宛先がそれを指して維持され、ACK を送れない。
  </div>
  <div style="flex:1;min-width:240px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px">
    <strong>After（⑩）</strong><br>handshake 後は宛先を優先候補としてだけ扱う。現世代の認証済み pair を、宛先が指す pair → nominated → 固定した SPED 経路 → 一覧の任意の pair の順に選ぶ。
  </div>
</div>

- [packages/webrtc/src/transport/sped.ts:611](review-diff:packages/webrtc/src/transport/sped.ts:611): `resolveAuthenticatedSendPair()` は、placeholder を宛先なしにしたうえで、`applicationReady`（handshake 後）なら `resolveEstablishedSendPair()` に分岐します。handshake 中の規則（明示的な宛先が認証済み pair の外なら送らない、固定経路を所有境界にする）は変えていません。
- [packages/webrtc/src/transport/sped.ts:666](review-diff:packages/webrtc/src/transport/sped.ts:666): `resolveEstablishedSendPair()` が上の順序で現世代の認証済み pair を選びます。「現世代の認証済み」の判定は既存の `isCurrentAuthenticatedPair()` です。旧世代の `lastPath` は所有境界にならず、現世代の pair でなければ選ばれません。
- テストの Arrange は [packages/webrtc/tests/integrate/warpArrange.ts:1636](review-diff:packages/webrtc/tests/integrate/warpArrange.ts:1636) の `prepareMigratingSpedPeers()` です。IPv4 で接続後に IPv6 だけを許可して restart し、controlling 側の nomination 応答の処理を遅らせます。`retainIpv4` では IPv4 の候補を一覧に残しつつ、その経路への要求を失敗させます。
- [packages/webrtc/tests/integrate/spedMigratedKeyUpdate.test.ts:5](review-file:packages/webrtc/tests/integrate/spedMigratedKeyUpdate.test.ts:5): 一覧から旧候補が消える場合と残る場合の 2 通りで、nomination が 2 秒超遅れる間に KeyUpdate しても、接続と双方向の DataChannel が保たれ、両側が IPv6 を使うことを確認します。
- [packages/webrtc/tests/transport/sped.test.ts:644](review-file:packages/webrtc/tests/transport/sped.test.ts:644): 単体で、旧宛先・旧世代の固定経路のみ、旧候補が未認証で残る、宛先が現世代の pair を指す、の 3 通りを確認します。

### 3.7 そのほか

- **経路選択テスト（②）:** ICE は nomination 後に残りのチェックを終了するため、両 family の `SUCCEEDED` を要求すると待ち続けます。準備条件を [packages/webrtc/tests/integrate/warpArrange.ts](review-file:packages/webrtc/tests/integrate/warpArrange.ts:1) の Arrange で保証する形に直しました。
- **完了条件の検証（⑥）:** 次のテストを追加しました。
  - [packages/webrtc/tests/integrate/earlyOutboundBoundary.test.ts](review-file:packages/webrtc/tests/integrate/earlyOutboundBoundary.test.ts:1): early outbound 無効時に、writeReady から fingerprint 認証まで application record を送らないこと。
  - [packages/webrtc/tests/integrate/connectionMatrix.test.ts](review-file:packages/webrtc/tests/integrate/connectionMatrix.test.ts:1): DTLS role × Full/Lite × SPED × DTLS version の 16 通り。
  - [packages/webrtc/tests/integrate/legacyWeriftRelease.test.ts](review-file:packages/webrtc/tests/integrate/legacyWeriftRelease.test.ts:1): npm の `werift@0.26.0` との相互接続（opt-in）。
- **`changelog.md`・`doc/`:** DTLS 1.3 / SPED / WARP の設定、`RTCTransportStats` の追加項目、SCTP role 変更の互換性を追記し、`npm run doc` で生成物を更新しています。

## 4. 判断理由

- **SCTP で fallback を入れた理由:** 旧 werift の挙動は変えられません。そのため、新しい側で RFC 9260 §5.2.1 の衝突処理を受け入れ、INIT が届かない場合は自分で送ることにしました。DTLS role を使う仕様（RFC 8832 §6）は維持しています。
- **placeholder 宛先を「宛先なし」にした理由:** `warp` では、この経路が宛先を使わず `ice.send()` を呼んでいました。宛先の照合規則そのものを緩めると、実在しない pair への誤送信を許すため、port 0 だけを特別扱いにしました。
- **readiness を milestone ごとに保存した理由:** 1.2 の latch は 3 つを同時に true にします。1.3 の途中状態の代わりに使うと、未到達の milestone を到達済みに見せるためです。
- **handshake 後は宛先を優先候補にする理由（⑩）:** ⑨の最初の修正（一覧に無い宛先だけを無視）では、旧候補が未認証で残る場合を拾えませんでした。DTLS の宛先は経路を決めるものではなく、経路は ICE が決める（`warp` の `ice.send()` と同じ）ためです。handshake 中の「認証済み pair の外へは送らない」規則は、誤送信防止のため変えていません。
- **スコープ外:** TURN relay 上の WARP と、汎用の SDP/BUNDLE 再交渉は扱いません（後者は [TICKET-webrtc-existing-negotiation-issues.md](review-file:TICKET-webrtc-existing-negotiation-issues.md:1) に分離）。

## 5. レビュアーが確認すべき点・リスク

- **role がずれる組み合わせの stream ID:** 旧 werift との組み合わせで ICE role と DTLS role がずれると、両端が同じ parity の stream ID を選び得ます。両側から同時に in-band で DataChannel を開くと ID が衝突し得ます。negotiated channel で ID を明示すれば避けられます（`changelog.md` に記載）。
- **SCTP の状態遷移:** [packages/sctp/src/sctp.ts:422](review-file:packages/sctp/src/sctp.ts:422) の条件変更は、passive 側の既存挙動（`isServer` の場合）を変えていないか確認してください。遅れた `start()` が確立済み association に INIT を再送しない条件も見てください。
- **公開 API・docs:** `PeerConfig`、`RTCTransportStats`、`PASSIVE_INIT_FALLBACK_MS`（[doc/variables/PASSIVE_INIT_FALLBACK_MS.md](review-file:doc/variables/PASSIVE_INIT_FALLBACK_MS.md:1)）が追加されています。`doc/`・README・`changelog.md` が一致していることを確認してください。
- **既存経路:** `RTCDtlsTransport` の分割（`dtls-*.ts`）が `sped: false` の経路を回帰させていないかを、`develop` との差分で確認してください。
- **handshake 後の送信先（今回）:** [packages/webrtc/src/transport/sped.ts:666](review-file:packages/webrtc/src/transport/sped.ts:666) は、宛先が指す pair が使えないとき、他の認証済み pair へ送ります。宛先の不一致を無視してよいのは handshake 後だけで、handshake 中の規則が変わっていないことを確認してください。
- **未特定の不具合:** 並列探索中に 1 件失敗した scenario seed 123（`negotiationScenarioProperty.test.ts`）は、単独 5 回と seed 100〜149 の 50 件で再現しませんでした。原因は特定していません。
- **未検証:** Pion との相互接続。TURN relay 上の WARP（スコープ外）。

## 6. 検証結果

**この文書の作成時に実行したもの（HEAD `9633c9662`）:**

| コマンド | 結果 |
|---|---|
| `packages/webrtc`: `vitest run tests/transport/sped.test.ts tests/integrate/spedMigratedKeyUpdate.test.ts --retry 0` | 2 ファイル 36 passed |
| `npm run doc:check`（root） | 終了コード 0（TypeDoc の警告 28 件、エラー 0） |

**検証記録 [reviews/epic4-warp-verification.md](review-file:reviews/epic4-warp-verification.md:1) からの転記（この文書の作成時に再実行していません）:**

| 内容 | 記録された結果 |
|---|---|
| §22 ICE restart 後の KeyUpdate（旧候補が消える場合） | 修正前は両 peer が `failed`、修正後は成功 |
| §23 旧候補が一覧に残る場合 | 修正前は失敗、修正後は成功。再現スクリプトも exit 0 |
| §16 `packages/webrtc` の `npm test` | 1,851 passed / 6 skipped（⑨・⑩の修正前の記録） |
| §18 SCTP role 不一致のテスト | 修正前に失敗、修正後に成功 |
| §19 接続マトリクス 16 通り / `werift@0.26.0` との相互接続 | 16/16 成功 / 5 組み合わせ成功 |
| §20 遅れた nomination、§21 handshake 途中の close | いずれも修正後に成功 |
| §15（それ以前の最終確認）`wpt` / `e2e` / leak property | REGRESSION 0 / 63 + 18 / 450 passed |

**未実施・未確認:** Pion との相互接続（自動ビルドが「local pion-sped is missing or incompatible」で起動しません）。`packages/webrtc` 全体のテスト、`wpt`、`e2e` は、⑨・⑩の修正後の HEAD で再実行していません。scenario seed 123 の失敗の原因も未特定です。
