import { negotiationCases } from "./negotiationCaseRunner";
import { mungeSection, sectionOf } from "./negotiationTransactionUtils";

/** SDP edits and waits several regression cases share. */
const fns = {
  /** `sdp` without the plain `a=rtcp-fb:<pt> nack` line (NACK PLI stays). */
  withoutNack: (sdp: string, pt: number) =>
    sdp.replace(new RegExp(`^a=rtcp-fb:${pt} nack\\r?\\n`, "m"), ""),
  /** Wait for the next macrotask (`setImmediate`). */
  nextMacrotask: () => new Promise((resolve) => setImmediate(resolve)),
};

/**
 * Deterministic regressions for what the negotiation property test found
 * (see tests/pbt/negotiationTransactionProperty.test.ts for the seeds).
 */
negotiationCases(
  "negotiation transaction regressions",
  [
    `
    case: a relay-only ICE restart offered by $offerer nominates once the held TURN allocation completes after the peer's candidates
    ref: 2.11-14; origin: property test
    given: createRelayOnlyPeers()
    each: [{ offerer: "a", answerer: "b" }, { offerer: "b", answerer: "a" }]
    Arrange: 両 peer が relay-only で、DataChannel が TURN 経由で開いている。
    let connections = () => [a, b].map((pc) => pc.iceTransports[0].connection)
    let previous = connections().map((c) => c.localUsername)
    Act: b の新しい TURN allocation を保留したまま ICE restart を確定する (a の relay 候補と end-of-candidates が、b のローカル候補より先に b へ届く)。
    do proxy.hold()
    $offerer offer restart
    $answerer answer
    sleep 300
    Act: b の allocation を完了させる。
    do proxy.release()
    Assert: 両側が新しい generation の relay pair を nominate する。
    waitFor connections().every((c, index) => c.localUsername !== previous[index] && c.nominated?.localCandidate.type === "relay" && c.nominated.localCandidate.ufrag === c.localUsername) timeout=15000
    Assert: 元の DataChannel が relay 経由で双方向に届き、候補の配送は失敗しない。
    data channel -> remote
    data remote -> channel
    expect candidateErrors == []
    invariants
  `,
    `
    case: close() from the stable event of a glare implicit rollback adds no pending offer and leaves no transport running
    ref: 2.11-15; origin: property test
    given: createPeerPair()
    exempt: close() is the operation under test
    Arrange: a は local offer を保留し、b は audio と video を足した offer を持つ。
    do a.addTransceiver("audio")
    do b.addTransceiver("audio", { direction: "sendonly" })
    do b.addTransceiver("video", { direction: "sendonly" })
    a offer hold
    b offer hold
    start closed = closeOnSignalingState(a, "stable")
    Act: glare の implicit rollback が通知する stable の handler から close() する。close に追い越された操作は InvalidStateError で失敗する。
    a setRemote local(b) rejects=InvalidStateError
    await closed
    Assert: 閉鎖後に pending の remote offer も新しい transceiver も追加されない。
    expect a.signalingState == "closed"
    expect a.pendingRemoteDescription is null
    expect a.getTransceivers().length == 1
    Assert: a が保持する transport (transceiver・交渉が作ったものを含む) はすべて閉じている。
    do assertTransportsClosed([...heldTransports(a), ...a.getTransceivers().map((t) => t.dtlsTransport)])
  `,
    `
    case: close() from the stable event of a new local offer that rolls a remote pranswer back adds no pending offer and leaves no transport running
    ref: 2.11-15; origin: property test
    given: createPeerPair()
    exempt: close() is the operation under test
    Arrange: a の offer に b が pranswer を返し、a は have-remote-pranswer にある。
    do a.addTransceiver("audio")
    a offer
    b pranswer
    expect a.signalingState == "have-remote-pranswer"
    do a.addTransceiver("video")
    a createOffer as=offer
    start closed = closeOnSignalingState(a, "stable")
    Act: pranswer を暗黙に rollback する新しい offer の stable の handler から close() する。close に追い越された操作は InvalidStateError で失敗する。
    a setLocal offer rejects=InvalidStateError
    await closed
    Assert: offer は pending にならない。
    expect a.signalingState == "closed"
    expect a.pendingLocalDescription is null
    Assert: a が保持する transport はすべて閉じている。
    do assertTransportsClosed([...heldTransports(a), ...a.getTransceivers().map((t) => t.dtlsTransport)])
  `,
    `
    case: rollback of a remote offer after the application's $operation keeps the remote-created transceiver only when it has a track (as develop)
    ref: 2.12-3; origin: property test (develop comparison)
    given: createPeerPair()
    each: [
      { operation: "stop", kept: false },
      { operation: "direction", kept: false },
      { operation: "setCodecPreferences", kept: false },
      { operation: "replaceTrack", kept: true },
      { operation: "addTrack", kept: true },
    ]
    exempt: the test applies only b's offer to a
    Arrange: b の video offer を a が適用し、remote offer が transceiver を作る。
    do b.addTransceiver("video", { direction: "sendrecv" })
    b offer
    let offer = local(b)
    let created = a.getTransceivers()[0]
    Act: rollback の前に app がその transceiver を操作し、rollback する。
    [operation=stop] do created.stop()
    [operation=direction] do Object.assign(created, { direction: "sendonly" })
    [operation=setCodecPreferences] do created.setCodecPreferences([useVP8()])
    [operation=replaceTrack] do created.sender.replaceTrack(new MediaStreamTrack({ kind: "video" }))
    [operation=addTrack] do a.addTrack(new MediaStreamTrack({ kind: "video" }))
    a setRemote rollback
    Assert: track を持つものだけが m-line の関連付けを外して残り、停止途中の transceiver は残らない。
    let states = () => a.getTransceivers().map((t) => ({ mid: t.mid, stopping: t.stopping, stopped: t.stopped }))
    [kept=true] expect states() == [{ mid: null, stopping: false, stopped: false }]
    [kept=false] expect states() == []
    Act: 同じ offer を再適用する。
    a setRemote offer
    Assert: transceiver は重複せず 1 つだけで、offer の MID に関連付く。
    expect a.getTransceivers().map((t) => t.mid) == [offer.sdp.match(/^a=mid:(\\S+)/m)[1]]
  `,
    `
    case: a bundlePolicy disable renegotiation pranswer does not fail the connection and the final answer connects
    ref: 2.12-2; origin: property test
    given: createPeerPair({ bundlePolicy: "disable" })
    Arrange: bundlePolicy disable で audio と DataChannel が接続済み。
    do a.addTransceiver(new MediaStreamTrack({ kind: "audio" }), { direction: "sendrecv" })
    do a.createDataChannel("disable")
    a negotiate
    do waitForPeersConnected(a, b)
    let aStates = recordConnectionStates(a)
    let bStates = recordConnectionStates(b)
    let aOut = new MediaStreamTrack({ kind: "video" })
    let aTransceiver = a.addTransceiver(aOut, { direction: "sendrecv" })
    Act: 新しい video (独自の transport) を足した re-offer に pranswer を返す。
    a offer
    b pranswer
    sleep 1500
    Assert: remote パラメータのない transport を開始しないので、pranswer 中に failed にならない。
    expect aStates lacks "failed"
    expect bStates lacks "failed"
    expect [a.connectionState, b.connectionState] == ["connected", "connected"]
    Act: final answer で確定する (pranswer と同じ SDP)。
    b setLocal
    a setRemote local(b)
    do waitForPeersConnected(a, b)
    Assert: 新しい video の RTP が届き、どちらも failed を通らない。
    let bVideo = b.getTransceivers().find((t) => t.mid === aTransceiver.mid)
    do waitForDtlsConnected(aTransceiver.dtlsTransport)
    do waitForDtlsConnected(bVideo.dtlsTransport)
    rtp aOut -> bVideo.receiver.track
    expect aStates lacks "failed"
    expect bStates lacks "failed"
  `,
    `
    case: a simulcast layer whose MID extension names no route is still routed by its RID (as develop)
    ref: 2.12-5; origin: property test (develop comparison)
    given: createSimulcastPeers()
    Act / Assert: どの route も使わない MID 値と RID を持つ RTP も、RID の層に届く。
    do sendLayer("high", 0x5001, "rid-unknown-mid-high", { withRid: true, headerMid: "unrouted" })
    do sendLayer("low", 0x5002, "rid-unknown-mid-low", { withRid: true, headerMid: "unrouted" })
    Assert: MID が route と一致する RTP は従来どおり MID+RID で届く。
    do sendLayer("high", 0x5003, "rid-known-mid-high", { withRid: true })
    invariants b
  `,
    {
      text: `
    case: addIceCandidate does not wait for the gathering of a setLocalDescription before it (as develop)
    ref: 2.12-6; origin: property test (develop comparison)
    given: createPeerPair({ iceServers: [{ urls: "stun:192.0.2.1:3478" }] }, {})
    exempt: the test applies only a's answer
    timeout: 20000
    Arrange: 応答しない STUN server を持つ answerer。setLocalDescription は gather を待つ。b の候補は trickle で続く (offer に end-of-candidates を載せない)。
    do b.addTransceiver("audio")
    b offer hold
    a setRemote mutate(local(b).sdp, ["noEndOfCandidates"])
    a createAnswer as=answer
    let started = Date.now()
    Act: answer の適用 (gather 待ち) の直後に remote 候補を追加する。
    start applying = a.setLocalDescription(answer)
    let answerApplied = settledFlag(applying)
    do a.addIceCandidate({ candidate: "candidate:1 1 udp 2130706431 127.0.0.1 9 typ host", sdpMid: a.getTransceivers()[0].mid })
    Assert: 候補の追加は gather の完了を待たずに終わり、remote description に記録される。
    expect Date.now() - started < 1000
    expect answerApplied.settled == false
    expect a.remoteDescription.sdp contains "127.0.0.1 9 typ host"
    Act: 後続の description 操作は先の 2 つの完了を待つ。
    start next = a.createOffer()
    await applying
    await next
    Assert: answer が確定し、invariant を満たす。
    expect a.signalingState == "stable"
    invariants a
  `,
      fns: {
        /** `settled` turns true once `promise` settles. */
        settledFlag: (promise: Promise<unknown>) => {
          const flag = { settled: false };
          const settle = () => {
            flag.settled = true;
          };
          promise.then(settle, settle);
          return flag;
        },
      },
    },
    `
    case: an ICE-lite peer's final answer with new credentials and generation 1 candidates connects without another restart
    ref: 2.12-10; origin: property test
    given: createPeerPair({ iceServers: [] }, { iceServers: [], iceLite: true })
    exempt: the answerer's ICE credentials were changed through its internals
    Arrange: full の offerer と ICE-lite の answerer。pranswer で接続済み。
    let aOut = new MediaStreamTrack({ kind: "video" })
    let bOut = new MediaStreamTrack({ kind: "video" })
    let aVideo = a.addTransceiver(aOut, { direction: "sendrecv" })
    a offer
    let bVideo = b.getTransceivers()[0]
    do Object.assign(bVideo, { direction: "sendrecv" })
    do bVideo.sender.replaceTrack(bOut)
    b pranswer
    do waitForPeersConnected(a, b)
    Arrange: answerer は final answer で資格情報を変える (候補は generation 1)。
    do changeAnswererIceCredentials(b)
    b createAnswer
    b setLocal
    expect local(b).sdp matches / generation 1 /
    Act: offerer が final answer を適用する (offerer 自身は restart しない)。
    a setRemote local(b)
    Assert: 次の restart の前に、新しい remote generation で pair を選び、checks の待機が決着する。
    let transport = a.iceTransports[0]
    waitFor !!transport.connection.nominated && transport.connection.remoteUsername === transport.getRemoteParameters()?.usernameFragment timeout=10000
    expect settlesWithin(transport.checksSettled(), 1000) == true
    expect ["connected", "completed"] contains transport.state
    Assert: 両方向に RTP が届く。
    rtp aOut -> bVideo.receiver.track
    rtp bOut -> aVideo.receiver.track
    invariants a
  `,
    `
    case: a replacement local offer keeps a new transceiver associated with its m-line
    ref: 2.1-T5; origin: property test
    given: createDuplexSession()
    Arrange: a が audio を足した offer を適用し、b にも渡す。
    let out = new MediaStreamTrack({ kind: "audio" })
    let audio = a.addTransceiver(out, { direction: "sendonly" })
    a offer
    let mid = audio.mid
    Act: 同じ内容の replacement offer を適用する。
    a offer hold
    Assert: pending 中も transceiver は自分の m-line (MID・index) に結び付いたまま。
    expect audio.mid is mid
    expect sectionOf(a.pendingLocalDescription.sdp, mid) contains "m=audio"
    Act: replacement offer に answer を返す。
    b setRemote local(a)
    b answer
    Assert: audio が届き、既存の video・DataChannel も継続する。
    rtp out -> b.getTransceivers().find((t) => t.mid === mid).receiver.track
    alive
  `,
    `
    case: an answer does not give a direction to a transceiver without an m-line
    ref: origin: property test
    given: createConnectedVideoPeers()
    Arrange: re-offer を受けた後に answerer が audio transceiver を足す。
    a offer
    let late = b.addTransceiver("audio", { direction: "sendonly" })
    Act: その transceiver の m-line を含まない answer を適用する。
    b answer hold
    Assert: 交渉されていない transceiver は current direction を持たない。
    expect late.mid is null
    expect !late.currentDirection == true
    invariants b
  `,
    `
    case: MIDs from unapplied createOffer calls do not collide with a later remote offer
    ref: origin: property test
    given: createDuplexSession()
    Arrange: b が audio を足し、適用しない createOffer を 2 回呼ぶ (MID・index が仮に振られる)。
    let own = b.addTransceiver(new MediaStreamTrack({ kind: "audio" }), { direction: "sendonly" })
    b createOffer
    b createOffer
    Act: a が同じ種類の m-line を足した offer で交渉する。
    do a.addTransceiver(new MediaStreamTrack({ kind: "audio" }), { direction: "sendonly" })
    a negotiate
    Assert: b の MID は重複せず、b 自身の transceiver は停止も除外もされない。
    let mids = b.getTransceivers().map((t) => t.mid).filter(Boolean)
    expect new Set(mids).size == mids.length
    expect b.getTransceivers() contains own
    expect own.stopped == false
    alive
  `,
    `
    case: the final answer after an ICE restart pranswer reuses the pranswer credentials
    ref: 2.9-7; origin: property test
    given: createConnectedVideoPeers()
    Arrange: ICE restart offer に pranswer を返す。
    let ufragOf = (sdp) => sdp.match(/^a=ice-ufrag:(.*?)\\r?$/m)[1]
    a offer restart
    b pranswer as=pranswer
    Act: 最終 answer を改めて作って適用する。
    b answer as=answer
    Assert: pranswer で広告した資格情報のまま確定し、live と SDP が一致して RTP が届く。
    expect ufragOf(answer.sdp) == ufragOf(pranswer.sdp)
    expect b.iceTransports[0].connection.localUsername == ufragOf(pranswer.sdp)
    invariants
    do Promise.all([waitForCommittedNomination(a), waitForCommittedNomination(b)])
    rtp outgoing -> incoming
  `,
  ],
  { fns },
);

