import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OAUTH_SCOPES, buildAuthorizeUrl } from "../src/servicem8-oauth.js";

// The install link asks ServiceM8 for OAUTH_SCOPES, not the manifest's list.
// The two drifted apart once (2026-10-16): the reinstall screen didn't offer
// Inbox, notifications or create jobs, so the due digest and Book job couldn't work.
test("the install link asks for exactly the manifest's scopes", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const sorted = (s) => s.trim().split(/\s+/).sort();
  assert.deepEqual(sorted(OAUTH_SCOPES), sorted(manifest.oauth.scope));
  const url = new URL(buildAuthorizeUrl({ appId: "a", redirectUri: "https://x/cb", state: "s" }));
  for (const s of ["publish_inbox", "create_notifications", "create_jobs"]) assert.ok(url.searchParams.get("scope").split(" ").includes(s), s);
});
