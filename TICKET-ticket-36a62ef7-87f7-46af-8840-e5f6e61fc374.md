コードベースと仕様の両方を調べて、`getStats` 実装タスクの詳細化に必要な材料を先に集めます。

  │ "**/AGENTS.md"

  │ "class RTCPeerConnection|interface RTCPeerConnection|function
  │ RTCPeerConnection|new RTCPeerConnection" in **/*.{ts,tsx} (packages/webrtc)

  │ "getStats|RTCStats|stats" in **/*.{ts,tsx,js} (packages)


  │ packages/webrtc/src/media/stats.ts

  │ packages/webrtc/src/peerConnection.ts

  │ packages/webrtc/src/secureTransportManager.ts

  │ packages/webrtc/tests/integrate/getStats.test.ts

  │ packages/webrtc/tests/integrate/getStats.test.ts

  │ "async getStats\(|getStats\(" in **/*.ts (packages/webrtc/src)

  │ "RTCStatsReport|generateStatsId\(|media-source|outbound-rtp|candidate-pair|c
  │ ertificate" in **/*.ts (packages/webrtc/src)

  │ packages/webrtc/src/transceiverManager.ts

  │ packages/webrtc/src/peerConnection.ts

  │ packages/webrtc/src/media/rtpSender.ts

  │ packages/webrtc/src/media/rtpReceiver.ts

  │ packages/webrtc/src/sctpManager.ts

  │ packages/webrtc/src/transport/dtls.ts

  │ packages/webrtc/src/media/rtpTransceiver.ts

  │ packages/webrtc/src/transport/ice.ts

仕様側の要件と、既存実装がどこまで揃っているかを対応づけて確認します。

  │ "getStats\(|RTCStatsReport|RTCRtpSender|getStats\s*\?:" in **/*.ts
  │ (packages/webrtc/src)

  │ "packetCount|octetCount|rtt|jitter|packets_lost|packets_received|messagesSen
  │ t|bytesSent|messagesReceived|bytesReceived|framesDecoded|framesEncoded|nackC
  │ ount|pliCount|firCount" in **/*.ts (packages)

● Fetching web content https://www.w3.org/TR/webrtc-stats/ · url: "https://www.w3.org/TR/webrtc-sta…

● Fetching web content https://www.w3.org/TR/webrtc/ · url: "https://www.w3.org/TR/webrtc/", max_le…

  │ "getStats|stats selection|RTCStatsReport" in **/*.{ts,js}
  │ (packages/webrtc/tests)

  │ "RTCDataChannelStats|RTCPeerConnectionStats|RTCTransportStats|RTCIceCandidat
  │ ePairStats|RTCRemoteInboundRtpStreamStats|RTCRemoteOutboundRtpStreamStats"
  │ in **/*.ts (packages/webrtc/src)

● Fetching web content https://www.w3.org/TR/webrtc-stats/ · url: "https://www.w3.org/TR/webrtc-sta…

● Fetching web content https://www.w3.org/TR/webrtc/ · url: "https://www.w3.org/TR/webrtc/", start_…

  │ "remoteId|localId|bytesReceived|totalRoundTripTime|availableOutgoingBitrate|
  │ availableIncomingBitrate|iceRole|dtlsCipher|tlsVersion|selectedCandidatePair
  │ Changes|iceRestarts" in **/*.ts (packages/webrtc/src)

● Fetching web content https://www.w3.org/TR/webrtc-stats/ · url: "https://www.w3.org/TR/webrtc-sta…

● Fetching web content https://www.w3.org/TR/webrtc/ · url: "https://www.w3.org/TR/webrtc/", start_…

W3C 側の必須要件を取りこぼさないよう、`getStats` の選択アルゴリズムと最低実装要件を追加で確認します。

  │ "onReceivingRtcp|ReceiverReport|SenderReport|nack|pli|fir|rtx|retransmit|hea
  │ derBytes|bytesReceived|packetsDiscarded" in **/*.ts
  │ (packages/webrtc/src/media)

  │ "candidatePairs|totalRoundTripTime|requestsSent|responsesSent|retransmission
  │ sSent|consent|iceRole|usernameFragment|selectedCandidatePairChanges|iceResta
  │ rts" in **/*.ts (packages/ice/src, packages/webrtc/src/transport)

