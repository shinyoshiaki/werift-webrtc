/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-var-requires */
const path = require("path");
const HTMLPlugin = require("html-webpack-plugin");
const webpack = require("webpack");

const dist = __dirname + "/build";

module.exports = {
  devtool: "source-map",
  entry: ["@babel/polyfill", "./src/index"],
  output: {
    path: dist,
    filename: "bundle.js",
    publicPath: "./",
    globalObject: "self",
  },
  resolve: {
    extensions: [".js", ".ts", ".tsx", ".json", ".mjs", ".wasm"],
  },
  module: {
    rules: [
      {
        test: /\.ts(x)?$/,
        use: {
          loader: "ts-loader",
          options: {
            transpileOnly: true,
          },
        },
      },
      {
        test: /\.css$/i,
        use: ["style-loader", "css-loader"],
      },
    ],
  },
  plugins: [
    new HTMLPlugin({
      template: path.join(__dirname, "public/index.html"),
      favicon: path.join(__dirname, "public/favicon.ico"),
    }),
    new webpack.DefinePlugin({
      NODE_ENV: JSON.stringify(process.env.NODE_ENV),
    }),
  ],
  devServer: {
    contentBase: __dirname + "/public",
    publicPath: "/",
    disableHostCheck: true,
    historyApiFallback: true,
    open: true,
    hot: true,
  },
};
