# 非対応 RTP m-line の拒否と停止済み m-line の再利用 (Issue #705)

remote offer にローカルで扱えない audio/video m-line が含まれていても `setRemoteDescription()` を成功させ、
answer の同じ位置を port `0` で拒否する。あわせて `transceiver.stop()` と、停止交渉が確定した m-line の再利用を扱う。

対象実装: `packages/webrtc/src/transceiverManager.ts`、`src/sdpManager.ts`、`src/peerConnection.ts`、
`src/secureTransportManager.ts`、`src/media/rtpTransceiver.ts`、`src/media/rtpSender.ts`、`src/media/router.ts`

参照: [RFC 8829 (JSEP)](https://www.rfc-editor.org/rfc/rfc8829) §5.3.1、
[RFC 3264 §6](https://www.rfc-editor.org/rfc/rfc3264#section-6)、
[RFC 8843 §7.3](https://www.rfc-editor.org/rfc/rfc8843#section-7.3)

PeerConnection negotiation state machine 全体の整理 (transaction coordinator、pranswer の暫定 RTP、
ICE restart、全 subsystem の rollback 統一など) は別チケット `0ad06d37` の範囲。本変更は RTP / m-line に必要な局所修正に留める。

---

## Before

- `TransceiverManager.setRemoteRTP()` は codec 交渉結果が空だと `Error("negotiate codecs failed.")` を投げた。
  `SDPManager` は pending remote SDP を保存済みのため、後続 m-line と signaling state の更新が中断された。
- 音声専用構成でブラウザが BUNDLE 内に video を含めると、VP8 を追加して受けるしかなかった。
- `buildAnswerSdp()` は全 MID を BUNDLE に入れ、拒否 section の fmt が空になりうる。inactive は常に port 0。
- `transceiver.stop()` は `stopping = true` を立てるだけ。`addTransceiver()` は inactive 枠を横取りし旧 MID をコピーした。
- `removeTrack()` は `sender.stop()` を呼ぶため、同じ sender で送信を再開できなかった。

## After

### transceiver の状態

| 状態 | 意味 | RTP pipeline |
|------|------|--------------|
| `direction` / `currentDirection === "inactive"` | 受け入れた inactive。m-line は生きている | 維持 |
| `pendingRejection` | remote offer の m-line を拒否予定 (answer 未確定) | 既存を維持 |
| `rejected` (+ `stopped`) | 共通 codec なし / remote port 0 で拒否が確定 | 解放済み |
| `stopping` | app が `stop()` した。port 0 は次の自分の offer で交渉 | `stop()` 時点で解放 |
| `stopped` (`currentDirection === "stopped"`) | port 0 の交渉が確定 | 解放済み |

解放は sender / receiver の停止、RtpRouter の SSRC / RID 登録解除、RTCP / NACK / TWCC と pending RTP の破棄、
remote track の `ended`。停止した transceiver の transport は、他の live な m-line / SCTP が使っていない場合だけ閉じる。

### 非対応 section の answer

```text
offer                                   answer
a=group:BUNDLE 0 1                      a=group:BUNDLE 1          ← 受け入れた MID のみ
m=video 9 UDP/TLS/RTP/SAVPF 96  (mid 0) m=video 0 UDP/TLS/RTP/SAVPF 96   ← 位置・MID・proto・fmt token を保持
m=audio 9 UDP/TLS/RTP/SAVPF 111 (mid 1) m=audio 9 UDP/TLS/RTP/SAVPF 111  ← answerer-tagged に移動
```

- SRD は codec が空でも MID と m-line index を設定して続行する。拒否 section では `prepareSend` / `prepareReceive` /
  router 登録 / `onTrack` / TWCC を行わない。remote が既に port 0 の場合も同じ。
- 未知の MID の port 0 m-line には transceiver を関連付けない (予約済みの新 transceiver を奪わない)。
- 確立済み BUNDLE の re-offer では negotiated tag を group 先頭に保つ。共有 transport の member を group 外へ出す
  re-offer は、状態を変える前に `InvalidAccessError` で拒否する。
- 非ゼロ port の remote answer / pranswer が pending local offer と共通 codec を持たない場合、
  `InvalidAccessError` で拒否し、signaling state と descriptions を変更しない。

### BUNDLE / transport / ICE

- offered BUNDLE group の member だけが共有 transport を使い、ICE / DTLS パラメータは group の tag
  (先頭の非ゼロ member) から適用する。拒否 member の remote 候補も共有 transport に渡す。
- group 外で受け入れた m-line は独立した transport と ICE credentials を持つ。`bundlePolicy: "disable"` は各 section 独立。
- local trickle candidate の `sdpMid` / `sdpMLineIndex` は、その ICE transport を所有する受け入れ済み m-line
  (BUNDLE なら tag) に合わせる。停止 / 拒否 section しか使わない transport の候補は通知しない。
- remote candidate は remote SDP の全 media 配列で MID / index を解決する。拒否した m-line 向けの候補は
  例外にせず、その位置に記録だけする。SCTP が RTP より先にある SDP でも元の index を使う。

### `mLineReuse`

| 値 | inactive の port | port 0 になるもの |
|----|------------------|-------------------|
| `"compatible"` (既定) | 9 | 拒否 / 停止した m-line |
| `"aggressive"` | 0 (従来動作) | 拒否 / 停止した m-line と inactive |

生成時に値を検証し (`TypeError`)、`setConfiguration()` による変更は `InvalidModificationError`。
どちらのモードでも codec reject、BUNDLE membership、ICE の所有関係は同じ規則に従う。
`aggressive` の inactive port 0 は相手 (ブラウザ) から見ると拒否なので、port 0 の answer を受けた m-line は
`stopped` として確定し、以後は再利用可能な位置になる。

### stop と m-line 再利用

```text
removeTrack + stop ──► offer: m=video 0 (旧 MID) ──► answer: port 0 ──► stopped 確定
                                                                         │
addTransceiver("video") ◄── 確定済み port 0 の同じ kind の位置を予約 ─────┘
      │
      └─► offer: 同じ index に新 MID / 新 transceiver。m-line 数は増えない
```

- `stop()` は冪等。未関連付け transceiver の stop は即 `stopped` になり、m-line を作らない。
  `createOffer()` で MID だけ割り当てられ未適用のまま stop した場合も、確定済み local description に
  非ゼロ m-line がなければ次の answer 確定時に `stopped` とし、negotiationneeded を繰り返さない。
- 関連付け済みなら negotiationneeded を要求し、次の自分の offer で port 0 にする。answer 適用後に `stopped`。
- answerer が `stop()` しただけでは、`compatible` の answer を port 0 にしない (inactive で答える)。
  answer 確定後に negotiationneeded を出し、自分の offer で停止を交渉する。
- `addTransceiver()` は **拒否 / 停止が確定した** port 0 位置だけを再利用する。stopping (交渉前) の位置は先取りせず、
  末尾に追加する。旧 transceiver は MID / index を外されて `getTransceivers()` から置き換わり、復活しない。
- remote offer が同じ位置に新 MID を置いた場合も、新しい transceiver / receiver / router 登録を作る。
- `addTrack()` の自動再使用は、未送信・非停止・非拒否の sender に限る。
- `removeTrack()` は sender から track を外すだけで sender は止めない。`sender.replaceTrack(track)` と
  `direction = "sendrecv"` で同じ sender から送信を再開できる。
- remote SDP 起因の停止 (拒否 / answer からの欠落) は negotiationneeded を出さない。app の `stop()` は出す。

### pending と rollback

- 非対応 re-offer の適用中 (`have-remote-offer`) は `pendingRejection` だけを立て、既存 track / RTP pipeline を維持する。
- local answer の確定で停止・解放する。`setRemoteDescription({ type: "rollback" })` では transceiver 対応
  (MID / index / 置き換え前の transceiver) を元に戻し、その offer が作った transceiver を破棄する。
- SSRC のない remote track は transceiver ごとの placeholder を再利用し、同じ受信状態の re-offer / re-answer で
  `ontrack` を重複発火しない。

## 検証

- `packages/webrtc/tests/issue/705.test.ts`: 拒否 answer の形、BUNDLE tag、全拒否、remote port 0、後続 m-line、
  remote / local candidate の MID と index、group 外 transport、SCTP 先行、`mLineReuse`、answer 検証、pending / rollback。
- `packages/webrtc/tests/issue/705-reuse.test.ts`: `stop()` の冪等性と解放、未関連付け stop、交渉前の非再利用、
  確定後の同 index / 新 MID 再利用、answerer の停止、BUNDLE 先頭停止、unbundled、SCTP 先行、繰り返し再利用後の RTP 受信。
- `e2e/tests/mediachannel/reuse.test.ts`: Chromium ↔ werift で removeTrack + stop → port 0 → 再利用を 2 回繰り返し、
  両モードで再利用位置の RTP を受信する。音声専用 werift が Chromium の audio + video offer の video を拒否する。
