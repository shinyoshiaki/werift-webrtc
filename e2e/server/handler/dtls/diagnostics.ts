import type { RTCPeerConnection } from "../..";

export type WeriftDtlsDiagnostics = {
  connectionState: string;
  dtlsState?: string;
  dtlsRole?: string;
  tlsVersion?: string;
  dtlsCipher?: string;
  srtpCipher?: string;
  lastError?: { name: string; message: string; code?: string };
  rtpPacketsReceived: number;
  rtcpPacketsReceived: number;
  iceRestarts?: number;
};

export function attachMediaCounters(pc: RTCPeerConnection) {
  const counters = {
    rtpPacketsReceived: 0,
    rtcpPacketsReceived: 0,
  };

  const attachTransport = () => {
    for (const dtls of pc.dtlsTransports) {
      dtls.onRtcp.subscribe(() => {
        counters.rtcpPacketsReceived++;
      });
      dtls.onRtp.subscribe(() => {
        counters.rtpPacketsReceived++;
      });
    }
  };

  attachTransport();
  pc.onRemoteTransceiverAdded.subscribe((transceiver) => {
    transceiver.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe(() => {
        counters.rtpPacketsReceived++;
      });
    });
  });

  return { counters, attachTransport };
}

export async function collectWeriftDtlsDiagnostics(
  pc: RTCPeerConnection | undefined,
  counters?: { rtpPacketsReceived: number; rtcpPacketsReceived: number },
): Promise<WeriftDtlsDiagnostics> {
  if (!pc) {
    return {
      connectionState: "new",
      rtpPacketsReceived: 0,
      rtcpPacketsReceived: 0,
    };
  }

  let stats: Map<string, { type: string }>;
  try {
    stats = await pc.getStats();
  } catch {
    stats = new Map();
  }
  const transport = [...stats.values()].find(
    (stat) => stat.type === "transport",
  ) as
    | {
        tlsVersion?: string;
        dtlsCipher?: string;
        srtpCipher?: string;
        dtlsState?: string;
        dtlsRole?: string;
        iceRestarts?: number;
      }
    | undefined;
  const dtls = pc.dtlsTransports[0];
  const lastError = dtls?.lastError;

  return {
    connectionState: pc.connectionState,
    dtlsState: dtls?.state ?? transport?.dtlsState,
    dtlsRole: dtls?.role === "auto" ? transport?.dtlsRole : dtls?.role,
    tlsVersion: transport?.tlsVersion,
    dtlsCipher: transport?.dtlsCipher,
    srtpCipher: transport?.srtpCipher,
    lastError: lastError
      ? {
          name: lastError.name,
          message: lastError.message,
          code: (lastError as { code?: string }).code,
        }
      : undefined,
    rtpPacketsReceived:
      counters?.rtpPacketsReceived ?? dtls?.packetsReceived ?? 0,
    rtcpPacketsReceived: counters?.rtcpPacketsReceived ?? 0,
    iceRestarts: transport?.iceRestarts,
  };
}
