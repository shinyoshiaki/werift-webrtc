import { setTimeout } from "timers/promises";

import {
  type DtlsTransportConfig,
  type DtlsVersion,
  RTCDtlsTransport,
  RTCIceGatherer,
  RTCIceTransport,
  RTCPeerConnection,
  type RTCPeerConnectionConfig,
  type RTCSessionDescription,
  RtpHeader,
  RtpPacket,
  defaultPeerConfig,
  isDtls,
} from "../src";
import { RtpRouter } from "../src/media/router";
import { exchangeIceCandidates } from "./utils";

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
    defaultPeerConfig,
    new RTCIceTransport(new RTCIceGatherer()),
  );
  return dtls;
};

export async function generateOffer() {
  const pc = new RTCPeerConnection();
  const offer = await pc.createOffer();
  pc.close();
  return offer;
}

export async function generateAnswer(offer: RTCSessionDescription) {
  const pc = new RTCPeerConnection();
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  pc.close();
  return answer;
}

export function dtlsPeerConfig(
  protocolVersions?: readonly DtlsVersion[],
  helloRetryRequest?: boolean,
): RTCPeerConnectionConfig {
  return {
    iceServers: [],
    dtls: {
      protocolVersions,
      helloRetryRequest,
    },
  };
}

export async function dtlsTransportPair(config: DtlsTransportConfig = {}) {
  const [transport1, transport2] = await iceTransportPair();
  await setTimeout(100);
  transport1.connection.iceControlling = true;
  transport2.connection.iceControlling = false;

  await RTCDtlsTransport.SetupCertificate();

  const session1 = new RTCDtlsTransport(config, transport1);

  const session2 = new RTCDtlsTransport(config, transport2);

  session1.setRemoteParams(session2.localParameters);
  session2.setRemoteParams(session1.localParameters);
  await Promise.all([session1.start(), session2.start()]);

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

  expect(transport1.state).toBe("new");
  expect(transport2.state).toBe("new");

  await Promise.all([gatherer1.gather(), gatherer2.gather()]);

  gatherer2.localCandidates.forEach(transport1.addRemoteCandidate);
  gatherer1.localCandidates.forEach(transport2.addRemoteCandidate);
  expect(transport1.state).toBe("completed");
  expect(transport2.state).toBe("completed");

  transport1.setRemoteParams(gatherer2.localParameters);
  transport2.setRemoteParams(gatherer1.localParameters);
  await Promise.all([transport1.start(), transport2.start()]);

  return [transport1, transport2];
};

const HRR_RANDOM = Buffer.from(
  "CF21AD74E59A6111BE1D8C021E65B891C2A211167ABB8C5E079E09E2C8A8339C",
  "hex",
);
const COOKIE_EXTENSION_TYPE = 44;
const CONTENT_HANDSHAKE = 22;
const HS_SERVER_HELLO = 2;

export async function negotiateWithDtlsCapture(
  offerer: RTCPeerConnection,
  answerer: RTCPeerConnection,
) {
  exchangeIceCandidates(offerer, answerer);
  const offererDatagrams = attachDtlsDatagramCapture(offerer);
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription!);
  const answererDatagrams = attachDtlsDatagramCapture(answerer);
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(answerer.localDescription!);
  return { offererDatagrams, answererDatagrams };
}

export function attachDtlsDatagramCapture(pc: RTCPeerConnection) {
  const datagrams: Buffer[] = [];
  for (const dtls of pc.dtlsTransports) {
    dtls.iceTransport.connection.onData.subscribe((buf) => {
      if (isDtls(buf)) {
        datagrams.push(Buffer.from(buf));
      }
    });
  }
  return datagrams;
}

export function inspectCookieHelloRetryRequests(datagrams: Buffer[]) {
  const hits: { hasCookie: boolean }[] = [];
  for (const datagram of datagrams) {
    let offset = 0;
    while (offset + 13 <= datagram.length) {
      const contentType = datagram[offset];
      const length = datagram.readUInt16BE(offset + 11);
      const fragmentStart = offset + 13;
      const fragmentEnd = fragmentStart + length;
      if (fragmentEnd > datagram.length) {
        break;
      }
      if (contentType === CONTENT_HANDSHAKE && length >= 12) {
        const hsType = datagram[fragmentStart];
        if (hsType === HS_SERVER_HELLO) {
          const body = datagram.subarray(fragmentStart + 12, fragmentEnd);
          const parsed = parseServerHelloHrr(body);
          if (parsed?.isHrr) {
            hits.push({ hasCookie: parsed.hasCookie });
          }
        }
      }
      offset = fragmentEnd;
    }
  }
  return hits;
}

function parseServerHelloHrr(body: Buffer) {
  if (body.length < 2 + 32 + 1) {
    return;
  }
  const random = body.subarray(2, 34);
  const isHrr = random.equals(HRR_RANDOM);
  if (!isHrr) {
    return { isHrr: false, hasCookie: false };
  }
  let offset = 34;
  const sessionIdLen = body[offset];
  offset += 1 + sessionIdLen;
  offset += 2;
  offset += 1;
  if (offset + 2 > body.length) {
    return { isHrr: true, hasCookie: false };
  }
  const extLen = body.readUInt16BE(offset);
  offset += 2;
  const extEnd = Math.min(body.length, offset + extLen);
  let hasCookie = false;
  while (offset + 4 <= extEnd) {
    const type = body.readUInt16BE(offset);
    const len = body.readUInt16BE(offset + 2);
    if (type === COOKIE_EXTENSION_TYPE) {
      hasCookie = true;
    }
    offset += 4 + len;
  }
  return { isHrr: true, hasCookie };
}
