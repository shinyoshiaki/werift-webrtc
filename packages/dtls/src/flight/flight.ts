import debug from "debug";
import { DtlsContext } from "../context/dtls";
import { TransportContext } from "../context/transport";
import { sleep } from "../helper";

const log = debug("dtls/flight");

const flightTypes = ["PREPARING", "SENDING", "WAITING", "FINISHED"] as const;

type FlightType = typeof flightTypes[number];

export abstract class Flight {
  state: FlightType = "PREPARING";
  private buffer: Buffer[] = [];

  constructor(
    private udp: TransportContext,
    public dtls: DtlsContext,
    private nextFlight?: number
  ) {}

  private setState(state: FlightType) {
    this.state = state;
  }

  protected transmit(buf: Buffer[]) {
    this.buffer = buf;
    this.retransmit();
  }

  protected send(buf: Buffer[]) {
    buf.forEach((v) => this.udp.send(v));
  }

  private async retransmit() {
    this.setState("SENDING");
    this.send(this.buffer);
    this.setState("WAITING");

    if (this.nextFlight === undefined) {
      this.setState("FINISHED");
      return;
    }

    await sleep(1000);
    if (this.dtls.flight >= this.nextFlight) {
      this.setState("FINISHED");
      return;
    } else {
      log("retransmit", this.dtls.flight);
      this.retransmit().then(() => log(this.dtls.flight, "done"));
    }
  }
}
