import { v4 as uuid } from "uuid";
import {
  PictureLossIndication,
  RtcpPacket,
  RtcpPayloadSpecificFeedback,
  RtcpRrPacket,
  RtcpSrPacket,
  RtpPacket,
} from "../../../rtp/src";
import { RTP_EXTENSION_URI } from "../extension/rtpExtension";
import { sleep } from "../helper";
import { RTCDtlsTransport } from "../transport/dtls";
import { Nack } from "./nack";
import { RTCRtpCodecParameters } from "./parameters";
import { ReceiverTWCC } from "./receiver/receiverTwcc";
import { Extensions } from "./router";
import { RtpTrack } from "./track";

export class RTCRtpReceiver {
  readonly type = "receiver";
  readonly uuid = uuid();
  readonly tracks: RtpTrack[] = [];
  readonly nack = new Nack(this);
  readonly receiverTWCC = new ReceiverTWCC(this.dtlsTransport, this.rtcpSsrc);
  readonly lsr: { [key: number]: BigInt } = {};
  readonly lsrTime: { [key: number]: number } = {};

  sdesMid?: string;
  rid?: string;
  mediaSourceSsrc!: number;
  supportTWCC = false;
  _codecs: RTCRtpCodecParameters[] = [];
  set codecs(codecs: RTCRtpCodecParameters[]) {
    this._codecs = codecs;
    this.supportTWCC = !!this.codecs.find((codec) =>
      codec.rtcpFeedback.find((v) => v.type === "transport-cc")
    );
  }
  get codecs() {
    return this._codecs;
  }

  constructor(
    public kind: string,
    public dtlsTransport: RTCDtlsTransport,
    public rtcpSsrc: number
  ) {}

  stop() {
    this.rtcpRunning = false;
    this.receiverTWCC.twccRunning = false;
  }

  rtcpRunning = false;
  async runRtcp() {
    if (this.rtcpRunning) return;
    this.rtcpRunning = true;

    while (this.rtcpRunning) {
      await sleep(500 + Math.random() * 1000);

      const reports = [];
      const packet = new RtcpRrPacket({ ssrc: this.rtcpSsrc, reports });

      try {
        await this.dtlsTransport.sendRtcp([packet]);
      } catch (error) {
        await sleep(500 + Math.random() * 1000);
      }
    }
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
    const track = this.tracks.find(
      (track) => track.ssrc === packet.header.ssrc
    );
    if (!track) throw new Error();

    this.handleRTP(track, packet, extensions);
  };

  handleRtpByRid = (packet: RtpPacket, rid: string, extensions: Extensions) => {
    const track = this.tracks.find((track) => track.rid === rid);
    if (!track) throw new Error();

    this.handleRTP(track, packet, extensions);
  };

  private handleRTP(
    track: RtpTrack,
    packet: RtpPacket,
    extensions: Extensions
  ) {
    if (this.supportTWCC) {
      const transportSequenceNumber = extensions[
        RTP_EXTENSION_URI.transportWideCC
      ] as number;
      if (!transportSequenceNumber == undefined) throw new Error();

      this.receiverTWCC.handleTWCC(
        this.mediaSourceSsrc,
        transportSequenceNumber
      );
      this.receiverTWCC.runTWCC();
    }

    if (track.kind === "video") this.nack.onPacket(packet);
    track.onRtp.execute(packet);

    this.runRtcp();
  }
}
