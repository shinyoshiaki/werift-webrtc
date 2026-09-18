import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  useH264,
  useVP8,
} from "../../src";

function videoTrack(codec?: RTCRtpCodecParameters) {
  return new MediaStreamTrack({ kind: "video", codec });
}

function codecNames(pc: RTCPeerConnection) {
  return pc
    .getTransceivers()[0]
    .codecs.map((codec) => codec.mimeType.toLowerCase());
}

describe("codec resolution", () => {
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
});
