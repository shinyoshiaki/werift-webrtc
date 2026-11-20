# WPTをGHAの別ワークフローに切り離す

## 目的と背景
`npm run ci` が `wpt` / `wpt:coverage` まで含み、Node CI ジョブが長大化・不安定化していた。WPT を独立した GitHub Actions ワークフローに切り離し、通常 CI と並列実行・個別再実行できるようにする。(Issue は特定できず、タイトルから詳細化。)

## 変更内容
- ルート `package.json` の `ci` から `wpt` `wpt:coverage` を除外。
- `.github/workflows/wpt.yml` を新設（submodule 初期化、Node 24/26 マトリクス、build、`npm run wpt:coverage` のみ。内部で WPT 本体を実行するため `npm run wpt` は呼ばない）。
- `AGENTS.md` の Commands 表を更新。

## 制約
- WPT は submodule (`third_party/wpt`) が必要。ゲートは `packages/webrtc/wpt/baseline.json` のまま変更しない。
- `nodejs.yml` の他ステップは変更しない。

## 完了条件
- `npm run ci` が WPT を実行しない。
- `wpt.yml` が push / PR / 手動で `wpt:coverage` 1回で WPT 本体と coverage を実行する（二重実行しない）。
- ドキュメントが整合している。
