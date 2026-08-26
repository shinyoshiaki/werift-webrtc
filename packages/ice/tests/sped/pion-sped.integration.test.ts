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
import { getRawAttributeValue } from "../../src/stun/rawAttributeValue";
import { resolvePionSpedBin as resolvePionSpedBinFromInput } from "./resolve-pion-sped-bin";

const toolDir = join(process.cwd(), "tools/pion-sped");
const localBin = join(toolDir, "pion-sped");

function pionSpedIsCompatible(path: string): boolean {
  if (!existsSync(path)) {
    return false;
  }
  try {
    const version = execFileSync(path, ["version"], { encoding: "utf8" });
    if (version.includes("verify") && version.includes("empty-ack")) {
      return true;
    }
  } catch {
    // fall through to usage probe
  }
  try {
    execFileSync(path, [], { encoding: "utf8" });
    return false;
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    const text = `${err.stderr ?? ""}${err.stdout ?? ""}`;
    return text.includes("verify") && text.includes("empty-ack");
  }
}

function tryBuildLocalPionSped(): boolean {
  try {
    execFileSync("go", ["build", "-o", localBin, "."], {
      cwd: toolDir,
      stdio: "pipe",
    });
    return pionSpedIsCompatible(localBin);
  } catch {
    return false;
  }
}

function resolvePionSpedBin(): string | undefined {
  return resolvePionSpedBinFromInput({
    override: process.env.WERIFT_PION_SPED,
    required: process.env.WERIFT_PION_SPED_REQUIRED === "1",
    autoBuild: process.env.WERIFT_PION_SPED_AUTO_BUILD === "1",
    localBin,
    exists: existsSync,
    isCompatible: pionSpedIsCompatible,
    tryBuildLocal: tryBuildLocalPionSped,
  });
}

const bin = resolvePionSpedBin();
const describePion = bin ? describe : describe.skip;

function pion(args: string[]) {
  if (!bin) {
    throw new Error("pion-sped binary is not available");
  }
  return execFileSync(bin, args, { encoding: "utf8" }).trim();
}

describePion("pion SPED wire codec (opt-in)", () => {
  it("opt-in した pion-sped は verify と empty-ack を持つ", () => {
    // Assert: 明示指定または AUTO_BUILD のバイナリだけを使う
    expect(bin).toBeDefined();
    expect(pionSpedIsCompatible(bin!)).toBe(true);
  });

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
      getRawAttributeValue(parsed!, DTLS_IN_STUN_DATA)?.toString("hex"),
    ).toBe("1601");
  });

  it("ACK 0/1/4 を双方向で一致させる", () => {
    const cases: { crcs: number[]; ackFlag?: string; emptyAck?: boolean }[] = [
      { crcs: [], emptyAck: true },
      { crcs: [0x11111111], ackFlag: "11111111" },
      { crcs: [1, 2, 3, 4], ackFlag: "00000001,00000002,00000003,00000004" },
    ];
    for (const { crcs, ackFlag, emptyAck } of cases) {
      // Arrange: werift → pion
      const msg = new Message(methods.BINDING, classes.REQUEST);
      msg.appendRawAttribute(DTLS_IN_STUN_ACK, encodeSpedAck(crcs).value);

      // Act
      const fromWerift = pion(["decode", msg.bytes.toString("hex")]);
      const fromPion = emptyAck
        ? pion(["encode", "-empty-ack"])
        : pion(["encode", "-ack", ackFlag!]);
      const parsed = parseMessage(Buffer.from(fromPion, "hex"));

      // Assert
      expect(fromWerift).toMatch(/type=0xC071/i);
      if (crcs.length === 0) {
        expect(fromWerift).toMatch(/len=0/);
        expect(getRawAttributeValue(parsed!, DTLS_IN_STUN_ACK)?.length).toBe(0);
        expect(
          getRawAttributeValue(parsed!, DTLS_IN_STUN_DATA),
        ).toBeUndefined();
      } else {
        const ack = getRawAttributeValue(parsed!, DTLS_IN_STUN_ACK);
        expect(ack?.length).toBe(crcs.length * 4);
        for (let i = 0; i < crcs.length; i++) {
          expect(ack!.readUInt32BE(i * 4)).toBe(crcs[i]);
        }
      }
    }
  });

  it("MESSAGE-INTEGRITY 境界を pion HMAC-SHA1 と相互検証する", () => {
    // Arrange: DATA を MI より前に置き pion / werift 双方で HMAC
    const password = "short-term-pass";
    const msg = new Message(methods.BINDING, classes.REQUEST);
    msg
      .setAttribute("USERNAME", "a:b")
      .appendRawAttribute(
        DTLS_IN_STUN_DATA,
        encodeSpedData(Buffer.from([22, 1])).value,
      )
      .addMessageIntegrity(Buffer.from(password))
      .addFingerprint();

    // Act: pion は werift 署名を HMAC-SHA1 で検証し、werift は pion 署名を検証する
    const verified = pion([
      "verify",
      "-integrity-key",
      password,
      msg.bytes.toString("hex"),
    ]);
    expect(() =>
      pion([
        "verify",
        "-integrity-key",
        "wrong-password",
        msg.bytes.toString("hex"),
      ]),
    ).toThrow();
    const fromPion = pion([
      "encode",
      "-data",
      "1601",
      "-integrity-key",
      password,
    ]);
    const parsedOk = parseMessage(
      Buffer.from(fromPion, "hex"),
      Buffer.from(password),
    );
    const parsedBad = parseMessage(
      Buffer.from(fromPion, "hex"),
      Buffer.from("wrong-password"),
    );

    // Assert: 両方向の正しい鍵だけが通り、誤鍵は失敗する
    expect(verified).toMatch(/MESSAGE-INTEGRITY OK/);
    expect(parsedOk).toBeDefined();
    expect(
      getRawAttributeValue(parsedOk!, DTLS_IN_STUN_DATA)?.toString("hex"),
    ).toBe("1601");
    expect(parsedBad).toBeUndefined();
  });
});
