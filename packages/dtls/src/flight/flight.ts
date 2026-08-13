import type { DtlsContext } from "../context/dtls";
import type { TransportContext } from "../context/transport";
import { debug } from "../imports/common";
import { createFragments, createPlaintext } from "../record/builder";
import { ContentType } from "../record/const";
import type { Handshake } from "../typings/domain";

const warn = debug("werift-dtls : packages/dtls/src/flight/flight.ts : warn");
const err = debug("werift-dtls : packages/dtls/src/flight/flight.ts : err");

const flightTypes = ["PREPARING", "SENDING", "WAITING", "FINISHED"] as const;

type FlightType = (typeof flightTypes)[number];

export abstract class Flight {
  state: FlightType = "PREPARING";
  static RetransmitCount = 10;
  /**
   * When set, transmit aborts after sleep if {@link DtlsContext.hvrGeneration}
   * no longer matches (superseded HVR / Flight3 re-challenge).
   */
  protected transmitGeneration?: number;
  /**
   * Captured {@link DtlsContext.flightTxGeneration} at Flight construction /
   * first transmit. Late transport.send completions after
   * cancelFlightTimers must not log or treat as live association failures.
   */
  private sendGeneration: number;

  constructor(
    private transport: TransportContext,
    public dtls: DtlsContext,
    private flight: number,
    private nextFlight?: number,
  ) {
    this.sendGeneration = dtls.flightTxGeneration;
  }

  protected createPacket(handshakes: Handshake[]) {
    const fragments = createFragments(this.dtls)(handshakes);
    this.dtls.bufferHandshakeCache(fragments, true, this.flight);
    const packets = createPlaintext(this.dtls)(
      fragments.map((fragment) => ({
        type: ContentType.handshake,
        fragment: fragment.serialize(),
      })),
      ++this.dtls.recordSequenceNumber,
    );
    return packets;
  }

  /**
   * True when this Flight instance still owns TX for the association
   * (not closed / not version-committed away / not HVR-superseded).
   */
  private isTransmitStillCurrent(): boolean {
    if (this.dtls.fatalError) return false;
    if (this.dtls.flight === 99) return false;
    if (this.sendGeneration !== this.dtls.flightTxGeneration) return false;
    if (
      this.transmitGeneration !== undefined &&
      this.transmitGeneration !== this.dtls.hvrGeneration
    ) {
      return false;
    }
    return true;
  }

  protected async transmit(buffers: Buffer[]) {
    // Refresh send generation at transmit start so a long-lived Flight that
    // began before a soft timer cancel still tracks the latest association TX gen
    // only when still the active path (fatal/close already bumped gen).
    this.sendGeneration = this.dtls.flightTxGeneration;

    let retransmitCount = 0;
    for (; retransmitCount <= Flight.RetransmitCount; retransmitCount++) {
      // Association may have advanced flight=99 / canceled timers while sleeping.
      if (
        this.nextFlight !== undefined &&
        this.dtls.flight >= this.nextFlight
      ) {
        this.setState("FINISHED");
        break;
      }
      if (this.dtls.fatalError) {
        this.setState("FINISHED");
        throw this.dtls.fatalError;
      }
      if (!this.isTransmitStillCurrent()) {
        this.setState("FINISHED");
        break;
      }

      this.setState("SENDING");
      // Capture generation for this wave so close/fallback mid-send silences
      // late rejections (fire-and-forget must not surface after terminal).
      const waveGen = this.dtls.flightTxGeneration;
      // Association-tagged send: if generation advances before the promise
      // settles, drop the error callback; if already stale, skip TX entirely.
      if (waveGen === this.dtls.flightTxGeneration && !this.dtls.fatalError) {
        this.send(buffers).catch((e) => {
          if (
            waveGen !== this.dtls.flightTxGeneration ||
            this.dtls.flight === 99 ||
            this.dtls.fatalError
          ) {
            // Stale after cancelFlightTimers / hard-close / fatal — ignore.
            return;
          }
          err(this.dtls.sessionId, "fail to send", e);
        });
      }
      this.setState("WAITING");

      if (this.nextFlight === undefined) {
        this.setState("FINISHED");
        break;
      }

      // Cancelable via DtlsContext.cancelFlightTimers (association hard-close).
      await this.dtls.flightSleep(1000 * ((retransmitCount + 1) / 2));

      if (this.dtls.fatalError) {
        this.setState("FINISHED");
        throw this.dtls.fatalError;
      }

      // Superseded by a newer HVR generation (Flight3 re-challenge) — stop
      // without throwing so only the latest cookie-bearing CH2 is retransmitted.
      if (
        this.transmitGeneration !== undefined &&
        this.transmitGeneration !== this.dtls.hvrGeneration
      ) {
        this.setState("FINISHED");
        break;
      }

      if (this.sendGeneration !== this.dtls.flightTxGeneration) {
        this.setState("FINISHED");
        break;
      }

      if (this.dtls.flight >= this.nextFlight) {
        this.setState("FINISHED");
        break;
      } else {
        warn(
          this.dtls.sessionId,
          "retransmit",
          retransmitCount,
          this.dtls.flight,
        );
      }
    }

    if (this.dtls.fatalError) {
      throw this.dtls.fatalError;
    }

    if (
      this.nextFlight !== undefined &&
      this.dtls.flight < this.nextFlight &&
      retransmitCount > Flight.RetransmitCount
    ) {
      // Do not throw "over retransmit" after association already terminal.
      if (!this.isTransmitStillCurrent()) {
        return;
      }
      err(this.dtls.sessionId, "retransmit failed", retransmitCount);
      throw new Error(
        `over retransmitCount : ${this.flight} ${this.nextFlight}`,
      );
    }
  }

  /** Send with association pin when TransportContext.pinnedPeer is set. */
  protected send = (buf: Buffer[]) =>
    Promise.all(buf.map((v) => this.transport.send(v)));

  private setState(state: FlightType) {
    this.state = state;
  }
}
