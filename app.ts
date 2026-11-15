// app.ts — the forge: REST v3, GraphQL v4, MCP and git smart HTTP over one in-memory store.
// Stdlib only. main.ts (lifecycle) is unchanged; this file is the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import {
  ZERO_OID, isObjectId, hashObject, putObject, parseTree, buildTree, parseCommit, buildCommit,
  parseTag, collectReachable, advertisement, parseLsRefs, lsRefsResponse, handleUploadPack,
  handleReceivePack, type GitObject, type GitStore, type TreeEntry,
} from './git.ts';

const VIEWER = 'adaiversen';
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const VIEWER_ID = 1000;
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const FIXED_TS = 1735689600; // 2025-01-01T00:00:00Z, the only timestamp the state ever carries
const FIXED_ISO = '2025-01-01T00:00:00Z';

let reqCounter = 0;
let dbIdCounter = 10000;

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}
function unb64url(text: string): string {
  try { return Buffer.from(text, 'base64url').toString('utf8'); } catch { return ''; }
}
function gid(kind: string, key: string): string { return b64url(`${kind}:${key}`); }
function isoOf(ts: number): string { return new Date(ts * 1000).toISOString().replace('.000Z', 'Z'); }

// -------------------------------------------------------------------------------- store
interface Issue { number: number; id: number; title: string; body: string; state: 'open' | 'closed'; labels: string[]; comments: Array<{ id: number; body: string }>; seq: number; }
interface PRFile { filename: string; status: string; additions: number; deletions: number; changes: number; }
interface PR {
  number: number; id: number; title: string; body: string; state: 'open' | 'closed'; merged: boolean;
  merged_at: string | null; merge_commit_sha: string | null; headRef: string; baseRef: string;
  headSha: string; baseSha: string; mergeBaseSha: string; files: PRFile[]; seq: number;
}
interface Repo {
  owner: string; name: string; id: number; nodeId: string; isPrivate: boolean; description: string;
  defaultBranch: string; objects: Map<string, GitObject>; refs: Map<string, string>;
  git: GitStore; issueTextCache: Map<number, string>;
  labels: Map<string, { name: string; color: string; id: number }>;
  issues: Map<number, Issue>; pulls: Map<number, PR>;
  nextNumber: number; nextCommentId: number; commitSeq: number;
  fileCache: Map<string, Map<string, Buffer>>;
}
const repos = new Map<string, Repo>();
function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
function getRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER) return undefined;
  return repos.get(repoKey(owner, name));
}
function newRepo(name: string, isPrivate: boolean, description: string): Repo {
  const id = ++dbIdCounter;
  const r: Repo = {
    owner: VIEWER, name, id, nodeId: gid('R', `${VIEWER}/${name}`), isPrivate,
    description, defaultBranch: 'main', objects: new Map(), refs: new Map(),
    labels: new Map(), issues: new Map(), pulls: new Map(),
    nextNumber: 1, nextCommentId: 1, commitSeq: 0, fileCache: new Map(),
    git: { objects: new Map(), refs: new Map(), defaultBranch: 'main', packCache: new Map() },
    issueTextCache: new Map(),
  };
  // The git store shares the repo's maps so both sides see the same state.
  r.git.objects = r.objects;
  r.git.refs = r.refs;
  repos.set(repoKey(VIEWER, name), r);
  return r;
}
function gitStoreOf(r: Repo): GitStore { return r.git; }

// Flat file map of a commit (path -> blob bytes), cached per commit.
function flatFiles(r: Repo, commitOid: string): Map<string, Buffer> {
  const cached = r.fileCache.get(commitOid);
  if (cached) return cached;
  const out = new Map<string, Buffer>();
  const commit = r.objects.get(commitOid);
  if (commit?.type === 'commit') {
    const walk = (treeOid: string, prefix: string): void => {
      const tree = r.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return;
      for (const e of parseTree(tree.data)) {
        if (e.mode === '40000') walk(e.oid, `${prefix}${e.name}/`);
        else { const blob = r.objects.get(e.oid); if (blob) out.set(`${prefix}${e.name}`, blob.data); }
      }
    };
    walk(parseCommit(commit.data).tree, '');
  }
  r.fileCache.set(commitOid, out);
  return out;
}
function treeFromFiles(r: Repo, files: Map<string, Buffer>): string {
  interface Node { files: Map<string, Buffer>; dirs: Map<string, Node>; }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, data] of files) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i]!;
      if (!node.dirs.has(s)) node.dirs.set(s, make());
      node = node.dirs.get(s)!;
    }
    node.files.set(segs[segs.length - 1]!, data);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, data] of node.files) entries.push({ mode: '100644', name, oid: putObject(gitStoreOf(r), 'blob', data) });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(gitStoreOf(r), 'tree', buildTree(entries));
  };
  return build(root);
}
function makeCommit(r: Repo, files: Map<string, Buffer>, parents: string[], message: string): string {
  const tree = treeFromFiles(r, files);
  const ts = FIXED_TS + (r.commitSeq++);
  const data = buildCommit({ tree, parents, message, author: `${VIEWER_NAME} <${VIEWER_EMAIL}>`, timestamp: ts });
  const oid = putObject(gitStoreOf(r), 'commit', data);
  r.git.packCache?.clear();
  return oid;
}
function commitMeta(r: Repo, oid: string): { message: string; author: string; committer: string; ts: number } {
  const obj = r.objects.get(oid);
  if (!obj || obj.type !== 'commit') return { message: '', author: '', committer: '', ts: FIXED_TS };
  const c = parseCommit(obj.data);
  const parseWho = (w: string): { name: string; email: string; ts: number } => {
    const m = /^(.*) <([^>]*)> (\d+) [+-]\d{4}$/.exec(w);
    if (!m) return { name: w, email: '', ts: FIXED_TS };
    return { name: m[1]!, email: m[2]!, ts: Number(m[3]) };
  };
  const a = parseWho(c.author);
  return { message: c.message, author: c.author, committer: c.committer, ts: a.ts };
}
function listCommits(r: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = r.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return out;
}
function diffFiles(base: Map<string, Buffer>, head: Map<string, Buffer>): PRFile[] {
  const files: PRFile[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const p of [...paths].sort()) {
    const b = base.get(p); const h = head.get(p);
    if (b !== undefined && h !== undefined) {
      if (b.equals(h)) continue;
      const add = Math.max(1, h.toString('utf8').split('\n').length);
      const del = Math.max(0, b.toString('utf8').split('\n').length);
      files.push({ filename: p, status: 'modified', additions: add, deletions: del, changes: add + del });
    } else if (h !== undefined) {
      const add = Math.max(1, h.toString('utf8').split('\n').length);
      files.push({ filename: p, status: 'added', additions: add, deletions: 0, changes: add });
    } else if (b !== undefined) {
      const del = Math.max(0, b.toString('utf8').split('\n').length);
      files.push({ filename: p, status: 'removed', additions: 0, deletions: del, changes: del });
    }
  }
  return files;
}
function prConflict(r: Repo, pr: PR): boolean {
  const baseTip = r.refs.get(`refs/heads/${pr.baseRef}`);
  if (!baseTip) return false;
  const mb = flatFiles(r, pr.mergeBaseSha);
  const head = flatFiles(r, pr.headSha);
  const base = flatFiles(r, pr.baseSha === pr.mergeBaseSha ? pr.mergeBaseSha : baseTip);
  const baseNow = flatFiles(r, baseTip);
  void base;
  for (const [path, headData] of head) {
    const mbData = mb.get(path);
    if (mbData === undefined || mbData.equals(headData)) continue; // unchanged on head
    const baseData = baseNow.get(path);
    if (baseData === undefined) {
      if (mbData !== undefined) return true; // deleted on base, changed on head
      continue;
    }
    if (!baseData.equals(mbData) && !baseData.equals(headData)) return true;
  }
  for (const [path, mbData] of mb) {
    if (head.has(path)) continue; // deleted on head
    const baseData = baseNow.get(path);
    if (baseData !== undefined && !baseData.equals(mbData)) return true; // deleted on head, changed on base
  }
  return false;
}
function doMerge(r: Repo, pr: PR): string | null {
  if (pr.state !== 'open' || pr.merged) return null;
  if (prConflict(r, pr)) return null;
  const baseTip = r.refs.get(`refs/heads/${pr.baseRef}`);
  if (!baseTip) return null;
  const mb = flatFiles(r, pr.mergeBaseSha);
  const head = flatFiles(r, pr.headSha);
  const merged = new Map(flatFiles(r, baseTip));
  for (const [path, data] of head) merged.set(path, data);
  for (const path of mb.keys()) if (!head.has(path)) merged.delete(path);
  const sha = makeCommit(r, merged, [baseTip], `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}`);
  r.refs.set(`refs/heads/${pr.baseRef}`, sha);
  pr.state = 'closed'; pr.merged = true; pr.merged_at = FIXED_ISO; pr.merge_commit_sha = sha;
  return sha;
}
function createPR(r: Repo, title: string, body: string, headRef: string, baseRef: string): PR | { error: string } {
  const headSha = r.refs.get(`refs/heads/${headRef}`);
  const baseSha = r.refs.get(`refs/heads/${baseRef}`);
  if (!headSha) return { error: `head branch ${headRef} not found` };
  if (!baseSha) return { error: `base branch ${baseRef} not found` };
  const number = r.nextNumber++;
  const files = diffFiles(flatFiles(r, baseSha), flatFiles(r, headSha));
  const pr: PR = {
    number, id: ++dbIdCounter, title, body, state: 'open', merged: false, merged_at: null,
    merge_commit_sha: null, headRef, baseRef, headSha, baseSha, mergeBaseSha: baseSha, files, seq: number,
  };
  r.pulls.set(number, pr);
  return pr;
}

