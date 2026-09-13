import { RTP_EXTENSION_URI } from "../../src";
import {
  createExtmapNegotiationState,
  negotiateRemoteHeaderExtensions,
  reverseExtmapDirection,
  seedExtmapUsedIds,
} from "../../src/media/extmap";

describe("extmap negotiation", () => {
  test("sendonly/recvonlyを反転しsendrecv/inactiveは維持する", () => {
    expect(reverseExtmapDirection("sendonly")).toBe("recvonly");
    expect(reverseExtmapDirection("recvonly")).toBe("sendonly");
    expect(reverseExtmapDirection("sendrecv")).toBe("sendrecv");
    expect(reverseExtmapDirection("inactive")).toBe("inactive");
    expect(reverseExtmapDirection(undefined)).toBeUndefined();
  });

  test("RFC 8285の4096 alternativesから1つを通常IDへremapする", () => {
    const supported = new Set([
      RTP_EXTENSION_URI.sdesMid,
      RTP_EXTENSION_URI.transportWideCC,
    ]);
    const state = createExtmapNegotiationState();
    seedExtmapUsedIds(
      state,
      [
        { id: 4096, uri: RTP_EXTENSION_URI.sdesMid },
        { id: 4096, uri: RTP_EXTENSION_URI.transportWideCC },
      ],
      supported,
    );

    const negotiated = negotiateRemoteHeaderExtensions(
      [
        { id: 4096, uri: RTP_EXTENSION_URI.sdesMid },
        { id: 4096, uri: RTP_EXTENSION_URI.transportWideCC },
      ],
      supported,
      state,
    );

    expect(negotiated).toHaveLength(1);
    expect(negotiated[0]!.uri).toBe(RTP_EXTENSION_URI.sdesMid);
    expect(negotiated[0]!.id).toBeGreaterThanOrEqual(1);
    expect(negotiated[0]!.id).toBeLessThanOrEqual(14);
    expect(negotiated[0]!.id).not.toBe(4096);
  });
});
