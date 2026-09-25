# Issue #705: 非対応 RTP m-line を Answer 側で reject し、停止済み位置を再利用する

- 対象: [Issue #705](https://github.com/shinyoshiaki/werift-webrtc/issues/705)
- 主な対象: `packages/webrtc/src`、`packages/webrtc/tests/issue`、`packages/webrtc/README.md`、`docs/design`、`changelog.md`
- スコープ境界: **§2 を参照**。PeerConnection negotiation state machine 全体の再設計は別チケット `ticket/0ad06d37-d829-4a08-8e49-2da46e551b79`（「PeerConnection negotiation transaction invariant の明文化と state machine 整理」）が扱い、本チケットのレビューでは同チケットと重複する指摘をしない。
- 調査時点: 2026-09-23 の当作業ツリー。**このチケットは実装指示であり、以下の完了条件は未達**。依頼文の §6.4 にある実施済み・Chromium 検証済みという記録に対応するコード、テスト、設計文書はこの作業ツリーには存在しないため、実装後に改めて検証する。

## 1. 目的と背景

妥当な remote offer にローカルで扱えない audio/video m-line が含まれていても、`setRemoteDescription()` を成功させ、対応する answer m-line を port `0` で拒否する。現状は `TransceiverManager.setRemoteRTP()` の codec 交渉結果が空になると `Error("negotiate codecs failed.")` を投げる。`SDPManager` はその前に pending remote SDP を保存しているため、後続 m-line の処理と signaling state 更新が中断される。WorkAdventurer の音声専用構成で、ブラウザが送る BUNDLE 内の video を受けるためだけに VP8 を追加する回避が必要になる。

[RFC 8829（JSEP）](https://www.rfc-editor.org/rfc/rfc8829)、[RFC 3264 §6.1](https://www.rfc-editor.org/rfc/rfc3264#section-6.1) に従い、共通 format のない section は answer の同じ位置で拒否する。[RFC 8843 §7.3](https://www.rfc-editor.org/rfc/rfc8843#section-7.3) に従い、BUNDLE の拒否済み MID を group に残さず、初回 answer で tag が拒否された場合は受け入れた section へ tag を移す。

追加要件として、`mLineReuse` モード、`transceiver.stop()`、停止交渉後の m-line 再利用を実装する。`removeTrack` と `stop` を同じ交渉前に行い、port 0 の拒否交渉を完了してから新規 transceiver を追加した場合、元が 2 本なら m-line は 2 本のまま、再利用位置には新 MID と新 transceiver を置く。

## 2. 関連チケット 0ad06d37 とのスコープ境界（レビュー重複防止）

このチケットは Issue #705 の拒否動作と m-line reuse を develop 上で実装する。PeerConnection negotiation transaction 全体の再設計は別チケット `ticket/0ad06d37-d829-4a08-8e49-2da46e551b79`（「PeerConnection negotiation transaction invariant の明文化と state machine 整理」）が扱う。0ad06d37 は develop に未マージで、本チケットの前提・依存ではない。両チケットは `transceiverManager.ts` / `sdpManager.ts` / `peerConnection.ts` などを共有するため、レビューは以下の境界に従う。

### 2.1 本チケットのスコープ

§3 の変更と §6 の完了条件を満たすための局所修正を対象とする。0ad06d37 の遷移表にも `RTP reject/stop/m-line reuse` 行があるが、その具体的な動作と完了条件は本チケットで定義し、0ad06d37 は transaction lifecycle への統合を担う。

- codec 不一致 / remote port 0 の m-line を answer で拒否する動作と、answer SDP の位置・MID・type・proto・port・fmt の整合
- 拒否 MID を含む BUNDLE group / tag の answer 上の扱いと、受け入れ m-line の transport / ICE candidate の MID・index 整合
- `PeerConfig.mLineReuse`、`transceiver.stop()`、停止位置の再利用、`removeTrack()` の再開可能性
- 上記に直接必要な範囲の pending（非対応 re-offer の保留）と rollback（確定前の RTP pipeline / track 復元）
- 上記の回帰テスト、設計文書、README、changelog

### 2.2 0ad06d37 が扱う範囲（本チケットのレビュー指摘として要求しない）

以下は 0ad06d37 の設計・完了条件で扱う。本チケットの差分に対して、これらを新規実装・再設計することを求めない。重複指摘を避けるため、該当する懸念は 0ad06d37 側の論点として扱う。

- `NegotiationTransaction` 相当の coordinator 新設と begin / replace / validate / prepare / commit / rollback / cleanup の単一 lifecycle
- RTP / BUNDLE / ICE / DTLS / SCTP を横断した current / pending / rollback baseline の統一と包括的な atomic commit
- offer / pranswer / replacement offer・pranswer / final answer / rollback の全遷移を対象にした state machine の再実装
- pranswer 中の暫定 RTP / connectivity checks / DTLS handshake / 新規 SCTP・DataChannel 通信
- ICE restart / trickle の generation 管理、BUNDLE split/merge、SCTP parameter・port 変更
- `ontrack` / transceiver / `icecandidate` / `ondatachannel` の不可逆イベントと speculative object の寿命・重複通知契約
- `assertNegotiationInvariants` 相当の test-only helper と両方向 transition matrix テスト
- 0ad06d37 のレビューで既出の論点（`setLocalDescription` の offer 同一性チェック、`IceConnection` interface のメソッド追加に伴う breaking change、`assertStablePayloadTypes` の適用範囲）。本チケットの差分が同等の変更を新たに持ち込まない限り再指摘しない

### 2.3 レビュー判定の基準

- 判定は本チケットの §6 完了条件と、本差分が新たに持ち込む regression・security・データ破損・通信不能に対して行う。§2.2 を理由にスコープ拡大を要求しない。
- 0ad06d37 の遷移表の `RTP reject/stop/m-line reuse` 行と矛盾しないことは、本チケットの RTP / m-line 範囲で確認する。整合修正は局所修正に留め、coordinator 導入は求めない。
- 本チケットの範囲外と判明した transaction 問題は、完了条件に追加せず 0ad06d37 に記録する。
- 実装は develop を基線に独立して行い、0ad06d37 のコードを前提にしない。共通関数の変更は、後から 0ad06d37 が載せ替えられるよう必要最小限に留める。

## 3. 実装する変更

### 非対応 RTP section と answer

1. `RTCRtpTransceiver` に codec 不一致による reject を `inactive`、`stopping`、`stopped` と区別する状態を持たせる。remote `port 0` も受信・送信パイプラインを組まない条件に含める。re-offer の暫定状態と確定済みの拒否状態を区別し、rollback で元に戻せるようにする。
2. `setRemoteRTP()` は codec が空でも MID と m-line index を設定して SRD を続行する。拒否 section では `prepareSend`、`prepareReceive`、SSRC/RID router 登録、`onTrack`、TWCC 設定を行わない。remote が既に `port 0` で codec も一致しない場合も同じ扱いにする。
3. `buildAnswerSdp()` は offered m-line の数・順序・MID・type・proto を保ち、非対応 section だけ port `0` にする。拒否 m-line にも offered `fmt` から少なくとも 1 token を残す。受け入れた inactive section は既定の `compatible` では port `9` のままにする。`aggressive` の inactive port `0` は明示 opt-in に限定する。
4. 非ゼロの remote answer / pranswer は pending local offer の codec と照合し、共通 codec がなければ `InvalidAccessError` として signaling state と descriptions を変更せず拒否する。非対応 re-offer を pending にしている間は既存 track/RTP を維持し、port 0 answer が確定した時点で停止・解放する。

### BUNDLE、transport、ICE

5. Answer の BUNDLE group は offered group の member のうち受け入れた MID のみで構築する。非 tag の拒否では tag を保持し、初回 answer で offerer-tagged を拒否したら受け入れた member を先頭の answerer-tagged にする。全 member を拒否したら group を省略する。確立済み BUNDLE の再交渉では negotiated tag と transport ownership を保持し、保持できない offer は不整合な answer を作らず拒否する。
6. SRD では offered BUNDLE group の member だけが tag の transport を共有し、ICE/DTLS パラメータは tag 側を共有 transport に適用する。group 外で受け入れた m-line は独立 transport、ICE credentials、candidate を持つ。unbundled (`bundlePolicy: "disable"`) は対応 section の独立 transport を維持する。停止した section の遊休 transport は他の live member が使っていない場合だけ閉じる。
7. Local trickle candidate の `sdpMid` / `sdpMLineIndex` は、m-line 0 固定ではなく、実際にその ICE transport を所有する受け入れ済み tagged section に合わせる。remote candidate は remote SDP の全 media 配列で MID/index を解決し、拒否した m-line の MID/index も失わない。SCTP が RTP より先にある SDP と部分 BUNDLE も扱う。

### m-line 再利用、stop、イベント

8. `PeerConfig.mLineReuse: "compatible" | "aggressive"` を追加し、既定値を `compatible` にする。生成時に値を検証し、`setConfiguration()` による途中変更を拒否する。`compatible` は inactive を非ゼロ port とし、`aggressive` は従来の inactive port 0 を明示的に選ぶ。両モードで codec reject と BUNDLE/ICE の整合性を守る。
9. `stop()` を冪等にし、sender/receiver、router の SSRC/RID 登録、RTCP/NACK/TWCC と pending RTP を停止・解除して negotiation を要求する。共有 ICE/DTLS は他の利用者がいる限り維持する。未関連付け transceiver の stop は新たな停止済み m-line を生成しない。`stopping` は次の**自分の offer**で port 0 とし、拒否 answer 適用後に `stopped` を確定する。answerer が stop を呼んだだけでは `compatible` の answer を強制的に port 0 にせず、その後自分が出す offer で停止を交渉する。
10. 新規 `addTransceiver()` は**拒否交渉が確定した** port 0 位置を優先し、旧 transceiver から MID/index を外して新 MID を割り当てる。停止予定の位置を交渉前に先取りしない。旧オブジェクトは復活させない。remote offer の同じ位置に新 MID が来た場合も新 receiver/router を作る。`addTrack()` の自動再使用は未送信・非停止・非拒否 sender に限る。`removeTrack()` は sender の track を detach し、同じ sender で再開可能にする。
11. SSRC のない remote track は transceiver ごとの placeholder を再利用し、re-offer の `onTrack` と track 重複を防ぐ。非対応 re-offer の rollback では元の transceiver 対応、track、RTP pipeline を復元する。remote SDP に起因する stop は `negotiationneeded` を発火させず、アプリケーションの `stop()` は発火させる。未設定 MID の複数 transceiver は異なる m-line を予約する。

## 4. 技術調査と実装経路

| 箇所 | 現状と必要な対応 |
| --- | --- |
| `src/transceiverManager.ts` | `setRemoteRTP()` は MID/index 設定後、空 codec を throw。これを reject 状態の記録と準備処理の skip に変える。`addTransceiver()` は現在 inactive 枠を横取りし、旧 MID をコピーするため、確定済み port 0 枠だけを再利用する。`addTrack()` も stopped/rejected の選択を防ぐ。 |
| `src/media/rtpTransceiver.ts`、`src/media/rtpSender.ts`、`src/media/rtpReceiver.ts`、`src/media/router.ts` | `stop()` は `stopping = true` のみ。sender/receiver には停止処理があるが router には登録解除 API がない。拒否状態、停止完了、リソース解放、再開可能な `removeTrack()` を連動させる。 |
| `src/sdpManager.ts` | `createMediaDescriptionForTransceiver()` は codec 配列から fmt を作るため空 fmt になりうる。`addTransportDescription()` は inactive を port 0 にする。`buildAnswerSdp()` は全 MID を BUNDLE に入れる。offer/answer の位置対応、format fallback、モード別 port、offered membership/tag をここで整える。`setLocal()` は RTP media を filter した index で transceiver を引くため、SCTP 先行時は元の media index で照合する。 |
| `src/peerConnection.ts` | SRD は pending remote 保存後に各 m-line の codec/transport を適用し、最後に signaling state を変える。BUNDLE なら現在全 media が先頭 transport を共有する。local candidate callback は `_localDescription.media[0]` を使用する。offer/answer 適用時の検証、確定・rollback、transport 所有者、候補通知、stop の negotiation を調整する。 |
| `src/secureTransportManager.ts` | remote candidate の MID/index 解決は remote SDP media 配列を参照するので、その位置対応を維持する。local candidate は bundled なら index `0` に固定するため、実 tag/index と transport 所有者で付与する。 |

実装順は、(1) codec reject と有効な answer、(2) offered BUNDLE membership と ICE transport の対応、(3) `mLineReuse` と停止・再利用、(4) re-offer/answer/rollback とイベントの整合性、(5) 回帰・interop 検証と文書更新とする。全 PeerConnection negotiation state machine の再設計は §2 のとおり別チケット 0ad06d37 が扱い、WPT 専用 strict shim の通常 API への移植も範囲外。§3 の rollback・確定処理は、この変更で触る RTP/m-line に必要な範囲で実装する。

## 5. 制約と注意点

- codec reject と direction `inactive`、永久停止を同一状態にしない。単に例外を除くだけでは空 fmt、port 9、拒否済み BUNDLE tag、空 codec を参照する sender/receiver 処理が残る。
- `PeerConfig.codecs` は `deepMerge` でオブジェクト単位に置換される。テストでは受け入れ側を `{ codecs: { audio: [useOPUS()], video: [] } }` などとし、デフォルト VP8 が残らないことを確認する。unbundled テストでは必ず `bundlePolicy: "disable"` を指定する。
- 現在の `setRemoteDescription()` は pending remote 保存後に処理するため、追加する拒否エラーや検証は、可能な限り破壊的な状態更新より前に行う。特に非ゼロ answer/pranswer の codec 検証失敗では signaling/descriptions を保つ。
- `removeTrack → 交渉 → stop → 交渉 → 新規追加` と `removeTrack + stop → 交渉 → 新規追加` の両手順を比較し、port 0 交渉前の新規追加は既存位置を奪わないことを確認する。
- 既存の `tests/integrate/peerConnection.test.ts` の port 0/no-ontrack、`tests/issue/141.test.ts` / `142.test.ts`、通常のデフォルト codec 交渉を維持する。テストの Arrange は `705.helpers.ts` など 1 箇所にまとめ、Act/Assert には日本語コメントを付ける。
- `docs/design/705-media-rejection-and-removetrack.md` と `packages/webrtc/README.md` にモードの選択例と停止・拒否・再利用の意味を記載し、`changelog.md` の Unreleased に #705 の修正を追記する。現作業ツリーには当該設計文書と `705*.test.ts` はまだない。

## 6. 完了条件

レビューは §2 のスコープ境界に従う。§2.2 に列挙した 0ad06d37 の範囲（transaction coordinator、pranswer、ICE restart、全 subsystem の rollback 統一など）を本チケットの完了条件に追加しない。

- [ ] codec 不一致または remote port 0 の offer で SRD が成功し、非対応 section で sender/receiver 準備、router 登録、`onTrack`、TWCC が動かない。
- [ ] Answer は元の m-line 数・順序・MID・type・proto を維持し、拒否 section の port 0 と 1 つ以上の offered fmt token を出す。受け入れ section は非ゼロ port。
- [ ] `705.test.ts` で unbundled の video 不一致 + audio 一致、BUNDLE 非 tag 不一致、tag 不一致と再選択、全拒否、remote port 0 + codec 不一致、後続 m-line、remote candidate の MID/index を検証する。
- [ ] BUNDLE group は offered membership と受け入れ section に一致する。初回 tag 再選択、確立済み tag 維持、group 外の独立 transport/ICE/candidate、local trickle の tag/index、SCTP 先行を検証する。
- [ ] `mLineReuse` 両値、既定値、無効値、途中変更拒否を検証する。`compatible` の inactive は非ゼロ、`aggressive` の inactive は port 0。両モードで #705 の拒否動作が成立する。
- [ ] `705-reuse.test.ts` で `stop()` の冪等性と解放、交渉要求、未関連付け stop、交渉前の非再利用、確定後の同 index/新 MID 再利用、answerer の停止、BUNDLE 先頭停止、unbundled、SCTP 先行、繰り返し再利用後の実 RTP 受信を検証する。
- [ ] 非ゼロ answer/pranswer の codec 不一致は `InvalidAccessError` で状態を変えず拒否する。非対応 re-offer の pending 中と rollback 後は既存 RTP/track を維持し、確定後だけ停止・再利用可能にする。`onTrack` 重複と `negotiationneeded` の発火条件も検証する。
- [ ] `cd packages/webrtc && npm run type` と `cd packages/webrtc && npm test` が通る。変更が package をまたぐ場合は workspace の `npm run type` / `npm run test:small` へ広げる。Chromium ↔ werift の removeTrack/stop/reuse RTP E2E を両モードで確認する。Firefox/Safari、WPT、E2E 全件、workspace CI は必須ゲートとしない。
- [ ] README、設計文書、`changelog.md` Unreleased を更新し、通常のデフォルト codec negotiation と既存 port 0・Issue #141/#142 テストが通る。
