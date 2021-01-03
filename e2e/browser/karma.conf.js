// Karma configuration
// Generated on Fri Jan 01 2021 14:33:51 GMT+0900 (日本標準時)

module.exports = function (config) {
  config.set({
    // base path that will be used to resolve all patterns (eg. files, exclude)
    basePath: "",

    // frameworks to use
    // available frameworks: https://npmjs.org/browse/keyword/karma-adapter
    frameworks: ["jasmine", "karma-typescript"],

    // list of files / patterns to load in the browser
    files: ["tests/**/*.ts"],

    // list of files / patterns to exclude
    exclude: [],

    // preprocess matching files before serving them to the browser
    // available preprocessors: https://npmjs.org/browse/keyword/karma-preprocessor
    preprocessors: { "**/*.ts": "karma-typescript" },

    // test results reporter to use
    // possible values: 'dots', 'progress'
    // available reporters: https://npmjs.org/browse/keyword/karma-reporter
    reporters: ["progress", "karma-typescript"],

    // web server port
    port: 9876,

    // enable / disable colors in the output (reporters and logs)
    colors: true,

    // level of logging
    // possible values: config.LOG_DISABLE || config.LOG_ERROR || config.LOG_WARN || config.LOG_INFO || config.LOG_DEBUG
    logLevel: config.LOG_INFO,

    // enable / disable watching file and executing tests whenever any file changes
    autoWatch: true,

    // start these browsers
    // available browser launchers: https://npmjs.org/browse/keyword/karma-launcher
    customLaunchers: {
      chrome_with_fake_device: {
        base: "ChromeHeadless",
        flags: [
          "--use-fake-device-for-media-stream",
          "--use-fake-ui-for-media-stream",
        ],
      },
      firefox_with_fake_device: {
        base: "FirefoxHeadless",
        prefs: {
          "media.navigator.permission.disabled": true,
          "media.navigator.streams.fake": true,
        },
      },
    },
    browsers: ["chrome_with_fake_device"],

    // Continuous Integration mode
    // if true, Karma captures browsers, runs the tests and exits
    // singleRun: true,

    // Concurrency level
    // how many browser should be started simultaneous
    concurrency: Infinity,
    karmaTypescriptConfig: {
      compilerOptions: {
        target: "ES2020",
        module: "commonjs",
        lib: ["esnext", "ES2020", "DOM"],
        declaration: true,
        outDir: "lib",
        strict: true,
        allowSyntheticDefaultImports: true,
        esModuleInterop: true,
        importHelpers: true,
        pretty: true,
        sourceMap: true,
        inlineSources: true,
        noUnusedLocals: false,
        skipLibCheck: true,
        strictNullChecks: false,
        noImplicitAny: false,
      },
      include: ["tests"],
    },
  });
};
