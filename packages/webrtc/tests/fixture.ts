import { randomBytes } from "crypto";
import { setTimeout } from "timers/promises";

import { vi } from "vitest";
import {
  codecParametersToString,
  type DtlsTransportConfig,
  type DtlsVersion,
  defaultPeerConfig,
  isDtls,
  type Kind,
  MediaStreamTrack,
  RTCDtlsTransport,
  RTCIceGatherer,
  RTCIceTransport,
  RTCPeerConnection,
  type RTCPeerConnectionConfig,
  RTCRtpCodecParameters,
  RTCRtpHeaderExtensionParameters,
  type RTCSessionDescription,
  RTP_EXTENSION_URI,
  RtpHeader,
  RtpPacket,
} from "../src";
import {
  ProtectionProfileAes128CmHmacSha1_80,
  SrtpSession,
} from "../src/imports/rtp";
import { RTCRtpSender } from "../src/media/rtpSender";
import type { SenderBandwidthEstimator } from "../src/media/sender/senderBWE";
import { exchangeIceCandidates } from "./utils";

export const createRtpPacket = (
  sequenceNumber = 0,
  timestamp = 0,
  payload: Buffer = Buffer.from([]),
) => {
  const header = new RtpHeader({
    sequenceNumber,
    timestamp,
    payloadType: 96,
    payloadOffset: 12,
    extension: true,
    marker: false,
    padding: false,
  });
  const rtp = new RtpPacket(header, payload);
  return rtp;
};

export const createDtlsTransport = () => {
  const dtls = new RTCDtlsTransport(
    defaultPeerConfig,
    new RTCIceTransport(new RTCIceGatherer()),
  );
  return dtls;
};

export function createAudioCodec(payloadType = 96) {
  return new RTCRtpCodecParameters({
    mimeType: "audio/opus",
    clockRate: 48000,
    payloadType,
  });
}

export function createRtxCodec(payloadType = 97, apt = 96) {
  return new RTCRtpCodecParameters({
    mimeType: "audio/rtx",
    clockRate: 48000,
    payloadType,
    parameters: codecParametersToString({ apt }),
  });
}

export function createConnectedRtpSender(options?: {
  kind?: Kind;
  track?: MediaStreamTrack;
  rtx?: boolean;
  twcc?: boolean;
  cname?: string;
  /** encrypt sendRtp with a real SrtpSession and decrypt it on a peer session */
  srtpLoopback?: boolean;
}) {
  const kind = options?.kind ?? "audio";
  const track = options?.track ?? new MediaStreamTrack({ kind, remote: true });
  const dtls = createDtlsTransport();
  dtls.state = "connected";
  const sender = new RTCRtpSender(track);
  sender.setDtlsTransport(dtls);

  const codecs = [createAudioCodec()];
  if (options?.rtx) {
    codecs.push(createRtxCodec());
  }
  const headerExtensions = options?.twcc
    ? [
        new RTCRtpHeaderExtensionParameters({
          id: 3,
          uri: RTP_EXTENSION_URI.transportWideCC,
        }),
      ]
    : [];

  sender.prepareSend({
    codecs,
    headerExtensions,
    rtcp: options?.cname ? { cname: options.cname, mux: false } : undefined,
  });

  const srtp = options?.srtpLoopback ? createSrtpLoopback() : undefined;
  const sendRtp = vi.spyOn(dtls, "sendRtp");
  if (srtp) {
    sendRtp.mockImplementation(async (payload, header) =>
      srtp.transmit(payload, header),
    );
  } else {
    sendRtp.mockResolvedValue(12);
  }
  const sendRtcp = vi
    .spyOn(dtls, "sendRtcp")
    .mockResolvedValue(undefined as never);

  return { sender, track, dtls, sendRtp, sendRtcp, srtp };
}

/**
 * SRTP sender session and a peer session with swapped keys.
 * `transmit` encrypts like `RTCDtlsTransport.sendRtp` and decrypts on the peer,
 * recording decrypted packets and authentication failures.
 */
export function createSrtpLoopback(
  profile: number = ProtectionProfileAes128CmHmacSha1_80,
) {
  const local = { masterKey: randomBytes(16), masterSalt: randomBytes(14) };
  const remote = { masterKey: randomBytes(16), masterSalt: randomBytes(14) };
  const sender = new SrtpSession({
    keys: {
      localMasterKey: local.masterKey,
      localMasterSalt: local.masterSalt,
      remoteMasterKey: remote.masterKey,
      remoteMasterSalt: remote.masterSalt,
    },
    profile,
  });
  const receiver = new SrtpSession({
    keys: {
      localMasterKey: remote.masterKey,
      localMasterSalt: remote.masterSalt,
      remoteMasterKey: local.masterKey,
      remoteMasterSalt: local.masterSalt,
    },
    profile,
  });

  const received: RtpPacket[] = [];
  const failures: { header: RtpHeader; error: Error }[] = [];
  /** seq numbers whose next transmission is encrypted but lost on the wire */
  const lost = new Set<number>();
  const loseNext = (sequenceNumber: number) => {
    lost.add(sequenceNumber);
  };

  const transmit = (payload: Buffer, header: RtpHeader) => {
    const encrypted = sender.encrypt(payload, header);
    if (lost.delete(header.sequenceNumber)) {
      return encrypted.length;
    }
    try {
      received.push(RtpPacket.deSerialize(receiver.decrypt(encrypted)));
    } catch (error) {
      failures.push({ header, error: error as Error });
    }
    return encrypted.length;
  };

  return { sender, receiver, received, failures, transmit, loseNext };
}

export type ConnectedRtpSenderSetup = ReturnType<
  typeof createConnectedRtpSender
>;

export function sentRtpHeaders(sendRtp: ConnectedRtpSenderSetup["sendRtp"]) {
  return sendRtp.mock.calls.map(([, header]) => header);
}

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

/** Arrange: gathered ICE transports with remote params set, not started yet. */
export const preparedIceTransportPair = async () => {
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

  return [transport1, transport2] as const;
};

export const iceTransportPair = async () => {
  const [transport1, transport2] = await preparedIceTransportPair();
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

/** Arrange: `count` packets sent through `estimator` from `firstSeq`, `sentAtMs` apart by `stepMs`. */
export function recordSentPackets(
  estimator: SenderBandwidthEstimator,
  {
    count,
    firstSeq = 0,
    sentAtMs = Date.now(),
    stepMs = 0,
  }: { count: number; firstSeq?: number; sentAtMs?: number; stepMs?: number },
) {
  for (let i = 0; i < count; i++) {
    const at = sentAtMs + i * stepMs;
    estimator.rtpPacketSent({
      wideSeq: (firstSeq + i) & 0xffff,
      size: 1000,
      sendingAtMs: at,
      sentAtMs: at,
    });
  }
}

/** Test-only read: the packets `estimator` keeps for transport-cc feedback. */
export function pendingFeedback(estimator: SenderBandwidthEstimator) {
  return (estimator as unknown as { sentInfos: Map<number, unknown> })
    .sentInfos;
}
