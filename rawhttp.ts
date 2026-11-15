// rawhttp.ts — minimal HTTP/1.1 server on node:net, stdlib only.
//
// This replaces node:http for the entry. The suite's only client is fetch
// (undici): Content-Length bodies, keep-alive connections, no pipelining, no
// Expect: 100-continue. So the server needs exactly: request line + headers,
// a Content-Length or chunked body, keep-alive, and a single-buffer response.
//
// What node:http costs per request that this skips: llhttp parsing, one
// IncomingMessage + one ServerResponse + a headers object + the stream state
// machines, and the writeHead/end path through _http_outgoing. Here a request
// is one small object, its body a subarray of the socket buffer, and a reply
// is one socket.write (two when the body is large, so a pack is never copied).
// Handlers run one at a time per connection, in request order, which is all
// a non-pipelining client can observe.

import { createServer, type Server, type Socket } from 'node:net';

export interface RawReq {
  method: string;
  /** Raw request-target as sent (path?query), for the fast-path regex. */
  url: string;
  /** Target up to the first '?'. */
  path: string;
  /** Parsed query; a shared empty instance when there is no query string. */
  params: URLSearchParams;
  /** Lowercase header names; last value wins. */
  headers: Record<string, string>;
  /** Full body, already buffered before dispatch. */
  body: Buffer;
  /** False when the request said `Connection: close` or is HTTP/1.0 without keep-alive. */
  keepAlive: boolean;
}

const EMPTY_PARAMS = new URLSearchParams();

const REASONS: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found', 405: 'Method Not Allowed',
  409: 'Conflict', 422: 'Unprocessable Entity', 500: 'Internal Server Error',
};

/** The Date header, cached per second: node:http regenerates it the same way. */
let dateCache = '';
let dateCacheSec = -1;
function dateStr(): string {
  const sec = (Date.now() / 1000) | 0;
  if (sec !== dateCacheSec) { dateCacheSec = sec; dateCache = new Date(sec * 1000).toUTCString(); }
  return dateCache;
}

/** Responses at or under this size go out as one Buffer in one write; larger ones
 *  write header and body separately so a packfile is never copied. */
const SINGLE_WRITE_MAX = 32768;

class RawRes {
  statusCode = 200;
  headersSent = false;
  private ended = false;
  private readonly headers = new Map<string, string>();
  private finishCbs: Array<() => void> = [];
  private readonly sock: Socket;
  private readonly keepAlive: boolean;
  private readonly onDone: () => void;
  constructor(sock: Socket, keepAlive: boolean, onDone: () => void) {
    this.sock = sock;
    this.keepAlive = keepAlive;
    this.onDone = onDone;
  }
  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }
  writeHead(status: number, headers?: Record<string, string>): void {
    this.statusCode = status;
    if (headers) for (const k of Object.keys(headers)) this.headers.set(k.toLowerCase(), headers[k]!);
    this.headersSent = true;
  }
  on(event: 'finish', cb: () => void): void {
    if (event === 'finish') this.finishCbs.push(cb);
  }
  isEnded(): boolean {
    return this.ended;
  }
  end(data?: Buffer | string): void {
    if (this.ended) return;
    this.ended = true;
    const body: Buffer = data === undefined ? Buffer.alloc(0) : typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const status = this.statusCode;
    const lines: string[] = [`HTTP/1.1 ${status} ${REASONS[status] ?? ''}\r\n`];
    for (const [k, v] of this.headers) lines.push(`${k}: ${v}\r\n`);
    const framed = this.headers.has('content-length') || this.headers.has('transfer-encoding');
    // Match node:http's framing: a response with no explicit length and no body
    // restriction (204) is sent chunked; 204 carries neither a length nor chunks.
    const chunked = status !== 204 && !framed;
    lines.push(`Date: ${dateStr()}\r\n`);
    if (this.keepAlive) {
      lines.push('Connection: keep-alive\r\n');
      lines.push('Keep-Alive: timeout=5\r\n');
    } else {
      lines.push('Connection: close\r\n');
    }
    if (chunked) lines.push('transfer-encoding: chunked\r\n');
    lines.push('\r\n');
    const head = Buffer.from(lines.join(''), 'ascii');
    let wire: Buffer;
    if (chunked) {
      wire = body.length === 0
        ? Buffer.from('0\r\n\r\n', 'ascii')
        : Buffer.concat([Buffer.from(`${body.length.toString(16)}\r\n`, 'ascii'), body, Buffer.from('\r\n0\r\n\r\n', 'ascii')]);
    } else wire = body;
    const done = (): void => {
      for (const cb of this.finishCbs) { try { cb(); } catch { /* profiling must never break the server */ } }
      this.finishCbs = [];
      this.onDone();
    };
    if (wire.length <= SINGLE_WRITE_MAX) {
      this.sock.write(Buffer.concat([head, wire]), done);
    } else {
      this.sock.write(head);
      this.sock.write(wire, done);
    }
    if (!this.keepAlive) this.sock.end();
  }
}

