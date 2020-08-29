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

const RTP_HISTORY_SIZE = 128;
const RTT_ALPHA = 0.85;

export class RTCRtpSender {
  type = "sender";
  ssrc = jspack.Unpack("!L", randomBytes(4))[0];
  streamId = uuid.v4();
  trackId = uuid.v4();
  private cname = "";

  // # stats
  private lsr?: bigint;
  private lsrTime?: number;
  private ntpTimestamp = BigInt(0);
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
      this.lsr = (this.ntpTimestamp >> BigInt(16)) & BigInt(0xffffffff);
      this.lsrTime = Date.now() / 1000;
      this.dtlsTransport.sendRtcp(packets);
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
          case "urn:ietf:params:rtp-hdrext:sdes:mid":
            if (parameters.muxId) payload = Buffer.from(parameters.muxId);
            break;
          case "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id":
            if (parameters.rid) payload = Buffer.from(parameters.rid);
            break;
        }
        if (payload) return { id: extension.id, payload };
      })
      .filter((v) => v);

    this.ntpTimestamp = BigInt(Date.now()) * BigInt(10000000);
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
        break;
    }
  }
}
