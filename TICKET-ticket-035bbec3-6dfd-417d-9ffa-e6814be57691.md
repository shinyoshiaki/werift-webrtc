# Avoid synchronous crypto.randomBytes() on ICE initialization paths

## 1. 目的と背景

ICE の初期化（`Connection` 生成）と STUN/TURN トランザクションでは、ICE credentials・tie-breaker・トランザクション ID の生成に同期版の `crypto.randomBytes()` を使っている。同期 native crypto 呼び出しは返るまで Node.js のイベントループを止める。

通常は数 µs で終わるので頻繁に起きる障害ではなく、**堅牢性の改善**として扱う。目的は次の 3 点。

- 乱数生成を **1 か所の差し替え可能な乱数ソース** に集約し、テストから遅延や失敗を注入できるようにする。
- `Connection` 生成時の **不要な乱数取得（credentials の二重生成）** をなくす。
- ICE 初期化のクリティカルパスで、OS エントロピーの読み取りを同期的に待つ必要がない構造にする。

### 調査で判明した事実

| 項目 | 内容 |
| --- | --- |
| Node.js の要件 | ルート `package.json` の `engines.node` は `>=22`（開発環境は v24）。 |
| `randomBytes` 同期版の実態 | 呼び出しごとに OS エントロピーを読むわけではない。OpenSSL の CSPRNG（`RAND_bytes`）は初回にシードされ、以降は CPU 処理だけで値を返す。ブロックの心配があるのは、**カーネルのエントロピープールが初期化される前（起動直後・VM / コンテナの cold start）に最初のシードを行う場合**にほぼ限られる。 |
| `webcrypto.getRandomValues` | Node では同期 API で、同じ OpenSSL CSPRNG を使う。**ブロック特性は `randomBytes` 同期版と実質変わらない**。Option B だけでは「同期待ちの排除」にならない。利点は primitive の明示と差し替えのしやすさにとどまる。 |
| `randomUUID()` | Node 内部にエントロピーキャッシュ（UUID 128 個分のプール）がある。werift はこれを `Candidate.id`、`IceGatherer.id` などで広く使っている（本チケットの対象外）。 |

## 2. 現状のコード（調査結果）

### `packages/ice/src/helper.ts`

```ts
import { randomBytes } from "crypto";

export function randomString(length: number) {
  return randomBytes(length).toString("hex").substring(0, length);
}

export function randomTransactionId() {
  return randomBytes(12);
}
```

- `randomString(n)` は n バイト取得し、hex 化してから **n 文字に切り詰める**。取得したバイトの半分は捨てていて、実効エントロピーは `4 * n` bit。
- `randomTransactionId()` の利用箇所は `packages/ice/src/turn/protocol.ts:521`（TURN リクエストの再送で ID を振り直す処理）の 1 か所だけ。

### `packages/ice/src/ice.ts`（`Connection`）

| 行 | 処理 |
| --- | --- |
| L47-48 | フィールド初期化子の `localUsername = randomString(4)` と `localPassword = randomString(22)` |
| L61 | `private readonly tieBreaker: bigint = randomBytes(8).readBigUInt64BE(0)` |
| L99 | constructor の末尾で `this.restart()` を呼ぶ |
| L172-182 | `restart()` の中で再び `randomString(4)` と `randomString(22)` を実行し、`userHistory` に登録する |
| L1598 | peer-reflexive 候補の foundation 用の `randomString(10)` |

- **L47-48 で作った credentials は、constructor 内の `restart()` ですぐ上書きされる（無駄な乱数取得）**。ただし初期化子の値は `userHistory` には登録されないので、機能上の副作用はない。
- `restart()` は `async` 宣言だが、`await` が出てくるより前の処理（credentials 生成を含む）は同期的に実行される。constructor は `await` せずに呼び、この性質に依存している。
- `packages/webrtc/src/transport/ice.ts:382`（`RTCIceGatherer` の constructor）で `new Connection(false, options)` を同期的に生成している。`localParameters` getter（L414-419）はその直後から `connection.localUsername/localPassword` を同期参照する。

