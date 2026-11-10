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