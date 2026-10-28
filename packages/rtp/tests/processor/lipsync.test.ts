import { LipsyncCallback } from "../../src/extra/processor/lipsyncCallback";

describe("Lipsync", () => {
  const arrange = () => {
    const audio: (number | "eol")[] = [];
    const video: (number | "eol")[] = [];
    // MediaRecorder と同じく、音声・映像の両方を pipe してから入力する
    const lipsync = new LipsyncCallback();
    lipsync.pipeAudio((o) => audio.push(o.frame ? o.frame.time : "eol"));
    lipsync.pipeVideo((o) => video.push(o.frame ? o.frame.time : "eol"));
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

    // Act: 音声、映像の順に終わる
    lipsync.processAudioInput({ eol: true });
    lipsync.processVideoInput({ eol: true });

    // Assert: 保持していた音声 15 フレームを時刻順に出し、最後に eol。映像も捨てない
    expect(audio).toEqual([
      ...Array.from({ length: 15 }, (_, i) => i * 20),
      "eol",
    ]);
    expect(video).toEqual([100, 200, "eol"]);
  });

  test("映像が先に終わっても、遅れて排出された音声を捨てずに出力してから終わる", () => {
    // Arrange: 映像は 4 秒分進む。音声は jitter buffer が欠番を待って保持している
    const { lipsync, audio, video, frame } = arrange();
    for (let time = 0; time <= 4000; time += 40) {
      lipsync.processVideoInput(frame(time));
    }

    // Act: 映像が終わった後、音声 jitter buffer が保持していた 4 秒分を排出して終わる
    lipsync.processVideoInput({ eol: true });
    for (let time = 0; time <= 4000; time += 20) {
      lipsync.processAudioInput(frame(time));
    }
    lipsync.processAudioInput({ eol: true });

    // Assert: 音声 201 フレームと映像 101 フレームが全て時刻順に出て、両方の eol が出る
    expect(audio).toEqual([
      ...Array.from({ length: 201 }, (_, i) => i * 20),
      "eol",
    ]);
    expect(video).toEqual([
      ...Array.from({ length: 101 }, (_, i) => i * 40),
      "eol",
    ]);
  });

  test("音声が映像より遅れて届いても、映像に追い越されて古いフレームとして捨てない", () => {
    // Arrange
    const { lipsync, audio, frame } = arrange();

    // Act: 映像が 3 秒先行してから、遅れていた音声が届く (どちらも終わらない)
    for (let time = 0; time <= 3000; time += 40) {
      lipsync.processVideoInput(frame(time));
    }
    for (let time = 0; time <= 3000; time += 20) {
      lipsync.processAudioInput(frame(time));
    }

    // Assert: 既に出力した分に音声の欠落がない (先頭から 20ms 刻みで連続)
    expect(audio.length).toBeGreaterThan(0);
    expect(audio).toEqual(
      Array.from({ length: audio.length }, (_, i) => i * 20),
    );
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
