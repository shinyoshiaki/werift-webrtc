import { paddingLength } from "../../../ice/src/stun/message";
import { encodeTcpFrame } from "../../../ice/src/stun/tcpFrame";
import type { Protocol } from "../../../ice/src/types/model";
import { DtlsVersion, type RTCDataChannel, RTCPeerConnection } from "../../src";
import {
  awaitMessage,
  createDataChannelPair,
  exchangeIceCandidates,
  waitForIceNominated,
} from "../utils";

const DTLS_IN_STUN_DATA = 0xc070;
const DTLS_IN_STUN_ACK = 0xc071;
const MESSAGE_INTEGRITY = 0x0008;
const FINGERPRINT = 0x8028;

const spedPeerConfig = (
  extra: { iceUseTcp?: boolean; iceLite?: boolean } = {},
) => ({
  iceServers: [] as { urls: string }[],
  sped: true,
  dtls: { protocolVersions: [DtlsVersion.V1_3] as const },
  ...extra,
});

function stunAttributeTypes(bytes: Buffer): number[] {
  const types: number[] = [];
  if (bytes.length < 20) {
    return types;
  }
  for (let pos = 20; pos + 4 <= bytes.length; ) {
    const type = bytes.readUInt16BE(pos);
    const length = bytes.readUInt16BE(pos + 2);
    types.push(type);
    pos += 4 + length + paddingLength(length);
  }
  return types;
}

function firstNonEmptySpedData(stun: Buffer[]): Buffer | undefined {
  for (const bytes of stun) {
    let pos = 20;
    while (pos + 4 <= bytes.length) {
      const type = bytes.readUInt16BE(pos);
      const length = bytes.readUInt16BE(pos + 2);
      if (type === DTLS_IN_STUN_DATA && length > 0) {
        return Buffer.from(bytes.subarray(pos + 4, pos + 4 + length));
      }
      pos += 4 + length + paddingLength(length);
    }
  }
}

function isStunBindingRequest(bytes: Buffer): boolean {
  return bytes.length >= 2 && bytes.readUInt16BE(0) === 0x0001;
}

function spyConnectionWire(
  pc: RTCPeerConnection,
  stun: Buffer[],
  handshakeDtls: Buffer[],
  options: {
    tcpFrames?: Buffer[];
    dropFirstNonEmptyData?: { remaining: number };
    duplicateFirstNonEmptyData?: { remaining: number };
    holdFirstNonEmptyData?: {
      message?: Parameters<Protocol["sendStun"]>[0];
      addr?: Parameters<Protocol["sendStun"]>[1];
    };
  } = {},
) {
  const ice = pc.iceTransports[0]?.connection as unknown as {
    protocols: Protocol[];
  };
  if (!ice) {
    return;
  }
  for (const protocol of ice.protocols) {
    const sendStun = protocol.sendStun.bind(protocol);
    const sendData = protocol.sendData.bind(protocol);
    protocol.sendStun = async (message, addr) => {
      const copy = Buffer.from(message.bytes);
      if (options.tcpFrames) {
        options.tcpFrames.push(encodeTcpFrame(copy));
      }
      const types = stunAttributeTypes(copy);
      const dataIndex = types.indexOf(DTLS_IN_STUN_DATA);
      let nonEmptyData = false;
      if (dataIndex >= 0 && message.messageClass === 0) {
        let pos = 20;
        for (let i = 0; i < types.length; i++) {
          const type = copy.readUInt16BE(pos);
          const length = copy.readUInt16BE(pos + 2);
          if (type === DTLS_IN_STUN_DATA && length > 0) {
            nonEmptyData = true;
            break;
          }
          pos += 4 + length + paddingLength(length);
        }
      }
      if (
        options.dropFirstNonEmptyData &&
        options.dropFirstNonEmptyData.remaining > 0 &&
        nonEmptyData
      ) {
        options.dropFirstNonEmptyData.remaining--;
        return;
      }
      if (
        options.holdFirstNonEmptyData &&
        !options.holdFirstNonEmptyData.message &&
        nonEmptyData
      ) {
        options.holdFirstNonEmptyData.message = message;
        options.holdFirstNonEmptyData.addr = addr;
        return;
      }
      stun.push(copy);
      await sendStun(message, addr);
      if (options.holdFirstNonEmptyData?.message && !nonEmptyData) {
        const heldMessage = options.holdFirstNonEmptyData.message;
        const heldAddr = options.holdFirstNonEmptyData.addr!;
        options.holdFirstNonEmptyData.message = undefined;
        stun.push(Buffer.from(heldMessage.bytes));
        await sendStun(heldMessage, heldAddr);
      }
      if (
        options.duplicateFirstNonEmptyData &&
        options.duplicateFirstNonEmptyData.remaining > 0 &&
        nonEmptyData
      ) {
        options.duplicateFirstNonEmptyData.remaining--;
        stun.push(copy);
        await sendStun(message, addr);
      }
    };
    protocol.sendData = async (data, addr) => {
      const copy = Buffer.from(data);
      if (copy[0] === 22) {
        handshakeDtls.push(copy);
      } else if (copy.length >= 20 && (copy[0] & 0xc0) === 0) {
        stun.push(copy);
      }
      return sendData(copy, addr);
    };
  }
}

