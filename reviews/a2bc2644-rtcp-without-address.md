---
ide:
  viewer: review-document
  version: 1
  title: "a=rtcp アドレス省略形式対応 (#355)"
  dock: right
  baseCommit: 9cc2d66322c52674d0c9012c2f594c88db76a424
---
# a=rtcp のアドレス省略形式対応 (#355) レビュー解説

## 1. 概要

RFC 3605 で許される `a=rtcp:<port>`（アドレス省略）を、例外なくパース・再シリアライズできるようにしました。あわせて、`a=rtcp-mux` が `a=rtcp` の有無に引きずられて消える不具合を直し、不正な `a=rtcp` は原因のわかるエラーで拒否します。
RingCentral など SIP/WebRTC ゲートウェイの offer（`a=rtcp:48037`）で `setRemoteDescription()` が `"exception"` で失敗していた問題が解消します。

## 2. 修正前後の流れ

<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px">
<div style="border:1px solid #d33;border-radius:8px;padding:10px">
<b style="color:#d33">Before</b><br>
<code>a=rtcp:53020</code><br>↓ <code>divide(value," ")</code> の残りは空文字<br>↓ <code>ipAddressFromSdp("")</code><br>
<b style="color:#d33">throw new Error("exception")</b> → setRemoteDescription 失敗<br><br>
再出力: <code>if (rtcpPort &amp;&amp; rtcpHost)</code> の内側にだけ <code>a=rtcp</code> と <code>a=rtcp-mux</code><br>
<b style="color:#d33">host なしだと a=rtcp-mux も消える</b>
</div>
<div style="border:1px solid #2a9d4b;border-radius:8px;padding:10px">
<b style="color:#2a9d4b">After</b><br>
<code>a=rtcp:53020</code><br>↓ <code>rtcpAttributeFromSdp</code>（1 or 4 トークン、port 1–65535 を検証）<br>↓ <code>{port:53020, host:undefined}</code><br>
<b style="color:#2a9d4b">パース成功。host は継承せず undefined のまま保持</b><br><br>
再出力: <code>rtcpPort !== undefined</code> で <code>a=rtcp:53020</code>、<code>rtcpMux</code> は独立して <code>a=rtcp-mux</code><br>
<b style="color:#2a9d4b">省略形式も rtcp-mux も保持</b>
</div>
</div>

図の要点: 分岐点は `case "rtcp"` のトークン数判定と、`toString()` の出力条件の分離です。

## 3. 主要変更

- パース: [packages/webrtc/src/sdp.ts:222](review-diff:packages/webrtc/src/sdp.ts:222) の `case "rtcp"` が `rtcpAttributeFromSdp()` を呼びます。トークンは 1 個（port のみ）か 4 個（`port IN IP4|IP6 addr`）だけ許可し、それ以外は `` invalid a=rtcp attribute: "..." `` を投げます。アドレス部は FQDN も受理します。`c=` で使う `ipAddressFromSdp()` は変更していません。
- 型保持: [packages/webrtc/src/sdp.ts:425](review-diff:packages/webrtc/src/sdp.ts:425) に `rtcpAddrType` を追加しました。`IN IP4 host.example.com` が再出力で `IP6` に化けないようにするためです。TSDoc に RFC 3605 の継承規則（`rtcpHost ?? media.host ?? session.host`）を記述しています。
- シリアライズ: [packages/webrtc/src/sdp.ts:539](review-diff:packages/webrtc/src/sdp.ts:539) で `a=rtcp` の条件を `rtcpPort !== undefined` にし、`a=rtcp-mux` を独立出力にしました（行順序は変更なし）。
- 関数定義: [packages/webrtc/src/sdp.ts:655](review-file:packages/webrtc/src/sdp.ts:655) の `rtcpAttributeFromSdp` と `rtcpAttributeToSdp`。
- 拒否 m-line: [packages/webrtc/src/sdpManager.ts:156](review-diff:packages/webrtc/src/sdpManager.ts:156) で `media.rtcpMux = true` を削除しました。シリアライズ修正後に、拒否 m-line（port 0）へ `a=rtcp-mux` が新たに出てしまうのを防ぐためです。
- テスト: [packages/webrtc/tests/sdp.test.ts](review-diff:packages/webrtc/tests/sdp.test.ts)（パーサー／シリアライザー単体）、[packages/webrtc/tests/issue/355.test.ts](review-diff:packages/webrtc/tests/issue/355.test.ts)（RingCentral 実 SDP で setRemoteDescription / createAnswer / RTP 配送）、共有 Arrange は [packages/webrtc/tests/sdpUtils.ts](review-diff:packages/webrtc/tests/sdpUtils.ts)。
- ドキュメント: [changelog.md](review-diff:changelog.md)、`doc/classes/MediaDescription.md`、`doc/functions/rtcpAttribute*.md` を `npm run doc` で再生成しています。

## 4. 判断理由

- 省略時の `rtcpHost` を `c=` の値で埋めない: 埋めると再シリアライズで省略形を保てないためです。werift 内部で `rtcpHost` を読む箇所は `sdpManager.ts` の書き込みのみで、新しい公開 getter は追加していません。
- addrtype とアドレスの整合（`IP4` に IPv6 リテラルなど）は検証しません。FQDN が connection-address として有効なためです。
- 不採用案: 拒否 m-line にも `a=rtcp-mux` を出す案。negotiation テストの更新と E2E 相互接続確認が必要になるため、従来の出力を保つ案を採用しました。

## 5. レビュアーが確認すべき点・リスク

- 厳格化: これまで通っていた port 0、非数値、2・3 トークン、`IN` 以外の nettype、先頭・末尾・連続空白付きの `a=rtcp` は新たにエラーになります。実機 SDP で空白が混ざる場合は `trim` の検討が必要です。
- 出力差: 拒否 m-line の `a=rtcp-mux` を出さない挙動は従来と同じですが、`rtcpMux` を持つ通常 m-line で `a=rtcp` なしの SDP は、これまで消えていた `a=rtcp-mux` が出るようになります（受信 SDP の再現性は向上）。
- 公開 API: `rtcpAttributeFromSdp` / `rtcpAttributeToSdp` が公開関数としてドキュメントに現れ、`MediaDescription.rtcpAddrType` が追加されました。

## 6. 検証結果

- 実行: `cd packages/webrtc && npx vitest run tests/sdp.test.ts tests/issue/355.test.ts tests/issue/705.test.ts tests/issue/705-reuse.test.ts` → 4 ファイル 107 テストすべて成功（HEAD 9cc2d6632）。
- 未実行: `npm run type`、`npm run test:small` 全体、E2E、WPT は今回の文書作成では実行していません。
