import { RTP_EXTENSION_URI } from "../../src";
import {
  createExtmapNegotiationState,
  negotiateRemoteHeaderExtensions,
  reverseExtmapDirection,
  seedExtmapUsedIds,
  selectAnswerHeaderExtensions,
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
    seedExtmapUsedIds(state, [
      { id: 4096, uri: RTP_EXTENSION_URI.sdesMid },
      { id: 4096, uri: RTP_EXTENSION_URI.transportWideCC },
    ]);

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

  test("4096のremap先はunsupported extensionのIDと衝突しない", () => {
    const supported = new Set([RTP_EXTENSION_URI.sdesMid]);
    const state = createExtmapNegotiationState();
    seedExtmapUsedIds(state, [
      { id: 1, uri: "urn:example:unsupported" },
      { id: 4096, uri: RTP_EXTENSION_URI.sdesMid },
    ]);

    const negotiated = negotiateRemoteHeaderExtensions(
      [
        { id: 1, uri: "urn:example:unsupported" },
        { id: 4096, uri: RTP_EXTENSION_URI.sdesMid },
      ],
      supported,
      state,
    );

    expect(negotiated).toHaveLength(1);
    expect(negotiated[0]!.uri).toBe(RTP_EXTENSION_URI.sdesMid);
    expect(negotiated[0]!.id).not.toBe(1);
    expect(negotiated[0]!.id).not.toBe(4096);
  });

  test("同じ4096 alternativeでもm-lineごとのdirectionは保持する", () => {
    const supported = new Set([RTP_EXTENSION_URI.sdesMid]);
    const state = createExtmapNegotiationState();
    seedExtmapUsedIds(state, [
      { id: 4096, uri: RTP_EXTENSION_URI.sdesMid, direction: "sendonly" },
      { id: 4096, uri: RTP_EXTENSION_URI.sdesMid, direction: "recvonly" },
    ]);

    const audio = negotiateRemoteHeaderExtensions(
      [{ id: 4096, uri: RTP_EXTENSION_URI.sdesMid, direction: "sendonly" }],
      supported,
      state,
    );
    const video = negotiateRemoteHeaderExtensions(
      [{ id: 4096, uri: RTP_EXTENSION_URI.sdesMid, direction: "recvonly" }],
      supported,
      state,
    );

    expect(audio[0]!.id).toBe(video[0]!.id);
    expect(audio[0]!.direction).toBe("sendonly");
    expect(video[0]!.direction).toBe("recvonly");
  });

  test("remote answerの4096はusable IDへremapしない", () => {
    const supported = new Set([RTP_EXTENSION_URI.sdesMid]);
    const selected = selectAnswerHeaderExtensions(
      [{ id: 4096, uri: RTP_EXTENSION_URI.sdesMid }],
      supported,
    );
    expect(selected).toEqual([]);
  });
});
