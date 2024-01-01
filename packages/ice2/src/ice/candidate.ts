import { Address } from "../model";

export type TransportType = 4 | 6;

export class IceCandidate {
  address!: Address;
  transport!: TransportType;
  foundation!: string;
  componentId!: string;
  priority!: number;
  type!: unknown;
  relatedAddress!: Address;
}

export class IceCandidateInfo {
  candidates: IceCandidate[] = [];
  isFull = true;
  usernameFragment!: string;
  password!: string;
}
