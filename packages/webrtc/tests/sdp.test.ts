import {
  GroupDescription,
  MediaDescription,
  SessionDescription,
  codecParametersFromString,
  codecParametersToString,
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
