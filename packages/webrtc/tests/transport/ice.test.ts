import { RTCIceGatherer, RTCIceTransport } from "../../src";

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

    await Promise.all([gatherer1.gather(), gatherer2.gather()]);

    gatherer2.localCandidates.forEach(transport1.addRemoteCandidate);
    gatherer1.localCandidates.forEach(transport2.addRemoteCandidate);
    expect(transport1.state).toBe("new");
    expect(transport2.state).toBe("new");

    await Promise.all([
      transport1.start(gatherer2.localParameters),
      transport2.start(gatherer1.localParameters),
    ]);
    expect(transport1.state).toBe("completed");
    expect(transport2.state).toBe("completed");

    await Promise.all([transport1.stop(), transport2.stop()]);
    expect(transport1.state).toBe("closed");
    expect(transport2.state).toBe("closed");
  });
});
