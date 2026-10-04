# ICE2 / MESSAGE-INTEGRITY-SHA256

## 1. 目的と背景

- RFC 8489（STUN の改訂版）で `MESSAGE-INTEGRITY-SHA256`（属性 `0x001C`、HMAC-SHA256）が追加された。短期クレデンシャル（ICE の `ice-ufrag` / `ice-pwd`）でも、SHA-1 の `MESSAGE-INTEGRITY`（`0x0008`）に加えて、または代わりに使える。
- RFC 8445 / RFC 8839 では、RFC 8445 準拠の ICE エージェントであることを示す SDP の ice-option トークン `ice2`（`a=ice-options:ice2`）が定義されている。
- 現在の werift の状況（下の「現状調査」）:
  - 属性テーブルに `MESSAGE-INTEGRITY-SHA256` は登録済みだが、生成も検証もしていない。
  - `parseMessage(data, integrityKey)` が検証するのは SHA-1 の `MESSAGE-INTEGRITY` だけ。そのため **SHA256 だけで署名された応答は、`integrityKey` を指定すると必ず `undefined`（破棄）になる**。一方 `transaction.ts` の防御的チェックは SHA256 があれば受理する前提になっていて、両者が食い違っている。
  - SDP は常に `a=ice-options:trickle` を出力し、`ice2` は送信も解釈もしていない。
- 目的: RFC 8489 / RFC 8445 に沿って、短期クレデンシャルでの `MESSAGE-INTEGRITY-SHA256` の生成・検証と、`ice2` ice-option の扱いを実装する。既存のブラウザ（libwebrtc / Firefox）との相互接続は崩さない。

## 2. 現状調査（コードベース）

| 箇所 | 現状 |
| --- | --- |
| `packages/ice-server/src/stun/message.ts` | STUN メッセージの実体。`packages/ice/src/stun/message.ts` はこれを再エクスポートしているだけなので、**変更は ice / ice-server の両方に影響する**。`addMessageIntegrity()` / `messageIntegrity()` / `parseMessage()` は HMAC-SHA1 固定 |
| `packages/ice-server/src/stun/const.ts` | `INTEGRITY_LENGTH = 24`（SHA-1 の 20 バイト + TLV ヘッダ 4 バイト）で固定。SHA256 用の長さ定数はない |
| `packages/ice-server/src/stun/attributes.ts` | `[0x001c, "MESSAGE-INTEGRITY-SHA256", packBytes, unpackBytes]` は定義済み。`PASSWORD-ALGORITHM(S)` / `USERHASH` も bytes として定義済み（長期クレデンシャル用） |
| `parseMessage()` | `MESSAGE-INTEGRITY` より後ろの属性もそのままパースして保持する。RFC 8489 §14.5 / §14.6 の「MI の後ろは MI-SHA256 と FINGERPRINT 以外を無視する」には従っていない |
| `packages/ice/src/stun/transaction.ts:150-160` | `integrityKey` がある場合は `MESSAGE-INTEGRITY` または `MESSAGE-INTEGRITY-SHA256` の存在を確認している（防御的チェック）。ワイヤ上の HMAC 検証は protocol 層の `parseMessage(data, key)` が担う |
| `packages/ice/src/stun/protocol.ts:72`, `tcpProtocol.ts:182`, `turn/protocol.ts:97,267` | 応答を `parseMessage(data, transaction.integrityKey)` で再パースして検証している。SHA256 だけの応答はここで落ちる |
| `packages/ice/src/stun/protocol.ts:127`, `tcpProtocol.ts:239`, `turn/protocol.ts:126,394` | リクエスト送信時は `addMessageIntegrity(key).addFingerprint()` 固定 |
| `packages/ice/src/ice.ts:292-` (`ensureProtocol` → `onRequestReceived`) | 受信した Binding Request に対する応答は `addMessageIntegrity(localPassword)` 固定（`ice.ts:346`）。エラー応答も同じ（`respondError`, `ice.ts:1774`）。**受信リクエスト側の MESSAGE-INTEGRITY 検証（`parseMessage(data, localPassword)`）は行っていない**（`data` は受け取っているが使っていない） |
| `packages/ice-server/src/turn/protocol.ts:956` | TURN サーバの長期クレデンシャル認証は `MESSAGE-INTEGRITY` が必須（SHA-1 のみ） |
| `packages/webrtc/src/sdpManager.ts:198` | `media.iceOptions = "trickle"` 固定 |
| `packages/webrtc/src/peerConnection.ts:347-353` | `canTrickleIceCandidates` は remote の ice-options をスペース区切りで解釈している。`ice2` を判定するときも同じ方法が使える |
| `packages/webrtc/src/sdp.ts:81,180,470` | session / media の `a=ice-options` をパース・出力する（文字列のまま保持） |
| テスト | `packages/ice-server/tests/message-integrity.test.ts`（MI 検証の AAA テスト）、`packages/ice/tests/stun/*.test.ts`、`packages/ice/tests/utils.ts`（共通 Arrange ユーティリティ） |

