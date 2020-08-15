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

const RTP_HISTORY_SIZE = 128;
const RTT_ALPHA = 0.85;

export class RTCRtpSender {
  ssrc = jspack.Unpack("!L", randomBytes(4))[0];
  streamId = uuid.v4();
  trackId = uuid.v4();

  // # stats
  private lsr?: bigint;
  private lsrTime?: number;
  private ntpTimestamp = BigInt(0);
  private rtpTimestamp = 0;
  private octetCount = 0;
  private packetCount = 0;
  private rtt?: number;
  onReady = new Event();
  ready = false;

  constructor(public kind: string, public dtlsTransport: RTCDtlsTransport) {
    dtlsTransport.stateChanged.subscribe((state) => {
      if (state === DtlsState.CONNECTED) {
        this.ready = true;
        this.onReady.execute();
      }
    });
  }

  haltRtcp = true;
  async runRtcp() {
    this.haltRtcp = false;

    while (!this.haltRtcp) {
      await sleep(500 + Math.random() * 1000);

      const packets = [
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
      this.lsr = (this.ntpTimestamp >> BigInt(16)) & BigInt(0xffffffff);
      this.lsrTime = Date.now() / 1000;

      this.dtlsTransport.sendRtcp(packets);
    }
  }

  sendRtp(rawRtp: Buffer, parameters: RTCRtpParameters) {
    if (!this.ready) return;

    const rtp = RtpPacket.deSerialize(rawRtp);
    const header = rtp.header;
    header.ssrc = this.ssrc;

    // todo refactor
    header.extensions = parameters.headerExtensions.map((extension) => {
      const id = extension.id;
      let payload: Buffer;
      switch (extension.uri) {
        case "urn:ietf:params:rtp-hdrext:sdes:mid":
          payload = Buffer.from(parameters.muxId);
          break;
        case "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id":
          // todo fix
          payload = Buffer.from("dummy");
          break;
      }
      return { id, payload };
    });

    // this.ntpTimestamp = BigInt(Date.now()) * BigInt(10000000);
    // this.rtpTimestamp = rtp.header.timestamp;
    // this.octetCount += rtp.payload.length;
    // this.packetCount++;

    this.dtlsTransport.sendRtp(rtp.payload, header);
  }

  handleRtcpPacket(rtcpPacket: RtcpPacket) {
    switch (rtcpPacket.type) {
      case RtcpSrPacket.type:
      case RtcpRrPacket.type:
        const packet = rtcpPacket as RtcpSrPacket | RtcpRrPacket;
        packet.reports
          .filter((report) => report.ssrc === this.ssrc)
          .forEach((report) => {
            if (this.lsr === report.lsr && report.dlsr) {
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
