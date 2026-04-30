import assert from "node:assert/strict";

// @ts-ignore Node strip-types runner resolves the .ts module directly in tests.
import { resolveFacebookLoginConfigId } from "./services/facebook-login-auth.ts";

function main() {
  const missing = resolveFacebookLoginConfigId({});
  assert.equal(missing.enabled, false);
  assert.equal(missing.configId, null);
  console.log("PASS Facebook login config stays disabled when no config id is set");

  const defaultEnabled = resolveFacebookLoginConfigId({
    FACEBOOK_LOGIN_CONFIG_ID: "1685723135915988"
  });
  assert.equal(defaultEnabled.enabled, true);
  assert.equal(defaultEnabled.configId, "1685723135915988");
  assert.equal(defaultEnabled.source, "FACEBOOK_LOGIN_CONFIG_ID");
  console.log("PASS Facebook login config id is enabled by default when present");

  const explicitlyEnabled = resolveFacebookLoginConfigId({
    FACEBOOK_LOGIN_CONFIG_ID: "1685723135915988",
    FACEBOOK_LOGIN_USE_CONFIG_ID: "true"
  });
  assert.equal(explicitlyEnabled.enabled, true);
  assert.equal(explicitlyEnabled.source, "FACEBOOK_LOGIN_USE_CONFIG_ID");
  console.log("PASS Facebook login config id can still be explicitly enabled");

  const explicitlyDisabled = resolveFacebookLoginConfigId({
    FACEBOOK_LOGIN_CONFIG_ID: "1685723135915988",
    FACEBOOK_LOGIN_USE_CONFIG_ID: "false"
  });
  assert.equal(explicitlyDisabled.enabled, false);
  assert.equal(explicitlyDisabled.configId, null);
  assert.equal(explicitlyDisabled.source, "FACEBOOK_LOGIN_USE_CONFIG_ID");
  console.log("PASS Facebook login config id can be explicitly disabled");
}

try {
  main();
} catch (error) {
  console.error("FAIL social auth tests");
  throw error;
}
