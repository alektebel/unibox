import { config } from "./config.js";

// GitHub, as you: what needs you there (review requests, assigned issues, your open PRs),
// your active repos, and the edits the assistant can make (issues, comments, files).
// Uses the same token as the gh CLI on the laptop (GITHUB_TOKEN on the server).

const API = "https://api.github.com";
const CACHE_MS = 10 * 60_000;

export interface GhItem {
  kind: "review" | "issue" | "pr";
  repo: string;
  number: number;
  title: string;
  url: string;
  updatedAt: number;
}

export interface GhSnapshot {
  login: string;
  repos: { name: string; private: boolean; pushedAt: number; url: string }[];
  items: GhItem[];
  fetchedAt: number;
}

let snapshot: GhSnapshot | null = null;
let fetching: Promise<void> | null = null;

export const githubConfigured = () => !!config.githubToken;

async function gh(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(path.startsWith("http") ? path : API + path, {
    ...init,
    headers: {
      authorization: `Bearer ${config.githubToken}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "unibox",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

async function search(q: string, kind: GhItem["kind"]): Promise<GhItem[]> {
  const r = await gh(`/search/issues?per_page=30&sort=updated&q=${encodeURIComponent(q)}`);
  return (r?.items ?? []).map((i: any) => ({
    kind,
    repo: String(i.repository_url).split("/repos/")[1] ?? "",
    number: i.number,
    title: i.title,
    url: i.html_url,
    updatedAt: Date.parse(i.updated_at),
  }));
}

async function fetchSnapshot(): Promise<void> {
  const user = await gh("/user");
  const [repos, reviews, issues, prs] = await Promise.all([
    gh("/user/repos?per_page=30&sort=pushed&affiliation=owner,collaborator,organization_member"),
    search("is:open is:pr review-requested:@me archived:false", "review"),
    search("is:open is:issue assignee:@me archived:false", "issue"),
    search("is:open is:pr author:@me archived:false", "pr"),
  ]);
  snapshot = {
    login: user.login,
    repos: (repos ?? []).map((r: any) => ({ name: r.full_name, private: r.private, pushedAt: Date.parse(r.pushed_at), url: r.html_url })),
    items: [...reviews, ...issues, ...prs],
    fetchedAt: Date.now(),
  };
}

/** The last snapshot, refreshed in the background when it's older than ten minutes. */
export function githubSnapshot(): GhSnapshot | null {
  if (!githubConfigured()) return null;
  if ((!snapshot || Date.now() - snapshot.fetchedAt > CACHE_MS) && !fetching) {
    fetching = fetchSnapshot()
      .catch((e) => console.warn("[github]", e instanceof Error ? e.message : e))
      .finally(() => { fetching = null; });
  }
  return snapshot;
}

export async function githubRefresh(): Promise<GhSnapshot | null> {
  if (!githubConfigured()) return null;
  await fetchSnapshot();
  return snapshot;
}

// --- reading -----------------------------------------------------------

const repoPath = (repo: string) => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("repo debe ser dueño/nombre");
  return `/repos/${repo}`;
};

export async function listRepos(): Promise<{ name: string; private: boolean; description: string; pushedAt: string }[]> {
  const out: any[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await gh(`/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`);
    out.push(...(r ?? []));
    if (!r || r.length < 100) break;
  }
  return out.map((r) => ({ name: r.full_name, private: r.private, description: r.description ?? "", pushedAt: r.pushed_at }));
}

export async function listTree(repo: string, ref?: string): Promise<string[]> {
  const meta = await gh(repoPath(repo));
  if (!meta) throw new Error("no encuentro ese repo");
  const t = await gh(`${repoPath(repo)}/git/trees/${encodeURIComponent(ref || meta.default_branch)}?recursive=1`);
  return (t?.tree ?? []).filter((n: any) => n.type === "blob").map((n: any) => n.path);
}

export async function readFile(repo: string, path: string, ref?: string): Promise<{ content: string; sha: string } | null> {
  const f = await gh(`${repoPath(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`);
  if (!f || Array.isArray(f) || f.type !== "file") return null;
  return { content: Buffer.from(f.content, "base64").toString("utf8"), sha: f.sha };
}

// --- editing -----------------------------------------------------------

export async function createIssue(repo: string, title: string, body = ""): Promise<string> {
  const r = await gh(`${repoPath(repo)}/issues`, { method: "POST", body: JSON.stringify({ title, body }) });
  snapshot = null;
  return r.html_url;
}

export async function comment(repo: string, number: number, body: string): Promise<string> {
  const r = await gh(`${repoPath(repo)}/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
  return r.html_url;
}

export async function setIssueState(repo: string, number: number, state: "open" | "closed"): Promise<void> {
  await gh(`${repoPath(repo)}/issues/${number}`, { method: "PATCH", body: JSON.stringify({ state }) });
  snapshot = null;
}

let login: string | null = null;

/** Your GitHub user name (asked once). */
export async function whoami(): Promise<string> {
  if (!login) login = String((await gh("/user"))?.login ?? "");
  return login;
}

/** A private repo of yours with this name, created (with a first commit) if it doesn't exist. */
export async function ensureRepo(name: string, description: string): Promise<string> {
  const me = await whoami();
  const existing = await gh(`/repos/${me}/${name}`);
  if (existing) return existing.full_name;
  const r = await gh("/user/repos", { method: "POST", body: JSON.stringify({ name, private: true, description, auto_init: true }) });
  return r.full_name;
}

/** Create or replace one file with a commit (on `branch`, or the default branch). */
export async function writeFile(repo: string, path: string, content: string, message: string, branch?: string): Promise<string> {
  const existing = await readFile(repo, path, branch);
  const r = await gh(`${repoPath(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      ...(existing ? { sha: existing.sha } : {}),
      ...(branch ? { branch } : {}),
    }),
  });
  return r.commit.html_url;
}

/** A branch off the default branch, so bigger edits go through a pull request. */
export async function createBranch(repo: string, branch: string): Promise<void> {
  const meta = await gh(repoPath(repo));
  const head = await gh(`${repoPath(repo)}/git/ref/heads/${encodeURIComponent(meta.default_branch)}`);
  await gh(`${repoPath(repo)}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: head.object.sha }) });
}

export async function openPullRequest(repo: string, branch: string, title: string, body = ""): Promise<string> {
  const meta = await gh(repoPath(repo));
  const r = await gh(`${repoPath(repo)}/pulls`, { method: "POST", body: JSON.stringify({ title, body, head: branch, base: meta.default_branch }) });
  snapshot = null;
  return r.html_url;
}
