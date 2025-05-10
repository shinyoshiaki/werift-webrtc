import type { Chunk } from "./chunk";
import { SCTP_MAX_ASSOCIATION_RETRANS, SCTP_MAX_INIT_RETRANS } from "./const";
import { debug } from "./imports/common";

const log = debug("werift/sctp/timer");

export enum SCTPTimerType {
  T1 = "t1", // wait for initAck or cookieAck
  T2 = "t2", // wait for shutdown
  T3 = "t3", // wait for data sack
  RECONFIG = "reconfig", // re-configuration
}

/**
 * SCTP タイマーの管理を行うクラス
 */
export class SCTPTimerManager {
  // タイマーハンドラ
  private t1Handle?: NodeJS.Timeout;
  private t2Handle?: NodeJS.Timeout;
  private t3Handle?: NodeJS.Timeout;
  private reconfigHandle?: NodeJS.Timeout;

  // タイマー関連の状態管理
  private t1Chunk?: Chunk;
  private t1Failures = 0;
  private t2Chunk?: Chunk;
  private t2Failures = 0;
  private reconfigFailures = 0;
  private rto: number;
  private onT1Expired: (failures: number) => void;
  private onT2Expired: (failures: number) => void;
  private onT3Expired: () => void;
  private onReconfigExpired: (failures: number) => void;
  private sendChunk: (chunk: Chunk) => Promise<void>;

  constructor({
    rto,
    onT1Expired,
    onT2Expired,
    onT3Expired,
    onReconfigExpired,
    sendChunk,
  }: {
    rto: number;
    onT1Expired: (failures: number) => void;
    onT2Expired: (failures: number) => void;
    onT3Expired: () => void;
    onReconfigExpired: (failures: number) => void;
    sendChunk: (chunk: Chunk) => Promise<void>;
  }) {
    this.rto = rto;
    this.onT1Expired = onT1Expired;
    this.onT2Expired = onT2Expired;
    this.onT3Expired = onT3Expired;
    this.onReconfigExpired = onReconfigExpired;
    this.sendChunk = sendChunk;
  }

  /**
   * RTOを設定する
   */
  setRto(rto: number) {
    this.rto = rto;
  }

  /**
   * RTOを取得する
   */
  getRto(): number {
    return this.rto;
  }

  /**
   * タイマー1の失敗回数を取得する
   */
  getT1Failures(): number {
    return this.t1Failures;
  }

  /**
   * タイマー2の失敗回数を取得する
   */
  getT2Failures(): number {
    return this.t2Failures;
  }

  /**
   * Reconfigタイマーの失敗回数を取得する
   */
  getReconfigFailures(): number {
    return this.reconfigFailures;
  }

  /**
   * Reconfigタイマーの失敗回数をインクリメントする
   */
  incrementReconfigFailures() {
    this.reconfigFailures++;
    return this.reconfigFailures;
  }

  /**
   * T1 タイマー開始 (initAck or cookieAck 待ち)
   */
  startT1(chunk: Chunk) {
    if (this.t1Handle) throw new Error("T1 timer already started");
    this.t1Chunk = chunk;
    this.t1Failures = 0;
    this.t1Handle = setTimeout(() => this.t1Expired(), this.rto * 1000);
  }

  /**
   * T1 タイマー失効処理
   */
  private t1Expired() {
    this.t1Failures++;
    this.t1Handle = undefined;

    if (this.t1Failures > SCTP_MAX_INIT_RETRANS) {
      this.onT1Expired(this.t1Failures);
    } else {
      setImmediate(() => {
        this.sendChunk(this.t1Chunk!).catch((err: Error) => {
          log("send timer1 chunk failed", err.message);
        });
      });
      this.t1Handle = setTimeout(() => this.t1Expired(), this.rto * 1000);
    }
  }

  /**
   * T1 タイマーキャンセル
   */
  cancelT1() {
    if (this.t1Handle) {
      clearTimeout(this.t1Handle);
      this.t1Handle = undefined;
      this.t1Chunk = undefined;
    }
  }

