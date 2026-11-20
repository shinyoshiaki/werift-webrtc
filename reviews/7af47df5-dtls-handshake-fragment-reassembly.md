---
ide:
  viewer: review-document
  version: 1
  title: "DTLS ハンドシェイクフラグメント再組立て"
  dock: right
  baseCommit: 5b0d5fa7d5a71b4d10cf094817cc91cebafa692c
---
# DTLS ハンドシェイクフラグメントの再組立て: レビューガイド

## 1. 概要

DTLS 1.2 のハンドシェイク再組立てを、受信順ではなく実際のバイト被覆で完了判定するようにしました。以前は「最後に受信したフラグメントが末尾で、バッファに 2 個以上ある」だけで完成扱いにしていたため、大きな ClientHello の末尾フラグメントが先頭より先に届くと、欠けたバイトがゼロ埋めされたまま上位に渡っていました。

新設の `HandshakeReassembler` が `(epoch, msg_type, message_seq, length)` ごとに区間を管理し、`[0, length)` が全て埋まったときだけ完成メッセージを返します。

## 2. 修正前の問題と修正後の仕組み

<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-family:sans-serif;font-size:13px">
<div style="border:2px solid #d9534f;border-radius:8px;padding:10px">
<b style="color:#d9534f">Before: 到着順 [frag2, frag1, frag0]</b>
<ol style="margin:6px 0 0 16px;padding:0">
<li><code>handleFragmentHandshake</code> が全フラグメントを 1 本の配列へ push</li>
<li>frag2 到着 → 件数 1、保留</li>
<li>frag1 到着 → 件数 2、最後が末尾 (<code>offset+len===length</code>) なので完成扱い</li>
<li><code>FragmentedHandshake.assemble()</code> が <code>Buffer.alloc</code> へコピー。frag0 の範囲はゼロのまま</li>
<li style="color:#d9534f"><b>version 0.0 / cipherSuites [] の ClientHello → cipher suite negotiation failed</b></li>
</ol>
</div>
<div style="border:2px solid #2e8b57;border-radius:8px;padding:10px">
<b style="color:#2e8b57">After: 同じ到着順</b>
<ol style="margin:6px 0 0 16px;padding:0">
<li><code>HandshakeReassembler.add()</code> がキー <code>epoch:msg_type:seq:length</code> のエントリへ集約</li>
<li>frag2 到着 → ranges <code>[[2n, L]]</code>、保留</li>
<li>frag1 到着 → ranges <code>[[n, L]]</code>、<b style="color:#2e8b57">先頭が 0 でないので保留</b></li>
<li>frag0 到着 → ranges <code>[[0, L]]</code></li>
<li style="color:#2e8b57"><b>単一フラグメント (offset 0, length L) として返却 → 元バイトと一致</b></li>
</ol>
</div>
</div>
<p style="font-size:12px;color:#666">図: 3 分割の ClientHello が逆順で届いた場合。赤が修正前の失敗経路、緑が修正後の経路です。</p>

## 3. 主要変更

### 再組立て器の新設

[packages/dtls/src/record/message/reassembler.ts:102](review-file:packages/dtls/src/record/message/reassembler.ts:102) の `add()` が中核です。差分は [packages/dtls/src/record/message/reassembler.ts](review-diff:packages/dtls/src/record/message/reassembler.ts:102) にあります。

- 検証: `fragment.length !== fragment_length` と `offset + length > length` は黙って破棄してログに残します (RFC 6347 §4.1.2.1)。fatal alert は送りません。
- 未分割メッセージ (`offset=0 && fragment_length=length`) はそのまま返します。同一キーの部分バッファがあれば破棄します。再送は再度上位へ渡るため、flight2 / flight4 の再送応答は維持されます。
- 重なり: 既存範囲との交差部分をバイト比較し、一致すれば受理、不一致ならそのメッセージを破棄します。
- 完成判定: 区間をマージした結果が `[[0, length]]` の 1 本になったときだけ返します。`mergeRange` ([packages/dtls/src/record/message/reassembler.ts:253](review-file:packages/dtls/src/record/message/reassembler.ts:253)) が区間を挿入してマージします。
- 上限: 1 メッセージ 64 KiB、同時 16 エントリ、総 256 KiB、1 メッセージ 256 区間、寿命 60 秒。超過時は古いエントリから捨てます。寿命の判定はタイマーを使わず、`add()` のたびに `expire()` ([packages/dtls/src/record/message/reassembler.ts:227](review-file:packages/dtls/src/record/message/reassembler.ts:227)) で行います。時計は `now` オプションで注入できます。

### `DtlsSocket` の差し替え

