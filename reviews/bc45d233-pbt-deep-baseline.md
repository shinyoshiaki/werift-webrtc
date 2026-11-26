---
ide:
  viewer: review-document
  version: 1
  title: "pbt:deep の比較元突き合わせと P3 の扱い"
  dock: right
  baseCommit: 305a96d115db175a3c8bdca81885ca5c78d0374f
---
# pbt:deep の比較元突き合わせと P3 の扱い

## 概要

`npm run pbt:deep` に `--baseline <worktree root>` を追加しました。単独の再実行でも失敗した項目を比較元で再生し、同じ形で失敗したものは `pre-existing` として exit code から外します。P3（heap slope）は閾値を変えず、判定の assertion だけを「統計的な失敗」にしました。この失敗は `--baseline` がないと **大きさに関係なく exit code に入りません**。

対象は `develop`（`b925ad42d`）と `305a96d11` の差分です。変更はコミット済みで、下の diff リンクは履歴の一部のコミットだけを開くことがあります。全体は `git diff b925ad42d 305a96d11` で確認してください。

## 修正前の問題と修正後の仕組み

修正前は、単独の再実行でも失敗すれば exit 1 でした。変更が原因の失敗と、develop にもある失敗（model seed 275 の flake、heap seed 4 の 16.01 対 16.00 KiB/cycle）を区別できませんでした。

<div style="font-family:var(--review-font);color:var(--review-fg);display:flex;flex-wrap:wrap;gap:12px;font-size:13px">
  <style>
    .pbtb-col{flex:1;min-width:300px;border:1px solid var(--review-border);border-radius:8px;padding:10px}
    .pbtb-box{border:1px solid var(--review-border);border-radius:6px;padding:6px 8px;background:var(--review-surface)}
    .pbtb-arrow{text-align:center;color:var(--review-muted);line-height:1.4}
    .pbtb-bad{border:2px solid var(--review-danger)}
    .pbtb-new{border:2px solid var(--review-accent)}
    .pbtb-ok{border:2px solid var(--review-success)}
  </style>
  <div class="pbtb-col">
    <strong>Before</strong>
    <div class="pbtb-box">分割を実行して失敗</div>
    <div class="pbtb-arrow">↓</div>
    <div class="pbtb-box">単独で 1 回再実行<br>通れば flaky（exit code の対象外）</div>
    <div class="pbtb-arrow">↓ また失敗</div>
    <div class="pbtb-box pbtb-bad"><strong>問題:</strong> 比較せずに confirmed → exit 1<br>以前からの失敗も、変更が原因の失敗も同じ扱い</div>
  </div>
  <div class="pbtb-col">
    <strong>After</strong>
    <div class="pbtb-box">分割を実行して失敗</div>
    <div class="pbtb-arrow">↓</div>
    <div class="pbtb-box">単独で 1 回再実行<br>通れば flaky（exit code の対象外）</div>
    <div class="pbtb-arrow">↓ また失敗</div>
    <div class="pbtb-box pbtb-new"><strong>--baseline あり:</strong> runDeepSearch が比較元で最大 3 回再生し、sameFailure で照合</div>
    <div class="pbtb-arrow">↓</div>
    <div class="pbtb-box pbtb-ok">今回の版で観測した形がすべて再現<br>→ pre-existing（exit code の対象外）</div>
    <div class="pbtb-box" style="margin-top:4px">比較元が通る・形が違う・比較できない<br>→ confirmed → exit 1</div>
    <div class="pbtb-box pbtb-new" style="margin-top:8px"><strong>--baseline なし:</strong> P3 の判定 assertion だけ statistical（対象外）。ほかは confirmed → exit 1</div>
  </div>
</div>

凡例: 赤は問題の箇所、アクセント色は追加した分岐、緑は新しく exit code から外れる経路です。「テストを 1 件も実行しなかった分割」は比較せず、常に confirmed です。

照合の中心は [packages/pbt/src/deep.ts:388](review-diff:packages/pbt/src/deep.ts:388) の `sameFailure`、再生の流れは [packages/pbt/src/deep.ts:894](review-file:packages/pbt/src/deep.ts:894) です。

## 主要変更

### 1. 比較元の検証と引数の確認

次の場合は、分割を 1 つも実行せずに exit 2 で終わります。

- `--baseline` にパスがない（値なし、空文字、直後が別のオプション、`--baseline=` 形式）: [packages/pbt/src/deep.ts:182](review-file:packages/pbt/src/deep.ts:182)
- 比較元が使えない（パッケージがない、worktree の根でない、現在の worktree やそのパッケージ自身、commit を読めない、現在の HEAD を含む commit、vitest を解決できない）: [packages/pbt/src/deep.ts:552](review-diff:packages/pbt/src/deep.ts:552)

自分自身や変更後の版と比べると、すべての失敗が `pre-existing` になります。上の確認はこの誤った成功を防ぐためのものです。

### 2. 「同じ形」の判定

