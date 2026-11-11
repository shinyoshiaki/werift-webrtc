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
