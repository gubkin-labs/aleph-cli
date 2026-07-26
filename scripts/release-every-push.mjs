/**
 * semantic-release normally skips commits that do not imply a release.
 * This project publishes every main-branch push, so patch is the minimum.
 * The conventional commit analyzer can still select minor or major.
 */
export const analyzeCommits = () => "patch";
