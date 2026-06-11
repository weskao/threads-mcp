# CLAUDE.md

Guidance for working in this repository.

## Project

`threads-mcp-server` — a TypeScript MCP server for the Threads API (ESM, `@modelcontextprotocol/sdk`). Source entry point is `src/index.ts`; compiled output goes to `dist/`.

## Commands

```bash
npm run build   # tsc — compile src/ to dist/
npm run dev     # tsx watch src/index.ts — run in watch mode
npm run lint    # tsc --noEmit — typecheck only
npm run start   # node dist/index.js — run the built server
```

Tests are not configured yet (`npm test` is a placeholder), although `jest`/`ts-jest` are installed and a `tests/` directory exists.

## Cross-platform support

When modifying code, consider all target platforms — **macOS, Linux, and Windows**. In particular:

- Use cross-platform path handling (`path.join`, `path.resolve`) instead of hardcoded `/` or `\` separators.
- Avoid shell- or OS-specific commands and assumptions in runtime code.
- Be mindful of line endings, environment-variable resolution, and home-directory paths across platforms.