// -------------------------------------------------------------------------------- JSON shapes
function userJson(): Record<string, unknown> {
  return { login: VIEWER, id: VIEWER_ID, node_id: gid('U', VIEWER), avatar_url: '', type: 'User', site_admin: false, name: VIEWER_NAME, email: VIEWER_EMAIL };
}
function repoJson(r: Repo): Record<string, unknown> {
  return {
    id: r.id, node_id: r.nodeId, name: r.name, full_name: `${r.owner}/${r.name}`,
    owner: userJson(), private: r.isPrivate, description: r.description, default_branch: r.defaultBranch,
    html_url: `/${r.owner}/${r.name}`, url: `/api/v3/repos/${r.owner}/${r.name}`,
    clone_url: `/${r.owner}/${r.name}.git`, git_url: `/${r.owner}/${r.name}.git`, ssh_url: `git@example.invalid:${r.owner}/${r.name}.git`,
    created_at: FIXED_ISO, updated_at: FIXED_ISO, pushed_at: FIXED_ISO, homepage: null, language: null,
    forks_count: 0, stargazers_count: 0, watchers_count: 0, size: 0, open_issues_count: [...r.issues.values()].filter((i) => i.state === 'open').length,
    has_issues: true, has_projects: true, has_downloads: true, has_wiki: true, has_pages: false,
    has_discussions: false, archived: false, disabled: false, visibility: r.isPrivate ? 'private' : 'public',
    license: null, topics: [], permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}
function labelJson(l: { name: string; color: string; id: number }): Record<string, unknown> {
  return { id: l.id, node_id: gid('L', l.name), name: l.name, color: l.color, description: '', default: false };
}
function issueJson(r: Repo, i: Issue): Record<string, unknown> {
  return {
    id: i.id, node_id: gid('I', `${r.owner}/${r.name}:${i.number}`), number: i.number,
    title: i.title, body: i.body, state: i.state, user: userJson(),
    labels: i.labels.map((n) => { const l = r.labels.get(n); return { name: n, color: l?.color ?? 'ededed', description: '' }; }),
    comments: i.comments.length, comments_url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}/comments`,
    created_at: FIXED_ISO, updated_at: FIXED_ISO, closed_at: i.state === 'closed' ? FIXED_ISO : null,
    html_url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}`,
    repository_url: `/api/v3/repos/${r.owner}/${r.name}`,
    assignee: null, assignees: [], milestone: null, locked: false, author_association: 'OWNER',
  };
}
function prJson(r: Repo, p: PR): Record<string, unknown> {
  return {
    id: p.id, node_id: gid('P', `${r.owner}/${r.name}:${p.number}`), number: p.number,
    title: p.title, body: p.body, state: p.state, merged: p.merged, merged_at: p.merged_at,
    merge_commit_sha: p.merge_commit_sha, mergeable: !prConflict(r, p), mergeable_state: prConflict(r, p) ? 'dirty' : 'clean',
    head: { ref: p.headRef, sha: p.headSha, label: `${r.owner}:${p.headRef}`, user: userJson(), repo: repoJson(r) },
    base: { ref: p.baseRef, sha: p.baseSha, label: `${r.owner}:${p.baseRef}`, user: userJson(), repo: repoJson(r) },
    user: userJson(), created_at: FIXED_ISO, updated_at: FIXED_ISO, closed_at: p.state === 'closed' ? FIXED_ISO : null,
    html_url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${p.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${p.number}`,
    draft: false, commits: 1, additions: p.files.reduce((s, f) => s + f.additions, 0),
    deletions: p.files.reduce((s, f) => s + f.deletions, 0), changed_files: p.files.length,
  };
}
function commitJson(r: Repo, oid: string): Record<string, unknown> {
  const m = commitMeta(r, oid);
  const parseWho = (w: string): { name: string; email: string; ts: number } => {
    const mm = /^(.*) <([^>]*)> (\d+) [+-]\d{4}$/.exec(w);
    return mm ? { name: mm[1]!, email: mm[2]!, ts: Number(mm[3]) } : { name: w, email: '', ts: FIXED_TS };
  };
  const a = parseWho(m.author); const c = parseWho(m.committer);
  const obj = r.objects.get(oid);
  const parents = obj?.type === 'commit' ? parseCommit(obj.data).parents : [];
  return {
    sha: oid, commit: {
      // The API reports the message as submitted, without git's trailing newline.
      message: m.message.replace(/\n$/, ''),
      author: { name: a.name, email: a.email, date: isoOf(a.ts) },
      committer: { name: c.name, email: c.email, date: isoOf(c.ts) },
    },
    author: userJson(), committer: userJson(), parents: parents.map((p) => ({ sha: p })),
    url: `/api/v3/repos/${r.owner}/${r.name}/commits/${oid}`, html_url: `/api/v3/repos/${r.owner}/${r.name}/commit/${oid}`,
  };
}

// -------------------------------------------------------------------------------- HTTP helpers
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = { 'x-github-request-id': `req-${++reqCounter}`, ...extra };
  if (status !== 204) { headers['content-type'] = 'application/json; charset=utf-8'; headers['content-length'] = String(Buffer.byteLength(text)); }
  res.writeHead(status, headers);
  res.end(text);
}
function sendJsonText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), 'x-github-request-id': `req-${++reqCounter}` });
  res.end(text);
}
function issueText(r: Repo, i: Issue): string {
  const cached = r.issueTextCache.get(i.number);
  if (cached !== undefined) return cached;
  const text = `${JSON.stringify(issueJson(r, i))}\n`;
  r.issueTextCache.set(i.number, text);
  return text;
}
function sendErr(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(raw.toString('utf8')) }; }
  catch { return { ok: false }; }
}
function authed(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const h = req.headers.authorization ?? '';
  return h === `Bearer ${TOKEN}`;
}
function seg(path: string): string[] {
  return path.split('/').filter((s) => s !== '').map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
}
function absUrl(req: IncomingMessage, path: string, query: Record<string, string | number>): string {
  const host = req.headers.host ?? 'localhost';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) qs.set(k, String(v));
  return `http://${host}${path}?${qs.toString()}`;
}
function paginate<T>(req: IncomingMessage, res: ServerResponse, items: T[], query: URLSearchParams, path: string): T[] {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const links: string[] = [];
  if (page < pages) links.push(`<${absUrl(req, path, { per_page: perPage, page: page + 1 })}>; rel="next"`);
  if (pages > 1) links.push(`<${absUrl(req, path, { per_page: perPage, page: pages })}>; rel="last"`);
  if (page > 1) links.push(`<${absUrl(req, path, { per_page: perPage, page: 1 })}>; rel="first"`);
  if (links.length) res.setHeader('link', links.join(', '));
  return slice;
}

// -------------------------------------------------------------------------------- REST v3
function dirTreeOid(r: Repo, prefix: string): string {
  // Compute the tree oid of the directory at prefix from the tip's flat file map.
  const tip = r.refs.get(`refs/heads/${r.defaultBranch}`);
  const files = tip ? flatFiles(r, tip) : new Map<string, Buffer>();
  const build = (pre: string): string => {
    const entries: TreeEntry[] = [];
    const seen = new Set<string>();
    for (const path of files.keys()) {
      if (!path.startsWith(pre)) continue;
      const rest = path.slice(pre.length);
      const slash = rest.indexOf('/');
      const first = slash < 0 ? rest : rest.slice(0, slash);
      if (seen.has(first)) continue;
      seen.add(first);
      if (slash < 0) entries.push({ mode: '100644', name: first, oid: putObject(gitStoreOf(r), 'blob', files.get(path)!) });
      else entries.push({ mode: '40000', name: first, oid: build(`${pre}${first}/`) });
    }
    return putObject(gitStoreOf(r), 'tree', buildTree(entries));
  };
  return build(prefix);
}

async function handleRest(req: IncomingMessage, res: ServerResponse, parts: string[], query: URLSearchParams): Promise<boolean> {
  const method = req.method ?? 'GET';
  const bodyRaw = (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') ? await readBody(req) : Buffer.alloc(0);
  const parsed = parseJsonBody(bodyRaw);
  if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return true; }
  const body = (parsed.value ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => typeof v === 'string' ? v : '';
  const num = (v: unknown): number | undefined => typeof v === 'number' ? v : undefined;

  if (parts.length === 0) {
    if (method !== 'GET') { sendErr(res, 404, 'Not Found'); return true; }
    sendJson(res, 200, { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (parts[0] === 'meta' && parts.length === 1 && method === 'GET') { sendJson(res, 200, { installed_version: '1.0.0' }); return true; }
  if (parts[0] === 'user' && parts.length === 1 && method === 'GET') { sendJson(res, 200, userJson()); return true; }
  if (parts[0] === 'user' && parts[1] === 'repos') {
    if (method === 'GET') {
      const all = [...repos.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map((r) => repoJson(r));
      sendJson(res, 200, paginate(req, res, all, query, '/api/v3/user/repos'));
      return true;
    }
    if (method === 'POST') {
      const name = str(body.name);
      if (!name) { sendErr(res, 422, 'name is required'); return true; }
      if (repos.has(repoKey(VIEWER, name))) { sendErr(res, 422, 'Repository already exists'); return true; }
      const r = newRepo(name, body.private === true, str(body.description));
      sendJson(res, 201, repoJson(r));
      return true;
    }
    sendErr(res, 404, 'Not Found'); return true;
  }
  if (parts[0] !== 'repos' || parts.length < 3) { sendErr(res, 404, 'Not Found'); return true; }
  const owner = parts[1]!; const repoName = parts[2]!;
  const r = getRepo(owner, repoName);
  if (!r) { sendErr(res, 404, 'Not Found'); return true; }
  const rest = parts.slice(3);

  // ---- /repos/{o}/{r} itself
  if (rest.length === 0) {
    if (method === 'GET') { sendJson(res, 200, repoJson(r)); return true; }
    if (method === 'PATCH') {
      if (typeof body.description === 'string') r.description = body.description;
      if (typeof body.private === 'boolean') r.isPrivate = body.private;
      sendJson(res, 200, repoJson(r)); return true;
    }
    if (method === 'DELETE') { repos.delete(repoKey(owner, repoName)); sendJson(res, 204, null); return true; }
    sendErr(res, 404, 'Not Found'); return true;
  }

  // ---- branches
  if (rest[0] === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const list = [...r.refs.entries()].filter(([n]) => n.startsWith('refs/heads/')).map(([n, sha]) => ({ name: n.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false }));
      sendJson(res, 200, list); return true;
    }
    if (method === 'GET' && rest.length === 2) {
      const sha = r.refs.get(`refs/heads/${rest[1]}`);
      if (!sha) { sendErr(res, 404, 'Branch not found'); return true; }
      sendJson(res, 200, { name: rest[1], commit: { sha, url: '' }, protected: false }); return true;
    }
  }
  // ---- commits
  if (rest[0] === 'commits' && method === 'GET' && rest.length === 1) {
    const shaParam = query.get('sha');
    let tip: string | undefined;
    if (shaParam) tip = r.refs.get(`refs/heads/${shaParam}`) ?? (isObjectId(shaParam) ? shaParam : undefined);
    else tip = r.refs.get(`refs/heads/${r.defaultBranch}`);
    if (!tip || !r.objects.has(tip)) { sendJson(res, 200, []); return true; }
    sendJson(res, 200, listCommits(r, tip).map((o) => commitJson(r, o))); return true;
  }
  // ---- git refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
      const sha = r.refs.get(`refs/heads/${rest[3]}`);
      if (!sha) { sendErr(res, 404, 'Not Found'); return true; }
      sendJson(res, 200, { ref: `refs/heads/${rest[3]}`, node_id: gid('REF', `refs/heads/${rest[3]}`), object: { sha, type: 'commit', url: '' }, url: '' }); return true;
    }
    if (method === 'POST' && rest.length === 2) {
      const ref = str(body.ref); const sha = str(body.sha);
      if (!ref.startsWith('refs/heads/') || !isObjectId(sha) || !r.objects.has(sha)) { sendErr(res, 422, 'Invalid ref or sha'); return true; }
      if (r.refs.has(ref)) { sendErr(res, 422, 'Reference already exists'); return true; }
      r.refs.set(ref, sha);
      r.git.packCache?.clear();
      sendJson(res, 201, { ref, node_id: gid('REF', ref), object: { sha, type: 'commit', url: '' }, url: '' }); return true;
    }
  }
  // ---- contents
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    const branch = str(body.branch) || query.get('ref') || r.defaultBranch;
    const tip = r.refs.get(`refs/heads/${branch}`);
    if (method === 'GET') {
      if (!tip) { sendErr(res, 404, 'Not Found'); return true; }
      const files = flatFiles(r, tip);
      if (files.has(path)) {
        const data = files.get(path)!;
        const oid = hashObject('blob', data);
        sendJson(res, 200, { type: 'file', encoding: 'base64', size: data.length, name: path.split('/').pop(), path, content: data.toString('base64'), sha: oid, url: '', git_url: '', html_url: '', download_url: '' });
        return true;
      }
      const prefix = path ? `${path}/` : '';
      const children = new Map<string, { type: string; oid: string }>();
      for (const p of files.keys()) {
        if (!p.startsWith(prefix)) continue;
        const restPath = p.slice(prefix.length);
        const slash = restPath.indexOf('/');
        if (slash < 0) children.set(restPath, { type: 'file', oid: hashObject('blob', files.get(p)!) });
        else children.set(restPath.slice(0, slash), { type: 'dir', oid: dirTreeOid(r, `${prefix}${restPath.slice(0, slash)}/`) });
      }
      if (!children.size) { sendErr(res, 404, 'Not Found'); return true; }
      const list = [...children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, c]) => ({ type: c.type, name, path: `${prefix}${name}`, sha: c.oid, size: 0, url: '', git_url: '', html_url: '', download_url: '' }));
      sendJson(res, 200, list); return true;
    }
    if (method === 'PUT') {
      const contentB64 = str(body.content);
      if (!contentB64) { sendErr(res, 422, 'content is required'); return true; }
      const data = Buffer.from(contentB64, 'base64');
      const files = tip ? new Map(flatFiles(r, tip)) : new Map<string, Buffer>();
      const exists = files.has(path);
      if (exists) {
        const curOid = hashObject('blob', files.get(path)!);
        if (str(body.sha) !== curOid) { sendErr(res, 409, 'sha does not match'); return true; }
      } else if (body.sha) { sendErr(res, 422, 'sha does not match a file'); return true; }
      files.set(path, data);
      const sha = makeCommit(r, files, tip ? [tip] : [], str(body.message) || (exists ? `Update ${path}` : `Create ${path}`));
      r.refs.set(`refs/heads/${branch}`, sha);
      sendJson(res, exists ? 200 : 201, {
        content: { name: path.split('/').pop(), path, sha: hashObject('blob', data), size: data.length, type: 'file', encoding: 'base64' },
        commit: { sha, message: str(body.message) || '' },
      });
      return true;
    }
    if (method === 'DELETE') {
      if (!tip) { sendErr(res, 404, 'Not Found'); return true; }
      const files = new Map(flatFiles(r, tip));
      if (!files.has(path)) { sendErr(res, 404, 'Not Found'); return true; }
      if (str(body.sha) !== hashObject('blob', files.get(path)!)) { sendErr(res, 409, 'sha does not match'); return true; }
      files.delete(path);
      const sha = makeCommit(r, files, [tip], str(body.message) || `Delete ${path}`);
      r.refs.set(`refs/heads/${branch}`, sha);
      sendJson(res, 200, { commit: { sha, message: str(body.message) || '' } });
      return true;
    }
  }
  // ---- labels
  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) { sendJson(res, 200, [...r.labels.values()].map((l) => labelJson(l))); return true; }
    if (method === 'POST' && rest.length === 1) {
      const name = str(body.name);
      if (!name) { sendErr(res, 422, 'name is required'); return true; }
      if (r.labels.has(name)) { sendErr(res, 422, 'Label already exists'); return true; }
      const label = { name, color: str(body.color) || 'ededed', id: ++dbIdCounter };
      r.labels.set(name, label);
      sendJson(res, 201, labelJson(label)); return true;
    }
  }
  // ---- issues
  if (rest[0] === 'issues') {
    const n = rest[1] ? Number(rest[1]) : NaN;
    if (rest.length === 1) {
      if (method === 'POST') {
        const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).map((x) => String(x)) : [];
        for (const l of labels) if (!r.labels.has(l)) { sendErr(res, 422, `Label '${l}' does not exist`); return true; }
        const number = r.nextNumber++;
        const issue: Issue = { number, id: ++dbIdCounter, title: str(body.title), body: str(body.body), state: 'open', labels, comments: [], seq: number };
        r.issues.set(number, issue);
        sendJson(res, 201, issueJson(r, issue)); return true;
      }
      if (method === 'GET') {
        let list = [...r.issues.values()];
        const state = query.get('state') ?? 'open';
        if (state !== 'all') list = list.filter((i) => i.state === state);
        const dir = query.get('direction') ?? 'desc';
        list.sort((a, b) => (dir === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        sendJson(res, 200, paginate(req, res, list.map((i) => issueJson(r, i)), query, `/api/v3/repos/${owner}/${repoName}/issues`));
        return true;
      }
    }
    if (Number.isInteger(n) && rest.length === 2) {
      const issue = r.issues.get(n);
      if (!issue) { sendErr(res, 404, 'Not Found'); return true; }
      if (method === 'GET') { sendJsonText(res, 200, issueText(r, issue)); return true; }
      if (method === 'PATCH') {
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (Array.isArray(body.labels)) issue.labels = (body.labels as unknown[]).map((x) => String(x));
        r.issueTextCache.delete(n);
        sendJson(res, 200, issueJson(r, issue)); return true;
      }
    }
    if (Number.isInteger(n) && rest.length === 3 && rest[2] === 'comments') {
      const issue = r.issues.get(n);
      if (!issue) { sendErr(res, 404, 'Not Found'); return true; }
      if (method === 'POST') {
        const c = { id: r.nextCommentId++, body: str(body.body) };
        issue.comments.push(c);
        r.issueTextCache.delete(n);
        sendJson(res, 201, { id: c.id, node_id: gid('C', `${owner}/${repoName}:${n}:${c.id}`), body: c.body, user: userJson(), created_at: FIXED_ISO, updated_at: FIXED_ISO, html_url: '', url: '', issue_url: '' });
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, node_id: gid('C', `${owner}/${repoName}:${n}:${c.id}`), body: c.body, user: userJson(), created_at: FIXED_ISO, updated_at: FIXED_ISO, html_url: '', url: '', issue_url: '' })));
        return true;
      }
    }
  }
  // ---- pulls
  if (rest[0] === 'pulls') {
    const n = rest[1] ? Number(rest[1]) : NaN;
    if (rest.length === 1) {
      if (method === 'POST') {
        const pr = createPR(r, str(body.title), str(body.body), str(body.head), str(body.base));
        if ('error' in pr) { sendErr(res, 422, pr.error); return true; }
        sendJson(res, 201, prJson(r, pr)); return true;
      }
      if (method === 'GET') {
        let list = [...r.pulls.values()];
        const state = query.get('state') ?? 'open';
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((a, b) => b.seq - a.seq);
        sendJson(res, 200, paginate(req, res, list.map((p) => prJson(r, p)), query, `/api/v3/repos/${owner}/${repoName}/pulls`));
        return true;
      }
    }
    if (Number.isInteger(n) && rest.length === 2 && method === 'GET') {
      const pr = r.pulls.get(n);
      if (!pr) { sendErr(res, 404, 'Not Found'); return true; }
      sendJson(res, 200, prJson(r, pr)); return true;
    }
    if (Number.isInteger(n) && rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      const pr = r.pulls.get(n);
      if (!pr) { sendErr(res, 404, 'Not Found'); return true; }
      sendJson(res, 200, pr.files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes })));
      return true;
    }
    if (Number.isInteger(n) && rest.length === 3 && rest[2] === 'commits' && method === 'GET') {
      const pr = r.pulls.get(n);
      if (!pr) { sendErr(res, 404, 'Not Found'); return true; }
      const baseReach = collectReachable([pr.baseSha], (o) => r.objects.get(o), true);
      const commits = listCommits(r, pr.headSha).filter((o) => !baseReach.has(o));
      sendJson(res, 200, commits.map((o) => commitJson(r, o))); return true;
    }
    if (Number.isInteger(n) && rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      const pr = r.pulls.get(n);
      if (!pr) { sendErr(res, 404, 'Not Found'); return true; }
      if (pr.merged) { sendJson(res, 200, { sha: pr.merge_commit_sha, merged: true, message: 'Merged' }); return true; }
      if (pr.state !== 'open') { sendErr(res, 405, 'Pull request is not open'); return true; }
      if (prConflict(r, pr)) { sendErr(res, 405, 'Merge conflict'); return true; }
      const sha = doMerge(r, pr);
      if (!sha) { sendErr(res, 405, 'Merge conflict'); return true; }
      sendJson(res, 200, { sha, merged: true, message: `Pull request #${pr.number} merged` });
      return true;
    }
  }
  sendErr(res, 404, 'Not Found');
  return true;
}

