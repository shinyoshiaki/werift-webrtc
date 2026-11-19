## 背景
下流の react-x11-components PR #1399 では werift の SCTP 内部キュー構造変更に追従する必要がありました。内部配列への直接依存を避け、送信待ち量やドレイン状態を公開 API から扱える設計を検討します。

参考: https://github.com/sidorares/react-x11-components/pull/1399
関連する既存Issue（内部キュー性能）: https://github.com/shinyoshiaki/werift-webrtc/issues/730

## 提案
- RTCSctpTransport / RTCDataChannel に既にある bufferedAmount、bufferedAmountLowThreshold、bufferedamountlow 相当の API と意味論を棚卸しする。
- 不足する場合のみ、送信待ちバイト数、閾値通知、送信完了/close 時の扱いを標準 WebRTC API との整合性を保って追加する。
- 内部キューの Array/FifoQueue 等の実装差異を公開契約から隠蔽する。
- 送信中 close、再送、部分信頼性設定、閾値跨ぎの回帰テストを用意する。

## 完了条件
- 下流が非公開キューへアクセスせずにフロー制御できる。
- 既存公開 API が十分なら利用方法を文書化して終了する。
- #730 の性能問題とは責任範囲を分離する。

※ API 改善提案であり、現行版に API が存在しないと断定するものではありません。