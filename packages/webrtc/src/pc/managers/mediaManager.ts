import { SenderDirections } from "../../const";
import { Event, debug } from "../../imports/common";
import {
  type MediaDirection,
  type MediaStream,
  type MediaStreamTrack,
  RTCRtpReceiver,
  RTCRtpSender,
  RTCRtpTransceiver,
  type TransceiverOptions,
} from "../../media";
import type { RTCDtlsTransport } from "../../transport/dtls";
import type { Kind } from "../../types/domain";
import type { CallbackWithValue } from "../../types/util";
import type { PeerConfig } from "../util";
import { allocateMid } from "../util";

const log = debug("werift:webrtc/mediaManager");

/**
 * Media Manager
 * Handles media (transceiver, sender, receiver) related operations
 */
export class MediaManager {
  readonly onTrack = new Event<[MediaStreamTrack]>();
  readonly onTransceiverAdded = new Event<[RTCRtpTransceiver]>();
  readonly onRemoteTransceiverAdded = new Event<[RTCRtpTransceiver]>();

  private transceivers: RTCRtpTransceiver[] = [];
  private seenMid = new Set<string>();

  constructor(private readonly config: Required<PeerConfig>) {}

  /**
   * Get all transceivers
   */
  getTransceivers(): RTCRtpTransceiver[] {
    return this.transceivers;
  }

  /**
   * Get all senders
   */
  getSenders(): RTCRtpSender[] {
    return this.getTransceivers().map((t) => t.sender);
  }

  /**
   * Get all receivers
   */
  getReceivers(): RTCRtpReceiver[] {
    return this.getTransceivers().map((t) => t.receiver);
  }

  /**
   * Add a new transceiver
   */
  addTransceiver(
    trackOrKind: Kind | MediaStreamTrack,
    dtlsTransport: RTCDtlsTransport,
    options: Partial<TransceiverOptions> = {},
  ): RTCRtpTransceiver {
    const kind =
      typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind;
    const direction = options.direction || "sendrecv";

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

    // Reuse inactive transceiver if exists
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

  /**
   * Add a track to an existing transceiver or create a new one
   */
  addTrack(
    track: MediaStreamTrack,
    dtlsTransport: RTCDtlsTransport,
    streams: MediaStream[] = [],
  ): RTCRtpSender {
    // Check if track already exists
    if (
      this.transceivers
        .map((t) => t.sender)
        .find((sender) => sender.track?.uuid === track.uuid)
    ) {
      throw new Error("Track already exists");
    }

    // Try to find an existing transceiver with empty track slot
    const emptyTrackTransceiver = this.transceivers.find(
      (t) =>
        t.sender.track == undefined &&
        t.kind === track.kind &&
        SenderDirections.includes(t.direction) === true,
    );

    if (emptyTrackTransceiver) {
      const sender = emptyTrackTransceiver.sender;
      sender.registerTrack(track);
      return sender;
    }

    // Try to find a non-sending transceiver that can be repurposed
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

      return sender;
    } else {
      // Create a new transceiver
      const transceiver = this.addTransceiver(track, dtlsTransport, {
        direction: "sendrecv",
      });

      return transceiver.sender;
    }
  }

  /**
   * Remove a track from its transceiver
   */
  removeTrack(sender: RTCRtpSender) {
    if (
      !this.transceivers
        .map((t) => t.sender)
        .find(({ ssrc }) => sender.ssrc === ssrc)
    ) {
      throw new Error("Sender not found");
    }

    const transceiver = this.transceivers.find(
      ({ sender: { ssrc } }) => sender.ssrc === ssrc,
    );

    if (!transceiver) {
      throw new Error("Transceiver not found");
    }

    sender.stop();

    if (transceiver.currentDirection === "recvonly") {
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

  /**
   * Fire track event
   */
  fireOnTrack(
    track: MediaStreamTrack,
    transceiver: RTCRtpTransceiver,
    stream: MediaStream,
  ) {
    const event = {
      track,
      streams: [stream],
      transceiver,
      receiver: transceiver.receiver,
    };

    this.onTrack.execute(track);
    return event;
  }

  /**
   * Find transceiver by MID
   */
  getTransceiverByMid(mid: string): RTCRtpTransceiver | undefined {
    return this.transceivers.find((transceiver) => transceiver.mid === mid);
  }

  /**
   * Find transceiver by mLineIndex
   */
  getTransceiverByMLineIndex(index: number): RTCRtpTransceiver | undefined {
    return this.transceivers.find(
      (transceiver) => transceiver.mLineIndex === index,
    );
  }

  /**
   * Add a transceiver to the list
   */
  pushTransceiver(transceiver: RTCRtpTransceiver) {
    this.transceivers.push(transceiver);
  }

  /**
   * Replace a transceiver at a specific index
   */
  replaceTransceiver(transceiver: RTCRtpTransceiver, index: number) {
    this.transceivers[index] = transceiver;
  }

  /**
   * Capture seen MIDs
   */
  captureMids(mids: Set<string>) {
    for (const mid of mids) {
      this.seenMid.add(mid);
    }
  }

  /**
   * Allocate a new MID
   */
  allocateNewMid(midSuffix?: boolean): string {
    return allocateMid(this.seenMid, midSuffix ? "av" : "");
  }

  /**
   * Stop all transceivers
   */
  stopAllTransceivers() {
    this.transceivers.forEach((transceiver) => {
      transceiver.receiver.stop();
      transceiver.sender.stop();
      transceiver.stopped = true;
    });
  }

  /**
   * Add remote transceiver
   */
  addRemoteTransceiver(
    kind: Kind,
    dtlsTransport: RTCDtlsTransport,
    direction: MediaDirection = "recvonly",
    mid?: string,
  ): RTCRtpTransceiver {
    const transceiver = this.addTransceiver(kind, dtlsTransport, {
      direction,
    });

    if (mid) {
      transceiver.mid = mid;
    }

    this.onRemoteTransceiverAdded.execute(transceiver);
    return transceiver;
  }

  /**
   * Serialize to JSON for live migration
   */
  toJSON() {
    return {
      transceiverIds: this.transceivers.map((t) => t.id),
      seenMid: Array.from(this.seenMid),
    };
  }

  /**
   * Restore from JSON for live migration
   */
  fromJSON(
    json: any,
    getTransceiver: (id: string) => RTCRtpTransceiver | undefined,
  ) {
    if (json.seenMid && Array.isArray(json.seenMid)) {
      this.seenMid = new Set(json.seenMid);
    }

    if (
      json.transceiverIds &&
      Array.isArray(json.transceiverIds) &&
      getTransceiver
    ) {
      this.transceivers = json.transceiverIds
        .map((id) => getTransceiver(id))
        .filter((t) => t !== undefined) as RTCRtpTransceiver[];
    }
  }
}
