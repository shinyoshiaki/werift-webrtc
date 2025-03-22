import type { Candidate } from "../candidate";
import type { Address, Event } from "../imports/common";
import type { Message } from "../stun/message";

export interface Protocol {
  type: string;
  onRequestReceived: Event<[Message, Address, Buffer]>;
  onDataReceived: Event<[Buffer]>;
  request: (
    message: Message,
    addr: Address,
    integrityKey?: Buffer,
    retransmissions?: any,
  ) => Promise<[Message, Address]>;
  close: () => Promise<void>;
  connectionMade: (...args: any) => Promise<void>;
  sendStun: (message: Message, addr: Address) => Promise<void>;
  sendData: (data: Buffer, addr: Address) => Promise<void>;
  localCandidate?: Candidate;
  sentMessage?: Message;
  responseAddr?: Address;
  responseMessage?: string;
  localIp?: string;
}
