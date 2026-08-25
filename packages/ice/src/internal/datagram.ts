import type { CandidatePair } from "../iceBase";
import type { Address } from "../imports/common";
import type { Protocol } from "../types/model";

/**
 * Internal datagram routing context (not a Public ICE API).
 * Public {@link Connection.onData} remains `Event<[Buffer]>`.
 */
export interface IceDatagramContext {
  bytes: Buffer;
  source: Address;
  protocol: Protocol;
  pair?: CandidatePair;
  generation: number;
  authenticated: boolean;
}
