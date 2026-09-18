import { RTCPeerConnection, useH264, useOPUS, useVP8 } from "../../src";
import { installPolyfill } from "../../src/polyfill";

type PeerConnectionConstructor = typeof RTCPeerConnection;

describe("polyfill peerConnectionConfig", () => {
  test("install defaults apply per kind and constructor config wins", () => {
    const target: Record<string, unknown> = {};
    const uninstall = installPolyfill({
      mediaRegister: [],
      target,
      peerConnectionConfig: { codecs: { video: [useH264()] } },
    });
    const Constructor = target.RTCPeerConnection as PeerConnectionConstructor;

    // Act: install default と constructor override の PC を生成する。
    const installed = new Constructor();
    const overridden = new Constructor({ codecs: { video: [useVP8()] } });

    // Assert: kind 単位で補完し、明示 constructor 値を優先する。
    expect(installed.getConfiguration().codecs.video?.[0].mimeType).toBe(
      "video/h264",
    );
    expect(installed.getConfiguration().codecs.audio?.[0].mimeType).toBe(
      "audio/OPUS",
    );
    expect(overridden.getConfiguration().codecs.video?.[0].mimeType).toBe(
      "video/VP8",
    );
    installed.close();
    overridden.close();
    uninstall();
  });

  test("probe-shaped PCs advertise the same install codecs", async () => {
    const target: Record<string, unknown> = {};
    const uninstall = installPolyfill({
      mediaRegister: [],
      target,
      peerConnectionConfig: {
        codecs: { audio: [useOPUS()], video: [useH264()] },
      },
    });
    const Constructor = target.RTCPeerConnection as PeerConnectionConstructor;
    const probe = new Constructor({
      iceServers: [],
      iceTransportPolicy: "all",
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
    });
    probe.addTransceiver("audio", { direction: "recvonly" });
    probe.addTransceiver("video", { direction: "recvonly" });
    const transport = new Constructor();

    // Act: mediasoup probe 相当の offer を生成する。
    const offer = await probe.createOffer();

    // Assert: probe と transport に同じ install default が入る。
    expect(offer.sdp.toLowerCase()).toContain("h264/90000");
    expect(offer.sdp.toLowerCase()).not.toContain("vp8/90000");
    expect(transport.getConfiguration().codecs.video?.[0].mimeType).toBe(
      "video/h264",
    );
    probe.close();
    transport.close();
    uninstall();
  });

  test("omitted config keeps the direct constructor and invalid input is rejected", () => {
    const target: Record<string, unknown> = {};

    // Act / Assert: 省略時は wrapper を作らない。
    const uninstall = installPolyfill({ mediaRegister: [], target });
    expect(target.RTCPeerConnection).toBe(RTCPeerConnection);
    uninstall();

    expect(() =>
      installPolyfill({
        mediaRegister: [],
        target,
        peerConnectionConfig: [] as never,
      }),
    ).toThrowError("peerConnectionConfig must be an object");
    expect(() =>
      installPolyfill({
        mediaRegister: [],
        target,
        peerConnectionConfig: null as never,
      }),
    ).toThrowError("peerConnectionConfig must be an object");
  });
});
