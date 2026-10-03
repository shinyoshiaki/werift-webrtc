// RTCPeerConnection configuration: the public configuration types, their
// defaults, input normalization (W3C RTCConfiguration compatibility) and the
// validation `setConfiguration` applies before merging.
import { DEFAULT_SCTP_MTU, validateSctpMtu } from "../../../sctp/src";
import { createWebRtcDomException, createWebRtcTypeError } from "../errors";
import { enumerate } from "../helper";
import type {
  Address,
  InterfaceAddresses,
  TlsConnectionOptions,
} from "../imports/common";
import type { CandidatePair, Message, Protocol } from "../imports/ice";
import {
  type RTCRtpCodecParameters,
  type RTCRtpHeaderExtensionParameters,
  type RTCRtpSenderOptions,
  defaultCodecs,
} from "../media";
import type { BundlePolicy } from "../sdp";
import type { MLineReuse } from "../sdpManager";
import type { DtlsKeys, RTCCertificate } from "../transport/dtls";
import { DEFAULT_MAX_MESSAGE_SIZE } from "../transport/sctp";
import { deepMerge } from "../utils";

export type DebugConfig = Partial<{
  /**% */
  inboundPacketLoss: number;
  /**% */
  outboundPacketLoss: number;
  /**ms */
  receiverReportDelay: number;
  disableSendNack: boolean;
  disableRecvRetransmit: boolean;
}>;

export interface PeerConfig {
  codecs: Partial<{
    /**
     * When specifying a codec with a fixed payloadType such as PCMU,
     * it is necessary to set the correct PayloadType in RTCRtpCodecParameters in advance.
     */
    audio: RTCRtpCodecParameters[];
    video: RTCRtpCodecParameters[];
  }>;
  headerExtensions: Partial<{
    audio: RTCRtpHeaderExtensionParameters[];
    video: RTCRtpHeaderExtensionParameters[];
  }>;
  iceTransportPolicy: "all" | "relay";
  /** Advertise local ICE lite and operate in the controlled role. */
  iceLite: boolean;
  iceServers: RTCIceServer[];
  /**Minimum port and Maximum port must not be the same value */
  icePortRange: [number, number] | undefined;
  iceInterfaceAddresses: InterfaceAddresses | undefined;
  /** Add additional host (local) addresses to use for candidate gathering.
   * Notably, you can include hosts that are normally excluded, such as loopback, tun interfaces, etc.
   */
  iceAdditionalHostAddresses: string[] | undefined;
  iceUseIpv4: boolean;
  iceUseIpv6: boolean;
  iceUseTcp: boolean;
  /** Gather passive (listening) TCP host candidates. Defaults to true. */
  iceTcpPassive: boolean;
  /**
   * Seconds to wait for server-reflexive candidates while gathering.
   * Defaults to 5 when undefined.
   */
  iceStunGatherTimeout: number | undefined;
  /**
   * Seconds to wait for a TURN TCP/TLS connection to be established.
   * Defaults to 8 when undefined.
   */
  iceTurnConnectTimeout: number | undefined;
  turnTransport: "udp" | "tcp" | "tls" | undefined;
  turnTlsOptions: TlsConnectionOptions | undefined;
  /** @deprecated Prefer turn URL transport parameters or turnTransport. */
  forceTurnTCP: boolean;
  /** such as google cloud run */
  iceUseLinkLocalAddress: boolean | undefined;
  /** If provided, is called on each STUN request.
   * Return `true` if a STUN response should be sent, false if it should be skipped. */
  iceFilterStunResponse:
    | ((message: Message, addr: Address, protocol: Protocol) => boolean)
    | undefined;
  iceFilterCandidatePair: ((pair: CandidatePair) => boolean) | undefined;
  dtls: Partial<{
    keys: DtlsKeys;
  }>;
  icePasswordPrefix: string | undefined;
  bundlePolicy: BundlePolicy;
  rtcpMuxPolicy: "require";
  iceCandidatePoolSize: number;
  certificates: RTCCertificate[];
  debug: DebugConfig;
  midSuffix: boolean;
  /** Advertised local SCTP max-message-size in SDP. Use 0 for unlimited. */
  maxMessageSize: number;
  /** SCTP outbound packet MTU used for DATA chunk fragmentation. */
  sctp: { mtu: number };
  /**
   * Queue outbound RTP on each sender until DTLS is connected.
   * Disabled by default. Pass `true` or `{ enabled: true, maxLength }` to buffer.
   */
  pendingRtp: NonNullable<RTCRtpSenderOptions["pendingRtp"]>;
  /**
   * How local SDP marks inactive / stopped m-lines. Cannot be changed after construction.
   * - `"compatible"` (default): an accepted `inactive` m-line keeps a non-zero port.
   *   Only rejected (no common codec / remote port 0) or stopped m-lines use port 0,
   *   and only those negotiated port 0 positions are reused by new transceivers.
   * - `"aggressive"`: legacy behavior. `inactive` m-lines are also written with port 0.
   */
  mLineReuse: MLineReuse;
}

