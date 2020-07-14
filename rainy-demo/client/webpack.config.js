const HtmlWebpackPlugin = require("html-webpack-plugin");
const WorkboxWebpackPlugin = require("workbox-webpack-plugin");
const ImportHttpWebpackPlugin = require("import-http/webpack");

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
    extensions: [".ts", ".tsx", ".js", ".json"],
  },
  module: {
    rules: [
      {
        test: /\.(ts|js)x?$/,
        exclude: /node_modules/,
        use: {
          loader: "babel-loader",
        },
      },
      {
        test: /\.(ts|tsx)$/,
        enforce: "pre",
        use: [
          {
            options: {
              eslintPath: require.resolve("eslint"),
            },
            loader: require.resolve("eslint-loader"),
          },
        ],
        exclude: /node_modules/,
      },

      {
        test: /\.worker\.ts$/,
        use: [
          {
            loader: "worker-loader",
            options: { inline: true, name: "[name].js" },
          },
          "babel-loader",
        ],
      },
      {
        test: /\.comlink\.ts$/,
        use: [
          {
            loader: "comlink-loader",
            options: {
              singleton: true,
            },
          },
          "babel-loader",
        ],
      },
      {
        test: /\.css$/,
        use: ["style-loader", "css-loader"],
      },
      {
        test: /\.(jpe?g|png|gif|ico|svg)$/i,
        use: [{ loader: "file-loader" }],
      },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template:
        process.env.NODE_ENV === "production"
          ? "./public/index.prod.html"
          : "./public/index.html",
      favicon: "./public/favicon.ico",
    }),
    new WorkboxWebpackPlugin.GenerateSW({
      swDest: dist + "/sw.js",
    }),
    new ImportHttpWebpackPlugin(),
  ],
  devServer: {
    disableHostCheck: true,
    contentBase: __dirname + "/assets",
    historyApiFallback: true,
    publicPath: "/",
  },
  performance: {
    hints: false,
  },
};
