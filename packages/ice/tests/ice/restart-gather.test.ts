import { getHostAddresses } from "../../src/utils";
import { createLocalStunServer, createTestConnection } from "../utils";

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
        const hostPorts = connection.localCandidates
          .filter((c) => c.type === "host" && c.transport === "udp")
          .map((c) => c.port)
          .sort();
        expect(connection.localCandidates.some((c) => c.type === "srflx")).toBe(
          true,
        );

        // Act: ICE restart して新 generation を gather する。
        await connection.restart();
        await connection.gatherCandidates();

        // Assert: socket は再利用され (host port 不変)、srflx も新 generation に再び載る。
        const restarted = connection.localCandidates;
        expect(
          restarted
            .filter((c) => c.type === "host" && c.transport === "udp")
            .map((c) => c.port)
            .sort(),
        ).toEqual(hostPorts);
        const srflx = restarted.filter((c) => c.type === "srflx");
        expect(srflx.length).toBeGreaterThan(0);
        for (const candidate of srflx) {
          expect(hostPorts).toContain(candidate.relatedPort);
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
});
