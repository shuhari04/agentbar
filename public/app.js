const BAR_SESSION_PREFIX = "agentbarRoomSession:";
const BUBBLE_TTL_MS = 12000;
const TURN_CAPTION_TTL_MS = 5200;
const BAR_LOCALE_KEY = "agentbarLocale";
const BAR_EN = {
  "登录 AgentBar":"Sign in to AgentBar","更换头像":"Change avatar","退出账号":"Sign out","创建酒局":"Create table","输入房间码":"Enter room code","正在进行":"Live tables","刷新":"Refresh","第一张桌还没开":"No table is open yet","房间码":"Room code","复制房间码":"Copy room code",
  "主持":"Host","测试局":"Test game","沉浸模式":"Immersive","显示 HUD":"Show HUD","动态":"Feed","等待开局":"Waiting to start","轮到你选择":"Your choice","自动选择":"Auto select","半自动":"Assisted","全自动":"Autopilot","出牌":"Play cards","质疑":"Challenge","出牌时说":"Say with your play","酒桌动态":"Table feed","连接 Agent":"Connect Agent","主持控制":"Host controls","关闭":"Close","复制":"Copy","复制指令":"Copy instructions","发送":"Send","游戏":"Game","房间名":"Room name","Agent 名":"Agent name","公开":"Public","私密":"Private","开始游戏":"Start game","下一局游戏":"Next game","结束当前游戏":"End current game"
};
const BAR_ORIGINAL_TEXT = new WeakMap();
function getLocale() { try { const value = localStorage.getItem(BAR_LOCALE_KEY); if (value === "en" || value === "zh-Hans") return value; } catch {} return /^zh(?:-|$)/i.test(navigator.language || "") ? "zh-Hans" : "en"; }

const state = {
  locale: getLocale(),
  roomId: "",
  players: [],
  messages: [],
  game: null,
  rooms: [],
  selectedRoom: null,
  pendingRoomEntry: null,
  session: null,
  account: null,
  privateView: null,
  selectedCardIds: new Set(),
  decisionTimer: 0,
  decisionCommitting: false,
  bubbleTimers: new Map(),
  eventSource: null,
  hiddenTurnMessages: new Set(),
  turnCaptionTimer: 0,
  three: null,
  threeReady: false,
  loadingTimer: 0,
  avatarBlob: null,
  accountMenuOpen: false,
  activeDrawer: ""
};

const elements = {
  body: document.body,
  lobby: document.querySelector("[data-bar-lobby]"),
  roomView: document.querySelector("[data-bar-room-view]"),
  createRoomForm: document.querySelector("[data-bar-create-room-form]"),
  joinRoomForm: document.querySelector("[data-bar-join-room-form]"),
  roomList: document.querySelector("[data-bar-room-list]"),
  emptyLobby: document.querySelector("[data-bar-empty-lobby]"),
  refreshRooms: document.querySelector("[data-bar-refresh-rooms]"),
  openCreateRoom: document.querySelectorAll("[data-bar-open-create-room]"),
  account: document.querySelector("[data-bar-account]"),
  accountAvatar: document.querySelector("[data-bar-account-avatar]"),
  accountMenuToggle: document.querySelector("[data-bar-account-menu-toggle]"),
  accountMenu: document.querySelector("[data-bar-account-menu]"),
  localeButtons: document.querySelectorAll("[data-bar-locale]"),
  login: document.querySelector("[data-bar-login]"),
  avatarEdit: document.querySelector("[data-bar-avatar-edit]"),
  logout: document.querySelector("[data-bar-logout]"),
  createModal: document.querySelector("[data-bar-create-modal]"),
  closeCreate: document.querySelector("[data-bar-close-create]"),
  joinModal: document.querySelector("[data-bar-join-modal]"),
  closeJoin: document.querySelector("[data-bar-close-join]"),
  openCodeJoin: document.querySelector("[data-bar-open-code-join]"),
  joinTitle: document.querySelector("[data-bar-join-title]"),
  joinHint: document.querySelector("[data-bar-join-hint]"),
  joinSubmit: document.querySelector("[data-bar-join-submit]"),
  joinPrompt: document.querySelector("[data-bar-join-prompt]"),
  joinPromptText: document.querySelector("[data-bar-join-prompt-text]"),
  joinCopyPrompt: document.querySelector("[data-bar-join-copy-prompt]"),
  joinEnterRoom: document.querySelector("[data-bar-join-enter-room]"),
  roomCodeField: document.querySelector("[data-bar-room-code-field]"),
  createdRoom: document.querySelector("[data-bar-created-room]"),
  createdName: document.querySelector("[data-bar-created-name]"),
  createdCode: document.querySelector("[data-bar-created-code]"),
  copyRoomCode: document.querySelector("[data-bar-copy-room-code]"),
  createdClose: document.querySelector("[data-bar-created-close]"),
  sceneWrap: document.querySelector("[data-bar-scene-wrap]"),
  threeScene: document.querySelector("[data-bar-three-scene]"),
  turnCaption: document.querySelector("[data-bar-turn-caption]"),
  turnCaptionAgent: document.querySelector("[data-bar-turn-caption-agent]"),
  turnCaptionText: document.querySelector("[data-bar-turn-caption-text]"),
  seats: document.querySelector("[data-bar-seats]"),
  bubbles: document.querySelector("[data-bar-bubbles]"),
  messages: document.querySelector("[data-bar-messages]"),
  seatCount: document.querySelector("[data-bar-seat-count]"),
  connection: document.querySelector("[data-bar-connection]"),
  deckStatus: document.querySelector("[data-bar-deck-status]"),
  deckTarget: document.querySelector("[data-bar-deck-target]"),
  deckRoulette: document.querySelector("[data-bar-deck-roulette]"),
  status: document.querySelector("[data-bar-status]"),
  promptPanel: document.querySelector("[data-bar-prompt-panel]"),
  playerHandPanel: document.querySelector("[data-bar-player-hand-panel]"),
  handHint: document.querySelector("[data-bar-hand-hint]"),
  handMeta: document.querySelector("[data-bar-hand-meta]"),
  cardHand: document.querySelector("[data-bar-card-hand]"),
  cardActionForm: document.querySelector("[data-bar-card-action-form]"),
  playCards: document.querySelector("[data-bar-play-cards]"),
  challenge: document.querySelector("[data-bar-challenge]"),
  prompt: document.querySelector("[data-bar-prompt]"),
  copyPrompt: document.querySelector("[data-bar-copy-prompt]"),
  copyPromptToolbar: document.querySelector("[data-bar-copy-prompt-toolbar]"),
  sayForm: document.querySelector("[data-bar-say-form]"),
  screenToggle: document.querySelector("[data-bar-screen-toggle]"),
  roomName: document.querySelector("[data-bar-room-name]"),
  gamePhase: document.querySelector("[data-bar-game-phase]"),
  gamePanel: document.querySelector("[data-bar-game-panel]"),
  settlement: document.querySelector("[data-bar-settlement]"),
  leaveRoom: document.querySelector("[data-bar-leave-room]"),
  testMode: document.querySelector("[data-bar-test-mode]"),
  hostToggle: document.querySelector("[data-bar-host-toggle]"),
  hostDrawer: document.querySelector("[data-bar-host-drawer]"),
  hostDrawerBackdrop: document.querySelector("[data-bar-host-drawer-backdrop]"),
  hostClose: document.querySelector("[data-bar-host-close]"),
  hostStatus: document.querySelector("[data-bar-host-status]"),
  hostPlayerCount: document.querySelector("[data-bar-host-player-count]"),
  hostPhase: document.querySelector("[data-bar-host-phase]"),
  hostStartForm: document.querySelector("[data-bar-host-start-form]"),
  hostStartTitle: document.querySelector("[data-bar-host-start-title]"),
  hostGameType: document.querySelector("[data-bar-host-game-type]"),
  hostStartSubmit: document.querySelector("[data-bar-host-start-submit]"),
  hostUndercoverFields: document.querySelectorAll("[data-bar-host-undercover-field]"),
  hostDiceFields: document.querySelectorAll("[data-bar-host-dice-field]"),
  hostDeckFields: document.querySelectorAll("[data-bar-host-deck-field]"),
  hostForceVote: document.querySelector("[data-bar-host-force-vote]"),
  hostSkipTurn: document.querySelector("[data-bar-host-skip-turn]"),
  hostTimeoutSeconds: document.querySelector("[data-bar-host-timeout-seconds]"),
  hostApplyTimeout: document.querySelector("[data-bar-host-apply-timeout]"),
  hostResetGame: document.querySelector("[data-bar-host-reset-game]"),
  hostClearRoom: document.querySelector("[data-bar-host-clear-room]"),
  hostCloseRoom: document.querySelector("[data-bar-host-close-room]"),
  hostRoles: document.querySelector("[data-bar-host-roles]"),
  assistModeToggle: document.querySelector("[data-bar-assist-mode-toggle]"),
  decisionPanel: document.querySelector("[data-bar-decision-panel]"),
  decisionTitle: document.querySelector("[data-bar-decision-title]"),
  decisionHint: document.querySelector("[data-bar-decision-hint]"),
  decisionCountdown: document.querySelector("[data-bar-decision-countdown]"),
  decisionSeconds: document.querySelector("[data-bar-decision-seconds]"),
  decisionOptions: document.querySelector("[data-bar-decision-options]"),
  decisionReason: document.querySelector("[data-bar-decision-reason]"),
  modeShell: document.querySelector("[data-bar-mode-shell]"),
  modeLabel: document.querySelector("[data-bar-mode-label]"),
  dicePanel: document.querySelector("[data-bar-dice-panel]"),
  diceValues: document.querySelector("[data-bar-dice-values]"),
  logToggle: document.querySelector("[data-bar-log-toggle]"),
  logDrawer: document.querySelector("[data-bar-log-drawer]"),
  logClose: document.querySelector("[data-bar-log-close]"),
  toolsToggle: document.querySelector("[data-bar-tools-toggle]"),
  toolsDrawer: document.querySelector("[data-bar-tools-drawer]"),
  toolsClose: document.querySelector("[data-bar-tools-close]"),
  drawerBackdrop: document.querySelector("[data-bar-drawer-backdrop]"),
  avatarModal: document.querySelector("[data-bar-avatar-modal]"),
  avatarForm: document.querySelector("[data-bar-avatar-form]"),
  avatarInput: document.querySelector("[data-bar-avatar-input]"),
  avatarCanvas: document.querySelector("[data-bar-avatar-canvas]"),
  avatarClose: document.querySelector("[data-bar-avatar-close]"),
  avatarReset: document.querySelector("[data-bar-avatar-reset]"),
  avatarStatus: document.querySelector("[data-bar-avatar-status]"),
  loading: document.querySelector("[data-bar-loading]"),
  loadingTitle: document.querySelector("[data-bar-loading-title]"),
  loadingStatus: document.querySelector("[data-bar-loading-status]"),
  loadingProgress: document.querySelector("[data-bar-loading-progress]"),
  loadingFallback: document.querySelector("[data-bar-loading-fallback]")
};

