/**
 * Chrome E2E: Chrome のカメラ映像を werift MediaRecorder が WebM ファイルに録画し、
 * そのファイルを DataChannel で Chrome へ送り返して、Chrome で正常に再生できること。
 *
 * video — VP8 のみ
 * av    — VP8 + Opus（2 トラックの Cluster / Cues）
 */
import {
  appendWebmToMediaSource,
  connectRecordPlayback,
  peer,
  playWebmFile,
  type RecordPlaybackKinds,
  receiveRecordedFile,
  requestServerDone,
  sleep,
} from "../fixture";

/** 録画する長さ。PLI 周期 (2s) より長くし、Cluster が複数できるようにする */
const RECORD_MS = 5_000;
/** Chrome fake camera の解像度（connectRecordPlayback で要求する値） */
const CAMERA = { width: 640, height: 480 };

const cases: {
  kinds: RecordPlaybackKinds;
  mimeType: string;
}[] = [
  { kinds: "video", mimeType: 'video/webm; codecs="vp8"' },
  { kinds: "av", mimeType: 'video/webm; codecs="vp8, opus"' },
];

describe("mediachannel_record_playback", () => {
  for (const { kinds, mimeType } of cases) {
    it(kinds, { timeout: 90_000 }, async () => {
      const label = `mediachannel_record_playback_${kinds}`;
      const { close, dc } = await connectRecordPlayback(label, kinds);
      try {
        // Act: サーバー側で一定時間録画させる
        await sleep(RECORD_MS);
        // Act: 録画を止め、保存された WebM ファイルを DataChannel で受け取る
        const file = await receiveRecordedFile(dc);
        const status = await peer.request(label, { type: "status" });
        // Act: 受け取ったファイルを <video> で最後まで再生し、中央へシークする
        const playback = await playWebmFile(file);
        // Act: Chrome の MSE (WebM バイトストリームパーサ) にファイル全体を渡す
        const mse = await appendWebmToMediaSource(file, mimeType);

        console.log(label, { status, playback, mse });

        // Assert: サーバーは全トラックの RTP を受け取り、録画中にエラーがない
        expect(status.error).toBeUndefined();
        expect(status.tracks).toBe(kinds === "av" ? 2 : 1);
        expect(status.rtpPackets.video).toBeGreaterThan(0);
        if (kinds === "av") {
          expect(status.rtpPackets.audio).toBeGreaterThan(0);
        }
        // Assert: DataChannel で受け取ったバイト数がサーバーのファイルサイズと一致する
        expect(file.byteLength).toBe(status.fileSize);
        // Assert: ファイル先頭は EBML ヘッダ
        expect(Array.from(file.subarray(0, 4))).toEqual([
          0x1a, 0x45, 0xdf, 0xa3,
        ]);

        // Assert: Duration は終了処理で確定しており、録画時間に近い有限値
        expect(Number.isFinite(playback.duration)).toBe(true);
        expect(playback.duration).toBeGreaterThan(RECORD_MS / 1000 / 2);
        expect(playback.duration).toBeLessThan(RECORD_MS / 1000 + 3);
        // Assert: 映像の解像度がカメラと一致し、最後まで再生できる
        expect(playback.videoWidth).toBe(CAMERA.width);
        expect(playback.videoHeight).toBe(CAMERA.height);
        expect(playback.endedAt).toBeGreaterThan(playback.duration * 0.9);
        // Assert: 再生中に複数秒分のフレームがデコードされた
        expect(playback.totalVideoFrames).toBeGreaterThan(30);
        // Assert: 音声付きの場合は音声もデコードされた
        if (kinds === "av") {
          expect(playback.audioDecodedBytes).toBeGreaterThan(0);
        }
        // Assert: 中央へのシークが完了し、黒ではないフレームが描画された
        expect(playback.seekedTo).toBeGreaterThan(0);
        expect(playback.seekedFrameLuma).toBeGreaterThan(0);

        // Assert: MSE でもエラーなく解析され、途切れのない 1 区間としてほぼ全体がバッファされた
        // （av では音声と映像の共通区間なので、音声の欠落も検出できる）
        expect(mse.readyState).toBe("open");
        expect(mse.ranges).toHaveLength(1);
        const bufferedEnd = mse.ranges[0].end;
        expect(bufferedEnd).toBeGreaterThan(playback.duration * 0.8);
      } finally {
        close();
        await requestServerDone(label);
      }
    });
  }
});
