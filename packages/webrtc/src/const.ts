import { HashAlgorithms, SignatureAlgorithm } from '../../dtls/src/cipher/const';
import {
  ProtectionProfileAeadAes128Gcm,
  ProtectionProfileAes128CmHmacSha1_80,
} from '../../dtls/src/context/srtp';
import { DtlsRole } from './transport/dtls';

// data channel export constants
export const DATA_CHANNEL_ACK = 2;
export const DATA_CHANNEL_OPEN = 3;

// 5.1.  DATA_CHANNEL_OPEN Message
export const DATA_CHANNEL_RELIABLE = 0x00;
export const DATA_CHANNEL_PARTIAL_RELIABLE_REXMIT = 0x01;
export const DATA_CHANNEL_PARTIAL_RELIABLE_TIMED = 0x02;
export const DATA_CHANNEL_RELIABLE_UNORDERED = 0x80;
export const DATA_CHANNEL_PARTIAL_RELIABLE_REXMIT_UNORDERED = 0x81;
export const DATA_CHANNEL_PARTIAL_RELIABLE_TIMED_UNORDERED = 0x82;

export const WEBRTC_DCEP = 50;
export const WEBRTC_STRING = 51;
export const WEBRTC_BINARY = 53;
export const WEBRTC_STRING_EMPTY = 56;
export const WEBRTC_BINARY_EMPTY = 57;

export const DISCARD_HOST = '0.0.0.0';
export const DISCARD_PORT = 9;
export const MEDIA_KINDS = ['audio', 'video'];

export const DIRECTIONS = ['inactive', 'sendonly', 'recvonly', 'sendrecv'];
export const DTLS_ROLE_SETUP = {
  auto: 'actpass',
  client: 'active',
  server: 'passive',
};
export const DTLS_SETUP_ROLE: { [key: string]: DtlsRole } = Object.keys(DTLS_ROLE_SETUP).reduce(
  (acc, cur) => {
    const key = (DTLS_ROLE_SETUP as any)[cur];
    acc[key] = cur;
    return acc;
  },
  {} as any
);
export const FMTP_INT_PARAMETERS = [
  'apt',
  'max-fr',
  'max-fs',
  'maxplaybackrate',
  'minptime',
  'stereo',
  'useinbandfec',
];

export const SSRC_INFO_ATTRS = ['cname', 'msid', 'mslabel', 'label'];

export const SRTP_PROFILE = {
  SRTP_AES128_CM_HMAC_SHA1_80: ProtectionProfileAes128CmHmacSha1_80,
  SRTP_AEAD_AES_128_GCM: ProtectionProfileAeadAes128Gcm,
} as const;

export const SenderDirections = ['sendonly', 'sendrecv'];
export const NotSenderDirections = ['inactive', 'recvonly'];

export { HashAlgorithms, SignatureAlgorithm };
