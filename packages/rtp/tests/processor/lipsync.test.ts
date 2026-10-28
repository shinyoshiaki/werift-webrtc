import { LipsyncBase } from "../../src/extra/processor/lipsync";

describe("LipsyncBase", () => {
  const arrange = () => {
    const audio: (number | "eol")[] = [];
    const video: (number | "eol")[] = [];
    const lipsync = new LipsyncBase(
      (o) => audio.push(o.frame ? o.frame.time : "eol"),
      (o) => video.push(o.frame ? o.frame.time : "eol"),
    );
    const frame = (time: number) => ({
      frame: { time, data: Buffer.from([0]), isKeyframe: true },
    });
    return { lipsync, audio, video, frame };
  };

  test("終了時、同期間隔に満たず保持していたフレームを捨てずに時刻順で出力してから eol を出す", () => {
    // Arrange: 同期間隔 (500ms) に満たない 300ms 分の音声と映像
    const { lipsync, audio, video, frame } = arrange();
    for (let time = 0; time < 300; time += 20) {
      lipsync.processAudioInput(frame(time));
    }
    lipsync.processVideoInput(frame(100));
    lipsync.processVideoInput(frame(200));

    // Act: 音声が先に終わる
    lipsync.processAudioInput({ eol: true });

    // Assert: 保持していた音声 15 フレームを時刻順に出し、最後に eol。映像も捨てない
    expect(audio).toEqual([
      ...Array.from({ length: 15 }, (_, i) => i * 20),
      "eol",
    ]);
    expect(video).toEqual([100, 200]);
  });

  test("一方の終了で出力済みなら、もう一方の終了では eol だけを出す", () => {
    // Arrange
    const { lipsync, audio, video, frame } = arrange();
    lipsync.processAudioInput(frame(0));
    lipsync.processVideoInput(frame(10));
    lipsync.processAudioInput({ eol: true });

    // Act
    lipsync.processVideoInput({ eol: true });

    // Assert: 重複して出力しない
    expect(audio).toEqual([0, "eol"]);
    expect(video).toEqual([10, "eol"]);
  });
});
