export type ExistingMediaDevicesMode = "overwrite" | "throw" | "noop";

export function shouldInstallMediaDevices(
  existingMediaDevices: unknown,
  mode: ExistingMediaDevicesMode = "overwrite",
): "install" | "skip" {
  if (!hasGetUserMedia(existingMediaDevices)) {
    return "install";
  }
  switch (mode) {
    case "overwrite":
      return "install";
    case "noop":
      return "skip";
    case "throw":
      throw new Error(
        'navigator.mediaDevices already exists; pass existingMediaDevices: "overwrite" to replace it',
      );
  }
}

function hasGetUserMedia(value: unknown): boolean {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as { getUserMedia?: unknown }).getUserMedia === "function"
  );
}
