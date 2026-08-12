import { randomBytes } from "crypto";
import type { HashAlgorithms, SignatureAlgorithms } from "../cipher/const";
import type { SessionTypes } from "../cipher/suites/abstract";
import { debug } from "../imports/common";
import type { FragmentedHandshake } from "../record/message/fragment";
import type { Options } from "../socket";
import type { Handshake } from "../typings/domain";

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
  /**
   * Last HelloVerify cookie (display / sessionId only). Verification is
   * stateless HMAC via {@link cookieSecret} + peer + ClientHello parameters.
   */
  cookie?: Buffer;
  /**
   * Secret for DTLS 1.2 HelloVerify cookies (RFC 6347 HMAC style).
   * Not shared across associations; never committed from peer input.
   */
  readonly cookieSecret = randomBytes(16);
  /**
   * True after a cookie-validated ClientHello has been committed into
   * cipher/srtp association state. Duplicate CH2 must not re-commit
   * (would regenerate serverRandom / ECDHE and desync cached Flight4).
   */
  clientHelloCommitted = false;
  requestedCertificateTypes: number[] = [];
  requestedSignatureAlgorithms: {
    hash: HashAlgorithms;
    signature: SignatureAlgorithms;
  }[] = [];
  remoteExtendedMasterSecret = false;
  /**
   * Set when a fatal peer alert / hard error aborts the 1.2 flight loop.
   * Flight.transmit checks this to stop retransmit and rethrow.
   */
  fatalError?: Error;

  /**
   * Cancelable retransmit sleeps for legacy 1.2 Flight.transmit.
   * Cleared by {@link cancelFlightTimers} on association hard-close / commit13.
   */
  private flightTimers = new Set<ReturnType<typeof setTimeout>>();
  private flightSleepResolvers = new Set<() => void>();

  constructor(
    public options: Options,
    public sessionType: SessionTypes,
  ) {}

  /**
   * Association-owned cancelable sleep (replaces bare timers/promises setTimeout
   * so close can cancel pending retransmit waits immediately).
   */
  flightSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const id = setTimeout(() => {
        this.flightTimers.delete(id);
        this.flightSleepResolvers.delete(resolve);
        resolve();
      }, ms);
      this.flightTimers.add(id);
      this.flightSleepResolvers.add(resolve);
    });
  }

  /** Cancel all pending 1.2 flight retransmit timers (association teardown). */
  cancelFlightTimers(): void {
    for (const id of this.flightTimers) {
      clearTimeout(id);
    }
    this.flightTimers.clear();
    // Resolve sleepers so transmit loops can observe flight=99 / fatal and exit
    // (do not reject — Flight treats resolve + flight check as clean stop).
    for (const resolve of this.flightSleepResolvers) {
      resolve();
    }
    this.flightSleepResolvers.clear();
  }

  get sessionId() {
    return this.cookie ? this.cookie.toString("hex").slice(0, 10) : "";
  }

  get sortedHandshakeCache() {
    return Object.entries(this.handshakeCache)
      .sort(([a], [b]) => Number(a) - Number(b))
      .flatMap(([, { data }]) =>
        data.sort((a, b) => a.message_seq - b.message_seq),
      );
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
