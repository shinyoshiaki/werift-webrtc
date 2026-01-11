import { describe, expect, test } from "vitest";

import { installGlobals } from "../../src/nonstandard/installGlobals";

describe("nonstandard/installGlobals", () => {
  test("installs into global and window, and creates navigator.mediaDevices", () => {
    const globalTarget: Record<string, unknown> = {};
    const windowTarget: Record<string, unknown> = {};

    installGlobals({ global: globalTarget, window: windowTarget });

    for (const target of [globalTarget, windowTarget]) {
      expect(target.RTCPeerConnection).toBeTruthy();
      expect(target.RTCIceCandidate).toBeTruthy();
      expect(target.RTCSessionDescription).toBeTruthy();
      expect(target.RTCDataChannel).toBeTruthy();
      expect(target.MediaStream).toBeTruthy();
      expect(target.MediaStreamTrack).toBeTruthy();
    }

    expect(globalTarget.navigator).toBeTruthy();
    expect(
      (globalTarget.navigator as { mediaDevices?: unknown }).mediaDevices,
    ).toBeTruthy();

    expect(windowTarget.navigator).toBeTruthy();
    expect(
      (windowTarget.navigator as { mediaDevices?: unknown }).mediaDevices,
    ).toBe(
      (globalTarget.navigator as { mediaDevices?: unknown }).mediaDevices,
    );
  });

  test("force=false does not override existing values", () => {
    const globalTarget: Record<string, unknown> = {
      RTCPeerConnection: "keep",
      navigator: { mediaDevices: "keep" },
    };

    installGlobals({ global: globalTarget, force: false });

    expect(globalTarget.RTCPeerConnection).toBe("keep");
    expect((globalTarget.navigator as any).mediaDevices).toBe("keep");
  });

  test("force=true overrides existing values", () => {
    const globalTarget: Record<string, unknown> = {
      RTCPeerConnection: "old",
      navigator: { mediaDevices: "old" },
    };

    installGlobals({ global: globalTarget, force: true });

    expect(globalTarget.RTCPeerConnection).not.toBe("old");
    expect((globalTarget.navigator as any).mediaDevices).not.toBe("old");
  });
});