## 3. 実装すべき内容

### 3.1 STUN メッセージ層（`packages/ice-server/src/stun`）

1. **生成**: `Message.addMessageIntegritySha256(key: Buffer, length = 32)` を追加する。
   - HMAC-SHA256 で計算する。ヘッダの length は MI-SHA256 属性（4 + `length` バイト）までを含めて書き換えてから計算する。
   - 切り詰め長は RFC 8489 §14.6 に従い、16 以上 32 以下の 4 の倍数だけを許可する。範囲外は例外にする。
   - `addMessageIntegrity()` と併用したときの順序は `... → MESSAGE-INTEGRITY → MESSAGE-INTEGRITY-SHA256 → FINGERPRINT` とする。MI-SHA256 の HMAC 対象には先行する MI を含める。
   - 現在の `messageIntegrity()` / モジュール内 `messageIntegrity()` は `INTEGRITY_LENGTH` を使っている。これをアルゴリズムと長さを引数に取る共通ヘルパに整理する（`setBodyLength` を再利用する）。
2. **検証**: `parseMessage(data, integrityKey)` を拡張する。
   - `MESSAGE-INTEGRITY-SHA256` を受信したら、その位置までのデータを HMAC-SHA256 で計算し、受信した長さに切り詰めて比較する。
   - RFC 8489 §9.1.4 に従い、**MI と MI-SHA256 が両方ある場合は MI-SHA256 だけで検証する**（MI は無視する）。どちらか一方だけなら、存在する方で検証する。
   - 受信した MI-SHA256 の長さが不正（16 未満、32 超、4 の倍数でない）なら `undefined` にする。
   - 比較には `crypto.timingSafeEqual` を使う（長さが違えば不一致）。既存の SHA-1 比較もこれに揃えてよい。
   - RFC 8489 §14.5 / §14.6 に従い、MI の後ろにある MI-SHA256 / FINGERPRINT 以外の属性と、MI-SHA256 の後ろにある FINGERPRINT 以外の属性は無視する（保持しない）。既存の挙動を変えるので、テストで影響範囲を確認すること。
   - 呼び出し側が「どちらで署名されていたか」を判断できるようにする。例えば `Message` に `integrityAlgorithm?: "sha1" | "sha256"` を持たせるか、`attributesKeys` から判定する。
3. `const.ts` に `INTEGRITY_SHA256_LENGTH`（デフォルト 32 + 4）などの定数を追加する。

### 3.2 ICE 層（`packages/ice`）

1. **応答時のアルゴリズムの一致**（RFC 8489 §9.1.3）: 受信した Binding Request が MI-SHA256 を含む場合は、Success / Error 応答にも MI-SHA256 を付ける（`ice.ts:346`、`respondError`）。MI だけの場合は従来どおり MI だけを付ける。
2. **送信リクエストのアルゴリズム選択**:
   - デフォルトは従来どおり `MESSAGE-INTEGRITY`（SHA-1）だけにする。相互接続のリスクを避けるため。
   - オプトイン（例: `IceOptions.messageIntegrity?: "sha1" | "sha256" | "both"`）で MI-SHA256 を付けられるようにする。`StunProtocol.request()` / `StunOverTcpProtocol.request()` / `TurnProtocol.request()` に渡す `integrityKey` に合わせて、アルゴリズム指定も渡せるようにする（`Protocol` インターフェースの変更になる）。
   - 相手から MI-SHA256 付きのリクエストや応答を受け取った（＝相手が対応している）ことを学習して、以降のリクエストを自動で切り替えるかどうかは任意（Phase 2 扱い）。
3. **受信リクエストの検証**（関連する既存の欠落）: 現在 `onRequestReceived` では MI を検証していない。今回 MI / MI-SHA256 の両方を検証するなら、`parseMessage(data, localPassword)` で検証し、失敗したら 401 Unauthorized を返すか破棄する（RFC 8445 §7.3 / RFC 8489 §9.1.3）。既存の挙動を大きく変えるので、**同じチケットで扱うか、別チケットに切り出すかを判断して明記する**（切り出す場合でも、SHA256 の検証ロジックはここで使える形にしておく）。
4. `transaction.ts` の防御的チェックは、SHA256 のサポートを実装した後もそのまま整合する。コメントの更新だけでよい。

