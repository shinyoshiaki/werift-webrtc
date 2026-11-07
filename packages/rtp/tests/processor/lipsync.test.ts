import { createLipsyncFrames, createLipsyncHarness } from "../utils";

const T = 10_000;

describe("lipsync", () => {
  let harness: ReturnType<typeof createLipsyncHarness>;

  afterEach(() => {
    harness?.restore();
  });

  it("outputs the head of a track whose frames arrive late with older times", () => {
    // Arrange
    harness = createLipsyncHarness();
    const video = createLipsyncFrames(T, 3_000, 33);
    const audio = createLipsyncFrames(T, 3_000, 20);

    // Act: 映像だけが先に時刻 T から 3 秒分届く（音声の SR がまだ来ていない状態）
    harness.inputVideo(video);
    // Act: 遅れて SR が届き、溜め込まれていた音声が時刻 T からまとめて届く
    harness.inputAudio(audio);
    // Act: その後も両トラックが同じ時刻で届き続ける
    harness.inputVideo(createLipsyncFrames(T + 3_003, 2_000, 33));
    harness.inputAudio(createLipsyncFrames(T + 3_000, 2_000, 20));

    // Assert: 音声の出力は時刻 T から始まり、先頭が捨てられていない
    expect(harness.output.audio[0].time).toBe(T);
    expect(harness.output.video[0].time).toBe(T);
    // Assert: 遅れて届いた音声 3 秒分がすべて途切れずに出力された
    expect(
      harness.output.audio.slice(0, audio.length).map((f) => f.time),
    ).toEqual(audio.map((f) => f.time));
    expect(
      harness.output.video.slice(0, video.length).map((f) => f.time),
    ).toEqual(video.map((f) => f.time));
  });

  it("starts with the received tracks only after startTimeout", () => {
    // Arrange
    harness = createLipsyncHarness({ startTimeout: 5_000 });

    // Act: 映像だけが 3 秒分届く（タイムアウト前）
    harness.inputVideo(createLipsyncFrames(T, 3_000, 33));
    harness.advanceWallClock(4_999);
    harness.inputVideo(createLipsyncFrames(T + 3_003, 33, 33));

    // Assert: 音声がそろうのを待っているので、まだ何も出力されない
    expect(harness.output.video).toHaveLength(0);

    // Act: タイムアウトを過ぎた後に映像が届く
    harness.advanceWallClock(1);
    harness.inputVideo(createLipsyncFrames(T + 3_036, 33, 33));

    // Assert: 届いている映像だけで、溜めた先頭（時刻 T）から出力が始まる
    expect(harness.output.video.length).toBeGreaterThan(0);
    expect(harness.output.video[0].time).toBe(T);
    expect(harness.output.audio).toHaveLength(0);
  });

  it("outputs the pending frames after startTimeout even without further input", async () => {
    // Arrange
    harness = createLipsyncHarness({ startTimeout: 20 });
    const video = createLipsyncFrames(T, 500, 20);

    // Act: 映像だけが届き、その後は入力が止まったまま期限を過ぎる
    harness.inputVideo(video);
    expect(harness.output.video).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Assert: 追加入力なしでも、溜めた映像がすべて時刻順に出力されている
    expect(harness.output.video.map((f) => f.time)).toEqual(
      video.map((f) => f.time),
    );
    expect(harness.output.audio).toHaveLength(0);
  });

  it("fills dummy audio for the pending span when started by the timer", async () => {
    // Arrange
    harness = createLipsyncHarness({
      startTimeout: 20,
      fillDummyAudioPacket: Buffer.from([1]),
    });

    // Act: 映像だけが届き、音声なしのまま期限を過ぎる
    harness.inputVideo(createLipsyncFrames(T, 1_000, 20));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Assert: 映像が時刻順に出力され、音声なしの区間にダミー音声が補完される
    expect(harness.output.video[0].time).toBe(T);
    expect(harness.output.audio.length).toBeGreaterThan(0);
    expect(harness.output.audio[0].time).toBe(T);
  });

  describe.each([
    { name: "without dummy audio", fillDummyAudioPacket: undefined },
    { name: "with dummy audio", fillDummyAudioPacket: Buffer.from([1]) },
  ])("timer start $name", ({ fillDummyAudioPacket }) => {
    // 期限前に届く映像（最後のフレームは区間の途中の T+400）
    const pending = createLipsyncFrames(T, 420, 20);
    // 期限後に届く映像（T+400 と同じ区間の T+420 から続く）
    const resumed = createLipsyncFrames(T + 420, 1_600, 20);

    const expectNoDummyAudioBeyond = (latest: number) => {
      const times = harness.output.audio.map((f) => f.time);
      if (fillDummyAudioPacket) {
        // Assert: ダミー音声は先頭から時刻順に ptime 以下の間隔で隙間なく続き、
        // 受信済みの最新フレームを越えない
        expect(times[0]).toBe(T);
        const steps = times.slice(1).map((t, i) => t - times[i]);
        expect(steps.every((step) => step > 0 && step <= 20)).toBe(true);
        expect(Math.max(...times)).toBeLessThanOrEqual(latest);
      } else {
        // Assert: 無音補完なしでは音声は出力されない
        expect(times).toHaveLength(0);
      }
    };

    it("outputs every pending frame when input stops", async () => {
      // Arrange
      harness = createLipsyncHarness({
        startTimeout: 20,
        fillDummyAudioPacket,
      });

      // Act: 映像だけが届き、その後は入力が止まったまま期限を過ぎる
      harness.inputVideo(pending);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Assert: 溜めた映像が欠落なく時刻順に出力される
      expect(harness.output.video.map((f) => f.time)).toEqual(
        pending.map((f) => f.time),
      );
      expectNoDummyAudioBeyond(T + 400);
    });

    it("keeps the frames of the same interval that arrive after the start", async () => {
      // Arrange
      harness = createLipsyncHarness({
        startTimeout: 20,
        fillDummyAudioPacket,
      });
      harness.inputVideo(pending);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const outputAtStart = harness.output.video.length;

      // Act: タイマー開始の後、同じ区間（T+420〜）から映像の入力が続く
      harness.inputVideo(resumed);

      // Assert: タイマー開始で溜めた映像がすべて出力済みだった
      expect(outputAtStart).toBe(pending.length);
      // Assert: 出力は入力の先頭からの連続した列と完全一致し、欠落がない
      const all = [...pending, ...resumed].map((f) => f.time);
      const times = harness.output.video.map((f) => f.time);
      expect(times).toEqual(all.slice(0, times.length));
      // Assert: 指摘された T+420〜T+480 を含め、期限後の入力も出力が進んでいる
      expect(times.length).toBeGreaterThan(pending.length + 4);
      expectNoDummyAudioBeyond(Math.max(...all));
    });
  });

  it("clears the start timer on stop", async () => {
    // Arrange
    harness = createLipsyncHarness({ startTimeout: 20 });
    harness.inputVideo(createLipsyncFrames(T, 100, 20));

    // Act: 期限前に終了し、期限を過ぎるまで待つ
    harness.lipsync.inputVideo({ eol: true });
    const outputLength = harness.output.video.length;
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Assert: 終了時に溜めた分が出力済みで、期限後に追加出力されない
    expect(outputLength).toBe(5);
    expect(harness.output.video).toHaveLength(outputLength);
    expect(harness.output.videoEol).toBe(true);
  });

  it("starts without waiting when only video is configured", () => {
    // Arrange
    harness = createLipsyncHarness({ kinds: ["video"] });

    // Act: 映像だけを 1 秒分流す
    harness.inputVideo(createLipsyncFrames(T, 1_000, 33));

    // Assert: 音声を待たずに時刻 T から出力が始まる
    expect(harness.output.video.length).toBeGreaterThan(0);
    expect(harness.output.video[0].time).toBe(T);
  });

  it("flushes the pending frames in time order when EOL arrives before start", () => {
    // Arrange
    harness = createLipsyncHarness();
    const video = createLipsyncFrames(T, 1_000, 33);
    harness.inputVideo(video);

    // Act: 音声がそろう前に映像の EOL が届き、その後に音声が届く
    harness.lipsync.inputVideo({ eol: true });
    const videoEolAfterFlush = harness.output.videoEol;
    harness.inputAudio(createLipsyncFrames(T, 100, 20));

    // Assert: 溜めていた映像がすべて時刻順に出力されてから EOL が出力される
    expect(harness.output.video.map((f) => f.time)).toEqual(
      video.map((f) => f.time),
    );
    expect(videoEolAfterFlush).toBe(true);
    // Assert: EOL の後に届いたフレームは出力されない
    expect(harness.output.audio).toHaveLength(0);
  });
});
