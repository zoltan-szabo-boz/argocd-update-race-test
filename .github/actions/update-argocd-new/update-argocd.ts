import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// The whole race fix: every release commit's parent is the exact main it was edited from, so GitHub's
// squash merge three-way-merges it onto any newer main instead of replacing the file with a stale copy.

export interface GameUpdate {
  prefix: string[];
  studio: string;
  game: string;
  image: string;
  replicas: number;
}

// Interpolated into yq paths and YAML lines, so anything outside these is refused rather than escaped
const SLUG = /^[a-z0-9][a-z0-9_-]*$/;
const PREFIX_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;

export function parseUpdate(raw: Record<string, string>): GameUpdate {
  const prefix = raw.prefix.split(".");
  if (!prefix.every((segment) => PREFIX_SEGMENT.test(segment))) throw new Error(`invalid values-yaml-prefix "${raw.prefix}"`);
  if (!SLUG.test(raw.studio)) throw new Error(`invalid studio "${raw.studio}"`);
  if (!SLUG.test(raw.game)) throw new Error(`invalid game-name "${raw.game}"`);
  if (!IMAGE.test(raw.image)) throw new Error(`invalid image-url "${raw.image}"`);
  if (!/^\d+$/.test(raw.replicas)) throw new Error(`invalid replicas "${raw.replicas}"`);
  return { prefix, studio: raw.studio, game: raw.game, image: raw.image, replicas: Number(raw.replicas) };
}

// ---- Editing: line-based, so every line outside the game's own entry stays byte-identical and
// concurrent releases of other games never touch the same lines (no merge conflicts, no reformatting).

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isContent = (line: string): boolean => line.trim() !== "" && !line.trimStart().startsWith("#");

function keyOf(line: string): { key: string; rest: string } | undefined {
  const match = line.trimStart().match(/^(?:"([^"]+)"|'([^']+)'|([^\s"'#:][^:#]*?))\s*:(\s.*|)$/);
  if (!match) return undefined;
  return { key: match[1] ?? match[2] ?? match[3], rest: match[4].trim() };
}

// Index just past keyLine's nested block, before any trailing blank lines
function blockEnd(lines: string[], keyLine: number, limit: number): number {
  const indent = indentOf(lines[keyLine]);
  let end = keyLine + 1;
  while (end < limit && (!isContent(lines[end]) || indentOf(lines[end]) > indent)) end++;
  while (end > keyLine + 1 && !isContent(lines[end - 1])) end--;
  return end;
}

function findKey(lines: string[], start: number, end: number, indent: number, key: string): number {
  for (let i = start; i < end; i++) {
    if (isContent(lines[i]) && indentOf(lines[i]) === indent && keyOf(lines[i])?.key === key) return i;
  }
  return -1;
}

function firstChildIndent(lines: string[], start: number, end: number): number | undefined {
  for (let i = start; i < end; i++) if (isContent(lines[i])) return indentOf(lines[i]);
  return undefined;
}

export function setGame(text: string, update: GameUpdate): string {
  const lines = text.split("\n");
  const keys = [...update.prefix, update.studio, "games"];
  let start = 0;
  let end = lines.length;
  let indent = 0;
  let keyLine = -1;

  for (const [depth, key] of keys.entries()) {
    keyLine = findKey(lines, start, end, indent, key);
    const where = keys.slice(0, depth + 1).join(".");
    if (keyLine === -1) throw new Error(`${where} not found in the values file`);
    if (keyOf(lines[keyLine])?.rest !== "") throw new Error(`${where} is not a block mapping`);
    end = blockEnd(lines, keyLine, end);
    start = keyLine + 1;
    indent = firstChildIndent(lines, start, end) ?? indentOf(lines[keyLine]) + 2;
  }

  const step = indent - indentOf(lines[keyLine]);
  const fields: [string, string][] = [
    ["image", update.image],
    ["replicas", String(update.replicas)],
  ];
  const gameLine = findKey(lines, start, end, indent, update.game);

  if (gameLine === -1) {
    const pad = " ".repeat(indent);
    const entry = [`${pad}${update.game}:`, ...fields.map(([field, value]) => `${pad}${" ".repeat(step)}${field}: ${value}`)];
    lines.splice(end, 0, ...entry);
    return lines.join("\n");
  }

  for (const [field, value] of fields) {
    const gameEnd = blockEnd(lines, gameLine, end);
    const fieldIndent = firstChildIndent(lines, gameLine + 1, gameEnd) ?? indent + step;
    const fieldLine = findKey(lines, gameLine + 1, gameEnd, fieldIndent, field);
    const replacement = `${" ".repeat(fieldIndent)}${field}: ${value}`;
    if (fieldLine === -1) {
      lines.splice(gameEnd, 0, replacement);
      end++;
    } else {
      lines[fieldLine] = replacement;
    }
  }
  return lines.join("\n");
}

