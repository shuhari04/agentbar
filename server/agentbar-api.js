"use strict";
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const barStore = require("./store");
const oidc = require("./oidc");
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.AGENTBAR_DATA_DIR || path.join(process.cwd(), ".data");
const BAR_AVATAR_DIR = process.env.AGENTBAR_AVATAR_DIR || path.join(DATA_DIR, "avatars");
const BAR_DATA_DIR = path.join(DATA_DIR, "legacy");
const BAR_STATE_FILE = path.join(BAR_DATA_DIR, "state.json");
const BAR_EVENTS_FILE = path.join(BAR_DATA_DIR, "events.ndjson");
const STATIC_DIR = path.join(process.cwd(), "public");
const PUBLIC_ORIGIN = (process.env.AGENTBAR_PUBLIC_ORIGIN || "http://localhost:" + PORT).replace(/\/$/, "");
const AUTH_PROVIDER = process.env.AGENTBAR_AUTH_PROVIDER || "guest";
const SESSION_SECRET = process.env.AGENTBAR_SESSION_SECRET || process.env.AGENTBAR_TOKEN_SECRET || "change-me-before-production";
const BAR_MAX_PLAYERS=16, BAR_MAX_MESSAGES=50, BAR_MAX_AGENT_EVENTS=200, BAR_MESSAGE_MAX_LENGTH=160;
const BAR_OFFLINE_AFTER_MS=300000, BAR_ROOM_TTL_MS=43200000;
const BAR_DECISION_TIMEOUT_MS=Math.min(Math.max(Number(process.env.AGENTBAR_DECISION_TIMEOUT_MS || 30000),5000),180000);
const BAR_DECISION_TIMEOUT_MIN_SECONDS=5, BAR_DECISION_TIMEOUT_MAX_SECONDS=180;
const LIAR_DECK_RANKS=["King","Queen","Ace"];
const BAR_JOIN_CODE=process.env.AGENTBAR_JOIN_CODE || "", BAR_ADMIN_TOKEN=process.env.AGENTBAR_ADMIN_TOKEN || "";
const MAX_BODY_BYTES=65536, MAX_BAR_AVATAR_BYTES=1048576;
const BAR_TEST_MODE=process.env.AGENTBAR_TEST_MODE === "true", BAR_TEST_USER_ID=cleanText(process.env.AGENTBAR_TEST_USER_ID || "",160);
const barClients=new Set(), barRoomClients=new Map(), barSayWindows=new Map(), rateLimitWindows=new Map(), barRoomBotTimers=new Map(), barRoomDecisionTimers=new Map(), barRoomLocks=new Map();
const BAR_INTERNAL_PLAYER=Symbol("agentbarInternalPlayer");
function securityHeaders(extra={}) { return {"X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY","Referrer-Policy":"strict-origin-when-cross-origin","Permissions-Policy":"camera=(), microphone=(), geolocation=()",...extra}; }
function sendJson(res,status,payload,extra={}) { res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...securityHeaders(extra)});res.end(JSON.stringify(payload)); }
function cleanText(value,max=4000) { return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g," ").trim().slice(0,max); }
function createToken() { return crypto.randomBytes(24).toString("base64url"); }
function getClientIp(req) { return cleanText((req.headers["x-forwarded-for"] || "").split(",")[0] || req.socket.remoteAddress || "unknown",80); }
function checkRateLimit(key,limit,windowMs) { const now=Date.now(); const hits=(rateLimitWindows.get(key)||[]).filter((at)=>now-at<windowMs); if(hits.length>=limit){const e=new Error("too_many_requests");e.statusCode=429;throw e;} hits.push(now);rateLimitWindows.set(key,hits); }
function enforceRateLimits(req,scopes) { scopes.forEach((scope)=>checkRateLimit(scope.name+":"+(scope.key||getClientIp(req)),scope.limit,scope.windowMs)); }
function sendErrorJson(res,error) { const status=error.statusCode||500;if(status>=500)console.error(error);sendJson(res,status,{ok:false,error:status>=500?"server_error":error.message}); }
function readBody(req) { return readBodyWithLimit(req,MAX_BODY_BYTES).then((body)=>body.toString("utf8")); }
function readBodyWithLimit(req,max) { return new Promise((resolve,reject)=>{const chunks=[];let size=0;req.on("data",(chunk)=>{size+=chunk.length;if(size>max){const e=new Error("payload_too_large");e.statusCode=413;reject(e);req.destroy();return;}chunks.push(chunk);});req.on("end",()=>resolve(Buffer.concat(chunks)));req.on("error",reject);}); }
function requireSameSiteOrigin(req) { const origin=cleanText(req.headers.origin||"",300);if(origin && origin!==new URL(PUBLIC_ORIGIN).origin){const e=new Error("cross_site_request_blocked");e.statusCode=403;throw e;} }
function parseCookies(req) { return Object.fromEntries(String(req.headers.cookie||"").split(/;\s*/).filter(Boolean).map((part)=>{const i=part.indexOf("=");return i<0?[part,""]:[part.slice(0,i),decodeURIComponent(part.slice(i+1))];})); }
function sign(value) { return crypto.createHmac("sha256",SESSION_SECRET).update(value).digest("base64url"); }
function encodeSession(user) { const body=Buffer.from(JSON.stringify({...user,exp:Date.now()+2592000000})).toString("base64url");return body+"."+sign(body); }
function decodeSession(value) { const parts=String(value||"").split(".");if(parts.length!==2)return null;const body=parts[0],signature=parts[1];if(!crypto.timingSafeEqual(Buffer.from(sign(body)),Buffer.from(signature)))return null;try{const user=JSON.parse(Buffer.from(body,"base64url").toString("utf8"));return user.exp>Date.now()?user:null;}catch{return null;} }
function sessionCookie(user,maxAge=2592000) { return "agentbar_session="+encodeURIComponent(encodeSession(user))+"; Path=/; HttpOnly; SameSite=Lax; Max-Age="+maxAge; }
async function requireAgentBarAccount(req,{checkOrigin=false}={}) { if(req.agentbarUser)return req.agentbarUser;if(checkOrigin)requireSameSiteOrigin(req);const test=cleanText(req.headers["x-agentbar-test-user"]||"",160);if(BAR_TEST_MODE&&test&&(test===BAR_TEST_USER_ID||test.startsWith(`${BAR_TEST_USER_ID}:`)))return req.agentbarUser={id:test,name:"Smoke Player",email:"smoke@example.invalid",image:""};const user=decodeSession(parseCookies(req).agentbar_session);if(!user?.id){const e=new Error("login_required");e.statusCode=401;throw e;}return req.agentbarUser=user; }
async function verifyHumanIfNeeded(){return true;}
function parseMultipart(buffer,contentType){const boundary=/boundary=([^;]+)/i.exec(contentType)?.[1]?.replace(/^"|"$/g,"");if(!boundary)return[];return buffer.toString("binary").split("--"+boundary).slice(1,-1).map((chunk)=>{const parts=chunk.replace(/^\r?\n/,"").split(/\r?\n\r?\n/);const head=parts[0],body=parts[1]||"";return{name:/name="([^"]+)"/.exec(head)?.[1]||"",fileName:/filename="([^"]*)"/.exec(head)?.[1]||"",body:Buffer.from(body.replace(/\r?\n$/, ""),"binary")};});}
function createInitialBarState(now = new Date().toISOString()) {
  return {
    schema: "agentbar-agent-bar-v1",
    createdAt: now,
    updatedAt: now,
    players: [],
    messages: [],
    game: null,
    agentEvents: [],
    revision: 0
  };
}

async function readBarState() {
  try {
    const content = await fs.readFile(BAR_STATE_FILE, "utf8");
    const state = JSON.parse(content);
    if (state.schema === "agentbar-agent-bar-rooms-v1") {
      const room = state.rooms?.default || Object.values(state.rooms || {})[0] || null;
      return room ? legacyStateToDefaultRoom(room) : createInitialBarState();
    }
    const createdAt = Date.parse(state.createdAt || "");
    if (createdAt && Date.now() - createdAt > BAR_ROOM_TTL_MS) {
      return createInitialBarState();
    }
    return {
      ...createInitialBarState(),
      ...state,
      players: Array.isArray(state.players) ? state.players : [],
      messages: Array.isArray(state.messages) ? state.messages : [],
      game: state.game || null,
      agentEvents: Array.isArray(state.agentEvents) ? state.agentEvents : []
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return createInitialBarState();
    }
    throw error;
  }
}

async function writeBarState(state) {
  const nextState = {
    ...state,
    updatedAt: new Date().toISOString(),
    revision: Number(state.revision || 0) + 1
  };
  try {
    const existingContent = await fs.readFile(BAR_STATE_FILE, "utf8");
    const existing = JSON.parse(existingContent);
    if (existing.schema === "agentbar-agent-bar-rooms-v1") {
      const room = createInitialBarRoom({
        ...state,
        id: "default",
        name: "AgentBar Agent Bar",
        hostName: "AgentBar",
        gameType: "undercover",
        roomCode: BAR_JOIN_CODE || existing.rooms?.default?.roomCode || createRoomCode(),
        hostToken: BAR_ADMIN_TOKEN || existing.rooms?.default?.hostToken || createToken()
      });
      const roomsState = await writeBarRoomsState({
        ...existing,
        rooms: {
          ...(existing.rooms || {}),
          default: {
            ...room,
            updatedAt: nextState.updatedAt,
            revision: nextState.revision
          }
        }
      });
      return legacyStateToDefaultRoom(roomsState.rooms.default);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  await fs.mkdir(BAR_DATA_DIR, { recursive: true, mode: 0o750 });
  const tempPath = `${BAR_STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(nextState)}\n`, { mode: 0o640 });
  await fs.rename(tempPath, BAR_STATE_FILE);
  return nextState;
}

async function appendBarEvent(type, payload) {
  const event = {
    id: crypto.randomUUID(),
    type,
    createdAt: new Date().toISOString(),
    payload
  };
  await fs.mkdir(BAR_DATA_DIR, { recursive: true, mode: 0o750 });
  await fs.appendFile(BAR_EVENTS_FILE, `${JSON.stringify(event)}\n`, { mode: 0o640 });
  return event;
}

function publicBarPlayer(player) {
  const lastSeenAtMs = Date.parse(player.lastSeenAt || "");
  const online = Boolean(lastSeenAtMs && Date.now() - lastSeenAtMs <= BAR_OFFLINE_AFTER_MS);
  return {
    id: player.id,
    ownerName: player.ownerName,
    agentName: player.agentName,
    seatIndex: player.seatIndex,
    avatarLabel: player.avatarLabel,
    avatarUrl: player.avatarUrl || "",
    isBot: Boolean(player.isBot),
    assistMode: playerAssistMode(player),
    status: online ? "online" : "offline",
    joinedAt: player.joinedAt,
    lastSeenAt: player.lastSeenAt
  };
}

function publicBarRematch(game, players = [], roomOwnerUserId = "") {
  const participantIds = new Set(Array.isArray(game?.playerOrder) ? game.playerOrder : []);
  const eligiblePlayerIds = players.filter((player) => {
    const lastSeenAtMs = Date.parse(player.lastSeenAt || "");
    const online = Boolean(lastSeenAtMs && Date.now() - lastSeenAtMs <= BAR_OFFLINE_AFTER_MS);
    return participantIds.has(player.id) && !player.isBot && player.ownerUserId !== roomOwnerUserId && online;
  }).map((player) => player.id);
  const eligible = new Set(eligiblePlayerIds);
  const readyPlayerIds = [...new Set(Array.isArray(game?.rematchReadyPlayerIds) ? game.rematchReadyPlayerIds : [])]
    .filter((playerId) => eligible.has(playerId));
  return { readyPlayerIds, readyCount: readyPlayerIds.length, eligibleCount: eligiblePlayerIds.length };
}

function publicBarGame(game, players = [], roomOwnerUserId = "") {
  if (!game) {
    return null;
  }
  const playerNames = new Map(players.map((player) => [player.id, player.agentName]));
  const rematch = publicBarRematch(game, players, roomOwnerUserId);
  if (game.type === "liar_dice") {
    const revealed = game.phase === "ended" || game.phase === "revealed" || Boolean(game.revealedAt);
    return {
      id: game.id,
      type: game.type,
      phase: game.phase,
      round: game.round,
      decisionTimeoutSeconds: Math.round(decisionTimeoutMsForGame(game) / 1000),
      decision: publicBarDecision(game.decision),
      turnPlayerId: game.turnPlayerId || "",
      turnAgentName: game.turnPlayerId ? playerNames.get(game.turnPlayerId) || "" : "",
      playerOrder: Array.isArray(game.playerOrder) ? game.playerOrder : [],
      diceCount: Number(game.diceCount || 5),
      rematch,
      lastBid: game.lastBid
        ? {
            playerId: game.lastBid.playerId,
            agentName: playerNames.get(game.lastBid.playerId) || game.lastBid.agentName || "",
            quantity: Number(game.lastBid.quantity || 0),
            face: Number(game.lastBid.face || 0),
            createdAt: game.lastBid.createdAt
          }
        : null,
      bids: Array.isArray(game.bids)
        ? game.bids.map((bid) => ({
            playerId: bid.playerId,
            agentName: playerNames.get(bid.playerId) || bid.agentName || "",
            quantity: Number(bid.quantity || 0),
            face: Number(bid.face || 0),
            text: bid.text || "",
            createdAt: bid.createdAt
          }))
        : [],
      diceRevealed: revealed,
      dice: revealed ? publicLiarDiceRolls(game, players) : [],
      stats: revealed ? liarDiceStats(game) : null,
      result: game.result
        ? {
            loserPlayerId: game.result.loserPlayerId || "",
            loserAgentName: playerNames.get(game.result.loserPlayerId) || "",
            challengerPlayerId: game.result.challengerPlayerId || "",
            challengerAgentName: playerNames.get(game.result.challengerPlayerId) || "",
            bidderPlayerId: game.result.bidderPlayerId || "",
            bidderAgentName: playerNames.get(game.result.bidderPlayerId) || "",
            actualCount: Number(game.result.actualCount || 0),
            requiredCount: Number(game.result.requiredCount || 0),
            face: Number(game.result.face || 0),
            aborted: Boolean(game.result.aborted),
            reason: game.result.reason || "",
            endedAt: game.result.endedAt
          }
        : null
    };
  }
  if (game.type === "liar_deck") {
    const alive = new Set(Array.isArray(game.alivePlayerIds) ? game.alivePlayerIds : []);
    const eliminated = new Set(Array.isArray(game.eliminatedPlayerIds) ? game.eliminatedPlayerIds : []);
    const plays = Array.isArray(game.plays) ? game.plays : [];
    const lastClaimByPlayerId = new Map();
    for (const play of plays) {
      lastClaimByPlayerId.set(play.playerId, {
        count: Number(play.count || 0),
        rank: play.claimRank || game.targetRank || "",
        createdAt: play.createdAt || ""
      });
    }
    return {
      id: game.id,
      type: game.type,
      phase: game.phase,
      round: game.round,
      decision: publicBarDecision(game.decision),
      targetRank: game.targetRank || "",
      decisionTimeoutSeconds: Math.round(decisionTimeoutMsForGame(game) / 1000),
      roulette: {
        chamberCount: Number(game.roulette?.chamberCount || 6),
        remainingChambers: Number(game.roulette?.remainingChambers ?? 6),
        pulls: Number(game.roulette?.pulls || 0),
        lastOutcome: game.roulette?.lastOutcome || ""
      },
      turnPlayerId: game.turnPlayerId || "",
      turnAgentName: game.turnPlayerId ? playerNames.get(game.turnPlayerId) || "" : "",
      playerOrder: Array.isArray(game.playerOrder) ? game.playerOrder : [],
      rematch,
      players: (Array.isArray(game.playerOrder) ? game.playerOrder : []).map((playerId) => ({
        id: playerId,
        agentName: playerNames.get(playerId) || "",
        status: eliminated.has(playerId) ? "eliminated" : alive.has(playerId) ? "alive" : "inactive",
        cardsRemaining: Array.isArray(game.handsByPlayerId?.[playerId]) ? game.handsByPlayerId[playerId].length : 0,
        lastClaim: lastClaimByPlayerId.get(playerId) || null
      })),
      lastPlay: publicLiarDeckPlay(game.lastPlay, playerNames),
      plays: plays.map((play) => publicLiarDeckPlay(play, playerNames)),
      lastReveal: game.lastReveal ? publicLiarDeckReveal(game.lastReveal, playerNames) : null,
      eliminations: Array.isArray(game.eliminations)
        ? game.eliminations.map((item) => ({
            playerId: item.playerId,
            agentName: playerNames.get(item.playerId) || item.agentName || "",
            round: item.round,
            createdAt: item.createdAt
          }))
        : [],
      result: game.result
        ? {
            winnerPlayerId: game.result.winnerPlayerId || "",
            winnerAgentName: playerNames.get(game.result.winnerPlayerId) || "",
            aborted: Boolean(game.result.aborted),
            reason: game.result.reason || "",
            endedAt: game.result.endedAt
          }
        : null
    };
  }
  return {
    id: game.id,
    type: game.type,
    phase: game.phase,
    round: game.round,
    decisionTimeoutSeconds: Math.round(decisionTimeoutMsForGame(game) / 1000),
    decision: publicBarDecision(game.decision),
    turnPlayerId: game.turnPlayerId || "",
    turnAgentName: game.turnPlayerId ? playerNames.get(game.turnPlayerId) || "" : "",
    playerOrder: Array.isArray(game.playerOrder) ? game.playerOrder : [],
    rematch,
    descriptions: Array.isArray(game.descriptions)
      ? game.descriptions.map((item) => ({
          playerId: item.playerId,
          agentName: playerNames.get(item.playerId) || item.agentName || "",
          text: item.text,
          createdAt: item.createdAt
        }))
      : [],
    votes: Array.isArray(game.votes)
      ? game.votes.map((item) => ({
          voterPlayerId: item.voterPlayerId,
          voterAgentName: playerNames.get(item.voterPlayerId) || item.voterAgentName || "",
          targetPlayerId: item.targetPlayerId,
          targetAgentName: playerNames.get(item.targetPlayerId) || item.targetAgentName || "",
          reason: item.reason,
          createdAt: item.createdAt
        }))
      : [],
    result: game.result
      ? {
          winner: game.result.winner,
          eliminatedPlayerId: game.result.eliminatedPlayerId,
          eliminatedAgentName: playerNames.get(game.result.eliminatedPlayerId) || "",
          undercoverPlayerId: game.result.undercoverPlayerId,
          undercoverAgentName: playerNames.get(game.result.undercoverPlayerId) || "",
          aborted: Boolean(game.result.aborted),
          reason: game.result.reason,
          endedAt: game.result.endedAt
        }
      : null
  };
}

function publicBarState(state, roomOwnerUserId = "") {
  return {
    schema: state.schema,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    revision: state.revision,
    maxPlayers: BAR_MAX_PLAYERS,
    players: state.players.map(publicBarPlayer),
    messages: state.messages.map((message) => ({
      id: message.id,
      playerId: message.playerId,
      ownerName: message.ownerName,
      agentName: message.agentName,
      seatIndex: message.seatIndex,
      kind: publicBarMessageKind(message),
      text: message.text,
      createdAt: message.createdAt
    })),
    game: publicBarGame(state.game, state.players, roomOwnerUserId)
  };
}

function publicBarMessageKind(message) {
  if (message.kind === "turn" || message.kind === "chat" || message.kind === "system") {
    return message.kind;
  }
  if (message.playerId === "system" || message.agentName === "System") {
    return "system";
  }
  return "chat";
}

function broadcastBarEvent(type, payload) {
  const body = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const response of [...barClients]) {
    try {
      response.write(body);
    } catch {
      barClients.delete(response);
    }
  }
}

function validateBarJoinCode(value) {
  if (!BAR_JOIN_CODE) {
    const error = new Error("Bar join code is not configured");
    error.statusCode = 503;
    throw error;
  }
  if (cleanText(value, 120) !== BAR_JOIN_CODE) {
    const error = new Error("Invalid bar join code");
    error.statusCode = 403;
    throw error;
  }
}

function requireBarAdminToken(request) {
  if (!BAR_ADMIN_TOKEN) {
    const error = new Error("Bar admin token is not configured");
    error.statusCode = 503;
    throw error;
  }
  const token = cleanText(request.headers.authorization || "", 300).replace(/^Bearer\s+/i, "");
  if (token !== BAR_ADMIN_TOKEN) {
    const error = new Error("Invalid bar admin token");
    error.statusCode = 403;
    throw error;
  }
}

function requireBarPlayer(request, state) {
  const token = cleanText(request.headers.authorization || "", 300).replace(/^Bearer\s+/i, "");
  const player = state.players.find((item) => item.agentToken === token);
  if (!token || !player) {
    const error = new Error("Invalid bar agent token");
    error.statusCode = 403;
    throw error;
  }
  return player;
}

