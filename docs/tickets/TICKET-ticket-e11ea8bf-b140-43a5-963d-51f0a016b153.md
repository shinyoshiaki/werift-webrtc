## 元報告と判定
元Issue: #814（sidorares）、関連: #438、#748（明示的interface設定の別問題）。
**妥当（developのコード上で確認）**。マルチNICでのパケット観測とWPT失敗は元報告による。今回別途実機再現はしていない。

## 原因
- [ice.ts L1198–1245](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/ice/src/ice.ts#L1198-L1245) は列挙した各ローカルアドレスごとにUDP `StunProtocol`を用意し、列挙アドレスをhost candidateとして広告する。
- [transport.ts L107–165](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/common/src/transport.ts#L107-L165) は`interfaceAddresses`が未指定だと`interfaceAddress()`からワイルドカードアドレスを得てbindする。候補A用ソケットの送信元IPがルーティング上のアドレスBになり得る。
- advertised candidateと実際のsource tupleが食い違い、受信者が不要なpeer-reflexive candidateを学習し、選択ペア整合性・到達性が崩れる。
- #748では明示設定のbind/address不一致を扱ったが、**デフォルトのマルチNIC/wildcard bind**は別経路として残る。

## 修正方針
1. UDP host候補を各NICアドレスで生成する場合、候補専用ソケットも原則その**具体的なIPアドレスにbind**する。上位の`iceInterfaceAddresses`が明示されていれば既存の選択を優先する。
2. `StunProtocol.connectionMade()` / `UdpTransport.init()` に候補固有のbindアドレスを渡す設計とし、socket.address()で実際のbind先IP/portを検証してcandidateと一致させる。未割当IPv4/IPv6、リンクローカルIPv6のzone ID、VPNや仮想NICを考慮する。
3. NIC単位のbind失敗時には他NICの正常なcandidateを維持し、失敗したIPを誤って広告しない。wildcardソケットが必要なユースケースは明示設定と分離する。
4. 同じソケットのsrflx・relay生成、ICE restart時の再利用、TCP候補、portRangeと既存のバインド方法への影響を確認する。

## 回帰テスト
- [ ] 2つ以上のNIC/IP（ネットワークnamespaceやモックソケット）を用い、各candidateに対応するSTUN/ICE connectivity checkの送信元IP/portが広告と一致。
- [ ] peer-reflexive candidateが単なる送信元IP不一致によって発生しない。
- [ ] 片方のアドレスへのbind失敗、IPv4+IPv6、明示`iceInterfaceAddresses`、ICE restartで誤広告・ソケットリークなし。
- [ ] WPT `RTCIceTransport.html` のselected candidate pair対応関係を確認。

**完了条件:** 複数インターフェースでcandidateと実送信元が一致し、正常な候補ペアを確立できる。

---

# 詳細化（2026-11-11 / 調査リビジョン `48b188bef`）

## 1. 目的と背景

- **目的:** `interfaceAddresses`（webrtc では `iceInterfaceAddresses`）を指定しない**デフォルト設定**で、各 UDP host candidate の広告アドレス（IP/port）と、その candidate 用ソケットから実際に送信される STUN/ICE パケットの source tuple を一致させる。
- **背景:**
  - 現状では列挙した NIC アドレスごとに `StunProtocol` を作るが、ソケットは `0.0.0.0` / `::` に bind される（`interfaceAddress()` が `undefined` を返し、`socket.bind({ address: undefined })` になる）。
  - Linux の weak host model では、wildcard ソケットの送信元 IP は宛先へのルーティングで決まる。そのため「candidate A（eth1 のアドレス）用のソケット」から出るパケットの送信元が eth0 のアドレス B になり得る。
  - 受信側は未知の source として peer-reflexive candidate（`ice.ts` L2598 付近 `7.2.1.3 Learning Peer Reflexive Candidates`）を学習する。その結果、選択ペアの local/remote 対応が SDP の candidate と一致しなくなる（WPT `RTCIceTransport.html` の selected candidate pair 検証の失敗、#438 の到達性問題）。
  - #748 で明示指定時（`interfaceAddresses` あり）の bind アドレスと広告の不一致は修正済み（bind 後に `socket.address()` を広告）。**未指定時の wildcard 経路だけが残っている**。
  - TCP 候補は既に具体 IP を使っている（`TcpPassiveProtocol.connectionMade(localIp)` は `localIp` で listen し、`TcpActiveProtocol` は `localAddress: this.localIp` で connect する）。不一致があるのは **UDP host ソケットだけ**。

## 2. 実装すべき変更内容

### 2.1 `packages/common`（`src/transport.ts`, `src/network.ts`）

- `UdpTransport.init(type, options)` の options に **`bindAddress?: string`**（候補固有の bind アドレス）を追加する。
  - 優先順位: `bindAddress` → `interfaceAddress(type, interfaceAddresses)` → wildcard（`undefined`）。
  - `portRange` 指定時の `findPort()` も同じアドレスでポートを探す。今は `interfaceAddresses` を引数に取るので、解決済みのアドレスを受け取れるよう拡張する。`randomPort` / `randomPorts` の既存シグネチャは互換を維持する。
- bind 失敗（`EADDRNOTAVAIL` など）は今と同じく `init()` の reject にし、ソケットは `close()` する。既存の `UdpTransport.init` の try/catch で close される。

### 2.2 `packages/ice/src/stun/protocol.ts`

- `StunProtocol.connectionMade(useIpv4, portRange?, interfaceAddresses?)` は `getGlobalIp()`（`utils.ts` L20）と外部利用者があるため、**位置引数の互換を保つ**。そのうえで第4引数（例: `{ bindAddress?: string }`）を追加し、`UdpTransport.init` に渡す。

### 2.3 `packages/ice/src/utils.ts` / `src/internal/selectAddresses.ts` / `src/internal/resolveHostAddresses.ts`

- `selectAddressesFromInterfaces()` は今はアドレス文字列だけを返すため、IPv6 リンクローカル（`fe80::/10`、`useLinkLocalAddress: true` のとき）の bind に必要な **zone ID（NIC 名）** が失われる。
  - 内部用に `{ address, nic, scopeid }` を返す API（例: `selectHostInterfaces`）を追加する。bind 時は `fe80::x%<nic>` を使い、広告時は既存の `stripZoneId()`（`ice.ts` L2846）で zone を外す。
  - 公開 API `getHostAddresses()` / `nodeIpAddress()` の戻り値（`string[]`）は変えない。
- `resolveHostAddresses()` の戻り値を「アドレス + bind 方針」の構造体にする（例: `{ address, bind: "explicit" | "enumerated" | "wildcard" }`）。
  - `interfaceAddresses` が明示されたファミリー → `explicit`（既存ロジックを維持。`boundInterface` に bind し、`socket.address()` を広告する）。
  - 列挙されたアドレス → `enumerated`（**そのアドレスに bind** する）。
  - `additionalHostAddresses` で追加されたアドレス → `wildcard`（後述 4.1。1:1 NAT の公開 IP などローカルに割り当てられていない IP を広告する既存用途を壊さない）。列挙と重複するアドレスは `enumerated` を優先する。

### 2.4 `packages/ice/src/ice.ts` `getCandidatePromises()`（L1142〜）

- 上の bind 方針に従って `protocol.connectionMade(isIPv4, portRange, interfaceAddresses, { bindAddress })` を呼ぶ。
- bind 後に `protocol.getExtraInfo()`（`socket.address()`）を検証する。
  - `enumerated` / `explicit`: 広告 host は `stripZoneId(boundHost)`、port は `boundPort` にする（#748 と同じく「実際の bind 先を広告する」に統一）。IPv6 表記揺れ（省略形など）は bind 結果の表記を採用し、`localIp` も同じ値にする。ICE restart の重複排除（L1166〜1186）が bind 後の表記で働くように、比較は正規化した表記で行う。
  - `wildcard`: 今の挙動を維持する（`0.0.0.0` / `::` は広告しない）。
- bind 失敗時: その NIC の candidate だけを捨て（log を残す）、他の NIC の候補収集は続ける。今も `addresses.map` ごとに try/catch があるので並列性は保たれる。**失敗した IP を広告しない、wildcard にフォールバックしない**。`ensureProtocol()` 済みで `this.protocols` に入らない `StunProtocol` がリークしないことを確認する。
- srflx: `queryReflexive()` は host ソケットを再利用するので、各 NIC から出た mapping が得られるようになる（related address も実 bind 先と一致する）。コード変更は不要の見込み。
- TURN（`gatherRelayCandidate` → `createStunOverTurnClient`）は別ソケットで、host candidate の広告とは無関係なので**本チケットの対象外**。今の `interfaceAddresses` / wildcard の挙動を維持する。
- TCP 候補: すでに具体 IP で bind / connect しているので変更不要。リンクローカル IPv6 の zone ID だけは、UDP と同じ情報源を使うかを確認する。

### 2.5 ドキュメント・公開 API コメント

- `packages/ice/src/iceBase.ts` L385–400 の JSDoc にある「Without any family set, every enumerated address is gathered over wildcard sockets.」を新しい挙動（列挙アドレスごとに具体 IP へ bind、`additionalHostAddresses` は wildcard）に合わせて直す。
- `packages/webrtc/src/api/peerConfig.ts` L70–84（`iceInterfaceAddresses` / `iceAdditionalHostAddresses`）の説明も同様に更新する。
- `changelog.md` に挙動変更（#814）を記載し、`npm run doc` で生成ドキュメントを再生成する。

## 3. 技術的アプローチ（調査結果まとめ）

| 箇所 | 現状 | 変更 |
| --- | --- | --- |
| `common/src/transport.ts` `UdpTransport.init()` L118–165 | `interfaceAddress(type, interfaceAddresses)` だけで bind アドレスを決め、未指定なら wildcard | `bindAddress` を最優先にする |
| `common/src/network.ts` `findPort()` L45–82 | `interfaceAddresses` 基準で空きポートを探す | 解決済みの bind アドレスで探す（列挙 NIC ごとに portRange 内のポートを確保） |
| `ice/src/stun/protocol.ts` `connectionMade()` L35–58 | `useIpv4, portRange, interfaceAddresses` | 第4引数 `{ bindAddress }` を追加（後方互換） |
| `ice/src/internal/selectAddresses.ts` | NIC 名を捨ててアドレスだけ返す | NIC 名 / scopeid を保持する内部 API を追加 |
| `ice/src/internal/resolveHostAddresses.ts` | `string[]` を返す | bind 方針付きの構造体を返す（`explicit` / `enumerated` / `wildcard`） |
| `ice/src/ice.ts` `getCandidatePromises()` L1198–1260 | 明示指定時のみ bind 先を広告 | 列挙アドレスも具体 bind して bind 先を広告し、失敗時は不広告 |
| `ice/src/stun/tcpProtocol.ts` | 既に `localIp` で bind / connect | 変更なし（zone ID だけ確認） |

- 参考: libwebrtc も Network ごとに具体 IP へ bind した UDP ソケットを作る（`BasicPortAllocator` → `UDPPort` は `Network::GetBestIP()` に bind）。wildcard は `PORTALLOCATOR_ENABLE_ANY_ADDRESS_PORTS` のような特殊ケースに限られる。今回の方針はこれに合わせるもの。
- 送信経路: 具体 IP に bind しても、Linux はルーティングテーブルに従って出口 NIC を選ぶ。送信元が bind IP に固定されるので、advertised candidate と source tuple は一致する。経路的に届かない組み合わせは connectivity check が失敗するだけで、誤った prflx は生まれない（これが ICE の想定動作）。

## 4. 制約・注意点

### 4.1 互換性・設計判断

- **`additionalHostAddresses` は wildcard を維持する。** Docker やクラウドの 1:1 NAT 公開 IP など、ローカルに割り当てのない IP を広告する用途がある（`iceAdditionalHostAddresses` の README / JSDoc）。具体 bind にすると `EADDRNOTAVAIL` で候補が消え、回帰になる。ただしループバックや tun などローカルにあるアドレスを追加する用途もあるので、方針は「ローカル NIC 列挙に含まれていれば `enumerated` 扱い、含まれなければ wildcard」とする。
- **明示 `interfaceAddresses` が最優先。** 指定されたファミリーは今と同じく 1 ソケットだけ作り、列挙アドレスは使わない（`resolveHostAddresses` の既存仕様と `interface-addresses.test.ts` の既存テストを維持する）。
- **wildcard が必要なユースケース**（コンテナでアドレスが後から変わる、など）は、明示的に `interfaceAddresses: { udp4: "0.0.0.0" }` を指定してもらう形で分離する。この場合、`boundInterface` の分岐で `socket.address()` が `0.0.0.0` になって広告されてしまう問題がないかを確認し、必要ならガードを入れる（`0.0.0.0` / `::` は広告しない）。
- **すべての列挙 NIC で bind に失敗した場合**も wildcard にフォールバックしない（誤広告を避けることを優先する）。srflx / relay は TURN 経由で残る。リリースノートに明記する。
- **受信範囲の変化:** 具体 bind にすると、そのソケットは自分の IP 宛てのパケットしか受信しない。`udp6` を `::` に bind していたときに受けていた IPv4-mapped 宛てのパケットも受信しなくなる。各 candidate の宛先は自分の IP なので ICE 上の問題はないが、テストで確認する。

### 4.2 アドレス種別

- **リンクローカル IPv6:** zone ID なしで `fe80::` に bind すると `EINVAL` / `EADDRNOTAVAIL` になる。bind は `%nic` 付きで行い、candidate と `localIp` には zone なしの表記を使う。
- **IPv6 tentative / deprecated / temporary アドレス:** DAD 中の tentative アドレスは bind に失敗し得る。失敗は個別にスキップするだけで、他の候補には影響させない。
- **未割当 IPv4 / IPv6:** 列挙とソケット作成の間に NIC が消えたり（DHCP 更新、VPN 切断）すると bind 失敗になる。上と同じくスキップする。
- **VPN / 仮想 NIC:** `selectAddressesFromInterfaces` は `tun` / `utun` / `tap` / `ipsec` / `vmnet` / `veth` を除外する。その除外ルールは変えない。

### 4.3 ICE restart / ライフサイクル

- restart では既存の `StunProtocol` を再利用する（`localIp` 一致で重複排除。L1166〜）。`localIp` を bind 後の正規化表記に揃え、同じアドレスのソケットが二重に作られないようにする。
- restart 時点で NIC アドレスが消えていた場合、再利用ソケットの送信は `EADDRNOTAVAIL` になる。消えたアドレスのソケットを restart 時に破棄するかは**本チケットではスコープ外**とし、別 Issue として記録する。
- `close()` や gathering の stale 化（`stale()`）と bind 完了の競合は、既存のパターン（`if (stale()) { await protocol.close(); return; }`）を維持する。

### 4.4 プラットフォーム / テスト環境

- サポート対象は Linux / macOS。macOS では `127.0.0.2` などの追加ループバックは既定で bind できない。複数 IP のテストでは bind 可能かを確認し、できなければ skip する（`canBindIpv6Loopback()` と同様のヘルパーを `packages/ice/tests/utils.ts` に追加する）。
- CI でネットワーク namespace は使えない前提にする。`node:os` の `networkInterfaces` を `vi.mock` で差し替え、`127.0.0.1` / `127.0.0.2` を `internal: false` の別 NIC（例: `eth0` / `eth1`）として見せる方式を基本にする。
- テストは Arrange / Act / Assert で書き、Act / Assert のコメントは日本語にする。共通のセットアップは `packages/ice/tests/utils.ts` に置く（AGENTS.md の規約）。

## 5. 回帰テスト計画（具体化）

`packages/ice/tests/ice/interface-addresses.test.ts`（または新規 `multi-nic.test.ts`）に以下を追加する。

1. **各候補の bind 先が広告と一致する:** 既存テスト「without interfaceAddresses, every enumerated address gets a host candidate」の Assert を強化し、`host.bound[0] === host.candidate[0]` も検証する（今は port しか見ていない）。
2. **複数 NIC で送信元が一致する:** 疑似 NIC（`127.0.0.1` / `127.0.0.2`）を持つ agent A と、受信側 agent B（`127.0.0.1` に明示 bind）で接続する。
   - B が受信した Binding Request の source が、A の広告 candidate のいずれかと IP/port まで一致すること。
   - B の `remoteCandidates` に **`prflx` が生成されないこと**。
   - `nominated` ペアの local / remote が双方の広告 candidate と一致すること。
3. **片方の bind が失敗する:** 疑似 NIC に未割当 IP（例: `192.0.2.1`、TEST-NET-1）を混ぜる。その IP の candidate は広告されず、他の NIC の候補は残ること。開いたソケット数が広告数と一致すること（リークなし）。
4. **IPv4 + IPv6:** `::1` に bind できる環境で、IPv4 と IPv6 の両方の疑似 NIC について上と同じ一致を確認する。
5. **明示 `interfaceAddresses`:** 既存テスト群（udp4 / udp6 / portRange / restart / bind 失敗）が変更なしで通ること。
6. **ICE restart:** 複数 NIC で restart → 再収集したとき、ソケット数が変わらず、各 candidate が同じ bind 先で再広告されること。
7. **portRange:** 複数 NIC で `portRange` を指定したとき、各ソケットが範囲内のポートに具体 IP で bind されること。
8. **`additionalHostAddresses`:** ローカルにない IP（例: `203.0.113.10`）を追加したとき、wildcard ソケットで今まで通り広告されること（回帰防止）。
9. `packages/common/tests/transport.test.ts`: `UdpTransport.init(..., { bindAddress })` が指定 IP に bind されること、`bindAddress` が `interfaceAddresses` より優先されること、bind 失敗で reject + close されること。
10. **WPT:** `RTCIceTransport.html` は現時点で `packages/webrtc/wpt/allowlist.json` に入っていない。修正後に `npm run wpt` 相当の個別実行で selected candidate pair の対応関係を確認し、通るなら allowlist / baseline への追加を検討する（追加する場合は `npm run wpt:coverage` も実行する）。

## 6. 検証コマンド

- `cd packages/common && npm test`、`cd packages/ice && npm test`（まず対象テストファイルだけで実行）。
- パッケージをまたぐ変更なので `npm run type` と `npm run test:small` も実行する。
- webrtc の接続経路に影響するので `npm run e2e` を最終確認として実行する。
- 必要に応じて `npm run wpt`（`RTCIceTransport.html` の確認）を実行する。
- 最後に `npm run format` と `npm run doc` を実行する。

## 7. 完了条件

- [ ] `interfaceAddresses` 未指定時、列挙された各 NIC アドレスの UDP host ソケットがそのアドレス（IPv6 リンクローカルは zone 付き）に bind され、広告 candidate の IP/port が `socket.address()` と一致する。
- [ ] 複数 NIC（疑似 NIC を含む）環境で、connectivity check の送信元 tuple が広告 candidate と一致し、送信元不一致による `prflx` が生成されない。
- [ ] NIC 単位の bind 失敗は該当 candidate の不広告だけで済み、他 NIC の candidate とソケットは正常に残る（リークなし）。
- [ ] 明示 `interfaceAddresses`、`additionalHostAddresses`、`portRange`、ICE restart、TCP 候補、srflx / relay の既存挙動とテストが回帰しない。
- [ ] `iceBase.ts` / `peerConfig.ts` の JSDoc、`changelog.md`、生成ドキュメントが新しい挙動に更新されている。
- [ ] 上の検証コマンドがすべて成功する。
