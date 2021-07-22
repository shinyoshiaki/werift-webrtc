import { HashAlgorithms, SignatureAlgorithms } from "../cipher/const";
import { SessionTypes } from "../cipher/suites/abstract";
import { FragmentedHandshake } from "../record/message/fragment";
import { Options } from "../socket";
import { Handshake } from "../typings/domain";

export class DtlsContext {
  version = { major: 255 - 1, minor: 255 - 2 };
  lastFlight: Handshake[] = [];
  lastMessage: Buffer[] = [];
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
  requestedSignatureAlgorithms: {
    hash: HashAlgorithms;
    signature: SignatureAlgorithms;
  }[] = [];
  remoteExtendedMasterSecret = false;

  constructor(public options: Options, public sessionType: SessionTypes) {}

  get session() {
    return this.cookie ? this.cookie.toString("hex").slice(0, 10) : "";
  }

  get sortedHandshakeCache() {
    // const order = [
    //   HandshakeType.client_hello_1,
    //   HandshakeType.server_hello_2,
    //   HandshakeType.certificate_11,
    //   HandshakeType.server_key_exchange_12,
    //   HandshakeType.certificate_request_13,
    //   HandshakeType.server_hello_done_14,
    //   HandshakeType.certificate_request_13,
    //   HandshakeType.client_key_exchange_16,
    //   HandshakeType.certificate_verify_15,
    //   HandshakeType.finished_20,
    // ];
    // for (const task of order) {
    // }
    const sorted = this.handshakeCache.sort((h) => h.data.msg_type);
    return sorted;
  }

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
