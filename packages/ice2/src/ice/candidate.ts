import { createHash } from "crypto";
import { Address } from "../model";
import { StunAgent } from "../stun/agent";

export type TransportType = "udp" | "tcp";
export type CandidateType = "host" | "srflx" | "prflx" | "relay";

export class IceCandidate {
  address!: Address;
  transport!: TransportType;
  foundation!: string;
  componentId!: number;
  priority!: number;
  type!: CandidateType;
  relatedAddress?: Address;
  protocol!: StunAgent;

  constructor(props: IceCandidate) {
    Object.assign(this, props);
  }
}

export class IceCandidateInfo {
  candidates: IceCandidate[] = [];
  isFull = true;
  usernameFragment!: string;
  password!: string;
}

export function candidateFoundation(
  candidateType: CandidateType,
  candidateTransport: string,
  baseAddress: string
) {
  // """
  // See RFC 5245 - 4.1.1.3. Computing Foundations
  // """
  const key = `${candidateType}|${candidateTransport}|${baseAddress}`;

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
