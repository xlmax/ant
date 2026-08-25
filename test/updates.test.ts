import assert from "node:assert/strict";
import test from "node:test";

import {
  isNewer,
  isRunningUnderNpm,
  isTrustedReleaseAssetUrl,
  parseLatestRelease,
} from "../src/updates/updates.js";
import { configureAnsi } from "../src/ui/ansi.js";
import { formatUpdateNotice } from "../src/ui/update-notice.js";

test("isNewer compares semantic versions", () => {
  assert.equal(isNewer("0.5.0", "0.4.0"), true);
  assert.equal(isNewer("0.4.1", "0.4.0"), true);
  assert.equal(isNewer("1.0.0", "0.9.9"), true);
  assert.equal(isNewer("0.4.0", "0.4.0"), false);
  assert.equal(isNewer("0.3.0", "0.4.0"), false);
});

test("parseLatestRelease extracts version and tarball url", () => {
  assert.deepEqual(
    parseLatestRelease({
      tag_name: "v0.5.0",
      assets: [
        {
          name: "ant-0.5.0.tgz",
          browser_download_url:
            "https://github.com/xlmax/ant/releases/download/v0.5.0/ant-0.5.0.tgz",
        },
      ],
    }),
    {
      version: "0.5.0",
      url: "https://github.com/xlmax/ant/releases/download/v0.5.0/ant-0.5.0.tgz",
    },
  );

  assert.deepEqual(parseLatestRelease({ tag_name: "v0.5.0", assets: [] }), {
    version: "0.5.0",
  });
  assert.equal(parseLatestRelease({ assets: [] }), undefined);
  assert.equal(parseLatestRelease(null), undefined);
});

test("release asset URLs are restricted to the official GitHub repository", () => {
  assert.equal(
    isTrustedReleaseAssetUrl(
      "https://github.com/xlmax/ant/releases/download/v0.5.0/ant-0.5.0.tgz",
      "0.5.0",
    ),
    true,
  );
  assert.equal(isTrustedReleaseAssetUrl("https://example.com/ant-0.5.0.tgz", "0.5.0"), false);
  assert.equal(
    isTrustedReleaseAssetUrl(
      "https://github.com/xlmax/ant/releases/download/v0.5.0/ant-0.4.0.tgz",
      "0.5.0",
    ),
    false,
  );
});

test("isRunningUnderNpm detects npm lifecycle", () => {
  assert.equal(isRunningUnderNpm({}), false);
  assert.equal(isRunningUnderNpm({ npm_lifecycle_event: "dev" }), true);
  assert.equal(isRunningUnderNpm({ npm_execpath: "/usr/bin/npm" }), true);
});

test("update notice mentions the new version and the update command", () => {
  configureAnsi(false);
  const notice = formatUpdateNotice(
    {
      version: "0.5.0",
      url: "https://github.com/xlmax/ant/releases/download/v0.5.0/ant-0.5.0.tgz",
    },
    "0.4.0",
  );

  assert.match(notice, /v0\.5\.0/u);
  assert.match(notice, /0\.4\.0/u);
  assert.match(notice, /\/update/u);
});
