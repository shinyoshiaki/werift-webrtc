import {
  IceCandidate,
  RTCIceCandidate,
  type RTCIceCandidateFields,
  type RTCIceCandidateInit,
} from "../../src";
import { iceTransportPair } from "../fixture";
import {
  allNull,
  type CandidatePath,
  candidates,
  candidateVia,
  fieldsOf,
  peerWithRemoteOffer,
} from "./iceCandidateUtils";

const allPaths: CandidatePath[] = [
  "constructor",
  "fromSdp",
  "fromJSON",
  "transport",
];
const foundation32 = "a".repeat(32);
const mdns = "3f8a1c2e-1b2c-4d5e-9f00-123456789abc.local";

/** Valid candidates: every path exposes the same expected fields. */
const valid: { name: string; sdp: string; expected: RTCIceCandidateFields }[] =
  [
    {
      name: "host",
      sdp: candidates.host,
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
      name: "srflx with related address / port",
      sdp: candidates.srflx,
      expected: {
        ...allNull,
        foundation: "2",
        component: "rtp",
        priority: 1694498815,
        address: "203.0.113.5",
        protocol: "udp",
        port: 61000,
        type: "srflx",
        relatedAddress: "192.168.1.10",
        relatedPort: 50000,
      },
    },
    {
      name: "relay on the rtcp component",
      sdp: candidates.relay,
      expected: {
        ...allNull,
        foundation: "3",
        component: "rtcp",
        priority: 16777215,
        address: "198.51.100.7",
        protocol: "udp",
        port: 3478,
        type: "relay",
        relatedAddress: "203.0.113.5",
        relatedPort: 61000,
      },
    },
    {
      name: "prflx",
      sdp: "5 1 udp 1845501695 203.0.113.9 40000 typ prflx raddr 192.168.1.10 rport 50000",
      expected: {
        ...allNull,
        foundation: "5",
        component: "rtp",
        priority: 1845501695,
        address: "203.0.113.9",
        protocol: "udp",
        port: 40000,
        type: "prflx",
        relatedAddress: "192.168.1.10",
        relatedPort: 50000,
      },
    },
    {
      name: "TCP with tcptype",
      sdp: candidates.tcp,
      expected: {
        ...allNull,
        foundation: "4",
        component: "rtp",
        priority: 1518280447,
        address: "192.168.1.10",
        protocol: "tcp",
        port: 9,
        type: "host",
        tcpType: "active",
      },
    },
    {
      name: "candidate: prefix is removed once",
      sdp: `candidate:${candidates.host}`,
      expected: {
        ...allNull,
        foundation: "1",
        component: "rtp",
        priority: 2130706431,
        address: "192.168.1.10",
        protocol: "udp",
        port: 50000,
        type: "host",
      },
    },
    {
      name: "Chrome mDNS host with network-id / network-cost",
      sdp: `candidate:842163049 1 udp 2122260223 ${mdns} 54321 typ host generation 0 ufrag Ab+/ network-id 1 network-cost 10`,
      expected: {
        ...allNull,
        foundation: "842163049",
        component: "rtp",
        priority: 2122260223,
        address: mdns,
        protocol: "udp",
        port: 54321,
        type: "host",
      },
    },
    {
      name: "Chrome TCP passive on port 9",
      sdp: "candidate:1840965416 1 tcp 1518280447 192.168.1.2 9 typ host tcptype passive generation 0 network-id 1",
      expected: {
        ...allNull,
        foundation: "1840965416",
        component: "rtp",
        priority: 1518280447,
        address: "192.168.1.2",
        protocol: "tcp",
        port: 9,
        type: "host",
        tcpType: "passive",
      },
    },
    {
      name: "Firefox uppercase UDP relay with raddr 0.0.0.0 rport 0",
      sdp: "candidate:3 1 UDP 92216831 198.51.100.7 61893 typ relay raddr 0.0.0.0 rport 0",
      expected: {
        ...allNull,
        foundation: "3",
        component: "rtp",
        priority: 92216831,
        address: "198.51.100.7",
        protocol: "udp",
        port: 61893,
        type: "relay",
        relatedAddress: "0.0.0.0",
        relatedPort: 0,
      },
    },
    {
      name: "IPv6 host",
      sdp: "1 1 udp 2130706431 2001:db8::1 50000 typ host",
      expected: {
        ...allNull,
        foundation: "1",
        component: "rtp",
        priority: 2130706431,
        address: "2001:db8::1",
        protocol: "udp",
        port: 50000,
        type: "host",
      },
    },
    {
      name: "boundary values (32-char foundation, priority 1, port 0)",
      sdp: `${foundation32} 2 udp 1 192.0.2.1 0 typ host`,
      expected: {
        ...allNull,
        foundation: foundation32,
        component: "rtcp",
        priority: 1,
        address: "192.0.2.1",
        protocol: "udp",
        port: 0,
        type: "host",
      },
    },
    {
      name: "boundary values (priority 2^31-1, port 65535)",
      sdp: "a+/9 1 udp 2147483647 192.0.2.1 65535 typ host",
      expected: {
        ...allNull,
        foundation: "a+/9",
        component: "rtp",
        priority: 2147483647,
        address: "192.0.2.1",
        protocol: "udp",
        port: 65535,
        type: "host",
      },
    },
    {
      name: "tcptype on a UDP candidate only nulls tcpType",
      sdp: "1 1 udp 1 192.0.2.1 123 typ host tcptype active",
      expected: {
        ...allNull,
        foundation: "1",
        component: "rtp",
        priority: 1,
        address: "192.0.2.1",
        protocol: "udp",
        port: 123,
        type: "host",
      },
    },
  ];