/** Findings of the pre-review self-review of pending writes to live state. */
negotiationCases(
  "negotiation transaction live-state regressions",
  [
    `
    case: a remote pranswer that changes send parameters is fully undone by rollback
    ref: 2.2-9 2.4-4; origin: self-review (live state)
    given: createConnectedVideoPeersWithRtx()
    Arrange: offerer の送信パラメータ (RTX を含む) を控え、RTX を外した pranswer を作る。
    let sender = a.getTransceivers()[0].sender
    let before = sender.snapshotSendParams()
    expect before.rtxPayloadType != undefined
    a offer
    b createAnswer as=answer
    Act: pranswer を適用して送信側が暫定値に変わった後、rollback する。
    a setRemote withoutCodecs(answer.sdp, "video", ["rtx"]) type=pranswer
    expect sender.snapshotSendParams()?.rtxPayloadType is undefined
    a setLocal rollback
    Assert: 送信パラメータは current のものへ完全に戻り、RTP も届く。
    expect sender.snapshotSendParams() == before
    invariants a
    rtp outgoing -> incoming
  `,
    `
    case: a re-offer that changes RTCP feedback of a current payload type is staged until commit
    ref: 2.4-T7a; origin: self-review (live state)
    given: createConnectedVideoPeers()
    Arrange: current の VP8 は nack を持つ。nack を外した re-offer を作る (a は適用しない)。
    let receiver = b.getTransceivers()[0].receiver
    a createOffer as=offer
    let pt = Number(offer.sdp.match(/^a=rtpmap:(\\d+) VP8\\/90000/m)[1])
    let feedback = () => receiver.snapshotReceiveTables().codecs[pt].rtcpFeedback.map((f) => f.type + " " + (f?.parameter ?? ""))
    expect feedback() contains "nack "
    Act: remote offer として適用する (answer はまだ返さない)。
    b setRemote withoutNack(offer.sdp, pt)
    Assert: pending 中は current の feedback (nack) のまま。
    expect feedback() contains "nack "
    Act: answer で確定する。
    b answer hold
    Assert: 確定時に新しい feedback へ切り替わる。
    expect feedback() lacks "nack "
  `,
    `
    case: a pending re-offer that adds transport-cc does not start TWCC feedback for the current stream
    ref: 2.4-5; origin: self-review (live state)
    given: createConnectedVideoPeers()
    Arrange: current は transport-cc なし。transport-cc を足した re-offer を作る (a は適用しない)。
    let receiver = b.getTransceivers()[0].receiver
    expect receiver?.receiverTWCC is undefined
    a createOffer as=offer
    Act: remote offer を適用して current の RTP を受け、rollback する。
    b setRemote withRtcpFeedback(offer.sdp, "VP8", "transport-cc")
    rtp outgoing -> incoming
    let pending = receiver?.receiverTWCC
    b setRemote rollback
    Assert: pending 中も rollback 後も current の stream に TWCC は始まらない。
    expect pending is undefined
    expect receiver?.receiverTWCC is undefined
  `,
    `
    case: a transceiver created for a remote offer does not make negotiation needed
    ref: 2.3-20 2.4-6 5-K6; origin: self-review (live state)
    given: createConnectedVideoPeers()
    Arrange: answerer の negotiationneeded を数える。
    let events = recordNegotiationEvents(b)
    Act: audio m-line を足した offer を受けて answer を返す。
    do a.addTransceiver("audio", { direction: "sendonly" })
    a negotiate
    do nextMacrotask()
    Assert: remote offer 由来の transceiver では再交渉は要求されない。
    expect events.negotiationNeeded == 0
    expect b.getTransceivers().length == 2
  `,
    `
    case: a final answer replaces the RTCP feedback a pranswer staged
    ref: 2.4-T7a 2.5-13; origin: self-review (live state)
    given: createDuplexSession()
    Arrange: re-offer を b に渡し、VP8 の NACK を外した pranswer を用意する。
    a offer
    b createAnswer as=answer
    let pt = Number(answer.sdp.match(/^a=rtpmap:(\\d+) VP8\\/90000/m)[1])
    let pranswer = withoutNack(answer.sdp, pt)
    expect pranswer != answer.sdp
    let hasNack = () => aVideo.receiver.snapshotReceiveTables().codecs[pt].rtcpFeedback.some((f) => f.type === "nack" && !f?.parameter)
    Act: NACK なしの pranswer を受ける。
    b setLocal answer.sdp type=pranswer
    a setRemote pranswer type=pranswer
    Assert: pranswer の feedback 変更は commit まで保留され、current の NACK を保つ。
    expect hasNack() == true
    Act: NACK を含む final answer で確定する。
    b setLocal answer
    a setRemote local(b)
    Assert: 確定 SDP と receiver の feedback が一致し (helper も検査する)、通信が続く。
    expect a.currentRemoteDescription.sdp contains "a=rtcp-fb:" + pt + " nack\\r\\n"
    expect hasNack() == true
    alive
  `,
    `
    case: adding video after an inactive audio m-line does not take the audio m-line
    ref: 2.4-7; origin: self-review (live state)
    given: createUnnegotiatedPeers()
    Arrange: inactive な audio m-line を確定させる。
    let audio = a.addTransceiver("audio", { direction: "inactive" })
    a negotiate
    let audioMid = audio.mid
    expect audio.currentDirection == "inactive"
    Act: 別 kind の video を追加して、自身の offer を作って適用する。
    let video = a.addTransceiver("video")
    a offer hold
    Assert: audio は MID と index を保ち、video は新しい m-line を末尾に持つ。
    expect audio.mid is audioMid
    expect audio.mLineIndex == 0
    expect video.mid isnt audioMid
    expect video.mLineIndex == 1
    expect a.getTransceivers() == [audio, video]
  `,
    `
    case: an answer whose codec was not in the offer is rejected before mutation
    ref: 2.5-4; origin: self-review (live state)
    given: createUnnegotiatedPeers()
    Arrange: 設定は Opus/PCMU に対応するが、offer は Opus だけを提案する。
    let audio = a.addTransceiver("audio")
    do Object.assign(audio, { codecs: a.config.codecs.audio.filter((codec) => codec.name.toLowerCase() === "opus") })
    a offer
    b createAnswer as=answer
    let unoffered = answer.sdp.replace(/opus\\/48000\\/2/i, "PCMU/8000")
    expect unoffered != answer.sdp
    Act / Assert: offer にない PCMU に差し替えた answer は InvalidAccessError で拒否され、状態は変わらない。
    a setRemote unoffered type=answer rejects=InvalidAccessError
    expect a.signalingState == "have-local-offer"
    expect a.currentRemoteDescription is null
    Assert: offer と合意する正しい answer はそのまま適用できる。
    a setRemote answer
    expect a.signalingState == "stable"
  `,
    `
    case: $candidate after end-of-candidates of an ICE restart pranswer reaches neither the pending SDP nor the provisional checklist
    ref: 5-12; origin: self-review (live state)
    given: createIceRestartPranswer()
    each: [
      { candidate: "a host candidate", host: "127.0.0.1" },
      { candidate: "an mDNS candidate", host: "peer.local" },
    ]
    Arrange: pranswer の restart generation に end-of-candidates を適用する。
    let mdns = stubIceMdns(a)
    a addCandidate { candidate: "", sdpMid: mid, usernameFragment: ufrag }
    let pendingSdp = a.pendingRemoteDescription.sdp
    let provisional = provisionalIce(a)
    let candidates = provisional.remoteCandidates.length
    let pairs = provisional.pairs.length
    Act: 同じ ufrag の候補が end-of-candidates の後に届く。
    a addCandidate trickleCandidate(50999, ufrag, mid, "$host")
    Assert: 完了済み generation の pending SDP と provisional checklist は変わらない。
    expect a.pendingRemoteDescription.sdp is pendingSdp
    expect a.pendingRemoteDescription.sdp contains "a=end-of-candidates"
    expect provisional.remoteCandidatesEnd == true
    expect provisional.remoteCandidates.length == candidates
    expect provisional.pairs.length == pairs
    Assert: mDNS 名の解決も始めない。
    expect mdns.requested == 0
    invariants a
    rtp outgoing -> incoming
  `,
    `
    case: an mDNS candidate that is still resolving does not hold later candidates or description operations
    ref: 2.8-1; origin: self-review (live state)
    given: createConnectedVideoPeers({}, { trickleOpen: true })
    Arrange: current の remote generation が trickle 継続中の接続済み peer と、解決しない mDNS lookup
    let mdns = stubIceMdns(b)
    let generation = currentRemoteGeneration(b)
    Act: mDNS 候補、通常の候補、description 操作をこの順に行う
    let mdnsElapsed = elapsedMs(() => b.addIceCandidate(trickleCandidate(50991, generation.ufrag, generation.mid, "peer.local")))
    let hostElapsed = elapsedMs(() => b.addIceCandidate(trickleCandidate(50992, generation.ufrag, generation.mid)))
    let offerElapsed = elapsedMs(() => b.createOffer())
    Assert: どの操作も mDNS の解決 (最大 10 秒) を待たずに終わり、通常の候補はすぐ checklist に入る
    expect mdns.requested == 1
    expect Math.max(mdnsElapsed, hostElapsed, offerElapsed) < 1000
    do waitForRemoteCandidatePort(b, 50992)
    rtp outgoing -> incoming
    Act: mDNS の解決を完了させる
    do mdns.resolveAll("127.0.0.1")
    Assert: 解決後に mDNS 候補も同じ generation の checklist に入る
    do waitForRemoteCandidatePort(b, 50991)
    invariants b
  `,
    `
    case: an mDNS candidate trickled before end-of-candidates of an ICE restart pranswer is kept
    ref: 2.7-T2 2.8-2 2.8-29 5-12; origin: self-review (live state)
    given: createIceRestartPranswer()
    Arrange: provisional generation の mDNS 候補を解決中にし、続けて EOC を送る。
    let mdns = stubIceMdns(a)
    start resolving = a.addIceCandidate(trickleCandidate(50998, ufrag, mid, "peer.local"))
    start end = a.addIceCandidate({ candidate: "", sdpMid: mid, usernameFragment: ufrag })
    do nextMacrotask()
    expect mdns.requested == 1
    Act: mDNS 解決を完了させる。
    do mdns.resolveAll("127.0.0.1")
    await Promise.all([resolving, end])
    Assert: EOC 前に届いた候補は pending SDP と provisional checklist に入り、その後に完了する。
    let provisional = provisionalIce(a)
    expect provisional.remoteCandidates.some((c) => c.port === 50998) == true
    expect provisional.remoteCandidatesEnd == true
    let section = sectionOf(a.pendingRemoteDescription.sdp, mid)
    expect section contains " 50998 typ host"
    expect section contains "a=end-of-candidates"
    invariants a
  `,
    `
    case: a sender added during a rolled-back offer keeps receiving RTCP after renegotiation
    ref: 5-8; origin: self-review (live state)
    given: createDuplexSession()
    Arrange: re-offer を適用した pending 中に、アプリが送信用 video を追加する。
    a offer hold
    let late = a.addTransceiver(new MediaStreamTrack({ kind: "video" }), { direction: "sendonly" })
    let onPli = vi.fn()
    do late.sender.onPictureLossIndication.subscribe(onPli)
    Act: pending offer を rollback する (追加した sender は残る)。
    a setLocal rollback
    Assert: rollback 後も追加した sender の SSRC 経路が残る (helper も検査する)。
    invariants a
    Act: 改めて交渉し、相手から PLI を送る。
    a negotiate
    do b.getTransceivers().find((t) => t.mid === late.mid).receiver.sendRtcpPLI(late.sender.ssrc)
    Assert: 相手の PLI が追加した sender に実際に届き、既存の通信も続く。
    waitFor onPli.mock.calls.length !== 0 timeout=2000
    alive
  `,
    `
    case: PLI stops at the commit of a re-offer that removes NACK/PLI for the same SSRC
    ref: 5-7; origin: self-review (live state)
    given: createConnectedVideoPeers()
    Arrange: 接続済み session は PLI を交渉済みで、実際に届く。
    let sender = a.getTransceivers()[0].sender
    let receiver = b.getTransceivers()[0].receiver
    expect pliReaches(receiver, sender) == true
    Act: 同じ SSRC の VP8 から NACK/PLI を外した re-offer を pending にする。
    a offer hold
    b setRemote rewriteVideoFeedback(local(a).sdp, "remove")
    Assert: pending 中は current の設定のまま PLI が届く。
    expect pliReaches(receiver, sender) == true
    Act: answer で確定する。
    b answer
    Assert: 確定した SDP は PLI を持たず、PLI は送られない。
    expect b.currentLocalDescription.sdp unlike /^a=rtcp-fb:\\d+ nack/m
    expect pliReaches(receiver, sender) == false
    invariants b
  `,
    `
    case: PLI starts only at the commit of a re-offer that adds NACK/PLI for the same SSRC
    ref: 2.4-T7b 5-7 5-13; origin: self-review (live state)
    given: createConnectedVideoPeers(videoWithoutFeedback)
    Arrange: 初回交渉は PLI を持たず、送られない。
    let sender = a.getTransceivers()[0].sender
    let receiver = b.getTransceivers()[0].receiver
    expect pliReaches(receiver, sender) == false
    Act: 同じ VP8 / SSRC に NACK/PLI を足した re-offer を pending にする。
    a offer hold
    b setRemote rewriteVideoFeedback(local(a).sdp, "add")
    Assert: pending 中は current の設定のまま PLI は送られない。
    expect pliReaches(receiver, sender) == false
    Act: re-offer を両側で rollback する。
    b setRemote rollback
    a setLocal rollback
    Assert: rollback 後も current の設定に戻ったまま送られない。
    expect pliReaches(receiver, sender) == false
    Act: 同じ re-offer を適用し、answer で確定する。
    a offer hold
    b setRemote rewriteVideoFeedback(local(a).sdp, "add")
    b answer
    Assert: 確定後は PLI が相手 sender に実際に届く。
    expect pliReaches(receiver, sender) == true
    invariants b
  `,
    `
    case: header extension IDs the answer did not accept stay free for a later offer
    ref: 2.8-16; origin: self-review (live state)
    given: createPeerPair({ headerExtensions: { audio: [useSdesMid()], video: [useSdesMid(), useAbsSendTime()] } })
    Arrange: remote (a) の audio offer は werift (b) が受理しない extmap を空き ID すべてに載せる
    do a.addTransceiver("audio")
    a offer hold
    b setRemote addUnsupportedExtmaps(local(a).sdp, "audio")
    b answer
    Act: werift (b) が video を追加して re-offer し、その ID をそのまま返す answer を適用する
    do b.addTransceiver("video")
    b negotiate
    Assert: 受理されなかった ID は使用中ではないので、answer は拒否されず stable になる
    expect b.signalingState == "stable"
    invariants b
  `,
    `
    case: a payload type the answer did not accept can carry another codec in a later remote offer
    ref: 2.8-16; origin: self-review (live state)
    given: createPeerPair()
    Arrange: remote (a) の audio offer に werift (b) が受理しない codec を PT 110 で載せ、answer で確定する
    do a.addTransceiver("audio")
    a offer hold
    b setRemote addOfferedCodec(local(a).sdp, "audio", 110, "FOO/8000")
    b answer
    expect b.currentLocalDescription.sdp lacks "FOO/8000"
    Act: remote の re-offer が PT 110 を別の codec に使う
    a offer hold
    b setRemote addOfferedCodec(local(a).sdp, "audio", 110, "BAR/8000")
    Assert: PT 110 は使用中ではないので re-offer は拒否されない
    expect b.signalingState == "have-remote-offer"
    b answer hold
    invariants b
  `,
    `
    case: close() during a pending BUNDLE split stops the transports the proposal prepared
    ref: 2.8-17; origin: self-review (live state)
    given: createConnectedVideoPeers({}, { withAudio: true })
    exempt: close() is the operation under test
    Arrange: video と audio を BUNDLE で共有する接続済み peer で、audio を分割する offer を適用中にする
    let audioMid = a.getTransceivers().find((t) => t.kind === "audio").mid
    let liveBefore = a.dtlsTransports.length
    a setLocal createSplitOffer(a, audioMid)
    let held = heldTransports(a)
    expect held.size > liveBefore
    Act: pending のまま close する
    a close
    b close
    Assert: 分割用に用意した transport も含め、すべての DTLS / ICE が閉じる
    do assertTransportsClosed(held)
  `,
    `
    case: a local pranswer applied again over a connected BUNDLE split keeps its checks settled through the final answer and close()
    ref: 2.12-9; origin: self-review (live state)
    given: createConnectedVideoPeers({}, { withAudio: true })
    Arrange: audio を分割する re-offer に pranswer を返し、分割先の transport で暫定接続する。
    let audioMid = a.getTransceivers().find((t) => t.kind === "audio").mid
    a setLocal createSplitOffer(a, audioMid)
    b setRemote local(a)
    b createAnswer as=answer
    b setLocal answer.sdp type=pranswer
    a setRemote answer.sdp type=pranswer
    let held = [...heldTransports(a), ...heldTransports(b)]
    do Promise.all(held.map((transport) => waitForDtlsConnected(transport)))
    let iceStates = () => held.map((t) => t.iceTransport.state)
    let connected = iceStates()
    expect connected.filter((s) => !["connected", "completed"].includes(s)) == []
    Act: 同じ local pranswer をもう一度適用する。
    b setLocal answer.sdp type=pranswer
    sleep 300
    Assert: 接続済みの generation の checks はやり直さず (checking に戻らない)、待機は決着している。
    expect iceStates() == connected
    expect Promise.all(held.map((t) => settlesWithin(t.iceTransport.checksSettled(), 1000))) == held.map(() => true)
    invariants b
    Act: final answer で確定する。
    b setLocal answer.sdp type=answer
    a setRemote answer.sdp type=answer
    do waitForPeersConnected(a, b)
    Assert: 確定後も checking に戻らず、集約した接続状態と一致する。
    expect [a.connectionState, b.connectionState] == ["connected", "connected"]
    expect [...a.iceTransports, ...b.iceTransports].map((t) => t.state).filter((s) => !["connected", "completed"].includes(s)) == []
    Assert: その後も次の offer・ICE restart・DataChannel と transceiver の追加・相手からの再 offer の後に通信できる。
    do expectSessionContinues(a, b, "split-pranswer-again")
    Act: close する。
    exempt close() is the operation under test after the continuation
    let transports = [...heldTransports(a), ...heldTransports(b), ...held]
    do Promise.all([a.close(), b.close()])
    Assert: すべての transport が閉じ、checks の待機も決着する。
    do assertTransportsClosed(transports)
    expect Promise.all(transports.map((t) => settlesWithin(t.iceTransport.checksSettled(), 1000))) == transports.map(() => true)
  `,
    `
    case: close() after a provisional split connection stops both peers' pending transports
    ref: 2.2-3 2.7-3 2.8-17; origin: self-review (live state)
    given: createConnectedVideoPeers({}, { withAudio: true })
    exempt: close() is the operation under test
    Arrange: audio を分割する re-offer に pranswer を返し、分割先の transport で暫定接続する
    let audioMid = a.getTransceivers().find((t) => t.kind === "audio").mid
    a setLocal createSplitOffer(a, audioMid)
    b setRemote local(a)
    b createAnswer as=answer
    b setLocal answer.sdp type=pranswer
    a setRemote answer.sdp type=pranswer
    let held = [...heldTransports(a), ...heldTransports(b)]
    do Promise.all(held.map((transport) => waitForDtlsConnected(transport)))
    Act: 両 peer を pending のまま close する
    a close
    b close
    Assert: 暫定接続した transport も含め、ICE / DTLS が動き続けない
    do assertTransportsClosed(held)
  `,
    `
    case: an ICE restart commit does not wait for an unreachable STUN server
    ref: 2.8-4; origin: self-review (live state)
    given: createConnectedVideoPeers({ iceServers: [{ urls: "stun:192.0.2.1:3478" }], iceStunGatherTimeout: 1 })
    Arrange: 到達できない STUN server を設定した接続済み peer (初回の gather は 1 秒で打ち切る)
    do a.restartIce()
    a offer
    Act: 双方で restart の answer を適用 (commit) する
    let answerElapsed = elapsedMs(() => b.createAnswer().then((answer) => b.setLocalDescription(answer)))
    let commitElapsed = elapsedMs(() => a.setRemoteDescription(local(b)))
    Assert: commit は STUN の応答 (最大 1 秒) を待たずに終わり、新しい generation で RTP が届く
    expect Math.max(answerElapsed, commitElapsed) < 500
    do waitForCommittedNomination(a)
    rtp outgoing -> incoming
  `,
    `
    case: restartIce() beside a new m-line with bundlePolicy disable offers the new transport's gathered candidates
    ref: 2.8-7; origin: self-review (live state)
    given: createPeerPair({ bundlePolicy: "disable" })
    Arrange: BUNDLE しない接続済み peer
    do a.addTransceiver("audio")
    a negotiate
    Act: 新しい m-line の追加と ICE restart を 1 つの offer で行う
    let video = a.addTransceiver("video")
    do a.restartIce()
    a offer hold
    Assert: まだ generation を持たない新しい transport は restart を stage せず、集めた候補を offer する
    expect sectionOf(local(a).sdp, video.mid) matches /^a=candidate:/m
    b setRemote local(a)
    b answer
    do waitForDtlsConnected(video.dtlsTransport)
    invariants a
  `,
    `
    case: a re-answer with a=setup:actpass keeps the DTLS role of the live association
    ref: 2.8-47 2.11-5; origin: self-review (live state)
    given: createPeerPair()
    Arrange: 接続済みの peer (answerer は active で答え、offerer は server になる)
    do a.createDataChannel("role")
    a negotiate
    let transport = a.dtlsTransports[0]
    do waitForDtlsConnected(transport)
    let role = transport.role
    Act: re-offer に a=setup:actpass の answer (b の前回の answer を書き換えたもの) が返る
    a offer hold
    a setRemote local(b).sdp.replace(/a=setup:\\w+/g, "a=setup:actpass") type=answer
    Assert: 拒否されず、確立済み association の role は変わらない
    expect a.signalingState == "stable"
    expect transport.role is role
  `,
    `
    case: close() while an ICE restart answer commits keeps the state closed
    ref: 2.8-19; origin: self-review (live state)
    given: createConnectedVideoPeers()
    exempt: close() is the operation under test
    Arrange: ICE restart の answer を適用する直前まで交渉する
    do a.restartIce()
    a offer
    b answer hold
    Act: answer の適用 (restart の commit) の途中で close する
    let gather = holdNextGather(a)
    start applying = a.setRemoteDescription(local(b))
    await gather.reached
    a close
    do gather.release()
    Assert: close に追い越された操作は成功を報告せず、signalingState は closed のまま
    await applying rejects=InvalidStateError
    expect a.signalingState == "closed"
  `,
    `
    case: a remote re-offer committed by the local answer switches the receive tables and the remote track codec
    ref: 2.5-16 2.6-T4h; origin: self-review (live state)
    given: createH264OnlyReoffer()
    Arrange: current は VP8、offerer が H264 だけの re-offer を出し answerer が適用済み (preference の変更なし)
    Act: answer を作って適用し、offerer も answer を適用する
    b answer
    Assert: 受信表は H264 だけになり、remote track の codec も H264 に切り替わる
    expect Object.values(transceiver.receiver.snapshotReceiveTables().codecs).map((codec) => codec.name.toUpperCase()) == ["H264"]
    expect incoming?.codec?.mimeType.toLowerCase() == "video/h264"
    invariants b
    rtp outgoing -> incoming
  `,
    `
    case: codec preferences resolved by createAnswer apply to live receive tables only at the answer commit
    ref: 2.5-16 2.6-T4a; origin: self-review (live state)
    given: createConnectedVideoPeers({ codecs: { video: [useVP8(), useH264()] } })
    Arrange: current は VP8。answerer は re-offer を受けた後で H264 だけを優先する。
    let transceiver = b.getTransceivers()[0]
    let receiver = transceiver.receiver
    let vp8Pt = Number(b.currentLocalDescription.sdp.match(/^a=rtpmap:(\\d+) VP8\\/90000/im)[1])
    a offer
    do transceiver.setCodecPreferences([useH264()])
    Act: preference を反映した answer を作る (まだ適用しない)。
    b createAnswer as=answer
    Assert: answer は H264 だけを提案するが、pending 中は current の VP8 で受信を続ける。
    expect answer.sdp matches /^a=rtpmap:\\d+ H264\\/90000/im
    expect answer.sdp unlike /^a=rtpmap:\\d+ VP8\\/90000/im
    expect receiver.snapshotReceiveTables().codecs[vp8Pt]?.name == "VP8"
    invariants b
    rtp outgoing -> incoming
    Act: answer を適用して transaction を commit する。
    b setLocal answer
    a setRemote local(b)
    Assert: commit 後は確定した H264 だけが受信 table に残る。
    expect Object.values(receiver.snapshotReceiveTables().codecs).map((codec) => codec.name.toUpperCase()) == ["H264"]
  `,
    `
    case: an answer applied during the DTLS handshake keeps the connected ICE state
    ref: 2.8-23 2.8-24 2.8-26; origin: self-review (live state)
    given: createUnnegotiatedVideoPeers()
    Arrange: 初回交渉の answerer 側 DTLS 開始を止め、offerer の handshake を ICE 接続済み・DTLS connecting の状態に留める。
    a offer
    b answer hold
    let held = holdDtlsStart(b)
    a setRemote local(b)
    do waitForIce(a)
    do waitForDtlsHandshake(a.dtlsTransports[0])
    Act: handshake 中に次の offer/answer を交換し、answer を適用する。
    a negotiate
    Assert: 接続済みの ICE は checking に戻らず、DTLS 完了前に connected を報告しない。
    sleep 100
    expect a.iceConnectionState == "connected"
    expect a.dtlsTransports[0].state == "connecting"
    expect a.connectionState == "connecting"
    Act: 止めていた handshake を進める。
    do held.release()
    do waitForDtlsConnected(a.dtlsTransports[0])
    do waitForConnection(a)
    Assert: ICE は connected のまま、DTLS 完了後に connected になり、RTP も届く。
    expect a.iceConnectionState == "connected"
    expect a.connectionState == "connected"
    rtp outgoing -> incoming()
  `,
    `
    case: an answer without an ICE restart leaves a failed ICE generation failed
    ref: 2.8-23 2.8-24 2.8-27; origin: self-review (live state)
    given: createConnectedVideoPeers()
    Arrange: 確立済みの session で offerer の ICE generation を failed にする (consent の期限切れ相当)。
    do forceIceState(a, "failed")
    let iceStates = recordIceConnectionStates(a)
    Act: ICE restart を含まない再交渉を answer まで行う。
    a negotiate
    sleep 100
    Assert: failed の generation は接続確認をやり直さず (checking に戻らず)、connectionState も connected に上書きされない。
    expect iceStates lacks "checking"
    expect a.iceConnectionState == "failed"
    expect a.connectionState != "connected"
  `,
    `
    case: an ICE restart keeps the configured icePasswordPrefix
    ref: 2.8-11; origin: self-review (live state)
    given: createConnectedVideoPeers({ icePasswordPrefix: "werift" })
    Act: ICE restart の offer を作る
    do a.restartIce()
    a createOffer as=offer
    Assert: 新しい generation の ICE password にも prefix が付く
    let password = offer.sdp.match(/^a=ice-pwd:(\\S+)/m)[1]
    expect password matches /^werift/
    expect password isnt a.currentLocalDescription.sdp.match(/^a=ice-pwd:(\\S+)/m)[1]
  `,
    `
    case: the local answer lists codecs in the answerer's preference order
    ref: 2.6-T4g; origin: self-review (live state)
    given: createPeerPair({ codecs: { video: [useH264(), useVP8()] } }, { codecs: { video: [useVP8(), useH264()] } })
    Arrange: offerer は H264 → VP8、answerer は VP8 → H264 の順で設定する。
    do a.addTransceiver("video")
    a offer
    Act: answer を作る。
    b createAnswer as=answer
    Assert: answer の codec 順は remote offer ではなく answerer の設定順になる。
    expect offeredVideoCodecs(answer.sdp) == ["VP8", "H264"]
  `,
    `
    case: a codec the local answer dropped leaves the receive table even when the re-offer staged it
    ref: 2.8-45; origin: self-review (live state)
    given: createConnectedVideoPeers({ codecs: { video: [useVP8(), useH264()] } })
    Arrange: current の VP8 から RTCP feedback を外した re-offer を受け、同じ payload type の VP8 を staged 値にする。answerer は H264 だけを優先する。
    let transceiver = b.getTransceivers()[0]
    a offer hold
    b setRemote rewriteVideoFeedback(local(a).sdp, "remove")
    do transceiver.setCodecPreferences([useH264()])
    b createAnswer as=answer
    expect offeredVideoCodecs(answer.sdp) == ["H264"]
    Act: H264 だけの answer を適用して commit する。
    b setLocal answer
    a setRemote local(b)
    Assert: answer で外した VP8 は staged 値からも戻らず、受信表は H264 だけになる。
    expect Object.values(receiveCodecNames(transceiver.receiver)) == ["H264"]
    expect incoming?.codec?.mimeType.toLowerCase() == "video/h264"
    rtp outgoing -> incoming
  `,
    `
    case: end-of-candidates trickled on a non-tag BUNDLE m-line completes the restarted generation
    ref: 2.8-28; origin: self-review (live state)
    given: createConnectedVideoPeers({}, { withAudio: true })
    Arrange: audio (BUNDLE の非 tag) を含む session で、EOC を含まない ICE restart の re-offer を answerer に適用する。
    do a.restartIce()
    a offer hold
    let ufrag = local(a).sdp.match(/^a=ice-ufrag:(\\S+)/m)[1]
    b setRemote local(a).sdp.replace(/^a=end-of-candidates\\r?\\n/gm, "")
    let audioMid = b.getTransceivers().find((t) => t.kind === "audio").mid
    Act: 非 tag m-line に新 generation の EOC を trickle してから answer で確定する。
    b addCandidate { candidate: "", sdpMid: audioMid, usernameFragment: ufrag }
    b answer
    Assert: 確定した共有 transport の generation が EOC を記録し、current の全 m-line の SDP も EOC を持つ。
    let connection = b.iceTransports[0].connection
    expect connection.remoteUsername == ufrag
    expect connection.remoteCandidatesEnd == true
    let current = b.currentRemoteDescription.sdp
    expect current.match(/^a=end-of-candidates/gm).length == current.match(/^m=/gm).length
    invariants b
  `,
    `
    case: a final answer cannot reverse the DTLS role a first pranswer connected with
    ref: 2.8-33; origin: self-review (live state)
    given: createInitialPranswerConnection()
    Arrange: 初回 pranswer で接続した offerer の DTLS role を控える。
    let transport = a.dtlsTransports[0]
    let role = transport.role
    Act / Assert: a=setup を反転した final answer は適用前に拒否され、状態は変わらない。
    a setRemote reverseSetupRole(pranswer) type=answer rejects=InvalidModificationError
    expect transport.role is role
    expect a.signalingState == "have-remote-pranswer"
    Act: pranswer と同じ role の final answer で確定し、通常の再交渉を行う。
    b setLocal pranswer type=answer
    a setRemote pranswer type=answer
    a negotiate
    Assert: 再交渉も成功し、role は維持される。
    expect a.signalingState == "stable"
    expect transport.role is role
  `,
    `
    case: rolling back a first pranswer connection resets the public connection states
    ref: 2.2-17 2.8-35; origin: self-review (live state)
    given: createInitialPranswerConnection()
    Arrange: 初回 pranswer で両 peer が接続済みと報告している。
    do Promise.all([waitForConnection(a), waitForConnection(b)])
    Act: 両 peer で初回交渉を rollback する (b、a の順)。
    b rollback
    Assert: current session がないので、接続状態は new に戻る。
    expect [a.currentRemoteDescription, b.currentRemoteDescription] == [null, null]
    expect [a.connectionState, b.connectionState] == ["new", "new"]
    expect [a.iceConnectionState, b.iceConnectionState] == ["new", "new"]
  `,
    `
    case: a remote-created transceiver the application keeps returns to its created state on rollback
    ref: 2.3-5 2.8-36; origin: self-review (live state)
    given: createInitialPranswerConnection()
    Arrange: pranswer で remote 起因の transceiver に direction が確定している。
    expect remoteCreated.currentDirection isnt null
    Act: answerer で remote offer を rollback する。
    b setRemote rollback
    Assert: app が使う transceiver は残るが、交渉した MID・direction は持たない。
    expect b.getTransceivers() contains remoteCreated
    expect remoteCreated.mid is null
    expect remoteCreated.currentDirection is null
  `,
    `
    case: a saved answer commits its own codecs after an unapplied createOffer() resolved others
    ref: 2.8-37 2.8-38 2.9-8 2.9-T1; origin: self-review (live state)
    given: createVp8H264AnsweringPeers()
    Arrange: VP8 の answer を作って保存し、その後 H264 を選んで offer を作る (適用しない)。
    do answererTransceiver.setCodecPreferences([useVP8()])
    b createAnswer as=answer
    do answererTransceiver.setCodecPreferences([useH264()])
    b createOffer
    Act: 保存した VP8 の answer を両 peer に適用する。
    b setLocal answer
    a setRemote local(b)
    do waitForPeersConnected(a, b)
    Assert: 送受信は適用した answer の VP8 で確定し、双方向に RTP が届く。
    expect offeredVideoCodecs(b.currentLocalDescription.sdp) == ["VP8"]
    expect answererTransceiver.sender?.codec?.mimeType.toLowerCase() == "video/vp8"
    expect Object.values(receiveCodecNames(answererTransceiver.receiver)) == ["VP8"]
    rtp offererOut -> answererTransceiver.receiver.track
    rtp answererOut -> offererTransceiver.receiver.track
    Assert: 未適用の offer で選んだ H264 は次の offer で解決し直される。
    b createOffer as=next
    expect offeredVideoCodecs(next.sdp) == ["H264"]
    Arrange: answerer の codec の選択を既定に戻す (H264 だけの選択は VP8 しか持たない offerer の次の offer と両立しない。develop と同じく sRD が失敗する)。
    do answererTransceiver.setCodecPreferences([])
  `,
    `
    case: a first pranswer sends and receives with the codecs it answered
    ref: 2.8-39; origin: self-review (live state)
    given: createVp8H264AnsweringPeers()
    Arrange: answerer は H264 だけを選んだ answer を作る。
    do answererTransceiver.setCodecPreferences([useH264()])
    b createAnswer as=answer
    Act: その answer を初回の pranswer として両 peer に適用する。
    b setLocal answer.sdp type=pranswer
    a setRemote local(b)
    do waitForPeersConnected(a, b)
    Assert: 暫定通信は pranswer の H264 で双方向に届く。
    expect answererTransceiver.sender?.codec?.mimeType.toLowerCase() == "video/h264"
    rtp offererOut -> answererTransceiver.receiver.track
    rtp answererOut -> offererTransceiver.receiver.track
    Act: 同じ内容の final answer で確定する。
    b setLocal answer
    a setRemote local(b)
    Assert: 確定後も H264 のまま、invariant を満たし双方向に届く。
    rtp answererOut -> offererTransceiver.receiver.track
  `,
    `
    case: a re-applied restart offer that fails to parse leaves no staged credentials
    ref: 2.9-4 2.9-9; origin: self-review (live state)
    given: createConnectedVideoPeers()
    Arrange: audio を含む restart offer を適用して rollback し、相手の通常 offer で同じ m-line 位置に video を確定する。
    let audio = a.addTransceiver("audio", { direction: "sendonly" })
    a createOffer restart as=saved
    a setLocal
    a setLocal rollback
    do b.addTransceiver("video", { direction: "sendonly" })
    b negotiate
    let iceTransport = a.iceTransports[0]
    let state = () => ({ signalingState: a.signalingState, current: a.currentLocalDescription.sdp, ufrag: iceTransport.localParameters.usernameFragment, staged: iceTransport.hasStagedRestart, audio: { mid: audio.mid, index: audio.mLineIndex } })
    let before = state()
    Act / Assert: 保存した offer の再適用は m-line の不整合で拒否される。
    a setLocal saved rejects=InvalidModificationError
    Assert: stage し直した資格情報や MID は残らず、失敗前と同じ状態になる。
    expect state() == before
    expect before.staged == false
    expect before.current contains "a=ice-ufrag:" + before.ufrag
    invariants a
    rtp outgoing -> incoming
  `,
    `
    case: a remote answer that answers only the leading m-lines of the offer is accepted and rejects the rest
    ref: 2.9-T9; origin: self-review (live state)
    given: createConnectedVideoPeers()
    Arrange: 相手の前回の answer (m-line が少ない) を保存し、offerer は video を足した offer を適用する。
    let staleAnswer = b.currentLocalDescription
    let added = a.addTransceiver("video", { direction: "sendonly" })
    a offer hold
    Act: 先頭の m-line だけに答える前回の answer を適用する (develop も受理する)。
    a setRemote staleAnswer
    Assert: 確定し、答えられなかった m-line は拒否として停止する。既存の映像は届く。
    expect a.signalingState == "stable"
    expect added.stopped == true
    invariants a
    rtp outgoing -> incoming
  `,
    `
    case: a first offer with a DataChannel re-applied after its rollback opens the channel
    ref: 2.3-15 2.9-10 2.9-T5; origin: self-review (live state)
    given: createUnnegotiatedPeers()
    Arrange: DataChannel を持つ初回 offer を作り、適用して rollback する。
    let channel = a.createDataChannel("reapplied")
    a createOffer as=offer
    a setLocal
    a setLocal rollback
    let sctpTransport = a.sctpTransport.dtlsTransport
    Act: 同じ offer を再適用し、answer で確定する。
    a setLocal offer
    b setRemote local(a)
    b answer
    Assert: SCTP の m-line は offer が作られた SCTP transport のまま交渉され (余分な transport を作らない)、DataChannel が開いて届く。
    expect a.sctpTransport.dtlsTransport is sctpTransport
    let received = b.onDataChannel.asPromise(5000).then((args) => args[0])
    waitFor channel.readyState === "open" timeout=5000
    data channel -> received
    invariants a
  `,
    `
    case: a max-compat first offer connects to a peer that answers without BUNDLE
    ref: 2.8-41 2.8-42; origin: self-review (live state)
    given: createPeerPair({}, { bundlePolicy: "disable" })
    Arrange: 既定 (max-compat) の offerer と、BUNDLE を使わず m-line ごとに独立した ICE 資格情報で答える answerer。
    let audioOut = new MediaStreamTrack({ kind: "audio" })
    let videoOut = new MediaStreamTrack({ kind: "video" })
    do a.addTransceiver(audioOut, { direction: "sendonly" })
    do a.addTransceiver(videoOut, { direction: "sendonly" })
    Act: 初回交渉を行い、すべての transport の接続を待つ。
    a negotiate
    do Promise.all([...a.dtlsTransports, ...b.dtlsTransports].map((transport) => waitForDtlsConnected(transport)))
    Assert: BUNDLE なしの answer を受理し、m-line ごとの transport で接続して audio・video とも届く。
    expect a.signalingState == "stable"
    expect new Set(a.dtlsTransports).size == 2
    let received = (kind) => b.getTransceivers().find((t) => t.kind === kind).receiver.track
    rtp audioOut -> received("audio")
    rtp videoOut -> received("video")
  `,
    `
    case: a candidate on the tag m-line after end-of-candidates on a non-tag member of a pending restart is ignored
    ref: 2.8-32; origin: self-review (live state)
    given: createConnectedVideoPeers({}, { withAudio: true })
    Arrange: EOC を含まない ICE restart の re-offer を answerer に適用し、非 tag (audio) の m-line に新 generation の EOC を trickle する。
    do a.restartIce()
    a offer hold
    let ufrag = local(a).sdp.match(/^a=ice-ufrag:(\\S+)/m)[1]
    b setRemote local(a).sdp.replace(/^a=end-of-candidates\\r?\\n/gm, "")
    let video = b.getTransceivers().find((t) => t.kind === "video").mid
    let audio = b.getTransceivers().find((t) => t.kind === "audio").mid
    b addCandidate { candidate: "", sdpMid: audio, usernameFragment: ufrag }
    Act: 同じ BUNDLE の tag (video) m-line に、同じ generation の遅延候補を送り、answer で確定する。
    b addCandidate trickleCandidate(49999, ufrag, video)
    b answer
    do Promise.all([waitForCommittedNomination(a), waitForCommittedNomination(b)])
    Assert: 終端通知の後の候補は pending SDP にも確定後の ICE にも入らない (RFC 8838)。
    let connection = b.iceTransports[0].connection
    expect connection.remoteCandidatesEnd == true
    expect connection.remoteCandidates.some((candidate) => candidate.port === 49999) == false
    expect b.currentRemoteDescription.sdp lacks " 49999 "
    invariants b
    rtp outgoing -> incoming
  `,
    `
    case: close() while createAnswer() prepares the transports of a BUNDLE split leaves none running
    ref: 2.8-18; origin: self-review (live state)
    given: createConnectedMultiVideoPeers(3)
    exempt: close() is the operation under test
    Arrange: 3 m-line の BUNDLE から 2 つを外す (owner transport を 2 つ準備させる) re-offer を受ける。
    let mids = a.getTransceivers().map((t) => t.mid)
    expect mids.length == 3
    let split = createRewrittenOffer(a, (sdp) => sdp.replace(/^a=group:BUNDLE [^\\r\\n]+/m, "a=group:BUNDLE " + mids[0]))
    a setLocal split
    b setRemote local(a)
    let hook = closeDuringNextPreparedGather(b)
    do closing({ close: () => hook.restore() })
    Act: createAnswer の transport 準備 (最初の gather) の途中で close する。
    expect b.createAnswer() rejects=InvalidStateError
    do hook.closed()
    do hook.restore()
    Assert: 準備を始めた transport は止まり、close の後に新しい transport は作られない。
    expect hook.gathered.map((transport) => transport.state) == ["closed"]
    expect b.connectionState == "closed"
  `,
    {
      text: `
    case: end-of-candidates on a pending restart reaches its BUNDLE group but not an m-line the offer splits off
    ref: 2.8-31; origin: self-review (live state)
    given: createConnectedVideoPeers({}, { withAudio: true })
    Arrange: ICE restart と BUNDLE 解除 (audio を group から外す) を行い、両 MID が同じ ufrag/pwd を持つ remote offer を、transport 準備 (createAnswer) の前まで適用する。
    do a.restartIce()
    let video = a.getTransceivers().find((t) => t.kind === "video").mid
    let audio = a.getTransceivers().find((t) => t.kind === "audio").mid
    let offer = createRewrittenOffer(a, (sdp) => splitWithSharedCredentials(sdp, video, audio))
    let ufrag = sectionOf(offer.sdp, video).match(/^a=ice-ufrag:(\\S+)/m)[1]
    b setRemote offer
    Act: video (tag) にだけ end-of-candidates を通知し、分割される audio に候補を送る。
    b addCandidate { candidate: "", sdpMid: video, usernameFragment: ufrag }
    b addCandidate trickleCandidate(49998, ufrag, audio)
    Assert: 終端は video の BUNDLE group だけが完了扱いになり、独立する audio は完了せず候補を受け入れる。
    let pending = b.pendingRemoteDescription.sdp
    expect sectionOf(pending, video) contains "a=end-of-candidates"
    expect sectionOf(pending, audio) lacks "a=end-of-candidates"
    expect sectionOf(pending, audio) contains " 49998 typ host"
  `,
      fns: {
        /**
         * `sdp` whose BUNDLE group keeps only `video`, without
         * end-of-candidates, and whose `audio` m-line carries the ICE
         * credentials of the `video` m-line.
         */
        splitWithSharedCredentials: (
          sdp: string,
          video: string,
          audio: string,
        ) => {
          const split = sdp
            .replace(/^a=group:BUNDLE [^\r\n]+/m, `a=group:BUNDLE ${video}`)
            .replace(/^a=end-of-candidates\r?\n/gm, "");
          const tag = sectionOf(split, video);
          const ufrag = tag.match(/^a=ice-ufrag:(\S+)/m)![1];
          const pwd = tag.match(/^a=ice-pwd:(\S+)/m)![1];
          return mungeSection(split, audio, (section) =>
            section
              .replace(/^a=ice-ufrag:\S+/m, `a=ice-ufrag:${ufrag}`)
              .replace(/^a=ice-pwd:\S+/m, `a=ice-pwd:${pwd}`),
          );
        },
      },
    },
  ],
  { fns },
);

