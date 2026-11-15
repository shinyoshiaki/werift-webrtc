import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  type RTCRtpTransceiver,
  useH264,
  useOPUS,
  useVP8,
  useVP9,
} from "../../src";
import {
  describeCases,
  negotiationCase,
} from "../negotiation/harness/negotiationCase";
import {
  createConnectedVideoPeersWith,
  createDuplexSession,
  createUnnegotiatedPeers,
  expectSessionAlive,
  expectSessionContinues,
  offeredVideoCodecs,
  payloadTypeOf,
} from "../negotiation/harness/negotiationTransactionUtils";

const rtx = (payloadType: number, apt: number) =>
  new RTCRtpCodecParameters({
    mimeType: "video/rtx",
    clockRate: 90000,
    payloadType,
    parameters: `apt=${apt}`,
  });

/** `{ name: payloadType }` of the video m-line, RTX as `rtx(<apt>)`. */
const payloadTypes = (sdp: string) =>
  Object.fromEntries(
    [...sdp.matchAll(/^a=rtpmap:(\d+) ([^/]+)\/90000/gm)].map(([, pt, name]) =>
      name.toLowerCase() === "rtx"
        ? [
            `rtx(${sdp.match(new RegExp(`^a=fmtp:${pt} apt=(\\d+)`, "m"))![1]})`,
            Number(pt),
          ]
        : [name.toUpperCase(), Number(pt)],
    ),
  );

const codecNames = (codecs: readonly RTCRtpCodecParameters[]) =>
  codecs.map((codec) => codec.name.toUpperCase());

/** Live codec state of a transceiver that an unapplied offer must not change. */
const liveCodecState = (transceiver: RTCRtpTransceiver) => ({
  codecs: transceiver.codecs.map((codec) => ({ ...codec })),
  pendingLocalOfferCodecs: transceiver.pendingLocalOfferCodecs?.map(
    (codec) => ({
      ...codec,
    }),
  ),
  vp9: transceiver.getPayloadType("vp9"),
  senderCodec: transceiver.sender.codec?.name,
  stats: transceiver.getCodecStats().map((stat) => {
    const { payloadType, mimeType } = stat as unknown as {
      payloadType: number;
      mimeType: string;
    };
    return { payloadType, mimeType };
  }),
});

