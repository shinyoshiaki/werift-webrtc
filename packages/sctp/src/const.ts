/**
 * @enum
 */
export const WEBRTC_PPID = {
  DCEP: 50,
  STRING: 51,
  BINARY: 53,
  STRING_EMPTY: 56,
  BINARY_EMPTY: 57,
} as const;
export type WEBRTC_PPID = (typeof WEBRTC_PPID)[keyof typeof WEBRTC_PPID];

/**
 * @enum
 */
export const SCTP_STATE = {
  CLOSED: 1,
  COOKIE_WAIT: 2,
  COOKIE_ECHOED: 3,
  ESTABLISHED: 4,
  SHUTDOWN_PENDING: 5,
  SHUTDOWN_SENT: 6,
  SHUTDOWN_RECEIVED: 7,
  SHUTDOWN_ACK_SENT: 8,
} as const;
export type SCTP_STATE = (typeof SCTP_STATE)[keyof typeof SCTP_STATE];
