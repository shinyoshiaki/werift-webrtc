import {
  RTCCertificate,
  RTCDtlsTransport,
} from "../../../src/rtc/transport/dtls";
import { RTCIceGatherer, RTCIceTransport } from "../../../src";
import { sleep } from "../../../src/utils";

export async function dtlsTransportPair() {
  const [transport1, transport2] = await iceTransportPair();
  await sleep(100);
  transport1.connection.iceControlling = true;
  transport2.connection.iceControlling = false;

  const certificate1 = RTCCertificate.generateCertificate();
  const session1 = new RTCDtlsTransport(transport1, [certificate1]);

  const certificate2 = RTCCertificate.generateCertificate();
  const session2 = new RTCDtlsTransport(transport2, [certificate2]);

  await Promise.all([
    session1.start(session2.getLocalParameters()),
    session2.start(session1.getLocalParameters()),
  ]);

  if (session1.role === "client") {
    return [session1, session2];
  } else {
    return [session2, session1];
  }
}

describe("RTCDtlsTransportTest", () => {
  test(
    "dtls_test_data",
    async () => {
      const [session1, session2] = await dtlsTransportPair();
      const receiver2 = new DummyDataReceiver();
      session2.dataReceiver = receiver2.handleData;

      session1.sendData(Buffer.from("ping"));
      await sleep(100);
      expect(receiver2.data).toEqual([Buffer.from("ping")]);
    },
    60 * 1000
  );
});

class DummyDataReceiver {
  data: Buffer[] = [];
  handleData = (data: Buffer) => {
    this.data.push(data);
  };
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
    transport2.start(gatherer1.getLocalParameters()),
  ]);

  return [transport1, transport2];
};
