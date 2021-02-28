import ts from "rollup-plugin-typescript2";
import commonjs from "@rollup/plugin-commonjs";

export default [
  {
    input: "src/index.ts",
    plugins: [ts({ tsconfig: "tsconfig.production.json" }), commonjs()],
    output: [
      {
        file: "lib/index.js",
        format: "cjs",
      },
    ],
  },
];
