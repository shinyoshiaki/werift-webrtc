import type { RTCPeerConnection } from "../../src";
import { negotiationCases } from "./negotiationCaseRunner";

/** The first host candidate of `sdp` moved to `port` (foundation suffix: the last digit of `port`). */
const hostCandidate = (sdp: string, port: number, ufrag?: string) => {
  const [, foundation, rest] = sdp.match(
    /^a=candidate:(\S+) (\d+ \S+ \d+ \S+) \d+ typ host/m,
  )!;
  const candidate = `candidate:${foundation}${port % 10} ${rest} ${port} typ host`;
  return ufrag ? `${candidate} ufrag ${ufrag}` : candidate;
};

negotiationCases(
  "negotiation transaction",
  [
    `
    case: rollback preserves application stop and a new trackless transceiver
    ref: 2.5-15
    given: createDuplexSession()
    Arrange: 音声を追加で交渉し、re-offer を b に pending で適用する。
    let audio = addNegotiatedAudio(session, session.a, session.b)
    let existing = audio.remote()
    let currentRemote = b.currentRemoteDescription.sdp
    a offer
    Act: pending 中にアプリが停止と track のない transceiver 追加を行い、rollback する。
    do existing.stop()
    let added = b.addTransceiver("audio", { direction: "recvonly" })
    b setRemote rollback
    Assert: SDP 由来の状態だけが戻り、アプリ操作 (stop / 追加) は残る。
    expect b.getTransceivers() containsAll [existing, added]
    expect added like { mid: null, sender: { track: null } }
    expect b.currentRemoteDescription.sdp == currentRemote
    Assert: stop() で解放した pipeline は rollback でも再開しない。
    expect existing like { stopping: true, receiver: { stopped: true, track: { readyState: "ended" } } }
    Assert: 停止していない video と DataChannel は両方向で通信を続ける。
    alive
  `,
    `
    case: a remote offer whose BUNDLE member is not an exact MID creates nothing
    ref: 2.8-20; origin: BUNDLE group validation
    given: createPeerPair()
    Arrange: BUNDLE group の MID に suffix を付けた初回 offer を作る。
    let events = recordNegotiationEvents(b)
    do a.addTransceiver("audio")
    a createOffer as=offer
    Act: その offer を remote description として適用する。拒否され状態は変わらない。
    b setRemote offer.sdp.replace(/^a=group:BUNDLE 0\\b/m, "a=group:BUNDLE 0_extra") rejects=OperationError
    Assert: transceiver も通知も作られず stable のまま。
    expect b.remoteDescription == null
    expect b.getTransceivers().length == 0
    expect events.remoteTransceivers == []
  `,
    `
    case: a replacement local offer whose transport preparation fails keeps the earlier pending offer
    ref: 2.9-9
    given: createDuplexSession()
    Arrange: audio を追加して交渉し、audio を BUNDLE から外す offer を pending にする (分割用の新 transport が準備される)。
    let audio = addNegotiatedAudio(session, session.a, session.b)
    a setLocal createSplitOffer(a, audio.mid)
    let prepared = a.negotiation.transportByMid.get(audio.mid)
    expect a.dtlsTransports lacks prepared
    let replacement = createSplitOffer(a, audio.mid)
    let gather = vi.spyOn(RTCIceTransport.prototype, "gather").mockRejectedValueOnce(new Error("gather failed"))
    Act: 新 transport の ICE gathering が失敗する replacement offer を適用する。失敗し、先行 pending offer と signaling state が残る。
    a setLocal replacement rejects="gather failed"
    do gather.mockRestore()
    Assert: 準備済み transport も残り、既存の通信は続く。
    expect a.negotiation.transportByMid.get(audio.mid) is prepared
    expect prepared.iceTransport.state != "closed"
    alive
    Act: 残った先行 offer に answer して commit する。
    b setRemote local(a)
    b answer
    do waitForDtlsConnected(audio.transceiver.dtlsTransport)
    do waitForDtlsConnected(audio.remote().dtlsTransport)
    Assert: 先行 offer の分割 transport で audio が届き、既存経路も続く。
    expect audio.transceiver.dtlsTransport is prepared
    rtp audio.out -> audio.remote().receiver.track
    alive
  `,
    `
    case: rollback keeps simulcast SSRCs learned $when
    ref: 2.4-1; origin: simulcast SSRC learning
    given: createSimulcastPeers()
    each: [
      { when: "during a pending re-offer" },
      { when: "after an unapplied createOffer in stable", createOfferFirst: true },
    ]
    Arrange: RID 付き packet で high/low の SSRC を受信側に学習させる。
    do sendLayer("low", 2222, "low-learned", { withRid: true })
    [createOfferFirst=true] b createOffer
    [createOfferFirst=true] invariants b
    a offer
    Act: pending 中に RID 付き packet で別 SSRC を学習し、両側で rollback する。
    do sendLayer("high", 1111, "high-learned", { withRid: true })
    a rollback
    Assert: RID なし (SSRC のみ) の packet が学習済みの各層へ届き続ける。
    do sendLayer("high", 1111, "high-after-rollback", { withRid: false })
    do sendLayer("low", 2222, "low-after-rollback", { withRid: false })
    expect b.signalingState == "stable"
  `,
    `
    case: rollback keeps a DataChannel created $when and the next negotiation opens it
    ref: 2.3-15 2.3-17 2.3-18
    given: createUnnegotiatedVideoPeers()
    each: [
      { when: "in have-local-offer", kind: "local-offer", creator: "a", peer: "b" },
      { when: "in have-remote-offer", kind: "remote-offer", creator: "b", peer: "a" },
      { when: "between createOffer and setting that older offer", kind: "stale-offer", creator: "a", peer: "b" },
    ]
    Arrange: m=application を含まない初回 offer で transaction を開き、その途中で DataChannel を作る。
    [kind=stale-offer] a createOffer
    [kind=stale-offer] let channel = a.createDataChannel("$kind")
    [kind=stale-offer] a setLocal
    [kind!=stale-offer] a offer hold
    [kind=remote-offer] b setRemote local(a)
    [kind!=stale-offer] let channel = $creator.createDataChannel("$kind")
    Act: application の createDataChannel を挟んだ transaction を rollback する。
    a rollback
    Assert: SCTP transport は止まらず、未交渉 (MID/remote port なし) で残る。
    expect $creator.signalingState == "stable"
    expect $creator.sctpTransport is channel.sctp
    expect channel.readyState == "connecting"
    Act: 作成側から改めて交渉する。
    [creator=b] do b.addTransceiver("video")
    let received = negotiateAndExpectChannel($creator, $peer, channel)
    Assert: channel が開いて両方向に届き、交渉済みの RTP も届く。
    data received -> channel
    [creator=a] rtp outgoing -> incoming()
  `,
    `
    case: an answer whose RTX has no associated codec is rejected before mutation
    ref: 2.5-4
    given: createConnectedVideoPeersWithRtx()
    Arrange: re-offer に対し、VP8 を落として RTX だけを残した answer を作る。
    a offer
    b answer hold
    Act: apt の指す codec がない answer を適用する。共通 codec のない非ゼロ port の answer は InvalidAccessError (issue 705 と同じ規則) で、pending offer・current は変わらない。
    a setRemote keepOnlyRtx(local(b).sdp) rejects=InvalidAccessError
    Assert: 事前検証で拒否され、RTP は変わらず届く。
    expect a.signalingState == "have-local-offer"
    rtp outgoing -> incoming
    Act: 正しい answer を適用する。
    a setRemote local(b)
    Assert: 交渉が完了し RTP も継続する。
    expect a.signalingState == "stable"
    rtp outgoing -> incoming
  `,
    `
    case: a remote offer that fails while applying leaves no partial state
    ref: 2.1-11 5-K3
    given: createConnectedVideoPeers()
    Arrange: 音声を足す re-offer を作り、受信側の RTP 適用を一度だけ失敗させる。
    do a.addTransceiver("audio", { direction: "sendonly" })
    a offer hold
    let count = b.getTransceivers().length
    do failOnce(negotiationInternals(b).transceiverManager, "setRemoteRTP")
    Act: 事前検証を通った後の適用中に例外が起きる。description と transceiver は変わらない。
    b setRemote local(a) rejects="injected apply failure"
    Assert: stable に戻り、作りかけの transceiver も transaction も残らない。
    expect b.signalingState == "stable"
    expect b.getTransceivers().length == count
    expect negotiationInternals(b).negotiation.inspect().phase == "idle"
    rtp outgoing -> incoming
    Act: 同じ offer を改めて適用し交渉を完了する。
    b setRemote local(a)
    b answer
    Assert: 両側 stable で音声 m-line が加わり、既存 RTP も届く。
    expect b.getTransceivers().length == count + 1
    rtp outgoing -> incoming
  `,
    `
    case: an answer that fails while applying returns to its pending offer
    ref: 2.1-11 2.1-T13
    given: createConnectedVideoPeers()
    Arrange: re-offer と answer を用意し、offer 側の RTP 適用を一度だけ失敗させる。
    a offer
    b answer hold
    do failOnce(negotiationInternals(a).transceiverManager, "setRemoteRTP")
    Act: answer の適用中に例外が起きる。pending offer のまま残る。
    a setRemote local(b) rejects="injected apply failure"
    Assert: transaction も pending に戻り、binding と current RTP は壊れない。
    expect a.signalingState == "have-local-offer"
    expect negotiationInternals(a).negotiation.inspect().phase == "pending"
    rtp outgoing -> incoming
    Act: 同じ answer を改めて適用する。
    a setRemote local(b)
    Assert: 交渉が完了し RTP も継続する。
    expect a.signalingState == "stable"
    rtp outgoing -> incoming
  `,
    `
    case: an ICE restart answer that fails while applying keeps the committed generation and pair
    ref: 2.1-11
    given: createConnectedVideoPeers()
    Arrange: 現在の ICE generation と選択済み pair を控え、ICE restart offer/answer を用意する。
    let transport = a.iceTransports[0]
    let ufrag = transport.connection.localUsername
    let pair = transport.getSelectedCandidatePair()
    let generation = a.iceGeneration
    a offer restart
    b answer hold
    do failOnce(negotiationInternals(a).transceiverManager, "setRemoteRTP")
    Act: restart answer の適用中に例外が起きる。
    a setRemote local(b) rejects="injected apply failure"
    Assert: restart は確定せず、generation・ufrag・選択済み pair が残り、RTP が届く。
    expect a.signalingState == "have-local-offer"
    expect a.iceGeneration == generation
    expect transport.connection.localUsername == ufrag
    expect transport.getSelectedCandidatePair() == pair
    rtp outgoing -> incoming
    Act: 同じ answer を改めて適用する。
    a setRemote local(b)
    do waitForCommittedNomination(a)
    Assert: 新しい generation に切り替わり、RTP も継続する。
    expect a.signalingState == "stable"
    expect a.iceGeneration == generation + 1
    expect transport.connection.localUsername != ufrag
    rtp outgoing -> incoming
  `,
    `
    case: a queued candidate that the answer cannot place rejects the answer before commit
    ref: 2.7-3; origin: candidate queue
    given: createUnnegotiatedVideoPeers()
    Arrange: 初回 offer/answer を作り、offerer に remote description より先に置き場所のない候補を積む。
    a offer
    b answer hold
    let answer = local(b)
    do a.addIceCandidate({ candidate: answer.sdp.match(/^a=(candidate:.*?)\\r?$/m)[1], sdpMid: "missing-mid" })
    Act: 置き場所のない候補が queue にある状態で answer を適用する。pending offer は残る。
    a setRemote answer rejects=OperationError
    Assert: answer は commit されず、transaction が残り、answer の ICE 資格情報も入らない。
    expect a.signalingState == "have-local-offer"
    expect a.remoteDescription == null
    expect negotiationInternals(a).negotiation.inspect().phase == "pending"
    expect a.iceTransports[0].connection.remoteUsername != answer.sdp.match(/^a=ice-ufrag:(.*?)\\r?$/m)[1]
    Act: 同じ answer を改めて適用する (拒否した候補は queue から外れている)。
    a setRemote answer
    Assert: 交渉が完了し、RTP が届く。
    expect a.signalingState == "stable"
    do Promise.all([waitForConnection(a), waitForConnection(b)])
    rtp outgoing -> incoming()
  `,
    `
    case: a trickle candidate of the unchanged ICE generation reaches the live checklist during a re-offer
    ref: origin: same-generation trickle during a re-offer
    given: createConnectedVideoPeers({}, { trickleOpen: true })
    Arrange: EOC 前の世代のまま ICE restart なしの re-offer を pending にし、同じ ufrag の新しい候補を作る。
    a offer hold
    b setRemote withoutEoc(local(a).sdp)
    let offer = local(a).sdp
    let candidate = { candidate: hostCandidate(offer, 40999), sdpMid: offer.match(/^a=mid:(.*?)\\r?$/m)[1], usernameFragment: ufragOf(offer) }
    expect liveCandidates(b, 40999) == 0
    Act: 同じ候補を 2 回 trickle する。
    b addCandidate candidate
    b addCandidate candidate
    Assert: pending と current の両 SDP に記録され、稼働中 checklist には 1 回だけ届く。
    expect b.pendingRemoteDescription.sdp contains " 40999 typ host"
    expect b.currentRemoteDescription.sdp contains " 40999 typ host"
    expect liveCandidates(b, 40999) == 1
    Act: re-offer を両側で rollback する。
    b rollback
    Assert: 同じ世代の候補は current に残り、既存 RTP も届く。
    expect b.currentRemoteDescription.sdp contains " 40999 typ host"
    expect liveCandidates(b, 40999) == 1
    rtp outgoing -> incoming
  `,
    `
    case: candidates in the body of a same-ufrag re-offer reach the live checklist before the answer
    ref: origin: same-generation candidates in an offer body
    given: createConnectedVideoPeers({}, { trickleOpen: true })
    Arrange: ICE restart なしの re-offer に、同じ ufrag の新しい候補を SDP 本文で足す (EOC なし)。
    a offer hold
    let withCandidate = withHostCandidate(withoutEoc(local(a).sdp), 40998)
    let connection = b.iceTransports[0].connection
    expect liveCandidates(b, 40998) == 0
    Act: 新しい候補を含む re-offer を適用する (answer はまだ返さない)。
    b setRemote withCandidate
    Assert: 候補は answer 前に稼働中 checklist と current SDP に 1 回だけ入る。
    expect liveCandidates(b, 40998) == 1
    expect b.currentRemoteDescription.sdp contains " 40998 typ host"
    expect connection.remoteCandidatesEnd == false
    Act: 同じ候補と EOC を含む置換 offer を適用する。
    b setRemote withCandidate.trimEnd() + "\\r\\na=end-of-candidates\\r\\n"
    Assert: 候補は重複せず、同じ世代の EOC も稼働中 generation に届く。
    expect liveCandidates(b, 40998) == 1
    expect connection.remoteCandidatesEnd == true
    Act: re-offer を両側で rollback する。
    b rollback
    Assert: 同じ世代の候補は current と checklist に残り、既存 RTP も届く。
    expect liveCandidates(b, 40998) == 1
    expect b.currentRemoteDescription.sdp contains " 40998 typ host"
    rtp outgoing -> incoming
  `,
    `
    case: end-of-candidates on a non-tag BUNDLE m-line completes the shared transport for every m-line
    ref: 2.8-28
    given: createConnectedVideoPeers({}, { trickleOpen: true, withAudio: true })
    Arrange: 映像 (tag) と音声 (非 tag) が一つの ICE transport を共有し、EOC 前の世代にある。
    let [tagMid, nonTagMid] = bundleMids(b.currentRemoteDescription.sdp)
    let connection = b.iceTransports[0].connection
    expect b.iceTransports.length == 1
    expect connection.remoteCandidatesEnd == false
    Act: 非 tag m-line に EOC を trickle する。
    b addCandidate { candidate: "", sdpMid: nonTagMid }
    Assert: 共有 transport が完了し、current SDP の両 m-line が完了扱いになる。
    expect connection.remoteCandidatesEnd == true
    expect eocCount(b.currentRemoteDescription.sdp) == 2
    Act: tag m-line の候補を本文に足した同じ ufrag の re-offer を適用する。
    a offer hold
    let withCandidate = withHostCandidate(withoutEoc(local(a).sdp), 40997)
    expect withCandidate.indexOf(" 40997 typ host") < withCandidate.indexOf("a=mid:" + nonTagMid)
    b setRemote withCandidate
    Assert: 完了済み transport の候補は current SDP にも checklist にも入らない。
    expect b.currentRemoteDescription.sdp lacks " 40997 typ host"
    expect liveCandidates(b, 40997) == 0
    Act: re-offer を両側で rollback する。
    b rollback
    Assert: current SDP は受け付けていない候補を含まず、既存 RTP が届く。
    expect b.currentRemoteDescription.sdp lacks " 40997 typ host"
    expect tagMid != nonTagMid
    rtp outgoing -> incoming
  `,
    `
    case: end-of-candidates trickled on a non-tag m-line during a same-ufrag re-offer stays aligned after $finish
    ref: 2.8-30
    given: createConnectedVideoPeers({}, { trickleOpen: true, withAudio: true })
    each: ANSWER_OR_ROLLBACK
    Arrange: EOC 前の世代のまま、ICE restart なしの re-offer を pending にする。
    a offer hold
    b setRemote withoutEoc(local(a).sdp)
    let nonTagMid = bundleMids(b.pendingRemoteDescription.sdp)[1]
    let connection = b.iceTransports[0].connection
    Act: pending 中に非 tag m-line へ EOC を trickle する。
    b addCandidate { candidate: "", sdpMid: nonTagMid }
    Assert: 共有 transport が完了し、pending と current の両 SDP で 2 m-line とも完了扱い。
    expect connection.remoteCandidatesEnd == true
    expect eocCount(b.pendingRemoteDescription.sdp) == 2
    expect eocCount(b.currentRemoteDescription.sdp) == 2
    Act: answer で確定する、または rollback する。
    b finish $finish
    Assert: 確定した SDP と live transport の EOC 状態が一致し、RTP が届く。
    expect b.signalingState == "stable"
    expect connection.remoteCandidatesEnd == true
    expect eocCount(b.currentRemoteDescription.sdp) == 2
    rtp outgoing -> incoming
  `,
    `
    case: end-of-candidates in the body of a non-tag m-line of a same-ufrag re-offer ends the shared generation after $finish
    ref: 2.8-30
    given: createConnectedVideoPeers({}, { trickleOpen: true, withAudio: true })
    each: ANSWER_OR_ROLLBACK
    Arrange: 非 tag m-line の本文だけに EOC を載せた同じ ufrag の re-offer を作る。
    a offer hold
    let stripped = withoutEoc(local(a).sdp)
    let offer = mungeSection(stripped, bundleMids(stripped)[1], (section) => section.trimEnd() + "\\r\\na=end-of-candidates\\r\\n")
    let connection = b.iceTransports[0].connection
    expect eocCount(offer) == 1
    expect connection.remoteCandidatesEnd == false
    Act: re-offer を適用する (answer はまだ返さない)。
    b setRemote offer
    Assert: 共有 transport が完了し、current と pending の両 SDP で 2 m-line とも完了扱い。
    expect connection.remoteCandidatesEnd == true
    expect eocCount(b.currentRemoteDescription.sdp) == 2
    expect eocCount(b.pendingRemoteDescription.sdp) == 2
    Act: answer で確定する、または rollback する。
    b finish $finish
    Assert: 確定した SDP と live transport の EOC 状態が一致し、RTP が届く。
    expect b.signalingState == "stable"
    expect connection.remoteCandidatesEnd == true
    expect eocCount(b.currentRemoteDescription.sdp) == 2
    rtp outgoing -> incoming
  `,
    `
    case: a queued candidate the remote offer cannot place rejects it before any application event
    ref: origin: candidate queue
    given: createUnnegotiatedVideoPeers()
    Arrange: answerer に remote description より先に置き場所のない候補を積み、通知を数える。
    a offer hold
    let offer = local(a)
    do b.addIceCandidate({ candidate: offer.sdp.match(/^a=(candidate:.*?)\\r?$/m)[1], sdpMid: "missing-mid" })
    let onTransceiver = vi.fn()
    let onTrack = vi.fn()
    do b.onRemoteTransceiverAdded.subscribe(onTransceiver)
    do b.onTrack.subscribe(onTrack)
    Act: その状態で remote offer を適用する。拒否され状態は変わらない。
    b setRemote offer rejects=OperationError
    Assert: transceiver/track の通知は一度も出ない。
    expect b.signalingState == "stable"
    expect b.remoteDescription == null
    expect b.getTransceivers().length == 0
    expect onTransceiver.mock.calls.length == 0
    expect onTrack.mock.calls.length == 0
    Act: 同じ offer を改めて適用し交渉を完了する (拒否した候補は queue から外れている)。
    b setRemote offer
    b answer
    Assert: 通知は成立した交渉の分だけ 1 回ずつ出て、RTP が届く。
    expect onTransceiver.mock.calls.length == 1
    expect onTrack.mock.calls.length == 1
    do Promise.all([waitForConnection(a), waitForConnection(b)])
    rtp outgoing -> incoming()
  `,
    `
    case: createOffer called while setLocalDescription is running does not invalidate that offer
    ref: origin: operations chain
    given: createConnectedVideoPeers()
    Arrange: re-offer A を作る。
    a createOffer as=offerA
    Act: setLocalDescription(A) の完了を待たずに次の createOffer を呼ぶ。
    let [applied, offerB] = Promise.all([a.setLocalDescription(offerA), a.createOffer()])
    Assert: 先行した A はそのまま適用され、B は A の後に作られる。
    expect a.signalingState == "have-local-offer"
    expect a.pendingLocalDescription.sdp == offerA.sdp
    invariants a
    Act: 後続の B を置換 offer として適用し、answer で確定する。
    a setLocal offerB
    b setRemote local(a)
    b answer
    Assert: 交渉が完了し、RTP も届く。
    expect a.signalingState == "stable"
    rtp outgoing -> incoming
  `,
    `
    case: createAnswer called while setRemoteDescription is running answers that offer
    ref: origin: operations chain
    given: createConnectedVideoPeers()
    Arrange: re-offer を適用する。
    a offer hold
    Act: setRemoteDescription(offer) の完了を待たずに createAnswer を呼ぶ。
    let [applied, answer] = Promise.all([b.setRemoteDescription(local(a)), b.createAnswer()])
    Assert: answer は適用後の offer に対して作られ、そのまま確定できる。
    expect b.signalingState == "have-remote-offer"
    b setLocal answer
    a setRemote local(b)
    expect a.signalingState == "stable"
    expect b.signalingState == "stable"
    rtp outgoing -> incoming
  `,
    `
    case: a candidate's ufrag in the candidate string routes it to the same generation as the usernameFragment property
    ref: 2.3-22
    given: createConnectedVideoPeers({}, { trickleOpen: true })
    Arrange: ICE restart re-offer で current (旧) と pending (新) の ufrag を併存させる。
    let oldUfrag = ufragOf(b.currentRemoteDescription.sdp)
    a offer restart
    let newUfrag = ufragOf(b.pendingRemoteDescription.sdp)
    expect newUfrag != oldUfrag
    let current = b.currentRemoteDescription.sdp
    let mid = current.match(/^a=mid:(.*?)\\r?$/m)[1]
    Act: 旧 ufrag を候補文字列だけに含める形と、プロパティでも渡す形で追加する。
    b addCandidate { candidate: hostCandidate(current, 40991, oldUfrag), sdpMid: mid }
    b addCandidate { candidate: hostCandidate(current, 40992, oldUfrag), sdpMid: mid, usernameFragment: oldUfrag }
    Assert: どちらも旧世代として current SDP と稼働中 checklist に入り、pending SDP には入らない。
    expect b.currentRemoteDescription.sdp contains " 40991 typ host"
    expect b.pendingRemoteDescription.sdp lacks " 40991 typ host"
    expect liveCandidates(b, 40991) > 0
    expect b.currentRemoteDescription.sdp contains " 40992 typ host"
    expect b.pendingRemoteDescription.sdp lacks " 40992 typ host"
    expect liveCandidates(b, 40992) > 0
    Act: 候補文字列とプロパティで ufrag が食い違う候補を追加する。拒否され状態は変わらない。
    b addCandidate { candidate: hostCandidate(current, 40993, oldUfrag), sdpMid: mid, usernameFragment: newUfrag } rejects=OperationError
    Assert: 食い違う候補はどの世代にも記録されない。
    expect b.currentRemoteDescription.sdp lacks " 40993 typ host"
    expect b.pendingRemoteDescription.sdp lacks " 40993 typ host"
    expect liveCandidates(b, 40993) == 0
    Act: re-offer を両側で rollback する。
    b rollback
    Assert: 旧世代の候補は current に残り、既存 RTP が届く。
    expect b.currentRemoteDescription.sdp contains " 40991 typ host"
    rtp outgoing -> incoming
  `,
    `
    case: during a partial BUNDLE split re-offer a candidate follows the ufrag of the m-line it targets
    ref: origin: partial BUNDLE split trickle
    given: createDuplexSession()
    Arrange: audio を追加し、audio だけを BUNDLE から外す re-offer を b に適用する。新世代の audio 候補はまだ trickle 中 (audio section に EOC なし) として渡す。
    let audio = addNegotiatedAudio(session, session.a, session.b)
    a setLocal createSplitOffer(a, audio.mid)
    b setRemote mungeSection(a.pendingLocalDescription.sdp, audio.mid, (section) => section.replace(/a=end-of-candidates\\r\\n/g, ""))
    let current = () => b.currentRemoteDescription.sdp
    let pending = () => b.pendingRemoteDescription.sdp
    let oldAudioUfrag = ufragOf(sectionOf(current(), audio.mid))
    let newAudioUfrag = ufragOf(sectionOf(pending(), audio.mid))
    Arrange: audio だけが新しい ufrag になり、video は旧 ufrag のまま。
    expect newAudioUfrag != oldAudioUfrag
    expect ufragOf(sectionOf(pending(), bVideo.mid)) == ufragOf(sectionOf(current(), bVideo.mid))
    Act: 旧世代と新世代の audio 候補を追加する。
    b addCandidate { candidate: hostCandidate(current(), 40981, oldAudioUfrag), sdpMid: audio.mid }
    b addCandidate { candidate: hostCandidate(current(), 40982, newAudioUfrag), sdpMid: audio.mid }
    Assert: 旧世代は end-of-candidates で完了済みなので current にも pending にも入らず (RFC 8838)、新世代は pending の audio にだけ記録される。
    expect sectionOf(current(), audio.mid) contains "a=end-of-candidates"
    expect sectionOf(current(), audio.mid) lacks " 40981 typ host"
    expect sectionOf(pending(), audio.mid) lacks " 40981 typ host"
    expect sectionOf(pending(), audio.mid) contains " 40982 typ host"
    expect sectionOf(current(), audio.mid) lacks " 40982 typ host"
    Act: re-offer を両側で rollback する。
    b rollback
    Assert: current は元のまま (新世代の候補も残らず)、映像・DataChannel も通信を続ける。
    expect sectionOf(current(), audio.mid) lacks " 40982 typ host"
    alive
  `,
    `
    case: an answer leaves the MID of a rejected m-line out of its BUNDLE group
    ref: 2.5-14
    given: createDuplexSession()
    Arrange: 音声を追加で交渉し、b がその transceiver を stop する。
    let audio = addNegotiatedAudio(session, session.a, session.b)
    do audio.remote().stop()
    Act: a から再交渉する。answerer の stop() は inactive で答えるだけなので、b は自分の次の offer で port 0 を交渉し、a はその m-line を拒否した answer を返す。
    a negotiate
    b negotiate
    Assert: answer の音声 m-line は port 0 で BUNDLE group に含まれない。
    let answer = a.currentLocalDescription.sdp
    expect sectionOf(answer, audio.mid) matches /^m=audio 0 /
    expect bundleMids(answer) lacks audio.mid
    expect bundleMids(answer) contains aVideo.mid
    Assert: 両側で停止が確定する。
    expect audio.remote().stopped == true
    Assert: BUNDLE に残る映像と DataChannel は両方向で通信を続ける。
    alive
  `,
    `
    case: rollback and close drop the transaction's references to closed or unused objects
    ref: origin: transaction references
    given: createUnnegotiatedVideoPeers()
    exempt: a is closed to check what close releases
    Arrange: 初回 offer を適用し、DataChannel 用の transport も作らせる。
    let internals = negotiationInternals(a)
    a offer hold
    do a.createDataChannel("references")
    a createOffer
    Act: rollback する。
    a setLocal rollback
    Assert: 停止した transport への参照は残らない。
    let afterRollback = internals.negotiation.inspect()
    expect afterRollback.phase == "idle"
    expect afterRollback.createdTransports.filter((t) => t.state === "closed") == []
    Act: offer を作ったまま close する。
    a createOffer
    a close
    Assert: transport と offer snapshot の参照をすべて手放す。
    let afterClose = internals.negotiation.inspect()
    expect afterClose.createdTransports == []
    expect afterClose.hasOfferSnapshot == false
  `,
    `
    case: a pending payload type leaves the receiver codec table by rollback
    ref: 2.4-1 2.4-3 5-13
    given: createConnectedVideoPeers({ codecs: { video: [useVP8(), useH264()] } })
    Arrange: 受信側の codec/RTX 対応表を控え、H264 を新しい PT 120 で提案する re-offer を用意する (current の PT の割当ては変えない)。
    let receiver = b.getTransceivers()[0].receiver
    let baseline = receiver.snapshotReceiveTables()
    let committedPt = Number(Object.entries(baseline.codecs).find((entry) => entry[1].mimeType === "video/VP8")[0])
    a offer hold
    let h264Pt = Number(local(a).sdp.match(/^a=rtpmap:(\\d+) H264\\/90000/im)[1])
    Act: 新 PT を含む remote offer を pending として適用する。
    b setRemote movePayloadType(local(a).sdp, h264Pt, 120)
    Assert: pending 中は新 PT が加わるが既存 PT の解釈は変わらず、旧 RTP が届く。
    let pending = receiver.snapshotReceiveTables()
    expect pending.codecs[120].mimeType.toLowerCase() == "video/h264"
    expect pending.codecs[committedPt] == baseline.codecs[committedPt]
    rtp outgoing -> incoming
    Act: 双方の pending description を rollback する。
    a rollback
    Assert: codec/RTX 対応表は baseline と完全に一致し、旧 RTP が届く。
    expect receiver.snapshotReceiveTables() == baseline
    rtp outgoing -> incoming
  `,
    `
    case: ICE restart pranswer connects a pending generation and rollback keeps current RTP
    ref: 2.2-3 2.7-T2
    given: createConnectedVideoPeers()
    Arrange: 現行 pair と ICE generation を記録する。
    let oldOffererTransport = a.iceTransports[0]
    let oldAnswererTransport = b.iceTransports[0]
    let oldPair = oldOffererTransport.getSelectedCandidatePair()
    let oldDtls = a.dtlsTransports[0]
    let currentRemote = b.currentRemoteDescription.sdp
    Act: restart offer と pranswer で新しい ICE generation の checks を進める。
    a offer restart
    b pranswer
    do Promise.all([waitForProvisionalNomination(a), waitForProvisionalNomination(b)])
    Assert: ICE restart は DTLS association を作り直さず、旧 pair で RTP が続く。
    expect a.dtlsTransports == [oldDtls]
    expect oldOffererTransport.getSelectedCandidatePair() == oldPair
    rtp outgoing -> incoming
    Act: 双方の pending description を破棄する。
    a rollback
    Assert: 旧 pair と SDP に戻り、RTP が実際に届く。
    expect a.iceTransports[0] is oldOffererTransport
    expect b.iceTransports[0] is oldAnswererTransport
    expect oldOffererTransport.getSelectedCandidatePair() == oldPair
    expect b.currentRemoteDescription.sdp == currentRemote
    rtp outgoing -> incoming
  `,
    `
    case: ICE restart pranswer over a connected SCTP association checks the new generation, then $outcome
    ref: 2.1-3 2.1-5 2.1-T4 2.1-T8 2.2-6 2.2-16 2.3-16 2.7-T3 2.7-T4b
    given: createConnectedMediaAndDataPeers()
    each: [{ outcome: "answer" }, { outcome: "rollback" }]
    Arrange: 現行 generation の selected pair と SCTP transport を控える。
    let offererIce = a.iceTransports[0]
    let answererIce = b.iceTransports[0]
    let offererPair = offererIce.connection.nominated
    let answererPair = answererIce.connection.nominated
    let sctpTransport = b.sctpTransport.dtlsTransport
    let currentRemote = b.currentRemoteDescription.sdp
    Act: 確立済み SCTP を保つ restart offer に pranswer を返す。
    a offer restart
    b pranswer as=answer
    let [offererConnection] = waitForProvisionalNomination(a)
    let [answererConnection] = waitForProvisionalNomination(b)
    Assert: pending generation は pranswer の資格情報で nominate され、current の pair・SDP・association はそのまま通信を続ける。
    let offerUfrag = ufragOf(local(a).sdp)
    let answerUfrag = ufragOf(local(b).sdp)
    expect offererConnection.provisionalNominated != undefined
    expect offererIce.connection.nominated is offererPair
    expect answererIce.connection.nominated is answererPair
    expect offererIce.connection.remoteUsername != answerUfrag
    expect answererIce.connection.remoteUsername != offerUfrag
    expect answererConnection.provisionalNominated != undefined
    expect b.sctpTransport.dtlsTransport is sctpTransport
    expect b.currentRemoteDescription.sdp == currentRemote
    rtp outgoing -> incoming
    data channel -> received
    [outcome=answer] Act: final answer で pending generation を commit する。
    [outcome=answer] b setLocal answer
    [outcome=answer] a setRemote local(b)
    [outcome=answer] do Promise.all([waitForIce(a), waitForIce(b)])
    [outcome=answer] Assert: 双方の live generation が SDP と一致し、SCTP は移動しない。
    [outcome=answer] expect offererIce.getRemoteParameters()?.usernameFragment == answerUfrag
    [outcome=answer] expect answererIce.getRemoteParameters()?.usernameFragment == offerUfrag
    [outcome=answer] expect answererIce.localParameters.usernameFragment == answerUfrag
    [outcome=rollback] Act: 双方の pending description を rollback する。
    [outcome=rollback] a rollback
    [outcome=rollback] Assert: provisional generation は破棄され、current pair が残る。
    [outcome=rollback] expect offererIce.connection?.provisionalNominated == undefined
    [outcome=rollback] expect answererIce.connection?.provisionalNominated == undefined
    [outcome=rollback] expect offererIce.connection.nominated is offererPair
    [outcome=rollback] expect answererIce.connection.nominated is answererPair
    [outcome=rollback] expect b.currentRemoteDescription.sdp == currentRemote
    Assert: commit/rollback 後も同じ association で RTP と DataChannel が届く。
    expect b.sctpTransport.dtlsTransport is sctpTransport
    rtp outgoing -> incoming
    data channel -> received
    data received -> channel
  `,
    `
    case: rollback removes remote-only objects and a repeated offer does not duplicate events
    ref: 2.1-7 2.1-10 2.1-T1 2.2-2 2.3-1 2.3-3 2.3-4 2.3-6 2.3-8 2.3-21 2.3-23 5-4
    given: createPeerPair()
    Arrange: remote offer が初回の transceiver を生成する。
    let onTrack = vi.fn()
    let onRemoteTransceiver = vi.fn()
    do b.onTrack.subscribe(onTrack)
    do b.onRemoteTransceiverAdded.subscribe(onRemoteTransceiver)
    do a.addTransceiver("audio")
    a createOffer as=offer
    Act: 同じ offer を再適用してから rollback する。
    b setRemote offer
    b setRemote offer
    Assert: 同じ receiver と transceiver への通知は一度だけ。
    expect onRemoteTransceiver.mock.calls.length == 1
    expect onTrack.mock.calls.length == 1
    let oldTransceiver = b.getTransceivers()[0]
    b setRemote rollback
    expect b.getTransceivers().length == 0
    expect oldTransceiver.stopped == true
    Act: rollback 後の新しい offer は新しい object を作る。
    b setRemote offer
    Assert: 新しい receiver 遷移に対する通知だけが追加される。
    expect onRemoteTransceiver.mock.calls.length == 2
    expect onTrack.mock.calls.length == 2
    expect b.getTransceivers()[0] isnt oldTransceiver
  `,
    `
    case: rollback keeps a remote-created transceiver that received a local track
    ref: 2.3-5 2.3-7 2.8-36
    given: createPeerPair()
    Arrange: remote offer で作成された transceiver に application が送信 track を付ける。
    let localTrack = new MediaStreamTrack({ kind: "audio" })
    do a.addTransceiver("audio", { direction: "sendonly" })
    a createOffer as=offer
    b setRemote offer
    let transceiver = b.getTransceivers()[0]
    do b.addTrack(localTrack)
    Act: remote offer を取り消す。
    b setRemote rollback
    Assert: application 所有の sender/track は残り、旧 m-line との関連だけ外れる。
    expect b.getTransceivers() contains transceiver
    expect transceiver.sender.track is localTrack
    expect transceiver.mid == null
    expect transceiver?.mLineIndex == undefined
  `,
    `
    case: rollback removes provisional receiver SSRC mappings on an existing track
    ref: 2.3-2 2.4-3 2.4-T6
    given: createConnectedVideoPeers()
    Arrange: 既存 m-line に別 SSRC を提案する re-offer を作る。
    let receiver = b.getTransceivers()[0].receiver
    let originalTracks = [...receiver.tracks]
    let originalSsrc = a.getTransceivers()[0].sender.ssrc
    let provisionalSsrc = originalSsrc + 1
    a createOffer as=offer
    Act: 追加 SSRC を一時登録してから offer を取り消す。
    b setRemote offer.sdp.replaceAll(String(originalSsrc), String(provisionalSsrc))
    expect receiver.trackBySSRC[provisionalSsrc] isnt undefined
    b setRemote rollback
    Assert: receiver の object は維持し、追加 track と SSRC 経路を除去する。
    expect receiver.tracks == originalTracks
    expect Object.keys(receiver.trackBySSRC) lacks String(provisionalSsrc)
    rtp outgoing -> incoming
  `,
    `
    case: setLocalDescription accepts only the last created offer
    ref: 2.9-4 2.9-T10 2.9-T11
    given: createPeerPair()
    Arrange: offer を 2 回作り、1 回目の offer と書き換えた最新 offer を用意する。
    do a.addTransceiver("audio")
    a createOffer as=older
    a createOffer as=latest
    expect older.sdp != latest.sdp
    Act: 最新ではない / 書き換えた local offer を適用する。W3C どおり InvalidModificationError で拒否し、状態は変えない。
    a setLocal older rejects=InvalidModificationError
    a setLocal latest.sdp.replace("a=sendrecv", "a=recvonly") rejects=InvalidModificationError
    a setLocal latest.sdp.replace(/a=ice-ufrag:[^\\r\\n]+/, "a=ice-ufrag:wronggeneration") rejects=InvalidModificationError
    Assert: stable のまま pending offer はない。
    expect a.signalingState == "stable"
    expect a.pendingLocalDescription == null
    Act: 最新の offer を適用する。
    a setLocal latest
    Assert: 最新 offer だけが pending になる。
    expect a.signalingState == "have-local-offer"
    expect a.pendingLocalDescription.sdp contains "a=sendrecv"
  `,
    `
    case: an offer created by another peer is rejected by $peer
    ref: 2.9-4
    given: createUnnegotiatedVideoPeers()
    each: [
      { peer: "a peer that never created an offer", connected: false },
      { peer: "a connected peer whose own offers were already applied", connected: true },
    ]
    Arrange: offer を作る側と、それを自分の offer として渡される側を用意する。connected なら接続し、answerer 自身も一度 offer を作って適用し、交渉を完了させておく。
    [connected=true] a negotiate
    [connected=true] do Promise.all([waitForIce(a), waitForIce(b), waitForConnection(a), waitForConnection(b)])
    [connected=true] b negotiate
    a createOffer as=foreignOffer
    let phase = negotiationInternals(b).negotiation.inspect().phase
    Act: 他の peer が作った offer を setLocalDescription に渡す。拒否され、signaling state・pending/current description は変わらない。
    b setLocal foreignOffer rejects=InvalidModificationError
    Assert: pending local はなく transaction も変わらない。
    expect b.pendingLocalDescription == null
    expect negotiationInternals(b).negotiation.inspect().phase == phase
    Act: 自分で作った offer なら適用できる。
    b createOffer
    b setLocal
    Assert: 自身の offer で have-local-offer に進む。
    expect b.signalingState == "have-local-offer"
  `,
    `
    case: an unsupported offered codec rejects only its m-line
    ref: origin: codec intersection per m-line
    exempt: the peers share no audio codec, so the audio transceiver the continuation adds cannot carry RTP
    given: createPeerPair(
      { codecs: { audio: [new RTCRtpCodecParameters({ mimeType: "audio/PCMU", clockRate: 8000, channels: 1 })] } },
      { codecs: { audio: [new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2 })] } },
    )
    Arrange: codec の共通集合がない audio offer を作る。
    let onTrack = vi.fn()
    do b.onTrack.subscribe(onTrack)
    do a.addTransceiver("audio")
    a offer
    Act: remote offer を受け、answer を適用する。
    b createAnswer
    b setLocal
    Assert: m-line 単位で拒否し、track event を送らない。
    expect b.currentLocalDescription.sdp matches /m=audio 0 /
    expect onTrack.mock.calls.length == 0
  `,
    `
    case: initial pranswer starts provisional DataChannel traffic and rollback closes it
    ref: 2.1-T4 2.2-4 2.2-5 2.2-16 2.2-17 2.3-13 2.3-14 2.3-16
    given: createPeerPair()
    Arrange: application m-line を持つ初回 offer を適用する。
    let localChannel = a.createDataChannel("provisional")
    let events = recordNegotiationEvents(b)
    a offer
    Act: final answer を待たずに pranswer で接続する。
    b pranswer as=answer
    waitFor localChannel.readyState === "open" timeout=5000
    Assert: stable/current は空のままで provisional channel が公開される。
    expect localChannel.readyState == "open"
    expect events.dataChannels.at(-1)?.label == "provisional"
    expect a.currentRemoteDescription == null
    expect b.currentLocalDescription == null
    Act: provisional negotiation を rollback する。
    a rollback
    Assert: current は空で pending-only association の channel は閉じる。
    expect localChannel.readyState == "closed"
    expect a.currentLocalDescription == null
    expect a.iceTransports[0].connection.remoteUsername != ufragOf(answer.sdp)
  `,
    `
    case: initial pranswer carries provisional RTP before final commit
    ref: 2.1-T1 2.2-1 2.2-2 2.3-1 2.3-3 2.3-6 2.7-3 5-3
    given: createPeerPair()
    Arrange: video の初回 offer を受け、receiver を pending に生成する。
    let outgoing = new MediaStreamTrack({ kind: "video" })
    let events = recordNegotiationEvents(b)
    do a.addTransceiver(outgoing, { direction: "sendonly" })
    a offer
    Act: 双方の pranswer だけで ICE/DTLS と RTP を開始する。
    b pranswer as=answer
    do Promise.all([waitForConnection(a), waitForConnection(b)])
    expect events.tracks.length > 0
    rtp outgoing -> events.tracks[0].track
    Act / Assert: 接続済み provisional DTLS の証明書差替えは拒否する。
    a setRemote answer.sdp.replace(/a=fingerprint:sha-256 [^\\r\\n]+/, "a=fingerprint:sha-256 " + Array(32).fill("00").join(":")) type=answer rejects=InvalidModificationError
    Assert: current description は空のまま通信し、rollback で仮 transceiver を除外する。
    expect b.currentRemoteDescription == null
    expect a.currentLocalDescription == null
    a rollback
    expect b.getTransceivers().length == 0
  `,
    `
    case: re-offer pranswer carries new RTP alongside the committed stream
    ref: 2.1-3 2.2-1 2.2-5 2.2-6 2.2-7
    given: createConnectedVideoPeers()
    Arrange: 接続済み video に新しい audio m-line を加える。
    let provisionalAudio = new MediaStreamTrack({ kind: "audio" })
    let events = recordNegotiationEvents(b)
    let currentRemote = b.currentRemoteDescription.sdp
    let selectedPair = b.iceTransports[0].getSelectedCandidatePair()
    do a.addTransceiver(provisionalAudio, { direction: "sendonly" })
    a offer
    Act: pranswer 中に新 audio と旧 video の RTP を両方送る。
    b pranswer
    let receivedAudio = events.tracks.find((e) => e.track.kind === "audio").track
    rtp provisionalAudio -> receivedAudio
    rtp outgoing -> incoming
    Assert: current の SDP と ICE pair は pranswer では入れ替わらない。
    expect b.currentRemoteDescription.sdp == currentRemote
    expect b.iceTransports[0].getSelectedCandidatePair() == selectedPair
    Act: rollback で新 audio を外し、旧 video は送り続ける。
    a rollback
    rtp outgoing -> incoming
    Assert: 接続中の current 経路と description が維持される。
    expect b.currentRemoteDescription.sdp == currentRemote
    expect b.iceTransports[0].getSelectedCandidatePair() == selectedPair
  `,
    `
    case: a final answer can replace provisional SCTP limits without another channel event
    ref: 2.2-5 2.2-12 2.2-15 2.3-18 5-4
    given: createPeerPair()
    Arrange: application offer と provisional answer を作る。
    let channel = a.createDataChannel("limits")
    let onDataChannel = vi.fn()
    do b.onDataChannel.subscribe(onDataChannel)
    a offer
    b createAnswer as=answer
    let maxMessageSize = (size) => answer.sdp.replace(/a=max-message-size:[^\\r\\n]+/, "a=max-message-size:" + size)
    b setLocal maxMessageSize(4096) type=pranswer
    a setRemote local(b)
    waitFor channel.readyState === "open" timeout=5000
    Act: provisional answer を置換しても既存 channel object を再通知しない。
    b setLocal maxMessageSize(3072) type=pranswer
    a setRemote local(b)
    expect a.currentRemoteDescription == null
    expect channel.readyState == "open"
    Act: 最終 answer では別の max-message-size を採用する。
    b setLocal maxMessageSize(2048) type=answer
    a setRemote local(b)
    Assert: final SDP と association の上限が一致し、channel は再通知されない。
    expect a.sctpTransport.remoteMaxMessageSize == 2048
    expect channel.readyState == "open"
    expect onDataChannel.mock.calls.length == 1
  `,
    `
    case: duplicate trickle candidate and EOC are idempotent within one generation
    ref: 2.1-10 2.3-21
    given: createPeerPair()
    Arrange: gathered candidate と EOC を含む offer を適用する。
    do a.addTransceiver("audio")
    a offer
    let sdp = b.remoteDescription.sdp
    let mid = sdp.match(/a=mid:([^\\r\\n]+)/)[1]
    let candidate = { candidate: sdp.match(/a=(candidate:[^\\r\\n]+)/)[1], sdpMid: mid, usernameFragment: ufragOf(sdp) }
    let eoc = { candidate: "", sdpMid: mid, usernameFragment: ufragOf(sdp) }
    let beforeCount = b.iceTransports[0].getRemoteCandidates().length
    Act: 同じ candidate と EOC を二度ずつ trickle する。
    b addCandidate candidate
    b addCandidate candidate
    b addCandidate eoc
    b addCandidate eoc
    Assert: description と ICE checklist に重複しない。
    expect b.remoteDescription.sdp == sdp
    expect b.iceTransports[0].getRemoteCandidates().length == beforeCount
  `,
    `
    case: both peers commit matching local and remote ICE restart generations
    ref: 2.1-T7 2.2-3 2.2-6 2.7-T1 2.7-T3 2.7-T4a 5-K6
    given: createConnectedVideoPeers()
    Arrange: current nomination と generation を控える。
    let oldGeneration = a.iceGeneration
    let oldPair = a.iceTransports[0].getSelectedCandidatePair()
    let oldDtls = a.dtlsTransports[0]
    Act: local restart offer は pending に置き、旧 nomination を維持する。
    a createOffer restart as=offer
    let offeredUfrag = ufragOf(offer.sdp)
    expect a.iceGeneration == oldGeneration
    a setLocal
    expect a.iceTransports[0].getSelectedCandidatePair() == oldPair
    rtp outgoing -> incoming
    Act: remote peer も新 generation を answer し、双方で確定する。
    b setRemote local(a)
    b createAnswer as=answer
    let answeredUfrag = ufragOf(answer.sdp)
    b setLocal answer type=pranswer
    a setRemote local(b)
    Assert: pranswer だけで新しい ICE generation が provisional に nominate される。
    do Promise.all([waitForProvisionalNomination(a), waitForProvisionalNomination(b)])
    Assert: pranswer 中は旧 nomination で RTP が続き、current は旧 SDP のまま。
    expect a.iceTransports[0].getSelectedCandidatePair() == oldPair
    expect a.iceGeneration == oldGeneration
    rtp outgoing -> incoming
    Act: 最終 answer で新 generation へ切り替える。
    b setLocal answer
    a setRemote local(b)
    do Promise.all([waitForIce(a), waitForIce(b), waitForConnection(a), waitForConnection(b)])
    Assert: answer SDP、transport credentials と新 nomination が一致し、DTLS association は restart 前のものを使い続ける。
    expect a.dtlsTransports == [oldDtls]
    expect a.iceGeneration > oldGeneration
    expect a.iceTransports[0].localParameters.usernameFragment == offeredUfrag
    expect b.iceTransports[0].localParameters.usernameFragment == answeredUfrag
    expect a.iceTransports[0].getSelectedCandidatePair() != null
    rtp outgoing -> incoming
  `,
    `
    case: local ICE restart rollback retains the committed selected pair
    ref: 2.1-7 2.1-T8 2.3-9 2.3-11 5-4
    given: createConnectedVideoPeers()
    Arrange: live ICE generation と選択済み pair を控える。
    let transport = a.iceTransports[0]
    let ufrag = transport.localParameters.usernameFragment
    let pair = transport.getSelectedCandidatePair()
    let generation = a.iceGeneration
    let events = recordNegotiationEvents(a)
    let candidateUfrags = () => events.candidates.map((c) => c?.toJSON().usernameFragment)
    Act: restart offer を pending にしてから rollback する。
    a createOffer restart as=restartOffer
    a setLocal restartOffer
    let emitted = events.candidates.length
    a setLocal restartOffer
    rtp outgoing -> incoming
    a setLocal rollback
    Assert: current generation と実通信経路が変わらない。
    expect emitted > 1
    expect events.candidates.length == emitted
    Assert: restart の generation は commit 後に STUN から集め直すので、offer では EOC を出さない。
    expect candidateUfrags() lacks undefined
    expect candidateUfrags() lacks ufrag
    expect transport.localParameters.usernameFragment == ufrag
    expect transport.getSelectedCandidatePair() == pair
    expect a.iceGeneration == generation
    rtp outgoing -> incoming
  `,
    `
    case: partial BUNDLE keeps an unbundled media transport independent
    ref: origin: partial BUNDLE (RFC 8843 7.3.2)
    given: createPeerPair()
    Arrange: audio/application は BUNDLE、video は独立する offer を offerer 自身が出す (offer で共有した transport を answer だけが分割することはできない: RFC 8843 7.3.2)。
    let video = new MediaStreamTrack({ kind: "video" })
    let events = recordNegotiationEvents(b)
    do a.addTransceiver("audio")
    do a.addTransceiver(video, { direction: "sendonly" })
    do a.createDataChannel("bundle")
    a createOffer as=probe
    let mids = [...probe.sdp.matchAll(/a=mid:([^\\r\\n]+)/g)].map((m) => m[1])
    a setLocal createRewrittenOffer(a, (sdp) => withBundle(sdp, [mids[0], mids[2]]))
    Act: 部分 BUNDLE offer を適用して answer を作る。
    b setRemote local(a)
    b createAnswer as=answer
    Assert: BUNDLE owner と独立 media の ICE/DTLS transport が分かれる。
    let [audio, remoteVideo] = b.getTransceivers()
    expect answer.sdp contains "a=group:BUNDLE " + mids[0] + " " + mids[2]
    expect audio.dtlsTransport is b.sctpTransport.dtlsTransport
    expect remoteVideo.dtlsTransport isnt audio.dtlsTransport
    Act: final answer 後に video RTP を独立 transport で送る。
    b setLocal answer
    a setRemote local(b)
    do Promise.all([waitForIce(a), waitForIce(b), waitForConnection(a), waitForConnection(b)])
    let receivedVideo = events.tracks.find((e) => e.track.kind === "video").track
    rtp video -> receivedVideo
    Act / Assert: 接続済み SCTP を別 DTLS owner へ移す answer / offer は適用前に拒否する。
    a setLocal createRewrittenOffer(a, (sdp) => withBundle(sdp, [mids[1], mids[0], mids[2]]))
    a setRemote withBundle(a.currentRemoteDescription.sdp, [mids[1], mids[0], mids[2]]) type=answer rejects=InvalidModificationError
    Act / Assert: 受信側は offer の validate で拒否し、stable の current を保つ。
    b setRemote local(a) rejects=InvalidModificationError
    expect b.signalingState == "stable"
    a setLocal rollback
    rtp video -> receivedVideo
    Act: 次の offer で全 m-line を BUNDLE に戻す。
    let oldVideoTransport = remoteVideo.dtlsTransport
    a offer
    b createAnswer as=mergedAnswer
    expect remoteVideo.dtlsTransport is oldVideoTransport
    rtp video -> receivedVideo
    b setLocal mergedAnswer
    a setRemote local(b)
    Assert: 旧 video owner は解放され、共有 transport で RTP が届く。
    expect remoteVideo.dtlsTransport is audio.dtlsTransport
    expect oldVideoTransport.state == "closed"
    rtp video -> receivedVideo
  `,
    `
    case: re-offer BUNDLE split stages a new owner and rollback discards it
    ref: 2.1-T9 2.3-9 2.5-T1 2.5-11 2.5-12
    given: createConnectedVideoPeers()
    Arrange: 接続中の video に audio を追加し、audio を BUNDLE 外にする。
    let currentTransport = b.getTransceivers()[0].dtlsTransport
    let currentRemote = b.currentRemoteDescription.sdp
    do a.addTransceiver("audio", { direction: "sendonly" })
    a createOffer as=offer
    let mids = [...offer.sdp.matchAll(/a=mid:([^\\r\\n]+)/g)].map((m) => m[1])
    let splitOffer = withBundle(offer.sdp, [mids[0]])
    Act: 新 owner の候補を answer に準備し、現在の video を使い続ける。
    b setRemote splitOffer
    b createAnswer as=firstAnswer
    let pendingTransportCount = b.dtlsTransports.length
    rtp outgoing -> incoming
    Assert: pending transport は live binding にまだ現れず、SDP だけが別 ICE generation を持つ。
    expect pendingTransportCount == 1
    expect b.getTransceivers()[1].dtlsTransport is currentTransport
    let ufrags = [...firstAnswer.sdp.matchAll(/a=ice-ufrag:([^\\r\\n]+)/g)].map((m) => m[1])
    expect ufrags.length == 2
    expect new Set(ufrags).size == 2
    Act: rollback で pending owner を破棄し、同じ proposal を再交渉して確定する。
    b setRemote rollback
    expect b.dtlsTransports.length == 1
    expect b.currentRemoteDescription.sdp == currentRemote
    rtp outgoing -> incoming
    b setRemote splitOffer
    b createAnswer as=answer
    let events = recordNegotiationEvents(b)
    b setLocal answer
    Assert: video の経路を保ち、audio owner の candidate/EOC を一度通知する。
    expect b.getTransceivers()[0].dtlsTransport is currentTransport
    expect b.getTransceivers()[1].dtlsTransport isnt currentTransport
    expect events.candidates.some((c) => c?.sdpMid === mids[1]) == true
    expect events.candidates.at(-1) == undefined
    rtp outgoing -> incoming
  `,
    `
    case: a local BUNDLE split prepares independent ICE and carries both RTP streams
    ref: origin: local BUNDLE split
    given: createConnectedVideoPeers()
    Arrange: 接続済み BUNDLE transport に audio を追加し、group を分割する。
    let audio = new MediaStreamTrack({ kind: "audio" })
    let events = recordNegotiationEvents(b)
    let currentLocal = a.currentLocalDescription.sdp
    let selectedPair = a.iceTransports[0].getSelectedCandidatePair()
    let videoMid = a.getTransceivers()[0].mid
    do a.addTransceiver(audio, { direction: "sendonly" })
    let split = createRewrittenOffer(a, (sdp) => withBundle(sdp, [videoMid]))
    Act: 新 audio の ICE transport を pending に準備し、旧 video は継続する。
    a setLocal split
    expect a.currentLocalDescription.sdp == currentLocal
    expect a.iceTransports[0].getSelectedCandidatePair() == selectedPair
    expect a.dtlsTransports.length == 1
    rtp outgoing -> incoming
    Act: remote answer で新 transport へ audio を結び付ける。
    b setRemote local(a)
    b answer
    let audioTransport = a.getTransceivers()[1].dtlsTransport
    waitFor audioTransport.state === "connected" timeout=3000
    Assert: video の旧 pair を維持し、独立 audio と video の RTP が届く。
    expect audioTransport isnt a.getTransceivers()[0].dtlsTransport
    let receivedAudio = events.tracks.find((e) => e.track.kind === "audio").track
    rtp audio -> receivedAudio
    rtp outgoing -> incoming
    Act: 次の offer で audio を新 BUNDLE tag にして video を合流させる。
    let oldVideoTransport = a.getTransceivers()[0].dtlsTransport
    let audioMid = a.getTransceivers()[1].mid
    a setLocal createRewrittenOffer(a, (sdp) => withBundle(sdp, [audioMid, videoMid]))
    b setRemote local(a)
    b answer
    Assert: tag 変更後は audio owner を共有し、両方の RTP が届く。
    expect a.getTransceivers()[0].dtlsTransport is audioTransport
    expect oldVideoTransport.state == "closed"
    rtp audio -> receivedAudio
    rtp outgoing -> incoming
  `,
    `
    case: rollback of a local BUNDLE split keeps the old RTP owner
    ref: 2.1-T9 2.5-11
    given: createConnectedVideoPeers()
    Arrange: 新 audio を非 BUNDLE にした local re-offer を作る。
    let oldTransport = a.getTransceivers()[0].dtlsTransport
    let oldPair = oldTransport.iceTransport.getSelectedCandidatePair()
    let audio = new MediaStreamTrack({ kind: "audio" })
    let localAudio = a.addTransceiver(audio, { direction: "sendonly" })
    let videoMid = a.getTransceivers()[0].mid
    let splitOffer = createRewrittenOffer(a, (sdp) => withBundle(sdp, [videoMid]))
    Act: pending owner を用意してから rollback する。
    a setLocal splitOffer
    expect a.pendingLocalDescription.sdp contains "a=group:BUNDLE " + videoMid
    rtp outgoing -> incoming
    a setLocal rollback
    Assert: pending transport は消え、application の audio object と旧 pair は残る。
    expect a.dtlsTransports.length == 1
    expect a.getTransceivers() contains localAudio
    expect localAudio.sender.track is audio
    expect oldTransport.iceTransport.getSelectedCandidatePair() == oldPair
    rtp outgoing -> incoming
  `,
    `
    case: replacement offers implicitly roll back either pranswer direction
    ref: 2.1-6 2.1-T12 2.2-18 2.8-34 2.9-T8
    given: createPeerPair()
    Arrange: 初回 offer と pranswer を双方の pending に置き、pranswer で ICE・DTLS の暫定接続を成立させる。
    let audioOut = new MediaStreamTrack({ kind: "audio" })
    do a.addTransceiver(audioOut, { direction: "sendonly" })
    a offer
    b pranswer
    do waitForPeersConnected(a, b)
    Act: offerer は remote pranswer を、answerer は local pranswer を implicit rollback して replacement offer を受ける。
    a offer
    Assert: 最後の stable baseline は空で、新しい offer だけが pending。
    expect a.signalingState == "have-local-offer"
    expect b.signalingState == "have-remote-offer"
    expect a.currentLocalDescription == null
    expect b.currentRemoteDescription == null
    expect a.pendingRemoteDescription == null
    expect b.pendingLocalDescription == null
    Act: replacement offer を最終 answer で確定する。
    b answer
    do waitForPeersConnected(a, b)
    Assert: 新しい transport で接続し直し、audio の RTP が届く。
    expect a.connectionState == "connected"
    expect b.connectionState == "connected"
    let mid = a.getTransceivers()[0].mid
    rtp audioOut -> b.getTransceivers().find((t) => t.mid === mid).receiver.track
  `,
    `
    case: description and trickle operations serialize, and a rolled-back ufrag cannot be buffered
    ref: origin: operations chain
    given: createPeerPair()
    Arrange: 同じ tick に渡す remote offer と candidate を用意する。candidate の trickle がまだ続いている offer として渡す (EOC 後の候補は破棄される)。
    do a.addTransceiver("audio")
    a offer hold
    let offer = withoutEoc(local(a).sdp)
    let candidate = { candidate: "candidate:serial 1 udp 2113937151 192.0.2.13 12348 typ host", sdpMid: offer.match(/a=mid:([^\\r\\n]+)/)[1], usernameFragment: ufragOf(offer) }
    Act: SRD と trickle を待たずに連続で開始する。
    do Promise.all([b.setRemoteDescription({ type: "offer", sdp: offer }), b.addIceCandidate(candidate)])
    Assert: candidate は新しい pending description にだけ付く。
    expect b.pendingRemoteDescription.sdp contains "serial"
    b setRemote rollback
    Act / Assert: 破棄済み generation の遅延 candidate は次回用キューに入らない。
    b addCandidate candidate rejects=OperationError
  `,
  ],
  {
    fns: {
      /** The SDP without end-of-candidates: the trickle of its generation is still open. */
      withoutEoc: (sdp: string) =>
        sdp.replace(/^a=end-of-candidates\r?\n/gm, ""),
      eocCount: (sdp: string) =>
        sdp.match(/^a=end-of-candidates/gm)?.length ?? 0,
      /** The MIDs of the BUNDLE group (the first one is the tag). */
      bundleMids: (sdp: string) =>
        sdp
          .match(/^a=group:BUNDLE (.*?)\r?$/m)![1]
          .trim()
          .split(" "),
      /** The SDP with its BUNDLE group set to `mids`. */
      withBundle: (sdp: string, mids: string[]) =>
        sdp.replace(
          /a=group:BUNDLE [^\r\n]+/,
          `a=group:BUNDLE ${mids.join(" ")}`,
        ),
      ufragOf: (sdp: string) => sdp.match(/^a=ice-ufrag:(.*?)\r?$/m)![1],
      hostCandidate,
      /** The SDP with `hostCandidate(sdp, port)` added after its first host candidate. */
      withHostCandidate: (sdp: string, port: number) => {
        const [line] = sdp.match(
          /^a=candidate:\S+ \d+ \S+ \d+ \S+ \d+ typ host.*$/m,
        )!;
        return sdp.replace(line, `${line}\r\na=${hostCandidate(sdp, port)}`);
      },
      /** Remote candidates on `port` in the live checklist of the first ICE transport. */
      liveCandidates: (pc: RTCPeerConnection, port: number) =>
        pc.iceTransports[0].connection.remoteCandidates.filter(
          (c) => c.port === port,
        ).length,
    },
  },
);
