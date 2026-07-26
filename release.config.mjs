export default {
  branches: ["main"],
  plugins: [
    "@semantic-release/commit-analyzer",
    "./scripts/release-every-push.mjs",
    "@semantic-release/release-notes-generator",
    ["@semantic-release/npm", { npmPublish: true }],
    "@semantic-release/github",
  ],
};