/** Findings of the peer-diversity SDP mutations (negotiationTransactionMutation). */
negotiationCases("negotiation transaction mutation regressions", [
  `
    case: an answer declining BUNDLE onto the same transport keeps the ended generation complete
    ref: 2.8-28 2.10-6; origin: SDP mutations
    given: createMutationSession("renegotiation")
    Arrange: 確立済み session (EOC 済み) で re-offer を両側に置く。
    a offer
    b answer hold as=answer
    Act: BUNDLE も end-of-candidates も持たない answer を適用する。
    a setRemote mutate(answer.sdp, ["noBundle", "noEndOfCandidates"])
    Assert: 同じ transport・ufrag の m-line はどれも終端済みとして記録される。
    let current = a.currentRemoteDescription.sdp
    expect sectionOf(current, "0") contains "a=end-of-candidates"
    expect sectionOf(current, "1") contains "a=end-of-candidates"
    invariants a
  `,
  `
    case: new remote credentials next to an inactive m-line keep only the new remote generation's candidates
    ref: 2.11-13; origin: SDP mutations
    given: createMutationSession("renegotiation")
    exempt: the answer misdescribes b's ICE credentials
    Arrange: 確立済み session で re-offer を両側に置く。
    a offer
    b answer hold as=answer
    Act: tag の video を inactive にし、別の資格情報を持たせた answer を適用する (develop から既存の renomination 経路: inactive の m-line と資格情報の変更)。
    a setRemote mutate(answer.sdp, ["videoInactive", "videoSeparateCredentials"])
    Assert: live の remote generation は新しい資格情報で、前の generation の ufrag を名乗る候補は checklist に残らない。
    let connection = aVideo.dtlsTransport.iceTransport.connection
    expect connection.remoteUsername == "mutv"
    expect connection.remoteCandidates.filter((candidate) => candidate?.ufrag && candidate.ufrag !== "mutv") == []
    invariants a
  `,
  `
    case: new remote credentials in an answer keep the local credentials the offer described
    ref: 2.10-5; origin: SDP mutations
    given: createMutationSession("renegotiation")
    Arrange: 確立済み session で re-offer を両側に置く。
    a offer
    let offered = sectionOf(local(a).sdp, "1").match(/^a=ice-ufrag:(\\S+)/m)[1]
    b answer hold as=answer
    Act: tag の video を拒否し、新しい tag の application が別の資格情報を持つ answer を適用する。
    a setRemote mutate(answer.sdp, ["separateCredentials", "videoRejected"])
    Assert: remote は新しい資格情報で checks をやり直し、local の資格情報は offer で伝えたまま (どの SDP にも無い資格情報を作らない)。
    let connection = a.sctpTransport.dtlsTransport.iceTransport.connection
    expect connection.remoteUsername == "mutd"
    expect connection.localUsername == offered
    invariants a
  `,
  `
    case: a rejected m-line does not turn a credential change into a renomination
    ref: 2.10-5; origin: SDP mutations
    given: createMutationSession("renegotiation")
    Arrange: video を拒否し application に新しい資格情報を持たせた offer を b に届ける。
    a offer hold
    b setRemote mutate(local(a).sdp, ["separateCredentials", "videoRejected"])
    let oldUfrag = b.sctpTransport.dtlsTransport.iceTransport.connection.localUsername
    b answer hold
    Act: b が新しい資格情報で答えた answer を a に適用する。
    a setRemote local(b)
    Assert: a の checklist に b の旧 generation の候補は残らない。
    let connection = a.sctpTransport.dtlsTransport.iceTransport.connection
    expect connection.remoteUsername isnt oldUfrag
    expect connection.remoteCandidates.map((candidate) => candidate?.ufrag ?? connection.remoteUsername).filter((ufrag) => ufrag !== connection.remoteUsername) == []
    invariants a
  `,
]);
