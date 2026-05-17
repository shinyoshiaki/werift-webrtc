import { useH264, useVP8 } from "../../src";
import {
  extractVideoKeyframes,
  getUserMediaE2EAssetPath,
  roundTripMediaAsset,
} from "./userMediaTestUtils";

describe("nonstandard/userMedia e2e file playback", () => {
  test("round-trips the ffmpeg MP4 asset through RTP and MP4 recording with a matching H264 keyframe", async () => {
    const sourcePath = getUserMediaE2EAssetPath("h264-opus.mp4");
    const sourceKeyframes = await extractVideoKeyframes(sourcePath);
    const recorded = await roundTripMediaAsset({
      sourcePath,
      videoCodec: useH264({
        parameters:
          "profile-level-id=42c00a;packetization-mode=1;level-asymmetry-allowed=1",
      }),
      recordingFormat: "mp4",
    });

    try {
      // 実行: MP4 asset を getUserMedia で送出し、対向 peer で MP4 に録画した結果を再パースする。
      const recordedKeyframes = await extractVideoKeyframes(
        recorded.outputPath,
      );

      // 検証: 対向で実際に RTP を受信しており、録画後に再度パースした H264 keyframe の一つが source と完全一致する。
      expect(recorded.recordedVideoPacketCount).toBeGreaterThan(0);
      expect(recorded.recordedAudioPacketCount).toBeGreaterThan(0);
      expect(
        recordedKeyframes.some((recordedKeyframe) =>
          sourceKeyframes.some((sourceKeyframe) =>
            sourceKeyframe.equals(recordedKeyframe),
          ),
        ),
      ).toBe(true);
    } finally {
      await recorded.cleanup();
    }
  }, 30_000);

  test("round-trips the ffmpeg WebM asset through RTP and WebM recording with a matching VP8 keyframe", async () => {
    const sourcePath = getUserMediaE2EAssetPath("vp8-opus.webm");
    const sourceKeyframes = await extractVideoKeyframes(sourcePath);
    const recorded = await roundTripMediaAsset({
      sourcePath,
      videoCodec: useVP8(),
      recordingFormat: "webm",
    });

    try {
      // 実行: WebM asset を getUserMedia で送出し、対向 peer で WebM に録画した結果を再パースする。
      const recordedKeyframes = await extractVideoKeyframes(
        recorded.outputPath,
      );

      // 検証: 対向で実際に RTP を受信しており、録画後に再度パースした VP8 keyframe の一つが source と完全一致する。
      expect(recorded.recordedVideoPacketCount).toBeGreaterThan(0);
      expect(recorded.recordedAudioPacketCount).toBeGreaterThan(0);
      expect(
        recordedKeyframes.some((recordedKeyframe) =>
          sourceKeyframes.some((sourceKeyframe) =>
            sourceKeyframe.equals(recordedKeyframe),
          ),
        ),
      ).toBe(true);
    } finally {
      await recorded.cleanup();
    }
  }, 30_000);
});
