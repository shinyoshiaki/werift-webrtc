/**
 * Package-private SPED attachment for Connection. Not exported from src/index.ts.
 */
import type { Connection } from "../ice";
import type { CandidatePair, IceConnection } from "../iceBase";
import { SpedSession } from "../sped/draft00/session";
import { type SpedRuntime, isSpedAdvertisablePair } from "../sped/runtime";
import type { Message } from "../stun/message";

const runtimes = new WeakMap<Connection, SpedRuntime>();
const pendingAdvertisements = new WeakMap<IceConnection, SpedSession>();

/** Advertise opt-in before gathering exposes a socket to early ICE checks. */
export function prepareConnectionSped(connection: IceConnection): void {
  pendingAdvertisements.set(connection, new SpedSession(connection.generation));
}

/**
 * Called for Binding Requests and authenticated Binding Responses before DTLS
 * attaches. Advertise support without consuming or ACKing any received DTLS
 * flight: the sender must retain L1 until a live DTLS endpoint can receive it.
 * Every non-relay pair advertises (draft §3.3.2.1); the peer otherwise treats
 * a C070-less first authenticated Binding as unsupported.
 */
export function decoratePendingSped(
  connection: IceConnection,
  message: Message,
  pair: CandidatePair,
): boolean {
  const advertisement = pendingAdvertisements.get(connection);
  if (!advertisement || !isSpedAdvertisablePair(pair)) {
    return true;
  }
  return advertisement.decorateCapabilityAdvertisement(message);
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
