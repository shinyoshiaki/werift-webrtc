import { type Candidate, candidatePriority } from "../candidate";
import type { TransactionError } from "../exceptions";
import { classes, type MessageIntegrityMode, methods } from "../stun/const";
import { Message } from "../stun/message";

/** STUN helpers of the connectivity checks (RFC 8445 §7.2, §7.3). */

/**
 * Integrity attribute of a response to `request` (RFC 8489 §9.1.3): a request
 * carrying MESSAGE-INTEGRITY-SHA256 is answered with MESSAGE-INTEGRITY-SHA256,
 * any other with MESSAGE-INTEGRITY.
 */
export const responseIntegrityMode = (
  request: Message,
): MessageIntegrityMode =>
  request.integrityAlgorithm === "sha256" ? "sha256" : "sha1";

export const encodeTxUsername = ({
  remoteUsername,
  localUsername,
}: {
  remoteUsername: string;
  localUsername: string;
}) => {
  return `${remoteUsername}:${localUsername}`;
};

export const decodeTxUsername = (txUsername: string) => {
  const [remoteUsername, localUsername] = txUsername.split(":");
  return { remoteUsername, localUsername };
};

/** The peer answered with 487 (Role Conflict). */
export const isRoleConflict = (error: unknown) =>
  (error as TransactionError | undefined)?.response?.getAttributeValue(
    "ERROR-CODE",
  )?.[0] === 487;

/**
 * The nomination a peer's check carries: the NOMINATION value
 * (renomination), else 1 for USE-CANDIDATE, else 0. A NOMINATION of 0 is
 * invalid and nominates nothing (as in libwebrtc).
 */
export const receivedNomination = (message: Message) => {
  if (message.attributesKeys.includes("NOMINATION")) {
    const value = message.getAttributeValue("NOMINATION");
    return typeof value === "number" && value > 0 ? value : 0;
  }
  return message.attributesKeys.includes("USE-CANDIDATE") ? 1 : 0;
};

export type CheckRequestParams = {
  /** USE-CANDIDATE (controlling only). */
  nominate: boolean;
  /** Renomination: the NOMINATION value to send (controlling only). */
  nomination?: number;
  remoteUsername: string;
  localUsername: string;
  iceControlling: boolean;
  /** The local candidate of the pair: the PRIORITY of a peer-reflexive one. */
  localCandidate?: Candidate;
  /** ICE-CONTROLLING / ICE-CONTROLLED tie-breaker of the agent. */
  tieBreaker: bigint;
};

/** A connectivity check (RFC 8445 §7.2.2): a Binding request of the agent. */
export const buildCheckRequest = ({
  nominate,
  nomination,
  remoteUsername,
  localUsername,
  iceControlling,
  localCandidate,
  tieBreaker,
}: CheckRequestParams) => {
  const txUsername = encodeTxUsername({ remoteUsername, localUsername });
  const request = new Message(methods.BINDING, classes.REQUEST);
  request.setAttribute("USERNAME", txUsername).setAttribute(
    "PRIORITY",
    candidatePriority("prflx", {
      transport: localCandidate?.transport,
      tcptype: localCandidate?.tcptype,
    }),
  );
  if (iceControlling) {
    request.setAttribute("ICE-CONTROLLING", tieBreaker);
    if (nominate) {
      request.setAttribute("USE-CANDIDATE", null);
    }
    if (nomination !== undefined) {
      request.setAttribute("NOMINATION", nomination);
    }
  } else {
    request.setAttribute("ICE-CONTROLLED", tieBreaker);
  }
  return request;
};
