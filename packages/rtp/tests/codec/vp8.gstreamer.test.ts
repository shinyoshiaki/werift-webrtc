import {
  captureGstreamerVp8Rtp,
  decodeWebmWithFfmpeg,
  isGstreamerVp8Available,
  recordVp8RtpToWebm,
  rewriteVp8RtpDescriptor,
} from "../utils";

// GStreamer vp8enc / rtpvp8pay → loopback UDP → werift depacketize / WebM 録画
// → ffmpeg デコードの E2E。実エンコーダは L=1,T=1 または X/I/M のみを出すため、
// RFC 7741 §4.2 の各 L/T/K 組み合わせは実ストリームの descriptor を書き換えて作る。
const FRAMES = 60;
const KEYFRAME_INTERVAL = 30;

describe.skipIf(!isGstreamerVp8Available())(
  "packages/rtp/tests/codec/vp8.gstreamer.test.ts",
  () => {
    let packets: Buffer[] = [];
    let baseline: Awaited<ReturnType<typeof recordVp8RtpToWebm>>;
    let baselineMd5s: string[] = [];

    beforeAll(async () => {
      // Arrange: GStreamer で実 VP8 ストリームを RTP 化して受信し、無加工で基準を録画
      packets = await captureGstreamerVp8Rtp({
        frames: FRAMES,
        keyframeInterval: KEYFRAME_INTERVAL,
      });
      baseline = await recordVp8RtpToWebm(packets);
      baselineMd5s = decodeWebmWithFfmpeg(baseline.webm).frameMd5s;
    }, 60_000);

    it("baseline: rtpvp8pay stream is depacketized and decodable", () => {
      // Assert: loopback でパケットロスがなく、複数パケットに分割されたフレームを含むこと
      const seqs = packets.map((p) => p.readUInt16BE(2));
      seqs.forEach((seq, i) => {
        if (i > 0) expect(seq).toBe((seqs[i - 1] + 1) & 0xffff);
      });
      expect(packets.length).toBeGreaterThan(FRAMES);
      // Assert: 全フレームが復元され、keyframe は keyframe-max-dist ごとに検出されること
      expect(baseline.frames.length).toBe(FRAMES);
      expect(baseline.frames.filter((f) => f.isKeyframe).length).toBe(
        FRAMES / KEYFRAME_INTERVAL,
      );
      // Assert: ffmpeg がエラーなしで全フレームをデコードできること
      const decoded = decodeWebmWithFfmpeg(baseline.webm);
      expect(decoded.errors).toBe("");
      expect(decoded.status).toBe(0);
      expect(decoded.frameMd5s.length).toBe(FRAMES);
    });

    it.each([
      { name: "T=1, L=0, K=0", ext: { t: true } },
      { name: "K=1, L=0, T=0", ext: { k: true } },
      { name: "L=1, T=1 (browser temporal layers)", ext: { l: true, t: true } },
      { name: "L=1, T=1, K=1", ext: { l: true, t: true, k: true } },
      { name: "L=1, T=0, K=0 (violates RFC)", ext: { l: true } },
    ])("$name: recording matches the unmodified stream", async ({ ext }) => {
      // Arrange: 同じ RTP の descriptor だけを L/T/K 付きに書き換える
      const rewritten = packets.map((p) => rewriteVp8RtpDescriptor(p, ext));

      // Act: depacketize → WebM 録画 → ffmpeg デコード
      const recorded = await recordVp8RtpToWebm(rewritten);
      const decoded = decodeWebmWithFfmpeg(recorded.webm);

      // Assert: 復元フレームのデータと keyframe 判定が無加工ストリームと一致すること
      expect(recorded.frames.length).toBe(baseline.frames.length);
      recorded.frames.forEach((frame, i) => {
        expect(frame.isKeyframe).toBe(baseline.frames[i].isKeyframe);
        expect(frame.data.equals(baseline.frames[i].data)).toBe(true);
      });
      // Assert: ffmpeg がエラーなしでデコードし、デコード結果が基準と同一であること
      expect(decoded.errors).toBe("");
      expect(decoded.status).toBe(0);
      expect(decoded.frameMd5s).toEqual(baselineMd5s);
    });
  },
);
