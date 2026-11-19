import { getHostAddresses } from "../../src/utils";
import {
  collectGarbage,
  createLocalStunServer,
  createTestConnection,
} from "../utils";

const localStunHost = getHostAddresses(true, false)[0];
const testWithLocalStun = localStunHost ? test : test.skip;

describe("ICE restart gathering", () => {
  testWithLocalStun(
    "a restart re-queries STUN on the kept sockets so the new generation has srflx again",
    async () => {
      // Arrange: ローカル STUN server を使って最初の generation を gather する。
      const server = await createLocalStunServer(localStunHost!);
      const connection = createTestConnection(true, {
        stunServer: server.address,
        useIpv6: false,
      });
      try {
        await connection.gatherCandidates();
        await connection.waitForLocalCandidatesEnd();
        const hostPorts = connection.localCandidates
          .filter((c) => c.type === "host" && c.transport === "udp")
          .map((c) => c.port)
          .sort();
        // srflx の base: host socket (関連アドレス = host) と wildcard socket (0.0.0.0)
        const srflxBases = (candidates: typeof connection.localCandidates) =>
          candidates
            .filter((c) => c.type === "srflx")
            .map((c) => `${c.relatedAddress}:${c.relatedPort}`)
            .sort();
        const initialBases = srflxBases(connection.localCandidates);
        expect(initialBases.length).toBeGreaterThan(0);

        // Act: ICE restart して新 generation を gather する。
        await connection.restart();
        await connection.gatherCandidates();
        await connection.waitForLocalCandidatesEnd();

        // Assert: socket は再利用され (host port 不変)、srflx も新 generation に
        // 同じ base (host socket と wildcard socket) から再び載る。
        const restarted = connection.localCandidates;
        expect(
          restarted
            .filter((c) => c.type === "host" && c.transport === "udp")
            .map((c) => c.port)
            .sort(),
        ).toEqual(hostPorts);
        expect(srflxBases(restarted)).toEqual(initialBases);
        for (const candidate of restarted.filter((c) => c.type === "srflx")) {
          expect(
            candidate.relatedAddress === "0.0.0.0" ||
              hostPorts.includes(candidate.relatedPort!),
          ).toBe(true);
        }
      } finally {
        await connection.close();
        await server.close();
      }
    },
  );

  testWithLocalStun(
    "a restart whose STUN query gets no answer keeps the srflx the socket already advertised",
    async () => {
      // Arrange: 最初の generation の srflx を得た後、STUN server を止める。
      const server = await createLocalStunServer(localStunHost!);
      const connection = createTestConnection(true, {
        stunServer: server.address,
        stunGatherTimeout: 1,
        useIpv6: false,
      });
      try {
        await connection.gatherCandidates();
        const before = connection.localCandidates
          .filter((c) => c.type === "srflx")
          .map((c) => `${c.host}:${c.port}:${c.relatedPort}`)
          .sort();
        expect(before.length).toBeGreaterThan(0);
        await server.close();

        // Act: STUN が応答しない状態で ICE restart して gather する。
        await connection.restart();
        await connection.gatherCandidates();

        // Assert: 同じ socket の srflx は新 generation でも一度ずつ広告される。
        const after = connection.localCandidates
          .filter((c) => c.type === "srflx")
          .map((c) => `${c.host}:${c.port}:${c.relatedPort}`)
          .sort();
        expect(after).toEqual(before);
      } finally {
        await connection.close();
      }
    },
  );

  test("a finished gathering keeps nothing alive until close: earlier generations' results are collected", async () => {
    // Arrange: loopback だけで gather する agent。各 gathering の primary に、他から参照されない
    // 目印の結果を 1 つ足し、WeakRef で追う (host socket の候補は socket が持ち続けるので使わない)。
    const connection = createTestConnection(true, {
      interfaceAddresses: { udp4: "127.0.0.1" },
      useIpv6: false,
    });
    const gatherer = (connection as any).gatherer;
    const original = gatherer.candidatePromises.bind(gatherer);
    const markers: WeakRef<object>[] = [];
    gatherer.candidatePromises = (...args: unknown[]) => {
      const promises = original(...args);
      const marker = { generation: markers.length };
      markers.push(new WeakRef(marker));
      promises.primary.push(Promise.resolve(marker));
      return promises;
    };
    try {
      // Act: ICE restart と gather を繰り返し、最後の generation 以外を手放させる。
      for (let i = 0; i < 4; i++) {
        if (i > 0) await connection.restart();
        await connection.gatherCandidates();
        await connection.waitForLocalCandidatesEnd();
      }
      await collectGarbage();

      // Assert: 前の generation の gathering の結果は close 前でも回収される
      // (close まで解決しない Promise に race すると、その反応が結果を保持し続ける)。
      expect(markers).toHaveLength(4);
      expect(
        markers
          .slice(0, -1)
          .map((ref) => ref.deref())
          .filter((marker) => marker !== undefined),
      ).toEqual([]);
    } finally {
      await connection.close();
    }
  });
});
