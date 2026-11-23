import { MediaStreamTrack } from "../../src/media/track";
import { createCallbackRegister } from "../../src/polyfill";
import {
  createVideoCallbackRegister,
  installTestPolyfill,
} from "./polyfillTestUtils";

describe("nonstandard/polyfill cleanup", () => {
  test("uninstall stops every source even if one onended throws", async () => {
    // Arrange: audio と video が別 source で、register.stop を数える。
    const stops: string[] = [];
    const audio = createCallbackRegister({
      mimeType: "audio/opus",
      kinds: ["audio"],
      async createTracks() {
        return [new MediaStreamTrack({ kind: "audio" })];
      },
      stop: () => {
        stops.push("audio");
      },
    });
    const video = createVideoCallbackRegister({
      stop: () => {
        stops.push("video");
      },
    });
    const uninstall = installTestPolyfill([audio, video]);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true,
    });
    const first = stream.getAudioTracks()[0] as MediaStreamTrack;
    const second = stream.getVideoTracks()[0] as MediaStreamTrack;
    first.onended = () => {
      throw new Error("onended failed");
    };

    // Act: uninstall する。
    const act = () => uninstall();

    // Assert: 例外は伝わるが、両方の track が ended になり、全 register が停止される。
    expect(act).toThrow("onended failed");
    expect(first.readyState).toBe("ended");
    expect(second.readyState).toBe("ended");
    expect(stops.sort()).toEqual(["audio", "video"]);
  });
});
