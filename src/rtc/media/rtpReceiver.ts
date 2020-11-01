import { RtcpPacket } from "../../vendor/rtp/rtcp/rtcp";
import { RtcpSrPacket } from "../../vendor/rtp/rtcp/sr";
import { RtpPacket } from "../../vendor/rtp/rtp/rtp";
import { v4 as uuid } from "uuid";
import { RtpTrack } from "./track";
import { RtcpRrPacket } from "../../vendor/rtp/rtcp/rr";
import { RTCDtlsTransport } from "../transport/dtls";
import { sleep } from "../../helper";
import { RtcpPayloadSpecificFeedback } from "../../vendor/rtp/rtcp/psfb";
import { PictureLossIndication } from "../../vendor/rtp/rtcp/psfb/pictureLossIndication";
import { RtcpTransportLayerFeedback } from "../../vendor/rtp/rtcp/rtpfb";
import { Extensions } from "./router";
import { RTP_EXTENSION_URI } from "../extension/rtpExtension";
import {
  PacketChunk,
  PacketStatus,
  RecvDelta,
  RunLengthChunk,
  TransportWideCC,
} from "../../vendor/rtp/rtcp/rtpfb/twcc";
import { microTime } from "../../utils";
import { Nack } from "./nack";

export class RTCRtpReceiver {
  readonly type = "receiver";
  readonly uuid = uuid();
  readonly tracks: RtpTrack[] = [];
  readonly nack = new Nack(this);

  // # RTCP
  readonly lsr: { [key: number]: BigInt } = {};
  readonly lsrTime: { [key: number]: number } = {};
  rtcpSsrc: number;
  readonly cacheTWCC: {
    [ssrc: number]: { tsn: number; timestamp: bigint }[];
  } = {};

  sdesMid: string;
  rid: string;

  constructor(public kind: string, public dtlsTransport: RTCDtlsTransport) {}

  stop() {
    this.rtcpRunning = false;
    this.twccRunning = false;
  }

  rtcpRunning = false;
  async runRtcp() {
    if (this.rtcpRunning) return;
    this.rtcpRunning = true;

    while (this.rtcpRunning) {
      await sleep(500 + Math.random() * 1000);

      const reports = [];
      const packet = new RtcpRrPacket({ ssrc: this.rtcpSsrc, reports });

      const error = await this.dtlsTransport.sendRtcp([packet]).catch(() => {
        console.log("send rtcp error");
        return true;
      });
      if (error) await sleep(500 + Math.random() * 1000);
    }
  }

  twccRunning = false;
  async runTWCC() {
    if (this.twccRunning) return;
    this.twccRunning = true;

    let fbPktCount = 0;

    while (this.twccRunning) {
      Object.entries(this.cacheTWCC)
        .map(
          ([ssrc, extensionsArr]) =>
            [
              Number(ssrc),
              extensionsArr.reduce((acc, cur) => {
                const { tsn, timestamp } = cur;
                acc[tsn] = timestamp;
                return acc;
              }, {} as { [tsn: number]: bigint }),
            ] as [number, { [tsn: number]: bigint }]
        )
        .forEach(([ssrc, rtpExtInfo]) => {
          if (Object.keys(rtpExtInfo).length === 0) return;

          let minTSN = 0,
            maxTSN = 0;
          Object.keys(rtpExtInfo).forEach((tsn: any) => {
            tsn = Number(tsn);
            if (minTSN === 0) minTSN = tsn;
            if (minTSN > tsn) minTSN = tsn;
            if (maxTSN < tsn) maxTSN = tsn;
          });

          const chunk = new RunLengthChunk({
            type: PacketChunk.TypeTCCRunLengthChunk,
            packetStatus: PacketStatus.TypeTCCPacketReceivedSmallDelta,
            runLength: maxTSN - minTSN + 1,
          });

          const recvDeltas: RecvDelta[] = [];
          let referenceTime = 0n,
            lastTS = 0n,
            baseTimeTicks = 0n;
          const timeWrapPeriodUs = 1073741824000n;
          const baseScaleFactor = 64000n;
          for (let i = minTSN; i <= maxTSN; i++) {
            const ts = rtpExtInfo[i];

            if (!ts) {
              recvDeltas.push(
                new RecvDelta({
                  type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
                  delta: 0,
                })
              );
              continue;
            }

            if (lastTS === 0n) lastTS = ts;

            if (baseTimeTicks === 0n)
              baseTimeTicks = (ts % timeWrapPeriodUs) / baseScaleFactor;

            let delta: bigint;
            if (lastTS === ts)
              delta = (ts % timeWrapPeriodUs) - baseTimeTicks * baseScaleFactor;
            else {
              delta = (ts - lastTS) % timeWrapPeriodUs;
            }

            if (referenceTime === 0n) {
              referenceTime = baseTimeTicks & 0x007fffffn;
            }

            const recvDelta = new RecvDelta({
              type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
              delta: Number(delta),
            });

            recvDeltas.push(recvDelta);
          }

          const packet = new RtcpTransportLayerFeedback({
            feedback: new TransportWideCC({
              senderSsrc: this.rtcpSsrc,
              mediaSsrc: ssrc,
              baseSequenceNumber: minTSN,
              packetStatusCount: maxTSN - minTSN + 1,
              referenceTime: Number(referenceTime),
              fbPktCount,
              recvDeltas,
              packetChunks: [chunk],
            }),
          });

          this.dtlsTransport.sendRtcp([packet]);
          this.cacheTWCC[ssrc] = [];
          if (fbPktCount === 255) fbPktCount = 0;
          fbPktCount++;
        });

      await sleep(100);
    }
  }

  sendRtcpPLI(mediaSsrc: number) {
    const packet = new RtcpPayloadSpecificFeedback({
      feedback: new PictureLossIndication({
        senderSsrc: this.rtcpSsrc,
        mediaSsrc,
      }),
    });
    this.dtlsTransport.sendRtcp([packet]);
  }

  handleRtcpPacket(packet: RtcpPacket) {
    switch (packet.type) {
      case RtcpSrPacket.type:
        const sr = packet as RtcpSrPacket;
        this.lsr[sr.ssrc] = (sr.senderInfo.ntpTimestamp >> 16n) & 0xffffffffn;
        this.lsrTime[sr.ssrc] = Date.now() / 1000;
        break;
      case RtcpTransportLayerFeedback.type:
        break;
    }
  }

  private handleTWCC(ssrc: number, extensions: Extensions) {
    if (!this.cacheTWCC[ssrc]) this.cacheTWCC[ssrc] = [];
    this.cacheTWCC[ssrc].push({
      tsn: Number(extensions[RTP_EXTENSION_URI.transportWideCC]),
      timestamp: microTime(),
    });
  }

  handleRtpBySsrc = (packet: RtpPacket, extensions: Extensions) => {
    const { ssrc } = packet.header;

    const track = this.tracks.find((track) => track.ssrc === ssrc);
    if (track.kind === "video") this.nack.onPacket(packet);
    track.onRtp.execute(packet);

    if (this.twccRunning) this.handleTWCC(ssrc, extensions);

    this.runRtcp();
  };

  handleRtpByRid = (packet: RtpPacket, rid: string, extensions: Extensions) => {
    const { ssrc } = packet.header;

    const track = this.tracks.find((track) => track.rid === rid);
    if (track.kind === "video") this.nack.onPacket(packet);
    track.onRtp.execute(packet);

    if (this.twccRunning) this.handleTWCC(ssrc, extensions);

    this.runRtcp();
  };
}
