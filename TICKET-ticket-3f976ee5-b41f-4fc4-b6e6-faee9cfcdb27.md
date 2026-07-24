# 依存ライブラリから標準ライブラリや独自実装に低コストで移行できるものは移行して依存数を減らす

## 1. 目的と背景

`common`、`ice`、`ice-server`、`dtls`、`rtp`、`sctp`、`webrtc` の各パッケージでは、利用箇所が限定的で、Node.js の標準 API または小規模なプロトコル固有処理で代替できる外部ライブラリもランタイム依存として配布されている。依存追加は、インストールサイズ、脆弱性・ライセンス確認、更新追従、サプライチェーンリスクを増やすため、公開 API や通信互換性を変えずに置換できるものを削減する。

調査時点では、上記 7 パッケージの `package.json` に 15 種類の外部ランタイム依存があり、このうち次の 6 種類は利用範囲が狭く低コストで置換可能である。

- `@shinyoshiaki/jspack`
- `fast-deep-equal`
- `int64-buffer`
- `ip`
- `@minhducsun2002/leb128`
- `aes-js`

これらは `packages/webrtc/package.json` の再掲分も含めて合計 18 箇所の dependency 宣言がある。対象をすべて除去すると、対象パッケージ群の外部ランタイム依存は 15 種類から 9 種類へ減る。

本タスクにおける「低コスト」は、利用箇所と必要な機能が限定され、標準 API または十分にレビュー可能な短い実装へ置換でき、既存のテストベクタで通信バイト列の互換性を確認できることとする。

## 2. 実装すべき変更内容

### 2.1 対象依存と置換内容

| 削除する依存 | 現在の主な利用箇所 | 置換内容 |
| --- | --- | --- |
| `@shinyoshiaki/jspack` | `packages/common/src/binary.ts` の乱数、`packages/rtp/src/rtp/rtx.ts` の RTX sequence number、`packages/sctp/src/param.ts` と `sctp.ts` の SCTP field、`packages/webrtc/src/transport/sctp.ts` の DCEP、`packages/webrtc/src/media/rtpSender.ts` の SSRC | `Buffer.readUInt8/readUInt16BE/readUInt32BE` と `Buffer.writeUInt8/writeUInt16BE/writeUInt32BE` に置換する。`!BBHLHH` は 12 byte の明示的な read/write にし、field 幅・offset・network byte order をコード上で確認できる形にする。 |
| `fast-deep-equal` | `packages/ice/src/ice.ts` の candidate pair 検索と STUN 応答元 address 比較 | Protocol/Candidate は既存フローで同一 instance を受け渡しているため参照同一性で比較し、`Address` は host と port を明示比較する。汎用 deep equality を持ち込まない。 |
| `int64-buffer` | ICE tie-breaker、SDP session ID、`packages/ice-server/src/stun/attributes.ts` の 64 bit STUN attribute | 8 byte の `Buffer` と `readBigUInt64BE` / `writeBigUInt64BE` を使用する。乱数生成も `randomBytes(8)` から unsigned 64 bit 値を読む。STUN の unsigned 64 bit 全域を扱えるようにする。 |
| `ip` | `packages/ice/src/utils.ts` の loopback 除外、`packages/ice-server/src/stun/attributes.ts` の IPv4/IPv6 判定・byte 列変換 | network interface の除外には `os.networkInterfaces()` が返す `internal` を使う。STUN address では `node:net` の `isIPv4` / `isIPv6` で判定し、IPv4 4 byte・IPv6 16 byte の text/binary 変換だけを package-local helper として実装する。 |
| `@minhducsun2002/leb128` | `packages/rtp/src/codec/av1.ts` の AV1 OBU size encode 1 箇所 | 同ファイルまたは codec 用 utility に unsigned LEB128 encoder を実装し、既存 decoder と対になる形にする。0 以上の safe integer のみを受け付ける。 |
| `aes-js` | `packages/rtp/src/srtp/context/context.ts` の SRTP session key/salt/auth key 導出 | `node:crypto.createCipheriv("aes-128-ecb", key, null)` と `setAutoPadding(false)` を使う小さな AES block encrypt helper に置換する。SRTP KDF の入力 block と出力 byte 列は変更しない。 |

### 2.2 dependency metadata の更新

以下を更新する。

- `packages/common/package.json`
- `packages/ice/package.json`
- `packages/ice-server/package.json`
- `packages/rtp/package.json`
- `packages/sctp/package.json`
- `packages/webrtc/package.json`
- ルート `package-lock.json`

上記 6 種類の runtime dependency を、宣言しているすべての workspace package から削除する。併せて不要になる `@types/ip` と `@types/aes-js` も削除し、ルートで `npm install` を実行して lockfile の workspace snapshot を同期する。

`import-test` は既存リリース版 `werift@0.22.7` も検証しているため、lockfile 内には旧版 `werift` が要求する同名依存が残る可能性がある。旧版に必要な entry を手作業で消さず、今回の workspace package の dependency 宣言から除去されていることを判定基準とする。

### 2.3 テストの追加・更新

既存テストベクタを維持し、少なくとも次を確認する。

- Buffer 置換
  - 16/32 bit の最大値を含む big-endian read/write。
  - RTX sequence number の wrap 境界。
  - SCTP reconfiguration parameter と cookie timestamp の既存 fixture round-trip。
  - DCEP OPEN/ACK の field、label、protocol が既存 data channel test と同じ結果になること。
