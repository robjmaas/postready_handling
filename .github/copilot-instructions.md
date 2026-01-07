## Postready — Copilot / AI agent instructions

This repository is a small Node.js service that retrieves files from Filemail and prepares them for downstream processing (Coconut transcode, Dropbox upload). The single entry point is `index.js` (ES module). Use the guidance below to be productive quickly.

### Big picture
- index: `index.js` — an Express server that currently exposes a minimal setup and contains the `getFilemailFiles()` helper which fetches from Filemail and returns an array of {name, url}.
- External integrations: Filemail (inbox API), Coconut (transcoding — commented webhook reference), and Dropbox (upload via access token).
- Config: environment-driven via `.env` and `dotenv`. Required env names in code: `FILEMAIL_API_KEY`, `COCONUT_API_KEY`, `DROPBOX_ACCESS_TOKEN`, optional `PORT`.

### Architectural notes & intent (from code)
- The service is written as a lightweight worker/API (Express present but no routes are implemented yet). The primary flow is: fetch transfer list from Filemail → map to {name,url} → (intended) send to Coconut or upload to Dropbox.
- `getFilemailFiles()` currently calls the Filemail public inbox endpoint and maps results to `{ name, url }`. It throws on non-OK responses (no retries).
- There is a commented `WEBHOOK_URL` and an example `getFilemailFiles("6N2s9wDC")` call — appears to be a manual/test invocation that should either be removed or replaced with a proper scheduled handler / route.

### Developer workflows (how to run & debug)
1. Install dependencies (the project file currently has an empty `dependencies` block). The code requires at least:
   - `express`
   - `node-fetch` (or use Node 18+ built-in `fetch`) 
   - `dotenv`

   Example (run once):

   npm install express node-fetch dotenv

2. Provide credentials via a `.env` file in the repo root (do not commit secrets):

   FILEMAIL_API_KEY=your_filemail_key
   COCONUT_API_KEY=your_coconut_key
   DROPBOX_ACCESS_TOKEN=your_dropbox_token
   PORT=3000

3. Start the server (zsh/macOS):

   node index.js

   - If you prefer automatic reloads in development, add `nodemon` and a `dev` script in `package.json`.

### Project-specific patterns & conventions
- ES modules: `package.json` uses `"type": "module"` — prefer `import`/`export` and avoid CommonJS `require()`.
- Environment-first config: code reads secrets via `process.env` and uses `dotenv.config()` early in `index.js`.
- Minimal error handling: functions tend to throw on non-OK responses. When expanding flows (Coconut/Dropbox), follow the same pattern but add retries and idempotency where external calls are non-atomic.
- Keep external integration code in small, testable functions similar to `getFilemailFiles()` (input → output mapping). Example return shape to match: `{ name, url }`.

### Integration details to watch for (examples from code)
- Filemail API: `https://api-public.filemail.com/transfer/inbox` and header `X-Filemail-ApiKey: <KEY>` — the current function expects the API response to include `files` with `filename` and `downloadurl`.
- Coconut: referenced by `COCONUT_API_KEY` and a commented `WEBHOOK_URL` — expect an async transcode workflow (upload → webhook callback) rather than immediate sync responses.
- Dropbox: token-based uploads via `DROPBOX_ACCESS_TOKEN` — implement chunked uploads for large files if needed.

### Concrete tasks an AI agent can do first
1. Remove or refactor the stray `getFilemailFiles("6N2s9wDC")` call — replace with a scheduled job, CLI command, or an Express route that triggers processing.
2. Add proper `package.json` scripts: `start` -> `node index.js`, `dev` -> `nodemon index.js` (if using nodemon). Also add missing `dependencies`.
3. Implement a Coconut integration function (upload URL or proxy the download) and a reliable webhook handler; include tests mocking HTTP responses.
4. Add basic logging and error boundaries around external fetches; add retry/backoff for transient errors.

### Files to reference while working
- `index.js` — main logic and examples (search for `getFilemailFiles`, `FILEMAIL_API_KEY`, `COCONUT_API_KEY`, `DROPBOX_ACCESS_TOKEN`).
- `package.json` — currently minimal; update it when adding dependencies and scripts.

### When to ask for human guidance
- If credentials or third-party API behavior are required (e.g., exact Filemail inbox IDs, Coconut webhook URLs), ask the repo owner rather than guessing.
- Before adding or committing any secrets or CI credentials.

If anything is unclear or you'd like me to expand specific integration examples (e.g., a working Coconut upload flow or a Dropbox uploader helper), tell me which piece to implement next.
