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
import type {
  CandidatePair,
  Message,
  MessageIntegrityMode,
  Protocol,
} from "../imports/ice";
import { defaultCodecs } from "../media/codec";
import { normalizeCodecMimeType } from "../media/codecCompatibility";
import type {
  RTCRtpCodecParameters,
  RTCRtpHeaderExtensionParameters,
} from "../media/parameters";
import type { KeyFrameRequestRouting } from "../media/router";
import type { RTCRtpSenderOptions } from "../media/rtpSender";
import type { BandwidthEstimatorOption } from "../media/sender/createBandwidthEstimator";
import type { BundlePolicy } from "../sdp";
import type { MLineReuse } from "../sdpManager";
import type { DtlsKeys, RTCCertificate } from "../transport/dtls";
import { DEFAULT_MAX_MESSAGE_SIZE } from "../transport/sctp";
import { deepMerge } from "../utils";
import {
  type CompatibilityOption,
  type CompatibilityOptionValue,
  CompatibilityOptionValues,
} from "./compatibilityOptions";

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
  /**
   * Fall back to the built-in public STUN server (`stun.l.google.com:19302`)
   * when `iceServers` contains no STUN URL (empty or TURN-only).
   * Set to false to gather server-reflexive candidates only from the STUN
   * servers given in `iceServers`. Defaults to true.
   */
  iceUseDefaultStunServer: boolean;
  /**Minimum port and Maximum port must not be the same value */
  icePortRange: [number, number] | undefined;
  /**
   * Local addresses to bind the ICE UDP host sockets to, per family
   * (`udp4` / `udp6`).
   *
   * The address given for a family is the only host address of that family:
   * its host candidate advertises the address the socket is actually bound
   * to, even when it is not an enumerated interface address (loopback, tun,
   * VPN, ...). If the bind fails, the family has no UDP host candidate.
   * A family left unspecified while the other one is set gathers no
   * enumerated addresses (only its `iceAdditionalHostAddresses`).
   */
  iceInterfaceAddresses: InterfaceAddresses | undefined;
  /** Add additional host (local) addresses to use for candidate gathering.
   * Notably, you can include hosts that are normally excluded, such as loopback, tun interfaces, etc.
   * For a family bound by `iceInterfaceAddresses`, addresses other than the bound one are ignored.
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
  /**
   * Preferred IP family of the TURN/UDP socket, applied only when the TURN
   * server is a hostname. Ignored for an IP literal server, whose own family
   * always selects the socket. Defaults to 4 when undefined.
   */
  turnUdpFamily: 4 | 6 | undefined;
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
  /**
   * Integrity attributes of the ICE connectivity checks and consent requests
   * werift sends (RFC 8489 short-term credentials). Applies to ICE transports
   * created after it is set.
   * - `undefined` / `"sha1"` (default): MESSAGE-INTEGRITY only. Browsers
   *   (libwebrtc, Firefox) accept this.
   * - `"sha256"`: MESSAGE-INTEGRITY-SHA256 only. Only for peers known to
   *   support it: a peer that does not know the attribute rejects the checks.
   * - `"both"`: MESSAGE-INTEGRITY followed by MESSAGE-INTEGRITY-SHA256.
   *
   * Checks and responses from the peer are accepted with either algorithm,
   * and responses are always signed with the algorithm of the request.
   */
  iceMessageIntegrity: MessageIntegrityMode | undefined;
  /**
   * Advertise the `ice2` ice-option (`a=ice-options:trickle ice2`, RFC 8445
   * §10 / RFC 8839) to declare an RFC 8445 agent. Defaults to false
   * (`a=ice-options:trickle`). It is only a declaration: werift runs the
   * RFC 8445 procedures either way. Cannot be changed after construction.
   */
  iceOptionIce2: boolean;
  dtls: Partial<{
    keys: DtlsKeys;
  }>;
  icePasswordPrefix: string | undefined;
  bundlePolicy: BundlePolicy;
  rtcpMuxPolicy: "require";
  iceCandidatePoolSize: number;
  certificates: RTCCertificate[];
  /**
   * Which default DTLS certificate is used when neither `certificates` nor `dtls.keys` is given
   * (see {@link CompatibilityOptionValues}). Cannot be changed after construction.
   * - `"process"` (default): one certificate shared by every RTCPeerConnection in the process,
   *   so their `a=fingerprint` values are identical.
   * - `"standard"`: each RTCPeerConnection generates its own certificate, as browsers do.
   *   All DTLS transports of that connection share it.
   *
   * Also accepts the v0.27.0 name `"peerConnection"` (= `"standard"`).
   */
  certificateScope: CertificateScope;
  debug: DebugConfig;
  midSuffix: boolean;
  /** Advertised local SCTP max-message-size in SDP. Use 0 for unlimited. */
  maxMessageSize: number;
  /**
   * When true, padding-only RTP is omitted from onReceiveRtp and later media
   * sequence numbers are compacted. Default false preserves wire RTP events.
   */
  filterProbePaddingOnReceiveRtp: boolean;
  /** Send-side estimator used by each new sender; defaults to `"lightweight"`. */
  bandwidthEstimator: BandwidthEstimatorOption;
  /** SCTP outbound packet MTU used for DATA chunk fragmentation. */
  sctp: { mtu: number };
  /**
   * Queue outbound RTP on each sender until DTLS is connected.
   * Disabled by default. Pass `true` or `{ enabled: true, maxLength }` to buffer.
   */
  pendingRtp: NonNullable<RTCRtpSenderOptions["pendingRtp"]>;
  /**
   * How local SDP marks inactive / stopped m-lines (see {@link CompatibilityOptionValues}).
   * Cannot be changed after construction.
   * - `"standard"` (default): an accepted `inactive` m-line keeps a non-zero port, as JSEP
   *   and browsers do. Only rejected (no common codec / remote port 0) or stopped m-lines
   *   use port 0, and only those negotiated port 0 positions are reused by new transceivers.
   * - `"aggressive"`: behavior before v0.25.0. `inactive` m-lines are also written with
   *   port 0, so the remote side treats them as rejected and their positions are reused.
   *
   * Also accepts the v0.27.0 name `"compatible"` (= `"standard"`).
   */
  mLineReuse: MLineReuse;
  /**
   * How a remote offer's m-sections are paired with local transceivers that
   * have no MID yet (see {@link CompatibilityOptionValues}). Cannot be changed
   * after construction.
   * - `"byKind"` (default): behavior up to v0.27.0. Any unassociated,
   *   non-stopped transceiver of the same kind is paired (the one at the same
   *   m-line index first), whatever created it. In glare (perfect negotiation)
   *   the remote offer can take over a transceiver created with
   *   `addTransceiver(kind, { direction: "sendonly" })` and its direction
   *   becomes `sendrecv`.
   * - `"standard"`: RFC 8829 (JSEP) section 5.10, as browsers do. An
   *   m-section whose MID no transceiver has is associated only with an
   *   unassociated, non-stopped transceiver of the same kind that
   *   `addTrack()` created (or one a rollback promoted to that, JSEP 4.1.8.2),
   *   and only when the m-section is `sendrecv` or `recvonly`. A transceiver
   *   created by `addTransceiver()` (with or without a track, also after
   *   `replaceTrack()` or a later `addTrack()` reusing it) is never paired:
   *   the offer gets a new transceiver, and the local one keeps its direction
   *   and `mid === null` until a local offer negotiates it. Use it for the
   *   perfect negotiation pattern and for code written for browsers.
   */
  transceiverPairing: TransceiverPairing;
  /**
   * Where a PLI / FIR goes when no route has its target SSRC (see
   * {@link CompatibilityOptionValues} and {@link KeyFrameRequestRouting}).
   * `setConfiguration()` may change it.
   * - `"fallback"` (default): the sender whose RTX SSRC it is, else the only video sender.
   * - `"standard"`: not delivered, as RFC 4585 / RFC 5104 define the target.
   *
   * Also accepts the names up to v0.27.0: `"compatible"` (= `"fallback"`) and
   * `"strict"` (= `"standard"`).
   */
  keyFrameRequestRouting: KeyFrameRequestRouting;
  /**
   * Sets every compatibility option (`certificateScope`, `mLineReuse`,
   * `transceiverPairing`, `keyFrameRequestRouting`, see
   * {@link CompatibilityOptionValues}) to the specification / browser behavior
   * at once. Cannot be changed after construction.
   * - `undefined` (default): each option keeps its own default.
   * - `"standard"`: every compatibility option not given in the same
   *   configuration is `"standard"`; an option given explicitly keeps the
   *   given value.
   *
   * ```ts
   * new RTCPeerConnection({ compatibility: "standard" });
   * // certificateScope, mLineReuse, transceiverPairing and
   * // keyFrameRequestRouting are all "standard"
   * ```
   *
   * It does not change `iceServers` / `iceUseDefaultStunServer`, which are not
   * compatibility options.
   */
  compatibility: CompatibilityPreset | undefined;
}