async function openDataChannelWithWireSpy(
  pc1: RTCPeerConnection,
  pc2: RTCPeerConnection,
  stun: Buffer[],
  handshakeDtls: Buffer[],
  spyOptions?: {
    tcpFrames?: Buffer[];
    dropFirstNonEmptyData?: { remaining: number };
    duplicateFirstNonEmptyData?: { remaining: number };
    holdFirstNonEmptyData?: {
      message?: Parameters<Protocol["sendStun"]>[0];
      addr?: Parameters<Protocol["sendStun"]>[1];
    };
  },
): Promise<[RTCDataChannel, RTCDataChannel]> {
  const dc1 = pc1.createDataChannel("dc");
  const bothOpen = Promise.all([
    new Promise<void>((resolve, reject) => {
      dc1.onopen = () => resolve();
      dc1.onerror = ({ error }) => reject(error);
    }),
    new Promise<RTCDataChannel>((resolve, reject) => {
      pc2.ondatachannel = ({ channel }) => {
        channel.onopen = () => resolve(channel);
        channel.onerror = ({ error }) => reject(error);
      };
    }),
  ]);
  exchangeIceCandidates(pc1, pc2);
  await pc1.setLocalDescription(await pc1.createOffer());
  spyConnectionWire(pc1, stun, handshakeDtls, spyOptions);
  await pc2.setRemoteDescription(pc1.localDescription!);
  await pc2.setLocalDescription(await pc2.createAnswer());
  spyConnectionWire(pc2, stun, handshakeDtls, spyOptions);
  await pc1.setRemoteDescription(pc2.localDescription!);
  const [, dc2] = await bothOpen;
  return [dc1, dc2];
}

