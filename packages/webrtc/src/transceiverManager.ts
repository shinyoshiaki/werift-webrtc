import { ReceiverDirection, SenderDirections } from "./const";
import { createWebRtcDomException } from "./errors";
import { Event, debug } from "./imports/common";
import {
  MediaStream,
  type MediaStreamTrack,
  type RTCRtpCodecParameters,
  RTCRtpCodingParameters,
  type RTCRtpEncodingParameters,
  type RTCRtpParameters,
  type RTCRtpReceiveParameters,
  RTCRtpReceiver,
  RTCRtpRtxParameters,
  RTCRtpSender,
  RTCRtpTransceiver,
  Recvonly,
  type RtpRouter,
  Sendonly,
  Sendrecv,
  type TransceiverOptions,
} from "./media";
import {
  assertCodecsSupported,
  resolveCodecs,
} from "./media/codecCompatibility";
import type { RTCStats } from "./media/stats";
import { captureTrackSourceCodecs, getTrackSourceCodecs } from "./media/track";
import { type PeerConfig, findCodecByMimeType } from "./peerConnection";
import { type MediaDescription, codecParametersFromString } from "./sdp";
import type { RTCDtlsTransport } from "./transport/dtls";
import type { Kind } from "./types/domain";
import { reverseDirection } from "./utils";

const log = debug("werift:packages/webrtc/src/media/rtpTransceiverManager.ts");

function simulcastFromSendEncodings(
  encodings: RTCRtpEncodingParameters[] | undefined,
): TransceiverOptions["simulcast"] | undefined {
  if (!encodings || encodings.length < 2) {
    return undefined;
  }
  const rids = encodings
    .map((encoding) => encoding.rid)
    .filter((rid): rid is string => typeof rid === "string" && rid.length > 0);
  if (rids.length < 2) {
    return undefined;
  }
  return rids.map((rid) => ({ rid, direction: "send" as const }));
}

export class TransceiverManager {
  private readonly transceivers: RTCRtpTransceiver[] = [];

  readonly onTransceiverAdded = new Event<[RTCRtpTransceiver]>();
  readonly onRemoteTransceiverAdded = new Event<[RTCRtpTransceiver]>();
  readonly onTrack = new Event<
    [
      {
        track: MediaStreamTrack;
        transceiver: RTCRtpTransceiver;
        streams: MediaStream[];
      },
    ]
  >();
  readonly onNegotiationNeeded = new Event<[]>();

  constructor(
    private readonly cname: string,
    private readonly config: Required<PeerConfig>,
    private readonly router: RtpRouter,
  ) {}

  getTransceivers(): RTCRtpTransceiver[] {
    return this.transceivers;
  }

  getSenders(): RTCRtpSender[] {
    return this.getTransceivers().map((t) => t.sender);
  }

  getReceivers() {
    return this.getTransceivers().map((t) => t.receiver);
  }

  getTransceiverByMLineIndex(index: number): RTCRtpTransceiver | undefined {
    return this.transceivers.find(
      (transceiver) => transceiver.mLineIndex === index,
    );
  }

  pushTransceiver(t: RTCRtpTransceiver): void {
    this.transceivers.push(t);
  }

  replaceTransceiver(t: RTCRtpTransceiver, index: number): void {
    this.transceivers[index] = t;
  }

  addTransceiver(
    trackOrKind: Kind | MediaStreamTrack,
    dtlsTransport?: RTCDtlsTransport,
    options: Partial<TransceiverOptions> = {},
  ): RTCRtpTransceiver {
    const kind =
      typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind;

    const direction = options.direction || "sendrecv";

    if (typeof trackOrKind !== "string") {
      captureTrackSourceCodecs(trackOrKind);
      assertCodecsSupported({
        kind,
        configured: this.filterCodecsByDirection(kind, direction),
        source: getTrackSourceCodecs(trackOrKind),
        preferences: undefined,
      });
    }

    const sender = new RTCRtpSender(trackOrKind, {
      pendingRtp: this.config.pendingRtp,
    });
    const receiver = new RTCRtpReceiver(this.config, kind, sender.ssrc);
    const newTransceiver = new RTCRtpTransceiver(
      kind,
      dtlsTransport,
      receiver,
      sender,
      direction,
    );
    newTransceiver.options = {
      ...options,
      simulcast:
        options.simulcast ?? simulcastFromSendEncodings(options.sendEncodings),
    };
    newTransceiver.sender.setStreams(options.streams ?? []);
    newTransceiver.sender.setSendEncodings(
      (
        (options.sendEncodings as RTCRtpEncodingParameters[] | undefined) ?? []
      ).map((encoding) => ({ ...encoding })),
    );
    this.router.registerRtpSender(newTransceiver.sender);

    // reuse inactive
    const inactiveTransceiverIndex = this.transceivers.findIndex(
      (t) => t.currentDirection === "inactive" && !t.usedForSender,
    );
    const inactiveTransceiver = this.transceivers.find(
      (t) => t.currentDirection === "inactive" && !t.usedForSender,
    );
    if (inactiveTransceiverIndex > -1 && inactiveTransceiver) {
      this.replaceTransceiver(newTransceiver, inactiveTransceiverIndex);
      newTransceiver.mLineIndex = inactiveTransceiver.mLineIndex;
      newTransceiver.mid = inactiveTransceiver.mid;
      inactiveTransceiver.setCurrentDirection(undefined);
    } else {
      this.pushTransceiver(newTransceiver);
    }
    this.onTransceiverAdded.execute(newTransceiver);

    return newTransceiver;
  }

