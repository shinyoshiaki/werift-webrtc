import { type Socket, createSocket } from "node:dgram";

import { UdpTransport } from "../../../common/src";
import { TransactionFailed } from "../../src/exceptions";
import { TurnProtocol, createTurnClient } from "../../src/turn/protocol";
import {
  TURN_TEST_PASSWORD,
  TURN_TEST_USERNAME,
  createLocalStunServer,
  createLocalTurnServer,
} from "../utils";

async function tryBindUdpPort(port: number) {
  const socket = createSocket("udp4");
  const error = await new Promise<NodeJS.ErrnoException | undefined>(
    (resolve) => {
      const onError = (error: NodeJS.ErrnoException) => {
        socket.off("listening", onListening);
        resolve(error);
      };
      const onListening = () => {
        socket.off("error", onError);
        resolve(undefined);
      };
      socket.once("error", onError);
      socket.once("listening", onListening);
      socket.bind({ address: "0.0.0.0", port });
    },
  );
  return { error, socket };
}

async function closeUdpSocket(socket?: Socket) {
  if (!socket) {
    return;
  }

  try {
    socket.address();
  } catch {
    return;
  }

  await new Promise<void>((resolve) => {
    socket.once("close", resolve);
    try {
      socket.close();
    } catch {
      resolve();
    }
  });
}

describe("TURN client allocation ownership", () => {
  test("failed allocation releases the client UDP port", async () => {
    // Arrange: ALLOCATE に 400 を返す実 UDP STUN server と client transport を用意する
    const server = await createLocalStunServer("127.0.0.1");
    const originalInit = UdpTransport.init;
    let clientTransport: UdpTransport | undefined;
    let clientPort: number | undefined;
    let reboundSocket: Socket | undefined;
    const initSpy = vi
      .spyOn(UdpTransport, "init")
      .mockImplementation(async (type, options) => {
        clientTransport = await originalInit(type, options);
        clientPort = clientTransport.port;
        return clientTransport;
      });

    try {
      // Act: TURN allocation を開始し、実 server からの拒否を受け取る
      const allocation = createTurnClient({
        address: server.address!,
        username: TURN_TEST_USERNAME,
        password: TURN_TEST_PASSWORD,
      });

      // Assert: allocation error を維持し、失敗した client の実 UDP port を再利用できる
      await expect(allocation).rejects.toBeInstanceOf(TransactionFailed);
      expect(clientPort).toBeDefined();
      const rebound = await tryBindUdpPort(clientPort!);
      reboundSocket = rebound.socket;
      expect(rebound.error).toBeUndefined();
    } finally {
      await closeUdpSocket(reboundSocket);
      await clientTransport?.close();
      initSpy.mockRestore();
      await server.close();
    }
  });

  test("cleanup failure preserves the allocation error", async () => {
    // Arrange: allocation と cleanup が別々の error で失敗する client を用意する
    const allocationError = new Error("allocation failed");
    const cleanupError = new Error("cleanup failed");
    const originalInit = UdpTransport.init;
    let clientTransport: UdpTransport | undefined;
    const initSpy = vi
      .spyOn(UdpTransport, "init")
      .mockImplementation(async (type, options) => {
        clientTransport = await originalInit(type, options);
        return clientTransport;
      });
    const connectionMadeSpy = vi
      .spyOn(TurnProtocol.prototype, "connectionMade")
      .mockRejectedValue(allocationError);
    const closeSpy = vi
      .spyOn(TurnProtocol.prototype, "close")
      .mockRejectedValue(cleanupError);

    try {
      // Act: allocation failure 後の cleanup failure まで実行する
      const allocation = createTurnClient({
        address: ["127.0.0.1", 9],
        username: TURN_TEST_USERNAME,
        password: TURN_TEST_PASSWORD,
      });

      // Assert: cleanup error ではなく元の allocation error を返す
      await expect(allocation).rejects.toBe(allocationError);
    } finally {
      closeSpy.mockRestore();
      connectionMadeSpy.mockRestore();
      initSpy.mockRestore();
      await clientTransport?.close();
    }
  });

  test("successful allocation leaves UDP port ownership with caller", async () => {
    // Arrange: allocation が成功する実 UDP TURN server を用意する
    const server = await createLocalTurnServer("127.0.0.1");
    let turn: TurnProtocol | undefined;
    let occupiedProbe: Socket | undefined;
    let releasedProbe: Socket | undefined;

    try {
      turn = await createTurnClient({
        address: server.address!,
        username: TURN_TEST_USERNAME,
        password: TURN_TEST_PASSWORD,
      });
      const clientPort = turn.transport.address.port;

      // Act: caller が close する前に同じ UDP port の bind を試す
      const occupied = await tryBindUdpPort(clientPort);
      occupiedProbe = occupied.socket;

      // Assert: 成功した client は transport の所有権を維持する
      expect(occupied.error?.code).toBe("EADDRINUSE");

      // Act: caller が client を close してから同じ port を再度 bind する
      await turn.close();
      turn = undefined;
      const released = await tryBindUdpPort(clientPort);
      releasedProbe = released.socket;

      // Assert: caller の close 後は UDP port を再利用できる
      expect(released.error).toBeUndefined();
    } finally {
      await closeUdpSocket(occupiedProbe);
      await closeUdpSocket(releasedProbe);
      await turn?.close();
      await server.close();
    }
  });
});
