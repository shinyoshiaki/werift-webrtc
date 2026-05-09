import type { Address } from "../../../common/src";
import { getHostAddresses } from "../../src/utils";
import {
  TURN_TEST_PASSWORD,
  TURN_TEST_USERNAME,
  createLocalTurnServer,
  createTestConnection,
  getLocalTurnClientTlsOptions,
} from "../utils";

const localTurnHost = getHostAddresses(true, false)[0]!;

async function assertConnectWithTurnServer(
  turnServer: Address,
  transport: "udp" | "tcp" | "tls",
) {
  const connectionOptions = {
    stunServer: undefined,
    turnServer,
    turnUsername: TURN_TEST_USERNAME,
    turnPassword: TURN_TEST_PASSWORD,
    turnTransport: transport,
    turnTlsOptions:
      transport === "tls" ? getLocalTurnClientTlsOptions() : undefined,
    forceTurn: true,
  };
  const a = createTestConnection(true, connectionOptions);
  const b = createTestConnection(false, connectionOptions);

  try {
    // relay 候補だけを使うため、まず両端で候補収集を完了させる。
    await a.gatherCandidates();
    await b.gatherCandidates();

    // 相手へ渡す候補を relay のみに絞って TURN 経路を強制する。
    b.remoteCandidates = a.localCandidates.filter(
      (candidate) => candidate.type === "relay",
    );
    b.remoteUsername = a.localUsername;
    b.remotePassword = a.localPassword;
    a.remoteCandidates = b.localCandidates.filter(
      (candidate) => candidate.type === "relay",
    );
    a.remoteUsername = b.localUsername;
    a.remotePassword = b.localPassword;

    // 接続前に relay 候補を取得できていることを確認する。
    expect(
      a.localCandidates.some((candidate) => candidate.type === "relay"),
    ).toBe(true);
    expect(
      b.localCandidates.some((candidate) => candidate.type === "relay"),
    ).toBe(true);

    // relay 候補だけで ICE 接続を確立する。
    await Promise.all([a.connect(), b.connect()]);

    // 実際に選ばれた候補対が relay 同士になっていることを確認する。
    expect(a.nominated?.localCandidate.type).toBe("relay");
    expect(a.nominated?.remoteCandidate.type).toBe("relay");
    expect(b.nominated?.localCandidate.type).toBe("relay");
    expect(b.nominated?.remoteCandidate.type).toBe("relay");

    // A から B へデータを流して TURN relay 経由で届くことを確認する。
    await a.send(Buffer.from(`howdee-over-${transport}`));
    let [data] = await b.onData.asPromise();
    expect(data.toString()).toBe(`howdee-over-${transport}`);

    // B から A への逆方向通信も TURN relay 経由で届くことを確認する。
    await b.send(Buffer.from(`gotcha-over-${transport}`));
    [data] = await a.onData.asPromise();
    expect(data.toString()).toBe(`gotcha-over-${transport}`);
  } finally {
    await a.close();
    await b.close();
  }
}

describe("turn", () => {
  test("connects through local turn server over udp", async () => {
    const server = await createLocalTurnServer(localTurnHost!);

    try {
      await assertConnectWithTurnServer(server.address!, "udp");
    } finally {
      await server.close();
    }
  });

  test("connects through local turn server over tcp", async () => {
    const server = await createLocalTurnServer(localTurnHost!);

    try {
      await assertConnectWithTurnServer(server.address!, "tcp");
    } finally {
      await server.close();
    }
  });

  test("connects through local turn server over tls", async () => {
    const server = await createLocalTurnServer(localTurnHost!, { tls: true });

    try {
      await assertConnectWithTurnServer(server.tlsAddress!, "tls");
    } finally {
      await server.close();
    }
  });
});
