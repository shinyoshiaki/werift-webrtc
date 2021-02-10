import {
  PacketStatus,
  RecvDelta,
  RtcpTransportLayerFeedback,
  RunLengthChunk,
  TransportWideCC,
  StatusVectorChunk,
} from "../../../../rtp/src";
import { sleep } from "../../../../sctp/src/helper";
import { RTCDtlsTransport } from "../../transport/dtls";
import { microTime, uint16Add, uint8Add } from "../../utils";

type ExtensionInfo = { tsn: number; timestamp: bigint };

export class ReceiverTWCC {
  readonly extensionInfo: {
    [ssrc: number]: ExtensionInfo[];
  } = {};

  twccRunning = false;
  /** uint8 */
  fbPktCount = 0;

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
    if (this.extensionInfo[ssrc].length > 10) {
      this.sendTWCC();
    }
  }

  async runTWCC() {
    if (this.twccRunning) return;
    this.twccRunning = true;

    while (this.twccRunning) {
      this.sendTWCC();
      await sleep(100);
    }
  }

  private sendTWCC() {
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

        const packetChunks: (RunLengthChunk | StatusVectorChunk)[] = [];
        const baseSequenceNumber = extensionsArr[0].tsn;
        const packetStatusCount = uint16Add(maxTSN - minTSN, 1);
        /**micro sec */
        let referenceTime!: bigint;
        /**micro sec */
        let lastTimestamp!: bigint;
        let lastPacketStatus:
          | { status: PacketStatus; minTSN: number }
          | undefined;
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

            const recvDelta = new RecvDelta({
              delta: Number(0), // todo fix
            });
            recvDelta.parseDelta();
            recvDeltas.push(recvDelta);

            // when status changed
            if (
              lastPacketStatus != undefined &&
              lastPacketStatus.status !== recvDelta.type
            ) {
              packetChunks.push(
                new RunLengthChunk({
                  packetStatus: lastPacketStatus.status,
                  runLength: i - lastPacketStatus.minTSN,
                })
              );
              lastPacketStatus = { minTSN: i, status: recvDelta.type! };
            }
            // last status
            if (i === maxTSN) {
              if (lastPacketStatus != undefined) {
                packetChunks.push(
                  new RunLengthChunk({
                    packetStatus: lastPacketStatus.status,
                    runLength: i - lastPacketStatus.minTSN + 1,
                  })
                );
              } else {
                packetChunks.push(
                  new RunLengthChunk({
                    packetStatus: recvDelta.type,
                    runLength: 1,
                  })
                );
              }
            }

            if (lastPacketStatus == undefined) {
              lastPacketStatus = { minTSN: i, status: recvDelta.type! };
            }
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
            fbPktCount: this.fbPktCount,
            recvDeltas,
            packetChunks,
          }),
        });

        this.dtlsTransport.sendRtcp([packet]).catch((err) => {
          console.log(err);
        });
        this.extensionInfo[Number(ssrc)] = [];
        this.fbPktCount = uint8Add(this.fbPktCount, 1);
      });
  }
}