/** Which default DTLS certificate is used. See {@link PeerConfig.certificateScope}. */
export type CertificateScope = CompatibilityOptionValue<"certificateScope">;
export const CertificateScopeModes: readonly CertificateScope[] =
  CompatibilityOptionValues.certificateScope;

/** How local SDP marks inactive / stopped m-lines. See {@link PeerConfig.mLineReuse}. */
export const MLineReuseModes: readonly MLineReuse[] =
  CompatibilityOptionValues.mLineReuse;

/** How a remote offer pairs m-sections with local transceivers. See {@link PeerConfig.transceiverPairing}. */
export type TransceiverPairing = CompatibilityOptionValue<"transceiverPairing">;
export const TransceiverPairingModes: readonly TransceiverPairing[] =
  CompatibilityOptionValues.transceiverPairing;

/** The values of {@link PeerConfig.compatibility}. */
export type CompatibilityPreset = "standard";
export const CompatibilityPresets: readonly CompatibilityPreset[] = [
  "standard",
];

const COMPATIBILITY_OPTIONS = Object.keys(
  CompatibilityOptionValues,
) as CompatibilityOption[];

/**
 * The values the compatibility options used up to v0.27.0 that are not
 * values any more, and the value each one is read as. They are accepted on
 * input only: `getConfiguration()` returns the current name.
 */
