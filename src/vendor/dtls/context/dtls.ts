import { FragmentedHandshake } from "../record/message/fragment";
import { Options } from "../socket";
import { Handshake } from "../typings/domain";

export class DtlsContext {
  version = { major: 255 - 1, minor: 255 - 2 };
  lastFlight: Handshake[] = [];
  recordSequenceNumber = 0;
  sequenceNumber = 0;
  epoch = 0;
  flight = 0;
  handshakeCache: {
    isLocal: boolean;
    data: FragmentedHandshake;
    flight: number;
  }[] = [];
  cookie?: Buffer;
  requestedCertificateTypes: number[] = [];
  requestedSignatureAlgorithms: { hash: number; signature: number }[] = [];

  constructor(public options: Options) {}

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
