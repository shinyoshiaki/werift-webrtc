import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DirectHandshakeCarrier } from "../../../dtls/src/carrier/direct";
import type { CandidatePair, Connection } from "../../../ice/src";
import { SpedSession } from "../../../ice/src/internal/sped";
import { getConnectionSpedRuntime } from "../../../ice/src/internal/sped-bind";
import { paddingLength } from "../../../ice/src/stun/message";
import { encodeTcpFrame } from "../../../ice/src/stun/tcpFrame";
import type { Protocol } from "../../../ice/src/types/model";
import {
  DtlsVersion,
  HashAlgorithm,
  RTCCertificate,
  type RTCDataChannel,
  RTCPeerConnection,
  SignatureAlgorithm,
} from "../../src";
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
  extra: {
    iceUseTcp?: boolean;
    iceLite?: boolean;
    iceAdditionalHostAddresses?: string[];
    certificates?: RTCCertificate[];
    iceFilterCandidatePair?: (pair: CandidatePair) => boolean;
    iceUseIpv6?: boolean;
  } = {},
) => ({
  iceServers: [] as { urls: string }[],
  sped: true,
  dtls: { protocolVersions: [DtlsVersion.V1_3] as const },
  ...extra,
});

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil timeout");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

function iceOf(pc: RTCPeerConnection) {
  return pc.iceTransports[0]!.connection as Connection;
}

function tcpOnlyCandidatePair(pair: CandidatePair) {
  return (
    pair.localCandidate.transport.toLowerCase() === "tcp" &&
    pair.remoteCandidate.transport.toLowerCase() === "tcp"
  );
}

function expectNominatedTcp(pc: RTCPeerConnection) {
  const nominated = iceOf(pc).nominated;
  expect(nominated).toBeDefined();
  expect(nominated!.localCandidate.transport.toLowerCase()).toBe("tcp");
  expect(nominated!.remoteCandidate.transport.toLowerCase()).toBe("tcp");
}

const hookedL1Sessions = new WeakSet<object>();

function captureL1Flights(pc: RTCPeerConnection, flights: Buffer[][]) {
  const hook = () => {
    const ice = pc.iceTransports[0]?.connection as Connection | undefined;
    if (!ice) {
      return false;
    }
    const runtime = getConnectionSpedRuntime(ice);
    if (!runtime || hookedL1Sessions.has(runtime.session)) {
      return !!runtime;
    }
    hookedL1Sessions.add(runtime.session);
    if (runtime.session.hasL1) {
      flights.push(runtime.session.l1Datagrams);
    }
    const original = runtime.session.replaceL1.bind(runtime.session);
    runtime.session.replaceL1 = (packets) => {
      flights.push(packets.map((packet) => Buffer.from(packet)));
      original(packets);
    };
    return true;
  };
  if (hook()) {
    return () => {};
  }
  const id = setInterval(() => {
    if (hook()) {
      clearInterval(id);
    }
  }, 1);
  return () => clearInterval(id);
}

function longestFlight(flights: Buffer[][]): Buffer[] | undefined {
  return flights.reduce(
    (best, flight) => (flight.length > (best?.length ?? 0) ? flight : best),
    undefined as Buffer[] | undefined,
  );
}

/**
 * Record L1 flights per session. Prototype hook runs before ICE/DTLS attach.
 */
function recordL1Flights() {
  const original = SpedSession.prototype.replaceL1;
  const flightsBySession = new WeakMap<SpedSession, Buffer[][]>();
  SpedSession.prototype.replaceL1 = function (
    this: SpedSession,
    packets: readonly Buffer[],
  ) {
    const copies = packets.map((packet) => Buffer.from(packet));
    const flights = flightsBySession.get(this) ?? [];
    flights.push(copies);
    flightsBySession.set(this, flights);
    original.call(this, packets);
  };
  return {
    stop: () => {
      SpedSession.prototype.replaceL1 = original;
    },
    flightsOf: (session: SpedSession) => flightsBySession.get(session) ?? [],
  };
}

/**
 * Cap DTLS carrier MTU before the first flight so large certificates fragment
 * into a multi-datagram L1. Must wrap the prototype before PeerConnection
 * construction; polling after attach loses the first flight.
 */
