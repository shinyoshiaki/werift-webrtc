import {
  type MediaStreamTrack,
  RTCRtpCodecParameters,
  type RTCRtpReceiver,
  type RTCRtpSender,
  type RtpPacket,
  useH264,
  useNACK,
  usePLI,
  useREMB,
  useTWCC,
  useTransportWideCC,
  useVP8,
} from "../../src";
import type { RTCDtlsTransport as DtlsTransport } from "../../src/transport/dtls";
import {
  answerRemoteOffer,
  createBundlePairWithOutsideReoffer,
} from "../issue/705.helpers";
import { negotiationCases } from "./negotiationCaseRunner";
import { sendRawRtp, watchRtpText } from "./negotiationTransactionUtils";

/**
 * Spec coverage for codecs, RTCP feedback, routing keys and the develop
 * features inside the negotiation transaction (ticket 0ad06d37 sections
 * 2.4 / 2.5 / 2.6 / 2.8 / 5). Each test name starts with its requirement ID.
 * Every case ends with `expectSessionContinues` (next offer, ICE restart,
 * added DataChannel / transceiver, offer from the peer, traffic).
 */
negotiationCases("negotiation transaction spec coverage: codecs and feedback", [
  {
    text: `
    case: [2.4-T7b] NACK, transport-cc and PLI follow the codec of each packet, not the lowest payload type
    ref: 2.4-T7b
    given: createConnectedVideoPeers({ codecs: { video: [useH264({ rtcpFeedback: [] }), useVP8({ rtcpFeedback: [useNACK(), usePLI(), useTWCC()] })] } })
    Arrange: H264 (feedback なし) が小さい PT、VP8 (NACK・PLI・transport-cc) が大きい PT。
    let transceiver = a.getTransceivers()[0]
    let sender = transceiver.sender
    let receiver = b.getTransceivers()[0].receiver
    let h264 = payloadTypeOf(b.currentRemoteDescription.sdp, "H264")
    let vp8 = payloadTypeOf(b.currentRemoteDescription.sdp, "VP8")
    expect h264 < vp8
    let feedback = recordSenderFeedback(sender)
    Act: feedback のない H264 の PT で、欠落 (seq の飛び) を含む RTP を送る。
    do sendWithGap(transceiver, incoming, h264, 1000)
    sleep 200
    Assert: H264 のパケットでは NACK も transport-cc も始まらず、PLI も送らない。
    expect feedback.record.nacks == []
    expect receiver.receiverTWCC == undefined
    expect receiver.pliNegotiation(sender.ssrc) == { payloadType: h264, allowed: false }
    expect pliReaches(receiver, sender) is false
    Act: 同じ SSRC で NACK・PLI・transport-cc を持つ VP8 の PT の RTP を欠落付きで送る。
    do sendWithGap(transceiver, incoming, vp8, 2000)
    waitFor feedback.record.nacks.length !== 0 timeout=1000
    Assert: VP8 のパケットの欠落には NACK が相手 sender に届き、PLI も届く。
    expect feedback.record.nacks.flat() containsAll [2002, 2003]
    expect receiver.pliNegotiation(sender.ssrc) == { payloadType: vp8, allowed: true }
    expect pliReaches(receiver, sender) is true
    Assert: transport-cc も最小 PT (H264) ではなく、VP8 のパケットで開始する。
    expect receiver.receiverTWCC != undefined
    invariants b
    do feedback.stop()
  `,
    fns: {
      /** Act: seq first, first+1, first+4 (2 lost) on the sender's SSRC with `payloadType`; each must reach `incoming`. */
      sendWithGap: async (
        transceiver: { sender: RTCRtpSender; dtlsTransport: DtlsTransport },
        incoming: MediaStreamTrack,
        payloadType: number,
        first: number,
      ) => {
        for (const sequenceNumber of [first, first + 1, first + 4]) {
          const text = `t7b-${payloadType}-${sequenceNumber}`;
          const received = watchRtpText([incoming], text);
          await sendRawRtp(
            transceiver.dtlsTransport,
            { ssrc: transceiver.sender.ssrc, payloadType, sequenceNumber },
            Buffer.from(text),
          );
          await received;
        }
      },
    },
  },
  `
    case: [2.4-4] a remote pranswer that changes codec, RTX, RED and header extensions of the senders is fully undone by rollback
    ref: 2.4-4
    given: createConnectedSendParamPeers()
    Arrange: video (VP8+RTX、H264) と audio (RED+Opus) を送り、両方に MID と abs-send-time を交渉した session。
    let [video, audio] = a.getTransceivers()
    let before = [video.sender.snapshotSendParams(), audio.sender.snapshotSendParams()]
    let absSendTime = useAbsSendTime().uri
    expect before[0].codec?.name.toUpperCase() == "VP8"
    expect before[0].rtxPayloadType != undefined
    expect before[1].redRedundantPayloadType != undefined
    expect before[0].headerExtensions.map((e) => e.uri) contains absSendTime
    a offer
    b createAnswer as=answer
    Arrange: pranswer は video の VP8 (と その RTX) と audio の RED を外し、abs-send-time もなくす。
    let pranswer = withoutExtmap(withoutCodecs(withoutCodecs(answer.sdp, "video", ["VP8"]), "audio", ["red"]), absSendTime)
    Act: 送信パラメータを変える remote pranswer を offerer に適用する。
    a setRemote pranswer type=pranswer
    Assert: 再交渉の pranswer は送信パラメータを暫定的に pranswer の値にする (2.10)。
    let pending = [video.sender.snapshotSendParams(), audio.sender.snapshotSendParams()]
    expect pending[0].codec?.name.toUpperCase() == "H264"
    expect pending[0].rtxPayloadType == undefined
    expect pending[0].headerExtensions.map((e) => e.uri) lacks absSendTime
    expect pending[1].codec?.name.toLowerCase() == "opus"
    expect pending[1].redRedundantPayloadType == undefined
    Act: 両側で rollback する。
    a rollback
    Assert: codec・RTX・RED・header extension・MID・RID を含む送信パラメータが適用前と完全に一致する。
    expect video.sender.snapshotSendParams() == before[0]
    expect audio.sender.snapshotSendParams() == before[1]
    Assert: current の VP8 で RTP が届く。
    rtp outgoing -> incoming
  `,
  `
    case: [2.4-5] transport-cc feedback a re-offer adds starts only at the answer commit
    ref: 2.4-5
    given: createConnectedVideoPeersWith({ offerer: { codecs: { video: [useVP8()] }, headerExtensions: { video: [useTransportWideCC()] } }, answerer: { codecs: { video: [useVP8({ rtcpFeedback: [useNACK(), usePLI(), useREMB(), useTWCC()] })] }, headerExtensions: { video: [useTransportWideCC()] } } })
    Arrange: transport-cc の header extension は交渉済みだが、current の VP8 は transport-cc feedback を持たない。
    expect receiver.receiverTWCC == undefined
    a createOffer
    a setLocal
    let withTwcc = withRtcpFeedback(local(a).sdp, "VP8", "transport-cc")
    Act: VP8 に transport-cc を足した re-offer を answerer に適用する (answer はまだ)。
    b setRemote withTwcc type=offer
    Assert: pending 中は current の RTP に TWCC を始めず、feedback も送らない。
    expect twccFeedbackSent(outgoing, receiver) is false
    expect receiver.receiverTWCC == undefined
    Act: answer で確定する。
    b answer
    Assert: commit で TWCC が始まり、受信した RTP への transport-cc feedback を session に送る。
    expect b.currentLocalDescription.sdp matches /^a=rtcp-fb:\\d+ transport-cc/m
    expect receiver.receiverTWCC != undefined
    expect twccFeedbackSent(outgoing, receiver) is true
  `,
  {
    text: `
    case: [2.4-5] transport-cc feedback a pranswer packet started stops on rollback
    ref: 2.4-5
    given: createConnectedVideoPeersWith({ offerer: twccH264Config(), answerer: twccH264Config(), offererPreferences: [useVP8()] })
    Arrange: H264 (transport-cc 付き) と VP8 を設定し、初回は VP8 だけで確定した session。
    expect receiver.receiverTWCC == undefined
    Arrange: re-offer は H264 と VP8 の両方を提案し、answerer は H264 を先頭に答える。
    do transceiver.setCodecPreferences([])
    a offer
    b createAnswer as=answer
    expect offeredVideoCodecs(answer.sdp)[0] == "H264"
    Act: H264 の pranswer を両側に適用し、offerer が暫定の H264 で送る。
    b setLocal answer type=pranswer
    a setRemote answer type=pranswer
    Assert: transport-cc を交渉した H264 のパケット受信で TWCC が始まり、feedback を送る。
    expect sender.codec?.name.toUpperCase() == "H264"
    expect twccFeedbackSent(outgoing, receiver) is true
    expect receiver.receiverTWCC != undefined
    Act: 両側で rollback する。
    a rollback
    Assert: pending 中に始まった TWCC は止まり、current の VP8 の RTP には feedback を送らない。
    expect receiver.receiverTWCC == undefined
    expect sender.codec?.name.toUpperCase() == "VP8"
    expect twccFeedbackSent(outgoing, receiver) is false
    Assert: current の RTP は届き続ける。
    rtp outgoing -> incoming
  `,
    fns: {
      twccH264Config: () => ({
        codecs: {
          video: [
            useH264({
              rtcpFeedback: [useNACK(), usePLI(), useREMB(), useTWCC()],
            }),
            useVP8(),
          ],
        },
        headerExtensions: { video: [useTransportWideCC()] },
      }),
    },
  },
  `
    case: [2.4-7] a transceiver for a remote offer does not take the m-line of a committed inactive transceiver
    ref: 2.4-7
    given: createCommittedInactiveAudioPeers()
    Arrange: inactive な audio m-line (index 0) を確定させる。
    let kept = { mid: inactiveMid, mLineIndex: 0, currentDirection: "inactive", stopping: false, stopped: false }
    expect inactive.currentDirection == "inactive"
    do a.addTransceiver(new MediaStreamTrack({ kind: "audio" }), { direction: "sendonly" })
    a createOffer
    a setLocal
    Act: audio を追加した remote offer を answerer に適用する。
    b setRemote local(a)
    Assert: 新しい m-line には新しい transceiver が作られ、inactive な transceiver の枠は奪われない。
    expect inactive like kept
    expect b.getTransceivers()[0] is inactive
    let added = b.getTransceivers()[1]
    expect added isnt undefined
    expect added.mid isnt inactiveMid
    expect added.mLineIndex == 1
    Act: rollback する。
    b setRemote rollback
    Assert: rollback 後も inactive な transceiver はそのまま残る。
    expect inactive like kept
    expect b.getTransceivers()[0] is inactive
    expect b.getTransceivers() == [inactive]
    Act: 同じ offer を適用し直し、answer で確定する。
    b setRemote local(a)
    b answer
    Assert: 確定後も inactive な m-line は元の transceiver のまま、追加分は 2 本目の m-line。
    expect inactive like kept
    expect b.getTransceivers()[0] is inactive
    expect b.getTransceivers().length == 2
    expect b.getTransceivers()[1].mLineIndex == 1
  `,
  `
    case: [2.4-7] a remote offer that puts a new MID on a committed inactive (not rejected) m-line does not take it
    ref: 2.4-7
    given: createCommittedInactiveAudioPeers()
    Arrange: inactive な audio m-line (index 0、port 0 ではない) を確定させ、その位置に別の MID の sendonly audio を置いた offer を作る (拒否済みでない m-line の再利用)。
    let current = b.currentRemoteDescription.sdp
    a createOffer as=offer
    let recycled = mungeSection(offer.sdp, inactiveMid, (section) => section.replace(/^a=mid:\\S+/m, "a=mid:recycled").replace(/^a=inactive/m, "a=sendonly")).replace(/^a=group:BUNDLE [^\\r\\n]+/m, "a=group:BUNDLE recycled")
    expect SessionDescription.parse(recycled).media[0].port != 0
    Act: remote offer として適用する (受理でも拒否でもよい)。
    let outcome = b.setRemoteDescription({ type: "offer", sdp: recycled }).then(() => "accepted", (error) => error.name)
    Assert: remote offer のための transceiver は inactive な transceiver の枠を奪わない (停止も置き換えもされず、MID と m-line の位置を保つ)。
    expect b.getTransceivers() contains inactive
    expect inactive like { mid: inactiveMid, mLineIndex: 0, stopped: false, stopping: false }
    Assert: 拒否するなら状態を変えない (受理なら比較しない)。
    expect (outcome === "accepted" ? "stable" : b.signalingState) == "stable"
    expect (outcome === "accepted" ? current : b.currentRemoteDescription.sdp) is current
    invariants b
  `,
  `
    case: [2.4-7] an unassociated inactive addTransceiver() is associated by a remote offer only within the documented constraint and keeps its direction
    ref: 2.4-7
    given: createUnnegotiatedPeers()
    Arrange: answerer の app が inactive な未関連付けの audio transceiver を持つ。
    let appInactive = b.addTransceiver("audio", { direction: "inactive" })
    do a.addTransceiver(new MediaStreamTrack({ kind: "audio" }), { direction: "sendonly" })
    a createOffer
    a setLocal
    Act: audio の remote offer を適用する。
    b setRemote local(a)
    Assert: 既知の制約 (6 章) どおり app の transceiver に関連付けるが、app が選んだ inactive は remote offer で変えず、別の transceiver も作らない。
    expect b.getTransceivers() == [appInactive]
    expect appInactive.mid is a.getTransceivers()[0].mid
    expect appInactive.direction == "inactive"
    Act: rollback する。
    b setRemote rollback
    Assert: app の transceiver は未関連付けに戻り、inactive のまま残る。
    expect b.getTransceivers() == [appInactive]
    expect appInactive.mid is null
    expect appInactive.direction == "inactive"
    Act: 同じ offer に answer する。
    b setRemote local(a)
    b createAnswer as=answer
    Assert: answer の m-line は app の inactive を反映する (受信方向を奪わない)。
    expect answer.sdp matches /^a=inactive\\r?$/m
    b setLocal answer
    a setRemote local(b)
    expect appInactive.currentDirection == "inactive"
  `,
  `
    case: [2.5-16] createAnswer only proposes: sender, receive codec / RTX tables, TWCC and the remote track codec switch at the local answer commit
    ref: 2.5-16
    given: createVp8RtxSessionWithH264Reoffer()
    Arrange: VP8+RTX で確定した session に、H264(transport-cc)+RTX だけの re-offer が届いている。
    let receiver = answererTransceiver.receiver
    let sender = answererTransceiver.sender
    let remoteTrack = receiver.track
    let vp8 = payloadTypeOf(b.currentRemoteDescription.sdp, "VP8")
    let tablesBefore = receiver.snapshotReceiveTables()
    let sendBefore = sender.snapshotSendParams()
    expect sendBefore.codec?.name.toUpperCase() == "VP8"
    expect remoteTrack.codec?.name.toUpperCase() == "VP8"
    expect receiver.receiverTWCC == undefined
    Act: answer を作る (まだ適用しない)。
    b createAnswer as=answer
    Assert: answer は H264+RTX を提案するが、live の送受信は current のまま変わらない。
    expect offeredVideoCodecs(answer.sdp) == ["H264"]
    expect answer.sdp matches /^a=rtpmap:\\d+ rtx\\/90000/m
    expect sender.snapshotSendParams() == sendBefore
    expect receiver.snapshotReceiveTables() == tablesBefore
    expect receiver.receiverTWCC == undefined
    expect remoteTrack.codec?.name.toUpperCase() == "VP8"
    invariants b
    rtp offererOut -> remoteTrack
    Act: answer を適用して commit する。
    b setLocal answer
    a setRemote local(b)
    Assert: commit で sender・受信 codec/RTX 表・TWCC・remote track の codec が answer の値に切り替わる。
    let h264 = payloadTypeOf(answer.sdp, "H264")
    let rtx = Number(answer.sdp.match(new RegExp(\`^a=fmtp:(\\\\d+) apt=\${h264}\`, "m"))[1])
    expect sender.codec?.name.toUpperCase() == "H264"
    expect receiveCodecNames(receiver) == Object.fromEntries([[h264, "H264"], [rtx, "RTX"]])
    expect Object.keys(receiver.snapshotReceiveTables().codecs) lacks String(vp8)
    expect receiver.receiverTWCC != undefined
    expect remoteTrack.codec?.name.toUpperCase() == "H264"
    Assert: 確定した H264 で双方向に届く。
    rtp offererOut -> remoteTrack
    rtp answererOut -> offererTransceiver.receiver.track
  `,
  `
    case: [2.5-17] a rolled-back local offer leaves no pendingLocalOfferCodecs and the next offer resolves as before
    ref: 2.5-17
    given: createConnectedVideoPeers({ codecs: { video: [useVP8(), useH264()] } })
    Arrange: VP8 + H264 で確定した session (setCodecPreferences なし)。
    let transceiver = a.getTransceivers()[0]
    let baseline = { pending: transceiver.pendingLocalOfferCodecs, needsResolution: transceiver.codecPreferencesNeedResolution, codecs: transceiver.codecs.map((c) => c.payloadType) }
    a createOffer as=offer
    Act: local offer を適用する。
    a setLocal
    Assert: 適用中は offer の codec を pendingLocalOfferCodecs に持つ。
    expect transceiver.pendingLocalOfferCodecs?.map((c) => c.payloadType) == SessionDescription.parse(offer.sdp).media[0].rtp.codecs.map((c) => c.payloadType)
    Act: rollback する。
    a setLocal rollback
    Assert: rolled-back offer の pendingLocalOfferCodecs と再解決要求は baseline に戻る。
    expect transceiver.pendingLocalOfferCodecs == baseline.pending
    expect transceiver.codecPreferencesNeedResolution is baseline.needsResolution
    expect transceiver.codecs.map((c) => c.payloadType) == baseline.codecs
    Assert: 次の offer は rollback 前と同じ codec を提案し、確定後も RTP が届く。
    a createOffer as=next
    expect offeredVideoCodecs(next.sdp) == offeredVideoCodecs(offer.sdp)
    a setLocal next
    b setRemote local(a)
    b answer
    rtp outgoing -> incoming
  `,
  `
    case: [2.5-17] a rolled-back remote offer restores the re-resolution request an unapplied createOffer consumed while it was pending
    ref: 2.5-17
    given: createH264OnlyReoffer()
    Arrange: createAnswer 後の addTrack で、answer の H264 を commit しつつ再解決要求が残った answerer。
    b createAnswer as=answer
    do b.addTrack(new MediaStreamTrack({ kind: "video" }))
    b setLocal answer
    a setRemote local(b)
    expect transceiver.codecPreferencesNeedResolution is true
    let baselineCodecs = transceiver.codecs.map((c) => c.payloadType)
    a offer
    Act: remote offer の pending 中に自分の offer を作る (適用しない。再解決要求を消費する)。
    b createOffer as=unapplied
    Assert: 未適用の createOffer で再解決要求は消費され、codec は解決し直されている。
    expect offeredVideoCodecs(unapplied.sdp) == ["VP8", "H264"]
    expect transceiver.codecPreferencesNeedResolution is false
    Act: remote offer を rollback する。
    b rollback
    Assert: pending 中に消費した再解決要求と解決済み codec は baseline に戻る。
    expect transceiver.codecPreferencesNeedResolution is true
    expect transceiver.codecs.map((c) => c.payloadType) == baselineCodecs
    expect transceiver.pendingLocalOfferCodecs == undefined
    Assert: 次の自分の offer は設定から解決し直す (VP8 と H264)。
    b createOffer as=next
    expect offeredVideoCodecs(next.sdp) == ["VP8", "H264"]
  `,
  `
    case: [2.6-T1b] the configured SCTP MTU is kept when SCTP moves to another DTLS transport, on rollback and at the answer
    ref: 2.6-T1b
    given: createPeerPair({}, { sctp: { mtu: 1052 } })
    Arrange: MTU を設定した answerer が先に DataChannel を作り (SCTP は自分の transport)、video と DataChannel を同じ BUNDLE にした offer を受ける。
    do a.addTransceiver(new MediaStreamTrack({ kind: "video" }), { direction: "sendonly" })
    let channel = a.createDataChannel("mtu")
    do b.createDataChannel("answerer-own")
    let sctp = b.sctpTransport
    let ownTransport = sctp.dtlsTransport
    expect sctp.sctp.mtu == 1052
    a createOffer
    a setLocal
    Act: remote offer を適用する (SCTP は BUNDLE tag の video の transport へ移る)。
    b setRemote local(a)
    Assert: 別 DTLS transport へ移った SCTP も設定の MTU を使う。
    expect b.sctpTransport is sctp
    expect sctp.dtlsTransport isnt ownTransport
    expect sctp.sctp.mtu == 1052
    Act: rollback する。
    b setRemote rollback
    Assert: 元の DTLS transport に戻した SCTP も設定の MTU を使う。
    expect b.sctpTransport.dtlsTransport is ownTransport
    expect b.sctpTransport.sctp.mtu == 1052
    Act: 同じ offer を適用し直して answer で確定する。
    start remote = b.onDataChannel.watch((c) => c.label === "mtu")
    b setRemote local(a)
    b answer
    Assert: 確定した SCTP も設定の MTU で、DataChannel が実際に届く。
    expect b.sctpTransport.sctp.mtu == 1052
    let [received] = remote
    data channel -> received
    invariants
  `,
  `
    case: [2.6-T4e] answering with a track source codec does not adopt it into the configured codecs
    ref: 2.6-T4e
    given: createPeerPair({ codecs: { video: [useVP8(), useH264()] } }, { codecs: { video: [useVP8(), useH264()] } })
    Arrange: VP8 → H264 の順に設定し、H264 source の track を addTrack した answerer が VP8/H264 の offer を受ける。
    let offererOut = new MediaStreamTrack({ kind: "video" })
    let offererTransceiver = a.addTransceiver(offererOut, { direction: "sendrecv" })
    let h264Source = new MediaStreamTrack({ kind: "video", codec: useH264() })
    let answererSender = b.addTrack(h264Source)
    let answererTransceiver = b.getTransceivers()[0]
    expect answererTransceiver.sender is answererSender
    let configured = () => b.getConfiguration().codecs.video.map((c) => \`\${c.mimeType}/\${c.payloadType}\`)
    let before = configured()
    a createOffer
    a setLocal
    expect offeredVideoCodecs(local(a).sdp) == ["VP8", "H264"]
    Act: remote offer を適用し、answer を作って両側に適用する。
    b setRemote local(a)
    b createAnswer as=answer
    b setLocal answer
    a setRemote local(b)
    do waitForPeersConnected(a, b)
    Assert: answer は develop の規則 (track source との積) で H264 だけを答え、事前検証は拒否しない。
    expect b.getTransceivers() == [answererTransceiver]
    expect offeredVideoCodecs(answer.sdp) == ["H264"]
    expect answererTransceiver.sender.codec?.name.toUpperCase() == "H264"
    Assert: track の codec は設定へ採用されず、設定の codec 順と PT は変わらない。
    expect configured() == before
    Assert: H264 で双方向に届く。
    rtp h264Source -> offererTransceiver.receiver.track
    rtp offererOut -> answererTransceiver.receiver.track
  `,
  `
    case: [2.6-T4g] a remote answer keeps the answerer's codec order for the offerer's codecs and sender
    ref: 2.6-T4g
    given: createPeerPair({ codecs: { video: [useVP8(), useH264()] } }, { codecs: { video: [useH264(), useVP8()] } })
    Arrange: offerer は VP8 → H264、answerer は H264 → VP8 の順で設定する。
    let outgoing = new MediaStreamTrack({ kind: "video" })
    let transceiver = a.addTransceiver(outgoing, { direction: "sendonly" })
    a createOffer
    a setLocal
    expect offeredVideoCodecs(local(a).sdp) == ["VP8", "H264"]
    b setRemote local(a)
    b answer hold
    Act: H264 → VP8 の answer を offerer に remote answer として適用する。
    a setRemote local(b)
    do waitForPeersConnected(a, b)
    Assert: offerer の確定 SDP・transceiver の codec・送信 codec は answer の順 (H264 先頭) を保つ。
    expect offeredVideoCodecs(a.currentRemoteDescription.sdp) == ["H264", "VP8"]
    expect transceiver.codecs.map((c) => c.name.toUpperCase()).filter((name) => name !== "RTX") == ["H264", "VP8"]
    expect transceiver.sender.codec?.name.toUpperCase() == "H264"
    Assert: answer の順の codec で RTP が届く。
    rtp outgoing -> b.getTransceivers()[0].receiver.track
  `,
  `
    case: [2.6-T4h] the local answer commit $change transport-cc with the answered codec without a preference change
    ref: 2.6-T4h
    given: {}
    each: [
      { change: "stops", twccCodec: "VP8", currentTwcc: true, starts: false },
      { change: "starts", twccCodec: "H264", currentTwcc: false, starts: true },
    ]
    Arrange: current は VP8、H264 だけの re-offer を answerer に適用済み。transport-cc feedback は twccCodec の codec だけが持つ。
    let peers = closing(await createTwccH264OnlyReoffer("$twccCodec"))
    let a = peers.offerer
    let b = peers.answerer
    let receiver = peers.receiver
    expect !!receiver.receiverTWCC is $currentTwcc
    Act: preference を変えずに answer を作って commit する。
    b answer
    Assert: 受信表と remote track の codec は H264 に、TWCC は H264 の feedback に置き換わる。
    expect Object.values(receiveCodecNames(receiver)) == ["H264"]
    expect peers.incoming.codec?.name.toUpperCase() == "H264"
    expect !!receiver.receiverTWCC is $starts
    Assert: 受信した RTP に transport-cc feedback を送るか (starts) / 送らないか (stops)。
    expect twccFeedbackSent(peers.outgoing, receiver) is $starts
    rtp peers.outgoing -> peers.incoming
  `,
  {
    text: `
    case: [2.8-36] a remote-created transceiver the application keeps returns to its created codecs and has no routes after rollback
    ref: 2.8-36
    given: createInitialPranswerConnection()
    Arrange: 初回 pranswer で remote 起因の transceiver に codec・受信経路が付いている。
    expect remoteCreated.codecs.length > 0
    expect routesTo(b, remoteCreated.receiver) > 0
    Act: answerer で remote offer を rollback する。
    b setRemote rollback
    Assert: app が使う transceiver は残り、作成時の状態 (MID・direction・codec なし) に戻る。
    expect b.getTransceivers() contains remoteCreated
    expect remoteCreated like { mid: null, currentDirection: null, direction: "recvonly", codecs: [] }
    expect remoteCreated.sender.codec == undefined
    expect remoteCreated.receiver.snapshotReceiveTables() == { codecs: {}, ssrcByRtx: {}, stagedCodecs: {}, stagedSsrcByRtx: {} }
    Assert: 受信経路 (SSRC / MID+RID) はどれもその receiver を指さない。
    expect routesTo(b, remoteCreated.receiver) == 0
  `,
    fns: {
      /** How many SSRC / RID routes of `pc`'s router lead to `endpoint`. */
      routesTo: (pc: unknown, endpoint: RTCRtpReceiver) => {
        const { router } = pc as {
          router: {
            ssrcTable: Record<number, unknown>;
            ridTable: Record<string, unknown>;
          };
        };
        return [
          ...Object.values(router.ssrcTable),
          ...Object.values(router.ridTable),
        ].filter((e) => e === endpoint).length;
      },
    },
  },
  `
    case: [2.8-39] rolling back a first pranswer returns both peers' send and receive codecs to the unnegotiated state
    ref: 2.8-39
    given: createVp8H264AnsweringPeers()
    Arrange: answerer は H264 だけを選んだ answer を初回 pranswer として両側に適用し、H264 で通信する。
    do answererTransceiver.setCodecPreferences([useH264()])
    b pranswer
    do waitForPeersConnected(a, b)
    expect offererTransceiver.sender.codec?.name.toUpperCase() == "H264"
    expect answererTransceiver.sender.codec?.name.toUpperCase() == "H264"
    rtp offererOut -> answererTransceiver.receiver.track
    Act: 両側で初回交渉を rollback する。
    b rollback
    Assert: 送信 codec と受信表は pranswer 前 (未交渉) に戻る。
    expect offererTransceiver.sender.codec == undefined
    expect receiveCodecNames(offererTransceiver.receiver) == {}
    expect answererTransceiver.sender.codec == undefined
    expect receiveCodecNames(answererTransceiver.receiver) == {}
    Act: 改めて preference なしで交渉する。
    do answererTransceiver.setCodecPreferences([])
    a offer
    let answererSide = b.getTransceivers()[0]
    do answererSide.setDirection("sendrecv")
    do answererSide.sender.replaceTrack(answererOut)
    b answer
    do waitForPeersConnected(a, b)
    Assert: 新しい交渉は VP8 で確定し、invariant を満たして届く。
    expect offererTransceiver.sender.codec?.name.toUpperCase() == "VP8"
    rtp offererOut -> answererSide.receiver.track
  `,
  `
    case: [5-7] PLI stays negotiated after a rolled-back re-offer that removes NACK/PLI for the same SSRC
    ref: 5-7
    given: createConnectedVideoPeers()
    Arrange: 接続済み session は PLI を交渉済みで、実際に届く。
    let sender = a.getTransceivers()[0].sender
    let receiver = b.getTransceivers()[0].receiver
    expect pliReaches(receiver, sender) is true
    Act: 同じ SSRC の VP8 から NACK/PLI を外した re-offer を pending にする。
    a createOffer
    a setLocal
    b setRemote rewriteVideoFeedback(local(a).sdp, "remove") type=offer
    Assert: pending 中は current の受信 codec のまま PLI が届く。
    expect pliReaches(receiver, sender) is true
    Act: 両側で rollback する。
    b rollback
    Assert: rollback 後も current の設定に戻ったまま PLI が届く。
    expect pliReaches(receiver, sender) is true
  `,
  {
    text: `
    case: [5-7] PLI follows the receive codec table $negotiated NACK/PLI, not a remote track codec rewritten $rewritten it
    ref: 5-7
    given: {}
    each: [
      { negotiated: "with", rewritten: "without", reached: true },
      { negotiated: "without", rewritten: "with", reached: false },
    ]
    Arrange: NACK/PLI を交渉した (または交渉しない) session で、受信 track の codec を逆の feedback に書き換える。
    let peers = closing(await createConnectedVideoPeers("$negotiated" === "with" ? {} : videoWithoutFeedback))
    let a = peers.offerer
    let b = peers.answerer
    let sender = a.getTransceivers()[0].sender
    let receiver = b.getTransceivers()[0].receiver
    [negotiated=with] do setTrackFeedback(peers.incoming, [])
    [negotiated=without] do setTrackFeedback(peers.incoming, [useNACK(), usePLI()])
    Act: PLI を要求する。
    let reached = pliReaches(receiver, sender)
    Assert: PLI の可否は track の codec ではなく、受信 codec 表 (current SDP) の feedback に従う。
    expect reached is $reached
    invariants b
  `,
    fns: {
      /** Arrange: replace `track.codec` with a copy whose RTCP feedback is `rtcpFeedback`. */
      setTrackFeedback: (
        track: MediaStreamTrack,
        rtcpFeedback: RTCRtpCodecParameters["rtcpFeedback"],
      ) => {
        track.codec = new RTCRtpCodecParameters({
          ...track.codec!,
          rtcpFeedback,
        });
      },
    },
  },
  {
    text: `
    case: [5-13] RTX packets resolve to the current media SSRC while a re-pairing is pending and after $finish
    ref: 5-13
    given: createConnectedVideoPeersWithRtx()
    each: ANSWER_OR_ROLLBACK
    Arrange: RTX 付きで接続済み。FID の RTX SSRC はそのまま、対のメディア SSRC を変えた re-offer を作る。
    a createOffer as=offer
    let [, mediaSsrc, rtxSsrc] = offer.sdp.match(/^a=ssrc-group:FID (\\d+) (\\d+)/m).map(Number)
    let rtxPt = payloadTypeOf(offer.sdp, "rtx")
    let repaired = offer.sdp.split(String(mediaSsrc)).join("999333")
    let transport = a.getTransceivers()[0].dtlsTransport
    let receiver = b.getTransceivers()[0].receiver
    Act: RTX の対応を変える remote offer を適用し、RTX パケットを送る。
    b setRemote repaired type=offer
    let pending = sendRtx(transport, receiver, { ssrc: rtxSsrc, payloadType: rtxPt, sequenceNumber: 3001 }, 3000, "rtx-pending-$finish")
    Assert: pending 中は current の対応のメディア SSRC として current の track に届く。
    expect pending.packet.header.ssrc == mediaSsrc
    expect pending.track is incoming
    Act: answer で確定する、または rollback してから RTX を送る。
    b finish $finish
    let after = sendRtx(transport, receiver, { ssrc: rtxSsrc, payloadType: rtxPt, sequenceNumber: 3002 }, 3001, "rtx-after-$finish")
    Assert: 確定後は新しい対のメディア SSRC、rollback 後は元の SSRC として復元される。
    [finish=answer] expect after.packet.header.ssrc == 999333
    [finish=answer] expect after.track is receiver.trackBySSRC[999333]
    [finish=rollback] expect after.packet.header.ssrc == mediaSsrc
    [finish=rollback] expect after.track is receiver.trackBySSRC[mediaSsrc]
    [finish=rollback] expect after.track is incoming
    invariants b
  `,
    fns: {
      /**
       * Act: one RTX packet with `header` whose payload is the original
       * sequence number `osn` (2 bytes) + `text`; resolves with the track
       * of `receiver` that got the repaired packet and that packet.
       */
      sendRtx: async (
        transport: DtlsTransport,
        receiver: RTCRtpReceiver,
        header: { ssrc: number; payloadType: number; sequenceNumber: number },
        osn: number,
        text: string,
      ): Promise<{ track: MediaStreamTrack; packet: RtpPacket }> => {
        const prefix = Buffer.alloc(2);
        prefix.writeUInt16BE(osn);
        const received = watchRtpText(receiver.tracks, text);
        await sendRawRtp(
          transport,
          header,
          Buffer.concat([prefix, Buffer.from(text)]),
        );
        return received;
      },
    },
  },
  `
    case: [5-13] RTP that carries a header extension under its new id arrives after the answer commits the move
    ref: 5-13
    given: createSimulcastPeers()
    Arrange: RID 拡張の URI を未使用の ID 12 へ移した re-offer を answerer に適用する。
    a createOffer as=created
    let offer = setExtmapId(created.sdp, useSdesRTPStreamId().uri, 12)
    expect offer contains \`a=extmap:12 \${useSdesRTPStreamId().uri}\`
    b setRemote offer type=offer
    let current = b.currentRemoteDescription.sdp
    let midExtensionId = extmapId(current, useSdesMid().uri)
    let payloadType = payloadTypeOf(current, "VP8")
    Act: answer で確定し、新しい ID 12 で RID を載せた RTP を送る。
    b finish answer
    let track = b.getTransceivers()[0].receiver.trackByRID.high
    start received = watchRtpText([track], "new-extension-id")
    do sendRawRtp(a.getTransceivers()[0].dtlsTransport, { ssrc: 7777, payloadType, sequenceNumber: 500, extensions: [{ id: midExtensionId, payload: Buffer.from(firstMid) }, { id: 12, payload: Buffer.from("high") }] }, Buffer.from("new-extension-id"))
    Assert: 新しい ID の RID で high 層の track に届く。
    await received
    invariants b
  `,
  `
    case: [5-13] RTP received while a fmtp change is staged is decoded with the current fmtp until $finish
    ref: 5-13
    given: createConnectedVideoPeers()
    each: ANSWER_OR_ROLLBACK
    Arrange: 接続済みの VP8 に fmtp を足した re-offer を作る。
    let receiver = b.getTransceivers()[0].receiver
    a createOffer as=offer
    let pt = payloadTypeOf(offer.sdp, "VP8")
    let currentFmtp = receiver.snapshotReceiveTables().codecs[pt].parameters
    let changed = offer.sdp.replace(new RegExp(\`^(a=rtpmap:\${pt} VP8/90000)\`, "m"), "$1\\r\\na=fmtp:" + pt + " max-fr=30")
    Act: fmtp を変える remote offer を適用し、RTP を送る。
    b setRemote changed type=offer
    Assert: fmtp の変更は staged で、pending 中の RTP は current の fmtp の codec で処理されて届く。
    let tables = receiver.snapshotReceiveTables()
    expect tables.codecs[pt].parameters is currentFmtp
    expect tables.stagedCodecs[pt]?.parameters is "max-fr=30"
    rtp outgoing -> incoming
    invariants b
    Act: answer で確定する、または rollback する。
    b finish $finish
    Assert: 確定すると新しい fmtp に、rollback なら current の fmtp に戻り、RTP が届く。
    [finish=answer] expect receiver.snapshotReceiveTables().codecs[pt].parameters is "max-fr=30"
    [finish=rollback] expect receiver.snapshotReceiveTables().codecs[pt].parameters is currentFmtp
    expect receiver.snapshotReceiveTables().stagedCodecs == {}
    rtp outgoing -> incoming
    invariants b
  `,
  {
    text: `
    case: [5-K14] an m-line outside the offered BUNDLE group offered with a=setup:active is answered passive (RFC 8842 section 5.3)
    ref: 5-K14
    given: createBundlePairWithOutsideReoffer({ reofferFrom: "callee" })
    exempt: the 705 helper's offer misdescribes the outside m-line ICE credentials (outsideufrag) the callee does not use, so the caller cannot continue
    invariants: explicit
    Arrange: 初回 offerer (DTLS server) の caller に、callee が group 外の audio を a=setup:active で提案する re-offer を用意する (705 helper の actpass を active にする)。
    let activeOffer = mungeSection(outsideOffer, outsideMid, (section) => section.replace(/^a=setup:actpass/m, "a=setup:active"))
    expect activeOffer != outsideOffer
    Act: re-offer に answer して確定する。
    let answer = answerRemoteOffer(caller, activeOffer)
    Assert: group 外の m-line は offer の逆の passive で答え、その独立 transport は server になる。
    expect SessionDescription.parse(answer).media.find((media) => media.rtp.muxId === outsideMid).dtlsParams?.role == "server"
    expect answer matches /^a=setup:passive\\r?$/m
    expect caller.getTransceivers().map((t) => [t.mid, t.dtlsTransport.role]) == [["0", "server"], ["1", "server"], [outsideMid, "server"]]
  `,
    fns: { createBundlePairWithOutsideReoffer, answerRemoteOffer },
  },
]);
