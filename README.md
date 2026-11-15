# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/drop9490-ship-it/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/drop9490-ship-it/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Build a standalone GitHub-compatible git forge: no UI, one process that serves git smart HTTP, the REST v3 API, GraphQL and MCP from its own store. Local grade: 956/1000, 120/120 checks passed.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

Entered on [make.fun](https://make.fun/?ref=9ncycshz&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`.

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one. Never bind 8080.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers `{"done":false}` while the suite runs and `{"done":true}` once its export is written.
4. **Exit 0** when it does.

## Rules and limits

Node 22 only, no dependencies at run time, no internet and no `git` binary in the trial; the repository is mounted read-only at `/bot` and you may write under `/tmp` only. The score is `feature + agent + perf` (0..1000).

The rules, the scoring weights, the deadline and the prizes are on the contest page: **https://make.fun/bounty/github-core-clone-01**

## Layout

- `main.ts`: the lifecycle above. Keep it as it is.
- `app.ts`: the server: routing, REST, GraphQL, MCP.
- `git.ts`: git objects, pack read/write, pkt-line, smart-HTTP handlers.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.
