# 旧バージョンの werift との互換性の再確認

対象: チケット `71cc0e0d`（`epic4-warp-webrtc-detailed`、`develop` と `warp` をマージした後の `076c09787`）。
調査日: 2026-11-07。

## 結論

- npm で公開されている旧バージョンと実際に接続して確認し、本ブランチの変更が原因の非互換を 3 件見つけて修正しました（§3）。
- 修正後、0.26.0（本ブランチの直前のリリース）との 60 ケースのうち、つながらない・届かないものは 4 件だけです。4 件とも、現行側を DTLS 1.3 のみに設定した構成で、旧 werift が DTLS 1.2 にしか対応していないため接続できないのは仕様どおりです（§4.1）。
- 0.24.4 以前のリリースとの間には別の非互換がありますが、すべて公開済みの 0.26.0 でも同じように起きるため、本ブランチによる回帰ではありません（§4.2）。

## 1. 方法

- 公開済みのリリースを `npm install --ignore-scripts` で一時ディレクトリに入れ、現行のソース（`packages/webrtc/src`）と同じプロセスで接続しました。両者の間でやり取りするのは plain な SDP と candidate の JSON だけです。
- 主な対象は 0.26.0 です。0.25.2、0.24.4、0.22.9、0.20.1、0.19.9 も各系列から 1 つずつ確認しました。
- 確認したのは次の 10 領域・60 ケースです。旧 werift が offerer か answerer か、answerer の DTLS role が client（setup:active）か server（setup:passive）かの組み合わせを、各領域で回しました。offerer は ICE controlling なので、answerer が DTLS server になると ICE role と DTLS role の対応がずれます。

| 領域 | 内容 |
|---|---|
| A / A2 | 両側からの in-band DataChannel（同時 / 順番）、stream ID |
| B / B2 | 60 KB・binary・50 件の順序、unordered・maxRetransmits:0、negotiated |
| C | DataChannel の close がもう一方へ伝わるか |
| D | 音声 RTP の双方向 |
| E | 現行側が DTLS `[1.3, 1.2]`、SPED + `[1.3, 1.2]`、1.3 のみ、SPED + 1.3 のみ |
| F | ICE restart（どちらから restart しても） |
| G | ICE-TCP のみ |
| H | ICE-lite（旧 / 現行のどちらが lite でも） |
| I | 接続後の再交渉で音声を追加 |
| J | PeerConnection の close がもう一方へ伝わるか |

- 失敗したケースは、現行側を公開済みの 0.26.0 に置き換えて同じ組み合わせで再実行し、本ブランチで生じたものか、以前からのものかを分けました。

## 2. 0.26.0 との結果（修正前）

60 ケース中 11 件が失敗しました。

| 失敗 | ケース | 原因 |
|---|---|---|
| E: 4 件 | 現行側が DTLS client で `[1.3, 1.2]`（SPED の有無とも）。接続しないまま `connecting` | §3.1 |
| G: 1 件 | ICE-TCP、旧 offerer × 現行 answerer DTLS server。SCTP が確立しない | §3.2 |
| A: 2 件 | role がずれる構成で、両側から同時に DataChannel を開くと stream ID が衝突し、相手側に現れない | §3.3 |
| E: 4 件 | 現行側が DTLS client で 1.3 のみ（SPED の有無とも） | §4.1（仕様どおり） |

それ以外（DataChannel の各種送信、close、RTP、ICE restart、ICE-lite、再交渉）は、すべての組み合わせで成功しました。

## 3. 見つかった問題と修正

### 3.1 DTLS `[1.3, 1.2]` の client が旧 werift の DTLS 1.2 server とつながらない

**原因:** 現行の client は、1.3 と 1.2 の両方を提示する最初の ClientHello（CH-A）を DTLS 1.3 engine で組み立てており、extended_master_secret（EMS、RFC 7627）を載せていませんでした。0.26.0 の server は HelloVerifyRequest の前の ClientHello だけで client の EMS 提示を判定し（`flight2`）、cookie 付きの ClientHello への ServerHello では EMS を常に返します。client は ServerHello の EMS を見て EMS で、server は「client は EMS を提示していない」として EMS なしで master secret を導出するため、client の Finished を server が復号できず、handshake が終わりませんでした。旧 werift だけでなく、SPED 非対応の peer へ直接 DTLS 1.2 へ fallback する（チケットの完了条件）経路そのものが、この相手では成立していませんでした。

**修正:** `packages/dtls/src/engine/v1_3/flight/client/flight1.ts` で、DTLS 1.2 も提示し、かつ EMS が有効なときは CH-A にも EMS を載せます（`Dtls13Options.extendedMasterSecret` を追加し、`packages/dtls/src/client.ts` から渡す）。1.3 だけを提示する ClientHello は変わりません。DTLS 1.3 の server は EMS を無視します。

