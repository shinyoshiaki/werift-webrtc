import { spawnSync } from "child_process";
import { createSocket } from "dgram";
import path from "path";
import { PassThrough } from "stream";

import { RTCPeerConnection } from "../../src";
import { OverconstrainedError } from "../../src/errors";
import { RtcpRrPacket, RtpPacket } from "../../src/imports/rtp";
import { MediaStream, MediaStreamTrack } from "../../src/media/track";
import { createFileMediaPlayer } from "../../src/nonstandard/userMedia";
import {
  createCallbackRegister,
  createEncodedBinaryRegister,
  createMp4WebmRegister,
  createRtpRtcpRegister,
  installPolyfill,
} from "../../src/polyfill";
import "../../src/polyfill";
import {
  encodeLengthPrefixed,
  openPacketSource,
} from "../../src/polyfill/sourceIo";
import {
  createHangingNodeStream,
  createHangingWebStream,
  createVideoCallbackRegister,
  expectDomException,
  expectOverconstrainedError,
  installTestPolyfill,
  waitForRtp,
  waitUntil,
  withUdpSocketCounter,
} from "./polyfillTestUtils";
import {
  createAvMp4Buffer,
  createAvWebmBuffer,
  createOpusMp4Buffer,
  createOpusWebmBuffer,
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

  test("omitted deviceId skips explicitly reserved generated ids", async () => {
    const uninstall = installTestPolyfill([
      createVideoCallbackRegister({ deviceId: "werift-device-1" }),
      createVideoCallbackRegister({
        mimeType: "video/H264",
        async createTracks() {
          return [new MediaStreamTrack({ kind: "video", id: "auto-track" })];
        },
      }),
    ]);
    try {
      // 実行: 明示 ID と省略 ID を共存させて列挙する。
      const devices = await navigator.mediaDevices.enumerateDevices();
      const autoStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: "werift-device-2" } },
      });

      // 検証: 省略側は未使用の werift-device-2 になり、入力の重複としては拒否されない。
      expect(devices.map((device) => device.deviceId)).toEqual([
        "werift-device-1",
        "werift-device-2",
      ]);
      expect(autoStream.getVideoTracks()[0].id).toBe("auto-track");
    } finally {
      uninstall();
    }
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

  test("generic createTracks errors become AbortError", async () => {
    const uninstall = installTestPolyfill([
      createVideoCallbackRegister({
        async createTracks() {
          throw new Error("boom");
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
      // 検証: ユーザ定義 register の一般 Error は AbortError になる。
      expectDomException(thrown, "AbortError");
      expect((thrown as DOMException).message).toMatch(/boom/);
    } finally {
      uninstall();
    }
  });

  test("stops already created tracks if a later kind fails", async () => {
    let audioTrack: MediaStreamTrack | undefined;
    const uninstall = installTestPolyfill([
      createCallbackRegister({
        mimeType: "audio/opus",
        kinds: ["audio"],
        async createTracks() {
          audioTrack = new MediaStreamTrack({ kind: "audio" });
          return [audioTrack];
        },
      }),
      createVideoCallbackRegister({
        async createTracks() {
          throw new Error("video failed");
        },
      }),
    ]);
    try {
      await expect(
        navigator.mediaDevices.getUserMedia({ audio: true, video: true }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof DOMException && error.name === "AbortError",
      );
      expect(audioTrack?.stopped).toBe(true);
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

  test("existingMediaDevices throw leaves the target unchanged", () => {
    const getUserMedia = async () => "original";
    const target: Record<string, any> = {
      navigator: {
        mediaDevices: { getUserMedia },
      },
    };

    // 実行: 既存 GUM がある sandbox へ throw モードでインストールする。
    expect(() =>
      installPolyfill({
        target,
        mediaRegister: [],
        existingMediaDevices: "throw",
      }),
    ).toThrow(/already exists/);

    // 検証: コンストラクタも window も mediaDevices も書き換わっていない。
    expect("RTCPeerConnection" in target).toBe(false);
    expect("RTCSessionDescription" in target).toBe(false);
    expect("MediaStream" in target).toBe(false);
    expect("window" in target).toBe(false);
    expect(target.navigator.mediaDevices.getUserMedia).toBe(getUserMedia);
  });

  test("uninstall removes navigator and constructors that did not exist", () => {
    const target: Record<string, any> = {};

    // 実行: 空の target にインストールしてから外す。
    const uninstall = installPolyfill({ target, mediaRegister: [] });
    expect(Object.prototype.hasOwnProperty.call(target, "navigator")).toBe(
      true,
    );
    expect(
      Object.prototype.hasOwnProperty.call(target, "RTCPeerConnection"),
    ).toBe(true);
    uninstall();

    // 検証: 元々無かったプロパティは undefined ではなく削除される。
    expect(Object.prototype.hasOwnProperty.call(target, "navigator")).toBe(
      false,
    );
    expect("navigator" in target).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(target, "mediaDevices")).toBe(
      false,
    );
    expect(
      Object.prototype.hasOwnProperty.call(target, "RTCPeerConnection"),
    ).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(target, "window")).toBe(false);
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

  test("failed defineProperty rolls back already assigned constructors", () => {
    const target: Record<string, any> = {};
    Object.defineProperty(target, "RTCSessionDescription", {
      configurable: false,
      enumerable: true,
      writable: false,
      value: "locked",
    });

    // 実行: 後段の RTCSessionDescription が再定義不能な target へインストールする。
    expect(() => installPolyfill({ target, mediaRegister: [] })).toThrow();

    // 検証: 先に書いた RTCPeerConnection も含め、副作用は残らない。
    expect("RTCPeerConnection" in target).toBe(false);
    expect(target.RTCSessionDescription).toBe("locked");
    expect("navigator" in target).toBe(false);
    expect("window" in target).toBe(false);
  });

  test("returned tracks expose writeRtp and MediaStream.clone", async () => {
    const uninstall = installTestPolyfill([
      createVideoCallbackRegister(),
      createCallbackRegister({
        mimeType: "audio/opus",
        kinds: ["audio"],
        async createTracks() {
          return [new MediaStreamTrack({ kind: "audio" })];
        },
      }),
    ]);
    try {
      // 実行: GUM で得たストリームと track を clone する。
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      });
      const [audio] = stream.getAudioTracks();
      const [video] = stream.getVideoTracks();
      const cloned = stream.clone();
      const audioClone = audio.clone();
      const videoClone = video.clone();
      const rtpClone = video.clone();
      let originalRtp = 0;
      let cloneRtp = 0;
      let originalRtcp = 0;
      let cloneRtcp = 0;
      (video as MediaStreamTrack).onReceiveRtp.subscribe(() => {
        originalRtp++;
      });
      rtpClone.onReceiveRtp.subscribe(() => {
        cloneRtp++;
      });
      (video as MediaStreamTrack).onReceiveRtcp.subscribe(() => {
        originalRtcp++;
      });
      rtpClone.onReceiveRtcp.subscribe(() => {
        cloneRtcp++;
      });

      // 実行: 元 track に RTP/RTCP を入力する。
      (video as MediaStreamTrack).writeRtp(
        RtpPacket.deSerialize(createVp8Rtp()),
      );
      (video as MediaStreamTrack).writeRtcp(new RtcpRrPacket());

      // 検証: writeRtp が使え、clone は別 ID で停止状態が独立し、元 source の RTP/RTCP を受ける。
      expect(video).toBeInstanceOf(MediaStreamTrack);
      expect(typeof (video as MediaStreamTrack).writeRtp).toBe("function");
      expect(originalRtp).toBe(1);
      expect(cloneRtp).toBe(1);
      expect(originalRtcp).toBe(1);
      expect(cloneRtcp).toBe(1);

      rtpClone.stop();
      (video as MediaStreamTrack).writeRtp(
        RtpPacket.deSerialize(createVp8Rtp()),
      );
      expect(originalRtp).toBe(2);
      expect(cloneRtp).toBe(1);
      expect(rtpClone.readyState).toBe("ended");
      expect(video.readyState).toBe("live");
      expect(cloned).toBeInstanceOf(MediaStream);
      expect(cloned).not.toBe(stream);
      expect(cloned.id).not.toBe(stream.id);
      expect(cloned.getAudioTracks()[0].id).not.toBe(audio.id);
      expect(cloned.getVideoTracks()[0].id).not.toBe(video.id);
      expect(audioClone.id).not.toBe(audio.id);
      expect(videoClone.id).not.toBe(video.id);

      stream.getTracks().forEach((track) => track.stop());
      expect(stream.active).toBe(false);
      expect(audio.readyState).toBe("ended");
      expect(video.readyState).toBe("ended");
      expect(cloned.active).toBe(true);
      expect(cloned.getAudioTracks()[0].readyState).toBe("live");
      expect(cloned.getVideoTracks()[0].readyState).toBe("live");
      expect(audioClone.readyState).toBe("live");
      expect(videoClone.readyState).toBe("live");

      let cloneAfterOriginalStop = 0;
      videoClone.onReceiveRtp.subscribe(() => {
        cloneAfterOriginalStop++;
      });
      // 実行: 元 track 停止後も同じ source へ RTP を書き込む。
      (video as MediaStreamTrack).writeRtp(
        RtpPacket.deSerialize(createVp8Rtp()),
      );

      // 検証: clone は live のまま RTP を受け取る。
      expect(cloneAfterOriginalStop).toBe(1);

      cloned.getAudioTracks()[0].stop();
      const endedClone = cloned.clone();
      expect(endedClone.getAudioTracks()[0].readyState).toBe("ended");
      expect(endedClone.getVideoTracks()[0].readyState).toBe("live");
      expect(endedClone.getAudioTracks()[0].id).not.toBe(
        cloned.getAudioTracks()[0].id,
      );
    } finally {
      uninstall();
    }
  });

  test("complements missing and Node.js userAgent with Chrome111 identity", () => {
    const emptyTarget: Record<string, any> = {};
    const nodeProto = {
      get userAgent() {
        return "Node.js/24";
      },
    };
    const nodeNavigator = Object.create(nodeProto);
    const nodeTarget: Record<string, any> = { navigator: nodeNavigator };

    // 実行: 空 navigator と Node.js/<major> UA の target へオプション省略で入れる。
    const uninstallEmpty = installPolyfill({
      target: emptyTarget,
      mediaRegister: [],
    });
    const uninstallNode = installPolyfill({
      target: nodeTarget,
      mediaRegister: [],
    });

    // 検証: どちらも Chromium 111 互換の固定値になり、既存 navigator オブジェクトは置換されない。
    expect(emptyTarget.navigator.userAgent).toBe(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36",
    );
    expect(nodeTarget.navigator).toBe(nodeNavigator);
    expect(nodeTarget.navigator.userAgent).toBe(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36",
    );
    uninstallEmpty();
    uninstallNode();
    expect(
      Object.prototype.hasOwnProperty.call(nodeNavigator, "userAgent"),
    ).toBe(false);
    expect(nodeNavigator.userAgent).toBe("Node.js/24");
  });

  test("keeps a non-Node userAgent when the option is omitted", () => {
    const browserUa =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0";
    const target: Record<string, any> = {
      navigator: { userAgent: browserUa },
    };

    // 実行: 既存のブラウザ UA がある target へ userAgent オプションなしで入れる。
    const uninstall = installPolyfill({ target, mediaRegister: [] });

    // 検証: 実ブラウザ / sandbox の識別情報は暗黙に上書きされない。
    expect(target.navigator.userAgent).toBe(browserUa);
    uninstall();
  });

  test("explicit userAgent overwrites Node, browser, and sandbox values", () => {
    const explicit =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    const nodeTarget: Record<string, any> = {
      navigator: { userAgent: "Node.js/18" },
    };
    const browserTarget: Record<string, any> = {
      navigator: {
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0",
      },
    };
    const sandboxTarget: Record<string, any> = {
      navigator: { userAgent: "WeriftSandbox/1" },
    };

    // 実行: 明示 userAgent で 3 種類の既存値を上書きする。
    const uninstalls = [nodeTarget, browserTarget, sandboxTarget].map(
      (target) =>
        installPolyfill({ target, mediaRegister: [], userAgent: explicit }),
    );

    // 検証: 指定文字列がそのまま入り、uninstall でインストール前へ戻る。
    expect(nodeTarget.navigator.userAgent).toBe(explicit);
    expect(browserTarget.navigator.userAgent).toBe(explicit);
    expect(sandboxTarget.navigator.userAgent).toBe(explicit);
    for (const uninstall of uninstalls) {
      uninstall();
    }
    expect(nodeTarget.navigator.userAgent).toBe("Node.js/18");
    expect(browserTarget.navigator.userAgent).toContain("Firefox/120.0");
    expect(sandboxTarget.navigator.userAgent).toBe("WeriftSandbox/1");
  });

  test("rejects empty, whitespace, and non-string userAgent before mutating globals", () => {
    const target: Record<string, any> = {};

    // 実行: 無効な userAgent を副作用より前に拒否する。
    expect(() =>
      installPolyfill({ target, mediaRegister: [], userAgent: "" }),
    ).toThrow(TypeError);
    expect(() =>
      installPolyfill({ target, mediaRegister: [], userAgent: "   " }),
    ).toThrow(TypeError);
    expect(() =>
      installPolyfill({ target, mediaRegister: [], userAgent: 111 as any }),
    ).toThrow(TypeError);

    // 検証: コンストラクタも navigator も書かれていない。
    expect("RTCPeerConnection" in target).toBe(false);
    expect("navigator" in target).toBe(false);
  });

  test("userAgent undefined is treated as omitted auto-detect", () => {
    const target: Record<string, any> = {};

    // 実行: userAgent: undefined は省略と同じ自動補完にする。
    const uninstall = installPolyfill({
      target,
      mediaRegister: [],
      userAgent: undefined,
    });

    // 検証: Chrome111 互換値が入る。
    expect(target.navigator.userAgent).toContain("Chrome/111.0.0.0");
    uninstall();
  });

  test("applies userAgent only to the given target", () => {
    const target: Record<string, any> = {};
    const previousGlobalUa = (globalThis as any).navigator?.userAgent;

    // 実行: sandbox target だけにインストールする。
    const uninstall = installPolyfill({ target, mediaRegister: [] });

    // 検証: target.navigator.userAgent だけが変わり、globalThis は触らない。
    expect(target.navigator.userAgent).toContain("Chrome/111.0.0.0");
    expect((globalThis as any).navigator?.userAgent).toBe(previousGlobalUa);
    uninstall();
  });

  test("noop existingMediaDevices still complements userAgent", () => {
    const existing = { getUserMedia: async () => undefined };
    const target: Record<string, any> = {
      navigator: {
        mediaDevices: existing,
        userAgent: "Node.js/18",
      },
    };

    // 実行: mediaDevices は残し、UA だけ Handler 検出用に補完する。
    const uninstall = installPolyfill({
      target,
      mediaRegister: [],
      existingMediaDevices: "noop",
    });

    // 検証: GUM はそのまま、UA は Chrome111 互換。
    expect(target.navigator.mediaDevices).toBe(existing);
    expect(target.navigator.userAgent).toContain("Chrome/111.0.0.0");
    uninstall();
    expect(target.navigator.userAgent).toBe("Node.js/18");
  });

  test("non-configurable Node userAgent fails the whole install", () => {
    const navigatorObject: Record<string, unknown> = {};
    Object.defineProperty(navigatorObject, "userAgent", {
      configurable: false,
      enumerable: true,
      writable: false,
      value: "Node.js/18",
    });
    const target: Record<string, any> = { navigator: navigatorObject };

    // 実行: 差し替え不能な Node UA がある target へ入れる。
    expect(() => installPolyfill({ target, mediaRegister: [] })).toThrow();

    // 検証: コンストラクタを残さず、元の UA もそのまま。
    expect("RTCPeerConnection" in target).toBe(false);
    expect(target.navigator.userAgent).toBe("Node.js/18");
    expect("window" in target).toBe(false);
  });

  test("failed constructor after userAgent still restores the previous descriptor", () => {
    const navigatorObject: Record<string, unknown> = {
      userAgent: "Node.js/18",
    };
    const target: Record<string, any> = { navigator: navigatorObject };
    Object.defineProperty(target, "window", {
      configurable: false,
      enumerable: true,
      writable: false,
      value: undefined,
    });

    // 実行: User-Agent 定義後の window 再定義が失敗する target へ入れる。
    expect(() => installPolyfill({ target, mediaRegister: [] })).toThrow();

    // 検証: navigator オブジェクトと UA はインストール前へ戻る。
    expect(target.navigator).toBe(navigatorObject);
    expect(target.navigator.userAgent).toBe("Node.js/18");
    expect("RTCPeerConnection" in target).toBe(false);
  });
});

describe("werift/polyfill builtin registers", () => {
  test("createMp4WebmRegister is synchronous and does not open files at install", () => {
    const target: Record<string, any> = {};

    // 実行: ドキュメント例どおり await せず、存在しない path を install する。
    const uninstall = installPolyfill({
      target,
      mediaRegister: [
        createMp4WebmRegister({ path: "/definitely/missing/clip.mp4" }),
      ],
    });

    // 検証: インストールは同期で成功し、ファイル未検出は getUserMedia まで遅延する。
    expect(typeof uninstall).toBe("function");
    expect(target.RTCPeerConnection).toBe(RTCPeerConnection);
    uninstall();
  });

  test("missing mp4 path getUserMedia uses a DOMException and uninstall is safe", async () => {
    const uninstall = installPolyfill({
      mediaRegister: [
        createMp4WebmRegister({ path: "/definitely/missing/clip.mp4" }),
      ],
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      // 実行: 存在しない path で GUM し、失敗後に uninstall する。
      let thrown: unknown;
      try {
        await navigator.mediaDevices.getUserMedia({ video: true });
      } catch (error) {
        thrown = error;
      }
      uninstall();
      await new Promise<void>((resolve) => setImmediate(resolve));

      // 検証: Node の ENOENT ではなく DOMException。uninstall 後に未処理 rejection はない。
      expectDomException(thrown, "NotReadableError");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("unselected missing mp4 register does not fail getUserMedia", async () => {
    const uninstall = installPolyfill({
      mediaRegister: [
        createMp4WebmRegister({ path: "/definitely/missing/clip.mp4" }),
        createVideoCallbackRegister(),
      ],
    });
    try {
      // 実行: 壊れた path と利用可能な video register を共存させて GUM する。
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      expect(stream.getVideoTracks()).toHaveLength(1);
    } finally {
      uninstall();
    }
  });

  test("unrelated prepare failure does not convert OverconstrainedError", async () => {
    const uninstall = installPolyfill({
      mediaRegister: [
        createMp4WebmRegister({ path: "/definitely/missing/clip.mp4" }),
        createVideoCallbackRegister({ mimeType: "video/VP8" }),
      ],
    });
    try {
      // 実行: 壊れた MP4 と VP8 がある状態で存在しない H264 を必須指定する。
      let thrown: unknown;
      try {
        await navigator.mediaDevices.getUserMedia({
          video: { mimeType: { exact: "video/H264" } },
        });
      } catch (error) {
        thrown = error;
      }

      // 検証: 選択失敗は NotReadableError に化けず OverconstrainedError のまま。
      expectOverconstrainedError(thrown, "mimeType");
    } finally {
      uninstall();
    }
  });

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

  test("same mp4/webm register can be acquired twice with independent tracks", async () => {
    const webm = await createAvWebmBuffer();
    await withRegister(
      createMp4WebmRegister({ binary: webm, loop: true }),
      async () => {
        // 実行: 同一 MP4/WebM register を2回 getUserMedia する。
        const first = await navigator.mediaDevices.getUserMedia({
          video: true,
        });
        const second = await navigator.mediaDevices.getUserMedia({
          video: true,
        });
        const firstTrack = first.getVideoTracks()[0] as MediaStreamTrack;
        const secondTrack = second.getVideoTracks()[0] as MediaStreamTrack;

        // 検証: 別インスタンスになり、片方を止めても他方は live のまま RTP を受ける。
        expect(firstTrack).not.toBe(secondTrack);
        expect(firstTrack.id).not.toBe(secondTrack.id);
        await waitForRtp(secondTrack);
        firstTrack.stop();
        expect(firstTrack.readyState).toBe("ended");
        expect(secondTrack.readyState).toBe("live");
        await waitForRtp(secondTrack);

        // 実行: 停止済み取得の後でも再取得する。
        const third = await navigator.mediaDevices.getUserMedia({
          video: true,
        });
        const thirdTrack = third.getVideoTracks()[0] as MediaStreamTrack;
        expect(thirdTrack).not.toBe(secondTrack);
        expect(thirdTrack.readyState).toBe("live");
        await waitForRtp(thirdTrack);

        secondTrack.stop();
        thirdTrack.stop();
        const fourth = await navigator.mediaDevices.getUserMedia({
          video: true,
        });
        await waitForRtp(fourth.getVideoTracks()[0] as MediaStreamTrack);
      },
    );
  }, 20_000);

  test("audio-only mp4/webm path, binary, and stream are not video devices", async () => {
    const webm = await createOpusWebmBuffer();
    const mp4 = await createOpusMp4Buffer();
    const mp4Path = await createTempMediaFile(mp4, "mp4");
    const webmPath = await createTempMediaFile(webm, "webm");
    try {
      // 実行: 拡張子が video でも音声専用コンテナを path / binary / 未終了 stream で登録する。
      await assertAudioOnlyRegister(
        createMp4WebmRegister({ path: mp4Path.path }),
        "audio/mp4",
      );
      await assertAudioOnlyRegister(
        createMp4WebmRegister({ path: webmPath.path }),
        "audio/webm",
      );
      await assertAudioOnlyRegister(
        createMp4WebmRegister({ binary: webm }),
        "audio/webm",
      );
      const passthrough = new PassThrough();
      const streamRegister = createMp4WebmRegister({ stream: passthrough });
      passthrough.end(webm);
      await assertAudioOnlyRegister(streamRegister, "audio/webm");
    } finally {
      await mp4Path.cleanup();
      await webmPath.cleanup();
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
    ).rejects.toThrow(/File playback no longer accepts/);
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

async function assertAudioOnlyRegister(
  register: Parameters<typeof installPolyfill>[0]["mediaRegister"][number],
  mimeType: string,
) {
  await register.prepare?.();
  expect(register.mimeType).toBe(mimeType);
  expect([...register.kinds]).toEqual(["audio"]);
  await withRegister(register, async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    expect(devices.map((device) => device.kind)).toEqual(["audioinput"]);

    let videoError: unknown;
    try {
      await navigator.mediaDevices.getUserMedia({ video: true });
    } catch (error) {
      videoError = error;
    }
    expectDomException(videoError, "NotFoundError");

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    expect(stream.getAudioTracks()).toHaveLength(1);
    expect(stream.getVideoTracks()).toHaveLength(0);
  });
}

function createVp8Rtp() {
  return Buffer.from([
    0x80, 96, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x10,
    0x00, 0x00, 0x00,
  ]);
}

test("packet stream errors become NotReadableError instead of unhandled rejection", async () => {
  const passthrough = new PassThrough();
  const errors: DOMException[] = [];
  const stop = await openPacketSource(
    { stream: passthrough },
    () => undefined,
    (error) => {
      errors.push(error);
    },
  );
  try {
    // 実行: 長さ付きストリームをエラー終了させる。
    passthrough.destroy(new Error("source closed"));
    await new Promise((resolve) => setImmediate(resolve));

    // 検証: NotReadableError が onError に渡り、未処理 rejection にしない。
    expect(errors).toHaveLength(1);
    expectDomException(errors[0], "NotReadableError");
    expect(errors[0].message).toMatch(/source closed/);
  } finally {
    stop();
  }
});

test("unfinished web stream is unlocked after track.stop and uninstall", async () => {
  const liveStream = createHangingWebStream();
  const uninstallLive = installPolyfill({
    mediaRegister: [
      createRtpRtcpRegister({ mimeType: "video/VP8", stream: liveStream }),
    ],
  });
  try {
    // 実行: 未終了 Web Stream の RTP register から GUM し、track.stop する。
    const media = await navigator.mediaDevices.getUserMedia({ video: true });
    expect(liveStream.locked).toBe(true);
    media.getTracks()[0].stop();
    await waitUntil(() => liveStream.locked === false);

    // 検証: reader が cancel され、ストリーム lock が解放される。
    expect(liveStream.locked).toBe(false);
  } finally {
    uninstallLive();
  }

  const uninstallStream = createHangingWebStream();
  const uninstall = installPolyfill({
    mediaRegister: [
      createRtpRtcpRegister({
        mimeType: "video/VP8",
        stream: uninstallStream,
      }),
    ],
  });
  // 実行: 未終了ストリームのままアンインストールする。
  await navigator.mediaDevices.getUserMedia({ video: true });
  expect(uninstallStream.locked).toBe(true);
  uninstall();
  await waitUntil(() => uninstallStream.locked === false);

  // 検証: アンインストール後も reader が残らない。
  expect(uninstallStream.locked).toBe(false);
});

test("mp4/webm hanging stream read is aborted on uninstall", async () => {
  const hanging = createHangingWebStream();
  const uninstall = installPolyfill({
    mediaRegister: [createMp4WebmRegister({ stream: hanging })],
  });
  // 実行: 終了しない Web Stream の全量読み込み中にアンインストールする。
  const gum = navigator.mediaDevices.getUserMedia({ video: true }).then(
    (stream) => stream,
    (error) => error,
  );
  await waitUntil(() => hanging.locked === true);
  uninstall();
  await waitUntil(() => hanging.locked === false);
  const result = await gum;

  // 検証: readEntireStream が中断され、lock が解放される。
  expect(hanging.locked).toBe(false);
  expect(result).toBeInstanceOf(DOMException);
  expect(["AbortError", "NotReadableError"]).toContain(
    (result as DOMException).name,
  );
});

test("same rtp/encoded udp register can be acquired twice and all sockets close", async () => {
  await assertUdpAcquisitionsReleased(() =>
    createRtpRtcpRegister({ mimeType: "video/VP8", udp: { port: 0 } }),
  );
  await assertUdpAcquisitionsReleased(() =>
    createEncodedBinaryRegister({ mimeType: "video/VP8", udp: { port: 0 } }),
  );
});

test("in-flight getUserMedia is aborted by immediate uninstall", async () => {
  const webStream = createHangingWebStream();
  const nodeStream = createHangingNodeStream();
  const uninstallWeb = installPolyfill({
    mediaRegister: [
      createRtpRtcpRegister({ mimeType: "video/VP8", stream: webStream }),
    ],
  });
  // 実行: GUM 完了を待たずに即 uninstall する。
  const webGum = navigator.mediaDevices.getUserMedia({ video: true });
  uninstallWeb();
  const webResult = await webGum.then(
    (stream) => stream,
    (error) => error,
  );
  await waitUntil(() => webStream.locked === false);

  // 検証: 進行中の GUM は失敗し、Web Stream の lock が残らない。
  expect(webStream.locked).toBe(false);
  expect(webResult).toBeInstanceOf(DOMException);
  expect((webResult as DOMException).name).toBe("AbortError");

  const uninstallNode = installPolyfill({
    mediaRegister: [
      createRtpRtcpRegister({ mimeType: "video/VP8", stream: nodeStream }),
    ],
  });
  const nodeGum = navigator.mediaDevices.getUserMedia({ video: true });
  uninstallNode();
  const nodeResult = await nodeGum.then(
    (stream) => stream,
    (error) => error,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  // 検証: Node Stream も取得失敗し、未終了 reader を残さない。
  expect(nodeResult).toBeInstanceOf(DOMException);
  expect((nodeResult as DOMException).name).toBe("AbortError");
  expect(nodeStream.readableFlowing).not.toBe(true);
});

test("public polyfill entry compiles with TypeScript DOM lib", () => {
  const project = path.join(__dirname, "polyfillDomCompile");
  const tsc = require.resolve("typescript/bin/tsc");
  // 実行: lib.dom と skipLibCheck=false で polyfill/dom エントリをコンパイルする。
  const result = spawnSync(
    process.execPath,
    [tsc, "-p", project, "--pretty", "false"],
    {
      encoding: "utf8",
    },
  );

  // 検証: TS2403 / TS2687 / TS2717 を含む型エラーが出ない。
  expect(result.status, result.stdout + result.stderr).toBe(0);
});

test("public polyfill entry compiles without DOM lib", () => {
  const project = path.join(__dirname, "polyfillNodeCompile");
  const tsc = require.resolve("typescript/bin/tsc");
  // 実行: lib.esnext のみで werift/polyfill のグローバル型をコンパイルする。
  const result = spawnSync(
    process.execPath,
    [tsc, "-p", project, "--pretty", "false"],
    {
      encoding: "utf8",
    },
  );

  // 検証: RTCPeerConnection / navigator / MediaStream が解決する。
  expect(result.status, result.stdout + result.stderr).toBe(0);
});

test("same rtp/encoded web stream register can be acquired twice", async () => {
  await assertStreamAcquisitionsLive((stream) =>
    createRtpRtcpRegister({ mimeType: "video/VP8", stream }),
  );
  await assertStreamAcquisitionsLive((stream) =>
    createEncodedBinaryRegister({ mimeType: "video/VP8", stream }),
  );
});

async function assertUdpAcquisitionsReleased(
  createRegister: () => Parameters<
    typeof installPolyfill
  >[0]["mediaRegister"][number],
) {
  await withUdpSocketCounter(async (sockets) => {
    const uninstall = installPolyfill({ mediaRegister: [createRegister()] });
    let uninstalled = false;
    const uninstallOnce = () => {
      if (uninstalled) {
        return;
      }
      uninstalled = true;
      uninstall();
    };
    try {
      // 実行: 同一 register を port 0 で2回取得し、片方の track を止めてから uninstall する。
      const first = await navigator.mediaDevices.getUserMedia({ video: true });
      const second = await navigator.mediaDevices.getUserMedia({ video: true });
      await waitUntil(() => sockets.open() === 2, 3_000);
      first.getTracks()[0].stop();
      await waitUntil(() => sockets.open() === 1, 3_000);
      expect(first.getTracks()[0].readyState).toBe("ended");
      expect(second.getTracks()[0].readyState).toBe("live");
      uninstallOnce();
      await waitUntil(() => sockets.open() === 0, 3_000);

      // 検証: 2 socket が立ち、片方停止で1つ減り、uninstall で両方解放される。
      expect(sockets.created).toBe(2);
      expect(sockets.open()).toBe(0);
      expect(first.getTracks()[0].readyState).toBe("ended");
      expect(second.getTracks()[0].readyState).toBe("ended");
    } finally {
      uninstallOnce();
    }
  });
}

async function assertStreamAcquisitionsLive(
  createRegister: (
    stream: ReadableStream<Uint8Array>,
  ) => Parameters<typeof installPolyfill>[0]["mediaRegister"][number],
) {
  const hanging = createHangingWebStream();
  const uninstall = installPolyfill({
    mediaRegister: [createRegister(hanging)],
  });
  try {
    // 実行: 同一 Web Stream register を2回 getUserMedia する。
    const first = await navigator.mediaDevices.getUserMedia({ video: true });
    const second = await navigator.mediaDevices.getUserMedia({ video: true });

    // 検証: 2回目も live のまま lock を共有する。
    expect(first.getTracks()[0].readyState).toBe("live");
    expect(second.getTracks()[0].readyState).toBe("live");
    expect(hanging.locked).toBe(true);
    first.getTracks()[0].stop();
    expect(second.getTracks()[0].readyState).toBe("live");
    expect(hanging.locked).toBe(true);
    second.getTracks()[0].stop();
    await waitUntil(() => hanging.locked === false);
    expect(hanging.locked).toBe(false);
  } finally {
    uninstall();
  }
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