const MLineReuseModes: readonly MLineReuse[] = ["compatible", "aggressive"];

export const findCodecByMimeType = (
  codecs: RTCRtpCodecParameters[],
  target: RTCRtpCodecParameters,
) =>
  codecs.find(
    (localCodec) =>
      localCodec.mimeType.toLowerCase() === target.mimeType.toLowerCase(),
  )
    ? target
    : undefined;

function assignDynamicPayloadTypes(config: PeerConfig) {
  for (const [i, codecParams] of enumerate([
    ...(config.codecs.audio || []),
    ...(config.codecs.video || []),
  ])) {
    if (codecParams.payloadType != undefined) {
      continue;
    }

    codecParams.payloadType = 96 + i;
    switch (codecParams.name.toLowerCase()) {
      case "rtx":
        {
          codecParams.parameters = `apt=${codecParams.payloadType - 1}`;
        }
        break;
      case "red":
        {
          if (codecParams.contentType === "audio") {
            const redundant = codecParams.payloadType + 1;
            codecParams.parameters = `${redundant}/${redundant}`;
            codecParams.payloadType = 63;
          }
        }
        break;
    }
  }
}

export type RTCIceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export type RTCBundlePolicy = "balanced" | "max-compat" | "max-bundle";
export type RTCRtcpMuxPolicy = "require";

export interface RTCSctpConfiguration {
  /** SCTP outbound packet MTU used for DATA chunk fragmentation. Defaults to 1191. */
  mtu?: number;
}

export interface RTCConfiguration {
  iceServers?: RTCIceServer[];
  iceTransportPolicy?: PeerConfig["iceTransportPolicy"];
  bundlePolicy?: RTCBundlePolicy;
  rtcpMuxPolicy?: RTCRtcpMuxPolicy;
  iceCandidatePoolSize?: number;
  certificates?: RTCCertificate[];
}

type RTCPeerConnectionRTCConfiguration = Omit<
  RTCConfiguration,
  "bundlePolicy"
> & {
  bundlePolicy?: PeerConfig["bundlePolicy"] | RTCBundlePolicy;
};

export type RTCPeerConnectionConfig = Partial<
  Omit<
    PeerConfig,
    | "bundlePolicy"
    | "rtcpMuxPolicy"
    | "iceCandidatePoolSize"
    | "certificates"
    | "sctp"
  >
> &
  RTCPeerConnectionRTCConfiguration & { sctp?: RTCSctpConfiguration };

