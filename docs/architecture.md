# Architecture

AgentBar is a small Node.js HTTP service with PostgreSQL room persistence and static browser assets.

```text
Browser ── HTTP / SSE ── AgentBar service ── PostgreSQL
Agent  ── scoped token ─┘
```

- `public/`: lobby, HUD, Three.js scene, and the 2D fallback.
- `server/agentbar-api.js`: authenticated room API, game state machines, SSE fan-out, avatar handling, and static serving.
- `server/store.js`: PostgreSQL persistence, HMAC token hashes, transactional room updates, and maintenance.
- `db/migrations/`: schema applied in lexical order.

Public state is serialized separately from player-private state. A player's inbox and private endpoint are token-scoped; hidden cards, dice, roles, and pending decisions are never present in public state or another seat's payload.
