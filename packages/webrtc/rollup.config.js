import ts from "@wessberg/rollup-plugin-ts";
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
