#!/usr/bin/env node

const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const externalOrigin = process.env.BAR_SMOKE_ORIGIN || "";
const port = Number(process.env.PORT || (19080 + Math.floor(Math.random() * 800)));
const origin = externalOrigin || `http://127.0.0.1:${port}`;
const testUserId = process.env.AGENTBAR_TEST_USER_ID || process.env.BAR_SMOKE_USER_ID || "";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForServer(server) {
  const deadline = Date.now() + 10000;
  let lastError;
  while (Date.now() < deadline) {
    if (server && server.exitCode !== null) throw new Error(`server exited early with code ${server.exitCode}`);
    try {
      const response = await fetch(`${origin}/api/healthz`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  throw new Error(`server did not become healthy: ${lastError?.message || "timeout"}`);
}

async function api(method, pathname, body, token, account = false) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(account ? { "X-AgentBar-Test-User": testUserId } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(`${method} ${pathname} failed: ${response.status} ${payload.error || ""}`);
  }
  return payload;
}

async function createRoom(gameType, name) {
  return api("POST", "/api/bar/rooms", { roomName: name, visibility: "private", gameType }, "", true);
}

async function join(room, index) {
  return api("POST", "/api/bar/rooms/join", {
    roomId: room.room.id,
    roomCode: room.roomCode,
    agentName: `Smoke Agent ${index}`,
    testCreateAdditionalSeat: index > 1
  }, "", true);
}

async function leave(roomId, player) {
  return api("POST", `/api/bar/rooms/${roomId}/leave`, {}, player.agentToken);
}

async function startGame(room, body) {
  return api("POST", `/api/bar/rooms/${room.room.id}/host/game/start`, body, "", true);
}

async function privateView(roomId, player) {
  return api("GET", `/api/bar/rooms/${roomId}/player/private`, undefined, player.agentToken);
}

async function commit(roomId, player, decision, optionId, action) {
  return api("POST", `/api/bar/rooms/${roomId}/player/decision/commit`, {
    decisionId: decision.id,
    optionId: optionId || "",
    action: action || null,
    source: "human"
  }, player.agentToken);
}

async function closeRoom(roomId) {
  await api("POST", `/api/bar/rooms/${roomId}/host/close`, {}, "", true).catch(() => {});
}

async function smokeLiarDeck() {
  const room = await createRoom("liar_deck", `Smoke Deck ${Date.now()}`);
  try {
    const players = [await join(room, 1), await join(room, 2)];
    const originalPlayerId = players[0].player.id;
    await leave(room.room.id, players[0]);
    const rejoined = await join(room, 1);
    assert(rejoined.player.id === originalPlayerId, "rejoin created a new player instead of restoring the seat");
    players[0] = rejoined;
    const started = await startGame(room, { type: "liar_deck", maxPlayers: 2 });
    assert(started.state.game?.type === "liar_deck", "liar deck did not start");
    assert(started.state.game?.decisionTimeoutSeconds === 30, "default decision timeout is not 30 seconds");
    assert(started.state.game?.roulette?.remainingChambers === 6, "liar deck roulette did not initialize");
    const timeoutUpdated = await api("POST", `/api/bar/rooms/${room.room.id}/host/game/decision-timeout`, { decisionTimeoutSeconds: 47 }, "", true);
    assert(timeoutUpdated.state.game.decisionTimeoutSeconds === 47, "host decision timeout update failed");
    const first = await privateView(room.room.id, players[0]);
    assert(first.private?.hand?.length > 0, "private hand missing");
    const playOption = first.decision?.options?.find((option) => option.action?.action === "play_cards");
    assert(playOption, "deck play decision missing");
    const played = await commit(room.room.id, players[0], first.decision, playOption.id);
    assert(played.state.game.lastPlay?.count > 0, "deck play not recorded");
    const second = await privateView(room.room.id, players[1]);
    const challenge = second.decision?.options?.find((option) => option.action?.action === "challenge");
    assert(challenge, "deck challenge decision missing");
    const revealed = await commit(room.room.id, players[1], second.decision, "", {
      gameId: second.game.id,
      action: "challenge",
      text: "我不信，开。"
    });
    assert(revealed.state.game.lastReveal, "deck reveal missing");
    assert(revealed.state.game.roulette, "roulette state missing after challenge");
    const switched = await startGame(room, { type: "liar_dice", diceCount: 3, decisionTimeoutSeconds: 30 });
    assert(switched.state.game?.type === "liar_dice", "host could not switch to a new game");
    assert(switched.state.players.length === 2, "switching games removed existing players");
    return "liar_deck";
  } finally {
    await closeRoom(room.room.id);
  }
}

async function smokeLiarDice() {
  const room = await createRoom("liar_dice", `Smoke Dice ${Date.now()}`);
  try {
    const players = [await join(room, 1), await join(room, 2)];
    const started = await startGame(room, { type: "liar_dice", diceCount: 5 });
    assert(started.state.game?.type === "liar_dice", "liar dice did not start");
    const firstId = started.state.game.turnPlayerId;
    const byId = new Map(players.map((player) => [player.player.id, player]));
    const firstPlayer = byId.get(firstId);
    const first = await privateView(room.room.id, firstPlayer);
    assert(first.private?.dice?.length === 5, "private dice missing");
    const bid = await commit(room.room.id, firstPlayer, first.decision, "", {
      gameId: started.state.game.id,
      action: "bid",
      quantity: 2,
      face: 4,
      text: "我叫 2 个 4。"
    });
    assert(bid.state.game.lastBid?.quantity === 2, "custom dice bid not recorded");
    const nextPlayer = byId.get(bid.state.game.turnPlayerId);
    const second = await privateView(room.room.id, nextPlayer);
    const challenge = second.decision?.options?.find((option) => option.action?.action === "challenge");
    assert(challenge, "dice challenge decision missing");
    const revealed = await commit(room.room.id, nextPlayer, second.decision, challenge.id);
    assert(revealed.state.game.diceRevealed, "dice were not revealed");
    return "liar_dice";
  } finally {
    await closeRoom(room.room.id);
  }
}

async function smokeUndercover() {
  const room = await createRoom("undercover", `Smoke Undercover ${Date.now()}`);
  try {
    const players = [];
    for (let index = 1; index <= 4; index += 1) players.push(await join(room, index));
    const started = await startGame(room, {
      type: "undercover",
      maxPlayers: 4,
      civilianWord: "SMOKE_COFFEE",
      undercoverWord: "SMOKE_TEA"
    });
    const serialized = JSON.stringify(started.state);
    assert(!serialized.includes("SMOKE_COFFEE") && !serialized.includes("SMOKE_TEA"), "undercover word leaked");
    const byId = new Map(players.map((player) => [player.player.id, player]));
    let state = started.state;
    for (const playerId of state.game.playerOrder) {
      const player = byId.get(playerId);
      const view = await privateView(room.room.id, player);
      assert(view.private?.word, "undercover private word missing");
      const option = view.decision?.options?.[0];
      assert(option, "describe decision missing");
      state = (await commit(room.room.id, player, view.decision, option.id)).state;
    }
    assert(state.game.phase === "voting", "undercover did not reach voting");
    for (const playerId of state.game.playerOrder) {
      if (state.game.phase === "ended") break;
      const player = byId.get(playerId);
      const view = await privateView(room.room.id, player);
      const option = view.decision?.options?.[0];
      if (option) state = (await commit(room.room.id, player, view.decision, option.id)).state;
    }
    assert(state.game.phase === "ended" && state.game.result?.winner, "undercover did not settle");
    return "undercover";
  } finally {
    await closeRoom(room.room.id);
  }
}

async function main() {
  if (!testUserId) throw new Error("AGENTBAR_TEST_USER_ID or BAR_SMOKE_USER_ID is required");
  let server = null;
  let dataDir = "";
  let stderr = "";
  if (!externalOrigin) {
    if (!process.env.AGENTBAR_DATABASE_URL || !process.env.AGENTBAR_TOKEN_SECRET) {
      throw new Error("AGENTBAR_DATABASE_URL and AGENTBAR_TOKEN_SECRET are required when spawning the smoke server");
    }
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentbar-bar-smoke-"));
    server = spawn(process.execPath, ["server/agentbar-api.js"], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        AGENTBAR_DATA_DIR: dataDir,
        AGENTBAR_PUBLIC_ORIGIN: origin,
        AGENTBAR_AUTH_PROVIDER: "guest",
        AGENTBAR_TEST_MODE: "true",
        AGENTBAR_TEST_USER_ID: testUserId
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    server.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  }
  try {
    await waitForServer(server);
    const passed = [await smokeLiarDeck(), await smokeLiarDice(), await smokeUndercover()];
    console.log(`Agent Bar API smoke passed on ${origin}: ${passed.join(", ")}`);
  } finally {
    if (server) server.kill("SIGTERM");
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  }
  if (stderr.trim()) console.error(stderr.trim());
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
