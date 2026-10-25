/**
 * Chrome E2E: werift が送出する VP8 を Chrome が正常にデコード・再生できること。
 *
 * file  — webrtc nonstandard userMedia のファイル再生（polyfill MP4/WebM register の実体）
 * dummy — navigator.mediaDevices.getUserMedia の dummyMedia
 *
 * packages/rtp Packetizer 単体の経路（複数パケットへの分割を含む）は
 * codecRtp.test.ts の scenario B で扱う。
 */
import {
  connectToServerOffer,
  getInboundVideoDecodeStats,
  peer,
  requestServerDone,
  sleep,
  waitFramesDecoded,
  waitVideoElementPlayback,
  waitVideoPlay,
} from "../fixture";

/** fixtures/media/vp8.webm: 320x240, 30fps, 2s */
const FIXTURE = { width: 320, height: 240, fps: 30, durationSec: 2 };
/** dummyMedia の VP8 フレーム（16x16 黒、既定 30fps / keyframe 30 フレーム周期） */
const DUMMY = { width: 16, height: 16 };

describe("mediachannel_vp8_playback", () => {
  it("file", async () => {
    const label = "mediachannel_vp8_playback_file";
    const { pc, track } = await connectToServerOffer(label, "vp8", "video");
    try {
      // Act: 画素が変化するまで待つ（デコードしたフレームが描画され、動きが反映される）
      await waitVideoPlay(track, 20_000);
      // Act: fixture 1 周（60 フレーム）を超え、ループ後もデコードが続くまで待つ
      const decoded = await waitFramesDecoded(
        pc,
        FIXTURE.durationSec * FIXTURE.fps + FIXTURE.fps,
        20_000,
      );
      // Act: <video> 要素で再生時間が 1 秒以上進むまで待つ
      const playback = await waitVideoElementPlayback(track, 15_000);
      // Act: 1 秒あけて decode 数を計測し、継続してデコードされているか見る
      const before = await getInboundVideoDecodeStats(pc);
      await sleep(1_000);
      const after = await getInboundVideoDecodeStats(pc);
      const status = await peer.request(label, { type: "status" });

      // Assert: 送出 RTP はブラウザ同様 X/I/M + 15bit PictureID を持ち、
      // ループ境界をまたいでもフレームごとに +1 される
      expect(status.sourceError).toBeUndefined();
      expect(status.packetsWithoutPictureId).toBe(0);
      expect(status.pictureIdMismatchInFrame).toBe(0);
      expect(status.pictureIdGapDetails).toEqual([]);
      expect(status.frames).toBeGreaterThan(FIXTURE.durationSec * FIXTURE.fps);
      // Assert: Chrome がキーフレームを含めて fixture の解像度でデコードしている
      expect(decoded.keyFramesDecoded).toBeGreaterThanOrEqual(1);
      expect(decoded.frameWidth).toBe(FIXTURE.width);
      expect(decoded.frameHeight).toBe(FIXTURE.height);
      // Assert: <video> 要素の再生サイズが fixture と一致する
      expect(playback.videoWidth).toBe(FIXTURE.width);
      expect(playback.videoHeight).toBe(FIXTURE.height);
      // Assert: 30fps ソースが 1 秒間で概ね途切れずにデコードされている
      expect(after.framesDecoded - before.framesDecoded).toBeGreaterThanOrEqual(
        FIXTURE.fps * 0.6,
      );
    } finally {
      await requestServerDone(label);
      pc.close();
    }
  }, 60_000);

  it("dummy", async () => {
    const label = "mediachannel_vp8_playback_dummy";
    const { pc, track } = await connectToServerOffer(label, "vp8", "video");
    try {
      // Act: Chrome が dummy VP8 を 1 秒分（30 フレーム）デコードするまで待つ
      const decoded = await waitFramesDecoded(pc, 30, 20_000);
      // Act: <video> 要素で再生時間が 1 秒以上進むまで待つ
      const playback = await waitVideoElementPlayback(track, 15_000);
      // Act: 1 秒あけて decode 数を計測し、継続してデコードされているか見る
      const before = await getInboundVideoDecodeStats(pc);
      await sleep(1_000);
      const after = await getInboundVideoDecodeStats(pc);
      const status = await peer.request(label, { type: "status" });

      // Assert: dummy も X/I/M + PictureID を持ち、フレームごとに +1 される
      expect(status.packetsWithoutPictureId).toBe(0);
      expect(status.pictureIdGapDetails).toEqual([]);
      // Assert: Chrome がキーフレームを含めて dummy の解像度でデコードしている
      expect(decoded.keyFramesDecoded).toBeGreaterThanOrEqual(1);
      expect(decoded.frameWidth).toBe(DUMMY.width);
      expect(decoded.frameHeight).toBe(DUMMY.height);
      // Assert: <video> 要素の再生サイズが dummy と一致する
      expect(playback.videoWidth).toBe(DUMMY.width);
      expect(playback.videoHeight).toBe(DUMMY.height);
      // Assert: キーフレーム後のデルタフレームも途切れずにデコードされている
      expect(after.framesDecoded - before.framesDecoded).toBeGreaterThanOrEqual(
        18,
      );
    } finally {
      await requestServerDone(label);
      pc.close();
    }
  }, 60_000);
});
