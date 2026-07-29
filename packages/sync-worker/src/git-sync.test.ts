import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { repoPathSegment } from "./git-sync.js";

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