function capHandshakeCarrierMtu(maxMtu: number) {
  const proto = DirectHandshakeCarrier.prototype;
  const originalGet = proto.getMtu;
  const originalSet = proto.setMtu;
  proto.getMtu = function (this: DirectHandshakeCarrier) {
    return Math.min(originalGet.call(this), maxMtu);
  };
  proto.setMtu = function (this: DirectHandshakeCarrier, mtu: number) {
    originalSet.call(this, Math.min(mtu, maxMtu));
  };
  return () => {
    proto.getMtu = originalGet;
    proto.setMtu = originalSet;
  };
}

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
  return nonEmptySpedDataPayloads(stun)[0];
}

function nonEmptySpedDataPayloads(stun: Buffer[]): Buffer[] {
  const payloads: Buffer[] = [];
  for (const bytes of stun) {
    let pos = 20;
    while (pos + 4 <= bytes.length) {
      const type = bytes.readUInt16BE(pos);
      const length = bytes.readUInt16BE(pos + 2);
      if (type === DTLS_IN_STUN_DATA && length > 0) {
        payloads.push(Buffer.from(bytes.subarray(pos + 4, pos + 4 + length)));
      }
      pos += 4 + length + paddingLength(length);
    }
  }
  return payloads;
}

function isStunBindingRequest(bytes: Buffer): boolean {
  return bytes.length >= 2 && bytes.readUInt16BE(0) === 0x0001;
}

type HoldFirstNonEmptyData = {
  message?: Parameters<Protocol["sendStun"]>[0];
  addr?: Parameters<Protocol["sendStun"]>[1];
  /** When true, the first non-empty DATA Binding is never released. */
  discard?: boolean;
};

type HoldUntilLaterFlightPacket = {
  flightOf: () => Buffer[] | undefined;
  holdIndex: number;
  releaseIndex: number;
  held: {
    message: Parameters<Protocol["sendStun"]>[0];
    addr: Parameters<Protocol["sendStun"]>[1];
    copy: Buffer;
  }[];
  released?: boolean;
};

type WireSpyOptions = {
  tcpFrames?: Buffer[];
  dropFirstNonEmptyData?: { remaining: number };
  duplicateFirstNonEmptyData?: { remaining: number };
  holdFirstNonEmptyData?: HoldFirstNonEmptyData;
  holdUntilLaterFlightPacket?: HoldUntilLaterFlightPacket;
};

type OpenWireSpyOptions = WireSpyOptions & {
  offerer?: WireSpyOptions;
  answerer?: WireSpyOptions;
  offererStun?: Buffer[];
  answererStun?: Buffer[];
};

const spiedProtocols = new WeakSet<object>();
const spiedIceSend = new WeakSet<object>();

