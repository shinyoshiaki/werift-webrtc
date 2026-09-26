import { randomUUID } from "crypto";
import { Event } from "../imports/common";

import type { RTCDtlsTransport } from "..";
import { SenderDirections } from "../const";
import type { Kind } from "../types/domain";
import type {
  RTCRtpCodecParameters,
  RTCRtpHeaderExtensionParameters,
} from "./parameters";
import type { RTCRtpReceiver } from "./rtpReceiver";
import type { RTCRtpSender } from "./rtpSender";
import {
  type RTCCodecStats,
  type RTCStats,
  generateCodecStatsId,
  generateStatsId,
  getStatsTimestamp,
} from "./stats";
import type { MediaStream, MediaStreamTrack } from "./track";

export class RTCRtpTransceiver {
  readonly id = randomUUID().toString();
  readonly onTrack = new Event<[MediaStreamTrack, RTCRtpTransceiver]>();
  mid: string | null = null;
  mLineIndex?: number;
  /**should not be reused because it has been used for sending before. */
  usedForSender = false;
  private _currentDirection?: CurrentDirection;
  offerDirection!: MediaDirection;
  _codecs: RTCRtpCodecParameters[] = [];
  set codecs(codecs: RTCRtpCodecParameters[]) {
    this._codecs = codecs;
  }
  get codecs() {
    return this._codecs;
  }
  headerExtensions: RTCRtpHeaderExtensionParameters[] = [];
  options: Partial<TransceiverOptions> = {};
  /**stop() 済み、または停止が確定した transceiver */
  stopping = false;
  /**port 0 の交渉が確定し、m-line が停止した transceiver */
  stopped = false;
  /**
   * 共通 codec がない / remote port 0 のため answer で拒否することが確定した。
   * `inactive` や app の `stop()` とは区別し、確定後は `stopped` も true になる。
   */
  rejected = false;
  /**
   * remote offer の m-line を拒否予定 (answer 未確定)。
   * 確定するまで既存の RTP pipeline / track は維持し、rollback で false に戻す。
   */
  pendingRejection = false;
  /**@private remote から受信中として track event を通知済みか */
  firedReceiving = false;
  /**@private app の stop() 要求を manager に伝える */
  readonly onStopRequested = new Event<[]>();
  /**@private 停止の確定または stop() でメディア資源を解放する際に通知する */
  readonly onRelease = new Event<[]>();

  constructor(
    public readonly kind: Kind,
    dtlsTransport: RTCDtlsTransport | undefined,
    public receiver: RTCRtpReceiver,
    public sender: RTCRtpSender,
    /**RFC 8829 4.2.4.  direction the transceiver was initialized with */
    private _direction: MediaDirection,
  ) {
    if (dtlsTransport) {
      this.setDtlsTransport(dtlsTransport);
    }
  }

  get dtlsTransport() {
    return this.receiver.dtlsTransport;
  }

  /**RFC 8829 4.2.4. setDirectionに渡された最後の値を示します */
  get direction() {
    return this._direction;
  }

  set direction(direction: MediaDirection) {
    this.setDirection(direction);
  }

  setDirection(direction: MediaDirection) {
    this._direction = direction;
    if (
      this._currentDirection &&
      this._currentDirection !== "stopped" &&
      SenderDirections.includes(this._currentDirection)
    ) {
      this.usedForSender = true;
    }
  }

  /**RFC 8829 4.2.5. last negotiated direction */
  get currentDirection(): CurrentDirection | null {
    return this._currentDirection ?? null;
  }

  setCurrentDirection(direction: CurrentDirection | undefined) {
    this._currentDirection = direction;
    if (
      direction &&
      direction !== "stopped" &&
      SenderDirections.includes(direction) &&
      this.sender.track
    ) {
      // 実際に送信へ使われた sender は addTrack の自動再使用対象から外す
      this.usedForSender = true;
    }
  }

  setDtlsTransport(dtls: RTCDtlsTransport) {
    this.receiver.setDtlsTransport(dtls);
    this.sender.setDtlsTransport(dtls);
  }

