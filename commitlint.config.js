// Conventional Commits enforcement. releaser-pleaser parses these messages on the
// GitLab control plane to compute the next version and generate the CHANGELOG, so a
// malformed message silently breaks release automation. config-conventional does not
// restrict scopes, so the existing scopes (desktop/web/release/core/cli/host/…) all pass.
export default {
  extends: ['@commitlint/config-conventional'],
};