● Web Search (MCP: github-mcp-server) · W3C WebRTC getStats selection algorithm and mandatory to im…

  │ "dataChannelsOpened|dataChannelsClosed" in **/*.ts (packages/webrtc/src)

  │ packages/webrtc/src/media/rtpSender.ts

  │ packages/webrtc/src/media/rtpReceiver.ts

  │ "class RTCDataChannel|readyState|messagesSent|bytesSent|close\(|state =" in
  │ **/*.ts (packages/webrtc/src/dataChannel.ts,
  │ packages/webrtc/src/transport/sctp.ts)

  │ packages/webrtc/src/index.ts

  │ "class CandidatePair|foundation\s*=|get foundation|candidate pair" in
  │ **/*.ts (packages/ice/src)

  │ "bytesReceived|headerBytesReceived|retransmittedPacketsSent|retransmittedByt
  │ esSent|nackCount|firCount|pliCount|framesDecoded|framesEncoded|packetsDiscar
  │ ded" in **/*.ts (packages/webrtc/src/media)

  │ "performance\.now\(|timeOrigin|Date\.now\(|getStatsTimestamp" in **/*.ts
  │ (packages/webrtc/src)

  │ packages/ice/src/iceBase.ts

  │ "getStats\(\): Promise<RTCStats\[]>" in **/*.ts (packages/webrtc/src)

  │ "selectedCandidatePairId|generateStatsId\("candidate-pair"" in **/*.ts
  │ (packages/webrtc/src/transport)

  │ "remoteId\s*:" in **/*.ts (packages/webrtc/src)

  │ "localId\s*:" in **/*.ts (packages/webrtc/src)

  │ "roundTripTimeMeasurements|totalRoundTripTime" in **/*.ts
  │ (packages/webrtc/src, packages/ice/src)

  │ packages/webrtc/src/media/rtpReceiver.ts

  │ packages/webrtc/src/media/rtpSender.ts

  │ packages/ice/src/ice.ts

  │ packages/webrtc/src/sctpManager.ts

  │ "getStats\(" in **/*.ts (packages/webrtc/tests)

  │ "sender\.getStats|receiver\.getStats|pc\.getStats\(.*track|transportId|selec
  │ tedCandidatePairId" in **/*.ts (packages/webrtc/tests)

  │ "getStats" in **/*.{md,ts} (README.md, docs, doc, packages/webrtc)

  │ doc/classes/RTCRtpSender.md

  │ doc/classes/RTCPeerConnection.md


  │ doc/classes/RTCRtpReceiver.md

  │ "consent|requestsSent|responsesReceived|responsesSent|retransmissionsSent|re
  │ transmissionsReceived|packetsDiscardedOnSend|availableOutgoingBitrate|availa
  │ bleIncomingBitrate" in **/*.ts (packages/ice/src, packages/webrtc/src)

  │ "bytesReceived\s*=|packetsReceived\s*=|packetsSent\s*=|transportSequenceNumb
  │ er" in **/*.ts (packages/webrtc/src/transport/dtls.ts,
  │ packages/webrtc/src/transport/ice.ts)

  │ "framesEncoded|framesDecoded|frameWidth|frameHeight|decoder|encoder|audioLev
  │ el|totalAudioEnergy|samples|qpSum|framesSent|framesReceived" in **/*.ts
  │ (packages/webrtc/src, packages/rtp/src)

  │ packages/webrtc/src/transport/ice.ts

  │ packages/webrtc/src/transport/dtls.ts

  │ packages/ice/src/ice.ts

  │ "handleRtcpPacket|onPictureLossIndication|onGenericNack|RtcpPayloadSpecificF
  │ eedback|GenericNack|PictureLossIndication" in **/*.ts
  │ (packages/webrtc/src/media/rtpSender.ts)

  │ "packetsSent\+\+|packetsReceived\+\+|bytesSent \+=|bytesReceived \+=" in
  │ **/*.ts (packages/webrtc/src/transport/dtls.ts)

  │ "sendRtcpPLI|GenericNack|onPacketLost|RtcpPayloadSpecificFeedback" in
  │ **/*.ts (packages/webrtc/src/media/rtpReceiver.ts)

  │ packages/webrtc/src/media/rtpSender.ts

  │ packages/webrtc/src/media/rtpReceiver.ts

  │ packages/webrtc/src/media/receiver/statistics.ts

  │ "new StreamStatistics|remoteStreams\[|\.add\(" in **/*.ts
  │ (packages/webrtc/src/media/rtpReceiver.ts)

  │ "getStats\(selector\?: MediaStreamTrack|invalid selector|peer-connection
  │ stats" in **/*.ts (packages/webrtc/tests/integrate/getStats.test.ts,
  │ packages/webrtc/src/peerConnection.ts)

