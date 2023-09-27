declare module "mux.js" {
  export namespace mp4 {
    export const Transmuxer: TransmuxerContructor;
    export const generator: {
      ftyp: () => any;
      mdat: (data: any) => any;
      moof: (sequenceNumber: any, tracks: any) => any;
      moov: (tracks: Track[]) => any;
      initSegment: (tracks: Track[]) => Uint8Array;
    };

    export interface Track {
      id: string;
      samples?: any[];
      type: string;
      width?: number;
      height?: number;
      duration?: number;
    }

    export interface Segment {
      captionStreams: {};
      captions: unknown[];
      data: Uint8Array;
      initSegment: Uint8Array;
      info: {
        width: number;
        height: number;
        levelIdc: number;
        profileIdc: number;
        profileCompatibility: number;
      };
    }

    export interface TransmuxerContructor {
      new (): Transmuxer;
    }

    export interface Transmuxer {
      on(event: "data", cb: (segment: Segment) => void): void;
      on(event: "error", cb: (error: unknown) => void): void;

      off(event: "data", cb?: (segment: Segment) => void): void;
      off(event: "error", cb?: (error: unknown) => void): void;

      push(typedArray: Uint8Array): void;
      flush(): void;
    }
  }
}
