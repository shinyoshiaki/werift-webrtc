import { constants as fsConstants, open as fsOpen } from "fs/promises";

import { PromiseQueue } from "../..";
import {
  type RetryTransientFsErrorOptions,
  retryTransientFsError,
  withFileHandle,
} from "./fsRetry";
import {
  ClusterSizeOffset,
  DurationPosition,
  replaceClusterSize,
  replaceSegmentSize,
  SegmentSizePosition,
  type WebmOutput,
} from "./webm";

/** the subset of `fs/promises` FileHandle used by the WebM file writer */
export interface WebmFileHandle {
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesWritten: number }>;
  truncate(len: number): Promise<void>;
  stat(): Promise<{ size: number }>;
  close(): Promise<void>;
}

/** @internal test seams of {@link createWebmFileWriter} */
export interface WebmFileWriterOptions extends RetryTransientFsErrorOptions {
  open?: (path: string, flags: string | number) => Promise<WebmFileHandle>;
}

/** read/write, created when missing, never truncated, never O_APPEND */
const OpenExistingOrCreate = fsConstants.O_RDWR | fsConstants.O_CREAT;

/**
 * File writer for {@link WebmOutput}. Every chunk is written at its own byte
 * offset (`WebmOutput.position`, or the bytes this writer has written so far)
 * with a positional write, so a retried chunk overwrites itself instead of
 * being appended twice. The chunk at offset 0 truncates an existing file.
 * Each chunk and the eol header rewrite open and close the file once per
 * attempt, and are retried as a whole on a transient error (see
 * `retryTransientFsError`). After a failure no further output is written.
 *
 * @returns resolves true for the eol output
 */
export function createWebmFileWriter(
  path: string,
  options: WebmFileWriterOptions = {},
) {
  const open = options.open ?? ((p, flags) => fsOpen(p, flags));
  const queue = new PromiseQueue();
  /** bytes written by this writer, i.e. the end of the output so far */
  let written = 0;
  let failure: unknown;

  const writeAll = async (
    handle: WebmFileHandle,
    buf: Buffer,
    position: number,
  ) => {
    for (let done = 0; done < buf.length; ) {
      const { bytesWritten } = await handle.write(
        buf,
        done,
        buf.length - done,
        position + done,
      );
      if (bytesWritten <= 0) {
        throw new Error(`webm write made no progress at ${position + done}`);
      }
      done += bytesWritten;
    }
  };

  const saveChunk = async (value: WebmOutput, chunk: Buffer) => {
    // without a position, a writer that has written nothing yet cannot tell
    // the first chunk from a later one: append after the current file end
    // unless the chunk is the initial header
    const known =
      value.position ??
      (written > 0 || value.kind === "initial" ? written : undefined);
    // decided once, so a retry rewrites the same bytes at the same offset
    let offset = known;
    await retryTransientFsError(
      () =>
        withFileHandle(
          () =>
            open(
              path,
              offset === 0
                ? "w"
                : offset === undefined
                  ? OpenExistingOrCreate
                  : "r+",
            ),
          async (handle) => {
            if (offset === undefined) {
              offset = (await handle.stat()).size;
            }
            await writeAll(handle, chunk, offset);
          },
        ),
      options,
    );
    written = offset! + chunk.length;
  };

  const saveEol = async (
    value: WebmOutput,
    eol: NonNullable<WebmOutput["eol"]>,
  ) => {
    const { durationElement, clusters } = eol;
    const known = value.position ?? (written > 0 ? written : undefined);
    await retryTransientFsError(
      () =>
        withFileHandle(
          () => open(path, "r+"),
          async (handle) => {
            const total = known ?? (await handle.stat()).size;
            // drop bytes a failed attempt may have left past the end
            await handle.truncate(total);

            // set duration
            await writeAll(
              handle,
              Buffer.from(durationElement),
              DurationPosition,
            );

            // set cluster sizes
            for (const { position, size } of clusters) {
              await writeAll(
                handle,
                replaceClusterSize(size),
                position + ClusterSizeOffset,
              );
            }

            // set segment size
            await writeAll(
              handle,
              replaceSegmentSize(total),
              SegmentSizePosition,
            );
          },
        ),
      options,
    );
  };

  return (value: WebmOutput): Promise<boolean> =>
    queue.push<boolean>(async () => {
      if (failure !== undefined) {
        throw failure;
      }
      try {
        if (value.saveToFile) {
          await saveChunk(value, value.saveToFile);
          return false;
        } else if (value.eol) {
          await saveEol(value, value.eol);
          return true;
        }
        return false;
      } catch (error) {
        failure = error;
        throw error;
      }
    });
}