  /**
   * T2 タイマー開始 (shutdown 待ち)
   */
  startT2(chunk: Chunk) {
    if (this.t2Handle) throw new Error("T2 timer already started");
    this.t2Chunk = chunk;
    this.t2Failures = 0;
    this.t2Handle = setTimeout(() => this.t2Expired(), this.rto * 1000);
  }

  /**
   * T2 タイマー失効処理
   */
  private t2Expired() {
    this.t2Failures++;
    this.t2Handle = undefined;

    if (this.t2Failures > SCTP_MAX_ASSOCIATION_RETRANS) {
      this.onT2Expired(this.t2Failures);
    } else {
      setImmediate(() => {
        this.sendChunk(this.t2Chunk!).catch((err: Error) => {
          log("send timer2Chunk failed", err.message);
        });
      });
      this.t2Handle = setTimeout(() => this.t2Expired(), this.rto * 1000);
    }
  }

  /**
   * T2 タイマーキャンセル
   */
  cancelT2() {
    if (this.t2Handle) {
      clearTimeout(this.t2Handle);
      this.t2Handle = undefined;
      this.t2Chunk = undefined;
    }
  }

  /**
   * T3 タイマー開始 (data sack 待ち)
   */
  startT3() {
    if (this.t3Handle) throw new Error("T3 timer already started");
    this.t3Handle = setTimeout(() => this.t3Expired(), this.rto * 1000);
  }

  /**
   * T3 タイマー再開始
   */
  restartT3() {
    this.cancelT3();
    // for performance
    this.t3Handle = setTimeout(() => this.t3Expired(), this.rto);
  }

  /**
   * T3 タイマー失効処理
   */
  private t3Expired() {
    this.t3Handle = undefined;
    this.onT3Expired();
  }

  /**
   * T3 タイマーキャンセル
   */
  cancelT3() {
    if (this.t3Handle) {
      clearTimeout(this.t3Handle);
      this.t3Handle = undefined;
    }
  }

  /**
   * Reconfig タイマー開始
   */
  startReconfigTimer() {
    if (this.reconfigHandle) return;

    log("timerReconfigHandleStart", { rto: this.rto });
    this.reconfigFailures = 0;
    this.reconfigHandle = setTimeout(
      () => this.reconfigTimerExpired(),
      this.rto * 1000,
    );
  }

  /**
   * Reconfig タイマー失効処理
   */
  private reconfigTimerExpired() {
    this.reconfigFailures++;
    // back off
    this.rto = Math.ceil(this.rto * 1.5);

    if (this.reconfigFailures > SCTP_MAX_ASSOCIATION_RETRANS) {
      this.reconfigHandle = undefined;
    }

    this.onReconfigExpired(this.reconfigFailures);
  }

  /**
   * 次回のReconfig タイマー設定
   */
  scheduleNextReconfigTimer() {
    if (!this.reconfigHandle) {
      this.reconfigHandle = setTimeout(
        () => this.reconfigTimerExpired(),
        this.rto * 1000,
      );
    }
  }

  /**
   * Reconfig タイマーキャンセル
   */
  cancelReconfigTimer() {
    if (this.reconfigHandle) {
      log("timerReconfigCancel");
      clearTimeout(this.reconfigHandle);
      this.reconfigHandle = undefined;
    }
  }

  /**
   * すべてのタイマーをキャンセル
   */
  cancelAllTimers() {
    this.cancelT1();
    this.cancelT2();
    this.cancelT3();
    this.cancelReconfigTimer();
  }

  /**
   * タイマーが動作中か確認
   */
  isRunning(type: SCTPTimerType): boolean {
    switch (type) {
      case SCTPTimerType.T1:
        return this.t1Handle !== undefined;
      case SCTPTimerType.T2:
        return this.t2Handle !== undefined;
      case SCTPTimerType.T3:
        return this.t3Handle !== undefined;
      case SCTPTimerType.RECONFIG:
        return this.reconfigHandle !== undefined;
    }
  }
}