### 3.3 ICE2 ice-option（`packages/webrtc`）

1. 出力: `sdpManager.ts:198` の `"trickle"` 固定をやめ、`"trickle ice2"` を出力するかどうかを設定で制御できるようにする（例: `PeerConfig.iceOptionIce2?: boolean`）。デフォルト値は後述の相互接続調査の結果で決める（安全側に倒すなら `false`）。
2. 受信: remote の ice-options に `ice2` があるかを判定するヘルパを追加する。`canTrickleIceCandidates` と同じ解釈ロジックを共通化する。判定結果は `RTCIceTransport` / `Connection` に伝えて、ログ出力などで使えるようにする。
3. `ice2` を受け取った・送ったときに挙動を変える箇所は、RFC 8445 と RFC 5245 の差分（ノミネーション手順、`ice-lite` の扱いなど）に限られる。werift はすでに RFC 8445 のロジック（regular nomination など）に従っているため、**挙動の分岐は原則不要**。追加するのは「宣言と取得」だけにとどめる。
4. Phase 2（任意）: `ice2` を受け取ったときだけ MI-SHA256 を有効にするポリシーを検討する。ただし RFC 上、ice2 が MI-SHA256 対応を保証するわけではない点に注意（4 章）。

### 3.4 対象外（別チケット候補）

- TURN の長期クレデンシャルでの SHA256（`PASSWORD-ALGORITHM` / `PASSWORD-ALGORITHMS` / `USERHASH` によるネゴシエーション。RFC 8489 §9.2）。クライアント（`packages/ice/src/turn/protocol.ts`）とサーバ（`packages/ice-server/src/turn/protocol.ts:956`）の両方に影響が大きいため、分離する。
- `ice-server` の STUN Binding サーバ（`packages/ice-server/src/protocol.ts`）でのクレデンシャル検証。

## 4. 技術的な実装アプローチ（要約）

- HMAC は `crypto.createHmac("sha256", key)` を使う。短期クレデンシャルの鍵は SHA-1 と同じく `ice-pwd` の UTF-8 バイト列（RFC 8489 §9.1.1。OpaqueString / SASLprep の扱いは既存実装に合わせる）。
- MI-SHA256 の計算手順:
  1. 先頭から MI-SHA256 属性の直前までをメッセージとして取り出す。
  2. ヘッダの length を `現在のボディ長 + 4 + truncLen` に書き換える。
  3. HMAC-SHA256 を計算し、先頭 `truncLen` バイトを使う。
  - 既存の `setBodyLength()` をそのまま流用できる。
- `parseMessage` のループでは、`pos`（その属性の先頭オフセット）を使った `data.slice(0, pos)` が既に計算対象として正しい。SHA256 の分岐を追加し、「MI 検証済み」フラグを「MI / MI-SHA256 のどちらかを要求どおり検証済み」に一般化する。
- 送信側の API は既存のメソッドチェーン（`.addMessageIntegrity(key).addFingerprint()`）を崩さない。例: `.addMessageIntegritySha256(key).addFingerprint()`、または `addIntegrity(key, { algorithm })` のようなヘルパ。
- `Protocol.request(..., integrityKey?)` のシグネチャ変更は `ConsentMockProtocol`（`packages/ice/tests/utils.ts`）などのテストダブルにも波及するため、まとめて更新する。
- `ice2` の判定は既存の `iceOptions.split(/\s+/)` パターンに合わせる。

## 5. 制約・注意点

