/**
 * Package-private SPED attachment for Connection. Not exported from src/index.ts.
 */
import type { Connection } from "../ice";
import type { CandidatePair, IceConnection } from "../iceBase";
import { DTLS_IN_STUN_DATA } from "../sped/draft00/constants";
import { SpedSession } from "../sped/draft00/session";
import {
  type SpedRuntime,
  isSpedEligiblePair,
  isSpedEligibleProtocol,
} from "../sped/runtime";
import type { Message } from "../stun/message";
import { getRawAttributeValue } from "../stun/rawAttributeValue";

const runtimes = new WeakMap<Connection, SpedRuntime>();
const pendingAdvertisements = new WeakMap<IceConnection, SpedSession>();

/** Advertise opt-in before gathering exposes a socket to early ICE checks. */
export function prepareConnectionSped(connection: IceConnection): void {
  pendingAdvertisements.set(connection, new SpedSession(connection.generation));
}

/**
 * Called only for authenticated Binding Responses before DTLS attaches.
 * Advertise support without consuming or ACKing any received DTLS flight:
 * the sender must retain L1 until a live DTLS endpoint can receive it.
 */
export function decoratePendingSpedResponse(
  connection: IceConnection,
  response: Message,
  pair: CandidatePair,
  request: Message,
): boolean {
  const advertisement = pendingAdvertisements.get(connection);
  if (
    !advertisement ||
    !isSpedEligibleProtocol(pair.protocol) ||
    pair.remoteCandidate.type === "relay"
  ) {
    return true;
  }
  // A UDP prflx address may still turn out to be a relay. Match the live
  // runtime's capability-only policy: wait for authenticated DATA evidence.
  if (
    !isSpedEligiblePair(pair) &&
    (pair.remoteCandidate.type !== "prflx" ||
      getRawAttributeValue(request, DTLS_IN_STUN_DATA) === undefined)
  ) {
    return true;
  }
  return advertisement.decorateCapabilityAdvertisement(response);
}

export function setConnectionSpedRuntime(
  connection: Connection,
  runtime: SpedRuntime | undefined,
): void {
  pendingAdvertisements.delete(connection);
  if (runtime) {
    runtimes.set(connection, runtime);
  } else {
    runtimes.delete(connection);
  }
}

export function getConnectionSpedRuntime(
  connection: Connection,
): SpedRuntime | undefined {
  return runtimes.get(connection);
}
