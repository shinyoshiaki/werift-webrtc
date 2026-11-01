import { afterEach, describe, expect, test } from "vitest";

import {
  type BandwidthEstimatorOption,
  createBandwidthEstimator,
  DisabledBandwidthEstimator,
  GccBandwidthEstimator,
  RTCPeerConnection,
  RTCRtpSender,
  SenderBandwidthEstimator,
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
      configured: "legacy",
      expected: SenderBandwidthEstimator,
    },
    {
      option: "legacy",
      configured: "legacy",
      expected: SenderBandwidthEstimator,
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
    const custom = new SenderBandwidthEstimator();
    expect(createBandwidthEstimator(() => custom)).toBe(custom);
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