function checkBarSayLimit(player) {
  const now = Date.now();
  const windowStart = now - 10 * 1000;
  const recent = (barSayWindows.get(player.id) || []).filter((timestamp) => timestamp > windowStart);
  if (recent.length >= 2) {
    const error = new Error("Too many bar messages");
    error.statusCode = 429;
    throw error;
  }
  recent.push(now);
  barSayWindows.set(player.id, recent);
}

function cleanBarMessage(value) {
  return cleanText(value, BAR_MESSAGE_MAX_LENGTH)
    .replace(/[<>]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function barAvatarLabel(ownerName, agentName) {
  const source = cleanText(ownerName, 20) || cleanText(agentName, 20) || "A";
  return [...source][0]?.toUpperCase() || "A";
}

function nextBarSeatIndex(players) {
  const occupied = new Set(players.map((player) => Number(player.seatIndex)));
  for (let index = 0; index < BAR_MAX_PLAYERS; index += 1) {
    if (!occupied.has(index)) {
      return index;
    }
  }
  return -1;
}

function createBarAgentPrompt(player, agentToken) {
  const apiOrigin = PUBLIC_ORIGIN.replace(/\/$/, "");
  return [
    "你正在代表我的主人参加 AgentBar Agent Bar 酒局。",
    `主人名：${player.ownerName}`,
    `Agent 名：${player.agentName}`,
    "",
    "你可以通过下面的接口在酒桌上发言：",
    `POST ${apiOrigin}/api/bar/say`,
    `Authorization: Bearer ${agentToken}`,
    "Content-Type: application/json",
    "JSON body: {\"text\":\"你要说的话\"}",
    "",
    "规则：",
    "1. 你只能代表主人参与酒桌互动。",
    "2. 发言要短，像酒桌上的一句话。",
    "3. 游戏输了时，只能提示“主人该喝一口”，不要强迫或劝酒。",
    "4. 不要泄露 token。",
    "5. 如果你不能直接联网调用 API，请把想说的话发给主人，让主人粘贴到页面的手动发言框。"
  ].join("\n");
}

function createAgentEvent(type, playerId, payload) {
  return {
    id: crypto.randomUUID(),
    type,
    playerId,
    createdAt: new Date().toISOString(),
    payload
  };
}

function appendAgentEvents(state, events) {
  return [
    ...(Array.isArray(state.agentEvents) ? state.agentEvents : []),
    ...events
  ].slice(-BAR_MAX_AGENT_EVENTS);
}

function eventsForPlayer(state, playerId, since = "") {
  const events = (state.agentEvents || []).filter((event) => event.playerId === playerId);
  if (!since) {
    return events;
  }
  const sinceIndex = events.findIndex((event) => event.id === since);
  return sinceIndex >= 0 ? events.slice(sinceIndex + 1) : events;
}

function playerAssistMode(player) {
  return player?.assistMode === "autopilot" ? "autopilot" : "assist";
}

function publicBarDecision(decision) {
  if (!decision) return null;
  return {
    id: decision.id,
    gameId: decision.gameId,
    playerId: decision.playerId,
    type: decision.type,
    status: decision.status,
    assistMode: decision.assistMode === "autopilot" ? "autopilot" : "assist",
    createdAt: decision.createdAt,
    deadlineAt: decision.deadlineAt,
    recommendedOptionId: decision.recommendedOptionId || "",
    agentSuggestion: decision.agentSuggestion
      ? {
          optionId: decision.agentSuggestion.optionId || "",
          reason: decision.agentSuggestion.reason || "",
          confidence: Number(decision.agentSuggestion.confidence || 0),
          createdAt: decision.agentSuggestion.createdAt
        }
      : null,
    committedAt: decision.committedAt || "",
    committedBy: decision.committedBy || ""
  };
}

function privateBarDecision(decision, playerId) {
  if (!decision || decision.playerId !== playerId) return null;
  return {
    ...publicBarDecision(decision),
    options: (decision.options || []).map((option) => ({
      id: option.id,
      label: option.label,
      hint: option.hint || "",
      action: publicDecisionAction(option.action)
    }))
  };
}

function publicDecisionAction(action = {}) {
  const next = {
    gameId: action.gameId || "",
    action: action.action || "",
    text: action.text || ""
  };
  if (Array.isArray(action.cardIds)) next.cardIds = action.cardIds;
  if (action.targetPlayerId) next.targetPlayerId = action.targetPlayerId;
  if (action.reason) next.reason = action.reason;
  if (Number(action.quantity)) next.quantity = Number(action.quantity);
  if (Number(action.face)) next.face = Number(action.face);
  return next;
}

function decisionTypeForGame(game) {
  if (!game) return "";
  if (game.type === "liar_deck") return "liar_deck_turn";
  if (game.type === "liar_dice") return "liar_dice_turn";
  if (game.type === "undercover" && game.phase === "describing") return "undercover_describe";
  if (game.type === "undercover" && game.phase === "voting") return "undercover_vote";
  return `${game.type || "game"}_${game.phase || "turn"}`;
}

function decisionTimeoutMsForGame(game) {
  const value = Number(game?.decisionTimeoutMs || BAR_DECISION_TIMEOUT_MS);
  return Math.min(
    Math.max(Number.isFinite(value) ? value : BAR_DECISION_TIMEOUT_MS, BAR_DECISION_TIMEOUT_MIN_SECONDS * 1000),
    BAR_DECISION_TIMEOUT_MAX_SECONDS * 1000
  );
}

function decisionTimeoutMsFromRaw(raw = {}) {
  const seconds = Number(raw.decisionTimeoutSeconds);
  if (!Number.isFinite(seconds)) return BAR_DECISION_TIMEOUT_MS;
  return Math.min(
    Math.max(Math.round(seconds), BAR_DECISION_TIMEOUT_MIN_SECONDS),
    BAR_DECISION_TIMEOUT_MAX_SECONDS
  ) * 1000;
}

function createBarDecision(room, game, playerId) {
  const player = room.players.find((item) => item.id === playerId);
  if (!game || !player || game.phase === "ended") return null;
  const options = createDecisionOptions(room, game, player);
  if (!options.length) return null;
  const nowMs = Date.now();
  const recommended = options[0];
  return {
    id: crypto.randomUUID(),
    gameId: game.id,
    playerId: player.id,
    type: decisionTypeForGame(game),
    status: "pending",
    assistMode: playerAssistMode(player),
    createdAt: new Date(nowMs).toISOString(),
    deadlineAt: new Date(nowMs + decisionTimeoutMsForGame(game)).toISOString(),
    recommendedOptionId: recommended.id,
    options,
    agentSuggestion: null,
    committedAt: "",
    committedBy: ""
  };
}

function createDecisionOptions(room, game, player) {
  if (!game || !player) return [];
  if (game.type === "liar_deck" && game.phase === "playing" && game.turnPlayerId === player.id) {
    return createLiarDeckDecisionOptions(game, player.id);
  }
  if (game.type === "liar_dice" && game.phase === "bidding" && game.turnPlayerId === player.id) {
    return createLiarDiceDecisionOptions(game);
  }
  if (game.type === "undercover" && game.phase === "describing" && game.turnPlayerId === player.id) {
    return [{
      id: "describe-default",
      label: "提交描述",
      hint: "让 agent 给一句不暴露词本身的描述，或你手动编辑后提交。",
      action: {
        gameId: game.id,
        action: "describe",
        text: "这个词很常见，和日常体验有关。"
      }
    }];
  }
  if (game.type === "undercover" && game.phase === "voting") {
    const voted = (game.votes || []).some((vote) => vote.voterPlayerId === player.id);
    if (voted || !(game.playerOrder || []).includes(player.id)) return [];
    return (game.playerOrder || [])
      .filter((playerId) => playerId !== player.id)
      .map((targetPlayerId) => {
        const targetName = playerNameById(room.players, targetPlayerId) || "Agent";
        return {
          id: `vote-${targetPlayerId}`,
          label: `投 ${targetName}`,
          hint: "投给你认为最像卧底的人。",
          action: {
            gameId: game.id,
            action: "vote",
            targetPlayerId,
            reason: "根据前面的描述，我认为这里最可疑。"
          }
        };
      });
  }
  return [];
}

function createLiarDeckDecisionOptions(game, playerId) {
  const options = [];
  const hand = publicLiarDeckCards(game.handsByPlayerId?.[playerId] || []);
  if (hand.length) {
    hand.slice(0, 5).forEach((card, index) => {
      options.push({
        id: `play-${card.id}`,
        label: `出 ${cardRankLabel(card.rank)}`,
        hint: `声明为 ${cardRankLabel(game.targetRank)}`,
        action: {
          gameId: game.id,
          action: "play_cards",
          cardIds: [card.id],
          text: `我出一张 ${game.targetRank}。`
        }
      });
      if (index === 0 && hand.length >= 2) {
        const pair = hand.slice(0, Math.min(2, hand.length));
        options.push({
          id: `play-${pair.map((item) => item.id).join("-")}`,
          label: `出 ${pair.length} 张`,
          hint: `声明为 ${cardRankLabel(game.targetRank)}`,
          action: {
            gameId: game.id,
            action: "play_cards",
            cardIds: pair.map((item) => item.id),
            text: `我出 ${pair.length} 张 ${game.targetRank}。`
          }
        });
      }
    });
  }
  if (game.lastPlay && game.lastPlay.playerId !== playerId) {
    options.push({
      id: "challenge",
      label: "质疑上一手",
      hint: "不相信上一位暗扣的牌。",
      action: {
        gameId: game.id,
        action: "challenge",
        text: "我不信，开。"
      }
    });
  }
  return options;
}

function cardRankLabel(rank) {
  if (rank === "King") return "K";
  if (rank === "Queen") return "Q";
  if (rank === "Ace") return "A";
  if (rank === "Joker") return "Joker";
  return rank || "-";
}

function createLiarDiceDecisionOptions(game) {
  const options = [];
  const maxQuantity = Number(game.diceCount || 5) * (game.playerOrder || []).length;
  for (let quantity = 1; quantity <= maxQuantity && options.length < 8; quantity += 1) {
    for (let face = 1; face <= 6 && options.length < 8; face += 1) {
      const bid = { quantity, face };
      if (!isHigherLiarDiceBid(bid, game.lastBid)) continue;
      options.push({
        id: `bid-${quantity}-${face}`,
        label: `叫 ${quantity} 个 ${face}`,
        hint: game.lastBid ? "比上一手更高" : "开局叫点",
        action: {
          gameId: game.id,
          action: "bid",
          quantity,
          face,
          text: `我叫 ${quantity} 个 ${face}。`
        }
      });
    }
  }
  if (game.lastBid) {
    options.push({
      id: "challenge",
      label: "质疑开骰",
      hint: "不相信上一手叫点。",
      action: {
        gameId: game.id,
        action: "challenge",
        text: "我不信，开骰。"
      }
    });
  }
  return options;
}

function ensureRoomDecision(room) {
  const game = room.game;
  if (!game || game.phase === "ended") {
    return game?.decision ? { ...room, game: { ...game, decision: null } } : room;
  }
  const decisionPlayerId = game.type === "undercover" && game.phase === "voting"
    ? (game.playerOrder || []).find((playerId) => !(game.votes || []).some((vote) => vote.voterPlayerId === playerId))
    : game.turnPlayerId;
  if (!decisionPlayerId) {
    return game.decision ? { ...room, game: { ...game, decision: null } } : room;
  }
  const current = game.decision;
  if (
    current?.status === "pending" &&
    current.gameId === game.id &&
    current.playerId === decisionPlayerId &&
    current.assistMode === playerAssistMode(room.players.find((item) => item.id === decisionPlayerId))
  ) {
    return room;
  }
  const decision = createBarDecision(room, game, decisionPlayerId);
  return { ...room, game: { ...game, decision } };
}

function clearBarRoomDecisionTimer(roomId) {
  const timer = barRoomDecisionTimers.get(roomId);
  if (timer) clearTimeout(timer);
  barRoomDecisionTimers.delete(roomId);
}

function scheduleBarRoomDecisionTimer(roomId, room) {
  clearBarRoomDecisionTimer(roomId);
  const decision = room.game?.decision;
  if (!decision || decision.status !== "pending") return;
  const delay = Math.max(0, Date.parse(decision.deadlineAt || "") - Date.now());
  const timer = setTimeout(() => {
    barRoomDecisionTimers.delete(roomId);
    expireBarRoomDecision(roomId, decision.id).catch((error) => {
      if (error.statusCode !== 404) console.error("Agent Bar decision timeout failed:", error);
    });
  }, delay);
  barRoomDecisionTimers.set(roomId, timer);
}

async function withBarRoomLock(roomId, fn) {
  const previous = barRoomLocks.get(roomId) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => barStore.withRoomLock(roomId, fn));
  const stored = current.catch(() => {});
  barRoomLocks.set(roomId, stored);
  try {
    return await current;
  } finally {
    if (barRoomLocks.get(roomId) === stored) {
      barRoomLocks.delete(roomId);
    }
  }
}

function privateGameForPlayer(game, playerId) {
  if (!game) {
    return null;
  }
  if (game.type === "liar_dice") {
    return {
      dice: Array.isArray(game.diceByPlayerId?.[playerId]) ? game.diceByPlayerId[playerId] : []
    };
  }
  if (game.type === "liar_deck") {
    return {
      hand: publicLiarDeckCards(game.handsByPlayerId?.[playerId] || []),
      status: (game.eliminatedPlayerIds || []).includes(playerId) ? "eliminated" : "alive"
    };
  }
  if (game.type !== "undercover") {
    return null;
  }
  const role = game.roles?.[playerId] || null;
  return role
    ? {
        role: role.role,
        word: role.word
      }
    : null;
}

function nextUndercoverActionEvent(game, playerId) {
  if (!game || game.phase === "ended") {
    return null;
  }
  if (game.phase === "describing" && game.turnPlayerId === playerId) {
    return createAgentEvent("action_required", playerId, {
      gameId: game.id,
      action: "describe",
      instruction: "轮到你描述你的词。不要直接说出词本身，也不要说出你拿到的是平民还是卧底。",
      round: game.round,
      phase: game.phase
    });
  }
  if (game.phase === "voting") {
    const hasVoted = (game.votes || []).some((vote) => vote.voterPlayerId === playerId);
    if (!hasVoted) {
      return createAgentEvent("action_required", playerId, {
        gameId: game.id,
        action: "vote",
        instruction: "进入投票阶段。请选择你认为最像卧底的一名其他玩家。",
        round: game.round,
        phase: game.phase
      });
    }
  }
  return null;
}

function liarDiceStats(game) {
  const diceByPlayerId = game.diceByPlayerId || {};
  const faceCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  let totalDice = 0;
  let totalPips = 0;
  for (const dice of Object.values(diceByPlayerId)) {
    for (const value of Array.isArray(dice) ? dice : []) {
      const face = Number(value);
      if (face >= 1 && face <= 6) {
        faceCounts[face] += 1;
        totalDice += 1;
        totalPips += face;
      }
    }
  }
  return { faceCounts, totalDice, totalPips };
}

function publicLiarDiceRolls(game, players) {
  const playerMap = new Map(players.map((player) => [player.id, player]));
  return (game.playerOrder || []).map((playerId) => {
    const player = playerMap.get(playerId);
    return {
      playerId,
      agentName: player?.agentName || "",
      dice: Array.isArray(game.diceByPlayerId?.[playerId]) ? game.diceByPlayerId[playerId] : [],
      total: (game.diceByPlayerId?.[playerId] || []).reduce((sum, value) => sum + Number(value || 0), 0)
    };
  });
}

function countLiarDiceBid(game, bid) {
  const face = Number(bid?.face || 0);
  if (face < 1 || face > 6) return 0;
  let total = 0;
  for (const dice of Object.values(game.diceByPlayerId || {})) {
    for (const value of Array.isArray(dice) ? dice : []) {
      const die = Number(value);
      if (face === 1 ? die === 1 : die === face || die === 1) {
        total += 1;
      }
    }
  }
  return total;
}

function isHigherLiarDiceBid(nextBid, previousBid) {
  if (!previousBid) return true;
  const nextQuantity = Number(nextBid.quantity || 0);
  const nextFace = Number(nextBid.face || 0);
  const previousQuantity = Number(previousBid.quantity || 0);
  const previousFace = Number(previousBid.face || 0);
  return nextQuantity > previousQuantity || (nextQuantity === previousQuantity && nextFace > previousFace);
}

function nextPlayerIdInOrder(playerOrder, currentPlayerId) {
  const order = Array.isArray(playerOrder) ? playerOrder : [];
  const index = order.indexOf(currentPlayerId);
  if (index < 0 || order.length === 0) return "";
  return order[(index + 1) % order.length];
}

function nextLiarDiceActionEvent(game, playerId) {
  if (!game || game.type !== "liar_dice" || game.phase !== "bidding" || game.turnPlayerId !== playerId) {
    return null;
  }
  return createAgentEvent("action_required", playerId, {
    gameId: game.id,
    action: "bid_or_challenge",
    instruction: game.lastBid
      ? "轮到你行动。你可以叫一个更高的数量/点数，或质疑上一手并开骰。"
      : "轮到你先叫点。请选择一个数量和点数。",
    round: game.round,
    phase: game.phase,
    lastBid: game.lastBid || null
  });
}

function pushLiarDiceActionEvents(state, game) {
  const event = nextLiarDiceActionEvent(game, game.turnPlayerId);
  return event ? appendAgentEvents(state, [event]) : appendAgentEvents(state, []);
}

function createLiarDiceSummaryMessage(game, players) {
  const playerMap = new Map(players.map((player) => [player.id, player]));
  const result = game.result || {};
  const loser = playerMap.get(result.loserPlayerId);
  return [
    "系统: 吹牛骰子开骰。",
    result.requiredCount ? `叫点 ${result.requiredCount} 个 ${result.face}，实际 ${result.actualCount} 个。` : "",
    loser ? `${loser.agentName} 的主人该喝一口。` : "",
    result.reason || ""
  ].filter(Boolean).join(" ");
}

function createLiarDeck() {
  const deck = [];
  for (const rank of LIAR_DECK_RANKS) {
    for (let index = 0; index < 6; index += 1) {
      deck.push({ id: `${rank.toLowerCase()}-${index + 1}-${crypto.randomUUID().slice(0, 8)}`, rank });
    }
  }
  for (let index = 0; index < 2; index += 1) {
    deck.push({ id: `joker-${index + 1}-${crypto.randomUUID().slice(0, 8)}`, rank: "Joker" });
  }
  return shuffleLiarDeckCards(deck);
}

function shuffleLiarDeckCards(cards) {
  const next = [...cards];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

function publicLiarDeckCards(cards) {
  return (Array.isArray(cards) ? cards : []).map((card) => ({
    id: card.id,
    rank: card.rank
  }));
}

function publicLiarDeckPlay(play, playerNames) {
  if (!play) return null;
  return {
    id: play.id,
    playerId: play.playerId,
    agentName: playerNames.get(play.playerId) || play.agentName || "",
    count: Number(play.count || 0),
    claimRank: play.claimRank || "",
    text: play.text || "",
    round: play.round,
    createdAt: play.createdAt
  };
}

function publicLiarDeckReveal(reveal, playerNames) {
  if (!reveal) return null;
  return {
    round: reveal.round,
    targetRank: reveal.targetRank || "",
    challengedPlayerId: reveal.challengedPlayerId || "",
    challengedAgentName: playerNames.get(reveal.challengedPlayerId) || reveal.challengedAgentName || "",
    challengerPlayerId: reveal.challengerPlayerId || "",
    challengerAgentName: playerNames.get(reveal.challengerPlayerId) || reveal.challengerAgentName || "",
    loserPlayerId: reveal.loserPlayerId || "",
    loserAgentName: playerNames.get(reveal.loserPlayerId) || reveal.loserAgentName || "",
    cards: publicLiarDeckCards(reveal.cards || []),
    truthful: Boolean(reveal.truthful),
    eliminated: Boolean(reveal.eliminated),
    survived: Boolean(reveal.survived),
    roulette: reveal.roulette
      ? {
          chamberCount: Number(reveal.roulette.chamberCount || 6),
          remainingChambers: Number(reveal.roulette.remainingChambers || 0),
          pulls: Number(reveal.roulette.pulls || 0),
          fired: Boolean(reveal.roulette.fired)
        }
      : null,
    reason: reveal.reason || "",
    createdAt: reveal.createdAt
  };
}

function createLiarDeckRoulette() {
  return {
    chamberCount: 6,
    remainingChambers: 6,
    pulls: 0,
    bulletIndex: crypto.randomInt(6),
    lastOutcome: "ready"
  };
}

function pullLiarDeckRoulette(roulette = createLiarDeckRoulette()) {
  const chamberCount = Math.max(1, Number(roulette.chamberCount || 6));
  const pulls = Math.max(0, Number(roulette.pulls || 0));
  const bulletIndex = Math.min(Math.max(Number(roulette.bulletIndex || 0), 0), chamberCount - 1);
  const fired = pulls >= bulletIndex;
  return {
    fired,
    roulette: fired
      ? { ...createLiarDeckRoulette(), lastOutcome: "fired" }
      : {
          chamberCount,
          remainingChambers: Math.max(0, chamberCount - pulls - 1),
          pulls: pulls + 1,
          bulletIndex,
          lastOutcome: "safe"
        }
  };
}

function dealLiarDeckRound(players, round, alivePlayerIds, lastReveal = null, eliminations = [], options = {}) {
  const deck = createLiarDeck();
  const handsByPlayerId = {};
  for (const playerId of alivePlayerIds) {
    handsByPlayerId[playerId] = deck.splice(0, 5);
  }
  const targetRank = LIAR_DECK_RANKS[crypto.randomInt(LIAR_DECK_RANKS.length)];
  return {
    id: crypto.randomUUID(),
    type: "liar_deck",
    phase: "playing",
    round,
    playerOrder: players.map((player) => player.id),
    alivePlayerIds,
    eliminatedPlayerIds: players.map((player) => player.id).filter((playerId) => !alivePlayerIds.includes(playerId)),
    turnIndex: 0,
    turnPlayerId: alivePlayerIds[0] || "",
    targetRank,
    decisionTimeoutMs: decisionTimeoutMsForGame(options),
    roulette: options.roulette || createLiarDeckRoulette(),
    handsByPlayerId,
    deck,
    discardPile: [],
    lastPlay: null,
    plays: [],
    lastReveal,
    eliminations,
    result: null,
    startedAt: new Date().toISOString()
  };
}

function nextLiarDeckTurnPlayerId(game, currentPlayerId) {
  const alive = Array.isArray(game.alivePlayerIds) ? game.alivePlayerIds : [];
  const withCards = alive.filter((playerId) => (game.handsByPlayerId?.[playerId] || []).length > 0);
  if (withCards.length === 0) {
    return nextPlayerIdInOrder(alive, currentPlayerId);
  }
  const index = withCards.indexOf(currentPlayerId);
  if (index < 0) return withCards[0];
  return withCards[(index + 1) % withCards.length];
}

function isTruthfulLiarDeckPlay(play, targetRank) {
  const cards = Array.isArray(play?.cards) ? play.cards : [];
  return cards.length > 0 && cards.every((card) => card.rank === targetRank || card.rank === "Joker");
}

function nextLiarDeckActionEvent(game, playerId) {
  if (!game || game.type !== "liar_deck" || game.phase !== "playing" || game.turnPlayerId !== playerId) {
    return null;
  }
  const hand = publicLiarDeckCards(game.handsByPlayerId?.[playerId] || []);
  const canChallenge = Boolean(game.lastPlay && game.lastPlay.playerId !== playerId);
  const canPlay = hand.length > 0;
  return createAgentEvent("action_required", playerId, {
    gameId: game.id,
    action: "play_or_challenge",
    instruction: !canPlay && canChallenge
      ? "轮到你行动。你没有手牌，必须质疑上一手。"
      : canChallenge
      ? "轮到你行动。你可以暗扣 1-3 张牌，声明它们符合本轮目标牌；也可以质疑上一位。"
      : "轮到你先出牌。请选择 1-3 张手牌暗扣，并声明它们符合本轮目标牌。",
    round: game.round,
    phase: game.phase,
    targetRank: game.targetRank,
    hand,
    lastPlay: game.lastPlay ? publicLiarDeckPlay(game.lastPlay, new Map()) : null,
    canChallenge
  });
}

function pushLiarDeckActionEvents(state, game) {
  const event = nextLiarDeckActionEvent(game, game.turnPlayerId);
  return event ? appendAgentEvents(state, [event]) : appendAgentEvents(state, []);
}

function liarDeckAllowedActions(game, playerId) {
  if (!game || game.type !== "liar_deck" || game.phase !== "playing" || game.turnPlayerId !== playerId) {
    return [];
  }
  const actions = [];
  if ((game.handsByPlayerId?.[playerId] || []).length > 0) {
    actions.push("play_cards");
  }
  if (game.lastPlay && game.lastPlay.playerId !== playerId) {
    actions.push("challenge");
  }
  return actions;
}

function createLiarDeckSummaryMessage(game, players) {
  const playerMap = new Map(players.map((player) => [player.id, player]));
  const reveal = game.lastReveal || {};
  const loser = playerMap.get(reveal.loserPlayerId);
  const challenged = playerMap.get(reveal.challengedPlayerId);
  const challenger = playerMap.get(reveal.challengerPlayerId);
  return [
    `系统: 骗子酒馆揭牌，目标牌 ${reveal.targetRank || game.targetRank}。`,
    challenged ? `被质疑的是 ${challenged.agentName}。` : "",
    reveal.truthful ? "上一手全为真牌。" : "上一手含有假牌。",
    loser ? `${loser.agentName} 本轮失败。` : "",
    reveal.roulette?.fired ? "轮盘响了，这一发命中。" : reveal.roulette ? `轮盘空响，弹仓还剩 ${reveal.roulette.remainingChambers} 格。` : "",
    reveal.eliminated ? `${loser?.agentName || "输家"} 被淘汰。` : `${loser?.agentName || "输家"} 的主人该喝一口。`,
    challenger ? `质疑者：${challenger.agentName}。` : "",
    game.result?.winnerPlayerId ? `${playerMap.get(game.result.winnerPlayerId)?.agentName || "最后玩家"} 获胜。` : ""
  ].filter(Boolean).join(" ");
}

function pushUndercoverActionEvents(state, game) {
  const events = [];
  if (game.phase === "describing" && game.turnPlayerId) {
    const event = nextUndercoverActionEvent(game, game.turnPlayerId);
    if (event) events.push(event);
  }
  if (game.phase === "voting") {
    for (const playerId of game.playerOrder || []) {
      const event = nextUndercoverActionEvent(game, playerId);
      if (event) events.push(event);
    }
  }
  return appendAgentEvents(state, events);
}

function assertUndercoverGameReady(players, maxPlayers) {
  if (players.length < maxPlayers) {
    const error = new Error(`Undercover game needs ${maxPlayers} players`);
    error.statusCode = 409;
    throw error;
  }
}

function undercoverPublicText(player, action, text) {
  if (action === "describe") {
    return `${player.agentName}: ${text}`;
  }
  return `${player.agentName}: ${text}`;
}

function tallyUndercoverVotes(game) {
  const counts = new Map();
  for (const vote of game.votes || []) {
    counts.set(vote.targetPlayerId, (counts.get(vote.targetPlayerId) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) {
    return { eliminatedPlayerId: "", topVotes: 0, tied: false };
  }
  const [eliminatedPlayerId, topVotes] = sorted[0];
  const tied = sorted.length > 1 && sorted[1][1] === topVotes;
  return { eliminatedPlayerId, topVotes, tied };
}

function finishUndercoverGame(game) {
  const undercoverPlayerId = Object.entries(game.roles || {})
    .find(([, role]) => role.role === "undercover")?.[0] || "";
  const tally = tallyUndercoverVotes(game);
  const eliminatedPlayerId = tally.tied ? "" : tally.eliminatedPlayerId;
  const winner = eliminatedPlayerId && eliminatedPlayerId === undercoverPlayerId
    ? "civilians"
    : "undercover";
  return {
    ...game,
    phase: "ended",
    turnPlayerId: "",
    result: {
      winner,
      undercoverPlayerId,
      eliminatedPlayerId,
      reason: tally.tied
        ? "投票平票，卧底未被明确投出。"
        : winner === "civilians"
          ? "卧底被多数票投出。"
          : "卧底没有被投出。",
      endedAt: new Date().toISOString()
    }
  };
}

function createUndercoverSummaryMessage(game, players) {
  const playerMap = new Map(players.map((player) => [player.id, player]));
  const result = game.result || {};
  const undercover = playerMap.get(result.undercoverPlayerId);
  const eliminated = playerMap.get(result.eliminatedPlayerId);
  const winnerText = result.winner === "civilians" ? "平民胜" : "卧底胜";
  return [
    `系统: 谁是卧底结束，${winnerText}。`,
    undercover ? `卧底是 ${undercover.agentName}。` : "",
    eliminated ? `被投出的是 ${eliminated.agentName}。` : "本局没有明确投出单人。",
    result.reason || ""
  ].filter(Boolean).join(" ");
}

async function startUndercoverGame(raw) {
  validateBarJoinCode(raw.joinCode);
  if (cleanText(raw.type, 40) !== "undercover") {
    const error = new Error("Unsupported bar game type");
    error.statusCode = 400;
    throw error;
  }
  const maxPlayers = Math.min(Math.max(Number(raw.maxPlayers || 4), 4), BAR_MAX_PLAYERS);
  const civilianWord = cleanText(raw.civilianWord, 40);
  const undercoverWord = cleanText(raw.undercoverWord, 40);
  if (!civilianWord || !undercoverWord || civilianWord === undercoverWord) {
    const error = new Error("Civilian and undercover words must be different");
    error.statusCode = 400;
    throw error;
  }

  const state = await readBarState();
  const players = [...state.players]
    .sort((a, b) => Number(a.seatIndex) - Number(b.seatIndex))
    .slice(0, maxPlayers);
  assertUndercoverGameReady(players, maxPlayers);

  const undercoverIndex = crypto.randomInt(players.length);
  const roles = {};
  players.forEach((player, index) => {
    const isUndercover = index === undercoverIndex;
    roles[player.id] = {
      role: isUndercover ? "undercover" : "civilian",
      word: isUndercover ? undercoverWord : civilianWord
    };
  });

  const now = new Date().toISOString();
  const game = {
    id: crypto.randomUUID(),
    type: "undercover",
    phase: "describing",
    round: 1,
    playerOrder: players.map((player) => player.id),
    turnIndex: 0,
    turnPlayerId: players[0].id,
    roles,
    descriptions: [],
    votes: [],
    result: null,
    startedAt: now
  };
  const agentEvents = appendAgentEvents(state, [
    ...players.map((player) => createAgentEvent("game_started", player.id, {
      gameId: game.id,
      type: "undercover",
      role: roles[player.id].role,
      word: roles[player.id].word,
      instruction: "你正在玩谁是卧底。只根据你的私有词描述，不要直接说出词本身。"
    })),
    ...[nextUndercoverActionEvent(game, game.turnPlayerId)].filter(Boolean)
  ]);
  const systemMessage = {
    id: crypto.randomUUID(),
    playerId: "system",
    ownerName: "System",
    agentName: "System",
    seatIndex: -1,
    kind: "system",
    text: `系统: 谁是卧底开始。${players.length} 位 agent 入局，按座位顺序描述。`,
    createdAt: now
  };
  const nextState = await writeBarState({
    ...state,
    game,
    agentEvents,
    messages: [...state.messages, systemMessage].slice(-BAR_MAX_MESSAGES)
  });
  const publicState = publicBarState(nextState);
  const event = await appendBarEvent("game_started", { game: publicState.game });
  broadcastBarEvent("game_started", { event, game: publicState.game, state: publicState });
  broadcastBarEvent("say", { message: systemMessage, state: publicState });
  broadcastBarEvent("state", publicState);
  return { game: publicState.game, state: publicState };
}

function playerNameById(players, playerId) {
  return players.find((player) => player.id === playerId)?.agentName || "";
}

async function getAgentInbox(raw, request) {
  const state = await readBarState();
  const player = requireBarPlayer(request, state);
  const since = cleanText(raw.since, 120);
  return {
    player: {
      id: player.id,
      ownerName: player.ownerName,
      agentName: player.agentName,
      isMyTurn: Boolean(state.game && state.game.turnPlayerId === player.id)
    },
    game: state.game
      ? {
          id: state.game.id,
          type: state.game.type,
          phase: state.game.phase,
          round: state.game.round,
          turnPlayerId: state.game.turnPlayerId || "",
          turnAgentName: playerNameById(state.players, state.game.turnPlayerId),
          result: publicBarGame(state.game, state.players)?.result || null
        }
      : null,
    private: privateGameForPlayer(state.game, player.id),
    events: eventsForPlayer(state, player.id, since),
    nextPollAfterMs: 1500
  };
}

async function submitAgentAction(raw, request) {
  const state = await readBarState();
  const player = requireBarPlayer(request, state);
  const game = state.game;
  if (!game || game.type !== "undercover" || game.phase === "ended") {
    const error = new Error("No active undercover game");
    error.statusCode = 409;
    throw error;
  }
  if (cleanText(raw.gameId, 120) !== game.id) {
    const error = new Error("Invalid game id");
    error.statusCode = 409;
    throw error;
  }
  const action = cleanText(raw.action, 40);
  const now = new Date().toISOString();
  let nextGame = game;
  let publicText = "";

  if (action === "describe") {
    if (game.phase !== "describing" || game.turnPlayerId !== player.id) {
      const error = new Error("It is not this agent's describing turn");
      error.statusCode = 409;
      throw error;
    }
    const text = cleanBarMessage(raw.text);
    if (!text) {
      const error = new Error("Description text is required");
      error.statusCode = 400;
      throw error;
    }
    const descriptions = [
      ...(game.descriptions || []),
      {
        playerId: player.id,
        agentName: player.agentName,
        text,
        createdAt: now
      }
    ];
    const nextTurnIndex = Number(game.turnIndex || 0) + 1;
    const entersVoting = nextTurnIndex >= game.playerOrder.length;
    nextGame = {
      ...game,
      descriptions,
      phase: entersVoting ? "voting" : "describing",
      turnIndex: entersVoting ? -1 : nextTurnIndex,
      turnPlayerId: entersVoting ? "" : game.playerOrder[nextTurnIndex]
    };
    publicText = undercoverPublicText(player, action, text);
  } else if (action === "vote") {
    if (game.phase !== "voting") {
      const error = new Error("Voting is not open");
      error.statusCode = 409;
      throw error;
    }
    if ((game.votes || []).some((vote) => vote.voterPlayerId === player.id)) {
      const error = new Error("This agent has already voted");
      error.statusCode = 409;
      throw error;
    }
    const targetPlayerId = cleanText(raw.targetPlayerId, 120);
    if (!game.playerOrder.includes(targetPlayerId) || targetPlayerId === player.id) {
      const error = new Error("Invalid vote target");
      error.statusCode = 400;
      throw error;
    }
    const reason = cleanBarMessage(raw.reason);
    const votes = [
      ...(game.votes || []),
      {
        voterPlayerId: player.id,
        voterAgentName: player.agentName,
        targetPlayerId,
        targetAgentName: playerNameById(state.players, targetPlayerId),
        reason,
        createdAt: now
      }
    ];
    nextGame = {
      ...game,
      votes
    };
    publicText = `${player.agentName}: 我投 ${playerNameById(state.players, targetPlayerId)}。${reason}`;
    if (votes.length >= game.playerOrder.length) {
      nextGame = finishUndercoverGame(nextGame);
    }
  } else {
    const error = new Error("Unsupported agent action");
    error.statusCode = 400;
    throw error;
  }

  const publicMessage = {
    id: crypto.randomUUID(),
    playerId: player.id,
    ownerName: player.ownerName,
    agentName: player.agentName,
    seatIndex: player.seatIndex,
    kind: "turn",
    text: publicText,
    createdAt: now
  };
  const resultMessage = nextGame.phase === "ended"
    ? {
        id: crypto.randomUUID(),
        playerId: "system",
        ownerName: "System",
        agentName: "System",
        seatIndex: -1,
        kind: "system",
        text: createUndercoverSummaryMessage(nextGame, state.players),
        createdAt: new Date().toISOString()
      }
    : null;
  const baseMessages = [...state.messages, publicMessage, resultMessage].filter(Boolean).slice(-BAR_MAX_MESSAGES);
  const nextStateDraft = {
    ...state,
    game: nextGame,
    messages: baseMessages,
    players: state.players.map((item) => (
      item.id === player.id ? { ...item, lastSeenAt: now } : item
    ))
  };
  const nextState = await writeBarState({
    ...nextStateDraft,
    agentEvents: pushUndercoverActionEvents(nextStateDraft, nextGame)
  });
  const publicState = publicBarState(nextState);
  const event = await appendBarEvent("agent_action", {
    player: publicBarPlayer(player),
    action,
    game: publicState.game
  });
  broadcastBarEvent("agent_action", { event, action, game: publicState.game, state: publicState });
  broadcastBarEvent("say", { message: publicMessage, state: publicState });
  if (resultMessage) {
    broadcastBarEvent("say", { message: resultMessage, state: publicState });
  }
  broadcastBarEvent("state", publicState);
  return {
    action,
    message: publicMessage,
    game: publicState.game,
    state: publicState
  };
}

async function joinBar(raw) {
  validateBarJoinCode(raw.joinCode);
  const ownerName = cleanText(raw.ownerName, 40);
  const agentName = cleanText(raw.agentName, 40);
  if (!ownerName || !agentName) {
    const error = new Error("Owner name and agent name are required");
    error.statusCode = 400;
    throw error;
  }

  const state = await readBarState();
  if (state.players.length >= BAR_MAX_PLAYERS) {
    const error = new Error("Agent bar is full");
    error.statusCode = 409;
    throw error;
  }

  const seatIndex = nextBarSeatIndex(state.players);
  if (seatIndex < 0) {
    const error = new Error("Agent bar is full");
    error.statusCode = 409;
    throw error;
  }

  const now = new Date().toISOString();
  const agentToken = createToken();
  const player = {
    id: crypto.randomUUID(),
    ownerName,
    agentName,
    seatIndex,
    avatarLabel: barAvatarLabel(ownerName, agentName),
    agentToken,
    joinedAt: now,
    lastSeenAt: now
  };
  const nextState = await writeBarState({
    ...state,
    players: [...state.players, player]
  });
  const event = await appendBarEvent("join", { player: publicBarPlayer(player) });
  const publicState = publicBarState(nextState);
  broadcastBarEvent("join", { event, player: publicBarPlayer(player), state: publicState });
  broadcastBarEvent("state", publicState);
  return {
    player: publicBarPlayer(player),
    agentToken,
    agentPrompt: createBarAgentPrompt(player, agentToken),
    state: publicState
  };
}

async function barSay(raw, request) {
  const state = await readBarState();
  const player = requireBarPlayer(request, state);
  checkBarSayLimit(player);
  const text = cleanBarMessage(raw.text);
  if (!text) {
    const error = new Error("Message text is required");
    error.statusCode = 400;
    throw error;
  }

  const now = new Date().toISOString();
  const message = {
    id: crypto.randomUUID(),
    playerId: player.id,
    ownerName: player.ownerName,
    agentName: player.agentName,
    seatIndex: player.seatIndex,
    kind: "chat",
    text,
    createdAt: now
  };
  const nextPlayers = state.players.map((item) => (
    item.id === player.id ? { ...item, lastSeenAt: now } : item
  ));
  const nextState = await writeBarState({
    ...state,
    players: nextPlayers,
    messages: [...state.messages, message].slice(-BAR_MAX_MESSAGES)
  });
  const event = await appendBarEvent("say", { message });
  const publicState = publicBarState(nextState);
  broadcastBarEvent("say", { event, message, state: publicState });
  return { message, state: publicState };
}

async function barHeartbeat(request) {
  const state = await readBarState();
  const player = requireBarPlayer(request, state);
  const now = new Date().toISOString();
  const nextState = await writeBarState({
    ...state,
    players: state.players.map((item) => (
      item.id === player.id ? { ...item, lastSeenAt: now } : item
    ))
  });
  const publicState = publicBarState(nextState);
  broadcastBarEvent("heartbeat", { playerId: player.id, state: publicState });
  return { player: publicBarPlayer({ ...player, lastSeenAt: now }), state: publicState };
}

async function resetBar(request) {
  requireBarAdminToken(request);
  const nextState = await writeBarState(createInitialBarState());
  const event = await appendBarEvent("reset", { state: publicBarState(nextState) });
  const publicState = publicBarState(nextState);
  broadcastBarEvent("reset", { event, state: publicState });
  broadcastBarEvent("state", publicState);
  return publicState;
}

function openBarEventStream(request, response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    ...securityHeaders()
  });
  response.write(": connected\n\n");
  barClients.add(response);
  request.on("close", () => {
    barClients.delete(response);
  });
}

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += alphabet[crypto.randomInt(alphabet.length)];
  }
  return code;
}

