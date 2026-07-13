import * as THREE from "/assets/vendor/three.module.min.js";

const SEAT_COUNT = 16;
const TABLE_RADIUS = 2.35;
const SEAT_RADIUS = 3.35;
const RED = 0xeb583e;
const WHITE = 0xf4efe8;

export function init(container, options = {}) {
  if (!container || !supportsWebGL()) throw new Error("WebGL is not available");
  return new BarThreeScene(container, options);
}

function supportsWebGL() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(window.WebGLRenderingContext && (canvas.getContext("webgl2") || canvas.getContext("webgl")));
  } catch {
    return false;
  }
}

class BarThreeScene {
  constructor(container, options = {}) {
    this.container = container;
    this.options = options;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x020202, 0.043);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.setClearColor(0x020202, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.domElement.className = "bar-three-canvas";
    this.container.appendChild(this.renderer.domElement);

    this.clock = new THREE.Clock();
    this.elapsed = 0;
    this.seats = [];
    this.players = [];
    this.game = null;
    this.privateView = null;
    this.localPlayerId = "";
    this.highlightedPlayerId = "";
    this.cameraPreset = "overview";
    this.baseCameraTarget = new THREE.Vector3(0, 6.2, 5.8);
    this.baseLookTarget = new THREE.Vector3(0, 0.05, 0);
    this.cameraTarget = this.baseCameraTarget.clone();
    this.lookTarget = this.baseLookTarget.clone();
    this.currentLook = this.baseLookTarget.clone();
    this.camera.position.copy(this.baseCameraTarget);
    this.pointerTarget = new THREE.Vector2();
    this.pointerCurrent = new THREE.Vector2();
    this.raycaster = new THREE.Raycaster();
    this.interactiveObjects = [];
    this.hoveredCup = null;
    this.cupPinned = false;
    this.cupReveal = 0;
    this.cupRevealTarget = 0;
    this.shakeUntil = 0;
    this.gameSignature = "";
    this.cardMeshesById = new Map();
    this.selectedCardIds = new Set();
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.coarsePointer = window.matchMedia("(hover: none), (pointer: coarse)").matches;

    this.tableGroup = new THREE.Group();
    this.seatGroup = new THREE.Group();
    this.gameProps = new THREE.Group();
    this.scene.add(this.tableGroup, this.seatGroup, this.gameProps);

    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerLeave = this.handlePointerLeave.bind(this);
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handleContextLost = this.handleContextLost.bind(this);
    window.addEventListener("pointermove", this.handlePointerMove, { passive: true });
    this.renderer.domElement.addEventListener("pointerleave", this.handlePointerLeave);
    this.renderer.domElement.addEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.addEventListener("webglcontextlost", this.handleContextLost);

    this.options.onProgress?.(0.18, "点亮桌面");
    this.buildScene();
    this.options.onProgress?.(0.72, "安排座位");
    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.animate = this.animate.bind(this);
    this.animationFrame = window.requestAnimationFrame(this.animate);
    this.options.onProgress?.(1, "酒桌已就绪");
  }

  pixelRatio() {
    const mobile = window.innerWidth < 760 || window.matchMedia("(pointer: coarse)").matches;
    return Math.min(window.devicePixelRatio || 1, mobile ? 1.25 : 1.75);
  }