この変更で、既存のテスト `self13_dual_fallback_ch_wire.test.ts` の「CH-A は EMS を載せない」という前提を改めました。この前提は、CH-A を 1.3 engine が作るため 1.2 の拡張を載せていなかったことをそのまま固定したものでした。cookie なしの 1.2 ServerHello（Chrome 相当）を受けた後に CH-A をそのまま再送する、という規則は変えておらず、再送も CH-A と同じ拡張集合のままです。cookie 付きの ClientHello に 1.2 の拡張を足す処理は重複を足さないので、EMS が二重に載ることはありません。

### 3.2 旧 werift が自分の INIT に答えた後、旧 werift の INIT を捨てて SCTP が確立しない

**原因:** 0.26.0 の SCTP association は `start()` までは passive（`isServer` の既定値が true）で、相手の INIT に INIT_ACK で答え、相手の verification tag を覚えます。その後 ICE controlling 側として `start()` すると、覚えた tag を付けて自分の INIT を送ります（RFC 9260 では INIT の tag は 0）。さらに initiator になった後は INIT と COOKIE_ECHO を無視します。現行側（DTLS server、INIT を送る側）の INIT が旧 werift の `start()` より先に届くと、現行側は tag が 0 でない旧 werift の INIT を捨て、旧 werift は現行側の COOKIE_ECHO を捨てるため、どちらも進めなくなっていました。ICE-TCP では毎回この順序になりました。現行の SCTP 自身も、`start()` 前に相手の INIT に答えた後の INIT を同じく相手の tag で送っていました。

**修正:** `packages/sctp/src/sctp.ts` で次の 2 点を変えました。
- 自分の verification tag が付いた INIT も受け付ける。その tag を知っているのは自分の INIT を受け取った相手だけで、SCTP は DTLS の中を流れるので、送れるのは認証済みの相手だけです。受け付けた後は、これまでどおり INIT の衝突（RFC 9260 §5.2.1）として INIT_ACK で答えます。
- 自分の INIT は常に tag 0 で送る。

### 3.3 role がずれる構成で、両側から同時に開いた DataChannel の stream ID が衝突する

**原因:** 現行は RFC 8832 §6 に従い、DTLS role で stream ID の parity を決めます（client は偶数、server は奇数）。0.26.0 は ICE role で決めます（controlling は奇数）。ICE role と DTLS role の対応がずれる構成（現行が DTLS server かつ ICE controlled、または DTLS client かつ ICE controlling）では、両者が同じ parity を使い、どちらも小さい番号から数えます。両側から同時に開くと同じ ID になり、どちらの側も相手の OPEN を「既に開いている」として ACK だけを返すため、相手のチャネルは現れず、メッセージは別の label の自分のチャネルへ混線していました。

**修正:** `packages/webrtc/src/transport/sctp.ts` で、ICE role と DTLS role の対応がずれる構成に限り、DTLS role の parity のまま、交渉済みの stream 数の上端から小さい方へ ID を割り当てます（例: 65533、65531、…）。旧 werift は下端から数えるので、両者の ID が出会うのは約 3 万本を開いた後です。DTLS role の parity は守るので、RFC 8832 に従う peer（逆の parity を使う）とも衝突しません。対応が揃う通常の構成（offerer が ICE controlling かつ DTLS server）の ID は、これまでどおり 0/1、2/3、… です。role がずれる構成でだけ `RTCDataChannel.id` の値が大きくなる点は、`changelog.md` に記載しました。

### 3.4 テスト

| テスト | 修正前 | 修正後 |
|---|---|---|
| `packages/webrtc/tests/integrate/legacyWeriftRelease.test.ts`（opt-in、0.26.0 実物、21 ケース）: role の 4 通り × 現行 `[1.3, 1.2]`（SPED の有無）、ICE-TCP、両側から同時の DataChannel を追加 | 7 件失敗（3.1 の 4 件、3.2 の 1 件、3.3 の 2 件） | 21 件成功 |
| `packages/sctp/tests/roleMismatch.test.ts`: `start()` 前に答えた後も INIT は tag 0 / 自分の tag 付きの INIT に INIT_ACK で答える / 無関係な tag の INIT は捨てる | 前の 2 件が失敗 | 3 件成功 |
| `packages/dtls/tests/e2e/self13_dual_fallback_ch_wire.test.ts`: CH-A は EMS を提示する / 再送は CH-A と同じ / 1.3 のみの ClientHello は EMS を載せない | （前提を変更） | 3 件成功 |
| `packages/webrtc/tests/integrate/legacySctpRole.test.ts`: 旧 werift の SCTP を模した peer（ICE role の parity で下から割り当て）と、両側から同時に DataChannel を開く 3 通り | role がずれる 2 件が失敗 | 3 件成功 |

