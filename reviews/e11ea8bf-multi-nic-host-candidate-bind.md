---
ide:
  viewer: review-document
  version: 1
  title: "#814 複数NICでhost candidateと送信元IPを一致させる"
  dock: right
  baseCommit: d6262ff3a787821659dcfcc9a63f2550ad3931a6
---
# #814 複数 NIC で host candidate と送信元 IP を一致させる

## 1. 概要

`iceInterfaceAddresses` を指定しないデフォルト設定で、列挙した NIC アドレスごとの UDP host ソケットを、そのアドレスへ bind するようにしました。これまでは wildcard (`0.0.0.0` / `::`) に bind しており、送信元 IP がルーティングで決まるため、広告した candidate とは別のアドレスからパケットが出ることがありました。受信側は不要な peer-reflexive candidate を学習し、選択ペアが SDP と食い違っていました。

bind 後は実際の bind 先 (IP と port) を広告します。bind に失敗したアドレスだけを捨て、wildcard へはフォールバックしません。`additionalHostAddresses` のうちローカルに割り当てられていないもの (1:1 NAT の公開 IP など) は、従来どおり wildcard ソケットで広告します。

<div style="display:flex;gap:12px;flex-wrap:wrap">
<div style="flex:1;min-width:280px;border:1px solid #c66;border-radius:8px;padding:10px">
<b>変更前</b><br>candidate A (eth1) 用ソケット = wildcard bind<br>→ 送信元がルーティングで eth0 の B になり得る<br>→ 相手が prflx を学習し、選択ペアが不一致
</div>
<div style="flex:1;min-width:280px;border:1px solid #6a6;border-radius:8px;padding:10px">
<b>変更後</b><br>candidate A 用ソケット = A に bind<br>→ 送信元は常に A<br>→ prflx は発生せず、広告と実際の source tuple が一致
</div>
</div>

## 2. 主要変更

### common

- [packages/common/src/transport.ts:39](review-diff:packages/common/src/transport.ts:39) で `UdpTransportOptions` を導入し、`bindAddress` を追加しました。優先順位は `bindAddress`、`interfaceAddresses`、wildcard の順です。
- [packages/common/src/network.ts](review-diff:packages/common/src/network.ts) の `findPort` は、`portRange` 指定時に解決済みの bind アドレスでポートを探します。既存シグネチャは互換を保っています。

### ice

- [packages/ice/src/stun/protocol.ts](review-diff:packages/ice/src/stun/protocol.ts) の `StunProtocol.connectionMade` に第 4 引数 `{ bindAddress }` を追加しました。既存の位置引数は変えていません。
- [packages/ice/src/internal/selectAddresses.ts](review-diff:packages/ice/src/internal/selectAddresses.ts) に `selectHostInterfaces` を追加し、NIC 名 (zone) 付きで返すようにしました。IPv6 link-local は `fe80::x%nic` で bind します。公開 API の `getHostAddresses()` / `nodeIpAddress()` の戻り値は変えていません。
- [packages/ice/src/internal/hostInterfaces.ts](review-file:packages/ice/src/internal/hostInterfaces.ts:1) は新規ファイルです。列挙結果 (bind 用アドレス付き) と、除外 NIC (loopback や tun など) を含む割り当て済み全アドレスを返します。
- [packages/ice/src/internal/resolveHostAddresses.ts:6](review-diff:packages/ice/src/internal/resolveHostAddresses.ts:6) は、戻り値を `{ address, bind, bindAddress }` に変えました。`bind` は `explicit` / `enumerated` / `wildcard` のいずれかです。
  - `explicit`: `interfaceAddresses` で指定されたアドレス。既存挙動を維持します。
  - `enumerated`: 列挙した NIC アドレス。そのアドレスに bind します。
  - `wildcard`: ローカルに割り当てられていない `additionalHostAddresses`、または `0.0.0.0` / `::` を明示したファミリー。
  - 重複判定は IPv6 の正規化表記 (`normalizeIp`) で行います。
