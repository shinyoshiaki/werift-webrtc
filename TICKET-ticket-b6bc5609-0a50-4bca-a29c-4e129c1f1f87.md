
# 1. タスクの目的と背景
- ESM ビルド（`packages/webrtc` の `compile:esm`）で CJS 依存の CRC32/CRC32C を避け、互換性と型安全性を改善  
- 現状: STUN FINGERPRINT は `packages/ice/src/stun/message.ts` で `buffer-crc32`、SCTP checksum は `packages/sctp/src/chunk.ts` で `turbo-crc32/crc32c.js` を使用  
- `buffer-crc32` は `@ts-ignore` が必要、`turbo-crc32` は ESM 非対応の CJS  
- 目標: ESM + TS 型が整ったライブラリへ統一し、CRC32/CRC32C を同一パッケージで扱う  

# 2. 実装すべき具体的な機能や変更内容
- `@se-oss/crc32` へ置換（1 パッケージで CRC32/CRC32C 両対応、ESM/TS 対応）  
- 変更対象:  
  - `packages/ice/src/stun/message.ts` の CRC32 計算と XOR 処理  
  - `packages/sctp/src/chunk.ts` の CRC32C 計算と LE 書き込み  
- 依存更新: `buffer-crc32`/`turbo-crc32` を削除し、`packages/ice` と `packages/sctp` に `@se-oss/crc32` を追加（必要に応じて root lockfile 更新）  
- `@ts-ignore` 除去、型定義の整合（CRC32 結果は number として扱い `writeUInt32*` へ）  

# 3. 技術的な実装アプローチ（調査結果まとめ）
- 調査事実:  
  - `buffer-crc32` は ESM export を持つが CJS 型定義 (`export =`) で default import 互換が弱い  
  - `turbo-crc32` は CJS のみ、`crc32c.js` も `module.exports`  
  - STUN は CRC32(IEEE)、SCTP は CRC32C(Castagnoli) でアルゴリズムが異なる  
  - 候補比較:  
    - `@se-oss/crc32`: `type: module` + `exports` を持つ ESM/TS 対応。`crc32`/`crc32c` を同一 API で提供し Buffer/Uint8Array 入力に対応  
    - `@node-rs/crc32`: 高速だが N-API 依存 + CJS ベース。ESM ビルドと移植性の観点で不利  
    - `crc-32`: 純 JS だが CJS かつ古めで、ESM 互換性が弱い  
- 方針:  
  - 第一候補は `@se-oss/crc32` に統一（ESM/TS 対応・CRC32/CRC32C 両対応・依存最小）  
  - 代替案: もし依存追加が不可なら、`packages/common` に CRC32/CRC32C の純 TS 実装を追加し内部利用  
  - CRC32 結果は number として XOR/書き込み処理へ (`writeUInt32BE`)、CRC32C は `writeUInt32LE` を維持  

# 4. 考慮すべき制約や注意点
- CRC32 と CRC32C の混同禁止（STUN と SCTP で別アルゴリズム）  
- エンディアン: STUN は BE、SCTP は LE を維持  
- Node 要件（root >=18、packages/webrtc >=16）に適合するライブラリ選定  
- ESM 빌드で deep import 破壊や CJS interop 依存を避ける  
- `@se-oss/crc32` は optional で `sse4_crc32` を利用可能だが、追加導入は必須ではない（通常は純 TS 実装を使用）  

# 5. 完了条件
- `buffer-crc32` / `turbo-crc32` を `@se-oss/crc32` へ置換  
- `@ts-ignore` が不要になり、型/ビルドが通る  
- STUN FINGERPRINT と SCTP checksum の計算結果が既存と一致（テスト通過）  
- `npm run build` / `npm run test:small` / `packages/webrtc` の ESM ビルドが成功

# 6. レビュー反映メモ
- `package-lock.json` に残る `buffer-crc32` / `turbo-crc32` は `import-test/node_modules/werift@0.22.7` 由来の記録であり、今回の変更対象ワークスペース（`packages/ice` / `packages/sctp` / `packages/webrtc`）の実装経路には未使用。  
- 依存の完全整理を厳密に行う場合は、`import-test` 側の参照バージョン更新を別チケットで実施する。  
- 追跡性のため、今回の checksum/fingerprint 影響確認テストは以下を記録する。  
  - STUN: `packages/ice/tests/stun/stun.test.ts`  
    - `test_binding_request_ice_controlled`（FINGERPRINT 値検証）  
    - `test_binding_request_ice_controlled_bad_fingerprint`（不正 fingerprint 検知）  
  - SCTP: `packages/sctp/tests/packet.test.ts`  
    - `test_parse_init`（roundtrip で checksum 整合）  
    - `test_parse_init_invalid_checksum`（不正 checksum 検知）
