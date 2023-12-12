import { RtcpReceiverInfo, RtcpRrPacket } from "../../src/rtcp/rr";
import { RtcpPacketConverter } from "../../src/rtcp/rtcp";
import { Config } from "../../src/srtp/session";
import { SrtcpSession } from "../../src/srtp/srtcp";
import { Transport } from "../../src/transport";
import { createMockTransportPair } from "../utils";

function buildSessionSRTCPPair(): [
  { session: SrtcpSession; transport: Transport },
  { session: SrtcpSession; transport: Transport },
] {
  const config: Config = {
    profile: 0x0001,
    keys: {
      localMasterKey: Buffer.from([
        0xe1, 0xf9, 0x7a, 0x0d, 0x3e, 0x01, 0x8b, 0xe0, 0xd6, 0x4f, 0xa3, 0x2c,
        0x06, 0xde, 0x41, 0x39,
      ]),
      localMasterSalt: Buffer.from([
        0x0e, 0xc6, 0x75, 0xad, 0x49, 0x8a, 0xfe, 0xeb, 0xb6, 0x96, 0x0b, 0x3a,
        0xab, 0xe6,
      ]),
      remoteMasterKey: Buffer.from([
        0xe1, 0xf9, 0x7a, 0x0d, 0x3e, 0x01, 0x8b, 0xe0, 0xd6, 0x4f, 0xa3, 0x2c,
        0x06, 0xde, 0x41, 0x39,
      ]),
      remoteMasterSalt: Buffer.from([
        0x0e, 0xc6, 0x75, 0xad, 0x49, 0x8a, 0xfe, 0xeb, 0xb6, 0x96, 0x0b, 0x3a,
        0xab, 0xe6,
      ]),
    },
  };
  const [a, b] = createMockTransportPair();
  const aSession = new SrtcpSession(config);
  const bSession = new SrtcpSession(config);

  return [
    { session: aSession, transport: a },
    { session: bSession, transport: b },
  ];
}

describe("srtcp", () => {
  test("TestSessionSRTCP", () => {
    const testPayload = new RtcpRrPacket({
      ssrc: 5000,
      reports: [new RtcpReceiverInfo({ highestSequence: 3 })],
    }).serialize();
    const [aPair, bPair] = buildSessionSRTCPPair();

    bPair.transport.onData = (buf) => {
      const dec = bPair.session.decrypt(buf);
      const [rr] = RtcpPacketConverter.deSerialize(dec) as [RtcpRrPacket];
      expect(rr.type).toBe(RtcpRrPacket.type);
      expect(rr.ssrc).toBe(5000);
      expect(testPayload).toEqual(dec);
    };

    const enc = aPair.session.encrypt(testPayload);
    aPair.transport.send(enc);
  });
});
