import { GroupDescription, MediaDescription, SessionDescription } from "../src";

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
});
