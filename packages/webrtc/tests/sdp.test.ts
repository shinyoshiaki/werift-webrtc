import {
  codecParametersFromString,
  codecParametersToString,
  descriptionIceOptions,
  GroupDescription,
  MediaDescription,
  parseIceOptions,
  rtcpAttributeFromSdp,
  rtcpAttributeToSdp,
  SessionDescription,
} from "../src";
import { buildAudioSdp, rtcpLines } from "./sdpUtils";

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

  describe("a=rtcp (RFC 3605)", () => {
    test("アドレス省略形 a=rtcp:<port> をパースし、省略形のまま再シリアライズする", () => {
      // Arrange
      const sdp = buildAudioSdp({
        sessionHost: "192.0.2.10",
        mediaAttributes: ["a=rtcp:53020"],
      });

      // Act: パースして再シリアライズする
      const description = SessionDescription.parse(sdp);
      const media = description.media[0];
      const serialized = description.string;

      // Assert: port だけを持ち、host は継承値で埋めず undefined のまま
      expect(media.rtcpPort).toBe(53020);
      expect(media.rtcpHost).toBeUndefined();
      // Assert: アドレスを補わず a=rtcp:<port> のまま出力する
      expect(rtcpLines(serialized)).toEqual(["a=rtcp:53020"]);
    });

    test.each([
      ["IPv4", "a=rtcp:53020 IN IP4 192.0.2.1", "192.0.2.1"],
      ["IPv6", "a=rtcp:53020 IN IP6 2001:db8::1", "2001:db8::1"],
    ])("アドレス付き形式 (%s) を round trip する", (_, line, host) => {
      // Arrange
      const sdp = buildAudioSdp({
        sessionHost: "192.0.2.10",
        mediaAttributes: [line],
      });

      // Act: パースして再シリアライズする
      const description = SessionDescription.parse(sdp);
      const media = description.media[0];

      // Assert: port と host を保持し、同じ行を出力する
      expect(media.rtcpPort).toBe(53020);
      expect(media.rtcpHost).toBe(host);
      expect(rtcpLines(description.string)).toEqual([line]);
    });

    test.each([
      {
        name: "media-level の c= だけ",
        sessionHost: undefined,
        mediaHost: "192.0.2.20",
        expected: "192.0.2.20",
      },
      {
        name: "session-level の c= だけ",
        sessionHost: "192.0.2.10",
        mediaHost: undefined,
        expected: "192.0.2.10",
      },
      {
        name: "両方 (media-level が優先)",
        sessionHost: "192.0.2.10",
        mediaHost: "192.0.2.20",
        expected: "192.0.2.20",
      },
    ])(
      "省略時の有効 RTCP アドレスは c= から解決できる: $name",
      ({ sessionHost, mediaHost, expected }) => {
        // Arrange
        const sdp = buildAudioSdp({
          sessionHost,
          mediaHost,
          mediaAttributes: ["a=rtcp:53020"],
        });

        // Act: パースする
        const description = SessionDescription.parse(sdp);
        const media = description.media[0];

        // Assert: rtcpHost は undefined のまま、RFC 3605 の継承規則で有効アドレスが決まる
        expect(media.rtcpHost).toBeUndefined();
        expect(media.rtcpHost ?? media.host ?? description.host).toBe(expected);
      },
    );

    test("a=rtcp なしの a=rtcp-mux を保持する", () => {
      // Arrange
      const sdp = buildAudioSdp({
        sessionHost: "192.0.2.10",
        mediaAttributes: ["a=rtcp-mux"],
      });

      // Act: パースして再シリアライズする
      const description = SessionDescription.parse(sdp);
      const media = description.media[0];

      // Assert: rtcp-mux だけを持ち、再シリアライズ後も消えない
      expect(media.rtcpMux).toBe(true);
      expect(media.rtcpPort).toBeUndefined();
      expect(rtcpLines(description.string)).toEqual(["a=rtcp-mux"]);
    });

    test("werift が生成する a=rtcp:9 IN IP4 0.0.0.0 + a=rtcp-mux を round trip する", () => {
      // Arrange
      const sdp = buildAudioSdp({
        mediaHost: "0.0.0.0",
        mediaAttributes: ["a=rtcp:9 IN IP4 0.0.0.0", "a=rtcp-mux"],
      });

      // Act: パースして再シリアライズする
      const description = SessionDescription.parse(sdp);

      // Assert: 順序 (a=rtcp → a=rtcp-mux) も含めて同じ行を出力する
      expect(rtcpLines(description.string)).toEqual([
        "a=rtcp:9 IN IP4 0.0.0.0",
        "a=rtcp-mux",
      ]);
    });

    test.each([
      "",
      "abc",
      "0",
      "65536",
      "-1",
      "53020 IN",
      "53020 IN IP4",
      "53020 IN IP5 1.2.3.4",
      "53020 XX IP4 1.2.3.4",
      "53020 IN IP4 1.2.3.4 extra",
      "abc IN IP4 1.2.3.4",
    ])("malformed な a=rtcp:%j は行の内容を含むエラーになる", (value) => {
      // Arrange
      const sdp = buildAudioSdp({
        sessionHost: "192.0.2.10",
        mediaAttributes: [`a=rtcp:${value}`],
      });

      // Act / Assert: パースが a=rtcp の値を含むメッセージで失敗する
      expect(() => SessionDescription.parse(sdp)).toThrow(
        `invalid a=rtcp attribute: ${JSON.stringify(value)}`,
      );
    });

    test("rtcpAttributeFromSdp / rtcpAttributeToSdp は境界値の port を扱える", () => {
      // Act: 境界値をパースする
      const min = rtcpAttributeFromSdp("1");
      const max = rtcpAttributeFromSdp("65535 IN IP4 192.0.2.1");

      // Assert: 1 と 65535 は有効で、生成は入力と一致する
      expect(min).toEqual({ port: 1 });
      expect(max).toEqual({
        port: 65535,
        host: "192.0.2.1",
        addrType: "IP4",
      });
      expect(rtcpAttributeToSdp(min)).toBe("1");
      expect(rtcpAttributeToSdp(max)).toBe("65535 IN IP4 192.0.2.1");
    });

    test.each([
      "a=rtcp:53020 IN IP4 host.example.com",
      "a=rtcp:53020 IN IP6 host.example.com",
    ])("ホスト名を含む %s は addrtype を保ったまま round trip する", (line) => {
      // Arrange: ホスト名のアドレス付き a=rtcp を含む SDP
      const sdp = buildAudioSdp({
        sessionHost: "192.0.2.1",
        mediaAttributes: [line],
      });

      // Act: パースして再シリアライズする
      const serialized = SessionDescription.parse(sdp).string;

      // Assert: addrtype もアドレスも入力と同じ
      expect(rtcpLines(serialized)).toEqual([line]);
    });
  });
});

