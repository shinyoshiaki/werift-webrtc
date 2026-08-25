import { type Address, Event } from "../../../common/src";
import { Candidate } from "../../src/candidate";
import type { Message } from "../../src/stun/message";
import type { Protocol } from "../../src/types/model";

/** Shared Arrange: host UDP protocol for SPED decorate / datagram tests. */
export class SpedProtocolMock implements Protocol {
  type = "mock";
  onRequestReceived: Event<[Message, Address, Buffer]> = new Event();
  onDataReceived: Event<[Buffer, Address?]> = new Event();
  localCandidate = new Candidate(
    "some-foundation",
    1,
    "udp",
    20,
    "1.2.3.4",
    1234,
    "host",
  );
  sentMessage?: Message;
  request = async () => null as any;
  sendStun = async (message: Message) => {
    this.sentMessage = message;
  };
  async connectionMade() {}
  async sendData(_data: Buffer, _addr?: Address) {}
  async close() {}
}
