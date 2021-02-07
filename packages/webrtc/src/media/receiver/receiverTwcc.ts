import {
  PacketChunk,
  PacketStatus,
  RecvDelta,
  RtcpTransportLayerFeedback,
  RunLengthChunk,
  TransportWideCC,
} from "../../../../rtp/src";
import { sleep } from "../../../../sctp/src/helper";
import { RTP_EXTENSION_URI } from "../../extension/rtpExtension";
import { RTCDtlsTransport } from "../../transport/dtls";
import { microTime } from "../../utils";
import { Extensions } from "../router";

export class ReceiverTWCC {
  readonly cacheTWCC: {
    [ssrc: number]: { tsn: number; timestamp: bigint }[];
  } = {};

  twccRunning = false;

  constructor(
    private dtlsTransport: RTCDtlsTransport,
    private rtcpSsrc: number
  ) {}

  handleTWCC(ssrc: number, extensions: Extensions) {
    if (!this.cacheTWCC[ssrc]) this.cacheTWCC[ssrc] = [];
    this.cacheTWCC[ssrc].push({
      tsn: Number(extensions[RTP_EXTENSION_URI.transportWideCC]),
      timestamp: microTime(),
    });
  }

  async runTWCC() {
    if (this.twccRunning) return;
    this.twccRunning = true;

    let fbPktCount = 0;

    while (this.twccRunning) {
      Object.entries(this.cacheTWCC)
        .map(([ssrc, extensionsArr]) => ({
          ssrc: Number(ssrc),
          rtpExtInfo: extensionsArr.reduce(
            (acc: { [tsn: number]: bigint }, cur) => {
              const { tsn, timestamp } = cur;
              acc[tsn] = timestamp;
              return acc;
            },
            {}
          ),
        }))
        .forEach(({ ssrc, rtpExtInfo }) => {
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

          /**micro sec */
          let referenceTime!: bigint;
          const recvDeltas: RecvDelta[] = [];
          for (let i = minTSN; i <= maxTSN; i++) {
            /**micro sec */
            const timestamp = rtpExtInfo[i];

            if (!timestamp) {
              recvDeltas.push(
                new RecvDelta({
                  type: PacketStatus.TypeTCCPacketNotReceived,
                  delta: 0,
                })
              );
              continue;
            }
            if (!referenceTime) referenceTime = timestamp;

            // const delta = (timestamp - referenceTime) / 250n;
            const delta = 0n;

            if (delta < 0 || delta > 255) {
              let rDelta = delta;
              if (rDelta > 32767n) rDelta = 32767n;
              if (rDelta < -32768n) rDelta = -32768n;

              recvDeltas.push(
                new RecvDelta({
                  type: PacketStatus.TypeTCCPacketReceivedLargeDelta,
                  delta: Number(rDelta),
                })
              );
            } else {
              recvDeltas.push(
                new RecvDelta({
                  type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
                  delta: Number(delta),
                })
              );
            }
          }

          const packet = new RtcpTransportLayerFeedback({
            feedback: new TransportWideCC({
              senderSsrc: this.rtcpSsrc,
              mediaSsrc: ssrc,
              baseSequenceNumber: minTSN,
              packetStatusCount: maxTSN - minTSN + 1,
              referenceTime: Number(
                BigInt.asUintN(24, referenceTime / 1000n / 64n)
              ),
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

      await sleep(200);
    }
  }
}
