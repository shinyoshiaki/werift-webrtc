import {
  parsePacket,
  serializePacket,
  InitChunk,
  CookieEchoChunk,
  AbortChunk,
  DataChunk
} from "../../../../src/rtc/transport/sctp/chunk";
import { load } from "../../../utils";

describe("SctpPacketTest", () => {
  const roundtripPacket = (data: Buffer) => {
    const [sourcePort, destinationPort, verificationTag, chunks] = parsePacket(
      data
    );
    expect(sourcePort).toBe(5000);
    expect(destinationPort).toBe(5000);
    expect(chunks.length).toBe(1);
    const output = serializePacket(
      sourcePort,
      destinationPort,
      verificationTag,
      chunks[0]
    );
    expect(output).toEqual(data);
    return chunks[0];
  };

  test("test_parse_init", () => {
    const data = load("sctp_init.bin");
    const chunk = roundtripPacket(data);

    expect(chunk.type).toBe(InitChunk.type);
    expect(chunk.type).toBe(1);
    expect(chunk.flags).toBe(0);
    expect(chunk.body!.length).toBe(82);
  });

  test("test_parse_init_invalid_checksum", () => {
    let data = load("sctp_init.bin");
    data = Buffer.concat([
      data.slice(0, 8),
      Buffer.from("\x01\x02\x03\x04"),
      data.slice(12)
    ]);
    try {
      roundtripPacket(data);
    } catch (error) {
      expect(error.message).toBe("SCTP packet has invalid checksum");
    }
  });

  test("test_parse_init_truncated_packet_header", () => {
    let data = load("sctp_init.bin").slice(0, 10);
    try {
      roundtripPacket(data);
    } catch (error) {
      expect(error.message).toBe("SCTP packet length is less than 12 bytes");
    }
  });

  test("test_parse_cookie_echo", () => {
    let data = load("sctp_cookie_echo.bin");
    const chunk = roundtripPacket(data);

    expect(chunk.type).toBe(CookieEchoChunk.type);
    expect(chunk.type).toBe(10);
    expect(chunk.flags).toBe(0);
    expect(chunk.body!.length).toBe(8);
  });

  test("test_parse_abort", () => {
    const data = load("sctp_abort.bin");
    const chunk = roundtripPacket(data) as AbortChunk;

    expect(chunk.type).toBe(AbortChunk.type);
    expect(chunk.type).toBe(6);
    expect(chunk.flags).toBe(0);
    expect(chunk.params).toEqual([
      [13, Buffer.from("Expected B-bit for TSN=4ce1f17f, SID=0001, SSN=0000")]
    ]);
  });

  test("test_parse_data", () => {
    const data = load("sctp_data.bin");
    const chunk = roundtripPacket(data) as DataChunk;

    expect(chunk.type).toBe(DataChunk.type);
    expect(chunk.type).toBe(0);
    expect(chunk.flags).toBe(3);
    expect(chunk.tsn).toBe(2584679421);
    expect(chunk.streamId).toBe(1);
    expect(chunk.streamSeq).toBe(1);
    expect(chunk.protocol).toBe(51);
    expect(chunk.userData).toEqual(Buffer.from("ping"));
  });
});
