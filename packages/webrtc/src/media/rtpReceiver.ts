import { debug } from "debug";
import Event from "rx.mini";
import { setTimeout } from "timers/promises";
import { v4 as uuid } from "uuid";

import { PeerConfig, codecParametersFromString, usePLI, useTWCC } from "..";
import { int } from "../../../common/src";
import {
  PictureLossIndication,
  RTP_EXTENSION_URI,
  Red,
  RedHandler,
  RtcpPacket,
  RtcpPayloadSpecificFeedback,
  RtcpReceiverInfo,
  RtcpRrPacket,
  RtcpSrPacket,
  RtpPacket,
  TransportWideCCPayload,
  unwrapRtx,
} from "../../../rtp/src";
import { RTCDtlsTransport } from "../transport/dtls";
import { Kind } from "../types/domain";
import { compactNtp, timestampSeconds } from "../utils";
import { RTCRtpCodecParameters, RTCRtpReceiveParameters } from "./parameters";
import { NackHandler } from "./receiver/nack";
import { ReceiverTWCC } from "./receiver/receiverTwcc";
import { StreamStatistics } from "./receiver/statistics";
import { Extensions } from "./router";
import { MediaStreamTrack } from "./track";

const log = debug("werift:packages/webrtc/src/media/rtpReceiver.ts");

export class RTCRtpReceiver {
  private readonly codecs: { [pt: number]: RTCRtpCodecParameters } = {};
  private get codecArray() {
    return Object.values(this.codecs).sort(
      (a, b) => a.payloadType - b.payloadType,
    );
  }
  private readonly ssrcByRtx: { [rtxSsrc: number]: number } = {};
  private readonly nack = new NackHandler(this);
  private readonly audioRedHandler = new RedHandler();

  readonly type = "receiver";
  readonly uuid = uuid();
  readonly tracks: MediaStreamTrack[] = [];
  readonly trackBySSRC: { [ssrc: string]: MediaStreamTrack } = {};
  readonly trackByRID: { [rid: string]: MediaStreamTrack } = {};
  /**last sender Report Timestamp
   * compactNtp
   */
  readonly lastSRtimestamp: { [ssrc: number]: number } = {};
  /**seconds */
  readonly receiveLastSRTimestamp: { [ssrc: number]: number } = {};
  readonly onPacketLost = this.nack.onPacketLost;
  readonly onRtcp = new Event<[RtcpPacket]>();

  dtlsTransport!: RTCDtlsTransport;
  sdesMid?: string;
  latestRid?: string;
  latestRepairedRid?: string;

  receiverTWCC?: ReceiverTWCC;
  stopped = false;
  remoteStreamId?: string;
  remoteTrackId?: string;

  rtcpRunning = false;
  private rtcpCancel = new AbortController();
  private remoteStreams: { [ssrc: number]: StreamStatistics } = {};

  constructor(
    readonly config: PeerConfig,
    public kind: Kind,
    public rtcpSsrc: number,
  ) {}

  setDtlsTransport(dtls: RTCDtlsTransport) {
    this.dtlsTransport = dtls;
  }

  // todo fix
  get track() {
    return this.tracks[0];
  }

  get nackEnabled() {
    return this.codecArray[0]?.rtcpFeedback.find((f) => f.type === "nack");
  }

  get twccEnabled() {
    return this.codecArray[0]?.rtcpFeedback.find(
      (f) => f.type === useTWCC().type,
    );
  }

  get pliEnabled() {
    return this.codecArray[0]?.rtcpFeedback.find(
      (f) => f.type === usePLI().type,
    );
  }

  prepareReceive(params: RTCRtpReceiveParameters) {
    params.codecs.forEach((c) => {
      this.codecs[c.payloadType] = c;
    });
    params.encodings.forEach((e) => {
      if (e.rtx) {
        this.ssrcByRtx[e.rtx.ssrc] = e.ssrc;
      }
    });
  }

  /**
   * setup TWCC if supported
   */
  setupTWCC(mediaSourceSsrc: number) {
    if (this.twccEnabled && !this.receiverTWCC) {
      this.receiverTWCC = new ReceiverTWCC(
        this.dtlsTransport,
        this.rtcpSsrc,
        mediaSourceSsrc,
      );
    }
  }

  addTrack(track: MediaStreamTrack) {
    const exist = this.tracks.find((t) => {
      if (t.rid) {
        return t.rid === track.rid;
      }
      if (t.ssrc) {
        return t.ssrc === track.ssrc;
      }
    });
    if (exist) {
      return false;
    }
    this.tracks.push(track);
    if (track.ssrc) {
      this.trackBySSRC[track.ssrc] = track;
    }
    if (track.rid) {
      this.trackByRID[track.rid] = track;
    }
    return true;
  }

  stop() {
    this.stopped = true;
    this.rtcpRunning = false;
    this.rtcpCancel.abort();

    if (this.receiverTWCC) this.receiverTWCC.twccRunning = false;
    this.nack.close();
  }