● Web Search (MCP: github-mcp-server) · W3C RTCRtpSender.getStats must return RTCStatsReport not ar…

● Web Search (MCP: github-mcp-server) · W3C RTCPeerConnection.getStats(selector) should peer-connec…

● Web Search (MCP: github-mcp-server) · W3C RTCPeerConnection.getStats invalid selector object shou…

● Web Search (MCP: github-mcp-server) · W3C RTCPeerConnection.getStats after close behavior stats s…

● Web Search (MCP: github-mcp-server) · W3C RTCPeerConnection.getStats selector not associated with…

  │ "class Candidate|interface Candidate|type Candidate" in **/*.ts
  │ (packages/ice/src)

  │ "relatedAddress|relatedPort|tcpType|url|foundation" in **/*.ts
  │ (packages/ice/src)

  │ packages/ice/src/candidate.ts

  │ "restart\(|renominating|resetNominatedPair|setRemoteParams\(" in **/*.ts
  │ (packages/webrtc/src/transport/ice.ts, packages/ice/src/ice.ts)

  │ "tlsVersion|cipher|srtpProfile|selectedCandidatePairChanges|iceRestarts" in
  │ **/*.ts (packages/webrtc/src/transport/dtls.ts, packages/dtls/src,
  │ packages/rtp/src)

  │ packages/webrtc/src/transport/dtls.ts

  │ packages/webrtc/src/transport/ice.ts

  │ "cipher|version|srtpProfile" in **/*.ts (packages/dtls/src)

  │ "dtls\.srtp\.srtpProfile|cipherSuite|serverHello" in **/*.ts
  │ (packages/webrtc/src/transport/dtls.ts, packages/dtls/src)

以下の内容で詳細化できます。

# W3C互換 `getStats` 実装タスク詳細化

## 1. タスクの目的と背景

`werift` では `getStats` がすでに部分実装されていますが、現状は **W3C WebRTC / webrtc-stats 仕様への互換性が不十分** です。特に `packages/webrtc` では `RTCPeerConnection.getStats()` はある一方で、`RTCRtpSender` / `RTCRtpReceiver` は `RTCStatsReport` ではなく配列を返しており、統計オブジェクト間の参照関係やメトリクスの埋まり方も仕様準拠になっていません。

コードベース上の主な現状は以下です。

| 対象 | 現状 | 主要ギャップ |
| --- | --- | --- |
| `packages/webrtc/src/peerConnection.ts` | `RTCPeerConnection.getStats()` は `RTCStatsReport` を返す | selector 指定時も peer-wide / transport / data-channel を混ぜて返している |
| `packages/webrtc/src/media/rtpSender.ts` | `RTCRtpSender.getStats()` は `RTCStats[]` | 返り値が仕様非互換、`remoteId` 未設定、remote-inbound が不足 |
| `packages/webrtc/src/media/rtpReceiver.ts` | `RTCRtpReceiver.getStats()` は `RTCStats[]` | 返り値が仕様非互換、`bytesReceived` 未実装、`jitter` 単位が仕様非互換 |
| `packages/webrtc/src/media/stats.ts` | 型定義はかなり揃っている | `media-playout` 欠落、timestamp が `performance.now()` のみ |
| `packages/webrtc/src/transport/ice.ts` / `packages/ice/src` | candidate / candidate-pair を返せる | ID 生成が foundation ベースで衝突・再利用しうる。pair 参照 ID も不整合 |
| `packages/webrtc/tests/integrate/getStats.test.ts` | テストは多数ある | 仕様準拠というより「壊れないこと」中心で、誤仕様を固定化している箇所がある |

