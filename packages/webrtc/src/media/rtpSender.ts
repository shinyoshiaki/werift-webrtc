import { randomBytes } from "crypto";
import debug from "debug";
import { jspack } from "jspack";
import Event from "rx.mini";
import * as uuid from "uuid";

import {
  Extension,
  GenericNack,
  PictureLossIndication,
  ReceiverEstimatedMaxBitrate,
  RtcpPacket,
  RtcpPayloadSpecificFeedback,
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
import { bufferWriter } from "../../../rtp/src/helper";
import { RTP_EXTENSION_URI } from "../extension/rtpExtension";
import { RTCDtlsTransport } from "../transport/dtls";
import { Kind } from "../types/domain";
import { milliTime, ntpTime, uint16Add, uint32Add } from "../utils";
import { RTCRtpCodecParameters, RTCRtpParameters } from "./parameters";
import { SenderBandwidthEstimator, SentInfo } from "./senderBWE/senderBWE";
import { MediaStreamTrack } from "./track";

const log = debug("werift:webrtc:rtpSender");

const RTP_HISTORY_SIZE = 128;
const RTT_ALPHA = 0.85;

export class RTCRtpSender {
  readonly type = "sender";
  readonly kind =
    typeof this.trackOrKind === "string"
      ? this.trackOrKind
      : this.trackOrKind.kind;
  readonly ssrc = jspack.Unpack("!L", randomBytes(4))[0];
  readonly streamId = uuid.v4();
  readonly trackId = uuid.v4();
  readonly onReady = new Event();
  readonly onRtcp = new Event<[RtcpPacket]>();
  readonly senderBWE = new SenderBandwidthEstimator();

  private cname?: string;
  private disposeTrack?: () => void;

  // # stats
  private lsr?: bigint;
  private lsrTime?: number;
  private ntpTimestamp = 0n;
  private rtpTimestamp = 0;
  private octetCount = 0;
  private packetCount = 0;
  private rtt?: number;
  receiverEstimatedMaxBitrate: bigint = 0n;

  // rtp
  private sequenceNumber?: number;
  private timestamp?: number;
  private timestampOffset = 0;
  private seqOffset = 0;
  private rtpCache: RtpPacket[] = [];

  private _codec?: RTCRtpCodecParameters;
  set codec(codec: RTCRtpCodecParameters) {
    this._codec = codec;
    if (this.track) this.track.codec = codec;
  }

  parameters?: RTCRtpParameters &
    Pick<Required<RTCRtpParameters>, "muxId" | "rtcp">;
  track?: MediaStreamTrack;
  stopped = false;

  constructor(
    public trackOrKind: Kind | MediaStreamTrack,
    public dtlsTransport: RTCDtlsTransport
  ) {
    dtlsTransport.onStateChange.subscribe((state) => {
      if (state === "connected") {
        this.onReady.execute();
      }
    });
    if (trackOrKind instanceof MediaStreamTrack) {
      this.registerTrack(trackOrKind);
    }
  }

  registerTrack(track: MediaStreamTrack) {
    if (track.stopped) throw new Error("track is ended");

    if (this.disposeTrack) {
      this.disposeTrack();
    }

    track.id = this.trackId;

    const { unSubscribe } = track.onReceiveRtp.subscribe((rtp) => {
      this.sendRtp(rtp);
    });
    this.track = track;
    this.disposeTrack = unSubscribe;

    track.codec = this._codec;
  }

  async replaceTrack(track: MediaStreamTrack | null) {
    if (track === null) {
      // todo impl
      return;
    }

    if (track.stopped) throw new Error("track is ended");

    if (this.sequenceNumber != undefined) {
      const header =
        track.header || (await track.onReceiveRtp.asPromise())[0].header;

      this.replaceRTP(header);
    }

    this.registerTrack(track);
    log("replaceTrack", track.ssrc, track.rid);
  }

  get ready() {
    return this.dtlsTransport.state === "connected";
  }

  stop() {
    this.stopped = true;
    this.track = undefined;
    this.rtcpRunner = false;
    this.rtcpCancel.execute();
  }

  rtcpRunner = false;
  private rtcpCancel = new Event();
  async runRtcp() {
    if (this.rtcpRunner || this.stopped) return;
    this.rtcpRunner = true;

    while (this.rtcpRunner) {
      await new Promise<void>((r) => {
        const timer = setTimeout(r, 500 + Math.random() * 1000);
        this.rtcpCancel.once(() => {
          clearTimeout(timer);
          r();
        });
      });

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
        await this.dtlsTransport.sendRtcp(packets);
      } catch (error) {
        await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000));
      }
    }
  }

  private replaceRTP({ sequenceNumber, timestamp }: RtpHeader) {
    if (this.sequenceNumber != undefined) {
      this.seqOffset = uint16Add(this.sequenceNumber, -sequenceNumber);
    }
    if (this.timestamp != undefined) {
      this.timestampOffset = Number(
        uint32Add(BigInt(this.timestamp), BigInt(-timestamp))
      );
    }
    this.rtpCache = [];
    log("replaceRTP", this.sequenceNumber, sequenceNumber, this.seqOffset);
  }

  sendRtp(rtp: Buffer | RtpPacket) {
    const { parameters } = this;
    if (!this.ready || !parameters) return;

    rtp = Buffer.isBuffer(rtp) ? RtpPacket.deSerialize(rtp) : rtp;

    const header = rtp.header;
    header.ssrc = this.ssrc;
    // todo : header.payloadType=parameters.codecs
    header.timestamp = Number(
      uint32Add(BigInt(header.timestamp), BigInt(this.timestampOffset))
    );
    header.sequenceNumber = uint16Add(header.sequenceNumber, this.seqOffset);
    this.timestamp = header.timestamp;
    this.sequenceNumber = header.sequenceNumber;

    this.cname = parameters.rtcp.cname;

    header.extensions = parameters.headerExtensions
      .map((extension) => {
        const payload = (() => {
          switch (extension.uri) {
            case RTP_EXTENSION_URI.sdesMid:
              return Buffer.from(parameters.muxId);
            case RTP_EXTENSION_URI.sdesRTPStreamID:
              if (parameters?.rid) {
                return Buffer.from(parameters.rid);
              }
              return;
            case RTP_EXTENSION_URI.transportWideCC:
              this.dtlsTransport.transportSequenceNumber = uint16Add(
                this.dtlsTransport.transportSequenceNumber,
                1
              );
              return bufferWriter(
                [2],
                [this.dtlsTransport.transportSequenceNumber]
              );
            case RTP_EXTENSION_URI.absSendTime:
              const buf = Buffer.alloc(3);
              const time = (ntpTime() >> 14n) & 0x00ffffffn;
              buf.writeUIntBE(Number(time), 0, 3);
              return buf;
          }
        })();

        if (payload) return { id: extension.id, payload };
      })
      .filter((v) => v) as Extension[];

    this.ntpTimestamp = ntpTime();
    this.rtpTimestamp = rtp.header.timestamp;
    this.octetCount += rtp.payload.length;
    this.packetCount = Number(uint32Add(BigInt(this.packetCount), 1n));

    rtp.header = header;
    this.rtpCache.push(rtp);
    this.rtpCache = this.rtpCache.slice(-RTP_HISTORY_SIZE);

    const size = this.dtlsTransport.sendRtp(rtp.payload, header);

    this.runRtcp();
    const sentInfo: SentInfo = {
      wideSeq: this.dtlsTransport.transportSequenceNumber,
      size,
      sendingAtMs: milliTime(),
      sentAtMs: milliTime(),
    };
    this.senderBWE.rtpPacketSent(sentInfo);
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
                  Date.now() / 1000 - this.lsrTime! - report.dlsr / 65536;
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
                this.senderBWE.receiveTWCC(feedback);
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
      case RtcpPayloadSpecificFeedback.type:
        {
          const packet = rtcpPacket as RtcpPayloadSpecificFeedback;
          switch (packet.feedback.count) {
            case ReceiverEstimatedMaxBitrate.count:
              {
                const feedback = packet.feedback as ReceiverEstimatedMaxBitrate;
                this.receiverEstimatedMaxBitrate = feedback.bitrate;
              }
              break;
            case PictureLossIndication.count:
              {
              }
              break;
          }
        }
        break;
    }
    this.onRtcp.execute(rtcpPacket);
  }
}
