// git.ts — git object model, packfile read/write, pkt-line codec and smart-HTTP
// protocol (upload-pack v2/v0, receive-pack v0). Stdlib only (node:crypto, node:zlib).
// Pure functions plus handlers that operate on a GitStore interface supplied by app.ts.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { readonly type: GitObjectType; readonly data: Buffer; }
export interface TreeEntry { readonly mode: string; readonly name: string; readonly oid: string; }

export interface GitStore {
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  defaultBranch: string;
  packCache?: Map<string, Buffer>;
}

const HEX40 = /^[0-9a-f]{40}$/;
export function isObjectId(v: string): boolean { return HEX40.test(v); }
export function hashObject(type: GitObjectType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}
export function putObject(store: GitStore, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.objects.has(oid)) store.objects.set(oid, { type, data });
  return oid;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new Error('bad tree');
    entries.push({ mode: data.subarray(off, sp).toString('ascii'), name: data.subarray(sp + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return entries;
}

function cmpTreeNames(a: TreeEntry, b: TreeEntry): number {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(cmpTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string; }
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = ''; const parents: string[] = []; let author = ''; let committer = '';
  for (const line of data.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'tree') tree = v; else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v; else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}
export function buildCommit(o: { tree: string; parents?: readonly string[]; message: string; author: string; committer?: string; timestamp: number }): Buffer {
  const who = `${o.author} ${o.timestamp} +0000`;
  const com = `${o.committer ?? o.author} ${o.timestamp} +0000`;
  const lines = [`tree ${o.tree}`];
  for (const p of o.parents ?? []) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${com}`, '');
  const msg = o.message.endsWith('\n') ? o.message : `${o.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${msg}`, 'utf8');
}
export interface TagView { object: string; type: string; tag: string; tagger: string; message: string; }
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headEnd = blank < 0 ? data.length : blank;
  const h = new Map<string, string>();
  for (const line of data.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    if (sp >= 0) h.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return { object: h.get('object') ?? '', type: h.get('type') ?? '', tag: h.get('tag') ?? '', tagger: h.get('tagger') ?? '', message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
}

/** Every object reachable from roots (commit→tree+parents, tag→target, tree→entries). */
export function collectReachable(roots: Iterable<string>, lookup: (oid: string) => GitObject | undefined, allowMissing = false): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) if (isObjectId(r)) queue.push(r);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) { if (allowMissing) continue; throw new Error(`missing object ${oid}`); }
    seen.add(oid);
    if (obj.type === 'commit') { const c = parseCommit(obj.data); queue.push(c.tree); for (const p of c.parents) queue.push(p); }
    else if (obj.type === 'tag') queue.push(parseTag(obj.data).object);
    else if (obj.type === 'tree') { for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid); }
  }
  return seen;
}
export function isAncestor(store: GitStore, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const reach = collectReachable([desc], (o) => store.objects.get(o), true);
  return reach.has(anc);
}

// -------------------------------------------------------------------------------- pkt-line
export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const h = Buffer.allocUnsafe(4);
  h.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([h, data]);
}
export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');
export function pktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it === 'flush') parts.push(FLUSH);
    else if (it === 'delim') parts.push(DELIM);
    else parts.push(pkt(it));
  }
  return Buffer.concat(parts);
}
export interface Pkt { kind: 'data' | 'flush' | 'delim' | 'end'; payload?: Buffer; }
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (head === '0000') { out.push({ kind: 'flush' }); off += 4; continue; }
    if (head === '0001') { out.push({ kind: 'delim' }); off += 4; continue; }
    if (head === '0002') { out.push({ kind: 'end' }); off += 4; continue; }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) throw new Error('bad pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  if (off !== buf.length) throw new Error('trailing pkt-line bytes');
  return out;
}

// -------------------------------------------------------------------------------- packfile
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let rem = size;
  let first = (code << 4) | (rem & 0x0f);
  rem = Math.floor(rem / 16);
  while (rem > 0) { bytes.push(first | 0x80); first = rem & 0x7f; rem = Math.floor(rem / 128); }
  bytes.push(first);
  return Buffer.from(bytes);
}
export function writePack(objects: readonly GitObject[]): Buffer {
  const sorted = [...objects].sort((a, b) => {
    const ao = hashObject(a.type, a.data); const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii'); header.writeUInt32BE(2, 4); header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const o of sorted) {
    parts.push(writePackHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start]!;
  const first = byte;
  let size = byte & 0x0f; let shift = 4; let off = start + 1;
  while (byte & 0x80) { byte = buf[off++]!; size += (byte & 0x7f) * 2 ** shift; shift += 7; }
  return { size, next: off, first };
}
function readOfsBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buf[start]!; let off = start + 1; let value = byte & 0x7f;
  while (byte & 0x80) { byte = buf[off++]!; value = ((value + 1) * 128) + (byte & 0x7f); }
  return { baseOffset: value, next: off };
}
function inflateAt(buf: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const r = inflateSync(buf.subarray(offset, end), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  if (!r.engine.bytesWritten) throw new Error('zlib consumed no bytes');
  return { data: r.buffer, next: offset + r.engine.bytesWritten };
}
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let v = 0; let sh = 0;
    for (;;) { const b = delta[off++]!; v += (b & 0x7f) * 2 ** sh; sh += 7; if (!(b & 0x80)) break; }
    return v;
  };
  const srcSize = readSize(); const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++]!;
    if (op & 0x80) {
      let co = 0; let cs = 0; let sh = 0;
      for (let bit = 0; bit < 4; bit++) { if (op & (1 << bit)) co += delta[off++]! * 2 ** sh; sh += 8; }
      sh = 0;
      for (let bit = 4; bit < 7; bit++) { if (op & (1 << bit)) cs += delta[off++]! * 2 ** sh; sh += 8; }
      if (cs === 0) cs = 0x10000;
      base.copy(out, written, co, co + cs); written += cs;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, written, off, off + n); off += n; written += n;
    } else throw new Error('delta opcode 0');
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}

/** Parse a packfile; resolves OFS/REF deltas. Returns objects keyed by oid. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  if (createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex') !== trailer) throw new Error('pack checksum mismatch');
  interface Raw { offset: number; typeCode: number; size: number; data: Buffer; baseOffset?: number; baseOid?: string; resolved?: GitObject; oid?: string; }
  const raw: Raw[] = []; const byOffset = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i++) {
    const entryOff = off;
    const h = readVarint(pack, off); off = h.next;
    const typeCode = (h.first >> 4) & 0x07;
    const e: Raw = { offset: entryOff, typeCode, size: h.size, data: Buffer.alloc(0) };
    if (typeCode === 6) { const b = readOfsBase(pack, off); off = b.next; e.baseOffset = entryOff - b.baseOffset; }
    else if (typeCode === 7) { e.baseOid = pack.subarray(off, off + 20).toString('hex'); off += 20; }
    else if (!CODE_TYPE[typeCode]) throw new Error(`pack type ${typeCode}`);
    const inf = inflateAt(pack, off, trailerStart);
    if (inf.data.length !== h.size) throw new Error('pack entry size mismatch');
    e.data = inf.data; off = inf.next;
    raw.push(e); byOffset.set(entryOff, e);
  }
  if (off !== trailerStart) throw new Error('pack trailing bytes');
  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (e: Raw): GitObject => {
    if (e.resolved && e.oid) return e.resolved;
    if (resolving.has(e.offset)) throw new Error('delta cycle');
    resolving.add(e.offset);
    let obj: GitObject;
    if (e.typeCode === 6) {
      const base = resolve(byOffset.get(e.baseOffset!)!);
      obj = { type: base.type, data: applyDelta(base.data, e.data) };
    } else if (e.typeCode === 7) {
      const be = resolvedByOid.get(e.baseOid!);
      if (be) { const base = resolve(be); obj = { type: base.type, data: applyDelta(base.data, e.data) }; }
      else {
        const ext = resolveBase?.(e.baseOid!);
        if (!ext) throw new Error(`ref-delta base ${e.baseOid} missing`);
        obj = { type: ext.type, data: applyDelta(ext.data, e.data) };
      }
    } else obj = { type: CODE_TYPE[e.typeCode]!, data: e.data };
    const oid = hashObject(obj.type, obj.data);
    e.resolved = obj; e.oid = oid; resolvedByOid.set(oid, e); resolving.delete(e.offset);
    return obj;
  };
  for (const e of raw) {
    const obj = resolve(e);
    const oid = hashObject(obj.type, obj.data);
    if (!objects.has(oid)) objects.set(oid, obj);
  }
  return objects;
}

// -------------------------------------------------------------------------------- smart HTTP
const AGENT = 'github-forge/1.0';
const V2_CAPS = 'ls-refs=unborn\nfetch=shallow filter\nobject-format=sha1\nagent=github-forge/1.0\n';
const V0_UPLOAD_CAPS = 'symref=HEAD:refs/heads/main side-band-64k ofs-delta thin-pack multi_ack multi_ack_detailed shallow filter agent=github-forge/1.0 object-format=sha1';
const V0_RECV_CAPS = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=github-forge/1.0 symref=HEAD:refs/heads/main';

export function sortedRefs(store: GitStore): Array<{ oid: string; name: string }> {
  return [...store.refs.entries()].map(([name, oid]) => ({ oid, name })).sort((a, b) => (a.name < b.name ? -1 : 1));
}
function peelOf(store: GitStore, oid: string): string | undefined {
  const obj = store.objects.get(oid);
  if (!obj || obj.type !== 'tag') return undefined;
  return parseTag(obj.data).object;
}

/** GET info/refs body for a service. `v2` = client asked Git-Protocol: version=2 (upload-pack only). */
export function advertisement(store: GitStore, service: 'git-upload-pack' | 'git-receive-pack', v2: boolean): Buffer {
  const tip = store.refs.get(`refs/heads/${store.defaultBranch}`);
  if (service === 'git-upload-pack' && v2) {
    const lines: (string | 'flush')[] = ['version 2\n'];
    for (const line of V2_CAPS.split('\n')) if (line) lines.push(`${line}\n`);
    lines.push('flush');
    return pktLines(lines);
  }
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPS : V0_RECV_CAPS;
  const preamble = `# service=${service}\n`;
  if (!tip && store.refs.size === 0) {
    return Buffer.concat([pkt(`${preamble}`), FLUSH, pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`), FLUSH]);
  }
  const lines: (string | 'flush')[] = [];
  const refs = sortedRefs(store);
  const headOid = tip ?? refs.find((r) => r.name.startsWith('refs/heads/'))?.oid ?? ZERO_OID;
  lines.push(`${headOid} HEAD\0${caps}\n`);
  for (const r of refs) {
    lines.push(`${r.oid} ${r.name}\n`);
    const peeled = peelOf(store, r.oid);
    if (peeled) lines.push(`${peeled} ${r.name}^{}\n`);
  }
  return Buffer.concat([pkt(preamble), FLUSH, pktLines(lines), FLUSH]);
}

interface LsRefsArg { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[]; }
/** Parse a v2 ls-refs request body. */
export function parseLsRefs(body: Buffer): LsRefsArg {
  const pkts = decodePktLines(body);
  const arg: LsRefsArg = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let seenDelim = false;
  for (const p of pkts) {
    if (p.kind === 'delim') { seenDelim = true; continue; }
    if (p.kind !== 'data' || !seenDelim) continue;
    const line = p.payload!.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') arg.peel = true;
    else if (line === 'symrefs') arg.symrefs = true;
    else if (line === 'unborn') arg.unborn = true;
    else if (line.startsWith('ref-prefix ')) arg.prefixes.push(line.slice('ref-prefix '.length));
  }
  return arg;
}
export function lsRefsResponse(store: GitStore, arg: LsRefsArg): Buffer {
  const tip = store.refs.get(`refs/heads/${store.defaultBranch}`);
  const lines: (string | 'flush')[] = [];
  const refs = sortedRefs(store).filter((r) => arg.prefixes.length === 0 || arg.prefixes.some((p) => r.name.startsWith(p)));
  const headWanted = arg.prefixes.length === 0 || arg.prefixes.some((p) => 'HEAD'.startsWith(p));
  if (arg.symrefs && headWanted) {
    if (tip) lines.push(`${tip} HEAD symref-target:refs/heads/${store.defaultBranch}\n`);
    else if (arg.unborn) lines.push(`unborn HEAD symref-target:refs/heads/${store.defaultBranch}\n`);
  }
  for (const r of refs) {
    let line = `${r.oid} ${r.name}`;
    const peeled = arg.peel ? peelOf(store, r.oid) : undefined;
    if (peeled) line += ` peeled:${peeled}`;
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return pktLines(lines);
}

// ---- fetch ----
interface FetchReq { wants: string[]; haves: string[]; shallow: string[]; depth?: number; }
function parseFetchV2(body: Buffer): FetchReq {
  const pkts = decodePktLines(body);
  const req: FetchReq = { wants: [], haves: [], shallow: [] };
  let seenDelim = false;
  for (const p of pkts) {
    if (p.kind === 'delim') { seenDelim = true; continue; }
    if (p.kind !== 'data' || !seenDelim) continue;
    const line = p.payload!.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) req.depth = parseInt(line.slice(7), 10);
  }
  return req;
}
function parseFetchV0(body: Buffer): FetchReq {
  const pkts = decodePktLines(body);
  const req: FetchReq = { wants: [], haves: [], shallow: [] };
  let section = 0;
  for (const p of pkts) {
    if (p.kind === 'flush') { section++; continue; }
    if (p.kind !== 'data') continue;
    const line = p.payload!.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const sp = rest.indexOf(' ');
        req.wants.push(sp < 0 ? rest : rest.slice(0, sp));
      } else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) req.depth = parseInt(line.slice(7), 10);
    } else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
  }
  return req;
}

/** Compute the object set for a fetch: reachable(wants) minus reachable(haves), depth-limited.
 *  Returns {objects, shallow, unshallow}. Depth counts commit generations: distance 0 = want. */
export function fetchObjects(store: GitStore, req: FetchReq): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const lookup = (o: string) => store.objects.get(o);
  const oldShallow = new Set(req.shallow);
  // Objects the client already holds: the closure of its haves, but never past a
  // shallow boundary's parents — a shallow clone holds the boundary commit, not
  // its history, so a deepen fetch must still deliver the parent.
  const treeClosureInto = (treeOid: string, into: Set<string>): void => {
    const stack = [treeOid];
    while (stack.length) {
      const o = stack.pop()!;
      if (into.has(o)) continue;
      const obj = lookup(o);
      if (!obj) continue;
      into.add(o);
      if (obj.type === 'tree') for (const e of parseTree(obj.data)) stack.push(e.oid);
    }
  };
  const haveReach = new Set<string>();
  {
    const stack = [...req.haves];
    while (stack.length) {
      const oid = stack.pop()!;
      if (haveReach.has(oid)) continue;
      const obj = lookup(oid);
      if (!obj) continue;
      haveReach.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        treeClosureInto(c.tree, haveReach);
        if (!oldShallow.has(oid)) for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tag') stack.push(parseTag(obj.data).object);
      else if (obj.type === 'tree') treeClosureInto(oid, haveReach);
    }
  }
  // BFS over commits from wants, tracking distance; include trees/blobs/tags of included commits.
  const included = new Set<string>();
  const commitDist = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const w of req.wants) if (isObjectId(w)) queue.push([w, 0]);
  const shallowSet = new Set<string>();
  while (queue.length) {
    const [oid, dist] = queue.shift()!;
    if (commitDist.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    if (req.depth !== undefined && dist >= req.depth) continue;
    commitDist.set(oid, dist);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      for (const p of c.parents) {
        if (req.depth !== undefined && dist + 1 >= req.depth) shallowSet.add(oid);
        queue.push([p, dist + 1]);
      }
      if (obj.type === 'commit' && req.depth !== undefined && dist === req.depth - 1 && c.parents.length) shallowSet.add(oid);
    } else if (obj.type === 'tag') {
      const t = parseTag(obj.data);
      if (t.type === 'commit') queue.push([t.object, dist]);
    }
  }
  // Shallow boundary: included commits whose parents were NOT included.
  const shallow: string[] = [];
  for (const [oid] of commitDist) {
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    if (c.parents.length && c.parents.some((p) => !commitDist.has(p))) shallow.push(oid);
  }
  // Included objects: each included commit + its tree closure (tree/blobs only — never parents),
  // plus tag objects and their targets' tree closures.
  for (const [oid] of commitDist) {
    included.add(oid);
    const obj = lookup(oid);
    if (obj?.type === 'commit') treeClosureInto(parseCommit(obj.data).tree, included);
    else if (obj?.type === 'tag') {
      const t = parseTag(obj.data);
      included.add(t.object);
      const target = lookup(t.object);
      if (target?.type === 'commit') { included.add(t.object); treeClosureInto(parseCommit(target.data).tree, included); }
    }
  }
  for (const w of req.wants) {
    const obj = lookup(w);
    if (obj?.type === 'tag') { included.add(w); for (const o of collectReachable([w], lookup, true)) { const oo = lookup(o); if (oo?.type !== 'commit' || commitDist.has(o)) included.add(o); } }
  }
  const unshallow = [...oldShallow].filter((o) => commitDist.has(o) && !shallow.includes(o));
  const objects: GitObject[] = [];
  for (const oid of included) {
    if (haveReach.has(oid)) continue;
    const obj = lookup(oid);
    if (obj) objects.push(obj);
  }
  return { objects, shallow, unshallow };
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let off = 0; off < pack.length; off += 60000) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + 60000));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pkt(Buffer.from([1])));
  return Buffer.concat(parts);
}

/** POST git-upload-pack body → response body. `v2` from Git-Protocol header. Throws on bad input. */
export function handleUploadPack(store: GitStore, body: Buffer, v2: boolean): Buffer {
  const req = v2 ? parseFetchV2(body) : parseFetchV0(body);
  if (!req.wants.length) {
    // Empty fetch: answer with a packfile section carrying an empty pack.
    if (v2) return Buffer.concat([pkt('packfile\n'), sidebandPack(writePack([])), FLUSH]);
    return Buffer.concat([pkt('NAK\n'), sidebandPack(writePack([])), FLUSH]);
  }
  const { objects, shallow, unshallow } = fetchObjects(store, req);
  // The pack for a given request is deterministic; cache it (cleared on any
  // mutation) so concurrent identical clones share one build.
  const cacheKey = JSON.stringify({ w: [...req.wants].sort(), h: [...req.haves].sort(), s: [...req.shallow].sort(), d: req.depth ?? null });
  let pack = store.packCache?.get(cacheKey);
  if (!pack) {
    pack = writePack(objects);
    if (!store.packCache) store.packCache = new Map();
    store.packCache.set(cacheKey, pack);
  }
  if (v2) {
    const parts: Buffer[] = [];
    // Git's client expects an acknowledgments section only when it sent haves;
    // with no haves it reads straight for shallow-info/packfile. The suite's
    // parser is order-tolerant, so omitting it here is safe for both.
    if (req.haves.length) parts.push(pktLines(['acknowledgments\n', 'NAK\n', 'delim']));
    if (req.depth !== undefined) {
      const lines: (string | 'delim')[] = ['shallow-info\n'];
      for (const s of shallow) lines.push(`shallow ${s}\n`);
      for (const u of unshallow) lines.push(`unshallow ${u}\n`);
      lines.push('delim');
      parts.push(pktLines(lines));
    }
    parts.push(pkt('packfile\n'));
    parts.push(sidebandPack(pack));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  const parts: Buffer[] = [pkt('NAK\n')];
  for (const s of shallow) parts.push(pkt(`shallow ${s}\n`));
  for (const u of unshallow) parts.push(pkt(`unshallow ${u}\n`));
  parts.push(sidebandPack(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---- receive-pack ----
export interface PushCommand { oldOid: string; newOid: string; ref: string; caps: string[]; }
export function parsePush(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  // pkt-lines until flush; the rest is the raw pack.
  let off = 0;
  const commands: PushCommand[] = [];
  while (off + 4 <= body.length) {
    const head = body.subarray(off, off + 4).toString('ascii');
    if (head === '0000') { off += 4; break; }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > body.length) throw new Error('bad pkt-line in push');
    const line = body.subarray(off + 4, off + len).toString('utf8');
    off += len;
    const nul = line.indexOf('\0');
    const text = (nul >= 0 ? line.slice(0, nul) : line).replace(/\n$/, '');
    const caps = nul >= 0 ? line.slice(nul + 1).replace(/\n$/, '').split(' ').filter(Boolean) : [];
    const parts = text.split(' ');
    if (parts.length !== 3) throw new Error('bad push command');
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]!, caps });
  }
  if (!commands.length) throw new Error('no push commands');
  return { commands, pack: body.subarray(off) };
}

/** Apply a receive-pack exchange. Returns the report body (sideband or raw pkt-lines). */
export function handleReceivePack(store: GitStore, body: Buffer): Buffer {
  const { commands, pack } = parsePush(body);
  const sideband = commands[0]?.caps.includes('side-band-64k') ?? false;
  const lines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const updates = commands.some((c) => c.newOid !== ZERO_OID);
  let incoming = new Map<string, GitObject>();
  if (updates || pack.length > 0) {
    if (pack.length === 0) { unpackOk = false; unpackDetail = 'unpack error: empty pack'; }
    else {
      try { incoming = readPack(pack, (o) => store.objects.get(o)); }
      catch (e) { unpackOk = false; unpackDetail = `unpack error: ${e instanceof Error ? e.message : String(e)}`; }
    }
  }
  if (unpackOk) for (const [oid, obj] of incoming) if (!store.objects.has(oid)) store.objects.set(oid, obj);
  if (unpackOk && incoming.size) store.packCache?.clear();
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const cmd of commands) {
    if (!unpackOk) { results.push({ ref: cmd.ref, ok: false, reason: 'unpack error' }); continue; }
    const cur = store.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      if (cur === undefined) results.push({ ref: cmd.ref, ok: false, reason: 'no such ref' });
      else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== cur) results.push({ ref: cmd.ref, ok: false, reason: 'old oid does not match' });
      else { store.refs.delete(cmd.ref); results.push({ ref: cmd.ref, ok: true, reason: '' }); }
      continue;
    }
    const target = store.objects.get(cmd.newOid);
    if (!target) { results.push({ ref: cmd.ref, ok: false, reason: 'object not found' }); continue; }
    if (cur === undefined) {
      if (cmd.oldOid !== ZERO_OID) results.push({ ref: cmd.ref, ok: false, reason: 'old oid does not match' });
      else { store.refs.set(cmd.ref, cmd.newOid); results.push({ ref: cmd.ref, ok: true, reason: '' }); }
      continue;
    }
    if (cmd.oldOid !== cur) { results.push({ ref: cmd.ref, ok: false, reason: 'old oid does not match' }); continue; }
    if (cmd.newOid === cur) { results.push({ ref: cmd.ref, ok: true, reason: '' }); continue; }
    // Fast-forward: new tip must have old tip as ancestor (commit) or be same tag target.
    let ff = false;
    if (target.type === 'commit') ff = isAncestor(store, cur, cmd.newOid);
    else if (target.type === 'tag') ff = isAncestor(store, cur, parseTag(target.data).object) || parseTag(target.data).object === cur;
    if (!ff) { results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' }); continue; }
    store.refs.set(cmd.ref, cmd.newOid);
    results.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  lines.push(`unpack ${unpackDetail}\n`);
  for (const r of results) lines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  if (results.some((r) => r.ok)) store.packCache?.clear();
  const inner = pktLines([...lines, 'flush']);
  if (!sideband) return inner;
  // Band 1 carries the pkt-line report stream, chunked.
  const parts: Buffer[] = [];
  for (let off = 0; off < inner.length; off += 60000) {
    parts.push(pkt(Buffer.concat([Buffer.from([1]), inner.subarray(off, Math.min(inner.length, off + 60000))])));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}
