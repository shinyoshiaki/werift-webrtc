import { RTCIceGatherer, RTCIceTransport } from "../../src";
import { iceTransportPair } from "../fixture";

describe("iceTransport", () => {
  test("test_connect", async () => {
    const gatherer1 = new RTCIceGatherer({
      stunServer: ["stun.l.google.com", 19302],
    });
    const transport1 = new RTCIceTransport(gatherer1);
    transport1.connection.iceControlling = true;

    const gatherer2 = new RTCIceGatherer({
      stunServer: ["stun.l.google.com", 19302],
    });
    const transport2 = new RTCIceTransport(gatherer2);
    transport2.connection.iceControlling = false;

    expect(transport1.state).toBe("new");
    expect(transport2.state).toBe("new");

    await Promise.all([gatherer1.gather(), gatherer2.gather()]);

    expect(transport1.state).toBe("completed");
    expect(transport2.state).toBe("completed");

    gatherer2.localCandidates.forEach(transport1.addRemoteCandidate);
    gatherer1.localCandidates.forEach(transport2.addRemoteCandidate);

    transport1.setRemoteParams(gatherer2.localParameters);
    transport2.setRemoteParams(gatherer1.localParameters);
    await Promise.all([transport1.start(), transport2.start()]);
    expect(transport1.state).toBe("connected");
    expect(transport2.state).toBe("connected");

    await Promise.all([transport1.stop(), transport2.stop()]);
    expect(transport1.state).toBe("closed");
    expect(transport2.state).toBe("closed");
  });

  test.skip("portRange", async () => {
    const gatherer = new RTCIceGatherer({
      stunServer: ["stun.l.google.com", 19302],
      portRange: [44444, 44455],
    });

    await gatherer.gather();

    const candidates = gatherer.localCandidates;
    for (const candidate of candidates) {
      expect(candidate.port >= 44444 && candidate.port < 44455).toBeTruthy();
    }
    await gatherer.connection.close();
  });

  test.skip("minimum target port", async () => {
    const gatherer = new RTCIceGatherer({
      stunServer: ["stun.l.google.com", 19302],
      portRange: [44546, 44547],
    });

    await gatherer.gather();

    const candidates = gatherer.localCandidates;
    for (const candidate of candidates) {
      expect(
        candidate.port >= 44546 && candidate.port < 44547 + 1,
      ).toBeTruthy();
    }
    await gatherer.connection.close();
  });

  test("getStats keeps candidate ids stable until restart and does not reuse them after restart", async () => {
    const gatherer = new RTCIceGatherer();
    const transport = new RTCIceTransport(gatherer);

    await gatherer.gather();

    // Act: restart 前に 2 回 stats を取り、同じ monitored object を確認する。
    const beforeRestart = await transport.getStats();
    const beforeRestartAgain = await transport.getStats();

    // Assert: restart 前は local candidate の id が安定している。
    const firstIds = beforeRestart
      .filter((stat) => stat.type === "local-candidate")
      .map((stat) => stat.id)
      .sort();
    const secondIds = beforeRestartAgain
      .filter((stat) => stat.type === "local-candidate")
      .map((stat) => stat.id)
      .sort();
    expect(secondIds).toEqual(firstIds);

    transport.restart();
    await gatherer.gather();

    // Act: restart 後の candidate id を取得する。
    const afterRestart = await transport.getStats();

    // Assert: restart 後は以前の id を再利用しない。
    const restartedIds = new Set(
      afterRestart
        .filter((stat) => stat.type === "local-candidate")
        .map((stat) => stat.id),
    );
    expect(firstIds.every((id) => !restartedIds.has(id))).toBe(true);

    await transport.stop();
  });

  test("getStats keeps candidate-pair ids stable until restart and does not reuse them after restart", async () => {
    const [transport1, transport2] = await iceTransportPair();

    // Act: restart 前に 2 回 stats を取り、同じ candidate-pair を確認する。
    const beforeRestart = await transport1.getStats();
    const beforeRestartAgain = await transport1.getStats();

    // Assert: restart 前は candidate-pair の id が安定している。
    const firstPairIds = beforeRestart
      .filter((stat) => stat.type === "candidate-pair")
      .map((stat) => stat.id)
      .sort();
    const secondPairIds = beforeRestartAgain
      .filter((stat) => stat.type === "candidate-pair")
      .map((stat) => stat.id)
      .sort();
    expect(firstPairIds.length).toBeGreaterThan(0);
    expect(secondPairIds).toEqual(firstPairIds);

    transport1.restart();
    transport2.restart();
    await Promise.all([transport1.gather(), transport2.gather()]);

    transport2.localCandidates.forEach(transport1.addRemoteCandidate);
    transport1.localCandidates.forEach(transport2.addRemoteCandidate);
    transport1.setRemoteParams(transport2.localParameters);
    transport2.setRemoteParams(transport1.localParameters);

    // Act: restart 後の candidate-pair id を取得する。
    const afterRestart = await transport1.getStats();

    // Assert: restart 後は以前の pair id を再利用しない。
    const restartedPairIds = new Set(
      afterRestart
        .filter((stat) => stat.type === "candidate-pair")
        .map((stat) => stat.id),
    );
    expect(firstPairIds.every((id) => !restartedPairIds.has(id))).toBe(true);

    await Promise.all([transport1.stop(), transport2.stop()]);
  });
});
