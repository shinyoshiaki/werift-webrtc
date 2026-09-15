import { RTP_EXTENSION_URI } from "../../src";
import {
  assertExtmapCompatibleWithMedia,
  assignLocalExtmapIds,
  createExtmapNegotiationState,
  createLocalExtmapAllocator,
  negotiateRemoteHeaderExtensions,
  projectExtmapDirectionForAnswer,
  projectExtmapDirectionForMedia,
  projectHeaderExtensionsForMedia,
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

  test("remote answerの4096はofferにあればusable IDへremapしない", () => {
    const supported = new Set([RTP_EXTENSION_URI.sdesMid]);
    const selected = selectAnswerHeaderExtensions(
      [{ id: 4096, uri: RTP_EXTENSION_URI.sdesMid }],
      [{ id: 4096, uri: RTP_EXTENSION_URI.sdesMid }],
      supported,
    );
    expect(selected).toEqual([]);
  });

  test("remote answerの4096がofferに無いと拒否する", () => {
    const supported = new Set([RTP_EXTENSION_URI.sdesMid]);
    expect(() =>
      selectAnswerHeaderExtensions(
        [{ id: 4096, uri: RTP_EXTENSION_URI.sdesMid }],
        [{ id: 1, uri: RTP_EXTENSION_URI.sdesMid }],
        supported,
      ),
    ).toThrow(/was not offered/);
  });

  test("同じsessionではURI+attributesでIDを共有しdirectionは無視する", () => {
    const allocator = createLocalExtmapAllocator();
    const audio = assignLocalExtmapIds(
      [
        { id: 0, uri: RTP_EXTENSION_URI.sdesMid, direction: "sendonly" },
        { id: 0, uri: RTP_EXTENSION_URI.transportWideCC },
      ],
      allocator,
    );
    const video = assignLocalExtmapIds(
      [
        { id: 0, uri: RTP_EXTENSION_URI.transportWideCC },
        { id: 0, uri: RTP_EXTENSION_URI.sdesMid, direction: "recvonly" },
      ],
      allocator,
    );

    expect(audio[0]!.id).toBe(video[1]!.id);
    expect(audio[1]!.id).toBe(video[0]!.id);
    expect(audio[0]!.id).not.toBe(audio[1]!.id);
  });

  test("live mappingをseedすると既存IDを維持する", () => {
    const allocator = createLocalExtmapAllocator([
      { id: 4, uri: RTP_EXTENSION_URI.sdesMid },
    ]);
    const assigned = assignLocalExtmapIds(
      [
        { id: 0, uri: RTP_EXTENSION_URI.sdesMid },
        { id: 0, uri: RTP_EXTENSION_URI.transportWideCC },
      ],
      allocator,
    );

    expect(assigned[0]!.id).toBe(4);
    expect(assigned[1]!.id).not.toBe(4);
  });

  test("remote answerのvalid-range ID remapと未offerの追加を拒否する", () => {
    const supported = new Set([RTP_EXTENSION_URI.sdesMid]);
    const offered = [{ id: 1, uri: RTP_EXTENSION_URI.sdesMid }];

    expect(() =>
      selectAnswerHeaderExtensions(
        [{ id: 2, uri: RTP_EXTENSION_URI.sdesMid }],
        offered,
        supported,
      ),
    ).toThrow(/answer remapped extmap/);
    expect(() =>
      selectAnswerHeaderExtensions(
        [
          { id: 1, uri: RTP_EXTENSION_URI.sdesMid },
          { id: 2, uri: RTP_EXTENSION_URI.transportWideCC },
        ],
        offered,
        supported,
      ),
    ).toThrow(/was not offered/);
  });

  test("4096 offerをvalid-rangeへremapしたanswerは受理する", () => {
    const supported = new Set([RTP_EXTENSION_URI.sdesMid]);
    const selected = selectAnswerHeaderExtensions(
      [{ id: 2, uri: RTP_EXTENSION_URI.sdesMid }],
      [{ id: 4096, uri: RTP_EXTENSION_URI.sdesMid }],
      supported,
    );
    expect(selected).toEqual([
      expect.objectContaining({ id: 2, uri: RTP_EXTENSION_URI.sdesMid }),
    ]);
  });

  test("recvonly mediaにsendonly extmapは矛盾する", () => {
    expect(() =>
      assertExtmapCompatibleWithMedia(
        { id: 1, uri: RTP_EXTENSION_URI.sdesMid, direction: "sendonly" },
        "recvonly",
      ),
    ).toThrow(/contradicts media direction/);
  });

  test("BUNDLE統合時はstable IDをremapせず衝突したextensionを外す", () => {
    const allocator = createLocalExtmapAllocator();
    const audio = assignLocalExtmapIds(
      [{ id: 1, uri: RTP_EXTENSION_URI.sdesMid }],
      allocator,
    );
    const video = assignLocalExtmapIds(
      [{ id: 1, uri: RTP_EXTENSION_URI.transportWideCC }],
      allocator,
    );

    expect(audio).toEqual([
      expect.objectContaining({ id: 1, uri: RTP_EXTENSION_URI.sdesMid }),
    ]);
    expect(video).toEqual([]);
  });

  test("valid range外のlocal IDはstableとして残さず1-255へ再割当する", () => {
    const allocator = createLocalExtmapAllocator();
    const assigned = assignLocalExtmapIds(
      [
        { id: 1, uri: RTP_EXTENSION_URI.sdesMid },
        { id: 300, uri: RTP_EXTENSION_URI.transportWideCC },
        { id: 4096, uri: RTP_EXTENSION_URI.absSendTime },
      ],
      allocator,
    );

    expect(assigned[0]).toEqual(
      expect.objectContaining({ id: 1, uri: RTP_EXTENSION_URI.sdesMid }),
    );
    expect(assigned[1]!.uri).toBe(RTP_EXTENSION_URI.transportWideCC);
    expect(assigned[1]!.id).toBeGreaterThanOrEqual(1);
    expect(assigned[1]!.id).toBeLessThanOrEqual(255);
    expect(assigned[1]!.id).not.toBe(300);
    expect(assigned[2]!.uri).toBe(RTP_EXTENSION_URI.absSendTime);
    expect(assigned[2]!.id).toBeGreaterThanOrEqual(1);
    expect(assigned[2]!.id).toBeLessThanOrEqual(255);
    expect(assigned[2]!.id).not.toBe(4096);
    expect(new Set(assigned.map((extension) => extension.id)).size).toBe(3);
  });

  test("inactive mediaの省略extmapはsendrecvとして扱い明示sendrecvも許可する", () => {
    expect(() =>
      assertExtmapCompatibleWithMedia(
        { id: 1, uri: RTP_EXTENSION_URI.sdesMid },
        "inactive",
      ),
    ).not.toThrow();
    expect(() =>
      assertExtmapCompatibleWithMedia(
        { id: 1, uri: RTP_EXTENSION_URI.sdesMid, direction: "sendrecv" },
        "inactive",
      ),
    ).not.toThrow();
    expect(() =>
      assertExtmapCompatibleWithMedia(
        { id: 1, uri: RTP_EXTENSION_URI.sdesMid, direction: "inactive" },
        "inactive",
      ),
    ).not.toThrow();
  });

  test("sendrecv extmapはrecvonly m-lineへ絞り込んでqualifierを省略する", () => {
    expect(
      projectExtmapDirectionForMedia("sendrecv", "recvonly"),
    ).toBeUndefined();
    expect(
      projectHeaderExtensionsForMedia(
        [{ id: 1, uri: RTP_EXTENSION_URI.sdesMid, direction: "sendrecv" }],
        "recvonly",
      )[0]!.direction,
    ).toBeUndefined();
  });

  test("recvonly offerの省略extmapはinactive answerでinactiveにする", () => {
    expect(
      projectExtmapDirectionForAnswer(undefined, "inactive", "recvonly"),
    ).toBe("inactive");
    expect(
      projectHeaderExtensionsForMedia(
        [{ id: 1, uri: RTP_EXTENSION_URI.sdesMid }],
        "inactive",
        new Map([[`${RTP_EXTENSION_URI.sdesMid}\n`, "recvonly"]]),
      )[0]!.direction,
    ).toBe("inactive");
  });
});
