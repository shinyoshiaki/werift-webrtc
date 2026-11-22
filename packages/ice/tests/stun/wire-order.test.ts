import { classes, methods } from "../../src/stun/const";
import { Message, paddingLength, parseMessage } from "../../src/stun/message";

const DTLS_IN_STUN_DATA = 0xc070;
const DTLS_IN_STUN_ACK = 0xc071;

function attributeTypes(bytes: Buffer): number[] {
  const types: number[] = [];
  for (let pos = 20; pos + 4 <= bytes.length; ) {
    const type = bytes.readUInt16BE(pos);
    const length = bytes.readUInt16BE(pos + 2);
    types.push(type);
    pos += 4 + length + paddingLength(length);
  }
  return types;
}

describe("ICE STUN wire order (ice re-export)", () => {
  const key = Buffer.from("local-password", "utf8");

  it("DATA / ACK は MESSAGE-INTEGRITY より前、FINGERPRINT が末尾", () => {
    // Arrange
    const request = new Message(methods.BINDING, classes.REQUEST);
    request
      .setAttribute("USERNAME", "abcd:efgh")
      .setAttribute("PRIORITY", 1)
      .setAttribute("ICE-CONTROLLING", 1n);
    request.appendRawAttribute(DTLS_IN_STUN_ACK, Buffer.alloc(0));
    request.appendRawAttribute(DTLS_IN_STUN_DATA, Buffer.from([20, 1]));
    request.addMessageIntegrity(key).addFingerprint();

    // Act
    const types = attributeTypes(request.bytes);

    // Assert: RFC 8489 §9 / §14.7。ice は ice-server Message を再exportする
    expect(types.indexOf(DTLS_IN_STUN_ACK)).toBeLessThan(types.indexOf(0x0008));
    expect(types.indexOf(DTLS_IN_STUN_DATA)).toBeLessThan(
      types.indexOf(0x0008),
    );
    expect(types.at(-1)).toBe(0x8028);
  });

  it("DATA 改ざんで HMAC 検証が失敗する", () => {
    // Arrange
    const request = new Message(methods.BINDING, classes.REQUEST);
    request.setAttribute("USERNAME", "a:b");
    request.appendRawAttribute(DTLS_IN_STUN_DATA, Buffer.from([20, 9]));
    request.addMessageIntegrity(key).addFingerprint();
    const bytes = Buffer.from(request.bytes);
    const types = attributeTypes(bytes);
    const dataIndex = types.indexOf(DTLS_IN_STUN_DATA);
    let pos = 20;
    for (let i = 0; i < dataIndex; i++) {
      const length = bytes.readUInt16BE(pos + 2);
      pos += 4 + length + paddingLength(length);
    }
    bytes[pos + 4] ^= 0xff;

    // Act
    const parsed = parseMessage(bytes, key);

    // Assert
    expect(parsed).toBeUndefined();
  });
});