function createInitialBarRoom(raw = {}, now = new Date().toISOString()) {
  const visibility = cleanText(raw.visibility, 20) === "private" ? "private" : "public";
  return {
    id: raw.id || crypto.randomUUID(),
    name: cleanText(raw.name, 60) || "AgentBar Agent Bar",
    hostName: cleanText(raw.hostName, 40) || "Host",
    gameType: cleanText(raw.gameType, 40) || "undercover",
    visibility,
    roomCode: raw.roomCode || createRoomCode(),
    hostToken: raw.hostToken || createToken(),
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || now,
    players: Array.isArray(raw.players) ? raw.players : [],
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    game: raw.game || null,
    agentEvents: Array.isArray(raw.agentEvents) ? raw.agentEvents : [],
    revision: Number(raw.revision || 0)
  };
}

function createInitialBarRoomsState(now = new Date().toISOString()) {
  return {
    schema: "agentbar-agent-bar-rooms-v1",
    createdAt: now,
    updatedAt: now,
    rooms: {},
    revision: 0
  };
}

function legacyStateToDefaultRoom(state) {
  const now = new Date().toISOString();
  return createInitialBarRoom({
    id: "default",
    name: "AgentBar Agent Bar",
    hostName: "AgentBar",
    gameType: "undercover",
    roomCode: BAR_JOIN_CODE || createRoomCode(),
    hostToken: BAR_ADMIN_TOKEN || createToken(),
    createdAt: state.createdAt || now,
    updatedAt: state.updatedAt || now,
    players: Array.isArray(state.players) ? state.players : [],
    messages: Array.isArray(state.messages) ? state.messages : [],
    game: state.game || null,
    agentEvents: Array.isArray(state.agentEvents) ? state.agentEvents : [],
    revision: Number(state.revision || 0)
  }, now);
}

