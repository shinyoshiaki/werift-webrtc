/**
 * Chrome E2E: Chrome のマイク音声 (Opus) を werift MediaRecorder が Ogg Opus
 * ファイル (.ogg) に録音し、そのファイルを DataChannel で Chrome へ送り返して、
 * Chrome で正常に再生・デコードできること。
 */
import {
  connectRecordPlayback,
  decodeAudioFile,
  peer,
  playAudioFile,
  receiveRecordedFile,
  requestServerDone,
  sleep,
  summarizeOggFile,
} from "../fixture";

/** 録音する長さ。1 ページ (約 1 秒) より長くし、音声ページが複数できるようにする */
const RECORD_MS = 5_000;
/** Ogg Opus の granule position は常に 48 kHz (RFC 7845 §4) */
const OPUS_RATE = 48_000;

describe("mediachannel_record_playback_ogg", () => {
  it("audio", { timeout: 90_000 }, async () => {
    const label = "mediachannel_record_playback_audio";
    const { close, dc } = await connectRecordPlayback(label, "audio");
    try {
      // Act: サーバー側で一定時間 Ogg に録音させる
      await sleep(RECORD_MS);
      // Act: 録音を止め、保存された Ogg ファイルを DataChannel で受け取る
      const file = await receiveRecordedFile(dc);
      const status = await peer.request(label, { type: "status" });
      // Act: ページ構造を読み、<audio> で最後まで再生し、Web Audio で全体をデコードする
      const ogg = summarizeOggFile(file);
      const playback = await playAudioFile(file, "audio/ogg");
      const decoded = await decodeAudioFile(file);

      console.log(label, { status, ogg, playback, decoded });

      // Assert: サーバーは音声 RTP を受け取り、録音中にエラーがない
      expect(status.error).toBeUndefined();
      expect(status.tracks).toBe(1);
      expect(status.rtpPackets.audio).toBeGreaterThan(0);
      // Assert: DataChannel で受け取ったバイト数がサーバーのファイルサイズと一致する
      expect(file.byteLength).toBe(status.fileSize);

      // Assert: 全ページが同一 serial の Ogg ページで、page sequence は 0 からの連番
      expect(ogg.wellFormed).toBe(true);
      expect(ogg.sequential).toBe(true);
      expect(ogg.pageCount).toBeGreaterThan(4);
      // Assert: 先頭は BOS の OpusHead、続いて OpusTags、最後のページだけが EOS
      expect(ogg.firstHeaderType & 0x02).toBe(0x02);
      expect(ogg.lastHeaderType & 0x04).toBe(0x04);
      expect(ogg.opusHead).toEqual({
        channels: 2,
        preSkip: 0,
        sampleRate: OPUS_RATE,
      });
      expect(ogg.opusTags).toBe(true);
      // Assert: granule position は単調増加し、最後の値は録音時間に近い
      expect(ogg.granuleMonotonic).toBe(true);
      const granuleSec = ogg.lastGranule / OPUS_RATE;
      expect(granuleSec).toBeGreaterThan(RECORD_MS / 1000 / 2);
      expect(granuleSec).toBeLessThan(RECORD_MS / 1000 + 3);
      // Assert: 受信した 20 ms パケット分の音声が欠けずに入っている
      expect(ogg.lastGranule / 960).toBeGreaterThanOrEqual(
        status.rtpPackets.audio - 2,
      );

      // Assert: <audio> の長さは最後の granule と一致し、最後まで再生できる
      expect(playback.duration).toBeCloseTo(granuleSec, 2);
      expect(playback.endedAt).toBeGreaterThan(playback.duration * 0.9);
      expect(playback.audioDecodedBytes).toBeGreaterThan(0);
      // Assert: 中央へのシークが完了する
      expect(playback.seekedTo).toBeGreaterThan(0);

      // Assert: Web Audio でも全体がデコードでき、サンプル数は granule と一致する
      expect(decoded.sampleRate).toBe(OPUS_RATE);
      expect(decoded.numberOfChannels).toBe(2);
      expect(decoded.length).toBe(ogg.lastGranule - ogg.opusHead!.preSkip);
      // Assert: 無音ではなく、マイク (fake device) の音声が入っている
      expect(decoded.peak).toBeGreaterThan(0.01);
    } finally {
      close();
      await requestServerDone(label);
    }
  });
});
