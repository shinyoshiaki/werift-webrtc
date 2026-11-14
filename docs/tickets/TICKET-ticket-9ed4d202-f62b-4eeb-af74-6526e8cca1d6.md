## 背景

`pages-build-deployment` の `deploy` ジョブが断続的に失敗している。

- 失敗例
  - run 42734300604 / job 129559961612（`23292efc6` verup 0.27.0）
  - run 42718882043（`b4c5470e1`）
- 症状: `Current status: syncing_files` のまま約 10 分経過し、`Timeout reached, aborting!` で中止される。`build` ジョブは成功している。
- 直前の `367874fbf` は、ほぼ同じ中身で約 2 分で成功している。コード起因ではなく、成果物の規模が原因。

## 原因

- GitHub Pages が legacy ビルドで、`develop` のルート `/` を公開している。`.nojekyll` もあるため、リポジトリ全体が加工なしで公開される。
- ビルドがサブモジュールを `submodules: recursive` で取り込むため、`third_party/wpt`（web-platform-tests）まで成果物に入る。
  - 成果物は約 168,000 ファイル、約 117MB。
  - そのうち約 164,000 ファイルが `third_party/wpt` 配下。
  - 同期が Pages 側の上限時間に近く、成功するか時間切れになるかが毎回の状況次第になっている。
- 公開内容も役に立っていない。
  - ルートに `index.html` がない。
  - `doc/` は TypeDoc の Markdown 出力で、`.nojekyll` のため HTML に変換されない。

## 対応方針

1. Pages のソースを GitHub Actions に切り替える前提で、Pages 専用のワークフロー（例: `.github/workflows/pages.yml`）を追加する。
   - サブモジュールを checkout しない。
   - 公開したいものだけを `actions/upload-pages-artifact` でアップロードし、`actions/deploy-pages` でデプロイする。
   - 公開対象の候補: TypeDoc の HTML 出力、または `doc/` を HTML 化したもの。
   - `npm run doc` の設定（Markdown 出力）を変えずに済む方法を優先する。
2. 公開対象のファイル数を大幅に減らす（目安: 数千ファイル以下）。WPT・`node_modules`・examples の依存などを含めない。
3. 既存の `doc/`・README のリンク（`https://shinyoshiaki.github.io/werift-webrtc/`）が引き続き有効か確認する。
4. リポジトリ設定 Settings > Pages > Source を "GitHub Actions" に変更する。これは手動操作になるので、PR 説明に手順として明記する。
5. ルートの `AGENTS.md` と、関係する README・docs を必要に応じて更新する。

## 完了条件

- 新しい Pages ワークフローが成功し、デプロイ時間が安定して数分以内に収まる。
- 成果物に `third_party/wpt` が含まれない。
- 公開サイトでドキュメントが閲覧できる（ルート URL が 404 にならない）。
- 既存の CI（`nodejs.yml`）に影響がない。