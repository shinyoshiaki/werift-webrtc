import { describe, expect, test } from "vitest";

import { NtpTimeCallback } from "../../src/extra/processor";

describe("SimpleProcessorCallbackBase public types", () => {
  test("keeps cb / destructor / processInput accessible on the class and pipe result", () => {
    // Arrange
    const processor = new NtpTimeCallback(90000);

    // Act: pipe の戻り値と公開プロパティを型付きで参照する（型エラーならコンパイルで失敗する）
    const piped = processor.pipe(
      () => {},
      () => {},
    );
    const cb: ((o: any) => void) | undefined = piped.cb;
    const destructor: (() => void) | undefined = piped.destructor;
    const outputs = piped.processInput({ eol: true });

    // Assert: pipe は自身を返し、登録した callback が保持される
    expect(piped).toBe(processor);
    expect(cb).toBeTypeOf("function");
    expect(destructor).toBeTypeOf("function");
    expect(Array.isArray(outputs)).toBe(true);
  });
});
