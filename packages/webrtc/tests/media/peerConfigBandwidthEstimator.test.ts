import { afterEach, describe, expect, test } from "vitest";

import {
  type BandwidthEstimatorOption,
  createBandwidthEstimator,
  DisabledBandwidthEstimator,
  GccBandwidthEstimator,
  LightweightBandwidthEstimator,
  RTCPeerConnection,
  RTCRtpSender,
} from "../../src";

describe("PeerConfig.bandwidthEstimator", () => {
  const pcs: RTCPeerConnection[] = [];

  afterEach(async () => {
    await Promise.all(pcs.splice(0).map((pc) => pc.close()));
  });

  function pc(config?: ConstructorParameters<typeof RTCPeerConnection>[0]) {
    const peer = new RTCPeerConnection({ iceServers: [], ...config });
    pcs.push(peer);
    return peer;
  }

  test.each([
    {
      option: undefined,
      configured: "lightweight",
      expected: LightweightBandwidthEstimator,
    },
    {
      option: "lightweight",
      configured: "lightweight",
      expected: LightweightBandwidthEstimator,
    },
    { option: "gcc", configured: "gcc", expected: GccBandwidthEstimator },
    { option: false, configured: false, expected: DisabledBandwidthEstimator },
    {
      option: "none",
      configured: "none",
      expected: DisabledBandwidthEstimator,
    },
  ] as {
    option: BandwidthEstimatorOption | undefined;
    configured: BandwidthEstimatorOption;
    expected: abstract new (...args: never[]) => unknown;
  }[])(
    "bandwidthEstimator: $option は各 sender に $expected.name を別インスタンスで付ける",
    ({ option, configured, expected }) => {
      // Arrange
      const peer = pc(
        option === undefined ? undefined : { bandwidthEstimator: option },
      );

      // Act
      const video = peer.addTransceiver("video").sender;
      const audio = peer.addTransceiver("audio").sender;

      // Assert: sender ごとに指定どおりの estimator が別インスタンスで付く
      expect(video.senderBWE).toBeInstanceOf(expected);
      expect(audio.senderBWE).toBeInstanceOf(expected);
      expect(video.senderBWE).not.toBe(audio.senderBWE);
      expect(peer.getConfiguration().bandwidthEstimator).toBe(configured);
      // Assert: createBandwidthEstimator も同じ preset 解釈をする
      expect(createBandwidthEstimator(option)).toBeInstanceOf(expected);
    },
  );

  test("factory は sender ごとに 1 回呼ばれ、戻り値がそのまま使われる", () => {
    // Arrange
    const created: GccBandwidthEstimator[] = [];
    const peer = pc({
      bandwidthEstimator: () => {
        const gcc = new GccBandwidthEstimator(200_000);
        created.push(gcc);
        return gcc;
      },
    });

    // Act
    peer.addTransceiver("audio");
    peer.addTransceiver("video");

    // Assert
    expect(created).toHaveLength(2);
    expect(peer.getSenders().map((s) => s.senderBWE)).toEqual(created);
    const custom = new LightweightBandwidthEstimator();
    expect(createBandwidthEstimator(() => custom)).toBe(custom);
  });

  test("factory で指定した min/max は、balanced の初回交渉で video sender が BUNDLE に統合されても保たれる", async () => {
    // Arrange: factory が min 50k / start 100k / max 150k を指定した GCC を返す、balanced の offerer
    const estimators: GccBandwidthEstimator[] = [];
    const offerer = pc({
      bundlePolicy: "balanced",
      bandwidthEstimator: () => {
        const gcc = new GccBandwidthEstimator(300_000);
        gcc.setBitrates(50_000, 100_000, 150_000);
        estimators.push(gcc);
        return gcc;
      },
    });
    const answerer = pc();
    const audio = offerer.addTransceiver("audio", { direction: "sendonly" });
    const video = offerer.addTransceiver("video", { direction: "sendonly" });

    // Act: 初回 offer では別 transport、BUNDLE を受理した answer で audio の transport に統合される
    await offerer.setLocalDescription(await offerer.createOffer());
    const offeredVideoTransport = video.sender.transport;
    await answerer.setRemoteDescription(offerer.localDescription!);
    await answerer.setLocalDescription(await answerer.createAnswer());
    await offerer.setRemoteDescription(answerer.localDescription!);
    const gcc = video.sender.senderBWE as GccBandwidthEstimator;
    const probeTargets: number[] = [];
    gcc.onProbeClusterConfig.subscribe((cfg) =>
      probeTargets.push(cfg.targetBps),
    );
    gcc.setNetworkAvailable(true);
    gcc.process(Date.now());

    // Assert: video sender は transport が切り替わり、その後の probe 目標も max 150 kbps 以下
    expect(estimators).toContain(gcc);
    expect(video.sender.transport).not.toBe(offeredVideoTransport);
    expect(video.sender.transport).toBe(audio.sender.transport);
    expect(probeTargets.length).toBeGreaterThan(0);
    expect(Math.max(...probeTargets)).toBeLessThanOrEqual(150_000);
  });

  test("RTCRtpSender コンストラクタでも estimator を渡せる", () => {
    // Arrange
    const gcc = new GccBandwidthEstimator();

    // Act
    const sender = new RTCRtpSender("video", { bandwidthEstimator: gcc });

    // Assert: setBandwidthEstimator を呼ばなくても注入される
    expect(sender.senderBWE).toBe(gcc);
    sender.stop();
  });
});
