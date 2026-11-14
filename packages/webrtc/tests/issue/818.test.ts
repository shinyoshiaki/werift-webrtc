import {
  MediaStreamTrack,
  RTCRtpCodecParameters,
  type RTCRtpTransceiver,
  useH264,
  useVP8,
  useVP9,
} from "../../src";
import {
  describeCases,
  negotiationCase,
} from "../negotiation/harness/negotiationCase";
import {
  createConnectedVideoPeersWith,
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
});