- [packages/ice/src/ice.ts:1175](review-diff:packages/ice/src/ice.ts:1175) の `getCandidatePromises` は、`bind` に応じて `bindAddress` を渡します。bind 後の `socket.address()` から、広告する host (zone を除去) と port を決めます。bind に失敗すると、そのアドレスだけを捨てます。ICE restart の重複排除は、bind 後の表記を正規化して比較します。

### docs

- [packages/ice/src/iceBase.ts](review-diff:packages/ice/src/iceBase.ts) と [packages/webrtc/src/api/peerConfig.ts](review-diff:packages/webrtc/src/api/peerConfig.ts) の JSDoc を新挙動に合わせました。
- `changelog.md` に #814 の記載を追加しました。`doc/` と `packages/*/doc` は `npm run doc` で再生成されています。

## 3. 判断理由

- **candidate 側を bind 先に合わせる案は採りませんでした。** 問題は「広告アドレスと送信元の不一致」です。ソケットを具体 IP に bind すれば、広告とのずれを根本から防げます。
- **bind 失敗時に wildcard へ戻す案も採りませんでした。** 広告したアドレスと送信元が再び食い違うためです。失敗した IP は広告せず、他 NIC の収集は続けます。
- **`additionalHostAddresses` は wildcard を維持しました。** 公開 IP はローカルに割り当てられておらず、bind できないためです。ローカルに割り当て済みなら (除外 NIC のものも) そのアドレスへ bind します。
- TURN と TCP は対象外です。TCP はもともと具体 IP を使っています。TURN は host candidate の広告と無関係の別ソケットです。

## 4. レビュアーが確認すべき点・リスク

- **挙動変更:** デフォルト設定で UDP host ソケットが wildcard から具体 IP に変わります。外部から見えるポートは同じですが、`socket.address()` が wildcard でなくなります。
- **bind 失敗の扱い:** 収集中に消えた IP や IPv6 tentative のアドレスは、候補から落ちます。他 NIC の候補は維持されます。
- **IPv6 link-local:** bind 時は zone 付きで、広告時は zone なしです。zone の除去箇所は [packages/ice/src/ice.ts:1269](review-file:packages/ice/src/ice.ts:1269) 付近です。
- **公開 API:** 互換性を保っています。`StunProtocol.connectionMade` は引数を追加しただけです。`resolveHostAddresses` / `hostInterfaces` は package-private です。
- **未実施の検証:** 実機の複数 NIC や network namespace での確認と、WPT `RTCIceTransport.html` の再確認は、私の手元では行っていません。

## 5. 検証結果

私がこのドキュメント作成時に実行したものです。

| コマンド | 結果 |
| --- | --- |
| `packages/ice`: `vitest run tests/ice/multi-nic.test.ts tests/ice/interface-addresses.test.ts tests/utils.test.ts` | 3 ファイル 35 テスト成功 |
| `packages/common`: `vitest run tests/transport.test.ts` | 1 ファイル 14 テスト成功 |

追加テストは次のとおりです。

- [packages/ice/tests/ice/multi-nic.test.ts:58](review-file:packages/ice/tests/ice/multi-nic.test.ts:58): 各ソケットが広告アドレスへ bind されていること、prflx が学習されないこと、bind 失敗時にそのアドレスだけが落ちること。
- 同じ [packages/ice/tests/ice/multi-nic.test.ts:141](review-file:packages/ice/tests/ice/multi-nic.test.ts:141) 以降: IPv4 と IPv6 の併用、ICE restart でのソケット再利用、`portRange`、`additionalHostAddresses` の扱い、明示 wildcard。
- [packages/common/tests/transport.test.ts](review-diff:packages/common/tests/transport.test.ts) と [packages/ice/tests/ice/interface-addresses.test.ts](review-diff:packages/ice/tests/ice/interface-addresses.test.ts): 優先順位の変更に対応するテスト。

`npm run type` / `npm run test:small` / `npm run wpt` は、今回は実行していません。
