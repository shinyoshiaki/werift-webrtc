import { SCTP_STATE } from "../../../sctp/src";
import type { RTCPeerConnection, RTCRtpTransceiver } from "../../src";
import {
  REMOTE_UFRAG,
  answerRemoteOffer,
  buildRemoteSdp,
  bundleGroups,
  createAudioOnlyPeer,
  expectTransportsMatchBundle,
} from "../issue/705.helpers";
import { negotiationCases } from "./negotiationCaseRunner";
import { sdpCandidates, sectionOf } from "./negotiationTransactionUtils";

/** The value of `a=<name>` in the m-section `mid`. */
const attribute = (sdp: string, mid: string, name: string) =>
  new RegExp(`^a=${name}:(\\S+)`, "m").exec(sectionOf(sdp, mid))?.[1];

/** The remote fingerprint a DTLS transport would verify. */
const remoteFingerprint = (
  transport: RTCPeerConnection["dtlsTransports"][number],
) =>
  (
    transport as unknown as {
      remoteParameters?: { fingerprints: { value: string }[] };
    }
  ).remoteParameters?.fingerprints[0]?.value;

/** The receiver the router of `pc` routes the remote SSRC `ssrc` to. */
const routedReceiver = (pc: RTCPeerConnection, ssrc: number) =>
  (pc as unknown as { router: { ssrcTable: Record<number, unknown> } }).router
    .ssrcTable[ssrc];

/** The candidate ports of m-line `mid` in `sdp`. */
const advertised = (sdp: string, mid: string) =>
  new Set(
    sdpCandidates(sdp, mid).map(({ candidate }) => candidate.split(" ")[5]),
  );

/** The ports `transceiver`'s ICE transport gathered. */
const gathered = (transceiver: RTCRtpTransceiver) =>
  new Set(
    transceiver.dtlsTransport.iceTransport.connection.localCandidates.map(
      (candidate) => String(candidate.port),
    ),
  );

/** #142 fixture with its BUNDLE group written in the answerer's own MIDs. */
const issue142Answer = `v=0
o=- 0 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0_srtp 2_sctp 1_srtp
a=msid-semantic: WMS 13945094204333313074/3212739396 virtual-6666
a=ice-lite
m=audio 19305 UDP/TLS/RTP/SAVPF 96
c=IN IP4 <redacted>
a=rtcp:9 IN IP4 0.0.0.0
a=candidate: 1 udp 2113939711 2607:f8b0:400e:c03::7f 19305 typ host generation 0
a=candidate: 1 tcp 2113939710 2607:f8b0:400e:c03::7f 19305 typ host tcptype passive generation 0
a=candidate: 1 ssltcp 2113939709 2607:f8b0:400e:c03::7f 443 typ host generation 0
a=candidate: 1 udp 2113932031 74.125.197.127 19305 typ host generation 0
a=candidate: 1 tcp 2113932030 74.125.197.127 19305 typ host tcptype passive generation 0
a=candidate: 1 ssltcp 2113932029 74.125.197.127 443 typ host generation 0
a=ice-ufrag:KFPTBCP4YKPZTY1Q
a=ice-pwd:VA0L9MQMWS8IYO9NJF+ITE++
a=fingerprint:sha-256 92:D6:06:D6:CB:64:B4:EF:47:76:00:F7:48:E0:ED:DD:9F:3E:DA:16:41:49:47:43:E0:77:DD:C6:D7:83:7E:19
a=setup:passive
a=mid:0_srtp
a=sendrecv
a=msid:virtual-6666 virtual-6666
a=rtcp-mux
a=rtpmap:96 opus/48000/2
a=fmtp:96 minptime=10;useinbandfec=1
a=ssrc:6666 cname:6666
m=video 9 UDP/TLS/RTP/SAVPF 97
c=IN IP4 0.0.0.0
a=rtcp:9 IN IP4 0.0.0.0
a=ice-ufrag:KFPTBCP4YKPZTY1Q
a=ice-pwd:VA0L9MQMWS8IYO9NJF+ITE++
a=fingerprint:sha-256 92:D6:06:D6:CB:64:B4:EF:47:76:00:F7:48:E0:ED:DD:9F:3E:DA:16:41:49:47:43:E0:77:DD:C6:D7:83:7E:19
a=setup:passive
a=mid:1_srtp
a=sendrecv
a=msid:13945094204333313074/3212739396 13945094204333313074/3212739396
a=rtcp-mux
a=rtpmap:97 VP8/90000
a=rtcp-fb:97 ccm fir
a=rtcp-fb:97 nack
a=rtcp-fb:97 nack pli
a=rtcp-fb:97 goog-remb
a=ssrc:3212739396 cname:3212739396
m=application 9 DTLS/SCTP 5000
c=IN IP4 0.0.0.0
a=ice-ufrag:KFPTBCP4YKPZTY1Q
a=ice-pwd:VA0L9MQMWS8IYO9NJF+ITE++
a=fingerprint:sha-256 92:D6:06:D6:CB:64:B4:EF:47:76:00:F7:48:E0:ED:DD:9F:3E:DA:16:41:49:47:43:E0:77:DD:C6:D7:83:7E:19
a=setup:passive
a=mid:2_sctp
a=sctpmap:5000 webrtc-datachannel 1024
`;

