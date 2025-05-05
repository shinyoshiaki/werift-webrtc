import { ReceiverDirection, SenderDirections } from "../const";
import { Event, debug } from "../imports/common";
import { type PeerConfig, findCodecByMimeType } from "../peerConnection";
import { type MediaDescription, codecParametersFromString } from "../sdp";
import type { RTCDtlsTransport } from "../transport/dtls";
import type { Kind } from "../types/domain";
import { reverseDirection } from "../utils";
import {
  MediaStream,
  type MediaStreamTrack,
  type RTCRtpCodecParameters,
  RTCRtpCodingParameters,
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
} from "./";

const log = debug("werift:packages/webrtc/src/media/rtpTransceiverManager.ts");

export class TransceiverManager {
  private readonly transceivers: RTCRtpTransceiver[] = [];

  readonly onTransceiverAdded = new Event<[RTCRtpTransceiver]>();
  readonly onRemoteTransceiverAdded = new Event<[RTCRtpTransceiver]>();
  readonly onTrack = new Event<
    [
      {
        track: MediaStreamTrack;
        transceiver: RTCRtpTransceiver;
        stream: MediaStream;
      },
    ]
  >();
  readonly onNegotiationNeeded = new Event<[]>();

  constructor(
    private readonly cname: string,
    private readonly config: Required<PeerConfig>,
    private readonly router: RtpRouter,
    private readonly createTransport: () => RTCDtlsTransport,
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
    options: Partial<TransceiverOptions> = {},
  ): RTCRtpTransceiver {
    const kind =
      typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind;

    const direction = options.direction || "sendrecv";

    const dtlsTransport = this.createTransport();

    const sender = new RTCRtpSender(trackOrKind);
    const receiver = new RTCRtpReceiver(this.config, kind, sender.ssrc);
    const newTransceiver = new RTCRtpTransceiver(
      kind,
      dtlsTransport,
      receiver,
      sender,
      direction,
    );
    newTransceiver.options = options;
    this.router.registerRtpSender(newTransceiver.sender);

    // reuse inactive
    const inactiveTransceiverIndex = this.transceivers.findIndex(
      (t) => t.currentDirection === "inactive",
    );
    const inactiveTransceiver = this.transceivers.find(
      (t) => t.currentDirection === "inactive",
    );
    if (inactiveTransceiverIndex > -1 && inactiveTransceiver) {
      this.replaceTransceiver(newTransceiver, inactiveTransceiverIndex);
      newTransceiver.mLineIndex = inactiveTransceiver.mLineIndex;
      inactiveTransceiver.setCurrentDirection(undefined);
    } else {
      this.pushTransceiver(newTransceiver);
    }
    this.onTransceiverAdded.execute(newTransceiver);

    return newTransceiver;
  }

  addTrack(track: MediaStreamTrack, ms?: MediaStream): RTCRtpSender {
    if (this.getSenders().find((sender) => sender.track?.uuid === track.uuid)) {
      throw new Error("track exist");
    }

    const emptyTrackSender = this.transceivers.find(
      (t) =>
        t.sender.track == undefined &&
        t.kind === track.kind &&
        SenderDirections.includes(t.direction) === true,
    );
    if (emptyTrackSender) {
      const sender = emptyTrackSender.sender;
      sender.registerTrack(track);
      return sender;
    }

    const notSendTransceiver = this.transceivers.find(
      (t) =>
        t.sender.track == undefined &&
        t.kind === track.kind &&
        SenderDirections.includes(t.direction) === false &&
        !t.usedForSender,
    );
    if (notSendTransceiver) {
      const sender = notSendTransceiver.sender;
      sender.registerTrack(track);
      switch (notSendTransceiver.direction) {
        case "recvonly":
          notSendTransceiver.setDirection("sendrecv");
          break;
        case "inactive":
          notSendTransceiver.setDirection("sendonly");
          break;
      }
      this.onNegotiationNeeded.execute();
      return sender;
    } else {
      const transceiver = this.addTransceiver(track, {
        direction: "sendrecv",
      });
      this.onNegotiationNeeded.execute();
      return transceiver.sender;
    }
  }

  removeTrack(sender: RTCRtpSender): void {
    if (!this.getSenders().find(({ ssrc }) => sender.ssrc === ssrc)) {
      throw new Error("unExist");
    }

    const transceiver = this.transceivers.find(
      ({ sender: { ssrc } }) => sender.ssrc === ssrc,
    );
    if (!transceiver) throw new Error("unExist");

    sender.stop();

    if (transceiver.currentDirection === "recvonly") {
      this.onNegotiationNeeded.execute();
      return;
    }

    if (transceiver.stopping || transceiver.stopped) {
      transceiver.setDirection("inactive");
    } else {
      if (transceiver.direction === "sendrecv") {
        transceiver.setDirection("recvonly");
      } else if (
        transceiver.direction === "sendonly" ||
        transceiver.direction === "recvonly"
      ) {
        transceiver.setDirection("inactive");
      }
    }
  }

  assignTransceiverCodecs(transceiver: RTCRtpTransceiver): void {
    const codecs = (
      this.config.codecs[transceiver.kind] as RTCRtpCodecParameters[]
    ).filter((codecCandidate) => {
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

  setRemoteRTP(
    transceiver: RTCRtpTransceiver,
    remoteMedia: MediaDescription,
    type: "offer" | "answer",
    mLineIndex: number,
  ): void {
    if (!transceiver.mid) {
      transceiver.mid = remoteMedia.rtp.muxId;
    }
    transceiver.mLineIndex = mLineIndex;

    // # negotiate codecs
    transceiver.codecs = remoteMedia.rtp.codecs.filter((remoteCodec) => {
      const localCodecs = this.config.codecs[remoteMedia.kind] || [];

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
      throw new Error("negotiate codecs failed.");
    }
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
      remoteMedia.simulcastParameters.forEach((param) => {
        this.router.registerRtpReceiverByRid(transceiver, param, remotePrams);
      });

      transceiver.receiver.prepareReceive(remotePrams);
      // register ssrc receiver
      this.router.registerRtpReceiverBySsrc(transceiver, remotePrams);
    }
    if (["sendonly", "sendrecv"].includes(mediaDirection)) {
      if (remoteMedia.msid) {
        const [streamId, trackId] = remoteMedia.msid.split(" ");
        transceiver.receiver.remoteStreamId = streamId;
        transceiver.receiver.remoteTrackId = trackId;
      }

      this.onTrack.execute({
        track: transceiver.receiver.track,
        transceiver,
        stream: new MediaStream({
          id: transceiver.receiver.remoteStreamId,
          tracks: [transceiver.receiver.track],
        }),
      });
    }

    if (remoteMedia.ssrc[0]?.ssrc) {
      transceiver.receiver.setupTWCC(remoteMedia.ssrc[0].ssrc);
    }
  }
}
