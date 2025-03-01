import { debug } from "../../imports/common";
import type { Kind, RTCSignalingState } from "../../types/domain";
import type { BaseManager } from "../types/manager";
import type { PeerConnectionContext } from "../types/peerConnectionContext";
import {
  MediaStream,
  type MediaStreamTrack,
  RTCRtpReceiver,
  RTCRtpSender,
  RTCRtpTransceiver,
  type TransceiverOptions,
  useOPUS,
  usePCMU,
  useVP8,
} from "../../media";
import { SenderDirections } from "../../const";

const log = debug("werift:webrtc/mediaManager");

export class MediaManager implements BaseManager {
  constructor(public readonly context: PeerConnectionContext) {}

  addTransceiver(
    trackOrKind: Kind | MediaStreamTrack,
    options: Partial<TransceiverOptions> = {},
  ) {
    const kind =
      typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind;

    const direction = options.direction || "sendrecv";

    const dtlsTransport = this.context.connection.dtlsTransports[0]; //this.context.dtlsManager.createTransport([
    //SRTP_PROFILE.SRTP_AEAD_AES_128_GCM, // prefer
    //SRTP_PROFILE.SRTP_AES128_CM_HMAC_SHA1_80,
    //]);

    const sender = new RTCRtpSender(trackOrKind);
    const receiver = new RTCRtpReceiver(this.context.config, kind, sender.ssrc);
    const newTransceiver = new RTCRtpTransceiver(
      kind,
      dtlsTransport,
      receiver,
      sender,
      direction,
    );
    newTransceiver.options = options;
    this.context.router.registerRtpSender(newTransceiver.sender);

    // reuse inactive
    const inactiveTransceiverIndex =
      this.context.connection.transceivers.findIndex(
        (t) => t.currentDirection === "inactive",
      );
    const inactiveTransceiver = this.context.connection.transceivers.find(
      (t) => t.currentDirection === "inactive",
    );
    if (inactiveTransceiverIndex > -1 && inactiveTransceiver) {
      this.context.connection.transceivers[inactiveTransceiverIndex] =
        newTransceiver;
      newTransceiver.mLineIndex = inactiveTransceiver.mLineIndex;
      inactiveTransceiver.setCurrentDirection(undefined);
    } else {
      this.context.connection.transceivers.push(newTransceiver);
    }
    this.context.connection.onTransceiverAdded.execute(newTransceiver);

    this.context.updateIceConnectionState();
    this.context.needNegotiation();

    return newTransceiver;
  }

  addTrack(
    track: MediaStreamTrack,
    /**todo impl */
    ms?: MediaStream,
  ) {
    if (this.context.connection.isClosed) {
      throw new Error("is closed");
    }
    if (
      this.context.connection.transceivers
        .map((t) => t.sender)
        .find((sender) => sender.track?.uuid === track.uuid)
    ) {
      throw new Error("track exist");
    }

    const emptyTrackSender = this.context.connection.transceivers.find(
      (t) =>
        t.sender.track == undefined &&
        t.kind === track.kind &&
        SenderDirections.includes(t.direction) === true,
    );
    if (emptyTrackSender) {
      const sender = emptyTrackSender.sender;
      sender.registerTrack(track);
      this.context.needNegotiation();
      return sender;
    }

    const notSendTransceiver = this.context.connection.transceivers.find(
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
      this.context.needNegotiation();
      return sender;
    } else {
      const transceiver = this.addTransceiver(track, {
        direction: "sendrecv",
      });
      this.context.needNegotiation();
      return transceiver.sender;
    }
  }

  removeTrack(sender: RTCRtpSender) {
    if (this.context.connection.isClosed) throw new Error("peer closed");
    if (
      !this.context.connection.transceivers
        .map((t) => t.sender)
        .find(({ ssrc }) => sender.ssrc === ssrc)
    ) {
      throw new Error("unExist");
    }

    const transceiver = this.context.connection.transceivers.find(
      ({ sender: { ssrc } }) => sender.ssrc === ssrc,
    );
    if (!transceiver) {
      throw new Error("unExist");
    }

    sender.stop();

    if (transceiver.currentDirection === "recvonly") {
      this.context.needNegotiation();
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
    this.context.needNegotiation();
  }

  fireOnTrack(
    track: MediaStreamTrack,
    transceiver: RTCRtpTransceiver,
    stream: MediaStream,
  ) {
    const event: RTCTrackEvent = {
      track,
      streams: [stream],
      transceiver,
      receiver: transceiver.receiver,
    };
    this.context.connection.onTrack.execute(track);
    this.context.connection.emit("track", event);
    if (this.context.connection.ontrack) {
      this.context.connection.ontrack(event);
    }
  }

  dispose() {
    // Cleanup any media-specific resources if needed
  }
}

export interface RTCTrackEvent {
  track: MediaStreamTrack;
  streams: MediaStream[];
  transceiver: RTCRtpTransceiver;
  receiver: RTCRtpReceiver;
}
