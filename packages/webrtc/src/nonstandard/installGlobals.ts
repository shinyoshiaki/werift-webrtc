import {
  MediaStream,
  MediaStreamTrack,
  RTCPeerConnection,
} from "../index";
import { RTCSessionDescription } from "../sdp";
import { RTCIceCandidate } from "../transport/ice";
import { RTCDataChannel } from "../dataChannel";
import { Navigator } from "./navigator";

type GlobalsTarget = {
  global?: Record<string, unknown>;
  window?: Record<string, unknown> | undefined;
};

export type InstallGlobalsOptions = GlobalsTarget & {
  force?: boolean;
};

function installValue(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  force: boolean,
) {
  if (!force && key in target) return;
  target[key] = value;
}

export function installGlobals(options: InstallGlobalsOptions = {}) {
  const force = options.force ?? false;
  const globalTarget = options.global ?? (globalThis as unknown as Record<string, unknown>);
  const windowTarget =
    options.window ??
    ((globalThis as unknown as { window?: Record<string, unknown> }).window ?? undefined);

  const targets = windowTarget ? [globalTarget, windowTarget] : [globalTarget];
  for (const target of targets) {
    installValue(target, "RTCPeerConnection", RTCPeerConnection, force);
    installValue(target, "RTCIceCandidate", RTCIceCandidate, force);
    installValue(target, "RTCSessionDescription", RTCSessionDescription, force);
    installValue(target, "RTCDataChannel", RTCDataChannel, force);
    installValue(target, "MediaStream", MediaStream, force);
    installValue(target, "MediaStreamTrack", MediaStreamTrack, force);
  }

  const existingNavigator = globalTarget.navigator as
    | { mediaDevices?: unknown }
    | undefined;

  if (!existingNavigator || force) {
    globalTarget.navigator = {};
  }

  const nav = globalTarget.navigator as { mediaDevices?: unknown };

  if (!nav.mediaDevices || force) {
    const weriftNavigator = new Navigator();
    nav.mediaDevices = weriftNavigator.mediaDevices;
  }

  if (windowTarget) {
    const winNav = (windowTarget.navigator as { mediaDevices?: unknown } | undefined) ??
      ((windowTarget.navigator = {}) as { mediaDevices?: unknown });

    if (!winNav.mediaDevices || force) {
      winNav.mediaDevices = (globalTarget.navigator as { mediaDevices?: unknown }).mediaDevices;
    }
  }
}
