---
ide:
  viewer: review-document
  version: 1
  title: "ICE: close() で pending な mDNS lookup を取り消す"
  dock: right
  baseCommit: f174ec79721ad56755e31696e08feeca1789f355
---
# ICE: close() で pending な mDNS lookup を取り消す

## 1. 概要

`Connection.close()` の後も remote `.local` 候補の mDNS 解決が 10 秒タイマー・`response` listener・未決 Promise を保持し続け、Node プロセスの終了を遅らせたり、閉じた connection に候補を追加したりしていました。`MdnsLookup` が pending な lookup をすべて所有して一括 cancel できるようにし、`Connection` 側は close を最初の `await` より前に確定させ、await 後にも closed を再確認するようにしました。公開 API とプロトコル挙動は変わりません。

<div style="display:flex;gap:12px">
  <div style="flex:1;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px">
    <strong>Before</strong><br>
    <code>lookup.close()</code> は <code>close()</code> の末尾で、socket を破棄するだけ。<br>
    timer / listener / Promise は 10 秒残る。<br>
    close 後の <code>addRemoteCandidate()</code> は <code>MdnsLookup</code> を新規生成して 5353 を再 bind する。
  </div>
  <div style="flex:1;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px">
    <strong>After</strong><br>
    <code>close()</code> の同期区間で lookup を close し、pending 全件を即 reject する。<br>
    timer / listener を解放する。<br>
    close 後の候補追加は入口で return し、lookup も生成しない。
  </div>
</div>

## 2. 主要変更

### 2.1 `MdnsLookup` が pending lookup を所有する

[packages/ice/src/dns/lookup.ts:15](review-file:packages/ice/src/dns/lookup.ts:15) の変更が核です。差分は [packages/ice/src/dns/lookup.ts](review-diff:packages/ice/src/dns/lookup.ts:35) です。

- `closed` フラグと、pending lookup の cancel 関数を持つ `Set` を追加しました。
- 解決・タイムアウト・cancel は共通の `settle()` を通ります。`pending.delete(cancel)` が false なら何もしないので、二重 settle や二重 remove は起きません。`settle()` は listener を外し、`clearTimeout` を呼び、Set から自分を外します。
- `close()` は冪等です。`closed = true`、pending 全件の cancel、`mdnsInstance.destroy()` の順に実行します。
- `closed` 後の `lookup()` は query も timer も作らず、即 reject します。
- constructor が `createMdns` factory を受け取ります（既定は `mdns()`）。テストが実 socket なしで書けます。
- `pendingCount` は `@internal` の観測用 getter です。
- `cache` と `mdnsInstance` の公開フィールドは残しています。最終コミットで、`mdnsInstance` を `mdns.MulticastDNS` 型にして既存利用者への互換を保つ調整が入りました。テストでも固定しています。

### 2.2 `Connection` の close 境界

差分は [packages/ice/src/ice.ts](review-diff:packages/ice/src/ice.ts:1883) です。

<svg viewBox="0 0 760 120" width="100%" role="img" aria-label="close() の同期区間と await 区間">
  <g fill="none" stroke="var(--review-border)">
    <rect x="6" y="20" width="440" height="60" rx="6" stroke="var(--review-accent)"/>
    <rect x="466" y="20" width="288" height="60" rx="6"/>
  </g>
  <g fill="var(--review-fg)" font-size="12">
    <text x="16" y="14" fill="var(--review-accent)">同期区間（最初の await より前）</text>
    <text x="16" y="42">closed = true → setState("closed") → endProvisional()</text>
    <text x="16" y="62">lookup.close() → lookup = undefined → remoteResolutions.clear()</text>
    <text x="476" y="14" fill="var(--review-muted)">await 区間</text>
    <text x="476" y="42">protocol.close() などを待つ</text>
    <text x="476" y="62">この間に応答が来ても候補は積まれない</text>
  </g>
</svg>

