import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  isLoadedKoffiBusyError,
  isNewer,
  isRunningUnderNpm,
  isTrustedReleaseAssetUrl,
  parseLatestRelease,
  runGlobalUpdate,
} from "../packages/frontend-terminal/src/updates/updates.js";
import { configureAnsi } from "../packages/frontend-terminal/src/ansi.js";
import { formatUpdateNotice } from "../packages/frontend-terminal/src/update-notice.js";

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
  assert.equal(
    isTrustedReleaseAssetUrl(
      "https://user;whoami;@github.com/xlmax/ant/releases/download/v0.5.0/ant-0.5.0.tgz",
      "0.5.0",
    ),
    false,
  );
  assert.equal(
    isTrustedReleaseAssetUrl(
      "https://github.com:443/xlmax/ant/releases/download/v0.5.0/ant-0.5.0.tgz",
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

const RELEASE_URL = "https://github.com/xlmax/ant/releases/download/v0.5.0/ant-0.5.0.tgz";

class FakeUpdateChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

function fakeSpawn(
  child: FakeUpdateChild,
  observe?: (options: { detached?: boolean }) => void,
): typeof spawn {
  return ((_command: string, _args: readonly string[], options: { detached?: boolean }) => {
    observe?.(options);
    return child as unknown as ReturnType<typeof spawn>;
  }) as unknown as typeof spawn;
}

test("Windows update reports loaded koffi EBUSY without forwarding npm stderr", async () => {
  const child = new FakeUpdateChild();
  const stderr: Buffer[] = [];
  let spawned = 0;
  let detached: boolean | undefined;
  const result = runGlobalUpdate(RELEASE_URL, {
    platform: "win32",
    spawnProcess: fakeSpawn(child, (options) => {
      spawned += 1;
      detached = options.detached;
    }),
    writeStderr: (chunk) => stderr.push(chunk),
  });

  child.stderr.write(
    "npm error code EBUSY\nnpm error path C:\\ant\\node_modules\\koffi\\build\\koffi.node\n",
  );
  child.emit("close", 4_294_963_214);

  assert.deepEqual(await result, { status: "blocked-by-loaded-native-module" });
  assert.equal(Buffer.concat(stderr).toString("utf8"), "");
  assert.equal(spawned, 1);
  assert.notEqual(detached, true);
});

test("loaded koffi classification requires both stderr markers", () => {
  assert.equal(isLoadedKoffiBusyError("npm EBUSY at koffi.node"), true);
  assert.equal(isLoadedKoffiBusyError("npm EBUSY at another.node"), false);
  assert.equal(isLoadedKoffiBusyError("npm EPERM at koffi.node"), false);
});

test("loaded koffi EBUSY remains an ordinary npm error outside Windows", async () => {
  const child = new FakeUpdateChild();
  const stderr: Buffer[] = [];
  const result = runGlobalUpdate(RELEASE_URL, {
    platform: "linux",
    spawnProcess: fakeSpawn(child),
    writeStderr: (chunk) => stderr.push(chunk),
  });

  child.stderr.write("npm error code EBUSY\nnpm error path /ant/koffi.node\n");
  child.emit("close", 16);

  await assert.rejects(result, /npm install завершился с кодом 16/u);
  assert.match(Buffer.concat(stderr).toString("utf8"), /EBUSY[\s\S]*koffi\.node/u);
});

test("ordinary npm update errors retain stderr and the diagnostic exit code", async () => {
  const child = new FakeUpdateChild();
  const stderr: Buffer[] = [];
  const result = runGlobalUpdate(RELEASE_URL, {
    platform: "win32",
    spawnProcess: fakeSpawn(child),
    writeStderr: (chunk) => stderr.push(chunk),
  });

  child.stderr.write("npm error code EACCES\nnpm error ordinary failure\n");
  child.emit("close", 1);

  await assert.rejects(result, /npm install завершился с кодом 1/u);
  assert.equal(
    Buffer.concat(stderr).toString("utf8"),
    "npm error code EACCES\nnpm error ordinary failure\n",
  );
});

test("spawn errors are not followed by a second close diagnostic", async () => {
  const child = new FakeUpdateChild();
  const stderr: Buffer[] = [];
  const result = runGlobalUpdate(RELEASE_URL, {
    platform: "win32",
    spawnProcess: fakeSpawn(child),
    writeStderr: (chunk) => stderr.push(chunk),
  });
  const failure = new Error("spawn failed");

  child.emit("error", failure);
  child.stderr.write("npm error ordinary failure\n");
  child.emit("close", 1);

  await assert.rejects(result, failure);
  assert.equal(stderr.length, 0);
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
