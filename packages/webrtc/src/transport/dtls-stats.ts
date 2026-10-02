import type { Connection } from "../../../ice/src";
import { getConnectionSpedRuntime } from "../../../ice/src/internal/sped-bind";
import type { DtlsSocket } from "../imports/dtls";
import {
  type RTCCertificateStats,
  type RTCStats,
  type RTCTransportStats,
  generateStatsId,
} from "../media/stats";
import type { RTCCertificate, RTCDtlsFingerprint } from "./dtls-certificate";
import type { DtlsRole, DtlsState, DtlsTransportStats } from "./dtls-types";
import type { RTCIceTransport } from "./ice";

function formatDtlsVersion(socket?: DtlsSocket) {
  if (!socket) {
    return;
  }
  if (socket.isDtls13) {
    return "DTLS 1.3";
  }
  const version = socket.dtls?.version;
  if (!version) return;
  if (version.major === 0xfe && version.minor === 0xfd) {
    return "DTLS 1.2";
  }
  if (version.major === 0xfe && version.minor === 0xff) {
    return "DTLS 1.0";
  }
}

function formatDtlsCipher(socket?: DtlsSocket) {
  if (!socket) {
    return;
  }
  if (socket.isDtls13) {
    return "TLS_AES_128_GCM_SHA256";
  }
  return socket.cipher?.cipher?.name;
}

function formatSrtpCipher(profile?: number) {
  switch (profile) {
    case 0x0001:
      return "AES_CM_128_HMAC_SHA1_80";
    case 0x0007:
      return "AEAD_AES_128_GCM";
    default:
      return;
  }
}

type EarlyQueueStats = {
  bufferedPackets: number;
  bufferedBytes: number;
  droppedPackets: number;
  droppedBytes: number;
};

/** @internal Point-in-time view of RTCDtlsTransport for stats generation. */
export interface DtlsTransportStatsSource extends DtlsTransportStats {
  id: string;
  state: DtlsState;
  role: DtlsRole;
  iceTransport: RTCIceTransport;
  dtls?: DtlsSocket;
  localCertificate?: RTCCertificate;
  /** Only while connected; see RTCDtlsTransport.remoteCertificateForStats. */
  remoteCertificate?: Buffer;
  remoteFingerprints?: readonly RTCDtlsFingerprint[];
  applicationQueue: EarlyQueueStats;
  mediaQueue: EarlyQueueStats;
  handshakeStartedAt?: number;
  peerAuthenticatedAt?: number;
  earlyServerSendUsed: boolean;
}

/** @internal Transport and certificate stats (ICE stats are appended by the caller). */
export function buildDtlsTransportStats(
  source: DtlsTransportStatsSource,
  timestamp: number,
): { transportId: string; stats: RTCStats[] } {
  const stats: RTCStats[] = [];
  const { iceTransport, dtls, localCertificate, remoteCertificate } = source;

  const transportId = generateStatsId("transport", source.id);

  // Transport stats
  const appQueue = source.applicationQueue;
  const mediaQueue = source.mediaQueue;
  const dtlsQueue = dtls?.earlyDataStats;
  const spedDiagnostics = getConnectionSpedRuntime(
    iceTransport.connection as Connection,
  )?.diagnosticsSnapshot();
  const transportStats: RTCTransportStats = {
    type: "transport",
    id: transportId,
    timestamp,
    bytesSent: source.bytesSent,
    bytesReceived: source.bytesReceived,
    packetsSent: source.packetsSent,
    packetsReceived: source.packetsReceived,
    dtlsState: source.state,
    iceState: iceTransport.state,
    iceRole: iceTransport.role === "unknown" ? undefined : iceTransport.role,
    iceLocalUsernameFragment: iceTransport.localParameters.usernameFragment,
    selectedCandidatePairId: iceTransport.connection.nominated
      ? generateStatsId("candidate-pair", iceTransport.connection.nominated.id)
      : undefined,
    localCertificateId: localCertificate
      ? generateStatsId("certificate", source.id, "local")
      : undefined,
    remoteCertificateId: remoteCertificate
      ? generateStatsId("certificate", source.id, "remote")
      : undefined,
    dtlsRole: source.role === "auto" ? undefined : source.role,
    tlsVersion: formatDtlsVersion(dtls),
    dtlsCipher: formatDtlsCipher(dtls),
    srtpCipher: formatSrtpCipher(dtls?.srtp.srtpProfile),
    iceRestarts: iceTransport.iceRestarts,
    warpSpedState: spedDiagnostics?.state ?? "disabled",
    warpCarrier: spedDiagnostics?.carrier ?? "direct",
    warpHandshakeRttMs:
      source.handshakeStartedAt !== undefined &&
      source.peerAuthenticatedAt !== undefined
        ? source.peerAuthenticatedAt - source.handshakeStartedAt
        : undefined,
    warpDtlsRetransmissions: dtls?.totalRetransmitCount ?? 0,
    warpSpedRetransmissions: spedDiagnostics?.retransmissions ?? 0,
    warpEarlyBufferedPackets:
      appQueue.bufferedPackets +
      mediaQueue.bufferedPackets +
      (dtlsQueue?.bufferedPackets ?? 0),
    warpEarlyBufferedBytes:
      appQueue.bufferedBytes +
      mediaQueue.bufferedBytes +
      (dtlsQueue?.bufferedBytes ?? 0),
    warpEarlyDroppedPackets:
      appQueue.droppedPackets +
      mediaQueue.droppedPackets +
      (dtlsQueue?.droppedPackets ?? 0),
    warpEarlyDroppedBytes:
      appQueue.droppedBytes +
      mediaQueue.droppedBytes +
      (dtlsQueue?.droppedBytes ?? 0),
    warpEarlyServerSendUsed: source.earlyServerSendUsed,
    iceGeneration: (iceTransport.connection as Connection).generation,
  };
  stats.push(transportStats);

  // Certificate stats
  if (localCertificate) {
    const fingerprints = localCertificate.getFingerprints();
    if (fingerprints.length > 0) {
      const certStats: RTCCertificateStats = {
        type: "certificate",
        id: generateStatsId("certificate", source.id, "local"),
        timestamp,
        fingerprint: fingerprints[0].value,
        fingerprintAlgorithm: fingerprints[0].algorithm,
        base64Certificate: Buffer.from(localCertificate.certPem).toString(
          "base64",
        ),
      };
      stats.push(certStats);
    }
  }

  const remoteFingerprints = source.remoteFingerprints;
  if (
    remoteFingerprints &&
    remoteFingerprints.length > 0 &&
    remoteCertificate
  ) {
    const certStats: RTCCertificateStats = {
      type: "certificate",
      id: generateStatsId("certificate", source.id, "remote"),
      timestamp,
      fingerprint: remoteFingerprints[0].value,
      fingerprintAlgorithm: remoteFingerprints[0].algorithm,
      base64Certificate: Buffer.from(remoteCertificate).toString("base64"),
    };
    stats.push(certStats);
  }

  return { transportId, stats };
}
