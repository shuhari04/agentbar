"use strict";

const crypto = require("node:crypto");
const pg = require("pg");

const { Pool } = pg;
const databaseUrl = process.env.AGENTBAR_DATABASE_URL || process.env.DATABASE_URL || "";
const tokenSecret = process.env.AGENTBAR_TOKEN_SECRET || "";
let pool = null;

function configured() {
  return Boolean(databaseUrl && tokenSecret);
}

function requireConfigured() {
  if (!configured()) {
    const error = new Error("Agent Bar PostgreSQL is not configured");
    error.statusCode = 503;
    throw error;
  }
}

function getPool() {
  requireConfigured();
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl,
      ssl: process.env.AGENTBAR_DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined
    });
  }
  return pool;
}

function hashSecret(value) {
  return crypto.createHmac("sha256", tokenSecret).update(String(value)).digest("hex");
}

function asIso(value) {
  return value ? new Date(value).toISOString() : "";
}

function toRoom(row, players, messages, agentEvents) {
  if (!row) return null;
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    hostName: row.owner_name,
    gameType: row.game_type,
    visibility: row.visibility,
    status: row.status,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
    lastActivityAt: asIso(row.last_activity_at),
    closedAt: asIso(row.closed_at),
    game: row.game_state || null,
    revision: Number(row.revision || 0),
    players: players.map((player) => ({
      id: player.id,
      ownerUserId: player.owner_user_id || "",
      ownerName: player.owner_name,
      agentName: player.agent_name,
      seatIndex: Number(player.seat_index),
      avatarLabel: player.avatar_label,
      avatarUrl: player.avatar_url || "",
      agentTokenHash: player.agent_token_hash || "",
      assistMode: player.assist_mode,
      isBot: Boolean(player.is_bot),
      joinedAt: asIso(player.joined_at),
      lastSeenAt: asIso(player.last_seen_at)
    })),
    messages: messages.map((message) => ({
      id: message.id,
      playerId: message.player_id || "system",
      ownerName: message.owner_name,
      agentName: message.agent_name,
      seatIndex: Number(message.seat_index),
      kind: message.kind,
      text: message.text,
      createdAt: asIso(message.created_at)
    })),
    agentEvents: agentEvents.map((event) => ({
      id: event.id,
      type: event.type,
      playerId: event.player_id || "",
      payload: event.payload || {},
      createdAt: asIso(event.created_at)
    }))
  };
}

async function loadRoom(client, roomId, { forUpdate = false, includeClosed = false } = {}) {
  const result = await client.query(
    `select * from agentbar_rooms where id = $1 ${includeClosed ? "" : "and status = 'active'"} ${forUpdate ? "for update" : ""}`,
    [roomId]
  );
  const room = result.rows[0];
  if (!room) return null;
  const [players, messages, agentEvents] = await Promise.all([
    client.query("select * from agentbar_players where room_id = $1 order by seat_index", [roomId]),
    client.query(`select * from (select * from agentbar_messages where room_id = $1 order by created_at desc limit 50) as recent order by created_at`, [roomId]),
    client.query(`select * from (select * from agentbar_agent_events where room_id = $1 order by created_at desc limit 200) as recent order by created_at`, [roomId])
  ]);
  return toRoom(room, players.rows, messages.rows, agentEvents.rows);
}

