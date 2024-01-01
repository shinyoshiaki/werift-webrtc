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
    [flight: number]: {
      isLocal: boolean;
      data: FragmentedHandshake[];
      flight: number;
    };
  } = {};
  cookie?: Buffer;
  requestedCertificateTypes: number[] = [];
  requestedSignatureAlgorithms: {
    hash: HashAlgorithms;
    signature: SignatureAlgorithms;
  }[] = [];
  remoteExtendedMasterSecret = false;

  constructor(public options: Options, public sessionType: SessionTypes) {}

  get sessionId() {
    return this.cookie ? this.cookie.toString("hex").slice(0, 10) : "";
  }

  get sortedHandshakeCache() {
    return Object.entries(this.handshakeCache)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, { data }]) => data.sort((a, b) => a.message_seq - b.message_seq))
      .flatMap((v) => v);
  }

  checkHandshakesExist = (handshakes: number[]) =>
    !handshakes.find(
      (type) =>
        this.sortedHandshakeCache.find((h) => h.msg_type === type) == undefined,
    );

  bufferHandshakeCache(
    handshakes: FragmentedHandshake[],
    isLocal: boolean,
    flight: number,
  ) {
    if (!this.handshakeCache[flight]) {
      this.handshakeCache[flight] = { data: [], isLocal, flight };
    }

    const filtered = handshakes.filter((h) => {
      const exist = this.handshakeCache[flight].data.find(
        (t) => t.msg_type === h.msg_type,
      );
      if (exist) {
        log(this.sessionId, "exist", exist.summary, isLocal, flight);
        return false;
      }
      return true;
    });

    this.handshakeCache[flight].data = [
      ...this.handshakeCache[flight].data,
      ...filtered,
    ];
  }
}
