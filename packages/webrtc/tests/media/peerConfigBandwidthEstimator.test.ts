import { afterEach, describe, expect, test } from "vitest";

import {
  DisabledBandwidthEstimator,
  GccBandwidthEstimator,
  RTCPeerConnection,
  RTCRtpSender,
  SenderBandwidthEstimator,
  createBandwidthEstimator,
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

  test("default は legacy SenderBandwidthEstimator", () => {
    // Arrange
    const peer = pc();

    // Act
    const sender = peer.addTransceiver("video").sender;

    // Assert: コンストラクタ未指定は従来どおり legacy
    expect(sender.senderBWE).toBeInstanceOf(SenderBandwidthEstimator);
    expect(peer.getConfiguration().bandwidthEstimator).toBe("legacy");
  });

  test('bandwidthEstimator: "gcc" は各 sender に GccBandwidthEstimator を付ける', () => {
    // Arrange
    const peer = pc({ bandwidthEstimator: "gcc" });

    // Act
    const video = peer.addTransceiver("video").sender;
    const audio = peer.addTransceiver("audio").sender;

    // Assert: sender ごとに別インスタンス
    expect(video.senderBWE).toBeInstanceOf(GccBandwidthEstimator);
    expect(audio.senderBWE).toBeInstanceOf(GccBandwidthEstimator);
    expect(video.senderBWE).not.toBe(audio.senderBWE);
    expect(peer.getConfiguration().bandwidthEstimator).toBe("gcc");
  });

  test("bandwidthEstimator: false は DisabledBandwidthEstimator で無効化する", () => {
    // Arrange
    const peer = pc({ bandwidthEstimator: false });

    // Act
    const sender = peer.addTransceiver("audio").sender;

    // Assert: TWCC を受けても帯域は出ない
    expect(sender.senderBWE).toBeInstanceOf(DisabledBandwidthEstimator);
    expect(sender.senderBWE.availableBitrate).toBe(0);
    expect(sender.senderBWE.processIntervalMs).toBe(0);
    expect(sender.senderBWE.getPacingBitrateBps()).toBe(0);
  });

  test('bandwidthEstimator: "none" も DisabledBandwidthEstimator', () => {
    // Arrange / Act
    const sender = pc({ bandwidthEstimator: "none" }).addTransceiver(
      "video",
    ).sender;

    // Assert
    expect(sender.senderBWE).toBeInstanceOf(DisabledBandwidthEstimator);
  });

  test("factory は sender ごとに 1 回呼ばれる", () => {
    // Arrange
    let n = 0;
    const peer = pc({
      bandwidthEstimator: () => {
        n += 1;
        return new GccBandwidthEstimator(200_000);
      },
    });

    // Act
    peer.addTransceiver("audio");
    peer.addTransceiver("video");

    // Assert
    expect(n).toBe(2);
    expect(peer.getSenders()[0].senderBWE).toBeInstanceOf(
      GccBandwidthEstimator,
    );
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

  test("createBandwidthEstimator の preset と factory", () => {
    // Arrange / Act / Assert
    expect(createBandwidthEstimator("legacy")).toBeInstanceOf(
      SenderBandwidthEstimator,
    );
    expect(createBandwidthEstimator("gcc")).toBeInstanceOf(
      GccBandwidthEstimator,
    );
    expect(createBandwidthEstimator(false)).toBeInstanceOf(
      DisabledBandwidthEstimator,
    );
    expect(createBandwidthEstimator("none")).toBeInstanceOf(
      DisabledBandwidthEstimator,
    );
    const custom = new SenderBandwidthEstimator();
    expect(createBandwidthEstimator(() => custom)).toBe(custom);
  });
});