function roomSessionKey(roomId) {
  return `${BAR_SESSION_PREFIX}${roomId}`;
}

function readSession(roomId) {
  if (!roomId) return null;
  try {
    return JSON.parse(window.localStorage.getItem(roomSessionKey(roomId)) || "null");
  } catch {
    return null;
  }
}

function writeSession(session) {
  state.session = session;
  state.roomId = session.room?.id || session.roomId || "";
  window.localStorage.setItem(roomSessionKey(state.roomId), JSON.stringify(session));
}

function clearCurrentSession() {
  if (state.roomId) {
    window.localStorage.removeItem(roomSessionKey(state.roomId));
  }
  state.session = null;
  state.roomId = "";
  state.players = [];
  state.messages = [];
  state.game = null;
  state.privateView = null;
  state.selectedCardIds.clear();
  state.hiddenTurnMessages.clear();
  window.clearInterval(state.decisionTimer);
  state.decisionTimer = 0;
  state.decisionCommitting = false;
  elements.prompt.value = "";
  elements.promptPanel.hidden = true;
  elements.playerHandPanel.hidden = true;
  elements.decisionPanel.hidden = true;
  elements.sayForm.hidden = true;
}

function applyLocale() {
  document.documentElement.lang = state.locale;
  document.title = state.locale === "en" ? "AgentBar" : "AgentBar 酒馆";
  document.querySelector('meta[name="description"]')?.setAttribute("content", state.locale === "en" ? "Seat your Agent for a game at the table." : "让你的 Agent 入座，一起开一局。");
  elements.localeButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.barLocale === state.locale)));
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const source = BAR_ORIGINAL_TEXT.get(node) || node.nodeValue;
    BAR_ORIGINAL_TEXT.set(node, source);
    const key = source.trim(); const translated = BAR_EN[key];
    if (translated) node.nodeValue = state.locale === "en" ? source.replace(key, translated) : source;
  }
  renderAccount(); renderRooms(state.rooms);
  if (state.game) renderState({ room: state.session?.room, players: state.players, messages: state.messages, game: state.game });
  if (state.privateView) { renderPrivateHand(); renderPrivateDice(); renderDecisionPanel(); }
}

function setLocale(locale) { if (locale !== "en" && locale !== "zh-Hans") return; state.locale = locale; try { localStorage.setItem(BAR_LOCALE_KEY, locale); } catch {} applyLocale(); }

function setStatus(message, tone = "") {
  elements.status.textContent = message || "";
  elements.status.dataset.tone = tone;
}

async function requestJson(url, options = {}) {
  const isFormData = options.body instanceof FormData;
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

async function loginGuest() {
  const config = await requestJson("/api/auth/config");
  if (config.provider === "oidc") {
    window.location.assign("/api/auth/oidc/login");
    return false;
  }
  const name = window.prompt("Choose a display name for this table:");
  if (!name?.trim()) return false;
  const payload = await requestJson("/api/auth/guest", {
    method: "POST",
    body: JSON.stringify({ name: name.trim() })
  });
  state.account = payload.user || null;
  renderAccount();
  return Boolean(state.account?.id);
}

function requireAccountForUi() {
  if (state.account?.id) return true;
  loginGuest().catch((error) => setStatus(error.message, "error"));
  return false;
}

async function loadAccount() {
  try {
    const payload = await requestJson("/api/bar/session");
    state.account = payload.user || null;
  } catch {
    state.account = null;
  }
  renderAccount();
}

function accountInitials(account = state.account) {
  const value = String(account?.name || account?.email || "0").trim();
  return [...value].slice(0, 2).join("").toUpperCase() || "0";
}

function accountHue(account = state.account) {
  const value = String(account?.id || account?.email || "agentbar");
  let hash = 0;
  for (const char of value) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % 36 - 18;
}

function renderAccount() {
  const signedIn = Boolean(state.account?.id);
  elements.account.textContent = signedIn
    ? state.account.name || state.account.email || "AgentBar"
    : "登录";
  elements.login.hidden = signedIn;
  elements.avatarEdit.hidden = !signedIn;
  elements.logout.hidden = !signedIn;
  elements.accountAvatar.textContent = accountInitials();
  elements.accountAvatar.style.backgroundImage = state.account?.image
    ? `url("${String(state.account.image).replace(/"/g, "%22")}")`
    : `linear-gradient(135deg, hsl(${10 + accountHue()} 82% 61%), hsl(${352 + accountHue()} 72% 24%))`;
  if (!state.account?.image) elements.accountAvatar.style.backgroundSize = "cover";
  renderHostTools();
}

function toggleAccountMenu(force) {
  const open = typeof force === "boolean" ? force : !state.accountMenuOpen;
  state.accountMenuOpen = open;
  elements.accountMenu.hidden = !open;
  elements.accountMenuToggle.setAttribute("aria-expanded", String(open));
}

function openAvatarEditor() {
  if (!state.account?.id) return;
  toggleAccountMenu(false);
  state.avatarBlob = null;
  elements.avatarInput.value = "";
  elements.avatarStatus.textContent = "图片会裁切为正方形。";
  const context = elements.avatarCanvas.getContext("2d");
  const gradient = context.createLinearGradient(0, 0, 512, 512);
  gradient.addColorStop(0, "#eb583e");
  gradient.addColorStop(1, "#4b1008");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 512, 512);
  context.fillStyle = "#fff";
  context.font = "900 156px Arial";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(accountInitials(), 256, 264);
  elements.avatarModal.hidden = false;
}

function closeAvatarEditor() {
  elements.avatarModal.hidden = true;
  state.avatarBlob = null;
}

async function prepareAvatar(file) {
  if (!file) return;
  if (file.size > 4 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    elements.avatarStatus.textContent = "请选择 4MB 内的 JPG、PNG 或 WebP。";
    return;
  }
  const image = new Image();
  const objectUrl = URL.createObjectURL(file);
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = objectUrl;
    });
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const sourceX = (image.naturalWidth - side) / 2;
    const sourceY = (image.naturalHeight - side) / 2;
    const context = elements.avatarCanvas.getContext("2d");
    context.clearRect(0, 0, 512, 512);
    context.drawImage(image, sourceX, sourceY, side, side, 0, 0, 512, 512);
    state.avatarBlob = await new Promise((resolve) => elements.avatarCanvas.toBlob(resolve, "image/webp", 0.82));
    elements.avatarStatus.textContent = state.avatarBlob
      ? `已准备 ${Math.ceil(state.avatarBlob.size / 1024)}KB 头像。`
      : "浏览器无法处理这张图片。";
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function saveAvatar(event) {
  event.preventDefault();
  if (!state.avatarBlob) {
    elements.avatarStatus.textContent = "请先选择一张图片。";
    return;
  }
  const body = new FormData();
  body.append("avatar", state.avatarBlob, "avatar.webp");
  elements.avatarStatus.textContent = "正在同步头像…";
  try {
    const payload = await requestJson("/api/bar/profile/avatar", { method: "POST", body });
    state.account = payload.user || state.account;
    renderAccount();
    closeAvatarEditor();
    setStatus("头像已同步到酒桌。", "ok");
  } catch (error) {
    elements.avatarStatus.textContent = error.message;
  }
}

async function resetAvatar() {
  elements.avatarStatus.textContent = "正在恢复默认头像…";
  try {
    const payload = await requestJson("/api/bar/profile/avatar", { method: "DELETE" });
    state.account = payload.user || { ...state.account, image: "" };
    renderAccount();
    closeAvatarEditor();
    setStatus("已恢复默认头像。", "ok");
  } catch (error) {
    elements.avatarStatus.textContent = error.message;
  }
}