  addTrack(
    track: MediaStreamTrack,
    streams: MediaStream[] = [],
  ): RTCRtpTransceiver {
    if (this.getSenders().find((sender) => sender.track?.uuid === track.uuid)) {
      throw createWebRtcDomException(
        "InvalidAccessError",
        "Track already added",
      );
    }

    const emptyTrackSenderTransceiver = this.transceivers.find(
      (t) =>
        t.sender.track == undefined &&
        t.kind === track.kind &&
        SenderDirections.includes(t.direction) === true,
    );
    if (emptyTrackSenderTransceiver) {
      this.validateTrackForTransceiver(track, emptyTrackSenderTransceiver);
      const sender = emptyTrackSenderTransceiver.sender;
      sender.setStreams(streams);
      sender.registerTrack(track);
      emptyTrackSenderTransceiver.options = {
        ...emptyTrackSenderTransceiver.options,
        streams,
      };
      emptyTrackSenderTransceiver.codecs = [];
      return emptyTrackSenderTransceiver;
    }

    const notSendTransceiver = this.transceivers.find(
      (t) =>
        t.sender.track == undefined &&
        t.kind === track.kind &&
        SenderDirections.includes(t.direction) === false &&
        !t.usedForSender,
    );
    if (notSendTransceiver) {
      const nextDirection =
        notSendTransceiver.direction === "recvonly"
          ? "sendrecv"
          : notSendTransceiver.direction === "inactive"
            ? "sendonly"
            : notSendTransceiver.direction;
      this.validateTrackForTransceiver(
        track,
        notSendTransceiver,
        nextDirection,
      );
      const sender = notSendTransceiver.sender;
      sender.setStreams(streams);
      sender.registerTrack(track);
      notSendTransceiver.options = {
        ...notSendTransceiver.options,
        streams,
      };
      switch (notSendTransceiver.direction) {
        case "recvonly":
          notSendTransceiver.setDirection("sendrecv");
          break;
        case "inactive":
          notSendTransceiver.setDirection("sendonly");
          break;
      }
      notSendTransceiver.codecs = [];
      return notSendTransceiver;
    } else {
      const transceiver = this.addTransceiver(track, undefined, {
        direction: "sendrecv",
        streams,
      });
      return transceiver;
    }
  }

  removeTrack(sender: RTCRtpSender): void {
    if (!this.getSenders().find(({ ssrc }) => sender.ssrc === ssrc)) {
      throw createWebRtcDomException(
        "InvalidAccessError",
        "Sender does not exist",
      );
    }

    const transceiver = this.transceivers.find(
      ({ sender: { ssrc } }) => sender.ssrc === ssrc,
    );
    if (!transceiver) throw new Error("No matching transceiver found");

    if (transceiver.stopping || transceiver.stopped) {
      return;
    }

    sender.stop();

    if (["recvonly", "inactive"].includes(transceiver.currentDirection ?? "")) {
      this.onNegotiationNeeded.execute();
      return;
    }

    if (transceiver.direction === "sendrecv") {
      transceiver.setDirection("recvonly");
    } else if (
      transceiver.direction === "sendonly" ||
      transceiver.direction === "recvonly"
    ) {
      transceiver.setDirection("inactive");
    }
  }

  assignTransceiverCodecs(transceiver: RTCRtpTransceiver): void {
    const configured = this.filterCodecsByDirection(
      transceiver.kind,
      transceiver.direction,
    );
    transceiver.codecs = assertCodecsSupported({
      kind: transceiver.kind,
      configured,
      source: getTrackSourceCodecs(transceiver.sender.track),
      preferences: transceiver.codecPreferences,
    });
  }

