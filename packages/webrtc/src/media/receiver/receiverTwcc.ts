import {
  PacketChunk,
  PacketStatus,
  RecvDelta,
  RtcpTransportLayerFeedback,
  RunLengthChunk,
  TransportWideCC,
  StatusVectorChunk,
} from "../../../../rtp/src";
import { sleep } from "../../../../sctp/src/helper";
import { RTCDtlsTransport } from "../../transport/dtls";
import { microTime, uint8Add } from "../../utils";

type ExtensionInfo = { tsn: number; timestamp: bigint };

export class ReceiverTWCC {
  readonly extensionInfo: {
    [ssrc: number]: ExtensionInfo[];
  } = {};

  twccRunning = false;

  constructor(
    private dtlsTransport: RTCDtlsTransport,
    private rtcpSsrc: number
  ) {}

  handleTWCC(ssrc: number, transportSequenceNumber: number) {
    if (!this.extensionInfo[ssrc]) this.extensionInfo[ssrc] = [];
    this.extensionInfo[ssrc].push({
      tsn: transportSequenceNumber,
      timestamp: microTime(),
    });
  }

  async runTWCC() {
    if (this.twccRunning) return;
    this.twccRunning = true;

    let fbPktCount = 0;

    while (this.twccRunning) {
      Object.entries(this.extensionInfo)
        .map(([ssrc, extensionsArr]) => ({
          ssrc: Number(ssrc),
          rtpExtInfo: extensionsArr.reduce(
            (acc: { [tsn: number]: ExtensionInfo }, cur) => {
              acc[cur.tsn] = cur;
              return acc;
            },
            {}
          ),
        }))
        .forEach(({ ssrc, rtpExtInfo }) => {
          if (Object.keys(rtpExtInfo).length === 0) return;
          const extensionsArr = Object.values(rtpExtInfo).sort(
            (a, b) => a.tsn - b.tsn
          );

          const minTSN = extensionsArr[0].tsn;
          const maxTSN = extensionsArr.slice(-1)[0].tsn;

          const packetChunks: (RunLengthChunk | StatusVectorChunk)[] = [
            new RunLengthChunk({
              type: PacketChunk.TypeTCCRunLengthChunk,
              packetStatus: PacketStatus.TypeTCCPacketReceivedSmallDelta,
              runLength: maxTSN - minTSN + 1,
            }),
          ];

          const baseSequenceNumber = extensionsArr[0].tsn;
          const packetStatusCount = maxTSN - minTSN + 1;
          /**micro sec */
          let referenceTime!: bigint, lastTimestamp!: bigint;
          const recvDeltas: RecvDelta[] = [];

          for (let i = minTSN; i <= maxTSN; i++) {
            /**micro sec */
            const timestamp = rtpExtInfo[i]?.timestamp;

            if (timestamp) {
              if (!referenceTime) {
                referenceTime = timestamp;
                lastTimestamp = timestamp;
              }

              const delta = timestamp - lastTimestamp;
              lastTimestamp = timestamp;

              recvDeltas.push(
                new RecvDelta({
                  delta: Number(delta),
                })
              );
            }
          }

          if (!referenceTime) {
            return;
          }

          const packet = new RtcpTransportLayerFeedback({
            feedback: new TransportWideCC({
              senderSsrc: this.rtcpSsrc,
              mediaSourceSsrc: Number(ssrc),
              baseSequenceNumber,
              packetStatusCount,
              referenceTime: Number(
                BigInt.asUintN(24, referenceTime / 1000n / 64n)
              ),
              fbPktCount,
              recvDeltas,
              packetChunks,
            }),
          });

          this.dtlsTransport.sendRtcp([packet]);
          this.extensionInfo[Number(ssrc)] = [];
          fbPktCount = uint8Add(fbPktCount, 1);
        });

      await sleep(100);
    }
  }
}