function spyConnectionWire(
  pc: RTCPeerConnection,
  stun: Buffer[],
  handshakeDtls: Buffer[],
  options: WireSpyOptions = {},
) {
  const ice = pc.iceTransports[0]?.connection as unknown as {
    protocols: Protocol[];
    send: (data: Buffer) => Promise<void>;
  };
  if (!ice) {
    return false;
  }
  if (!spiedIceSend.has(ice)) {
    spiedIceSend.add(ice);
    const iceSend = ice.send.bind(ice);
    ice.send = async (data: Buffer) => {
      const copy = Buffer.from(data);
      if (copy[0] === 22) {
        handshakeDtls.push(copy);
      }
      return iceSend(copy);
    };
  }
  for (const protocol of ice.protocols) {
    if (spiedProtocols.has(protocol)) {
      continue;
    }
    spiedProtocols.add(protocol);
    const sendStun = protocol.sendStun.bind(protocol);
    const sendData = protocol.sendData.bind(protocol);
    protocol.sendStun = async (message, addr) => {
      const copy = Buffer.from(message.bytes);
      if (options.tcpFrames) {
        options.tcpFrames.push(encodeTcpFrame(copy));
      }
      const dataValue = firstNonEmptySpedData([copy]);
      const nonEmptyData = !!dataValue;
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
      const reorder = options.holdUntilLaterFlightPacket;
      const flight = reorder?.flightOf();
      if (
        reorder &&
        !reorder.released &&
        dataValue &&
        flight &&
        flight.length > reorder.releaseIndex &&
        dataValue.equals(flight[reorder.holdIndex]!)
      ) {
        reorder.held.push({ message, addr, copy });
        return;
      }
      stun.push(copy);
      await sendStun(message, addr);
      if (
        reorder &&
        !reorder.released &&
        dataValue &&
        flight &&
        dataValue.equals(flight[reorder.releaseIndex]!)
      ) {
        for (const held of reorder.held) {
          stun.push(held.copy);
          await sendStun(held.message, held.addr);
        }
        reorder.held.length = 0;
        reorder.released = true;
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
  return ice.protocols.length > 0;
}

function spyWhenReady(
  pc: RTCPeerConnection,
  stun: Buffer[],
  handshakeDtls: Buffer[],
  options?: WireSpyOptions,
) {
  if (spyConnectionWire(pc, stun, handshakeDtls, options)) {
    return () => {};
  }
  const id = setInterval(() => {
    if (spyConnectionWire(pc, stun, handshakeDtls, options)) {
      clearInterval(id);
    }
  }, 1);
  return () => clearInterval(id);
}

async function openDataChannelWithWireSpy(
  pc1: RTCPeerConnection,
  pc2: RTCPeerConnection,
  stun: Buffer[],
  handshakeDtls: Buffer[],
  spyOptions?: OpenWireSpyOptions,
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
  const stopSpy1 = spyWhenReady(
    pc1,
    spyOptions?.offererStun ?? stun,
    handshakeDtls,
    {
      ...spyOptions,
      ...spyOptions?.offerer,
    },
  );
  await pc1.setLocalDescription(await pc1.createOffer());
  await pc2.setRemoteDescription(pc1.localDescription!);
  const stopSpy2 = spyWhenReady(
    pc2,
    spyOptions?.answererStun ?? stun,
    handshakeDtls,
    {
      ...spyOptions,
      ...spyOptions?.answerer,
    },
  );
  await pc2.setLocalDescription(await pc2.createAnswer());
  await pc1.setRemoteDescription(pc2.localDescription!);
  const [, dc2] = await bothOpen;
  stopSpy1();
  stopSpy2();
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

  test("createDataChannel 後の iceServers 更新では sped が維持される", () => {
    // Arrange: sped:true で transport を生成してから無関係な部分更新
    const pc = new RTCPeerConnection({
      iceServers: [],
      sped: true,
      dtls: { protocolVersions: [DtlsVersion.V1_3] },
    });

    try {
      pc.createDataChannel("dc");

      // Act: iceServers だけ更新する
      pc.setConfiguration({ iceServers: [] });

      // Assert: transport 生成後も sped は false に戻らない
      expect(pc.getConfiguration().sped).toBe(true);
    } finally {
      pc.close();
    }
  });

  test("createDataChannel 後の dtls 部分更新では protocolVersions が残る", async () => {
    // Arrange: sped + DTLS 1.3 で transport を生成してから helloRetryRequest だけ更新
    const pc1 = new RTCPeerConnection(spedPeerConfig());
    const pc2 = new RTCPeerConnection(spedPeerConfig());

    try {
      pc1.createDataChannel("warmup");

      // Act: nested dtls の一部だけを指定する
      pc1.setConfiguration({ dtls: { helloRetryRequest: false } });

      // Assert: protocolVersions が消えず、既存 transport と connect できる
      expect(pc1.getConfiguration().dtls.protocolVersions).toEqual([
        DtlsVersion.V1_3,
      ]);
      expect(pc1.getConfiguration().sped).toBe(true);
      const [dc1, dc2] = await createDataChannelPair({}, pc1, pc2);
      dc1.send("dtls-merge");
      expect(await awaitMessage(dc2)).toBe("dtls-merge");
    } finally {
      await pc1.close();
      await pc2.close();
    }
  }, 30_000);

  test("createDataChannel 後の sped 有効化は reject する", () => {
    // Arrange: 既存 non-SPED transport のあとで sped を後付けしない
    const pc = new RTCPeerConnection({ iceServers: [] });

    try {
      pc.createDataChannel("dc");

      // Act / Assert
      expect(() =>
        pc.setConfiguration({
          sped: true,
          dtls: { protocolVersions: [DtlsVersion.V1_3] },
        }),
      ).toThrow(/sped cannot be changed after a DTLS transport is created/);
      expect(pc.getConfiguration().sped).toBe(false);
    } finally {
      pc.close();
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
    const tcpSpedConfig = spedPeerConfig({
      iceUseTcp: true,
      iceFilterCandidatePair: tcpOnlyCandidatePair,
    });
    const pc1 = new RTCPeerConnection(tcpSpedConfig);
    const pc2 = new RTCPeerConnection(tcpSpedConfig);
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

      // Assert: nominated pair が TCP であり、UDP 高優先度で偽陽性にならない
      expectNominatedTcp(pc1);
      expectNominatedTcp(pc2);

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
    const flights: Buffer[][] = [];
    const pc1 = new RTCPeerConnection({
      iceServers: [],
      dtls: { protocolVersions: [DtlsVersion.V1_3] },
    });
    const pc2 = new RTCPeerConnection(spedPeerConfig());
    const stopCapture = captureL1Flights(pc2, flights);
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

      // Assert: SPED client の ClientHello が probe され、同一 bytes で raw fallback する
      expect(
        stun.some((bytes) =>
          stunAttributeTypes(bytes).includes(DTLS_IN_STUN_DATA),
        ),
      ).toBe(true);
      const embedded = firstNonEmptySpedData(stun) ?? flights[0]?.[0];
      expect(handshakeDtls.length).toBeGreaterThan(0);
      expect(embedded).toBeDefined();
      expect(handshakeDtls.some((bytes) => bytes.equals(embedded!))).toBe(true);
    } finally {
      stopCapture();
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
    const hold: HoldFirstNonEmptyData = { discard: true };
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
      spyConnectionWire(pc2, stun, handshakeDtls, {
        holdFirstNonEmptyData: hold,
      });
      await pc1.setRemoteDescription(pc2.localDescription!);

      // Act: DTLS client の最初の非空 DATA を止めて handshake 途中であることを同期してから restart
      await waitUntil(() => !!hold.message);
      expect(hold.message).toBeDefined();
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

  test("multi-candidate でも SPED handshake が完了する", async () => {
    const extra = { iceAdditionalHostAddresses: ["127.0.0.2"] };
    const pc1 = new RTCPeerConnection(spedPeerConfig(extra));
    const pc2 = new RTCPeerConnection(spedPeerConfig(extra));
    try {
      const [dc1, dc2] = await createDataChannelPair({}, pc1, pc2);
      // Assert: 追加ホストで候補が複数ある
      expect(
        pc1.iceTransports[0]!.connection.localCandidates.length,
      ).toBeGreaterThan(1);
      expect(
        pc2.iceTransports[0]!.connection.localCandidates.length,
      ).toBeGreaterThan(1);
      dc1.send("multi-cand");
      expect(await awaitMessage(dc2)).toBe("multi-cand");
    } finally {
      await pc1.close();
      await pc2.close();
    }
  }, 30_000);

  test("large certificate の multi-record flight を B→A に並べ替えても handshake が完了する", async () => {
    const largeCertPem = readFileSync(
      join(__dirname, "../../../dtls/assets/large_cert.pem"),
      "utf8",
    );
    const largeKeyPem = readFileSync(
      join(__dirname, "../../../dtls/assets/large_key.pem"),
      "utf8",
    );
    expect(Buffer.from(largeCertPem).length).toBeGreaterThan(2000);
    const certificate = new RTCCertificate(largeKeyPem, largeCertPem, {
      signature: SignatureAlgorithm.rsa_1,
      hash: HashAlgorithm.sha256_4,
    });
    const stun: Buffer[] = [];
    const offererStun: Buffer[] = [];
    const handshakeDtls: Buffer[] = [];
    const restoreMtu = capHandshakeCarrierMtu(400);
    const record = recordL1Flights();
    const extra = {
      certificates: [certificate],
      iceUseIpv6: false,
    };
    const pc1 = new RTCPeerConnection(spedPeerConfig(extra));
    const pc2 = new RTCPeerConnection(spedPeerConfig(extra));
    const reorder: HoldUntilLaterFlightPacket = {
      holdIndex: 1,
      releaseIndex: 2,
      held: [],
      flightOf: () => {
        const ice = pc1.iceTransports[0]?.connection as Connection | undefined;
        if (!ice) {
          return undefined;
        }
        const session = getConnectionSpedRuntime(ice)?.session;
        return session ? longestFlight(record.flightsOf(session)) : undefined;
      },
    };
    try {
      const [dc1, dc2] = await openDataChannelWithWireSpy(
        pc1,
        pc2,
        stun,
        handshakeDtls,
        { offererStun, offerer: { holdUntilLaterFlightPacket: reorder } },
      );

      // Act: large certificate を SPED 上で送り、アプリデータまで到達させる
      dc1.send("large-cert");
      expect(await awaitMessage(dc2)).toBe("large-cert");

      // Assert: offerer の最長 L1 が 3 datagram 以上。B を hold し C を先に送る
      expect(reorder.released).toBe(true);
      const offererSession = getConnectionSpedRuntime(iceOf(pc1))!.session;
      const multiRecordFlight = longestFlight(record.flightsOf(offererSession));
      expect(multiRecordFlight?.length).toBeGreaterThan(2);
      const spedPayloads = nonEmptySpedDataPayloads(offererStun);
      for (const packet of multiRecordFlight!) {
        expect(spedPayloads.some((payload) => payload.equals(packet))).toBe(
          true,
        );
      }
      const flightKeys = multiRecordFlight!.map((packet) =>
        packet.toString("hex"),
      );
      const firstSeenOrder: number[] = [];
      for (const payload of spedPayloads) {
        const index = flightKeys.indexOf(payload.toString("hex"));
        if (index >= 0 && !firstSeenOrder.includes(index)) {
          firstSeenOrder.push(index);
        }
      }
      const posB = firstSeenOrder.indexOf(1);
      const posC = firstSeenOrder.indexOf(2);
      expect(posC).toBeGreaterThanOrEqual(0);
      expect(posB).toBeGreaterThan(posC);
      expect(handshakeDtls).toHaveLength(0);
    } finally {
      record.stop();
      restoreMtu();
      await pc1.close();
      await pc2.close();
    }
  }, 60_000);

  test("DTLS error は ICE connected のまま SPED を disabled にする", async () => {
    const stun: Buffer[] = [];
    const handshakeDtls: Buffer[] = [];
    const hold: HoldFirstNonEmptyData = { discard: true };
    const pc1 = new RTCPeerConnection(spedPeerConfig());
    const pc2 = new RTCPeerConnection(spedPeerConfig());
    try {
      pc1.createDataChannel("dc");
      exchangeIceCandidates(pc1, pc2);
      await pc1.setLocalDescription(await pc1.createOffer());
      spyConnectionWire(pc1, stun, handshakeDtls);
      await pc2.setRemoteDescription(pc1.localDescription!);
      await pc2.setLocalDescription(await pc2.createAnswer());
      spyConnectionWire(pc2, stun, handshakeDtls, {
        holdFirstNonEmptyData: hold,
      });
      await pc1.setRemoteDescription(pc2.localDescription!);

      // Act: handshake 途中で DTLS error を起こす
      await waitUntil(() => !!hold.message);
      const ice = iceOf(pc2);
      const runtime = getConnectionSpedRuntime(ice);
      expect(runtime).toBeDefined();
      expect(runtime!.session.state).not.toBe("disabled");
      pc2.dtlsTransports[0]!.dtls!.onError.execute(
        new Error("sped-dtls-error"),
      );
      await waitUntil(() => runtime?.session.state === "disabled");

      // Assert: ICE は failed でなく、SPED は埋め込みを止める
      expect(ice.state === "failed" || ice.state === "closed").toBe(false);
      expect(runtime?.session.state).toBe("disabled");
      expect(runtime?.session.embedding).toBe(false);
      expect(runtime?.session.hasL1).toBe(false);
    } finally {
      await pc1.close();
      await pc2.close();
    }
  }, 30_000);
});