// ---- Scope check: an independent YAML parser (yq, preinstalled on GitHub's Ubuntu runners) confirms the
// change sets this game's image and replicas and leaves every other value in the file exactly as it was.

function yq(expression: string, text: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "update-argocd-"));
  try {
    const file = path.join(dir, "values.yaml");
    writeFileSync(file, text);
    return execFileSync("yq", ["-o=json", "-I=0", expression, file], { encoding: "utf8" }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function checkScope(before: string, after: string, update: GameUpdate): void {
  const game = `.${update.prefix.join(".")}["${update.studio}"].games["${update.game}"]`;
  if (yq(`del(${game})`, before) !== yq(`del(${game})`, after)) {
    throw new Error(`the change would modify entries other than ${update.studio}/${update.game}`);
  }
  const previous = yq(`${game} // {} | del(.image, .replicas)`, before);
  if (previous !== yq(`${game} | del(.image, .replicas)`, after)) {
    throw new Error(`the change would modify keys of ${update.studio}/${update.game} other than image and replicas`);
  }
  if (yq(`${game}.image`, after) !== JSON.stringify(update.image) || yq(`${game}.replicas`, after) !== String(update.replicas)) {
    throw new Error(`the change does not set ${update.studio}/${update.game} to the requested image and replicas`);
  }
}

// ---- GitHub

interface Api {
  (method: string, url: string, body?: unknown): Promise<{ status: number; data: any }>;
}

function githubApi(token: string): Api {
  const base = process.env.GITHUB_API_URL ?? "https://api.github.com";
  return async (method, url, body) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : undefined };
  };
}

