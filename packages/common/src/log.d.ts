export declare class WeriftError extends Error {
  message: string;
  payload?: object;
  path?: string;
  constructor(props: Pick<WeriftError, "message" | "payload" | "path">);
  toJSON(): {
    message: string;
    payload: any;
    path: string | undefined;
  };
}
export interface Debugger {
  (...args: unknown[]): void;
  readonly enabled: boolean;
  readonly namespace: string;
}
export interface DebugFactory {
  (namespace: string): Debugger;
  enable(namespaces: string): void;
  disable(): string;
  enabled(namespace: string): boolean;
}
export declare const debug: DebugFactory;
/** @internal Replace the log sink in unit tests. */
export declare function setDebugWriterForTest(
  writer?: (message: string) => void,
): void;
