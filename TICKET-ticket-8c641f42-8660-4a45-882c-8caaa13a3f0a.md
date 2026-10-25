親チケットの依存更新後のコードに npm run format を適用し、整形のみの差分をコミットしてください。packages/dtls/src/handshake/message/changeCipherSpec.ts の @ts-ignore が @ts-expect-error に変換されて TS2578 になる既知問題を直し、npm run build / type:all / test:small と format の2回目差分なしを確認してください。完了後に PR を作成し、このチケットへリンクしてください。

---

## 詳細化（エージェント調査結果）

関連 GitHub Issue: タイトル・description に Issue 番号/URL がないため特定できなかった。親チケット（依存更新: commit 96532d46〜7b385bbb 系）と直近履歴（1b9d83b2 "Revert repository-wide formatting", 03aef2af "Stop running the formatter during package builds"）から詳細化した。

### 1. 目的と背景
- 親チケットで依存（`@biomejs/biome` 2.6.2 など）を更新した結果、Biome の整形・lint 安全修正結果が既存コードと乖離した。
- 依存更新の差分と整形差分が混ざるのを避けるため、親チケットでは整形を一度 revert し、build 時の自動 format も停止した（03aef2af）。
- 本チケットで整形のみの差分を独立コミットとして適用する。

### 2. 実装内容
- ルートで `npm run format`（各 workspace の `biome check --write` + examples / e2e）を実行し、結果を整形のみのコミットにする。
- Biome の `suspicious/noTsIgnore` 修正で `//@ts-ignore` が `//@ts-expect-error` に変換されるが、`packages/dtls/src/handshake/message/changeCipherSpec.ts` では抑制対象のエラーが存在しない（コンストラクタ引数が省略可能なため `any[]` の spread が型エラーにならない）ので TS2578（未使用の `@ts-expect-error`）になる。
  - 根本対応: ディレクティブで抑制せず、デコード結果から `type` を明示的に取り出してコンストラクタへ渡す形に書き換える。

### 3. 技術的アプローチ
- `npm run format` → `git diff` 確認 → dtls 修正 → `npm run build` / `npm run type:all` / `npm run test:small` → `npm run format` 再実行で差分なしを確認。
- 整形コミットと TS2578 修正コミットを分け、レビューしやすくする。

### 4. 制約・注意点
- 整形以外のロジック変更を混ぜない（TS2578 修正のみ例外、別コミット）。
- 生成 docs（`doc/`, `packages/*/doc`）は format 対象外であり、公開 API は変わらないため再生成不要。
- 03aef2af の「build で format しない」方針は維持する。
- active worktree で stash / reset しない。

### 5. 完了条件
- [ ] `npm run format` 適用済みの整形コミットが存在する
- [ ] changeCipherSpec.ts の TS2578 が解消している
- [ ] `npm run build` / `npm run type:all` / `npm run test:small` が成功
- [ ] `npm run format` を再実行しても差分が出ない
- [ ] PR を作成し、このチケットにリンクする
