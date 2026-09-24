import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";
import { patchGeneratedWorkflowTestReporter } from "./scripts/workflow-test-reporter.mjs";

const webChatLiveTestsEnabled = process.env.LLM_FOR_ZOTERO_WEBCHAT_LIVE === "1";
// Live agent tests call a real model with the user's own credentials, so they
// are opt-in: they cost money and need network, which a default test run
// should never assume.
const agentLiveTestsEnabled = process.env.LLM_FOR_ZOTERO_AGENT_LIVE === "1";
const workflowTestsEnabled =
  webChatLiveTestsEnabled ||
  agentLiveTestsEnabled ||
  process.env.LLM_FOR_ZOTERO_WORKFLOW_TESTS === "1";

// GitHub Actions sets GITHUB_REPOSITORY to the repo the workflow runs on,
// so a fork publishes its release, update feed, and download links to
// itself instead of upstream (package.json's repository). Locally the
// {{owner}}/{{repo}} placeholders keep resolving from package.json.
const releaseRepository = process.env.GITHUB_REPOSITORY || "{{owner}}/{{repo}}";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/${releaseRepository}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink: `https://github.com/${releaseRepository}/releases/download/v{{version}}/{{xpiName}}.xpi`,
  release: {
    github: {
      repository: releaseRepository,
    },
  },

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    fluent: {
      prefixFluentMessages: false,
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox115",
        loader: { ".md": "text" },
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  test: {
    // LLM_FOR_ZOTERO_TEST_ENTRY pins an entries DIRECTORY (the scaffold
    // always appends "/**/*.test.js"), so a scratch dir with one probe file
    // runs alone instead of paying for the whole workflow suite.
    entries:
      process.env.LLM_FOR_ZOTERO_TEST_ENTRY ||
      (agentLiveTestsEnabled
        ? "test-live-agent"
        : webChatLiveTestsEnabled
          ? "test-live-workflows"
          : workflowTestsEnabled
            ? "test-workflows"
            : "test"),
    // The workflow tests assert English UI labels (e.g. the reader popup
    // "Add Text" button), so pin the locale regardless of the host OS
    // language — a Chinese-locale machine otherwise localizes the plugin UI
    // and breaks those assertions.
    prefs: {
      "intl.locale.requested": "en-US",
    },
    ...(workflowTestsEnabled
      ? {
          abortOnFail: !agentLiveTestsEnabled,
          // A live agent turn does real model round trips and real library
          // writes, so it needs far longer than a UI workflow test.
          mocha: {
            timeout:
              webChatLiveTestsEnabled || agentLiveTestsEnabled ? 720000 : 30000,
          },
          watch: false,
        }
      : {}),
    hooks: {
      "test:bundleTests": () => patchGeneratedWorkflowTestReporter(),
    },
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
});