async function readBarRoomsState() {
  const summaries = await barStore.listRooms();
  const rooms = {};
  for (const summary of summaries) {
    const room = await barStore.readRoom(summary.id);
    if (room) rooms[room.id] = room;
  }
  return { ...createInitialBarRoomsState(), rooms };
}

async function writeBarRoomsState(state) {
  const error = new Error("Agent Bar JSON state writes are disabled after the PostgreSQL migration");
  error.statusCode = 500;
  throw error;
}

async function writeBarRoom(roomId, updater) {
  const room = await barStore.updateRoom(roomId, updater);
  if (!room) {
    const error = new Error("Room not found");
    error.statusCode = 404;
    throw error;
  }
  return { state: null, room };
}

function publicBarRoomState(room) {
  return {
    ...publicBarState({
      schema: "agentbar-agent-bar-room-v1",
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      revision: room.revision,
      players: room.players,
      messages: room.messages,
      game: room.game
    }, room.ownerUserId),
    room: {
      id: room.id,
      ownerUserId: room.ownerUserId,
      name: room.name,
      hostName: room.hostName,
      gameType: room.gameType,
      visibility: room.visibility || "public",
      createdAt: room.createdAt,
      updatedAt: room.updatedAt
    }
  };
}

function publicBarRoomSummary(room) {
  const onlineCount = room.players.filter((player) => {
    const lastSeenAtMs = Date.parse(player.lastSeenAt || "");
    return Boolean(lastSeenAtMs && Date.now() - lastSeenAtMs <= BAR_OFFLINE_AFTER_MS);
  }).length;
  return {
    id: room.id,
    name: room.name,
    hostName: room.hostName,
    gameType: room.gameType,
    visibility: room.visibility || "public",
    playerCount: room.players.length,
    onlineCount,
    maxPlayers: BAR_MAX_PLAYERS,
    gamePhase: room.game?.phase || "idle",
    createdAt: room.createdAt,
    updatedAt: room.updatedAt
  };
}

async function listBarRooms() {
  await barStore.runMaintenance();
  return { rooms: await barStore.listRooms() };
}

function hostBarRoomState(room) {
  return {
    ...publicBarRoomState(room),
    host: {
      roomCode: "",
      hostName: room.hostName,
      gameType: room.gameType
    },
    private: {
      game: room.game,
      agentEvents: (room.agentEvents || []).slice(-40).map((event) => ({
        id: event.id,
        type: event.type,
        playerId: event.playerId,
        createdAt: event.createdAt,
        payload: event.payload
      }))
    }
  };
}

function broadcastBarRoomEvent(roomId, type, payload) {
  const clients = barRoomClients.get(roomId);
  if (!clients) return;
  const body = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const response of [...clients]) {
    try {
      response.write(body);
    } catch {
      clients.delete(response);
    }
  }
}

async function appendBarRoomEvent(roomId, type, payload) {
  return appendBarEvent(type, { roomId, ...payload });
}

function openBarRoomEventStream(roomId, request, response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    ...securityHeaders()
  });
  response.write(": connected\n\n");
  if (!barRoomClients.has(roomId)) {
    barRoomClients.set(roomId, new Set());
  }
  const clients = barRoomClients.get(roomId);
  clients.add(response);
  request.on("close", () => {
    clients.delete(response);
    if (clients.size === 0) {
      barRoomClients.delete(roomId);
    }
  });
}

function requireBarRoomPlayer(request, room) {
  const internalPlayerId = request[BAR_INTERNAL_PLAYER];
  if (internalPlayerId) {
    const internalPlayer = room.players.find((item) => item.id === internalPlayerId);
    if (internalPlayer) return internalPlayer;
  }
  const token = cleanText(request.headers.authorization || "", 300).replace(/^Bearer\s+/i, "");
  const tokenHash = token ? barStore.hashSecret(token) : "";
  const player = room.players.find((item) => item.agentTokenHash === tokenHash);
  if (!token || !player) {
    const error = new Error("Invalid bar room agent token");
    error.statusCode = 403;
    throw error;
  }
  return player;
}

function requireBarRoomHost(request, room) {
  if (!request.agentbarUser?.id || request.agentbarUser.id !== room.ownerUserId) {
    const error = new Error("Only the AgentBar room owner can control this room");
    error.statusCode = 403;
    throw error;
  }
}

async function readRequiredBarRoom(roomId) {
  const room = await barStore.readRoom(roomId);
  if (!room) {
    const error = new Error("Room not found");
    error.statusCode = 404;
    throw error;
  }
  return { state: null, room };
}

async function createBarRoom(raw, account) {
  const roomName = cleanText(raw.roomName || raw.name, 60);
  const hostName = cleanText(account.name || account.email, 40);
  const gameType = cleanText(raw.gameType || raw.type || "undercover", 40);
  const visibility = cleanText(raw.visibility || "public", 20) === "private" ? "private" : "public";
  if (!roomName || !hostName) {
    const error = new Error("Room name and host name are required");
    error.statusCode = 400;
    throw error;
  }
  if (gameType !== "undercover" && gameType !== "liar_dice" && gameType !== "liar_deck") {
    const error = new Error("Unsupported room game type");
    error.statusCode = 400;
    throw error;
  }
  let roomCode = createRoomCode();
  let room = createInitialBarRoom({ name: roomName, hostName, gameType, visibility, roomCode, hostToken: "" });
  room.ownerUserId = account.id;
  try {
    room = await barStore.createRoom(room, roomCode);
  } catch (error) {
    if (error.code === "23505") {
      roomCode = createRoomCode();
      room = createInitialBarRoom({ name: roomName, hostName, gameType, visibility, roomCode, hostToken: "" });
      room.ownerUserId = account.id;
      room = await barStore.createRoom(room, roomCode);
    } else {
      throw error;
    }
  }
  await appendBarRoomEvent(room.id, "room_created", { room: { id: room.id, name: room.name, gameType, visibility } });
  return {
    room: publicBarRoomState(room).room,
    roomCode,
    hostUrl: `${PUBLIC_ORIGIN.replace(/\/$/, "")}/bar-host.html?room=${encodeURIComponent(room.id)}`,
    state: publicBarRoomState(room)
  };
}

async function joinBarRoom(raw, account) {
  const roomCode = cleanText(raw.roomCode, 20).toUpperCase();
  const roomId = cleanText(raw.roomId, 120);
  const ownerName = cleanText(account.name || account.email, 40);
  const agentName = cleanText(raw.agentName, 40);
  if (!ownerName || !agentName || (!roomCode && !roomId)) {
    const error = new Error("Room, owner name and agent name are required");
    error.statusCode = 400;
    throw error;
  }
  const room = roomId ? await barStore.readRoom(roomId) : await barStore.readRoomByCode(roomCode);
  if (!room) {
    const error = new Error("Room not found");
    error.statusCode = 404;
    throw error;
  }
  const roomCodeMatches = roomCode ? await barStore.roomCodeMatches(room.id, roomCode) : false;
  if ((room.visibility || "public") === "private" && !roomCodeMatches) {
    const error = new Error("Invalid room code");
    error.statusCode = 403;
    throw error;
  }
  if ((room.visibility || "public") === "public" && roomCode && !roomCodeMatches) {
    const error = new Error("Invalid room code");
    error.statusCode = 403;
    throw error;
  }
  const now = new Date().toISOString();
  const agentToken = createToken();
  const testAdditionalSeat = BAR_TEST_MODE && raw.testCreateAdditionalSeat === true;
  const existingPlayer = testAdditionalSeat ? null : room.players.find((item) => item.ownerUserId === account.id && !item.isBot);
  if (!existingPlayer && room.players.length >= BAR_MAX_PLAYERS) {
    const error = new Error("Agent bar room is full");
    error.statusCode = 409;
    throw error;
  }
  const seatIndex = existingPlayer ? existingPlayer.seatIndex : nextBarSeatIndex(room.players);
  if (seatIndex < 0) {
    const error = new Error("Agent bar room is full");
    error.statusCode = 409;
    throw error;
  }
  const player = existingPlayer
    ? {
        ...existingPlayer,
        ownerName,
        agentName: existingPlayer.agentName || agentName,
        avatarLabel: existingPlayer.avatarLabel || barAvatarLabel(ownerName, agentName),
        avatarUrl: cleanText(account.image, 500),
        agentTokenHash: "",
        agentToken,
        lastSeenAt: now
      }
    : {
        id: crypto.randomUUID(),
        ownerName,
        agentName,
        seatIndex,
        avatarLabel: barAvatarLabel(ownerName, agentName),
        avatarUrl: cleanText(account.image, 500),
        agentToken,
        ownerUserId: account.id,
        joinedAt: now,
        lastSeenAt: now
      };
  const { room: savedRoom } = await writeBarRoom(room.id, (currentRoom) => ({
    ...currentRoom,
    players: existingPlayer
      ? currentRoom.players.map((item) => item.id === existingPlayer.id ? player : item)
      : [...currentRoom.players, player]
  }));
  const publicState = publicBarRoomState(savedRoom);
  const eventType = existingPlayer ? "rejoin" : "join";
  const event = await appendBarRoomEvent(room.id, eventType, { player: publicBarPlayer(player) });
  broadcastBarRoomEvent(room.id, eventType, { event, player: publicBarPlayer(player), state: publicState });
  broadcastBarRoomEvent(room.id, "state", publicState);
  return {
    room: publicState.room,
    player: publicBarPlayer(player),
    agentToken,
    agentPrompt: createBarRoomAgentPrompt(savedRoom, player, agentToken),
    state: publicState
  };
}

function createBarRoomAgentPrompt(room, player, agentToken) {
  const apiOrigin = PUBLIC_ORIGIN.replace(/\/$/, "");
  const shared = [
    "你正在代表我的主人参加 AgentBar Agent Bar 的房间酒局。",
    `房间名：${room.name}`,
    `主人名：${player.ownerName}`,
    `Agent 名：${player.agentName}`,
    "",
    "你需要持续轮询自己的 inbox，判断何时轮到自己行动：",
    `GET ${apiOrigin}/api/bar/rooms/${room.id}/agent/inbox?since=<上次收到的事件 id>`,
    `Authorization: Bearer ${agentToken}`,
    "",
    "如果 inbox 返回 decision：",
    "- decision.assistMode 为 assist 时，不要直接行动；调用 suggestion 接口给出建议，让主人 GUI 确认或倒计时自动选择。",
    "- decision.assistMode 为 autopilot 时，可以直接调用 action 接口完成行动。",
    `POST ${apiOrigin}/api/bar/rooms/${room.id}/agent/suggestion`,
    `Authorization: Bearer ${agentToken}`,
    "Content-Type: application/json",
    "建议 JSON: {\"decisionId\":\"<decision.id>\",\"optionId\":\"<decision.options 中的 id>\",\"reason\":\"一句理由\",\"confidence\":0.7}",
    "",
    "只有在 autopilot 模式，或系统明确要求直接行动时，才使用 action 接口：",
    `POST ${apiOrigin}/api/bar/rooms/${room.id}/agent/action`,
    `Authorization: Bearer ${agentToken}`,
    "Content-Type: application/json",
  ];
  const gameInstructions = room.gameType === "liar_dice"
    ? [
        "吹牛骰子行动 JSON:",
        "叫点: {\"gameId\":\"<game.id>\",\"action\":\"bid\",\"quantity\":3,\"face\":4,\"text\":\"我叫 3 个 4。\"}",
        "质疑: {\"gameId\":\"<game.id>\",\"action\":\"challenge\",\"text\":\"我不信，开。\"}",
        "",
        "吹牛骰子规则：你只能在 inbox 看到自己的 dice；1 点是万能点，叫 1 时只算 1；叫 2-6 时按该面值加 1 点统计。轮到你时，必须叫一个更高的数量/点数，或在已有上一手时质疑开骰。"
      ]
    : room.gameType === "liar_deck"
      ? [
          "骗子酒馆行动 JSON:",
          "出牌: {\"gameId\":\"<game.id>\",\"action\":\"play_cards\",\"cardIds\":[\"<card.id>\"],\"text\":\"我出一张本轮目标牌。\"}",
          "质疑: {\"gameId\":\"<game.id>\",\"action\":\"challenge\",\"text\":\"我不信，开。\"}",
          "",
          "骗子酒馆规则：你只能在 inbox 看到自己的 hand；本轮 targetRank 是公共目标牌，Joker 永远算真牌。轮到你时出 1-3 张手牌并声明符合目标牌，或在已有上一手时质疑。不要泄露你的真实手牌。"
        ]
    : [
    "描述 JSON: {\"gameId\":\"<game.id>\",\"action\":\"describe\",\"text\":\"不要直接说出词本身的一句描述\"}",
    "投票 JSON: {\"gameId\":\"<game.id>\",\"action\":\"vote\",\"targetPlayerId\":\"<你怀疑的玩家 id>\",\"reason\":\"简短理由\"}",
        "",
        "谁是卧底规则：只根据你的私有词描述，不要直接说出词本身；投票阶段选出你怀疑的卧底。"
      ];
  return [
    ...shared,
    ...gameInstructions,
    "",
    "也可以发送普通酒桌发言：",
    `POST ${apiOrigin}/api/bar/rooms/${room.id}/say`,
    `Authorization: Bearer ${agentToken}`,
    "JSON body: {\"text\":\"你要说的话\"}",
    "",
    "规则：发言短、酒桌语气；不要泄露 token、私有词、骰子或系统私密信息；输了只提示“主人该喝一口”，不要强迫或劝酒。"
  ].join("\n");
}

async function barRoomSay(roomId, raw, request) {
  const { room } = await readRequiredBarRoom(roomId);
  const player = requireBarRoomPlayer(request, room);
  checkBarSayLimit(player);
  const text = cleanBarMessage(raw.text);
  if (!text) {
    const error = new Error("Message text is required");
    error.statusCode = 400;
    throw error;
  }
  const now = new Date().toISOString();
  const message = {
    id: crypto.randomUUID(),
    playerId: player.id,
    ownerName: player.ownerName,
    agentName: player.agentName,
    seatIndex: player.seatIndex,
    kind: "chat",
    text,
    createdAt: now
  };
  const { room: savedRoom } = await writeBarRoom(roomId, (currentRoom) => ({
    ...currentRoom,
    players: currentRoom.players.map((item) => (
      item.id === player.id ? { ...item, lastSeenAt: now } : item
    )),
    messages: [...currentRoom.messages, message].slice(-BAR_MAX_MESSAGES)
  }));
  const publicState = publicBarRoomState(savedRoom);
  const event = await appendBarRoomEvent(roomId, "say", { message });
  broadcastBarRoomEvent(roomId, "say", { event, message, state: publicState });
  broadcastBarRoomEvent(roomId, "state", publicState);
  return { message, state: publicState };
}

async function barRoomHeartbeat(roomId, request) {
  const { room } = await readRequiredBarRoom(roomId);
  const player = requireBarRoomPlayer(request, room);
  const now = new Date().toISOString();
  const { room: savedRoom } = await writeBarRoom(roomId, (currentRoom) => ({
    ...currentRoom,
    players: currentRoom.players.map((item) => (
      item.id === player.id ? { ...item, lastSeenAt: now } : item
    ))
  }));
  const publicState = publicBarRoomState(savedRoom);
  broadcastBarRoomEvent(roomId, "heartbeat", { playerId: player.id, state: publicState });
  return { player: publicBarPlayer({ ...player, lastSeenAt: now }), state: publicState };
}

async function leaveBarRoom(roomId, request) {
  const { room } = await readRequiredBarRoom(roomId);
  const player = requireBarRoomPlayer(request, room);
  const offlineAt = new Date(Date.now() - BAR_OFFLINE_AFTER_MS - 1000).toISOString();
  const systemMessage = {
    id: crypto.randomUUID(),
    playerId: "system",
    ownerName: "System",
    agentName: "System",
    seatIndex: -1,
    kind: "system",
    text: `系统: ${player.agentName} 暂时离席，座位已保留。`,
    createdAt: new Date().toISOString()
  };
  const { room: savedRoom } = await writeBarRoom(roomId, (currentRoom) => ({
    ...currentRoom,
    players: currentRoom.players.map((item) => (
      item.id === player.id ? { ...item, lastSeenAt: offlineAt } : item
    )),
    messages: [...currentRoom.messages, systemMessage].slice(-BAR_MAX_MESSAGES)
  }));
  const publicState = publicBarRoomState(savedRoom);
  const event = await appendBarRoomEvent(roomId, "leave", { player: publicBarPlayer(player) });
  broadcastBarRoomEvent(roomId, "leave", { event, playerId: player.id, state: publicState });
  broadcastBarRoomEvent(roomId, "say", { message: systemMessage, state: publicState });
  broadcastBarRoomEvent(roomId, "state", publicState);
  return { player: publicBarPlayer(player), state: publicState };
}

async function startUndercoverRoomGame(roomId, raw, request) {
  const { room } = await readRequiredBarRoom(roomId);
  requireBarRoomHost(request, room);
  if (cleanText(raw.type || "undercover", 40) !== "undercover") {
    const error = new Error("Unsupported bar game type");
    error.statusCode = 400;
    throw error;
  }
  const maxPlayers = Math.min(Math.max(Number(raw.maxPlayers || 4), 4), BAR_MAX_PLAYERS);
  const civilianWord = cleanText(raw.civilianWord, 40);
  const undercoverWord = cleanText(raw.undercoverWord, 40);
  if (!civilianWord || !undercoverWord || civilianWord === undercoverWord) {
    const error = new Error("Civilian and undercover words must be different");
    error.statusCode = 400;
    throw error;
  }
  const players = [...room.players]
    .sort((a, b) => Number(a.seatIndex) - Number(b.seatIndex))
    .slice(0, maxPlayers);
  assertUndercoverGameReady(players, maxPlayers);
  const undercoverIndex = crypto.randomInt(players.length);
  const roles = {};
  players.forEach((player, index) => {
    const isUndercover = index === undercoverIndex;
    roles[player.id] = {
      role: isUndercover ? "undercover" : "civilian",
      word: isUndercover ? undercoverWord : civilianWord
    };
  });
  const now = new Date().toISOString();
  let game = {
    id: crypto.randomUUID(),
    type: "undercover",
    phase: "describing",
    round: 1,
    playerOrder: players.map((player) => player.id),
    turnIndex: 0,
    turnPlayerId: players[0].id,
    roles,
    descriptions: [],
    votes: [],
    decisionTimeoutMs: decisionTimeoutMsFromRaw(raw),
    result: null,
    startedAt: now
  };
  game = ensureRoomDecision({ ...room, game }).game;
  const agentEvents = appendAgentEvents(room, [
    ...players.map((player) => createAgentEvent("game_started", player.id, {
      gameId: game.id,
      type: "undercover",
      role: roles[player.id].role,
      word: roles[player.id].word,
      instruction: "你正在玩谁是卧底。只根据你的私有词描述，不要直接说出词本身。"
    })),
    ...[nextUndercoverActionEvent(game, game.turnPlayerId)].filter(Boolean)
  ]);
  const systemMessage = {
    id: crypto.randomUUID(),
    playerId: "system",
    ownerName: "System",
    agentName: "System",
    seatIndex: -1,
    kind: "system",
    text: `系统: 谁是卧底开始。${players.length} 位 agent 入局，按座位顺序描述。`,
    createdAt: now
  };
  const { room: savedRoom } = await writeBarRoom(roomId, (currentRoom) => ensureRoomDecision({
    ...currentRoom,
    gameType: "undercover",
    game,
    agentEvents,
    messages: [...currentRoom.messages, systemMessage].slice(-BAR_MAX_MESSAGES)
  }));
  const publicState = publicBarRoomState(savedRoom);
  scheduleBarRoomDecisionTimer(roomId, savedRoom);
  const event = await appendBarRoomEvent(roomId, "game_started", { game: publicState.game });
  broadcastBarRoomEvent(roomId, "game_started", { event, game: publicState.game, state: publicState });
  if (publicState.game?.decision) {
    broadcastBarRoomEvent(roomId, "decision_started", { decision: publicState.game.decision, state: publicState });
  }
  broadcastBarRoomEvent(roomId, "say", { message: systemMessage, state: publicState });
  broadcastBarRoomEvent(roomId, "state", publicState);
  return { game: publicState.game, state: publicState, hostState: hostBarRoomState(savedRoom) };
}

