import { DtlsContext } from "../context/dtls";
import { Handshake } from "../typings/domain";
import { DtlsPlaintext } from "./message/plaintext";

export type Message = { type: number; fragment: Buffer };

export const createFragments =
  (dtls: DtlsContext) => (handshakes: Handshake[]) => {
    dtls.lastFlight = handshakes;

    return handshakes
      .map((handshake) => {
        handshake.messageSeq = dtls.sequenceNumber++;
        const fragment = handshake.toFragment();
        const fragments = fragment.chunk();
        return fragments;
      })
      .flatMap((v) => v);
  };

export const createPlaintext =
  (dtls: DtlsContext) =>
  (fragments: Message[], recordSequenceNumber: number) => {
    return fragments.map((msg) => {
      const plaintext = new DtlsPlaintext(
        {
          contentType: msg.type,
          protocolVersion: dtls.version,
          epoch: dtls.epoch,
          sequenceNumber: recordSequenceNumber,
          contentLen: msg.fragment.length,
        },
        msg.fragment,
      );
      return plaintext;
    });
  };
