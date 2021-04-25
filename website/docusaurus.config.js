module.exports = {
  title: "werift",
  tagline: "Pure TypeScript implementation of WebRTC",
  url: "https://your-docusaurus-test-site.com",
  baseUrl: "/werift-webrtc/website/build/",
  onBrokenLinks: "throw",
  onBrokenMarkdownLinks: "warn",
  favicon: "img/favicon.ico",
  organizationName: "shinyoshiaki", // Usually your GitHub org/user name.
  projectName: "werift", // Usually your repo name.
  i18n: {
    defaultLocale: "en",
    locales: ["en", "ja"],
    localeConfigs: {
      en: {
        label: "English",
      },
      fr: {
        label: "Japanese",
      },
    },
  },
  themeConfig: {
    navbar: {
      title: "werift",
      logo: {
        alt: "My Site Logo",
        src: "img/logo.svg",
      },
      items: [
        {
          to: "docs/",
          activeBasePath: "docs",
          label: "Docs",
          position: "left",
        },
        { to: "blog", label: "Blog", position: "left" },
        {
          type: "localeDropdown",
          position: "right",
        },
        {
          href: "https://github.com/facebook/docusaurus",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Docs",
          items: [
            {
              label: "Documentation",
              to: "docs/",
            },
            {
              label: "API Reference",
              to: "docs/api/",
            },
          ],
        },
        {
          title: "Community",
          items: [
            {
              label: "Twitter",
              href: "https://twitter.com/shinyoshiaki",
            },
          ],
        },
        {
          title: "More",
          items: [
            {
              label: "Blog",
              to: "blog",
            },
            {
              label: "GitHub",
              href: "https://github.com/shinyoshiaki/werift-webrtc",
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} werift, shinyoshiaki`,
    },
  },
  presets: [
    [
      "@docusaurus/preset-classic",
      {
        docs: {
          sidebarPath: require.resolve("./sidebars.js"),
          // Please change this to your repo.
          editUrl:
            "https://github.com/facebook/docusaurus/edit/master/website/",
        },
        blog: {
          showReadingTime: true,
          // Please change this to your repo.
          editUrl:
            "https://github.com/facebook/docusaurus/edit/master/website/blog/",
        },
        theme: {
          customCss: require.resolve("./src/css/custom.css"),
        },
      },
    ],
  ],
  plugins: [
    [
      "docusaurus-plugin-typedoc",
      {
        entryPoints: ["../packages/webrtc/src/index.ts"],
        tsconfig: "../packages/webrtc/tsconfig.json",
        docsRoot: "docs",
        out: "api",
        sidebar: {
          sidebarFile: "typedoc-sidebar.js",
          fullNames: true,
          readmeLabel: "Overview",
        },
      },
    ],
  ],
};
