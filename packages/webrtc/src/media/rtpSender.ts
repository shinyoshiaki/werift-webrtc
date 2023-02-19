/**
   [10 Nov 1995 11:33:25.125 UTC]       [10 Nov 1995 11:33:36.5 UTC]
   n                 SR(n)              A=b710:8000 (46864.500 s)
   ---------------------------------------------------------------->
                      v                 ^
   ntp_sec =0xb44db705 v               ^ dlsr=0x0005:4000 (    5.250s)
   ntp_frac=0x20000000  v             ^  lsr =0xb705:2000 (46853.125s)
     (3024992005.125 s)  v           ^
   r                      v         ^ RR(n)
   ---------------------------------------------------------------->
                          |<-DLSR->|
                           (5.250 s)
        
   A     0xb710:8000 (46864.500 s)
   DLSR -0x0005:4000 (    5.250 s)
   LSR  -0xb705:2000 (46853.125 s)
   -------------------------------
   delay 0x0006:2000 (    6.125 s)
        
Figure 2: Example for round-trip time computation
 */

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
  RedEncoder,
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
import { compactNtp, milliTime, ntpTime, timestampSeconds } from "../utils";
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
  readonly kind: Kind;
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
  private _redDistance = 2;
  redEncoder = new RedEncoder(this._redDistance);
  private headerExtensions: RTCRtpHeaderExtensionParameters[] = [];
  private disposeTrack?: () => void;

  // # stats
  private lastSRtimestamp?: number;
  private lastSentSRTimestamp?: number;
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
  public dtlsTransport!: RTCDtlsTransport;
  private dtlsDisposer: (() => void)[] = [];

  track?: MediaStreamTrack;
  stopped = false;
  rtcpRunning = false;
  private rtcpCancel = new AbortController();

  constructor(public trackOrKind: Kind | MediaStreamTrack) {
    this.kind =
      typeof this.trackOrKind === "string"
        ? this.trackOrKind
        : this.trackOrKind.kind;
    if (trackOrKind instanceof MediaStreamTrack) {
      if (trackOrKind.streamId) {
        this.streamId = trackOrKind.streamId;
      }
      this.registerTrack(trackOrKind);
    }
  }

  setDtlsTransport(dtlsTransport: RTCDtlsTransport) {
    if (this.dtlsTransport) {
      this.dtlsDisposer.forEach((dispose) => dispose());
    }

    this.dtlsTransport = dtlsTransport;
    this.dtlsDisposer = [
      this.dtlsTransport.onStateChange.subscribe((state) => {
        if (state === "connected") {
          this.onReady.execute();
        }
      }).unSubscribe,
    ];
  }

  get redDistance() {
    return this._redDistance;
  }
  set redDistance(n: number) {
    this._redDistance = n;
    this.redEncoder.distance = n;
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

    const { unSubscribe } = track.onReceiveRtp.subscribe(async (rtp) => {
      await this.sendRtp(rtp);
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
    if (this.disposeTrack) {
      this.disposeTrack();
    }
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
        this.lastSRtimestamp = compactNtp(this.ntpTimestamp);
        this.lastSentSRTimestamp = timestampSeconds();

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

  replaceRTP(
    {
      sequenceNumber,
      timestamp,
    }: Pick<RtpHeader, "sequenceNumber" | "timestamp">,
    discontinuity = false
  ) {
    if (this.sequenceNumber != undefined) {
      this.seqOffset = uint16Add(this.sequenceNumber, -sequenceNumber);
      if (discontinuity) {
        this.seqOffset = uint16Add(this.seqOffset, 2);
      }
    }
    if (this.timestamp != undefined) {
      this.timestampOffset = uint32Add(this.timestamp, -timestamp);
      if (discontinuity) {
        this.timestampOffset = uint16Add(this.timestampOffset, 1);
      }
    }
    this.rtpCache = [];
    log("replaceRTP", this.sequenceNumber, sequenceNumber, this.seqOffset);
  }

  async sendRtp(rtp: Buffer | RtpPacket) {
    if (this.dtlsTransport.state !== "connected" || !this.codec) {
      return;
    }

    rtp = Buffer.isBuffer(rtp) ? RtpPacket.deSerialize(rtp) : rtp;

    const { header, payload } = rtp;
    header.ssrc = this.ssrc;
    header.payloadType = this.codec.payloadType;
    header.timestamp = uint32Add(header.timestamp, this.timestampOffset);
    header.sequenceNumber = uint16Add(header.sequenceNumber, this.seqOffset);
    this.timestamp = header.timestamp;
    this.sequenceNumber = header.sequenceNumber;

    const ntptime = ntpTime();

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
              const time = (ntptime >> 14n) & 0x00ffffffn;
              buf.writeUIntBE(Number(time), 0, 3);
              return buf;
          }
        })();

        if (payload) return { id: extension.id, payload };
      })
      .filter((v) => v) as Extension[];

    this.ntpTimestamp = ntptime;
    this.rtpTimestamp = header.timestamp;
    this.octetCount += payload.length;
    this.packetCount = uint32Add(this.packetCount, 1);

    this.rtpCache[header.sequenceNumber % RTP_HISTORY_SIZE] = rtp;

    let rtpPayload = payload;

    if (this.redRedundantPayloadType) {
      this.redEncoder.push({
        block: rtpPayload,
        timestamp: header.timestamp,
        blockPT: this.redRedundantPayloadType,
      });
      const red = this.redEncoder.build();
      rtpPayload = red.serialize();
    }

    const size = await this.dtlsTransport.sendRtp(rtpPayload, header);

    this.runRtcp();
    const millitime = milliTime();
    const sentInfo: SentInfo = {
      wideSeq: this.dtlsTransport.transportSequenceNumber,
      size,
      sendingAtMs: millitime,
      sentAtMs: millitime,
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
              if (this.lastSRtimestamp === report.lsr && report.dlsr) {
                if (this.lastSentSRTimestamp) {
                  const rtt =
                    timestampSeconds() -
                    this.lastSentSRTimestamp -
                    report.dlsr / 65536;
                  if (this.rtt === undefined) {
                    this.rtt = rtt;
                  } else {
                    this.rtt = RTT_ALPHA * this.rtt + (1 - RTT_ALPHA) * rtt;
                  }
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
                feedback.lost.forEach(async (seqNum) => {
                  let packet: RtpPacket | undefined =
                    this.rtpCache[seqNum % RTP_HISTORY_SIZE];
                  if (packet && packet.header.sequenceNumber !== seqNum) {
                    packet = undefined;
                  }
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
                    await this.dtlsTransport.sendRtp(
                      packet.payload,
                      packet.header
                    );
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