### STUN トランザクション ID の実際の生成元（チケット原文で漏れていた点）

`packages/ice/src/stun/message.ts` は `packages/ice-server/src/stun/message.ts` の re-export にすぎない。

```ts
// packages/ice-server/src/stun/message.ts:120-
export class Message extends AttributeRepository {
  constructor(
    public messageMethod: methods,
    public messageClass: classes,
    public transactionId: Buffer = randomBytes(12),
    ...
```

STUN/TURN/ICE のほぼすべてのリクエスト（`ice.ts:1723` の connectivity check、`iceBase.ts:346`、`utils.ts:21`、`turn/protocol.ts` の ALLOCATE / REFRESH / CREATE_PERMISSION / CHANNEL_BIND / SEND など）は、**この default 引数の `randomBytes(12)` で ID を得ている**。`helper.ts` の `randomTransactionId()` だけ直しても、トランザクション ID の大部分は変わらない。

### 関連するが本チケットのスコープ外の同期乱数

`packages/common/src/binary.ts`（`random16/random32`）、`packages/webrtc/src/sdp.ts:696`、`packages/webrtc/src/media/rtpSender.ts:148-149`（SSRC）、`packages/dtls/*`、`packages/sctp/src/sctp.ts:135`。いずれも ICE 初期化パスの外なので、本チケットでは触らない。必要なら別チケットにする。

## 3. 実装すべき変更内容

### 3.1 乱数ソースの集約と注入ポイント（必須）

- `packages/ice/src/helper.ts`（または新規の `packages/ice/src/random.ts`）に、**ICE パッケージ共通の乱数ソース**を定義する。

  ```ts
  export interface RandomSource {
    /** n バイトの暗号学的乱数を同期的に返す */
    bytes(length: number): Buffer;
  }
  ```

- `randomString` / `randomTransactionId` / tie-breaker 生成をすべてこのソース経由にする。tie-breaker 用には `randomTieBreaker(): bigint` のようなヘルパーを追加する。
- `ice.ts` の `import { randomBytes } from "crypto"` を削除し、直接呼び出しをなくす。
- テストから差し替える手段を用意する。例: `IceOptions` に internal なオプションを追加するか、モジュールレベルの setter（`setRandomSourceForTesting()` など、`@internal` 付き）。公開 API を増やしたくない場合はモジュールレベルの setter を推奨。

### 3.2 credentials の二重生成を削除（必須）

- `localUsername` / `localPassword` のフィールド初期化子をやめ、`localUsername!: string` のような宣言、または `""` による初期化に変える。初回の生成は `restart()` の 1 回だけにする。
- `restart()` の credentials 生成部分は private メソッド（例: `generateLocalCredentials()`）に切り出す。constructor と ICE restart の両方から使えるようにする。
- `generation` の初期値は `-1` で、constructor の `restart()` 呼び出しで `0` になる。この挙動は維持する。

### 3.3 トランザクション ID 生成の集約（必須）

- `ice-server` の `Message` constructor の default 引数 `randomBytes(12)` を、共通の乱数ヘルパー経由に置き換える。
  - `ice-server` は `ice` に依存しない（依存は逆向き）。ヘルパーは `ice-server` 側に置く（例: `packages/ice-server/src/stun/random.ts`）。`ice` 側の `randomTransactionId()` はそこから import / re-export する。
  - `ice-server` 側の `turn/protocol.ts:1072`（nonce 生成など）は、ついでに揃えてもよい。ただし必須ではない。
- `turn/protocol.ts:521` の `randomTransactionId()` は、集約したヘルパーを使い続ける。

### 3.4 エントロピー取得方式の選定（下記 4 章の推奨に従う）

推奨方針は **Option C（非同期で補充するプール）を、デフォルト実装の任意の改善として載せる**こと。最低限の完了ラインは 3.1〜3.3 と、テストから遅延や失敗を注入できる状態。

## 4. 技術的アプローチの比較と推奨

