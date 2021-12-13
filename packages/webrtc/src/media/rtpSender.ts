import { randomBytes } from "crypto";
import debug from "debug";
import { jspack } from "jspack";
import Event from "rx.mini";
import { setTimeout } from "timers/promises";
import * as uuid from "uuid";

import {
  bufferWriter,
  random16,
  uint16Add,
  uint32Add,
} from "../../../common/src";
import {
  Extension,
  GenericNack,
  PictureLossIndication,
  ReceiverEstimatedMaxBitrate,
  Red,
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
import { codecParametersFromString } from "..";
import { RTCDtlsTransport } from "../transport/dtls";
import { Kind } from "../types/domain";
import { compactNtp, milliTime, ntpTime } from "../utils";
import { RTP_EXTENSION_URI } from "./extension/rtpExtension";
import {
  RTCRtpCodecParameters,
  RTCRtpHeaderExtensionParameters,
  RTCRtpSendParameters,
} from "./parameters";
import { SenderBandwidthEstimator, SentInfo } from "./sender/senderBWE";
import { MediaStreamTrack } from "./track";

const log = debug("werift:packages/webrtc/src/media/rtpSender.ts");

const RTP_HISTORY_SIZE = 128;
const RTT_ALPHA = 0.85;

export class RTCRtpSender {
  readonly type = "sender";
  readonly kind =
    typeof this.trackOrKind === "string"
      ? this.trackOrKind
      : this.trackOrKind.kind;
  readonly ssrc = jspack.Unpack("!L", randomBytes(4))[0];
  readonly rtxSsrc = jspack.Unpack("!L", randomBytes(4))[0];
  streamId = uuid.v4();
  readonly trackId = uuid.v4();
  readonly onReady = new Event();
  readonly onRtcp = new Event<[RtcpPacket]>();
  readonly onPictureLossIndication = new Event<[]>();
  readonly onGenericNack = new Event<[GenericNack]>();
  readonly senderBWE = new SenderBandwidthEstimator();

  private cname?: string;
  private mid?: string;
  private rtpStreamId?: string;
  private repairedRtpStreamId?: string;
  private rtxPayloadType?: number;
  private rtxSequenceNumber = random16();
  redRedundantPayloadType?: number;
  redDistance = 2;
  private headerExtensions: RTCRtpHeaderExtensionParameters[] = [];
  private disposeTrack?: () => void;

  // # stats
  private lsr?: number;
  private lsrTime: number = Date.now() / 1000;
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
  codec?: RTCRtpCodecParameters;

  track?: MediaStreamTrack;
  stopped = false;
  rtcpRunning = false;
  private rtcpCancel = new AbortController();

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
      if (trackOrKind.streamId) {
        this.streamId = trackOrKind.streamId;
      }
      this.registerTrack(trackOrKind);
    }
  }

  prepareSend(params: RTCRtpSendParameters) {
    this.cname = params.rtcp?.cname;
    this.mid = params.muxId;
    this.headerExtensions = params.headerExtensions;
    this.rtpStreamId = params.rtpStreamId;
    this.repairedRtpStreamId = params.repairedRtpStreamId;

    this.codec = params.codecs[0];
    if (this.track) {
      this.track.codec = this.codec;
    }

    params.codecs.forEach((codec) => {
      const codecParams = codecParametersFromString(codec.parameters ?? "");
      if (
        codec.name.toLowerCase() === "rtx" &&
        codecParams["apt"] === this.codec?.payloadType
      ) {
        this.rtxPayloadType = codec.payloadType;
      }
      if (codec.name.toLowerCase() === "red") {
        this.redRedundantPayloadType = Number(
          (codec.parameters ?? "").split("/")[0]
        );
      }
    });
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

    if (this.codec) {
      track.codec = this.codec;
    }

    track.onSourceChanged.subscribe((header) => {
      this.replaceRTP(header);
    });
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
    log("replaceTrack", "ssrc", track.ssrc, "rid", track.rid);
  }

  stop() {
    this.stopped = true;
    this.rtcpRunning = false;
    this.rtcpCancel.abort();

    this.track = undefined;
  }

  async runRtcp() {
    if (this.rtcpRunning || this.stopped) return;
    this.rtcpRunning = true;

    try {
      while (this.rtcpRunning) {
        await setTimeout(500 + Math.random() * 1000, undefined, {
          signal: this.rtcpCancel.signal,
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
        this.lsr = compactNtp(this.ntpTimestamp);
        this.lsrTime = Date.now() / 1000;

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

        try {
          await this.dtlsTransport.sendRtcp(packets);
        } catch (error) {
          log("sendRtcp failed", error);
          await setTimeout(500 + Math.random() * 1000);
        }
      }
    } catch (error) {}
  }

  replaceRTP({
    sequenceNumber,
    timestamp,
  }: Pick<RtpHeader, "sequenceNumber" | "timestamp">) {
    if (this.sequenceNumber != undefined) {
      this.seqOffset = uint16Add(this.sequenceNumber, -sequenceNumber);
    }
    if (this.timestamp != undefined) {
      this.timestampOffset = uint32Add(this.timestamp, -timestamp);
    }
    this.rtpCache = [];
    log("replaceRTP", this.sequenceNumber, sequenceNumber, this.seqOffset);
  }

  sendRtp(rtp: Buffer | RtpPacket) {
    if (this.dtlsTransport.state !== "connected" || !this.codec) {
      return;
    }

    rtp = Buffer.isBuffer(rtp) ? RtpPacket.deSerialize(rtp) : rtp;

    const header = rtp.header;
    header.ssrc = this.ssrc;
    header.payloadType = this.codec.payloadType;
    header.timestamp = uint32Add(header.timestamp, this.timestampOffset);
    header.sequenceNumber = uint16Add(header.sequenceNumber, this.seqOffset);
    this.timestamp = header.timestamp;
    this.sequenceNumber = header.sequenceNumber;

    header.extensions = this.headerExtensions
      .map((extension) => {
        const payload = (() => {
          switch (extension.uri) {
            case RTP_EXTENSION_URI.sdesMid:
              if (this.mid) {
                return Buffer.from(this.mid);
              }
              return;
            // todo : sender simulcast unsupported now
            case RTP_EXTENSION_URI.sdesRTPStreamID:
              if (this.rtpStreamId) {
                return Buffer.from(this.rtpStreamId);
              }
              return;
            // todo : sender simulcast unsupported now
            case RTP_EXTENSION_URI.repairedRtpStreamId:
              if (this.repairedRtpStreamId) {
                return Buffer.from(this.repairedRtpStreamId);
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
    this.packetCount = uint32Add(this.packetCount, 1);

    rtp.header = header;

    this.rtpCache.push(rtp);
    this.rtpCache = this.rtpCache.slice(-RTP_HISTORY_SIZE);

    let rtpPayload = rtp.payload;

    if (this.redRedundantPayloadType) {
      const redundantPackets = [...Array(this.redDistance).keys()]
        .map((i) => {
          return this.rtpCache.find(
            (c) =>
              c.header.sequenceNumber ===
              header.sequenceNumber - (this.redDistance - i)
          );
        })
        .filter((p): p is NonNullable<typeof p> => typeof p !== "undefined");
      const red = buildRedPacket(
        redundantPackets,
        this.redRedundantPayloadType,
        rtp
      );
      rtpPayload = red.serialize();
    }

    const size = this.dtlsTransport.sendRtp(rtpPayload, header);

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
                  let packet = this.rtpCache.find(
                    (rtp) => rtp.header.sequenceNumber === seqNum
                  );
                  if (packet) {
                    if (this.rtxPayloadType != undefined) {
                      packet = wrapRtx(
                        packet,
                        this.rtxPayloadType,
                        this.rtxSequenceNumber,
                        this.rtxSsrc
                      );
                      this.rtxSequenceNumber = uint16Add(
                        this.rtxSequenceNumber,
                        1
                      );
                    }
                    this.dtlsTransport.sendRtp(packet.payload, packet.header);
                  }
                });
                this.onGenericNack.execute(feedback);
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
                this.onPictureLossIndication.execute();
              }
              break;
          }
        }
        break;
    }
    this.onRtcp.execute(rtcpPacket);
  }
}

export function wrapRtx(
  packet: RtpPacket,
  payloadType: number,
  sequenceNumber: number,
  ssrc: number
) {
  const rtx = new RtpPacket(
    new RtpHeader({
      payloadType,
      marker: packet.header.marker,
      sequenceNumber,
      timestamp: packet.header.timestamp,
      ssrc,
      csrc: packet.header.csrc,
      extensions: packet.header.extensions,
    }),
    Buffer.concat([
      Buffer.from(jspack.Pack("!H", [packet.header.sequenceNumber])),
      packet.payload,
    ])
  );
  return rtx;
}

export function buildRedPacket(
  redundantPackets: RtpPacket[],
  blockPT: number,
  presentPacket: RtpPacket
) {
  const red = new Red();
  redundantPackets.forEach((redundant) => {
    red.blocks.push({
      block: redundant.payload,
      blockPT,
      timestampOffset: uint32Add(
        presentPacket.header.timestamp,
        -redundant.header.timestamp
      ),
    });
  });

  red.blocks.push({
    block: presentPacket.payload,
    blockPT,
  });
  return red;
}
