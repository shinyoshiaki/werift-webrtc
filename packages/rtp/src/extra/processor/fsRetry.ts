/**
 * Bounded retry for transient file-system errors. Internal to
 * `extra/processor`: not exported from the package entry points.
 */

/**
 * errno codes retried as transient. `EBUSY` is what a sharing violation on a
 * CIFS/SMB mount or a FUSE file system reports while another process holds
 * the file. `EPERM` is deliberately absent: on POSIX it is a permanent
 * permission error. Add a code here only after it was observed to be
 * transient (e.g. `EAGAIN` on NFS / FUSE).
 */
const TransientFsErrorCodes: readonly string[] = Object.freeze(["EBUSY"]);

/** attempts including the first one */
const MaxAttempts = 8;
/** upper bound of the summed backoff delay */
const MaxTotalDelayMs = 1000;
/** the n-th retry waits BaseDelayMs * n (20, 40, ... 140 ms; 560 ms total) */
const BaseDelayMs = 20;

export function isTransientFsError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && TransientFsErrorCodes.includes(code);
}

/** @internal test seams */
export interface RetryTransientFsErrorOptions {
  isTransient?: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const sleepFor = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `op` and re-runs it while it fails with a transient error, at most
 * `MaxAttempts` times and `MaxTotalDelayMs` of waiting in total. `op` must be
 * idempotent. Any other error, or the last transient one once the limits are
 * reached, is thrown as is (its `code` is kept). The first attempt never waits.
 */
export async function retryTransientFsError<T>(
  op: () => Promise<T>,
  options: RetryTransientFsErrorOptions = {},
): Promise<T> {
  const isTransient = options.isTransient ?? isTransientFsError;
  const sleep = options.sleep ?? sleepFor;
  let waited = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      return await op();
    } catch (error) {
      const delay = BaseDelayMs * attempt;
      if (
        !isTransient(error) ||
        attempt >= MaxAttempts ||
        waited + delay > MaxTotalDelayMs
      ) {
        throw error;
      }
      waited += delay;
      await sleep(delay);
    }
  }
}

/**
 * Opens a handle, runs `body` with it and closes it exactly once. When `body`
 * fails, its error wins over a close error. When only close fails, the close
 * error is thrown so that a transient one can retry the whole unit.
 */
export async function withFileHandle<H extends { close(): Promise<void> }, T>(
  open: () => Promise<H>,
  body: (handle: H) => Promise<T>,
): Promise<T> {
  const handle = await open();
  let result: T;
  try {
    result = await body(handle);
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  await handle.close();
  return result;
}
