import {
  RTCCertificate,
  RTCDtlsTransport
} from "../../../../src/rtc/transport/dtls";
import { RTCIceGatherer, RTCIceTransport } from "../../../../src";
import { sleep } from "../../../../src/utils";

describe("RTCDtlsTransportTest", () => {
  test("test_data", async () => {
    const [transport1, transport2] = await iceTransportPair();

    const certificate1 = RTCCertificate.generateCertificate();
    const session1 = new RTCDtlsTransport(transport1, [certificate1]);
    const receiver1 = new DummyDataReceiver();
    session1.registerDataReceiver(receiver1 as any);

    const certificate2 = RTCCertificate.generateCertificate();
    const session2 = new RTCDtlsTransport(transport2, [certificate2]);
    const receiver2 = new DummyDataReceiver();
    session2.registerDataReceiver(receiver2 as any);

    await Promise.all([
      session1.start(session2.getLocalParameters()),
      session2.start(session1.getLocalParameters())
    ]);

    session1.sendData(Buffer.from("ping"));
    await sleep(100);
    expect(receiver2.data).toEqual([Buffer.from("ping")]);
  });
});

class DummyDataReceiver {
  data: Buffer[] = [];
  handleData(data: Buffer) {
    this.data.push(data);
  }
}

const iceTransportPair = async () => {
  const gatherer1 = new RTCIceGatherer();
  const transport1 = new RTCIceTransport(gatherer1);

  const gatherer2 = new RTCIceGatherer();
  const transport2 = new RTCIceTransport(gatherer2);

  await Promise.all([gatherer1.gather(), gatherer2.gather()]);

  gatherer2.getLocalCandidates().forEach(transport1.addRemoteCandidate);
  gatherer1.getLocalCandidates().forEach(transport2.addRemoteCandidate);
  expect(transport1.state).toBe("new");
  expect(transport2.state).toBe("new");

  await Promise.all([
    transport1.start(gatherer2.getLocalParameters()),
    transport2.start(gatherer1.getLocalParameters())
  ]);

  return [transport1, transport2];
};