/**
 * Spec coverage for the pranswer lifecycle, DTLS, BUNDLE and signaling
 * transitions of TICKET-ticket-0ad06d37 (§2.2, §2.4, §2.5, §2.8, §2.9, §5).
 * The requirement ID leads each test name. Video is MID "0" and the
 * application MID "1" in a duplex or mutation session.
 */
negotiationCases(
  "negotiation transaction spec coverage: transport",
  [
    {
      text: `
        case: [2.2-8] a replacement pranswer's DTLS fingerprint and role take effect on a new association that has not started
        ref: 2.2-8
        given: createDuplexSession()
        Arrange: 確立済み session で、新しい audio を BUNDLE 外に出す re-offer (新しい DTLS association) を両側に置き、offerer の新 transport の DTLS 開始を止める。
        let audioOut = new MediaStreamTrack({ kind: "audio" })
        let audio = a.addTransceiver(audioOut, { direction: "sendonly" })
        a setLocal createRewrittenOffer(a, (sdp) => leaveBundle(sdp, audio.mid))
        let mid = audio.mid
        let hold = holdNewDtlsStart(a)
        b setRemote local(a)
        b createAnswer as=answer
        let shared = aVideo.dtlsTransport
        let [sharedRole, sharedFingerprint] = [shared.role, remoteFingerprint(shared)]
        let realFingerprint = /^a=fingerprint:\\S+ (\\S+)/m.exec(sectionOf(answer.sdp, mid))[1]
        Arrange: 1 回目は新 association の fingerprint と a=setup だけを変えた pranswer。
        let first = mungeSection(answer.sdp, mid, (section) => reverseSetupRole(section).replace(/^a=fingerprint:(\\S+) \\S+/m, "a=fingerprint:$1 " + BOGUS_FINGERPRINT))
        let newTransport = () => [...heldTransports(a)].find((t) => t !== shared && t.state !== "closed")
        Act: 1 回目の pranswer を両側に適用する。
        b setLocal answer type=pranswer
        a setRemote first type=pranswer
        Assert: 未接続の新 association は 1 回目の pranswer の fingerprint / role になる。
        expect hold.held.length == 1
        expect remoteFingerprint(newTransport()) == BOGUS_FINGERPRINT
        expect newTransport().role == "client"
        Act: 正しい fingerprint と a=setup の replacement pranswer を適用する。
        a setRemote answer type=pranswer
        Assert: 新 association は最新の pranswer の値に置き換わり、既存 association は変わらない。
        expect remoteFingerprint(newTransport()) == realFingerprint
        expect newTransport().role == "server"
        expect [shared.role, remoteFingerprint(shared)] == [sharedRole, sharedFingerprint]
        Act: DTLS の開始を許し、新 association の接続を待つ。
        do hold.release()
        let remoteAudio = b.getTransceivers().find((t) => t.mid === mid)
        do waitForPeersConnected(a, b)
        do Promise.all([waitForDtlsConnected(newTransport()), waitForDtlsConnected(remoteAudio.dtlsTransport)])
        Assert: 最新の pranswer の値で接続し、新しい audio の RTP と既存 session が通じる。
        expect b.signalingState == "have-local-pranswer"
        rtp audioOut -> remoteAudio.receiver.track
        alive
      `,
      fns: {
        remoteFingerprint,
        BOGUS_FINGERPRINT: Array(32).fill("AB").join(":"),
      },
    },
    `
      case: [2.2-8] a replacement pranswer that adds BUNDLE detaches the transports a no-BUNDLE pranswer used and stops their checks
      ref: 2.2-8
      given: createMutationSession("initial")
      Arrange: 初回交渉で、BUNDLE なしの pranswer を offerer に適用する。
      a offer
      do prepareMutationAnswerer(session)
      b createAnswer as=answer
      b setLocal answer type=pranswer
      a setRemote mutate(answer.sdp, ["noBundle"]) type=pranswer
      let unbundled = [...a.dtlsTransports]
      expect unbundled.length > 1
      Act: BUNDLE を受理した replacement pranswer を適用する。
      a setRemote answer type=pranswer
      let detached = unbundled.filter((t) => !a.dtlsTransports.includes(t))
      Assert: 全 m-line が tag の transport を共有し、旧 pranswer だけが使った transport は外れて、その暫定の ICE checks は止まる (new か closed)。
      expect a.sctpTransport.dtlsTransport is aVideo.dtlsTransport
      expect detached.length > 0
      expect detached.filter((t) => t.iceTransport.state !== "new" && t.iceTransport.state !== "closed") == []
      Assert: final answer 前の最新 topology で RTP と DataChannel が通じる。
      do waitForMutationSession(session)
      expect a.signalingState == "have-remote-pranswer"
      alive
      Act: final answer で確定する。
      b setLocal answer
      a setRemote answer
      Assert: 確定後も同じ topology で通じる。
      alive
    `,
    {
      text: `
        case: [2.2-13] a final answer that rejects the application m-line keeps the SCTP association a first pranswer opened, as develop does
        ref: 2.2-13 2.11-2; origin: develop comparison
        given: createMutationSession("initial")
        Arrange: 初回交渉の pranswer で SCTP association と DataChannel を開く。
        a offer
        do prepareMutationAnswerer(session)
        b createAnswer as=answer
        b setLocal answer type=pranswer
        a setRemote answer type=pranswer
        do waitForMutationSession(session)
        let provisional = a.sctpTransport
        expect provisional.sctp.associationState == SCTP_STATE.ESTABLISHED
        let rejected = leaveBundle(mungeSection(answer.sdp, "1", (s) => s.replace(/^m=application \\d+/m, "m=application 0")), "1")
        Act: application m-line を port 0 で拒否した final answer を offerer に適用する。
        b setLocal answer
        a setRemote rejected
        Assert: develop と同じく SCTP transport と DataChannel は閉じず、同じ MID に束縛されたまま。
        expect a.sctpTransport is provisional
        expect provisional.mid == "1"
        expect provisional.sctp.associationState == SCTP_STATE.ESTABLISHED
        expect aChannel.readyState == "open"
        Assert: 受理された video は確定した transport で届き続ける。
        rtp aOut -> session.b.video.receiver.track
        Assert: 次の offer は同じ MID の application を再提案する (その後の通信は runner の継続確認)。
        a createOffer as=next
        expect sectionOf(next.sdp, "1") matches /^m=application [1-9]/
      `,
      fns: { SCTP_STATE },
    },
    `
      case: [2.2-13] the candidates of a pranswer generation the final answer replaced leave the live checklist
      ref: 2.2-13
      given: createMutationSession("initial")
      Arrange: 初回交渉で、final answer と別の ICE generation の候補を持つ pranswer を offerer に適用する。
      a offer
      do prepareMutationAnswerer(session)
      b createAnswer as=answer
      let ufrag = attribute(answer.sdp, "0", "ice-ufrag")
      Arrange: pranswer は別の (provisional) ICE generation とその候補 (port 50991) を伝える。
      let extra = trickleCandidate(50991, "prov", "0").candidate
      let provisional = withIceCredentials(answer.sdp, "prov", "provisionalpasswordprovisional").replace(/ ufrag \\S+/g, " ufrag prov")
      let pranswer = mungeSection(provisional, "0", (s) => s.replace(/^(a=ice-pwd:[^\\r\\n]+\\r\\n)/m, "$1a=" + extra + "\\r\\n"))
      let connection = a.iceTransports[0].connection
      b setLocal answer type=pranswer
      a setRemote pranswer type=pranswer
      waitFor connection.remoteCandidates.some((c) => c.port === 50991)
      Act: その候補を含まない final answer で確定する。
      b setLocal answer
      a setRemote answer
      Assert: final answer の generation に切り替わり、pranswer だけが伝えた候補は live checklist と current SDP から外れる。
      let live = a.iceTransports[0].connection
      expect live.remoteUsername == ufrag
      expect live.remoteCandidates.some((c) => c.port === 50991) == false
      expect live.checkList.some((pair) => pair.remoteCandidate.port === 50991) == false
      expect a.currentRemoteDescription.sdp lacks " 50991 "
      do waitForMutationSession(session)
      do expectMediaAlive(session, "pranswer-candidate-released")
    `,
    {
      text: `
        case: [2.2-16] rollback stops the RTP a renegotiation pranswer started and keeps the current stream
        ref: 2.2-16
        given: createDuplexSession()
        Arrange: 確立済み session に新しい audio を足した re-offer を pranswer まで進め、新 audio の RTP が届くことを確かめる。
        let audioOut = new MediaStreamTrack({ kind: "audio" })
        let audio = a.addTransceiver(audioOut, { direction: "sendonly" })
        a offer
        b pranswer
        let remoteAudio = b.getTransceivers().find((t) => t.mid === audio.mid)
        let [audioTrack, audioSsrc] = [remoteAudio.receiver.track, audio.sender.ssrc]
        rtp audioOut -> audioTrack
        expect routedReceiver(b, audioSsrc) is remoteAudio.receiver
        Act: 両側で rollback する。
        a rollback
        Assert: 新 audio の RTP は届かなくなり、受信側 router にその SSRC は残らない。
        expect sendAndExpectRtp(audioOut, audioTrack, "rolled-back-audio") rejects="RTP was not received"
        expect routedReceiver(b, audioSsrc) is undefined
        Assert: 旧 current の video と DataChannel は双方向に届き続ける。
        alive
      `,
      fns: { routedReceiver },
    },
    `
      case: [2.8-18] close() while a local offer stages the transports of a BUNDLE split leaves none running
      ref: 2.8-18
      given: createConnectedMultiVideoPeers(3)
      exempt: close() is the operation under test
      Arrange: 3 m-line の BUNDLE から 2 つを外す (owner transport を 2 つ stage させる) local offer を用意する。
      let first = a.getTransceivers()[0].mid
      let split = createRewrittenOffer(a, (sdp) => sdp.replace(/^a=group:BUNDLE [^\\r\\n]+/m, "a=group:BUNDLE " + first))
      let live = [...a.dtlsTransports]
      let hook = closeDuringNextPreparedGather(a)
      do closing({ close: hook.restore })
      Act: local offer の stage (最初の gather) の途中で close する。
      a setLocal split rejects=InvalidStateError
      do hook.closed()
      do hook.restore()
      Assert: stage を始めた transport は止まり、close の後に新しい transport は作られない。
      expect hook.gathered.length == 1
      expect hook.gathered.filter((t) => t.state !== "closed") == []
      do assertTransportsClosed(live)
      expect [a.connectionState, a.signalingState] == ["closed", "closed"]
    `,
    {
      text: `
        case: [2.8-20] a first answer's own MIDs are read as the offered MIDs in BUNDLE, and a later answer must match exactly
        ref: 2.8-20
        given: new RTCPeerConnection()
        exempt: no real remote peer (a hand-written remote answer)
        invariants: explicit
        Arrange: #142 の fixture を、BUNDLE も answer 側の独自 MID で書いた版にする (fixture の payload type は offer と異なるので invariant は検査しない)。
        do a.addTrack(new MediaStreamTrack({ kind: "audio" }))
        do a.addTrack(new MediaStreamTrack({ kind: "video" }))
        do a.createDataChannel("dc")
        a offer hold
        Act: 初回 answer として適用する。
        a setRemote issue142Answer
        Assert: 受理され、MID と BUNDLE の項目が offer の MID に読み替えられて transport を共有する。
        expect a.signalingState == "stable"
        expect a.getTransceivers().map((t) => t.mid) == ["0", "1"]
        expect bundleGroups(a.currentRemoteDescription.sdp) == [["0", "2", "1"]]
        let [audio, video] = a.getTransceivers()
        expect video.dtlsTransport is audio.dtlsTransport
        expect a.sctpTransport.dtlsTransport is audio.dtlsTransport
        expect a.dtlsTransports.length == 1
        Act: 再交渉で、同じ独自 MID の answer を適用する。session 確立後は MID の不一致を拒否し、状態は変わらない。
        a offer hold
        a setRemote issue142Answer rejects=InvalidModificationError
        Assert: pending offer のまま残る。
        expect a.signalingState == "have-local-offer"
      `,
      fns: { issue142Answer },
    },
    {
      text: `
        case: [2.8-41] a $bundlePolicy first offer keeps each m-line on its own transport and candidates until an answer accepts BUNDLE
        ref: 2.8-41
        given: {}
        each: [{ bundlePolicy: "max-compat" }, { bundlePolicy: "balanced" }]
        Arrange: audio + video の初回 offerer と、BUNDLE を受理する answerer。
        let a = new RTCPeerConnection({ bundlePolicy: "$bundlePolicy" })
        let b = new RTCPeerConnection()
        let [audioOut, videoOut] = [new MediaStreamTrack({ kind: "audio" }), new MediaStreamTrack({ kind: "video" })]
        let audio = a.addTransceiver(audioOut, { direction: "sendonly" })
        let video = a.addTransceiver(videoOut, { direction: "sendonly" })
        Act: offer を作って適用する。
        a offer hold
        Assert: offer は BUNDLE を提案するが、各 m-line は自分の transport を持ち、その transport の候補を広告する。
        let offer = local(a).sdp
        expect bundleGroups(offer) == [[audio.mid, video.mid]]
        expect audio.dtlsTransport isnt video.dtlsTransport
        expect advertised(offer, audio.mid).size > 0
        expect advertised(offer, audio.mid) == gathered(audio)
        expect advertised(offer, video.mid).size > 0
        expect advertised(offer, video.mid) == gathered(video)
        expect [...advertised(offer, audio.mid)].some((port) => advertised(offer, video.mid).has(port)) == false
        let proposed = heldTransports(a)
        Act: BUNDLE を受理した answer で確定する。
        b setRemote local(a)
        b answer
        Assert: tag の transport に統合され、余った transport は閉じる。
        expect video.dtlsTransport is audio.dtlsTransport
        let dropped = [...proposed].filter((t) => t !== audio.dtlsTransport)
        expect dropped.length == 1
        do assertTransportsClosed(dropped)
        Assert: 統合した transport で audio・video とも届く。
        do waitForPeersConnected(a, b)
        let received = (mid) => b.getTransceivers().find((t) => t.mid === mid).receiver.track
        rtp audioOut -> received(audio.mid)
        rtp videoOut -> received(video.mid)
      `,
      fns: { advertised, gathered },
    },
    `
      case: [2.8-43] a max-bundle first offer shares the tag's transport at the offer
      ref: 2.8-43
      given: new RTCPeerConnection({ bundlePolicy: "max-bundle" })
      exempt: no real remote peer (a local offer only)
      Arrange: max-bundle の初回 offerer (audio + video + DataChannel)。
      let audio = a.addTransceiver("audio", { direction: "sendonly" })
      let video = a.addTransceiver("video", { direction: "sendonly" })
      do a.createDataChannel("dc")
      Act: offer を作って適用する。
      a offer hold
      Assert: 全 m-line の ufrag が同じで、transport も tag (audio) のものを共有する。
      let offer = local(a).sdp
      let mids = offer.match(/^a=mid:\\S+/gm).map((line) => line.slice(6))
      expect new Set(mids.map((mid) => attribute(offer, mid, "ice-ufrag"))).size == 1
      expect video.dtlsTransport is audio.dtlsTransport
      expect a.sctpTransport.dtlsTransport is audio.dtlsTransport
      expect heldTransports(a).size == 1
    `,
    `
      case: [2.8-43] an m-line added to a session whose peer accepted BUNDLE shares the tag's transport at the offer
      ref: 2.8-43
      given: createDuplexSession()
      Arrange: BUNDLE を受理済みの session に audio を追加する。
      let audio = a.addTransceiver("audio", { direction: "sendonly" })
      Act: offer を作って適用する。
      a offer hold
      Assert: 新しい m-line は tag と同じ ufrag で、tag の transport を共有する。
      expect attribute(local(a).sdp, audio.mid, "ice-ufrag") == attribute(local(a).sdp, "0", "ice-ufrag")
      expect audio.dtlsTransport is aVideo.dtlsTransport
      expect heldTransports(a) == new Set([aVideo.dtlsTransport])
    `,
    `
      case: [2.8-47] an actpass answer makes a new association the DTLS client
      ref: 2.8-47
      given: createMutationSession("initial")
      Arrange: 初回 offer (actpass) と、全 m-line を a=setup:actpass にした remote answer。
      a offer hold
      expect local(a).sdp matches /^a=setup:actpass/m
      b setRemote local(a)
      do prepareMutationAnswerer(session)
      b answer hold
      Act: actpass の answer を適用する。
      a setRemote mutate(local(b).sdp, ["setupActpass"]) type=answer
      Assert: 受理され、新しい association の role は client になる。
      expect a.signalingState == "stable"
      expect a.dtlsTransports.map((t) => t.role) == a.dtlsTransports.map(() => "client")
    `,
    `
      case: [2.9-T8] the same offer replaces a pranswer a first negotiation connected and the final answer reconnects
      ref: 2.9-T8
      given: createInitialPranswerConnectionWithOffer()
      Arrange: 初回交渉の pranswer で ICE / DTLS を接続した peer。
      let out = a.getTransceivers()[0].sender.track
      Act: 最後に作った同じ offer を offerer に再適用する。
      a setLocal offer
      Assert: remote pranswer は先に rollback され、offerer は have-local-offer に戻る。
      expect a.signalingState == "have-local-offer"
      expect a.pendingRemoteDescription is null
      expect a.currentRemoteDescription is null
      Act: answerer に offer を渡し、final answer で確定する。
      b setRemote local(a)
      let received = b.getTransceivers()[0]
      do received.sender.replaceTrack(new MediaStreamTrack({ kind: "video" }))
      b answer
      Assert: final answer で接続し直し、RTP が届く。
      do waitForPeersConnected(a, b)
      expect a.signalingState == "stable"
      rtp out -> received.receiver.track
    `,
    {
      text: `
        case: [5-11] staged topology, candidate delivery, DTLS role and the answer's tags apply to the second BUNDLE group
        ref: 5-11
        given: createAudioOnlyPeer()
        exempt: no real remote peer (hand-written remote offers)
        Arrange: [0,1] と [2,3] の 2 つの BUNDLE group を確立した answerer。
        let sections = (ufrag) => [{ kind: "audio", mid: "0" }, { kind: "audio", mid: "1" }, { kind: "audio", mid: "2", ufrag: "groupbufrag" }, { kind: "audio", mid: "3", ufrag }]
        let twoGroups = buildRemoteSdp({ sections: sections("groupbufrag"), bundles: [["0", "1"], ["2", "3"]] })
        let splitSecond = buildRemoteSdp({ sections: sections("splitufrag"), bundles: [["0", "1"], ["2"], ["3"]] })
        do answerRemoteOffer(a, twoGroups)
        let [t0, t1, t2, t3] = a.getTransceivers()
        let [groupA, groupB] = [t0.dtlsTransport, t2.dtlsTransport]
        expect t3.dtlsTransport is groupB
        expect groupB isnt groupA
        Act: 2 つ目の group だけを分割する re-offer を適用する。
        a setRemote splitSecond
        Assert: pending 中は 2 つ目の group の共有 transport と remote 資格情報が変わらない。
        expect [t0, t1, t2, t3].map((t) => t.dtlsTransport) == [groupA, groupA, groupB, groupB]
        expect groupB.iceTransport.connection.remoteUsername == "groupbufrag"
        Act: rollback し、2 つ目の group の非 tag m-line (3) に候補と EOC を trickle する。
        a setRemote rollback
        a addCandidate trickleCandidate(50993, "groupbufrag", "3")
        a addCandidate { candidate: "", sdpMid: "3", usernameFragment: "groupbufrag" }
        Assert: 候補と EOC はその group の transport にだけ届く。
        waitFor groupB.iceTransport.connection.remoteCandidates.some((c) => c.port === 50993)
        waitFor groupB.iceTransport.connection.remoteCandidatesEnd
        expect groupA.iceTransport.connection.remoteCandidates.some((c) => c.port === 50993) == false
        expect groupA.iceTransport.connection.remoteCandidatesEnd == false
        expect groupA.iceTransport.connection.remoteUsername == REMOTE_UFRAG
        Act: 2 つ目の group を分割する re-offer に answer して確定する。
        let answer = answerRemoteOffer(a, splitSecond)
        Assert: answer の group と tag は offer と一致し、分割した m-line だけが新しい transport に移る。
        expect bundleGroups(answer) == [["0", "1"], ["2"], ["3"]]
        do expectTransportsMatchBundle(a)
        expect t2.dtlsTransport is groupB
        expect t3.dtlsTransport isnt groupB
        expect t3.dtlsTransport isnt groupA
        expect [t0.dtlsTransport, t1.dtlsTransport] == [groupA, groupA]
        invariants a
      `,
      fns: {
        createAudioOnlyPeer,
        buildRemoteSdp,
        answerRemoteOffer,
        expectTransportsMatchBundle,
        REMOTE_UFRAG,
      },
    },
  ],
  { fns: { attribute, bundleGroups } },
);

