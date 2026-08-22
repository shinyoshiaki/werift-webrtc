import type { CipherContext } from "../context/cipher";
import type { DtlsContext } from "../context/dtls";
import { Alert } from "../handshake/message/alert";
import { debug } from "../imports/common";
import { AlertDesc, ContentType } from "./const";
import { FragmentedHandshake } from "./message/fragment";
import { DtlsPlaintext } from "./message/plaintext";

const log = debug("werift-dtls : packages/dtls/record/receive.ts : log");
const err = debug("werift-dtls : packages/dtls/record/receive.ts : err");

export const parsePacket = (data: Buffer) => {
  let start = 0;
  const packets: DtlsPlaintext[] = [];
  while (data.length > start) {
    const fragmentLength = data.readUInt16BE(start + 11);
    if (data.length < start + (12 + fragmentLength)) {
      break;
    }
    const packet = DtlsPlaintext.deSerialize(data.subarray(start));
    packets.push(packet);

    start += 13 + fragmentLength;
  }

  return packets;
};

export const parsePlainText =
  (dtls: DtlsContext, cipher: CipherContext) =>
  (
    plain: DtlsPlaintext,
  ): {
    type: ContentType;
    data: any;
  }[] => {
    const contentType = plain.recordLayerHeader.contentType;

    switch (contentType) {
      case ContentType.changeCipherSpec: {
        log(dtls.sessionId, "change cipher spec");
        return [
          {
            type: ContentType.changeCipherSpec,
            data: undefined,
          },
        ];
      }
      case ContentType.handshake: {
        let raw = plain.fragment;
        try {
          if (plain.recordLayerHeader.epoch > 0) {
            log(dtls.sessionId, "decrypt handshake");
            raw = cipher.decryptPacket(plain);
          }
        } catch (error) {
          err(dtls.sessionId, "decrypt failed", error);
          throw error;
        }
        try {
          let start = 0;
          const handshakes: { type: ContentType; data: any }[] = [];
          while (raw.length > start) {
            const handshake = FragmentedHandshake.deSerialize(
              raw.subarray(start),
            );
            handshakes.push({ type: ContentType.handshake, data: handshake });
            start += handshake.fragment_length + 12;
          }

          return handshakes;
        } catch (error) {
          err(dtls.sessionId, "decSerialize failed", error, raw);
          throw error;
        }
      }
      case ContentType.applicationData: {
        return [
          {
            type: ContentType.applicationData,
            data: cipher.decryptPacket(plain),
          },
        ];
      }
      case ContentType.alert: {
        // After local epoch advances, epoch>0 alerts must AEAD-verify.
        // Before keys (local epoch 0): epoch>0 may still be structural
        // (dual probing distinguishes epoch-0 vs epoch≥1 suppress filters);
        // post-handshake lifecycle ignores unauthenticated epoch-0 at socket.
        let alert: Alert;
        if (plain.recordLayerHeader.epoch > 0 && dtls.epoch > 0) {
          const dec = cipher.decryptPacket(plain);
          alert = Alert.deSerialize(dec);
        } else if (plain.recordLayerHeader.epoch > 0 && dtls.epoch === 0) {
          try {
            const dec = cipher.decryptPacket(plain);
            alert = Alert.deSerialize(dec);
          } catch {
            // No read keys yet — structural parse for HS-time dual demux only.
            alert = Alert.deSerialize(plain.fragment);
          }
        } else {
          alert = Alert.deSerialize(plain.fragment);
        }
        err(
          dtls.sessionId,
          "ContentType.alert",
          alert,
          AlertDesc[alert.description],
          "flight",
          dtls.flight,
          "lastFlight",
          dtls.lastFlight,
        );
        // Surface alert to socket (protocol_version / fatal) instead of
        // throwing here — throw was only logged and left Flight retransmitting.
        return [{ type: ContentType.alert, data: alert }];
      }
      default: {
        return [{ type: ContentType.alert, data: undefined }];
      }
    }
  };
