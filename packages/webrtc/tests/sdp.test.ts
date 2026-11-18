import {
  codecParametersFromString,
  codecParametersToString,
  descriptionIceOptions,
  GroupDescription,
  MediaDescription,
  parseIceOptions,
  SessionDescription,
} from "../src";

describe("sdp", () => {
  test("rtx", () => {
    const sdp = new SessionDescription();
    const media = new MediaDescription("video", 9, "UDP/TLS/RTP/SAVPF", [98]);
    media.ssrcGroup = [new GroupDescription("FID", ["ssrc", "rtx"])];
    sdp.media.push(media);

    const str = sdp.string;
    expect(SessionDescription.parse(str).media[0].ssrcGroup).toEqual([
      new GroupDescription("FID", ["ssrc", "rtx"]),
    ]);
  });

  describe("codecParametersFromString", () => {
    test("h264 parameters", () => {
      const params = codecParametersFromString(
        "packetization-mode:0;profile-level-id:42001f;level-asymmetry-allowed:0",
      );
      expect(params).toEqual({
        "level-asymmetry-allowed": 0,
        "packetization-mode": 0,
        "profile-level-id": "42001f",
      });
    });

    test("empty input does not create an empty parameter key", () => {
      expect(codecParametersFromString("")).toEqual({});
    });
  });

  describe("codecParametersToString", () => {
    test("keeps numeric zero and omits empty or undefined entries", () => {
      const parameters = codecParametersToString({
        "": "ignored",
        "packetization-mode": 0,
        ignored: undefined,
        "profile-level-id": "42e01f",
      });

      expect(parameters).toBe("packetization-mode=0;profile-level-id=42e01f");
      expect(codecParametersFromString(parameters!)["packetization-mode"]).toBe(
        0,
      );
    });
  });
});

describe("bundle-only", () => {
  // Firefox 157 の ICE restart offer の非tag m-line の形 (ticket 21a27c92 §2)。
  const offer = [
    "v=0",
    "o=- 1 2 IN IP4 0.0.0.0",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0 1",
    "m=video 9 UDP/TLS/RTP/SAVPF 96",
    "c=IN IP4 0.0.0.0",
    "a=mid:0",
    "a=rtpmap:96 VP8/90000",
    "m=video 0 UDP/TLS/RTP/SAVPF 96",
    "c=IN IP4 0.0.0.0",
    "a=bundle-only",
    "a=sendrecv",
    "a=mid:1",
    "a=rtpmap:96 VP8/90000",
    "",
  ].join("\r\n");

  test("a=bundle-only を読み、port 0 と一緒に書き戻す", () => {
    // Act: parse して文字列に戻す。
    const parsed = SessionDescription.parse(offer);
    const written = SessionDescription.parse(parsed.string);

    // Assert: 非tag だけが bundle-only で、書き戻しても port 0 + bundle-only のまま。
    expect(parsed.media.map((m) => [m.port, m.bundleOnly])).toEqual([
      [9, false],
      [0, true],
    ]);
    expect(written.media.map((m) => [m.port, m.bundleOnly])).toEqual([
      [9, false],
      [0, true],
    ]);
  });

  test("受け入れた bundle-only の m-line は内部の port に関わらず port 0 で書く", () => {
    // Arrange: BUNDLE に受け入れた状態 (SDPManager.acceptBundleOnlyMedia と同じ)。
    const parsed = SessionDescription.parse(offer);
    parsed.media[1].port = 9;
    parsed.media[1].acceptedBundleOnly = true;

    // Act: 文字列に戻す。
    const written = parsed.string;

    // Assert: 受け取ったときの m 行と a=bundle-only が残る。
    expect(written).toContain("m=video 0 UDP/TLS/RTP/SAVPF 96\r\n");
    expect(written).toContain("a=bundle-only\r\n");
  });
});

describe("ice-options", () => {
  test("parseIceOptions はスペース区切りのトークンに分解する", () => {
    // Act: 余分な空白や未指定を含む値を分解する
    const tokens = parseIceOptions("  trickle   ice2 ");
    const none = parseIceOptions(undefined);

    // Assert: 空トークンは含まない
    expect(tokens).toEqual(["trickle", "ice2"]);
    expect(none).toEqual([]);
  });

  test("descriptionIceOptions は session レベルの値を m-line に継承して集める", () => {
    // Arrange: session レベルにだけ ice2 を置いた SDP
    const sdp = [
      "v=0",
      "o=- 1 1 IN IP4 0.0.0.0",
      "s=-",
      "t=0 0",
      "a=ice-options:trickle ice2",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
      "c=IN IP4 0.0.0.0",
      "a=mid:0",
      "",
    ].join("\r\n");

    // Act: パースしてトークンを集める
    const description = SessionDescription.parse(sdp);

    // Assert: m-line も session の値を持ち、ice2 を判定できる
    expect(description.media[0].iceOptions).toBe("trickle ice2");
    expect(descriptionIceOptions(description)).toContain("ice2");
  });
});