export const DeprecatedCompatibilityValues = {
  certificateScope: { peerConnection: "standard" },
  mLineReuse: { compatible: "standard" },
  keyFrameRequestRouting: { compatible: "fallback", strict: "standard" },
} as const satisfies {
  [K in CompatibilityOption]?: Readonly<
    Record<string, CompatibilityOptionValue<K>>
  >;
};

/** @deprecated Use `"standard"` (`"peerConnection"`). */
export type DeprecatedCertificateScope =
  keyof (typeof DeprecatedCompatibilityValues)["certificateScope"];
/** @deprecated Use `"standard"` (`"compatible"`). */
export type DeprecatedMLineReuse =
  keyof (typeof DeprecatedCompatibilityValues)["mLineReuse"];
/** @deprecated Use `"fallback"` (`"compatible"`) or `"standard"` (`"strict"`). */
export type DeprecatedKeyFrameRequestRouting =
  keyof (typeof DeprecatedCompatibilityValues)["keyFrameRequestRouting"];

const MessageIntegrityModes: readonly MessageIntegrityMode[] = [
  "sha1",
  "sha256",
  "both",
];

export const findCodecByMimeType = (
  codecs: RTCRtpCodecParameters[],
  target: RTCRtpCodecParameters,
) =>
  codecs.find(
    (localCodec) =>
      normalizeCodecMimeType(localCodec.mimeType) ===
      normalizeCodecMimeType(target.mimeType),
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
    | "certificateScope"
    | "mLineReuse"
    | "keyFrameRequestRouting"
  >
> &
  RTCPeerConnectionRTCConfiguration & {
    sctp?: RTCSctpConfiguration;
    /** See {@link PeerConfig.certificateScope}. */
    certificateScope?: CertificateScope | DeprecatedCertificateScope;
    /** See {@link PeerConfig.mLineReuse}. */
    mLineReuse?: MLineReuse | DeprecatedMLineReuse;
    /** See {@link PeerConfig.keyFrameRequestRouting}. */
    keyFrameRequestRouting?:
      | KeyFrameRequestRouting
      | DeprecatedKeyFrameRequestRouting;
  };

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
    iceUseDefaultStunServer: true,
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
    turnUdpFamily: undefined,
    iceFilterStunResponse: undefined,
    iceFilterCandidatePair: undefined,
    iceMessageIntegrity: undefined,
    iceOptionIce2: false,
    icePasswordPrefix: undefined,
    iceUseLinkLocalAddress: undefined,
    dtls: {},
    bundlePolicy: "max-compat",
    rtcpMuxPolicy: "require",
    iceCandidatePoolSize: 0,
    certificates: [],
    certificateScope: "process",
    debug: {},
    midSuffix: false,
    forceTurnTCP: false,
    maxMessageSize: DEFAULT_MAX_MESSAGE_SIZE,
    filterProbePaddingOnReceiveRtp: false,
    bandwidthEstimator: "lightweight",
    sctp: { mtu: DEFAULT_SCTP_MTU },
    pendingRtp: false,
    mLineReuse: "standard",
    transceiverPairing: "byKind",
    keyFrameRequestRouting: "fallback",
    compatibility: undefined,
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

  for (const option of COMPATIBILITY_OPTIONS) {
    const value: unknown = input[option];
    if (option in DeprecatedCompatibilityValues && typeof value === "string") {
      const aliases: Readonly<Record<string, string>> =
        DeprecatedCompatibilityValues[
          option as keyof typeof DeprecatedCompatibilityValues
        ];
      if (Object.hasOwn(aliases, value)) {
        (normalizedConfig as Record<string, unknown>)[option] = aliases[value];
      }
    }
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
const CLEARABLE_TURN_KEYS = [
  "turnTransport",
  "turnTlsOptions",
  "turnUdpFamily",
] as const;

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
    normalizedConfig.compatibility !== undefined &&
    !CompatibilityPresets.includes(normalizedConfig.compatibility)
  ) {
    throw createWebRtcTypeError(
      `compatibility must be one of ${CompatibilityPresets.join(", ")}`,
    );
  }
  if (isReconfiguration) {
    if (
      normalizedConfig.compatibility !== undefined &&
      normalizedConfig.compatibility !== config.compatibility
    ) {
      throw createWebRtcDomException(
        "InvalidModificationError",
        "compatibility cannot be changed",
      );
    }
  } else if (normalizedConfig.compatibility === "standard") {
    // 構築時だけ、明示されていない互換性オプションを standard にする
    for (const option of COMPATIBILITY_OPTIONS) {
      if (normalizedConfig[option] === undefined) {
        (normalizedConfig as Record<string, unknown>)[option] = "standard";
      }
    }
  }

  for (const option of COMPATIBILITY_OPTIONS) {
    const value = normalizedConfig[option];
    if (value === undefined) continue;
    const values: readonly string[] = CompatibilityOptionValues[option];
    if (!values.includes(value)) {
      throw createWebRtcTypeError(
        `${option} must be one of ${values.join(", ")}`,
      );
    }
    // keyFrameRequestRouting は接続中に切り替えられる (router が次の要求から使う)
    if (
      isReconfiguration &&
      option !== "keyFrameRequestRouting" &&
      value !== config[option]
    ) {
      throw createWebRtcDomException(
        "InvalidModificationError",
        `${option} cannot be changed`,
      );
    }
  }

  if (
    normalizedConfig.iceMessageIntegrity !== undefined &&
    !MessageIntegrityModes.includes(normalizedConfig.iceMessageIntegrity)
  ) {
    throw createWebRtcTypeError(
      `iceMessageIntegrity must be one of ${MessageIntegrityModes.join(", ")}`,
    );
  }

  if (
    isReconfiguration &&
    normalizedConfig.iceOptionIce2 !== undefined &&
    normalizedConfig.iceOptionIce2 !== config.iceOptionIce2
  ) {
    throw createWebRtcDomException(
      "InvalidModificationError",
      "iceOptionIce2 cannot be changed",
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
  // Omitted keys keep their value, but an explicit `undefined` unsets these
  // optional TURN settings (deepMerge skips undefined).
  for (const key of CLEARABLE_TURN_KEYS) {
    if (Object.hasOwn(normalizedConfig, key) && normalizedConfig[key] == null) {
      // Union-key writes require the intersection of all indexed property
      // types. Narrow the key so each optional setting can be cleared safely.
      switch (key) {
        case "turnTransport":
          config.turnTransport = undefined;
          break;
        case "turnTlsOptions":
          config.turnTlsOptions = undefined;
          break;
        case "turnUdpFamily":
          config.turnUdpFamily = undefined;
          break;
      }
    }
  }
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