  buildScene() {
    const ambient = new THREE.HemisphereLight(0xfff4e9, 0x090403, 0.56);
    this.scene.add(ambient);

    const key = new THREE.DirectionalLight(0xfff4e9, 1.58);
    key.position.set(2.8, 5.8, 3.5);
    this.scene.add(key);

    this.speakerLight = new THREE.PointLight(RED, 0, 5.5, 2.2);
    this.speakerLight.position.set(0, 1.6, 0);
    this.scene.add(this.speakerLight);

    const tableLight = new THREE.PointLight(RED, 17, 9, 2.1);
    tableLight.position.set(0, 1.22, 0);
    this.scene.add(tableLight);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(7.3, 96),
      new THREE.MeshStandardMaterial({ color: 0x050403, roughness: 0.96, metalness: 0.02 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.2;
    this.scene.add(floor);

    const floorHalo = new THREE.Mesh(
      new THREE.RingGeometry(3.6, 6.9, 96),
      new THREE.MeshBasicMaterial({ color: 0x2b0c07, transparent: true, opacity: 0.15, side: THREE.DoubleSide })
    );
    floorHalo.rotation.x = -Math.PI / 2;
    floorHalo.position.y = -0.185;
    this.scene.add(floorHalo);

    this.buildTableCore();
    for (let index = 0; index < SEAT_COUNT; index += 1) this.seats.push(this.createSeat(index));

    const grid = new THREE.GridHelper(14, 28, 0x21110f, 0x0d0b0a);
    grid.position.y = -0.175;
    this.scene.add(grid);
  }

  buildTableCore() {
    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(0.82, 1.28, 1.08, 64),
      new THREE.MeshStandardMaterial({ color: 0x090806, roughness: 0.78, metalness: 0.3 })
    );
    pedestal.position.y = -0.63;
    this.tableGroup.add(pedestal);

    const table = new THREE.Mesh(
      new THREE.CylinderGeometry(TABLE_RADIUS, TABLE_RADIUS * 1.035, 0.3, 128),
      new THREE.MeshStandardMaterial({ color: 0x12100e, roughness: 0.56, metalness: 0.34 })
    );
    table.position.y = 0.05;
    this.tableGroup.add(table);

    const top = new THREE.Mesh(
      new THREE.CylinderGeometry(TABLE_RADIUS * 0.93, TABLE_RADIUS * 0.93, 0.04, 128),
      new THREE.MeshStandardMaterial({
        color: 0x070605,
        roughness: 0.48,
        metalness: 0.58,
        emissive: 0x160401,
        emissiveIntensity: 0.24
      })
    );
    top.position.y = 0.225;
    this.tableGroup.add(top);

    const rimMaterial = new THREE.MeshStandardMaterial({
      color: RED,
      emissive: RED,
      emissiveIntensity: 0.65,
      roughness: 0.28,
      metalness: 0.86
    });
    const rim = new THREE.Mesh(new THREE.TorusGeometry(TABLE_RADIUS * 1.02, 0.038, 14, 160), rimMaterial);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.245;
    this.tableGroup.add(rim);

    const innerRing = new THREE.Mesh(
      new THREE.TorusGeometry(TABLE_RADIUS * 0.47, 0.012, 8, 96),
      new THREE.MeshStandardMaterial({
        color: RED,
        emissive: RED,
        emissiveIntensity: 0.5,
        transparent: true,
        opacity: 0.62,
        roughness: 0.4,
        metalness: 0.7
      })
    );
    innerRing.rotation.x = Math.PI / 2;
    innerRing.position.y = 0.27;
    this.tableGroup.add(innerRing);

    const mark = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeTextTexture("AgentBar", "AGENT BAR", { width: 640, height: 240, accent: true }),
      transparent: true,
      depthWrite: false
    }));
    mark.scale.set(1.62, 0.62, 1);
    mark.position.set(0, 0.34, 0);
    this.tableGroup.add(mark);

    const glassMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x2a0d08,
      roughness: 0.12,
      metalness: 0.02,
      transmission: 0.18,
      transparent: true,
      opacity: 0.58
    });
    for (let index = 0; index < 6; index += 1) {
      const angle = (index / 6) * Math.PI * 2;
      const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.09, 0.25, 24), glassMaterial);
      glass.position.set(Math.cos(angle) * 1.72, 0.39, Math.sin(angle) * 1.72);
      this.tableGroup.add(glass);
    }
  }

  createSeat(index) {
    const angle = seatAngle(index);
    const position = new THREE.Vector3(Math.cos(angle) * SEAT_RADIUS, 0.08, Math.sin(angle) * SEAT_RADIUS);
    const group = new THREE.Group();
    group.position.copy(position);
    group.lookAt(0, 0.08, 0);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.32, 0.019, 8, 48),
      new THREE.MeshStandardMaterial({
        color: 0x2a1510,
        emissive: 0x170402,
        emissiveIntensity: 0.18,
        roughness: 0.48,
        metalness: 0.45
      })
    );
    ring.rotation.x = Math.PI / 2;
    group.add(ring);

    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(0.27, 0.31, 0.07, 40),
      new THREE.MeshStandardMaterial({ color: 0x080808, roughness: 0.65, metalness: 0.22 })
    );
    pad.position.y = -0.02;
    group.add(pad);

    const label = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeTextTexture(String(index + 1).padStart(2, "0"), "EMPTY", { muted: true }),
      transparent: true,
      depthWrite: false
    }));
    label.position.set(0, 0.88, 0);
    label.scale.set(1.76, 0.96, 1);
    group.add(label);

    this.seatGroup.add(group);
    return { index, angle, position, group, ring, pad, label, player: null, avatarRequest: "" };
  }

  setPlayers(players) {
    this.players = Array.isArray(players) ? players : [];
    for (const seat of this.seats) {
      const player = this.players.find((item) => Number(item.seatIndex) === seat.index) || null;
      seat.player = player;
      this.updateSeatLabel(seat, player);
      const active = player && player.id === this.highlightedPlayerId;
      const filled = Boolean(player);
      const eliminated = this.game?.players?.find((item) => item.id === player?.id)?.status === "eliminated";
      seat.ring.material.color.setHex(active ? RED : eliminated ? 0x5a1712 : filled ? 0x773020 : 0x2a1510);
      seat.ring.material.emissive.setHex(active ? RED : eliminated ? 0x7c1208 : filled ? 0x351109 : 0x170402);
      seat.ring.material.emissiveIntensity = active ? 1.2 : eliminated ? 0.78 : filled ? 0.42 : 0.18;
      seat.pad.material.color.setHex(active ? 0x1b0704 : eliminated ? 0x160403 : 0x080808);
    }
  }

  updateSeatLabel(seat, player) {
    const gamePlayer = this.game?.players?.find((item) => item.id === player?.id) || null;
    const claim = gamePlayer?.lastClaim?.count ? `叫 ${gamePlayer.lastClaim.count} 张 ${rankLabel(gamePlayer.lastClaim.rank)}` : "";
    const eliminated = gamePlayer?.status === "eliminated";
    const requestKey = player ? [player.avatarUrl, player.avatarLabel, player.agentName, player.status, claim, eliminated].join("|") : "empty";
    if (seat.avatarRequest === requestKey) return;
    seat.avatarRequest = requestKey;
    const apply = (texture) => {
      if (seat.avatarRequest !== requestKey) {
        texture.dispose();
        return;
      }
      if (seat.label.material.map) seat.label.material.map.dispose();
      seat.label.material.map = texture;
      seat.label.material.needsUpdate = true;
    };
    if (!player) {
      apply(makeTextTexture(String(seat.index + 1).padStart(2, "0"), "EMPTY", { muted: true }));
      return;
    }
    if (player.avatarUrl) {
      loadAvatarTexture(player.avatarUrl, player.agentName || player.ownerName || "", player.status === "online", { claim, eliminated })
        .then(apply)
        .catch(() => apply(makeTextTexture(player.avatarLabel || "A", player.agentName || player.ownerName || "", {
          online: player.status === "online",
          active: player.id === this.highlightedPlayerId,
          claim,
          eliminated
        })));
      return;
    }
    apply(makeTextTexture(player.avatarLabel || "A", player.agentName || player.ownerName || "", {
      online: player.status === "online",
      active: player.id === this.highlightedPlayerId,
      claim,
      eliminated
    }));
  }

  setGameState(game, privateView, localPlayerId) {
    this.game = game || null;
    this.privateView = privateView || null;
    this.localPlayerId = localPlayerId || "";
    this.setPlayers(this.players);
    const privateGame = privateView?.private || {};
    const signature = JSON.stringify({
      id: game?.id,
      type: game?.type,
      phase: game?.phase,
      round: game?.round,
      lastPlay: game?.lastPlay?.id,
      reveal: game?.lastReveal?.createdAt || game?.revealedAt,
      hand: privateGame.hand?.map((card) => card.id),
      dice: privateGame.dice
    });
    if (signature === this.gameSignature) return;
    const previousRound = this.gameSignature && this.game?.round;
    this.gameSignature = signature;
    this.clearGameProps();
    if (game?.type === "liar_dice") this.buildDiceGame(game, privateGame.dice || []);
    if (game?.type === "liar_deck") this.buildCardGame(game, privateGame.hand || []);
    if (game && !previousRound) this.shakeUntil = this.elapsed + 1.05;
  }

  clearGameProps() {
    this.interactiveObjects = [];
    this.hoveredCup = null;
    this.cupPinned = false;
    this.cupReveal = 0;
    this.cupRevealTarget = 0;
    this.cardMeshesById.clear();
    disposeObject(this.gameProps);
    this.scene.remove(this.gameProps);
    this.gameProps = new THREE.Group();
    this.scene.add(this.gameProps);
  }

  buildDiceGame(game, privateDice) {
    const player = this.players.find((item) => item.id === this.localPlayerId);
    if (!player) return;
    const angle = seatAngle(player.seatIndex);
    // Keep the private cup near the table center so it remains visible above the action HUD.
    const inwardRadius = 1.68;
    const propGroup = new THREE.Group();
    propGroup.position.set(Math.cos(angle) * inwardRadius, 0.31, Math.sin(angle) * inwardRadius);
    propGroup.rotation.y = -angle + Math.PI / 2;
    this.gameProps.add(propGroup);
    this.dicePropGroup = propGroup;

    this.diceGroup = new THREE.Group();
    privateDice.forEach((value, index) => {
      const die = createDie(Number(value || 1));
      const column = index - (privateDice.length - 1) / 2;
      die.position.set(column * 0.25, 0.13, (index % 2 ? 0.08 : -0.08));
      die.rotation.set(index * 0.37, index * 0.62, index * 0.21);
      this.diceGroup.add(die);
    });
    propGroup.add(this.diceGroup);

    this.cupGroup = new THREE.Group();
    this.cupGroup.scale.setScalar(0.58);
    const cup = new THREE.Mesh(
      new THREE.CylinderGeometry(0.43, 0.54, 0.72, 48, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0x2b0b07,
        roughness: 0.48,
        metalness: 0.18,
        side: THREE.DoubleSide,
        emissive: 0x160301,
        emissiveIntensity: 0.22
      })
    );
    cup.position.y = 0.36;
    cup.userData.barDiceCup = true;
    this.cupGroup.add(cup);
    const top = new THREE.Mesh(
      new THREE.CircleGeometry(0.43, 48),
      new THREE.MeshStandardMaterial({ color: 0x160706, roughness: 0.52, metalness: 0.12 })
    );
    top.rotation.x = -Math.PI / 2;
    top.position.y = 0.72;
    top.userData.barDiceCup = true;
    this.cupGroup.add(top);
    const band = new THREE.Mesh(
      new THREE.TorusGeometry(0.49, 0.025, 8, 48),
      new THREE.MeshStandardMaterial({ color: RED, emissive: RED, emissiveIntensity: 0.38, metalness: 0.7 })
    );
    band.rotation.x = Math.PI / 2;
    band.position.y = 0.11;
    band.userData.barDiceCup = true;
    this.cupGroup.add(band);
    propGroup.add(this.cupGroup);
    this.interactiveObjects.push(cup, top, band);

    if (game.diceRevealed) {
      this.cupPinned = true;
      this.cupRevealTarget = 1;
    }
    this.shakeUntil = this.elapsed + 1.15;
  }

  buildCardGame(game, hand) {
    const player = this.players.find((item) => item.id === this.localPlayerId);
    if (player && hand.length) {
      const angle = seatAngle(player.seatIndex);
      const radial = 2.72;
      const handGroup = new THREE.Group();
      handGroup.position.set(Math.cos(angle) * radial, 0.32, Math.sin(angle) * radial);
      handGroup.rotation.y = -angle + Math.PI / 2;
      this.gameProps.add(handGroup);
      hand.slice(0, 7).forEach((card, index) => {
        const mesh = createCardMesh(card.rank);
        const offset = index - (Math.min(hand.length, 7) - 1) / 2;
        mesh.position.set(offset * 0.21, 0.03 + Math.abs(offset) * 0.008, -Math.abs(offset) * 0.035);
        mesh.rotation.x = -Math.PI / 2;
        mesh.rotation.z = -offset * 0.075;
        mesh.userData.cardId = card.id;
        handGroup.add(mesh);
        this.cardMeshesById.set(card.id, mesh);
      });
    }

    const playCount = Number(game?.lastPlay?.count || 0);
    for (let index = 0; index < Math.min(playCount, 3); index += 1) {
      const mesh = createCardMesh(null);
      mesh.position.set((index - (playCount - 1) / 2) * 0.18, 0.31 + index * 0.012, 0.05 * index);
      mesh.rotation.set(-Math.PI / 2, 0, (index - 1) * 0.11);
      this.gameProps.add(mesh);
    }

    if (game?.lastReveal?.cards?.length) {
      game.lastReveal.cards.slice(0, 3).forEach((card, index) => {
        const mesh = createCardMesh(card.rank);
        mesh.position.set((index - 1) * 0.38, 0.38, -0.1);
        mesh.rotation.x = -Math.PI / 2;
        mesh.rotation.z = (index - 1) * 0.08;
        this.gameProps.add(mesh);
      });
    }
  }

  setSelectedCardIds(ids) {
    this.selectedCardIds = new Set(ids || []);
    for (const [id, mesh] of this.cardMeshesById) {
      const selected = this.selectedCardIds.has(id);
      mesh.position.y = selected ? 0.18 : 0.03;
      mesh.material.emissive?.setHex(selected ? RED : 0x000000);
      if (mesh.material.emissiveIntensity !== undefined) mesh.material.emissiveIntensity = selected ? 0.35 : 0;
    }
  }

  setCameraPreset(name, playerId = "") {
    const preset = name || "overview";
    this.cameraPreset = preset;
    if (preset === "seatDecision") {
      const seat = this.seats.find((item) => item.player?.id === playerId);
      if (seat) {
        const radial = new THREE.Vector3(Math.cos(seat.angle), 0, Math.sin(seat.angle));
        this.baseCameraTarget.copy(seat.position).addScaledVector(radial, 1.08);
        this.baseCameraTarget.y = 1.46;
        this.baseLookTarget.copy(seat.position).addScaledVector(radial, -2.36);
        this.baseLookTarget.y = 0.25;
        return;
      }
    }
    if (preset === "speaker") {
      const seat = this.seats.find((item) => item.player?.id === playerId);
      if (seat) {
        const radial = new THREE.Vector3(Math.cos(seat.angle), 0, Math.sin(seat.angle));
        this.baseCameraTarget.copy(seat.position).addScaledVector(radial, 1.34);
        this.baseCameraTarget.y = 1.95;
        this.baseLookTarget.copy(seat.position).addScaledVector(radial, -0.35);
        this.baseLookTarget.y = 0.42;
        return;
      }
    }
    if (preset === "reveal") {
      this.baseCameraTarget.set(0, 3.35, 3.55);
      this.baseLookTarget.set(0, 0.25, 0);
      return;
    }
    if (preset === "settlement") {
      this.baseCameraTarget.set(0, 7.35, 7.2);
      this.baseLookTarget.set(0, 0.1, 0);
      return;
    }
    this.baseCameraTarget.set(0, 6.2, 5.8);
    this.baseLookTarget.set(0, 0.05, 0);
  }

  focusPlayer(playerId) {
    this.highlightedPlayerId = playerId;
    this.setPlayers(this.players);
    this.setCameraPreset("speaker", playerId);
    const seat = this.seats.find((item) => item.player?.id === playerId);
    if (seat) this.speakerLight.position.copy(seat.position).add(new THREE.Vector3(0, 1.4, 0));
  }

  overview() {
    this.highlightedPlayerId = "";
    this.setPlayers(this.players);
    this.setCameraPreset("overview");
  }

  handlePointerMove(event) {
    if (this.reducedMotion || this.coarsePointer) return;
    this.pointerTarget.x = THREE.MathUtils.clamp((event.clientX / window.innerWidth) * 2 - 1, -1, 1);
    this.pointerTarget.y = THREE.MathUtils.clamp(-((event.clientY / window.innerHeight) * 2 - 1), -1, 1);
    this.updateCupHover(event.clientX, event.clientY);
  }

  handlePointerLeave() {
    this.pointerTarget.set(0, 0);
    this.hoveredCup = null;
    if (!this.cupPinned) this.cupRevealTarget = 0;
    this.renderer.domElement.style.cursor = "";
  }

  handlePointerDown(event) {
    if (!this.coarsePointer || !this.cupGroup) return;
    this.updateCupHover(event.clientX, event.clientY);
    if (this.hoveredCup) {
      this.cupPinned = !this.cupPinned;
      this.cupRevealTarget = this.cupPinned ? 1 : 0;
    }
  }

  updateCupHover(clientX, clientY) {
    if (!this.interactiveObjects.length) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.interactiveObjects, true)[0] || null;
    this.hoveredCup = hit?.object?.userData?.barDiceCup ? hit.object : null;
    if (!this.coarsePointer && !this.cupPinned) this.cupRevealTarget = this.hoveredCup ? 1 : 0;
    this.renderer.domElement.style.cursor = this.hoveredCup ? "pointer" : "";
  }

  handleContextLost(event) {
    event.preventDefault();
    document.body.classList.add("bar-three-fallback");
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(width, height, false);
  }

  animate() {
    const delta = Math.min(this.clock.getDelta(), 0.04);
    this.elapsed += delta;

    const pointerPositionAlpha = 1 - Math.exp(-3 * delta);
    const pointerFocusAlpha = 1 - Math.exp(-4.5 * delta);
    this.pointerCurrent.x = THREE.MathUtils.lerp(this.pointerCurrent.x, this.pointerTarget.x, pointerPositionAlpha);
    this.pointerCurrent.y = THREE.MathUtils.lerp(this.pointerCurrent.y, this.pointerTarget.y, pointerFocusAlpha);

    this.cameraTarget.copy(this.baseCameraTarget);
    this.lookTarget.copy(this.baseLookTarget);
    if (!this.reducedMotion && !this.coarsePointer) {
      const right = new THREE.Vector3().subVectors(this.baseLookTarget, this.baseCameraTarget).normalize();
      right.cross(this.camera.up).normalize();
      this.cameraTarget.addScaledVector(right, this.pointerCurrent.x * 0.12);
      this.cameraTarget.y += this.pointerCurrent.y * 0.07;
      this.lookTarget.addScaledVector(right, this.pointerCurrent.x * 0.18);
      this.lookTarget.y += this.pointerCurrent.y * 0.09;
    }

    const cameraAlpha = 1 - Math.exp(-5.7 * delta);
    const lookAlpha = 1 - Math.exp(-6.6 * delta);
    this.camera.position.lerp(this.cameraTarget, cameraAlpha);
    this.currentLook.lerp(this.lookTarget, lookAlpha);
    this.camera.lookAt(this.currentLook);

    this.speakerLight.intensity = THREE.MathUtils.lerp(
      this.speakerLight.intensity,
      this.highlightedPlayerId ? 10 + Math.sin(this.elapsed * 5.2) * 1.5 : 0,
      1 - Math.exp(-4 * delta)
    );

    this.updateDiceAnimation(delta);
    this.renderer.render(this.scene, this.camera);
    this.animationFrame = window.requestAnimationFrame(this.animate);
  }

  updateDiceAnimation(delta) {
    if (!this.cupGroup) return;
    const revealAlpha = 1 - Math.exp(-9 * delta);
    this.cupReveal = THREE.MathUtils.lerp(this.cupReveal, this.cupRevealTarget, revealAlpha);
    const shaking = this.elapsed < this.shakeUntil && !this.reducedMotion;
    const shake = shaking ? Math.max(0, (this.shakeUntil - this.elapsed) / 1.15) : 0;
    this.cupGroup.position.x = Math.sin(this.elapsed * 42) * 0.06 * shake;
    this.cupGroup.position.z = Math.cos(this.elapsed * 38) * 0.045 * shake;
    this.cupGroup.position.y = this.cupReveal * 0.2 + Math.sin(this.elapsed * 49) * 0.025 * shake;
    this.cupGroup.rotation.z = this.cupReveal * -0.32 + Math.sin(this.elapsed * 36) * 0.08 * shake;
    this.cupGroup.rotation.x = this.cupReveal * 0.1;
    if (this.diceGroup && shaking) {
      this.diceGroup.rotation.y += delta * 8;
      this.diceGroup.rotation.x += delta * 4;
    }
  }

  destroy() {
    if (this.animationFrame) window.cancelAnimationFrame(this.animationFrame);
    this.resizeObserver?.disconnect();
    window.removeEventListener("pointermove", this.handlePointerMove);
    this.renderer.domElement.removeEventListener("pointerleave", this.handlePointerLeave);
    this.renderer.domElement.removeEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.removeEventListener("webglcontextlost", this.handleContextLost);
    disposeObject(this.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function seatAngle(index) {
  return (Number(index || 0) / SEAT_COUNT) * Math.PI * 2 - Math.PI / 2;
}

function createCardMesh(rank) {
  const texture = makeCardTexture(rank);
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    color: 0xffffff,
    roughness: 0.72,
    metalness: 0.02,
    emissive: 0x000000,
    emissiveIntensity: 0,
    side: THREE.DoubleSide
  });
  return new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.015, 0.52), material);
}

