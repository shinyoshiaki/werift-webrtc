import { Candidate } from "../candidate";
import { Message } from "../stun/stun";

export type Address = [string, number];

export type Protocol = {
  localCandidate?: Candidate;
  sentMessage?: Message;
  sendStun: (request: Message, addr: Address) => void;
  request: (
    message: Message,
    addr: Address,
    integrityKey?: Buffer,
    retransmissions?: any
  ) => Promise<[Message, Address]>;
  responseAddr?: Address;
  responseMessage?: string;
  close?: () => Promise<void>;
  sendData?: (data: Buffer, addr: Address) => Promise<void>;
};