async function ok(api: Api, method: string, url: string, body?: unknown): Promise<any> {
  const { status, data } = await api(method, url, body);
  if (status >= 300) throw new Error(`${method} ${url} failed with ${status}: ${data?.message ?? ""}`);
  return data;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface Release {
  api: Api;
  repository: string;
  filePath: string;
  update: GameUpdate;
  envName: string;
  branchSuffix: string;
  maxAttempts: number;
}

async function readFileAt(release: Release, sha: string): Promise<string> {
  const data = await ok(release.api, "GET", `/repos/${release.repository}/contents/${release.filePath}?ref=${sha}`);
  return Buffer.from(data.content, "base64").toString("utf8");
}

async function pointBranch(release: Release, branch: string, sha: string): Promise<void> {
  const created = await release.api("POST", `/repos/${release.repository}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  if (created.status === 201) return;
  if (created.status !== 422) throw new Error(`creating ${branch} failed with ${created.status}: ${created.data?.message ?? ""}`);
  await ok(release.api, "PATCH", `/repos/${release.repository}/git/refs/heads/${branch}`, { sha, force: true });
}

async function openPullRequest(release: Release, branch: string, title: string): Promise<{ number: number; html_url: string }> {
  const owner = release.repository.split("/")[0];
  const open = await ok(release.api, "GET", `/repos/${release.repository}/pulls?state=open&head=${owner}:${encodeURIComponent(branch)}`);
  if (open.length > 0) return open[0];
  return ok(release.api, "POST", `/repos/${release.repository}/pulls`, { title, head: branch, base: "main", body: title });
}

export async function release(release: Release): Promise<{ prUrl: string; mergedSha: string }> {
  const { api, repository, update } = release;
  const name = `${update.studio}-${update.game}`;
  const title = `ci: release: ${name} ${release.envName}`;
  const branch = `release/${release.envName}/${name}/${release.branchSuffix}`;

  for (let attempt = 1; attempt <= release.maxAttempts; attempt++) {
    const base = (await ok(api, "GET", `/repos/${repository}/git/ref/heads/main`)).object.sha as string;
    const before = await readFileAt(release, base);
    const after = setGame(before, update);
    if (after === before) {
      console.log(`${name} already has this image and replicas on main ${base}, nothing to release`);
      return { prUrl: "", mergedSha: base };
    }
    checkScope(before, after, update);

    const baseTree = (await ok(api, "GET", `/repos/${repository}/git/commits/${base}`)).tree.sha;
    const blob = await ok(api, "POST", `/repos/${repository}/git/blobs`, { content: after, encoding: "utf-8" });
    const tree = await ok(api, "POST", `/repos/${repository}/git/trees`, {
      base_tree: baseTree,
      tree: [{ path: release.filePath, mode: "100644", type: "blob", sha: blob.sha }],
    });
    const commit = await ok(api, "POST", `/repos/${repository}/git/commits`, { message: title, tree: tree.sha, parents: [base] });
    await pointBranch(release, branch, commit.sha);
    const pr = await openPullRequest(release, branch, title);

    // sha pins the merge to the commit built above, so a branch moved by anything else is never merged
    const merge = await api("PUT", `/repos/${repository}/pulls/${pr.number}/merge`, {
      merge_method: "squash",
      sha: commit.sha,
      commit_title: `${title} (#${pr.number})`,
    });
    if (merge.status === 200 && merge.data?.merged) {
      await verifyMerge(release, merge.data.sha);
      console.log(`Merged ${pr.html_url} as ${merge.data.sha} on attempt ${attempt} (edited from main ${base})`);
      return { prUrl: pr.html_url, mergedSha: merge.data.sha };
    }

    // Rebuild from the latest main rather than retrying the old commit, so a retry never carries stale content
    const backoff = 1000 * (2 ** Math.min(attempt, 5) + Math.random() * 2 ** Math.min(attempt, 5));
    console.log(`Attempt ${attempt}: merge returned ${merge.status} (${merge.data?.message ?? ""}), rebuilding from the latest main in ${Math.round(backoff / 1000)}s`);
    await sleep(backoff);
  }
  throw new Error(`could not merge the ${name} release after ${release.maxAttempts} attempts`);
}

// The squash commit GitHub produced must itself change only this game, or this release reverted someone
async function verifyMerge(release: Release, mergedSha: string): Promise<void> {
  const merged = await ok(release.api, "GET", `/repos/${release.repository}/git/commits/${mergedSha}`);
  const parent = merged.parents[0].sha as string;
  checkScope(await readFileAt(release, parent), await readFileAt(release, mergedSha), release.update);
}

const escapeData = (value: string): string => value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

if (process.env.GITHUB_ACTIONS === "true") {
  const input = (name: string): string => process.env[`INPUT_${name.toUpperCase()}`] ?? "";
  try {
    const result = await release({
      api: githubApi(input("token")),
      repository: input("repository"),
      filePath: input("values-file-path"),
      update: parseUpdate({
        prefix: input("values-yaml-prefix"),
        studio: input("studio"),
        game: input("game-name"),
        image: input("image-url"),
        replicas: input("replicas"),
      }),
      envName: input("env-name"),
      branchSuffix: input("branch-suffix"),
      maxAttempts: Number(input("max-attempts") || "10"),
    });
    appendFileSync(process.env.GITHUB_OUTPUT ?? "", `pr-url=${result.prUrl}\nmerged-sha=${result.mergedSha}\n`);
  } catch (err: unknown) {
    console.log(`::error::${escapeData(err instanceof Error ? err.message : String(err))}`);
    process.exit(1);
  }
}