/**
 * Transitions run in both offerer directions (each peer is once the local
 * and once the remote offerer, which also swaps the DTLS roles). `a` is the
 * offerer and `b` the answerer of `createDirectedDuplexSession(from)`.
 */
for (const from of ["a", "b"] as const) {
  negotiationCases(
    `negotiation transaction spec coverage: transport (offerer=${from})`,
    [
      `
        case: [2.5-T3] an answer to an m-line outside the BUNDLE group offered with a=setup:active is passive
        ref: 2.5-T3
        given: createDirectedDuplexSession(from)
        Arrange: 新しい audio を BUNDLE 外に出した offer を作り、answerer に届く remote offer ではその m-line だけ a=setup:active にする。
        let audioOut = new MediaStreamTrack({ kind: "audio" })
        let audio = a.addTransceiver(audioOut, { direction: "sendonly" })
        let offer = createRewrittenOffer(a, (sdp) => leaveBundle(sdp, audio.mid))
        let mid = audio.mid
        let roles = [aVideo.dtlsTransport.role, bVideo.dtlsTransport.role]
        a setLocal offer
        let remoteOffer = mungeSection(local(a).sdp, mid, (s) => s.replace(/^a=setup:\\w+/m, "a=setup:active"))
        expect attribute(remoteOffer, mid, "setup") == "active"
        b setRemote remoteOffer
        Act: answer を作る。
        b createAnswer as=answer
        Assert: group 外の m-line は offer の逆の passive で答え、group は従来の role のまま。
        expect attribute(answer.sdp, mid, "setup") == "passive"
        expect attribute(answer.sdp, "0", "setup") == (bVideo.dtlsTransport.role === "client" ? "active" : "passive")
        Act: answer で確定する。
        b setLocal answer
        a setRemote answer
        let remoteAudio = b.getTransceivers().find((t) => t.mid === mid)
        Assert: 独立 transport の role は answerer が server、offerer が client。
        expect remoteAudio.dtlsTransport isnt bVideo.dtlsTransport
        expect remoteAudio.dtlsTransport.role == "server"
        expect audio.dtlsTransport.role == "client"
        expect [aVideo.dtlsTransport.role, bVideo.dtlsTransport.role] == roles
        Assert: 独立 transport で接続し、audio と既存 session が通じる。
        do Promise.all([waitForDtlsConnected(audio.dtlsTransport), waitForDtlsConnected(remoteAudio.dtlsTransport)])
        rtp audioOut -> remoteAudio.receiver.track
        alive
      `,
      `
        case: [5-2] an m-line without a common codec, its port 0 answer and duplicate applications keep the invariants
        ref: 5-2
        given: createDirectedDuplexSession(from)
        Arrange: 新しい video m-line を足した re-offer を作り、wire 上でその m-line を共通 codec のない提案にする。
        let extra = a.addTransceiver(new MediaStreamTrack({ kind: "video" }), { direction: "sendonly" })
        a createOffer as=offer
        let mid = extra.mid
        let unsupported = { type: "offer", sdp: withOnlyUnsupportedCodec(offer.sdp, mid) }
        a setLocal offer
        Act: 同じ remote offer を二重に適用する。
        b setRemote unsupported
        let transceivers = b.getTransceivers()
        b setRemote unsupported
        Assert: 二重適用で transceiver は増えず、pending 中は何も止まらず通信も続く。
        expect b.getTransceivers() == transceivers
        let rejecting = b.getTransceivers().find((t) => t.mid === mid)
        expect [rejecting.stopped, extra.stopped] == [false, false]
        alive
        Act: port 0 を含む answer を作り、pranswer を二重に適用してから確定する。
        b createAnswer as=answer
        expect sectionOf(answer.sdp, mid) matches /^m=video 0 /
        b setLocal answer type=pranswer
        a setRemote answer type=pranswer
        b setLocal answer type=pranswer
        a setRemote answer type=pranswer
        Assert: pranswer 中も拒否予定の m-line は止まらない。
        expect [rejecting.stopped, extra.stopped] == [false, false]
        b setLocal answer
        a setRemote answer
        Assert: commit で拒否予定の m-line だけが両側で停止し、既存 session は通じる。
        expect [rejecting.stopped, extra.stopped, aVideo.stopped, bVideo.stopped] == [true, true, false, false]
        alive
      `,
    ],
    { fns: { from, attribute } },
  );
}
