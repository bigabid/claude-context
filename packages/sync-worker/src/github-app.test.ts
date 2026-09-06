import { test } from "node:test";
import assert from "node:assert/strict";
import { filterAndMapRepos } from "./github-app.js";

const baseRepo = {
    name: "rtb-engine",
    full_name: "bigabid/rtb-engine",
    clone_url: "https://github.com/bigabid/rtb-engine.git",
    default_branch: "main",
    archived: false,
    fork: false
};

test("filterAndMapRepos excludes archived repos by default", () => {
    const repos = [baseRepo, { ...baseRepo, name: "old-thing", full_name: "bigabid/old-thing", archived: true }];
    const result = filterAndMapRepos(repos, { excludeRepos: [], includeArchived: false, includeForks: false });
    assert.deepEqual(result.map((r) => r.fullName), ["bigabid/rtb-engine"]);
});

test("filterAndMapRepos includes archived repos when includeArchived is true", () => {
    const repos = [baseRepo, { ...baseRepo, name: "old-thing", full_name: "bigabid/old-thing", archived: true }];
    const result = filterAndMapRepos(repos, { excludeRepos: [], includeArchived: true, includeForks: false });
    assert.deepEqual(result.map((r) => r.fullName).sort(), ["bigabid/old-thing", "bigabid/rtb-engine"]);
});

test("filterAndMapRepos excludes forks by default", () => {
    const repos = [baseRepo, { ...baseRepo, name: "a-fork", full_name: "bigabid/a-fork", fork: true }];
    const result = filterAndMapRepos(repos, { excludeRepos: [], includeArchived: false, includeForks: false });
    assert.deepEqual(result.map((r) => r.fullName), ["bigabid/rtb-engine"]);
});

test("filterAndMapRepos excludes repos matching excludeRepos by full name or short name, case-insensitively", () => {
    const repos = [baseRepo, { ...baseRepo, name: "huge-mono", full_name: "bigabid/huge-mono" }];
    const result = filterAndMapRepos(repos, { excludeRepos: ["Huge-Mono"], includeArchived: false, includeForks: false });
    assert.deepEqual(result.map((r) => r.fullName), ["bigabid/rtb-engine"]);
});

test("filterAndMapRepos falls back to a constructed clone URL and 'main' when the API omits them", () => {
    const repos = [{ ...baseRepo, clone_url: null, default_branch: null }];
    const result = filterAndMapRepos(repos, { excludeRepos: [], includeArchived: false, includeForks: false });
    assert.equal(result[0].cloneUrl, "https://github.com/bigabid/rtb-engine.git");
    assert.equal(result[0].defaultBranch, "main");
});