[packages/dtls/src/socket.ts:470](review-file:packages/dtls/src/socket.ts:470) の `handleFragmentHandshake(messages, epoch = 0)` は再組立て器への委譲になりました。名前と戻り値の型を維持し、epoch は省略可能です。変更の核は [packages/dtls/src/socket.ts](review-diff:packages/dtls/src/socket.ts:470) です。

- [packages/dtls/src/socket.ts:169](review-file:packages/dtls/src/socket.ts:169) で `packet.recordLayerHeader.epoch` を渡し、`msg_type` 単位のグループ化と `assemble()` 呼び出しを廃止しました。`msg_type` 昇順ソートは維持しています。
- 解放: `renegotiation`、`close()`、`closeTransport()`、終了パスの 4 箇所で `reassembler.clear()` を呼びます ([packages/dtls/src/socket.ts:106](review-file:packages/dtls/src/socket.ts:106)、[packages/dtls/src/socket.ts:230](review-file:packages/dtls/src/socket.ts:230)、[packages/dtls/src/socket.ts:411](review-file:packages/dtls/src/socket.ts:411)、[packages/dtls/src/socket.ts:529](review-file:packages/dtls/src/socket.ts:529))。

### 不要コードの削除

[packages/dtls/src/record/message/fragment.ts](review-diff:packages/dtls/src/record/message/fragment.ts) から、検証なしの `assemble()` と未使用の `findAllFragments()` を削除しました。

### ドキュメント

[packages/dtls/README.md](review-diff:packages/dtls/README.md) に `# Handshake fragments` 節を追加しました。[changelog.md](review-diff:changelog.md) には `Unreleased` の Bug Fix を追加しています。

### テスト

- 単体: [packages/dtls/tests/record/message/reassembler.test.ts](review-file:packages/dtls/tests/record/message/reassembler.test.ts) (新規、約 380 行)
- ソケット層: [packages/dtls/tests/server.test.ts](review-diff:packages/dtls/tests/server.test.ts)。バグ挙動を固定していた既存の `handleFragmentHandshake` 期待値を修正し、並べ替えた ClientHello を注入して HelloVerifyRequest が出ることも確認します。
- 結合: [packages/dtls/tests/e2e/fragment.test.ts](review-file:packages/dtls/tests/e2e/fragment.test.ts)。並べ替え、ドロップ、重複を起こす転送路で DtlsClient と DtlsServer のハンドシェイクを完走させます。
- Arrange の共通化: [packages/dtls/tests/utils.ts](review-diff:packages/dtls/tests/utils.ts)

## 4. 判断理由

- 区間リスト方式を採用しました。典型的なフラグメント数は少なく、ビットマップより省メモリで、重なりの検証も交差部分だけで済みます。
- 不整合や上限超過で fatal alert を送らない設計です。送ると、経路上の注入で接続を切れる DoS になります。
- 完了済みキーを恒久的に抑止しませんでした。flight2 / flight4 の再送応答を維持するためです。
- 完成メッセージを `offset=0 / fragment_length=length` の単一フラグメントで返します。Flight が `handshakeCache` に積むトランスクリプトの形を従来の `assemble()` と同じに保つためです。

## 5. レビュアーが確認すべき点・リスク

- `FragmentedHandshake.assemble()` / `findAllFragments()` の削除です。公開 API かどうかは差分からは確認していません。`packages/dtls/src/index.ts` の export を確認してください。changelog には「unvalidated internal」と書いています。
- 寿命はタイマーではなく次回の `add()` で判定するため、アイドルなソケットでは終了か `clear()` まで保持されます。README にも明記しています。
- 上限値 (64 KiB、256 KiB、16 エントリ) が、PQ ClientHello や RSA 4096 の証明書チェーンなどの正常系に十分かを確認してください。
- 不一致な重なりでメッセージ全体を破棄するため、攻撃者が不正なフラグメントを 1 つ注入すると、そのメッセージは再送待ちになります。fatal にしない代わりのトレードオフです。
- チケットの対象外: 受信側の `next_receive_seq` による順序制御、送信側 `Flight.createPacket()` のトランスクリプト扱い、ICE 開始中の早着 DTLS データグラムのバッファリング。
- changelog の英文に、「and their lifetime ... and are freed」という語順の乱れがあります。内容に影響しない軽微な点です。

## 6. 検証結果

- `cd packages/dtls && npm test` (vitest run ./tests): 34 ファイル成功、1 スキップ、122 テスト成功、1 スキップ。この解説作成時に実行しました。
- 未実行: `npm run type`、`npm run test:small`、`packages/webrtc` のテスト、E2E、`npm run format` の確認。上記以外の検証結果は、この文書作成時点では確認していません。
