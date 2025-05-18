import { ReconfigChunk } from "./chunk";
import {
  RECONFIG_MAX_STREAMS,
  SCTP_MAX_ASSOCIATION_RETRANS,
  SCTP_STATE,
} from "./const";
import { Event, debug } from "./imports/common";
import {
  OutgoingSSNResetRequestParam,
  ReconfigResponseParam,
  type StreamAddOutgoingParam,
  type StreamParam,
  reconfigResult,
} from "./param";
import { type InboundStream, tsnMinusOne, tsnPlusOne } from "./stream";
import type { SCTPTimerManager } from "./timer";
import type { SCTPTransmitter } from "./transmitter";

const log = debug("packages/sctp/src/reconfig.ts");

export class SctpReconfig {
  // # reconfiguration

  /**初期TSNと同じ値に初期化される単調に増加する数です. これは、新しいre-configuration requestパラメーターを送信するたびに1ずつ増加します */
  reconfigRequestSeq: number;
  /**このフィールドは、incoming要求のre-configuration requestシーケンス番号を保持します. 他の場合では、次に予想されるre-configuration requestシーケンス番号から1を引いた値が保持されます */
  reconfigResponseSeq = 0;
  reconfigRequest?: OutgoingSSNResetRequestParam;
  reconfigQueue: number[] = [];
  readonly onReconfigStreams = new Event<[number[]]>();

  constructor(
    private transmitter: SCTPTransmitter,
    private timerManager: SCTPTimerManager,
  ) {
    this.reconfigRequestSeq = this.transmitter.localTsn;

    this.timerManager.onReconfigExpired.subscribe(async (reconfigFailures) => {
      if (
        reconfigFailures <= SCTP_MAX_ASSOCIATION_RETRANS &&
        this.reconfigRequest
      ) {
        log(
          "timerReconfigHandleExpired",
          reconfigFailures,
          this.timerManager.rto,
        );
        await this.sendReconfigParam(this.reconfigRequest);

        this.timerManager.scheduleNextReconfigTimer();
      }
    });
  }

  async transmitReconfigRequest(associationState: SCTP_STATE) {
    if (
      this.reconfigQueue.length > 0 &&
      associationState === SCTP_STATE.ESTABLISHED &&
      !this.reconfigRequest
    ) {
      const streams = this.reconfigQueue.slice(0, RECONFIG_MAX_STREAMS);

      this.reconfigQueue = this.reconfigQueue.slice(RECONFIG_MAX_STREAMS);
      const param = new OutgoingSSNResetRequestParam(
        this.reconfigRequestSeq,
        this.reconfigResponseSeq,
        tsnMinusOne(this.transmitter.localTsn),
        streams,
      );
      this.reconfigRequestSeq = tsnPlusOne(this.reconfigRequestSeq);

      this.reconfigRequest = param;
      await this.sendReconfigParam(param);
      this.timerManager.startReconfigTimer();
    }
  }

  async sendReconfigParam(param: StreamParam) {
    log("sendReconfigParam", param);
    const chunk = new ReconfigChunk();
    chunk.params.push([param.type, param.bytes]);
    await this.transmitter.sendChunk(chunk).catch((err: Error) => {
      log("send reconfig failed", err.message);
    });
  }

  updateReconfigResponseSeq(reconfigResponseSeq: number) {
    this.reconfigResponseSeq = reconfigResponseSeq;
  }

  async handleOutgoingSSNResetRequest(
    p: OutgoingSSNResetRequestParam,
    outboundStreamSeq: {
      [streamId: number]: number;
    },
    associationState: SCTP_STATE,
  ) {
    // # send response
    const response = new ReconfigResponseParam(
      p.requestSequence,
      reconfigResult.ReconfigResultSuccessPerformed,
    );
    this.updateReconfigResponseSeq(p.requestSequence);
    await this.sendReconfigParam(response);

    // # mark closed inbound streams
    await Promise.all(
      p.streams.map(async (streamId) => {
        if (outboundStreamSeq[streamId]) {
          this.reconfigQueue.push(streamId);
          // await this.sendResetRequest(streamId);
        }
      }),
    );
    await this.transmitReconfigRequest(associationState);
    // # close data channel
    this.onReconfigStreams.execute(p.streams);

    return p.streams;
  }

  async handleReconfigResponse(
    reset: ReconfigResponseParam,
    associationState: SCTP_STATE,
  ) {
    if (reset.result !== reconfigResult.ReconfigResultSuccessPerformed) {
      log(
        "OutgoingSSNResetRequestParam failed",
        Object.keys(reconfigResult).find(
          (key) => reconfigResult[key as never] === reset.result,
        ),
      );
    } else if (
      reset.responseSequence === this.reconfigRequest?.requestSequence
    ) {
      const reconfigStreams = this.reconfigRequest.streams.map((streamId) => {
        return streamId;
      });

      this.onReconfigStreams.execute(reconfigStreams);

      this.reconfigRequest = undefined;
      this.timerManager.cancelReconfigTimer();
      if (this.reconfigQueue.length > 0) {
        await this.transmitReconfigRequest(associationState);
      }

      return reconfigStreams;
    }
  }

  async handleStreamAddOutgoing(add: StreamAddOutgoingParam) {
    const res = new ReconfigResponseParam(add.requestSequence, 1);
    this.reconfigResponseSeq = add.requestSequence;
    await this.sendReconfigParam(res);
  }
}