export function generateDefaultPeerConfig(): PeerConfig {
  return {
    codecs: defaultCodecs(),
    headerExtensions: {
      audio: [],
      video: [],
    },
    iceTransportPolicy: "all",
    iceLite: false,
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    icePortRange: undefined,
    iceInterfaceAddresses: undefined,
    iceAdditionalHostAddresses: undefined,
    iceUseIpv4: true,
    iceUseIpv6: true,
    iceUseTcp: false,
    iceTcpPassive: true,
    iceStunGatherTimeout: undefined,
    iceTurnConnectTimeout: undefined,
    turnTransport: undefined,
    turnTlsOptions: undefined,
    iceFilterStunResponse: undefined,
    iceFilterCandidatePair: undefined,
    icePasswordPrefix: undefined,
    iceUseLinkLocalAddress: undefined,
    dtls: {},
    bundlePolicy: "max-compat",
    rtcpMuxPolicy: "require",
    iceCandidatePoolSize: 0,
    certificates: [],
    debug: {},
    midSuffix: false,
    forceTurnTCP: false,
    maxMessageSize: DEFAULT_MAX_MESSAGE_SIZE,
    sctp: { mtu: DEFAULT_SCTP_MTU },
    pendingRtp: false,
    mLineReuse: "compatible",
  };
}
export const defaultPeerConfig: PeerConfig = generateDefaultPeerConfig();

function normalizePeerConfiguration(
  config: RTCPeerConnectionConfig,
): Partial<PeerConfig> & { sctp?: RTCSctpConfiguration } {
  const input = Object(config ?? {}) as RTCPeerConnectionConfig;
  const normalizedConfig = { ...input } as Partial<PeerConfig> & {
    sctp?: RTCSctpConfiguration;
  };

  if (input.sctp !== undefined) {
    normalizedConfig.sctp = { ...input.sctp } as PeerConfig["sctp"];
  }

  if (input.bundlePolicy === "balanced") {
    normalizedConfig.bundlePolicy = "max-compat";
  }

  if ("certificates" in input) {
    if (input.certificates === undefined) {
      normalizedConfig.certificates = undefined;
    } else if (
      !Array.isArray(input.certificates) ||
      input.certificates.some((certificate) => certificate == null)
    ) {
      throw createWebRtcTypeError(
        "certificates must be an array of RTCCertificate",
      );
    } else {
      normalizedConfig.certificates = [...input.certificates];
    }
  }

  if ("iceCandidatePoolSize" in input) {
    normalizedConfig.iceCandidatePoolSize = coerceUnsignedShort(
      input.iceCandidatePoolSize,
      "iceCandidatePoolSize",
    );
  }

  return normalizedConfig;
}

function coerceUnsignedShort(value: unknown, name: string) {
  const coerced = Number(value);
  if (
    !Number.isFinite(coerced) ||
    !Number.isInteger(coerced) ||
    coerced < 0 ||
    coerced > 65535
  ) {
    throw createWebRtcTypeError(`${name} must be an unsigned short`);
  }
  return coerced;
}

function hasSameCertificates(left: RTCCertificate[], right: RTCCertificate[]) {
  return (
    left.length === right.length &&
    left.every((certificate, index) => certificate === right[index])
  );
}

export function clonePeerConfiguration(config: PeerConfig) {
  return {
    ...config,
    codecs: {
      audio: config.codecs.audio ? [...config.codecs.audio] : undefined,
      video: config.codecs.video ? [...config.codecs.video] : undefined,
    },
    headerExtensions: {
      audio: config.headerExtensions.audio
        ? [...config.headerExtensions.audio]
        : undefined,
      video: config.headerExtensions.video
        ? [...config.headerExtensions.video]
        : undefined,
    },
    iceServers: config.iceServers.map((server) => ({
      ...server,
      urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
    })),
    icePortRange: config.icePortRange
      ? ([...config.icePortRange] as [number, number])
      : undefined,
    iceAdditionalHostAddresses: config.iceAdditionalHostAddresses
      ? [...config.iceAdditionalHostAddresses]
      : undefined,
    dtls: { ...config.dtls },
    certificates: [...config.certificates],
    debug: { ...config.debug },
    sctp: { ...config.sctp },
    pendingRtp:
      typeof config.pendingRtp === "object" && config.pendingRtp != undefined
        ? { ...config.pendingRtp }
        : config.pendingRtp,
  };
}

/**
 * `setConfiguration`: validate `input` against the current `config`, then
 * merge it in place. Returns the normalized input; side effects on live
 * transports (SCTP limits, ICE servers) stay with the caller.
 */
