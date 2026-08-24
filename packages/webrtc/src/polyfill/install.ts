import { RTCDataChannel } from "../dataChannel";
import { OverconstrainedError } from "../errors";
import {
  MediaStream,
  MediaStreamTrack,
  RTCRtpReceiver,
  RTCRtpSender,
  RTCRtpTransceiver,
} from "../media";
import { RTCPeerConnection, RTCTrackEvent } from "../peerConnection";
import { RTCDtlsTransport } from "../transport/dtls";
import { RTCIceCandidate, RTCIceTransport } from "../transport/ice";
import {
  type ExistingMediaDevicesMode,
  shouldInstallMediaDevices,
} from "./existingMediaDevices";
import { MediaDevices } from "./mediaDevices";
import type { BoundMediaRegister, MediaRegister } from "./mediaRegister";
import { PolyfillRTCSessionDescription } from "./rtcSessionDescription";

const INSTALLED_KEYS = [
  "RTCPeerConnection",
  "RTCSessionDescription",
  "RTCIceCandidate",
  "RTCDataChannel",
  "MediaStream",
  "MediaStreamTrack",
  "RTCRtpSender",
  "RTCRtpReceiver",
  "RTCRtpTransceiver",
  "RTCIceTransport",
  "RTCDtlsTransport",
  "RTCTrackEvent",
  "OverconstrainedError",
] as const;

export interface InstallPolyfillOptions {
  mediaRegister: MediaRegister[];
  existingMediaDevices?: ExistingMediaDevicesMode;
  target?: object;
}

export function installPolyfill(options: InstallPolyfillOptions): () => void {
  if (options == null || typeof options !== "object") {
    throw new TypeError("installPolyfill requires an options object");
  }
  if (!("mediaRegister" in options) || options.mediaRegister == undefined) {
    throw new TypeError("mediaRegister is required");
  }
  if (!Array.isArray(options.mediaRegister)) {
    throw new TypeError("mediaRegister must be an array");
  }

  const target = (options.target ?? globalThis) as Record<string, unknown>;
  const boundRegisters = bindRegisters(options.mediaRegister);
  const previous = snapshot(target, INSTALLED_KEYS);
  const previousNavigator = snapshotNavigator(target);

  assign(target, "RTCPeerConnection", RTCPeerConnection);
  assign(target, "RTCSessionDescription", PolyfillRTCSessionDescription);
  assign(target, "RTCIceCandidate", RTCIceCandidate);
  assign(target, "RTCDataChannel", RTCDataChannel);
  assign(target, "MediaStream", MediaStream);
  assign(target, "MediaStreamTrack", MediaStreamTrack);
  assign(target, "RTCRtpSender", RTCRtpSender);
  assign(target, "RTCRtpReceiver", RTCRtpReceiver);
  assign(target, "RTCRtpTransceiver", RTCRtpTransceiver);
  assign(target, "RTCIceTransport", RTCIceTransport);
  assign(target, "RTCDtlsTransport", RTCDtlsTransport);
  assign(target, "RTCTrackEvent", RTCTrackEvent);
  assign(target, "OverconstrainedError", OverconstrainedError);

  const mediaDevices = new MediaDevices(boundRegisters);
  const existingMediaDevices = getExistingMediaDevices(target);
  const mediaAction = shouldInstallMediaDevices(
    existingMediaDevices,
    options.existingMediaDevices ?? "overwrite",
  );
  if (mediaAction === "install") {
    installMediaDevices(target, mediaDevices);
  }

  if (target.window == null) {
    previous.window = descriptorOf(target, "window");
    assign(target, "window", target);
  }

  return () => {
    restore(target, previous);
    restoreNavigator(target, previousNavigator);
    mediaDevices.cleanup();
  };
}

function bindRegisters(registers: MediaRegister[]): BoundMediaRegister[] {
  const seen = new Set<string>();
  let sequence = 0;
  return registers.map((register) => {
    const deviceId = register.deviceId ?? `werift-device-${++sequence}`;
    if (seen.has(deviceId)) {
      throw new Error(`Duplicate mediaRegister deviceId: ${deviceId}`);
    }
    seen.add(deviceId);
    return {
      mimeType: register.mimeType,
      kinds: register.kinds,
      deviceId,
      groupId: register.groupId,
      label: register.label,
      createTracks: (request) => register.createTracks(request),
      stop: register.stop?.bind(register),
    };
  });
}

function getExistingMediaDevices(target: Record<string, unknown>) {
  const navigatorValue = target.navigator;
  if (!navigatorValue || typeof navigatorValue !== "object") {
    return undefined;
  }
  return (navigatorValue as { mediaDevices?: unknown }).mediaDevices;
}

function installMediaDevices(
  target: Record<string, unknown>,
  mediaDevices: MediaDevices,
) {
  let navigatorValue = target.navigator;
  if (!navigatorValue || typeof navigatorValue !== "object") {
    navigatorValue = {};
    assign(target, "navigator", navigatorValue);
  }
  assign(
    navigatorValue as Record<string, unknown>,
    "mediaDevices",
    mediaDevices,
  );
}

type Snapshot = Partial<Record<string, PropertyDescriptor | undefined>>;

function snapshot(target: Record<string, unknown>, keys: readonly string[]) {
  const previous: Snapshot = {};
  for (const key of keys) {
    previous[key] = descriptorOf(target, key);
  }
  return previous;
}

function snapshotNavigator(target: Record<string, unknown>) {
  const navigatorDesc = descriptorOf(target, "navigator");
  const navigatorValue =
    navigatorDesc && "value" in navigatorDesc
      ? navigatorDesc.value
      : target.navigator;
  const mediaDevicesDesc =
    navigatorValue && typeof navigatorValue === "object"
      ? descriptorOf(navigatorValue as Record<string, unknown>, "mediaDevices")
      : undefined;
  return { navigatorDesc, mediaDevicesDesc, navigatorValue };
}

function restoreNavigator(
  target: Record<string, unknown>,
  previous: ReturnType<typeof snapshotNavigator>,
) {
  if (previous.navigatorDesc) {
    Object.defineProperty(target, "navigator", previous.navigatorDesc);
  }
  if (
    previous.navigatorValue &&
    typeof previous.navigatorValue === "object" &&
    previous.mediaDevicesDesc
  ) {
    Object.defineProperty(
      previous.navigatorValue as object,
      "mediaDevices",
      previous.mediaDevicesDesc,
    );
  } else if (
    previous.navigatorValue &&
    typeof previous.navigatorValue === "object" &&
    !previous.mediaDevicesDesc
  ) {
    try {
      (previous.navigatorValue as Record<string, unknown>).mediaDevices =
        undefined;
    } catch {
      // ignore
    }
  }
}

function restore(target: Record<string, unknown>, previous: Snapshot) {
  for (const [key, descriptor] of Object.entries(previous)) {
    if (descriptor) {
      Object.defineProperty(target, key, descriptor);
    } else {
      delete target[key];
    }
  }
}

function assign(target: Record<string, unknown>, key: string, value: unknown) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

function descriptorOf(target: object, key: string) {
  return Object.getOwnPropertyDescriptor(target, key);
}