// -------------------------------------------------------------------------------- git smart HTTP
async function handleGit(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, tail: string[]): Promise<boolean> {
  const method = req.method ?? 'GET';
  const r = getRepo(owner, repoName);
  const url = new URL(req.url ?? '/', 'http://x');
  const service = url.searchParams.get('service');
  const sendGitErr = (status: number, message: string): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'x-github-request-id': `req-${++reqCounter}` });
    res.end(JSON.stringify({ message }));
  };
  if (tail[0] === 'info' && tail[1] === 'refs' && method === 'GET') {
    if (!r) { sendGitErr(404, 'Not Found'); return true; }
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { sendGitErr(400, 'service required'); return true; }
    const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    const body = advertisement(gitStoreOf(r), service, v2);
    const ct = service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
    res.writeHead(200, { 'content-type': ct, 'content-length': String(body.length), 'x-github-request-id': `req-${++reqCounter}` });
    res.end(body);
    return true;
  }
  if (tail[0] === 'git-upload-pack' && method === 'POST') {
    if (!r) { sendGitErr(404, 'Not Found'); return true; }
    const raw = await readBody(req);
    const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    let out: Buffer;
    try {
      if (v2 && raw.length >= 4 && raw.subarray(0, 4).toString('ascii') === '0000') {
        // v2 ls-refs request is sent to this endpoint by some clients; detect by content.
        const pkts = raw.subarray(0, 200).toString('utf8');
        void pkts;
      }
      if (v2) {
        // Distinguish ls-refs (command=ls-refs) from fetch (command=fetch).
        const text = raw.toString('utf8');
        if (text.includes('command=ls-refs')) out = lsRefsResponse(gitStoreOf(r), parseLsRefs(raw));
        else out = handleUploadPack(gitStoreOf(r), raw, true);
      } else out = handleUploadPack(gitStoreOf(r), raw, false);
    } catch { sendGitErr(400, 'Bad request'); return true; }
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': String(out.length), 'x-github-request-id': `req-${++reqCounter}` });
    res.end(out);
    return true;
  }
  if (tail[0] === 'git-receive-pack' && method === 'POST') {
    if (!r) { sendGitErr(404, 'Not Found'); return true; }
    const raw = await readBody(req);
    let out: Buffer;
    try { out = handleReceivePack(gitStoreOf(r), raw); }
    catch { sendGitErr(400, 'Bad request'); return true; }
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': String(out.length), 'x-github-request-id': `req-${++reqCounter}` });
    res.end(out);
    return true;
  }
  sendGitErr(404, 'Not Found');
  return true;
}

