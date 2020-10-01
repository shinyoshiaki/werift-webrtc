import { randomBytes } from "crypto";
import { jspack } from "jspack";
import * as uuid from "uuid";
import { RtpPacket } from "../../vendor/rtp/rtp/rtp";
import { RtcpPacket } from "../../vendor/rtp/rtcp/rtcp";
import { RtcpSrPacket, RtcpSenderInfo } from "../../vendor/rtp/rtcp/sr";
import { RtcpRrPacket } from "../../vendor/rtp/rtcp/rr";
import { sleep } from "../../helper";
import { RTCDtlsTransport, DtlsState } from "../transport/dtls";
import Event from "rx.mini";
import { RTCRtpParameters } from "./parameters";
import {
  RtcpSourceDescriptionPacket,
  SourceDescriptionChunk,
  SourceDescriptionItem,
} from "../../vendor/rtp/rtcp/sdes";
import { RTP_EXTENSION_URI } from "../extension/rtpExtension";
import { RtcpTransportLayerFeedback } from "../../vendor/rtp/rtcp/rtpfb";
import { TransportWideCC } from "../../vendor/rtp/rtcp/rtpfb/twcc";
import { ntpTime } from "../../utils";

const RTP_HISTORY_SIZE = 128;
const RTT_ALPHA = 0.85;

export class RTCRtpSender {
  type = "sender";
  readonly ssrc = jspack.Unpack("!L", randomBytes(4))[0];
  readonly streamId = uuid.v4();
  readonly trackId = uuid.v4();
  private cname = "";

  // # stats
  private lsr?: bigint;
  private lsrTime?: number;
  private ntpTimestamp = 0n;
  private rtpTimestamp = 0;
  private octetCount = 0;
  private packetCount = 0;
  private rtt?: number;
  onReady = new Event();

  constructor(public kind: string, public dtlsTransport: RTCDtlsTransport) {
    dtlsTransport.stateChanged.subscribe((state) => {
      if (state === DtlsState.CONNECTED) {
        this.onReady.execute();
      }
    });
  }

  get ready() {
    return this.dtlsTransport.state === DtlsState.CONNECTED;
  }

  stop() {
    this.rtcpRunner = false;
  }

  rtcpRunner = false;
  async runRtcp() {
    if (this.rtcpRunner) return;
    this.rtcpRunner = true;

    while (this.rtcpRunner) {
      await sleep(500 + Math.random() * 1000);

      const packets: RtcpPacket[] = [
        new RtcpSrPacket({
          ssrc: this.ssrc,
          senderInfo: new RtcpSenderInfo({
            ntpTimestamp: this.ntpTimestamp,
            rtpTimestamp: this.rtpTimestamp,
            packetCount: this.packetCount,
            octetCount: this.octetCount,
          }),
        }),
      ];
      if (this.cname) {
        packets.push(
          new RtcpSourceDescriptionPacket({
            chunks: [
              new SourceDescriptionChunk({
                source: this.ssrc,
                items: [
                  new SourceDescriptionItem({ type: 1, text: this.cname }),
                ],
              }),
            ],
          })
        );
      }
      this.lsr = (this.ntpTimestamp >> 16n) & 0xffffffffn;
      this.lsrTime = Date.now() / 1000;

      try {
        this.dtlsTransport.sendRtcp(packets);
      } catch (error) {
        console.log("send rtcp error");
        await sleep(500 + Math.random() * 1000);
      }
    }
  }

  sendRtp(rtp: Buffer | RtpPacket, parameters: RTCRtpParameters) {
    if (!this.ready) return;

    rtp = Buffer.isBuffer(rtp) ? RtpPacket.deSerialize(rtp) : rtp;
    const header = rtp.header;
    header.ssrc = this.ssrc;

    this.cname = parameters.rtcp.cname;

    header.extensions = parameters.headerExtensions
      .map((extension) => {
        let payload: Buffer;
        switch (extension.uri) {
          case RTP_EXTENSION_URI.sdesMid:
            if (parameters.muxId) payload = Buffer.from(parameters.muxId);
            break;
          case RTP_EXTENSION_URI.sdesRTPStreamID:
            if (parameters.rid) payload = Buffer.from(parameters.rid);
            break;
          case RTP_EXTENSION_URI.transportWideCC:
            {
              const buf = Buffer.alloc(2);
              buf.writeUInt16BE(this.dtlsTransport.transportSequenceNumber++);
              payload = buf;
            }
            break;
          case RTP_EXTENSION_URI.absSendTime:
            const buf = Buffer.alloc(3);
            const time = (ntpTime() >> 14n) & 0x00ffffffn;
            buf.writeUIntBE(Number(time), 0, 3);
            payload = buf;
            break;
        }
        if (payload) return { id: extension.id, payload };
      })
      .filter((v) => v);

    this.ntpTimestamp = ntpTime();
    this.rtpTimestamp = rtp.header.timestamp;
    this.octetCount += rtp.payload.length;
    this.packetCount++;

    this.dtlsTransport.sendRtp(rtp.payload, header);
    this.runRtcp();
  }

  handleRtcpPacket(rtcpPacket: RtcpPacket) {
    switch (rtcpPacket.type) {
      case RtcpSrPacket.type:
      case RtcpRrPacket.type:
        {
          const packet = rtcpPacket as RtcpSrPacket | RtcpRrPacket;
          packet.reports
            .filter((report) => report.ssrc === this.ssrc)
            .forEach((report) => {
              if (this.lsr === BigInt(report.lsr) && report.dlsr) {
                const rtt =
                  Date.now() / 1000 - this.lsrTime - report.dlsr / 65536;
                if (this.rtt === undefined) {
                  this.rtt = rtt;
                } else {
                  this.rtt = RTT_ALPHA * this.rtt + (1 - RTT_ALPHA) * rtt;
                }
              }
            });
        }
        break;
      case RtcpTransportLayerFeedback.type:
        {
          const packet = rtcpPacket as RtcpTransportLayerFeedback;
          const feedback = packet.feedback as TransportWideCC;
        }
        break;
    }
  }
}
