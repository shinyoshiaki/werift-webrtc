/**
 * Chromium 111+ として mediasoup-client の Chrome111 Handler が選ぶ固定 User-Agent。
 * 実行中 Node の major から Chrome バージョンを合成しない。
 */
export const CHROME111_COMPAT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36";

const NODE_USER_AGENT = /^Node\.js\/\d+/;

export function parseUserAgentOption(userAgent: unknown): string | undefined {
  if (userAgent === undefined) {
    return undefined;
  }
  if (typeof userAgent !== "string" || userAgent.trim() === "") {
    throw new TypeError("userAgent must be a non-empty string");
  }
  return userAgent;
}

export function shouldReplaceUserAgent(current: unknown): boolean {
  if (typeof current !== "string") {
    return true;
  }
  if (current.trim() === "") {
    return true;
  }
  return NODE_USER_AGENT.test(current);
}

export function resolveInstalledUserAgent(
  current: unknown,
  explicit: string | undefined,
): string | undefined {
  if (explicit !== undefined) {
    return explicit;
  }
  if (!shouldReplaceUserAgent(current)) {
    return undefined;
  }
  return CHROME111_COMPAT_USER_AGENT;
}

export function applyUserAgent(
  navigatorObject: object,
  userAgent: string,
): void {
  Object.defineProperty(navigatorObject, "userAgent", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: userAgent,
  });
}

export function installUserAgent(
  navigatorObject: object,
  explicit: string | undefined,
): void {
  const current = (navigatorObject as { userAgent?: unknown }).userAgent;
  const next = resolveInstalledUserAgent(current, explicit);
  if (next === undefined) {
    return;
  }
  applyUserAgent(navigatorObject, next);
}

export const assertUserAgentOption = parseUserAgentOption;
