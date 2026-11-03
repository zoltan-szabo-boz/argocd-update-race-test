import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface GameUpdate {
  prefix: string[];
  studio: string;
  game: string;
  image: string;
  replicas: number;
}

// These end up inside YAML lines and yq paths, so anything else is refused rather than escaped
const SLUG = /^[a-z0-9][a-z0-9_-]*$/;
const PREFIX_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;

export function parseUpdate(raw: Record<"prefix" | "studio" | "game" | "image" | "replicas", string>): GameUpdate {
  const prefix = raw.prefix.split(".");
  if (!prefix.every((segment) => PREFIX_SEGMENT.test(segment))) throw new Error(`invalid values-yaml-prefix "${raw.prefix}"`);
  if (!SLUG.test(raw.studio)) throw new Error(`invalid studio "${raw.studio}"`);
  if (!SLUG.test(raw.game)) throw new Error(`invalid game-name "${raw.game}"`);
  if (!IMAGE.test(raw.image)) throw new Error(`invalid image-url "${raw.image}"`);
  if (!/^\d+$/.test(raw.replicas)) throw new Error(`invalid replicas "${raw.replicas}"`);
  return { prefix, studio: raw.studio, game: raw.game, image: raw.image, replicas: Number(raw.replicas) };
}

// Edited line by line rather than parsed and re-serialised, so every line outside the game's entry stays
// byte-identical: releases of different games then touch disjoint lines and merge without conflicts.

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isContent = (line: string): boolean => line.trim() !== "" && !line.trimStart().startsWith("#");

function keyOf(line: string): { key: string; value: string } | undefined {
  const match = line.trimStart().match(/^(?:"([^"]+)"|'([^']+)'|([^\s"'#:-][^:#]*?))\s*:(\s.*|)$/);
  if (!match) return undefined;
  return { key: match[1] ?? match[2] ?? match[3], value: match[4].trim() };
}

// Index just past the block nested under keyLine, before any blank lines that trail it
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

function firstContentIndent(lines: string[], start: number, end: number): number | undefined {
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
    const where = keys.slice(0, depth + 1).join(".");
    keyLine = findKey(lines, start, end, indent, key);
    if (keyLine === -1) throw new Error(`${where} not found in the values file`);
    if (keyOf(lines[keyLine])?.value !== "") throw new Error(`${where} is not a block mapping`);
    end = blockEnd(lines, keyLine, end);
    start = keyLine + 1;
    indent = firstContentIndent(lines, start, end) ?? indentOf(lines[keyLine]) + 2;
  }

  const step = indent - indentOf(lines[keyLine]);
  const fields: [string, string][] = [
    ["image", update.image],
    ["replicas", String(update.replicas)],
  ];
  const gameLine = findKey(lines, start, end, indent, update.game);

  if (gameLine === -1) {
    const pad = " ".repeat(indent);
    lines.splice(end, 0, `${pad}${update.game}:`, ...fields.map(([field, value]) => `${pad}${" ".repeat(step)}${field}: ${value}`));
    return lines.join("\n");
  }

  for (const [field, value] of fields) {
    const gameEnd = blockEnd(lines, gameLine, end);
    const fieldIndent = firstContentIndent(lines, gameLine + 1, gameEnd) ?? indent + step;
    const fieldLine = findKey(lines, gameLine + 1, gameEnd, fieldIndent, field);
    const line = `${" ".repeat(fieldIndent)}${field}: ${value}`;
    if (fieldLine === -1) {
      lines.splice(gameEnd, 0, line);
      end++;
    } else {
      lines[fieldLine] = line;
    }
  }
  return lines.join("\n");
}

// A second, independent reading of the change: yq (preinstalled on GitHub's Ubuntu runners, and already
// what verify-deployment reads the file with) must agree that only this game's image and replicas moved.

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
  const name = `${update.studio}/${update.game}`;
  const game = `.${update.prefix.join(".")}["${update.studio}"].games["${update.game}"]`;
  if (yq(`del(${game})`, before) !== yq(`del(${game})`, after)) {
    throw new Error(`the change modifies entries other than ${name}`);
  }
  if (yq(`${game} // {} | del(.image, .replicas)`, before) !== yq(`${game} | del(.image, .replicas)`, after)) {
    throw new Error(`the change modifies keys of ${name} other than image and replicas`);
  }
  if (yq(`${game}.image`, after) !== JSON.stringify(update.image) || yq(`${game}.replicas`, after) !== String(update.replicas)) {
    throw new Error(`the change does not set ${name} to the requested image and replicas`);
  }
}

// ---- Releasing through gap-kubernetes

export type Api = (method: string, url: string, body?: unknown) => Promise<{ status: number; data: any }>;

