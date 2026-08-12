import {
  CipherSuite,
  NamedCurveAlgorithmList,
  type NamedCurveAlgorithms,
  SignatureAlgorithm,
} from "../../cipher/const";
import { generateKeyPair } from "../../cipher/namedCurve";
import type { CipherContext } from "../../context/cipher";
import type { DtlsContext } from "../../context/dtls";
import { SrtpContext } from "../../context/srtp";
import { EllipticCurves } from "../../handshake/extensions/ellipticCurves";
import { ExtendedMasterSecret } from "../../handshake/extensions/extendedMasterSecret";
import { RenegotiationIndication } from "../../handshake/extensions/renegotiationIndication";
import { Signature } from "../../handshake/extensions/signature";
import { UseSRTP } from "../../handshake/extensions/useSrtp";
import type { ClientHello } from "../../handshake/message/client/hello";
import { DtlsRandom } from "../../handshake/random";
import { type SrtpProfile, debug } from "../../imports/rtp";

const log = debug(
  "werift-dtls : packages/dtls/flight/server/commitClientHello.ts : log",
);

/**
 * Commit ClientHello parameters into association cipher/srtp/dtls state.
 *
 * Call only after DTLS 1.2 HelloVerify cookie verification (return-routability).
 * Pre-cookie CH1 must not invoke this — concurrent peers would poison state.
 */
export function commitClientHelloToAssociation(
  clientHello: ClientHello,
  dtls: DtlsContext,
  cipher: CipherContext,
  srtp: SrtpContext,
): void {
  clientHello.extensions.forEach((extension) => {
    switch (extension.type) {
      case EllipticCurves.type:
        {
          const curves = EllipticCurves.fromData(extension.data).data;
          log(dtls.sessionId, "curves", curves);
          const curve = curves.filter((c) =>
            NamedCurveAlgorithmList.includes(c as any),
          )[0] as NamedCurveAlgorithms;
          cipher.namedCurve = curve;
          log(dtls.sessionId, "curve selected", cipher.namedCurve);
        }
        break;
      case Signature.type:
        {
          if (!cipher.signatureHashAlgorithm)
            throw new Error("need to set certificate");

          const signatureHash = Signature.fromData(extension.data).data;
          log(dtls.sessionId, "hash,signature", signatureHash);
          const signature = signatureHash.find(
            (v) => v.signature === cipher.signatureHashAlgorithm?.signature,
          )?.signature;
          const hash = signatureHash.find(
            (v) => v.hash === cipher.signatureHashAlgorithm?.hash,
          )?.hash;
          if (signature == undefined || hash == undefined) {
            throw new Error("invalid signatureHash");
          }
        }
        break;
      case UseSRTP.type:
        {
          if (!dtls.options?.srtpProfiles) return;
          if (dtls.options.srtpProfiles.length === 0) return;

          const useSrtp = UseSRTP.fromData(extension.data);
          log(dtls.sessionId, "srtp profiles", useSrtp.profiles);
          const profile = SrtpContext.findMatchingSRTPProfile(
            useSrtp.profiles as SrtpProfile[],
            dtls.options?.srtpProfiles,
          );
          if (!profile) {
            throw new Error();
          }
          srtp.srtpProfile = profile;
          log(dtls.sessionId, "srtp profile selected", srtp.srtpProfile);
        }
        break;
      case ExtendedMasterSecret.type:
        {
          dtls.remoteExtendedMasterSecret = true;
        }
        break;
      case RenegotiationIndication.type:
        {
          log(dtls.sessionId, "RenegotiationIndication", extension.data);
        }
        break;
      case 43:
        {
          // supported_versions (DTLS 1.3 dual path log only on 1.2 flight)
          const data = extension.data.subarray(1);
          const versions = [...data].map((v) => v.toString(10));
          log("dtls supported version", versions);
        }
        break;
    }
  });

  cipher.localRandom = new DtlsRandom();
  cipher.remoteRandom = DtlsRandom.from(clientHello.random);

  const suites = clientHello.cipherSuites;
  log(dtls.sessionId, "cipher suites", suites);
  const suite = (() => {
    switch (cipher.signatureHashAlgorithm?.signature) {
      case SignatureAlgorithm.ecdsa_3:
        return CipherSuite.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256_49195;
      case SignatureAlgorithm.rsa_1:
        return CipherSuite.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256_49199;
    }
  })();
  if (suite === undefined || !suites.includes(suite)) {
    throw new Error("dtls cipher suite negotiation failed");
  }
  cipher.cipherSuite = suite;
  log(dtls.sessionId, "selected cipherSuite", cipher.cipherSuite);

  cipher.localKeyPair = generateKeyPair(cipher.namedCurve);
}
