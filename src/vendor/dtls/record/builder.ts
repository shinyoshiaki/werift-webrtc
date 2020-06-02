import { DtlsPlaintext } from "./message/plaintext";
import { DtlsContext } from "../context/dtls";
import { Handshake } from "../typings/domain";

export type Message = { type: number; fragment: Buffer };

export const createFragments = (client: DtlsContext) => (
  handshakes: Handshake[]
) => {
  client.lastFlight = handshakes;

  return handshakes
    .map((handshake) => {
      handshake.messageSeq = client.sequenceNumber++;
      const fragment = handshake.toFragment();
      const fragments = fragment.chunk();
      return fragments;
    })
    .flatMap((v) => v);
};

export const createPlaintext = (client: DtlsContext) => (
  fragments: Message[],
  recordSequenceNumber: number
) => {
  return fragments.map((msg) => {
    const plaintext = new DtlsPlaintext(
      {
        contentType: msg.type,
        protocolVersion: client.version,
        epoch: client.epoch,
        sequenceNumber: recordSequenceNumber,
        contentLen: msg.fragment.length,
      },
      msg.fragment
    );
    return plaintext;
  });
};