  private filterCodecsByDirection(
    kind: Kind,
    direction: RTCRtpTransceiver["direction"],
  ) {
    return (this.config.codecs[kind] as RTCRtpCodecParameters[]).filter(
      (codecCandidate) => {
        switch (codecCandidate.direction) {
          case "recvonly": {
            if (ReceiverDirection.includes(direction)) return true;
            return false;
          }
          case "sendonly": {
            if (SenderDirections.includes(direction)) return true;
            return false;
          }
          case "sendrecv": {
            if ([Sendrecv, Recvonly, Sendonly].includes(direction)) return true;
            return false;
          }
          case "all": {
            return true;
          }
          default:
            return false;
        }
      },
    );
  }

  private validateTrackForTransceiver(
    track: MediaStreamTrack,
    transceiver: RTCRtpTransceiver,
    direction = transceiver.direction,
  ) {
    captureTrackSourceCodecs(track);
    assertCodecsSupported({
      kind: track.kind,
      configured: this.filterCodecsByDirection(track.kind, direction),
      source: getTrackSourceCodecs(track),
      preferences: transceiver.codecPreferences,
    });
  }

  getLocalRtpParams(transceiver: RTCRtpTransceiver): RTCRtpParameters {
    if (transceiver.mid == undefined) throw new Error("mid not assigned");

    const rtp: RTCRtpParameters = {
      codecs: transceiver.codecs,
      muxId: transceiver.mid,
      headerExtensions: transceiver.headerExtensions,
      rtcp: { cname: this.cname, ssrc: transceiver.sender.ssrc, mux: true },
    };
    return rtp;
  }

  getRemoteRtpParams(
    media: MediaDescription,
    transceiver: RTCRtpTransceiver,
  ): RTCRtpReceiveParameters {
    const receiveParameters: RTCRtpReceiveParameters = {
      muxId: media.rtp.muxId,
      rtcp: media.rtp.rtcp,
      codecs: transceiver.codecs,
      headerExtensions: transceiver.headerExtensions,
      encodings: Object.values(
        transceiver.codecs.reduce(
          (acc: { [pt: number]: RTCRtpCodingParameters }, codec) => {
            if (codec.name.toLowerCase() === "rtx") {
              const params = codecParametersFromString(codec.parameters ?? "");
              const apt = acc[params["apt"]];
              if (apt && media.ssrc.length === 2) {
                apt.rtx = new RTCRtpRtxParameters({ ssrc: media.ssrc[1].ssrc });
              }
              return acc;
            }
            acc[codec.payloadType] = new RTCRtpCodingParameters({
              ssrc: media.ssrc[0]?.ssrc,
              payloadType: codec.payloadType,
            });
            return acc;
          },
          {},
        ),
      ),
    };

    return receiveParameters;
  }

  /**
   * remote offer と local (source constraint + preferences) から
   * answer 用の codec を再解決し、sender/receiver の codec 状態も
   * 新しい negotiated codec に同期する。
   * setCodecPreferences() による無効化後に createAnswer() から呼ばれる。
   * direction / headerExtensions / onTrack は setRemoteDescription() 時の
   * まま変えない (track イベントの重複発火を避ける)。
   */
  resyncAnswerCodecs(
    transceiver: RTCRtpTransceiver,
    remoteMedia: MediaDescription,
  ): void {
    this.refreshAnswerCodecs(transceiver, remoteMedia);

    const localParams = this.getLocalRtpParams(transceiver);
    transceiver.sender.prepareSend(localParams);

    if (["recvonly", "sendrecv"].includes(transceiver.direction)) {
      const remoteParams = this.getRemoteRtpParams(remoteMedia, transceiver);
      for (const param of remoteMedia.simulcastParameters) {
        this.router.registerRtpReceiverByRid(transceiver, param, remoteParams);
      }
      transceiver.receiver.prepareReceive(remoteParams);
      this.router.registerRtpReceiverBySsrc(transceiver, remoteParams);
    }

    if (remoteMedia.ssrc[0]?.ssrc) {
      transceiver.receiver.setupTWCC(remoteMedia.ssrc[0].ssrc);
    }
  }

  /**
   * remote offer と local (source constraint + preferences) から
   * answer 用の codec だけを再解決する (sender/receiver の同期なし)。
   * setRemoteRTP() の交渉部分として使う。
   */
  refreshAnswerCodecs(
    transceiver: RTCRtpTransceiver,
    remoteMedia: MediaDescription,
  ): void {
    const localCodecs = resolveCodecs(
      this.config.codecs[remoteMedia.kind] || [],
      getTrackSourceCodecs(transceiver.sender.track),
      transceiver.codecPreferences,
    );
    assertCodecsSupported({
      kind: remoteMedia.kind,
      configured: this.config.codecs[remoteMedia.kind] || [],
      source: getTrackSourceCodecs(transceiver.sender.track),
      preferences: transceiver.codecPreferences,
    });

    // # negotiate codecs
    transceiver.codecs = remoteMedia.rtp.codecs.filter((remoteCodec) => {
      const existCodec = findCodecByMimeType(localCodecs, remoteCodec);
      if (!existCodec) {
        return false;
      }

      if (existCodec?.name.toLowerCase() === "rtx") {
        const params = codecParametersFromString(existCodec.parameters ?? "");
        const pt = params["apt"];
        const origin = remoteMedia.rtp.codecs.find((c) => c.payloadType === pt);
        if (!origin) {
          return false;
        }
        return !!findCodecByMimeType(localCodecs, origin);
      }

      return true;
    });

    log("negotiated codecs", transceiver.codecs);
    if (transceiver.codecs.length === 0) {
      throw createWebRtcDomException(
        "NotSupportedError",
        "No compatible codec remains after remote negotiation.",
      );
    }
  }

