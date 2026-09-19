import { vi } from "vitest";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpHeader,
  RtpPacket,
  useH264,
  useOPUS,
  useTWCC,
  useVP8,
} from "../../src";
import { applyCodecPreferences } from "../../src/media/codecCompatibility";
import { setTrackSourceCodecs } from "../../src/media/track";

function videoTrack(codec?: RTCRtpCodecParameters) {
  return new MediaStreamTrack({ kind: "video", codec });
}

function codecNames(pc: RTCPeerConnection) {
  return pc
    .getTransceivers()[0]
    .codecs.map((codec) => codec.mimeType.toLowerCase());
}

describe("codec resolution", () => {
  test("RED preference preserves its sending position before primary codec", () => {
    const opus = new RTCRtpCodecParameters({
      mimeType: "audio/opus",
      clockRate: 48_000,
      channels: 2,
      payloadType: 96,
    });
    const red = new RTCRtpCodecParameters({
      mimeType: "audio/red",
      clockRate: 48_000,
      channels: 2,
      payloadType: 97,
      parameters: "96/96",
    });

    // 実行: RED を送信 codec の先頭として preference に指定する。
    const resolved = applyCodecPreferences([opus, red], [red, opus]);

    // 検証: RED と参照先 primary の順序を維持する。
    expect(resolved.map((codec) => codec.mimeType.toLowerCase())).toEqual([
      "audio/red",
      "audio/opus",
    ]);
  });

  test("fixed H264 source is rejected by a VP8-only connection", () => {
    const pc = new RTCPeerConnection({ codecs: { video: [useVP8()] } });

    // Act: fixed H264 track を capability に追加する。
    const act = () => pc.addTrack(videoTrack(useH264()));

    // Assert: capability は暗黙に拡張されず同期的に失敗する。
    expect(act).toThrow(expect.objectContaining({ name: "NotSupportedError" }));
    expect(pc.getTransceivers()).toHaveLength(0);
    pc.close();
  });

  test("source constraint and preferences are independent", async () => {
    const pc = new RTCPeerConnection({
      codecs: { video: [useVP8(), useH264()] },
    });
    const sender = pc.addTrack(videoTrack(useH264()));
    const transceiver = pc
      .getTransceivers()
      .find((item) => item.sender === sender)!;
    transceiver.setCodecPreferences([useVP8(), useH264()]);

    // Act: offer 作成時に capability・source・preference を解決する。
    const offer = await pc.createOffer();

    // Assert: source constraint により H264 だけが残る。
    expect(codecNames(pc)).toEqual(["video/h264"]);
    expect(offer.sdp.toLowerCase()).toContain("h264/90000");
    expect(offer.sdp.toLowerCase()).not.toContain("vp8/90000");
    pc.close();
  });

  test("raw source keeps all capabilities and preferences can be cleared", async () => {
    const pc = new RTCPeerConnection({
      codecs: { video: [useVP8(), useH264()] },
    });
    const sender = pc.addTrack(videoTrack());
    const transceiver = pc
      .getTransceivers()
      .find((item) => item.sender === sender)!;
    transceiver.setCodecPreferences([useH264()]);
    transceiver.setCodecPreferences([]);

    // Act: 空配列で preference を解除して offer を作成する。
    await pc.createOffer();

    // Assert: raw source には全 capability が残る。
    expect(codecNames(pc)).toEqual(["video/vp8", "video/h264"]);
    pc.close();
  });

  test("preference that excludes the fixed source fails at offer", async () => {
    const pc = new RTCPeerConnection({
      codecs: { video: [useVP8(), useH264()] },
    });
    const sender = pc.addTrack(videoTrack(useH264()));
    const transceiver = pc
      .getTransceivers()
      .find((item) => item.sender === sender)!;
    transceiver.setCodecPreferences([useVP8()]);

    // Act / Assert: preference 適用後に codec が無ければ明示的に失敗する。
    await expect(pc.createOffer()).rejects.toMatchObject({
      name: "NotSupportedError",
    });
    pc.close();
  });

  test("H264 profile and packetization mode constrain capability", () => {
    const source = useH264({
      parameters: "profile-level-id=42c00a;packetization-mode=0",
    });
    const mismatch = new RTCPeerConnection({
      codecs: { video: [useH264()] },
    });

    // Act / Assert: fmtp が異なる capability は利用できない。
    expect(() => mismatch.addTransceiver(videoTrack(source))).toThrow(
      expect.objectContaining({ name: "NotSupportedError" }),
    );
    mismatch.close();

    const match = new RTCPeerConnection({
      codecs: {
        video: [
          useH264({
            parameters: "profile-level-id=42c00a;packetization-mode=0",
          }),
        ],
      },
    });
    expect(() => match.addTrack(videoTrack(source))).not.toThrow();
    match.close();
  });

  test("per-track constraints do not mutate PC codecs and retain RTX", async () => {
    const vp8 = useVP8({ payloadType: 96 });
    const h264 = useH264({ payloadType: 97 });
    const rtx = new RTCRtpCodecParameters({
      mimeType: "video/rtx",
      clockRate: 90_000,
      payloadType: 98,
      parameters: "apt=97",
    });
    const pc = new RTCPeerConnection({ codecs: { video: [vp8, h264, rtx] } });
    const h264Sender = pc.addTrack(videoTrack(useH264()));
    const vp8Sender = pc.addTrack(videoTrack(useVP8()));

    // Act: 同一 PC 上で異なる fixed source を解決する。
    await pc.createOffer();
    const transceivers = pc.getTransceivers();
    const h264Transceiver = transceivers.find(
      (item) => item.sender === h264Sender,
    )!;
    const vp8Transceiver = transceivers.find(
      (item) => item.sender === vp8Sender,
    )!;

    // Assert: 各 transceiver は独立し、RTX は参照先 codec にだけ追従する。
    expect(
      h264Transceiver.codecs.map((codec) => codec.name.toLowerCase()),
    ).toEqual(["h264", "rtx"]);
    expect(
      vp8Transceiver.codecs.map((codec) => codec.name.toLowerCase()),
    ).toEqual(["vp8"]);
    expect(
      pc
        .getConfiguration()
        .codecs.video?.map((codec) => codec.name.toLowerCase()),
    ).toEqual(["vp8", "h264", "rtx"]);
    pc.close();
  });

  test("RED is retained only when all referenced primary codecs remain", async () => {
    const codecs = () => [
      useVP8({ payloadType: 96 }),
      useH264({ payloadType: 97 }),
      new RTCRtpCodecParameters({
        mimeType: "video/red",
        clockRate: 90_000,
        payloadType: 98,
        parameters: "96/97",
      }),
    ];
    const partialTrack = videoTrack();
    setTrackSourceCodecs(partialTrack, [useVP8()]);
    const partial = new RTCPeerConnection({ codecs: { video: codecs() } });
    partial.addTrack(partialTrack);

    // 実行: RED が参照する primary の一部だけを許可して解決する。
    await partial.createOffer();

    // 検証: 参照先が欠けた RED は保持しない。
    expect(codecNames(partial)).toEqual(["video/vp8"]);
    partial.close();

    const completeTrack = videoTrack();
    setTrackSourceCodecs(completeTrack, [useVP8(), useH264()]);
    const complete = new RTCPeerConnection({ codecs: { video: codecs() } });
    complete.addTrack(completeTrack);

    // 実行: RED の全参照先を許可して解決する。
    await complete.createOffer();

    // 検証: 全参照先が残る場合だけ RED を保持する。
    expect(codecNames(complete)).toEqual([
      "video/vp8",
      "video/h264",
      "video/red",
    ]);
    complete.close();
  });

  // setCodecPreferences() は解決済み codec を無効化し、次回 offer/answer で再解決する。
  test("changing preferences after first offer is reflected in renegotiation", async () => {
    const pc = new RTCPeerConnection({
      codecs: { video: [useVP8(), useH264()] },
    });
    pc.addTrack(videoTrack());

    // Act: 初回 offer では全 capability を広告する。
    const firstOffer = await pc.createOffer();

    // Assert: 初回は VP8/H264 の両方を含む。
    expect(firstOffer.sdp.toLowerCase()).toContain("vp8/90000");
    expect(firstOffer.sdp.toLowerCase()).toContain("h264/90000");

    // Act: 初回 offer 後に preference を H264 のみに変更して再 offer する。
    pc.getTransceivers()[0].setCodecPreferences([useH264()]);
    const secondOffer = await pc.createOffer();

    // Assert: 2 回目の offer は H264 のみに絞られる。
    expect(secondOffer.sdp.toLowerCase()).toContain("h264/90000");
    expect(secondOffer.sdp.toLowerCase()).not.toContain("vp8/90000");
    expect(codecNames(pc)).toEqual(["video/h264"]);
    pc.close();
  });

  test("incompatible preferences after first offer fail at next offer", async () => {
    const pc = new RTCPeerConnection({
      codecs: { video: [useVP8(), useH264()] },
    });
    pc.addTrack(videoTrack(useH264()));

    // Act: 初回 offer は fixed H264 source により H264 のみで成功する。
    const firstOffer = await pc.createOffer();

    // Assert: 初回は H264 のみを含む。
    expect(firstOffer.sdp.toLowerCase()).toContain("h264/90000");

    // Act: 初回 offer 後に source と互換の無い preference を設定する。
    pc.getTransceivers()[0].setCodecPreferences([useVP8()]);

    // Assert: 次回 offer で NotSupportedError になる。
    await expect(pc.createOffer()).rejects.toMatchObject({
      name: "NotSupportedError",
    });
    pc.close();
  });

  test("preferences changed after remote offer are reflected in answer", async () => {
    const offerer = new RTCPeerConnection({
      codecs: { video: [useVP8(), useH264()] },
    });
    offerer.addTrack(videoTrack());

    // Act: offer 側が VP8/H264 で offer を作成し、answer 側が remote に適用する。
    const offer = await offerer.createOffer();
    const answerer = new RTCPeerConnection({
      codecs: { video: [useVP8(), useH264()] },
    });
    await answerer.setRemoteDescription(offer);

    // Act: remote offer 適用後に preference を H264 のみに変更して answer を作成する。
    answerer.getTransceivers()[0].setCodecPreferences([useH264()]);
    const answer = await answerer.createAnswer();

    // Assert: answer は H264 のみに絞られる。
    expect(answer.sdp.toLowerCase()).toContain("h264/90000");
    expect(answer.sdp.toLowerCase()).not.toContain("vp8/90000");
    await offerer.close();
    await answerer.close();
  });

  test("answerer with local track syncs sender codec with answer SDP", async () => {
    const codecs = () => [
      useVP8(),
      new RTCRtpCodecParameters({
        mimeType: "video/rtx",
        clockRate: 90000,
        payloadType: 97,
        parameters: "apt=96",
      }),
      useH264(),
    ];
    const offerer = new RTCPeerConnection({
      codecs: { video: codecs() },
    });
    offerer.addTrack(videoTrack());

    // Arrange: offer 側が VP8/H264 で offer を作成する。
    const offer = await offerer.createOffer();

    const answerer = new RTCPeerConnection({
      codecs: { video: codecs() },
    });
    // Arrange: answerer も local track を持つ (sendrecv)。
    answerer.addTrack(videoTrack());
    await answerer.setRemoteDescription(offer);
    const answererTransceiver = answerer.getTransceivers()[0];

    // Act: remote offer 適用後に preference を H264 のみに変更して answer を作成する。
    answererTransceiver.setCodecPreferences([useH264()]);
    const answer = await answerer.createAnswer();

    // Assert: answer SDP と sender の実 codec が一致する。
    expect(answer.sdp.toLowerCase()).toContain("h264/90000");
    expect(answer.sdp.toLowerCase()).not.toContain("vp8/90000");
    expect(answererTransceiver.sender.codec?.mimeType.toLowerCase()).toBe(
      "video/h264",
    );
    expect(answer.sdp.toLowerCase()).not.toContain("rtx/90000");
    expect(
      (
        answererTransceiver.sender as unknown as {
          rtxPayloadType?: number;
        }
      ).rtxPayloadType,
    ).toBeUndefined();
    const senderStats = await answererTransceiver.sender.getStats();
    const outbound = Array.from(senderStats.values()).find(
      (stat) => stat.type === "outbound-rtp",
    ) as { rtxSsrc?: number };
    expect(outbound.rtxSsrc).toBeUndefined();
    await offerer.close();
    await answerer.close();
  });

  test("answer preserves RED preference order for a sendrecv transceiver", async () => {
    const codecs = (opusPayloadType: number, redPayloadType: number) => {
      const opus = useOPUS({ payloadType: opusPayloadType });
      const red = new RTCRtpCodecParameters({
        mimeType: "audio/red",
        clockRate: 48_000,
        channels: 2,
        payloadType: redPayloadType,
        parameters: `${opusPayloadType}/${opusPayloadType}`,
      });
      return { opus, red };
    };
    const offerCodecs = codecs(96, 97);
    const offerer = new RTCPeerConnection({
      codecs: { audio: [offerCodecs.opus, offerCodecs.red] },
    });
    offerer.addTrack(new MediaStreamTrack({ kind: "audio" }));
    const offer = await offerer.createOffer();
    await offerer.setLocalDescription(offer);

    const answerCodecs = codecs(98, 99);
    const answerer = new RTCPeerConnection({
      codecs: { audio: [answerCodecs.opus, answerCodecs.red] },
    });
    answerer.addTrack(new MediaStreamTrack({ kind: "audio" }));
    await answerer.setRemoteDescription(offer);
    const transceiver = answerer.getTransceivers()[0];

    // 実行: remote offerとは逆にREDを優先してanswerを作成する。
    transceiver.setCodecPreferences([answerCodecs.red, answerCodecs.opus]);
    const answer = await answerer.createAnswer();
    await answerer.setLocalDescription(answer);
    await offerer.setRemoteDescription(answer);

    // 検証: answer SDPとsenderの送信codecがRED preferenceを維持する。
    expect(transceiver.codecs.map((codec) => codec.name.toLowerCase())).toEqual(
      ["red", "opus"],
    );
    expect(transceiver.sender.codec?.mimeType.toLowerCase()).toBe("audio/red");
    expect(
      offerer.getTransceivers()[0].sender.codec?.mimeType.toLowerCase(),
    ).toBe("audio/red");
    const mediaLine = answer.sdp
      .split("\r\n")
      .find((line) => line.startsWith("m=audio"));
    expect(mediaLine?.split(" ").slice(3, 5)).toEqual(["97", "96"]);
    await offerer.close();
    await answerer.close();
  });

  test("negotiates equivalent H264 constraint forms with asymmetric levels", async () => {
    const h264 = (profileLevelId: string) =>
      useH264({
        parameters: `profile-level-id=${profileLevelId};packetization-mode=1;level-asymmetry-allowed=1`,
      });
    const offerer = new RTCPeerConnection({
      codecs: { video: [h264("42e01f")] },
    });
    offerer.addTrack(videoTrack());
    const offer = await offerer.createOffer();
    await offerer.setLocalDescription(offer);
    const answerer = new RTCPeerConnection({
      codecs: { video: [h264("42c00d")] },
    });
    answerer.addTrack(videoTrack());

    // 実行: 同一profileでlevelだけが異なるofferを適用してanswerする。
    await answerer.setRemoteDescription(offer);
    const answer = await answerer.createAnswer();
    await answerer.setLocalDescription(answer);
    await offerer.setRemoteDescription(answer);

    // 検証: level asymmetryが双方で許可されていれば往復交渉が成立する。
    expect(answer.sdp.toLowerCase()).toContain("h264/90000");
    expect(answerer.getTransceivers()[0].codecs).toHaveLength(1);
    expect(offerer.getTransceivers()[0].codecs).toHaveLength(1);
    await offerer.close();
    await answerer.close();
  });

  test("remote answer uses pending offer codecs after preferences change", async () => {
    const offerer = new RTCPeerConnection({
      codecs: { video: [useVP8(), useH264()] },
    });
    offerer.addTrack(videoTrack());
    const transceiver = offerer.getTransceivers()[0];
    transceiver.setCodecPreferences([useVP8()]);
    const offer = await offerer.createOffer();
    await offerer.setLocalDescription(offer);

    const answerer = new RTCPeerConnection({
      codecs: { video: [useVP8(), useH264()] },
    });
    answerer.addTrack(videoTrack());
    await answerer.setRemoteDescription(offer);
    const answer = await answerer.createAnswer();
    await answerer.setLocalDescription(answer);

    // 実行: 次回交渉用preferenceをH264へ変えた後、pending VP8 offerへのanswerを適用する。
    transceiver.setCodecPreferences([useH264()]);
    await offerer.setRemoteDescription(answer);

    // 検証: 最新preferenceではなく送信済みofferのVP8 codecで交渉を完了する。
    expect(transceiver.sender.codec?.mimeType.toLowerCase()).toBe("video/vp8");
    expect(transceiver.codecs.map((codec) => codec.name.toLowerCase())).toEqual(
      ["vp8"],
    );
    await offerer.close();
    await answerer.close();
  });

  test("answer maps duplicate MIME profiles and RTX to remote payload types", async () => {
    const h264 = (payloadType: number, profile: string) =>
      useH264({
        payloadType,
        parameters: `profile-level-id=${profile};packetization-mode=1`,
      });
    const rtx = (payloadType: number, apt: number) =>
      new RTCRtpCodecParameters({
        mimeType: "video/rtx",
        clockRate: 90_000,
        payloadType,
        parameters: `apt=${apt}`,
      });
    const offerer = new RTCPeerConnection({
      codecs: {
        video: [
          h264(96, "42e01f"),
          rtx(97, 96),
          h264(98, "640c1f"),
          rtx(99, 98),
        ],
      },
    });
    offerer.addTrack(videoTrack());
    const offer = await offerer.createOffer();
    const answerer = new RTCPeerConnection({
      codecs: {
        video: [
          h264(110, "42e01f"),
          rtx(111, 110),
          h264(112, "640c1f"),
          rtx(113, 112),
        ],
      },
    });
    answerer.addTrack(videoTrack());

    // 実行: 同一MIMEの異なるprofileとRTXを持つofferへanswerする。
    await answerer.setRemoteDescription(offer);
    const answer = await answerer.createAnswer();
    const negotiated = answerer.getTransceivers()[0].codecs;

    // 検証: remote codecを重複なく対応付け、offer側PTとRTX aptを使用する。
    expect(negotiated.map((codec) => codec.payloadType)).toEqual([
      96, 97, 98, 99,
    ]);
    expect(
      negotiated
        .filter((codec) => codec.name.toLowerCase() === "rtx")
        .map((codec) => codec.parameters),
    ).toEqual(["apt=96", "apt=98"]);
    const mediaLine = answer.sdp
      .split("\r\n")
      .find((line) => line.startsWith("m=video"));
    expect(mediaLine?.split(" ").slice(3, 7)).toEqual(["96", "97", "98", "99"]);
    await offerer.close();
    await answerer.close();
  });

  test("answer resync drops excluded RTP and updates remote track codec", async () => {
    const offerer = new RTCPeerConnection({
      codecs: { video: [useVP8(), useH264()] },
    });
    offerer.addTrack(videoTrack());

    // Arrange: offer 側が VP8/H264 で offer を作成する。
    const offer = await offerer.createOffer();

    const answerer = new RTCPeerConnection({
      codecs: { video: [useVP8(), useH264()] },
    });
    // Arrange: answerer も local track を持つ (sendrecv)。
    answerer.addTrack(videoTrack());
    await answerer.setRemoteDescription(offer);
    const answererTransceiver = answerer.getTransceivers()[0];
    const remoteTrack = answererTransceiver.receiver.tracks[0];
    const vp8PayloadType = answererTransceiver.codecs.find(
      (codec) => codec.name.toLowerCase() === "vp8",
    )!.payloadType;

    // Act: remote offer 適用後に preference を H264 のみに変更して answer を作成する。
    answererTransceiver.setCodecPreferences([useH264()]);
    const answer = await answerer.createAnswer();
    const h264PayloadType = answererTransceiver.codecs.find(
      (codec) => codec.name.toLowerCase() === "h264",
    )!.payloadType;

    // Assert: answer SDP と remote track の codec が H264 に更新される。
    expect(answer.sdp.toLowerCase()).toContain("h264/90000");
    expect(answer.sdp.toLowerCase()).not.toContain("vp8/90000");
    expect(remoteTrack.codec?.mimeType.toLowerCase()).toBe("video/h264");

    // Act: 除外された VP8 と残った H264 の RTP を受信させる。
    const onRtp = vi.fn();
    remoteTrack.onReceiveRtp.subscribe(onRtp);
    const ssrc = remoteTrack.ssrc!;
    answererTransceiver.receiver.handleRtpBySsrc(
      new RtpPacket(
        new RtpHeader({ ssrc, payloadType: vp8PayloadType }),
        Buffer.from([1, 2, 3, 4]),
      ),
      {},
    );

    // Assert: 除外された codec は受信されない。
    expect(onRtp).not.toHaveBeenCalled();

    answererTransceiver.receiver.handleRtpBySsrc(
      new RtpPacket(
        new RtpHeader({ ssrc, payloadType: h264PayloadType }),
        Buffer.from([5, 6, 7, 8]),
      ),
      {},
    );

    // Assert: 残った codec は受信される。
    expect(onRtp).toHaveBeenCalledTimes(1);
    await offerer.close();
    await answerer.close();
  });

  test("answer resync resets receiver TWCC when preferred codec lacks transport-cc", async () => {
    const vp8WithTWCC = () => useVP8({ rtcpFeedback: [useTWCC()] });
    const offerer = new RTCPeerConnection({
      codecs: { video: [vp8WithTWCC(), useH264()] },
    });
    offerer.addTrack(videoTrack());

    // Arrange: offer 側が VP8(TWCC)/H264 で offer を作成する。
    const offer = await offerer.createOffer();

    const answerer = new RTCPeerConnection({
      codecs: { video: [vp8WithTWCC(), useH264()] },
    });
    // Arrange: answerer も local track を持つ (sendrecv)。
    answerer.addTrack(videoTrack());
    await answerer.setRemoteDescription(offer);
    const answererTransceiver = answerer.getTransceivers()[0];

    // Arrange: 初期交渉では TWCC が開始している。
    expect(answererTransceiver.receiver.receiverTWCC).toBeDefined();

    // Act: transport-cc を持たない H264 のみに絞って answer を作成する。
    answererTransceiver.setCodecPreferences([useH264()]);
    const answer = await answerer.createAnswer();

    // Assert: answer SDP と sender が H264 に更新され、TWCC 状態は破棄される。
    expect(answer.sdp.toLowerCase()).toContain("h264/90000");
    expect(answer.sdp.toLowerCase()).not.toContain("vp8/90000");
    expect(answererTransceiver.sender.codec?.mimeType.toLowerCase()).toBe(
      "video/h264",
    );
    expect(answererTransceiver.receiver.receiverTWCC).toBeUndefined();
    await offerer.close();
    await answerer.close();
  });
});