背景として、`README.md` の roadmap にも `getStats` は未完了項目として残っており、今回のタスクは **単なる統計追加ではなく、公開 API を W3C 互換に寄せる仕上げ作業** と捉えるのが適切です。

## 2. 実装すべき具体的な機能や変更内容

1. **公開 API を W3C 互換に揃える**
   - `RTCPeerConnection.getStats(selector?)` の仕様準拠
   - `RTCRtpSender.getStats()` を `Promise<RTCStatsReport>` に変更
   - `RTCRtpReceiver.getStats()` を `Promise<RTCStatsReport>` に変更
   - 必要なら生成ドキュメント (`doc/classes/*.md`) も更新

2. **stats graph を仕様どおりに返す**
   - 返却対象の主統計から `codecId` / `transportId` / `selectedCandidatePairId` / `localCandidateId` / `remoteCandidateId` / `localCertificateId` / `remoteCertificateId` / `remoteId` / `localId` をたどって、**関連 stats を推移的に含める**
   - 逆に、selector や sender/receiver と無関係な stats を混ぜない

3. **stats object の型と基本ルールを揃える**
   - `RTCStats.timestamp` を `performance.timeOrigin + performance.now()` ベースにする
   - `RTCStatsType` に必要な型を揃える（少なくとも `media-playout` の扱いを整理）
   - 利用できない値は **0 埋めせず omit**
   - cumulative metric は未観測でも 0 を返してよいものだけ 0 を返す

4. **RTP 系 stats を充実させる**
   - `outbound-rtp`: `remoteId`, `headerBytesSent`, `retransmittedPacketsSent`, `retransmittedBytesSent`, RTT 関連累積値
   - `inbound-rtp`: `bytesReceived`, `headerBytesReceived`, `lastPacketReceivedTimestamp`, `remoteId`, feedback count など
   - `remote-inbound-rtp`: `packetsLost`, `fractionLost`, `roundTripTime`, `totalRoundTripTime`, `roundTripTimeMeasurements`
   - `remote-outbound-rtp`: `reportsSent`, `remoteTimestamp` などの精度改善

5. **Transport / ICE 系 stats を充実させる**
   - `transport.selectedCandidatePairId` と `candidate-pair.id` の整合
   - `candidate-pair.totalRoundTripTime`, `currentRoundTripTime`, `roundTripTimeMeasurements`
   - `transport.iceRole`, `iceLocalUsernameFragment`, `dtlsRole`
   - 可能なら `tlsVersion`, `dtlsCipher`, `srtpCipher`
   - `local-candidate` / `remote-candidate` の `relatedAddress`, `relatedPort`, `tcpType`, `usernameFragment`

6. **ID の安定性と lifetime を仕様寄りに直す**
   - foundation や SSRC だけで ID を作らず、**監視対象オブジェクト単位の stable ID** を使う
   - ICE restart や candidate 再生成後に、削除済み object の ID を再利用しない
   - 特に candidate / candidate-pair は `packages/ice` 側の改修が必要

7. **不足メトリクスがある lower package を改修する**
   - `packages/ice`: candidate / pair 用 stable ID、requests / responses / retransmissions / consent 系カウンタ
   - 必要に応じて `packages/dtls`: negotiated cipher / version の露出
   - `packages/webrtc` 内の sender / receiver / statistics クラス: bytes / header bytes / feedback counters / RTT accumulators