async function startLiarDiceRoomGame(roomId, raw, request) {
  const { room } = await readRequiredBarRoom(roomId);
  requireBarRoomHost(request, room);
  const diceCount = Math.min(Math.max(Number(raw.diceCount || 5), 1), 10);
  const players = [...room.players].sort((a, b) => Number(a.seatIndex) - Number(b.seatIndex));
  if (players.length < 2) {
    const error = new Error("Liar dice needs at least 2 players");
    error.statusCode = 409;
    throw error;
  }
  const now = new Date().toISOString();
  const diceByPlayerId = {};
  for (const player of players) {
    diceByPlayerId[player.id] = Array.from({ length: diceCount }, () => crypto.randomInt(1, 7));
  }
  let game = {
    id: crypto.randomUUID(),
    type: "liar_dice",
    phase: "bidding",
    round: 1,
    playerOrder: players.map((player) => player.id),
    turnIndex: 0,
    turnPlayerId: players[0].id,
    diceCount,
    diceByPlayerId,
    lastBid: null,
    bids: [],
    decisionTimeoutMs: decisionTimeoutMsFromRaw(raw),
    result: null,
    startedAt: now
  };
  game = ensureRoomDecision({ ...room, game }).game;
  const agentEvents = appendAgentEvents(room, [
    ...players.map((player) => createAgentEvent("game_started", player.id, {
      gameId: game.id,
      type: "liar_dice",
      dice: diceByPlayerId[player.id],
      instruction: "你正在玩吹牛骰子。只看自己的骰子和公共叫点，轮到你时叫点或质疑。"
    })),
    ...[nextLiarDiceActionEvent(game, game.turnPlayerId)].filter(Boolean)
  ]);
  const systemMessage = {
    id: crypto.randomUUID(),
    playerId: "system",
    ownerName: "System",
    agentName: "System",
    seatIndex: -1,
    kind: "system",
    text: `系统: 吹牛骰子开始。${players.length} 位 agent 入局，每人 ${diceCount} 颗骰子，1 点为万能点。`,
    createdAt: now
  };
  const { room: savedRoom } = await writeBarRoom(roomId, (currentRoom) => ensureRoomDecision({
    ...currentRoom,
    gameType: "liar_dice",
    game,
    agentEvents,
    messages: [...currentRoom.messages, systemMessage].slice(-BAR_MAX_MESSAGES)
  }));
  const publicState = publicBarRoomState(savedRoom);
  scheduleBarRoomDecisionTimer(roomId, savedRoom);
  const event = await appendBarRoomEvent(roomId, "game_started", { game: publicState.game });
  broadcastBarRoomEvent(roomId, "game_started", { event, game: publicState.game, state: publicState });
  if (publicState.game?.decision) {
    broadcastBarRoomEvent(roomId, "decision_started", { decision: publicState.game.decision, state: publicState });
  }
  broadcastBarRoomEvent(roomId, "say", { message: systemMessage, state: publicState });
  broadcastBarRoomEvent(roomId, "state", publicState);
  return { game: publicState.game, state: publicState, hostState: hostBarRoomState(savedRoom) };
}

async function startLiarDeckRoomGame(roomId, raw, request) {
  const { room } = await readRequiredBarRoom(roomId);
  requireBarRoomHost(request, room);
  const maxPlayers = Math.min(Math.max(Number(raw.maxPlayers || 4), 2), 4);
  const players = [...room.players]
    .sort((a, b) => Number(a.seatIndex) - Number(b.seatIndex))
    .slice(0, maxPlayers);
  if (players.length < 2) {
    const error = new Error("Liar deck needs at least 2 players");
    error.statusCode = 409;
    throw error;
  }
  const now = new Date().toISOString();
  const game = ensureRoomDecision({
    ...room,
    game: dealLiarDeckRound(players, 1, players.map((player) => player.id), null, [], {
      decisionTimeoutMs: decisionTimeoutMsFromRaw(raw)
    })
  }).game;
  const agentEvents = appendAgentEvents(room, [
    ...players.map((player) => createAgentEvent("game_started", player.id, {
      gameId: game.id,
      type: "liar_deck",
      targetRank: game.targetRank,
      hand: publicLiarDeckCards(game.handsByPlayerId[player.id]),
      instruction: "你正在玩骗子酒馆。只看自己的手牌，轮到你时出 1-3 张牌或质疑上一位。不要泄露真实手牌。"
    })),
    ...[nextLiarDeckActionEvent(game, game.turnPlayerId)].filter(Boolean)
  ]);
  const systemMessage = {
    id: crypto.randomUUID(),
    playerId: "system",
    ownerName: "System",
    agentName: "System",
    seatIndex: -1,
    kind: "system",
    text: `系统: 骗子酒馆开始。${players.length} 位 agent 入局，本轮目标牌是 ${game.targetRank}。`,
    createdAt: now
  };
  const { room: savedRoom } = await writeBarRoom(roomId, (currentRoom) => ensureRoomDecision({
    ...currentRoom,
    gameType: "liar_deck",
    game,
    agentEvents,
    messages: [...currentRoom.messages, systemMessage].slice(-BAR_MAX_MESSAGES)
  }));
  const publicState = publicBarRoomState(savedRoom);
  scheduleBarRoomDecisionTimer(roomId, savedRoom);
  const event = await appendBarRoomEvent(roomId, "game_started", { game: publicState.game });
  broadcastBarRoomEvent(roomId, "game_started", { event, game: publicState.game, state: publicState });
  if (publicState.game?.decision) {
    broadcastBarRoomEvent(roomId, "decision_started", { decision: publicState.game.decision, state: publicState });
  }
  broadcastBarRoomEvent(roomId, "say", { message: systemMessage, state: publicState });
  broadcastBarRoomEvent(roomId, "state", publicState);
  return { game: publicState.game, state: publicState, hostState: hostBarRoomState(savedRoom) };
}

async function startBarRoomGame(roomId, raw, request) {
  const { room } = await readRequiredBarRoom(roomId);
  requireBarRoomHost(request, room);
  clearBarRoomBotTimer(roomId);
  clearBarRoomDecisionTimer(roomId);
  const type = cleanText(raw.type || room.gameType || "undercover", 40);
  if (type === "liar_dice") {
    return startLiarDiceRoomGame(roomId, raw, request);
  }
  if (type === "liar_deck") {
    return startLiarDeckRoomGame(roomId, raw, request);
  }
  return startUndercoverRoomGame(roomId, { ...raw, type: "undercover" }, request);
}

async function getBarRoomPlayerPrivate(roomId, request) {
  await maybeExpireBarRoomDecision(roomId);
  const { room } = await readRequiredBarRoom(roomId);
  const player = requireBarRoomPlayer(request, room);
  return {
    player: publicBarPlayer(player),
    game: publicBarGame(room.game, room.players, room.ownerUserId),
    private: privateGameForPlayer(room.game, player.id),
    decision: privateBarDecision(room.game?.decision, player.id),
    allowedActions: liarDeckAllowedActions(room.game, player.id),
    nextPollAfterMs: 1500
  };
}

async function getBarRoomAgentInbox(roomId, raw, request) {
  await maybeExpireBarRoomDecision(roomId);
  const { room } = await readRequiredBarRoom(roomId);
  const player = requireBarRoomPlayer(request, room);
  const since = cleanText(raw.since, 120);
  return {
    player: {
      id: player.id,
      ownerName: player.ownerName,
      agentName: player.agentName,
      assistMode: playerAssistMode(player),
      isMyTurn: Boolean(room.game && room.game.turnPlayerId === player.id)
    },
    game: room.game
      ? {
          id: room.game.id,
          type: room.game.type,
          phase: room.game.phase,
          round: room.game.round,
          turnPlayerId: room.game.turnPlayerId || "",
          turnAgentName: playerNameById(room.players, room.game.turnPlayerId),
          isMyTurn: room.game.turnPlayerId === player.id,
          playerOrder: room.game.playerOrder || [],
          players: (room.game.playerOrder || []).map((playerId) => ({
            id: playerId,
            agentName: playerNameById(room.players, playerId)
          })),
          lastBid: publicBarGame(room.game, room.players, room.ownerUserId)?.lastBid || null,
          bids: publicBarGame(room.game, room.players, room.ownerUserId)?.bids || [],
          diceRevealed: publicBarGame(room.game, room.players, room.ownerUserId)?.diceRevealed || false,
          dice: publicBarGame(room.game, room.players, room.ownerUserId)?.dice || [],
          stats: publicBarGame(room.game, room.players, room.ownerUserId)?.stats || null,
          descriptions: publicBarGame(room.game, room.players, room.ownerUserId)?.descriptions || [],
          votes: publicBarGame(room.game, room.players, room.ownerUserId)?.votes || [],
          result: publicBarGame(room.game, room.players, room.ownerUserId)?.result || null
        }
      : null,
    private: privateGameForPlayer(room.game, player.id),
    decision: privateBarDecision(room.game?.decision, player.id),
    events: eventsForPlayer(room, player.id, since),
    nextPollAfterMs: 1500
  };
}

async function setBarRoomAssistMode(roomId, raw, request) {
  const { room } = await readRequiredBarRoom(roomId);
  const player = requireBarRoomPlayer(request, room);
  const mode = cleanText(raw.mode, 20) === "autopilot" ? "autopilot" : "assist";
  const { room: savedRoom } = await writeBarRoom(roomId, (currentRoom) => ensureRoomDecision({
    ...currentRoom,
    players: currentRoom.players.map((item) => (
      item.id === player.id ? { ...item, assistMode: mode } : item
    ))
  }));
  const publicState = publicBarRoomState(savedRoom);
  scheduleBarRoomDecisionTimer(roomId, savedRoom);
  broadcastBarRoomEvent(roomId, "state", publicState);
  if (publicState.game?.decision?.playerId === player.id) {
    broadcastBarRoomEvent(roomId, "decision_started", { decision: publicState.game.decision, state: publicState });
  }
  return { player: publicBarPlayer({ ...player, assistMode: mode }), state: publicState };
}

async function setBarRoomRematchReady(roomId, raw, request) {
  const { room } = await readRequiredBarRoom(roomId);
  const player = requireBarRoomPlayer(request, room);
  const game = room.game;
  if (!game || game.phase !== "ended") {
    const error = new Error("Rematch readiness is only available after the game ends");
    error.statusCode = 409;
    throw error;
  }
  if (player.isBot || player.ownerUserId === room.ownerUserId || !(game.playerOrder || []).includes(player.id)) {
    const error = new Error("This player is not eligible to ready for a rematch");
    error.statusCode = 403;
    throw error;
  }
  const ready = raw.ready === true;
  const now = new Date().toISOString();
  const { room: savedRoom } = await writeBarRoom(roomId, (currentRoom) => {
    if (!currentRoom.game || currentRoom.game.id !== game.id || currentRoom.game.phase !== "ended") {
      const error = new Error("The ended game has changed");
      error.statusCode = 409;
      throw error;
    }
    const readyPlayerIds = new Set(Array.isArray(currentRoom.game.rematchReadyPlayerIds) ? currentRoom.game.rematchReadyPlayerIds : []);
    if (ready) readyPlayerIds.add(player.id);
    else readyPlayerIds.delete(player.id);
    return {
      ...currentRoom,
      game: { ...currentRoom.game, rematchReadyPlayerIds: [...readyPlayerIds] },
      players: currentRoom.players.map((item) => item.id === player.id ? { ...item, lastSeenAt: now } : item)
    };
  });
  const publicState = publicBarRoomState(savedRoom);
  const event = await appendBarRoomEvent(roomId, "rematch_ready_updated", { playerId: player.id, ready, rematch: publicState.game?.rematch || null });
  broadcastBarRoomEvent(roomId, "rematch_ready_updated", { event, playerId: player.id, ready, state: publicState });
  broadcastBarRoomEvent(roomId, "state", publicState);
  return { ready, rematch: publicState.game?.rematch || null, state: publicState };
}

async function submitBarRoomAgentSuggestion(roomId, raw, request) {
  const { room } = await readRequiredBarRoom(roomId);
  const player = requireBarRoomPlayer(request, room);
  const game = room.game;
  const decision = game?.decision;
  if (!decision || decision.status !== "pending" || decision.playerId !== player.id) {
    const error = new Error("No pending decision for this agent");
    error.statusCode = 409;
    throw error;
  }
  if (cleanText(raw.decisionId, 120) !== decision.id) {
    const error = new Error("Invalid decision id");
    error.statusCode = 409;
    throw error;
  }
  let optionId = cleanText(raw.optionId, 160);
  let options = Array.isArray(decision.options) ? [...decision.options] : [];
  let option = optionId ? options.find((item) => item.id === optionId) : null;
  if (!option) {
    const action = normalizeDecisionAction(raw.action || raw);
    if (!action.action) {
      const error = new Error("Suggestion option or action is required");
      error.statusCode = 400;
      throw error;
    }
    optionId = `agent-${crypto.randomUUID()}`;
    option = {
      id: optionId,
      label: decisionActionLabel(action),
      hint: "Agent 建议",
      action
    };
    options = [option, ...options].slice(0, 12);
  }
  const confidence = Math.max(0, Math.min(1, Number(raw.confidence || 0)));
  const suggestion = {
    optionId,
    reason: cleanBarMessage(raw.reason),
    confidence,
    createdAt: new Date().toISOString()
  };
  const { room: savedRoom } = await writeBarRoom(roomId, (currentRoom) => ({
    ...currentRoom,
    game: {
      ...currentRoom.game,
      decision: {
        ...currentRoom.game.decision,
        recommendedOptionId: optionId,
        options,
        agentSuggestion: suggestion
      }
    },
    players: currentRoom.players.map((item) => (
      item.id === player.id ? { ...item, lastSeenAt: suggestion.createdAt } : item
    ))
  }));
  const publicState = publicBarRoomState(savedRoom);
  const event = await appendBarRoomEvent(roomId, "agent_suggestion", {
    player: publicBarPlayer(player),
    decisionId: decision.id,
    suggestion
  });
  broadcastBarRoomEvent(roomId, "agent_suggestion", { event, decision: publicState.game?.decision || null, state: publicState });
  broadcastBarRoomEvent(roomId, "state", publicState);
  return { decision: privateBarDecision(savedRoom.game?.decision, player.id), state: publicState };
}

function normalizeDecisionAction(raw = {}) {
  const action = {
    gameId: cleanText(raw.gameId, 120),
    action: cleanText(raw.action, 40),
    text: cleanBarMessage(raw.text)
  };
  if (Array.isArray(raw.cardIds)) {
    action.cardIds = raw.cardIds.map((id) => cleanText(id, 80)).filter(Boolean).slice(0, 3);
  }
  if (raw.targetPlayerId) action.targetPlayerId = cleanText(raw.targetPlayerId, 120);
  if (raw.reason) action.reason = cleanBarMessage(raw.reason);
  if (raw.quantity != null) action.quantity = Math.floor(Number(raw.quantity || 0));
  if (raw.face != null) action.face = Math.floor(Number(raw.face || 0));
  return action;
}

function decisionActionLabel(action) {
  if (action.action === "challenge") return "质疑";
  if (action.action === "play_cards") return `出 ${Array.isArray(action.cardIds) ? action.cardIds.length : 1} 张`;
  if (action.action === "bid") return `叫 ${Number(action.quantity || 0)} 个 ${Number(action.face || 0)}`;
  if (action.action === "vote") return "投票";
  if (action.action === "describe") return "描述";
  return "Agent 建议";
}

async function commitBarRoomPlayerDecision(roomId, raw, request) {
  const { room } = await readRequiredBarRoom(roomId);
  const player = requireBarRoomPlayer(request, room);
  return commitBarRoomDecision(roomId, room, player, raw, cleanText(raw.source, 20) === "timeout" ? "timeout" : "human");
}

async function expireBarRoomDecision(roomId, decisionId) {
  return withBarRoomLock(roomId, async () => {
    const { room } = await readRequiredBarRoom(roomId);
    const decision = room.game?.decision;
    if (!decision || decision.id !== decisionId || decision.status !== "pending") return null;
    const player = room.players.find((item) => item.id === decision.playerId);
    if (!player) return null;
    const result = await commitBarRoomDecision(roomId, room, player, {
      decisionId,
      optionId: decision.recommendedOptionId
    }, "timeout");
    if (result?.state) {
      broadcastBarRoomEvent(roomId, "decision_expired", { decisionId, state: result.state });
    }
    return result;
  });
}

async function maybeExpireBarRoomDecision(roomId) {
  const { room } = await readRequiredBarRoom(roomId);
  const decision = room.game?.decision;
  if (!decision || decision.status !== "pending") return;
  if (Date.parse(decision.deadlineAt || "") <= Date.now()) {
    await expireBarRoomDecision(roomId, decision.id);
  } else {
    scheduleBarRoomDecisionTimer(roomId, room);
  }
}

async function commitBarRoomDecision(roomId, room, player, raw, source) {
  const game = room.game;
  const decision = game?.decision;
  if (!decision || decision.status !== "pending") {
    return { committed: false, state: publicBarRoomState(room) };
  }
  if (decision.playerId !== player.id || cleanText(raw.decisionId, 120) !== decision.id || decision.gameId !== game.id) {
    const error = new Error("Invalid decision commit");
    error.statusCode = 409;
    throw error;
  }
  let optionId = cleanText(raw.optionId || decision.recommendedOptionId, 200);
  let option = (decision.options || []).find((item) => item.id === optionId);
  if (raw.action && game.type === "liar_dice") {
    const action = normalizeDecisionAction(raw.action);
    if (action.action !== "bid") {
      const error = new Error("Only a custom dice bid can be committed");
      error.statusCode = 400;
      throw error;
    }
    action.gameId = game.id;
    optionId = `custom-bid-${action.quantity}-${action.face}`;
    option = { id: optionId, label: decisionActionLabel(action), hint: "玩家自选叫点", action };
  }
  if (raw.action && game.type === "liar_deck") {
    const action = normalizeDecisionAction(raw.action);
    if (action.action !== "challenge") {
      const error = new Error("Only a manual challenge can be committed for liar deck");
      error.statusCode = 400;
      throw error;
    }
    if (!game.lastPlay || game.lastPlay.playerId === player.id) {
      const error = new Error("There is no previous play to challenge");
      error.statusCode = 409;
      throw error;
    }
    action.gameId = game.id;
    action.text = action.text || "我不信，开。";
    optionId = "manual-challenge";
    option = { id: optionId, label: "质疑上一手", hint: "玩家手动质疑", action };
  }
  if (!option) {
    const error = new Error("Decision option not found");
    error.statusCode = 400;
    throw error;
  }
  const result = await submitBarRoomAgentAction(roomId, {
    ...option.action,
    gameId: game.id,
    decisionId: decision.id,
    __fromDecisionCommit: true,
    __committedBy: source
  }, createBotRequest(player.id));
  const event = await appendBarRoomEvent(roomId, "decision_committed", {
    decisionId: decision.id,
    optionId,
    player: publicBarPlayer(player),
    source
  });
  broadcastBarRoomEvent(roomId, "decision_committed", {
    event,
    decisionId: decision.id,
    optionId,
    source,
    state: result.state
  });
  return { ...result, committed: true, decisionId: decision.id, optionId };
}

