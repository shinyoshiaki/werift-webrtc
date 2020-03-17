import {
  parsePacket,
  serializePacket,
  InitChunk,
  CookieEchoChunk,
  AbortChunk,
  DataChunk,
  ErrorChunk,
  ForwardTsnChunk,
  HeartbeatChunk,
  ReConfigChunk
} from "../../../../src/rtc/transport/sctp/chunk";
import {
  StreamResetOutgoingParam,
  StreamAddOutgoingParam
} from "../../../../src/rtc/transport/sctp/param";
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

  test("test_parse_data_padding", () => {
    const data = load("sctp_data_padding.bin");
    const chunk = roundtripPacket(data) as DataChunk;

    expect(chunk.type).toBe(DataChunk.type);
    expect(chunk.type).toBe(0);
    expect(chunk.flags).toBe(3);
    expect(chunk.tsn).toBe(2584679421);
    expect(chunk.streamId).toBe(1);
    expect(chunk.streamSeq).toBe(1);
    expect(chunk.protocol).toBe(51);
    expect(chunk.userData).toEqual(Buffer.from("M"));
  });

  test("test_parse_error", () => {
    const data = load("sctp_error.bin");
    const chunk = roundtripPacket(data) as ErrorChunk;

    expect(chunk.type).toBe(ErrorChunk.type);
    expect(chunk.type).toBe(9);
    expect(chunk.flags).toBe(0);
    expect(chunk.params).toEqual([[1, Buffer.from("\x30\x39\x00\x00")]]);
  });

  test("test_parse_forward_tsn", () => {
    const data = load("sctp_forward_tsn.bin");
    const chunk = roundtripPacket(data) as ForwardTsnChunk;

    expect(chunk.type).toBe(ForwardTsnChunk.type);
    expect(chunk.type).toBe(192);
    expect(chunk.flags).toBe(0);
    expect(chunk.cumulativeTsn).toBe(1234);
    expect(chunk.streams).toEqual([[12, 34]]);
  });

  test("test_parse_heartbeat", () => {
    const data = load("sctp_heartbeat.bin");
    const chunk = roundtripPacket(data) as HeartbeatChunk;

    expect(chunk.type).toBe(HeartbeatChunk.type);
    expect(chunk.type).toBe(4);
    expect(chunk.flags).toBe(0);
    // expect(chunk.params).toEqual([
    //   [
    //     1,
    //     Buffer.from(
    //       "\xb5o\xaaZvZ\x06\x00\x00\x00\x00\x00\x00\x00\x00\x00{\x10\x00\x00\x004\xeb\x07F\x10\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"
    //     )
    //   ]
    // ]);
  });

  test("test_parse_reconfig_reset_out", () => {
    const data = load("sctp_reconfig_reset_out.bin");
    const chunk = roundtripPacket(data) as ReConfigChunk;

    expect(chunk.type).toBe(ReConfigChunk.type);
    expect(chunk.type).toBe(130);
    expect(chunk.flags).toBe(0);
    // expect(chunk.params).toEqual([
    //   [13, Buffer.from("\x8b\xd8\n[\xe4\x8b\xecs\x8b\xd8\n^\x00\x01")]
    // ]);

    const paramData = chunk.params[0][1];
    const param = StreamResetOutgoingParam.parse(paramData);
    expect(param.requestSequence).toBe(2346191451);
    expect(param.responseSequence).toBe(3834375283);
    expect(param.lastTsn).toBe(2346191454);
    expect(param.streams).toEqual([1]);
    expect(param.bytes).toEqual(paramData);
  });

  test("test_parse_reconfig_add_out", () => {
    const data = load("sctp_reconfig_add_out.bin");
    const chunk = roundtripPacket(data) as ReConfigChunk;

    expect(chunk.type).toBe(ReConfigChunk.type);
    expect(chunk.type).toBe(130);
    expect(chunk.flags).toBe(0);
    // expect(chunk.params).toEqual([
    //   [17, Buffer.from("\xca\x02\xf60\x00\x10\x00\x00")]
    // ]);

    const paramData = chunk.params[0][1];
    const param = StreamAddOutgoingParam.parse(paramData);
    expect(param.requestSequence).toBe(3389191728);
    expect(param.newStreams).toBe(16);
    expect(param.bytes).toEqual(paramData);
  });
});