// -------------------------------------------------------------------------------- parsing

const CRLFCRLF = Buffer.from('\r\n\r\n', 'ascii');
const MAX_HEADER_BYTES = 65536;
const MAX_QUEUE = 64;

/** Parse one chunked body starting at `off` in `buf`. Returns the body and the
 *  offset just past the terminating chunk (plus trailers), or null if incomplete. */
function parseChunked(buf: Buffer, off: number): { body: Buffer; next: number } | null {
  const chunks: Buffer[] = [];
  let pos = off;
  for (;;) {
    const eol = buf.indexOf('\r\n', pos);
    if (eol < 0) return null;
    const size = parseInt(buf.subarray(pos, eol).toString('ascii').trim(), 16);
    if (!Number.isFinite(size) || size < 0) throw new Error('bad chunk size');
    const dataStart = eol + 2;
    if (size === 0) {
      // Trailers end at the next blank line.
      const end = buf.indexOf('\r\n', dataStart);
      if (end < 0) return null;
      return { body: Buffer.concat(chunks), next: end + 2 };
    }
    if (dataStart + size + 2 > buf.length) return null;
    chunks.push(buf.subarray(dataStart, dataStart + size));
    pos = dataStart + size + 2;
  }
}

interface ParsedReq {
  req: RawReq;
  consumed: number;
}