| 案 | 内容 | 長所 | 短所 / 注意 |
| --- | --- | --- | --- |
| A: 非同期初期化 | callback 版 `randomBytes` で credentials と tie-breaker を事前生成し、async factory で `Connection` を作る | イベントループを確実に止めない | `new Connection()` と `RTCIceGatherer` constructor、`localParameters` の同期参照など `packages/webrtc` 全体の API が壊れる。**不採用** |
| B: `webcrypto.getRandomValues` | 固定長の TypedArray で同期取得 | 変更が小さい。primitive が明示的になる | Node では `randomBytes` 同期版と同じ CSPRNG なので、**ブロック特性は改善しない**。単独では目的を満たさない |
| C: 非同期補充プール | 例えば 256〜1024 バイトのプールを callback 版 `randomBytes` で非同期に補充し、同期 API は先頭から切り出して返す。不足したら同期版 `randomFillSync` にフォールバックし、非同期補充を予約する | 同期 API（`new Connection()`）を維持したまま、通常時はクリティカルパスで乱数取得を待たない | フォールバック時は同期取得になる（cold start 直後など）。プールからの切り出し後は **必ずゼロ埋めや再利用防止を行い、同じバイトを 2 回返さない**ことを保証する必要がある |

**推奨**: 3.1 の `RandomSource` 抽象を入れたうえで、デフォルト実装は **C（プール + 同期フォールバック）** とする。B は「同期フォールバック」に使う primitive の候補としてだけ扱う（`randomFillSync` と同等)。

### 実装メモ（C 案）

- モジュールロード時（またはプールの初回利用時）に `crypto.randomFill`（callback 版）で初回補充を開始する。プールが空なら同期フォールバックする。
- 残量がしきい値を下回ったら非同期補充を 1 本だけ予約する（多重補充を防ぐフラグを持つ）。
- 非同期補充の callback でエラーが起きたら握りつぶさない。プールを無効化して同期フォールバックに戻し、`debug` ログを出す（AGENTS.md の「broad catch-and-ignore 禁止」に従う）。
- 1 回の `Connection` 生成で消費するのは約 4 + 22 + 8 = 34 バイト（3.2 適用後）。トランザクション ID は 1 件 12 バイト。connectivity check が多いと消費が多いので、プールサイズは 512 バイト前後から始めて計測で調整する。
- プールの補充タイミングが vitest の open handle 検出やプロセス終了に影響しないことを確認する（callback 版 `randomFill` は threadpool タスクなので、終了をブロックしない想定）。

## 5. 制約・注意点

- **乱数の強度と長さを変えない**: ufrag は hex 4 文字、password は hex 22 文字、tie-breaker は 64 bit、トランザクション ID は 96 bit を維持する。`randomString` の出力文字集合（hex、`ice-char` の部分集合）も変えない。
  - 補足: RFC 8445 §5.3 は ufrag に 24 bit 以上、password に 128 bit 以上のランダム性を要求している。現状の hex 切り詰めでは ufrag が 16 bit、password が 88 bit しかない。これは本チケットでは**変更しない**（相互運用やテスト期待値に影響するため）。別チケットとして起票を検討する。
- **`localPasswordPrefix` の挙動を維持する**: `restart()` 内で prefix を前置し、末尾を切り詰める処理はそのまま残す。
- **`Connection` / `RTCIceGatherer` の同期生成 API を壊さない**: `packages/webrtc` 側は `new Connection()` 直後に `localParameters` を参照している。
- **`ice-server` とのパッケージ境界**: `ice` は `ice-server` のソースを相対 import / re-export している（`../../../ice-server/src/...`）。逆向きの依存は作らない。変更前に `packages/ice-server/AGENTS.md` を読む。
- **暗号学的安全性**: `Math.random` などの非 CSPRNG にフォールバックしない。プールのバイトは使い回さない。
- **テストの決定性**: 既存テスト（`consent.test.ts` では `Math.random` を spy している）を壊さない。乱数ソースを差し替えたテストは `afterEach` で必ずデフォルトに戻す。
- **公開 API**: 注入用の API を外部に公開する場合は `@internal` を付け、typedoc（`npm run doc`）の出力に出ないようにする。公開 API を増やす場合は README / docs を更新する。

