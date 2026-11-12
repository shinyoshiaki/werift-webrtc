## 1. 目的と背景

- `e2e/` には Firefox 用の設定（`vitest.firefox.config.mts`、`npm run firefox`）がある。しかし CI（`.github/workflows/nodejs.yml`、`e2e/run-ci.js`）が実行するのは Chrome だけで、Firefox の E2E は保守されていない。
- 親チケット #269 の確認（2026-11-12、HEAD `7ffcaaf9a`、Firefox 157 / Playwright 1.64.1）では、この環境で既定設定の基本テストも全件失敗した。
  - `tests/datachannel/datachannel.test.ts`: 3 件すべて `Test timed out in 20000ms`
  - `tests/mediachannel/sendrecv.test.ts`: すべて失敗（`waitVideoPlay timed out`）
  - `tests/bundle/*`: すべて失敗
  - `media.peerconnection.ice.obfuscate_host_addresses: false`（mDNS 秘匿の無効化）を追加しても、datachannel / sendrecv の結果は変わらない。
- 一方、**同じ環境で Node の werift と Playwright の Firefox を直接つなぐと、DataChannel が成立する**。これは Firefox の既定設定（mDNS 秘匿あり）でも、`stun:stun.l.google.com` を設定しても同じだった。したがって原因は werift と Firefox の非互換ではなく、E2E 経路のどこかにある。候補は vitest browser（Firefox）のテストページ、protoo のシグナリング、候補のトリクル中継、e2e サーバー（`lib/e2e/server/main.js`）である。
- werift ↔ Firefox の既知の不具合は、別のサブタスクで扱う。
  - `a=bundle-only` 未対応（`c=` のない answer）
  - werift 起点の ICE restart の後に Firefox の受信が止まる

  この 2 件に依存するテストは、修正されるまで Firefox で失敗し得る。

## 2. 調査の方向

- まず `tests/datachannel/datachannel.test.ts` の 1 件に絞り、どこで止まるかを特定する。確認するのは次のとおり。
  - protoo の `peer` が `open` するか
  - offer / answer / candidate の各リクエストがサーバーに届くか
  - Firefox / werift の ICE 状態
- 確認する仮説:
  - vitest browser の Firefox で WebSocket（`ws://localhost:<E2E_PORT>`）がつながっているか
  - トリクル中継で `candidate` が `null` / 空文字のときの扱い（Firefox は end-of-candidates を空文字の candidate で通知する）
  - mDNS の `.local` 候補（コンテナ内では解決できない可能性）
  - `firefoxUserPrefs` の不足
  - Playwright の Firefox のバージョン差
- 失敗の分類: E2E の基盤（シグナリング、設定）の問題は本サブタスクで直す。werift 本体の不具合は、既存の 2 サブタスクか新しいサブタスクに回す。ブラウザ固有でテストの前提が成り立たないもの（例: Firefox は pranswer 未実装）は、ブラウザ判定（`browserName`、`tests/fixture.ts`）で理由付きでスキップする。
- 保守のための整備:
  - `npm run firefox` を単独で回せる手順を `e2e/` の README / AGENTS.md に書く（E2E_PORT、サーバーの起動と停止、`PLAYWRIGHT_BROWSERS_PATH`）。
  - CI に組み込むかどうか（ジョブを分けるか、nightly か、対象を絞った subset か）を判断し、理由をチケットに残す。
  - `ensure-browser.js` が Firefox も取得するようにする。

## 3. 完了条件

- [ ] `e2e/` の Firefox 実行で、datachannel、mediachannel、bundle など主要なテストが通る。通らないものは原因（werift 本体の不具合サブタスク、またはブラウザ未対応）を明記してスキップする。
- [ ] Firefox E2E を単独で実行する手順と、保守の方針（CI に組み込むか、その形）がドキュメントにある。
- [ ] Chrome E2E（`npm run e2e`）に回帰がない。
- [ ] `cd e2e && npm run type` が通る。`npm run format` を実行する。