// -------------------------------------------------------------------------------- GraphQL
type GValue =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int' | 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; value: GValue[] }
  | { kind: 'object'; value: Map<string, GValue> };
interface GSel { alias?: string; name: string; args: Map<string, GValue>; children?: GSel[]; inlineType?: string; frag?: string; }
interface GFrag { typeCond: string; children: GSel[]; }
interface GOp { kind: 'query' | 'mutation'; name?: string; vars: Map<string, { type: string; def?: GValue }>; children: GSel[]; }
interface GDoc { ops: GOp[]; frags: Map<string, GFrag>; }

type Tok = { t: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread'; v: string };
function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '.' && src.slice(i, i + 3) === '...') { toks.push({ t: 'spread', v: '...' }); i += 3; continue; }
    if ('{}()[]:!=$@'.includes(c)) { toks.push({ t: 'punct', v: c }); i++; continue; }
    if (c === '"') {
      let j = i + 1; let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1]!;
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === '"' ? '"' : e === '\\' ? '\\' : e === '/' ? '/' : e === 'u' ? String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)) : e;
          j += e === 'u' ? 6 : 2;
        } else { out += src[j]; j++; }
      }
      toks.push({ t: 'string', v: out }); i = j + 1; continue;
    }
    if (/[0-9-]/.test(c) && (c !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i; let isFloat = false;
      if (src[j] === '-') j++;
      while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      if (src[j] === '.') { isFloat = true; j++; while (j < src.length && /[0-9]/.test(src[j]!)) j++; }
      if (src[j] === 'e' || src[j] === 'E') { isFloat = true; j++; if (src[j] === '+' || src[j] === '-') j++; while (j < src.length && /[0-9]/.test(src[j]!)) j++; }
      toks.push({ t: isFloat ? 'float' : 'int', v: src.slice(i, j) }); i = j; continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < src.length && /[_A-Za-z0-9]/.test(src[j]!)) j++;
      toks.push({ t: 'name', v: src.slice(i, j) }); i = j; continue;
    }
    throw new Error(`graphql: unexpected char ${c}`);
  }
  return toks;
}
class GParser {
  private pos = 0;
  private readonly toks: Tok[];
  constructor(toks: Tok[]) { this.toks = toks; }
  peek(): Tok | undefined { return this.toks[this.pos]; }
  next(): Tok { const t = this.toks[this.pos++]; if (!t) throw new Error('graphql: unexpected end'); return t; }
  expect(v: string): Tok { const t = this.next(); if (t.v !== v) throw new Error(`graphql: expected ${v}, got ${t.v}`); return t; }
  parseDocument(): GDoc {
    const doc: GDoc = { ops: [], frags: new Map() };
    while (this.pos < this.toks.length) {
      const t = this.peek()!;
      if (t.t === 'punct' && t.v === '{') { doc.ops.push({ kind: 'query', vars: new Map(), children: this.parseSelectionSet() }); continue; }
      if (t.t === 'name' && (t.v === 'query' || t.v === 'mutation')) {
        const kind = this.next().v as 'query' | 'mutation';
        let name: string | undefined;
        if (this.peek()?.t === 'name') name = this.next().v;
        const vars = new Map<string, { type: string; def?: GValue }>();
        if (this.peek()?.v === '(') {
          this.next();
          while (this.peek()?.v !== ')') {
            this.expect('$');
            const vn = this.next().v;
            this.expect(':');
            const type = this.parseType();
            let def: GValue | undefined;
            if (this.peek()?.v === '=') { this.next(); def = this.parseValue(); }
            vars.set(vn, { type, def });
          }
          this.expect(')');
        }
        // directives
        while (this.peek()?.v === '@') { this.next(); this.next(); if (this.peek()?.v === '(') this.skipParens(); }
        doc.ops.push({ kind, name, vars, children: this.parseSelectionSet() });
        continue;
      }
      if (t.t === 'name' && t.v === 'fragment') {
        this.next();
        const name = this.next().v;
        this.expect('on');
        const typeCond = this.next().v;
        while (this.peek()?.v === '@') { this.next(); this.next(); if (this.peek()?.v === '(') this.skipParens(); }
        doc.frags.set(name, { typeCond, children: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`graphql: unexpected token ${t.v}`);
    }
    return doc;
  }
  private skipParens(): void {
    let depth = 0;
    while (this.pos < this.toks.length) {
      const t = this.next();
      if (t.v === '(') depth++;
      else if (t.v === ')') { depth--; if (depth === 0) return; }
    }
  }
  private parseType(): string {
    let type = '';
    if (this.peek()?.v === '[') { this.next(); type = `[${this.parseType()}]`; }
    else type = this.next().v;
    if (this.peek()?.v === '!') { this.next(); type += '!'; }
    return type;
  }
  private parseSelectionSet(): GSel[] {
    this.expect('{');
    const sels: GSel[] = [];
    while (this.peek()?.v !== '}') {
      if (this.peek()?.t === 'spread') {
        this.next();
        if (this.peek()?.t === 'name' && this.peek()!.v === 'on') {
          this.next();
          const typeCond = this.next().v;
          while (this.peek()?.v === '@') { this.next(); this.next(); if (this.peek()?.v === '(') this.skipParens(); }
          sels.push({ name: '__inline', args: new Map(), children: this.parseSelectionSet(), inlineType: typeCond });
        } else {
          const name = this.next().v;
          while (this.peek()?.v === '@') { this.next(); this.next(); if (this.peek()?.v === '(') this.skipParens(); }
          sels.push({ name: '__spread', args: new Map(), frag: name });
        }
        continue;
      }
      const first = this.next();
      if (first.t !== 'name') throw new Error('graphql: expected field name');
      let alias: string | undefined; let name = first.v;
      if (this.peek()?.v === ':') { this.next(); alias = name; name = this.next().v; }
      const args = new Map<string, GValue>();
      if (this.peek()?.v === '(') {
        this.next();
        while (this.peek()?.v !== ')') {
          const an = this.next().v;
          this.expect(':');
          args.set(an, this.parseValue());
        }
        this.expect(')');
      }
      while (this.peek()?.v === '@') { this.next(); this.next(); if (this.peek()?.v === '(') this.skipParens(); }
      const children = this.peek()?.v === '{' ? this.parseSelectionSet() : undefined;
      sels.push({ alias, name, args, children });
    }
    this.expect('}');
    return sels;
  }
  private parseValue(): GValue {
    const t = this.next();
    if (t.t === 'string') return { kind: 'string', value: t.v };
    if (t.t === 'int' || t.t === 'float') return { kind: t.t, value: Number(t.v) };
    if (t.t === 'name') {
      if (t.v === 'true') return { kind: 'bool', value: true };
      if (t.v === 'false') return { kind: 'bool', value: false };
      if (t.v === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.v };
    }
    if (t.v === '$') return { kind: 'var', name: this.next().v };
    if (t.v === '[') {
      const items: GValue[] = [];
      while (this.peek()?.v !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', value: items };
    }
    if (t.v === '{') {
      const fields = new Map<string, GValue>();
      while (this.peek()?.v !== '}') {
        const fn = this.next().v;
        this.expect(':');
        fields.set(fn, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', value: fields };
    }
    throw new Error(`graphql: unexpected value ${t.v}`);
  }
}

const GQL_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'createdAt', 'updatedAt', 'description', 'isPrivate'],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'url', 'createdAt', 'updatedAt', 'comments'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'author', 'url', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  User: ['login', 'id', 'databaseId', 'name', 'email', 'avatarUrl'],
  Ref: ['name', 'target', 'prefix'],
  Commit: ['oid', 'message', 'abbreviatedOid'],
  IssueComment: ['id', 'body', 'author'],
  IssueCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description', 'isDeprecated'],
  __Schema: ['queryType', 'mutationType', 'types'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};
const GQL_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['CONFLICTING', 'MERGEABLE', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

interface GWrap { __t: string; __v: unknown; }
function wrap(t: string, v: unknown): GWrap { return { __t: t, __v: v }; }
function isWrap(v: unknown): v is GWrap { return typeof v === 'object' && v !== null && '__t' in (v as Record<string, unknown>); }

function resolveGValue(v: GValue, vars: Map<string, unknown>): unknown {
  switch (v.kind) {
    case 'var': return vars.get(v.name) ?? null;
    case 'string': case 'int': case 'float': case 'bool': return v.value;
    case 'null': return null;
    case 'enum': return v.value;
    case 'list': return v.value.map((x) => resolveGValue(x, vars));
    case 'object': { const o: Record<string, unknown> = {}; for (const [k, x] of v.value) o[k] = resolveGValue(x, vars); return o; }
  }
}
function gArgs(sel: GSel, vars: Map<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of sel.args) o[k] = resolveGValue(v, vars);
  return o;
}
function cursorOf(n: number): string { return b64url(`cursor:${n}`); }
function cursorNum(c: unknown): number {
  if (typeof c !== 'string') return 0;
  const s = unb64url(c);
  const m = /^cursor:(\d+)$/.exec(s);
  return m ? Number(m[1]) : 0;
}
function pageInfoFor(total: number, shown: number, lastShown?: number, hasNext = false): Record<string, unknown> {
  return { hasNextPage: hasNext, hasPreviousPage: false, startCursor: shown ? cursorOf(1) : null, endCursor: lastShown !== undefined ? cursorOf(lastShown) : null };
}

class GQLError extends Error {}

/** Resolve one field on a wrapped object (or the Query/Mutation root). Returns a raw JS value or a wrap. */
function resolveGField(typeName: string, obj: unknown, sel: GSel, vars: Map<string, unknown>): unknown {
  const args = gArgs(sel, vars);
  const repoOf = (v: unknown): Repo => v as Repo;
  switch (typeName) {
    case 'Query': {
      if (sel.name === 'viewer') return wrap('User', null);
      if (sel.name === 'repository') {
        const r = getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return r ? wrap('Repository', r) : null;
      }
      if (sel.name === 'node') {
        const decoded = unb64url(String(args.id ?? ''));
        const m = /^([A-Z]):(.+)$/.exec(decoded);
        if (!m) return null;
        const kind = m[1]!; const key = m[2]!;
        if (kind === 'R') { const [o, n] = key.split('/'); const r = getRepo(o ?? '', n ?? ''); return r ? wrap('Repository', r) : null; }
        if (kind === 'I') { const mm = /^([^/]+)\/([^:]+):(\d+)$/.exec(key); if (!mm) return null; const r = getRepo(mm[1]!, mm[2]!); const i = r?.issues.get(Number(mm[3])); return i ? wrap('Issue', { repo: r!, issue: i }) : null; }
        if (kind === 'P') { const mm = /^([^/]+)\/([^:]+):(\d+)$/.exec(key); if (!mm) return null; const r = getRepo(mm[1]!, mm[2]!); const p = r?.pulls.get(Number(mm[3])); return p ? wrap('PullRequest', { repo: r!, pr: p }) : null; }
        if (kind === 'U') return wrap('User', null);
        return null;
      }
      if (sel.name === '__type') {
        const name = String(args.name ?? '');
        if (!GQL_FIELDS[name] && !GQL_ENUM_VALUES[name]) return null;
        return wrap('__Type', { name, isEnum: Boolean(GQL_ENUM_VALUES[name]) });
      }
      if (sel.name === '__schema') return wrap('__Schema', {});
      break;
    }
    case 'Mutation': {
      const input = (args.input ?? {}) as Record<string, unknown>;
      if (sel.name === 'createIssue') {
        const decoded = unb64url(String(input.repositoryId ?? ''));
        const m = /^R:(.+)$/.exec(decoded);
        if (!m) return wrap('CreateIssuePayload', { issue: null });
        const [o, n] = m[1]!.split('/');
        const r = getRepo(o ?? '', n ?? '');
        if (!r) return wrap('CreateIssuePayload', { issue: null });
        const number = r.nextNumber++;
        const issue: Issue = { number, id: ++dbIdCounter, title: String(input.title ?? ''), body: String(input.body ?? ''), state: 'open', labels: [], comments: [], seq: number };
        r.issues.set(number, issue);
        return wrap('CreateIssuePayload', { issue: wrap('Issue', { repo: r, issue }) });
      }
      if (sel.name === 'closeIssue') {
        const decoded = unb64url(String(input.issueId ?? ''));
        const m = /^I:([^/]+)\/([^:]+):(\d+)$/.exec(decoded);
        if (!m) return wrap('CloseIssuePayload', { issue: null });
        const r = getRepo(m[1]!, m[2]!);
        const issue = r?.issues.get(Number(m[3]));
        if (issue) { issue.state = 'closed'; r!.issueTextCache.delete(issue.number); }
        return wrap('CloseIssuePayload', { issue: issue ? wrap('Issue', { repo: r!, issue }) : null });
      }
      if (sel.name === 'createPullRequest') {
        const decoded = unb64url(String(input.repositoryId ?? ''));
        const m = /^R:(.+)$/.exec(decoded);
        if (!m) return wrap('CreatePullRequestPayload', { pullRequest: null });
        const [o, n] = m[1]!.split('/');
        const r = getRepo(o ?? '', n ?? '');
        if (!r) return wrap('CreatePullRequestPayload', { pullRequest: null });
        const pr = createPR(r, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
        if ('error' in pr) return wrap('CreatePullRequestPayload', { pullRequest: null });
        return wrap('CreatePullRequestPayload', { pullRequest: wrap('PullRequest', { repo: r, pr }) });
      }
      if (sel.name === 'mergePullRequest') {
        const decoded = unb64url(String(input.pullRequestId ?? ''));
        const m = /^P:([^/]+)\/([^:]+):(\d+)$/.exec(decoded);
        if (!m) return wrap('MergePullRequestPayload', { pullRequest: null });
        const r = getRepo(m[1]!, m[2]!);
        const pr = r?.pulls.get(Number(m[3]));
        if (pr && pr.state === 'open' && !prConflict(r!, pr)) doMerge(r!, pr);
        return wrap('MergePullRequestPayload', { pullRequest: pr ? wrap('PullRequest', { repo: r!, pr }) : null });
      }
      if (sel.name === 'addComment') {
        const decoded = unb64url(String(input.subjectId ?? ''));
        const m = /^I:([^/]+)\/([^:]+):(\d+)$/.exec(decoded);
        if (!m) return wrap('AddCommentPayload', { commentEdge: null });
        const r = getRepo(m[1]!, m[2]!);
        const issue = r?.issues.get(Number(m[3]));
        if (!issue) return wrap('AddCommentPayload', { commentEdge: null });
        const c = { id: r!.nextCommentId++, body: String(input.body ?? '') };
        issue.comments.push(c);
        r!.issueTextCache.delete(issue.number);
        return wrap('AddCommentPayload', { commentEdge: wrap('IssueCommentEdge', { node: wrap('IssueComment', { repo: r!, issue, comment: c }), cursor: cursorOf(c.id) }) });
      }
      break;
    }
    case 'Repository': {
      const r = repoOf(obj);
      switch (sel.name) {
        case 'id': return r.nodeId;
        case 'databaseId': return r.id;
        case 'name': return r.name;
        case 'nameWithOwner': return `${r.owner}/${r.name}`;
        case 'owner': return wrap('User', null);
        case 'defaultBranchRef': return wrap('Ref', { name: r.defaultBranch });
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'url': return `/${r.owner}/${r.name}`;
        case 'description': return r.description;
        case 'isPrivate': return r.isPrivate;
        case 'createdAt': case 'updatedAt': return FIXED_ISO;
        case 'issue': { const i = r.issues.get(Number(args.number)); return i ? wrap('Issue', { repo: r, issue: i }) : null; }
        case 'issues': {
          let list = [...r.issues.values()];
          const states = args.states as string[] | undefined;
          if (states?.length) list = list.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
          const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
          if (orderBy?.field === 'CREATED_AT') list.sort((a, b) => (orderBy.direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
          else list.sort((a, b) => a.seq - b.seq);
          const after = cursorNum(args.after);
          list = list.filter((i) => i.number > after);
          const total = list.length;
          const first = typeof args.first === 'number' ? args.first : total;
          const page = list.slice(0, first);
          const hasNext = list.length > first;
          return wrap('IssueConnection', { nodes: page.map((i) => wrap('Issue', { repo: r, issue: i })), pageInfo: pageInfoFor(total, page.length, page.length ? page[page.length - 1]!.number : undefined, hasNext), totalCount: total });
        }
        case 'pullRequests': {
          const list = [...r.pulls.values()].sort((a, b) => a.seq - b.seq);
          const first = typeof args.first === 'number' ? args.first : list.length;
          const page = list.slice(0, first);
          return wrap('PullRequestConnection', { nodes: page.map((p) => wrap('PullRequest', { repo: r, pr: p })), pageInfo: pageInfoFor(list.length, page.length, page.length ? page[page.length - 1]!.number : undefined, list.length > first), totalCount: list.length });
        }
        case 'pullRequest': { const p = r.pulls.get(Number(args.number)); return p ? wrap('PullRequest', { repo: r, pr: p }) : null; }
      }
      break;
    }
    case 'Issue': {
      const { repo, issue } = obj as { repo: Repo; issue: Issue };
      void repo;
      switch (sel.name) {
        case 'id': return gid('I', `${repo.owner}/${repo.name}:${issue.number}`);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'author': return wrap('User', null);
        case 'url': return `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`;
        case 'createdAt': case 'updatedAt': return FIXED_ISO;
        case 'comments': return wrap('IssueConnection', { nodes: [], pageInfo: pageInfoFor(0, 0), totalCount: 0 });
      }
      break;
    }
    case 'PullRequest': {
      const { repo, pr } = obj as { repo: Repo; pr: PR };
      switch (sel.name) {
        case 'id': return gid('P', `${repo.owner}/${repo.name}:${pr.number}`);
        case 'databaseId': return pr.id;
        case 'number': return pr.number;
        case 'title': return pr.title;
        case 'body': return pr.body;
        case 'state': return pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'headRefName': return pr.headRef;
        case 'baseRefName': return pr.baseRef;
        case 'mergeable': return prConflict(repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
        case 'merged': return pr.merged;
        case 'mergedAt': return pr.merged_at;
        case 'mergeCommit': return pr.merge_commit_sha ? wrap('Commit', { oid: pr.merge_commit_sha, message: '' }) : null;
        case 'author': return wrap('User', null);
        case 'url': return `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`;
        case 'createdAt': case 'updatedAt': return FIXED_ISO;
        case 'files': {
          const first = typeof args.first === 'number' ? args.first : pr.files.length;
          const page = pr.files.slice(0, first);
          return wrap('PullRequestChangedFileConnection', { nodes: page.map((f) => wrap('PullRequestChangedFile', f)), pageInfo: pageInfoFor(pr.files.length, page.length, undefined, pr.files.length > first), totalCount: pr.files.length });
        }
      }
      break;
    }
    case 'IssueConnection': case 'PullRequestConnection': case 'PullRequestChangedFileConnection': {
      const c = obj as { nodes: unknown[]; pageInfo: Record<string, unknown>; totalCount: number };
      if (sel.name === 'nodes') return c.nodes;
      if (sel.name === 'pageInfo') return wrap('PageInfo', c.pageInfo);
      if (sel.name === 'totalCount') return c.totalCount;
      break;
    }
    case 'PageInfo': {
      const p = obj as Record<string, unknown>;
      return p[sel.name] ?? null;
    }
    case 'PullRequestChangedFile': {
      const f = obj as PRFile;
      if (sel.name === 'path') return f.filename;
      if (sel.name === 'additions') return f.additions;
      if (sel.name === 'deletions') return f.deletions;
      if (sel.name === 'changeType') return f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'REMOVED' : 'MODIFIED';
      break;
    }
    case 'User': {
      if (sel.name === 'login') return VIEWER;
      if (sel.name === 'id') return gid('U', VIEWER);
      if (sel.name === 'databaseId') return VIEWER_ID;
      if (sel.name === 'name') return VIEWER_NAME;
      if (sel.name === 'email') return VIEWER_EMAIL;
      if (sel.name === 'avatarUrl') return '';
      break;
    }
    case 'Ref': {
      const rf = obj as { name: string };
      if (sel.name === 'name') return rf.name;
      if (sel.name === 'prefix') return 'refs/heads/';
      if (sel.name === 'target') return null;
      break;
    }
    case 'Commit': {
      const cm = obj as { oid: string; message: string };
      if (sel.name === 'oid') return cm.oid;
      if (sel.name === 'abbreviatedOid') return cm.oid.slice(0, 7);
      if (sel.name === 'message') return cm.message;
      break;
    }
    case 'IssueComment': {
      const cc = obj as { comment: { id: number; body: string } };
      if (sel.name === 'id') return gid('C', `c:${cc.comment.id}`);
      if (sel.name === 'body') return cc.comment.body;
      if (sel.name === 'author') return wrap('User', null);
      break;
    }
    case 'IssueCommentEdge': {
      const e = obj as { node: unknown; cursor: string };
      if (sel.name === 'node') return e.node;
      if (sel.name === 'cursor') return e.cursor;
      break;
    }
    case 'CreateIssuePayload': case 'CloseIssuePayload': {
      const p = obj as { issue: unknown };
      if (sel.name === 'issue') return p.issue;
      if (sel.name === 'clientMutationId') return null;
      break;
    }
    case 'CreatePullRequestPayload': case 'MergePullRequestPayload': {
      const p = obj as { pullRequest: unknown };
      if (sel.name === 'pullRequest') return p.pullRequest;
      if (sel.name === 'clientMutationId') return null;
      break;
    }
    case 'AddCommentPayload': {
      const p = obj as { commentEdge: unknown };
      if (sel.name === 'commentEdge') return p.commentEdge;
      if (sel.name === 'subject') return null;
      if (sel.name === 'clientMutationId') return null;
      break;
    }
    case '__Type': {
      const t = obj as { name: string; isEnum: boolean };
      if (sel.name === 'name') return t.name;
      if (sel.name === 'kind') return t.isEnum ? 'ENUM' : 'OBJECT';
      if (sel.name === 'description') return null;
      if (sel.name === 'fields') {
        if (t.isEnum) return null;
        return (GQL_FIELDS[t.name] ?? []).map((f) => wrap('__Field', { name: f }));
      }
      if (sel.name === 'enumValues') {
        if (!t.isEnum) return null;
        return (GQL_ENUM_VALUES[t.name] ?? []).map((n) => wrap('__EnumValue', { name: n }));
      }
      break;
    }
    case '__Field': {
      const f = obj as { name: string };
      if (sel.name === 'name') return f.name;
      if (sel.name === 'description') return null;
      if (sel.name === 'args') return [];
      if (sel.name === 'type') return wrap('__Type', { name: 'String', isEnum: false });
      break;
    }
    case '__EnumValue': {
      const e = obj as { name: string };
      if (sel.name === 'name') return e.name;
      if (sel.name === 'description') return null;
      if (sel.name === 'isDeprecated') return false;
      break;
    }
    case '__Schema': {
      if (sel.name === 'queryType') return wrap('__Type', { name: 'Query', isEnum: false });
      if (sel.name === 'mutationType') return wrap('__Type', { name: 'Mutation', isEnum: false });
      if (sel.name === 'types') return Object.keys(GQL_FIELDS).map((n) => wrap('__Type', { name: n, isEnum: Boolean(GQL_ENUM_VALUES[n]) }));
      break;
    }
    case '__InputValue': {
      const iv = obj as { name: string };
      if (sel.name === 'name') return iv.name;
      if (sel.name === 'description') return null;
      if (sel.name === 'type') return wrap('__Type', { name: 'String', isEnum: false });
      if (sel.name === 'defaultValue') return null;
      break;
    }
  }
  return undefined;
}

function projectValue(typeName: string, obj: unknown, sels: GSel[], vars: Map<string, unknown>, frags: Map<string, GFrag>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.name === '__inline') {
      if (sel.inlineType && sel.inlineType !== typeName && sel.inlineType !== 'Node') continue;
      Object.assign(out, projectValue(typeName, obj, sel.children ?? [], vars, frags));
      continue;
    }
    if (sel.name === '__spread') {
      const frag = frags.get(sel.frag ?? '');
      if (!frag) continue;
      if (frag.typeCond !== typeName && frag.typeCond !== 'Node') continue;
      Object.assign(out, projectValue(typeName, obj, frag.children, vars, frags));
      continue;
    }
    const allowed = GQL_FIELDS[typeName] ?? [];
    if (!allowed.includes(sel.name)) throw new GQLError(`Cannot query field "${sel.name}" on type "${typeName}".`);
    const key = sel.alias ?? sel.name;
    const raw = resolveGField(typeName, obj, sel, vars);
    if (raw === undefined) throw new GQLError(`Cannot query field "${sel.name}" on type "${typeName}".`);
    if (!sel.children) { out[key] = raw; continue; }
    if (raw === null) { out[key] = null; continue; }
    if (Array.isArray(raw)) {
      out[key] = raw.map((el) => {
        if (isWrap(el)) return projectValue(el.__t, el.__v, sel.children!, vars, frags);
        return el;
      });
      continue;
    }
    if (isWrap(raw)) out[key] = projectValue(raw.__t, raw.__v, sel.children, vars, frags);
    else out[key] = raw;
  }
  return out;
}

function runGraphQL(doc: GDoc, body: Record<string, unknown>): { data: unknown; errors?: Array<{ message: string }> } {
  const opName = typeof body.operationName === 'string' ? body.operationName : undefined;
  const op = opName ? doc.ops.find((o) => o.name === opName) : doc.ops[0];
  if (!op) return { data: null, errors: [{ message: 'Unknown operation' }] };
  const vars = new Map<string, unknown>();
  const provided = (body.variables ?? {}) as Record<string, unknown>;
  for (const [name, def] of op.vars) {
    if (name in provided) vars.set(name, provided[name]);
    else if (def.def) vars.set(name, resolveGValue(def.def, vars));
    else vars.set(name, null);
  }
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  try {
    const data = projectValue(rootType, null, op.children, vars, doc.frags);
    return { data };
  } catch (e) {
    if (e instanceof GQLError) return { data: null, errors: [{ message: e.message }] };
    throw e;
  }
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return; }
  const payload = parsed.value;
  try {
    if (Array.isArray(payload)) {
      const out: unknown[] = [];
      for (const item of payload) {
        const query = String((item as Record<string, unknown>).query ?? '');
        const doc = new GParser(tokenize(query)).parseDocument();
        out.push(runGraphQL(doc, item as Record<string, unknown>));
      }
      sendJson(res, 200, out);
      return;
    }
    const query = String((payload as Record<string, unknown>).query ?? '');
    const doc = new GParser(tokenize(query)).parseDocument();
    sendJson(res, 200, runGraphQL(doc, payload as Record<string, unknown>));
  } catch {
    sendJson(res, 200, { data: null, errors: [{ message: 'GraphQL parse error' }] });
  }
}

// -------------------------------------------------------------------------------- MCP
const MCP_TOOLS: Array<Record<string, unknown>> = [
  { name: 'create_repo', description: 'Create a new repository', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', description: 'Issue state: open, closed, or all' } }, required: ['owner', 'repo'] } },
  { name: 'get_issue', description: 'Get an issue by number', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'number', description: 'Issue number' } }, required: ['owner', 'repo', 'issue_number'] } },
  { name: 'create_pull_request', description: 'Create a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string', description: 'Pull request title' }, head: { type: 'string', description: 'Head branch' }, base: { type: 'string', description: 'Base branch' }, body: { type: 'string', description: 'Pull request body' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'list_pull_requests', description: 'List pull requests in a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', description: 'Pull request state' } }, required: ['owner', 'repo'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] } },
];

