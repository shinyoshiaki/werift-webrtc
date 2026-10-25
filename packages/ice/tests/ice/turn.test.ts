import type { Address } from "../../../common/src";
import { Candidate } from "../../src/candidate";
import { methods } from "../../src/stun/const";
import type { Message } from "../../src/stun/message";
import type {
  StunOverTurnProtocol,
  TurnProtocol,
} from "../../src/turn/protocol";
import { getHostAddresses } from "../../src/utils";
import {
  TURN_TEST_PASSWORD,
  TURN_TEST_USERNAME,
  createLocalTurnServer,
  createTestConnection,
  getLocalTurnClientTlsOptions,
} from "../utils";

const localTurnHost = getHostAddresses(true, false)[0]!;

/** Peer address that will be forced to fail CreatePermission/ChannelBind. */
const REJECTED_PEER: Address = ["198.51.100.99", 9];

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

    // 接続前から relay-only の設定どおり relay 候補だけが収集されていることを確認する。
    expect(a.localCandidates.length).toBeGreaterThan(0);
    expect(b.localCandidates.length).toBeGreaterThan(0);
    expect(
      a.localCandidates.every((candidate) => candidate.type === "relay"),
    ).toBe(true);
    expect(
      b.localCandidates.every((candidate) => candidate.type === "relay"),
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

type ConnectionWithProtocols = {
  // Connection.protocols is private; tests reach it via structural cast.
  protocols: Array<{ type?: string; turn?: TurnProtocol }>;
};

/**
 * Issue #667 ICE path: a rejected peer is tried first on the controlling
 * side; isolation must still allow a later valid relay pair to nominate.
 */
function installRejectedPeerTurnHook(connection: object): {
  rejectedSeen: () => boolean;
} {
  const protocols = (connection as ConnectionWithProtocols).protocols;
  const stunOverTurn = protocols.find((p) => p.type === "turn") as
    | StunOverTurnProtocol
    | undefined;
  if (!stunOverTurn?.turn) {
    throw new Error("expected StunOverTurnProtocol after forceTurn gather");
  }

  const turn = stunOverTurn.turn;
  const original = turn.requestWithRetry.bind(turn);
  let rejectedSeen = false;

  turn.requestWithRetry = async (request: Message, addr: Address) => {
    const method = request.messageMethod;
    if (
      method === methods.CHANNEL_BIND ||
      method === methods.CREATE_PERMISSION
    ) {
      const peer = request.getAttributeValue("XOR-PEER-ADDRESS") as Address;
      if (peer[0] === REJECTED_PEER[0] && peer[1] === REJECTED_PEER[1]) {
        rejectedSeen = true;
        throw new Error("simulated TURN rejection for bad peer");
      }
    }
    return original(request, addr);
  };

  return { rejectedSeen: () => rejectedSeen };
}

function highPriorityRejectedRemoteCandidate(ufrag: string): Candidate {
  // Higher priority than typical relay remotes so checklist tries this first.
  return new Candidate(
    "rejected-peer",
    1,
    "udp",
    2_130_706_431,
    REJECTED_PEER[0],
    REJECTED_PEER[1],
    "relay",
    undefined,
    undefined,
    undefined,
    0,
    ufrag,
  );
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

  test("after rejected remote peer is tried first, valid relay pair still nominates and exchanges data", async () => {
    // Arrange: local NodeTurnServer + forceTurn 両端
    const server = await createLocalTurnServer(localTurnHost!);
    const turnServer = server.address!;
    const connectionOptions = {
      stunServer: undefined,
      turnServer,
      turnUsername: TURN_TEST_USERNAME,
      turnPassword: TURN_TEST_PASSWORD,
      turnTransport: "udp" as const,
      forceTurn: true,
    };
    const a = createTestConnection(true, connectionOptions);
    const b = createTestConnection(false, connectionOptions);

    try {
      await a.gatherCandidates();
      await b.gatherCandidates();

      // A 側だけ拒否 peer 向け TURN 操作を強制 fail させる
      const hook = installRejectedPeerTurnHook(a);

      const bRelay = b.localCandidates.filter((c) => c.type === "relay");
      const aRelay = a.localCandidates.filter((c) => c.type === "relay");
      expect(bRelay.length).toBeGreaterThan(0);
      expect(aRelay.length).toBeGreaterThan(0);

      // Act: 拒否候補を先に並べ、続けて正常 relay を渡す
      a.remoteCandidates = [
        highPriorityRejectedRemoteCandidate(b.localUsername),
        ...bRelay,
      ];
      a.remoteUsername = b.localUsername;
      a.remotePassword = b.localPassword;

      b.remoteCandidates = aRelay;
      b.remoteUsername = a.localUsername;
      b.remotePassword = a.localPassword;

      await Promise.all([a.connect(), b.connect()]);

      // Assert: 拒否 peer が実際に試されたうえで valid relay が nominated
      expect(hook.rejectedSeen()).toBe(true);
      expect(a.nominated?.localCandidate.type).toBe("relay");
      expect(a.nominated?.remoteCandidate.type).toBe("relay");
      expect(a.nominated?.remoteCandidate.host).not.toBe(REJECTED_PEER[0]);
      expect(a.nominated?.remoteCandidate.port).not.toBe(REJECTED_PEER[1]);

      // Assert: 双方向データ
      await a.send(Buffer.from("after-reject-howdee"));
      let [data] = await b.onData.asPromise();
      expect(data.toString()).toBe("after-reject-howdee");

      await b.send(Buffer.from("after-reject-gotcha"));
      [data] = await a.onData.asPromise();
      expect(data.toString()).toBe("after-reject-gotcha");
    } finally {
      await a.close();
      await b.close();
      await server.close();
    }
  }, 30_000);
});
