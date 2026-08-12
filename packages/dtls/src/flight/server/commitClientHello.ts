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

/** Fully validated ClientHello negotiation — no association mutation yet. */
export type NegotiatedClientHello = {
  namedCurve: NamedCurveAlgorithms;
  cipherSuite: number;
  remoteRandom: DtlsRandom;
  localRandom: DtlsRandom;
  localKeyPair: ReturnType<typeof generateKeyPair>;
  srtpProfile?: SrtpProfile;
  remoteExtendedMasterSecret: boolean;
};

/**
 * Validate ClientHello and build negotiated locals only.
 * Must not write association state (cipher / srtp / dtls) so a mid-parse failure
 * cannot poison the next peer.
 */
export function validateAndNegotiateClientHello(
  clientHello: ClientHello,
  dtls: DtlsContext,
  cipher: CipherContext,
): NegotiatedClientHello {
  let namedCurve: NamedCurveAlgorithms | undefined;
  let srtpProfile: SrtpProfile | undefined;
  let remoteExtendedMasterSecret = false;

  for (const extension of clientHello.extensions) {
    switch (extension.type) {
      case EllipticCurves.type:
        {
          const curves = EllipticCurves.fromData(extension.data).data;
          log(dtls.sessionId, "curves", curves);
          const curve = curves.filter((c) =>
            NamedCurveAlgorithmList.includes(c as any),
          )[0] as NamedCurveAlgorithms | undefined;
          if (curve === undefined) {
            throw new Error("no overlapping named curve");
          }
          namedCurve = curve;
          log(dtls.sessionId, "curve selected", namedCurve);
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
          if (!dtls.options?.srtpProfiles?.length) break;

          const useSrtp = UseSRTP.fromData(extension.data);
          log(dtls.sessionId, "srtp profiles", useSrtp.profiles);
          const profile = SrtpContext.findMatchingSRTPProfile(
            useSrtp.profiles as SrtpProfile[],
            dtls.options.srtpProfiles,
          );
          if (!profile) {
            throw new Error("no matching SRTP profile");
          }
          srtpProfile = profile;
          log(dtls.sessionId, "srtp profile selected", srtpProfile);
        }
        break;
      case ExtendedMasterSecret.type:
        {
          remoteExtendedMasterSecret = true;
        }
        break;
      case RenegotiationIndication.type:
        {
          log(dtls.sessionId, "RenegotiationIndication", extension.data);
        }
        break;
      case 43:
        {
          const data = extension.data.subarray(1);
          const versions = [...data].map((v) => v.toString(10));
          log("dtls supported version", versions);
        }
        break;
    }
  }

  if (namedCurve === undefined) {
    // Prefer first local supported if peer omitted elliptic_curves (rare)
    namedCurve = NamedCurveAlgorithmList[0] as NamedCurveAlgorithms;
  }

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
  log(dtls.sessionId, "selected cipherSuite", suite);

  const localRandom = new DtlsRandom();
  const remoteRandom = DtlsRandom.from(clientHello.random);
  const localKeyPair = generateKeyPair(namedCurve);

  return {
    namedCurve,
    cipherSuite: suite,
    remoteRandom,
    localRandom,
    localKeyPair,
    srtpProfile,
    remoteExtendedMasterSecret,
  };
}

/** Apply a fully negotiated result — only call after validation succeeds. */
export function applyNegotiatedClientHello(
  negotiated: NegotiatedClientHello,
  dtls: DtlsContext,
  cipher: CipherContext,
  srtp: SrtpContext,
): void {
  cipher.namedCurve = negotiated.namedCurve;
  cipher.cipherSuite = negotiated.cipherSuite as any;
  cipher.localRandom = negotiated.localRandom;
  cipher.remoteRandom = negotiated.remoteRandom;
  cipher.localKeyPair = negotiated.localKeyPair;
  if (negotiated.srtpProfile !== undefined) {
    srtp.srtpProfile = negotiated.srtpProfile;
  }
  dtls.remoteExtendedMasterSecret = negotiated.remoteExtendedMasterSecret;
}

/**
 * Commit ClientHello parameters into association cipher/srtp/dtls state.
 *
 * Transactional: validation builds locals first; association is only written
 * after every check succeeds (no partial poison on throw).
 *
 * Call only after DTLS 1.2 HelloVerify cookie verification.
 */
export function commitClientHelloToAssociation(
  clientHello: ClientHello,
  dtls: DtlsContext,
  cipher: CipherContext,
  srtp: SrtpContext,
): void {
  const negotiated = validateAndNegotiateClientHello(clientHello, dtls, cipher);
  applyNegotiatedClientHello(negotiated, dtls, cipher, srtp);
}