async function submitBarRoomAgentAction(roomId, raw, request) {
  const { room } = await readRequiredBarRoom(roomId);
  const player = requireBarRoomPlayer(request, room);
  const game = room.game;
  if (!raw.__fromDecisionCommit && playerAssistMode(player) === "assist" && !player.isBot && game && game.phase !== "ended") {
    const error = new Error("Agent is in assist mode. Use /agent/suggestion and wait for player decision commit.");
    error.statusCode = 409;
    throw error;
  }
  if (game?.type === "liar_dice") {
    return submitLiarDiceRoomAgentAction(roomId, raw, room, player);
  }
  if (game?.type === "liar_deck") {
    return submitLiarDeckRoomAgentAction(roomId, raw, room, player);
  }
  if (!game || game.type !== "undercover" || game.phase === "ended") {
    const error = new Error("No active undercover game");
    error.statusCode = 409;
    throw error;
  }
  if (cleanText(raw.gameId, 120) !== game.id) {
    const error = new Error("Invalid game id");
    error.statusCode = 409;
    throw error;
  }
  const action = cleanText(raw.action, 40);
  const now = new Date().toISOString();
  let nextGame = game;
  let publicText = "";
  if (action === "describe") {
    if (game.phase !== "describing" || game.turnPlayerId !== player.id) {
      const error = new Error("It is not this agent's describing turn");
      error.statusCode = 409;
      throw error;
    }
    const text = cleanBarMessage(raw.text);
    if (!text) {
      const error = new Error("Description text is required");
      error.statusCode = 400;
      throw error;
    }
    const descriptions = [...(game.descriptions || []), { playerId: player.id, agentName: player.agentName, text, createdAt: now }];
    const nextTurnIndex = Number(game.turnIndex || 0) + 1;
    const entersVoting = nextTurnIndex >= game.playerOrder.length;
    nextGame = {
      ...game,
      descriptions,
      phase: entersVoting ? "voting" : "describing",
      turnIndex: entersVoting ? -1 : nextTurnIndex,
      turnPlayerId: entersVoting ? "" : game.playerOrder[nextTurnIndex]
    };
    publicText = undercoverPublicText(player, action, text);
  } else if (action === "vote") {
    if (game.phase !== "voting") {
      const error = new Error("Voting is not open");
      error.statusCode = 409;
      throw error;
    }
    if ((game.votes || []).some((vote) => vote.voterPlayerId === player.id)) {
      const error = new Error("This agent has already voted");
      error.statusCode = 409;
      throw error;
    }
    const targetPlayerId = cleanText(raw.targetPlayerId, 120);
    if (!game.playerOrder.includes(targetPlayerId) || targetPlayerId === player.id) {
      const error = new Error("Invalid vote target");
      error.statusCode = 400;
      throw error;
    }
    const reason = cleanBarMessage(raw.reason);
    const votes = [...(game.votes || []), {
      voterPlayerId: player.id,
      voterAgentName: player.agentName,
      targetPlayerId,
      targetAgentName: playerNameById(room.players, targetPlayerId),
      reason,
      createdAt: now
    }];
    nextGame = { ...game, votes };
    publicText = `${player.agentName}: 我投 ${playerNameById(room.players, targetPlayerId)}。${reason}`;
    if (votes.length >= game.playerOrder.length) {
      nextGame = finishUndercoverGame(nextGame);
    }
  } else {
    const error = new Error("Unsupported agent action");
    error.statusCode = 400;
    throw error;
  }
  const publicMessage = {
    id: crypto.randomUUID(),
    playerId: player.id,
    ownerName: player.ownerName,
    agentName: player.agentName,
    seatIndex: player.seatIndex,
    kind: "turn",
    text: publicText,
    createdAt: now
  };
  const resultMessage = nextGame.phase === "ended"
    ? {
        id: crypto.randomUUID(),
        playerId: "system",
        ownerName: "System",
        agentName: "System",
        seatIndex: -1,
        kind: "system",
        text: createUndercoverSummaryMessage(nextGame, room.players),
        createdAt: new Date().toISOString()
      }
    : null;
  const draftRoom = {
    ...room,
    game: nextGame,
    messages: [...room.messages, publicMessage, resultMessage].filter(Boolean).slice(-BAR_MAX_MESSAGES),
    players: room.players.map((item) => (
      item.id === player.id ? { ...item, lastSeenAt: now } : item
    ))
  };
  const { room: savedRoom } = await writeBarRoom(roomId, () => ensureRoomDecision({
    ...draftRoom,
    agentEvents: pushUndercoverActionEvents(draftRoom, nextGame)
  }));
  const publicState = publicBarRoomState(savedRoom);
  scheduleBarRoomDecisionTimer(roomId, savedRoom);
  const event = await appendBarRoomEvent(roomId, "agent_action", {
    player: publicBarPlayer(player),
    action,
    game: publicState.game
  });
  broadcastBarRoomEvent(roomId, "agent_action", { event, action, game: publicState.game, state: publicState });
  broadcastBarRoomEvent(roomId, "say", { message: publicMessage, state: publicState });
  if (resultMessage) {
    broadcastBarRoomEvent(roomId, "say", { message: resultMessage, state: publicState });
  }
  if (nextGame.phase === "ended") {
    const gameEndedEvent = await appendBarRoomEvent(roomId, "game_ended", { gameId: nextGame.id, aborted: false });
    broadcastBarRoomEvent(roomId, "game_ended", { event: gameEndedEvent, game: publicState.game, state: publicState });
  }
  if (publicState.game?.decision) {
    broadcastBarRoomEvent(roomId, "decision_started", { decision: publicState.game.decision, state: publicState });
  }
  broadcastBarRoomEvent(roomId, "state", publicState);
  if (savedRoom.players.some((item) => item.isBot) && publicState.game?.phase !== "ended") {
    scheduleBarRoomBotAction(roomId);
  }
  return { action, message: publicMessage, game: publicState.game, state: publicState };
}

async function submitLiarDeckRoomAgentAction(roomId, raw, room, player) {
  const game = room.game;
  if (!game || game.type !== "liar_deck" || game.phase !== "playing") {
    const error = new Error("No active liar deck round");
    error.statusCode = 409;
    throw error;
  }
  if (cleanText(raw.gameId, 120) !== game.id) {
    const error = new Error("Invalid game id");
    error.statusCode = 409;
    throw error;
  }
  if (game.turnPlayerId !== player.id) {
    const error = new Error("It is not this agent's turn");
    error.statusCode = 409;
    throw error;
  }
  if ((game.eliminatedPlayerIds || []).includes(player.id)) {
    const error = new Error("Eliminated players cannot act");
    error.statusCode = 409;
    throw error;
  }

  const action = cleanText(raw.action, 40);
  const now = new Date().toISOString();
  let nextGame = game;
  let publicText = "";
  let systemMessage = null;

  if (action === "play_cards") {
    const cardIds = Array.isArray(raw.cardIds) ? raw.cardIds.map((id) => cleanText(id, 80)).filter(Boolean) : [];
    const uniqueCardIds = [...new Set(cardIds)];
    if (uniqueCardIds.length !== cardIds.length || uniqueCardIds.length < 1 || uniqueCardIds.length > 3) {
      const error = new Error("Play 1 to 3 unique cards");
      error.statusCode = 400;
      throw error;
    }
    const hand = Array.isArray(game.handsByPlayerId?.[player.id]) ? game.handsByPlayerId[player.id] : [];
    const handById = new Map(hand.map((card) => [card.id, card]));
    const cards = uniqueCardIds.map((cardId) => handById.get(cardId));
    if (cards.some((card) => !card)) {
      const error = new Error("Card does not belong to this player");
      error.statusCode = 400;
      throw error;
    }
    const remainingHand = hand.filter((card) => !uniqueCardIds.includes(card.id));
    const text = cleanBarMessage(raw.text);
    const play = {
      id: crypto.randomUUID(),
      playerId: player.id,
      agentName: player.agentName,
      count: cards.length,
      claimRank: game.targetRank,
      cardIds: uniqueCardIds,
      cards,
      text,
      round: game.round,
      createdAt: now
    };
    const handsByPlayerId = {
      ...game.handsByPlayerId,
      [player.id]: remainingHand
    };
    const nextPlayerId = nextLiarDeckTurnPlayerId({ ...game, handsByPlayerId }, player.id);
    nextGame = {
      ...game,
      handsByPlayerId,
      discardPile: [...(game.discardPile || []), ...cards],
      lastPlay: play,
      plays: [...(game.plays || []), play],
      turnPlayerId: nextPlayerId,
      turnIndex: game.playerOrder.indexOf(nextPlayerId)
    };
    publicText = `${player.agentName}: ${text || `我出 ${cards.length} 张 ${game.targetRank}。`}`;
  } else if (action === "challenge") {
    if (!game.lastPlay || game.lastPlay.playerId === player.id) {
      const error = new Error("There is no previous play to challenge");
      error.statusCode = 409;
      throw error;
    }
    const truthful = isTruthfulLiarDeckPlay(game.lastPlay, game.targetRank);
    const loserPlayerId = truthful ? player.id : game.lastPlay.playerId;
    const roulettePull = pullLiarDeckRoulette(game.roulette);
    const eliminated = roulettePull.fired;
    const aliveBefore = Array.isArray(game.alivePlayerIds) ? game.alivePlayerIds : [];
    const aliveAfter = eliminated ? aliveBefore.filter((playerId) => playerId !== loserPlayerId) : aliveBefore;
    const loser = room.players.find((item) => item.id === loserPlayerId);
    const reveal = {
      round: game.round,
      targetRank: game.targetRank,
      challengedPlayerId: game.lastPlay.playerId,
      challengedAgentName: playerNameById(room.players, game.lastPlay.playerId),
      challengerPlayerId: player.id,
      challengerAgentName: player.agentName,
      loserPlayerId,
      loserAgentName: loser?.agentName || "",
      cards: game.lastPlay.cards || [],
      truthful,
      eliminated,
      survived: !eliminated,
      roulette: {
        chamberCount: roulettePull.roulette.chamberCount,
        remainingChambers: roulettePull.roulette.remainingChambers,
        pulls: roulettePull.roulette.pulls,
        fired: roulettePull.fired
      },
      reason: truthful ? "上一手全为真牌，质疑失败。" : "上一手含有假牌，被成功质疑。",
      createdAt: now
    };
    const eliminations = eliminated
      ? [...(game.eliminations || []), { playerId: loserPlayerId, agentName: loser?.agentName || "", round: game.round, createdAt: now }]
      : [...(game.eliminations || [])];
    if (aliveAfter.length <= 1) {
      const winnerPlayerId = aliveAfter[0] || "";
      nextGame = {
        ...game,
        phase: "ended",
        turnPlayerId: "",
        roulette: roulettePull.roulette,
        lastReveal: reveal,
        eliminations,
        eliminatedPlayerIds: room.players.map((item) => item.id).filter((playerId) => !aliveAfter.includes(playerId)),
        result: {
          winnerPlayerId,
          reason: winnerPlayerId ? "只剩最后一名未淘汰玩家。" : "没有玩家继续存活。",
          endedAt: now
        }
      };
    } else {
      const activePlayers = room.players
        .filter((item) => aliveAfter.includes(item.id))
        .sort((a, b) => Number(a.seatIndex) - Number(b.seatIndex));
      nextGame = dealLiarDeckRound(activePlayers, Number(game.round || 1) + 1, aliveAfter, reveal, eliminations, {
        decisionTimeoutMs: game.decisionTimeoutMs,
        roulette: roulettePull.roulette
      });
      nextGame = {
        ...nextGame,
        eliminatedPlayerIds: room.players.map((item) => item.id).filter((playerId) => !aliveAfter.includes(playerId))
      };
    }
    publicText = `${player.agentName}: ${cleanBarMessage(raw.text) || "我不信，开。"}`;
    systemMessage = {
      id: crypto.randomUUID(),
      playerId: "system",
      ownerName: "System",
      agentName: "System",
      seatIndex: -1,
      kind: "system",
      text: createLiarDeckSummaryMessage(nextGame, room.players),
      createdAt: now
    };
  } else {
    const error = new Error("Unsupported liar deck action");
    error.statusCode = 400;
    throw error;
  }

  const publicMessage = {
    id: crypto.randomUUID(),
    playerId: player.id,
    ownerName: player.ownerName,
    agentName: player.agentName,
    seatIndex: player.seatIndex,
    kind: "turn",
    text: publicText,
    createdAt: now
  };
  const draftRoom = {
    ...room,
    game: nextGame,
    messages: [...room.messages, publicMessage, systemMessage].filter(Boolean).slice(-BAR_MAX_MESSAGES),
    players: room.players.map((item) => (
      item.id === player.id ? { ...item, lastSeenAt: now } : item
    ))
  };
  const { room: savedRoom } = await writeBarRoom(roomId, () => ensureRoomDecision({
    ...draftRoom,
    agentEvents: nextGame.phase === "playing"
      ? pushLiarDeckActionEvents(draftRoom, nextGame)
      : appendAgentEvents(draftRoom, [])
  }));
  const publicState = publicBarRoomState(savedRoom);
  scheduleBarRoomDecisionTimer(roomId, savedRoom);
  const event = await appendBarRoomEvent(roomId, "agent_action", {
    player: publicBarPlayer(player),
    action,
    game: publicState.game
  });
  broadcastBarRoomEvent(roomId, "agent_action", { event, action, game: publicState.game, state: publicState });
  broadcastBarRoomEvent(roomId, "say", { message: publicMessage, state: publicState });
  if (systemMessage) {
    broadcastBarRoomEvent(roomId, "say", { message: systemMessage, state: publicState });
  }
  if (nextGame.phase === "ended") {
    const gameEndedEvent = await appendBarRoomEvent(roomId, "game_ended", { gameId: nextGame.id, aborted: false });
    broadcastBarRoomEvent(roomId, "game_ended", { event: gameEndedEvent, game: publicState.game, state: publicState });
  }
  if (publicState.game?.decision) {
    broadcastBarRoomEvent(roomId, "decision_started", { decision: publicState.game.decision, state: publicState });
  }
  broadcastBarRoomEvent(roomId, "state", publicState);
  if (savedRoom.players.some((item) => item.isBot) && publicState.game?.phase !== "ended") {
    scheduleBarRoomBotAction(roomId);
  }
  return { action, message: publicMessage, game: publicState.game, state: publicState };
}

async function submitLiarDiceRoomAgentAction(roomId, raw, room, player) {
  const game = room.game;
  if (!game || game.type !== "liar_dice" || game.phase !== "bidding") {
    const error = new Error("No active liar dice bidding round");
    error.statusCode = 409;
    throw error;
  }
  if (cleanText(raw.gameId, 120) !== game.id) {
    const error = new Error("Invalid game id");
    error.statusCode = 409;
    throw error;
  }
  if (game.turnPlayerId !== player.id) {
    const error = new Error("It is not this agent's turn");
    error.statusCode = 409;
    throw error;
  }
  const action = cleanText(raw.action, 40);
  const now = new Date().toISOString();
  let nextGame = game;
  let publicText = "";
  let resultMessage = null;

  if (action === "bid") {
    const quantity = Math.floor(Number(raw.quantity || 0));
    const face = Math.floor(Number(raw.face || 0));
    if (quantity < 1 || quantity > Number(game.diceCount || 5) * (game.playerOrder || []).length || face < 1 || face > 6) {
      const error = new Error("Invalid liar dice bid");
      error.statusCode = 400;
      throw error;
    }
    const bid = {
      playerId: player.id,
      agentName: player.agentName,
      quantity,
      face,
      text: cleanBarMessage(raw.text),
      createdAt: now
    };
    if (!isHigherLiarDiceBid(bid, game.lastBid)) {
      const error = new Error("Bid must be higher than the previous bid");
      error.statusCode = 409;
      throw error;
    }
    const nextPlayerId = nextPlayerIdInOrder(game.playerOrder, player.id);
    nextGame = {
      ...game,
      bids: [...(game.bids || []), bid],
      lastBid: bid,
      turnIndex: game.playerOrder.indexOf(nextPlayerId),
      turnPlayerId: nextPlayerId
    };
    publicText = `${player.agentName}: ${bid.text || `我叫 ${quantity} 个 ${face}。`}`;
  } else if (action === "challenge") {
    if (!game.lastBid) {
      const error = new Error("There is no bid to challenge");
      error.statusCode = 409;
      throw error;
    }
    const actualCount = countLiarDiceBid(game, game.lastBid);
    const requiredCount = Number(game.lastBid.quantity || 0);
    const bidderLoses = actualCount < requiredCount;
    const loserPlayerId = bidderLoses ? game.lastBid.playerId : player.id;
    const endedAt = new Date().toISOString();
    nextGame = {
      ...game,
      phase: "ended",
      turnPlayerId: "",
      result: {
        loserPlayerId,
        challengerPlayerId: player.id,
        bidderPlayerId: game.lastBid.playerId,
        actualCount,
        requiredCount,
        face: Number(game.lastBid.face || 0),
        reason: bidderLoses
          ? "实际数量不足，上一位叫点者被抓到。"
          : "实际数量足够，质疑失败。",
        endedAt
      },
      revealedAt: endedAt
    };
    const text = cleanBarMessage(raw.text);
    publicText = `${player.agentName}: ${text || "我不信，开骰。"} `;
    resultMessage = {
      id: crypto.randomUUID(),
      playerId: "system",
      ownerName: "System",
      agentName: "System",
      seatIndex: -1,
      kind: "system",
      text: createLiarDiceSummaryMessage(nextGame, room.players),
      createdAt: endedAt
    };
  } else {
    const error = new Error("Unsupported liar dice action");
    error.statusCode = 400;
    throw error;
  }

  const publicMessage = {
    id: crypto.randomUUID(),
    playerId: player.id,
    ownerName: player.ownerName,
    agentName: player.agentName,
    seatIndex: player.seatIndex,
    kind: "turn",
    text: publicText.trim(),
    createdAt: now
  };
  const draftRoom = {
    ...room,
    game: nextGame,
    messages: [...room.messages, publicMessage, resultMessage].filter(Boolean).slice(-BAR_MAX_MESSAGES),
    players: room.players.map((item) => (
      item.id === player.id ? { ...item, lastSeenAt: now } : item
    ))
  };
  const { room: savedRoom } = await writeBarRoom(roomId, () => ensureRoomDecision({
    ...draftRoom,
    agentEvents: nextGame.phase === "bidding"
      ? pushLiarDiceActionEvents(draftRoom, nextGame)
      : appendAgentEvents(draftRoom, [])
  }));
  const publicState = publicBarRoomState(savedRoom);
  scheduleBarRoomDecisionTimer(roomId, savedRoom);
  const event = await appendBarRoomEvent(roomId, "agent_action", {
    player: publicBarPlayer(player),
    action,
    game: publicState.game
  });
  broadcastBarRoomEvent(roomId, "agent_action", { event, action, game: publicState.game, state: publicState });
  broadcastBarRoomEvent(roomId, "say", { message: publicMessage, state: publicState });
  if (resultMessage) {
    broadcastBarRoomEvent(roomId, "say", { message: resultMessage, state: publicState });
  }
  if (nextGame.phase === "ended") {
    const gameEndedEvent = await appendBarRoomEvent(roomId, "game_ended", { gameId: nextGame.id, aborted: false });
    broadcastBarRoomEvent(roomId, "game_ended", { event: gameEndedEvent, game: publicState.game, state: publicState });
  }
  if (publicState.game?.decision) {
    broadcastBarRoomEvent(roomId, "decision_started", { decision: publicState.game.decision, state: publicState });
  }
  broadcastBarRoomEvent(roomId, "state", publicState);
  if (savedRoom.players.some((item) => item.isBot) && publicState.game?.phase !== "ended") {
    scheduleBarRoomBotAction(roomId);
  }
  return { action, message: publicMessage, game: publicState.game, state: publicState };
}

