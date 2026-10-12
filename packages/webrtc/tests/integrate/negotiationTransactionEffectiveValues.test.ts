import { negotiationCases } from "./negotiationCaseRunner";

/**
 * Values a renegotiation pranswer makes effective before the final answer
 * (NEGOTIATION_TRANSACTION.md "Effective values while pending"). The runner
 * checks every value against `expectedLive` (the invariants) after each
 * operation; these scenarios drive the ones the matrix does not change.
 * Video is MID "0".
 */
negotiationCases(
  "negotiation effective values while a renegotiation is pending",
  [
    `
    case: a pranswer sends with its codec on both sides until $finish
    ref: 2.2-1 2.2-8 2.2-9 2.4-4 2.10-2
    given: createDuplexSession({ codecs: { video: [useVP8(), useH264()] } })
    each: ANSWER_OR_ROLLBACK
    Arrange: VP8 で確立した後、answerer が H264 だけを選んだ answer を用意する。
    a offer
    do bVideo.setCodecPreferences([useH264()])
    b createAnswer as=answer
    let sendCodecs = () => [aVideo, bVideo].map((t) => t.sender.codec?.mimeType.toLowerCase())
    Act: H264 の pranswer を両側に適用する。
    b setLocal answer type=pranswer
    a setRemote answer type=pranswer
    Assert: 再交渉の pranswer 中は両側とも pranswer の H264 で送り、届く。
    expect sendCodecs() == ["video/h264", "video/h264"]
    alive
    Act: 同じ内容の final answer で commit する、または両側で rollback する。
    [finish=answer] b setLocal answer
    [finish=answer] a setRemote answer
    [finish=rollback] a rollback
    Assert: answer なら H264 のまま確定し、rollback なら両側とも current の VP8 に戻る。
    [finish=answer] expect sendCodecs() == ["video/h264", "video/h264"]
    [finish=rollback] expect sendCodecs() == ["video/vp8", "video/vp8"]
    Assert: 確定 / 復元した codec で双方向に届く。
    alive
  `,
    `
    case: SSRCs only a replaced pranswer announced stop routing at the final answer
    ref: 2.1-4 2.2-7 2.2-13 2.2-14 2.4-1 2.5-13 2.10-4
    given: createDuplexSession()
    Arrange: answerer の video SSRC を wire 上で pranswer 用と final 用に書き換える。
    a offer
    b createAnswer as=answer
    let original = Number(ssrcOf(answer.sdp, "0"))
    let withSsrc = (ssrc) => mungeSection(answer.sdp, "0", (section) => section.replaceAll(\`a=ssrc:\${original} \`, \`a=ssrc:\${ssrc} \`))
    let receiver = aVideo.receiver
    Act: 別 SSRC の pranswer を offerer に適用する。
    b setLocal answer type=pranswer
    a setRemote withSsrc(1111) type=pranswer
    Assert: pranswer の SSRC が新たに route され、current の SSRC も残る。
    expect a.router.ssrcTable[1111] is receiver
    expect a.router.ssrcTable[original] is receiver
    Act: 別 SSRC の replacement pranswer を適用する。
    a setRemote withSsrc(3333) type=pranswer
    Assert: 置き換えられた pranswer の SSRC は route から外れる。
    expect a.router.ssrcTable[3333] is receiver
    expect Object.keys(a.router.ssrcTable) lacks "1111"
    Act: さらに別 SSRC の final answer で commit する。
    b setLocal answer
    a setRemote withSsrc(2222) type=answer
    Assert: final answer の SSRC が route され、置き換えられた pranswer だけの SSRC は届かなくなる (確定済み session の SSRC は develop と同じく残る)。
    expect a.router.ssrcTable[2222] is receiver
    expect Object.keys(a.router.ssrcTable) lacks "3333"
    expect a.router.ssrcTable[original] is receiver
  `,
    `
    case: a first pranswer with other SSRCs leaves the receiver's track to the final answer's SSRC
    ref: 2.4-T6 2.10-4
    given: createMutationSession("initial")
    Arrange: 初回交渉で、answerer の video SSRC を wire 上で書き換えた pranswer を用意する。
    a offer
    do prepareMutationAnswerer(session)
    b createAnswer as=answer
    Act: 別 SSRC の pranswer を適用し、offerer の track を控える。
    b setLocal answer type=pranswer
    a setRemote mutate(answer.sdp, ["ssrcChanged"]) type=pranswer
    let track = aVideo.receiver.track
    Act: 実際の SSRC の final answer で確定する。
    b setLocal answer
    a setRemote answer
    do waitForMutationSession(session)
    Assert: receiver の track は同じ object のまま final answer の SSRC を受け取る。
    expect aVideo.receiver.track is track
    expect aVideo.receiver.tracks == [track]
    do expectMediaAlive(session, "first-pranswer-ssrc")
  `,
    `
    case: a transport a no-BUNDLE first pranswer added stays closed after the BUNDLE answer
    ref: 2.2-13 2.10-9
    given: createMutationSession("initial")
    Arrange: 初回交渉で、BUNDLE なしの pranswer で transport を分けさせる。
    a offer
    do prepareMutationAnswerer(session)
    b createAnswer as=answer
    b setLocal answer type=pranswer
    a setRemote mutate(answer.sdp, ["noBundle"]) type=pranswer
    let split = heldTransports(a)
    Act: BUNDLE の final answer で確定し、中断された checks が終わるのを待つ。
    b setLocal answer
    a setRemote answer
    let dropped = [...split].filter((transport) => !heldTransports(a).has(transport))
    sleep 200
    Assert: 外した transport の ICE は failed にならず closed のまま。
    expect dropped.length > 0
    expect dropped.filter((transport) => transport.iceTransport.state !== "closed") == []
    invariants
  `,
  ],
);
