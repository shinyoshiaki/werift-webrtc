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
import * as browserIdentity from "./browserIdentity";
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
  /** navigator.userAgent に設定する値。指定時は既存値より優先する */
  userAgent?: string;
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

  const explicitUserAgent = browserIdentity.assertUserAgentOption(
    options.userAgent,
  );

  const target = (options.target ?? globalThis) as Record<string, unknown>;
  const mediaAction = shouldInstallMediaDevices(
    getExistingMediaDevices(target),
    options.existingMediaDevices ?? "overwrite",
  );
  const boundRegisters = bindRegisters(options.mediaRegister);
  const previous = snapshot(target, INSTALLED_KEYS);
  previous.window = descriptorOf(target, "window");
  const previousNavigator = snapshotNavigator(target);

  const mediaDevices = new MediaDevices(boundRegisters);
  try {
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

    if (mediaAction === "install") {
      installMediaDevices(target, mediaDevices);
    }

    const navigatorObject = ensureNavigator(target);
    browserIdentity.installUserAgent(navigatorObject, explicitUserAgent);

    if (target.window == null) {
      assign(target, "window", target);
    }
  } catch (error) {
    restore(target, previous);
    restoreNavigator(target, previousNavigator);
    mediaDevices.cleanup();
    throw error;
  }

  return () => {
    restore(target, previous);
    restoreNavigator(target, previousNavigator);
    mediaDevices.cleanup();
  };
}

function bindRegisters(registers: MediaRegister[]): BoundMediaRegister[] {
  const used = new Set<string>();
  for (const register of registers) {
    const explicitId = explicitDeviceId(register.deviceId);
    if (explicitId == undefined) {
      continue;
    }
    if (used.has(explicitId)) {
      throw new Error(`Duplicate mediaRegister deviceId: ${explicitId}`);
    }
    used.add(explicitId);
  }

  let sequence = 0;
  return registers.map((register) => {
    const deviceId =
      explicitDeviceId(register.deviceId) ??
      nextGeneratedDeviceId(used, () => ++sequence);
    return {
      get mimeType() {
        return register.mimeType;
      },
      get kinds() {
        return register.kinds;
      },
      deviceId,
      groupId: register.groupId,
      label: register.label,
      prepare: register.prepare?.bind(register),
      createTracks: (request) => register.createTracks(request),
      stop: register.stop?.bind(register),
    };
  });
}

function explicitDeviceId(deviceId: string | undefined) {
  if (deviceId == undefined || deviceId === "") {
    return undefined;
  }
  return deviceId;
}

function nextGeneratedDeviceId(used: Set<string>, nextSequence: () => number) {
  let deviceId: string;
  do {
    deviceId = `werift-device-${nextSequence()}`;
  } while (used.has(deviceId));
  used.add(deviceId);
  return deviceId;
}

function getExistingMediaDevices(target: Record<string, unknown>) {
  const navigatorValue = target.navigator;
  if (!navigatorValue || typeof navigatorValue !== "object") {
    return undefined;
  }
  return (navigatorValue as { mediaDevices?: unknown }).mediaDevices;
}

function ensureNavigator(target: Record<string, unknown>) {
  let navigatorValue = target.navigator;
  if (!navigatorValue || typeof navigatorValue !== "object") {
    navigatorValue = {};
    assign(target, "navigator", navigatorValue);
  }
  return navigatorValue as Record<string, unknown>;
}

function installMediaDevices(
  target: Record<string, unknown>,
  mediaDevices: MediaDevices,
) {
  assign(ensureNavigator(target), "mediaDevices", mediaDevices);
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
  const navigatorValue = target.navigator;
  const navigatorObject =
    navigatorValue && typeof navigatorValue === "object"
      ? (navigatorValue as object)
      : undefined;
  return {
    hadOwnNavigator: hasOwn(target, "navigator"),
    navigatorDesc: descriptorOf(target, "navigator"),
    navigatorObject,
    hadOwnMediaDevices: navigatorObject
      ? hasOwn(navigatorObject, "mediaDevices")
      : false,
    mediaDevicesDesc: navigatorObject
      ? descriptorOf(navigatorObject, "mediaDevices")
      : undefined,
    hadOwnUserAgent: navigatorObject
      ? hasOwn(navigatorObject, "userAgent")
      : false,
    userAgentDesc: navigatorObject
      ? descriptorOf(navigatorObject, "userAgent")
      : undefined,
  };
}

function restoreNavigator(
  target: Record<string, unknown>,
  previous: ReturnType<typeof snapshotNavigator>,
) {
  if (previous.navigatorObject) {
    restoreOwnProperty(
      previous.navigatorObject,
      "userAgent",
      previous.hadOwnUserAgent,
      previous.userAgentDesc,
    );
    restoreOwnProperty(
      previous.navigatorObject,
      "mediaDevices",
      previous.hadOwnMediaDevices,
      previous.mediaDevicesDesc,
    );
  }
  restoreOwnProperty(
    target,
    "navigator",
    previous.hadOwnNavigator,
    previous.navigatorDesc,
  );
}

function restoreOwnProperty(
  target: object,
  key: string,
  hadOwn: boolean,
  descriptor: PropertyDescriptor | undefined,
) {
  if (hadOwn) {
    if (descriptor) {
      Object.defineProperty(target, key, descriptor);
    }
    return;
  }
  if (hasOwn(target, key)) {
    delete (target as Record<string, unknown>)[key];
  }
}

function hasOwn(target: object, key: string) {
  return Object.prototype.hasOwnProperty.call(target, key);
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
