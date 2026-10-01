import { TransactionTimeout } from "../../src/exceptions";
import { classes, methods } from "../../src/stun/const";
import { Message } from "../../src/stun/message";
import { TurnProtocol } from "../../src/turn/protocol";
import { createRecordingTransport, stubDualStackLookup } from "../utils";

const TURN_HOST = "turn.example.test";
const TURN_IPV4 = "192.0.2.1";
const TURN_IPV6 = "2001:db8::1";

function createTurn(transport: ReturnType<typeof createRecordingTransport>) {
  return new TurnProtocol(
    [TURN_HOST, 3478],
    "user",
    "pass",
    600,
    transport.transport,
  );
}

/** Allocate を 1 回だけ送り、応答なしでタイムアウトさせる */
async function allocateOnce(turn: TurnProtocol) {
  const request = new Message(methods.ALLOCATE, classes.REQUEST);
  await expect(
    turn.request(request, turn.server, undefined, {
      retransmissions: 0,
      responseTimeout: 5,
    }),
  ).rejects.toBeInstanceOf(TransactionTimeout);
}

describe("TurnProtocol resolves the server hostname in the socket's family", () => {
  let dns: ReturnType<typeof stubDualStackLookup>;

  beforeEach(() => {
    dns = stubDualStackLookup(TURN_IPV4, TURN_IPV6);
  });

  afterEach(() => {
    dns.restore();
  });

  test("udp4 socket sends to the IPv4 address of an IPv6-first host", async () => {
    // Arrange: udp4 ソケットと、AAAA を先に返すホスト名
    const recording = createRecordingTransport("udp", "udp4");
    const turn = createTurn(recording);

    // Act: Allocate を送る
    await allocateOnce(turn);

    // Assert: IPv4 で名前解決し、IPv4 アドレスへ送信している
    expect(dns.families).toEqual([4]);
    expect(recording.sentTo).toEqual([[TURN_IPV4, 3478]]);
  });

  test("udp6 socket sends to the IPv6 address", async () => {
    // Arrange: udp6 ソケット
    const recording = createRecordingTransport("udp", "udp6");
    const turn = createTurn(recording);

    // Act: Allocate を送る
    await allocateOnce(turn);

    // Assert: IPv6 で名前解決し、IPv6 アドレスへ送信している
    expect(dns.families).toEqual([6]);
    expect(recording.sentTo).toEqual([[TURN_IPV6, 3478]]);
  });

  test("stream transport keeps the default lookup", async () => {
    // Arrange: TCP トランスポート(接続済みのストリームなのでファミリー指定は不要)
    const recording = createRecordingTransport("tcp");
    const turn = createTurn(recording);

    // Act: Allocate を送る
    await allocateOnce(turn);

    // Assert: ファミリー指定なし(0)で名前解決している
    expect(dns.families).toEqual([0]);
  });
});
