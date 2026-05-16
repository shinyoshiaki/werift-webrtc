export function normalizeAuthority(value: string, fallbackPort: number) {
  const normalizedValue = value.trim();
  if (normalizedValue.length === 0) {
    throw new Error("public host must not be empty");
  }

  try {
    const url = new URL(
      normalizedValue.includes("://")
        ? normalizedValue
        : `turns://${normalizedValue}`,
    );
    const resolvedPort = url.port || String(fallbackPort);
    return formatAuthority(url.hostname, resolvedPort);
  } catch {
    return normalizedValue.includes(":") && !normalizedValue.startsWith("[")
      ? `[${normalizedValue}]:${fallbackPort}`
      : normalizedValue.includes(":")
        ? normalizedValue
        : `${normalizedValue}:${fallbackPort}`;
  }
}

type ResolvePublicAuthorityOptions = {
  configuredAuthority?: string;
  configuredHost?: string;
  defaultAuthority: string;
  requestHost?: string;
  publicPort: number;
};

export function resolvePublicAuthority({
  configuredAuthority,
  configuredHost,
  defaultAuthority,
  requestHost,
  publicPort,
}: ResolvePublicAuthorityOptions) {
  if (configuredAuthority || configuredHost) {
    return defaultAuthority;
  }

  if (!requestHost) {
    return defaultAuthority;
  }

  return normalizeAuthority(requestHost, publicPort);
}

function formatAuthority(hostname: string, port: string) {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return `${hostname}:${port}`;
  }
  return hostname.includes(":") ? `[${hostname}]:${port}` : `${hostname}:${port}`;
}