  setRemoteRTP(
    transceiver: RTCRtpTransceiver,
    remoteMedia: MediaDescription,
    type: "offer" | "answer" | "pranswer",
    mLineIndex: number,
  ): void {
    if (!transceiver.mid) {
      transceiver.mid = remoteMedia.rtp.muxId ?? null;
    }
    transceiver.mLineIndex = mLineIndex;

    this.refreshAnswerCodecs(transceiver, remoteMedia);
    transceiver.headerExtensions = remoteMedia.rtp.headerExtensions.filter(
      (extension) =>
        (
          this.config.headerExtensions[remoteMedia.kind as "audio" | "video"] ||
          []
        ).find((v) => v.uri === extension.uri),
    );

    // # configure direction
    const mediaDirection = remoteMedia.direction ?? "inactive";
    const direction = reverseDirection(mediaDirection);
    if (["answer", "pranswer"].includes(type)) {
      transceiver.setCurrentDirection(direction);
    } else {
      transceiver.offerDirection = direction;
    }
    const localParams = this.getLocalRtpParams(transceiver);
    transceiver.sender.prepareSend(localParams);

    if (["recvonly", "sendrecv"].includes(transceiver.direction)) {
      const remotePrams = this.getRemoteRtpParams(remoteMedia, transceiver);

      // register simulcast receiver
      for (const param of remoteMedia.simulcastParameters) {
        this.router.registerRtpReceiverByRid(transceiver, param, remotePrams);
      }

      transceiver.receiver.prepareReceive(remotePrams);
      // register ssrc receiver
      this.router.registerRtpReceiverBySsrc(transceiver, remotePrams);
    }
    if (
      remoteMedia.port !== 0 &&
      ["sendonly", "sendrecv"].includes(mediaDirection)
    ) {
      const remoteStreamIds = [
        ...new Set(remoteMedia.msids.map((msid) => msid.split(" ")[0])),
      ];
      const remoteTrackId = remoteMedia.msids[0]?.split(" ")[1];
      transceiver.receiver.remoteStreamId = remoteStreamIds[0];
      transceiver.receiver.remoteStreamIds = remoteStreamIds;
      transceiver.receiver.remoteTrackId = remoteTrackId;

      this.onTrack.execute({
        track: transceiver.receiver.track,
        transceiver,
        streams: remoteStreamIds.map(
          (id) =>
            new MediaStream({
              id,
              tracks: [transceiver.receiver.track],
            }),
        ),
      });
    }

    if (remoteMedia.ssrc[0]?.ssrc) {
      transceiver.receiver.setupTWCC(remoteMedia.ssrc[0].ssrc);
    }
  }

  collectStats(timestamp: number): RTCStats[] {
    const stats: RTCStats[] = [];

    for (const transceiver of this.transceivers) {
      if (transceiver.sender) {
        stats.push(...transceiver.sender.collectStats(timestamp));
      }

      if (transceiver.receiver) {
        stats.push(...transceiver.receiver.collectStats(timestamp));
      }

      const codecStats = transceiver.collectCodecStats(timestamp);
      if (codecStats) {
        stats.push(...codecStats);
      }
    }

    return stats;
  }

  getStatsRootIds(selector: MediaStreamTrack | null | undefined) {
    if (!selector) {
      return [];
    }

    const rootIds: string[] = [];
    for (const transceiver of this.transceivers) {
      if (transceiver.sender.track === selector) {
        rootIds.push(...transceiver.sender.getStatsRootIds());
      }
      if (transceiver.receiver.tracks.includes(selector)) {
        rootIds.push(...transceiver.receiver.getStatsRootIds(selector));
      }
    }

    return rootIds;
  }

  /**
   * 全トランシーバーのreceiver/senderのstopを呼ぶcloseメソッド
   */
  close() {
    for (const transceiver of this.transceivers) {
      transceiver.forceStop();
    }

    this.onTransceiverAdded.allUnsubscribe();
    this.onRemoteTransceiverAdded.allUnsubscribe();
    this.onTrack.allUnsubscribe();
    this.onNegotiationNeeded.allUnsubscribe();
  }
}
