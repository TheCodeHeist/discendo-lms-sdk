import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";
import { sidebar } from "./sidebar.mts";

const REPO = "https://github.com/TheCodeHeist/discendo-lms-sdk";

// Set DOCS_BASE=/discendo-lms-sdk/ when deploying to GitHub Pages.
const base = (process.env.DOCS_BASE ?? "/") as `/${string}/` | "/";

export default withMermaid(
  defineConfig({
    base,
    lang: "en-US",
    title: "Discendo SDK",
    titleTemplate: ":title · Discendo SDK",
    description:
      "A framework- and database-agnostic TypeScript SDK of LMS logic: enrollment, content, assessment, grading, scheduling and more.",

    cleanUrls: true,
    lastUpdated: true,

    head: [
      ["link", { rel: "icon", type: "image/svg+xml", href: `${base}logo.svg` }],
      ["meta", { name: "theme-color", content: "#681f6e" }],
      ["meta", { property: "og:type", content: "website" }],
      ["meta", { property: "og:title", content: "Discendo SDK" }],
      [
        "meta",
        {
          property: "og:description",
          content: "Bring your own database and framework. Get the LMS logic.",
        },
      ],
    ],

    markdown: {
      theme: { light: "github-light", dark: "github-dark" },
    },

    mermaid: {
      // follows the site's light/dark toggle automatically
    },

    themeConfig: {
      logo: "/logo.svg",
      siteTitle: "Discendo SDK",

      nav: [
        {
          text: "Guide",
          link: "/introduction/what-is-discendo",
          activeMatch: "^/(introduction|concepts)/",
        },
        { text: "Modules", link: "/modules/", activeMatch: "^/modules/" },
        {
          text: "Build an LMS",
          link: "/tutorial/",
          activeMatch: "^/tutorial/",
        },
        {
          text: "v0.1.0",
          items: [
            { text: "Commit history", link: `${REPO}/commits/development` },
            { text: "Source on GitHub", link: REPO },
            { text: "Report an issue", link: `${REPO}/issues` },
          ],
        },
      ],

      sidebar,

      outline: { level: [2, 3], label: "On this page" },

      search: { provider: "local" },

      socialLinks: [{ icon: "github", link: REPO }],

      editLink: {
        pattern: `${REPO}/edit/development/website/:path`,
        text: "Edit this page on GitHub",
      },

      footer: {
        message: "Released under the GPL-3.0 License.",
        copyright: "Copyright © 2026 Md Riyasat Hossain",
      },
    },
  }),
);
