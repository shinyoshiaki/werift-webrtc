import { RTCDtlsTransport } from "../../../src/transport/dtls";
import { RTCIceGatherer, RTCIceTransport } from "../../../src";
import { sleep } from "../../../src/helper";
import { RtpRouter } from "../../../src/media/router";

describe("RTCDtlsTransportTest", () => {
  test("dtls_test_data", async () => {
    const [session1, session2] = await dtlsTransportPair();
    const receiver2 = new DummyDataReceiver();
    session2.dataReceiver = receiver2.handleData;

    session1.sendData(Buffer.from("ping"));
    await sleep(100);
    expect(receiver2.data).toEqual([Buffer.from("ping")]);
  });
});

export async function dtlsTransportPair() {
  const [transport1, transport2] = await iceTransportPair();
  await sleep(100);
  transport1.connection.iceControlling = true;
  transport2.connection.iceControlling = false;

  const session1 = new RTCDtlsTransport(transport1, new RtpRouter(), []);
  await session1.setupCertificate();

  const session2 = new RTCDtlsTransport(transport2, new RtpRouter(), []);
  await session2.setupCertificate();

  await Promise.all([
    session1.start(session2.localParameters),
    session2.start(session1.localParameters),
  ]);

  if (session1.role === "client") {
    return [session1, session2];
  } else {
    return [session2, session1];
  }
}

class DummyDataReceiver {
  data: Buffer[] = [];
  handleData = (data: Buffer) => {
    this.data.push(data);
  };
}

export const iceTransportPair = async () => {
  const gatherer1 = new RTCIceGatherer();
  const transport1 = new RTCIceTransport(gatherer1);
  transport1.connection.iceControlling = true;
  const gatherer2 = new RTCIceGatherer();
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

  return [transport1, transport2];
};
