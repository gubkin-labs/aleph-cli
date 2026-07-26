export default {
  branches: ["main"],
  plugins: [
    "@semantic-release/commit-analyzer",
    "./scripts/release-every-push.mjs",
    "@semantic-release/release-notes-generator",
    ["@semantic-release/npm", { npmPublish: false }],
    [
      "@semantic-release/git",
      {
        assets: ["package.json"],
        message:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: semantic-release expands these placeholders.
          "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
      },
    ],
    "@semantic-release/github",
  ],
};
