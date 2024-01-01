import { createHash } from "crypto";
import { Address } from "../model";
import { StunAgent } from "../stun/agent";
import { address2Str } from "../util";
import { IceRole } from "./agent";

// ベース: ICEエージェントが特定の候補のために送信するトランスポートアドレス。
// ホスト候補、サーバー反射候補、ピア反射候補の場合、ベースはホスト候補と同じである。
// 中継候補の場合、ベースは中継候補と同じである
// （すなわち、TURNサーバーが送信元として使用するトランスポートアドレスである）

// Foundation。凍結アルゴリズムにおいて、
// 類似の候補をグループ化するために使用される任意の文字列です。
// タイプ、ベースIPアドレス、プロトコル（UDP、TCPなど）、
// STUNまたはTURNサーバーが同じである2つの候補で同じになります。
// これらのいずれかが異なる場合、基盤が異なることになる。

export type TransportType = "udp" | "tcp";
export type CandidateType = "host" | "srflx" | "prflx" | "relay";

export interface IceCandidate {
  address: Address;
  transport: TransportType;
  foundation: string;
  componentId: number;
  priority: number;
  type: CandidateType;
  relatedAddress?: Address;
}

export class IceCandidateImpl implements IceCandidate {
  address!: Address;
  transport!: TransportType;
  foundation!: string;
  componentId!: number;
  priority!: number;
  type!: CandidateType;
  relatedAddress?: Address;
  protocol!: StunAgent;

  constructor(props: IceCandidate & { protocol: StunAgent }) {
    Object.assign(this, props);
  }

  toJSON(): IceCandidate {
    return {
      address: this.address,
      transport: this.transport,
      foundation: this.foundation,
      componentId: this.componentId,
      priority: this.priority,
      type: this.type,
      relatedAddress: this.relatedAddress,
    };
  }
}

/**6.1.2.6. Computing Candidate Pair States */
export type IceCandidatePairState =
  | "waiting"
  | "inprogress"
  | "succeeded"
  | "failed"
  | "frozen";

export class IceCandidatePair {
  readonly localCandidate = this.props.local;
  readonly remoteCandidate = this.props.remote;
  readonly id =
    this.localCandidate.foundation + ":" + this.remoteCandidate.foundation;
  // The ICE agent initially places all candidate pairs in the Frozen state
  state: IceCandidatePairState = "frozen";
  readonly client: StunAgent = this.props.local.protocol;
  nominated = false;

  constructor(
    private props: {
      role: IceRole;
      local: IceCandidateImpl;
      remote: IceCandidate;
    }
  ) {}

  shouldPrune(pair: IceCandidatePair) {
    return (
      address2Str(pair.localCandidate.address) ===
        address2Str(this.localCandidate.address) &&
      address2Str(pair.remoteCandidate.address) ===
        address2Str(this.remoteCandidate.address)
    );
  }

  get candidatePairPriority() {
    const iceControlling = this.props.role === "controlling";
    const { local, remote } = this.props;

    const G = (iceControlling && local.priority) || remote.priority;
    const D = (iceControlling && remote.priority) || local.priority;
    return (2 ^ 32) * Math.min(G, D) + 2 * Math.max(G, D) + (G > D ? 1 : 0);
  }
}

/**5.3.  Exchanging Candidate Information */
export interface IceParameters {
  isLite: boolean;
  ConnectivityCheckPacingValue?: number;
  usernameFragment: string;
  password: string;
  extensions?: string[];
}

export function candidateFoundation(
  candidateType: CandidateType,
  candidateTransportType: TransportType,
  baseAddress: string
) {
  // """
  // See RFC 5245 - 4.1.1.3. Computing Foundations
  // """
  const key = `${candidateType}|${candidateTransportType}|${baseAddress}`;

  return createHash("md5").update(key, "ascii").digest("hex").slice(7);
}

export function candidatePriority(
  candidateType: CandidateType,
  localPref = 65535
) {
  // See RFC 5245 - 4.1.2.1. Recommended Formula
  let typePref = 0;
  if (candidateType === "host") {
    typePref = 126;
  } else if (candidateType === "prflx") {
    typePref = 110;
  } else if (candidateType === "srflx") {
    typePref = 100;
  } else {
    typePref = 0;
  }
  const candidateComponent = 1;
  return (
    (1 << 24) * typePref + (1 << 8) * localPref + (256 - candidateComponent)
  );
}
