import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  GithubApiError,
  GithubClient,
  githubErrorForUser,
  joinGithubPath,
  splitRepository,
} from "./client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function response(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

test("normalizes repository and destination paths without changing hierarchy", () => {
  assert.deepEqual(splitRepository("https://github.com/acme/site.git"), { owner: "acme", name: "site" });
  assert.equal(joinGithubPath("projects/myapp", "src/components/Button.jsx"), "projects/myapp/src/components/Button.jsx");
  assert.equal(joinGithubPath("/", "README.md"), "README.md");
  assert.throws(() => joinGithubPath("../escape", "file.txt"), /unsafe/i);
});

test("creates blobs, one tree, one commit, and updates the branch", async () => {
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname + parsed.search, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    if (parsed.pathname === "/repos/acme/site") return response({ full_name: "acme/site", default_branch: "main" });
    if (parsed.pathname.endsWith("/git/ref/heads/main")) return response({ object: { sha: "parent", type: "commit" } });
    if (parsed.pathname.endsWith("/git/commits/parent")) return response({ tree: { sha: "base-tree" } });
    if (parsed.pathname.endsWith("/git/trees/base-tree")) return response({ tree: [{ path: "existing.txt", type: "blob" }] });
    if (parsed.pathname.endsWith("/git/blobs")) return response({ sha: "blob-sha" });
    if (parsed.pathname.endsWith("/git/trees")) return response({ sha: "new-tree" });
    if (parsed.pathname.endsWith("/git/commits")) return response({ sha: "new-commit", html_url: "https://github.com/acme/site/commit/new-commit" });
    if (parsed.pathname.endsWith("/git/refs/heads/main")) return response({});
    return response({ message: "unexpected" }, 500);
  };

  const directory = await mkdtemp(path.join(tmpdir(), "github-test-"));
  const filePath = path.join(directory, "file.bin");
  await writeFile(filePath, Buffer.from([0, 255, 42]));
  try {
    const client = new GithubClient("test-token", "https://github.test");
    const repo = await client.getRepository("acme", "site");
    const parent = await client.getBranchCommit("acme", "site", "main");
    const baseTree = await client.getCommitTree("acme", "site", parent);
    const existing = await client.getExistingPaths("acme", "site", baseTree);
    const blob = await client.createBlob("acme", "site", filePath);
    const tree = await client.createTree("acme", "site", baseTree, [{ path: "assets/file.bin", sha: blob }]);
    const commit = await client.createCommit("acme", "site", "Upload test", tree, parent);
    await client.updateBranch("acme", "site", "main", commit.sha);

    assert.equal(repo.full_name, "acme/site");
    assert.equal(parent, "parent");
    assert.equal(existing.has("existing.txt"), true);
    assert.equal(commit.sha, "new-commit");
    const blobBody = JSON.parse(calls.find((call) => call.path.endsWith("/git/blobs"))?.body ?? "{}") as { content: string };
    assert.equal(Buffer.from(blobBody.content, "base64").equals(Buffer.from([0, 255, 42])), true);
    assert.equal(calls.filter((call) => call.path.endsWith("/git/commits") && call.method === "POST").length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("creates initialized personal and organization repositories", async () => {
  const calls: Array<{ path: string; body?: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, body: typeof init?.body === "string" ? init.body : undefined });
    return response({
      full_name: url.pathname.includes("/orgs/") ? "acme/new-project" : "owner/new-project",
      html_url: "https://github.com/owner/new-project",
      default_branch: "main",
      private: true,
    });
  };

  const client = new GithubClient("test-token", "https://github.test");
  await client.createRepository({ name: "new-project", description: "Test repository", private: true });
  await client.createRepository({ name: "new-project", private: false, organization: "acme" });

  assert.deepEqual(calls.map((call) => call.path), ["/user/repos", "/orgs/acme/repos"]);
  assert.equal(JSON.parse(calls[0].body ?? "{}").auto_init, true);
  assert.equal(JSON.parse(calls[1].body ?? "{}").private, false);
});

test("maps GitHub failures to safe user-facing messages", async () => {
  globalThis.fetch = async () => response({ message: "Bad credentials" }, 401);
  await assert.rejects(
    new GithubClient("test-token", "https://github.test").getAuthenticatedUser(),
    (error: unknown) => error instanceof GithubApiError && error.status === 401,
  );
  assert.match(githubErrorForUser(new GithubApiError("Bad credentials", 401)), /configured token/i);
  assert.match(githubErrorForUser(new GithubApiError("Not found", 404)), /not found/i);
  assert.match(
    githubErrorForUser(new GithubApiError("Resource not accessible by personal access token", 403, "1788774804", "4999")),
    /Contents read\/write permission/i,
  );
  assert.match(
    githubErrorForUser(new GithubApiError("API rate limit exceeded", 403, "1788774804", "0")),
    /rate limit reached/i,
  );
});