

## 1. タスクの目的と背景

`packages/sctp/README.md` の利用例は `createUdpTransport` を `werift-sctp` から直接 import する前提ですが、実際の公開API（`packages/sctp/src/index.ts`）では `Transport` 型しか export されておらず、READMEどおりに使えません。  
調査上、`createUdpTransport` 自体は `packages/sctp/src/transport.ts` に実装済みで、内部テスト/サンプルもそれを直接 `../src/transport` から import して利用しています。  
一方で `SCTP.stop()` の責務については再整理が必要です。RFC 8831 では **DataChannel の close は stream reset（§6.7）** で行い、association/transport teardown とは別概念です。さらに association を閉じると全 DataChannel が閉じる（§6.2）ため、`stop()` から常に `transport.close()` を呼ぶ設計は用途によっては過剰です。

---

## 2. 実装すべき具体的な機能や変更内容

- **公開API修正（必須）**
  - `packages/sctp/src/index.ts` から `createUdpTransport` を export する。
  - 必要に応じて `UdpTransport` も export（利用者が明示的にクラス利用したい場合の拡張性）。
  - 少なくとも README の import 文  
    `import { SCTP, WEBRTC_PPID, createUdpTransport } from "werift-sctp";`  
    がそのまま動く状態にする。

- **停止処理の責務整理（必須）**
  - `SCTP.stop()` は **association の停止に限定**し、`transport.close()` を無条件で呼ばない方針を基本とする。
  - 理由: RFC 8831 §6.7 では DataChannel close は stream reset、association/transport close はより広い停止操作（§6.2）であるため。
  - 必要なら「standalone UDP 利用時のみ transport も閉じる」ための明示API（例: `stop({ closeTransport: true })` など）を別途検討し、デフォルトは `false` にする。
  - 多重停止時の安全性（idempotent）は維持する。

- **テスト追加・更新（必須）**
  - `../src`（= index 経由）から `createUdpTransport` が import 可能であることを検証。
  - `SCTP.stop()` のデフォルト動作では transport `close` が呼ばれないことを検証（モック Transport で確認）。
  - もし `closeTransport` のような明示オプションを導入する場合は、そのときのみ `close` が呼ばれることを検証。
  - 既存の UDP/SCTP テストが回帰しないことを確認。

- **ドキュメント整合（必要最小限）**
  - README の import 例は維持し、公開APIをREADMEに合わせる。
  - `SCTP.stop()` の責務（association停止のみ）と、UDPソケットを閉じる責務（利用側または明示オプション）を明記する。

---

## 3. 技術的な実装アプローチ（調査結果まとめ）

### 調査で確認した事実
- `createUdpTransport` 実体: `packages/sctp/src/transport.ts` に存在。
- 公開漏れ: `packages/sctp/src/index.ts` は `SCTP_STATE`, `WEBRTC_PPID`, `SCTP`, `type Transport` のみ export。
- `SCTP` は `public transport: Transport` を持ち、`client/server` は `Transport` 注入方式。
- `SCTP.stop()` は `abort` + state/timer cleanup のみで transport close なし。
- RFC 8831 §6.7: DataChannel close は stream reset（RFC 6525）でシグナルするのが MUST。
- RFC 8831 §6.2: association を閉じると全 DataChannel が閉じる（graceful/non-graceful いずれでも）。
- RFC 8831 / RFC 8261 のスタックでは SCTP は DTLS/ICE 上で動作し、WebRTC全体では他トラフィックと下位トランスポート共有が起こり得るため、SCTP層からの無条件 transport close は慎重に扱うべき。

### 推奨実装方針
1. `index.ts` に `export { createUdpTransport } from "./transport";`（必要なら `UdpTransport` も）。
2. `SCTP.stop()` の責務は association 停止に維持し、transport close はデフォルトでは行わない。
3. standalone UDP の後始末を容易にする必要がある場合のみ、明示オプション/APIで transport close を提供する（暗黙 close はしない）。
4. ユニットテストで export と停止責務（default close しない / 明示時のみ close）を固定化。
5. 既存 `packages/sctp` テストを実行して後方互換を確認。

---

## 4. 考慮すべき制約や注意点

- **後方互換性**: 既存利用者が `../src/transport` から直接 import していても壊さない（追加 export は非破壊）。
- **DataChannel close と association close の分離**: RFC 8831 に従い、DataChannel close（stream reset）と association/transport teardown を混同しない。
- **stop の責務**: transport 共有実装で副作用を起こさないよう、`stop()` は安全側（非closeデフォルト）に寄せる。
- **多重呼び出し耐性**: `stop()` 再実行で異常終了しない idempotent 性を維持する。
- **型契約維持**: `Transport` インターフェース（`send`, `close`, `onData`）前提は維持し、`any` 回避。
- **最小変更原則**: export追加と stop修正、関連テストに限定して差分を小さく保つ。

---

## 5. 完了条件

- [ ] `werift-sctp` のトップレベル import で `createUdpTransport` が利用可能。  
- [ ] README のサンプル import が実際に成立する。  
- [ ] `SCTP.stop()` のデフォルト動作が association 停止に限定される（transportを暗黙closeしない）。  
- [ ] （明示オプション/APIを導入した場合）指定時のみ transport の `close()` が実行される。  
- [ ] `stop()` 多重呼び出しでも異常終了しない。  
- [ ] `packages/sctp` の既存テスト + 追加テストが成功し、回帰がない。
