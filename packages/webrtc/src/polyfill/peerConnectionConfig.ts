import { cloneCodecParameters, defaultCodecs } from "../media/codec";
import { RTCRtpHeaderExtensionParameters } from "../media/parameters";
import {
  RTCPeerConnection,
  type RTCPeerConnectionConfig,
} from "../peerConnection";

function hasKinds(value: unknown) {
  return value != undefined;
}

export function mergePeerConnectionConfig(
  installConfig: RTCPeerConnectionConfig,
  config: RTCPeerConnectionConfig,
): RTCPeerConnectionConfig {
  const merged = { ...installConfig } as RTCPeerConnectionConfig;
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }

  if (hasKinds(installConfig.codecs) || hasKinds(config.codecs)) {
    const builtin = defaultCodecs();
    merged.codecs = {
      audio: (
        config.codecs?.audio ??
        installConfig.codecs?.audio ??
        builtin.audio
      ).map(cloneCodecParameters),
      video: (
        config.codecs?.video ??
        installConfig.codecs?.video ??
        builtin.video
      ).map(cloneCodecParameters),
    };
  }

  if (
    hasKinds(installConfig.headerExtensions) ||
    hasKinds(config.headerExtensions)
  ) {
    merged.headerExtensions = {
      audio: (
        config.headerExtensions?.audio ??
        installConfig.headerExtensions?.audio ??
        []
      ).map((extension) => new RTCRtpHeaderExtensionParameters(extension)),
      video: (
        config.headerExtensions?.video ??
        installConfig.headerExtensions?.video ??
        []
      ).map((extension) => new RTCRtpHeaderExtensionParameters(extension)),
    };
  }
  return merged;
}

export function createPolyfillRTCPeerConnection(
  installConfig?: RTCPeerConnectionConfig,
): typeof RTCPeerConnection {
  if (installConfig == undefined) return RTCPeerConnection;
  const defaults = installConfig;
  return class PolyfillRTCPeerConnection extends RTCPeerConnection {
    constructor(config: RTCPeerConnectionConfig = {}) {
      super(mergePeerConnectionConfig(defaults, config));
    }
  };
}
