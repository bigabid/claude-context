import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { DiscoveredRepo } from "./github-app.js";

const execFileAsync = promisify(execFile);

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
 * Clones a repo (shallow, single-branch - only the current state is needed
 * for indexing, not history) if it isn't already checked out under reposDir,
 * otherwise fetches and hard-resets to the latest default branch. Returns the
 * absolute local path.
 */
export async function cloneOrPull(repo: DiscoveredRepo, token: string, reposDir: string): Promise<string> {
    const targetDir = path.join(reposDir, repoPathSegment(repo.fullName));
    const authArg = authHeaderArg(token);

    if (fs.existsSync(path.join(targetDir, '.git'))) {
        await execFileAsync('git', ['-C', targetDir, '-c', authArg, 'fetch', '--depth', '1', 'origin', repo.defaultBranch]);
        await execFileAsync('git', ['-C', targetDir, 'reset', '--hard', `origin/${repo.defaultBranch}`]);
    } else {
        fs.mkdirSync(path.dirname(targetDir), { recursive: true });
        await execFileAsync('git', [
            '-c', authArg,
            'clone', '--depth', '1', '--single-branch', '--branch', repo.defaultBranch,
            repo.cloneUrl, targetDir
        ]);
    }

    return targetDir;
}