// https://github.com/shinyoshiaki/werift-webrtc/issues/818
// RFC 8829 §5.2.2: a subsequent offer lists every codec the transceiver can
// currently use, whatever an earlier answer narrowed.
describeCases("issue 818: subsequent offers list every supported codec", () => {
  negotiationCase(
    "offerer: an answer that kept only VP8 does not remove VP9 from the next offer",
    { ref: "origin: issue 818" },
    async (c) => {
      // Arrange: A は VP8 + VP9、B は VP8 だけで初回交渉を確定する。
      const { a } = await c.given(
        createConnectedVideoPeersWith({
          offerer: { codecs: { video: [useVP8(), useVP9()] } },
          answerer: { codecs: { video: [useVP8()] } },
        }),
      );
      const initialVp8 = payloadTypeOf(a.currentLocalDescription!.sdp, "VP8");
      expect(offeredVideoCodecs(a.currentRemoteDescription!.sdp)).toEqual([
        "VP8",
      ]);

      // Act: A が次の offer を作る。
      const offer = await a.createOffer();

      // Assert: VP8 と VP9 の両方を初回と同じ順で提示し、VP8 の PT は変わらない。
      expect(offeredVideoCodecs(offer.sdp)).toEqual(["VP8", "VP9"]);
      expect(payloadTypeOf(offer.sdp, "VP8")).toEqual(initialVp8);
      // Assert: 交渉済み codec (送信中の codec) は VP8 のまま。
      expect(codecNames(a.getTransceivers()[0].codecs)).toEqual(["VP8"]);
    },
  );

  negotiationCase(
    "offerer: a later answer can move to VP9, which is live only after the answer commits",
    { ref: "origin: issue 818" },
    async (c) => {
      // Arrange: 両側 VP8 + VP9 で、B は preferences で VP8 だけに答えて確定する。
      const config = { codecs: { video: [useVP8(), useVP9()] } };
      const { a, b } = await c.given(
        createConnectedVideoPeersWith({ offerer: config, answerer: config }),
      );
      const aTransceiver = a.getTransceivers()[0];
      const bTransceiver = b.getTransceivers()[0];
      bTransceiver.setCodecPreferences([useVP8()]);
      await c.negotiate(a);
      expect(codecNames(aTransceiver.codecs)).toEqual(["VP8"]);

      // Act: B が VP9 を優先するようにし、A が再オファーを適用して B に渡す。
      bTransceiver.setCodecPreferences([useVP9()]);
      const offer = await c.offer(a);

      // Assert: offer は VP9 を再提示し、answer 前の live codec は VP8 のまま。
      expect(offeredVideoCodecs(offer.sdp)).toEqual(["VP8", "VP9"]);
      expect(a.signalingState).toEqual("have-local-offer");
      expect(codecNames(aTransceiver.codecs)).toEqual(["VP8"]);
      expect(aTransceiver.sender.codec?.name.toUpperCase()).toEqual("VP8");

      // Act: B が VP9 で答え、A が適用する。
      await c.answer(b);

      // Assert: 確定後は A の送信 codec と B の受信表が VP9 になる。
      expect(codecNames(aTransceiver.codecs)[0]).toEqual("VP9");
      expect(aTransceiver.sender.codec?.name.toUpperCase()).toEqual("VP9");
      expect(codecNames(bTransceiver.codecs)[0]).toEqual("VP9");
    },
  );

  negotiationCase(
    "answerer: after answering a VP8-only offer the next offer lists every configured codec with the offerer's VP8 payload type",
    { ref: "origin: issue 818 (WPT protocol/codecs-subsequent-offer)" },
    async (c) => {
      // Arrange: A は VP8 (PT 100) だけを offer し、B (VP8 96 + H264 97) が答える。
      const { a, b } = await c.given(
        createConnectedVideoPeersWith({
          offerer: { codecs: { video: [useVP8({ payloadType: 100 })] } },
          answerer: {
            codecs: {
              video: [
                useVP8({ payloadType: 96 }),
                useH264({ payloadType: 97 }),
              ],
            },
          },
        }),
      );
      expect(payloadTypes(b.currentLocalDescription!.sdp)).toEqual({
        VP8: 100,
      });

      // Act: answerer だった B が次の offer を作って適用し、A が答える。
      const offer = await c.offer(b);
      await c.answer(a);

      // Assert: VP8 は A の PT 100 のまま、H264 は設定上の PT 97 で再提示される。
      expect(payloadTypes(offer.sdp)).toEqual({ VP8: 100, H264: 97 });
      expect(codecNames(b.getTransceivers()[0].codecs)).toEqual(["VP8"]);
    },
  );

  negotiationCase(
    "answerer: a codec offered again moves off a payload type the session uses, and its RTX follows",
    { ref: "origin: issue 818 (RFC 3264 8.3.2)" },
    async (c) => {
      // Arrange: A は VP8 98 / RTX 99 と VP9 100 / RTX 101 を持つが、初回は VP8 だけ offer する。
      // B は VP8 96 / RTX 97 と VP9 98 / RTX 99 を持ち、A の PT (98 / 99) で答える。
      const { a, b } = await c.given(
        createConnectedVideoPeersWith({
          offerer: {
            codecs: {
              video: [
                useVP8({ payloadType: 98 }),
                rtx(99, 98),
                useVP9({ payloadType: 100 }),
                rtx(101, 100),
              ],
            },
          },
          answerer: {
            codecs: {
              video: [
                useVP8({ payloadType: 96 }),
                rtx(97, 96),
                useVP9({ payloadType: 98 }),
                rtx(99, 98),
              ],
            },
          },
          offererPreferences: [useVP8()],
        }),
      );
      expect(payloadTypes(b.currentLocalDescription!.sdp)).toEqual({
        VP8: 98,
        "rtx(98)": 99,
      });
      a.getTransceivers()[0].setCodecPreferences([]);

      // Act: B が次の offer を作って適用し、A が答える。
      const offer = await c.offer(b);
      await c.answer(a);

      // Assert: VP8 / RTX は交渉済み PT、VP9 は 98 が使用中なので空き PT 96、その RTX は 97 で apt=96。
      expect(payloadTypes(offer.sdp)).toEqual({
        VP8: 98,
        "rtx(98)": 99,
        VP9: 96,
        "rtx(96)": 97,
      });
      // Assert: A は VP9 も受け入れ、B の交渉済み codec は offer の PT になる。
      expect(
        b
          .getTransceivers()[0]
          .codecs.map((codec) => [codec.name.toUpperCase(), codec.payloadType]),
      ).toEqual([
        ["VP8", 98],
        ["RTX", 99],
        ["VP9", 96],
        ["RTX", 97],
      ]);
    },
  );

  negotiationCase(
    "codec preferences still narrow the next offer, and clearing them lists VP9 again",
    { ref: "origin: issue 818" },
    async (c) => {
      // Arrange: A は VP8 + VP9、B は VP8 だけで確定する。
      const { a } = await c.given(
        createConnectedVideoPeersWith({
          offerer: { codecs: { video: [useVP8(), useVP9()] } },
          answerer: { codecs: { video: [useVP8()] } },
        }),
      );
      const transceiver = a.getTransceivers()[0];

      // Act: preferences を VP8 だけにして offer を作る。
      transceiver.setCodecPreferences([useVP8()]);
      const narrowed = await a.createOffer();
      // Act: preferences を解除して offer を作る。
      transceiver.setCodecPreferences([]);
      const cleared = await a.createOffer();

      // Assert: VP8 だけの preferences では VP9 は戻らず、解除すると戻る。
      expect(offeredVideoCodecs(narrowed.sdp)).toEqual(["VP8"]);
      expect(offeredVideoCodecs(cleared.sdp)).toEqual(["VP8", "VP9"]);
      // Assert: preferences の変更でも交渉済み codec は空にならない。
      expect(codecNames(transceiver.codecs)).toEqual(["VP8"]);
    },
  );

  negotiationCase(
    "an unapplied or rolled-back re-offer leaves the live codecs, payload types and codec stats unchanged",
    { ref: "origin: issue 818" },
    async (c) => {
      // Arrange: A は VP8 + VP9、B は VP8 だけで確定する。
      const { a } = await c.given(
        createConnectedVideoPeersWith({
          offerer: { codecs: { video: [useVP8(), useVP9()] } },
          answerer: { codecs: { video: [useVP8()] } },
        }),
      );
      const transceiver = a.getTransceivers()[0];
      const before = liveCodecState(transceiver);
      expect(before.vp9).toBeUndefined();

      // Act: VP9 を含む offer を作るだけで適用しない。
      const offer = await a.createOffer();

      // Assert: live な codec 状態は変わらない。
      expect(offeredVideoCodecs(offer.sdp)).toEqual(["VP8", "VP9"]);
      expect(liveCodecState(transceiver)).toEqual(before);

      // Act: offer を適用してから rollback する。
      await c.setLocal(a, offer);
      expect(codecNames(transceiver.pendingLocalOfferCodecs!)).toEqual([
        "VP8",
        "VP9",
      ]);
      await c.rollback(a);

      // Assert: codecs・pending offer codec・sender は確定値に戻る。
      expect(liveCodecState(transceiver)).toEqual(before);
    },
  );

  negotiationCase(
    "a fixed H264 source keeps limiting the next offer to source-compatible codecs",
    { ref: "origin: issue 818" },
    async (c) => {
      // Arrange: 両側 H264 + VP8 の設定で、H264 + VP8 を確定する。
      const config = {
        codecs: { video: [useH264(), useVP8()] },
      };
      const { a } = await c.given(
        createConnectedVideoPeersWith({ offerer: config, answerer: config }),
      );
      const transceiver = a.getTransceivers()[0];
      expect(codecNames(transceiver.codecs)).toEqual(["H264", "VP8"]);

      // Act: H264 固定 source の track に差し替えて offer を作る。
      await transceiver.sender.replaceTrack(
        new MediaStreamTrack({ kind: "video", codec: useH264() }),
      );
      const offer = await a.createOffer();

      // Assert: offer は source と互換な H264 だけになり、交渉済み codec は変わらない。
      expect(offeredVideoCodecs(offer.sdp)).toEqual(["H264"]);
      expect(codecNames(transceiver.codecs)).toEqual(["H264", "VP8"]);
    },
  );

  negotiationCase(
    "a transceiver added to a negotiated session does not reuse a payload type another m-line uses",
    { ref: "origin: issue 818 (review: payload type collision)" },
    async (c) => {
      // Arrange: A は VP8 (PT 98) だけを offer し、B (VP8 96 + VP9 98) が VP8 = PT 98 で確定する。
      const { b } = await c.given(
        createConnectedVideoPeersWith({
          offerer: { codecs: { video: [useVP8({ payloadType: 98 })] } },
          answerer: {
            codecs: {
              video: [useVP8({ payloadType: 96 }), useVP9({ payloadType: 98 })],
            },
          },
        }),
      );
      expect(payloadTypeOf(b.currentLocalDescription!.sdp, "VP8")).toEqual(98);
      const before = b.getTransceivers()[0].codecs.map((codec) => ({
        ...codec,
      }));

      // Act: B が映像 transceiver を追加して offer を作る。
      b.addTransceiver("video", { direction: "sendrecv" });
      const offer = await b.createOffer();

      // Assert: 各 m-line の PT は 1 つの codec だけを指し、既存 m-line の VP8 は 98 のまま。
      const sections = offer.sdp.split(/^m=/m).slice(1);
      const videoSections = sections.filter((section) =>
        section.startsWith("video"),
      );
      expect(videoSections).toHaveLength(2);
      const mapping = new Map<string, string>();
      for (const section of videoSections) {
        for (const [, pt, name] of section.matchAll(
          /^a=rtpmap:(\d+) ([^/]+)\/90000/gm,
        )) {
          const known = mapping.get(pt);
          expect(known ?? name).toEqual(name);
          mapping.set(pt, name);
        }
      }
      expect(payloadTypes(videoSections[0]).VP8).toEqual(98);
      expect(payloadTypes(videoSections[1]).VP9).not.toEqual(98);
      // Assert: 交渉済み transceiver の live codec は変わらない。
      expect(
        b.getTransceivers()[0].codecs.map((codec) => ({ ...codec })),
      ).toEqual(before);
    },
  );

  negotiationCase(
    "an added m-line does not reuse the payload type of an H264 format with another packetization-mode",
    { ref: "origin: issue 818 (review: H264 format collision)" },
    async (c) => {
      // Arrange: A は H264 mode 1 (PT 98) だけを offer し、B (mode 0 = 98, mode 1 = 100) が mode 1 = PT 98 で確定する。
      const mode0 = (payloadType: number) =>
        useH264({
          payloadType,
          parameters:
            "profile-level-id=42e01f;packetization-mode=0;level-asymmetry-allowed=1",
        });
      const { b } = await c.given(
        createConnectedVideoPeersWith({
          offerer: { codecs: { video: [useH264({ payloadType: 98 })] } },
          answerer: {
            codecs: { video: [mode0(98), useH264({ payloadType: 100 })] },
          },
        }),
      );
      expect(
        b.currentLocalDescription!.sdp.match(/^a=fmtp:98 (.*)$/m)![1],
      ).toContain("packetization-mode=1");

      // Act: B が映像 transceiver を追加して offer を作る。
      b.addTransceiver("video", { direction: "sendrecv" });
      const offer = await b.createOffer();

      // Assert: BUNDLE 内の各 PT は 1 つの H264 形式 (packetization-mode) だけを指す。
      const videoSections = offer.sdp
        .split(/^m=/m)
        .slice(1)
        .filter((section) => section.startsWith("video"));
      expect(videoSections).toHaveLength(2);
      const formats = videoSections.map((section) =>
        Object.fromEntries(
          [...section.matchAll(/^a=fmtp:(\d+) (.*)$/gm)]
            .filter(([, pt]) =>
              new RegExp(`^a=rtpmap:${pt} H264/`, "m").test(section),
            )
            .map(([, pt, fmtp]) => [
              Number(pt),
              fmtp.match(/packetization-mode=(\d)/)![1],
            ]),
        ),
      );
      for (const [pt, mode] of Object.entries(formats[1])) {
        expect(formats[0][pt] ?? mode).toEqual(mode);
      }
      // Assert: 既存 m-line の mode 1 は 98 のまま、追加 m-line の mode 0 は 98 以外。
      expect(formats[0][98]).toEqual("1");
      expect(formats[1][98]).not.toEqual("0");
      expect(Object.values(formats[1])).toContain("0");
    },
  );

  negotiationCase(
    "an added m-line does not reuse the payload type of a RED with other primaries",
    { ref: "origin: issue 818 (review: RED fmtp collision)" },
    async (c) => {
      // Arrange: A (opus 110 + RED 63 = 110/110) と B (opus 109 + RED 63 = 109/109) が A の PT で音声を確定する。
      const red = (primary: number) =>
        new RTCRtpCodecParameters({
          mimeType: "audio/red",
          clockRate: 48000,
          channels: 2,
          payloadType: 63,
          parameters: `${primary}/${primary}`,
        });
      const audio = (primary: number) => ({
        codecs: {
          audio: [red(primary), useOPUS({ payloadType: primary })],
        },
      });
      const offerer = new RTCPeerConnection({ iceServers: [], ...audio(110) });
      const answerer = new RTCPeerConnection({ iceServers: [], ...audio(109) });
      const { a, b } = await c.given({
        offerer,
        answerer,
        close: () => Promise.allSettled([offerer.close(), answerer.close()]),
      });
      c.exempt(
        "SDP only: checks the payload types of an offer, no media is sent",
      );
      a.addTransceiver("audio", { direction: "sendrecv" });
      await c.negotiate(a);
      expect(b.currentLocalDescription!.sdp).toMatch(
        /^a=fmtp:63 110\/110\r?$/m,
      );

      // Act: B が音声 transceiver を追加して offer を作る。
      b.addTransceiver("audio", { direction: "sendrecv" });
      const offer = await b.createOffer();

      // Assert: BUNDLE 内の各 PT の fmtp は全 m-line で同じ (RFC 8859 IDENTICAL-PER-PT)。
      const audioSections = offer.sdp
        .split(/^m=/m)
        .slice(1)
        .filter((section) => section.startsWith("audio"));
      expect(audioSections).toHaveLength(2);
      const fmtps = audioSections.map(
        (section) =>
          new Map(
            [...section.matchAll(/^a=fmtp:(\d+) (.*?)\r?$/gm)].map(
              ([, pt, fmtp]) => [Number(pt), fmtp],
            ),
          ),
      );
      for (const [pt, fmtp] of fmtps[1]) {
        expect(fmtps[0].get(pt) ?? fmtp).toEqual(fmtp);
      }
      // Assert: 既存 m-line の RED は 63 = 110/110 のまま、追加 m-line の RED (109/109) は 63 以外。
      expect(fmtps[0].get(63)).toEqual("110/110");
      const addedRed = [...fmtps[1]].find(([, fmtp]) => fmtp === "109/109");
      expect(addedRed).toBeDefined();
      expect(addedRed![0]).not.toEqual(63);
    },
  );

  negotiationCase(
    "glare on a connected session: the polite peer's implicit rollback keeps RTP and DataChannel flowing both ways",
    { ref: "origin: issue 818 (review: glare)" },
    async (c) => {
      // Arrange: 接続済みの sendrecv 映像 + DataChannel のセッションで、両 peer が同時に offer を保留する。
      const { a, b, session } = await c.given(createDuplexSession());
      await c.offer(a, { hold: true });
      await c.offer(b, { hold: true });

      // Act: polite な b が a の offer を適用し (have-local-offer を暗黙に rollback)、answer を返す。
      await c.setRemote(b, a.localDescription);
      await c.answer(b);

      // Assert: 確定後も RTP と DataChannel が両方向で届く。
      expect(a.signalingState).toEqual("stable");
      expect(b.signalingState).toEqual("stable");
      await expectSessionAlive(session, "glare");
      await expectSessionContinues(a, b);
    },
  );

  negotiationCase(
    "an unapplied offer created while a remote offer is pending keeps the codec preferences for the answer",
    { ref: "origin: issue 818 (review: preference lost)" },
    async (c) => {
      // Arrange: 両側 VP8 + VP9 で確定し、a が再 offer して b が remote offer を保留する。
      const config = { codecs: { video: [useVP8(), useVP9()] } };
      const { a, b } = await c.given(
        createConnectedVideoPeersWith({ offerer: config, answerer: config }),
      );
      await c.offer(a, { hold: true });
      await c.setRemote(b, a.localDescription);
      expect(b.signalingState).toEqual("have-remote-offer");

      // Act: b が VP9 だけを選好し、適用しない offer を作ってから answer を作る。
      b.getTransceivers()[0].setCodecPreferences([useVP9()]);
      await b.createOffer();
      const answer = await b.createAnswer();

      // Assert: answer は選好した VP9 だけを返す。
      expect(offeredVideoCodecs(answer.sdp)).toEqual(["VP9"]);
      await c.answer(b);
      expect(codecNames(b.getTransceivers()[0].codecs)).toEqual(["VP9"]);
    },
  );

  negotiationCase(
    "a video RED without fmtp stays in later offers after an answer that accepted only VP8",
    { ref: "origin: issue 818 (review: parameterless RED)" },
    async (c) => {
      // Arrange: A は VP8 + RED (fmtp なし)、B は VP8 だけで初回交渉を確定する。
      const red = () =>
        new RTCRtpCodecParameters({
          mimeType: "video/red",
          clockRate: 90000,
          payloadType: 116,
        });
      const { a, b } = await c.given(
        createConnectedVideoPeersWith({
          offerer: { codecs: { video: [useVP8(), red()] } },
          answerer: { codecs: { video: [useVP8()] } },
        }),
      );
      const first = offeredVideoCodecs(a.currentLocalDescription!.sdp);
      expect(first).toEqual(["VP8", "RED"]);

      // Act: A が次の offer を作る。
      const offer = await a.createOffer();

      // Assert: 初回と同じく RED を fmtp なしのまま提示する。
      expect(offeredVideoCodecs(offer.sdp)).toEqual(first);
      expect(offer.sdp).not.toMatch(/a=fmtp:116 /);
      await expectSessionContinues(a, b);
    },
  );

  // A direction change once resolved the offer from the capability of the new
  // direction alone: empty for `inactive` (also what `removeTrack()` makes of
  // `sendonly`) and for the opposite direction of a direction-tagged codec,
  // so createOffer threw NotSupportedError. Negotiated codecs now stay.
  const directionChanges: {
    name: string;
    codecs: () => RTCRtpCodecParameters[];
    negotiated: "sendrecv" | "sendonly";
    change: (pc: RTCPeerConnection, transceiver: RTCRtpTransceiver) => void;
    direction: string;
    /** B has no track: it answers a recvonly offer with inactive */
    current: string;
  }[] = [
    {
      name: "a sendonly VP8 session set to inactive",
      codecs: () => [useVP8({ direction: "sendonly" })],
      negotiated: "sendonly",
      change: (_, t) => (t.direction = "inactive"),
      direction: "inactive",
      current: "inactive",
    },
    {
      name: "removeTrack() on a sendonly VP8 session (it becomes inactive)",
      codecs: () => [useVP8({ direction: "sendonly" })],
      negotiated: "sendonly",
      change: (pc, t) => pc.removeTrack(t.sender),
      direction: "inactive",
      current: "inactive",
    },
    {
      name: "a sendonly session of a VP8 configured for sendrecv set to inactive",
      codecs: () => [useVP8({ direction: "sendrecv" })],
      negotiated: "sendonly",
      change: (_, t) => (t.direction = "inactive"),
      direction: "inactive",
      current: "inactive",
    },
    {
      name: "removeTrack() on a sendonly session of a VP8 configured for sendrecv",
      codecs: () => [useVP8({ direction: "sendrecv" })],
      negotiated: "sendonly",
      change: (pc, t) => pc.removeTrack(t.sender),
      direction: "inactive",
      current: "inactive",
    },
    {
      name: "a sendrecv session of a sendonly VP8 set to recvonly",
      codecs: () => [useVP8({ direction: "sendonly" })],
      negotiated: "sendrecv",
      change: (_, t) => (t.direction = "recvonly"),
      direction: "recvonly",
      current: "inactive",
    },
    {
      name: "a sendrecv session of a recvonly VP8 set to sendonly",
      codecs: () => [useVP8({ direction: "recvonly" })],
      negotiated: "sendrecv",
      change: (_, t) => (t.direction = "sendonly"),
      direction: "sendonly",
      current: "sendonly",
    },
  ];
  for (const row of directionChanges) {
    negotiationCase(
      `direction change keeps the negotiated codec: ${row.name}`,
      { ref: "origin: issue 818 (review: inactive)" },
      async (c) => {
        // Arrange: 方向付きの VP8 だけを持つ A と VP8 の B で交渉を確定する。
        const { a, b } = await c.given(
          createConnectedVideoPeersWith({
            offerer: { codecs: { video: row.codecs() } },
            answerer: { codecs: { video: [useVP8()] } },
            direction: row.negotiated,
          }),
        );
        const transceiver = a.getTransceivers()[0];
        const negotiated = payloadTypes(a.currentLocalDescription!.sdp);
        expect(Object.keys(negotiated)).toEqual(["VP8"]);

        // Act: 方向を変えてから再オファーを適用して B に渡す。
        row.change(a, transceiver);
        const offer = await c.offer(a);

        // Assert: offer は投げずに作られ、VP8 を交渉済みの PT のまま新しい方向で提示する。
        expect(payloadTypes(offer.sdp)).toEqual(negotiated);
        expect(offer.sdp).toMatch(new RegExp(`^a=${row.direction}\r?$`, "m"));

        // Act: B が答え、A が確定する。
        await c.answer(b);

        // Assert: 確定後も VP8 が交渉済みのまま、セッションは続けられる。
        expect(transceiver.currentDirection).toEqual(row.current);
        expect(codecNames(transceiver.codecs)).toEqual(["VP8"]);
        await expectSessionContinues(a, b);
      },
    );
  }

  negotiationCase(
    "an inactive re-offer keeps a sendonly VP9 next to VP8 with their payload types",
    { ref: "origin: issue 818 (review: inactive)" },
    async (c) => {
      // Arrange: 両側 VP8 (all) + VP9 (sendonly) で、sendonly の交渉を VP8 + VP9 で確定する。
      const config = {
        codecs: { video: [useVP8(), useVP9({ direction: "sendonly" })] },
      };
      const { a, b } = await c.given(
        createConnectedVideoPeersWith({ offerer: config, answerer: config }),
      );
      const transceiver = a.getTransceivers()[0];
      const negotiated = payloadTypes(a.currentLocalDescription!.sdp);
      expect(Object.keys(negotiated)).toEqual(["VP8", "VP9"]);

      // Act: inactive にして offer を作る。
      transceiver.direction = "inactive";
      const offer = await a.createOffer();

      // Assert: sendonly 用の VP9 も m-line から外れず、PT と順序も変わらない。
      expect(payloadTypes(offer.sdp)).toEqual(negotiated);
      expect(offeredVideoCodecs(offer.sdp)).toEqual(["VP8", "VP9"]);

      // Act: その offer で交渉を終える。
      await c.setLocal(a, offer);
      await c.setRemote(b, a.localDescription);
      await c.answer(b);

      // Assert: 確定後の交渉済み codec は VP8 + VP9 のまま、セッションは続けられる。
      expect(codecNames(transceiver.codecs)).toEqual(["VP8", "VP9"]);
      await expectSessionContinues(a, b);
    },
  );

  negotiationCase(
    "an inactive transceiver can use a sendonly codec in a first offer and with a track",
    { ref: "origin: issue 818 (review: inactive)" },
    async (c) => {
      // Arrange: 設定は sendonly の VP8 だけ。
      const { a, b } = await c.given(
        createUnnegotiatedPeers({
          codecs: { video: [useVP8({ direction: "sendonly" })] },
        }),
      );

      // Act: inactive の transceiver を track なしと track 付きで追加し、初回 offer を作る。
      a.addTransceiver("video", { direction: "inactive" });
      a.addTransceiver(new MediaStreamTrack({ kind: "video" }), {
        direction: "inactive",
      });
      const offer = await c.offer(a);

      // Assert: どちらの m-line も VP8 を提示する。
      const sections = offer.sdp.split(/^m=/m).slice(1);
      expect(sections.map((section) => offeredVideoCodecs(section))).toEqual([
        ["VP8"],
        ["VP8"],
      ]);

      // Act: B が答え、A が確定する。
      await c.answer(b);

      // Assert: 両 m-line が VP8 で inactive に確定し、セッションは続けられる。
      expect(
        a
          .getTransceivers()
          .map((t) => [t.currentDirection, codecNames(t.codecs)]),
      ).toEqual([
        ["inactive", ["VP8"]],
        ["inactive", ["VP8"]],
      ]);
      await expectSessionContinues(a, b);
    },
  );
});