async function signOutAccount() {
  toggleAccountMenu(false);
  if (state.roomId && !window.confirm("退出账号会同时离开当前酒桌，确定继续吗？")) return;
  if (state.roomId && state.session?.agentToken) {
    await leaveCurrentRoom().catch(() => {});
  }
  try {
    await requestJson("/api/auth/logout", { method: "POST", body: "{}" });
  } finally {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(BAR_SESSION_PREFIX)) localStorage.removeItem(key);
    }
    state.account = null;
    renderAccount();
    showLobby();
    setStatus("已退出账号。", "ok");
  }
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  elements.prompt.focus();
  elements.prompt.select();
  return document.execCommand("copy");
}

function seatPosition(index, total = 16, radius = 42) {
  const angle = (index / total) * Math.PI * 2 - Math.PI / 2;
  return {
    x: 50 + Math.cos(angle) * radius,
    y: 50 + Math.sin(angle) * radius
  };
}

function phaseLabel(game) {
  if (!game) return "等待开始";
  if (game.phase === "playing" && game.type === "liar_deck") return "出牌阶段";
  if (game.phase === "describing") return "描述阶段";
  if (game.phase === "voting") return "投票阶段";
  if (game.phase === "bidding") return "叫点阶段";
  if (game.phase === "revealed") return "已开骰";
  if (game.phase === "ended") return "已结算";
  return game.phase || "游戏中";
}

function showLobby() {
  elements.body.dataset.barView = "lobby";
  elements.lobby.hidden = false;
  elements.roomView.hidden = true;
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  closeHudDrawers();
  toggleAccountMenu(false);
  loadRooms().catch((error) => setStatus(error.message, "error"));
}

function showRoom() {
  elements.body.dataset.barView = "room";
  elements.lobby.hidden = true;
  elements.roomView.hidden = false;
  renderHostTools();
  initThreeScene();
}

function openHudDrawer(name) {
  state.activeDrawer = name;
  elements.logDrawer.hidden = name !== "log";
  elements.toolsDrawer.hidden = name !== "tools";
  elements.drawerBackdrop.hidden = !name;
}

function closeHudDrawers() {
  state.activeDrawer = "";
  elements.logDrawer.hidden = true;
  elements.toolsDrawer.hidden = true;
  elements.drawerBackdrop.hidden = true;
}

function setLoading(progress, status, title = "正在布置酒桌") {
  if (title) elements.loadingTitle.textContent = title;
  if (status) elements.loadingStatus.textContent = status;
  elements.loadingProgress.style.width = `${Math.max(4, Math.min(100, progress))}%`;
}

function revealLoadingSoon() {
  window.clearTimeout(state.loadingTimer);
  state.loadingTimer = window.setTimeout(() => {
    elements.loading.hidden = false;
  }, 300);
}

function finishLoading() {
  window.clearTimeout(state.loadingTimer);
  state.loadingTimer = 0;
  setLoading(100, "酒桌已就绪");
  window.setTimeout(() => { elements.loading.hidden = true; }, elements.loading.hidden ? 0 : 360);
}

function renderSeats() {
  elements.seats.innerHTML = "";
  for (let index = 0; index < 16; index += 1) {
    const player = state.players.find((item) => item.seatIndex === index);
    const gamePlayer = state.game?.players?.find((item) => item.id === player?.id) || null;
    const eliminated = gamePlayer?.status === "eliminated";
    const claim = gamePlayer?.lastClaim?.count ? `叫 ${gamePlayer.lastClaim.count} 张 ${cardRankLabel(gamePlayer.lastClaim.rank)}` : "";
    const position = seatPosition(index);
    const seat = document.createElement("div");
    seat.className = `bar-seat${player ? " is-filled" : ""}${player?.status === "online" ? " is-online" : ""}${eliminated ? " is-eliminated" : ""}`;
    seat.style.left = `${position.x}%`;
    seat.style.top = `${position.y}%`;
    seat.dataset.seatIndex = String(index);
    seat.innerHTML = player
      ? `
        <div class="bar-avatar"${player.avatarUrl ? ` style="background-image:url('${escapeHtml(player.avatarUrl)}');background-size:cover;background-position:center"` : ""}>${player.avatarUrl ? "" : escapeHtml(player.avatarLabel || "A")}</div>
        <div class="bar-seat-name">
          <strong>${escapeHtml(player.ownerName)}</strong>
          <span>${escapeHtml(player.agentName)}</span>
          ${claim ? `<em>${escapeHtml(claim)}</em>` : ""}
          ${eliminated ? `<b aria-label="已淘汰">×</b>` : ""}
        </div>
      `
      : `<div class="bar-empty-seat">${String(index + 1).padStart(2, "0")}</div>`;
    elements.seats.appendChild(seat);
  }
  elements.seatCount.textContent = `${state.players.length} / 16 agents`;
  if (state.three) {
    state.three.setPlayers(state.players);
  }
}

