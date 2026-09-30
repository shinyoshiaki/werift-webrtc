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
import {
  getTrackSourceCodecs,
  setTrackSourceCodecs,
} from "../../src/media/track";

function videoTrack(codec?: RTCRtpCodecParameters) {
  return new MediaStreamTrack({ kind: "video", codec });
}

function codecNames(pc: RTCPeerConnection) {
  return pc
    .getTransceivers()[0]
    .codecs.map((codec) => codec.mimeType.toLowerCase());
}

function remoteApplicationSnapshot(pc: RTCPeerConnection) {
  return {
    currentLocal: pc.currentLocalDescription,
    pendingLocal: pc.pendingLocalDescription,
    currentRemote: pc.currentRemoteDescription,
    pendingRemote: pc.pendingRemoteDescription,
    signalingState: pc.signalingState,
    transceivers: pc.getTransceivers().map((transceiver) => ({
      mid: transceiver.mid,
      mLineIndex: transceiver.mLineIndex,
      codecs: transceiver.codecs.map((codec) => ({ ...codec })),
      pendingLocalOfferCodecs: transceiver.pendingLocalOfferCodecs?.map(
        (codec) => ({ ...codec }),
      ),
      headerExtensions: transceiver.headerExtensions.map((extension) => ({
        ...extension,
      })),
      currentDirection: transceiver.currentDirection,
      senderCodec: transceiver.sender.codec
        ? { ...transceiver.sender.codec }
        : undefined,
      receiverCodec: transceiver.receiver.track.codec
        ? { ...transceiver.receiver.track.codec }
        : undefined,
      dtlsState: transceiver.dtlsTransport.state,
    })),
  };
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

  test("fixed H264 source compares specified profile-level-id values", () => {
    const source = useH264({
      parameters: "profile-level-id=42c01f;packetization-mode=1",
    });
    const pc = new RTCPeerConnection({
      codecs: {
        video: [
          useH264({
            parameters: "profile-level-id=42e01f;packetization-mode=1",
          }),
        ],
      },
    });

    // 実行 / 検証: 双方に指定されたsource制約は文字列値が異なれば拒否する。
    expect(() => pc.addTrack(videoTrack(source))).toThrow(
      expect.objectContaining({ name: "NotSupportedError" }),
    );
    pc.close();
  });

  test("fixed H264 source accepts capability with an omitted parameter", () => {
    const source = useH264({
      parameters: "profile-level-id=42e01f;packetization-mode=1",
    });
    const capability = new RTCRtpCodecParameters({
      mimeType: "video/H264",
      clockRate: 90_000,
      payloadType: 96,
      parameters: "profile-level-id=42e01f",
    });
    const pc = new RTCPeerConnection({ codecs: { video: [capability] } });

    // 実行 / 検証: 片側だけのfmtp指定は判定不能なのでsource制約を許容する。
    expect(() => pc.addTrack(videoTrack(source))).not.toThrow();
    pc.close();
  });

  test("remote H264 membership ignores fmtp differences", async () => {
    const omitted = new RTCRtpCodecParameters({
      mimeType: "video/H264",
      clockRate: 90_000,
      payloadType: 96,
    });
    const offerer = new RTCPeerConnection({ codecs: { video: [omitted] } });
    offerer.addTrack(videoTrack());
    const offer = await offerer.createOffer();

    const modeOne = new RTCPeerConnection({
      codecs: {
        video: [
          useH264({
            parameters: "profile-level-id=42e01f;packetization-mode=1",
          }),
        ],
      },
    });
    modeOne.addTrack(videoTrack());

    // 実行 / 検証: remote membershipはMIME一致なのでmode差に関係なく成立する。
    await modeOne.setRemoteDescription(offer);
    await expect(modeOne.createAnswer()).resolves.toBeDefined();
    modeOne.close();

    const highProfile = new RTCPeerConnection({
      codecs: {
        video: [
          useH264({
            parameters: "profile-level-id=640c1f;packetization-mode=0",
          }),
        ],
      },
    });
    highProfile.addTrack(videoTrack());

    // 実行 / 検証: remote membershipはprofile差も照合に使用しない。
    await highProfile.setRemoteDescription(offer);
    await expect(highProfile.createAnswer()).resolves.toBeDefined();
    offerer.close();
    highProfile.close();
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

  test("preference changes invalidate a cached implicit offer", async () => {
    const pc = new RTCPeerConnection({
      codecs: { video: [useVP8(), useH264()] },
    });
    pc.addTrack(videoTrack());

    // 実行: 全codecのoffer作成後、H264 preferenceへ変更して暗黙offerを設定する。
    const cached = await pc.createOffer();
    expect(cached.sdp.toLowerCase()).toContain("vp8/90000");
    pc.getTransceivers()[0].setCodecPreferences([useH264()]);
    await pc.setLocalDescription();
    const localSdp = pc.localDescription!.sdp;

    // 検証: cached offerを再利用せず、H264だけのSDPと内部codecを設定する。
    expect(localSdp.toLowerCase()).toContain("h264/90000");
    expect(localSdp.toLowerCase()).not.toContain("vp8/90000");
    expect(codecNames(pc)).toEqual(["video/h264"]);
    pc.close();
  });

  test("preference changes request negotiation only when semantics change", async () => {
    const offerer = new RTCPeerConnection({
      codecs: { video: [useVP8(), useH264()] },
    });
    offerer.addTrack(videoTrack());
    const answerer = new RTCPeerConnection({
      codecs: { video: [useVP8(), useH264()] },
    });
    answerer.addTrack(videoTrack());
    const offer = await offerer.createOffer();
    await offerer.setLocalDescription(offer);
    await answerer.setRemoteDescription(offer);
    const answer = await answerer.createAnswer();
    await answerer.setLocalDescription(answer);
    await offerer.setRemoteDescription(answer);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const onNegotiationNeeded = vi.fn();
    offerer.onnegotiationneeded = onNegotiationNeeded;
    const transceiver = offerer.getTransceivers()[0];

    // 実行: stable状態でpreferenceをH264へ変更する。
    transceiver.setCodecPreferences([useH264()]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    // 検証: negotiationneededが一度発火する。
    expect(onNegotiationNeeded).toHaveBeenCalledTimes(1);

    // 実行: 意味的に同じpreferenceを再設定する。
    transceiver.setCodecPreferences([useH264()]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    // 検証: 不要な再交渉を追加要求しない。
    expect(onNegotiationNeeded).toHaveBeenCalledTimes(1);
    await offerer.close();
    await answerer.close();
  });

  test("H264 parameter preference changes request negotiation but match by MIME", async () => {
    const h264Preference = (profile: string, mode: number) =>
      useH264({
        parameters: `profile-level-id=${profile};packetization-mode=${mode}`,
      });
    const offerer = new RTCPeerConnection({
      codecs: {
        video: [h264Preference("42e01f", 1), h264Preference("42c00d", 0)],
      },
    });
    offerer.addTrack(videoTrack());
    const transceiver = offerer.getTransceivers()[0];
    transceiver.setCodecPreferences([h264Preference("42e01f", 1)]);
    const answerer = new RTCPeerConnection({
      codecs: { video: [useH264()] },
    });
    answerer.addTrack(videoTrack());
    const offer = await offerer.createOffer();
    await offerer.setLocalDescription(offer);
    await answerer.setRemoteDescription(offer);
    const answer = await answerer.createAnswer();
    await answerer.setLocalDescription(answer);
    await offerer.setRemoteDescription(answer);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const onNegotiationNeeded = vi.fn();
    offerer.onnegotiationneeded = onNegotiationNeeded;

    // 実行: MIME/clockRateが同じH264のprofileとpacketization modeを変更する。
    const changed = h264Preference("42c00d", 0);
    transceiver.setCodecPreferences([changed]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    // 検証: preferenceを更新し、codec cacheを無効化して再交渉を要求する。
    expect(transceiver.codecPreferences?.[0].parameters).toBe(
      changed.parameters,
    );
    expect(transceiver.codecs).toEqual([]);
    expect(onNegotiationNeeded).toHaveBeenCalledTimes(1);

    // 実行: 変更後preferenceで次のofferを生成する。
    const changedOffer = await offerer.createOffer();

    // 検証: preferenceのfmtpではなく、最初にMIME一致したcapabilityを使用する。
    expect(changedOffer.sdp.toLowerCase()).toContain(
      "profile-level-id=42e01f;packetization-mode=1",
    );
    expect(changedOffer.sdp.toLowerCase()).not.toContain(
      "profile-level-id=42c00d;packetization-mode=0",
    );
    expect(transceiver.codecs[0].parameters).toBe(
      h264Preference("42e01f", 1).parameters,
    );
    await offerer.close();
    await answerer.close();
  });

  test("H264 preference ignores parameters when selecting a capability", async () => {
    const configured = useH264({
      parameters: "profile-level-id=42e01f;packetization-mode=1",
    });
    const pc = new RTCPeerConnection({ codecs: { video: [configured] } });
    pc.addTrack(videoTrack());
    await pc.createOffer();
    const transceiver = pc.getTransceivers()[0];

    // 実行: 単一capabilityと異なるprofile/modeをpreference指定してofferする。
    transceiver.setCodecPreferences([
      useH264({
        parameters: "profile-level-id=42c00d;packetization-mode=0",
      }),
    ]);

    const offer = await pc.createOffer();

    // 検証: parametersを照合せず、MIME/clockRateが一致するconfigured codecを選ぶ。
    expect(offer.sdp.toLowerCase()).toContain(
      "profile-level-id=42e01f;packetization-mode=1",
    );
    expect(transceiver.codecs).toEqual([configured]);
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

  test.each([
    [
      "Opus",
      "audio",
      useOPUS({ payloadType: 96 }),
      useOPUS({ payloadType: 110 }),
    ],
    [
      "H264",
      "video",
      useH264({ payloadType: 96 }),
      useH264({ payloadType: 110 }),
    ],
  ] as const)(
    "fixed %s source preserves RED for offerer and answerer",
    async (_codecName, kind, offerPrimary, answerPrimary) => {
      const red = (payloadType: number, primaryPayloadType: number) =>
        new RTCRtpCodecParameters({
          mimeType: `${kind}/red`,
          clockRate: offerPrimary.clockRate,
          channels: offerPrimary.channels,
          payloadType,
          parameters: `${primaryPayloadType}/${primaryPayloadType}`,
        });
      const offerRed = red(97, 96);
      const answerRed = red(111, 110);
      const offerer = new RTCPeerConnection({
        codecs: { [kind]: [offerPrimary, offerRed] },
      });
      const offererTransceiver = offerer.addTransceiver(
        new MediaStreamTrack({ kind, codec: offerPrimary }),
      );
      offererTransceiver.setCodecPreferences([offerRed, offerPrimary]);
      const answerer = new RTCPeerConnection({
        codecs: { [kind]: [answerPrimary, answerRed] },
      });
      const answererTransceiver = answerer.addTransceiver(
        new MediaStreamTrack({ kind, codec: answerPrimary }),
      );
      answererTransceiver.setCodecPreferences([answerRed, answerPrimary]);

      // 実行: 両側にfixed sourceを持つRED優先のoffer/answerを完了する。
      const offer = await offerer.createOffer();
      await offerer.setLocalDescription(offer);
      await answerer.setRemoteDescription(offer);
      const answer = await answerer.createAnswer();
      await answerer.setLocalDescription(answer);
      await offerer.setRemoteDescription(answer);

      // 検証: offerer/answererともREDと参照先primaryを維持し、REDを送信形式にする。
      expect(
        offererTransceiver.codecs.map((codec) => codec.name.toLowerCase()),
      ).toEqual(["red", offerPrimary.name.toLowerCase()]);
      expect(
        answererTransceiver.codecs.map((codec) => codec.name.toLowerCase()),
      ).toEqual(["red", offerPrimary.name.toLowerCase()]);
      expect(offererTransceiver.sender.codec?.name.toLowerCase()).toBe("red");
      expect(answererTransceiver.sender.codec?.name.toLowerCase()).toBe("red");
      expect(offer.sdp).toContain("a=fmtp:97 96/96");
      expect(answer.sdp).toContain("a=fmtp:97 96/96");
      await offerer.close();
      await answerer.close();
    },
  );

  test("remote H264 negotiation preserves the offered codec parameters", async () => {
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

    // 検証: remote membershipはMIMEで成立し、answerはofferのcodecを保持する。
    expect(answer.sdp.toLowerCase()).toContain("h264/90000");
    expect(answer.sdp.toLowerCase()).toContain("profile-level-id=42e01f");
    expect(answerer.getTransceivers()[0].codecs).toHaveLength(1);
    expect(offerer.getTransceivers()[0].codecs).toHaveLength(1);
    await offerer.close();
    await answerer.close();
  });

  test("remote H264 negotiation does not rewrite the offered level", async () => {
    const h264 = (profileLevelId: string) =>
      useH264({
        parameters: `profile-level-id=${profileLevelId};packetization-mode=1;level-asymmetry-allowed=0`,
      });
    const offerer = new RTCPeerConnection({
      codecs: { video: [h264("42e01f")] },
    });
    offerer.addTrack(videoTrack());
    const offer = await offerer.createOffer();
    await offerer.setLocalDescription(offer);
    const answerer = new RTCPeerConnection({
      codecs: { video: [h264("42e00d")] },
    });
    answerer.addTrack(videoTrack());

    // 実行: level asymmetryなしでlevel 3.1のofferへlevel 1.3でanswerする。
    await answerer.setRemoteDescription(offer);
    const answer = await answerer.createAnswer();
    await answerer.setLocalDescription(answer);
    await offerer.setRemoteDescription(answer);

    // 検証: remote codec objectを採用し、offerのlevelをanswerへ維持する。
    expect(answer.sdp.toLowerCase()).toContain("profile-level-id=42e01f");
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

    // 実行: pending offerへのanswer適用後に、次回offerを生成する。
    const nextOffer = await offerer.createOffer();

    // 検証: 旧交渉codecの反映で再解決要求が失われず、H264 preferenceを使用する。
    expect(nextOffer.sdp.toLowerCase()).toContain("h264/90000");
    expect(nextOffer.sdp.toLowerCase()).not.toContain("vp8/90000");
    expect(codecNames(offerer)).toEqual(["video/h264"]);
    await offerer.close();
    await answerer.close();
  });

  test("remote offer must be compatible with a fixed H264 source", async () => {
    const remoteCodec = useH264({
      parameters: "profile-level-id=42e01f;packetization-mode=1",
    });
    const fixedCodec = useH264({
      parameters: "profile-level-id=42c00a;packetization-mode=0",
    });
    const offerer = new RTCPeerConnection({
      codecs: { video: [remoteCodec] },
    });
    offerer.addTrack(videoTrack());
    const offer = await offerer.createOffer();
    const answerer = new RTCPeerConnection({
      codecs: { video: [fixedCodec] },
    });
    answerer.addTrack(videoTrack(fixedCodec));
    const stateBefore = remoteApplicationSnapshot(answerer);

    // 実行: MIMEは一致するがfixed sourceのfmtpと非互換なofferを適用する。
    const act = answerer.setRemoteDescription(offer);

    // 検証: sourceとremote候補の厳密照合で拒否し、状態へ副作用を残さない。
    await expect(act).rejects.toMatchObject({ name: "NotSupportedError" });
    expect(remoteApplicationSnapshot(answerer)).toEqual(stateBefore);
    await offerer.close();
    await answerer.close();
  });

  test("remote offer selects a later compatible H264 and its RTX", async () => {
    const h264 = (payloadType: number, parameters: string) =>
      useH264({ payloadType, parameters });
    const rtx = (payloadType: number, apt: number) =>
      new RTCRtpCodecParameters({
        mimeType: "video/rtx",
        clockRate: 90_000,
        payloadType,
        parameters: `apt=${apt}`,
      });
    const incompatible = h264(
      96,
      "profile-level-id=42e01f;packetization-mode=1",
    );
    const compatible = h264(98, "profile-level-id=42c00a;packetization-mode=0");
    const offerer = new RTCPeerConnection({
      codecs: { video: [incompatible, rtx(97, 96), compatible, rtx(99, 98)] },
    });
    offerer.addTrack(videoTrack());
    const offer = await offerer.createOffer();
    const fixedCodec = h264(
      110,
      "profile-level-id=42c00a;packetization-mode=0",
    );
    const answerer = new RTCPeerConnection({
      codecs: { video: [fixedCodec, rtx(111, 110)] },
    });
    answerer.addTrack(videoTrack(fixedCodec));

    // 実行: 先頭が非互換、後続が互換な複数H264 offerを適用する。
    await answerer.setRemoteDescription(offer);
    const answer = await answerer.createAnswer();

    // 検証: 後続のprimaryと、それを参照するRTXだけを選択する。
    expect(
      answerer.getTransceivers()[0].codecs.map((codec) => codec.payloadType),
    ).toEqual([98, 99]);
    expect(answer.sdp).toContain("m=video 9 UDP/TLS/RTP/SAVPF 98 99");
    expect(answer.sdp).toContain("a=fmtp:99 apt=98");
    expect(answer.sdp).not.toContain("a=fmtp:97 apt=96");
    await offerer.close();
    await answerer.close();
  });

  test("remote answer rejects a codec incompatible with the fixed source", async () => {
    const sourceCodec = useH264({
      parameters: "profile-level-id=42e01f;packetization-mode=1",
    });
    const offerer = new RTCPeerConnection({
      codecs: { video: [sourceCodec] },
    });
    offerer.addTrack(videoTrack(sourceCodec));
    const offer = await offerer.createOffer();
    await offerer.setLocalDescription(offer);
    const answerer = new RTCPeerConnection({
      codecs: { video: [sourceCodec] },
    });
    answerer.addTrack(videoTrack());
    await answerer.setRemoteDescription(offer);
    const answer = await answerer.createAnswer();
    const incompatibleAnswer = {
      type: answer.type,
      sdp: answer.sdp.replace(
        "profile-level-id=42e01f",
        "profile-level-id=42c00a",
      ),
    };
    const codecsBefore = [...offerer.getTransceivers()[0].codecs];

    // 実行: pending offerとMIMEは同じだがfixed sourceと非互換なanswerを適用する。
    const act = offerer.setRemoteDescription(incompatibleAnswer);

    // 検証: remote offerのMIME membershipとは別に、answerをsource制約で拒否する。
    await expect(act).rejects.toMatchObject({ name: "NotSupportedError" });
    expect(offerer.remoteDescription).toBeNull();
    expect(offerer.signalingState).toBe("have-local-offer");
    expect(offerer.getTransceivers()[0].codecs).toEqual(codecsBefore);
    await offerer.close();
    await answerer.close();
  });

  test.each([
    ["raw", "answer"],
    ["raw", "pranswer"],
    ["fixed", "answer"],
    ["fixed", "pranswer"],
  ] as const)(
    "%s track keeps all state when an incompatible remote %s is rejected",
    async (sourceType, descriptionType) => {
      const fixedCodec = useH264({
        parameters: "profile-level-id=42e01f;packetization-mode=1",
      });
      const configured = sourceType === "fixed" ? [fixedCodec] : [useVP8()];
      const offerer = new RTCPeerConnection({ codecs: { video: configured } });
      offerer.addTrack(
        videoTrack(sourceType === "fixed" ? fixedCodec : undefined),
      );
      const offer = await offerer.createOffer();
      await offerer.setLocalDescription(offer);
      const answerer = new RTCPeerConnection({
        codecs: { video: configured },
      });
      answerer.addTrack(videoTrack());
      await answerer.setRemoteDescription(offer);
      const answer = await answerer.createAnswer();
      const invalidSdp =
        sourceType === "fixed"
          ? answer.sdp.replace("42e01f", "42c00a")
          : answer.sdp.replace("VP8/90000", "H264/90000");
      const before = remoteApplicationSnapshot(offerer);
      const onTrack = vi.fn();
      offerer.onTrack.subscribe(onTrack);

      // 実行: codec不一致のanswer/pranswerを適用する。
      const act = offerer.setRemoteDescription({
        type: descriptionType,
        sdp: invalidSdp,
      });

      // 検証: 例外前後のSDP・transceiver・transport状態とイベントを不変に保つ。
      // MIME が 1 つも一致しない raw は Issue #705 の InvalidAccessError、
      // fixed source の fmtp 不一致は NotSupportedError になる。
      await expect(act).rejects.toMatchObject({
        name:
          sourceType === "fixed" ? "NotSupportedError" : "InvalidAccessError",
      });
      expect(remoteApplicationSnapshot(offerer)).toEqual(before);
      expect(onTrack).not.toHaveBeenCalled();

      // 実行 / 検証: 拒否直後にも正常answerを適用できる。
      await expect(
        offerer.setRemoteDescription(answer),
      ).resolves.toBeUndefined();
      await offerer.close();
      await answerer.close();
    },
  );

  test("a later failing m-line leaves earlier media and events untouched", async () => {
    const offerer = new RTCPeerConnection({
      codecs: { audio: [useOPUS()], video: [useVP8()] },
    });
    offerer.addTrack(new MediaStreamTrack({ kind: "audio" }));
    offerer.addTrack(videoTrack());
    const offer = await offerer.createOffer();
    const answerer = new RTCPeerConnection({
      codecs: { audio: [useOPUS()], video: [useVP8(), useH264()] },
    });
    answerer.addTrack(new MediaStreamTrack({ kind: "audio" }));
    answerer.addTrack(videoTrack(useH264()));
    const before = remoteApplicationSnapshot(answerer);
    const onTrack = vi.fn();
    answerer.onTrack.subscribe(onTrack);

    // 実行: audioは成功するが後続videoがfixed sourceと不一致のofferを適用する。
    const act = answerer.setRemoteDescription(offer);

    // 検証: 全m-lineの解決完了前には先行audioもイベントも反映しない。
    await expect(act).rejects.toMatchObject({ name: "NotSupportedError" });
    expect(remoteApplicationSnapshot(answerer)).toEqual(before);
    expect(onTrack).not.toHaveBeenCalled();
    await offerer.close();
    await answerer.close();
  });

  test("a rejected answer m-line ignores incompatible codec parameters", async () => {
    const fixedCodec = useH264({
      parameters: "profile-level-id=42e01f;packetization-mode=1",
    });
    const offerer = new RTCPeerConnection({
      codecs: { video: [fixedCodec] },
    });
    offerer.addTrack(videoTrack(fixedCodec));
    const offer = await offerer.createOffer();
    await offerer.setLocalDescription(offer);
    const answerer = new RTCPeerConnection({
      codecs: { video: [fixedCodec] },
    });
    await answerer.setRemoteDescription(offer);
    const answer = await answerer.createAnswer();
    const rejectedSdp = answer.sdp
      .replace("42e01f", "42c00a")
      .replace(/m=video \d+ /, "m=video 0 ");

    // 実行: codec fmtpが非互換でもport=0でrejectされたanswerを適用する。
    await offerer.setRemoteDescription({ type: "answer", sdp: rejectedSdp });

    // 検証: rejected sectionはRTP設定を開始せず、Issue #705 の拒否として停止を確定する。
    const transceiver = offerer.getTransceivers()[0];
    expect(offerer.signalingState).toBe("stable");
    expect(transceiver.stopped).toBe(true);
    expect(transceiver.currentDirection).toBe("stopped");
    expect(transceiver.sender.codec).toBeUndefined();
    await offerer.close();
    await answerer.close();
  });

  test("a remote offer without a common codec is rejected even when an existing transceiver needs resolution", async () => {
    const offerer = new RTCPeerConnection({ codecs: { video: [useH264()] } });
    offerer.addTransceiver("video", { direction: "sendrecv" });
    const offer = await offerer.createOffer();
    await offerer.setLocalDescription(offer);
    const answerer = new RTCPeerConnection({ codecs: { video: [useVP8()] } });
    const transceiver = answerer.addTransceiver("video");
    transceiver.setCodecPreferences([useVP8()]);

    // 実行: MIME が一致しない remote offer を適用して answer を作る。
    await answerer.setRemoteDescription(offer);
    const answer = await answerer.createAnswer();

    // 検証: codec 解決で NotSupportedError にせず、Issue #705 どおり port 0 で拒否する。
    expect(transceiver.pendingRejection).toBe(true);
    expect(answer.sdp).toContain("m=video 0 ");
    await offerer.close();
    await answerer.close();
  });

  test("a negotiated raw track clone remains unconstrained", async () => {
    const raw = videoTrack();
    const first = new RTCPeerConnection({ codecs: { video: [useH264()] } });
    first.addTrack(raw);
    raw.codec = useH264();
    const cloned = raw.clone();
    const second = new RTCPeerConnection({ codecs: { video: [useVP8()] } });

    // 実行: senderがH264を設定したraw trackのcloneをVP8-only PCへ追加する。
    const act = () => second.addTrack(cloned);

    // 検証: negotiated track.codecをsource metadataとして再捕捉しない。
    expect(raw.codec?.mimeType.toLowerCase()).toBe("video/h264");
    expect(getTrackSourceCodecs(cloned)).toBeUndefined();
    expect(act).not.toThrow();
    await expect(second.createOffer()).resolves.toBeDefined();
    await first.close();
    await second.close();
  });

  test("a fixed track cloned before attachment retains its source codec", () => {
    const fixed = videoTrack(useH264());

    // 実行: metadata capture前のfixed trackをcloneしてVP8-only PCへ追加する。
    const cloned = fixed.clone();
    const pc = new RTCPeerConnection({ codecs: { video: [useVP8()] } });
    const act = () => pc.addTrack(cloned);

    // 検証: clone時に公開codecをsource constraintとして捕捉し、非互換を拒否する。
    expect(getTrackSourceCodecs(cloned)?.[0].mimeType.toLowerCase()).toBe(
      "video/h264",
    );
    expect(act).toThrow(expect.objectContaining({ name: "NotSupportedError" }));
    pc.close();
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
