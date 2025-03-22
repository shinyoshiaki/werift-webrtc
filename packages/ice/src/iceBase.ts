import { randomUUID } from "crypto";
import { Candidate, candidateFoundation, candidatePriority } from "./candidate";
import type { MdnsLookup } from "./dns/lookup";
import type { Cancelable } from "./helper";
import {
  type Address,
  type Event,
  type InterfaceAddresses,
  debug,
} from "./imports/common";
import { classes, methods } from "./stun/const";
import { Message } from "./stun/message";
import type { Protocol } from "./types/model";

const log = debug("werift-ice : packages/ice/src/ice.ts : log");

export interface IceConnection {
  iceControlling: boolean;
  localUsername: string;
  localPassword: string;
  remotePassword: string;
  remoteUsername: string;
  remoteIsLite: boolean;
  checkList: CandidatePair[];
  localCandidates: Candidate[];
  stunServer?: Address;
  turnServer?: Address;
  generation: number;
  options: IceOptions;
  remoteCandidatesEnd: boolean;
  localCandidatesEnd: boolean;
  state: IceState;
  lookup?: MdnsLookup;
  nominated?: CandidatePair;

  readonly onData: Event<[Buffer]>;
  readonly stateChanged: Event<[IceState]>;
  readonly onIceCandidate: Event<[Candidate]>;

  restart(): void;

  setRemoteParams(params: {
    iceLite: boolean;
    usernameFragment: string;
    password: string;
  }): void;

  gatherCandidates(): Promise<void>;

  connect(): Promise<void>;

  close(): Promise<void>;

  addRemoteCandidate(remoteCandidate: Candidate | undefined): Promise<void>;

  send(data: Buffer): Promise<void>;

  getDefaultCandidate(): Candidate | undefined;
  resetNominatedPair(): void;
}

export class CandidatePair {
  readonly id = randomUUID();
  handle?: Cancelable<void>;
  nominated = false;
  remoteNominated = false;
  // 5.7.4.  Computing States
  private _state = CandidatePairState.FROZEN;
  get state() {
    return this._state;
  }

  toJSON() {
    return this.json;
  }

  get json() {
    return {
      protocol: this.protocol.type,
      localCandidate: this.localCandidate.toSdp(),
      remoteCandidate: this.remoteCandidate.toSdp(),
    };
  }

  constructor(
    public protocol: Protocol,
    public remoteCandidate: Candidate,
    public iceControlling: boolean,
  ) {}

  updateState(state: CandidatePairState) {
    this._state = state;
  }

  get localCandidate() {
    if (!this.protocol.localCandidate) {
      throw new Error("localCandidate not exist");
    }
    return this.protocol.localCandidate;
  }

  get remoteAddr(): Address {
    return [this.remoteCandidate.host, this.remoteCandidate.port];
  }

  get component() {
    return this.localCandidate.component;
  }

  get priority() {
    return candidatePairPriority(
      this.localCandidate,
      this.remoteCandidate,
      this.iceControlling,
    );
  }
}

export const ICE_COMPLETED = 1 as const;
export const ICE_FAILED = 2 as const;

export const CONSENT_INTERVAL = 5;
export const CONSENT_FAILURES = 6;

export enum CandidatePairState {
  FROZEN = 0,
  WAITING = 1,
  IN_PROGRESS = 2,
  SUCCEEDED = 3,
  FAILED = 4,
}

export type IceState =
  | "disconnected"
  | "closed"
  | "completed"
  | "new"
  | "connected";

export interface IceOptions {
  stunServer?: Address;
  turnServer?: Address;
  turnUsername?: string;
  turnPassword?: string;
  turnTransport?: "udp" | "tcp";
  forceTurn?: boolean;
  localPasswordPrefix?: string;
  useIpv4: boolean;
  useIpv6: boolean;
  useLinkLocalAddress?: boolean;
  portRange?: [number, number];
  interfaceAddresses?: InterfaceAddresses;
  additionalHostAddresses?: string[];
  filterStunResponse?: (
    message: Message,
    addr: Address,
    protocol: Protocol,
  ) => boolean;
  filterCandidatePair?: (pair: CandidatePair) => boolean;
}

export const defaultOptions: IceOptions = {
  useIpv4: true,
  useIpv6: true,
};

export function validateRemoteCandidate(candidate: Candidate) {
  // """
  // Check the remote candidate is supported.
  // """
  if (!["host", "relay", "srflx"].includes(candidate.type))
    throw new Error(`Unexpected candidate type "${candidate.type}"`);

  // ipaddress.ip_address(candidate.host)
  return candidate;
}

export function sortCandidatePairs(
  pairs: {
    localCandidate: Pick<Candidate, "priority">;
    remoteCandidate: Pick<Candidate, "priority">;
  }[],
  iceControlling: boolean,
) {
  return pairs
    .sort(
      (a, b) =>
        candidatePairPriority(
          a.localCandidate,
          a.remoteCandidate,
          iceControlling,
        ) -
        candidatePairPriority(
          b.localCandidate,
          b.remoteCandidate,
          iceControlling,
        ),
    )
    .reverse();
}

// 5.7.2.  Computing Pair Priority and Ordering Pairs
export function candidatePairPriority(
  local: Pick<Candidate, "priority">,
  remote: Pick<Candidate, "priority">,
  iceControlling: boolean,
) {
  const G = (iceControlling && local.priority) || remote.priority;
  const D = (iceControlling && remote.priority) || local.priority;
  return (1 << 32) * Math.min(G, D) + 2 * Math.max(G, D) + (G > D ? 1 : 0);
}

export async function serverReflexiveCandidate(
  protocol: Protocol,
  stunServer: Address,
) {
  // """
  // Query STUN server to obtain a server-reflexive candidate.
  // """

  // # perform STUN query
  const request = new Message(methods.BINDING, classes.REQUEST);
  try {
    const [response] = await protocol.request(request, stunServer);

    const localCandidate = protocol.localCandidate;
    if (!localCandidate) {
      throw new Error("not exist");
    }

    const candidate = new Candidate(
      candidateFoundation("srflx", "udp", localCandidate.host),
      localCandidate.component,
      localCandidate.transport,
      candidatePriority("srflx"),
      response.getAttributeValue("XOR-MAPPED-ADDRESS")[0],
      response.getAttributeValue("XOR-MAPPED-ADDRESS")[1],
      "srflx",
      localCandidate.host,
      localCandidate.port,
    );
    return candidate;
  } catch (error) {
    // todo fix
    log("error serverReflexiveCandidate", error);
  }
}

export function validateAddress(addr?: Address): Address | undefined {
  if (addr && Number.isNaN(addr[1])) {
    return [addr[0], 443];
  }
  return addr;
}
