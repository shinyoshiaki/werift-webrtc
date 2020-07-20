import { FragmentedHandshake } from "../record/message/fragment";
import { Handshake } from "../typings/domain";

export class DtlsContext {
  version = { major: 255 - 1, minor: 255 - 2 };
  lastFlight: Handshake[] = [];
  sequenceNumber = 0;
  epoch = 0;
  flight = 1;
  handshakeCache: {
    isLocal: boolean;
    data: FragmentedHandshake;
    flight: number;
  }[] = [];
  cookie?: Buffer;
  requestedCertificateTypes: number[] = [];
  requestedSignatureAlgorithms: { hash: number; signature: number }[] = [];

  bufferHandshakeCache(
    handshakes: FragmentedHandshake[],
    isLocal: boolean,
    flight: number
  ) {
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
