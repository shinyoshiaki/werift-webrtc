import { Handshake } from "../typings/domain";
import { FragmentedHandshake } from "../record/message/fragment";

export class DtlsContext {
  version = { major: 255 - 1, minor: 255 - 2 };
  lastFlight: Handshake[] = [];
  sequenceNumber = 0;
  epoch = 0;
  flight = 1;
  handshakeCache: { isLocal: boolean; data: Buffer; flight: number }[] = [];
  cookie?: Buffer;

  bufferHandshakeCache(handshakes: Buffer[], isLocal: boolean, flight: number) {
    this.handshakeCache = [
      ...this.handshakeCache,
      ...handshakes.map((data) => ({
        isLocal,
        data,
        flight,
      })),
    ];
  }
}
