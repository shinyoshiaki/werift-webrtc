import { ClientHello } from "../../handshake/message/client/hello";
import { DtlsRandom } from "../../handshake/random";
import { createFragments, createPlaintext } from "../../record/builder";
import { TransportContext } from "../../context/transport";
import { DtlsContext } from "../../context/dtls";
import { EllipticCurves } from "../../handshake/extensions/ellipticCurves";
import { Signature } from "../../handshake/extensions/signature";
import { RecordContext } from "../../context/record";
import {
  SignatureAlgorithm,
  CipherSuite,
  HashAlgorithm,
  NamedCurveAlgorithm,
} from "../../cipher/const";
import { CipherContext } from "../../context/cipher";

export const flight1 = async (
  udp: TransportContext,
  dtls: DtlsContext,
  record: RecordContext,
  cipher: CipherContext
) => {
  const curve = EllipticCurves.createEmpty();
  curve.data = [
    NamedCurveAlgorithm.namedCurveX25519,
    NamedCurveAlgorithm.namedCurveP256,
  ];
  const signature = Signature.createEmpty();
  signature.data = [
    { hash: HashAlgorithm.sha256, signature: SignatureAlgorithm.ecdsa },
    { hash: HashAlgorithm.sha256, signature: SignatureAlgorithm.rsa },
  ];

  const hello = new ClientHello(
    { major: 255 - 1, minor: 255 - 2 },
    new DtlsRandom(),
    Buffer.from([]),
    Buffer.from([]),
    [
      CipherSuite.EcdheRsaWithAes128GcmSha256,
      CipherSuite.EcdheEcdsaWithAes128GcmSha256,
    ],
    [0], // don't compress
    [curve.extension, signature.extension]
  );

  const fragments = createFragments(dtls)([hello]);
  const packets = createPlaintext(dtls)(
    fragments,
    ++record.recordSequenceNumber
  );
  const buf = Buffer.concat(packets.map((v) => v.serialize()));
  udp.send(buf);

  dtls.version = hello.clientVersion;
  cipher.localRandom = DtlsRandom.from(hello.random);
};
