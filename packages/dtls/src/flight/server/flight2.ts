import { randomBytes } from "crypto";
import debug from "debug";

import {
  CipherSuite,
  NamedCurveAlgorithmList,
  NamedCurveAlgorithms,
  SignatureAlgorithm,
} from "../../cipher/const";
import { generateKeyPair } from "../../cipher/namedCurve";
import { CipherContext } from "../../context/cipher";
import { DtlsContext } from "../../context/dtls";
import { Profile, SrtpContext } from "../../context/srtp";
import { TransportContext } from "../../context/transport";
import { EllipticCurves } from "../../handshake/extensions/ellipticCurves";
import { ExtendedMasterSecret } from "../../handshake/extensions/extendedMasterSecret";
import { RenegotiationIndication } from "../../handshake/extensions/renegotiationIndication";
import { Signature } from "../../handshake/extensions/signature";
import { UseSRTP } from "../../handshake/extensions/useSrtp";
import { ClientHello } from "../../handshake/message/client/hello";
import { ServerHelloVerifyRequest } from "../../handshake/message/server/helloVerifyRequest";
import { DtlsRandom } from "../../handshake/random";
import { createFragments, createPlaintext } from "../../record/builder";
import { ContentType } from "../../record/const";

const log = debug("werift-dtls : packages/dtls/flight/server/flight2.ts : log");

// HelloVerifyRequest do not retransmit

export const flight2 =
  (
    udp: TransportContext,
    dtls: DtlsContext,
    cipher: CipherContext,
    srtp: SrtpContext
  ) =>
  (clientHello: ClientHello) => {
    dtls.flight = 2;

    clientHello.extensions.forEach((extension) => {
      switch (extension.type) {
        case EllipticCurves.type:
          {
            const curves = EllipticCurves.fromData(extension.data).data;
            log(dtls.sessionId, "curves", curves);
            const curve = curves.find((curve) =>
              NamedCurveAlgorithmList.includes(curve as any)
            ) as NamedCurveAlgorithms;
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
              (v) => v.signature === cipher.signatureHashAlgorithm?.signature
            )?.signature;
            const hash = signatureHash.find(
              (v) => v.hash === cipher.signatureHashAlgorithm?.hash
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
              useSrtp.profiles as Profile[],
              dtls.options?.srtpProfiles
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
