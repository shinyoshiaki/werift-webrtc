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
import {
  CipherSuite,
  CipherSuites,
  HashAlgorithm,
  NamedCurveAlgorithm,
  NamedCurveAlgorithms,
  SignatureAlgorithm,
} from "../../cipher/const";
import { ContentType } from "../../record/const";
import { UseSRTP } from "../../handshake/extensions/useSrtp";
import { SrtpContext } from "../../context/srtp";
import debug from "debug";
import { ExtendedMasterSecret } from "../../handshake/extensions/extendedMasterSecret";

const log = debug("werift/dtls/flight/server/flight2");

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
          log("curves", curves);
          const curve = curves.find((curve) =>
            Object.values(NamedCurveAlgorithm).includes(curve as any)
          ) as NamedCurveAlgorithms;
          cipher.namedCurve = curve;
          log("curve selected", cipher.namedCurve);
        }
        break;
      case Signature.type:
        {
          const signatureHash = Signature.fromData(extension.data).data;
          log("hash,signature", signatureHash);
          const hash = signatureHash.find((v) =>
            Object.values(HashAlgorithm).includes(v.hash)
          )?.hash;
          const signature = signatureHash.find((v) =>
            Object.values(SignatureAlgorithm).includes(v.signature)
          )?.signature;
          if (hash == undefined || signature == undefined)
            throw new Error("invalid signatureHash");
          cipher.signatureHashAlgorithm = {
            hash: HashAlgorithm.sha256,
            signature: SignatureAlgorithm.rsa,
          }; // todo fix
          log("signatureHash selected", cipher.signatureHashAlgorithm);
        }
        break;
      case UseSRTP.type:
        {
          if (!dtls.options?.srtpProfiles) return;
          if (dtls.options.srtpProfiles.length === 0) return;

          const useSrtp = UseSRTP.fromData(extension.data);
          log("srtp profiles", useSrtp.profiles);
          const profile = SrtpContext.findMatchingSRTPProfile(
            useSrtp.profiles,
            dtls.options?.srtpProfiles
          );
          if (!profile) {
            throw new Error();
          }
          srtp.srtpProfile = profile;
          log("srtp profile selected", srtp.srtpProfile);
        }
        break;
      case ExtendedMasterSecret.type:
        {
          dtls.remoteExtendedMasterSecret = true;
        }
        break;
    }
  });

  cipher.localRandom = new DtlsRandom();
  cipher.remoteRandom = DtlsRandom.from(clientHello.random);

  const suites = clientHello.cipherSuites;
  const suite = suites.find((suite) =>
    Object.values(CipherSuite).includes(suite as any)
  ) as CipherSuites;
  if (!suite) throw new Error("dtls cipher suite negotiation failed");

  log("cipher suites", suites);
  cipher.cipherSuite = CipherSuite.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256; // todo fix
  log("cipher suite selected", cipher.cipherSuite);

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

  const buf = packets.map((v) => v.serialize());
  buf.forEach((v) => udp.send(v));
};