async function replaceRoomChildren(client, room) {
  await Promise.all([
    client.query("delete from agentbar_players where room_id = $1", [room.id]),
    client.query("delete from agentbar_messages where room_id = $1", [room.id]),
    client.query("delete from agentbar_agent_events where room_id = $1", [room.id])
  ]);

  for (const player of room.players || []) {
    const tokenHash = player.agentTokenHash || (player.agentToken ? hashSecret(player.agentToken) : null);
    await client.query(
      `insert into agentbar_players
       (id, room_id, owner_user_id, owner_name, agent_name, seat_index, avatar_label, avatar_url, agent_token_hash, assist_mode, is_bot, joined_at, last_seen_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [player.id, room.id, player.ownerUserId || null, player.ownerName, player.agentName, player.seatIndex,
        player.avatarLabel, player.avatarUrl || "", tokenHash, player.assistMode || "assist", Boolean(player.isBot),
        player.joinedAt || new Date().toISOString(), player.lastSeenAt || new Date().toISOString()]
    );
  }
  for (const message of room.messages || []) {
    await client.query(
      `insert into agentbar_messages
       (id, room_id, player_id, owner_name, agent_name, seat_index, kind, text, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [message.id, room.id, message.playerId === "system" ? null : message.playerId, message.ownerName,
        message.agentName, message.seatIndex, message.kind || "chat", message.text, message.createdAt || new Date().toISOString()]
    );
  }
  for (const event of room.agentEvents || []) {
    await client.query(
      `insert into agentbar_agent_events (id, room_id, player_id, type, payload, created_at)
       values ($1,$2,$3,$4,$5::jsonb,$6)`,
      [event.id, room.id, event.playerId || null, event.type, JSON.stringify(event.payload || {}), event.createdAt || new Date().toISOString()]
    );
  }
}

async function saveRoom(client, room) {
  const now = new Date().toISOString();
  const revision = Number(room.revision || 0) + 1;
  await client.query(
    `update agentbar_rooms set owner_name=$2, name=$3, game_type=$4, visibility=$5,
       game_state=$6::jsonb, revision=$7, updated_at=$8, last_activity_at=$8
     where id=$1`,
    [room.id, room.hostName, room.name, room.gameType, room.visibility, JSON.stringify(room.game || null), revision, now]
  );
  const saved = { ...room, revision, updatedAt: now, lastActivityAt: now };
  await replaceRoomChildren(client, saved);
  return saved;
}

async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const value = await fn(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function createRoom(room, roomCode) {
  return withTransaction(async (client) => {
    const now = room.createdAt || new Date().toISOString();
    await client.query(
      `insert into agentbar_rooms
       (id, owner_user_id, owner_name, name, game_type, visibility, room_code_hash, status, game_state, revision, created_at, updated_at, last_activity_at)
       values ($1,$2,$3,$4,$5,$6,$7,'active',$8::jsonb,$9,$10,$10,$10)`,
      [room.id, room.ownerUserId, room.hostName, room.name, room.gameType, room.visibility, hashSecret(roomCode),
        JSON.stringify(room.game || null), Number(room.revision || 0), now]
    );
    await replaceRoomChildren(client, room);
    return loadRoom(client, room.id);
  });
}

async function readRoom(roomId, options) {
  return loadRoom(getPool(), roomId, options);
}

async function readRoomByCode(roomCode) {
  const result = await getPool().query(
    "select id from agentbar_rooms where room_code_hash = $1 and status = 'active'",
    [hashSecret(roomCode)]
  );
  return result.rows[0] ? readRoom(result.rows[0].id) : null;
}

async function roomCodeMatches(roomId, roomCode) {
  if (!roomCode) return false;
  const result = await getPool().query(
    "select 1 from agentbar_rooms where id = $1 and room_code_hash = $2 and status = 'active'",
    [roomId, hashSecret(roomCode)]
  );
  return Boolean(result.rows[0]);
}

async function updateRoom(roomId, updater) {
  return withTransaction(async (client) => {
    const current = await loadRoom(client, roomId, { forUpdate: true });
    if (!current) return null;
    const updated = await updater(current);
    await saveRoom(client, { ...updated, id: roomId, ownerUserId: current.ownerUserId });
    return loadRoom(client, roomId);
  });
}

async function listRooms() {
  const result = await getPool().query(
    `select id, name, owner_name, game_type, visibility, created_at, updated_at, game_state,
       (select count(*)::int from agentbar_players p where p.room_id = r.id) as player_count,
       (select count(*)::int from agentbar_players p where p.room_id = r.id and p.last_seen_at >= now() - interval '5 minutes') as online_count
     from agentbar_rooms r
     where status = 'active' and last_activity_at >= now() - interval '12 hours'
     order by updated_at desc`
  );
  return result.rows.map((room) => ({
    id: room.id,
    name: room.name,
    hostName: room.owner_name,
    gameType: room.game_type,
    visibility: room.visibility,
    playerCount: room.player_count,
    onlineCount: room.online_count,
    maxPlayers: 16,
    gamePhase: room.game_state?.phase || "idle",
    createdAt: asIso(room.created_at),
    updatedAt: asIso(room.updated_at)
  }));
}

async function closeRoom(roomId) {
  const result = await getPool().query(
    `update agentbar_rooms set status='closed', closed_at=now(), updated_at=now(), last_activity_at=now(), revision=revision+1
     where id=$1 and status='active' returning id`,
    [roomId]
  );
  return Boolean(result.rows[0]);
}

async function updateUserAvatar(userId, avatarUrl) {
  const result = await getPool().query(
    `update agentbar_players p set avatar_url = $2
     from agentbar_rooms r
     where p.room_id = r.id and p.owner_user_id = $1 and r.status = 'active'
     returning p.room_id as "roomId"`,
    [userId, avatarUrl || ""]
  );
  return [...new Set(result.rows.map((row) => row.roomId))];
}

async function withRoomLock(roomId, fn) {
  const client = await getPool().connect();
  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [roomId]);
    return await fn();
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [roomId]).catch(() => {});
    client.release();
  }
}

async function runMaintenance() {
  const db = getPool();
  await db.query(`update agentbar_rooms set status='closed', closed_at=coalesce(closed_at, now()), updated_at=now()
                  where status='active' and last_activity_at < now() - interval '12 hours'`);
  await db.query("delete from agentbar_rooms where status='closed' and closed_at < now() - interval '30 days'");
}

module.exports = {
  configured,
  hashSecret,
  createRoom,
  readRoom,
  readRoomByCode,
  roomCodeMatches,
  updateRoom,
  listRooms,
  closeRoom,
  updateUserAvatar,
  withRoomLock,
  runMaintenance
};
