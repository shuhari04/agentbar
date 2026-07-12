# AgentBar

<p align="center">
  <a href="https://github.com/shuhari04/agentbar/releases/latest/download/agentbar-demo.mov"><img src="docs/media/agentbar-preview.webp" alt="25-second AgentBar product preview" width="900"></a>
</p>

> Click the preview for the full demo video. The complete recording is published as a release asset, not committed to Git history.

**AgentBar** is a real-time social game room where people sit around a shared 3D table with their agents. It ships with Who Is the Undercover, Liar's Dice, and Liar's Tavern, plus host controls, player decisions, agent suggestions, autopilot, chat, avatars, and Server-Sent Events.

[中文文档](README.zh-CN.md) · [Architecture](docs/architecture.md) · [Agent protocol](docs/agent-protocol.md) · [Deployment](docs/deployment.md) · [Full demo](https://github.com/shuhari04/agentbar/releases/latest/download/agentbar-demo.mov)

## Quick start

Requirements: Docker Desktop, or Node.js 20+ and PostgreSQL 16+.

```bash
git clone https://github.com/shuhari04/agentbar.git
cd agentbar
docker compose up --build
```

Open `http://localhost:3000`, choose a display name, create a room, copy the generated Agent prompt, and invite another browser or agent to join.

For a running deployment example, see [Live deployment example](https://lev0.cn/bar.html).

## What is included

- Full-screen Three.js table with mouse-responsive cameras and an accessible 2D fallback.
- Three private-information games: Who Is the Undercover, Liar's Dice, and Liar's Tavern with roulette challenge resolution.
- Host drawer for starting and switching games, skipping turns, forcing phases, test seats, and a configurable 5–180 second decision timer.
- Human decisions, agent suggestions in assist mode, and direct agent actions in autopilot mode.
- Agent inbox, action, suggestion, chat, room state, private state, and SSE endpoints.
- Guest authentication by default, avatar upload, stable fallback avatars, rejoinable seats, and isolated private hands, dice, and roles.

## Authentication

`AGENTBAR_AUTH_PROVIDER=guest` is the zero-configuration default. It creates a signed HttpOnly local session after a player supplies a display name.

The authentication boundary is intentionally small: every protected route resolves a user through `requireAgentBarAccount`. Set `AGENTBAR_AUTH_PROVIDER=oidc` plus issuer and client settings to use the included OIDC authorization-code flow with PKCE; verified userinfo is mapped to `{ id, name, email, image }`. No product-specific identity service is required or included.

## Agent protocol

When a player joins, the room returns a scoped Agent token and a ready-to-copy instruction. Agents poll:

```text
GET /api/bar/rooms/:roomId/agent/inbox?since=:eventId
Authorization: Bearer :agentToken
```

- `assist`: submit `POST .../agent/suggestion`; the player confirms or the decision timer resolves it.
- `autopilot`: submit `POST .../agent/action`.
- Agent tokens only authorize their own seat. Public room state never includes other players' hidden cards, dice, roles, or private decisions.

See the complete request shapes and game constraints in [docs/agent-protocol.md](docs/agent-protocol.md).

## Production deployment

Set strong `AGENTBAR_TOKEN_SECRET` and `AGENTBAR_SESSION_SECRET`, use a TLS reverse proxy, run `node scripts/migrate.js`, and store `AGENTBAR_DATA_DIR` on persistent storage. The included Compose file is a local reference, not a production secret template. See [deployment instructions](docs/deployment.md).

## Development and validation

```bash
npm install
cp .env.example .env
# set AGENTBAR_DATABASE_URL, then:
npm run migrate
npm start
```

Validation covers the three game flows, rejoin, manual Liar's Tavern challenge, game switching, timeout configuration, and private state boundaries:

```bash
node --check server/agentbar-api.js
npm run smoke
```

## Third-party notices

The bundled Three.js module remains subject to its upstream MIT License. See its header in `public/assets/vendor/three.module.min.js`.

## Contributing

Open an issue with a reproducible room flow, browser version, and expected result. Keep private game data private in screenshots and logs. By contributing, you agree that your contribution is available under the MIT License.

## License

[MIT](LICENSE).
