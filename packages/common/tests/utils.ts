import * as dgram from "node:dgram";
import * as net from "node:net";
import { binaryData, FifoQueue } from "../src";
import { UdpTransport } from "../src/transport";

/** loopback に bind 済みの UdpTransport を生成する。 */
export function createLoopbackUdpTransport(
  options: { port?: number; portRange?: [number, number] } = {},
) {
  return UdpTransport.init("udp4", {
    ...options,
    interfaceAddresses: { udp4: "127.0.0.1" },
  });
}

/** 127.0.0.1 のポートを占有する dgram socket を生成する。 */
export async function occupyUdpPort() {
  const socket = dgram.createSocket("udp4");
  await new Promise<void>((resolve) =>
    socket.bind({ port: 0, address: "127.0.0.1" }, resolve),
  );
  return {
    socket,
    port: socket.address().port,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
}

/**
 * Bun が ICMP port unreachable を受けたときに socket の error として出す
 * `recvmsg ECONNREFUSED` 相当のエラーを生成する。
 */
export function createRecvmsgConnRefusedError() {
  return Object.assign(new Error("recvmsg ECONNREFUSED"), {
    code: "ECONNREFUSED",
    errno: -111,
    syscall: "recvmsg",
  });
}

/** UdpTransport の受信データを最初の 1 件だけ待つ Promise を返す。 */
export function waitForUdpData(transport: UdpTransport) {
  return new Promise<Buffer>((resolve) => {
    transport.onData = (data) => resolve(data);
  });
}

export async function createHangingStreamServer() {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as net.AddressInfo;

  return {
    address: [address.address, address.port] as [string, number],
    sockets,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/**
 * binaryData の encode / decode テスト用に、werift (dtls) で使う型を
 * 一通り含むスキーマとサンプル値を生成する。
 */
export function createBinaryDataFixture() {
  const {
    uint8,
    uint16be,
    uint24be,
    uint32be,
    uint48be,
    buffer,
    array,
    string,
  } = binaryData.types;

  const spec = {
    u8: uint8,
    u16: uint16be,
    u24: uint24be,
    u32: uint32be,
    u48: uint48be,
    version: { major: uint8, minor: uint8 },
    fixed: buffer(4),
    prefixed: buffer(uint16be),
    len: uint8,
    dynamic: buffer((ctx) => ctx.current.len),
    list: array({ type: uint16be, data: buffer(uint16be) }, uint16be, "bytes"),
    nums: array(uint16be, uint8, "bytes"),
    certs: array(buffer(uint24be), uint24be, "bytes"),
    names: array(string(uint16be), uint16be, "bytes"),
  };

  const value: binaryData.Decoded<typeof spec> = {
    u8: 0xfe,
    u16: 0xbeef,
    u24: 0xabcdef,
    u32: 0xdeadbeef,
    u48: 0x123456789abc,
    version: { major: 254, minor: 253 },
    fixed: Buffer.from([1, 2, 3, 4]),
    prefixed: Buffer.from([5, 6, 7]),
    len: 2,
    dynamic: Buffer.from([8, 9]),
    list: [
      { type: 10, data: Buffer.from([0xaa]) },
      { type: 65281, data: Buffer.alloc(0) },
    ],
    nums: [29, 23, 24],
    certs: [Buffer.from([0x30, 0x82]), Buffer.from([0x01])],
    names: ["CN=a", ""],
  };

  /** 移植前の @shinyoshiaki/binary-data@0.6.1 で value を encode した結果 */
  const legacyEncoded = Buffer.from(
    "febeefabcdefdeadbeef123456789abcfefd0102030400030506070208090009000a0001aaff01000006001d0017001800000900000230820000010100080004434e3d610000",
    "hex",
  );

  return { spec, value, legacyEncoded };
}

/** 0..count-1 を順に積んだ FifoQueue を生成する。 */
export function createFilledQueue(count: number) {
  return new FifoQueue<number>([...Array(count).keys()]);
}
