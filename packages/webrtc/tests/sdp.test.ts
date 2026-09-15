import {
  GroupDescription,
  MediaDescription,
  SessionDescription,
  codecParametersFromString,
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

  test("extmapはdirectionとextensionattributesを保持する", () => {
    const sdp = [
      "v=0",
      "o=- 0 0 IN IP4 0.0.0.0",
      "s=-",
      "t=0 0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=extmap:1/sendonly urn:ietf:params:rtp-hdrext:sdes:mid",
      "a=extmap:2 urn:ietf:params:rtp-hdrext:sdes:mid config-b",
      "",
    ].join("\r\n");

    const parsed = SessionDescription.parse(sdp);
    expect(parsed.media[0]!.rtp.headerExtensions).toEqual([
      expect.objectContaining({
        id: 1,
        uri: "urn:ietf:params:rtp-hdrext:sdes:mid",
        direction: "sendonly",
      }),
      expect.objectContaining({
        id: 2,
        uri: "urn:ietf:params:rtp-hdrext:sdes:mid",
        attributes: "config-b",
      }),
    ]);
    expect(parsed.string).toContain(
      "a=extmap:1/sendonly urn:ietf:params:rtp-hdrext:sdes:mid",
    );
    expect(parsed.string).toContain(
      "a=extmap:2 urn:ietf:params:rtp-hdrext:sdes:mid config-b",
    );
  });

  test("RFC 8285 range外のextmap IDはparse時に拒否する", () => {
    const sdpFor = (id: string) =>
      [
        "v=0",
        "o=- 0 0 IN IP4 0.0.0.0",
        "s=-",
        "t=0 0",
        "m=audio 9 UDP/TLS/RTP/SAVPF 111",
        `a=extmap:${id} urn:ietf:params:rtp-hdrext:sdes:mid`,
        "",
      ].join("\r\n");

    expect(() => SessionDescription.parse(sdpFor("300"))).toThrow(
      /outside RFC 8285 range/,
    );
    expect(() => SessionDescription.parse(sdpFor("abc"))).toThrow(
      /invalid extmap id abc/,
    );
    expect(() => SessionDescription.parse(sdpFor("256"))).toThrow(
      /outside RFC 8285 range/,
    );
  });

  test("未知のextmap directionはparse時に拒否する", () => {
    const sdp = [
      "v=0",
      "o=- 0 0 IN IP4 0.0.0.0",
      "s=-",
      "t=0 0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=extmap:1/foobar urn:ietf:params:rtp-hdrext:sdes:mid",
      "",
    ].join("\r\n");

    expect(() => SessionDescription.parse(sdp)).toThrow(
      /invalid extmap direction foobar/,
    );
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
  });
});