opt-in のテストは `cd packages/webrtc && WERIFT_LEGACY_RELEASE_AUTO_INSTALL=1 npm run test:legacy-werift` で実行できます（`WERIFT_LEGACY_RELEASE_VERSION` で版を変更）。修正前の欄は、HEAD のソースに新しいテストだけを入れた一時 worktree で確認しました。

## 4. 修正しなかったもの

### 4.1 現行側を DTLS 1.3 のみにした構成

1.3 だけを提示する現行と、1.2 にしか対応しない旧 werift はつながりません（設定どおり）。現行が DTLS server のときは 10 秒以内に `failed` になります。現行が DTLS client のときは、旧 werift の server が ClientHello を内部で拒否するだけで alert を返さないため、現行側は応答のない相手と区別できず、再送の上限（10 回、指数バックオフ、上限 RTO）に達するまで `connecting` のままです。応答のない相手に対する既存の振る舞いと同じなので、変更していません。旧 werift と接続する可能性がある場合は `[1.3, 1.2]` を使ってください（§3.1 の修正でつながります）。

### 4.2 0.24.4 以前との非互換（0.26.0 でも同じ）

修正後の現行で、0.25.2 との失敗は §4.1 の 4 件だけでした。0.24.4 以前では次の失敗が加わりますが、現行側を公開済みの 0.26.0 に置き換えても同じケースが同じように失敗するため、本ブランチによる回帰ではなく、旧リリース側の既存の非互換です。

| 旧リリース | 失敗する領域（0.26.0 でも失敗） |
|---|---|
| 0.24.4 | J: 旧側が PeerConnection を close しても、相手の DataChannel が閉じない |
| 0.22.9 | F: ICE restart で一方が `failed`、G: ICE-TCP で開かない、J: 同上 |
| 0.20.1 / 0.19.9 | D: 旧側が相手の RTP を受け取らない、G: ICE-TCP で開かない、I: 再交渉で追加した音声を旧側が受け取らない（旧側が受信側の 2 通り） |

## 5. 検証

| 確認 | 結果 |
|---|---|
| 調査用の 60 ケース（0.26.0） | 修正前 11 件失敗 → 修正後は §4.1 の 4 件だけ |
| 同（0.25.2 / 0.24.4 / 0.22.9 / 0.20.1 / 0.19.9） | §4.1 の 4 件と §4.2 の既存の非互換だけ |
| `legacyWeriftRelease.test.ts`（0.26.0、`--retry=0`） | 21/21 |
| `packages/sctp` | 80 passed |
| `packages/dtls` | 470 passed / 1 skipped |
| `packages/webrtc`（`tests/` 以下） | 1896 passed / 27 skipped。失敗 5 件は HEAD でも同じく失敗（§6） |
| Chromium E2E（`e2e/run-ci.js` と `run-dtls-ci.js`） | 66 / 18 passed。`npm run e2e` は §6 の型エラーで事前の `tsc` が止まるため、`tsc` の終了コードを無視して同じ手順を実行した |
| 型エラーの数（package ごと） | HEAD と同じ（増えていない） |

## 6. 別に見つかった問題（本件の範囲外、未対応）

いずれも HEAD（`develop` と `warp` のマージ後）で、本件の変更の前から起きています。

- **`erasableSyntaxOnly` の型エラー:** マージで入った「ソースは消去可能な構文だけ」（Node.js 26 の型除去のみ）の規則に、本チケットで追加したコードが従っていません。parameter property や `enum` のため、package ごとの `tsc` で dtls 40 件、webrtc 49 件（import する dtls・ice のソースを含む）、ice 2 件、rtp 1 件の型エラーがあり、`npm run type`、`npm run e2e` の事前の `tsc`、`tests/nonstandard/polyfill.test.ts`、`tests/types/publicTypes.test.ts` が失敗します。webrtc にはこのほかに `transportActivation.ts` の TS2339 が 1 件あります。Node.js の型除去だけでは本ブランチのソースを実行できません（調査では Node.js 24 の `--experimental-transform-types` で実行した）。
- **`packages/webrtc/doc` が commit されている:** 別チケットの自動 commit（`004fcafc8`）で 873 ファイルが入っています。`npm run doc` が途中で止まった残りと思われます。`npm test`（`vitest run ./tests`）がその下の例のテストまで拾います。
- **memleak の 2 シナリオ（DataChannel / メディア）:** HEAD でも処理数 0 のまま時間切れになります（`npm run memleak`、ローカルのみ）。
