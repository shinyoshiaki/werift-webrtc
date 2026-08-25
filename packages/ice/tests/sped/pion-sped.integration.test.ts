import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  DTLS_IN_STUN_ACK,
  DTLS_IN_STUN_DATA,
  encodeSpedAck,
  encodeSpedData,
} from "../../src/sped/draft00";
import { classes, methods } from "../../src/stun/const";
import { Message, parseMessage } from "../../src/stun/message";

const defaultBin = join(process.cwd(), "tools/pion-sped/pion-sped");
const bin = process.env.WERIFT_PION_SPED ?? defaultBin;
const describePion =
  existsSync(bin) || process.env.WERIFT_PION_SPED ? describe : describe.skip;

function pion(args: string[]) {
  return execFileSync(bin, args, { encoding: "utf8" }).trim();
}

describePion("pion SPED wire codec (opt-in)", () => {
  it("empty / non-empty DATA を pion が decode する", () => {
    // Arrange: werift が DATA を付けた Binding
    const empty = new Message(methods.BINDING, classes.REQUEST);
    empty.appendRawAttribute(
      DTLS_IN_STUN_DATA,
      encodeSpedData(Buffer.alloc(0)).value,
    );
    const hello = Buffer.from([22, 0xfe, 0xfd, 0x00, 0x01]);
    const withHello = new Message(methods.BINDING, classes.REQUEST);
    withHello.appendRawAttribute(
      DTLS_IN_STUN_DATA,
      encodeSpedData(hello).value,
    );

    // Act
    const decodedEmpty = pion(["decode", empty.bytes.toString("hex")]);
    const decodedHello = pion(["decode", withHello.bytes.toString("hex")]);

    // Assert: codepoint と value。失敗を握りつぶさない
    expect(decodedEmpty).toMatch(/type=0xC070/i);
    expect(decodedEmpty).toMatch(/len=0/);
    expect(decodedHello).toMatch(/type=0xC070/i);
    expect(decodedHello).toMatch(/value=16fefd0001/i);
  });

  it("pion が encode した DATA を werift が parse する", () => {
    // Arrange / Act
    const hex = pion(["encode", "-data", "1601"]);
    const parsed = parseMessage(Buffer.from(hex, "hex"));

    // Assert
    expect(parsed).toBeDefined();
    expect(
      parsed!.getRawAttributeValue(DTLS_IN_STUN_DATA)?.toString("hex"),
    ).toBe("1601");
  });

  it("ACK 0/1/4 を双方向で一致させる", () => {
    const cases: { crcs: number[]; ackFlag?: string }[] = [
      { crcs: [] },
      { crcs: [0x11111111], ackFlag: "11111111" },
      { crcs: [1, 2, 3, 4], ackFlag: "00000001,00000002,00000003,00000004" },
    ];
    for (const { crcs, ackFlag } of cases) {
      // Arrange: werift → pion
      const msg = new Message(methods.BINDING, classes.REQUEST);
      msg.appendRawAttribute(DTLS_IN_STUN_ACK, encodeSpedAck(crcs).value);

      // Act
      const fromWerift = pion(["decode", msg.bytes.toString("hex")]);
      const fromPion = ackFlag
        ? pion(["encode", "-ack", ackFlag])
        : pion(["encode", "-data", ""]);
      const parsed = parseMessage(Buffer.from(fromPion, "hex"));

      // Assert
      if (crcs.length === 0) {
        expect(fromWerift).toMatch(/type=0xC071/i);
        expect(fromWerift).toMatch(/len=0/);
      } else {
        expect(fromWerift).toMatch(/type=0xC071/i);
        const ack = parsed!.getRawAttributeValue(DTLS_IN_STUN_ACK);
        expect(ack?.length).toBe(crcs.length * 4);
        for (let i = 0; i < crcs.length; i++) {
          expect(ack!.readUInt32BE(i * 4)).toBe(crcs[i]);
        }
      }
    }
  });
});
