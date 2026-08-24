import { createSocket } from "dgram";
import { PassThrough } from "stream";

import { RTCPeerConnection } from "../../src";
import { OverconstrainedError } from "../../src/errors";
import { MediaStreamTrack } from "../../src/media/track";
import { createFileMediaPlayer } from "../../src/nonstandard/userMedia";
import {
  createEncodedBinaryRegister,
  createMp4WebmRegister,
  createRtpRtcpRegister,
  installPolyfill,
} from "../../src/polyfill";
import "../../src/polyfill";
import { encodeLengthPrefixed } from "../../src/polyfill/sourceIo";
import {
  createVideoCallbackRegister,
  expectDomException,
  expectOverconstrainedError,
  installTestPolyfill,
  waitForRtp,
} from "./polyfillTestUtils";
import {
  createAvMp4Buffer,
  createAvWebmBuffer,
  createTempMediaFile,
} from "./userMediaTestUtils";

describe("werift/polyfill installPolyfill", () => {
  test("rejects missing or non-array mediaRegister", () => {
    // 実行: 必須の mediaRegister を省略または非配列で呼ぶ。
    expect(() => installPolyfill({} as any)).toThrow(
      /mediaRegister is required/,
    );
    expect(() => installPolyfill({ mediaRegister: undefined as any })).toThrow(
      /mediaRegister is required/,
    );
    expect(() => installPolyfill({ mediaRegister: {} as any })).toThrow(
      /mediaRegister must be an array/,
    );
  });

  test("empty mediaRegister allows PeerConnection but getUserMedia fails with NotFoundError / TypeError", async () => {
    const uninstall = installTestPolyfill([]);
    try {
      // 実行: 空配列でインストールし、PC と不正な GUM を試す。
      const pc = new globalThis.RTCPeerConnection();
      const channel = pc.createDataChannel("polyfill");
      let emptyError: unknown;
      try {
        await navigator.mediaDevices.getUserMedia({});
      } catch (error) {
        emptyError = error;
      }
      let notFound: unknown;
      try {
        await navigator.mediaDevices.getUserMedia({ video: true });
      } catch (error) {
        notFound = error;
      }

      // 検証: DataChannel は使え、空制約は TypeError、video 要求は NotFoundError。
      expect(pc).toBeInstanceOf(RTCPeerConnection);
      expect(channel).toBeDefined();
      expect(emptyError).toBeInstanceOf(TypeError);
      expectDomException(notFound, "NotFoundError");
      await pc.close();
    } finally {
      uninstall();
    }
  });

  test("rejects duplicate deviceIds", () => {
    // 実行: 同じ deviceId を 2 件登録する。
    expect(() =>
      installTestPolyfill([
        createVideoCallbackRegister({ deviceId: "same" }),
        createVideoCallbackRegister({ deviceId: "same" }),
      ]),
    ).toThrow(/Duplicate mediaRegister deviceId/);
  });

  test("duplicate mimeType picks the first register unless deviceId is exact", async () => {
    const uninstall = installTestPolyfill([
      createVideoCallbackRegister({
        mimeType: "video/VP8",
        deviceId: "first",
        async createTracks() {
          return [new MediaStreamTrack({ kind: "video", id: "first-track" })];
        },
      }),
      createVideoCallbackRegister({
        mimeType: "video/VP8",
        deviceId: "second",
        async createTracks() {
          return [new MediaStreamTrack({ kind: "video", id: "second-track" })];
        },
      }),
    ]);
    try {
      // 実行: 同一 mimeType を 2 件登録して video:true と deviceId.exact で選ぶ。
      const defaultStream = await navigator.mediaDevices.getUserMedia({
        video: true,
      });
      const exactStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: "second" } },
      });

      // 検証: 先勝ちがデフォルト。exact でもう一方を選べる。
      expect(defaultStream.getVideoTracks()[0].id).toBe("first-track");
      expect(exactStream.getVideoTracks()[0].id).toBe("second-track");
    } finally {
      uninstall();
    }
  });

  test("passes width/height/frameRate/facingMode to createTracks and video:true as {}", async () => {
    const seen: unknown[] = [];
    const uninstall = installTestPolyfill([
      createVideoCallbackRegister({
        async createTracks(request) {
          seen.push(request.constraints);
          return [new MediaStreamTrack({ kind: "video" })];
        },
      }),
    ]);
    try {
      // 実行: true と生成用制約をそれぞれ渡す。
      await navigator.mediaDevices.getUserMedia({ video: true });
      await navigator.mediaDevices.getUserMedia({
        video: {
          width: 1280,
          height: 720,
          frameRate: 30,
          facingMode: "user",
        },
      });

      // 検証: true は {}。width 等は選択せずコールバックへそのまま渡る。
      expect(seen[0]).toEqual({});
      expect(seen[1]).toMatchObject({
        width: 1280,
        height: 720,
        frameRate: 30,
        facingMode: "user",
      });
    } finally {
      uninstall();
    }
  });

  test("propagates OverconstrainedError from createTracks", async () => {
    const uninstall = installTestPolyfill([
      createVideoCallbackRegister({
        async createTracks() {
          throw new OverconstrainedError("width", "cannot satisfy width");
        },
      }),
    ]);
    try {
      let thrown: unknown;
      try {
        await navigator.mediaDevices.getUserMedia({ video: true });
      } catch (error) {
        thrown = error;
      }
      // 検証: getUserMedia から同じ OverconstrainedError が見える。
      expectOverconstrainedError(thrown, "width");
    } finally {
      uninstall();
    }
  });

  test("required mimeType mismatch is OverconstrainedError", async () => {
    const uninstall = installTestPolyfill([
      createVideoCallbackRegister({ mimeType: "video/VP8" }),
    ]);
    try {
      let thrown: unknown;
      try {
        await navigator.mediaDevices.getUserMedia({
          video: { mimeType: { exact: "video/H264" } } as any,
        });
      } catch (error) {
        thrown = error;
      }
      expectOverconstrainedError(thrown, "mimeType");
    } finally {
      uninstall();
    }
  });

  test("width.exact does not fail selection", async () => {
    const uninstall = installTestPolyfill([
      createVideoCallbackRegister({ mimeType: "video/VP8" }),
    ]);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { exact: 1920 } } as any,
      });
      expect(stream.getVideoTracks()).toHaveLength(1);
    } finally {
      uninstall();
    }
  });

  test("getSupportedConstraints only enables deviceId/groupId/mimeType", () => {
    const uninstall = installTestPolyfill([]);
    try {
      expect(navigator.mediaDevices.getSupportedConstraints()).toEqual({
        deviceId: true,
        groupId: true,
        mimeType: true,
      });
    } finally {
      uninstall();
    }
  });

  test("installs werift RTCPeerConnection and browser RTCSessionDescription", () => {
    const uninstall = installTestPolyfill([]);
    try {
      const pc = new globalThis.RTCPeerConnection();
      const description = new (globalThis as any).RTCSessionDescription({
        type: "offer",
        sdp: "v=0\r\n",
      });
      expect(pc).toBeInstanceOf(RTCPeerConnection);
      expect(description.type).toBe("offer");
      expect(description.sdp).toBe("v=0\r\n");
      void pc.close();
    } finally {
      uninstall();
    }
  });

  test("restores globals on uninstall", () => {
    const previous = (globalThis as any).RTCPeerConnection;
    const uninstall = installTestPolyfill([]);
    expect((globalThis as any).RTCPeerConnection).toBe(RTCPeerConnection);
    uninstall();
    expect((globalThis as any).RTCPeerConnection).toBe(previous);
  });

  test("existingMediaDevices overwrite / throw / noop", () => {
    const target: Record<string, any> = {
      navigator: {
        mediaDevices: { getUserMedia: async () => undefined },
      },
    };
    const existing = target.navigator.mediaDevices;

    expect(() =>
      installPolyfill({
        target,
        mediaRegister: [],
        existingMediaDevices: "throw",
      }),
    ).toThrow(/already exists/);

    const uninstallNoop = installPolyfill({
      target,
      mediaRegister: [],
      existingMediaDevices: "noop",
    });
    expect(target.navigator.mediaDevices).toBe(existing);
    expect(target.RTCPeerConnection).toBe(RTCPeerConnection);
    uninstallNoop();

    const uninstallOverwrite = installPolyfill({
      target,
      mediaRegister: [],
      existingMediaDevices: "overwrite",
    });
    expect(target.navigator.mediaDevices).not.toBe(existing);
    expect(typeof target.navigator.mediaDevices.getUserMedia).toBe("function");
    uninstallOverwrite();
  });

  test("returned tracks expose writeRtp", async () => {
    const uninstall = installTestPolyfill([createVideoCallbackRegister()]);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const [track] = stream.getVideoTracks();
      expect(track).toBeInstanceOf(MediaStreamTrack);
      expect(typeof (track as MediaStreamTrack).writeRtp).toBe("function");
    } finally {
      uninstall();
    }
  });
});

