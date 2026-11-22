import { describe, expect, test, vi } from "vitest";

import { RTCPeerConnection, RTCSessionDescription } from "../src";
import { installPolyfill } from "../src/polyfill";

const SDP = "v=0\r\n";

describe("RTCSessionDescription: legacy (sdp, type) form", () => {
  test("keeps read-only enumerable properties, toSdp() and its JSON", () => {
    // Act: 旧 2 引数形式で作る
    const description = new RTCSessionDescription(SDP, "offer");

    // Assert: プロパティは列挙可能・書き換え不可、toSdp() と JSON は従来どおり
    expect(Object.keys(description)).toEqual(["sdp", "type"]);
    expect(Object.getOwnPropertyDescriptor(description, "sdp")).toMatchObject({
      enumerable: true,
      writable: false,
    });
    expect(() => {
      (description as { type: string }).type = "answer";
    }).toThrow(TypeError);
    expect(description.toSdp()).toEqual({ sdp: SDP, type: "offer" });
    expect(JSON.stringify(description)).toBe(
      JSON.stringify({ sdp: SDP, type: "offer" }),
    );
    expect(RTCSessionDescription.isThis(description)).toBe(true);
  });
});

describe("RTCSessionDescription: W3C dictionary form", () => {
  test.each(["offer", "answer", "pranswer", "rollback"] as const)(
    "accepts type %s and defaults sdp to an empty string",
    (type) => {
      // Act: 辞書形式で sdp を省略して作る
      const description = new RTCSessionDescription({ type });

      // Assert: type はそのまま、sdp は ""、toJSON() は type と sdp の 2 キーだけ
      expect(description.type).toBe(type);
      expect(description.sdp).toBe("");
      expect(Object.keys(description.toJSON()).sort()).toEqual(["sdp", "type"]);
      expect(description.toJSON()).toEqual({ type, sdp: "" });
    },
  );

  test.each([
    { name: "a missing type", init: { sdp: SDP } },
    { name: "an unknown type", init: { type: "bogus", sdp: SDP } },
    { name: "an empty dictionary", init: {} },
    { name: "undefined", init: undefined },
  ])("$name is a TypeError", ({ init }) => {
    // Act / Assert: W3C の辞書変換と同じく TypeError
    expect(() => new RTCSessionDescription(init as never)).toThrow(TypeError);
  });

  test("setRemoteDescription(new RTCSessionDescription({ type, sdp })) connects", async () => {
    // Arrange: DataChannel を持つ offerer と answerer
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();
    const channel = offerer.createDataChannel("dictionary");
    const opened = new Promise<void>((resolve) => {
      channel.onopen = () => resolve();
    });

    try {
      // Act: 説明を辞書形式のコンストラクタで包み直して交換する
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(
        new RTCSessionDescription({
          type: "offer",
          sdp: offerer.localDescription!.sdp,
        }),
      );
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(
        new RTCSessionDescription(answerer.localDescription!.toJSON()),
      );

      // Assert: 接続が成立し DataChannel が開く
      await opened;
      await vi.waitFor(() => expect(offerer.connectionState).toBe("connected"));
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });
});

describe("RTCSessionDescription: werift/polyfill", () => {
  test("the global is the core class, so instanceof holds both ways", async () => {
    // Arrange: 空の target に polyfill をインストールする
    const target: Record<string, any> = {};
    const uninstall = installPolyfill({ target, mediaRegister: [] });
    const pc = new target.RTCPeerConnection() as RTCPeerConnection;

    try {
      // Act: werift が作る説明と、グローバルで作る説明
      await pc.setLocalDescription(await pc.createOffer());
      const created = new target.RTCSessionDescription({
        type: "offer",
        sdp: SDP,
      });

      // Assert: グローバルはコアクラスと同一で、instanceof が双方向に成立する
      expect(target.RTCSessionDescription).toBe(RTCSessionDescription);
      expect(pc.localDescription).toBeInstanceOf(target.RTCSessionDescription);
      expect(created).toBeInstanceOf(RTCSessionDescription);
      // Assert: type のない辞書は polyfill でも TypeError
      expect(() => new target.RTCSessionDescription({ sdp: SDP })).toThrow(
        TypeError,
      );
    } finally {
      await pc.close();
      uninstall();
    }
  });
});
