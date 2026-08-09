import { UdpTransport } from "../../common/src";
import type { SrtpProfile } from "../../rtp/src/srtp/const";
import { DtlsClient, DtlsServer, DtlsVersion } from "../src";

export const certPem = `-----BEGIN CERTIFICATE-----
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

export const keyPem = `-----BEGIN PRIVATE KEY-----
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


/** P-256 ECDSA server/client certificate (self-signed) for CertificateVerify E2E. */
export const ecdsaP256CertPem = `-----BEGIN CERTIFICATE-----
MIIBgTCCASegAwIBAgIUWPl9ezaAwooN0W/noF6nMqO27+UwCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLd2VyaWZ0LXAyNTYwHhcNMjYwODA5MDY0NzUxWhcNMzYwODA2
MDY0NzUxWjAWMRQwEgYDVQQDDAt3ZXJpZnQtcDI1NjBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABHlUI1X8d3RCb9d7LO1e+XhQWCkPfiIv0UPVtjiWWce3qviPLrlz
3W0KhJ3dN2QM2bCHtpaIq0W4ElQ1BceywKmjUzBRMB0GA1UdDgQWBBSg3E14VfdS
7jurKvZOT2XPzGnoXDAfBgNVHSMEGDAWgBSg3E14VfdS7jurKvZOT2XPzGnoXDAP
BgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIQCe3OhPB504FbF9OnP2
Z6tBZslb1Ns5zweEKJ9pxERCrAIgC8fWPv+znOXnm7zr3/yQcPZsEG4OOBz0Q8SU
n8Oal40=
-----END CERTIFICATE-----
`;

export const ecdsaP256KeyPem = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgge5orEw2sT5d8HA5
NnKAgw1SjU1EaS/sHrQ6RXEiuSKhRANCAAR5VCNV/Hd0Qm/XeyztXvl4UFgpD34i
L9FD1bY4llnHt6r4jy65c91tCoSd3TdkDNmwh7aWiKtFuBJUNQXHssCp
-----END PRIVATE KEY-----
`;

/** P-384 ECDSA key material — must fail ecdsa_secp256r1_sha256 negotiation. */
export const ecdsaP384CertPem = `-----BEGIN CERTIFICATE-----
MIIBvzCCAUSgAwIBAgIUDHFqVeDzyukj2QfNsPAKpLfoPLAwCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLd2VyaWZ0LXAzODQwHhcNMjYwODA5MDY0NzUxWhcNMzYwODA2
MDY0NzUxWjAWMRQwEgYDVQQDDAt3ZXJpZnQtcDM4NDB2MBAGByqGSM49AgEGBSuB
BAAiA2IABDgJ0Eblp++FJHgz0Pnli6B+uEnag1DHDXjgRa3iueDiUDhAI1Br4dKe
QVbHDLMmZ3jhIQ4E7UvitkC3BWk5sCCrytT5wD0N7K9vgFNgY7SCsm3N+VPrIyId
EwRxGLIVWaNTMFEwHQYDVR0OBBYEFHN3qcdjB7USDsqqLpd/7lw4RCfgMB8GA1Ud
IwQYMBaAFHN3qcdjB7USDsqqLpd/7lw4RCfgMA8GA1UdEwEB/wQFMAMBAf8wCgYI
KoZIzj0EAwIDaQAwZgIxAKgfPBYQMThxostuFLyMRb2cS+RYYxenD3UmFlDb7AtK
EmXrhKnqVxdr7mMWhKQ8wQIxAOenBxVQXDy15Eed0qPdHAFBA3Zry3HEAdM/6qiu
gEHcxlZDaPb4GtYJpYF/g4n5Ww==
-----END CERTIFICATE-----
`;

export const ecdsaP384KeyPem = `-----BEGIN PRIVATE KEY-----
MIG2AgEAMBAGByqGSM49AgEGBSuBBAAiBIGeMIGbAgEBBDDwZmwePe2VWRsDzwS+
YqjsjnVJmEhmjrKofYbJtv8dISDBx6EYAvp2fF79zjuJ86mhZANiAAQ4CdBG5afv
hSR4M9D55YugfrhJ2oNQxw144EWt4rng4lA4QCNQa+HSnkFWxwyzJmd44SEOBO1L
4rZAtwVpObAgq8rU+cA9Deyvb4BTYGO0grJtzflT6yMiHRMEcRiyFVk=
-----END PRIVATE KEY-----
`;

/** Shared Arrange options for DTLS 1.3 self E2E pairs. */
export type Dtls13PairExtra = {
  certificateRequest?: boolean;
  addressValidation?: "dtls-cookie" | "ice-authenticated" | "none";
  srtpProfiles?: SrtpProfile[];
};

/**
 * Arrange: UDP-linked DtlsServer / DtlsClient for 1.3 self tests.
 * Prefer this over duplicating transport setup across e2e files.
 */
export async function arrangeDtls13Pair(extra?: Dtls13PairExtra) {
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;
  const base = {
    cert: certPem,
    key: keyPem,
    protocolVersions: [DtlsVersion.V1_3] as const,
    addressValidation: "none" as const,
    ...extra,
  };
  const server = new DtlsServer({ transport: serverTransport, ...base });
  const client = new DtlsClient({ transport: clientTransport, ...base });
  return { server, client, serverTransport, clientTransport };
}