export function mergePeerConfiguration(
  config: PeerConfig,
  input: RTCPeerConnectionConfig,
  {
    isReconfiguration,
    hasLocalDescription,
    hasSctpTransport,
  }: {
    isReconfiguration: boolean;
    hasLocalDescription: boolean;
    hasSctpTransport: boolean;
  },
) {
  const normalizedConfig = normalizePeerConfiguration(input);

  if (
    normalizedConfig.rtcpMuxPolicy &&
    normalizedConfig.rtcpMuxPolicy !== "require"
  ) {
    throw new Error("rtcpMuxPolicy must be require");
  }

  if (
    normalizedConfig.iceCandidatePoolSize !== undefined &&
    (!Number.isInteger(normalizedConfig.iceCandidatePoolSize) ||
      normalizedConfig.iceCandidatePoolSize < 0)
  ) {
    throw new Error("iceCandidatePoolSize must be a non-negative integer");
  }

  if (
    isReconfiguration &&
    normalizedConfig.bundlePolicy !== undefined &&
    normalizedConfig.bundlePolicy !== config.bundlePolicy
  ) {
    throw new Error("bundlePolicy cannot be changed");
  }

  if (
    normalizedConfig.mLineReuse !== undefined &&
    !MLineReuseModes.includes(normalizedConfig.mLineReuse)
  ) {
    throw createWebRtcTypeError(
      `mLineReuse must be one of ${MLineReuseModes.join(", ")}`,
    );
  }

  if (
    isReconfiguration &&
    normalizedConfig.mLineReuse !== undefined &&
    normalizedConfig.mLineReuse !== config.mLineReuse
  ) {
    throw createWebRtcDomException(
      "InvalidModificationError",
      "mLineReuse cannot be changed",
    );
  }

  if (
    isReconfiguration &&
    normalizedConfig.rtcpMuxPolicy !== undefined &&
    normalizedConfig.rtcpMuxPolicy !== config.rtcpMuxPolicy
  ) {
    throw new Error("rtcpMuxPolicy cannot be changed");
  }

  if (
    isReconfiguration &&
    normalizedConfig.certificates !== undefined &&
    !hasSameCertificates(normalizedConfig.certificates, config.certificates)
  ) {
    throw new Error("certificates cannot be changed");
  }

  if (
    isReconfiguration &&
    normalizedConfig.iceCandidatePoolSize !== undefined &&
    hasLocalDescription &&
    normalizedConfig.iceCandidatePoolSize !== config.iceCandidatePoolSize
  ) {
    throw new Error(
      "iceCandidatePoolSize cannot be changed after setLocalDescription",
    );
  }

  if ((normalizedConfig.iceCandidatePoolSize ?? 0) > 0) {
    throw new Error("iceCandidatePoolSize > 0 is not supported");
  }

  if (normalizedConfig.sctp !== undefined) {
    const requestedSctpMtu = normalizedConfig.sctp.mtu ?? DEFAULT_SCTP_MTU;
    validateSctpMtu(requestedSctpMtu);
    if (hasSctpTransport && requestedSctpMtu !== config.sctp.mtu) {
      throw new Error(
        "sctp.mtu cannot be changed after SCTP transport creation",
      );
    }
  }

  deepMerge(config, normalizedConfig as Partial<PeerConfig>);
  config.sctp = {
    mtu: config.sctp?.mtu ?? DEFAULT_SCTP_MTU,
  };

  if (config.icePortRange) {
    const [min, max] = config.icePortRange;
    if (min === max) throw new Error("should not be same value");
    if (min >= max) throw new Error("The min must be less than max");
  }

  if (!Number.isInteger(config.maxMessageSize) || config.maxMessageSize < 0) {
    throw new Error("maxMessageSize must be a non-negative integer");
  }

  assignDynamicPayloadTypes(config);

  [
    ...(config.headerExtensions.audio || []),
    ...(config.headerExtensions.video || []),
  ].forEach((v, i) => {
    v.id = 1 + i;
  });

  return normalizedConfig;
}