/** Valid RFC 8839 but not representable by the W3C attributes: all null, still accepted by ICE. */
const unrepresentable = [
  "1 3 udp 1 192.0.2.1 123 typ host",
  "1 256 udp 1 192.0.2.1 123 typ host",
  "1 1 sctp 1 192.0.2.1 123 typ host",
  "1 1 udp 1 192.0.2.1 123 typ bogus",
];

/**
 * Grammar violations: all null and rejected by `IceCandidate.fromJSON()`.
 * `typed` marks the cases also visible in the typed values the ICE layer's
 * own parser produces (the `transport` path).
 */
const invalid: { sdp: string; typed: boolean }[] = [
  { sdp: "", typed: false },
  { sdp: "garbage", typed: false },
  { sdp: "! 1 udp 1 192.0.2.1 123 typ host", typed: true },
  { sdp: `${foundation32}a 1 udp 1 192.0.2.1 123 typ host`, typed: true },
  { sdp: `candidate:candidate:${candidates.host}`, typed: true },
  { sdp: "1 0 udp 1 192.0.2.1 123 typ host", typed: true },
  { sdp: "1 257 udp 1 192.0.2.1 123 typ host", typed: true },
  { sdp: "1 1 udp 0 192.0.2.1 123 typ host", typed: true },
  { sdp: "1 1 udp 2147483648 192.0.2.1 123 typ host", typed: true },
  { sdp: "1 1 udp nope 192.0.2.1 123 typ host", typed: true },
  { sdp: "1 1 udp 1 !!!@@ 123 typ host", typed: true },
  { sdp: "1 1 udp 1 999.1.1.1 123 typ host", typed: true },
  { sdp: "1 1 udp 1 192.0.2.1 xyz typ host", typed: true },
  { sdp: "1 1 udp 1 192.0.2.1 70000 typ host", typed: true },
  { sdp: "1 1 udp 1 192.0.2.1 123 wrong relay", typed: false },
  { sdp: "1 1 udp 1 192.0.2.1 123 typ srflx raddr !!! rport 1", typed: true },
  {
    sdp: "1 1 udp 1 192.0.2.1 123 typ srflx raddr 192.0.2.2 rport abc",
    typed: true,
  },
  { sdp: "1 1 tcp 1 192.0.2.1 9 typ host tcptype bogus", typed: true },
  { sdp: "1 1 udp 1 192.0.2.1 123 typ host generation x", typed: true },
  { sdp: "1 1 udp 1 192.0.2.1 123 typ host generation", typed: false },
  { sdp: "1  1 udp 1 192.0.2.1 123 typ host", typed: false },
  { sdp: " 1 1 udp 1 192.0.2.1 123 typ host", typed: false },
  { sdp: "1 1 udp 1 192.0.2.1 123 typ host ", typed: false },
  { sdp: "1 1\tudp 1 192.0.2.1 123 typ host", typed: false },
];

