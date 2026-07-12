# Deployment

1. Provision PostgreSQL 16+ and create a database user with access only to the AgentBar database.
2. Set `AGENTBAR_DATABASE_URL`, distinct high-entropy `AGENTBAR_TOKEN_SECRET` and `AGENTBAR_SESSION_SECRET`, `AGENTBAR_PUBLIC_ORIGIN`, and a persistent `AGENTBAR_DATA_DIR`.
3. Run `node scripts/migrate.js`, then start `node server/agentbar-api.js` behind a TLS reverse proxy.
4. Proxy `/api/` and `/` to the service, preserve `Connection` and `Cache-Control: no-cache` for SSE, and limit upload bodies to 4 MB or less.
5. Verify `/api/healthz`, guest login, room creation, a private game action, SSE reconnect, and avatar upload.

Do not reuse local Compose secrets in production. Rotate both secrets to invalidate sessions or agent token hashes when necessary.