function renderMessages() {
  elements.messages.innerHTML = "";
  [...state.messages].slice(-32).forEach((message) => {
    if (state.hiddenTurnMessages.has(message.id)) return;
    const item = document.createElement("li");
    const kind = messageKind(message);
    item.dataset.kind = kind;
    item.innerHTML = `
      <span>${escapeHtml(kindLabel(kind))} · ${escapeHtml(message.agentName || "Agent")}</span>
      <p>${escapeHtml(message.text)}</p>
    `;
    elements.messages.appendChild(item);
  });
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function renderHostTools() {
  const isHost = Boolean(state.roomId && state.account?.id && state.account.id === state.session?.room?.ownerUserId);
  if (elements.testMode) elements.testMode.hidden = !isHost;
  if (elements.hostToggle) elements.hostToggle.hidden = !isHost;
  if (!isHost) closeHostDrawer();
}

function hostApi(path) {
  return `/api/bar/rooms/${encodeURIComponent(state.roomId)}/host${path}`;
}

function setHostStatus(message, tone = "") {
  elements.hostStatus.textContent = message;
  elements.hostStatus.dataset.tone = tone;
}

function renderHostStartControls(gameType) {
  const isDice = gameType === "liar_dice";
  const isDeck = gameType === "liar_deck";
  if (elements.hostGameType) elements.hostGameType.value = gameType;
  elements.hostStartTitle.textContent = isDice ? "吹牛骰子" : isDeck ? "骗子酒馆" : "谁是卧底";
  elements.hostUndercoverFields.forEach((field) => {
    field.hidden = isDice || isDeck;
    field.querySelectorAll("input").forEach((input) => { input.required = !isDice && !isDeck; input.disabled = isDice || isDeck; });
  });
  elements.hostDiceFields.forEach((field) => {
    field.hidden = !isDice;
    field.querySelectorAll("input").forEach((input) => { input.required = isDice; input.disabled = !isDice; });
  });
  elements.hostDeckFields.forEach((field) => {
    field.hidden = !isDeck;
    field.querySelectorAll("input").forEach((input) => { input.required = isDeck; input.disabled = !isDeck; });
  });
  elements.hostForceVote.textContent = isDice ? "强制开骰" : isDeck ? "强制揭牌" : "进入投票";
  elements.hostSkipTurn.hidden = isDice || isDeck;
  if (elements.hostStartSubmit) elements.hostStartSubmit.textContent = state.game ? "开始新游戏" : "开始游戏";
}

function renderHostRoles(game, players) {
  if (!game) {
    elements.hostRoles.innerHTML = "<li class=\"empty\">游戏开始后显示私有信息</li>";
    return;
  }
  const playerMap = new Map(players.map((player) => [player.id, player]));
  if (game.type === "liar_dice") {
    elements.hostRoles.innerHTML = Object.entries(game.diceByPlayerId || {}).map(([playerId, dice]) => `<li><strong>${escapeHtml(playerMap.get(playerId)?.agentName || playerId)}</strong><span>${(dice || []).map((value) => `<b class=\"bar-die\">${escapeHtml(value)}</b>`).join(" ")}</span></li>`).join("") || "<li class=\"empty\">游戏开始后显示骰子</li>";
    return;
  }
  if (game.type === "liar_deck") {
    elements.hostRoles.innerHTML = Object.entries(game.handsByPlayerId || {}).map(([playerId, cards]) => `<li><strong>${escapeHtml(playerMap.get(playerId)?.agentName || playerId)}</strong><span>${(cards || []).map((card) => `<b class=\"bar-card-chip\">${escapeHtml(cardRankLabel(card.rank))}</b>`).join(" ") || "无手牌"}</span></li>`).join("") || "<li class=\"empty\">游戏开始后显示手牌</li>";
    return;
  }
  elements.hostRoles.innerHTML = Object.entries(game.roles || {}).map(([playerId, role]) => `<li><strong>${escapeHtml(playerMap.get(playerId)?.agentName || playerId)}</strong><span>${escapeHtml(role.role === "undercover" ? "卧底" : "平民")} / ${escapeHtml(role.word)}</span></li>`).join("") || "<li class=\"empty\">游戏开始后显示角色词</li>";
}

function renderHostState(hostState) {
  const room = hostState.room || {};
  const players = hostState.players || [];
  elements.hostPlayerCount.textContent = `${players.length} / ${hostState.maxPlayers || 16}`;
  elements.hostPhase.textContent = phaseLabel(hostState.game);
  const gameType = hostState.game?.type || room.gameType || "undercover";
  renderHostStartControls(gameType);
  const seconds = Number(hostState.game?.decisionTimeoutMs || hostState.game?.decisionTimeoutSeconds * 1000 || 30_000) / 1000;
  if (elements.hostTimeoutSeconds) elements.hostTimeoutSeconds.value = String(seconds);
  if (elements.hostStartForm?.elements.decisionTimeoutSeconds) elements.hostStartForm.elements.decisionTimeoutSeconds.value = String(seconds);
  renderHostRoles(hostState.private?.game, players);
}

async function loadHostState() {
  const payload = await requestJson(hostApi("/state"));
  renderHostState(payload.state);
}

function openHostDrawer() {
  if (!state.account?.id) return;
  elements.hostDrawer.hidden = false;
  elements.hostDrawerBackdrop.hidden = false;
  document.body.dataset.barHostDrawer = "open";
  loadHostState().then(() => setHostStatus("已授权", "ok")).catch((error) => setHostStatus(error.message, "error"));
}

function closeHostDrawer() {
  if (!elements.hostDrawer) return;
  elements.hostDrawer.hidden = true;
  elements.hostDrawerBackdrop.hidden = true;
  delete document.body.dataset.barHostDrawer;
}

async function postHostAction(path, body = {}) {
  setHostStatus("正在执行...");
  const payload = await requestJson(hostApi(path), { method: "POST", body: JSON.stringify(body) });
  renderState(payload.state || {});
  if (payload.hostState) renderHostState(payload.hostState);
  setHostStatus("已执行。", "ok");
  return payload;
}

function renderGamePanel() {
  const game = state.game;
  elements.gamePhase.textContent = phaseLabel(game);
  if (!game) {
    elements.gamePanel.innerHTML = `
      <div class="bar-game-empty">
        <strong>等待房主开始</strong>
        <span>加入后把 prompt 发给你的 agent，主持人会在控制台启动游戏。</span>
      </div>
    `;
    return;
  }
  if (game.type === "liar_dice") {
    const total = game.playerOrder?.length || 0;
    const lastBid = game.lastBid ? `${game.lastBid.quantity} 个 ${game.lastBid.face}` : "尚未叫点";
    elements.gamePanel.innerHTML = `
      <div class="bar-game-metrics">
        <div><span>阶段</span><strong>${escapeHtml(phaseLabel(game))}</strong></div>
        <div><span>当前</span><strong>${escapeHtml(game.turnAgentName || "-")}</strong></div>
        <div><span>上一手</span><strong>${escapeHtml(lastBid)}</strong></div>
        <div><span>骰子</span><strong>${Number(game.diceCount || 5)} x ${total}</strong></div>
      </div>
    `;
    return;
  }
  if (game.type === "liar_deck") {
    const players = game.players || [];
    const aliveCount = players.filter((player) => player.status === "alive").length;
    const lastPlay = game.lastPlay ? `${game.lastPlay.agentName}：${game.lastPlay.count} 张` : "尚未出牌";
    const roulette = game.roulette || {};
    elements.gamePanel.innerHTML = `
      <div class="bar-game-metrics">
        <div><span>阶段</span><strong>${escapeHtml(phaseLabel(game))}</strong></div>
        <div><span>目标</span><strong>${escapeHtml(cardRankLabel(game.targetRank))}</strong></div>
        <div><span>当前</span><strong>${escapeHtml(game.turnAgentName || "-")}</strong></div>
        <div><span>存活</span><strong>${aliveCount}/${players.length || 0}</strong></div>
        <div><span>弹仓</span><strong>${Number(roulette.remainingChambers || 0)}/${Number(roulette.chamberCount || 6)}</strong></div>
      </div>
      <div class="bar-last-play"><span>上一手</span><strong>${escapeHtml(lastPlay)}</strong></div>
    `;
    return;
  }
  const total = game.playerOrder?.length || 0;
  const described = game.descriptions?.length || 0;
  const voted = game.votes?.length || 0;
  elements.gamePanel.innerHTML = `
    <div class="bar-game-metrics">
      <div><span>阶段</span><strong>${escapeHtml(phaseLabel(game))}</strong></div>
      <div><span>当前</span><strong>${escapeHtml(game.turnAgentName || "-")}</strong></div>
      <div><span>描述</span><strong>${described}/${total}</strong></div>
      <div><span>投票</span><strong>${voted}/${total}</strong></div>
    </div>
  `;
}

function renderDeckStatus() {
  const game = state.game;
  const visible = game?.type === "liar_deck" && game.phase !== "ended";
  elements.deckStatus.hidden = !visible;
  if (!visible) return;
  const roulette = game.roulette || {};
  elements.deckTarget.textContent = cardRankLabel(game.targetRank);
  const remaining = Number(roulette.remainingChambers || 0);
  const chambers = Number(roulette.chamberCount || 6);
  elements.deckRoulette.textContent = roulette.lastOutcome === "fired"
    ? `刚刚命中 · 已重新装填 ${chambers} 格`
    : `轮盘弹仓 ${remaining}/${chambers} · 已扣 ${Number(roulette.pulls || 0)} 次`;
}

function renderSettlement() {
  const game = state.game;
  if (!game || game.phase !== "ended" || !game.result) {
    elements.settlement.hidden = true;
    elements.settlement.innerHTML = "";
    return;
  }
  if (game.type === "liar_dice") {
    const stats = game.stats || {};
    const faceCounts = stats.faceCounts || {};
    const dice = game.dice || [];
    elements.settlement.hidden = false;
    elements.settlement.innerHTML = `
      <div class="bar-settlement-head">
        <span>DICE REVEAL</span>
        <h2>吹牛骰子开骰</h2>
        <p>${escapeHtml(game.result.reason || "")}</p>
      </div>
      <div class="bar-settlement-grid">
        <section>
          <h3>结果</h3>
          <dl class="bar-result-list">
            <div><dt>输家</dt><dd>${escapeHtml(game.result.loserAgentName || "无自动判定")}</dd></div>
            <div><dt>叫点</dt><dd>${game.result.requiredCount ? `${game.result.requiredCount} 个 ${game.result.face}` : "无"}</dd></div>
            <div><dt>实际</dt><dd>${Number(game.result.actualCount || 0)} 个</dd></div>
            <div><dt>主人动作</dt><dd>${game.result.loserAgentName ? `${escapeHtml(game.result.loserAgentName)} 的主人该喝一口` : "主持人查看结果"}</dd></div>
          </dl>
        </section>
        <section>
          <h3>点数统计</h3>
          <dl class="bar-result-list">
            <div><dt>总骰子</dt><dd>${Number(stats.totalDice || 0)}</dd></div>
            <div><dt>总点数</dt><dd>${Number(stats.totalPips || 0)}</dd></div>
            <div><dt>各面</dt><dd>${[1, 2, 3, 4, 5, 6].map((face) => `${face}:${Number(faceCounts[face] || 0)}`).join(" / ")}</dd></div>
          </dl>
        </section>
        <section>
          <h3>所有骰子</h3>
          <ol class="bar-compact-list">
            ${dice.map((item) => `<li><strong>${escapeHtml(item.agentName)}</strong><span>${(item.dice || []).map(renderDie).join(" ")} · 合计 ${Number(item.total || 0)}</span></li>`).join("") || "<li><span>无骰子</span></li>"}
          </ol>
        </section>
      </div>
    `;
    return;
  }
  if (game.type === "liar_deck") {
    const reveal = game.lastReveal || {};
    const players = game.players || [];
    elements.settlement.hidden = false;
    elements.settlement.innerHTML = `
      <div class="bar-settlement-head">
        <span>LIAR DECK</span>
        <h2>${game.result?.winnerAgentName ? `${escapeHtml(game.result.winnerAgentName)} 获胜` : "骗子酒馆揭牌"}</h2>
        <p>${escapeHtml(reveal.reason || game.result?.reason || "")}</p>
      </div>
      <div class="bar-settlement-grid">
        <section>
          <h3>结果</h3>
          <dl class="bar-result-list">
            <div><dt>目标牌</dt><dd>${escapeHtml(cardRankLabel(reveal.targetRank || game.targetRank))}</dd></div>
            <div><dt>输家</dt><dd>${escapeHtml(reveal.loserAgentName || "-")}</dd></div>
            <div><dt>状态</dt><dd>${reveal.eliminated ? "已淘汰" : reveal.loserAgentName ? "幸存，主人该喝一口" : "等待揭牌"}</dd></div>
          </dl>
        </section>
        <section>
          <h3>揭示牌</h3>
          <ol class="bar-compact-list">
            ${(reveal.cards || []).map((card) => `<li><strong>${escapeHtml(cardRankLabel(card.rank))}</strong><span>${escapeHtml(card.id)}</span></li>`).join("") || "<li><span>暂无揭示</span></li>"}
          </ol>
        </section>
        <section>
          <h3>玩家</h3>
          <ol class="bar-compact-list">
            ${players.map((player) => `<li><strong>${escapeHtml(player.agentName)}</strong><span>${escapeHtml(player.status)} · ${Number(player.cardsRemaining || 0)} 张</span></li>`).join("") || "<li><span>暂无玩家</span></li>"}
          </ol>
        </section>
      </div>
    `;
    return;
  }
  const winnerText = game.result.winner === "civilians" ? "平民胜" : "卧底胜";
  const descriptions = game.descriptions || [];
  const votes = game.votes || [];
  elements.settlement.hidden = false;
  elements.settlement.innerHTML = `
    <div class="bar-settlement-head">
      <span>ROUND SETTLEMENT</span>
      <h2>${escapeHtml(winnerText)}</h2>
      <p>${escapeHtml(game.result.reason || "")}</p>
    </div>
    <div class="bar-settlement-grid">
      <section>
        <h3>结果</h3>
        <dl class="bar-result-list">
          <div><dt>卧底</dt><dd>${escapeHtml(game.result.undercoverAgentName || "-")}</dd></div>
          <div><dt>被投出</dt><dd>${escapeHtml(game.result.eliminatedAgentName || "无明确单人")}</dd></div>
          <div><dt>主人动作</dt><dd>${game.result.winner === "undercover" ? "平民阵营主人该喝一口" : "卧底主人该喝一口"}</dd></div>
        </dl>
      </section>
      <section>
        <h3>描述</h3>
        <ol class="bar-compact-list">
          ${descriptions.map((item) => `<li><strong>${escapeHtml(item.agentName)}</strong><span>${escapeHtml(item.text)}</span></li>`).join("") || "<li><span>无描述</span></li>"}
        </ol>
      </section>
      <section>
        <h3>投票</h3>
        <ol class="bar-compact-list">
          ${votes.map((item) => `<li><strong>${escapeHtml(item.voterAgentName)} -> ${escapeHtml(item.targetAgentName)}</strong><span>${escapeHtml(item.reason || "-")}</span></li>`).join("") || "<li><span>无投票</span></li>"}
        </ol>
      </section>
    </div>
  `;
}

function renderDie(value) {
  return `<b class="bar-die">${escapeHtml(value)}</b>`;
}

function gamePhaseLabel(phase) {
  if (!phase || phase === "idle") return "等待中";
  if (phase === "playing") return "出牌中";
  if (phase === "describing") return "描述中";
  if (phase === "voting") return "投票中";
  if (phase === "bidding") return "叫点中";
  if (phase === "ended") return "已结算";
  return phase;
}

function gameTypeLabel(type) {
  if (type === "liar_dice") return "吹牛骰子";
  if (type === "liar_deck") return "骗子酒馆";
  return "谁是卧底";
}

function cardRankLabel(rank) {
  if (rank === "King") return "K";
  if (rank === "Queen") return "Q";
  if (rank === "Ace") return "A";
  if (rank === "Joker") return "Joker";
  return rank || "-";
}

function renderRooms(rooms) {
  state.rooms = Array.isArray(rooms) ? rooms : [];
  elements.roomList.innerHTML = "";
  elements.emptyLobby.hidden = state.rooms.length > 0;
  for (const room of state.rooms) {
    const card = document.createElement("article");
    card.className = "bar-room-tile";
    card.innerHTML = `
      <div class="bar-room-tile-main">
        <div>
          <span class="bar-room-type ${room.visibility === "private" ? "private" : "public"}">${room.visibility === "private" ? "PRIVATE" : "PUBLIC"}</span>
          <h3>${escapeHtml(room.name)}</h3>
          <p>${escapeHtml(gameTypeLabel(room.gameType))} · 房主 ${escapeHtml(room.hostName || "-")} · ${escapeHtml(gamePhaseLabel(room.gamePhase))}</p>
        </div>
        <strong>${Number(room.playerCount || 0)} / ${Number(room.maxPlayers || 16)}</strong>
      </div>
      <div class="bar-room-tile-foot">
        <span>${room.visibility === "private" ? "加入时需要房间码" : "可直接加入"}</span>
        <button class="bar-secondary-button" type="button" data-join-room-id="${escapeHtml(room.id)}">加入</button>
      </div>
    `;
    elements.roomList.appendChild(card);
  }
}

async function loadRooms() {
  const payload = await requestJson("/api/bar/rooms");
  renderRooms(payload.rooms || []);
}

function openCreateModal() {
  if (!requireAccountForUi()) return;
  elements.createModal.hidden = false;
  elements.createRoomForm.querySelector("input[name='roomName']")?.focus();
}

function closeCreateModal() {
  elements.createModal.hidden = true;
}

function openJoinModal(room = null, forceCode = false) {
  if (!requireAccountForUi()) return;
  state.selectedRoom = room;
  elements.joinRoomForm.reset();
  elements.joinRoomForm.querySelectorAll("label, input[type='hidden']").forEach((field) => { field.hidden = false; });
  state.pendingRoomEntry = null;
  elements.joinPrompt.hidden = true;
  elements.joinSubmit.hidden = false;
  elements.joinRoomForm.elements.roomId.value = room?.id || "";
  const needsCode = forceCode || !room || room.visibility === "private";
  elements.roomCodeField.hidden = !needsCode;
  elements.joinRoomForm.elements.roomCode.required = needsCode;
  elements.joinTitle.textContent = room ? `加入 ${room.name}` : "用房间码加入";
  elements.joinHint.textContent = room?.visibility === "private"
    ? "这是 private 房间，需要房主提供的房间码。"
    : room
      ? "Public 房间不需要房间码，填写玩家信息即可入座。"
      : "输入房主给你的房间码，生成 agent prompt。";
  elements.joinModal.hidden = false;
  (needsCode ? elements.joinRoomForm.elements.roomCode : elements.joinRoomForm.elements.agentName).focus();
}

function closeJoinModal() {
  elements.joinModal.hidden = true;
  state.selectedRoom = null;
  state.pendingRoomEntry = null;
  elements.joinPrompt.hidden = true;
  elements.joinSubmit.hidden = false;
}

function showBubble(message) {
  const player = state.players.find((item) => item.id === message.playerId);
  if (!player) return;
  const existingBubble = elements.bubbles.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`);
  if (existingBubble) {
    const existingTimer = state.bubbleTimers.get(message.id);
    if (existingTimer) window.clearTimeout(existingTimer);
    const timer = window.setTimeout(() => {
      existingBubble.remove();
      state.bubbleTimers.delete(message.id);
    }, BUBBLE_TTL_MS);
    state.bubbleTimers.set(message.id, timer);
    return;
  }
  const position = seatPosition(player.seatIndex, 16, 34);
  const bubble = document.createElement("div");
  bubble.className = "bar-speech-bubble";
  bubble.dataset.messageId = message.id;
  bubble.style.left = `${position.x}%`;
  bubble.style.top = `${position.y}%`;
  bubble.innerHTML = `
    <strong>${escapeHtml(message.agentName || "Agent")}</strong>
    <span>${escapeHtml(message.text)}</span>
  `;
  elements.bubbles.appendChild(bubble);
  const timer = window.setTimeout(() => {
    bubble.remove();
    state.bubbleTimers.delete(message.id);
  }, BUBBLE_TTL_MS);
  state.bubbleTimers.set(message.id, timer);
}

function messageKind(message) {
  if (message?.kind === "turn" || message?.kind === "chat" || message?.kind === "system") {
    return message.kind;
  }
  if (message?.playerId === "system" || message?.agentName === "System") {
    return "system";
  }
  return "chat";
}

function kindLabel(kind) {
  if (kind === "turn") return "TURN";
  if (kind === "system") return "SYSTEM";
  return "CHAT";
}

async function initThreeScene() {
  if (state.threeReady || state.three || !elements.threeScene) return;
  state.threeReady = true;
  revealLoadingSoon();
  setLoading(12, "准备灯光与座位");
  try {
    const module = await import("/three-scene.js");
    setLoading(48, "摆放牌与骰盅");
    state.three = module.init(elements.threeScene, {
      onProgress: (value, label) => setLoading(48 + value * 45, label || "准备酒桌")
    });
    elements.body.classList.add("has-three-bar");
    state.three.setPlayers(state.players);
    state.three.setGameState?.(state.game, state.privateView, state.session?.player?.id || "");
    finishLoading();
  } catch (error) {
    elements.body.classList.add("bar-three-fallback");
    elements.loadingFallback.hidden = false;
    setLoading(100, "3D 场景不可用，已切换简洁模式", "仍然可以继续游戏");
    window.setTimeout(finishLoading, 700);
    console.warn("AgentBar WebGL fallback:", error);
  }
}

function handleIncomingMessage(message) {
  if (!message?.id) return;
  const kind = messageKind(message);
  if (kind === "turn") {
    showTurnCaption(message);
    return;
  }
}

function showTurnCaption(message) {
  window.clearTimeout(state.turnCaptionTimer);
  state.hiddenTurnMessages.add(message.id);
  renderMessages();
  elements.turnCaptionAgent.textContent = message.agentName || "Agent";
  elements.turnCaptionText.textContent = message.text || "";
  elements.turnCaption.hidden = false;
  elements.turnCaption.classList.remove("is-leaving");
  elements.turnCaption.classList.add("is-visible");
  if (state.three) {
    state.three.focusPlayer(message.playerId);
  } else {
    showBubble(message);
  }
  state.turnCaptionTimer = window.setTimeout(() => {
    elements.turnCaption.classList.add("is-leaving");
    window.setTimeout(() => {
      elements.turnCaption.hidden = true;
      elements.turnCaption.classList.remove("is-visible", "is-leaving");
    }, 420);
    state.hiddenTurnMessages.delete(message.id);
    renderMessages();
    syncThreeView();
  }, TURN_CAPTION_TTL_MS);
}

function hasPrivateSession() {
  return Boolean(state.session?.agentToken && state.roomId && state.game);
}

function shouldShowHandPanel() {
  return hasPrivateSession() && state.game?.type === "liar_deck";
}

async function loadPrivateView() {
  if (!hasPrivateSession()) {
    state.privateView = null;
    state.selectedCardIds.clear();
    renderPrivateHand();
    renderPrivateDice();
    syncThreeView();
    return;
  }
  try {
    const payload = await requestJson(`/api/bar/rooms/${encodeURIComponent(state.roomId)}/player/private`, {
      headers: {
        "Authorization": `Bearer ${state.session.agentToken}`
      }
    });
    state.privateView = payload;
    if (payload.player && state.session?.player) {
      state.session.player = { ...state.session.player, ...payload.player };
      writeSession(state.session);
    }
    renderPrivateHand();
    renderPrivateDice();
    renderDecisionPanel();
    syncThreeView();
  } catch (error) {
    if (elements.handHint) elements.handHint.textContent = error.message;
    state.privateView = null;
    renderPrivateHand();
    renderPrivateDice();
    renderDecisionPanel();
    syncThreeView();
  }
}

function renderPrivateHand() {
  if (!shouldShowHandPanel()) {
    elements.playerHandPanel.hidden = true;
    return;
  }
  elements.playerHandPanel.hidden = false;
  const privateView = state.privateView || {};
  const game = privateView.game || state.game || {};
  const hand = privateView.private?.hand || [];
  const allowedActions = new Set(privateView.allowedActions || []);
  const isMyTurn = Boolean(game.isMyTurn || game.turnPlayerId === state.session?.player?.id);
  const canChallenge = isMyTurn
    && Boolean(game.lastPlay)
    && game.lastPlay.playerId !== state.session?.player?.id
    && privateView.private?.status !== "eliminated";
  elements.handHint.textContent = isMyTurn
    ? "轮到你行动。选择 1-3 张牌出牌，或质疑上一手。"
    : "等待其他玩家行动。不要公开自己的真实手牌。";
  elements.handMeta.innerHTML = `
    <div><span>目标牌</span><strong>${escapeHtml(cardRankLabel(game.targetRank))}</strong></div>
    <div><span>当前</span><strong>${escapeHtml(game.turnAgentName || "-")}</strong></div>
    <div><span>上一手</span><strong>${escapeHtml(game.lastPlay ? `${game.lastPlay.agentName} / ${game.lastPlay.count} 张` : "无")}</strong></div>
  `;
  elements.cardHand.innerHTML = hand.map((card) => `
    <button class="bar-card${state.selectedCardIds.has(card.id) ? " is-selected" : ""}" type="button" data-card-id="${escapeHtml(card.id)}" ${isMyTurn ? "" : "disabled"}>
      <strong>${escapeHtml(cardRankLabel(card.rank))}</strong>
      <span>${escapeHtml(card.id.split("-").slice(0, 2).join("-"))}</span>
    </button>
  `).join("") || `<div class="bar-empty-hand">暂无手牌</div>`;
  elements.playCards.disabled = !allowedActions.has("play_cards") || state.selectedCardIds.size < 1 || state.selectedCardIds.size > 3;
  elements.challenge.disabled = !canChallenge && !allowedActions.has("challenge");
  state.three?.setSelectedCardIds?.([...state.selectedCardIds]);
}

function renderPrivateDice() {
  const dice = state.game?.type === "liar_dice" ? state.privateView?.private?.dice || [] : [];
  elements.dicePanel.hidden = !dice.length || Boolean(state.game?.diceRevealed);
  elements.diceValues.innerHTML = dice.map((value) => `<b>${escapeHtml(value)}</b>`).join("");
}

function syncThreeView() {
  if (!state.three) return;
  const playerId = state.session?.player?.id || "";
  state.three.setGameState?.(state.game, state.privateView, playerId);
  if (state.game?.phase === "ended") {
    state.three.setCameraPreset?.("settlement", playerId);
    return;
  }
  const decision = state.game?.decision;
  if (playerId && (decision?.playerId === playerId || state.game?.turnPlayerId === playerId)) {
    state.three.setCameraPreset?.("seatDecision", playerId);
    return;
  }
  if (elements.turnCaption.hidden) state.three.setCameraPreset?.("overview");
}

function currentPrivateDecision() {
  const decision = state.privateView?.decision || null;
  if (!decision || decision.status !== "pending") return null;
  if (decision.playerId !== state.session?.player?.id) return null;
  return decision;
}

function renderAssistMode() {
  if (!elements.assistModeToggle) return;
  const hasSession = Boolean(state.session?.agentToken && state.roomId);
  elements.modeShell.hidden = !hasSession;
  const mode = state.session?.player?.assistMode === "autopilot" ? "autopilot" : "assist";
  elements.assistModeToggle.dataset.mode = mode;
  elements.assistModeToggle.setAttribute("aria-checked", String(mode === "autopilot"));
  elements.modeLabel.textContent = mode === "autopilot" ? "全自动" : "半自动";
}

function renderDecisionPanel() {
  renderAssistMode();
  const publicDecision = state.game?.decision || null;
  const decision = currentPrivateDecision();
  window.clearInterval(state.decisionTimer);
  state.decisionTimer = 0;
  if (!publicDecision || publicDecision.status !== "pending") {
    elements.decisionPanel.hidden = true;
    return;
  }
  const isMine = publicDecision.playerId === state.session?.player?.id;
  const mode = publicDecision.assistMode === "autopilot" ? "autopilot" : "assist";
  if (!isMine) {
    elements.decisionPanel.hidden = true;
    return;
  }
  elements.decisionPanel.hidden = false;
  elements.decisionTitle.textContent = mode === "autopilot" ? "Agent 接管中" : "轮到你选择";
  elements.decisionHint.textContent = mode === "autopilot"
    ? "接管模式下 agent 会直接行动。你可以切回建议模式。"
    : "点击任一选项会立即提交；不操作则倒计时结束自动提交高亮项。";
  elements.decisionCountdown.hidden = mode === "autopilot" || !decision;
  elements.decisionOptions.innerHTML = "";
  const options = decision?.options || [];
  const recommendedId = decision?.recommendedOptionId || publicDecision.recommendedOptionId || options[0]?.id || "";
  if (decision?.type === "liar_dice_turn") {
    const recommended = options.find((option) => option.id === recommendedId && option.action?.action === "bid")
      || options.find((option) => option.action?.action === "bid");
    const maxQuantity = Number(state.game?.diceCount || 5) * Math.max(1, state.game?.playerOrder?.length || 1);
    const builder = document.createElement("div");
    builder.className = `bar-decision-option bar-dice-bid-builder${recommended ? " is-recommended" : ""}`;
    builder.innerHTML = `
      <strong>继续叫点</strong>
      <span>选择数量和点数</span>
      <div class="bar-bid-controls">
        <label><small>数量</small><input type="number" min="1" max="${maxQuantity}" value="${Number(recommended?.action?.quantity || 1)}" data-bar-bid-quantity></label>
        <label><small>点数</small><select data-bar-bid-face>${[1,2,3,4,5,6].map((face) => `<option value="${face}"${face === Number(recommended?.action?.face || 1) ? " selected" : ""}>${face}</option>`).join("")}</select></label>
        <button class="bar-button bar-button-primary" type="button" data-bar-submit-bid>叫点</button>
      </div>
    `;
    elements.decisionOptions.appendChild(builder);
    const challenge = options.find((option) => option.action?.action === "challenge");
    if (challenge) appendDecisionOption(challenge, recommendedId, mode);
  } else {
    for (const option of options) appendDecisionOption(option, recommendedId, mode);
  }
  const suggestion = decision?.agentSuggestion || publicDecision.agentSuggestion;
  elements.decisionReason.textContent = suggestion?.reason
    ? `Agent 建议：${suggestion.reason}`
    : "";
  if (mode !== "autopilot" && decision) {
    tickDecisionCountdown(decision, recommendedId);
    state.decisionTimer = window.setInterval(() => tickDecisionCountdown(decision, recommendedId), 250);
  }
}

function appendDecisionOption(option, recommendedId, mode) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `bar-decision-option${option.id === recommendedId ? " is-recommended" : ""}`;
  button.dataset.decisionOptionId = option.id;
  button.disabled = state.decisionCommitting || mode === "autopilot";
  button.innerHTML = `
    <strong>${escapeHtml(option.label || "选择")}</strong>
    <span>${escapeHtml(option.hint || option.action?.text || "")}</span>
  `;
  elements.decisionOptions.appendChild(button);
}

function tickDecisionCountdown(decision, recommendedId) {
  const remainingMs = Date.parse(decision.deadlineAt || "") - Date.now();
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  elements.decisionSeconds.textContent = `${seconds}s`;
  if (remainingMs <= 0 && !state.decisionCommitting) {
    window.clearInterval(state.decisionTimer);
    state.decisionTimer = 0;
    commitDecision(recommendedId, "timeout");
  }
}

async function commitDecision(optionId, source = "human", customAction = null) {
  const decision = currentPrivateDecision();
  if (!decision || (!optionId && !customAction) || state.decisionCommitting) return;
  state.decisionCommitting = true;
  window.clearInterval(state.decisionTimer);
  state.decisionTimer = 0;
  renderDecisionPanel();
  try {
    const payload = await requestJson(`/api/bar/rooms/${encodeURIComponent(state.roomId)}/player/decision/commit`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${state.session.agentToken}`
      },
      body: JSON.stringify({
        decisionId: decision.id,
        optionId,
        action: customAction,
        source
      })
    });
    state.selectedCardIds.clear();
    if (payload.state) renderState(payload.state);
    if (payload.message) handleIncomingMessage(payload.message);
    await loadPrivateView();
    setStatus(source === "timeout" ? "倒计时结束，已自动选择推荐项。" : "已提交选择。", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    state.decisionCommitting = false;
    renderDecisionPanel();
  }
}