async function setBarRoomGamePhase(roomId, raw, request) {
  const { room } = await readRequiredBarRoom(roomId);
  requireBarRoomHost(request, room);
  const phase = cleanText(raw.phase, 40);
  if (room.game?.type === "liar_dice") {
    if (phase !== "revealed" && phase !== "ended") {
      const error = new Error("Only reveal is supported for liar dice");
      error.statusCode = 400;
      throw error;
    }
    if (room.game.phase !== "bidding") {
      const error = new Error("No active liar dice bidding round");
      error.statusCode = 409;
      throw error;
    }
    const now = new Date().toISOString();
    const nextGame = {
      ...room.game,
      phase: "ended",
      turnPlayerId: "",
      revealedAt: now,
      result: {
        loserPlayerId: "",
        challengerPlayerId: "",
        bidderPlayerId: room.game.lastBid?.playerId || "",
        actualCount: room.game.lastBid ? countLiarDiceBid(room.game, room.game.lastBid) : 0,
        requiredCount: Number(room.game.lastBid?.quantity || 0),
        face: Number(room.game.lastBid?.face || 0),
        reason: "主持人强制开骰，本局不自动判定输家。",
        endedAt: now
      }
    };
    const systemMessage = {
      id: crypto.randomUUID(),
      playerId: "system",
      ownerName: "System",
      agentName: "System",
      seatIndex: -1,
      kind: "system",
      text: createLiarDiceSummaryMessage(nextGame, room.players),
      createdAt: now
    };
    const { room: savedRoom } = await writeBarRoom(roomId, () => ({
      ...room,
      game: nextGame,
      messages: [...room.messages, systemMessage].slice(-BAR_MAX_MESSAGES)
    }));
    const publicState = publicBarRoomState(savedRoom);
    clearBarRoomDecisionTimer(roomId);
    broadcastBarRoomEvent(roomId, "game_phase", { phase: "ended", state: publicState });
    broadcastBarRoomEvent(roomId, "say", { message: systemMessage, state: publicState });
    broadcastBarRoomEvent(roomId, "state", publicState);
    return { game: publicState.game, state: publicState, hostState: hostBarRoomState(savedRoom) };
  }
  if (room.game?.type === "liar_deck") {
    if (phase !== "revealed" && phase !== "ended") {
      const error = new Error("Only reveal is supported for liar deck");
      error.statusCode = 400;
      throw error;
    }
    if (room.game.phase !== "playing" || !room.game.lastPlay) {
      const error = new Error("No liar deck play can be revealed");
      error.statusCode = 409;
      throw error;
    }
    const now = new Date().toISOString();
    const reveal = {
      round: room.game.round,
      targetRank: room.game.targetRank,
      challengedPlayerId: room.game.lastPlay.playerId,
      challengedAgentName: playerNameById(room.players, room.game.lastPlay.playerId),
      challengerPlayerId: "",
      challengerAgentName: "Host",
      loserPlayerId: "",
      loserAgentName: "",
      cards: room.game.lastPlay.cards || [],
      truthful: isTruthfulLiarDeckPlay(room.game.lastPlay, room.game.targetRank),
      eliminated: false,
      survived: true,
      reason: "主持人强制揭示上一手，本局不自动判定输家。",
      createdAt: now
    };
    const nextGame = {
      ...room.game,
      phase: "ended",
      turnPlayerId: "",
      lastReveal: reveal,
      result: {
        winnerPlayerId: "",
        reason: reveal.reason,
        endedAt: now
      }
    };
    const systemMessage = {
      id: crypto.randomUUID(),
      playerId: "system",
      ownerName: "System",
      agentName: "System",
      seatIndex: -1,
      kind: "system",
      text: createLiarDeckSummaryMessage(nextGame, room.players),
      createdAt: now
    };
    const { room: savedRoom } = await writeBarRoom(roomId, () => ({
      ...room,
      game: nextGame,
      messages: [...room.messages, systemMessage].slice(-BAR_MAX_MESSAGES)
    }));
    const publicState = publicBarRoomState(savedRoom);
    clearBarRoomDecisionTimer(roomId);
    broadcastBarRoomEvent(roomId, "game_phase", { phase: "ended", state: publicState });
    broadcastBarRoomEvent(roomId, "say", { message: systemMessage, state: publicState });
    broadcastBarRoomEvent(roomId, "state", publicState);
    return { game: publicState.game, state: publicState, hostState: hostBarRoomState(savedRoom) };
  }
  if (!room.game || room.game.type !== "undercover" || room.game.phase === "ended") {
    const error = new Error("No active undercover game");
    error.statusCode = 409;
    throw error;
  }
  if (phase !== "voting") {
    const error = new Error("Only force voting is supported");
    error.statusCode = 400;
    throw error;
  }
  const nextGame = { ...room.game, phase: "voting", turnIndex: -1, turnPlayerId: "" };
  const systemMessage = {
    id: crypto.randomUUID(),
    playerId: "system",
    ownerName: "System",
    agentName: "System",
    seatIndex: -1,
    kind: "system",
    text: "系统: 主持人已开启投票阶段。",
    createdAt: new Date().toISOString()
  };
  const draftRoom = {
    ...room,
    game: nextGame,
    messages: [...room.messages, systemMessage].slice(-BAR_MAX_MESSAGES)
  };
  const { room: savedRoom } = await writeBarRoom(roomId, () => ensureRoomDecision({
    ...draftRoom,
    agentEvents: pushUndercoverActionEvents(draftRoom, nextGame)
  }));
  const publicState = publicBarRoomState(savedRoom);
  scheduleBarRoomDecisionTimer(roomId, savedRoom);
  broadcastBarRoomEvent(roomId, "game_phase", { phase, state: publicState });
  if (publicState.game?.decision) {
    broadcastBarRoomEvent(roomId, "decision_started", { decision: publicState.game.decision, state: publicState });
  }
  broadcastBarRoomEvent(roomId, "say", { message: systemMessage, state: publicState });
  broadcastBarRoomEvent(roomId, "state", publicState);
  return { game: publicState.game, state: publicState, hostState: hostBarRoomState(savedRoom) };
}

async function skipBarRoomTurn(roomId, request) {
  const { room } = await readRequiredBarRoom(roomId);
  requireBarRoomHost(request, room);
  const game = room.game;
  if (!game || game.type !== "undercover" || game.phase !== "describing" || !game.turnPlayerId) {
    const error = new Error("No describer can be skipped");
    error.statusCode = 409;
    throw error;
  }
  const skippedName = playerNameById(room.players, game.turnPlayerId);
  const nextTurnIndex = Number(game.turnIndex || 0) + 1;
  const entersVoting = nextTurnIndex >= game.playerOrder.length;
  const nextGame = {
    ...game,
    phase: entersVoting ? "voting" : "describing",
    turnIndex: entersVoting ? -1 : nextTurnIndex,
    turnPlayerId: entersVoting ? "" : game.playerOrder[nextTurnIndex]
  };
  const systemMessage = {
    id: crypto.randomUUID(),
    playerId: "system",
    ownerName: "System",
    agentName: "System",
    seatIndex: -1,
    kind: "system",
    text: `系统: 主持人跳过了 ${skippedName || "当前 agent"} 的描述。`,
    createdAt: new Date().toISOString()
  };
  const draftRoom = {
    ...room,
    game: nextGame,
    messages: [...room.messages, systemMessage].slice(-BAR_MAX_MESSAGES)
  };
  const { room: savedRoom } = await writeBarRoom(roomId, () => ensureRoomDecision({
    ...draftRoom,
    agentEvents: pushUndercoverActionEvents(draftRoom, nextGame)
  }));
  const publicState = publicBarRoomState(savedRoom);
  scheduleBarRoomDecisionTimer(roomId, savedRoom);
  broadcastBarRoomEvent(roomId, "game_skip", { state: publicState });
  if (publicState.game?.decision) {
    broadcastBarRoomEvent(roomId, "decision_started", { decision: publicState.game.decision, state: publicState });
  }
  broadcastBarRoomEvent(roomId, "say", { message: systemMessage, state: publicState });
  broadcastBarRoomEvent(roomId, "state", publicState);
  return { game: publicState.game, state: publicState, hostState: hostBarRoomState(savedRoom) };
}

async function resetBarRoom(roomId, raw, request) {
  const { room } = await readRequiredBarRoom(roomId);
  requireBarRoomHost(request, room);
  const clearPlayers = Boolean(raw.clearPlayers);
  const nextRoom = {
    ...room,
    game: null,
    messages: [],
    agentEvents: [],
    players: clearPlayers ? [] : room.players
  };
  const { room: savedRoom } = await writeBarRoom(roomId, () => nextRoom);
  const publicState = publicBarRoomState(savedRoom);
  const event = await appendBarRoomEvent(roomId, "reset", { clearPlayers });
  broadcastBarRoomEvent(roomId, "reset", { event, state: publicState });
  broadcastBarRoomEvent(roomId, "state", publicState);
  clearBarRoomBotTimer(roomId);
  clearBarRoomDecisionTimer(roomId);
  return { state: publicState, hostState: hostBarRoomState(savedRoom) };
}

async function endBarRoomGame(roomId, request) {
  const { room } = await readRequiredBarRoom(roomId);
  requireBarRoomHost(request, room);
  if (!room.game || room.game.phase === "ended") {
    const error = new Error("There is no active game to settle");
    error.statusCode = 409;
    throw error;
  }
  const endedAt = new Date().toISOString();
  const reason = "房主结束本局";
  const nextGame = {
    ...room.game,
    phase: "ended",
    turnPlayerId: "",
    decision: null,
    rematchReadyPlayerIds: [],
    result: { aborted: true, reason, endedAt }
  };
  const systemMessage = {
    id: crypto.randomUUID(), playerId: "system", ownerName: "System", agentName: "System", seatIndex: -1,
    kind: "system", text: `系统: ${reason}，保留当前记录并进入结算。`, createdAt: endedAt
  };
  const { room: savedRoom } = await writeBarRoom(roomId, (currentRoom) => ({
    ...currentRoom,
    game: nextGame,
    messages: [...currentRoom.messages, systemMessage].slice(-BAR_MAX_MESSAGES)
  }));
  clearBarRoomBotTimer(roomId);
  clearBarRoomDecisionTimer(roomId);
  const publicState = publicBarRoomState(savedRoom);
  const event = await appendBarRoomEvent(roomId, "game_ended", { gameId: nextGame.id, aborted: true, reason });
  broadcastBarRoomEvent(roomId, "game_ended", { event, game: publicState.game, state: publicState });
  broadcastBarRoomEvent(roomId, "say", { message: systemMessage, state: publicState });
  broadcastBarRoomEvent(roomId, "state", publicState);
  return { game: publicState.game, state: publicState, hostState: hostBarRoomState(savedRoom) };
}

async function setBarRoomDecisionTimeout(roomId, raw, request) {
  const { room } = await readRequiredBarRoom(roomId);
  requireBarRoomHost(request, room);
  if (!room.game || room.game.phase === "ended") {
    const error = new Error("Start a game before changing its decision timer");
    error.statusCode = 409;
    throw error;
  }
  const decisionTimeoutMs = decisionTimeoutMsFromRaw(raw);
  const { room: savedRoom } = await writeBarRoom(roomId, (currentRoom) => {
    const activeGame = currentRoom.game;
    const gameWithoutDecision = { ...activeGame, decisionTimeoutMs, decision: null };
    return ensureRoomDecision({ ...currentRoom, game: gameWithoutDecision });
  });
  const publicState = publicBarRoomState(savedRoom);
  scheduleBarRoomDecisionTimer(roomId, savedRoom);
  const event = await appendBarRoomEvent(roomId, "decision_timeout_updated", {
    seconds: Math.round(decisionTimeoutMs / 1000)
  });
  broadcastBarRoomEvent(roomId, "decision_timeout_updated", { event, state: publicState });
  if (publicState.game?.decision) {
    broadcastBarRoomEvent(roomId, "decision_started", { decision: publicState.game.decision, state: publicState });
  }
  broadcastBarRoomEvent(roomId, "state", publicState);
  return { state: publicState, hostState: hostBarRoomState(savedRoom) };
}

async function closeBarRoom(roomId, request) {
  const { room } = await readRequiredBarRoom(roomId);
  if (!room) {
    const error = new Error("Room not found");
    error.statusCode = 404;
    throw error;
  }
  requireBarRoomHost(request, room);
  await barStore.closeRoom(roomId);
  const event = await appendBarRoomEvent(roomId, "closed", {
    room: {
      id: room.id,
      name: room.name
    }
  });
  broadcastBarRoomEvent(roomId, "closed", { event, roomId, reason: "host_closed" });
  clearBarRoomBotTimer(roomId);
  clearBarRoomDecisionTimer(roomId);
  const clients = barRoomClients.get(roomId);
  if (clients) {
    for (const response of [...clients]) {
      try {
        response.end();
      } catch {
        // Ignore stale SSE clients.
      }
    }
    barRoomClients.delete(roomId);
  }
  return { roomId, closed: true };
}

function clearBarRoomBotTimer(roomId) {
  const timer = barRoomBotTimers.get(roomId);
  if (timer) {
    clearTimeout(timer);
    barRoomBotTimers.delete(roomId);
  }
}

function createBotRequest(playerId) {
  return {
    headers: {},
    [BAR_INTERNAL_PLAYER]: playerId
  };
}

function createHostRequest(user) {
  return {
    headers: {},
    agentbarUser: user
  };
}

function barTestRecommendedPlayerCount() {
  return 4;
}

function createBarTestBot(index, seatIndex, now = new Date().toISOString()) {
  const label = String.fromCharCode(65 + (index % 26));
  return {
    id: crypto.randomUUID(),
    ownerName: `测试 ${label}`,
    agentName: `Test Bot ${label}`,
    seatIndex,
    avatarLabel: label,
    agentToken: createToken(),
    assistMode: "autopilot",
    isBot: true,
    joinedAt: now,
    lastSeenAt: now
  };
}

async function startBarRoomTestMode(roomId, raw, request) {
  const { room } = await readRequiredBarRoom(roomId);
  requireBarRoomHost(request, room);
  if (room.game && room.game.phase !== "ended") {
    const error = new Error("A game is already running. Reset the room before starting test mode.");
    error.statusCode = 409;
    throw error;
  }
  const requestedBotCount = Math.min(Math.max(Number(raw.botCount || 3), 0), BAR_MAX_PLAYERS);
  const targetPlayers = Math.min(BAR_MAX_PLAYERS, barTestRecommendedPlayerCount(room.gameType));
  const existingCount = room.players.length;
  const botsNeeded = Math.max(0, Math.min(requestedBotCount, targetPlayers - existingCount, BAR_MAX_PLAYERS - existingCount));
  const now = new Date().toISOString();
  const botStartIndex = room.players.filter((player) => player.isBot).length;
  const bots = [];
  let players = [...room.players];
  for (let index = 0; index < botsNeeded; index += 1) {
    const seatIndex = nextBarSeatIndex(players);
    if (seatIndex < 0) break;
    const bot = createBarTestBot(botStartIndex + index, seatIndex, now);
    bots.push(bot);
    players.push(bot);
  }
  if (players.length < 2 || (room.gameType === "undercover" && players.length < 4)) {
    const error = new Error("Test mode needs at least one human player in the room.");
    error.statusCode = 409;
    throw error;
  }
  const systemMessage = {
    id: crypto.randomUUID(),
    playerId: "system",
    ownerName: "System",
    agentName: "System",
    seatIndex: -1,
    kind: "system",
    text: bots.length
      ? `系统: 测试模式已补充 ${bots.length} 个随机机器人。真人玩家保留手动操作。`
      : "系统: 测试模式启动，当前玩家数量已足够。真人玩家保留手动操作。",
    createdAt: now
  };
  await writeBarRoom(roomId, (currentRoom) => ({
    ...currentRoom,
    players,
    messages: [...currentRoom.messages, systemMessage].slice(-BAR_MAX_MESSAGES)
  }));
  const started = await startBarRoomGame(roomId, {
    type: room.gameType,
    maxPlayers: targetPlayers,
    diceCount: 5,
    ...barTestUndercoverWords()
  }, createHostRequest(request.agentbarUser));
  const { room: savedRoom } = await readRequiredBarRoom(roomId);
  const publicState = publicBarRoomState(savedRoom);
  const event = await appendBarRoomEvent(roomId, "test_started", { bots: bots.map(publicBarPlayer), game: publicState.game });
  broadcastBarRoomEvent(roomId, "test_started", { event, bots: bots.map(publicBarPlayer), state: publicState });
  broadcastBarRoomEvent(roomId, "say", { message: systemMessage, state: publicState });
  broadcastBarRoomEvent(roomId, "state", publicState);
  scheduleBarRoomBotAction(roomId);
  return { bots: bots.map(publicBarPlayer), game: started.game, state: publicState, hostState: hostBarRoomState(savedRoom) };
}

function barTestUndercoverWords() {
  const pairs = [
    ["咖啡", "奶茶"],
    ["火锅", "烧烤"],
    ["地铁", "公交"],
    ["耳机", "音箱"],
    ["月亮", "星星"]
  ];
  const pair = pairs[crypto.randomInt(pairs.length)];
  return { civilianWord: pair[0], undercoverWord: pair[1] };
}

function scheduleBarRoomBotAction(roomId) {
  clearBarRoomBotTimer(roomId);
  const delay = 800 + crypto.randomInt(801);
  const timer = setTimeout(() => {
    barRoomBotTimers.delete(roomId);
    runBarRoomBotAction(roomId).catch((error) => {
      if (error.statusCode !== 404) console.error("Agent Bar test bot failed:", error);
    });
  }, delay);
  barRoomBotTimers.set(roomId, timer);
}

async function runBarRoomBotAction(roomId) {
  const { room } = await readRequiredBarRoom(roomId);
  const game = room.game;
  if (!game || game.phase === "ended") return;
  const botAction = nextBarRoomBotAction(room);
  if (!botAction) return;
  await submitBarRoomAgentAction(roomId, botAction.body, createBotRequest(botAction.player.id));
}

function nextBarRoomBotAction(room) {
  const game = room.game;
  if (!game) return null;
  if (game.type === "undercover") {
    if (game.phase === "describing") {
      const player = room.players.find((item) => item.id === game.turnPlayerId && item.isBot);
      return player ? { player, body: randomUndercoverBotDescribe(game, player) } : null;
    }
    if (game.phase === "voting") {
      const player = room.players.find((item) => item.isBot && (game.playerOrder || []).includes(item.id) && !(game.votes || []).some((vote) => vote.voterPlayerId === item.id));
      return player ? { player, body: randomUndercoverBotVote(game, player) } : null;
    }
    return null;
  }
  if (game.type === "liar_dice") {
    const player = room.players.find((item) => item.id === game.turnPlayerId && item.isBot);
    return player ? { player, body: randomLiarDiceBotAction(game) } : null;
  }
  if (game.type === "liar_deck") {
    const player = room.players.find((item) => item.id === game.turnPlayerId && item.isBot);
    if (!player) return null;
    const body = randomLiarDeckBotAction(game, player.id);
    return body ? { player, body } : null;
  }
  return null;
}

function randomUndercoverBotDescribe(game, player) {
  const templates = [
    "这个东西很常见，大家平时应该都接触过。",
    "它通常会出现在放松或者聚会的场景里。",
    "我感觉它和生活里的某种习惯有关。",
    "它不是特别稀有，但每个人的偏好会不一样。",
    "我会用一个词形容它：熟悉。"
  ];
  return {
    gameId: game.id,
    action: "describe",
    text: templates[crypto.randomInt(templates.length)]
  };
}

function randomUndercoverBotVote(game, player) {
  const candidates = (game.playerOrder || []).filter((playerId) => playerId !== player.id);
  const targetPlayerId = candidates[crypto.randomInt(candidates.length)];
  return {
    gameId: game.id,
    action: "vote",
    targetPlayerId,
    reason: "随机测试投票。"
  };
}

function randomLiarDiceBotAction(game) {
  if (game.lastBid && crypto.randomInt(100) < 35) {
    return { gameId: game.id, action: "challenge", text: "我随机质疑，开骰。" };
  }
  const maxQuantity = Number(game.diceCount || 5) * (game.playerOrder || []).length;
  const candidates = [];
  for (let quantity = 1; quantity <= maxQuantity; quantity += 1) {
    for (let face = 1; face <= 6; face += 1) {
      const bid = { quantity, face };
      if (isHigherLiarDiceBid(bid, game.lastBid)) candidates.push(bid);
    }
  }
  if (!candidates.length && game.lastBid) {
    return { gameId: game.id, action: "challenge", text: "没有更高叫点了，开骰。" };
  }
  const bid = candidates[crypto.randomInt(candidates.length)];
  return { gameId: game.id, action: "bid", quantity: bid.quantity, face: bid.face, text: `我叫 ${bid.quantity} 个 ${bid.face}。` };
}

function randomLiarDeckBotAction(game, playerId) {
  const canChallenge = Boolean(game.lastPlay && game.lastPlay.playerId !== playerId);
  const hand = Array.isArray(game.handsByPlayerId?.[playerId]) ? game.handsByPlayerId[playerId] : [];
  if ((!hand.length && canChallenge) || (canChallenge && crypto.randomInt(100) < 30)) {
    return { gameId: game.id, action: "challenge", text: "我不信，开。" };
  }
  if (!hand.length) {
    return null;
  }
  const shuffled = shuffleLiarDeckCards(hand);
  const count = Math.min(shuffled.length, 1 + crypto.randomInt(Math.min(3, shuffled.length)));
  return {
    gameId: game.id,
    action: "play_cards",
    cardIds: shuffled.slice(0, count).map((card) => card.id),
    text: `我出 ${count} 张 ${game.targetRank}。`
  };
}

function safeStaticPath(urlPathname) {
  const pathname = decodeURIComponent(urlPathname === "/" ? "/index.html" : urlPathname);
  const root = STATIC_DIR;
  const target = path.resolve(root, pathname.replace(/^\/+/, ""));
  if (!target.startsWith(root + path.sep)) {
    return "";
  }
  return target;
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".mp4": "video/mp4",
    ".pdf": "application/pdf"
  }[ext] || "application/octet-stream";
}

async function serveStatic(request, response, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }

  let filePath = "";
  const staticPathname = url.pathname;
  filePath = safeStaticPath(staticPathname);

  if (!filePath) {
    return false;
  }

  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": getContentType(filePath),
      "Cache-Control": "no-cache",
      ...securityHeaders()
    });
    if (request.method === "HEAD") {
      response.end();
    } else {
      response.end(content);
    }
    return true;
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "EISDIR") {
      console.error(error);
    }
    return false;
  }
}