| 失敗の種類 | pre-existing になる条件 |
| --- | --- |
| テストの失敗 | 同じフルネーム（seed と再生用 env を含む）で、全エラーの署名が一致する |
| テスト結果の外のエラー（未処理例外、hook、ファイル） | 各エラーの署名が一致する。終了コードだけでは一致にしない |
| シグナル終了、レポートなし、説明できない終了コード、メッセージのないエラー | 比較できないので confirmed |
| テストを実行しなかった分割 | 比較しないので confirmed |

署名には、エラーの型と名前、メッセージ全文、`expected` と `actual`、送出元のファイルとソース行、`cause` と集約エラーを含めます。除くのは色コード、worktree の根、行と列の番号、ミリ秒の値です。実装は [packages/pbt/src/failureForm.ts:157](review-file:packages/pbt/src/failureForm.ts:157) です。

組み込みの JSON レポーターは `actual`、`cause`、テスト外のエラーを出力しないため、専用レポーターを追加しました: [packages/pbt/src/deepReporter.mjs](review-diff:packages/pbt/src/deepReporter.mjs)。現在の版のレポーターを `--reporter` で渡すので、比較元にこのファイルがなくても使えます。

同じ分割でテストの失敗が `pre-existing` でも、テスト外のエラーは別に判定します（[packages/pbt/src/deep.ts:840](review-file:packages/pbt/src/deep.ts:840)）。flaky と認めるのは、単独の再実行で失敗したテスト自身が通った場合だけで、skip は数えません（[packages/pbt/src/deep.ts:494](review-file:packages/pbt/src/deep.ts:494)）。

### 3. P3（heap slope）

<div style="font-family:var(--review-font);color:var(--review-fg);display:flex;flex-wrap:wrap;gap:12px;font-size:13px">
  <style>
    .pbtp-col{flex:1;min-width:300px;border:1px solid var(--review-border);border-radius:8px;padding:10px}
    .pbtp-row{border:1px solid var(--review-border);border-left:4px solid var(--review-border);border-radius:6px;padding:6px 8px;margin-top:6px}
    .pbtp-bad{border-left-color:var(--review-danger)}
    .pbtp-ok{border-left-color:var(--review-success)}
    .pbtp-new{border-left-color:var(--review-accent)}
  </style>
  <div class="pbtp-col">
    <strong>Before:</strong> heap の判定が失敗
    <div class="pbtp-row pbtp-bad">現在 16.01 / 比較元の状態は考慮しない<br>→ exit 1（閾値すれすれでも同じ）</div>
    <div class="pbtp-row">現在 400 / 比較元の状態は考慮しない<br>→ exit 1</div>
  </div>
  <div class="pbtp-col">
    <strong>After:</strong> --baseline ありの場合
    <div class="pbtp-row pbtp-ok">現在 16.01 / 比較元 17.50<br>→ pre-existing</div>
    <div class="pbtp-row pbtp-new">現在 400 / 比較元 16.01<br>→ 超過量が現在の版の方が大きい → exit 1</div>
    <div class="pbtp-row pbtp-new">現在 16.01 / 比較元は通る<br>→ exit 1</div>
    <strong style="display:block;margin-top:10px">After:</strong> --baseline なしの場合
    <div class="pbtp-row pbtp-bad">現在 16.01 でも 400 でも<br>→ statistical（exit code の対象外）</div>
  </div>
</div>

凡例: 数値は slope（KiB/cycle、閾値は 16.00）の例です。左の赤は修正前の問題、右の緑は除外される経路、アクセント色は失敗のまま残る経路、右の赤は注意が必要な経路を表します。slope の判定だけが失敗した場合の例です。

- 判定の `expect` にマーカーを付けました: [packages/webrtc/tests/pbt/leak/negotiationLeakProperty.test.ts:334](review-diff:packages/webrtc/tests/pbt/leak/negotiationLeakProperty.test.ts:334)
- heap の分割だけに `statistical`、`HEAP_VERDICT`、`heapVerdictExcess` を設定しました: [packages/webrtc/tests/pbt/suites.ts:52](review-diff:packages/webrtc/tests/pbt/suites.ts:52)、[packages/webrtc/tests/pbt/suites.ts:135](review-file:packages/webrtc/tests/pbt/suites.ts:135)
- 統計扱いになるのは、`cause` も集約エラーもない `AssertionError` で、マーカーがあり、残りの全文が `HEAP_VERDICT` に一致するものだけです: [packages/pbt/src/failureForm.ts:41](review-diff:packages/pbt/src/failureForm.ts:41)。操作の例外、タイムアウト、プロセス異常は通常の失敗です。
- 比較時は測定値を単位ごと `<n>` に置き換えて形をそろえ、閾値の超過量は bytes で別に比べます。比較元の超過量（再生した中の最大値）が、**すべての判定項目で現在の版以上** のときだけ `pre-existing` です。
- 現在の develop の assertion にはマーカーがありません。そのため、比較元側はマーカーがなくても `HEAP_VERDICT` に全文一致すれば同じ形とみなします。現在の版の失敗は、マーカーがなければ統計扱いになりません。

### 4. 出力とドキュメント

