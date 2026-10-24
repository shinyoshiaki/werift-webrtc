import { setDebugWriterForTest } from "../src/log";

export function createDebugOutput() {
  const messages: string[] = [];
  setDebugWriterForTest((message) => messages.push(message));
  return {
    messages,
    restore: () => setDebugWriterForTest(),
  };
}
