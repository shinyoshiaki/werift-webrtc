import { describe, expect, test } from "vitest";

import { Navigator } from "../../src/nonstandard/navigator";

describe("nonstandard/getDisplayMedia", () => {
  test("defaults to video=true audio=false", async () => {
    const nav = new Navigator();
    const stream = await nav.mediaDevices.getDisplayMedia();

    expect(stream.getVideoTracks().length).toBe(1);
    expect(stream.getAudioTracks().length).toBe(0);
  });

  test("returns fresh tracks each call", async () => {
    const nav = new Navigator();

    const a = await nav.mediaDevices.getDisplayMedia();
    const b = await nav.mediaDevices.getDisplayMedia();

    const aVideo = a.getVideoTracks()[0];
    const bVideo = b.getVideoTracks()[0];

    expect(aVideo).toBeTruthy();
    expect(bVideo).toBeTruthy();
    expect(aVideo).not.toBe(bVideo);
  });
});
