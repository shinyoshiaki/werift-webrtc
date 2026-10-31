import { describe, expect, it } from "vitest";

import { WeriftError } from "../../src/imports/common";
import { MediaRecorder } from "../../src/nonstandard";
import { OggFactory } from "../../src/nonstandard/recorder/writer/ogg";
import { WebmFactory } from "../../src/nonstandard/recorder/writer/webm";
import {
  createOggInput,
  createOggStream,
  createOpusTrack,
  createPcmuTrack,
  createRecordingDir,
  createVp8Track,
  feedOpusRtp,
  oggHeaderTypes,
  waitForOggRecorderStarted,
} from "./recorderTestUtils";

describe("packages/webrtc/tests/nonstandard/recorder.test.ts", () => {
  it.each(["ogg", "opus"])("records an opus track to .%s", async (ext) => {
    // Arrange
    const dir = await createRecordingDir();
    const track = createOpusTrack();
    try {
      const recorder = new MediaRecorder({
        path: dir.path(`out.${ext}`),
        tracks: [track],
        disableNtp: true,
      });

      await waitForOggRecorderStarted(recorder);

      // Act: 1 秒分の Opus RTP を流してから停止する。
      feedOpusRtp(track, 50);
      await recorder.stop();
      const buffer = await dir.read(`out.${ext}`);

      // Assert: Ogg 用 writer が選ばれ、最終ページが EOS になる。
      expect(recorder.format).toBe("ogg");
      expect(recorder.writer).toBeInstanceOf(OggFactory);
      expect(oggHeaderTypes(buffer).at(-1)).toBe(0x04);
      // Assert: mediabunny で 1 秒の Opus 音声として読める。
      const input = createOggInput(buffer);
      try {
        const [audio] = await input.getAudioTracks();
        expect(await audio!.getCodec()).toBe("opus");
        expect(await audio!.getNumberOfChannels()).toBe(2);
        expect(await input.computeDuration()).toBeCloseTo(1, 2);
      } finally {
        input.dispose();
      }
    } finally {
      await dir.cleanup();
    }
  });

  it("reports a write failure through onError and stops without crashing", async () => {
    // Arrange: 存在しないディレクトリを保存先にする。
    const dir = await createRecordingDir();
    const track = createOpusTrack();
    const baseline = {
      rtp: track.onReceiveRtp.length,
      rtcp: track.onReceiveRtcp.length,
    };
    const errors: Error[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const recorder = new MediaRecorder({
        path: dir.path("missing/out.ogg"),
        tracks: [track],
        disableNtp: true,
      });
      recorder.onError.subscribe((e) => errors.push(e));
      await waitForOggRecorderStarted(recorder);

      // Act: RTP を流して停止する。
      feedOpusRtp(track, 10);
      await new Promise((r) => setTimeout(r, 50));
      expect(errors.length).toBe(1);
      const started = Date.now();
      await recorder.stop();

      // Assert: 失敗後は RTP の購読が解除され、以後のパケットは処理されない。
      expect(track.onReceiveRtp.length).toBe(baseline.rtp);
      expect(track.onReceiveRtcp.length).toBe(baseline.rtcp);
      // Assert: 書き込みエラーが onError に通知され、停止は 5 秒待たずに完了する。
      expect(errors.length).toBe(1);
      expect(Date.now() - started).toBeLessThan(2000);
      // Assert: 未処理の Promise 拒否は発生しない。
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await dir.cleanup();
    }
  });

  it("reorders out-of-order opus packets before writing", async () => {
    // Arrange
    const dir = await createRecordingDir();
    const track = createOpusTrack();
    try {
      const recorder = new MediaRecorder({
        path: dir.path("out.ogg"),
        tracks: [track],
        disableNtp: true,
      });
      await waitForOggRecorderStarted(recorder);

      // Act: 順序が入れ替わった 4 パケット (0, 2, 1, 3) を流して停止する。
      feedOpusRtp(track, [0, 2, 1, 3]);
      await recorder.stop();
      const input = createOggInput(await dir.read("out.ogg"));

      // Assert: 重複・補完なしで 80ms の録音になる。
      try {
        expect(await input.computeDuration()).toBeCloseTo(0.08, 3);
      } finally {
        input.dispose();
      }
    } finally {
      await dir.cleanup();
    }
  });

  it("keeps every received packet when one packet is lost", async () => {
    // Arrange
    const dir = await createRecordingDir();
    const track = createOpusTrack();
    try {
      const recorder = new MediaRecorder({
        path: dir.path("out.ogg"),
        tracks: [track],
        disableNtp: true,
      });
      await waitForOggRecorderStarted(recorder);

      // Act: パケット 0〜30 のうち 1 だけを欠落させて流し、停止する。
      const order = Array.from({ length: 31 }, (_, i) => i).filter(
        (i) => i !== 1,
      );
      feedOpusRtp(track, order);
      await recorder.stop();
      const buffer = await dir.read("out.ogg");

      // Assert: 正常に受信した 30 パケットの音声がすべて録音に残る。
      for (const i of order) {
        expect(buffer.includes(Buffer.from([0xfc, i, 0x00]))).toBe(true);
      }
      // Assert: 欠落分は補完され、録音時間は 31 パケット分 (620ms) になる。
      const input = createOggInput(buffer);
      try {
        expect(await input.computeDuration()).toBeCloseTo(0.62, 3);
      } finally {
        input.dispose();
      }
    } finally {
      await dir.cleanup();
    }
  });

  it("finishes the file when stopped right after construction", async () => {
    // Arrange
    const dir = await createRecordingDir();
    try {
      const recorder = new MediaRecorder({
        path: dir.path("out.ogg"),
        tracks: [createOpusTrack()],
      });

      // Act: 非同期の start 完了を待たずに stop する。
      const startedAt = Date.now();
      await recorder.stop();

      // Assert: start 完了後に停止され、EOL のタイムアウトを待たずに EOS ページまで書かれる。
      expect(Date.now() - startedAt).toBeLessThan(4000);
      expect(oggHeaderTypes(await dir.read("out.ogg"))).toEqual([
        0x02, 0x00, 0x04,
      ]);
    } finally {
      await dir.cleanup();
    }
  });

  it("streams ogg with format: ogg", async () => {
    // Arrange
    const track = createOpusTrack();
    const { stream, outputs, buffer } = createOggStream();
    const recorder = new MediaRecorder({
      stream,
      format: "ogg",
      tracks: [track],
      disableNtp: true,
    });
    await waitForOggRecorderStarted(recorder);

    // Act
    feedOpusRtp(track, 10);
    await recorder.stop();

    // Assert: stream に BOS から EOS までのページと eol が通知される。
    const types = oggHeaderTypes(buffer());
    expect(types[0]).toBe(0x02);
    expect(types.at(-1)).toBe(0x04);
    expect(outputs.at(-1)!.eol).toEqual({ duration: 200 });
  });

  it("keeps WebM as the default for stream only", () => {
    // Act
    const recorder = new MediaRecorder({
      stream: createOggStream().stream as any,
      numOfTracks: 1,
    });

    // Assert: format 未指定の stream 出力は従来通り WebM。
    expect(recorder.format).toBe("webm");
    expect(recorder.writer).toBeInstanceOf(WebmFactory);
  });

  it.each([
    ["a video track", () => ({ tracks: [createVp8Track()] })],
    ["a non-opus track", () => ({ tracks: [createPcmuTrack()] })],
    ["two tracks", () => ({ tracks: [createOpusTrack(), createOpusTrack()] })],
    ["numOfTracks: 2", () => ({ numOfTracks: 2 })],
  ])("rejects %s for ogg", (_, props) => {
    // Act / Assert: Ogg で扱えない構成はメッセージ付き WeriftError になる。
    expect(
      () => new MediaRecorder({ path: "x.ogg", ...(props() as any) }),
    ).toThrow(WeriftError);
    expect(
      () => new MediaRecorder({ path: "x.ogg", ...(props() as any) }),
    ).toThrow(/ogg recording/);
  });

  it("rejects a video track added later to an ogg recorder", async () => {
    // Arrange
    const recorder = new MediaRecorder({ path: "x.ogg", numOfTracks: 1 });

    // Act / Assert: addTrack 時点で video トラックが拒否され、録音は開始されない。
    await expect(recorder.addTrack(createVp8Track())).rejects.toThrow(
      /does not support video/,
    );
    expect(recorder.started).toBe(false);
  });

  it.each([
    [{ path: "x.mp4", numOfTracks: 1 }, /unsupported file extension: \.mp4/],
    [
      { path: "x.webm", format: "ogg" as const, numOfTracks: 1 },
      /does not match format ogg/,
    ],
  ])("rejects %o", (props, message) => {
    // Act / Assert: 未対応拡張子や format との矛盾はメッセージ付きエラーになる。
    expect(() => new MediaRecorder(props)).toThrow(message);
  });
});
