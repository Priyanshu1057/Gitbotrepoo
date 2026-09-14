import { readFile } from "node:fs/promises";

const API_ROOT = "https://api.github.com";

export type GithubRepository = {
  full_name: string;
  html_url: string;
  default_branch: string;
  private: boolean;
  archived?: boolean;
  description?: string | null;
};

export type GithubBranch = {
  name: string;
  protected: boolean;
};

export type GithubOrganization = {
  login: string;
};

export type GithubCommitResult = {
  sha: string;
  html_url?: string;
};

export class GithubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly rateLimitReset?: string,
    public readonly rateLimitRemaining?: string,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}

export function splitRepository(repository: string): { owner: string; name: string } {
  const clean = repository.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  const parts = clean.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1] || parts.some((part) => part.includes(".."))) {
    throw new Error("Repository must look like owner/name.");
  }
  return { owner: parts[0], name: parts[1] };
}

export function joinGithubPath(destination: string, relativePath: string): string {
  const cleanDestination = destination.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const cleanRelative = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  const combined = [cleanDestination, cleanRelative].filter(Boolean).join("/");
  const normalized = combined.split("/").filter(Boolean).join("/");
  if (
    !normalized ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.split("/").some((part) => part === "." || part === ".." || part.includes("\0"))
  ) {
    throw new Error("Destination path is unsafe.");
  }
  return normalized;
}

export class GithubClient {
  constructor(private readonly token: string, private readonly apiRoot = API_ROOT) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.apiRoot}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "zip-to-github-uploader",
        ...(init.headers ?? {}),
      },
    });
    const reset = response.headers.get("x-ratelimit-reset") ?? undefined;
    const remaining = response.headers.get("x-ratelimit-remaining") ?? undefined;
    const bodyText = await response.text();
    let body: unknown;
    try {
      body = bodyText ? JSON.parse(bodyText) : undefined;
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const message =
        typeof body === "object" && body && "message" in body && typeof body.message === "string"
          ? body.message
          : `GitHub API request failed with status ${response.status}`;
      throw new GithubApiError(message, response.status, reset, remaining);
    }
    return body as T;
  }

  async getAuthenticatedUser(): Promise<{ login: string }> {
    return this.request("/user");
  }

  async listRepositories(): Promise<GithubRepository[]> {
    return this.request("/user/repos?per_page=20&sort=updated");
  }

  async listBranches(owner: string, name: string): Promise<GithubBranch[]> {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches?per_page=20`);
  }

  async listOrganizations(): Promise<GithubOrganization[]> {
    return this.request("/user/orgs?per_page=20");
  }

  async createRepository(input: {
    name: string;
    description?: string;
    private: boolean;
    organization?: string;
  }): Promise<GithubRepository> {
    const path = input.organization
      ? `/orgs/${encodeURIComponent(input.organization)}/repos`
      : "/user/repos";
    return this.request<GithubRepository>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: input.name,
        description: input.description || undefined,
        private: input.private,
        auto_init: true,
      }),
    });
  }

  async updateRepository(
    owner: string,
    name: string,
    input: { private?: boolean; archived?: boolean; description?: string; default_branch?: string },
  ): Promise<GithubRepository> {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async deleteRepository(owner: string, name: string): Promise<void> {
    await this.request<void>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  async getRepository(owner: string, name: string): Promise<GithubRepository> {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  }

  async getBranchCommit(owner: string, name: string, branch: string): Promise<string> {
    const data = await this.request<{ object: { sha: string; type: string } }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    if (data.object.type !== "commit") throw new Error("The selected branch does not point to a commit.");
    return data.object.sha;
  }

  async getCommitTree(owner: string, name: string, commitSha: string): Promise<string> {
    const data = await this.request<{ tree: { sha: string } }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/commits/${commitSha}`,
    );
    return data.tree.sha;
  }

  async getExistingPaths(owner: string, name: string, treeSha: string): Promise<Set<string>> {
    const data = await this.request<{ tree: Array<{ path: string; type: string }> }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${treeSha}?recursive=1`,
    );
    return new Set(data.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path));
  }

  async createBlob(owner: string, name: string, filePath: string): Promise<string> {
    const content = await readFile(filePath);
    const data = await this.request<{ sha: string }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/blobs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: content.toString("base64"), encoding: "base64" }),
      },
    );
    return data.sha;
  }

  async createTree(
    owner: string,
    name: string,
    baseTreeSha: string,
    entries: Array<{ path: string; sha: string | null }>,
  ): Promise<string> {
    const data = await this.request<{ sha: string }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree: entries.map((entry) => ({ path: entry.path, mode: "100644", type: "blob", sha: entry.sha })),
        }),
      },
    );
    return data.sha;
  }

  async createCommit(
    owner: string,
    name: string,
    message: string,
    treeSha: string,
    parentSha: string,
  ): Promise<GithubCommitResult> {
    return this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/commits`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] }),
      },
    );
  }

  async updateBranch(owner: string, name: string, branch: string, commitSha: string): Promise<void> {
    await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/refs/heads/${encodeURIComponent(branch)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sha: commitSha, force: false }),
      },
    );
  }
}

export function githubErrorForUser(error: unknown): string {
  if (!(error instanceof GithubApiError)) return "GitHub could not complete the request. Please try again.";
  if (error.status === 401) return "GitHub rejected the configured token. Check the token and its permissions.";
  const rateLimitMessage = /rate limit/i.test(error.message);
  const rateLimitExhausted = error.rateLimitRemaining === "0";
  if ((error.status === 403 || error.status === 429) && (rateLimitMessage || rateLimitExhausted)) {
    return error.rateLimitReset
      ? `GitHub rate limit reached. Please try again after ${new Date(Number(error.rateLimitReset) * 1000).toLocaleTimeString()}.`
      : "GitHub rate limit reached. Please try again later.";
  }
  if (error.status === 403) return "GitHub denied access. Confirm the token has repository Contents read/write permission and can access this repository.";
  if (error.status === 404) return "Repository or branch not found, or the token cannot access it.";
  if (error.status === 409) return "GitHub reported a conflict because the branch changed. Please retry the upload.";
  if (error.status === 422 && /already exists/i.test(error.message)) {
    return "A repository with that name already exists. Choose a different name.";
  }
  if (error.status === 422) return "GitHub rejected the repository details. Check the name and try again.";
  return "GitHub could not complete the request. Please try again.";
}