/** Try to parse one request from the front of `buf`. Null when more bytes are needed. */
function parseRequest(buf: Buffer): ParsedReq | null {
  const headEnd = buf.indexOf(CRLFCRLF);
  if (headEnd < 0) {
    if (buf.length > MAX_HEADER_BYTES) throw new Error('headers too large');
    return null;
  }
  const head = buf.subarray(0, headEnd);
  const lineEnd = head.indexOf('\r\n');
  const firstLine = head.subarray(0, lineEnd < 0 ? head.length : lineEnd).toString('ascii');
  const sp1 = firstLine.indexOf(' ');
  const sp2 = firstLine.indexOf(' ', sp1 + 1);
  if (sp1 < 0 || sp2 < 0) throw new Error('bad request line');
  const method = firstLine.slice(0, sp1);
  let target = firstLine.slice(sp1 + 1, sp2);
  const version = firstLine.slice(sp2 + 1);
  if (!version.startsWith('HTTP/')) throw new Error('bad http version');
  // Absolute-form target (a proxy-style request): keep only path?query, as new URL does.
  const scheme = target.indexOf('://');
  if (scheme >= 0) {
    const slash = target.indexOf('/', scheme + 3);
    target = slash < 0 ? '/' : target.slice(slash);
  }
  const headers: Record<string, string> = {};
  let pos = lineEnd < 0 ? head.length : lineEnd + 2;
  while (pos < head.length) {
    const eol = head.indexOf('\r\n', pos);
    const lineEndAt = eol < 0 ? head.length : eol;
    const line = head.subarray(pos, lineEndAt).toString('latin1');
    pos = lineEndAt + 2;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const q = target.indexOf('?');
  const path = q < 0 ? target : target.slice(0, q);
  const query = q < 0 ? '' : target.slice(q + 1);
  const conn = (headers['connection'] ?? '').toLowerCase();
  const keepAlive = version === 'HTTP/1.1' ? conn !== 'close' : conn === 'keep-alive';
  let bodyStart = headEnd + 4;
  const te = headers['transfer-encoding'] ?? '';
  if (te.toLowerCase().includes('chunked')) {
    const parsed = parseChunked(buf, bodyStart);
    if (!parsed) return null;
    return {
      req: {
        method, url: target, path,
        params: query ? new URLSearchParams(query) : EMPTY_PARAMS,
        headers, body: parsed.body, keepAlive,
      },
      consumed: parsed.next,
    };
  }
  const len = headers['content-length'] === undefined ? 0 : parseInt(headers['content-length'], 10);
  if (!Number.isFinite(len) || len < 0) throw new Error('bad content-length');
  if (buf.length < bodyStart + len) return null;
  return {
    req: {
      method, url: target, path,
      params: query ? new URLSearchParams(query) : EMPTY_PARAMS,
      headers, body: buf.subarray(bodyStart, bodyStart + len), keepAlive,
    },
    consumed: bodyStart + len,
  };
}

/** Send a minimal 400 and close: only reached for requests no real client sends. */
function sendBadRequest(sock: Socket): void {
  try {
    const body = Buffer.from('{"message":"Bad Request"}', 'utf8');
    sock.write(
      Buffer.concat([Buffer.from('HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: ' + body.length + '\r\nconnection: close\r\n\r\n', 'ascii'), body]),
      () => { try { sock.destroy(); } catch { /* ignore */ } },
    );
  } catch { try { sock.destroy(); } catch { /* ignore */ } }
}

export function createRawServer(handler: (req: RawReq, res: RawRes) => Promise<void> | void): Server {
  const server = createServer((sock) => {
    sock.setNoDelay(true);
    let chunks: Buffer[] = [];
    let len = 0;
    let queue: RawReq[] = [];
    let busy = false;
    let dead = false;
    let halfClosed = false;
    let paused = false;
    let sent100 = false;

    const tryParse = (): void => {
      for (;;) {
        if (chunks.length === 0) return;
        if (chunks.length > 1) {
          const joined = Buffer.concat(chunks, len);
          chunks = [joined];
        }
        const buf = chunks[0]!;
        // A client that sent `Expect: 100-continue` waits for the interim reply
        // before sending its body: answer as soon as the header block is complete.
        if (!sent100) {
          const he = buf.indexOf(CRLFCRLF);
          if (he >= 0 && buf.subarray(0, he).toString('latin1').toLowerCase().includes('expect: 100-continue')) {
            sent100 = true;
            try { sock.write('HTTP/1.1 100 Continue\r\n\r\n'); } catch { /* ignore */ }
          }
        }
        let parsed: ParsedReq | null;
        try {
          parsed = parseRequest(buf);
        } catch {
          dead = true;
          sendBadRequest(sock);
          return;
        }
        if (!parsed) return;
        queue.push(parsed.req);
        sent100 = false;
        const rest = buf.subarray(parsed.consumed);
        if (rest.length === 0) { chunks = []; len = 0; }
        else { chunks = [Buffer.from(rest)]; len = rest.length; }
        if (queue.length >= MAX_QUEUE && !paused) { paused = true; sock.pause(); }
      }
    };

    const pump = (): void => {
      if (busy || dead || queue.length === 0) return;
      busy = true;
      const req = queue.shift()!;
      if (paused && queue.length < MAX_QUEUE / 2) { paused = false; sock.resume(); }
      const res = new RawRes(sock, req.keepAlive, () => {
        busy = false;
        if (halfClosed && queue.length === 0) { try { sock.end(); } catch { /* ignore */ } return; }
        pump();
      });
      void (async () => {
        try {
          await handler(req, res);
          if (!res.headersSent) {
            // The handler never answered: end it as a 500 like node:http's catch path.
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end('{"message":"Internal Server Error"}');
          } else if (!res.isEnded()) {
            res.end();
          }
        } catch {
          try {
            if (!res.headersSent) {
              res.writeHead(500, { 'content-type': 'application/json' });
              res.end('{"message":"Internal Server Error"}');
            } else res.end();
          } catch { /* socket may be gone */ }
        }
      })();
    };

    sock.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      len += chunk.length;
      tryParse();
      pump();
    });
    sock.on('end', () => {
      halfClosed = true;
      if (!busy && queue.length === 0) { try { sock.end(); } catch { /* ignore */ } }
    });
    sock.on('close', () => { dead = true; });
    sock.on('error', () => { dead = true; try { sock.destroy(); } catch { /* ignore */ } });
  });
  return server;
}
