import { Candidate } from "../candidate";
import { Message } from "../stun/message";

export type Address = Readonly<[string, number]>;

export interface Protocol {
  type: string;
  localCandidate: Candidate;
  sentMessage?: Message;
  request: (
    message: Message,
    addr: Address,
    integrityKey?: Buffer,
    retransmissions?: any
  ) => Promise<[Message, Address]>;
  responseAddr?: Address;
  responseMessage?: string;
  close?: () => Promise<void>;
  connectionMade: (...args: any) => Promise<void>;
  sendStun: (message: Message, addr: Address) => void;
  sendData: (data: Buffer, addr: Address) => Promise<void>;
}