function makeCardTexture(rank) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 384;
  const context = canvas.getContext("2d");
  const gradient = context.createLinearGradient(0, 0, 256, 384);
  gradient.addColorStop(0, rank ? "#f4efe8" : "#2a0d08");
  gradient.addColorStop(1, rank ? "#d9d1c5" : "#080706");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 384);
  context.strokeStyle = rank ? "#eb583e" : "rgba(235,88,62,.75)";
  context.lineWidth = 10;
  context.strokeRect(14, 14, 228, 356);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = rank ? "#15100e" : "#eb583e";
  context.font = "900 82px Arial";
  context.fillText(rankLabel(rank), 128, 190);
  context.font = "700 22px monospace";
  context.fillText("AgentBar", 128, 318);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createDie(value) {
  const materials = [1, 6, 2, 5, 3, 4].map((face) => new THREE.MeshStandardMaterial({
    map: makeDieTexture(face),
    color: 0xffffff,
    roughness: 0.7,
    metalness: 0.02
  }));
  const die = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.21, 0.21), materials);
  die.userData.value = value;
  const rotations = [
    [0, 0, 0],
    [0, 0, -Math.PI / 2],
    [Math.PI / 2, 0, 0],
    [-Math.PI / 2, 0, 0],
    [0, 0, Math.PI / 2],
    [Math.PI, 0, 0]
  ];
  die.rotation.set(...rotations[Math.max(0, Math.min(5, value - 1))]);
  return die;
}

