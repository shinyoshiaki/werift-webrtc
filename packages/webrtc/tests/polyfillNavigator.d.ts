/** Test-only navigator typing for Node tsconfig (no DOM lib). Not part of the published polyfill types. */
interface Navigator {
  mediaDevices: {
    getUserMedia(constraints?: unknown): Promise<import("../src/media/track").MediaStream>;
    enumerateDevices(): Promise<
      import("../src/polyfill/mediaDevices").MediaDeviceInfoLike[]
    >;
    getSupportedConstraints(): {
      deviceId: true;
      groupId: true;
      mimeType: true;
    };
    getDisplayMedia?(constraints?: unknown): Promise<import("../src/media/track").MediaStream>;
  };
  userAgent: string;
}

declare var navigator: Navigator;
