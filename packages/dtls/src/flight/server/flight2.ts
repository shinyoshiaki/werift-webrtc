import { ClientHello } from "../../handshake/message/client/hello";
import { DtlsRandom } from "../../handshake/random";
import { createFragments, createPlaintext } from "../../record/builder";
import { TransportContext } from "../../context/transport";
import { DtlsContext } from "../../context/dtls";
import { EllipticCurves } from "../../handshake/extensions/ellipticCurves";
import { Signature } from "../../handshake/extensions/signature";
import { generateKeyPair } from "../../cipher/namedCurve";
import { CipherContext } from "../../context/cipher";
import { ServerHelloVerifyRequest } from "../../handshake/message/server/helloVerifyRequest";
import { randomBytes } from "crypto";
import { CipherSuite, NamedCurveAlgorithm } from "../../cipher/const";
import { ContentType } from "../../record/const";
import { UseSRTP } from "../../handshake/extensions/useSrtp";
import { SrtpContext } from "../../context/srtp";

// HelloVerifyRequest do not retransmit

export const flight2 = (
  udp: TransportContext,
  dtls: DtlsContext,
  cipher: CipherContext,
  srtp: SrtpContext
) => (clientHello: ClientHello) => {
  dtls.flight = 2;

  clientHello.extensions.forEach((extension) => {
    switch (extension.type) {
      case EllipticCurves.type:
        {
          const curves = EllipticCurves.fromData(extension.data).data;
          if (!curves.includes(NamedCurveAlgorithm.namedCurveX25519))
            throw new Error();
          cipher.namedCurve = NamedCurveAlgorithm.namedCurveX25519;
        }
        break;
      case Signature.type:
        {
          const signature = Signature.fromData(extension.data).data;
        }
        break;
      case UseSRTP.type:
        {
          if (!dtls.options?.srtpProfiles) return;
          if (dtls.options.srtpProfiles.length === 0) return;

          const useSrtp = UseSRTP.fromData(extension.data);
          const profile = SrtpContext.findMatchingSRTPProfile(
            useSrtp.profiles,
            dtls.options?.srtpProfiles
          );
          if (!profile) {
            throw new Error();
          }
          srtp.srtpProfile = profile;
        }
        break;
    }
  });
  cipher.localRandom = new DtlsRandom();
  cipher.remoteRandom = DtlsRandom.from(clientHello.random);
  cipher.cipherSuite = CipherSuite.EcdheRsaWithAes128GcmSha256;
  cipher.localKeyPair = generateKeyPair(cipher.namedCurve!);

  dtls.cookie = randomBytes(20);
  const helloVerifyReq = new ServerHelloVerifyRequest(
    {
      major: 255 - 1,
      minor: 255 - 2,
    },
    dtls.cookie
  );
  const fragments = createFragments(dtls)([helloVerifyReq]);
  const packets = createPlaintext(dtls)(
    fragments.map((fragment) => ({
      type: ContentType.handshake,
      fragment: fragment.serialize(),
    })),
    ++dtls.recordSequenceNumber
  );
  const buf = Buffer.concat(packets.map((v) => v.serialize()));
  udp.send(buf);
};
