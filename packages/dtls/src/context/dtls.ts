import { debug } from "debug";

import { HashAlgorithms, SignatureAlgorithms } from "../cipher/const";
import { SessionTypes } from "../cipher/suites/abstract";
import { FragmentedHandshake } from "../record/message/fragment";
import { Options } from "../socket";
import { Handshake } from "../typings/domain";

const log = debug("werift-dtls : packages/dtls/src/context/dtls.ts : log");

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

    // todo fix
    const sorted = this.handshakeCache.sort(
      (a, b) => a.data.msg_type - b.data.msg_type
    );
    return sorted;
  }

  bufferHandshakeCache(
    handshakes: FragmentedHandshake[],
    isLocal: boolean,
    flight: number
  ) {
    const exist = this.handshakeCache.find(
      (h) =>
        handshakes.find((t) => h.data.msg_type === t.msg_type) &&
        h.isLocal === isLocal &&
        h.flight === flight
    );
    if (exist) {
      log(this.session, "exist handshake", exist.data.summary, isLocal, flight);
      return;
    }

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