## 6. テスト計画

AGENTS.md に従い Arrange / Act / Assert の 3 フェーズで書く。Arrange のユーティリティは `packages/ice/tests/utils.ts` に集約し、Act / Assert には日本語コメントを付ける。

1. **credentials の生成が 1 回だけであることの検証**（`packages/ice/tests/ice/` に新しいテストファイルを追加。例: `random.test.ts`）
   - Arrange: 呼び出し回数と要求バイト数を記録する spy 付き `RandomSource` を注入するユーティリティを `tests/utils.ts` に追加する。
   - Act: `new Connection(true)`
   - Assert: ufrag 用（4 バイト）と password 用（22 バイト）の取得がそれぞれ 1 回だけで、tie-breaker 用（8 バイト）も 1 回だけ。`userHistory` のキーが 1 件で、`localUsername` と一致する。
2. **長さと形式の維持**
   - `localUsername` が `/^[0-9a-f]{4}$/`、`localPassword` が `/^[0-9a-f]{22}$/` に一致する。`localPasswordPrefix` を指定した場合は prefix を含めて 22 文字になる。
   - トランザクション ID が 12 バイトの `Buffer` で、`Message` を連続生成しても重複しない。
3. **乱数ソースの遅延と失敗の注入**
   - 失敗するソースを注入すると、`new Connection()` がエラーを握りつぶさずに例外を伝播する（または仕様として決めた挙動になる）。
   - （C 案を採用した場合）プールが空のとき同期フォールバックで正しい長さの値を返す。非同期補充が遅延または失敗しても、`new Connection()` は完了する。
4. **プールの安全性**（C 案を採用した場合）: 連続して切り出したバイト列に重複区間がない（同じオフセットを 2 回返さない）。
5. **クリティカルパス上で同期取得しないことの回帰テスト**（C 案を採用した場合）: プールの補充完了後に `crypto.randomFillSync` / `randomBytes` を spy し、`new Connection()` の実行中に同期 API が呼ばれないことを確認する。
6. 既存の `packages/ice/tests/ice/*.test.ts`（特に `ice.test.ts`、`consent-restart.test.ts`、`turn-protocol-lifecycle.test.ts`）と `packages/ice/tests/stun/stun.test.ts` が通ること。

## 7. 完了条件

- [ ] `packages/ice/src/ice.ts` から `crypto.randomBytes` の直接呼び出しがなくなり、乱数取得はすべて集約したヘルパー（`RandomSource`）経由になっている。
- [ ] `Connection` の constructor で ICE credentials の生成が 1 回だけになっている（フィールド初期化子による二重生成を削除）。
- [ ] `ice-server` の `Message` の default トランザクション ID と、`ice` の `randomTransactionId()` が集約ヘルパーを使っている。
- [ ] テストから乱数ソースを差し替えて、遅延や失敗を注入できる。
- [ ] ufrag（hex 4 文字）、password（hex 22 文字、prefix の挙動を含む）、tie-breaker（64 bit）、トランザクション ID（96 bit）の長さと形式が変わっていない。
- [ ] （採用した場合）非同期補充プールが実装されていて、補充済みの状態では `new Connection()` が同期エントロピー API を呼ばないことをテストで確認している。
- [ ] 上記 6 章のテストを追加済み。Arrange ユーティリティは `packages/ice/tests/utils.ts` にあり、Act / Assert に日本語コメントがある。
- [ ] 以下の検証コマンドが成功している。
  - `cd packages/ice && npm run type && npm test`
  - `cd packages/ice-server && npm run type && npm test`（`Message` を変更するため。コマンドは同パッケージの `package.json` / `AGENTS.md` で確認する）
  - ICE と ice-server の 2 パッケージにまたがり、プロトコルの基盤にも関わるため、`npm run type` と `npm run test:small` も実行する。
- [ ] 公開 API を追加または変更した場合は、関連する docs / README を更新している。RFC 8445 のエントロピー不足は、必要に応じて別チケットとして記録している。
