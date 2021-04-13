import {
  RTCDtlsTransport,
  RTCIceGatherer,
  RTCIceTransport,
  RTCPeerConnection,
  RTCSessionDescription,
  RtpHeader,
  RtpPacket,
  sleep,
} from "../src";
import { RtpRouter } from "../src/media/router";

export const createRtpPacket = () => {
  const header = new RtpHeader({
    sequenceNumber: 0,
    timestamp: 0,
    payloadType: 96,
    payloadOffset: 12,
    extension: true,
    marker: false,
    padding: false,
  });
  const rtp = new RtpPacket(header, Buffer.from([]));
  return rtp;
};

export const createDtlsTransport = () => {
  const dtls = new RTCDtlsTransport(
    new RTCIceTransport(new RTCIceGatherer()),
    new RtpRouter(),
    []
  );
  return dtls;
};

export async function generateAnswer(offer: RTCSessionDescription) {
  const pc = new RTCPeerConnection();
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  pc.close();
  return answer;
}

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