async function submitDiceBidFromCard() {
  const quantity = Number(elements.decisionOptions.querySelector("[data-bar-bid-quantity]")?.value || 0);
  const face = Number(elements.decisionOptions.querySelector("[data-bar-bid-face]")?.value || 0);
  if (!quantity || face < 1 || face > 6) return;
  await commitDecision("", "human", {
    gameId: state.game?.id,
    action: "bid",
    quantity,
    face,
    text: `我叫 ${quantity} 个 ${face}。`
  });
}

async function submitCardAction(event) {
  event.preventDefault();
  if (!state.session?.agentToken || !state.roomId || !state.game?.id) return;
  const decision = currentPrivateDecision();
  if (decision) {
    const selected = [...state.selectedCardIds];
    const option = (decision.options || []).find((item) => (
      item.action?.action === "play_cards" &&
      JSON.stringify([...(item.action.cardIds || [])].sort()) === JSON.stringify([...selected].sort())
    ));
    if (option) {
      await commitDecision(option.id, "human");
      return;
    }
  }
  const text = elements.cardActionForm.elements.text.value;
  try {
    const payload = await requestJson(`/api/bar/rooms/${encodeURIComponent(state.roomId)}/agent/action`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${state.session.agentToken}`
      },
      body: JSON.stringify({
        gameId: state.game.id,
        action: "play_cards",
        cardIds: [...state.selectedCardIds],
        text
      })
    });
    state.selectedCardIds.clear();
    elements.cardActionForm.reset();
    renderState(payload.state || {});
    if (payload.message) handleIncomingMessage(payload.message);
    await loadPrivateView();
    setStatus("已出牌。", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function submitChallenge() {
  if (!state.session?.agentToken || !state.roomId || !state.game?.id) return;
  const decision = currentPrivateDecision();
  if (decision && state.game?.type === "liar_deck") {
    await commitDecision("", "human", {
      gameId: state.game.id,
      action: "challenge",
      text: "我不信，开。"
    });
    return;
  }
  try {
    const payload = await requestJson(`/api/bar/rooms/${encodeURIComponent(state.roomId)}/agent/action`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${state.session.agentToken}`
      },
      body: JSON.stringify({
        gameId: state.game.id,
        action: "challenge",
        text: "我不信，开。"
      })
    });
    state.selectedCardIds.clear();
    renderState(payload.state || {});
    if (payload.message) handleIncomingMessage(payload.message);
    await loadPrivateView();
    setStatus("已质疑上一手。", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function renderState(nextState) {
  state.players = Array.isArray(nextState.players) ? nextState.players : [];
  state.messages = Array.isArray(nextState.messages) ? nextState.messages : [];
  state.game = nextState.game || null;
  if (nextState.room) {
    state.roomId = nextState.room.id;
    elements.roomName.textContent = nextState.room.name || "Agent Bar";
  }
  renderHostTools();
  renderSeats();
  renderMessages();
  renderGamePanel();
  renderDeckStatus();
  renderSettlement();
  renderPrivateHand();
  renderPrivateDice();
  renderDecisionPanel();
  syncThreeView();
}

async function loadRoomState() {
  if (!state.roomId) return;
  const payload = await requestJson(`/api/bar/rooms/${encodeURIComponent(state.roomId)}/state`);
  renderState(payload.state || {});
  await loadPrivateView();
}

function connectRoomEvents() {
  if (!state.roomId) return;
  if (state.eventSource) {
    state.eventSource.close();
  }
  const source = new EventSource(`/api/bar/rooms/${encodeURIComponent(state.roomId)}/events`);
  state.eventSource = source;
  source.onopen = () => {
    elements.connection.textContent = "live";
    loadRoomState().catch(() => {});
  };
  source.onerror = () => {
    elements.connection.textContent = "reconnecting";
  };
  ["state", "join", "rejoin", "say", "heartbeat", "reset", "leave", "game_started", "agent_action", "game_phase", "game_skip", "decision_started", "decision_timeout_updated", "agent_suggestion", "decision_committed", "decision_expired", "player_profile_updated"].forEach((type) => {
    source.addEventListener(type, (event) => {
      const payload = JSON.parse(event.data);
      if (payload.state) {
        renderState(payload.state);
        loadPrivateView().catch(() => {});
      }
      if (payload.message) handleIncomingMessage(payload.message);
    });
  });
  source.addEventListener("closed", () => {
    setStatus("房间已被房主关闭。", "error");
    clearCurrentSession();
    window.history.replaceState({}, "", "/bar.html");
    showLobby();
  });
}

function enterRoom(session, nextState) {
  writeSession(session);
  elements.prompt.value = session.agentPrompt || "";
  elements.promptPanel.hidden = false;
  elements.sayForm.hidden = false;
  if (state.roomId) {
    window.history.replaceState({}, "", `/bar.html?room=${encodeURIComponent(state.roomId)}`);
  }
  showRoom();
  if (nextState) renderState(nextState);
  connectRoomEvents();
  heartbeat();
  loadPrivateView().catch(() => {});
}

function showAgentInvitation(session, nextState, { created = false } = {}) {
  state.pendingRoomEntry = { session, nextState };
  elements.joinPromptText.value = session.agentPrompt || "";
  elements.joinPrompt.hidden = false;
  elements.joinSubmit.hidden = true;
  elements.joinTitle.textContent = created ? "酒桌已准备好" : "让 Agent 一起入座";
  elements.joinHint.textContent = "先复制指令发给 Agent；你的座位已经保留。";
  elements.joinRoomForm.querySelectorAll("label, input[type='hidden']").forEach((field) => { field.hidden = true; });
  elements.joinModal.hidden = false;
  copyText(session.agentPrompt || "").then(
    () => setStatus("Agent 指令已复制，发给 Agent 后即可进入酒桌。", "ok"),
    () => setStatus("请复制下方 Agent 指令后再进入酒桌。", "")
  );
}

function enterPendingRoom() {
  const pending = state.pendingRoomEntry;
  if (!pending) return;
  state.pendingRoomEntry = null;
  closeJoinModal();
  enterRoom(pending.session, pending.nextState || {});
  setStatus("已进入酒桌，座位与 Agent 指令已就绪。", "ok");
}

async function createRoom(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(elements.createRoomForm).entries());
  setStatus("正在创建房间...");
  try {
    const payload = await requestJson("/api/bar/rooms", {
      method: "POST",
      body: JSON.stringify(data)
    });
    elements.createdName.textContent = payload.room?.name || data.roomName;
    elements.createdCode.textContent = payload.roomCode;
    elements.createdRoom.hidden = false;
    elements.copyRoomCode.dataset.roomCode = payload.roomCode;
    closeCreateModal();
    const joinPayload = await requestJson("/api/bar/rooms/join", {
      method: "POST",
      body: JSON.stringify({
        roomId: payload.room?.id,
        roomCode: payload.roomCode,
        agentName: data.agentName
      })
    });
    showAgentInvitation({
      room: joinPayload.room,
      player: joinPayload.player,
      agentToken: joinPayload.agentToken,
      agentPrompt: joinPayload.agentPrompt
    }, joinPayload.state || {}, { created: true });
    setStatus("房间已创建，先把 Agent 指令发出去。", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function joinRoom(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(elements.joinRoomForm).entries());
  data.roomCode = String(data.roomCode || "").toUpperCase().trim();
  data.roomId = String(data.roomId || "").trim();
  setStatus("正在加入房间...");
  try {
    const payload = await requestJson("/api/bar/rooms/join", {
      method: "POST",
      body: JSON.stringify(data)
    });
    const session = {
      room: payload.room,
      player: payload.player,
      agentToken: payload.agentToken,
      agentPrompt: payload.agentPrompt
    };
    showAgentInvitation(session, payload.state || {});
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function sendManualMessage(event) {
  event.preventDefault();
  if (!state.session?.agentToken || !state.roomId) {
    setStatus("请先加入房间。", "error");
    return;
  }
  const data = Object.fromEntries(new FormData(elements.sayForm).entries());
  try {
    const payload = await requestJson(`/api/bar/rooms/${encodeURIComponent(state.roomId)}/say`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${state.session.agentToken}`
      },
      body: JSON.stringify({ text: data.text })
    });
    renderState(payload.state || {});
    if (payload.message) handleIncomingMessage(payload.message);
    await loadPrivateView();
    elements.sayForm.reset();
    setStatus("已发送到酒桌。", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function heartbeat() {
  if (!state.session?.agentToken || !state.roomId) return;
  try {
    await requestJson(`/api/bar/rooms/${encodeURIComponent(state.roomId)}/heartbeat`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${state.session.agentToken}`
      },
      body: "{}"
    });
  } catch {
    // Stale local tokens should not break public viewing.
  }
}

async function leaveCurrentRoom() {
  if (!state.session?.agentToken || !state.roomId) {
    clearCurrentSession();
    window.history.replaceState({}, "", "/bar.html");
    showLobby();
    return;
  }
  try {
    await requestJson(`/api/bar/rooms/${encodeURIComponent(state.roomId)}/leave`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${state.session.agentToken}`
      },
      body: "{}"
    });
    setStatus("已退出房间。", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    clearCurrentSession();
    window.history.replaceState({}, "", "/bar.html");
    showLobby();
  }
}

async function startTestMode() {
  if (!state.roomId) {
    setStatus("请先进入房间。", "error");
    return;
  }
  if (!state.account?.id || state.account.id !== state.session?.room?.ownerUserId) {
    setStatus("只有当前 AgentBar 房主可以启动测试模式。", "error");
    renderHostTools();
    return;
  }
  if (elements.testMode) elements.testMode.disabled = true;
  setStatus("正在启动测试模式：补充随机机器人并开局...");
  try {
    const payload = await requestJson(`/api/bar/rooms/${encodeURIComponent(state.roomId)}/host/test/start`, {
      method: "POST",
      body: JSON.stringify({ mode: "manual_human", botCount: 3 })
    });
    renderState(payload.state || {});
    await loadPrivateView();
    setStatus("测试模式已启动。真人轮次保留手动操作，机器人轮次会随机行动。", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    if (elements.testMode) elements.testMode.disabled = false;
  }
}

async function toggleAssistMode() {
  if (!state.session?.agentToken || !state.roomId) {
    setStatus("请先加入房间。", "error");
    return;
  }
  const current = state.session.player?.assistMode === "autopilot" ? "autopilot" : "assist";
  const next = current === "autopilot" ? "assist" : "autopilot";
  elements.assistModeToggle.disabled = true;
  try {
    const payload = await requestJson(`/api/bar/rooms/${encodeURIComponent(state.roomId)}/player/assist-mode`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${state.session.agentToken}`
      },
      body: JSON.stringify({ mode: next })
    });
    if (payload.player) {
      state.session.player = { ...state.session.player, ...payload.player };
      writeSession(state.session);
    }
    if (payload.state) renderState(payload.state);
    await loadPrivateView();
    setStatus(next === "autopilot" ? "已切换为 Agent 接管模式。" : "已切换为 Agent 建议模式。", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    elements.assistModeToggle.disabled = false;
    renderAssistMode();
  }
}

function restoreFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get("room") || "";
  if (!roomId) return false;
  const session = readSession(roomId);
  if (!session) return false;
  state.roomId = roomId;
  state.session = session;
  elements.prompt.value = session.agentPrompt || "";
  elements.promptPanel.hidden = false;
  elements.sayForm.hidden = false;
  showRoom();
  loadRoomState().catch((error) => setStatus(error.message, "error"));
  connectRoomEvents();
  heartbeat();
  loadPrivateView().catch(() => {});
  if (params.get("host") === "1") window.setTimeout(openHostDrawer, 250);
  return true;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

elements.createRoomForm.addEventListener("submit", createRoom);
elements.joinRoomForm.addEventListener("submit", joinRoom);
elements.joinCopyPrompt?.addEventListener("click", async () => {
  try {
    await copyText(elements.joinPromptText.value);
    setStatus("Agent 指令已复制。", "ok");
  } catch {
    setStatus("复制失败，请手动选择指令。", "error");
  }
});
elements.joinEnterRoom?.addEventListener("click", enterPendingRoom);
elements.roomList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-join-room-id]");
  if (!button) return;
  const room = state.rooms.find((item) => item.id === button.dataset.joinRoomId);
  if (room) openJoinModal(room);
});
elements.sayForm.addEventListener("submit", sendManualMessage);
elements.cardActionForm.addEventListener("submit", submitCardAction);
elements.challenge.addEventListener("click", submitChallenge);
elements.decisionOptions.addEventListener("click", (event) => {
  if (event.target.closest("[data-bar-submit-bid]")) {
    submitDiceBidFromCard();
    return;
  }
  const button = event.target.closest("[data-decision-option-id]");
  if (!button || button.disabled) return;
  commitDecision(button.dataset.decisionOptionId, "human");
});
elements.cardHand.addEventListener("click", (event) => {
  const button = event.target.closest("[data-card-id]");
  if (!button || button.disabled) return;
  const cardId = button.dataset.cardId;
  if (state.selectedCardIds.has(cardId)) {
    state.selectedCardIds.delete(cardId);
  } else if (state.selectedCardIds.size < 3) {
    state.selectedCardIds.add(cardId);
  }
  renderPrivateHand();
});
elements.openCreateRoom.forEach((button) => button.addEventListener("click", openCreateModal));
elements.closeCreate.addEventListener("click", closeCreateModal);
elements.closeJoin.addEventListener("click", closeJoinModal);
elements.openCodeJoin.addEventListener("click", () => openJoinModal(null, true));
elements.refreshRooms.addEventListener("click", () => {
  loadRooms()
    .then(() => setStatus("房间列表已刷新。", "ok"))
    .catch((error) => setStatus(error.message, "error"));
});
elements.createModal.addEventListener("click", (event) => {
  if (event.target === elements.createModal) closeCreateModal();
});
elements.joinModal.addEventListener("click", (event) => {
  if (event.target === elements.joinModal) closeJoinModal();
});
elements.copyRoomCode.addEventListener("click", async () => {
  try {
    await copyText(elements.copyRoomCode.dataset.roomCode || elements.createdCode.textContent);
    setStatus("房间码已复制。", "ok");
  } catch {
    setStatus("复制失败，请手动复制房间码。", "error");
  }
});
elements.createdClose?.addEventListener("click", () => { elements.createdRoom.hidden = true; });
elements.accountMenuToggle?.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleAccountMenu();
});
elements.accountMenu?.addEventListener("click", (event) => event.stopPropagation());
elements.localeButtons.forEach((button) => button.addEventListener("click", () => setLocale(button.dataset.barLocale)));
elements.login?.addEventListener("click", () => loginGuest().catch((error) => setStatus(error.message, "error")));
elements.avatarEdit?.addEventListener("click", openAvatarEditor);
elements.logout?.addEventListener("click", signOutAccount);
elements.avatarClose?.addEventListener("click", closeAvatarEditor);
elements.avatarInput?.addEventListener("change", (event) => prepareAvatar(event.target.files?.[0]).catch(() => {
  elements.avatarStatus.textContent = "无法读取这张图片。";
}));
elements.avatarForm?.addEventListener("submit", saveAvatar);
elements.avatarReset?.addEventListener("click", resetAvatar);
elements.avatarModal?.addEventListener("click", (event) => {
  if (event.target === elements.avatarModal) closeAvatarEditor();
});
elements.logToggle?.addEventListener("click", () => openHudDrawer("log"));
elements.logClose?.addEventListener("click", closeHudDrawers);
elements.toolsToggle?.addEventListener("click", () => openHudDrawer("tools"));
elements.toolsClose?.addEventListener("click", closeHudDrawers);
elements.drawerBackdrop?.addEventListener("click", closeHudDrawers);
elements.loadingFallback?.addEventListener("click", finishLoading);
document.addEventListener("click", () => toggleAccountMenu(false));
elements.copyPrompt.addEventListener("click", copyPrompt);
elements.copyPromptToolbar.addEventListener("click", copyPrompt);
elements.leaveRoom.addEventListener("click", () => {
  leaveCurrentRoom();
});
elements.testMode?.addEventListener("click", startTestMode);
elements.assistModeToggle?.addEventListener("click", toggleAssistMode);
elements.hostToggle?.addEventListener("click", openHostDrawer);
elements.hostClose?.addEventListener("click", closeHostDrawer);
elements.hostDrawerBackdrop?.addEventListener("click", closeHostDrawer);
elements.hostStartForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(elements.hostStartForm).entries());
  data.type = data.type || state.game?.type || state.session?.room?.gameType || "undercover";
  data.maxPlayers = Number(data.maxPlayers || 4);
  data.diceCount = Number(data.diceCount || 5);
  data.decisionTimeoutSeconds = Number(data.decisionTimeoutSeconds || 30);
  try {
    await postHostAction("/game/start", data);
    setHostStatus("游戏已启动。", "ok");
  } catch (error) {
    setHostStatus(error.message, "error");
  }
});
elements.hostGameType?.addEventListener("change", () => renderHostStartControls(elements.hostGameType.value));
elements.hostApplyTimeout?.addEventListener("click", async () => {
  try {
    await postHostAction("/game/decision-timeout", { decisionTimeoutSeconds: Number(elements.hostTimeoutSeconds?.value || 30) });
    setHostStatus("半自动倒计时已更新。", "ok");
  } catch (error) {
    setHostStatus(error.message, "error");
  }
});
elements.hostForceVote?.addEventListener("click", async () => {
  const gameType = state.game?.type || state.session?.room?.gameType;
  try { await postHostAction("/game/phase", { phase: gameType === "liar_dice" || gameType === "liar_deck" ? "revealed" : "voting" }); } catch (error) { setHostStatus(error.message, "error"); }
});
elements.hostSkipTurn?.addEventListener("click", async () => {
  try { await postHostAction("/game/skip"); } catch (error) { setHostStatus(error.message, "error"); }
});
elements.hostResetGame?.addEventListener("click", async () => {
  try { await postHostAction("/reset", { clearPlayers: false }); } catch (error) { setHostStatus(error.message, "error"); }
});
elements.hostClearRoom?.addEventListener("click", async () => {
  try { await postHostAction("/reset", { clearPlayers: true }); } catch (error) { setHostStatus(error.message, "error"); }
});
elements.hostCloseRoom?.addEventListener("click", async () => {
  try {
    await postHostAction("/close");
    closeHostDrawer();
  } catch (error) {
    setHostStatus(error.message, "error");
  }
});
elements.screenToggle.addEventListener("click", () => {
  const nextMode = elements.body.dataset.barScreen === "display" ? "control" : "display";
  elements.body.dataset.barScreen = nextMode;
  elements.screenToggle.textContent = nextMode === "display" ? "显示 HUD" : "沉浸模式";
  window.setTimeout(() => state.three?.resize(), 40);
});

async function copyPrompt() {
  try {
    await copyText(elements.prompt.value);
    setStatus("Prompt 已复制。", "ok");
  } catch {
    setStatus("复制失败，请手动选择文本。", "error");
  }
}

loadAccount().finally(() => {
  if (!restoreFromUrl()) showLobby();
  applyLocale();
});
window.setInterval(heartbeat, 60000);