  get msid() {
    return this.msids[0];
  }

  get msids() {
    return this.sender.streamIds.map(
      (streamId) => `${streamId} ${this.sender.trackId}`,
    );
  }

  addTrack(track: MediaStreamTrack) {
    const res = this.receiver.addTrack(track);
    if (res) {
      this.onTrack.execute(track, this);
    }
  }

  /**m-line (MID / index) と関連付け済みか */
  get associated() {
    return this.mid != null && this.mLineIndex != undefined;
  }

  /**
   * https://www.w3.org/TR/webrtc/#dom-rtcrtptransceiver-stop
   * 送受信をただちに止めて資源を解放し、次の自分の offer で port 0 を交渉する。
   * 冪等で、2 回目以降は何もしない。
   */
  stop() {
    if (this.stopping) {
      return;
    }

    this.stopping = true;
    this.releaseMedia();
    if (!this.associated) {
      // m-line と未関連付けなら交渉対象の m-line を作らずに停止を確定する
      this.markStopped();
    }
    this.onStopRequested.execute();
  }

  /**
   * @private
   * port 0 の交渉確定 (自分の stop の answer / remote による拒否) を反映する。
   */
  commitStopped({ rejected }: { rejected: boolean }) {
    if (rejected && !this.stopping) {
      this.rejected = true;
    }
    this.pendingRejection = false;
    this.stopping = true;
    this.releaseMedia();
    this.markStopped();
  }

  private markStopped() {
    this.stopped = true;
    this.setCurrentDirection("stopped");
  }

  private releaseMedia() {
    // W3C の stop() は sender.track を null にしないため参照は維持する
    this.sender.stop({ keepTrack: true });
    this.receiver.stop();
    this.receiver.endTracks();
    this.onRelease.execute();
  }

  forceStop() {
    if (this.stopped && this.sender.stopped && this.receiver.stopped) {
      return;
    }

    this.stopping = true;
    this.stopped = true;
    this.setCurrentDirection("stopped");
    this.receiver.stop();
    this.sender.stop();
    this.onRelease.execute();
  }

  getPayloadType(mimeType: string) {
    return this.codecs.find((codec) =>
      codec.mimeType.toLowerCase().includes(mimeType.toLowerCase()),
    )?.payloadType;
  }

  getCodecStats(): RTCStats[] {
    const timestamp = getStatsTimestamp();
    return this.collectCodecStats(timestamp);
  }

  collectCodecStats(timestamp: number): RTCStats[] {
    const stats: RTCStats[] = [];

    if (!this.dtlsTransport) {
      return stats;
    }

    const transportId = generateStatsId("transport", this.dtlsTransport.id);

    // Add codec stats for each codec
    for (const codec of this.codecs) {
      const codecStats: RTCCodecStats = {
        type: "codec",
        id: generateCodecStatsId(transportId, codec.payloadType, this.id),
        timestamp,
        payloadType: codec.payloadType,
        transportId,
        mimeType: codec.mimeType,
        clockRate: codec.clockRate,
        channels: codec.channels,
        sdpFmtpLine: codec.parameters,
      };
      stats.push(codecStats);
    }

    return stats;
  }
}

export const Inactive = "inactive";
export const Sendonly = "sendonly";
export const Recvonly = "recvonly";
export const Sendrecv = "sendrecv";

export const Directions = [Inactive, Sendonly, Recvonly, Sendrecv] as const;

export type MediaDirection = (typeof Directions)[number];
export type CurrentDirection = MediaDirection | "stopped";

type SimulcastDirection = "send" | "recv";

export interface RTCRtpEncodingParameters {
  active?: boolean;
  rid?: string;
  maxBitrate?: number;
}

export interface TransceiverOptions {
  direction: MediaDirection;
  sendEncodings: RTCRtpEncodingParameters[];
  simulcast: { direction: SimulcastDirection; rid: string }[];
  streams: MediaStream[];
}