末尾に `summary:`（confirmed / pre-existing / flaky / statistical）を出力し、`pre-existing` には比較元のパスと commit を添えます。レビューの合格条件は、`--baseline` を付けた実行で `0 confirmed` になることです: [packages/webrtc/AGENTS.md:23](review-diff:packages/webrtc/AGENTS.md:23)、[packages/webrtc/AGENTS.md:68](review-file:packages/webrtc/AGENTS.md:68)。規則の詳細は [packages/pbt/README.md:39](review-diff:packages/pbt/README.md:39) にあります。

チケットが挙げる `packages/webrtc/tools/pbt-deep/run.ts` は存在しません。実行器は共通の `packages/pbt/src/deep.ts` なので、冒頭コメントもそこで更新しています。

## 判断理由

| 判断 | 理由と、採らなかった案 |
| --- | --- |
| 既知 flake の一覧を作らない | 一覧は根拠が古くなっても残る。比較元の再生なら、実行のたびに再現を確かめられる |
| 比較元を最大 3 回再生する | flake は毎回は再現しない。同じ形を 1 回観測すれば `pre-existing` とする |
| 署名に原因の全体を使う | 以前の実装案は先頭の 1 行だけを比べたため、別の原因が一致するとレビューで指摘された |
| P3 を必須項目から完全には外さない | `--baseline` を付ければ比較して判定できる。閾値は変えない |
| 超過量も比べる | 数値を `<n>` にするだけだと、比較元の 16.01 KiB/cycle が現在の版の 400 KiB/cycle を隠してしまう |

## レビュアーが確認すべき点とリスク

### exit code から外れる側

1. **`--baseline` なしの実行は、P3 の判定失敗がどれほど大きくても exit 0 になり得ます。** 変更前は exit 1 でした。出力には `statistical` と表示されます。`--baseline` を必須にしているのは `AGENTS.md` の規則で、コードは強制しません。
2. **比較元が develop かどうかは確認しません。** 拒否するのは、現在の HEAD を含む commit などです。古すぎる版や、変更の一部を含む同じブランチの以前の commit は受け付けます。`summary:` の commit が意図した比較元か確認してください。
3. **発生頻度の増加は検出できません。** 変更で flake が起きやすくなっても、比較元で 3 回中 1 回再現すれば `pre-existing` です。単独の再実行で通れば flaky になる扱いは、変更前と同じです。

### confirmed に残る側

4. **背景の 2 件が必ず除外されるわけではありません。** 比較元が通る場合は exit 1 です。P3 では、比較元の超過量が小さい場合や、超えた判定の組み合わせ（slope、margin、両方）が違う場合も exit 1 です。閾値付近のノイズではこれが起こり得ます。`--baseline-runs` を増やすと再現の機会は増えます。
5. **実行ごとに値が変わる失敗は一致しません。** メッセージのポート番号などは正規化しません。失敗した行のソースを変更した場合も一致しません。
6. `--baseline-runs` の値は検証していません。0、負の値、数値でない値では再生せず、失敗は confirmed のままです。

### 互換性と保守

- 変更はテスト基盤、テスト、文書、`.gitignore` だけで、公開パッケージの `src` は変えていません。
- `werift-pbt`（private）の export と、`DeepShard` の任意フィールド `statistical`、`statisticalVerdict`、`statisticalExcess` が増えます。
- `detectLeak` の文言や単位を変える場合は、`HEAP_VERDICT` と `heapVerdictExcess` も更新してください。`suites.test.ts` が実際の文言との一致を確認します。
- 軽微な文書の崩れがあります。[packages/pbt/README.md:38](review-file:packages/pbt/README.md:38) の次の見出し `### Baseline comparison` の前に空行がありません。また、分割方法を説明する [packages/pbt/README.md:118](review-file:packages/pbt/README.md:118) の段落が、この見出しの下に入っています。今回は修正していません。

## 検証結果

### この文書の作成時に `305a96d11` で実行したもの

| コマンド | 結果 |
| --- | --- |
| `cd packages/pbt && npm test` | 型検査が成功。3 ファイル、80 件が成功 |
| `cd packages/webrtc && npm run type && npm test` | exit 0。144 ファイル成功、5 ファイル skip。3334 件成功、194 件 skip |
| `npx vitest run tests/pbt/suites.test.ts`（webrtc） | 12 件成功 |
| `npm run pbt:deep -- --dry-run`（webrtc） | exit 0。heap の 4 分割が `statistical` |

比較元が通る失敗が exit 1 のままになることは、一時的な 2 つの worktree と実際の vitest プロセスを使うテストで確認しています: [packages/pbt/tests/deep.test.ts:276](review-file:packages/pbt/tests/deep.test.ts:276)。

### 未実施と未確認

- 全 seed の deep search は実行していません。
- 今回は、実際の develop の worktree を `--baseline` にした実行をしていません。
- 実装時の対応記録では、周回を 30 に短縮した heap seed 1〜4 を、マーカーのない develop（`7ca1d86aa`）と比較し、4 件すべてが `pre-existing`、exit 0 でした。ただし、これは超過量の比較と単位の処理を追加する前の実行で、最終版の確認にはなりません。
- 既知の flake の model seed 275 が、比較元と同じ形になるかは確認していません。
