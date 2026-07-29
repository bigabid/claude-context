import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { SyncWorkerConfig } from "./config.js";

export interface DiscoveredRepo {
    fullName: string; // "org/repo"
    cloneUrl: string; // https clone URL
    defaultBranch: string;
    archived: boolean;
    fork: boolean;
}

type AppAuth = ReturnType<typeof createAppAuth>;

export function createGithubAppAuth(config: SyncWorkerConfig): AppAuth {
    return createAppAuth({
        appId: config.githubAppId,
        privateKey: config.githubAppPrivateKey
    });
}

/**
 * Mints a fresh installation access token. These expire after ~1 hour - a
 * whole-org clone+embed run can easily exceed that, so callers must mint a
 * new token right before each use (e.g. per repo) rather than once at
 * startup and reuse it for the whole run.
 */
export async function mintInstallationToken(appAuth: AppAuth, installationId: number): Promise<string> {
    const authentication = await appAuth({ type: "installation", installationId });
    return authentication.token;
}

interface RawRepo {
    name: string;
    full_name: string;
    clone_url?: string | null;
    default_branch?: string | null;
    archived: boolean;
    fork: boolean;
}

/**
 * Pure filtering/mapping logic, split out from discoverRepos so it's testable
 * without hitting the GitHub API.
 */
export function filterAndMapRepos(
    repos: RawRepo[],
    config: Pick<SyncWorkerConfig, 'excludeRepos' | 'includeArchived' | 'includeForks'>
): DiscoveredRepo[] {
    const excludeSet = new Set(config.excludeRepos.map((r) => r.toLowerCase()));

    return repos
        .filter((repo) => {
            if (excludeSet.has(repo.full_name.toLowerCase()) || excludeSet.has(repo.name.toLowerCase())) {
                return false;
            }
            if (repo.archived && !config.includeArchived) {
                return false;
            }
            if (repo.fork && !config.includeForks) {
                return false;
            }
            return true;
        })
        .map((repo) => ({
            fullName: repo.full_name,
            cloneUrl: repo.clone_url || `https://github.com/${repo.full_name}.git`,
            defaultBranch: repo.default_branch || 'main',
            archived: repo.archived,
            fork: repo.fork
        }));
}

/**
 * Auto-discovers every repo this GitHub App installation can see (GET
 * /installation/repositories), filtered by config. Requires an installation
 * token minted with Contents:read + Metadata:read permissions.
 */
export async function discoverRepos(config: SyncWorkerConfig, installationToken: string): Promise<DiscoveredRepo[]> {
    const octokit = new Octokit({ auth: installationToken });

    // This endpoint returns a { total_count, repositories: [...] } envelope
    // rather than a flat array, so octokit.paginate()'s generic (array-shaped)
    // typing doesn't line up with it - paginate manually instead.
    const repos: RawRepo[] = [];
    for (let page = 1; ; page++) {
        const response = await octokit.rest.apps.listReposAccessibleToInstallation({ per_page: 100, page });
        repos.push(...response.data.repositories);
        if (response.data.repositories.length < 100) {
            break;
        }
    }

    return filterAndMapRepos(repos, config);
}
