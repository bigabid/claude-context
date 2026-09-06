import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { DiscoveredRepo } from "./github-app.js";

const execFileAsync = promisify(execFile);

const AUTH_HEADER_PATTERN = /AUTHORIZATION: basic [A-Za-z0-9+/=]+/gi;

/**
 * Thrown when a repo has no commits on its configured default branch (the
 * GitHub API still reports a default_branch name for a freshly-created,
 * never-pushed-to repo, even though no such ref actually exists to clone).
 * Not a real failure - there's nothing to index. Callers should log and
 * move on rather than treat this like an error.
 */
export class EmptyRepoError extends Error {
    constructor(repoFullName: string) {
        super(`Repo '${repoFullName}' has no commits on its default branch (nothing to index)`);
        this.name = 'EmptyRepoError';
    }
}

/**
 * Maps a repo's "org/repo" full name to a filesystem-safe relative path.
 * Defensive against unexpected characters in a name returned by the GitHub
 * API - rejects any segment that isn't a safe path component (notably ".."),
 * rather than trusting the API response to never contain one.
 */
export function repoPathSegment(fullName: string): string {
    const segments = fullName.split('/');
    if (segments.length !== 2) {
        throw new Error(`Unexpected repo full_name (expected "org/repo"): ${fullName}`);
    }
    for (const segment of segments) {
        if (segment.length === 0 || segment === '.' || segment === '..' || /[\\/\0]/.test(segment)) {
            throw new Error(`Unsafe repo path segment in full_name: ${fullName}`);
        }
    }
    return path.join(...segments);
}

/**
 * Builds a `-c http.extraheader=...` value that authenticates as the GitHub
 * App installation for this single git invocation only. Deliberately NOT
 * using a token-embedded clone URL (https://x-access-token:TOKEN@github.com/...)
 * because that persists the token in plaintext in .git/config - since tokens
 * are re-minted per repo anyway (they expire in ~1h), there's no reason to
 * ever write one to disk.
 */
function authHeaderArg(token: string): string {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    return `http.extraheader=AUTHORIZATION: basic ${basic}`;
}

/**
 * Node's child_process error objects put the FULL invoked command - including
 * our -c http.extraheader=AUTHORIZATION: basic <token> arg - directly into
 * .message (and often .cmd), so an unhandled git failure leaks the live
 * GitHub App installation token straight into logs. Strip it before this
 * error is ever allowed to propagate to a console.error/log call.
 */
export function redactAuthHeader(error: unknown): Error {
    if (!(error instanceof Error)) {
        return new Error(String(error).replace(AUTH_HEADER_PATTERN, 'AUTHORIZATION: basic ***REDACTED***'));
    }
    const sanitized = new Error(error.message.replace(AUTH_HEADER_PATTERN, 'AUTHORIZATION: basic ***REDACTED***'));
    sanitized.name = error.name;
    if (error.stack) {
        sanitized.stack = error.stack.replace(AUTH_HEADER_PATTERN, 'AUTHORIZATION: basic ***REDACTED***');
    }
    // node's exec errors often carry the raw command on a non-standard `.cmd` property too
    const cmd = (error as { cmd?: unknown }).cmd;
    if (typeof cmd === 'string') {
        (sanitized as unknown as { cmd: string }).cmd = cmd.replace(AUTH_HEADER_PATTERN, 'AUTHORIZATION: basic ***REDACTED***');
    }
    return sanitized;
}

async function runGit(args: string[], repo: DiscoveredRepo): Promise<void> {
    try {
        await execFileAsync('git', args);
    } catch (error) {
        const sanitized = redactAuthHeader(error);
        if (/remote branch .* not found in upstream|couldn.?t find remote ref/i.test(sanitized.message)) {
            throw new EmptyRepoError(repo.fullName);
        }
        throw sanitized;
    }
}

/**
 * Clones a repo (shallow, single-branch - only the current state is needed
 * for indexing, not history) if it isn't already checked out under reposDir,
 * otherwise fetches and hard-resets to the latest default branch. Returns the
 * absolute local path. Throws EmptyRepoError (not a real failure) if the repo
 * has no commits on its default branch.
 */
export async function cloneOrPull(repo: DiscoveredRepo, token: string, reposDir: string): Promise<string> {
    const targetDir = path.join(reposDir, repoPathSegment(repo.fullName));
    const authArg = authHeaderArg(token);

    if (fs.existsSync(path.join(targetDir, '.git'))) {
        await runGit(['-C', targetDir, '-c', authArg, 'fetch', '--depth', '1', 'origin', repo.defaultBranch], repo);
        await runGit(['-C', targetDir, 'reset', '--hard', `origin/${repo.defaultBranch}`], repo);
    } else {
        if (fs.existsSync(targetDir)) {
            // targetDir survived without a valid .git - a previous run was killed
            // mid-clone (OOM, activeDeadlineSeconds, node eviction). `git clone`
            // refuses to write into a non-empty directory, which would wedge this
            // repo as FAILED on every run until someone manually cleans the PVC.
            fs.rmSync(targetDir, { recursive: true, force: true });
        }
        fs.mkdirSync(path.dirname(targetDir), { recursive: true });
        await runGit([
            '-c', authArg,
            'clone', '--depth', '1', '--single-branch', '--branch', repo.defaultBranch,
            repo.cloneUrl, targetDir
        ], repo);
    }

    return targetDir;
}
