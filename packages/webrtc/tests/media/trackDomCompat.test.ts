import { MediaStream, MediaStreamTrack } from "../../src/media/track";
import {
  arrangeIdentifiedVideoRegister,
  arrangeOpusTrack,
  arrangeStream,
  arrangeVp8Track,
  captureRejection,
  expectOverconstrained,
} from "./trackDomCompatTestUtils";

describe("MediaStreamTrack DOM-compatible members", () => {
  test("defaults match the DOM attributes", () => {
    // Arrange
    const track = new MediaStreamTrack({ kind: "audio" });

    // Act / Assert: id は uuid で埋まり、contentHint と on* ハンドラは DOM の既定値になる。
    expect(track.id).toBe(track.uuid);
    expect(track.contentHint).toBe("");
    expect(track.onended).toBeNull();
    expect(track.onmute).toBeNull();
    expect(track.onunmute).toBeNull();
  });

  test("onended is called once after the ended listeners", () => {
    // Arrange
    const track = arrangeOpusTrack();
    const calls: string[] = [];
    const events: unknown[] = [];
    track.addEventListener("ended", (event) => {
      calls.push("listener");
      events.push(event);
    });
    track.onended = function (this: unknown, event) {
      calls.push(this === track ? "onended(this=track)" : "onended");
      events.push(event);
    };

    // Act: stop を 2 回呼ぶ。
    track.stop();
    track.stop();

    // Assert: listener の後に onended が 1 回だけ呼ばれ、同じ "ended" Event を受け取る。
    expect(calls).toEqual(["listener", "onended(this=track)"]);
    expect(events[0]).toBe(events[1]);
    expect((events[0] as Event).type).toBe("ended");
  });

  test("stopMediaSource calls onended of every clone", () => {
    // Arrange
    const track = arrangeOpusTrack();
    const cloned = track.clone();
    const ended: string[] = [];
    track.onended = () => ended.push("original");
    cloned.onended = () => ended.push("clone");

    // Act: 共有 source を止める。
    track.stopMediaSource();

    // Assert: 両方の track の onended が呼ばれる。
    expect(ended.sort()).toEqual(["clone", "original"]);
  });

  test("getSettings of a constructed track reports its codec", () => {
    // Arrange
    const audio = arrangeOpusTrack();
    const video = arrangeVp8Track();
    const bare = new MediaStreamTrack({ kind: "video" });

    // Act
    const settings = [audio, video, bare].map((track) => track.getSettings());

    // Assert: codec 由来の値だけを返し、codec がなければ空になる。
    expect(settings).toEqual([
      { mimeType: "audio/OPUS", sampleRate: 48000, channelCount: 2 },
      { mimeType: "video/VP8" },
      {},
    ]);
    expect(video.getCapabilities()).toEqual({});
    expect(video.getConstraints()).toEqual({});
  });

  test("getUserMedia tracks report the selected register", async () => {
    // Arrange
    const { uninstall } = arrangeIdentifiedVideoRegister();
    try {
      // Act: 未対応の width を含む制約で取得する。
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: "camera-1" }, width: 640 },
      });
      const [track] = stream.getVideoTracks();

      // Assert: register の deviceId / groupId / mimeType と、対応する制約だけが残る。
      expect(track.getSettings()).toEqual({
        deviceId: "camera-1",
        groupId: "group-1",
        mimeType: "video/VP8",
      });
      expect(track.getCapabilities()).toEqual({
        deviceId: "camera-1",
        groupId: "group-1",
      });
      expect(track.getConstraints()).toEqual({
        deviceId: { exact: "camera-1" },
      });
      track.stop();
    } finally {
      uninstall();
    }
  });

  test("applyConstraints stores satisfiable constraints", async () => {
    // Arrange
    const { uninstall } = arrangeIdentifiedVideoRegister();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const [track] = stream.getVideoTracks();

      // Act: 満たせる exact 制約、満たせない ideal / advanced、未対応制約を適用する。
      await track.applyConstraints({
        groupId: { exact: "group-1" },
        deviceId: "other-camera",
        advanced: [{ mimeType: "video/H264" }],
        frameRate: 30,
      } as Parameters<typeof track.applyConstraints>[0]);

      // Assert: resolve し、対応する制約が保持され、settings は変わらない。
      expect(track.getConstraints()).toEqual({
        groupId: { exact: "group-1" },
        deviceId: "other-camera",
        advanced: [{ mimeType: "video/H264" }],
      });
      expect(track.getSettings().deviceId).toBe("camera-1");

      // Act: 引数なしで適用する。
      await track.applyConstraints();

      // Assert: 制約が空に戻る。
      expect(track.getConstraints()).toEqual({});
      track.stop();
    } finally {
      uninstall();
    }
  });

  test("applyConstraints rejects unsatisfiable required constraints", async () => {
    // Arrange
    const track = arrangeVp8Track();
    await track.applyConstraints({ mimeType: { exact: "video/VP8" } });

    // Act: 現在の settings で満たせない exact 制約を適用する。
    const deviceError = await captureRejection(() =>
      track.applyConstraints({ deviceId: { exact: "camera-1" } }),
    );
    const mimeError = await captureRejection(() =>
      track.applyConstraints({ mimeType: { exact: ["video/H264"] } }),
    );

    // Assert: OverconstrainedError で reject し、直前の制約を保持する。
    expectOverconstrained(deviceError, "deviceId");
    expectOverconstrained(mimeError, "mimeType");
    expect(track.getConstraints()).toEqual({
      mimeType: { exact: "video/VP8" },
    });
  });

  test("clone keeps contentHint, settings and constraints", async () => {
    // Arrange
    const { uninstall } = arrangeIdentifiedVideoRegister();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: "camera-1" },
      });
      const [track] = stream.getVideoTracks();
      track.contentHint = "motion";

      // Act
      const cloned = track.clone();
      const constraints = cloned.getConstraints();
      constraints.deviceId = "mutated";

      // Assert: DOM の clone と同様に引き継ぎ、ID は新しく、元の制約とは独立している。
      expect(cloned.id).not.toBe(track.id);
      expect(cloned.contentHint).toBe("motion");
      expect(cloned.getSettings()).toEqual(track.getSettings());
      expect(cloned.getConstraints()).toEqual({ deviceId: "camera-1" });
      expect(track.getConstraints()).toEqual({ deviceId: "camera-1" });
      track.stop();
      cloned.stop();
    } finally {
      uninstall();
    }
  });
});

