---
ide:
  viewer: review-document
  version: 1
  title: "DTLS close_notify / fatal alert の送受信（#811）"
  dock: right
  baseCommit: 0738d09f9d19d3fdabc5f2d0fadf252d1eccb7dc
---
# DTLS close_notify / fatal alert の送受信（#811）レビュー解説

## 1. 概要

werift はこれまで DTLS の alert を送らず、受けた alert も区別せずに握り潰していました。このため `pc.close()` や証明書 fingerprint 不一致を相手 peer が知るのは、ICE consent が切れる約 30 秒後でした。

本変更で、正常終了は `close_notify`、証明書検証失敗は fatal `bad_certificate` として送信し、受信側は `RTCDtlsTransport.state`（`closed` / `failed`）、SCTP、DataChannel、`connectionState` へ即座に反映します。基準は develop との分岐点 `1f007fe89` から HEAD `0738d09f9` までの差分です（61 ファイル、+6633 / -134。大半はテストと生成ドキュメント）。

## 2. 修正前後の流れ

<div style="display:flex;gap:16px;flex-wrap:wrap;font-family:sans-serif;font-size:13px">
<svg viewBox="0 0 330 250" width="330" role="img" aria-label="Before">
<text x="10" y="18" font-weight="bold" fill="#c0392b">Before: pc1.close()</text>
<rect x="10" y="30" width="140" height="34" rx="4" fill="#fdecea" stroke="#c0392b"/><text x="18" y="52">runStop(): closed</text>
<rect x="10" y="84" width="140" height="34" rx="4" fill="#fdecea" stroke="#c0392b"/><text x="18" y="106">// todo impl send alert</text>
<rect x="10" y="138" width="140" height="34" rx="4" fill="#eee" stroke="#999"/><text x="18" y="160">iceTransport.stop()</text>
<rect x="180" y="84" width="140" height="34" rx="4" fill="#fdecea" stroke="#c0392b"/><text x="186" y="106">pc2 DTLS: connected</text>
<rect x="180" y="138" width="140" height="34" rx="4" fill="#fdecea" stroke="#c0392b"/><text x="186" y="160">約30秒 ICE consent 切れ</text>
<path d="M80 64V84M80 118V138M150 155H180M250 118V138" stroke="#555" fill="none"/>
<text x="10" y="205" fill="#c0392b">alert は一切送られない</text>
</svg>
<svg viewBox="0 0 330 250" width="330" role="img" aria-label="After">
<text x="10" y="18" font-weight="bold" fill="#1e8449">After: pc1.close()</text>
<rect x="10" y="30" width="140" height="34" rx="4" fill="#eee" stroke="#999"/><text x="18" y="52">markClosed(): 同期</text>
<rect x="10" y="84" width="140" height="34" rx="4" fill="#eafaf1" stroke="#1e8449"/><text x="18" y="106">close_notify 送信(≤100ms)</text>
<rect x="10" y="138" width="140" height="34" rx="4" fill="#eee" stroke="#999"/><text x="18" y="160">dtls.close → ICE stop</text>
<rect x="180" y="84" width="140" height="34" rx="4" fill="#eafaf1" stroke="#1e8449"/><text x="186" y="106">onAlert → closed</text>
<rect x="180" y="138" width="140" height="34" rx="4" fill="#eafaf1" stroke="#1e8449"/><text x="186" y="160">SCTP / DataChannel closed</text>
<path d="M80 64V84M80 118V138M150 101H180M250 118V138" stroke="#555" fill="none"/>
<text x="10" y="205" fill="#1e8449">fingerprint 不一致は bad_certificate → 両 peer failed</text>
</svg>
</div>

凡例: 赤は問題のある経路、緑は変更で追加された経路、灰色は変更なしです。図は `pc.close()` の流れで、送信順は SCTP ABORT → close_notify → ICE 停止です。

## 3. 主要変更

### packages/dtls

- Alert の型・生成・分類を新ファイル [packages/dtls/src/alert.ts:1](review-file:packages/dtls/src/alert.ts:1) にまとめました。`DtlsAlertError`（`source: "local" | "remote"`）、`createAlertRecord`（epoch 0 は平文、epoch > 0 は暗号化）、`classifyAlert`（close / ignore / fatal）があります。
- 受信処理は [packages/dtls/src/record/receive.ts](review-diff:packages/dtls/src/record/receive.ts) で、暗号化の判定を「description が未知か」から `record epoch > 0` に変えました。復号失敗や古い epoch の alert は捨て、1 record 内の複数 alert を順に返し、throw はしません。
- [packages/dtls/src/socket.ts:521](review-file:packages/dtls/src/socket.ts:521) の `close({ notify, timeoutMs })` と `sendAlert()` を追加しました。引数なしの `close()` は alert を送らず従来どおりですが、送信中の alert の完了またはタイムアウトを待ってから閉じます。差分は [packages/dtls/src/socket.ts](review-diff:packages/dtls/src/socket.ts) です。
- `Options.verifyRemoteCertificate` を [packages/dtls/src/socket.ts:391](review-file:packages/dtls/src/socket.ts:391) から呼び、flight5 / flight6 で handshake 中に証明書を検証します。失敗時は `bad_certificate` を送って中止し、再送も止めます（[packages/dtls/src/flight/client/flight5.ts](review-diff:packages/dtls/src/flight/client/flight5.ts)、[packages/dtls/src/flight/server/flight6.ts](review-diff:packages/dtls/src/flight/server/flight6.ts)）。
- `AlertLevel` を [packages/dtls/src/record/const.ts](review-diff:packages/dtls/src/record/const.ts) に `as const` オブジェクトとして追加しました（`enum` は使っていません）。

