import debug from "debug";
import { DtlsContext } from "../context/dtls";
import { TransportContext } from "../context/transport";
import { sleep } from "../helper";
import { createFragments, createPlaintext } from "../record/builder";
import { ContentType } from "../record/const";
import { Handshake } from "../typings/domain";

const log = debug("werift/dtls/flight");

const flightTypes = ["PREPARING", "SENDING", "WAITING", "FINISHED"] as const;

type FlightType = typeof flightTypes[number];

export abstract class Flight {
  state: FlightType = "PREPARING";
  private buffer: Buffer[] = [];

  constructor(
    private transport: TransportContext,
    public dtls: DtlsContext,
    private flight: number,
    private nextFlight?: number
  ) {}

  protected createPacket(handshakes: Handshake[]) {
    const fragments = createFragments(this.dtls)(handshakes);
    this.dtls.bufferHandshakeCache(fragments, true, this.flight);
    const packets = createPlaintext(this.dtls)(
      fragments.map((fragment) => ({
        type: ContentType.handshake,
        fragment: fragment.serialize(),
      })),
      ++this.dtls.recordSequenceNumber
    );
    return packets;
  }

  protected transmit(buf: Buffer[]) {
    this.buffer = buf;
    this.retransmit();
  }

  protected send = (buf: Buffer[]) =>
    Promise.all(buf.map((v) => this.transport.send(v)));

  private setState(state: FlightType) {
    this.state = state;
  }

  retransmitCount = 0;
  private async retransmit() {
    this.setState("SENDING");
    this.send(this.buffer);
    this.setState("WAITING");

    if (this.nextFlight === undefined) {
      this.retransmitCount = 0;
      this.setState("FINISHED");
      return;
    }

    await sleep(1000);
    if (this.dtls.flight >= this.nextFlight) {
      this.retransmitCount = 0;
      this.setState("FINISHED");
      return;
    } else {
      if (this.retransmitCount++ > 10) throw new Error("over retransmitCount");
      log("retransmit", this.dtls.flight, this.dtls.sessionType);
      this.retransmit().then(() => log(this.dtls.flight, "done"));
    }
  }
}
