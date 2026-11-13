import { afterEach, describe, expect, test } from "vitest";

import { RTCPeerConnection } from "../../src";
import {
  connectPeerConnections,
  firstIceTransport,
  iceIntegrityConfig,
  sdpIceOptionLines,
} from "../utils";

/**
 * RFC 8445 §10 / RFC 8839 §5.6 `ice2` ice-option and RFC 8489
 * MESSAGE-INTEGRITY-SHA256 through the RTCPeerConnection configuration.
 */
describe("ice-options ice2 / iceMessageIntegrity", () => {
  const peers: RTCPeerConnection[] = [];
  const createPeer = (
    config: ConstructorParameters<typeof RTCPeerConnection>[0],
  ) => {
    const pc = new RTCPeerConnection(config);
    peers.push(pc);
    return pc;
  };
  afterEach(async () => {
    await Promise.allSettled(peers.splice(0).map((pc) => pc.close()));
  });

  test("iceOptionIce2 有効時は全 m-line に a=ice-options:trickle ice2 を出力する", async () => {
    // Arrange
    const pc = createPeer({
      ...iceIntegrityConfig().config,
      iceOptionIce2: true,
    });
    pc.addTransceiver("audio");
    pc.createDataChannel("dc");

    // Act: offer を作る
    const offer = await pc.createOffer();

    // Assert: m-line ごとに trickle と ice2 を宣言する
    const lines = sdpIceOptionLines(offer.sdp);
    expect(lines.length).toBe(2);
    expect(new Set(lines)).toEqual(new Set(["a=ice-options:trickle ice2"]));
  });

  test("既定では a=ice-options:trickle だけを出力する（ice2 なし）", async () => {
    // Arrange
    const pc = createPeer(iceIntegrityConfig().config);
    pc.createDataChannel("dc");

    // Act: offer を作る
    const offer = await pc.createOffer();

    // Assert: 従来どおり trickle だけ
    expect(sdpIceOptionLines(offer.sdp)).toEqual(["a=ice-options:trickle"]);
  });

  test("remote の ice2 を判定し、RTCIceTransport / Connection に伝える", async () => {
    // Arrange: offerer だけ ice2 を宣言する
    const offerer = createPeer({
      ...iceIntegrityConfig().config,
      iceOptionIce2: true,
    });
    const answerer = createPeer(iceIntegrityConfig().config);
    const beforeNegotiation = {
      ice2: answerer.remoteIceOptionIce2,
      trickle: answerer.canTrickleIceCandidates,
    };

    // Act: offer / answer を交換して接続する
    await connectPeerConnections(offerer, answerer);

    // Assert: remote description が無い間は null、交換後は相手の宣言どおり
    expect(beforeNegotiation).toEqual({ ice2: null, trickle: null });
    expect(answerer.remoteIceOptionIce2).toBe(true);
    expect(firstIceTransport(answerer).ice.remoteIce2).toBe(true);
    expect(firstIceTransport(answerer).ice.remoteIceOptions).toEqual([
      "trickle",
      "ice2",
    ]);
    expect(offerer.remoteIceOptionIce2).toBe(false);
    expect(firstIceTransport(offerer).ice.remoteIce2).toBe(false);
    // canTrickleIceCandidates は ice2 の有無に関わらず trickle を判定する
    expect(answerer.canTrickleIceCandidates).toBe(true);
    expect(offerer.canTrickleIceCandidates).toBe(true);
  });

  test("iceOptionIce2 は構築後に変更できない", () => {
    // Arrange
    const pc = createPeer(iceIntegrityConfig().config);

    // Act / Assert: 変更は InvalidModificationError、同じ値は許可される
    expect(() => pc.setConfiguration({ iceOptionIce2: true })).toThrow(
      "iceOptionIce2 cannot be changed",
    );
    expect(() => pc.setConfiguration({ iceOptionIce2: false })).not.toThrow();
  });

  test("iceMessageIntegrity は sha1 / sha256 / both 以外を拒否する", () => {
    // Act / Assert: 不正な値は TypeError
    expect(
      () =>
        new RTCPeerConnection({
          iceMessageIntegrity: "md5" as unknown as "sha1",
        }),
    ).toThrow(TypeError);
  });

  test.each([
    [undefined, "sha1"],
    ["sha256", "sha256"],
    ["both", "sha256"],
  ] as const)(
    "iceMessageIntegrity=%s どうしで接続でき、相手は %s 署名のチェックを受け取る",
    async (mode, expected) => {
      // Arrange
      const offererRecord = iceIntegrityConfig({ iceMessageIntegrity: mode });
      const answererRecord = iceIntegrityConfig({ iceMessageIntegrity: mode });
      const offerer = createPeer(offererRecord.config);
      const answerer = createPeer(answererRecord.config);

      // Act: offer / answer を交換して接続する
      await connectPeerConnections(offerer, answerer);

      // Assert: 接続でき、受け取ったチェックの完全性アルゴリズムが設定どおり
      const received = [...offererRecord.received, ...answererRecord.received];
      expect(received.length).toBeGreaterThan(0);
      expect(new Set(received)).toEqual(new Set([expected]));
    },
  );
});