- [packages/ice/src/ice.ts:1883](review-file:packages/ice/src/ice.ts:1883): 単調な `private closed` フラグを導入しました。`state` は `restart()` で `"new"` に戻る経路があるため、`state === "closed"` では判定できないためです。
- [packages/ice/src/ice.ts:1891](review-file:packages/ice/src/ice.ts:1891): `lookup.close()` / `lookup = undefined` / `remoteResolutions.clear()` を、以前の末尾から同期区間に移しました。
- [packages/ice/src/ice.ts:1941](review-file:packages/ice/src/ice.ts:1941): `addRemoteCandidate()` は入口で closed なら即 return します。close 後に `MdnsLookup` を再生成するリーク経路を塞ぎます。
- [packages/ice/src/ice.ts:1976](review-file:packages/ice/src/ice.ts:1976): mDNS の await 後の判定に closed を追加しました。
- [packages/ice/src/ice.ts:1952](review-file:packages/ice/src/ice.ts:1952): EOC 経路でも `allSettled` 後に closed を見て、`remoteCandidatesEnd` を更新しません。
- [packages/ice/src/ice.ts:408](review-file:packages/ice/src/ice.ts:408): `addProvisionalRemoteCandidate()` は入口と `current()` に closed 条件を足しました。

### 2.3 テスト

- [packages/ice/tests/ice/mdns-close.test.ts](review-file:packages/ice/tests/ice/mdns-close.test.ts): 新規 15 ケースです。
  - `MdnsLookup` 単体: 解決、タイムアウト、一括 cancel、close 後の lookup、冪等な close、公開型の維持。
  - `Connection`: pending 2 件の close、`close()` の await 中の応答、応答直後の close、close 後の候補、EOC、provisional、二重 close、通常の解決。
- [packages/ice/tests/utils.ts:1652](review-file:packages/ice/tests/utils.ts:1652): `createFakeMdns` / `installFakeMdnsLookup` / `addClosingProtocol` を共有 Arrange として追加しました（AGENTS.md の方針どおり）。

## 3. 判断理由

| 案 | 判断 |
| --- | --- |
| A: `MdnsLookup` に cancel 集合と `closed` を持たせ、`Connection` は早期 close と再チェック | 採用。変更が `lookup.ts` / `ice.ts` に閉じ、チケットの完了条件を満たします。 |
| B: `AbortSignal` を `lookup()` に渡す | 見送り。`restart()` が lookup ごと close する現状では効果が同じで、変更量だけ増えます。generation 単位の cancel が要る将来に拡張します。 |
| C: `closedSignal` と `Promise.race` | 不採用。timer / listener が残るので根本解決になりません。 |

`restart()` は既存の `lookup.close()` が今回 pending を即 reject するようになるため、追加変更なしです。続きは既存の generation check で捨てられます。

## 4. レビュアーが確認すべき点・リスク

- **cancel 由来の reject の扱い**: `addRemoteCandidate()` / `addProvisionalRemoteCandidate()` の既存 `try/catch` と `allSettled` で受けています。新しい握り潰しは足していません。
- **二重 close**: `stateChanged` の再発火は今回の範囲では変えていません。lookup 周りだけを no-op にしています。
- **`restart()` 後の挙動**: `restart()` は lookup を close して `lookup = undefined` にします。以後の `addRemoteCandidate()` は新しい `MdnsLookup` を作ります（`closed` は restart では立たない）。この点は従来どおりです。
- **公開面**: `MdnsLookup` の constructor に optional 引数が増えただけで、後方互換です。`pendingCount` は `@internal` です。
- **スコープ外**: #744（local gathering / TURN 生成のキャンセル）は扱いません。`restartRemote()` で旧 lookup を cancel する任意項目も未実施です。
- **webrtc 側**: `packages/webrtc` は変更していません。

## 5. 検証結果

今回の作業（解説作成時）に実行したものです。

| コマンド | 結果 |
| --- | --- |
| `cd packages/ice && npx vitest run tests/ice/mdns-close.test.ts tests/ice/end-of-candidates.test.ts` | 2 ファイル / 21 テスト pass |
| `cd packages/ice && npx vitest run`（ice パッケージ全体） | 40 ファイル pass、1 ファイル skip / 313 pass、5 skip |
| `cd packages/ice && npm run type` | **実行したが失敗**。この環境の `tsc` 5.7.3 が `tsconfig.json` の `moduleResolution: "bundler"` を `TS5095` で拒否します。ソースの型エラーではなく環境側の問題と見ていますが、型検査としては未確認です。 |

未実施: `packages/webrtc` のテスト、`npm run type` / `npm run test:small`（ワークスペース全体）。チケットは webrtc 側の確認を求めているため、未確認事項として残ります。
