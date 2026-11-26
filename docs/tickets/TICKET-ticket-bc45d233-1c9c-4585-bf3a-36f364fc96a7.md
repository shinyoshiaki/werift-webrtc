## 1. 目的と背景

- 親チケット 21a27c92（Firefox `a=bundle-only` 対応）では、実装の指摘がすべて解消した後も、`npm run pbt:deep` の exit 1 だけでレビューが通らなかった。
- 原因は、変更と無関係な既知の flake（model seed 275「the transport did not settle」、develop でも再現）と、P3（heap slope）の統計的な判定（leak heap seed 4 が閾値 16.00 KiB/cycle に対して 16.01）だった。
- `packages/webrtc/tools/pbt-deep/run.ts` は、失敗した seed を単独で 1 回だけ再実行し、それも失敗すれば exit 1 にする。比較元（develop）でも失敗するかを区別する仕組みがない。そのため、変更起因の失敗と以前からの失敗が同じ exit 1 になり、レビューの判定が運とレビュアーの解釈に左右される。

## 2. 作業内容

1. 比較元との突き合わせモードを追加する。例: `npm run pbt:deep -- --baseline <worktree>`。`tools/negotiation-diff` と同じく、比較元は `git worktree add --detach` で作った一時 worktree を使う（ルート `AGENTS.md` Do 7）。
   - 確定した失敗（単独再実行でも失敗）を、同じ env で比較元でも再生する。
   - 比較元でも同じ形で失敗するものは「以前からの失敗（pre-existing）」として報告し、exit code に含めない。比較元で通るものだけを exit 1 にする。
   - 失敗の「同じ形」の判定基準（テスト名・エラーメッセージの一致など）を決めて記載する。
2. 代案または併用として、既知の flake の一覧（seed・suite・メッセージ・記載箇所）を 1 か所で持ち、一覧にある失敗は exit code に含めずに明示して報告する。一覧に載せる条件（比較元での再現記録があること）も決める。
3. P3（heap slope）の扱いを決める。統計的な判定なので、レビューの必須項目から外すか、比較元との比較で判定する。閾値を緩めるだけの対応はしない。
4. 出力の最後に、confirmed / pre-existing / flaky の内訳を表示し、レビュアーが判定しやすい形にする。
5. `packages/webrtc/AGENTS.md` の Do 7 / Commands / Validation と、`run.ts` 冒頭のコメントを更新する。

## 3. 完了条件

- [ ] 比較元と突き合わせるモード（または既知 flake の一覧）があり、以前からの失敗が exit code に含まれない。
- [ ] 変更起因の失敗（比較元で通る seed）は従来どおり exit 1 になることをテストまたは手順で確認している。
- [ ] P3 の扱いが決まり、ドキュメントに反映されている。
- [ ] `packages/webrtc/AGENTS.md` と `run.ts` のコメントが更新されている。
- [ ] `cd packages/webrtc && npm run type && npm test` が通る。

## 4. 制約

- 本当の失敗を隠さない。閾値やテストを緩めない。
- TypeScript は `node --import ../../tools/node-ts/register.mjs` で実行し、erasable な構文だけを使う（ルート `AGENTS.md`）。