import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { repoPathSegment, redactAuthHeader } from "./git-sync.js";

test("repoPathSegment joins org/repo into a platform-correct relative path", () => {
    assert.equal(repoPathSegment("bigabid/rtb-engine"), path.join("bigabid", "rtb-engine"));
});

test("repoPathSegment rejects a full_name with a path-traversal segment", () => {
    assert.throws(() => repoPathSegment("bigabid/.."), /[Uu]nsafe repo path segment/);
});

test("repoPathSegment rejects a full_name with more than two segments (also a form of traversal)", () => {
    assert.throws(() => repoPathSegment("bigabid/../../etc"), /Unexpected repo full_name/);
});

test("repoPathSegment rejects a full_name that isn't exactly org/repo", () => {
    assert.throws(() => repoPathSegment("just-a-name"), /Unexpected repo full_name/);
    assert.throws(() => repoPathSegment("org/repo/extra"), /Unexpected repo full_name/);
});

test("repoPathSegment rejects an empty segment", () => {
    assert.throws(() => repoPathSegment("bigabid/"), /[Uu]nsafe repo path segment/);
});

test("redactAuthHeader strips the base64 GitHub App token from the error message", () => {
    const token = Buffer.from('x-access-token:ghs_supersecrettoken1234567890').toString('base64');
    const original = new Error(
        `Command failed: git -c http.extraheader=AUTHORIZATION: basic ${token} clone --depth 1 https://github.com/org/repo.git /data/repos/org/repo\n` +
        `fatal: repository not found`
    );

    const sanitized = redactAuthHeader(original);

    assert.ok(!sanitized.message.includes(token), 'redacted message must not contain the raw base64 token');
    assert.ok(sanitized.message.includes('AUTHORIZATION: basic ***REDACTED***'), 'redacted message must show the redaction marker');
    assert.ok(sanitized.message.includes('fatal: repository not found'), 'redaction must preserve the actual error detail');
});

test("redactAuthHeader also scrubs the token from .stack and a non-standard .cmd property", () => {
    const token = Buffer.from('x-access-token:ghs_anothersecret').toString('base64');
    const original = new Error(`Command failed: git -c http.extraheader=AUTHORIZATION: basic ${token} clone ...`);
    original.stack = `Error: ...\n    at http.extraheader=AUTHORIZATION: basic ${token}`;
    (original as unknown as { cmd: string }).cmd = `git -c http.extraheader=AUTHORIZATION: basic ${token} clone ...`;

    const sanitized = redactAuthHeader(original) as Error & { cmd?: string };

    assert.ok(!sanitized.stack?.includes(token));
    assert.ok(!sanitized.cmd?.includes(token));
});

test("redactAuthHeader handles a non-Error thrown value without crashing", () => {
    const token = Buffer.from('x-access-token:yetanothersecret').toString('base64');
    const sanitized = redactAuthHeader(`git failed: AUTHORIZATION: basic ${token}`);

    assert.ok(!sanitized.message.includes(token));
});
