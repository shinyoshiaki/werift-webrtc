import {
  DISCARD_HOST,
  DISCARD_PORT,
  ReceiverDirection,
  SenderDirections,
} from "../const";
import { enumerate } from "../helper";
import type { Address, InterfaceAddresses } from "../imports/common";
import type { CandidatePair, Message, Protocol } from "../imports/ice";
import {
  type MediaDirection,
  type RTCRtpCodecParameters,
  type RTCRtpHeaderExtensionParameters,
  RTCRtpSimulcastParameters,
  type RTCRtpTransceiver,
  Recvonly,
  Sendonly,
  Sendrecv,
} from "../media";
import {
  GroupDescription,
  MediaDescription,
  type SessionDescription,
  SsrcDescription,
} from "../sdp";
import type { DtlsKeys, RTCDtlsTransport } from "../transport/dtls";
import type { IceGathererState, RTCIceConnectionState } from "../transport/ice";
import { RTCSctpTransport } from "../transport/sctp";
import type { RTCSignalingState } from "../types/domain";
import { deepMerge } from "../utils";

// https://w3c.github.io/webrtc-pc/#dom-rtciceconnectionstate
export function updateIceConnectionState({
  iceStates,
}: {
  iceStates: RTCIceConnectionState[];
}) {
  let newState: RTCIceConnectionState;

  function allMatch(...state: RTCIceConnectionState[]) {
    return (
      iceStates.filter((s) => state.includes(s)).length === iceStates.length
    );
  }

  if (allMatch("failed")) {
    newState = "failed";
  } else if (allMatch("disconnected")) {
    newState = "disconnected";
  } else if (allMatch("new", "closed")) {
    newState = "new";
  } else if (allMatch("new", "checking")) {
    newState = "checking";
  } else if (allMatch("completed", "closed")) {
    newState = "completed";
  } else if (allMatch("connected", "completed", "closed")) {
    newState = "connected";
  } else {
    // unreachable?
    newState = "new";
  }

  return newState;
}

// https://w3c.github.io/webrtc-pc/#dom-rtcicegatheringstate
export function updateIceGatheringState(all: IceGathererState[]) {
  function allMatch(...state: IceGathererState[]) {
    return all.filter((s) => state.includes(s)).length === all.length;
  }

  let newState: IceGathererState;

  if (all.length && allMatch("complete")) {
    newState = "complete";
  } else if (!all.length || allMatch("new", "complete")) {
    newState = "new";
  } else if (all.includes("gathering")) {
    newState = "gathering";
  } else {
    newState = "new";
  }

  return newState;
}

export function createMediaDescriptionForTransceiver(
  transceiver: RTCRtpTransceiver,
  cname: string,
  direction: MediaDirection,
) {
  const media = new MediaDescription(
    transceiver.kind,
    9,
    "UDP/TLS/RTP/SAVPF",
    transceiver.codecs.map((c) => c.payloadType),
  );
  media.direction = direction;
  media.msid = transceiver.msid;
  media.rtp = {
    codecs: transceiver.codecs,
    headerExtensions: transceiver.headerExtensions,
    muxId: transceiver.mid,
  };
  media.rtcpHost = "0.0.0.0";
  media.rtcpPort = 9;
  media.rtcpMux = true;
  media.ssrc = [new SsrcDescription({ ssrc: transceiver.sender.ssrc, cname })];

  if (transceiver.options.simulcast) {
    media.simulcastParameters = transceiver.options.simulcast.map(
      (o) => new RTCRtpSimulcastParameters(o),
    );
  }

  if (media.rtp.codecs.find((c) => c.name.toLowerCase() === "rtx")) {
    media.ssrc.push(
      new SsrcDescription({ ssrc: transceiver.sender.rtxSsrc, cname }),
    );
    media.ssrcGroup = [
      new GroupDescription("FID", [
        transceiver.sender.ssrc.toString(),
        transceiver.sender.rtxSsrc.toString(),
      ]),
    ];
  }

  addTransportDescription(media, transceiver.dtlsTransport);
  return media;
}

export function createMediaDescriptionForSctp(sctp: RTCSctpTransport) {
  const media = new MediaDescription(
    "application",
    DISCARD_PORT,
    "UDP/DTLS/SCTP",
    ["webrtc-datachannel"],
  );
  media.sctpPort = sctp.port;
  media.rtp.muxId = sctp.mid;
  media.sctpCapabilities = RTCSctpTransport.getCapabilities();

  addTransportDescription(media, sctp.dtlsTransport);
  return media;
}

