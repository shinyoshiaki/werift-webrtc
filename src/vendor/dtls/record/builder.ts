import { ContentType } from "./const";
import { DtlsPlaintext } from "./message/plaintext";
import { DtlsContext } from "../context/dtls";
import { Handshake } from "../typings/domain";

export type Fragment = { type: number; fragment: Buffer };

export const createFragments = (client: DtlsContext) => (
  handshakes: Handshake[]
) => {
  client.lastFlight = handshakes;

  return handshakes
    .map((handshake) => {
      handshake.messageSeq = client.sequenceNumber++;
      const fragment = handshake.toFragment();
      const fragments = fragment.chunk().map((f) => ({
        type: ContentType.handshake,
        fragment: f.serialize(),
      }));
      return fragments;
    })
    .flatMap((v) => v);
};

export const createPlaintext = (client: DtlsContext) => (
  fragments: Fragment[],
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