describe("RTCIceCandidate parsed fields", () => {
  describe.each(allPaths)("via %s", (path) => {
    test.each(valid)("valid: $name", ({ sdp, expected }) => {
      // Act: 対象の経路で a-line から RTCIceCandidate を得る
      const candidate = candidateVia(path, sdp);

      // Assert: どの経路でも同じブラウザ互換フィールドが読める
      expect(candidate).toBeInstanceOf(RTCIceCandidate);
      expect(fieldsOf(candidate!)).toEqual(expected);
    });

    test.each(unrepresentable)(
      "W3C-unrepresentable gives all-null fields: %s",
      (sdp) => {
        // Act: RFC 8839 上は有効だが W3C の列挙型に写せない a-line を処理する
        const candidate = candidateVia(path, sdp);

        // Assert: 1 つでも無効な値があれば解析を中止し、すべて null
        expect(candidate).toBeInstanceOf(RTCIceCandidate);
        expect(fieldsOf(candidate!)).toEqual(allNull);
      },
    );
  });

  describe.each(["constructor", "fromSdp"] as const)("via %s", (path) => {
    test.each(invalid)(
      "grammar violation gives all-null fields: '$sdp'",
      ({ sdp }) => {
        // Act: 文法違反の a-line から生成する
        const candidate = candidateVia(path, sdp)!;

        // Assert: 派生フィールドはすべて null、candidate 文字列は入力のまま
        expect(fieldsOf(candidate)).toEqual(allNull);
        expect(candidate.candidate).toBe(sdp);
      },
    );
  });

  test.each(invalid)(
    "IceCandidate.fromJSON rejects a grammar violation: '$sdp'",
    ({ sdp }) => {
      // Act: addIceCandidate と同じ内部変換に渡す
      const internal = IceCandidate.fromJSON({ candidate: sdp, sdpMid: "0" });

      // Assert: 内部候補は生成されない
      expect(internal).toBeUndefined();
    },
  );

  test.each(invalid.filter(({ typed }) => typed))(
    "the transport conversion validates typed values: '$sdp'",
    ({ sdp }) => {
      // Act: ICE 層の緩いパーサーが作った値を公開 API に変換する
      const candidate = candidateVia("transport", sdp)!;

      // Assert: 型付きの値を同じ要素検証器で確かめ、無効ならすべて null
      expect(fieldsOf(candidate)).toEqual(allNull);
    },
  );

  test("IceCandidate.fromJSON keeps RFC-valid candidates werift accepted before", () => {
    // Act: W3C 属性には写せないが文法上は有効な候補を内部表現にする
    const internal = IceCandidate.fromJSON({
      candidate: unrepresentable[0],
      sdpMid: "0",
    });

    // Assert: ICE 層には渡り、component はそのまま保持される
    expect(internal?.component).toBe(3);
  });

  test("the constructor reads only RTCIceCandidateInit members", () => {
    // Arrange: 派生フィールドを混ぜた init (ブラウザの RTCIceCandidateInit には存在しない)
    const injected = { type: "relay", port: 1, foundation: "x" };

    // Act: 有効・不正な candidate と一緒に渡して生成する
    const withValid = new RTCIceCandidate({
      candidate: candidates.host,
      ...injected,
    } as RTCIceCandidateInit);
    const withInvalid = new RTCIceCandidate({
      candidate: "garbage",
      ...injected,
    } as RTCIceCandidateInit);

    // Assert: 派生フィールドは常に candidate から解析した値になる
    expect(withValid).toMatchObject({ type: "host", port: 50000 });
    expect(withValid.foundation).toBe("1");
    expect(fieldsOf(withInvalid)).toEqual(allNull);
  });

  test("omitting candidate defaults it to an empty string", () => {
    // Act: candidate を省略して生成する
    const none = new RTCIceCandidate();
    const midOnly = new RTCIceCandidate({ sdpMid: "0" });

    // Assert: 型宣言どおり string で、JSON にも空文字列として残る
    for (const candidate of [none, midOnly]) {
      expect(candidate.candidate).toBe("");
      expect(candidate.toJSON().candidate).toBe("");
      expect(JSON.parse(JSON.stringify(candidate)).candidate).toBe("");
      expect(fieldsOf(candidate)).toEqual(allNull);
    }
  });

  test("IceCandidate.toJSON carries the parsed fields and toJSON keeps the signaling shape", () => {
    // Arrange: 内部表現の relay candidate
    const ice = IceCandidate.fromJSON({
      candidate: candidates.relay,
      sdpMid: "1",
    })!;

    // Act: 公開 API の RTCIceCandidate に変換し、さらにシグナリング用 JSON にする
    const candidate = ice.toJSON();
    const json = JSON.parse(JSON.stringify(candidate));

    // Assert: 解析済みフィールドを持ち、JSON はシグナリング用の項目のみ
    expect(candidate.type).toBe("relay");
    expect(Object.keys(json).sort()).toEqual(["candidate", "sdpMid"]);
    expect(json.candidate).toBe(candidates.relay);
  });

  test("addIceCandidate rejects a grammar violation and accepts browser candidates", async () => {
    // Arrange: リモート offer を適用済みのピア
    const { answerer, close } = await peerWithRemoteOffer();
    try {
      // Act: 文法違反の候補と、Chrome / Firefox 形式の候補を追加する
      const rejected = answerer.addIceCandidate({
        candidate: "candidate:! 1 udp 1 192.0.2.1 123 typ host",
        sdpMid: "0",
      });
      const accepted = valid
        .filter(({ name }) => /Chrome|Firefox/.test(name))
        // ufrag はこのセッションの値と一致しないため除いて追加する
        .map(({ sdp }) => sdp.replace(/ ufrag \S+/, ""))
        .map((sdp) =>
          answerer.addIceCandidate({ candidate: sdp, sdpMid: "0" }),
        );

      // Assert: 不正な候補は OperationError、ブラウザの候補は受理される
      await expect(rejected).rejects.toMatchObject({ name: "OperationError" });
      await expect(Promise.all(accepted)).resolves.toBeDefined();
    } finally {
      await close();
    }
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
