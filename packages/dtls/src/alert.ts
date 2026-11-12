import type { CipherContext } from "./context/cipher";
import type { DtlsContext } from "./context/dtls";
import { Alert } from "./handshake/message/alert";
import { createPlaintext } from "./record/builder";
import {
  AlertDesc,
  AlertLevel,
  alertDescName,
  ContentType,
} from "./record/const";

/**
 * DTLS 1.2 alert handling, kept apart from {@link DtlsSocket} so that a later
 * DTLS 1.3 implementation can replace the record encoding and the reaction to
 * each alert (RFC 5246 §7.2 / RFC 6347).
 */

/** A decoded alert (level and description as they were on the wire). */
export interface DtlsAlert {
  level: number;
  description: number;
}

/**
 * Error passed to `DtlsSocket.onError` when a connection ends with a fatal
 * alert.
 *
 * - `source: "remote"`: the peer sent the fatal alert.
 * - `source: "local"`: this side detected the error (for example
 *   `verifyRemoteCertificate` rejected the peer certificate, or the
 *   application called `sendAlert` with a fatal level) and sent the fatal
 *   alert to the peer.
 */
export class DtlsAlertError extends Error {
  readonly level: number;
  readonly description: number;
  /** AlertDesc member name, or undefined for an unknown description. */
  readonly alertDescName: string | undefined;
  readonly source: "local" | "remote";
  /** Local errors: what made this side abort (e.g. the verifier's exception). */
  readonly reason?: unknown;

  constructor(alert: DtlsAlert, source: "local" | "remote", reason?: unknown) {
    const name = alertDescName(alert.description);
    super(
      `dtls ${source === "remote" ? "received" : "sent"} ${
        alert.level === AlertLevel.fatal ? "fatal" : "warning"
      } alert: ${name ?? alert.description}`,
    );
    this.name = "DtlsAlertError";
    this.level = alert.level;
    this.description = alert.description;
    this.alertDescName = name;
    this.source = source;
    if (reason !== undefined) this.reason = reason;
  }
}

/**
 * Serialize an alert record protected with the current write epoch: plaintext
 * at epoch 0 (before ChangeCipherSpec), encrypted at epoch > 0. It shares the
 * epoch and the record sequence number with application data.
 */
export const createAlertRecord = (
  dtls: DtlsContext,
  cipher: CipherContext,
  alert: DtlsAlert,
) => {
  const [packet] = createPlaintext(dtls)(
    [
      {
        type: ContentType.alert,
        fragment: new Alert(alert.level, alert.description).serialize(),
      },
    ],
    ++dtls.recordSequenceNumber,
  );
  return dtls.epoch > 0
    ? cipher.encryptPacket(packet).serialize()
    : packet.serialize();
};

/**
 * What the receiver does with an alert (RFC 5246 §7.2.1 / §7.2.2).
 *
 * - `close`: close_notify (whatever its level). The connection is closed by
 *   the peer.
 * - `fatal`: any other alert with the fatal level. The connection is invalid.
 * - `ignore`: any other warning (user_canceled, no_renegotiation, ...).
 */
export const classifyAlert = (alert: DtlsAlert) => {
  if (alert.description === AlertDesc.CloseNotify) return "close" as const;
  if (alert.level === AlertLevel.fatal) return "fatal" as const;
  return "ignore" as const;
};
