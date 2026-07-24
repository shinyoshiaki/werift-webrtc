import {
  bufferToIpAddress,
  ipAddressToBuffer,
} from "../../../ice-server/src/stun/ip";
import {
  ATTRIBUTES_BY_NAME,
  packErrorCode,
  packXorAddress,
  unpackErrorCode,
  unpackXorAddress,
} from "../../src/stun/attributes";

describe("stun", () => {
  test("test_unpack_error_code", () => {
    const data = Buffer.from("00000457526f6c6520436f6e666c696374", "hex");
    const [code, reason] = unpackErrorCode(data);
    expect(code).toBe(487);
    expect(reason).toBe("Role Conflict");
  });

  test("test_unpack_error_code_too_short", () => {
    const data = Buffer.from("000004", "hex");
    try {
      unpackErrorCode(data);
    } catch (error) {
      expect((error as Error).message).toBe(
        "STUN error code is less than 4 bytes",
      );
    }
  });

  test("test_unpack_xor_address_ipv4", () => {
    const transactionId = Buffer.from("b7e7a701bc34d686fa87dfae", "hex");
    const [address, port] = unpackXorAddress(
      Buffer.from("0001a147e112a643", "hex"),
      transactionId,
    );
    expect(address).toBe("192.0.2.1");
    expect(port).toBe(32853);
  });

  test("test_unpack_xor_address_ipv4_truncated", () => {
    const transactionId = Buffer.from("b7e7a701bc34d686fa87dfae", "hex");
    try {
      unpackXorAddress(Buffer.from("0001a147e112a6", "hex"), transactionId);
    } catch (error) {
      expect((error as Error).message).toBe(
        "STUN address has invalid length for IPv4",
      );
    }
  });

  test("test_unpack_xor_address_ipv6", () => {
    const transactionId = Buffer.from("b7e7a701bc34d686fa87dfae", "hex");
    const [address, port] = unpackXorAddress(
      Buffer.from("0002a1470113a9faa5d3f179bc25f4b5bed2b9d9", "hex"),
      transactionId,
    );
    expect(address).toBe("2001:db8:1234:5678:11:2233:4455:6677");
    expect(port).toBe(32853);
  });

  test("test_unpack_xor_address_ipv6_truncated", () => {
    const transactionId = Buffer.from("b7e7a701bc34d686fa87dfae", "hex");
    try {
      unpackXorAddress(
        Buffer.from("0002a1470113a9faa5d3f179bc25f4b5bed2b9", "hex"),
        transactionId,
      );
    } catch (error) {
      expect((error as Error).message).toBe(
        "STUN address has invalid length for IPv6",
      );
    }
  });

  test("test_unpack_xor_address_too_short", () => {
    const transactionId = Buffer.from("b7e7a701bc34d686fa87dfae", "hex");
    try {
      unpackXorAddress(Buffer.from("0001", "hex"), transactionId);
    } catch (error) {
      expect((error as Error).message).toBe(
        "STUN address length is less than 4 bytes",
      );
    }
  });

  test("test_unpack_xor_address_unknown_protocol", () => {
    const transactionId = Buffer.from("b7e7a701bc34d686fa87dfae", "hex");
    try {
      unpackXorAddress(Buffer.from("0003a147e112a643", "hex"), transactionId);
    } catch (error) {
      expect((error as Error).message).toBe(
        "STUN address has unknown protocol",
      );
    }
  });

  test("test_pack_error_code", () => {
    const data = packErrorCode([487, "Role Conflict"]);
    expect(data).toEqual(
      Buffer.from("00000457526f6c6520436f6e666c696374", "hex"),
    );
  });

  test("test_pack_xor_address_ipv4", () => {
    const transactionId = Buffer.from("b7e7a701bc34d686fa87dfae", "hex");
    const data = packXorAddress(["192.0.2.1", 32853], transactionId);
    expect(data).toEqual(Buffer.from("0001a147e112a643", "hex"));
  });

  test("test_pack_xor_address_ipv6", () => {
    const transactionId = Buffer.from("b7e7a701bc34d686fa87dfae", "hex");
    const data = packXorAddress(
      ["2001:db8:1234:5678:11:2233:4455:6677", 32853],
      transactionId,
    );
    expect(data).toEqual(
      Buffer.from("0002a1470113a9faa5d3f179bc25f4b5bed2b9d9", "hex"),
    );
  });

  test.each([0n, 5943294521425135761n, 2n ** 64n - 1n])(
    "unsigned 64-bit ICE-CONTROLLING pack/unpack %s",
    (value) => {
      // Arrange
      const [, , pack, unpack] = ATTRIBUTES_BY_NAME["ICE-CONTROLLING"];

      // Act: unsigned 64 bit を encode / decode する
      const encoded = pack(value);
      const decoded = unpack(encoded);

      // Assert: 全域の値が往復すること
      expect(encoded.length).toBe(8);
      expect(decoded).toBe(value);
    },
  );

  test.each([
    "192.0.2.1",
    "::1",
    "2001:db8::1",
    "2001:db8:1234:5678:11:2233:4455:6677",
    "::ffff:192.0.2.1",
  ])("ip address binary round-trip %s", (address) => {
    // Act: text → binary → text → binary
    const binary = ipAddressToBuffer(address);
    const text = bufferToIpAddress(binary);
    const binaryAgain = ipAddressToBuffer(text);

    // Assert: 文字列表現が異なっても binary は同一であること
    expect(binaryAgain.equals(binary)).toBe(true);
    expect(binary.length === 4 || binary.length === 16).toBe(true);
  });
});
