import type { SocketType } from "node:dgram";
import { type Address, UdpTransport } from "../../../common/src";
import {
  AddressFamilyMismatch,
  TransactionTimeout,
} from "../../src/exceptions";
import { classes, methods } from "../../src/stun/const";
import { Message } from "../../src/stun/message";
import { StunProtocol } from "../../src/stun/protocol";
import { TurnProtocol } from "../../src/turn/protocol";
import {
  createRecordingTransport,
  recordSends,
  stubDualStackLookup,
} from "../utils";

const TURN_HOST = "turn.example.test";
const TURN_IPV4 = "192.0.2.1";
const TURN_IPV6 = "2001:db8::1";

/** One attempt, no answer: the request times out almost at once. */
const SEND_ONCE = { retransmissions: 0, responseTimeout: 5 };

function allocateRequest() {
  return new Message(methods.ALLOCATE, classes.REQUEST);
}

describe("TURN/UDP resolves the server in the bound socket's family", () => {
  let dns: ReturnType<typeof stubDualStackLookup>;
  const transports: UdpTransport[] = [];

  beforeEach(() => {
    dns = stubDualStackLookup(TURN_IPV4, TURN_IPV6);
  });

  afterEach(async () => {
    dns.restore();
    await Promise.all(transports.splice(0).map((t) => t.close()));
  });

  async function createUdpTurn(socketType: SocketType, server: Address) {
    const transport = await UdpTransport.init(socketType);
    transports.push(transport);
    const sentTo = recordSends(transport);
    const turn = new TurnProtocol(server, "user", "pass", 600, transport);
    return { turn, sentTo };
  }

  test.each([
    ["udp4", 4, TURN_IPV4],
    ["udp6", 6, TURN_IPV6],
  ] as const)(
    "%s socket looks a dual-stack hostname up with family %i",
    async (socketType, family, expected) => {
      // Arrange: 実際の UdpTransport と、AAAA を先に返すホスト名
      const { turn, sentTo } = await createUdpTurn(socketType, [
        TURN_HOST,
        3478,
      ]);

      // Act: Allocate を 1 回だけ送る
      await expect(
        turn.request(allocateRequest(), turn.server, undefined, SEND_ONCE),
      ).rejects.toBeInstanceOf(TransactionTimeout);

      // Assert: ソケットのファミリーで名前解決し、そのアドレスへ送信している
      expect(dns.families).toEqual([family]);
      expect(sentTo).toEqual([[expected, 3478]]);
    },
  );

  test.each([
    ["udp4", TURN_IPV4],
    ["udp6", TURN_IPV6],
  ] as const)(
    "%s socket sends to a %s literal without a lookup",
    async (socketType, literal) => {
      // Arrange: ソケットと同じファミリーの IP リテラル
      const { turn, sentTo } = await createUdpTurn(socketType, [literal, 3478]);

      // Act: Allocate を 1 回だけ送る
      await expect(
        turn.request(allocateRequest(), turn.server, undefined, SEND_ONCE),
      ).rejects.toBeInstanceOf(TransactionTimeout);

      // Assert: DNS を引かずにリテラルへそのまま送信している
      expect(dns.families).toEqual([]);
      expect(sentTo).toEqual([[literal, 3478]]);
    },
  );

  test.each([
    ["udp4", TURN_IPV6],
    ["udp6", TURN_IPV4],
  ] as const)(
    "%s socket rejects a %s literal at once",
    async (socketType, literal) => {
      // Arrange: ソケットと異なるファミリーの IP リテラル
      const { turn, sentTo } = await createUdpTurn(socketType, [literal, 3478]);

      // Act: 既定の再送ポリシーで Allocate を送る(再送に入れば数秒かかる)
      const allocate = turn.request(allocateRequest(), turn.server);

      // Assert: 再送せずに即座にファミリー不一致で失敗し、何も送信していない
      await expect(allocate).rejects.toBeInstanceOf(AddressFamilyMismatch);
      expect(sentTo).toEqual([]);
    },
  );

  test("custom UDP transport without addressFamily keeps the default lookup", async () => {
    // Arrange: addressFamily を公開しないカスタム UDP トランスポート
    const recording = createRecordingTransport("udp");
    const turn = new TurnProtocol(
      [TURN_HOST, 3478],
      "user",
      "pass",
      600,
      recording.transport,
    );

    // Act: Allocate を 1 回だけ送る
    await expect(
      turn.request(allocateRequest(), turn.server, undefined, SEND_ONCE),
    ).rejects.toBeInstanceOf(TransactionTimeout);

    // Assert: IPv4 を仮定せず、ファミリー指定なし(0)で名前解決している
    expect(dns.families).toEqual([0]);
    expect(recording.sentTo).toEqual([[TURN_IPV6, 3478]]);
  });
});

describe("STUN resolves its target in the bound socket's family", () => {
  let dns: ReturnType<typeof stubDualStackLookup>;
  const protocols: StunProtocol[] = [];

  beforeEach(() => {
    dns = stubDualStackLookup(TURN_IPV4, TURN_IPV6);
  });

  afterEach(async () => {
    dns.restore();
    await Promise.all(protocols.splice(0).map((p) => p.close()));
  });

  test.each([
    [true, 4, TURN_IPV4],
    [false, 6, TURN_IPV6],
  ] as const)(
    "useIpv4=%s looks a dual-stack hostname up with family %i",
    async (useIpv4, family, expected) => {
      // Arrange: 実際の UdpTransport を持つ StunProtocol
      const protocol = new StunProtocol();
      protocols.push(protocol);
      await protocol.connectionMade(useIpv4);
      const sentTo = recordSends(protocol.transport);

      // Act: Binding を 1 回だけ送る
      await expect(
        protocol.request(
          new Message(methods.BINDING, classes.REQUEST),
          [TURN_HOST, 3478],
          undefined,
          SEND_ONCE,
        ),
      ).rejects.toBeInstanceOf(TransactionTimeout);

      // Assert: ソケットのファミリーで名前解決し、そのアドレスへ送信している
      expect(dns.families).toEqual([family]);
      expect(sentTo).toEqual([[expected, 3478]]);
    },
  );
});