describe("werift/polyfill builtin registers", () => {
  test("mp4/webm path, binary, and stream emit RTP via getUserMedia", async () => {
    const webm = await createAvWebmBuffer();
    const mp4 = await createAvMp4Buffer();
    const temp = await createTempMediaFile(mp4, "mp4");
    try {
      // 実行: binary / path / stream の各ソースを polyfill GUM から再生する。
      await withRegister(createMp4WebmRegister({ binary: webm }), async () => {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
        });
        await waitForRtp(stream.getVideoTracks()[0] as MediaStreamTrack);
      });
      await withRegister(
        createMp4WebmRegister({ path: temp.path }),
        async () => {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: true,
          });
          await waitForRtp(stream.getVideoTracks()[0] as MediaStreamTrack);
        },
      );
      const passthrough = new PassThrough();
      passthrough.end(webm);
      await withRegister(
        createMp4WebmRegister({ stream: passthrough }),
        async () => {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: true,
          });
          await waitForRtp(stream.getVideoTracks()[0] as MediaStreamTrack);
        },
      );
    } finally {
      await temp.cleanup();
    }
  }, 20_000);

  test("rtp/rtcp udp and web stream emit RTP", async () => {
    const rtp = createVp8Rtp();
    const port = 41000 + Math.floor(Math.random() * 1000);
    await withRegister(
      createRtpRtcpRegister({
        mimeType: "video/VP8",
        udp: { port, address: "127.0.0.1" },
      }),
      async () => {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
        });
        const wait = waitForRtp(stream.getVideoTracks()[0] as MediaStreamTrack);
        await sendUdp(rtp, port);
        await wait;
      },
    );

    const passthrough = new PassThrough();
    await withRegister(
      createRtpRtcpRegister({ mimeType: "video/VP8", stream: passthrough }),
      async () => {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
        });
        const wait = waitForRtp(stream.getVideoTracks()[0] as MediaStreamTrack);
        passthrough.end(encodeLengthPrefixed(rtp));
        await wait;
      },
    );
  });

  test("encoded binary udp and web stream emit RTP", async () => {
    const au = Buffer.from([0x10, 0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a]);
    const port = 42000 + Math.floor(Math.random() * 1000);
    await withRegister(
      createEncodedBinaryRegister({
        mimeType: "video/VP8",
        udp: { port, address: "127.0.0.1" },
      }),
      async () => {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
        });
        const wait = waitForRtp(stream.getVideoTracks()[0] as MediaStreamTrack);
        await sendUdp(au, port);
        await wait;
      },
    );

    const passthrough = new PassThrough();
    await withRegister(
      createEncodedBinaryRegister({
        mimeType: "video/VP8",
        stream: passthrough,
      }),
      async () => {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
        });
        const wait = waitForRtp(stream.getVideoTracks()[0] as MediaStreamTrack);
        passthrough.end(encodeLengthPrefixed(au));
        await wait;
      },
    );
  });
});

describe("nonstandard getUserMedia({ path }) removal", () => {
  test("werift/nonstandard no longer exports getUserMedia", async () => {
    const nonstandard = await import("../../src/nonstandard");
    expect("getUserMedia" in nonstandard).toBe(false);
  });

  test("internal file player still rejects legacy width/height", async () => {
    const mediaBuffer = await createAvWebmBuffer();
    await expect(
      createFileMediaPlayer({
        buffer: mediaBuffer,
        width: 640,
        height: 360,
      } as any),
    ).rejects.toThrow("File playback no longer accepts { width, height }");
  });
});

async function withRegister(
  register: Parameters<typeof installPolyfill>[0]["mediaRegister"][number],
  run: () => Promise<void>,
) {
  const uninstall = installPolyfill({ mediaRegister: [register] });
  try {
    await run();
  } finally {
    uninstall();
  }
}

function createVp8Rtp() {
  return Buffer.from([
    0x80, 96, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x10,
    0x00, 0x00, 0x00,
  ]);
}

function sendUdp(payload: Buffer, port: number) {
  return new Promise<void>((resolve, reject) => {
    const sender = createSocket("udp4");
    sender.send(payload, port, "127.0.0.1", (error) => {
      sender.close();
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
