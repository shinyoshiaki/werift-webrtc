import { jspack } from "jspack";
import { setTimeout } from "timers/promises";
import { v4 as uuid } from "uuid";

import {
  PictureLossIndication,
  RtcpPacket,
  RtcpPayloadSpecificFeedback,
  RtcpRrPacket,
  RtcpSrPacket,
  RtpHeader,
  RtpPacket,
} from "../../../rtp/src";
import { RTP_EXTENSION_URI } from "../extension/rtpExtension";
import { RTCDtlsTransport } from "../transport/dtls";
import { Kind } from "../types/domain";
import { Nack } from "./nack";
import { RTCRtpCodecParameters, RTCRtpReceiveParameters } from "./parameters";
import { ReceiverTWCC } from "./receiver/receiverTwcc";
import { Extensions } from "./router";
import { MediaStreamTrack } from "./track";

export class RTCRtpReceiver {
  readonly type = "receiver";
  readonly uuid = uuid();
  readonly tracks: MediaStreamTrack[] = [];
  readonly trackBySSRC: { [ssrc: string]: MediaStreamTrack } = {};
  readonly trackByRID: { [rid: string]: MediaStreamTrack } = {};
  readonly lsr: { [key: number]: BigInt } = {};
  readonly lsrTime: { [key: number]: number } = {};
  private readonly codecs: { [pt: number]: RTCRtpCodecParameters } = {};
  private readonly ssrcByRtx: { [rtxSsrc: number]: number } = {};
  private readonly nack = new Nack(this);

  sdesMid?: string;
  rid?: string;
  repairedRid?: string;

  receiverTWCC?: ReceiverTWCC;
  supportTWCC = false;
  stopped = false;
  remoteStreamId?: string;
  remoteTrackId?: string;

  rtcpRunning = false;
  private rtcpCancel = new AbortController();

  constructor(
    public kind: Kind,
    public dtlsTransport: RTCDtlsTransport,
    public rtcpSsrc: number
  ) {}

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

        const reports = [];
        const packet = new RtcpRrPacket({ ssrc: this.rtcpSsrc, reports });

        try {
          await this.dtlsTransport.sendRtcp([packet]);
        } catch (error) {
          await setTimeout(500 + Math.random() * 1000);
        }
      }
    } catch (error) {}
  }

  async sendRtcpPLI(mediaSsrc: number) {
    const packet = new RtcpPayloadSpecificFeedback({
      feedback: new PictureLossIndication({
        senderSsrc: this.rtcpSsrc,
        mediaSsrc,
      }),
    });
    try {
      await this.dtlsTransport.sendRtcp([packet]);
    } catch (error) {}
  }

  handleRtcpPacket(packet: RtcpPacket) {
    switch (packet.type) {
      case RtcpSrPacket.type:
        {
          const sr = packet as RtcpSrPacket;
          this.lsr[sr.ssrc] = (sr.senderInfo.ntpTimestamp >> 16n) & 0xffffffffn;
          this.lsrTime[sr.ssrc] = Date.now() / 1000;
        }
        break;
    }
  }

  handleRtpBySsrc = (packet: RtpPacket, extensions: Extensions) => {
    const track = this.trackBySSRC[packet.header.ssrc];

    this.handleRTP(packet, extensions, track);
  };

  handleRtpByRid = (packet: RtpPacket, rid: string, extensions: Extensions) => {
    const track = this.trackByRID[rid];

    this.handleRTP(packet, extensions, track);
  };

  private handleRTP(
    packet: RtpPacket,
    extensions: Extensions,
    track?: MediaStreamTrack
  ) {
    if (this.stopped) return;

    if (this.receiverTWCC) {
      const transportSequenceNumber = extensions[
        RTP_EXTENSION_URI.transportWideCC
      ] as number;
      if (!transportSequenceNumber == undefined) throw new Error();

      this.receiverTWCC.handleTWCC(transportSequenceNumber);
    } else if (this.supportTWCC) {
      this.setupTWCC(packet.header.ssrc);
    }

    const codec = this.codecs[packet.header.payloadType];
    if (!codec) {
      throw new Error("unknown codec " + packet.header.payloadType);
    }

    if (codec.name.toLowerCase() === "rtx") {
      const originalSsrc = this.ssrcByRtx[packet.header.ssrc];
      const rtxCodec = this.codecs[codec.parameters["apt"]];
      if (packet.payload.length < 2) return;

      packet = unwrapRtx(packet, rtxCodec.payloadType, originalSsrc);
      track = this.trackBySSRC[originalSsrc];
    }

    // todo fix
    if (track?.kind === "video") this.nack.addPacket(packet);

    if (track) track.onReceiveRtp.execute(packet);

    this.runRtcp();
  }
}

function unwrapRtx(rtx: RtpPacket, payloadType: number, ssrc: number) {
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