function makeDieTexture(face) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  context.fillStyle = "#f3eee6";
  context.fillRect(0, 0, 128, 128);
  context.strokeStyle = "#d7cec2";
  context.lineWidth = 5;
  context.strokeRect(3, 3, 122, 122);
  context.fillStyle = face === 1 ? "#eb583e" : "#171311";
  const dots = {
    1: [[64,64]],
    2: [[36,36],[92,92]],
    3: [[34,34],[64,64],[94,94]],
    4: [[36,36],[92,36],[36,92],[92,92]],
    5: [[34,34],[94,34],[64,64],[34,94],[94,94]],
    6: [[36,30],[92,30],[36,64],[92,64],[36,98],[92,98]]
  }[face] || [];
  for (const [x, y] of dots) {
    context.beginPath();
    context.arc(x, y, 10, 0, Math.PI * 2);
    context.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function rankLabel(rank) {
  if (rank === "King") return "K";
  if (rank === "Queen") return "Q";
  if (rank === "Ace") return "A";
  if (rank === "Joker") return "J";
  return rank || "◆";
}

async function loadAvatarTexture(url, label, online, options = {}) {
  const image = new Image();
  image.crossOrigin = "anonymous";
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = reject;
    image.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 344;
  const context = canvas.getContext("2d");
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  const sx = (image.naturalWidth - side) / 2;
  const sy = (image.naturalHeight - side) / 2;
  context.save();
  context.beginPath();
  context.arc(320, 106, 84, 0, Math.PI * 2);
  context.clip();
  context.drawImage(image, sx, sy, side, side, 236, 22, 168, 168);
  context.restore();
  context.strokeStyle = online ? "#eb583e" : "rgba(255,255,255,.42)";
  context.lineWidth = 6;
  context.beginPath();
  context.arc(320, 106, 87, 0, Math.PI * 2);
  context.stroke();
  context.fillStyle = online ? "rgba(255,255,255,.92)" : "rgba(255,255,255,.62)";
  context.font = "36px monospace";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(truncateText(label, 12), 320, 232);
  drawSeatAnnotations(context, canvas, options);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeTextTexture(primary, secondary, options = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = options.width || 512;
  canvas.height = options.height || 280;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.shadowColor = "rgba(0,0,0,.86)";
  context.shadowBlur = 18;

  if (options.muted) {
    context.strokeStyle = "rgba(255,255,255,.2)";
    context.lineWidth = 3;
    roundedRect(context, 96, 42, canvas.width - 192, 132, 64);
    context.stroke();
    context.fillStyle = "rgba(255,255,255,.42)";
  } else {
    const gradient = context.createRadialGradient(canvas.width / 2, 82, 12, canvas.width / 2, 88, 104);
    gradient.addColorStop(0, "rgba(255,255,255,.2)");
    gradient.addColorStop(.45, "rgba(235,88,62,.9)");
    gradient.addColorStop(1, "rgba(45,10,5,.96)");
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(canvas.width / 2, 88, 68, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = options.active ? "rgba(255,255,255,.94)" : "rgba(235,88,62,.84)";
    context.lineWidth = options.active ? 7 : 4;
    context.stroke();
    context.fillStyle = "#fff";
  }

  context.font = `${options.accent ? 64 : 62}px Arial Black, sans-serif`;
  context.fillText(String(primary || "A").slice(0, options.accent ? 12 : 2), canvas.width / 2, options.accent ? 78 : 88);

  if (secondary) {
    context.shadowBlur = 10;
    context.fillStyle = options.online ? "rgba(255,255,255,.92)" : "rgba(255,255,255,.66)";
    context.font = "28px monospace";
    context.fillText(truncateText(secondary, 12), canvas.width / 2, 192);
  } else if (options.muted) {
    context.font = "24px monospace";
    context.fillText(String(primary || ""), canvas.width / 2, 102);
  }

  drawSeatAnnotations(context, canvas, options);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function drawSeatAnnotations(context, canvas, options = {}) {
  if (options.claim) {
    context.shadowBlur = 10;
    context.fillStyle = "rgba(255,235,225,.94)";
    context.font = "700 24px monospace";
    context.fillText(truncateText(options.claim, 14), canvas.width / 2, canvas.height > 300 ? 292 : 240);
  }
  if (options.eliminated) {
    context.shadowBlur = 16;
    context.fillStyle = "#ff5d43";
    context.font = "900 92px Arial Black, sans-serif";
    context.fillText("×", canvas.width / 2, 112);
  }
}

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

function truncateText(value, maxLength) {
  const chars = [...String(value || "")];
  return chars.length > maxLength ? `${chars.slice(0, maxLength - 1).join("")}…` : chars.join("");
}

function disposeObject(object) {
  object.traverse?.((child) => {
    child.geometry?.dispose?.();
    const materials = child.material ? (Array.isArray(child.material) ? child.material : [child.material]) : [];
    for (const material of materials) {
      material.map?.dispose?.();
      material.dispose?.();
    }
  });
}