describe("RTCPeerConnection SPED opt-in", () => {
  test("既定は sped: false で clone される", () => {
    // Arrange
    const pc = new RTCPeerConnection();
    const opted = new RTCPeerConnection({
      sped: true,
      dtls: { protocolVersions: [DtlsVersion.V1_3] },
    });

    try {
      // Assert
      expect(pc.getConfiguration().sped).toBe(false);
      expect(opted.getConfiguration().sped).toBe(true);
    } finally {
      pc.close();
      opted.close();
    }
  });

  test("sped: true かつ DTLS 1.3 が無いと connect() 開始時に throw する", async () => {
    // Arrange: 未指定 / 空 / 1.2 のみ
    const unspecified = new RTCPeerConnection({ iceServers: [], sped: true });
    const empty = new RTCPeerConnection({
      iceServers: [],
      sped: true,
      dtls: { protocolVersions: [] },
    });
    const v12 = new RTCPeerConnection({
      iceServers: [],
      sped: true,
      dtls: { protocolVersions: [DtlsVersion.V1_2] },
    });

    try {
      // Act / Assert: constructor では落とさず connect() で失敗
      await expect((unspecified as any).connect()).rejects.toThrow(
        /sped requires DTLS 1.3/,
      );
      await expect((empty as any).connect()).rejects.toThrow(
        /sped requires DTLS 1.3/,
      );
      await expect((v12 as any).connect()).rejects.toThrow(
        /sped requires DTLS 1.3/,
      );
    } finally {
      unspecified.close();
      empty.close();
      v12.close();
    }
  });

  test("sped: true と helloRetryRequest: true は connect() で reject する", async () => {
    // Arrange
    const pc = new RTCPeerConnection({
      iceServers: [],
      sped: true,
      dtls: {
        protocolVersions: [DtlsVersion.V1_3],
        helloRetryRequest: true,
      },
    });
    try {
      // Act / Assert: SPED は ice-authenticated 固定。dtls-cookie と併用しない
      await expect((pc as any).connect()).rejects.toThrow(/helloRetryRequest/);
    } finally {
      pc.close();
    }
  });

  test("sped: false 同士は datachannel が開き Binding に SPED が付かない", async () => {
    const stun: Buffer[] = [];
    const handshakeDtls: Buffer[] = [];
    const pc1 = new RTCPeerConnection({ iceServers: [] });
    const pc2 = new RTCPeerConnection({ iceServers: [] });
    try {
      const [dc1, dc2] = await openDataChannelWithWireSpy(
        pc1,
        pc2,
        stun,
        handshakeDtls,
      );
      dc1.send("hello");
      expect(await awaitMessage(dc2)).toBe("hello");
      expect(
        stun.some((bytes) =>
          stunAttributeTypes(bytes).includes(DTLS_IN_STUN_DATA),
        ),
      ).toBe(false);
    } finally {
      await pc1.close();
      await pc2.close();
    }
  }, 20_000);

  test("werift ↔ werift で SPED + DTLS 1.3 + 双方向 app data", async () => {
    const pc1 = new RTCPeerConnection(spedPeerConfig());
    const pc2 = new RTCPeerConnection(spedPeerConfig());
    try {
      const [dc1, dc2] = await createDataChannelPair({}, pc1, pc2);
      dc1.send("sped-a");
      expect(await awaitMessage(dc2)).toBe("sped-a");
      dc2.send("sped-b");
      expect(await awaitMessage(dc1)).toBe("sped-b");
    } finally {
      await pc1.close();
      await pc2.close();
    }
  }, 30_000);

  test("answerer が offer しても SPED handshake が完了する", async () => {
    const pc1 = new RTCPeerConnection(spedPeerConfig());
    const pc2 = new RTCPeerConnection(spedPeerConfig());
    try {
      const [dc1, dc2] = await createDataChannelPair({}, pc2, pc1);
      dc1.send("role-swap");
      expect(await awaitMessage(dc2)).toBe("role-swap");
    } finally {
      await pc1.close();
      await pc2.close();
    }
  }, 30_000);

  test("Full × Lite で SPED handshake と双方向 app data", async () => {
    const full = new RTCPeerConnection(spedPeerConfig());
    const lite = new RTCPeerConnection(spedPeerConfig({ iceLite: true }));
    try {
      const [dc1, dc2] = await createDataChannelPair({}, full, lite);
      dc1.send("lite");
      expect(await awaitMessage(dc2)).toBe("lite");
      dc2.send("full");
      expect(await awaitMessage(dc1)).toBe("full");
    } finally {
      await full.close();
      await lite.close();
    }
  }, 30_000);

  test("TCP ICE 上で SPED handshake と双方向 app data", async () => {
    const stun: Buffer[] = [];
    const handshakeDtls: Buffer[] = [];
    const tcpFrames: Buffer[] = [];
    const pc1 = new RTCPeerConnection(spedPeerConfig({ iceUseTcp: true }));
    const pc2 = new RTCPeerConnection(spedPeerConfig({ iceUseTcp: true }));
    try {
      const [dc1, dc2] = await openDataChannelWithWireSpy(
        pc1,
        pc2,
        stun,
        handshakeDtls,
        { tcpFrames },
      );
      // Act: TCP nominated 上で app data を送る
      dc1.send("tcp-sped");
      expect(await awaitMessage(dc2)).toBe("tcp-sped");

      // Assert: RFC 4571 フレーム（2-byte length）の payload に DATA/ACK がある
      const framedSped = tcpFrames.filter((frame) => {
        if (frame.length < 2) {
          return false;
        }
        const length = frame.readUInt16BE(0);
        const payload = frame.subarray(2, 2 + length);
        const types = stunAttributeTypes(payload);
        return (
          types.includes(DTLS_IN_STUN_DATA) || types.includes(DTLS_IN_STUN_ACK)
        );
      });
      expect(framedSped.length).toBeGreaterThan(0);
      for (const frame of framedSped) {
        expect(frame.readUInt16BE(0)).toBe(frame.length - 2);
      }
      expect(handshakeDtls).toHaveLength(0);
    } finally {
      await pc1.close();
      await pc2.close();
    }
  }, 30_000);

  test("non-SPED peer へ fallback して handshake が完了する", async () => {
    const stun: Buffer[] = [];
    const handshakeDtls: Buffer[] = [];
    const pc1 = new RTCPeerConnection(spedPeerConfig());
    const pc2 = new RTCPeerConnection({
      iceServers: [],
      dtls: { protocolVersions: [DtlsVersion.V1_3] },
    });
    try {
      const [dc1, dc2] = await openDataChannelWithWireSpy(
        pc1,
        pc2,
        stun,
        handshakeDtls,
      );
      // Act
      dc1.send("fallback");
      expect(await awaitMessage(dc2)).toBe("fallback");

      // Assert: SPED probe のあと、生 DTLS handshake で fallback する
      expect(
        stun.some((bytes) =>
          stunAttributeTypes(bytes).includes(DTLS_IN_STUN_DATA),
        ),
      ).toBe(true);
      const embedded = firstNonEmptySpedData(stun);
      expect(handshakeDtls.length).toBeGreaterThan(0);
      if (embedded) {
        expect(handshakeDtls.some((bytes) => bytes.equals(embedded))).toBe(
          true,
        );
      }
    } finally {
      await pc1.close();
      await pc2.close();
    }
  }, 30_000);

  test("最初の非空 DATA を drop しても handshake が完了する", async () => {
    const stun: Buffer[] = [];
    const handshakeDtls: Buffer[] = [];
    const pc1 = new RTCPeerConnection(spedPeerConfig());
    const pc2 = new RTCPeerConnection(spedPeerConfig());
    try {
      const [dc1, dc2] = await openDataChannelWithWireSpy(
        pc1,
        pc2,
        stun,
        handshakeDtls,
        { dropFirstNonEmptyData: { remaining: 1 } },
      );
      // Act / Assert: 損失後も round-robin / extra Binding で完了する
      dc1.send("loss");
      expect(await awaitMessage(dc2)).toBe("loss");
    } finally {
      await pc1.close();
      await pc2.close();
    }
  }, 30_000);

  test("SPED wire: DATA/ACK は MI より前で handshake を生 DTLS に出さない", async () => {
    const stun: Buffer[] = [];
    const handshakeDtls: Buffer[] = [];
    const pc1 = new RTCPeerConnection(spedPeerConfig());
    const pc2 = new RTCPeerConnection(spedPeerConfig());
    try {
      const [dc1, dc2] = await openDataChannelWithWireSpy(
        pc1,
        pc2,
        stun,
        handshakeDtls,
      );
      dc1.send("wire");
      expect(await awaitMessage(dc2)).toBe("wire");

      const sped = stun.filter((bytes) => {
        const types = stunAttributeTypes(bytes);
        return (
          types.includes(DTLS_IN_STUN_DATA) || types.includes(DTLS_IN_STUN_ACK)
        );
      });
      expect(sped.length).toBeGreaterThan(0);
      for (const bytes of sped) {
        const types = stunAttributeTypes(bytes);
        const data = types.indexOf(DTLS_IN_STUN_DATA);
        const ack = types.indexOf(DTLS_IN_STUN_ACK);
        const mi = types.indexOf(MESSAGE_INTEGRITY);
        expect(types.at(-1)).toBe(FINGERPRINT);
        if (data >= 0 && mi >= 0) {
          expect(data).toBeLessThan(mi);
        }
        if (ack >= 0 && mi >= 0) {
          expect(ack).toBeLessThan(mi);
        }
        if (ack >= 0 && data >= 0) {
          expect(ack).toBeLessThan(data);
        }
      }
      expect(handshakeDtls).toHaveLength(0);
    } finally {
      await pc1.close();
      await pc2.close();
    }
  }, 30_000);

  test("ICE restart 後も datachannel が使える", async () => {
    const pc1 = new RTCPeerConnection(spedPeerConfig());
    const pc2 = new RTCPeerConnection(spedPeerConfig());
    try {
      const [dc1, dc2] = await createDataChannelPair({}, pc1, pc2);
      dc1.send("before");
      expect(await awaitMessage(dc2)).toBe("before");

      await pc1.setLocalDescription(
        await pc1.createOffer({ iceRestart: true }),
      );
      await pc2.setRemoteDescription(pc1.localDescription!);
      await pc2.setLocalDescription(await pc2.createAnswer());
      await pc1.setRemoteDescription(pc2.localDescription!);
      await Promise.all([waitForIceNominated(pc1), waitForIceNominated(pc2)]);

      dc1.send("after");
      expect(await awaitMessage(dc2)).toBe("after");
    } finally {
      await pc1.close();
      await pc2.close();
    }
  }, 40_000);

  test("handshake 開始後の ICE restart でも datachannel が開く", async () => {
    const stun: Buffer[] = [];
    const handshakeDtls: Buffer[] = [];
    const pc1 = new RTCPeerConnection(spedPeerConfig());
    const pc2 = new RTCPeerConnection(spedPeerConfig());
    try {
      const dc1 = pc1.createDataChannel("dc");
      let dc2!: RTCDataChannel;
      const opened = Promise.all([
        new Promise<void>((resolve, reject) => {
          dc1.onopen = () => resolve();
          dc1.onerror = ({ error }) => reject(error);
        }),
        new Promise<void>((resolve, reject) => {
          pc2.ondatachannel = ({ channel }) => {
            dc2 = channel;
            channel.onopen = () => resolve();
            channel.onerror = ({ error }) => reject(error);
          };
        }),
      ]);
      exchangeIceCandidates(pc1, pc2);
      await pc1.setLocalDescription(await pc1.createOffer());
      spyConnectionWire(pc1, stun, handshakeDtls);
      await pc2.setRemoteDescription(pc1.localDescription!);
      await pc2.setLocalDescription(await pc2.createAnswer());
      spyConnectionWire(pc2, stun, handshakeDtls);
      await pc1.setRemoteDescription(pc2.localDescription!);

      // Act: DATA が見えたところで restart し、新 generation で完了させる
      await new Promise((r) => setTimeout(r, 20));
      await pc1.setLocalDescription(
        await pc1.createOffer({ iceRestart: true }),
      );
      await pc2.setRemoteDescription(pc1.localDescription!);
      await pc2.setLocalDescription(await pc2.createAnswer());
      await pc1.setRemoteDescription(pc2.localDescription!);
      await opened;
      dc1.send("hs-restart");
      expect(await awaitMessage(dc2)).toBe("hs-restart");
    } finally {
      await pc1.close();
      await pc2.close();
    }
  }, 40_000);

  test("Full × Lite で Lite は Binding Request を出さない", async () => {
    const fullStun: Buffer[] = [];
    const liteStun: Buffer[] = [];
    const handshakeDtls: Buffer[] = [];
    const full = new RTCPeerConnection(spedPeerConfig());
    const lite = new RTCPeerConnection(spedPeerConfig({ iceLite: true }));
    try {
      const dc1 = full.createDataChannel("dc");
      const bothOpen = Promise.all([
        new Promise<void>((resolve, reject) => {
          dc1.onopen = () => resolve();
          dc1.onerror = ({ error }) => reject(error);
        }),
        new Promise<RTCDataChannel>((resolve, reject) => {
          lite.ondatachannel = ({ channel }) => {
            channel.onopen = () => resolve(channel);
            channel.onerror = ({ error }) => reject(error);
          };
        }),
      ]);
      exchangeIceCandidates(full, lite);
      await full.setLocalDescription(await full.createOffer());
      spyConnectionWire(full, fullStun, handshakeDtls);
      await lite.setRemoteDescription(full.localDescription!);
      await lite.setLocalDescription(await lite.createAnswer());
      spyConnectionWire(lite, liteStun, handshakeDtls);
      await full.setRemoteDescription(lite.localDescription!);
      const [, dc2] = await bothOpen;
      dc1.send("lite-req");
      expect(await awaitMessage(dc2)).toBe("lite-req");

      // Assert: Lite は Response のみ。Request を能動送信しない
      expect(liteStun.some(isStunBindingRequest)).toBe(false);
      expect(fullStun.some(isStunBindingRequest)).toBe(true);
    } finally {
      await full.close();
      await lite.close();
    }
  }, 30_000);

  test("重複 DATA でも handshake が完了する", async () => {
    const stun: Buffer[] = [];
    const handshakeDtls: Buffer[] = [];
    const pc1 = new RTCPeerConnection(spedPeerConfig());
    const pc2 = new RTCPeerConnection(spedPeerConfig());
    try {
      const [dc1, dc2] = await openDataChannelWithWireSpy(
        pc1,
        pc2,
        stun,
        handshakeDtls,
        { duplicateFirstNonEmptyData: { remaining: 1 } },
      );
      dc1.send("dup");
      expect(await awaitMessage(dc2)).toBe("dup");
    } finally {
      await pc1.close();
      await pc2.close();
    }
  }, 30_000);

  test("順序入れ替え DATA でも handshake が完了する", async () => {
    const stun: Buffer[] = [];
    const handshakeDtls: Buffer[] = [];
    const pc1 = new RTCPeerConnection(spedPeerConfig());
    const pc2 = new RTCPeerConnection(spedPeerConfig());
    try {
      const [dc1, dc2] = await openDataChannelWithWireSpy(
        pc1,
        pc2,
        stun,
        handshakeDtls,
        { holdFirstNonEmptyData: {} },
      );
      dc1.send("reorder");
      expect(await awaitMessage(dc2)).toBe("reorder");
    } finally {
      await pc1.close();
      await pc2.close();
    }
  }, 30_000);
});
