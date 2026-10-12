import type { Connection } from "../../../ice/src";
import { StunOverTurnProtocol } from "../../../ice/src/turn/protocol";
import { turnAllocations } from "../../../ice/tests/utils";
import type { RTCIceCandidate, RTCPeerConnection } from "../../src";
import { negotiationCases } from "./negotiationCaseRunner";

/** Helpers of the TURN cases. */
const turnFns = {
  StunOverTurnProtocol,
  /** Act: `addIceCandidate` each recorded event on `pc` in order (`undefined` is end-of-candidates). */
  trickleAll: async (
    pc: RTCPeerConnection,
    events: (RTCIceCandidate | undefined)[],
  ) => {
    for (const candidate of events) {
      await pc.addIceCandidate(candidate?.toJSON() ?? null);
    }
  },
  relayAllocations: (pc: RTCPeerConnection) =>
    turnAllocations(pc.iceTransports[0].connection as Connection),
};

/**
 * Regressions for develop features merged into the negotiation transaction
 * (ticket section 2.6): TURN settings across a staged ICE restart, SCTP MTU,
 * and app-driven codec state during a pending negotiation.
 */
describe("develop features inside the negotiation transaction", () => {
  negotiationCases(
    "TURN settings and ICE restart (#688 / #731)",
    [
      `
      case: a TURN server set before a restart offer is gathered at the commit and trickled
      ref: 2.6-T3b 2.8-6; origin: develop #688 / #731
      given: createConnectedMediaAndDataPeersWithTurnServer()
      Arrange: TURN なしで接続済みの peer と、後から設定するローカル TURN server を用意する。
      let events = recordIceCandidates(a)
      Act: TURN を設定してから ICE restart の offer を適用する。
      do a.setConfiguration({ iceServers: turn.iceServers })
      do a.restartIce()
      a createOffer
      a setLocal
      Assert: 新しい server で集め直す generation なので、offer は relay も EOC もまだ含まない。
      expect local(a).sdp lacks "a=end-of-candidates"
      expect local(a).sdp lacks "typ relay"
      Act: answer を確定させ、commit 後に出る候補を answerer へ trickle する。
      b setRemote local(a)
      b answer hold
      let committedFrom = events.length
      a setRemote local(b)
      do waitForEndOfCandidates(events)
      let committed = events.slice(committedFrom)
      do trickleAll(b, committed)
      Assert: commit 後に新しい TURN server の relay 候補が trickle され、answerer が受け付ける。
      expect committed.find((c) => c?.candidate.includes("typ relay")) isnt undefined
      expect committed.at(-1) is undefined
      expect b.iceTransports[0].getRemoteCandidates().some((c) => c.candidate.includes("typ relay")) is true
      Assert: 新しい generation が nominate され、DataChannel が通信できる。
      do waitForCommittedNomination(a)
      data channel -> received
    `,
      `
      case: an ICE restart with TURN trickles a fresh relay candidate after the commit
      ref: 2.3-9 2.6-T3c 2.8-6; origin: develop #688 / #731
      given: createHeldTurnRestartPeers(0)
      Arrange: TURN 付きで接続済みの peer (TURN は offerer だけ) と、offerer の候補を answerer へ転送する経路。
      let relayBefore = a.iceTransports[0].getLocalCandidates().filter((c) => c.candidate.includes("typ relay"))
      expect relayBefore.length == 1
      let events = recordIceCandidates(a)
      Act: 設定を変えずに ICE restart を交渉し、commit 後の候補を answerer へ trickle する。
      do a.restartIce()
      a createOffer
      a setLocal
      let offerSdp = local(a).sdp
      b setRemote local(a)
      b answer hold
      let committedFrom = events.length
      a setRemote local(b)
      do waitForEndOfCandidates(events)
      let committed = events.slice(committedFrom)
      do trickleAll(b, committed)
      Assert: offer は古い relay 候補も EOC も含まず、commit 後に新しい allocation の relay 候補と EOC が届く。
      expect offerSdp lacks "typ relay"
      expect offerSdp lacks "a=end-of-candidates"
      let relayAfter = committed.filter((c) => c?.candidate.includes("typ relay"))
      expect relayAfter.length == 1
      expect relayAfter[0].candidate isnt relayBefore[0].candidate
      expect committed.at(-1) is undefined
      Assert: 新しい generation で DataChannel が通信できる。
      do waitForCommittedNomination(a)
      data channel -> received
    `,
    ],
    { fns: turnFns },
  );

  negotiationCases(
    "background gathering of consecutive ICE restarts",
    [
      `
      case: end-of-candidates is signalled once, when the latest generation completes
      ref: 2.3-10 2.3-11 2.3-12 2.8-8 2.8-9; origin: develop #688 / #731
      given: createHeldTurnRestartPeers(2)
      Arrange: 2 回続けた restart の TURN allocation をそれぞれ proxy で保留する。
      let closed = vi.spyOn(StunOverTurnProtocol.prototype, "close")
      do restartThrough(0)
      do restartThrough(1)
      let events = recordIceCandidates(a)
      Act: 置き換えられた 1 回目の restart の allocation を完了させる。
      do proxies[0].release()
      waitFor new Set(closed.mock.contexts).size === 2 timeout=1000
      Assert: 新 generation はまだ gathering で、end-of-candidates も relay 候補も出ない。
      expect events lacks undefined
      expect events.some((c) => c?.candidate.includes("typ relay")) is false
      expect a.iceGatheringState == "gathering"
      Act: 新 generation の allocation を完了させる。
      do proxies[1].release()
      do waitForEndOfCandidates(events)
      Assert: end-of-candidates は新 generation の relay 候補の後に一度だけ出る。
      expect events.filter((c) => c === undefined).length == 1
      expect events.at(-1) is undefined
      expect events.filter((c) => c?.candidate.includes("typ relay")).length == 1
      expect a.iceGatheringState == "complete"
      Assert: 継続の前提として、初回接続の DataChannel が開く (接続途中の再交渉で SCTP が COOKIE_WAIT に残る既知の疑いを避ける)。
      waitFor channel.readyState === "open" timeout=10000
    `,
      `
      case: only the latest generation keeps a TURN allocation
      ref: 2.6-T3c 2.8-9; origin: develop #688 / #731
      given: createHeldTurnRestartPeers(2)
      Arrange: 2 回続けた restart の TURN allocation をそれぞれ proxy で保留する。
      let closed = vi.spyOn(StunOverTurnProtocol.prototype, "close")
      do restartThrough(0)
      do restartThrough(1)
      Act: 新 generation、置き換えられた generation の順に allocation を完了させる。
      let events = recordIceCandidates(a)
      do proxies[1].release()
      do waitForEndOfCandidates(events)
      do proxies[0].release()
      waitFor new Set(closed.mock.contexts).size === 2 timeout=1000
      Assert: 新 generation の allocation 1 つだけが残り、遅れて完了した旧 allocation は閉じる。
      let allocations = relayAllocations(a)
      expect allocations.length == 1
      expect closed.mock.contexts lacks allocations[0]
      expect a.iceTransports[0].getLocalCandidates().filter((c) => c.candidate.includes("typ relay")).length == 1
      Assert: 継続の前提として、初回接続の DataChannel が開く (接続途中の再交渉で SCTP が COOKIE_WAIT に残る既知の疑いを避ける)。
      waitFor channel.readyState === "open" timeout=10000
    `,
      `
      case: an unapplied restart offer does not change the applied description the gathering refreshes
      ref: 2.8-13; origin: develop #688 / #731
      given: createHeldTurnRestartPeers(1)
      Arrange: restart を確定し、その TURN allocation を proxy で保留する。
      do restartThrough(0)
      let ufragOf = (sdp) => sdp.match(/^a=ice-ufrag:(\\S+)/m)[1]
      let committed = ufragOf(a.currentLocalDescription.sdp)
      let iceTransport = a.iceTransports[0]
      Act: 次の restart offer を作るが適用せず、確定済み generation の gather を完了させる。
      do a.restartIce()
      a createOffer as=unapplied
      let future = ufragOf(unapplied.sdp)
      do proxies[0].release()
      waitFor iceTransport.gatheringState === "complete" timeout=1000
      Assert: current description は適用した generation の資格情報・relay 候補・EOC を保ち、live ICE と一致する。未適用 offer の generation は入らない。
      expect future isnt committed
      let current = a.currentLocalDescription.sdp
      expect ufragOf(current) is committed
      expect iceTransport.connection.localUsername is committed
      expect current contains "typ relay"
      expect current contains "a=end-of-candidates"
      expect a.signalingState == "stable"
      Assert: 継続の前提として、初回接続の DataChannel が開く (接続途中の再交渉で SCTP が COOKIE_WAIT に残る既知の疑いを避ける)。
      waitFor channel.readyState === "open" timeout=10000
    `,
      `
      case: close() during a restart's background TURN gathering leaves no allocation
      ref: 2.3-12 2.3-24 2.8-8; origin: develop #688 / #731
      given: createHeldTurnRestartPeers(1)
      exempt: the offerer's close() is the operation under test
      Arrange: restart の TURN allocation を proxy で保留する。
      let closed = vi.spyOn(StunOverTurnProtocol.prototype, "close")
      do restartThrough(0)
      Act: gathering 中に close し、その後で allocation を完了させる。
      a close
      do proxies[0].release()
      Assert: close 後にできた allocation も閉じ (refresh timer も止まり)、transport に残らない。
      waitFor new Set(closed.mock.contexts).size === 2 timeout=1000
      expect relayAllocations(a).length == 0
    `,
    ],
    { fns: turnFns },
  );

  negotiationCases("one-to-one codec matching (#729)", [
    `
    case: an offer with several H264 variants is answered with only the configured one
    ref: 2.6-T4f; origin: develop #729
    given: createPeerPair({ codecs: { video: [useH264(), useH264({ parameters: "profile-level-id=42e01f;packetization-mode=0;level-asymmetry-allowed=1" }), useH264({ parameters: "profile-level-id=640032;packetization-mode=1;level-asymmetry-allowed=1" })] } }, { codecs: { video: [useH264()] } })
    Arrange: offerer は 3 種類の H264、answerer は既定の H264 (packetization-mode=1) だけを持つ。
    do a.addTransceiver("video")
    a createOffer
    a setLocal
    expect offeredVideoCodecs(local(a).sdp) == ["H264", "H264", "H264"]
    Act: offer に answer する。
    b setRemote local(a)
    b answer hold
    Assert: answer は設定した 1 つの variant だけを受理する。
    expect offeredVideoCodecs(local(b).sdp) == ["H264"]
    a setRemote local(b)
  `,
  ]);

  negotiationCases("app codec changes during a pending negotiation (#729)", [
    `
    case: setCodecPreferences between createAnswer and setLocalDescription commits the answer's codec
    ref: 2.6-T4c 2.6-T4h 2.8-38; origin: develop #729
    given: createH264OnlyReoffer()
    Arrange: current は VP8、offerer が H264 だけの re-offer を出し、answerer が answer を作成済み。
    b createAnswer as=answer
    Act: answer の適用前に preference を変え、その answer を適用する。
    do transceiver.setCodecPreferences([useVP8(), useH264()])
    b setLocal answer
    a setRemote local(b)
    Assert: 受信 table は answer の H264 を持ち、RTP が届く。
    expect Object.values(transceiver.receiver.snapshotReceiveTables().codecs).map((codec) => codec.name.toUpperCase()) contains "H264"
    rtp outgoing -> incoming
    Assert: 新しい preference は次の offer で再解決される。
    b createOffer as=next
    expect offeredVideoCodecs(next.sdp)[0] == "VP8"
  `,
    `
    case: addTrack between createAnswer and setLocalDescription sends with the answer's codec
    ref: 2.6-T4a 2.6-T4c; origin: develop #729
    given: createH264OnlyReoffer()
    Arrange: current は VP8、H264 だけの re-offer への answer を作成済み。
    b createAnswer as=answer
    Act: answer の適用前に既存 transceiver へ track を追加し、answer を適用する。
    do b.addTrack(new MediaStreamTrack({ kind: "video" }))
    b setLocal answer
    a setRemote local(b)
    Assert: sender は answer の H264 で送り、transceiver の codec も空にならない。
    expect transceiver.sender.codec?.name.toUpperCase() == "H264"
    expect transceiver.codecs.length > 0
  `,
    `
    case: setCodecPreferences during a pending offer survives its rollback
    ref: 2.5-17 2.6-T4b; origin: develop #729
    given: createConnectedVideoPeers({ codecs: { video: [useVP8(), useH264()] } })
    Arrange: VP8 + H264 の接続済み session で、offerer の re-offer を適用中にする。
    let transceiver = a.getTransceivers()[0]
    a createOffer
    a setLocal
    Act: pending 中に H264 だけを優先し、その offer を rollback する。
    do transceiver.setCodecPreferences([useH264()])
    a setLocal rollback
    Assert: アプリの選択は残り、次の offer は H264 だけを提案する。
    a createOffer as=next
    expect offeredVideoCodecs(next.sdp) == ["H264"]
    invariants a
  `,
    `
    case: replaceTrack during a pending re-offer rejects a track the answer's codec cannot carry
    ref: 2.6-T4d; origin: develop #729
    given: createH264OnlyReoffer()
    Arrange: current は VP8、H264 だけの re-offer を適用中の answerer。
    let vp8Source = new MediaStreamTrack({ kind: "video", codec: useVP8() })
    Act / Assert: commit 後に H264 で送ることになる VP8 source の track は受け付けない。
    expect transceiver.sender.replaceTrack(vp8Source) rejects=InvalidModificationError
    Assert: 交渉はそのまま完了できる。
    b answer
  `,
    `
    case: a track attached during a rolled-back pranswer gets the restored codec
    ref: 2.5-17; origin: develop #729
    given: createH264OnlyReoffer()
    Arrange: current は VP8、offerer は H264 だけの re-offer を適用中で、送信 track を差し替える。
    let replacement = new MediaStreamTrack({ kind: "video" })
    do a.getSenders()[0].replaceTrack(replacement)
    b createAnswer as=answer
    Act: H264 の remote pranswer を暫定適用してから rollback する。
    a setRemote answer type=pranswer
    expect replacement.codec?.name.toUpperCase() == "H264"
    a setLocal rollback
    Assert: 差し替えた track の codec も current の VP8 に戻る。
    expect replacement.codec?.name.toUpperCase() == "VP8"
  `,
  ]);

  negotiationCases(
    "m-line reuse during a pending negotiation (#721 / issue 705)",
    [
      `
    case: a local offer reuses a stopped m-line only for a transceiver of the same kind
    ref: 2.5-6 2.8-46; origin: develop #721 / issue 705
    given: createConnectedVideoPeers()
    Arrange: video を停止して port 0 まで交渉済みの session (index 0 が停止済み video)。
    do a.getTransceivers()[0].stop()
    a negotiate
    Act: audio を追加して offer を作る。
    let audio = a.addTransceiver("audio")
    a createOffer
    a setLocal
    Assert: 停止済み video の位置は audio に使わず、audio は新しい m-line に入る。
    let kinds = local(a).sdp.split("\\r\\n").filter((line) => line.startsWith("m=")).map((line) => line.split(" ")[0])
    expect kinds[0] == "m=video"
    expect audio.mLineIndex isnt 0
    b setRemote local(a)
    b answer
  `,
      `
    case: a transceiver added during a rolled-back offer does not keep the stopped m-line index
    ref: 2.1-T10 2.6-T2; origin: develop #721 / issue 705
    given: createConnectedVideoPeers({}, { withAudio: true })
    Arrange: audio を停止して port 0 まで交渉済みの session。
    let audio = a.getTransceivers().find((transceiver) => transceiver.kind === "audio")
    do audio.stop()
    a negotiate
    a createOffer
    a setLocal
    Act: pending 中に audio を追加し (停止済みの位置を引き継ぐ)、offer を rollback する。
    let added = a.addTransceiver("audio")
    a setLocal rollback
    Assert: 追加した transceiver は停止済み m-line の位置を持たず、再交渉で追加される。
    expect added.mLineIndex isnt audio.mLineIndex
    a negotiate
    expect Boolean(added.mid) is true
  `,
    ],
  );

  negotiationCases("SCTP MTU (#716)", [
    `
    case: an SCTP transport a remote offer creates uses the configured MTU
    ref: 2.6-T1a; origin: develop #716
    given: createPeerPair({}, { sctp: { mtu: 1052 } })
    Arrange: MTU を設定した answerer と DataChannel を持つ offerer。
    do a.createDataChannel("mtu")
    a createOffer
    a setLocal
    Act: remote offer を適用して SCTP transport を作らせる。
    b setRemote local(a)
    Assert: pending 中に作った SCTP transport も設定の MTU を使う。
    expect b.sctpTransport.sctp.mtu == 1052
  `,
    `
    case: the MTU is fixed while a remote offer's SCTP transport is pending and free again after rollback
    ref: 2.6-T1c; origin: develop #716
    given: createPeerPair()
    Arrange: DataChannel を含む remote offer を適用中の answerer。
    do a.createDataChannel("mtu")
    a createOffer
    a setLocal
    b setRemote local(a)
    Act / Assert: pending の SCTP transport があるので MTU は変えられない。
    expect b.setConfiguration({ sctp: { mtu: 1052 } }) rejects="sctp.mtu cannot be changed after SCTP transport creation"
    Act: remote offer を rollback する。
    b setRemote rollback
    Assert: 提案が作った SCTP transport は消え、MTU を変更できる。
    expect b.sctpTransport == undefined
    do b.setConfiguration({ sctp: { mtu: 1052 } })
    expect b.getConfiguration().sctp.mtu == 1052
  `,
  ]);
});
