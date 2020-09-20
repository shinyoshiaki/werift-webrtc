import { DtlsContext } from "../context/dtls";
import { TransportContext } from "../context/transport";
import { sleep } from "../helper";

const flightTypes = ["PREPARING", "SENDING", "WAITING", "FINISHED"] as const;

type FlightType = typeof flightTypes[number];

export abstract class Flight {
  state: FlightType = "PREPARING";
  buffer: Buffer[] = [];

  constructor(
    private udp: TransportContext,
    public dtls: DtlsContext,
    private nextFlight?: number
  ) {}

  private setState(state: FlightType) {
    this.state = state;
  }

  transmit(buf: Buffer[]) {
    this.buffer = buf;
    this.retransmit();
  }

  private async retransmit() {
    this.setState("SENDING");
    this.buffer.forEach((v) => this.udp.send(v));
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
      this.retransmit();
    }
  }
}
