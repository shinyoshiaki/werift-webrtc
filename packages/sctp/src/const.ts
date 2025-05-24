// # local constants
export const COOKIE_LENGTH = 24;
export const COOKIE_LIFETIME = 60;
export const MAX_STREAMS = 65535;
export const USERDATA_MAX_LENGTH = 1200;

// # protocol constants
export const SCTP_DATA_LAST_FRAG = 0x01;
export const SCTP_DATA_FIRST_FRAG = 0x02;
export const SCTP_DATA_UNORDERED = 0x04;

export const SCTP_MAX_ASSOCIATION_RETRANS = 10;
export const SCTP_MAX_INIT_RETRANS = 8;
export const SCTP_RTO_ALPHA = 1 / 8;
export const SCTP_RTO_BETA = 1 / 4;
export const SCTP_RTO_INITIAL = 3;
export const SCTP_RTO_MIN = 1;
export const SCTP_RTO_MAX = 60;
export const SCTP_TSN_MODULO = 2 ** 32;

export const RECONFIG_MAX_STREAMS = 135;

// # parameters
export const SCTP_STATE_COOKIE = 0x0007;
export const SCTP_SUPPORTED_CHUNK_EXT = 0x8008; //32778
export const SCTP_PRSCTP_SUPPORTED = 0xc000; //49152

export enum WEBRTC_PPID {
  DCEP = 50,
  STRING = 51,
  BINARY = 53,
  STRING_EMPTY = 56,
  BINARY_EMPTY = 57,
}

export enum SCTP_STATE {
  CLOSED = 1,
  COOKIE_WAIT = 2,
  COOKIE_ECHOED = 3,
  ESTABLISHED = 4,
  SHUTDOWN_PENDING = 5,
  SHUTDOWN_SENT = 6,
  SHUTDOWN_RECEIVED = 7,
  SHUTDOWN_ACK_SENT = 8,
}