### packages/webrtc

- [packages/webrtc/src/transport/dtls.ts:831](review-file:packages/webrtc/src/transport/dtls.ts:831) の `markClosed()` で `closed` を同期に確定し、[packages/webrtc/src/transport/dtls.ts:840](review-file:packages/webrtc/src/transport/dtls.ts:840) の `stop()` で `close_notify`（上限 `DTLS_ALERT_SEND_TIMEOUT_MS = 100`）→ `dtls.close()` → ICE 停止の順に処理します。
- `start()` で `verifyRemoteCertificate` に fingerprint 検証を渡し、完了後の検証は後方互換のフォールバックとして残しました。受信 alert は `fail()` で `failed` にし、`RTCError`（`dtls-failure` / `fingerprint-failure`）を `error` イベントで通知します。差分は [packages/webrtc/src/transport/dtls.ts](review-diff:packages/webrtc/src/transport/dtls.ts) です。
- [packages/webrtc/src/transport/sctp.ts](review-diff:packages/webrtc/src/transport/sctp.ts) に `RTCSctpTransport.state` を追加し、DTLS が `closed` / `failed` になるとアソシエーションを閉じます。`stopped` の場合は ABORT を飛ばさないよう何もしません。
- [packages/webrtc/src/secureTransportManager.ts](review-diff:packages/webrtc/src/secureTransportManager.ts) で、DTLS `failed` を `connectionState: "failed"` へ反映します。`failed` は `closed` 以外のどの状態より優先し、`closed` は最終状態です。peer の `close_notify` だけでは `connectionState` を変えません（W3C が closed を connected と同様に数えるため）。
- 通知は `notifySafely` / `executeIsolated`（[packages/common/src/event.ts](review-diff:packages/common/src/event.ts)）で購読者ごとに隔離し、リスナー例外が後続の内部処理を止めないようにしました。

### WPT / E2E

- [packages/webrtc/wpt/allowlist.json](review-diff:packages/webrtc/wpt/allowlist.json) に `dtls-close`、`dtls-fingerprint-validation`、`RTCDtlsTransport-state` を登録し、baseline を更新しました。`runner.ts` には `AudioContext` の shim と、理由付きで除外する `skippedSubtests` を追加しています（上流 WPT 専用の挙動は wpt-runner に閉じる、という AGENTS.md の方針に沿っています）。
- E2E は [e2e/tests/datachannel/dtlsAlert.test.ts](review-file:e2e/tests/datachannel/dtlsAlert.test.ts) を追加しました。テストは [packages/dtls/tests/alert.test.ts](review-file:packages/dtls/tests/alert.test.ts) と [packages/webrtc/tests/transport/dtlsAlert.test.ts](review-file:packages/webrtc/tests/transport/dtlsAlert.test.ts) が中心です。

## 4. 判断理由

- 証明書検証は handshake 中のフックを採用しました。完了後の検証だけでは相手が既に `connected` になっているためです。フォールバックも残しています。
- 引数なしの `close()` は alert を送らない従来互換としました。`close_notify` を送る経路は `close({ notify: true })` と `RTCDtlsTransport.stop()` に限ります。
- alert 送信の失敗や遅延は reject せず、100 ms で打ち切ります。`pc.close()` が alert のために長く待たされないようにするためです。
- peer の `close_notify` で `connectionState` を変えない点は、W3C の状態集約の定義に合わせています。

## 5. レビュアーが確認すべき点・リスク

- 公開 API が増えます。`DtlsSocket.sendAlert`、`close` のオプション、`Options.verifyRemoteCertificate`、`DtlsAlertError`、`RTCSctpTransport.state`、`RTCError`、`Event.executeIsolated` です。`changelog.md` と生成ドキュメントを更新済みです。
- `pc.close()` は最大 100 ms ほど長くなり得ます。
- `connectionState` で `failed` が他の状態に優先する規則が、複数 transport や再ネゴシエーションで想定どおりか確認してください。
- 範囲外として別チケット化が必要な既知の問題があります。client の ServerKeyExchange 署名と server の CertificateVerify を検証していません（develop も同じ）。能動的な中間者が相手の公開証明書を示すと、fingerprint 検証を通ります。SCTP の `burst.test.ts` の不安定さは develop でも出ます（チケット記載）。

## 6. 検証結果

本文書の作成時に、私はテストを再実行していません。コード・テスト・差分とチケットファイルの記述だけを読んで書いています。チケットの §10 は、`npm run type`、`test:small`、`wpt`、`wpt:coverage`、`e2e`、`doc` を実行する計画としています。その実行結果と合否は、レビュー記録を参照してください。