- ICE/STUN
  - 同じ Protocol/Candidate instance から重複 candidate pair を作らないこと。
  - STUN 応答元の host または port が異なる場合は一致と判定しないこと。
  - unsigned 64 bit の `0n`、通常値、`2n ** 64n - 1n` の encode/decode。
  - IPv4、圧縮 IPv6、`::1`、IPv4-mapped IPv6 の binary round-trip。
  - STUN address の protocol、address length、XOR address の既存エラー条件と既存 test vector。
  - `NetworkInterfaceInfo.internal` および link-local option による interface 選別。
- AV1
  - unsigned LEB128 の `0`、`127`、`128`、複数 byte 値の encode/decode。
  - 負数、非整数、safe integer 外、終端のない入力を拒否すること。
  - AV1 OBU の serialize/deSerialize および packetize/depacketize の既存結果が変わらないこと。
- SRTP
  - RFC 由来の既存 session key、session salt、session auth tag の test vector が完全一致すること。
  - AES block helper が padding byte を追加せず、16 byte block を同じ 16 byte の暗号文へ変換すること。

新規・変更テストは Arrange / Act / Assert の三相を明確にし、Act / Assert の操作と検証意図には既存ルールに従って適切な粒度の日本語コメントを付ける。複数テストで共通する Arrange setup は package 内の単一 utility にまとめる。

## 3. 技術的な実装アプローチ

1. まずバイナリ read/write、IP codec、AES block、LEB128 の package-local helper と単体テストを用意する。
2. 各 call site を helper または Node.js 標準 API へ置換し、旧ライブラリの import が残っていないことを検索で確認する。
3. 既存 fixture とプロトコルテストで、RTP/RTX、SCTP/DCEP、ICE/STUN、SRTP の wire bytes が変更されていないことを確認する。
4. 各 `package.json` から不要依存と型依存を削除し、`npm install` で `package-lock.json` を再生成する。
5. package 単位の type/test を先に実行し、その後 workspace 全体へ検証を広げる。

実装は汎用バイナリ packing library や汎用 IP library を新たに内製するのではなく、現在利用している field と形式だけに限定する。これにより独自実装の保守範囲を小さく保つ。

## 4. 制約・注意点

- 公開 export、class、method signature、イベント通知方式は変更しない。
- RTP/RTCP、SCTP/DCEP、STUN/TURN、ICE、SRTP の network byte order と wire bytes を変更しない。`jspack` の `!` は big-endian であり、各 offset を明示する。
- SCTP cookie timestamp は従来どおり秒単位の整数として encode し、置換時に小数を混入させない。
- ICE tie-breaker と STUN ICE-CONTROLLING / ICE-CONTROLLED は unsigned 64 bit として扱い、符号付き変換を挟まない。
- IPv6 codec は `::` 圧縮、先頭・末尾の圧縮、IPv4-mapped 表現を考慮する。文字列表現が異なっても同一 address を表す場合は binary round-trip で互換性を判断する。
- AES-ECB は汎用データ暗号化の選択ではなく、既存 SRTP KDF が要求する 1 block 演算の置換としてのみ使用する。auto padding は必ず無効化する。
- ルートのサポート対象である Node.js 18 以上および Unix-like 環境を前提とし、native Windows 対応は追加しない。
- `buffer` は `werift-rtp` の browser 利用手順と関係するため今回の対象外とする。
- `debug` は `DEBUG` namespace の互換実装が必要、`multicast-dns` は mDNS protocol/transport を担う、`mediabunny` は media container 処理を担うため対象外とする。
- `@fidm/x509`、`@peculiar/x509`、`@noble/curves`、`tweetnacl`、`@shinyoshiaki/binary-data` は証明書・暗号・DTLS binary schema の正確性と安全性に関わり、低コスト置換ではないため対象外とする。
- dependency 削減に伴って package の公開 API、script、stable entrypoint、validation command は変えないため、README や `AGENTS.md` の機能説明更新は不要とする。

## 5. 完了条件

- [ ] 対象 6 種類の import/require が workspace の実装コードからなくなっている。
- [ ] 対象 6 種類が `common`、`ice`、`ice-server`、`rtp`、`sctp`、`webrtc` の dependency から削除され、外部ランタイム依存の種類数が 15 から 9 になっている。
- [ ] `@types/ip` と `@types/aes-js` が不要になり、該当 package の devDependency から削除されている。
- [ ] `package-lock.json` の workspace package snapshot が各 `package.json` と一致している。旧版 `werift@0.22.7` が必要とする lockfile entry は保持されている。
- [ ] Buffer、uint64、IPv4/IPv6、LEB128、AES の境界値と既存 protocol fixture/test vector を対象とするテストが追加または更新され、既存 wire bytes と公開動作が維持されている。
- [ ] `cd packages/common && npm run type` と、ルートからの `npx vitest run packages/common/tests/binary.test.ts` が成功する。
- [ ] `cd packages/ice && npm run type && npm test` が成功する。
- [ ] `cd packages/ice-server && npm run type && npm test` が成功する。
- [ ] `cd packages/rtp && npm run type && npm test` が成功する。
- [ ] `cd packages/sctp && npm run type && npm test` が成功する。
- [ ] `cd packages/webrtc && npm run type && npm test` が成功する。
- [ ] ルートで `npm run type`、`npm run test:small`、`npm run build` が成功する。
- [ ] WPT submodule と必要な E2E dependency を利用できる CI 環境で `npm run ci` が成功する。