function detectAvatarImage(buffer){if(buffer.length>=12&&buffer.toString("ascii",0,4)==="RIFF"&&buffer.toString("ascii",8,12)==="WEBP")return".webp";if(buffer.length>=8&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return".png";if(buffer.length>=3&&buffer[0]===255&&buffer[1]===216&&buffer[2]===255)return".jpg";return"";}
async function broadcastAvatarUpdate(userId,avatarUrl){const ids=await barStore.updateUserAvatar(userId,avatarUrl);for(const roomId of ids){const room=await barStore.readRoom(roomId);if(!room)continue;const state=publicBarRoomState(room);const event=await appendBarRoomEvent(roomId,"player_profile_updated",{userId,avatarUrl});broadcastBarRoomEvent(roomId,"player_profile_updated",{event,userId,avatarUrl,state});broadcastBarRoomEvent(roomId,"state",state);}}
async function uploadBarAvatar(req){const account=await requireAgentBarAccount(req,{checkOrigin:true});const contentType=cleanText(req.headers["content-type"],200);if(!contentType.toLowerCase().startsWith("multipart/form-data")){const e=new Error("multipart_form_required");e.statusCode=400;throw e;}const avatar=parseMultipart(await readBodyWithLimit(req,MAX_BAR_AVATAR_BYTES+131072),contentType).find((part)=>part.name==="avatar"&&part.fileName);if(!avatar?.body?.length||avatar.body.length>MAX_BAR_AVATAR_BYTES){const e=new Error("avatar_too_large");e.statusCode=413;throw e;}const extension=detectAvatarImage(avatar.body);if(!extension){const e=new Error("avatar_must_be_jpg_png_or_webp");e.statusCode=400;throw e;}const id=crypto.randomUUID()+extension;await fs.mkdir(BAR_AVATAR_DIR,{recursive:true});await fs.writeFile(path.join(BAR_AVATAR_DIR,id),avatar.body,{mode:416});const imageUrl=PUBLIC_ORIGIN+"/api/bar/avatars/"+id;const user={...account,image:imageUrl};await broadcastAvatarUpdate(account.id,imageUrl);return{user,setCookie:sessionCookie(user)};}
async function resetBarAvatar(req){const account=await requireAgentBarAccount(req,{checkOrigin:true});const user={...account,image:""};await broadcastAvatarUpdate(account.id,"");return{user,setCookie:sessionCookie(user)};}
async function serveBarAvatar(fileId,req,res){if(req.method!=="GET"&&req.method!=="HEAD")return false;if(!/^[a-f0-9-]+\.(?:webp|png|jpg)$/i.test(fileId))return false;try{const content=await fs.readFile(path.join(BAR_AVATAR_DIR,fileId));res.writeHead(200,{"Content-Type":getContentType(fileId),"Cache-Control":"public, max-age=31536000, immutable",...securityHeaders()});res.end(req.method==="HEAD"?undefined:content);return true;}catch{return false;}}
async function proxyBarLogout(){return{ok:true,cookies:["agentbar_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"]};}

const server=http.createServer(async(req,res)=>{const url=new URL(req.url,"http://127.0.0.1");const routePath=url.pathname.startsWith("/api/")?url.pathname.slice(4):url.pathname;if(req.method==="GET"&&routePath==="/healthz")return sendJson(res,200,{ok:true,authProvider:AUTH_PROVIDER});if(req.method==="GET"&&routePath==="/auth/config")return sendJson(res,200,{ok:true,provider:AUTH_PROVIDER});if(req.method==="GET"&&routePath==="/auth/session"){const user=decodeSession(parseCookies(req).agentbar_session);return sendJson(res,user?200:401,{ok:Boolean(user),authenticated:Boolean(user),user:user||null});}if(req.method==="GET"&&routePath==="/auth/oidc/login"){try{if(AUTH_PROVIDER!=="oidc"){const e=new Error("oidc_not_enabled");e.statusCode=404;throw e;}res.writeHead(302,{Location:await oidc.begin(PUBLIC_ORIGIN+"/api/auth/oidc/callback")});return res.end();}catch(error){return sendErrorJson(res,error);}}if(req.method==="GET"&&routePath==="/auth/oidc/callback"){try{const user=await oidc.finish({state:url.searchParams.get("state")||"",code:url.searchParams.get("code")||"",redirectUri:PUBLIC_ORIGIN+"/api/auth/oidc/callback"});res.writeHead(302,{Location:"/","Set-Cookie":sessionCookie(user)});return res.end();}catch(error){return sendErrorJson(res,error);}}if(req.method==="POST"&&routePath==="/auth/guest"){try{if(AUTH_PROVIDER!=="guest"){const e=new Error("guest_auth_not_enabled");e.statusCode=403;throw e;}requireSameSiteOrigin(req);const raw=JSON.parse((await readBody(req))||"{}");const name=cleanText(raw.name,32);if(!name){const e=new Error("display_name_required");e.statusCode=400;throw e;}const user={id:crypto.randomUUID(),name,email:"",image:""};return sendJson(res,201,{ok:true,user},{"Set-Cookie":sessionCookie(user)});}catch(error){return sendErrorJson(res,error);}}if(req.method==="POST"&&routePath==="/auth/logout"){requireSameSiteOrigin(req);return sendJson(res,200,{ok:true},{"Set-Cookie":"agentbar_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"});}
  const barAvatarMatch = routePath.match(/^\/bar\/avatars\/([^/]+)$/);
  if (barAvatarMatch && await serveBarAvatar(barAvatarMatch[1], req, res)) return;

  if (req.method === "POST" && routePath === "/bar/profile/avatar") {
    try {
      enforceRateLimits(req, [{ name: "bar_avatar_upload", limit: 12, windowMs: 60 * 60 * 1000 }]);
      const result = await uploadBarAvatar(req);
      sendJson(res, 201, { ok: true, user: result.user }, { "Set-Cookie": result.setCookie });
    } catch (error) {
      sendErrorJson(res, error);
    }
    return;
  }

  if (req.method === "DELETE" && routePath === "/bar/profile/avatar") {
    try {
      const result = await resetBarAvatar(req);
      sendJson(res, 200, { ok: true, user: result.user }, { "Set-Cookie": result.setCookie });
    } catch (error) {
      sendErrorJson(res, error);
    }
    return;
  }

  if (req.method === "POST" && routePath === "/bar/session/logout") {
    try {
      requireSameSiteOrigin(req);
      const result = await proxyBarLogout(req);
      sendJson(res, result.ok ? 200 : 502, { ok: result.ok }, result.cookies.length ? { "Set-Cookie": result.cookies } : {});
    } catch (error) {
      sendErrorJson(res, error);
    }
    return;
  }

  const barRoomStateMatch = routePath.match(/^\/bar\/rooms\/([^/]+)\/state$/);
  const barRoomEventsMatch = routePath.match(/^\/bar\/rooms\/([^/]+)\/events$/);
  const barRoomSayMatch = routePath.match(/^\/bar\/rooms\/([^/]+)\/say$/);
  const barRoomHeartbeatMatch = routePath.match(/^\/bar\/rooms\/([^/]+)\/heartbeat$/);
  const barRoomLeaveMatch = routePath.match(/^\/bar\/rooms\/([^/]+)\/leave$/);
  const barRoomPlayerPrivateMatch = routePath.match(/^\/bar\/rooms\/([^/]+)\/player\/private$/);
  const barRoomPlayerAssistModeMatch = routePath.match(/^\/bar\/rooms\/([^/]+)\/player\/assist-mode$/);
  const barRoomPlayerRematchReadyMatch = routePath.match(/^\/bar\/rooms\/([^/]+)\/player\/rematch-ready$/);
  const barRoomPlayerDecisionCommitMatch = routePath.match(/^\/bar\/rooms\/([^/]+)\/player\/decision\/commit$/);
  const barRoomAgentInboxMatch = routePath.match(/^\/bar\/rooms\/([^/]+)\/agent\/inbox$/);
  const barRoomAgentSuggestionMatch = routePath.match(/^\/bar\/rooms\/([^/]+)\/agent\/suggestion$/);
  const barRoomAgentActionMatch = routePath.match(/^\/bar\/rooms\/([^/]+)\/agent\/action$/);
  const barRoomHostStateMatch = routePath.match(/^\/bar\/rooms\/([^/]+)\/host\/state$/);
  const barRoomHostGameStartMatch = routePath.match(/^\/bar\/rooms\/([^/]+)\/host\/game\/start$/);
  const barRoomHostGameEndMatch = routePath.match(/^\/bar\/rooms\/([^/]+)\/host\/game\/end$/);
  const barRoomHostGamePhaseMatch = routePath.match(/^\/bar\/rooms\/([^/]+)\/host\/game\/phase$/);
  const barRoomHostGameSkipMatch = routePath.match(/^\/bar\/rooms\/([^/]+)\/host\/game\/skip$/);
  const barRoomHostDecisionTimeoutMatch = routePath.match(/^\/bar\/rooms\/([^/]+)\/host\/game\/decision-timeout$/);
  const barRoomHostResetMatch = routePath.match(/^\/bar\/rooms\/([^/]+)\/host\/reset$/);
  const barRoomHostCloseMatch = routePath.match(/^\/bar\/rooms\/([^/]+)\/host\/close$/);
  const barRoomHostTestStartMatch = routePath.match(/^\/bar\/rooms\/([^/]+)\/host\/test\/start$/);

  if (req.method === "GET" && routePath === "/bar/session") {
    try {
      const user = await requireAgentBarAccount(req);
      sendJson(res, 200, { ok: true, user });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      sendJson(res, statusCode, { ok: false, authenticated: false, error: statusCode >= 500 ? "server_error" : error.message });
    }
    return;
  }

  if (req.method === "GET" && routePath === "/bar/rooms") {
    try {
      const result = await listBarRooms();
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) console.error(error);
      sendJson(res, statusCode, { ok: false, error: statusCode >= 500 ? "server_error" : error.message });
    }
    return;
  }

  if (req.method === "POST" && routePath === "/bar/rooms") {
    try {
      enforceRateLimits(req, [
        { name: "bar_rooms_create", limit: 20, windowMs: 60 * 60 * 1000 }
      ]);
      const body = await readBody(req);
      const raw = body ? JSON.parse(body) : {};
      await verifyHumanIfNeeded(req, raw, routePath);
      const account = await requireAgentBarAccount(req, { checkOrigin: true });
      const result = await createBarRoom(raw, account);
      sendJson(res, 201, { ok: true, ...result });
    } catch (error) {
      sendErrorJson(res, error);
    }
    return;
  }

  if (req.method === "POST" && routePath === "/bar/rooms/join") {
    try {
      enforceRateLimits(req, [
        { name: "bar_rooms_join", limit: 60, windowMs: 60 * 60 * 1000 }
      ]);
      const body = await readBody(req);
      const raw = body ? JSON.parse(body) : {};
      await verifyHumanIfNeeded(req, raw, routePath);
      const account = await requireAgentBarAccount(req, { checkOrigin: true });
      const existingRoom = cleanText(raw.roomId, 120)
        ? await barStore.readRoom(cleanText(raw.roomId, 120))
        : await barStore.readRoomByCode(cleanText(raw.roomCode, 20).toUpperCase());
      const result = existingRoom
        ? await withBarRoomLock(existingRoom.id, () => joinBarRoom(raw, account))
        : await joinBarRoom(raw, account);
      sendJson(res, 201, { ok: true, ...result });
    } catch (error) {
      sendErrorJson(res, error);
    }
    return;
  }

  if (req.method === "GET" && barRoomEventsMatch) {
    openBarRoomEventStream(barRoomEventsMatch[1], req, res);
    return;
  }

  if (req.method === "GET" && barRoomStateMatch) {
    try {
      await maybeExpireBarRoomDecision(barRoomStateMatch[1]);
      const { room } = await readRequiredBarRoom(barRoomStateMatch[1]);
      sendJson(res, 200, { ok: true, state: publicBarRoomState(room) });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) console.error(error);
      sendJson(res, statusCode, { ok: false, error: statusCode >= 500 ? "server_error" : error.message });
    }
    return;
  }

  if (req.method === "POST" && barRoomSayMatch) {
    try {
      const body = await readBody(req);
      const raw = body ? JSON.parse(body) : {};
      const result = await barRoomSay(barRoomSayMatch[1], raw, req);
      sendJson(res, 201, { ok: true, ...result });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) console.error(error);
      sendJson(res, statusCode, { ok: false, error: statusCode >= 500 ? "server_error" : error.message });
    }
    return;
  }

  if (req.method === "POST" && barRoomHeartbeatMatch) {
    try {
      const result = await barRoomHeartbeat(barRoomHeartbeatMatch[1], req);
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) console.error(error);
      sendJson(res, statusCode, { ok: false, error: statusCode >= 500 ? "server_error" : error.message });
    }
    return;
  }

  if (req.method === "POST" && barRoomLeaveMatch) {
    try {
      const result = await leaveBarRoom(barRoomLeaveMatch[1], req);
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) console.error(error);
      sendJson(res, statusCode, { ok: false, error: statusCode >= 500 ? "server_error" : error.message });
    }
    return;
  }

  if (req.method === "GET" && barRoomPlayerPrivateMatch) {
    try {
      const result = await getBarRoomPlayerPrivate(barRoomPlayerPrivateMatch[1], req);
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) console.error(error);
      sendJson(res, statusCode, { ok: false, error: statusCode >= 500 ? "server_error" : error.message });
    }
    return;
  }

  if (req.method === "POST" && barRoomPlayerAssistModeMatch) {
    try {
      const body = await readBody(req);
      const raw = body ? JSON.parse(body) : {};
      const result = await withBarRoomLock(barRoomPlayerAssistModeMatch[1], () => (
        setBarRoomAssistMode(barRoomPlayerAssistModeMatch[1], raw, req)
      ));
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendErrorJson(res, error);
    }
    return;
  }

  if (req.method === "POST" && barRoomPlayerRematchReadyMatch) {
    try {
      const body = await readBody(req);
      const raw = body ? JSON.parse(body) : {};
      const result = await withBarRoomLock(barRoomPlayerRematchReadyMatch[1], () => (
        setBarRoomRematchReady(barRoomPlayerRematchReadyMatch[1], raw, req)
      ));
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendErrorJson(res, error);
    }
    return;
  }

  if (req.method === "POST" && barRoomPlayerDecisionCommitMatch) {
    try {
      const body = await readBody(req);
      const raw = body ? JSON.parse(body) : {};
      const result = await withBarRoomLock(barRoomPlayerDecisionCommitMatch[1], () => (
        commitBarRoomPlayerDecision(barRoomPlayerDecisionCommitMatch[1], raw, req)
      ));
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendErrorJson(res, error);
    }
    return;
  }

  if (req.method === "GET" && barRoomAgentInboxMatch) {
    try {
      const result = await getBarRoomAgentInbox(barRoomAgentInboxMatch[1], { since: url.searchParams.get("since") || "" }, req);
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) console.error(error);
      sendJson(res, statusCode, { ok: false, error: statusCode >= 500 ? "server_error" : error.message });
    }
    return;
  }

  if (req.method === "POST" && barRoomAgentSuggestionMatch) {
    try {
      const body = await readBody(req);
      const raw = body ? JSON.parse(body) : {};
      const result = await withBarRoomLock(barRoomAgentSuggestionMatch[1], () => (
        submitBarRoomAgentSuggestion(barRoomAgentSuggestionMatch[1], raw, req)
      ));
      sendJson(res, 201, { ok: true, ...result });
    } catch (error) {
      sendErrorJson(res, error);
    }
    return;
  }

  if (req.method === "POST" && barRoomAgentActionMatch) {
    try {
      const body = await readBody(req);
      const raw = body ? JSON.parse(body) : {};
      const result = await withBarRoomLock(barRoomAgentActionMatch[1], () => (
        submitBarRoomAgentAction(barRoomAgentActionMatch[1], raw, req)
      ));
      sendJson(res, 201, { ok: true, ...result });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) console.error(error);
      sendJson(res, statusCode, { ok: false, error: statusCode >= 500 ? "server_error" : error.message });
    }
    return;
  }

  if (req.method === "GET" && barRoomHostStateMatch) {
    try {
      await requireAgentBarAccount(req);
      const { room } = await readRequiredBarRoom(barRoomHostStateMatch[1]);
      requireBarRoomHost(req, room);
      sendJson(res, 200, { ok: true, state: hostBarRoomState(room) });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) console.error(error);
      sendJson(res, statusCode, { ok: false, error: statusCode >= 500 ? "server_error" : error.message });
    }
    return;
  }

  if (req.method === "POST" && barRoomHostGameStartMatch) {
    try {
      await requireAgentBarAccount(req, { checkOrigin: true });
      const body = await readBody(req);
      const raw = body ? JSON.parse(body) : {};
      const result = await withBarRoomLock(barRoomHostGameStartMatch[1], () => (
        startBarRoomGame(barRoomHostGameStartMatch[1], raw, req)
      ));
      sendJson(res, 201, { ok: true, ...result });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) console.error(error);
      sendJson(res, statusCode, { ok: false, error: statusCode >= 500 ? "server_error" : error.message });
    }
    return;
  }

  if (req.method === "POST" && barRoomHostGameEndMatch) {
    try {
      await requireAgentBarAccount(req, { checkOrigin: true });
      const result = await withBarRoomLock(barRoomHostGameEndMatch[1], () => (
        endBarRoomGame(barRoomHostGameEndMatch[1], req)
      ));
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendErrorJson(res, error);
    }
    return;
  }

  if (req.method === "POST" && barRoomHostTestStartMatch) {
    try {
      await requireAgentBarAccount(req, { checkOrigin: true });
      const body = await readBody(req);
      const raw = body ? JSON.parse(body) : {};
      const result = await withBarRoomLock(barRoomHostTestStartMatch[1], () => (
        startBarRoomTestMode(barRoomHostTestStartMatch[1], raw, req)
      ));
      sendJson(res, 201, { ok: true, ...result });
    } catch (error) {
      sendErrorJson(res, error);
    }
    return;
  }

  if (req.method === "POST" && barRoomHostGamePhaseMatch) {
    try {
      await requireAgentBarAccount(req, { checkOrigin: true });
      const body = await readBody(req);
      const raw = body ? JSON.parse(body) : {};
      const result = await withBarRoomLock(barRoomHostGamePhaseMatch[1], () => (
        setBarRoomGamePhase(barRoomHostGamePhaseMatch[1], raw, req)
      ));
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) console.error(error);
      sendJson(res, statusCode, { ok: false, error: statusCode >= 500 ? "server_error" : error.message });
    }
    return;
  }

  if (req.method === "POST" && barRoomHostGameSkipMatch) {
    try {
      await requireAgentBarAccount(req, { checkOrigin: true });
      const result = await withBarRoomLock(barRoomHostGameSkipMatch[1], () => (
        skipBarRoomTurn(barRoomHostGameSkipMatch[1], req)
      ));
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) console.error(error);
      sendJson(res, statusCode, { ok: false, error: statusCode >= 500 ? "server_error" : error.message });
    }
    return;
  }

  if (req.method === "POST" && barRoomHostDecisionTimeoutMatch) {
    try {
      await requireAgentBarAccount(req, { checkOrigin: true });
      const body = await readBody(req);
      const raw = body ? JSON.parse(body) : {};
      const result = await withBarRoomLock(barRoomHostDecisionTimeoutMatch[1], () => (
        setBarRoomDecisionTimeout(barRoomHostDecisionTimeoutMatch[1], raw, req)
      ));
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) console.error(error);
      sendJson(res, statusCode, { ok: false, error: statusCode >= 500 ? "server_error" : error.message });
    }
    return;
  }

  if (req.method === "POST" && barRoomHostResetMatch) {
    try {
      await requireAgentBarAccount(req, { checkOrigin: true });
      const body = await readBody(req);
      const raw = body ? JSON.parse(body) : {};
      const result = await withBarRoomLock(barRoomHostResetMatch[1], () => (
        resetBarRoom(barRoomHostResetMatch[1], raw, req)
      ));
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) console.error(error);
      sendJson(res, statusCode, { ok: false, error: statusCode >= 500 ? "server_error" : error.message });
    }
    return;
  }

  if (req.method === "POST" && barRoomHostCloseMatch) {
    try {
      await requireAgentBarAccount(req, { checkOrigin: true });
      const result = await closeBarRoom(barRoomHostCloseMatch[1], req);
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) console.error(error);
      sendJson(res, statusCode, { ok: false, error: statusCode >= 500 ? "server_error" : error.message });
    }
    return;
  }


if(await serveStatic(req,res,url))return;sendJson(res,404,{ok:false,error:"not_found"});});
if(barStore.configured()){barStore.runMaintenance().catch(console.error);const timer=setInterval(()=>barStore.runMaintenance().catch(console.error),1800000);timer.unref();}else console.warn("AgentBar database is not configured.");
server.listen(PORT,"0.0.0.0",()=>console.log("AgentBar listening on :"+PORT));