- **相互接続**: 属性タイプ `0x001C` は comprehension-required の範囲（< 0x8000）にある。実装によっては未知属性として 420 (Unknown Attribute) を返したり、メッセージを破棄したりする可能性がある。libwebrtc / Firefox が ICE の短期クレデンシャルで MI-SHA256 を受理・送信するかは実装前に確認する（libwebrtc は独自の `GOOG-MESSAGE-INTEGRITY-32` は持つが、SHA256 は未対応の可能性が高い）。このため、**送信のデフォルトは SHA-1 のままにする**。受信と検証の対応、および「受け取ったアルゴリズムで応答する」対応は安全に入れられる。
- `ice2` は「RFC 8445 準拠」を示す宣言にすぎず、MI-SHA256 対応のネゴシエーションではない。ice2 を MI-SHA256 有効化のトリガーにする場合は、根拠と相互接続の確認が必要。
- `packages/ice-server/src/stun/message.ts` は ice と ice-server で共有されている。TURN サーバや ice-server の Chrome E2E に影響しないことを確認する。
- 後続属性を無視する変更（3.1-2）は、既存の受信処理（特に unknown な rawAttributes の保持や、FINGERPRINT 検証の順序）に影響しうる。回帰テストを追加する。
- 失敗した検証は個別に `log` に出して破棄する。広い catch-and-ignore は追加しない（AGENTS.md）。
- 公開 API（`IceOptions`、`PeerConfig`、`Message` のメソッド）を追加したら、README / docs（`docs/browser-api-compatibility.md` など、該当するもの）も更新する。
- WPT 用の厳格な挙動は `packages/webrtc/tools/wpt-runner/*` に閉じ込める（今回は該当しない見込み）。
- テストは Arrange / Act / Assert の 3 段構成にし、Act / Assert には日本語コメントを付ける。署名付きメッセージ生成などの Arrange は `packages/ice/tests/utils.ts`（ice 側）や ice-server の既存テストのヘルパに集約する。

## 6. テスト方針

- `packages/ice-server/tests/message-integrity.test.ts` に以下を追加する:
  - MI-SHA256 だけで署名 → 正しい鍵で受理、誤った鍵で `undefined`
  - MI + MI-SHA256 の併用 → MI-SHA256 で検証される（MI を壊しても MI-SHA256 が正しければ受理、逆の場合は拒否）
  - 切り詰め長 16 / 20 / 32 で受理、不正な長さ（12、33、18 など）で拒否
  - FINGERPRINT と併用したときの順序と CRC が正しい
  - MI の後ろに置かれた余計な属性が無視される
  - RFC 8489 Appendix B.1 のテストベクタ（"Sample Request with Long-Term Authentication with MESSAGE-INTEGRITY-SHA256 and USERHASH"）は長期クレデンシャル用なので、短期クレデンシャルの検証には自前のベクタを使う。可能であれば、外部実装（Python `aioice` 等、`packages/ice/python` の環境）で生成したバイト列を `packages/ice/tests/data/*.bin` に固定ベクタとして追加する。
- `packages/ice/tests/stun/stun.test.ts` / `ice/*.test.ts` に以下を追加する:
  - MI-SHA256 付き Binding Request への応答が MI-SHA256 で署名されている
  - SHA256 オプトイン時に、2 つの `Connection` 間の接続が確立する（`inviteAccept` を使う）
  - SHA256 だけの応答を `StunProtocol` / `StunOverTcpProtocol` / TURN 経由で受理する
- `packages/webrtc/tests` に以下を追加する: `ice2` 有効時に SDP に `a=ice-options:trickle ice2` が出力されること、remote の `ice2` を解釈できること、既存の `canTrickleIceCandidates` が回帰しないこと。

## 7. 完了条件

- [ ] `Message` で `MESSAGE-INTEGRITY-SHA256` を生成できる（切り詰め長の検証あり。MI / FINGERPRINT との順序が RFC 8489 どおり）。
- [ ] `parseMessage(data, key)` が MI-SHA256 を検証し、併用時は MI-SHA256 を優先し、不正な長さや不一致を拒否する。SHA256 だけの応答も受理される。
- [ ] ICE の Binding 応答（成功・エラー）が、リクエストと同じ完全性アルゴリズムで署名される。
- [ ] 送信リクエストで MI-SHA256 を使うかをオプションで選べる。デフォルトは従来どおり SHA-1 で、既存のブラウザ相互接続に回帰がない。
- [ ] `ice2` ice-option の出力（設定で制御）と、remote 側の判定ができる。
- [ ] 受信リクエストの完全性検証を本チケットで扱うか、別チケットに切り出すかが決まっていて、明記されている。
- [ ] TURN 長期クレデンシャルの SHA256 対応は別チケットとして起票されている（または対象外と明記されている）。
- [ ] 追加・変更したテストが AAA 構成で、日本語コメントが付き、共通 Arrange ユーティリティにまとまっている。
- [ ] 検証コマンドが通る:
  - `cd packages/ice-server && npm test && npm run type`
  - `cd packages/ice && npm run type && npm test`
  - `cd packages/webrtc && npm test`
  - パッケージ横断の変更なので `npm run type` と `npm run test:small`。可能であれば `npm run e2e` でブラウザ相互接続の回帰がないことを確認する。
- [ ] 公開 API やオプションの追加に合わせて、README / docs と該当する `AGENTS.md` を更新している。
