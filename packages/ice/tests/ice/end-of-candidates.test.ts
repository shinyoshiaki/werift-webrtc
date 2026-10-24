import {
  createConnectedPair,
  createTestConnection,
  provisionalGeneration,
  remoteHostCandidate,
  stubMdnsLookup,
} from "../utils";

/** Remote end-of-candidates completes a generation (RFC 8838). */
describe("remote end-of-candidates", () => {
  describe("current generation", () => {
    test("a candidate after end-of-candidates is ignored", async () => {
      const connection = createTestConnection(true);
      try {
        // Arrange: 1 つ目の候補と end-of-candidates を受けた generation。
        await connection.addRemoteCandidate(remoteHostCandidate(50000));
        await connection.addRemoteCandidate(undefined);

        // Act: 同じ generation に後から候補が届く。
        await connection.addRemoteCandidate(remoteHostCandidate(50001));

        // Assert: 完了済み generation の候補は増えない。
        expect(connection.remoteCandidatesEnd).toBe(true);
        expect(connection.remoteCandidates.map((c) => c.port)).toEqual([50000]);
      } finally {
        await connection.close();
      }
    });

    test("end-of-candidates waits for an mDNS candidate that arrived before it", async () => {
      const connection = createTestConnection(true);
      const mdns = stubMdnsLookup(connection);
      try {
        // Arrange: mDNS 候補の解決中に end-of-candidates と後続候補が届く。
        const resolving = connection.addRemoteCandidate(
          remoteHostCandidate(50000, "peer.local"),
        );
        const end = connection.addRemoteCandidate(undefined);
        const late = connection.addRemoteCandidate(remoteHostCandidate(50001));
        await late;

        // Assert: 解決が終わるまで generation は完了せず、EOC 後の候補は破棄される。
        expect(mdns.pending).toBe(1);
        expect(connection.remoteCandidatesEnd).toBe(false);
        expect(connection.remoteCandidates).toEqual([]);

        // Act: mDNS 解決を完了させる。
        mdns.resolveAll("127.0.0.1");
        await Promise.all([resolving, end]);

        // Assert: EOC 前に届いた候補だけが入り、その後に generation が完了する。
        expect(connection.remoteCandidates.map((c) => c.port)).toEqual([50000]);
        expect(connection.remoteCandidatesEnd).toBe(true);
      } finally {
        await connection.close();
      }
    });

    test("an mDNS candidate resolved after an ICE restart is dropped", async () => {
      const connection = createTestConnection(true);
      const mdns = stubMdnsLookup(connection);
      try {
        // Arrange: 旧 generation の mDNS 候補が解決中。
        const resolving = connection.addRemoteCandidate(
          remoteHostCandidate(50000, "peer.local"),
        );

        // Act: ICE restart で generation を切り替えてから解決を完了させる。
        await connection.restart();
        mdns.resolveAll("127.0.0.1");
        await resolving;

        // Assert: 旧 generation の候補は新 generation に入らない。
        expect(connection.remoteCandidates).toEqual([]);
        expect(connection.remoteCandidatesEnd).toBe(false);
      } finally {
        await connection.close();
      }
    });
  });

  describe("provisional generation", () => {
    const remote = {
      usernameFragment: "provB",
      password: "provisional-password-b-000",
    };

    test("a candidate after end-of-candidates reaches neither candidates nor checklist", async () => {
      const { a, b } = await createConnectedPair();
      try {
        // Arrange: pranswer の restart generation に候補 1 つと EOC を適用する。
        a.stageLocalCredentials("provA", "provisional-password-a-000");
        a.setProvisionalRemoteParams(remote);
        await a.addProvisionalRemoteCandidate(remoteHostCandidate(50000));
        await a.addProvisionalRemoteCandidate(undefined);
        const pairs = provisionalGeneration(a)!.pairs.length;

        // Act: 同じ ufrag の候補が EOC の後に届く。
        await a.addProvisionalRemoteCandidate(remoteHostCandidate(50001));

        // Assert: provisional の候補と checklist は完了時点のまま。
        const generation = provisionalGeneration(a)!;
        expect(generation.remoteCandidatesEnd).toBe(true);
        expect(generation.remoteCandidates.map((c) => c.port)).toEqual([50000]);
        expect(generation.pairs).toHaveLength(pairs);
        expect(
          generation.pairs.some((pair) => pair.remoteCandidate.port === 50001),
        ).toBe(false);
      } finally {
        await Promise.all([a.close(), b.close()]);
      }
    });

    test("end-of-candidates waits for an mDNS candidate that arrived before it", async () => {
      const { a, b } = await createConnectedPair();
      const mdns = stubMdnsLookup(a);
      try {
        // Arrange: provisional の mDNS 候補の解決中に EOC と後続候補が届く。
        a.stageLocalCredentials("provA", "provisional-password-a-000");
        a.setProvisionalRemoteParams(remote);
        const resolving = a.addProvisionalRemoteCandidate(
          remoteHostCandidate(50000, "peer.local"),
        );
        const end = a.addProvisionalRemoteCandidate(undefined);
        await a.addProvisionalRemoteCandidate(remoteHostCandidate(50001));

        // Assert: 解決中は完了せず、EOC 後の候補は入らない。
        expect(provisionalGeneration(a)!.remoteCandidatesEnd).toBe(false);
        expect(provisionalGeneration(a)!.remoteCandidates).toEqual([]);

        // Act: mDNS 解決を完了させる。
        mdns.resolveAll("127.0.0.1");
        await Promise.all([resolving, end]);

        // Assert: EOC 前の候補だけが checklist に入り、その後に完了する。
        const generation = provisionalGeneration(a)!;
        expect(generation.remoteCandidates.map((c) => c.port)).toEqual([50000]);
        expect(
          generation.pairs.every((pair) => pair.remoteCandidate.port === 50000),
        ).toBe(true);
        expect(generation.remoteCandidatesEnd).toBe(true);
      } finally {
        await Promise.all([a.close(), b.close()]);
      }
    });

    test("an mDNS candidate resolved after a replacement pranswer is dropped", async () => {
      const { a, b } = await createConnectedPair();
      const mdns = stubMdnsLookup(a);
      try {
        // Arrange: 旧 pranswer generation の mDNS 候補が解決中。
        a.stageLocalCredentials("provA", "provisional-password-a-000");
        a.setProvisionalRemoteParams(remote);
        const resolving = a.addProvisionalRemoteCandidate(
          remoteHostCandidate(50000, "peer.local"),
        );

        // Act: replacement pranswer で checklist を作り直してから解決を完了させる。
        a.setProvisionalRemoteParams({
          usernameFragment: "provB2",
          password: "provisional-password-b-001",
        });
        mdns.resolveAll("127.0.0.1");
        await resolving;

        // Assert: 置き換えられた generation の候補は新しい checklist に入らない。
        const generation = provisionalGeneration(a)!;
        expect(generation.remoteCandidates).toEqual([]);
        expect(generation.pairs).toEqual([]);
      } finally {
        await Promise.all([a.close(), b.close()]);
      }
    });
  });
});