8. **テストを仕様ベースへ更新する**
   - sender/receiver 単体の `getStats()`
   - selector 付き `pc.getStats(track)` の対象限定
   - stats 参照関係の閉包
   - ID の一意性・安定性・再利用禁止
   - ICE restart / close / track removal 後の lifetime
   - jitter / timestamp の単位検証

## 3. 技術的な実装アプローチを調査し結果を簡潔にまとめる

### 推奨アプローチ
**各コンポーネントで stats をバラバラに直接返す方式のまま拡張するより、`packages/webrtc` 側に統一 collector を置く** のが安全です。

### 実装方針
1. **raw providers を残す**
   - sender / receiver / dtls / ice / sctp は「自分が知っている raw stats object 群」を返す
2. **中央 collector を追加する**
   - 例: `StatsCollector` / `StatsGraphBuilder`
   - 全 stats を一度 index 化し、`id -> stat` マップを作る
3. **API ごとに root object を決める**
   - `pc.getStats()` → 全 root
   - `pc.getStats(track)` → その track に紐づく `media-source` / `outbound-rtp` / `inbound-rtp` / remote RTP
   - `sender.getStats()` → sender 系 root
   - `receiver.getStats()` → receiver 系 root
4. **参照をたどって report を閉包する**
   - `codec`, `transport`, `candidate-pair`, `candidate`, `certificate` を自動で含める
5. **1 回の getStats 呼び出しで timestamp を揃える**
   - report 全体で同一基準時刻に近い snapshot にする

### 調査上の重要所見
- `jitter` は現実装だと RTP clock 単位のまま返っており、**仕様上の秒単位に変換が必要**
- `selectedCandidatePairId` は `transport/dtls.ts` と `transport/ice.ts` で **別ルールの ID** を使っており、参照が壊れうる
- `Candidate.foundation` ベース ID は **一意でも安定でもない**
- `packages/ice` には `totalRoundTripTime` / `roundTripTimeMeasurements` がすでにあるので、**surface していないだけの値も多い**

## 4. 考慮すべき制約や注意点

- **仕様準拠を優先**しつつ、ブラウザ実装差分がある箇所（特に selector 周り）は実装前に最終判断を固定する
- **未取得の値を雑に 0 で返さない**。仕様上 unavailable は omit が基本
- **ID 再利用禁止** を守る必要があるため、現在の `generateStatsId(type, foundation|ssrc)` 依存は避ける
- `pc.getStats(track)` は現行テストが広すぎるため、**既存テストを壊すのではなく誤仕様テストを修正する作業**が必要
- BUNDLE 無効時、複数 transport / 複数 certificate / ICE restart を考慮する
- `close()` 後の stats は「呼べる」だけでなく、**寿命と更新停止の扱い**を整理する
- `media-playout` のように実装基盤が薄いものは、**型だけ先に揃えて未対応フィールドは出さない** という段階導入もあり

## 5. 完了条件

1. `RTCPeerConnection` / `RTCRtpSender` / `RTCRtpReceiver` の `getStats` が **W3C 互換の戻り値 (`RTCStatsReport`)** を返す
2. `timestamp`, `id`, `type`, 参照 ID 群が仕様どおりに整合している
3. `outbound-rtp` / `inbound-rtp` / `remote-inbound-rtp` / `remote-outbound-rtp` / `transport` / `candidate-pair` / `candidate` / `certificate` / `data-channel` / `peer-connection` の主要 stats が取得できる
4. 不足メトリクスがある場合、`packages/webrtc` だけでなく `packages/ice` など必要な package まで改修されている
5. selector / sender / receiver ごとの **対象限定と参照 closure** がテストで担保されている
6. ID の一意性・安定性・ICE restart 後の非再利用がテストで担保されている
7. 公開シグネチャ変更に応じて生成ドキュメントが更新されている

このタスクは **`packages/webrtc` の API 整備 + `packages/ice` を含む統計基盤整備 + テストの仕様化** をまとめて行うタスクとして切るのが適切です。