  async runRtcp() {
    if (this.rtcpRunning || this.stopped) return;
    this.rtcpRunning = true;

    try {
      while (this.rtcpRunning) {
        await setTimeout(500 + Math.random() * 1000, undefined, {
          signal: this.rtcpCancel.signal,
        });

        const reports = Object.entries(this.remoteStreams).map(
          ([ssrc, stream]) => {
            let lastSRtimestamp = 0,
              delaySinceLastSR = 0;
            if (this.lastSRtimestamp[ssrc]) {
              lastSRtimestamp = this.lastSRtimestamp[ssrc];
              const delaySeconds =
                timestampSeconds() - this.receiveLastSRTimestamp[ssrc];
              if (delaySeconds > 0 && delaySeconds < 65536) {
                delaySinceLastSR = int(delaySeconds * 65536);
              }
            }

            return new RtcpReceiverInfo({
              ssrc: Number(ssrc),
              fractionLost: stream.fraction_lost,
              packetsLost: stream.packets_lost,
              highestSequence: stream.max_seq,
              jitter: stream.jitter,
              lsr: lastSRtimestamp,
              dlsr: delaySinceLastSR,
            });
          },
        );

        const packet = new RtcpRrPacket({ ssrc: this.rtcpSsrc, reports });

        try {
          if (this.config.debug.receiverReportDelay) {
            await setTimeout(this.config.debug.receiverReportDelay);
          }
          await this.dtlsTransport.sendRtcp([packet]);
        } catch (error) {
          log("sendRtcp failed", error);
          await setTimeout(500 + Math.random() * 1000);
        }
      }
    } catch (error) {}
  }

  /**todo impl */
  getStats() {}

  async sendRtcpPLI(mediaSsrc: number) {
    if (!this.pliEnabled) {
      log("pli not supported", { mediaSsrc });
      return;
    }

    if (this.stopped) {
      return;
    }

    log("sendRtcpPLI", { mediaSsrc });

    const packet = new RtcpPayloadSpecificFeedback({
      feedback: new PictureLossIndication({
        senderSsrc: this.rtcpSsrc,
        mediaSsrc,
      }),
    });
    try {
      await this.dtlsTransport.sendRtcp([packet]);
    } catch (error) {
      log(error);
    }
  }

  handleRtcpPacket(packet: RtcpPacket) {
    switch (packet.type) {
      case RtcpSrPacket.type: {
        const sr = packet as RtcpSrPacket;
        this.lastSRtimestamp[sr.ssrc] = compactNtp(sr.senderInfo.ntpTimestamp);
        this.receiveLastSRTimestamp[sr.ssrc] = timestampSeconds();

        const track = this.trackBySSRC[packet.ssrc];
        if (track) {
          track.onReceiveRtcp.execute(packet);
        }
      }
      break;
    }
    this.onRtcp.execute(packet);
  }

  handleRtpBySsrc = (packet: RtpPacket, extensions: Extensions) => {
    const track = this.trackBySSRC[packet.header.ssrc];

    this.handleRTP(packet, extensions, track);
  };

  handleRtpByRid = (packet: RtpPacket, rid: string, extensions: Extensions) => {
    const track = this.trackByRID[rid];
    if (!this.trackBySSRC[packet.header.ssrc]) {
      this.trackBySSRC[packet.header.ssrc] = track;
    }

    this.handleRTP(packet, extensions, track);
  };

  private handleRTP(
    packet: RtpPacket,
    extensions: Extensions,
    track?: MediaStreamTrack,
  ) {
    if (this.stopped) {
      return;
    }

    const codec = this.codecs[packet.header.payloadType];
    if (!codec) {
      // log("unknown codec " + packet.header.payloadType);
      return;
    }

    this.remoteStreams[packet.header.ssrc] =
      this.remoteStreams[packet.header.ssrc] ??
      new StreamStatistics(codec.clockRate);
    this.remoteStreams[packet.header.ssrc].add(packet);

    if (this.receiverTWCC) {
      const transportSequenceNumber = extensions[
        RTP_EXTENSION_URI.transportWideCC
      ] as TransportWideCCPayload;

      if (!transportSequenceNumber == undefined) {
        throw new Error("undefined");
      }

      this.receiverTWCC.handleTWCC(transportSequenceNumber);
    } else if (this.twccEnabled) {
      this.setupTWCC(packet.header.ssrc);
    }

    if (codec.name.toLowerCase() === "rtx") {
      const originalSsrc = this.ssrcByRtx[packet.header.ssrc];
      const codecParams = codecParametersFromString(codec.parameters ?? "");
      const rtxCodec = this.codecs[codecParams["apt"]];
      if (packet.payload.length < 2) return;

      packet = unwrapRtx(packet, rtxCodec.payloadType, originalSsrc);
      track = this.trackBySSRC[originalSsrc];
    }

    let red: Red | undefined;
    if (codec.name.toLowerCase() === "red") {
      red = Red.deSerialize(packet.payload);
      if (
        !Object.keys(this.codecs).includes(
          red.header.fields[0].blockPT.toString(),
        )
      ) {
        return;
      }
    }

    if (track?.kind === "video" && this.nackEnabled) {
      this.nack.addPacket(packet);
    }

    if (track) {
      if (red) {
        if (track.kind === "audio") {
          const payloads = this.audioRedHandler.push(red, packet);
          for (const packet of payloads) {
            track.onReceiveRtp.execute(packet.clone());
          }
        } else {
        }
      } else {
        track.onReceiveRtp.execute(packet.clone());
      }
    }

    this.runRtcp();
  }
}
