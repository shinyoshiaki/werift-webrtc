## Summary
DTLS 1.2 handshake reassembly on current `develop` can assemble an incomplete ClientHello when handshake fragments arrive out of order, particularly when the fragment ending at the message length arrives before the initial fragment. A downstream production-path workaround was merged in [SimpleIM PR #26](https://github.com/zzqDeco/SimpleIM/pull/26), reporting failures with larger post-quantum `X25519MLKEM768` ClientHello messages over TURN/WAN.

## Current upstream implementation
- `packages/dtls/src/socket.ts` `handleFragmentHandshake()` buffers partial fragments, then treats the buffer as complete when the **last received** fragment satisfies `fragment_offset + fragment_length === length` and at least two fragments exist. This does not prove full byte coverage, nor that fragments belong to one `(msg_type, message_seq, length)` group.
- `packages/dtls/src/record/message/fragment.ts` `FragmentedHandshake.assemble()` sorts and copies fragments into `Buffer.alloc(messages[0].length)` without validating contiguous coverage. Missing bytes remain zero-filled.
- The resulting malformed `ClientHello` may be parsed with zeroed fields and fail cipher-suite negotiation. Out-of-order delivery, duplication and overlapping fragments require careful handling.

## Expected behavior
- Reassemble by handshake identity (at least message type, sequence and declared total length, scoped to the appropriate DTLS epoch/flight).
- Track actual byte coverage, not arrival order or whether the final offset was observed.
- Do not deliver a handshake message to the parser until the complete declared byte range is present.
- Handle out-of-order, duplicate and overlapping fragments safely; reject inconsistent overlapping bytes rather than silently accepting corrupted data.
- Bound buffered bytes, fragment count and lifetime to avoid memory exhaustion from untrusted network traffic.
- Preserve unfragmented handshakes and retransmission behavior.

## Regression tests
1. Three-fragment ClientHello with order [last, middle, first], and [middle, last, first].
2. Final fragment arrives while a gap remains: must **not** emit a reconstructed message.
3. Duplicate, overlapping, and interleaved fragments from distinct message sequences.
4. Verify the reconstructed bytes exactly match the original, including a large ClientHello.
5. DTLS client/server integration test across a lossy/reordering transport.

## Evidence and duplicate check
- Downstream: https://github.com/zzqDeco/SimpleIM/pull/26
- Upstream source: `packages/dtls/src/socket.ts`, `packages/dtls/src/record/message/fragment.ts` on `develop`.
- Searched existing upstream DTLS/fragment/reassembly issues and PRs. #659 (DTLS 1.3 roadmap) and #753 (stale ClientHello random after HelloVerifyRequest) concern different failure modes; no equivalent open PR found.

This issue targets the core DTLS fragment reassembler. The downstream PR also patches early DTLS datagram buffering during ICE startup, which is a separate concern and should not be assumed to be fixed by this issue.

---

# 詳細化（コードベース調査結果）

調査時点のリビジョンは `43fa72346`（`develop` 由来の `ticket/7af47df5-...` ブランチ）。

## 1. 目的と背景

- **目的**: `werift-dtls` の DTLS 1.2 ハンドシェイク再組立て（RFC 6347 §4.2.3）を、受信順ではなく **実際のバイト被覆** で完了判定する。欠けたバイトがゼロ埋めされたメッセージが上位（`ClientHello.deSerialize` など）へ渡らないようにする。
- **背景**:
  - Chrome などが送る大きな ClientHello（`X25519MLKEM768` など PQ 鍵共有拡張を含むもの）は MTU を超えるため、3 フラグメント以上に分割される。TURN/WAN 経路では順序の入れ替わりが起きる。
  - 現行実装では「最後に受信したフラグメントが末尾（`offset + length === total`）で、かつバッファに 2 個以上ある」だけで完成扱いになる。順序 `[frag2, frag1, frag0]` で frag1 → frag2 の順に届くと、frag0 が無いまま組み立てられる。その ClientHello は `version 0.0` で `cipherSuites: []` になり、`dtls cipher suite negotiation failed` で接続できない。
  - 下流の SimpleIM PR #26 は `DtlsSocket.prototype.handleFragmentHandshake` を `(msg_type, message_seq, length)` キーの区間ベース再組立て器に差し替えて回避している。今回はこれを本体側で根本的に直す。

## 2. 現行実装の問題点（コード上の根拠）

| 箇所 | 問題 |
| --- | --- |
| `packages/dtls/src/socket.ts:468` `handleFragmentHandshake()` | `fragment_length !== length` の要素をすべて 1 本の配列 `bufferFragmentedHandshakes` に入れる。`msg_type` / `message_seq` / `length` / epoch で分けていない。完成判定は「バッファ長が 2 以上で、最後に push された要素が末尾フラグメント」というだけ。末尾が届いた後で到着した欠落フラグメント（例: frag0）は次の組立てまでバッファに残り、別メッセージに混ざる。 |
| `packages/dtls/src/socket.ts:166-180` `udpOnMessage` | `handleFragmentHandshake` が返した要素を **`msg_type` だけ** でグループ化して `FragmentedHandshake.assemble()` に渡している。同じ `msg_type` で `message_seq` が違うもの（HelloVerifyRequest 前後の ClientHello seq0 / seq1、再送）が 1 つのバッファに混ざる。 |
| `packages/dtls/src/record/message/fragment.ts:126` `assemble()` | `Buffer.alloc(messages[0].length)` に `copy` するだけ。被覆、重複の一致、`offset + fragment_length <= length`、各要素の `length` / `msg_type` / `message_seq` が揃っているかを検証しない。欠落部分はゼロのまま残る。 |
| `fragment.ts:145` `findAllFragments()` | 正しいキー `(msg_type, message_seq, length)` でフィルタする実装はあるが、`src` のどこからも使われていない。 |
| `FragmentedHandshake.deSerialize` | `fragment_length` と、実際に読めた `fragment.length`（レコードが途中で切れた場合）や `offset + fragment_length > length` を検証していない。悪意ある値や壊れた値がそのまま再組立てに入る。 |

補足（今回のスコープ外だが関連する点）:
- 受信側は `next_receive_seq` による順序制御（RFC 6347 §4.2.2）を持っていない。メッセージ単位の順序は各 flight ハンドラ（`waitForReady` など）が吸収している。
- 送信側の `Flight.createPacket()` は分割後のフラグメントを `handshakeCache` に入れており、トランスクリプトハッシュの扱いに疑問がある（自分側のメッセージが分割される場合）。今回は受信側の再組立てに限定し、必要なら別チケットにする。
- 下流 PR の「ICE 開始中に早く届いた DTLS データグラムのバッファリング」は別問題で、本チケットでは扱わない。

## 3. 実装内容

### 3.1 再組立て器の新設（推奨: `packages/dtls/src/record/message/reassembler.ts`）

`DtlsSocket` からロジックを切り出し、単体テストしやすい純粋クラスにする（`Event` を使った通知は不要）。

- **キー**: `(epoch, msg_type, message_seq, length)`。epoch は `packet.recordLayerHeader.epoch` を `handleFragmentHandshake` へ渡す（シグネチャを拡張する）。同じ `(epoch, message_seq)` で `msg_type` か `length` が食い違うフラグメントは不整合なので、該当エントリごと破棄してログに残す。
- **バッファ**: `Buffer.alloc(length)` と、被覆済み区間のリスト（ソート済みでマージした `[start, end)`）、または長さ `length` のビットマップ。
- **追加時の検証**（不正なら当該フラグメントを破棄する。RFC 6347 §4.1.2.1 に従い黙って捨て、`err` ログを出す）:
  - `fragment.length === fragment_length`
  - `fragment_offset + fragment_length <= length`
  - `length <= 上限`（後述）
  - `fragment_length === 0 && length > 0` の空フラグメントは被覆に寄与しないので無視する。
- **重複・重なり**: 既に被覆済みの範囲と重なる場合は、そのバイトが既存バイトと一致するか確認する（`Buffer.compare` を部分範囲で行う）。
  - 一致すれば受理する。重複は再送や MTU 変更による再分割で正常に起きる。BoringSSL / Chrome は再送時に MTU を下げて分割境界を変えることがある。
  - 不一致ならそのメッセージ（キー）を破棄する。改ざんや破損を黙って取り込まない。fatal alert までは送らない（破棄でよい）。
- **完成判定**: 被覆が `[0, length)` 全体になったとき（区間マージ後に `[[0, length]]` になる）だけ、完成した `FragmentedHandshake(msg_type, length, message_seq, 0, length, buf)` を返し、エントリを削除する。
- **未分割メッセージ**（`fragment_offset === 0 && fragment_length === length`）は従来どおりそのまま返す。既に同じキーの部分バッファがあれば、そのエントリは破棄してよい（完全版が届いたため）。
- **上限**（信頼できないネットワーク入力への対策。定数は `static` で上書き可能にしてテストできるようにする）:
  - 1 メッセージの `length` 上限。例: 2^16 程度。証明書チェーンや PQ ClientHello が十分入り、uint24 上限の 16MB は許さない値にする。
  - 同時に保持するエントリ数の上限（例: 16 程度）と、総バッファ量の上限（例: 256KB 程度）。超えたら古いエントリから捨てる。
  - 1 エントリあたりのフラグメント数の上限（区間リストを使う場合は区間数の上限）。
  - 寿命: 一定時間（例: 再送の上限時間程度、数十秒）更新が無いエントリを捨てる。タイマーは増やさず、追加時に `Date.now()` で掃除する方式を推奨。テストでは時刻を注入できるようにする。
- **リセット**: `renegotiation()` で現行の `bufferFragmentedHandshakes = []` に相当するクリアを行う。`close()` / 終了時にも解放する。

### 3.2 `DtlsSocket` 側の変更

- `bufferFragmentedHandshakes` と現行の `handleFragmentHandshake()` を、新しい再組立て器への委譲に置き換える。`handleFragmentHandshake` は `tests/server.test.ts` から直接呼ばれているので、名前と戻り値（完成した `FragmentedHandshake[]`）は維持する。epoch 引数は省略可能（既定 0）にすると互換を保てる。
- `udpOnMessage` の `msg_type` グループ化と `FragmentedHandshake.assemble()` 呼び出しを廃止し、再組立て器が返した完成メッセージだけを `msg_type` 順にソートして `onHandleHandshakes` に渡す。ソート順は既存の挙動として維持する。
- 完成した同一メッセージの **再送（再受信）は再度上位へ渡す**。サーバの `Flight4.exec` は「flight4 twice」で `lastMessage` を再送し、`flight2` は ClientHello の再送に HelloVerifyRequest を返す。この再送応答の挙動を壊さないため、「完了済みキーを恒久的に抑止する」実装にはしない。
- stale-epoch ドロップ（接続後に `epoch < remoteEpoch` のハンドシェイクを捨てる）は再組立ての前に行う。現行の位置を維持する。

### 3.3 `FragmentedHandshake.assemble()` の扱い

- 呼び出し元が無くなるので、削除するか、被覆検証つきの実装（不完全なら `throw`）に直す。公開 API（`packages/dtls/src/index.ts` の export 対象）かどうかを確認し、export されているなら検証つきに直して互換を保つ。
- `findAllFragments()` は未使用。再組立て器で置き換わるなら削除を検討する（`knip` の対象）。

### 3.4 ドキュメント

- `packages/dtls/README.md` に、ハンドシェイクフラグメント再組立ての挙動を追記する（順不同・重複・重なりの扱い、不整合時の破棄、上限）。`# Alerts` の箇条書きと同じスタイルにする。
- `changelog.md` に Bug Fix を追記する。`v0.28.0` はタグ済みなので、先頭に未リリース節を作る（既存の流儀に合わせる）。
- 公開 API を変えた場合は `npm run doc` で `packages/dtls/doc` を再生成する。

## 4. 技術的アプローチの要点

- **区間リスト方式を推奨**: 典型的なケースはフラグメント数が少ない（数個〜十数個）。ソート済みの `[start, end)` 配列に挿入してマージするだけで O(n) になり、ビットマップより省メモリ。重なり検証は、新フラグメントの区間と既存区間の交差部分についてだけ `buf.subarray(...).equals(fragment.subarray(...))` を行う。
- **データ構造**: `Map<string, Entry>`（キー文字列例: `${epoch}:${msg_type}:${message_seq}:${length}`）。`message_seq` だけを主キーにして `msg_type` / `length` の不一致を検出する方式でもよい。
- **トランスクリプトとの整合**: `Flight4.exec` / `Flight5` / `Flight6` は受信メッセージを `handshakeCache` に入れ、`serialize()` で Finished の verify_data や署名入力を計算する。したがって完成メッセージは **`fragment_offset = 0` / `fragment_length = length` の単一フラグメント** として返す必要がある（現行 `assemble()` と同じ形）。完成バイトが元のメッセージと完全に一致することがテストの肝になる。
- **参考実装**: 下流 SimpleIM PR #26 の `DtlsHandshakeReassembler`（`apps/cli/src/werift-transport.ts`）は `(msg_type, message_seq, length)` キーの区間方式。pion/dtls の `fragmentBuffer` も参考にできる（ただし pion は epoch と seq で管理し、重複は上書きする）。

## 5. テスト計画

AGENTS.md に従い Arrange / Act / Assert で書き、Act / Assert には日本語コメントを付ける。共通の Arrange は `packages/dtls/tests/utils.ts` に集約する（例: 大きな ClientHello 生成、フラグメント分割・並べ替えヘルパ、並べ替え・欠落・重複を起こす `PairedTransport` 拡張）。

1. **単体（再組立て器）** `packages/dtls/tests/record/message/reassembler.test.ts`（新規）
   - 3 分割 ClientHello を `[last, middle, first]` と `[middle, last, first]` の順に投入する。最後の 1 個を入れるまで何も返らず、返ったバイトが `serialize()` を含めて元と一致すること。
   - 末尾フラグメントが届いた時点で欠落がある場合は返らないこと。その後で欠落分が届いたら返ること。
   - 重複フラグメント（完全一致）は受理されること。境界の異なる再分割（例: chunk 10 と chunk 7 の混在）の重なりも、バイトが一致すれば完成すること。
   - 重なり部分のバイトが不一致なら、そのメッセージは返らず破棄されること。後から正しい全フラグメントを送れば完成すること。
   - 異なる `message_seq`（ClientHello seq0 / seq1）や異なる `msg_type`、`length` が交互に混ざっても、それぞれ正しく組み立つこと。
   - 不正値（`offset + len > length`、`fragment.length !== fragment_length`、`length` 上限超過）が破棄されること。
   - 上限（エントリ数、総バイト数、寿命）を超えると古いエントリが捨てられること（定数と時刻を注入する）。
   - 大きな ClientHello（例: 1,200 バイト超の拡張を含み、既定 `chunk()` で 2〜3 分割になるもの）が完全一致で復元されること。
2. **ソケット層** `packages/dtls/tests/server.test.ts`
   - 既存テスト `handleFragmentHandshake` の期待値を見直す。現行テストは「最後の 1 個より前に末尾を入れると完成扱いになる」という **バグ挙動を固定している**（`second` を後から入れても 0 件）。正しい期待値（全バイトがそろったときに 1 件だけ返る）に修正する。
   - `DtlsServer` に並べ替えた ClientHello フラグメントのレコードを `transport.onData` で注入し、HelloVerifyRequest（flight2）が送られることを `RecordingTransport.sent` で確認する。
3. **結合** `packages/dtls/tests/e2e/`（または `socket.test.ts`）
   - `PairedTransport` に「並べ替え、遅延、重複、ドロップ」の挙動を追加し（`utils.ts`）、大きな証明書（例: RSA 4096 や中間証明書つきチェーンで Certificate を分割させる）または小さな MTU で `DtlsClient` と `DtlsServer` のハンドシェイクを完走させる。順序入れ替えとドロップがあっても再送で接続し、アプリケーションデータが往復すること。
   - フラグメント分割は `chunk()` の既定 MTU で決まるので、分割を確実に起こすにはテスト用に大きなメッセージを使うか、分割サイズを注入する手段を用意する（公開 API を増やさない形が望ましい）。

## 6. 制約・注意点

- 型ストリップ実行のため `enum` とパラメータプロパティは使わない（`erasableSyntaxOnly`）。
- ハンドシェイク全体の挙動（未分割メッセージ、再送応答、stale-epoch ドロップ、renegotiation）を変えない。特に **完成済みメッセージの再受信を抑止しない** こと。
- 不整合や上限超過は「破棄してログ」に留める。広範な catch-and-ignore はしない。ここで fatal alert を送ると、経路上の注入で接続を切れる DoS になる。
- 上限値は正当な最大ケースより十分大きくする。Chrome の PQ ClientHello、RSA 4096 の証明書チェーン、certificate_request を含む場合などで正常系が壊れないこと。
- `packages/webrtc` は `werift-dtls` を経由して使うだけなので API の変更は不要の見込み。ただし `packages/webrtc` のテストと E2E で回帰が無いことを確認する。
- このホストで HEAD 時点から失敗するテストがある（メモリ記載: tcp active-only の件数、setConfiguration、modern_sdp）。回帰かどうかは別 worktree で develop と比較して判断する。

## 7. 完了条件

- [ ] 再組立てが `(epoch, msg_type, message_seq, length)` 単位で行われ、`[0, length)` の全バイトがそろったときにだけ上位へ渡る。
- [ ] 順不同、重複、境界の異なる重なりは正しく復元され、重なりバイトの不一致はそのメッセージの破棄になる。
- [ ] 不正なフラグメントヘッダ（範囲外、長さ不一致、上限超過）が破棄される。
- [ ] バッファのバイト数、エントリ数、区間数、寿命に上限があり、テストで確認されている。
- [ ] 未分割ハンドシェイク、再送応答（flight2 / flight4 の再送）、stale-epoch ドロップ、renegotiation の既存挙動が維持されている。
- [ ] Regression tests 1〜5（上記テスト計画）が追加され、既存の `handleFragmentHandshake` テストが正しい期待値に修正されている。
- [ ] `cd packages/dtls && npm run type && npm test` が通る。`npm run type` と `npm run test:small` で回帰が無い（ホスト依存の既知失敗を除く）。
- [ ] `npm run format` 済み。`packages/dtls/README.md` と `changelog.md` が更新され、公開 API を変えた場合は `npm run doc` で再生成されている。
