/**
 * @internal
 * Package-private SPED attachment for RTCPeerConnection and ice tests.
 * Not re-exported from `src/index.ts`.
 */
import type { Connection } from "../ice";
import { SpedSession } from "../sped/draft00/session";
import { type SpedHooks, SpedRuntime } from "../sped/runtime";
import {
  requestSpedCarryMaybeFlush,
  setConnectionSpedRuntime,
} from "./sped-bind";

export type { SpedHooks } from "../sped/runtime";
export { isSpedEligibleProtocol } from "../sped/runtime";
export { SpedSession } from "../sped/draft00/session";
export {
  DTLS_IN_STUN_ACK,
  DTLS_IN_STUN_DATA,
  decodeSpedAck,
  decodeSpedData,
  encodeSpedAck,
  encodeSpedData,
  spedDataCrc32,
} from "../sped/draft00";

export interface SpedHandle {
  session: SpedSession;
  runtime: SpedRuntime;
  onFlightCreated: (packets: readonly Buffer[]) => void;
  onHandshakeComplete: () => void;
}

export function attachSpedToConnection(
  connection: Connection,
  hooks: SpedHooks,
): SpedHandle {
  const session = new SpedSession(connection.generation);
  const runtime = new SpedRuntime(session, {
    ...hooks,
    inject: async (bytes, peer, generation) => {
      if (connection.generation !== generation) {
        return;
      }
      await Promise.resolve();
      if (connection.generation !== generation) {
        return;
      }
      await hooks.inject(bytes, peer, generation);
    },
  });
  runtime.syncPathMtuFromConnection(connection);
  setConnectionSpedRuntime(connection, runtime);
  return {
    session,
    runtime,
    onFlightCreated: (packets) => {
      session.replaceL1(packets);
      requestSpedCarryMaybeFlush(connection);
    },
    onHandshakeComplete: () => runtime.completeHandshake(),
  };
}
