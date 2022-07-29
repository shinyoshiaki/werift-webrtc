import { debug } from "debug";
import { jspack } from "jspack";
import Event from "rx.mini";
import { setTimeout } from "timers/promises";
import { v4 as uuid } from "uuid";

import { codecParametersFromString } from "..";
import { int } from "../../../common/src";
import {
    PictureLossIndication,
    Red,
    RtcpPacket,
    RtcpPayloadSpecificFeedback,
    RtcpReceiverInfo,
    RtcpRrPacket,
    RtcpSrPacket,
    RtpHeader,
    RtpPacket
} from "../../../rtp/src";
import { RTCDtlsTransport } from "../transport/dtls";
import { Kind } from "../types/domain";
import { compactNtp } from "../utils";
import { RTP_EXTENSION_URI } from "./extension/rtpExtension";
import { RTCRtpCodecParameters, RTCRtpReceiveParameters } from "./parameters";
import { Nack } from "./receiver/nack";
import { ReceiverTWCC } from "./receiver/receiverTwcc";
import { RedHandler } from "./receiver/red";
import { StreamStatistics } from "./receiver/statistics";
import { Extensions } from "./router";
import { MediaStreamTrack } from "./track";

const log = debug("werift:packages/webrtc/src/media/rtpReceiver.ts");

export class RTCRtpReceiver {
  private readonly codecs: { [pt: number]: RTCRtpCodecParameters } = {};
  private readonly ssrcByRtx: { [rtxSsrc: number]: number } = {};
  private readonly nack = new Nack(this);
  private readonly redHandler = new RedHandler();

  readonly type = "receiver";
  readonly uuid = uuid();
  readonly tracks: MediaStreamTrack[] = [];
  readonly trackBySSRC: { [ssrc: string]: MediaStreamTrack } = {};
  readonly trackByRID: { [rid: string]: MediaStreamTrack } = {};
  // last senderReport
  readonly lsr: { [ssrc: number]: number } = {};
  readonly lsrTime: { [ssrc: number]: number } = {};
  readonly onPacketLost = this.nack.onPacketLost;
  readonly onRtcp = new Event<[RtcpPacket]>();

  dtlsTransport!: RTCDtlsTransport;
  sdesMid?: string;
  latestRid?: string;
  latestRepairedRid?: string;

  receiverTWCC?: ReceiverTWCC;
  supportTWCC = false;
  stopped = false;
  remoteStreamId?: string;
  remoteTrackId?: string;

  rtcpRunning = false;
  private rtcpCancel = new AbortController();
  private remoteStreams: { [ssrc: number]: StreamStatistics } = {};

  constructor(public kind: Kind, public rtcpSsrc: number) {}

  setDtlsTransport(dtls: RTCDtlsTransport) {
    this.dtlsTransport = dtls;
  }

  // todo fix
  get track() {
    return this.tracks[0];
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
  setupTWCC(mediaSourceSsrc?: number) {
    this.supportTWCC = !!Object.values(this.codecs).find((codec) =>
      codec.rtcpFeedback.find((v) => v.type === "transport-cc")
    );
    log("twcc support", this.supportTWCC);

    if (this.supportTWCC && mediaSourceSsrc) {
      this.receiverTWCC = new ReceiverTWCC(
        this.dtlsTransport,
        this.rtcpSsrc,
        mediaSourceSsrc
      );
    }
  }

  addTrack(track: MediaStreamTrack) {
    const exist = this.tracks.find((t) => {
      if (t.rid) return t.rid === track.rid;
      if (t.ssrc) return t.ssrc === track.ssrc;
    });
    if (exist) return false;
    this.tracks.push(track);
    if (track.ssrc) this.trackBySSRC[track.ssrc] = track;
    if (track.rid) this.trackByRID[track.rid] = track;
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
            let lsr = 0,
              dlsr = 0;
            if (this.lsr[ssrc]) {
              lsr = this.lsr[ssrc];
              const delay = Date.now() / 1000 - this.lsrTime[ssrc];
              if (delay > 0 && delay < 65536) {
                dlsr = int(delay * 65536);
              }
            }

            return new RtcpReceiverInfo({
              ssrc: Number(ssrc),
              fractionLost: stream.fraction_lost,
              packetsLost: stream.packets_lost,
              highestSequence: stream.max_seq,
              jitter: stream.jitter,
              lsr,
              dlsr,
            });
          }
        );

        const packet = new RtcpRrPacket({ ssrc: this.rtcpSsrc, reports });

        try {
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
      case RtcpSrPacket.type:
        {
          const sr = packet as RtcpSrPacket;
          this.lsr[sr.ssrc] = compactNtp(sr.senderInfo.ntpTimestamp);
          this.lsrTime[sr.ssrc] = Date.now() / 1000;

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
    track?: MediaStreamTrack
  ) {
    if (this.stopped) return;

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
      ] as number;
      if (!transportSequenceNumber == undefined) {
        throw new Error("undefined");
      }

      this.receiverTWCC.handleTWCC(transportSequenceNumber);
    } else if (this.supportTWCC) {
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
    }

    // todo fix select use or not use nack
    if (track?.kind === "video") {
      this.nack.addPacket(packet);
    }

    if (track) {
      if (red) {
        const payloads = this.redHandler.push(red, packet);
        for (const packet of payloads) {
          track.onReceiveRtp.execute(packet.clone());
        }
      } else {
        track.onReceiveRtp.execute(packet.clone());
      }
    }

    this.runRtcp();
  }
}

export function unwrapRtx(rtx: RtpPacket, payloadType: number, ssrc: number) {
  const packet = new RtpPacket(
    new RtpHeader({
      payloadType,
      marker: rtx.header.marker,
      sequenceNumber: jspack.Unpack("!H", rtx.payload.slice(0, 2))[0],
      timestamp: rtx.header.timestamp,
      ssrc,
    }),
    rtx.payload.slice(2)
  );
  return packet;
}