describe("a=rid restrictions (RFC 8851)", () => {
  const offer = [
    "v=0",
    "o=- 1 2 IN IP4 0.0.0.0",
    "s=-",
    "t=0 0",
    "m=video 9 UDP/TLS/RTP/SAVPF 96",
    "c=IN IP4 0.0.0.0",
    "a=mid:0",
    "a=rtpmap:96 VP8/90000",
    "a=rid:high send max-width=1280;max-height=720",
    "a=rid:low send",
    "a=simulcast:send high;low",
    "",
  ].join("\r\n");

  test("a=rid の方向と制約を分けて読み、書き戻すと元の行になる", () => {
    // Act: parse して文字列に戻す。
    const parsed = SessionDescription.parse(offer);
    const written = parsed.string;

    // Assert: 方向は send だけで、制約は restrictions に入り、制約のない RID には付かない。
    expect(
      parsed.media[0].simulcastParameters.map(
        ({ rid, direction, restrictions }) => ({
          rid,
          direction,
          restrictions,
        }),
      ),
    ).toEqual([
      {
        rid: "high",
        direction: "send",
        restrictions: "max-width=1280;max-height=720",
      },
      { rid: "low", direction: "send", restrictions: undefined },
    ]);
    // Assert: 書き戻した a=rid 行は元と同じ。
    expect(written).toContain(
      "a=rid:high send max-width=1280;max-height=720\r\n",
    );
    expect(written).toContain("a=rid:low send\r\n");
  });
});
