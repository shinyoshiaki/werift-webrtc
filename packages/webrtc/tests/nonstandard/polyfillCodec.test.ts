import {
  RTCPeerConnection,
  RTCRtpHeaderExtensionParameters,
  useH264,
  useOPUS,
  useVP8,
} from "../../src";
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

  test("multiple targets and PCs receive isolated codec instances", () => {
    const installCodec = useH264();
    const firstTarget: Record<string, unknown> = {};
    const secondTarget: Record<string, unknown> = {};
    const uninstallFirst = installPolyfill({
      mediaRegister: [],
      target: firstTarget,
      peerConnectionConfig: { codecs: { video: [installCodec] } },
    });
    const uninstallSecond = installPolyfill({
      mediaRegister: [],
      target: secondTarget,
      peerConnectionConfig: { codecs: { video: [installCodec] } },
    });

    // Act: 別targetのwrapperと同一wrapperから複数PCを生成する。
    const FirstConstructor =
      firstTarget.RTCPeerConnection as PeerConnectionConstructor;
    const SecondConstructor =
      secondTarget.RTCPeerConnection as PeerConnectionConstructor;
    const first = new FirstConstructor();
    const sibling = new FirstConstructor();
    const second = new SecondConstructor();
    const firstCodec = first.getConfiguration().codecs.video![0];
    const siblingCodec = sibling.getConfiguration().codecs.video![0];
    const secondCodec = second.getConfiguration().codecs.video![0];

    // Assert: targetごとにinstallでき、codec instanceはPC間でも入力とも共有しない。
    expect(firstTarget.RTCPeerConnection).not.toBe(
      secondTarget.RTCPeerConnection,
    );
    expect(firstCodec).not.toBe(installCodec);
    expect(firstCodec).not.toBe(siblingCodec);
    expect(firstCodec).not.toBe(secondCodec);
    first.close();
    sibling.close();
    second.close();
    uninstallFirst();
    uninstallSecond();
  });

  test("header extensions merge by kind and are cloned", () => {
    const audioExtension = new RTCRtpHeaderExtensionParameters({
      id: 1,
      uri: "urn:example:audio-install",
    });
    const installVideoExtension = new RTCRtpHeaderExtensionParameters({
      id: 2,
      uri: "urn:example:video-install",
    });
    const constructorVideoExtension = new RTCRtpHeaderExtensionParameters({
      id: 3,
      uri: "urn:example:video-constructor",
    });
    const target: Record<string, unknown> = {};
    const uninstall = installPolyfill({
      mediaRegister: [],
      target,
      peerConnectionConfig: {
        headerExtensions: {
          audio: [audioExtension],
          video: [installVideoExtension],
        },
      },
    });
    const Constructor = target.RTCPeerConnection as PeerConnectionConstructor;

    // Act: constructor側ではvideo kindだけを置換する。
    const pc = new Constructor({
      headerExtensions: { video: [constructorVideoExtension] },
    });
    const extensions = pc.getConfiguration().headerExtensions;

    // Assert: audioはinstall値を維持し、videoは置換され、各要素をcloneする。
    expect(extensions.audio?.map(({ uri }) => uri)).toEqual([
      audioExtension.uri,
    ]);
    expect(extensions.video?.map(({ uri }) => uri)).toEqual([
      constructorVideoExtension.uri,
    ]);
    expect(extensions.audio![0]).not.toBe(audioExtension);
    expect(extensions.video![0]).not.toBe(constructorVideoExtension);
    pc.close();
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