export function addTransportDescription(
  media: MediaDescription,
  dtlsTransport: RTCDtlsTransport,
) {
  const iceTransport = dtlsTransport.iceTransport;

  media.iceCandidates = iceTransport.localCandidates;
  media.iceCandidatesComplete = iceTransport.gatheringState === "complete";
  media.iceParams = iceTransport.localParameters;
  media.iceOptions = "trickle";

  media.host = DISCARD_HOST;
  media.port = DISCARD_PORT;

  if (media.direction === "inactive") {
    media.port = 0;
    media.msid = undefined;
  }

  if (!media.dtlsParams) {
    media.dtlsParams = dtlsTransport.localParameters;
    if (!media.dtlsParams.fingerprints) {
      media.dtlsParams.fingerprints =
        dtlsTransport.localParameters.fingerprints;
    }
  }
}

export function allocateMid(mids: Set<string>, type: "dc" | "av" | "") {
  let mid = "";
  for (let i = 0; ; ) {
    // rfc9143.html#name-security-considerations
    // SHOULD be 3 bytes or fewer to allow them to efficiently fit into the MID RTP header extension
    mid = (i++).toString() + type;
    if (!mids.has(mid)) break;
  }
  mids.add(mid);
  return mid;
}

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

export function assignTransceiverCodecs(
  transceiver: RTCRtpTransceiver,
  parameters: RTCRtpCodecParameters[],
) {
  const codecs = parameters.filter((codecCandidate) => {
    switch (codecCandidate.direction) {
      case "recvonly": {
        if (ReceiverDirection.includes(transceiver.direction)) return true;
        return false;
      }
      case "sendonly": {
        if (SenderDirections.includes(transceiver.direction)) return true;
        return false;
      }
      case "sendrecv": {
        if ([Sendrecv, Recvonly, Sendonly].includes(transceiver.direction))
          return true;
        return false;
      }
      case "all": {
        return true;
      }
      default:
        return false;
    }
  });
  transceiver.codecs = codecs;
}

export function assertSignalingState(
  description: SessionDescription,
  signalingState: RTCSignalingState,
  isLocal: boolean,
) {
  if (isLocal) {
    if (description.type === "offer") {
      if (!["stable", "have-local-offer"].includes(signalingState))
        throw new Error("Cannot handle offer in signaling state");
    } else if (description.type === "answer") {
      if (
        !["have-remote-offer", "have-local-pranswer"].includes(signalingState)
      ) {
        throw new Error("Cannot handle answer in signaling state");
      }
    }
  } else {
    if (description.type === "offer") {
      if (!["stable", "have-remote-offer"].includes(signalingState)) {
        throw new Error("Cannot handle offer in signaling state");
      }
    } else if (description.type === "answer") {
      if (
        !["have-local-offer", "have-remote-pranswer"].includes(signalingState)
      ) {
        throw new Error("Cannot handle answer in signaling state");
      }
    }
  }
}

export function setConfiguration(
  oldConfig: PeerConfig,
  config: Partial<PeerConfig>,
) {
  deepMerge(oldConfig, config);

  if (oldConfig.icePortRange) {
    const [min, max] = oldConfig.icePortRange;
    if (min === max) throw new Error("should not be same value");
    if (min >= max) throw new Error("The min must be less than max");
  }

  for (const [i, codecParams] of enumerate([
    ...(oldConfig.codecs.audio || []),
    ...(oldConfig.codecs.video || []),
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

  [
    ...(oldConfig.headerExtensions.audio || []),
    ...(oldConfig.headerExtensions.video || []),
  ].forEach((v, i) => {
    v.id = 1 + i;
  });

  return oldConfig;
}

export type RTCIceServer = {
  urls: string;
  username?: string;
  credential?: string;
};

export type BundlePolicy = "max-compat" | "max-bundle" | "disable";

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
  debug: Partial<{
    /**% */
    inboundPacketLoss: number;
    /**% */
    outboundPacketLoss: number;
    /**ms */
    receiverReportDelay: number;
    disableSendNack: boolean;
    disableRecvRetransmit: boolean;
  }>;
  midSuffix: boolean;
}
