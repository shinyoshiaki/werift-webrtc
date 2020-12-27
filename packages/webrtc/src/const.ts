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

export const DISCARD_HOST = "0.0.0.0";
export const DISCARD_PORT = 9;
export const MEDIA_KINDS = ["audio", "video"];

export const DIRECTIONS = ["inactive", "sendonly", "recvonly", "sendrecv"];
export const DTLS_ROLE_SETUP = {
  auto: "actpass",
  client: "active",
  server: "passive",
};
export const DTLS_SETUP_ROLE = Object.keys(DTLS_ROLE_SETUP).reduce(
  (acc, cur) => {
    const key = (DTLS_ROLE_SETUP as any)[cur];
    acc[key] = cur;
    return acc;
  },
  {} as any
);
export const FMTP_INT_PARAMETERS = [
  "apt",
  "max-fr",
  "max-fs",
  "maxplaybackrate",
  "minptime",
  "stereo",
  "useinbandfec",
];

export const SSRC_INFO_ATTRS = ["cname", "msid", "mslabel", "label"];

export enum SRTP_PROFILE {
  SRTP_AES128_CM_HMAC_SHA1_80 = 1,
}

export const defaultPrivateKey = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCsUhdMfiOlixc5
N/GoJTY3o7seKd4mT9RdHQ3lOF/Xl8kLb3FSGztWGcklY0MahMKf5s9rgNh7kMOn
3pcfy37KPjOBzgem1Kd7cU0cFjK0W9g8/ctqqUEqy4Ghbq8JSYZgIQABjFqQDJLE
J/BLqrzD9r8v2p1I3RhoiV2+GpGlx5ZFfUsSoK3d5f6nYNmry70aD2i632kBTiDl
aSZcOEka/uiR6RnaW+aCaTuliob6q0MKD2r6/9jlsGyHcwzDBm/gFD7j6JZyoETM
utZ76CrhnDpxWzTrK2dbGgFNPETZV5clm3bmXa2jhCX566UPszYoAI9xHheh5+Ei
OXX/DiSpAgMBAAECggEAbFERmiBz8bvzdiEHQuVZJjJCDVzN6hEl8P2xXVNJU3By
jECZ372EV8PPnzO82292EyL3YKDV8x31DpEpN3Anm6Lrp31FbAWh3UND8BK3/oz4
6KWzdrE7aFYRftLfLZxM3iIAKfj6eC+fFbPxJO8GxrtURBVL5qArlpI6HaP/x08c
ovRF7HBCRIBUHpqmkYBOT1hzj+XT/1IfMRTb2XUKUJOVGYZ6GkG4OuQV7U61LJW9
GniuYOlw9SIMgsiMYv+7iwLEgLU4DxCP+3Qmw2N9hzQsNBtvJRmAXUfxE+5bVslM
LgKq+Pw6zFyS70fWXsnFQ+dKjYTXuvJz1DD9pj1MnQKBgQDY/2qw+58j6OQ85Ilh
y9I+T+zZfHvtQfutWQ0A5fRrOlL3Bk5v9q061PXPokpFom8DVkOzGUxnBuloWZyc
MNcgnW/PhsUiXQfKiZtaZQUyijI2ujOHu358xmNbiQkrS2IqEiZQlGTMQsjdqTu1
CgeIWGZ4a0WMwHOp0qyPt8SSTwKBgQDLSvnxs5Z3sDkHlf6BdnMWGtkxjD7oCaHq
0BCfsjpfYxFjd0+MAzCtjOxKxqN23F2FuwF5K0LkMSYGAdIxvAAaIRbRvXzJQA3s
Fxy2NwzsdI+u8AZUKZM98p3WboajOeyiC5D73a6O4owFQc/AQTpg728+0hi3bSns
yMfuOzzzhwKBgCmgdbsVyeV9m6sCvEgCbYZ+lpTyCGPvMHSEjLYLZuPbAGda0lkw
HPMYPz9hhpXtHxaoybvlsn5hGQ1ng1+DDwG2sehBljeNWR1FYIPqtSCI2jEdbx0u
nokZFZ5Nn3CquV4QtUDn9p4ogZfkCwwjrGY/bwjSqzjhAk8lluzK9+6JAoGBAJ4e
fPWv91K0sEbkNYZAuRbyXwiYyrzz8QqQNr3fhGN4zKeOv0JpoMz8FTW79pyWne9M
GsNCEM8oIyj89Z5VWcb5AaS1O3/U4H9HIr/fZZ/ssW0hp+qCQ9IlCPsmEHaYsSMA
2A3uyLy+HKZiH9KraVrIIMC97ReOQtO2/zqevLO1AoGAImV+zywDZEzCRckhaKPB
zZn2vq3xNVGjFU8uEQao+bFauDTlfg6ER9YXrKSZi0LZnO7ceyIrRbAJad9jmhJf
v5/QTK1BlvJ52UxGn2C+SQVK7ZLO5U+lnrLJ8DmW4z7/hmK+VK7g27GxIbqVn75v
MRWZMFdB3hM1ZJ3myUyE8qw=
-----END PRIVATE KEY-----
`;

export const defaultCertificate = `-----BEGIN CERTIFICATE-----
MIIDETCCAfkCFEtWAs2R7xuwFvkze6b7C0mNodXKMA0GCSqGSIb3DQEBCwUAMEUx
CzAJBgNVBAYTAkFVMRMwEQYDVQQIDApTb21lLVN0YXRlMSEwHwYDVQQKDBhJbnRl
cm5ldCBXaWRnaXRzIFB0eSBMdGQwHhcNMjAwNTE3MDQxMTIwWhcNMzAwNTE1MDQx
MTIwWjBFMQswCQYDVQQGEwJBVTETMBEGA1UECAwKU29tZS1TdGF0ZTEhMB8GA1UE
CgwYSW50ZXJuZXQgV2lkZ2l0cyBQdHkgTHRkMIIBIjANBgkqhkiG9w0BAQEFAAOC
AQ8AMIIBCgKCAQEArFIXTH4jpYsXOTfxqCU2N6O7HineJk/UXR0N5Thf15fJC29x
Uhs7VhnJJWNDGoTCn+bPa4DYe5DDp96XH8t+yj4zgc4HptSne3FNHBYytFvYPP3L
aqlBKsuBoW6vCUmGYCEAAYxakAySxCfwS6q8w/a/L9qdSN0YaIldvhqRpceWRX1L
EqCt3eX+p2DZq8u9Gg9out9pAU4g5WkmXDhJGv7okekZ2lvmgmk7pYqG+qtDCg9q
+v/Y5bBsh3MMwwZv4BQ+4+iWcqBEzLrWe+gq4Zw6cVs06ytnWxoBTTxE2VeXJZt2
5l2to4Ql+eulD7M2KACPcR4XoefhIjl1/w4kqQIDAQABMA0GCSqGSIb3DQEBCwUA
A4IBAQBK3tyv1r3mMBxgHb3chNDtoqcdMQH4eznLQwKKvD/N6FLpDIoRL8BBShFa
v5P+MWpsAzn9PpMxDLIJlzmJKcgxh/dA+CC8rj5Zdiyepzs8V5jMz9lL5htJeN/b
nGn2BjuUqyzwlIKmiQADnhYxcD7gOJzfnXGrYPxnQoRujocnSrrgPyYfS08bDaP8
lnEvp3yUlo4uRDqs24V+SdDfOSBGaSAlMjtugHc/GAN2jE1IOLbWGv2XJm0FL5IT
B8GwHtA40Ar2XRQJdJhGkoMARqcOPbXKLy3EOUEMHbNAvwu+smqqn22zC0btKP39
AtQOdUkFbpbYBfEjOzp2AtgUk1W+
-----END CERTIFICATE-----
`;
