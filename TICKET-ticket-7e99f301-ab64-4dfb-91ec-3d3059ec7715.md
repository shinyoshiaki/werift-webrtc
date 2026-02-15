update_todo

● Glob "packages/sctp/**/*"

● Grep "createUdpTransport|export type \{ Transport \}|SCTP\.stop|stop\(\)" (packages/sctp)

● update_todo

● Read packages/sctp/src/sctp.ts lines 1230-1295

● Read packages/sctp/src/index.ts

● Read packages/sctp/src/transport.ts

● Read packages/sctp/README.md

● Read packages/sctp/package.json

● Grep "class SCTP|constructor\(|static client|static server|transport: Transport|readonly
transport|public transport|stop\(" (packages/sctp/src/sctp.ts)

● Grep "\.stop\(\)|transport\.close\(|sctp\.transport" in *.ts (packages)

● Read packages/sctp/tests/sctp.test.ts

● Read packages/sctp/tests/udp.test.ts

● Read packages/webrtc/src/transport/sctp.ts lines 300-410

● Read packages/webrtc/src/sctpManager.ts lines 1-190

● Grep "new SCTP\(|SCTP\.client\(|SCTP\.server\(" (packages/webrtc/src)

● Grep "export \* from "\.\/transport"|from "\.\/src\/transport"|createUdpTransport"
(packages/sctp/src)

● Grep ""werift-sctp"|packages/sctp|createUdpTransport" (package.json)

● Grep "onData\s*=|transport\.onData|transport.close\(" (packages/sctp/src/sctp.ts)

● Read package.json

● Read packages/sctp/src/sctp.ts lines 150-215

● Read packages/ice/src/index.ts

● Read packages/dtls/src/index.ts

● Read packages/rtp/src/index.ts

● Read packages/sctp/src/index.ts

● update_todo

● Create session plan file
  $ cat > /home/shin/.copilot/session-state/44fd1233-89fc-4fc2-bce6-b6f9eded88b1/plan.md << 'EOF'
  # Plan
  - sctp パッケージ公開APIと README の不整合を確認
  - SCTP.stop と transport.close の責務を確認
  - webrtc 側利用箇所を確認し互換性観点を整理...

● Read packages/sctp/tests/stream.test.ts lines 1-80

● Grep "from "\.\.\/src\/transport"" (packages/sctp/tests)

● Grep "from "\.\.\/src"" (packages/sctp/tests)

● update_todo

## 1. タスクの目的と背景

`packages/sctp/README.md` の利用例は `createUdpTransport` を `werift-sctp` から直接 import する前提ですが、実際の公開API（`packages/sctp/src/index.ts`）では `Transport` 型しか export されておらず、READMEどおりに使えません。  
調査上、`createUdpTransport` 自体は `packages/sctp/src/transport.ts` に実装済みで、内部テスト/サンプルもそれを直接 `../src/transport` から import して利用しています。  
加えて `SCTP.stop()`（`packages/sctp/src/sctp.ts`）は association を閉じる処理のみで `transport.close()` を呼ばず、UDPソケットのクローズ責務が利用者側に漏れている点が、README期待との乖離とリソース解放漏れの原因です。

---

## 2. 実装すべき具体的な機能や変更内容

- **公開API修正（必須）**
  - `packages/sctp/src/index.ts` から `createUdpTransport` を export する。
  - 必要に応じて `UdpTransport` も export（利用者が明示的にクラス利用したい場合の拡張性）。
  - 少なくとも README の import 文  
    `import { SCTP, WEBRTC_PPID, createUdpTransport } from "werift-sctp";`  
    がそのまま動く状態にする。

- **停止処理修正（必須）**
  - `SCTP.stop()` 内で `this.transport.close()` を呼ぶ。
  - 重複停止時の安全性を担保（`stop()` 多重呼び出し時に close を二重実行しない／例外化しない）。

- **テスト追加・更新（必須）**
  - `../src`（= index 経由）から `createUdpTransport` が import 可能であることを検証。
  - `SCTP.stop()` 実行時に transport の `close` が呼ばれることを検証（モック Transport で確認）。
  - 既存の UDP/SCTP テストが回帰しないことを確認。

- **ドキュメント整合（必要最小限）**
  - README は現状記述が意図として正しいため、主に「実装をREADMEに合わせる」。
  - 必要なら `stop()` が transport を閉じることを一文追記（利用者の期待値合わせ）。

---

## 3. 技術的な実装アプローチ（調査結果まとめ）

### 調査で確認した事実
- `createUdpTransport` 実体: `packages/sctp/src/transport.ts` に存在。
- 公開漏れ: `packages/sctp/src/index.ts` は `SCTP_STATE`, `WEBRTC_PPID`, `SCTP`, `type Transport` のみ export。
- `SCTP` は `public transport: Transport` を持ち、`client/server` は `Transport` 注入方式。
- `SCTP.stop()` は `abort` + state/timer cleanup のみで transport close なし。
- webrtc 側の `BridgeDtls` 実装は `Transport.close()` が no-op のため、`stop()` から close を呼んでも既存 webrtc 経路との衝突は小さい。

### 推奨実装方針
1. `index.ts` に `export { createUdpTransport } from "./transport";`（必要なら `UdpTransport` も）。
2. `SCTP.stop()` に transport close を追加し、**一度だけ close** するガードを導入。
3. ユニットテストで export と close 呼び出しを固定化。
4. 既存 `packages/sctp` テストを実行して後方互換を確認。

---

## 4. 考慮すべき制約や注意点

- **後方互換性**: 既存利用者が `../src/transport` から直接 import していても壊さない（追加 export は非破壊）。
- **stop の責務変更**: transport を共有する実装では「stopがcloseする」ことが影響になり得るため、仕様として明確化が必要。
- **多重呼び出し耐性**: `stop()` 再実行で `dgram.close()` 例外が出ないよう idempotent にする。
- **型契約維持**: `Transport` インターフェース（`send`, `close`, `onData`）前提は維持し、`any` 回避。
- **最小変更原則**: export追加と stop修正、関連テストに限定して差分を小さく保つ。

---

## 5. 完了条件

- [ ] `werift-sctp` のトップレベル import で `createUdpTransport` が利用可能。  
- [ ] README のサンプル import が実際に成立する。  
- [ ] `SCTP.stop()` で transport の `close()` が実行される。  
- [ ] `stop()` 多重呼び出しでも異常終了しない。  
- [ ] `packages/sctp` の既存テスト + 追加テストが成功し、回帰がない。