export interface ReleaseOptions {
  api: Api;
  repository: string;
  filePath: string;
  update: GameUpdate;
  envName: string;
  branchSuffix: string;
  maxAttempts: number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Jittered, so releases that collided once do not collide again in lockstep
const backoff = (attempt: number): number => 1000 * (1 + Math.random() * 2 ** Math.min(attempt, 4));

async function ok(api: Api, method: string, url: string, body?: unknown): Promise<any> {
  const { status, data } = await api(method, url, body);
  if (status >= 300) throw new Error(`${method} ${url} failed with ${status}: ${data?.message ?? ""}`);
  return data;
}

export async function release(options: ReleaseOptions): Promise<{ prUrl: string; mergedSha: string }> {
  const { api, update } = options;
  const sleep = options.sleep ?? wait;
  const repo = `/repos/${options.repository}`;
  const name = `${update.studio}-${update.game}`;
  const title = `ci: release: ${name} ${options.envName}`;
  const branch = `release/${options.envName}/${name}/${options.branchSuffix}`;
  const readFile = async (sha: string): Promise<string> =>
    Buffer.from((await ok(api, "GET", `${repo}/contents/${options.filePath}?ref=${sha}`)).content, "base64").toString("utf8");

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    // The commit is built on exactly the main that was read, so GitHub three-way merges it onto any newer
    // main. Building it on a later main, as yaml-update-action did, made it revert whatever landed in between.
    const base: string = (await ok(api, "GET", `${repo}/git/ref/heads/main`)).object.sha;
    const before = await readFile(base);
    const after = setGame(before, update);
    if (after === before) {
      console.log(`${name} already has this image and replicas on main (${base}), nothing to release`);
      return { prUrl: "", mergedSha: base };
    }
    checkScope(before, after, update);

    const baseTree = (await ok(api, "GET", `${repo}/git/commits/${base}`)).tree.sha;
    const blob = await ok(api, "POST", `${repo}/git/blobs`, { content: after, encoding: "utf-8" });
    const tree = await ok(api, "POST", `${repo}/git/trees`, {
      base_tree: baseTree,
      tree: [{ path: options.filePath, mode: "100644", type: "blob", sha: blob.sha }],
    });
    const commit: string = (await ok(api, "POST", `${repo}/git/commits`, { message: title, tree: tree.sha, parents: [base] })).sha;

    const created = await api("POST", `${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit });
    if (created.status === 422) await ok(api, "PATCH", `${repo}/git/refs/heads/${branch}`, { sha: commit, force: true });
    else if (created.status >= 300) throw new Error(`creating ${branch} failed with ${created.status}: ${created.data?.message ?? ""}`);

    const owner = options.repository.split("/")[0];
    const [open] = await ok(api, "GET", `${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(branch)}`);
    const pr = open ?? (await ok(api, "POST", `${repo}/pulls`, { title, head: branch, base: "main", body: title }));

    for (let merges = 1; merges <= options.maxAttempts; merges++) {
      // GitHub recomputes mergeability whenever the head or main moves and refuses to merge until it has,
      // so merging straight after a push fails as "not mergeable" even when the change merges cleanly
      if (!(await isMergeable(api, repo, pr.number, commit, sleep))) break;

      // sha pins the merge to the commit built above, so a branch moved by anything else is never merged
      const merge = await api("PUT", `${repo}/pulls/${pr.number}/merge`, {
        merge_method: "squash",
        sha: commit,
        commit_title: `${title} (#${pr.number})`,
      });
      if (merge.status === 200 && merge.data?.merged) {
        const merged = await ok(api, "GET", `${repo}/git/commits/${merge.data.sha}`);
        // The squash commit itself must change only this game, or this release reverted someone
        checkScope(await readFile(merged.parents[0].sha), await readFile(merge.data.sha), update);
        console.log(`Merged ${pr.html_url} as ${merge.data.sha} (built on main ${base}, attempt ${attempt})`);
        return { prUrl: pr.html_url, mergedSha: merge.data.sha };
      }
      // Usually another release merged first ("Base branch was modified"): the commit still three-way
      // merges onto the new main, so the merge is retried as is
      console.log(`Merging ${pr.html_url} returned ${merge.status} (${merge.data?.message ?? ""}), retrying`);
      await sleep(backoff(merges));
    }

    // Only a real conflict, such as another release of the same game, needs the edit redone on the latest main
    console.log(`${pr.html_url} cannot merge onto main, rebuilding from the latest main (attempt ${attempt})`);
    await sleep(backoff(attempt));
  }
  throw new Error(`could not merge the ${name} release after ${options.maxAttempts} attempts`);
}

async function isMergeable(api: Api, repo: string, prNumber: number, head: string, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  for (let poll = 0; poll < 60; poll++) {
    const pr = await ok(api, "GET", `${repo}/pulls/${prNumber}`);
    if (pr.head.sha === head && pr.mergeable !== null) return pr.mergeable;
    await sleep(2000);
  }
  throw new Error(`GitHub did not compute whether #${prNumber} is mergeable within 2 minutes`);
}

// ---- Entry point

// Test copy: releases into this repo instead of VGW/gap-kubernetes
const REPOSITORY = process.env.GITHUB_REPOSITORY ?? "";

export function githubApi(token: string): Api {
  return async (method, url, body) => {
    const response = await fetch(`https://api.github.com${url}`, {
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

export async function main({
  env,
  outputPath,
  api,
  sleep,
}: {
  env: Record<string, string | undefined>;
  outputPath: string;
  api: Api;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  if (!outputPath) throw new Error("GITHUB_OUTPUT is not set");
  const update = parseUpdate({
    prefix: env.VALUES_YAML_PREFIX ?? "",
    studio: env.STUDIO ?? "",
    game: env.GAME_NAME ?? "",
    image: env.IMAGE_URL ?? "",
    replicas: env.REPLICAS ?? "",
  });
  const { prUrl, mergedSha } = await release({
    api,
    repository: REPOSITORY,
    filePath: env.VALUES_FILE_PATH ?? "",
    update,
    envName: env.ENV_NAME ?? "",
    branchSuffix: env.BRANCH_SUFFIX ?? "",
    maxAttempts: 10,
    sleep,
  });
  appendFileSync(outputPath, `pr-url=${prUrl}\nmerged-sha=${mergedSha}\n`);
}

// Workflow command escaping, as @actions/core does, so an error message cannot start a command of its own
const escapeData = (value: string): string => value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

// import.meta.filename is symlink-resolved and argv[1] is not
if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) {
  main({ env: process.env, outputPath: process.env.GITHUB_OUTPUT ?? "", api: githubApi(process.env.GH_TOKEN ?? "") }).catch((err: unknown) => {
    console.log(`::error::${escapeData(err instanceof Error ? err.message : String(err))}`);
    process.exit(1);
  });
}
