import { resolve } from "path";
import ts from "typescript";

const webrtcRoot = resolve(__dirname, "../..");

// 利用者側 (exactOptionalPropertyTypes 有効) のコードをソースに対してコンパイルし、診断を返す
const compileConsumer = (code: string) => {
  const fileName = resolve(webrtcRoot, "tests/types/__consumer.ts");
  const options: ts.CompilerOptions = {
    strict: true,
    exactOptionalPropertyTypes: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: ["node"],
    allowImportingTsExtensions: true,
  };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, ...rest) =>
    name === fileName
      ? ts.createSourceFile(name, code, lang)
      : original(name, lang, ...rest);
  const program = ts.createProgram([fileName], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName === fileName)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
};

describe("public types (パラメータプロパティ変換後も互換)", () => {
  test("省略可能な公開プロパティへ undefined を代入できる", () => {
    // Arrange
    const code = `
      import { Candidate } from "../../../ice/src";
      import { CipherContext } from "../../../dtls/src";
      import { IceCandidate } from "../../src/transport/ice";
      import { RTCDtlsTransport } from "../../src/transport/dtls";
      declare const c: Candidate;
      declare const i: IceCandidate;
      declare const d: RTCDtlsTransport;
      declare const cc: CipherContext;
      c.ufrag = undefined;
      c.generation = undefined;
      c.tcptype = undefined;
      c.relatedAddress = undefined;
      c.relatedPort = undefined;
      i.ufrag = undefined;
      i.generation = undefined;
      d.localCertificate = undefined;
      cc.certPem = undefined;
      cc.keyPem = undefined;
    `;

    // Act
    const diagnostics = compileConsumer(code);

    // Assert: 型エラーが 0 件である
    expect(diagnostics).toEqual([]);
  });

  test("DtlsRandom.random_bytes は Uint8Array<ArrayBuffer> に代入できる", () => {
    // Arrange
    const code = `
      import { CipherContext } from "../../../dtls/src";
      declare const cc: CipherContext;
      export const u: Uint8Array<ArrayBuffer> = cc.localRandom.random_bytes;
    `;

    // Act
    const diagnostics = compileConsumer(code);

    // Assert: 型エラーが 0 件である
    expect(diagnostics).toEqual([]);
  });
});
