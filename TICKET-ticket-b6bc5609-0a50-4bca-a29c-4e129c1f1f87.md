Read package.json

● Grep "crc32" in *.{ts,js,json,md}

● Read packages/sctp/src/chunk.ts lines 1-220

● Read packages/ice/src/stun/message.ts lines 1-260

● Read packages/sctp/src/chunk.ts lines 220-700

● Read packages/ice/package.json

● Read packages/sctp/package.json

● Read packages/webrtc/package.json

● Create session plan file
  $ cat <<'EOF' > /home/shin/.copilot/session-state/37b2ab77-40fb-4ce3-8a5f-be5220425fa6/plan.md
  # Plan
  - Investigate current crc32 dependencies and usage
  - Identify ESM-compatible replacement options and impacts
  - Define required code/package changes and acceptance criteria...

● Read node_modules/buffer-crc32/package.json

● Read node_modules/turbo-crc32/package.json

● Read node_modules/buffer-crc32/dist/index.mjs lines 1-200

● Read node_modules/buffer-crc32/dist/index.cjs lines 1-200

● Read node_modules/turbo-crc32/crc32c.js lines 1-200

● Read TICKET-ticket-7e99f301-ab64-4dfb-91ec-3d3059ec7715.md

● Read TICKET-ticket-d57c0b1a-bdea-41a4-8c0e-bc21983606bf.md

● Read node_modules/buffer-crc32/index.d.ts lines 1-200

● Read node_modules/turbo-crc32/crc32.js lines 1-120

# 1. タスクの目的と背景
- ESM ビルド（`packages/webrtc` の `compile:esm`）で CJS 依存の CRC32/CRC32C を避け、互換性と型安全性を改善  
- 現状: STUN FINGERPRINT は `packages/ice/src/stun/message.ts` で `buffer-crc32`、SCTP checksum は `packages/sctp/src/chunk.ts` で `turbo-crc32/crc32c.js` を使用  
- `buffer-crc32` は `@ts-ignore` が必要、`turbo-crc32` は ESM 非対応の CJS  

# 2. 実装すべき具体的な機能や変更内容
- ESM 対応の新しい CRC32/CRC32C ライブラリへ置換（1 パッケージで両対応 or 2 パッケージ構成）  
- 変更対象:  
  - `packages/ice/src/stun/message.ts` の CRC32 計算と XOR 処理  
  - `packages/sctp/src/chunk.ts` の CRC32C 計算と LE 書き込み  
- `packages/ice/package.json` / `packages/sctp/package.json` / `packages/webrtc/package.json` の依存更新、関連ロックファイル更新（root + 影響する workspace）  
- `@ts-ignore` 除去、型定義の整合（Buffer vs number）  

# 3. 技術的な実装アプローチ（調査結果まとめ）
- 調査事実:  
  - `buffer-crc32` は ESM export を持つが CJS 型定義 (`export =`) で default import 互換が弱い  
  - `turbo-crc32` は CJS のみ、`crc32c.js` も `module.exports`  
  - STUN は CRC32(IEEE)、SCTP は CRC32C(Castagnoli) でアルゴリズムが異なる  
- 方針:  
  - ESM/TS 型が整った CRC32/CRC32C ライブラリを選定（例: ESM 対応の CRC32 + CRC32C パッケージ、または 1 パッケージで両対応）  
  - CRC32 結果が number の場合は `Buffer` 化して XOR か、数値 XOR 後に `writeUInt32BE`  
  - CRC32C は `writeUInt32LE` を維持（SCTP 仕様）  

# 4. 考慮すべき制約や注意点
- CRC32 と CRC32C の混同禁止（STUN と SCTP で別アルゴリズム）  
- エンディアン: STUN は BE、SCTP は LE を維持  
- Node 要件（root >=18、packages/webrtc >=16）に適合するライブラリ選定  
- ESM 빌드で deep import 破壊や CJS interop 依存を避ける  

# 5. 完了条件
- `buffer-crc32` / `turbo-crc32` を置換し、ESM 対応 CRC32 依存に統一  
- `@ts-ignore` が不要になり、型/ビルドが通る  
- STUN FINGERPRINT と SCTP checksum の計算結果が既存と一致（テスト通過）  
- `npm run build` / `npm run test:small` / `packages/webrtc` の ESM ビルドが成功