describe("MediaStream DOM-compatible members", () => {
  test("is an EventTarget with on* handlers", () => {
    // Arrange
    const stream = arrangeStream([arrangeOpusTrack()]);
    const received: string[] = [];
    stream.addEventListener("custom", (event) => received.push(event.type));

    // Act
    const dispatched = stream.dispatchEvent(new Event("custom"));

    // Assert: dispatchEvent が listener に届き、onaddtrack / onremovetrack は既定で null。
    expect(dispatched).toBe(true);
    expect(received).toEqual(["custom"]);
    expect(stream.onaddtrack).toBeNull();
    expect(stream.onremovetrack).toBeNull();
  });

  test("getTrackById returns null for an unknown id", () => {
    // Arrange
    const audio = arrangeOpusTrack();
    const video = arrangeVp8Track();
    const stream = arrangeStream([audio, video]);

    // Act / Assert: DOM と同じく見つからない場合は null、kind で分けて返す。
    expect(stream.getTrackById(audio.id)).toBe(audio);
    expect(stream.getTrackById("missing")).toBeNull();
    expect(stream.getAudioTracks()).toEqual([audio]);
    expect(stream.getVideoTracks()).toEqual([video]);
  });

  test("constructor props keep the given id", () => {
    // Arrange / Act: EventTarget を継承しても props の Object.assign は従来どおり効く。
    const restored = new MediaStream({ id: "fixed" });

    // Assert
    expect(restored.id).toBe("fixed");
    expect(restored.getTracks()).toEqual([]);
  });
});
