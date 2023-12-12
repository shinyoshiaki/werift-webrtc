import debug from "debug";
import { setTimeout } from "timers/promises";

import { DtlsContext } from "../context/dtls";
import { TransportContext } from "../context/transport";
import { createFragments, createPlaintext } from "../record/builder";
import { ContentType } from "../record/const";
import { Handshake } from "../typings/domain";

const warn = debug("werift-dtls : packages/dtls/src/flight/flight.ts : warn");
const err = debug("werift-dtls : packages/dtls/src/flight/flight.ts : err");

const flightTypes = ["PREPARING", "SENDING", "WAITING", "FINISHED"] as const;

type FlightType = (typeof flightTypes)[number];

export abstract class Flight {
  state: FlightType = "PREPARING";
  static RetransmitCount = 10;

  constructor(
    private transport: TransportContext,
    public dtls: DtlsContext,
    private flight: number,
    private nextFlight?: number,
  ) {}

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

  protected async transmit(buffers: Buffer[]) {
    let retransmitCount = 0;
    for (; retransmitCount <= Flight.RetransmitCount; retransmitCount++) {
      this.setState("SENDING");
      this.send(buffers).catch((e) => {
        err("fail to send", err);
      });
      this.setState("WAITING");

      if (this.nextFlight === undefined) {
        this.setState("FINISHED");
        break;
      }

      await setTimeout(1000 * ((retransmitCount + 1) / 2));

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

    if (retransmitCount > Flight.RetransmitCount) {
      err(this.dtls.sessionId, "retransmit failed", retransmitCount);
      throw new Error(
        `over retransmitCount : ${this.flight} ${this.nextFlight}`,
      );
    }
  }

  protected send = (buf: Buffer[]) =>
    Promise.all(buf.map((v) => this.transport.send(v)));

  private setState(state: FlightType) {
    this.state = state;
  }
}
