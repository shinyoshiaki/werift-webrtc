import { IceCandidate, RTCIceCandidate } from "../../src";
import { iceTransportPair } from "../fixture";

const host = "1 1 udp 2130706431 192.168.1.10 50000 typ host";
const srflx =
  "2 1 udp 1694498815 203.0.113.5 61000 typ srflx raddr 192.168.1.10 rport 50000";
const relay =
  "3 2 udp 16777215 198.51.100.7 3478 typ relay raddr 203.0.113.5 rport 61000";
const tcp =
  "4 1 tcp 1518280447 192.168.1.10 9 typ host tcptype active generation 0 ufrag abcd";

describe("RTCIceCandidate parsed fields", () => {
  test.each([
    {
      sdp: host,
      expected: {
        foundation: "1",
        component: "rtp",
        priority: 2130706431,
        address: "192.168.1.10",
        protocol: "udp",
        port: 50000,
        type: "host",
        tcpType: null,
        relatedAddress: null,
        relatedPort: null,
      },
    },
    {
      sdp: srflx,
      expected: {
        type: "srflx",
        address: "203.0.113.5",
        port: 61000,
        relatedAddress: "192.168.1.10",
        relatedPort: 50000,
      },
    },
    {
      sdp: relay,
      expected: {
        type: "relay",
        component: "rtcp",
        relatedAddress: "203.0.113.5",
        relatedPort: 61000,
      },
    },
    {
      sdp: tcp,
      expected: { protocol: "tcp", tcpType: "active", port: 9 },
    },
  ])(
    "fromSdp exposes the fields of $expected.type ($sdp)",
    ({ sdp, expected }) => {
      // Act: a-line から RTCIceCandidate を生成する
      const candidate = RTCIceCandidate.fromSdp(sdp);

      // Assert: a-line の各フィールドがブラウザ互換プロパティとして読める
      expect(candidate).toMatchObject(expected);
    },
  );

  test("constructor parses the candidate string, with or without the candidate: prefix", () => {
    // Act: RTCIceCandidateInit から生成する (ブラウザの new RTCIceCandidate(init) 相当)
    const withPrefix = new RTCIceCandidate({
      candidate: `candidate:${srflx}`,
      sdpMid: "0",
    });
    const withoutPrefix = new RTCIceCandidate({
      candidate: srflx,
      sdpMLineIndex: 0,
    });

    // Assert: どちらも同じ値に解析される
    for (const candidate of [withPrefix, withoutPrefix]) {
      expect(candidate).toMatchObject({
        foundation: "2",
        type: "srflx",
        relatedAddress: "192.168.1.10",
        relatedPort: 50000,
      });
    }
  });

  test("an empty or unparsable candidate string leaves the fields null", () => {
    // Act: end-of-candidates 相当の空文字列と壊れた文字列から生成する
    const empty = new RTCIceCandidate({ candidate: "", sdpMid: "0" });
    const broken = new RTCIceCandidate({ candidate: "garbage", sdpMid: "0" });

    // Assert: 解析できないフィールドは null
    for (const candidate of [empty, broken]) {
      expect(candidate.type).toBeNull();
      expect(candidate.foundation).toBeNull();
      expect(candidate.port).toBeNull();
    }
  });

  test.each([
    "1 1 udp nope 192.0.2.1 123 typ host",
    "1 1 udp 1 192.0.2.1 xyz typ host",
    "1 1 udp 1 192.0.2.1 70000 typ host",
    "1 1 udp 1 192.0.2.1 123 wrong relay",
    "1 1 udp 1 192.0.2.1 123 typ bogus",
    "1 1 sctp 1 192.0.2.1 123 typ host",
    "1 1 udp 1 192.0.2.1 123 typ srflx raddr 192.0.2.2 rport abc",
    "1 1 tcp 1 192.0.2.1 9 typ host tcptype bogus",
  ])(
    "syntactically or numerically invalid candidate gives all-null fields: %s",
    (sdp) => {
      // Act: 不正な a-line から生成する
      const candidate = new RTCIceCandidate({ candidate: sdp });

      // Assert: NaN や誤った type を公開せず、派生フィールドはすべて null
      expect(candidate).toMatchObject({
        foundation: null,
        component: null,
        priority: null,
        address: null,
        protocol: null,
        port: null,
        type: null,
        tcpType: null,
        relatedAddress: null,
        relatedPort: null,
      });
    },
  );

  test.each([
    "1 1 udp nope 192.0.2.1 123 typ host",
    "1 1 udp 1 192.0.2.1 123 wrong relay",
  ])(
    "fromSdp and IceCandidate.fromJSON().toJSON() hide invalid values: %s",
    (sdp) => {
      // Act: fromSdp と内部候補経由の両方で不正な a-line を処理する
      const viaFromSdp = RTCIceCandidate.fromSdp(sdp);
      const internal = IceCandidate.fromJSON({ candidate: sdp });

      // Assert: fromSdp は NaN や誤った type を公開せず null、内部候補は生成されない
      expect(viaFromSdp.type).toBeNull();
      expect(viaFromSdp.priority).toBeNull();
      expect(viaFromSdp.port).toBeNull();
      expect(internal).toBeUndefined();
    },
  );

  test("omitting candidate defaults it to an empty string", () => {
    // Act: candidate を省略して生成する
    const none = new RTCIceCandidate();
    const midOnly = new RTCIceCandidate({ sdpMid: "0" });

    // Assert: 型宣言どおり string で、JSON にも空文字列として残る
    for (const candidate of [none, midOnly]) {
      expect(candidate.candidate).toBe("");
      expect(candidate.toJSON().candidate).toBe("");
      expect(JSON.parse(JSON.stringify(candidate)).candidate).toBe("");
      expect(candidate.type).toBeNull();
    }
  });

  test("IceCandidate.toJSON carries the parsed fields and toJSON keeps the signaling shape", () => {
    // Arrange: 内部表現の relay candidate
    const ice = IceCandidate.fromJSON({ candidate: relay, sdpMid: "1" })!;

    // Act: 公開 API の RTCIceCandidate に変換し、さらにシグナリング用 JSON にする
    const candidate = ice.toJSON();
    const json = JSON.parse(JSON.stringify(candidate));

    // Assert: 解析済みフィールドを持ち、JSON はシグナリング用の 4 項目のみ
    expect(candidate).toBeInstanceOf(RTCIceCandidate);
    expect(candidate.type).toBe("relay");
    expect(candidate.component).toBe("rtcp");
    expect(Object.keys(json).sort()).toEqual(["candidate", "sdpMid"].sort());
    expect(json.candidate).toBe(relay);
  });

  test("getSelectedCandidatePair returns candidates whose type is inspectable", async () => {
    // Arrange: ローカルで接続した ICE transport のペア
    const [transport1, transport2] = await iceTransportPair();
    try {
      // Act: 選択された candidate pair とローカル/リモート候補を取得する
      const pair = transport1.getSelectedCandidatePair();
      const locals = transport1.getLocalCandidates();
      const remotes = transport1.getRemoteCandidates();

      // Assert: 文字列を解析せずに type / address / port を参照できる
      expect(pair).not.toBeNull();
      for (const candidate of [pair!.local, pair!.remote]) {
        expect(candidate.type).toBe("host");
        expect(candidate.protocol).toBe("udp");
        expect(candidate.component).toBe("rtp");
        expect(candidate.candidate).toContain(
          `${candidate.address} ${candidate.port} typ ${candidate.type}`,
        );
      }
      expect(locals.every((candidate) => candidate.type !== null)).toBe(true);
      expect(remotes.every((candidate) => candidate.type !== null)).toBe(true);
    } finally {
      await Promise.all([transport1.stop(), transport2.stop()]);
    }
  });
});
