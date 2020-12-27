import { randomBytes } from "crypto";
import debug from "debug";
import { jspack } from "jspack";
import Event from "rx.mini";
import * as uuid from "uuid";
import {
  GenericNack,
  RtcpPacket,
  RtcpRrPacket,
  RtcpSenderInfo,
  RtcpSourceDescriptionPacket,
  RtcpSrPacket,
  RtcpTransportLayerFeedback,
  RtpHeader,
  RtpPacket,
  SourceDescriptionChunk,
  SourceDescriptionItem,
  TransportWideCC,
} from "../../../rtp/src";
import { RTP_EXTENSION_URI } from "../extension/rtpExtension";
import { sleep } from "../helper";
import { DtlsState, RTCDtlsTransport } from "../transport/dtls";
import { ntpTime, uint16Add, uint32Add } from "../utils";
import { RTCRtpParameters } from "./parameters";

const log = debug("werift:webrtc:rtpSender");

const RTP_HISTORY_SIZE = 128;
const RTT_ALPHA = 0.85;

export class RTCRtpSender {
  readonly type = "sender";
  readonly ssrc = jspack.Unpack("!L", randomBytes(4))[0];
  readonly streamId = uuid.v4();
  readonly trackId = uuid.v4();
  readonly onReady = new Event();
  readonly onRtcp = new Event<[RtcpPacket]>();

  private cname?: string;

  // # stats
  private lsr?: bigint;
  private lsrTime?: number;
  private ntpTimestamp = 0n;
  private rtpTimestamp = 0;
  private octetCount = 0;
  private packetCount = 0;
  private rtt?: number;

  // rtp
  private sequenceNumber?: number;
  private timestamp?: number;
  private timestampOffset = 0;
  private seqOffset = 0;
  private rtpCache: RtpPacket[] = [];

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

      const error = await this.dtlsTransport.sendRtcp(packets).catch(() => {
        console.log("sender send rtcp error");
        return true;
      });
      if (error) await sleep(500 + Math.random() * 1000);
    }
  }

  replaceRTP({ sequenceNumber, ssrc, timestamp }: RtpHeader) {
    if (this.sequenceNumber) {
      this.seqOffset = uint16Add(this.sequenceNumber, -sequenceNumber);
    }
    if (this.timestamp) {
      this.timestampOffset = Number(
        uint32Add(BigInt(this.timestamp), BigInt(-timestamp))
      );
    }
    this.rtpCache = [];
    log(
      "replaceRTP",
      this.ssrc,
      ssrc,
      this.sequenceNumber,
      sequenceNumber,
      this.seqOffset
    );
  }

  sendRtp(rtp: Buffer | RtpPacket, parameters: RTCRtpParameters) {
    if (!this.ready) return;

    rtp = Buffer.isBuffer(rtp) ? RtpPacket.deSerialize(rtp) : rtp;

    const header = rtp.header;
    header.ssrc = this.ssrc;

    header.timestamp = Number(
      uint32Add(BigInt(header.timestamp), BigInt(this.timestampOffset))
    );
    header.sequenceNumber = uint16Add(header.sequenceNumber, this.seqOffset);
    this.timestamp = header.timestamp;
    this.sequenceNumber = header.sequenceNumber;

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

    rtp.header = header;
    this.rtpCache.push(rtp);
    this.rtpCache = this.rtpCache.slice(-RTP_HISTORY_SIZE);

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
          switch (packet.feedback.count) {
            case TransportWideCC.count:
              {
                const feedback = packet.feedback as TransportWideCC;
              }
              break;
            case GenericNack.count:
              {
                const feedback = packet.feedback as GenericNack;

                feedback.lost.forEach((seqNum) => {
                  const rtp = this.rtpCache.find(
                    (rtp) => rtp.header.sequenceNumber === seqNum
                  );
                  if (rtp) {
                    this.dtlsTransport.sendRtp(rtp.payload, rtp.header);
                  }
                });
              }
              break;
          }
        }
        break;
    }
    this.onRtcp.execute(rtcpPacket);
  }
}
