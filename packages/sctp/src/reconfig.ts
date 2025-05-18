import { ReconfigChunk } from "./chunk";
import { RECONFIG_MAX_STREAMS, SCTP_STATE } from "./const";
import { debug } from "./imports/common";
import { OutgoingSSNResetRequestParam, type StreamParam } from "./param";
import { tsnMinusOne, tsnPlusOne } from "./stream";
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

  constructor(
    private initialLocalTsn: number,
    private transmitter: SCTPTransmitter,
    private timerManager: SCTPTimerManager,
  ) {
    this.reconfigRequestSeq = this.initialLocalTsn;
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
        tsnMinusOne(this.initialLocalTsn),
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
}