function mcpToolResult(obj: Record<string, unknown>, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj, isError };
}
function mcpCallTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) return { __rpcError: -32602, __message: `Unknown tool: ${name}` };
  const required = (tool.inputSchema as { required?: string[] }).required ?? [];
  for (const req of required) {
    if (args[req] === undefined || args[req] === null || args[req] === '') return mcpToolResult({ error: `Missing required argument: ${req}` }, true);
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (repos.has(repoKey(VIEWER, repoName))) return mcpToolResult({ error: 'Repository already exists' }, true);
      const r = newRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
      return mcpToolResult(repoJson(r));
    }
    case 'get_repo': {
      const r = getRepo(String(args.owner), String(args.repo));
      if (!r) return mcpToolResult({ error: 'Not Found' }, true);
      return mcpToolResult(repoJson(r));
    }
    case 'create_issue': {
      const r = getRepo(String(args.owner), String(args.repo));
      if (!r) return mcpToolResult({ error: 'Not Found' }, true);
      const number = r.nextNumber++;
      const issue: Issue = { number, id: ++dbIdCounter, title: String(args.title), body: typeof args.body === 'string' ? args.body : '', state: 'open', labels: [], comments: [], seq: number };
      r.issues.set(number, issue);
      return mcpToolResult(issueJson(r, issue));
    }
    case 'list_issues': {
      const r = getRepo(String(args.owner), String(args.repo));
      if (!r) return mcpToolResult({ error: 'Not Found' }, true);
      let list = [...r.issues.values()];
      const state = typeof args.state === 'string' ? args.state : 'open';
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => a.seq - b.seq);
      return mcpToolResult({ issues: list.map((i) => issueJson(r, i)), total_count: list.length });
    }
    case 'get_issue': {
      const r = getRepo(String(args.owner), String(args.repo));
      const issue = r?.issues.get(Number(args.issue_number));
      if (!issue || !r) return mcpToolResult({ error: 'Not Found' }, true);
      return mcpToolResult(issueJson(r, issue));
    }
    case 'create_pull_request': {
      const r = getRepo(String(args.owner), String(args.repo));
      if (!r) return mcpToolResult({ error: 'Not Found' }, true);
      const pr = createPR(r, String(args.title), typeof args.body === 'string' ? args.body : '', String(args.head), String(args.base));
      if ('error' in pr) return mcpToolResult({ error: pr.error }, true);
      return mcpToolResult(prJson(r, pr));
    }
    case 'list_pull_requests': {
      const r = getRepo(String(args.owner), String(args.repo));
      if (!r) return mcpToolResult({ error: 'Not Found' }, true);
      let list = [...r.pulls.values()];
      const state = typeof args.state === 'string' ? args.state : 'open';
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => a.seq - b.seq);
      return mcpToolResult({ pull_requests: list.map((p) => prJson(r, p)), total_count: list.length });
    }
    case 'merge_pull_request': {
      const r = getRepo(String(args.owner), String(args.repo));
      const pr = r?.pulls.get(Number(args.pull_number));
      if (!pr || !r) return mcpToolResult({ error: 'Not Found' }, true);
      if (pr.merged) return mcpToolResult({ sha: pr.merge_commit_sha, merged: true, message: 'Merged' });
      if (pr.state !== 'open') return mcpToolResult({ error: 'Pull request is not open' }, true);
      if (prConflict(r, pr)) return mcpToolResult({ error: 'Merge conflict' }, true);
      const sha = doMerge(r, pr);
      if (!sha) return mcpToolResult({ error: 'Merge conflict' }, true);
      return mcpToolResult({ sha, merged: true, message: `Pull request #${pr.number} merged` });
    }
  }
  return mcpToolResult({ error: 'Unknown tool' }, true);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const msg = parsed.value as Record<string, unknown>;
  const id = msg.id ?? null;
  const method = String(msg.method ?? '');
  const reply = (status: number, payload: unknown): void => sendJson(res, status, payload);
  if (method.startsWith('notifications/')) { res.writeHead(202, { 'x-github-request-id': `req-${++reqCounter}` }); res.end(); return; }
  switch (method) {
    case 'server/discover':
      reply(200, { jsonrpc: '2.0', id, result: { supportedVersions: ['2026-07-28', '2025-06-18'], capabilities: { tools: {} }, serverInfo: { name: 'github-forge', version: '1.0.0' }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'github-forge', version: '1.0.0' } } } });
      return;
    case 'initialize': {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      reply(200, { jsonrpc: '2.0', id, result: { protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28', capabilities: { tools: {} }, serverInfo: { name: 'github-forge', version: '1.0.0' } } });
      return;
    }
    case 'ping':
      reply(200, { jsonrpc: '2.0', id, result: {} });
      return;
    case 'tools/list':
      reply(200, { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
      return;
    case 'tools/call': {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const result = mcpCallTool(String(params.name ?? ''), (params.arguments ?? {}) as Record<string, unknown>);
      if ('__rpcError' in result) {
        reply(200, { jsonrpc: '2.0', id, error: { code: result.__rpcError, message: String(result.__message ?? 'Unknown tool') } });
        return;
      }
      reply(200, { jsonrpc: '2.0', id, result });
      return;
    }
    default:
      reply(200, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
  }
}

// -------------------------------------------------------------------------------- router
export function createApp(): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://x');
        const path = url.pathname;
        if (path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
        if (path.startsWith('/api/v3')) {
          if (!authed(req)) { sendErr(res, 401, 'Bad credentials'); return; }
          const rest = path.slice('/api/v3'.length);
          await handleRest(req, res, seg(rest), url.searchParams);
          return;
        }
        if (path === '/api/graphql') {
          if (!authed(req)) { sendErr(res, 401, 'Bad credentials'); return; }
          await handleGraphQL(req, res);
          return;
        }
        if (path === '/mcp') {
          if (!authed(req)) { sendErr(res, 401, 'Bad credentials'); return; }
          await handleMcp(req, res);
          return;
        }
        const gm = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gm) {
          await handleGit(req, res, gm[1]!, gm[2]!, seg(gm[3] ?? ''));
          return;
        }
        sendErr(res, 404, 'Not Found');
      } catch (err) {
        if (!res.headersSent) sendErr(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        else res.end();
      }
    })();
  });
  // Small responses on a keep-alive connection: disable Nagle so each reply goes out at once.
  server.on('connection', (socket) => socket.setNoDelay(true));
  return server;
}
