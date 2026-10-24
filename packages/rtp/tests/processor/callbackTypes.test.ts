import { describe, expect, test } from "vitest";

import {
  NtpTimeCallback,
  RtpSourceStream,
  SimpleProcessorCallbackBase,
} from "../../src/extra/processor";

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

describe("public type compatibility", () => {
  test("keeps static members of the base class on the callback class", () => {
    // Arrange: static メンバーを持つ基底クラスを用意する
    class StaticBase {
      static version = 3;
      processInput(input: number): number[] {
        return [input];
      }
      toJSON() {
        return {};
      }
    }
    class Callback extends SimpleProcessorCallbackBase<
      number,
      number,
      typeof StaticBase
    >(StaticBase) {}

    // Act: static メンバーと instance の processInput を型付きで参照する
    const version: number = Callback.version;
    const outputs: number[] = new Callback().processInput(1);

    // Assert: 値が従来どおり参照できる
    expect(version).toBe(3);
    expect(outputs).toEqual([1]);
  });

  test("keeps full controller access for RtpSourceStream subclasses", () => {
    // Arrange: controller.close / error を使う派生クラス
    class Source extends RtpSourceStream {
      finish() {
        this.controller.close();
      }
      fail(e: Error) {
        this.controller.error(e);
      }
    }

    // Act / Assert: 型として参照でき、close を呼べる
    expect(() => new Source().finish()).not.toThrow();
    expect(typeof Source.prototype.fail).toBe("function");
  });
});
