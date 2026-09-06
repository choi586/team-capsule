import QRCode from "qrcode";
import "./styles.css";
import {
  MAX_PARTICIPANTS,
  ROOM_PHASES,
  buildAssignments,
  canonicalName,
  drawStepDuration,
  groupAssignments,
  groupSizes,
  normalizeName,
  resultText,
  validateName,
} from "./domain.js";
import {
  createJoinHash,
  createRoomCredentials,
  importRoomKey,
  importSigningPrivateKey,
  importSigningPublicKey,
  openMessage,
  parseJoinHash,
  randomToken,
  sealMessage,
  signPayload,
  verifyPayload,
} from "./crypto.js";
import { RoomRelay, roomTopic } from "./relay.js";

const PROTOCOL_VERSION = 1;
const ADMIN_STORAGE_KEY = "joy-team-admin-session-v1";
const SESSION_LIFETIME = 12 * 60 * 60 * 1_000;
const MAX_ENVELOPE_SIZE = 4_096;
const TEAM_COLORS = [
  "#ff6654",
  "#58d5bd",
  "#ffcf4a",
  "#6978ef",
  "#f293bb",
  "#68b7ec",
  "#9ed45b",
  "#f29b52",
  "#b58ce7",
  "#55c6d0",
];

const app = document.querySelector("#app");
const reducedMotion = globalThis.matchMedia("(prefers-reduced-motion: reduce)");

function createMessage(type, roomId, senderId, data = {}, messageId = randomToken(9)) {
  return {
    v: PROTOCOL_VERSION,
    t: type,
    r: roomId,
    s: senderId,
    m: messageId,
    x: Date.now(),
    d: data,
  };
}

function validMessage(body, roomId) {
  return Boolean(
    body &&
      body.v === PROTOCOL_VERSION &&
      body.r === roomId &&
      typeof body.t === "string" &&
      typeof body.s === "string" &&
      /^[A-Za-z0-9_-]{5,48}$/u.test(body.s) &&
      typeof body.m === "string" &&
      /^[A-Za-z0-9_-]{8,32}$/u.test(body.m) &&
      Number.isFinite(body.x) &&
      Math.abs(Date.now() - body.x) < SESSION_LIFETIME,
  );
}

function packState(state) {
  return {
    v: state.revision,
    p: state.phase,
    g: state.groupCount,
    n: state.participants.map((person) => [person.clientId, person.name]),
    a: state.revealed.map((assignment) => [
      assignment.clientId,
      assignment.group,
      assignment.order,
    ]),
    z: state.totalAssignments,
    q: state.roundId,
  };
}

function unpackState(value) {
  if (!value || typeof value !== "object") return null;
  if (!Number.isInteger(value.v) || value.v < 0) return null;
  if (!Object.values(ROOM_PHASES).includes(value.p)) return null;
  if (!Number.isInteger(value.g) || value.g < 2 || value.g > MAX_PARTICIPANTS) return null;
  if (!Array.isArray(value.n) || value.n.length > MAX_PARTICIPANTS) return null;
  if (!Array.isArray(value.a) || value.a.length > value.n.length) return null;

  const participants = [];
  const identifiers = new Set();
  for (const entry of value.n) {
    if (!Array.isArray(entry) || entry.length < 2) return null;
    const [clientId, rawName] = entry;
    if (typeof clientId !== "string" || !/^[A-Za-z0-9_-]{5,48}$/u.test(clientId)) {
      return null;
    }
    const checkedName = validateName(rawName);
    if (!checkedName.ok || identifiers.has(clientId)) return null;
    identifiers.add(clientId);
    participants.push({ clientId, name: checkedName.name });
  }

  const revealed = [];
  const assigned = new Set();
  for (const entry of value.a) {
    if (!Array.isArray(entry) || entry.length < 3) return null;
    const [clientId, group, order] = entry;
    if (
      !identifiers.has(clientId) ||
      assigned.has(clientId) ||
      !Number.isInteger(group) ||
      group < 1 ||
      group > value.g ||
      !Number.isInteger(order) ||
      order < 0
    ) {
      return null;
    }
    assigned.add(clientId);
    const person = participants.find((candidate) => candidate.clientId === clientId);
    revealed.push({ clientId, name: person.name, group, order });
  }

  const totalAssignments = Number.isInteger(value.z)
    ? Math.max(0, Math.min(value.n.length, value.z))
    : value.n.length;
  return {
    revision: value.v,
    phase: value.p,
    groupCount: value.g,
    participants,
    revealed,
    totalAssignments,
    roundId: typeof value.q === "string" ? value.q : "",
  };
}

function publicBaseUrl() {
  const url = new URL(globalThis.location.href);
  url.hash = "";
  url.search = "";
  return url.href;
}

function wait(milliseconds) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

function setConnectionStatus(root, status) {
  const pill = root.querySelector("[data-connection]");
  if (!pill) return;
  const text = pill.querySelector("[data-connection-text]");
  const labels = {
    connecting: "연결 중",
    online: "연결됨",
    offline: "다시 연결 중",
  };
  pill.dataset.status = status;
  text.textContent = labels[status] ?? labels.connecting;
}

function toast(message, kind = "info") {
  const region = document.querySelector("#toast-region");
  const element = document.createElement("div");
  element.className = "toast";
  element.dataset.kind = kind;
  element.textContent = message;
  region.append(element);
  globalThis.setTimeout(() => element.remove(), 3_200);
}

function confirmAction({ title, message, confirmLabel = "확인", danger = false }) {
  const dialog = document.querySelector("#confirm-dialog");
  const heading = dialog.querySelector("#dialog-title");
  const copy = dialog.querySelector("#dialog-message");
  const confirmButton = dialog.querySelector("#dialog-confirm");
  heading.textContent = title;
  copy.textContent = message;
  confirmButton.textContent = confirmLabel;
  confirmButton.className = `button ${danger ? "button-primary" : "button-yellow"}`;
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), {
      once: true,
    });
  });
}

async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  toast(successMessage);
}

function downloadText(filename, content, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  globalThis.setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
}

function showConfetti() {
  if (reducedMotion.matches) return;
  document.querySelector(".confetti-layer")?.remove();
  const layer = document.createElement("div");
  layer.className = "confetti-layer";
  layer.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 54; index += 1) {
    const piece = document.createElement("i");
    piece.className = "confetti-piece";
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.setProperty("--confetti", TEAM_COLORS[index % TEAM_COLORS.length]);
    piece.style.setProperty("--delay", `${Math.random() * 0.65}s`);
    piece.style.setProperty("--duration", `${1.8 + Math.random() * 1.3}s`);
    piece.style.setProperty("--drift", `${-80 + Math.random() * 160}px`);
    piece.style.setProperty("--spin", `${360 + Math.random() * 720}deg`);
    layer.append(piece);
  }
  document.body.append(layer);
  globalThis.setTimeout(() => layer.remove(), 3_500);
}

function renderGroups(container, state, lastClientId = "") {
  container.replaceChildren();
  const groups = groupAssignments(state.revealed, state.groupCount);
  for (const group of groups) {
    const card = document.createElement("article");
    card.className = "team-card";
    card.style.setProperty("--team-color", TEAM_COLORS[(group.number - 1) % TEAM_COLORS.length]);
    if (group.members.some((member) => member.clientId === lastClientId)) {
      card.classList.add("is-hit");
    }

    const head = document.createElement("div");
    head.className = "team-head";
    const title = document.createElement("div");
    title.className = "team-number";
    const dot = document.createElement("span");
    dot.className = "team-dot";
    dot.setAttribute("aria-hidden", "true");
    const titleText = document.createElement("span");
    titleText.textContent = `${group.number}조`;
    title.append(dot, titleText);
    const size = document.createElement("span");
    size.className = "team-size";
    size.textContent = `${group.members.length}명`;
    head.append(title, size);

    const members = document.createElement("div");
    members.className = "team-members";
    if (!group.members.length) {
      const empty = document.createElement("span");
      empty.className = "team-empty";
      empty.textContent = "아직 두근두근 대기 중";
      members.append(empty);
    } else {
      for (const member of group.members) {
        const chip = document.createElement("span");
        chip.className = "member-chip";
        chip.dataset.clientId = member.clientId;
        chip.textContent = member.name;
        if (member.clientId === lastClientId) chip.classList.add("is-new");
        members.append(chip);
      }
    }
    card.append(head, members);
    container.append(card);
  }
}

function updateStage(root, state, assignment = null, mixing = false) {
  const name = root.querySelector("[data-current-name]");
  const destination = root.querySelector("[data-destination]");
  const progress = root.querySelector("[data-progress]");
  const progressText = root.querySelector("[data-progress-text]");
  const total = Math.max(state.totalAssignments || state.participants.length, 1);
  const count = state.revealed.length;

  if (state.phase === ROOM_PHASES.COMPLETE) {
    name.textContent = "조 편성 완료!";
    destination.textContent = `${state.groupCount}개 조 완성`;
  } else if (assignment) {
    name.textContent = assignment.name;
    destination.textContent = mixing ? "어느 조일까요?" : `${assignment.group}조로 쏙!`;
  } else {
    name.textContent = "준비 중…";
    destination.textContent = "곧 시작해요";
  }
  name.classList.toggle("is-mixing", mixing && !reducedMotion.matches);
  progress.style.width = `${Math.min(100, (count / total) * 100)}%`;
  progressText.textContent = `${count} / ${state.totalAssignments || state.participants.length}`;
}

function animateFlyingName(root, assignment) {
  if (reducedMotion.matches) return;
  const source = root.querySelector("[data-current-name]");
  const target = root.querySelector(`[data-client-id="${assignment.clientId}"]`);
  if (!source || !target) return;
  const start = source.getBoundingClientRect();
  const end = target.getBoundingClientRect();
  const flyer = document.createElement("div");
  flyer.className = "member-chip";
  flyer.textContent = assignment.name;
  Object.assign(flyer.style, {
    position: "fixed",
    zIndex: "90",
    left: `${start.left + start.width / 2}px`,
    top: `${start.top + start.height / 2}px`,
    margin: "0",
    pointerEvents: "none",
    background: "#fff",
  });
  document.body.append(flyer);
  const deltaX = end.left + end.width / 2 - (start.left + start.width / 2);
  const deltaY = end.top + end.height / 2 - (start.top + start.height / 2);
  flyer
    .animate(
      [
        { transform: "translate(-50%, -50%) scale(1.15) rotate(0deg)", opacity: 1 },
        {
          transform: `translate(calc(-50% + ${deltaX * 0.55}px), calc(-50% + ${deltaY * 0.25 - 42}px)) scale(1.1) rotate(-5deg)`,
          opacity: 1,
          offset: 0.55,
        },
        {
          transform: `translate(calc(-50% + ${deltaX}px), calc(-50% + ${deltaY}px)) scale(.62) rotate(8deg)`,
          opacity: 0.1,
        },
      ],
      { duration: 520, easing: "cubic-bezier(.2,.8,.2,1)" },
    )
    .finished.finally(() => flyer.remove());
}

function csvForAssignments(assignments) {
  const rows = [["조", "이름"]];
  const sorted = [...assignments].sort((a, b) => a.group - b.group || a.name.localeCompare(b.name, "ko"));
  for (const assignment of sorted) rows.push([`${assignment.group}조`, assignment.name]);
  return `\uFEFF${rows
    .map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))
    .join("\r\n")}`;
}

function newRoomState() {
  return {
    revision: 0,
    phase: ROOM_PHASES.OPEN,
    groupCount: 4,
    participants: [],
    revealed: [],
    totalAssignments: 0,
    roundId: "",
  };
}

function validSavedSession(session) {
  const hasShape = Boolean(
    session &&
      session.credentials?.roomId &&
      session.credentials?.roomKey &&
      session.credentials?.signingPrivateJwk &&
      session.credentials?.signingPublicKey &&
      Number.isFinite(session.createdAt) &&
      Date.now() - session.createdAt < SESSION_LIFETIME &&
      session.state &&
      Array.isArray(session.state.participants) &&
      Array.isArray(session.state.revealed) &&
      Array.isArray(session.fullAssignments),
  );
  if (!hasShape) return false;
  try {
    if (!parseJoinHash(createJoinHash(session.credentials))) return false;
    const restored = unpackState(packState(session.state));
    if (!restored || session.fullAssignments.length > MAX_PARTICIPANTS) return false;
    const participantIds = new Set(restored.participants.map((person) => person.clientId));
    for (const assignment of session.fullAssignments) {
      if (
        !participantIds.has(assignment.clientId) ||
        !Number.isInteger(assignment.group) ||
        assignment.group < 1 ||
        assignment.group > restored.groupCount ||
        !Number.isInteger(assignment.order)
      ) {
        return false;
      }
    }
    if (
      restored.phase !== ROOM_PHASES.OPEN &&
      session.fullAssignments.length !== restored.totalAssignments
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

class AdminApp {
  constructor(session) {
    this.credentials = session.credentials;
    this.createdAt = session.createdAt;
    this.state = session.state;
    this.fullAssignments = session.fullAssignments;
    this.relay = new RoomRelay(roomTopic(this.credentials.roomId));
    this.roomKey = null;
    this.privateKey = null;
    this.broadcastTimer = null;
    this.isDrawing = false;
    this.skipRequested = false;
    this.fastMode = false;
    this.soundEnabled = false;
    this.audioContext = null;
    this.lastRenderedId = "";
  }

  async init() {
    [this.roomKey, this.privateKey] = await Promise.all([
      importRoomKey(this.credentials.roomKey),
      importSigningPrivateKey(this.credentials.signingPrivateJwk),
    ]);
    this.renderShell();
    this.bindEvents();
    this.render();
    await this.renderQr();

    this.relay.addEventListener("status", (event) => {
      setConnectionStatus(app, event.detail);
      if (event.detail === "online") {
        this.sendState().catch(() => {
          setConnectionStatus(app, "offline");
        });
      }
    });
    this.relay.addEventListener("message", (event) => this.handleRelayMessage(event.detail));
    this.relay.connect().catch(() => {
      setConnectionStatus(app, "offline");
      toast("연결이 늦어지고 있어요. 자동으로 다시 시도합니다.", "error");
    });

    if (
      this.state.phase === ROOM_PHASES.DRAWING &&
      this.fullAssignments.length === this.state.totalAssignments
    ) {
      globalThis.setTimeout(() => this.runDraw(), 700);
    }
  }

  renderShell() {
    app.innerHTML = `
      <div class="app-shell admin-shell">
        <header class="topbar">
          <div class="brand" aria-label="조이!">
            <span class="brand-mark" aria-hidden="true">JOY!</span>
            <span class="brand-word">조이! 랜덤 조 편성</span>
          </div>
          <div class="topbar-actions">
            <span class="role-pill">관리자 화면</span>
            <span class="connection-pill" data-connection data-status="connecting">
              <span class="connection-dot" aria-hidden="true"></span>
              <span data-connection-text>연결 중</span>
            </span>
            <button class="button button-small button-ghost" id="new-room-button" type="button">새 방</button>
          </div>
        </header>

        <main id="main-content">
          <section class="intro" id="admin-intro">
            <div>
              <p class="eyebrow">LIVE TEAM DRAW</p>
              <h1>QR로 모이고,<br><em>두근두근</em> 조를 뽑아요.</h1>
            </div>
            <p class="intro-copy">참가자가 이름을 보내면 이 화면에 바로 도착해요. 조 수를 정하고 시작하면 한 명씩 쏙쏙 배정됩니다.</p>
          </section>

          <div id="lobby-area">
            <div class="admin-grid">
              <section class="card panel invite-card" aria-labelledby="invite-title">
                <div class="panel-header">
                  <div>
                    <p class="step-label">STEP 01</p>
                    <h2 id="invite-title">QR을 보여 주세요</h2>
                    <p>카메라로 찍으면 참가 화면이 열립니다.</p>
                  </div>
                </div>
                <div class="invite-layout">
                  <div class="qr-frame">
                    <canvas id="join-qr" aria-label="참가용 QR 코드"></canvas>
                    <span class="qr-ribbon">SCAN ME</span>
                  </div>
                  <div class="invite-actions">
                    <button class="button button-yellow" id="copy-link-button" type="button">참가 링크 복사</button>
                    <button class="button button-ghost" id="test-link-button" type="button">참가 화면 열기</button>
                  </div>
                  <span class="mini-badge">방 코드 <strong id="room-code"></strong></span>
                </div>
              </section>

              <section class="card panel roster-card" aria-labelledby="roster-title">
                <div class="panel-header">
                  <div>
                    <p class="step-label">STEP 02</p>
                    <h2 id="roster-title">도착한 이름</h2>
                    <p id="roster-helper">QR 참가자와 직접 추가한 이름이 함께 보여요.</p>
                  </div>
                  <span class="count-pill roster-count" aria-live="polite"><strong id="participant-count">0</strong> / ${MAX_PARTICIPANTS}명</span>
                </div>
                <div class="roster-list" id="roster-list"></div>
                <form class="manual-form" id="manual-form">
                  <label class="sr-only" for="manual-name">이름 직접 추가</label>
                  <input class="input" id="manual-name" name="name" maxlength="16" autocomplete="off" placeholder="빠진 이름 직접 추가" />
                  <button class="button button-mint" type="submit">추가</button>
                </form>
                <p class="field-error" id="manual-error" aria-live="polite"></p>
              </section>
            </div>

            <section class="card control-bar" aria-labelledby="control-title">
              <div class="control-copy">
                <p class="step-label">STEP 03</p>
                <h2 id="control-title">몇 개 조로 나눌까요?</h2>
                <p id="distribution-text">참가자가 모이면 조별 예상 인원을 알려 드려요.</p>
              </div>
              <div class="group-stepper" aria-label="조 수 설정">
                <button class="button button-icon button-ghost" id="group-minus" type="button" aria-label="조 수 줄이기">−</button>
                <output class="group-value" id="group-count" aria-live="polite">4조</output>
                <button class="button button-icon button-ghost" id="group-plus" type="button" aria-label="조 수 늘리기">+</button>
              </div>
              <div class="start-wrap">
                <button class="button button-primary start-button" id="start-button" type="button">명단 잠그고 시작</button>
                <p class="start-reason" id="start-reason"></p>
              </div>
            </section>
          </div>

          <section class="card draw-section" id="draw-section" aria-labelledby="draw-title" hidden>
            <div class="draw-header">
              <div class="draw-heading">
                <p class="step-label">LIVE DRAW</p>
                <h2 id="draw-title">조 편성 중이에요</h2>
                <p id="draw-description">이름 캡슐이 한 명씩 조에 들어갑니다.</p>
              </div>
              <div class="draw-tools" id="draw-tools">
                <button class="button button-small button-ghost" id="sound-button" type="button" aria-pressed="false">효과음 꺼짐</button>
                <button class="button button-small button-yellow" id="fast-button" type="button" aria-pressed="false">빠르게</button>
                <button class="button button-small button-ghost" id="skip-button" type="button">연출 건너뛰기</button>
              </div>
              <div class="result-actions" id="result-actions" hidden>
                <button class="button button-small button-yellow" id="copy-result-button" type="button">결과 복사</button>
                <button class="button button-small button-ghost" id="csv-button" type="button">CSV 저장</button>
                <button class="button button-small button-mint" id="remix-button" type="button">다시 섞기</button>
              </div>
            </div>
            <div class="draw-layout">
              <div class="draw-stage" aria-live="polite">
                <div class="machine-core">
                  <p class="machine-label">NOW DRAWING</p>
                  <div class="current-name" data-current-name>준비 중…</div>
                  <span class="destination-pill" data-destination>곧 시작해요</span>
                </div>
                <div class="progress-wrap">
                  <div class="progress-meta"><span>배정 진행률</span><span data-progress-text>0 / 0</span></div>
                  <div class="progress-track"><div class="progress-bar" data-progress></div></div>
                </div>
              </div>
              <div class="groups-grid" id="admin-groups"></div>
            </div>
          </section>
        </main>

        <footer class="footer">
          <p class="privacy-note"><strong>잠깐 쓰고 사라지는 방이에요.</strong> 이름과 결과는 암호화되어 전달되며, 관리자 기기에 최대 12시간 동안 복구용으로 남습니다. 수업이 끝나면 ‘새 방’을 눌러 지울 수 있어요.</p>
          <span class="mini-badge">최대 ${MAX_PARTICIPANTS}명</span>
        </footer>
      </div>`;
  }

  bindEvents() {
    this.joinUrl = `${publicBaseUrl()}${createJoinHash(this.credentials)}`;
    app.querySelector("#copy-link-button").addEventListener("click", () =>
      copyText(this.joinUrl, "참가 링크를 복사했어요."),
    );
    app.querySelector("#test-link-button").addEventListener("click", () => {
      globalThis.open(this.joinUrl, "_blank", "noopener,noreferrer");
    });
    app.querySelector("#manual-form").addEventListener("submit", (event) => {
      event.preventDefault();
      this.addManualName();
    });
    app.querySelector("#group-minus").addEventListener("click", () => this.changeGroupCount(-1));
    app.querySelector("#group-plus").addEventListener("click", () => this.changeGroupCount(1));
    app.querySelector("#start-button").addEventListener("click", () => this.startDraw());
    app.querySelector("#skip-button").addEventListener("click", () => {
      this.skipRequested = true;
      app.querySelector("#skip-button").disabled = true;
      toast("남은 이름을 바로 배정할게요.");
    });
    app.querySelector("#fast-button").addEventListener("click", (event) => {
      this.fastMode = !this.fastMode;
      event.currentTarget.setAttribute("aria-pressed", String(this.fastMode));
      event.currentTarget.textContent = this.fastMode ? "보통 속도" : "빠르게";
    });
    app.querySelector("#sound-button").addEventListener("click", (event) => {
      this.soundEnabled = !this.soundEnabled;
      event.currentTarget.setAttribute("aria-pressed", String(this.soundEnabled));
      event.currentTarget.textContent = this.soundEnabled ? "효과음 켜짐" : "효과음 꺼짐";
      if (this.soundEnabled) {
        this.audioContext ??= new AudioContext();
        this.audioContext.resume();
        this.playSound(1);
      }
    });
    app.querySelector("#copy-result-button").addEventListener("click", () =>
      copyText(
        resultText(this.fullAssignments, this.state.groupCount),
        "조 편성 결과를 복사했어요.",
      ),
    );
    app.querySelector("#csv-button").addEventListener("click", () => {
      downloadText("조이-조편성-결과.csv", csvForAssignments(this.fullAssignments), "text/csv;charset=utf-8");
      toast("CSV 파일을 저장했어요.");
    });
    app.querySelector("#remix-button").addEventListener("click", () => this.remix());
    app.querySelector("#new-room-button").addEventListener("click", () => this.createNewRoom());
  }

  async renderQr() {
    app.querySelector("#room-code").textContent = this.credentials.roomId.slice(0, 6).toUpperCase();
    await QRCode.toCanvas(app.querySelector("#join-qr"), this.joinUrl, {
      width: 280,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#20243a", light: "#ffffff" },
    });
  }

  render() {
    const drawing = this.state.phase === ROOM_PHASES.DRAWING;
    const complete = this.state.phase === ROOM_PHASES.COMPLETE;
    app.querySelector("#lobby-area").hidden = drawing || complete;
    app.querySelector("#admin-intro").hidden = drawing || complete;
    app.querySelector("#draw-section").hidden = !(drawing || complete);
    app.querySelector("#draw-tools").hidden = !drawing;
    app.querySelector("#result-actions").hidden = !complete;

    this.renderRoster();
    this.renderControls();

    if (drawing || complete) {
      const last = this.state.revealed.at(-1) ?? null;
      const heading = app.querySelector("#draw-title");
      const description = app.querySelector("#draw-description");
      heading.textContent = complete ? "오늘의 조가 완성됐어요!" : "조 편성 중이에요";
      description.textContent = complete
        ? `${this.state.participants.length}명이 ${this.state.groupCount}개 조에 골고루 배정됐습니다.`
        : "이름 캡슐이 한 명씩 조에 들어갑니다.";
      updateStage(app, this.state, last, false);
      renderGroups(app.querySelector("#admin-groups"), this.state, last?.clientId ?? "");
      this.lastRenderedId = last?.clientId ?? "";
    }
  }

  renderRoster() {
    const list = app.querySelector("#roster-list");
    const count = app.querySelector("#participant-count");
    count.textContent = String(this.state.participants.length);
    list.replaceChildren();
    if (!this.state.participants.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "아직 도착한 이름이 없어요.\nQR을 보여 주거나 아래에서 직접 추가해 주세요.";
      list.append(empty);
      return;
    }

    for (const person of this.state.participants) {
      const chip = document.createElement("span");
      chip.className = "name-chip";
      chip.dataset.manual = String(Boolean(person.manual));
      const label = document.createElement("span");
      label.textContent = person.name;
      const remove = document.createElement("button");
      remove.className = "chip-remove";
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `${person.name} 삭제`);
      remove.addEventListener("click", () => this.removeParticipant(person.clientId));
      chip.append(label, remove);
      list.append(chip);
    }
  }

  renderControls() {
    const count = this.state.participants.length;
    app.querySelector("#group-count").textContent = `${this.state.groupCount}조`;
    app.querySelector("#group-minus").disabled = this.state.groupCount <= 2;
    app.querySelector("#group-plus").disabled =
      count < 2 || this.state.groupCount >= Math.min(count, MAX_PARTICIPANTS);

    const distribution = app.querySelector("#distribution-text");
    if (!count) {
      distribution.textContent = "참가자가 모이면 조별 예상 인원을 알려 드려요.";
    } else if (this.state.groupCount > count) {
      distribution.textContent = `현재 ${count}명 · 조 수를 ${count}개 이하로 줄여 주세요.`;
    } else {
      distribution.textContent = `${count}명 ÷ ${this.state.groupCount}조 → ${groupSizes(count, this.state.groupCount).join(" · ")}명`;
    }

    const start = app.querySelector("#start-button");
    const reason = app.querySelector("#start-reason");
    let message = "";
    if (count < 2) message = "두 명 이상 모이면 시작할 수 있어요.";
    else if (this.state.groupCount > count) message = "조 수가 참가자 수보다 많아요.";
    start.disabled = Boolean(message) || this.state.phase !== ROOM_PHASES.OPEN;
    reason.textContent = message;
  }

  persist() {
    localStorage.setItem(
      ADMIN_STORAGE_KEY,
      JSON.stringify({
        credentials: this.credentials,
        createdAt: this.createdAt,
        state: this.state,
        fullAssignments: this.fullAssignments,
      }),
    );
  }

  mutate(callback) {
    callback(this.state);
    this.state.revision += 1;
    this.persist();
    this.render();
  }

  changeGroupCount(delta) {
    const maximum = Math.max(2, this.state.participants.length);
    const next = Math.max(2, Math.min(maximum, this.state.groupCount + delta));
    if (next === this.state.groupCount) return;
    this.mutate((state) => {
      state.groupCount = next;
    });
    this.scheduleState();
  }

  addManualName() {
    const input = app.querySelector("#manual-name");
    const error = app.querySelector("#manual-error");
    const checked = validateName(input.value);
    error.textContent = checked.message;
    if (!checked.ok) return;
    if (this.state.participants.length >= MAX_PARTICIPANTS) {
      error.textContent = `최대 ${MAX_PARTICIPANTS}명까지 참가할 수 있어요.`;
      return;
    }
    if (
      this.state.participants.some(
        (person) => canonicalName(person.name) === canonicalName(checked.name),
      )
    ) {
      error.textContent = "같은 이름이 있어요. 성이나 별명을 덧붙여 주세요.";
      return;
    }
    this.mutate((state) => {
      state.participants.push({
        clientId: `manual-${randomToken(7)}`,
        name: checked.name,
        manual: true,
      });
    });
    input.value = "";
    error.textContent = "";
    this.scheduleState();
  }

  removeParticipant(clientId) {
    if (this.state.phase !== ROOM_PHASES.OPEN) return;
    this.mutate((state) => {
      state.participants = state.participants.filter((person) => person.clientId !== clientId);
    });
    this.scheduleState();
  }

  scheduleState(delay = 420) {
    globalThis.clearTimeout(this.broadcastTimer);
    this.broadcastTimer = globalThis.setTimeout(() => {
      this.sendState().catch(() => setConnectionStatus(app, "offline"));
    }, delay);
  }

  async sendAdminMessage(type, data) {
    const body = createMessage(type, this.credentials.roomId, "admin", data);
    const signature = await signPayload(body, this.privateKey);
    const envelope = await sealMessage({ b: body, s: signature }, this.roomKey, this.credentials.roomId);
    if (envelope.length > MAX_ENVELOPE_SIZE) {
      throw new Error("메시지가 너무 커서 보낼 수 없어요.");
    }
    await this.relay.publish(envelope);
  }

  sendState() {
    if (!this.relay.isOpen) return Promise.resolve(false);
    return this.sendAdminMessage("state", packState(this.state)).then(() => true);
  }

  async rejectRequest(body, message) {
    try {
      await this.sendAdminMessage("reject", {
        to: body.s,
        request: body.m,
        message,
      });
    } catch {
      setConnectionStatus(app, "offline");
    }
  }

  async handleRelayMessage(envelope) {
    if (typeof envelope !== "string" || envelope.length > MAX_ENVELOPE_SIZE) return;
    try {
      const packet = await openMessage(envelope, this.roomKey, this.credentials.roomId);
      if (packet?.s || !validMessage(packet?.b, this.credentials.roomId)) return;
      const body = packet.b;
      if (body.t === "sync") {
        this.scheduleState(260);
        return;
      }
      if (body.t !== "join") return;
      await this.acceptJoin(body);
    } catch {
      // Random public-topic traffic and invalid ciphertext are deliberately ignored.
    }
  }

  async acceptJoin(body) {
    const checked = validateName(body.d?.name);
    if (!checked.ok) {
      await this.rejectRequest(body, checked.message);
      return;
    }
    if (this.state.phase !== ROOM_PHASES.OPEN) {
      await this.rejectRequest(body, "명단이 이미 확정됐어요.");
      return;
    }
    const existing = this.state.participants.find((person) => person.clientId === body.s);
    if (!existing && this.state.participants.length >= MAX_PARTICIPANTS) {
      await this.rejectRequest(body, "참가 인원이 모두 찼어요.");
      return;
    }
    const duplicate = this.state.participants.find(
      (person) =>
        person.clientId !== body.s &&
        canonicalName(person.name) === canonicalName(checked.name),
    );
    if (duplicate) {
      await this.rejectRequest(body, "같은 이름이 있어요. 성이나 별명을 덧붙여 주세요.");
      return;
    }

    if (existing?.name === checked.name) {
      this.scheduleState(180);
      return;
    }
    this.mutate((state) => {
      if (existing) {
        existing.name = checked.name;
      } else {
        state.participants.push({ clientId: body.s, name: checked.name, manual: false });
      }
    });
    this.scheduleState();
  }

  async startDraw() {
    const count = this.state.participants.length;
    if (count < 2 || this.state.groupCount > count) return;
    const confirmed = await confirmAction({
      title: "이 명단으로 시작할까요?",
      message: `${count}명을 ${this.state.groupCount}개 조로 나눕니다.\n시작하면 더 이상 이름을 바꿀 수 없어요.`,
      confirmLabel: "네, 시작할게요",
    });
    if (!confirmed) return;

    this.fullAssignments = buildAssignments(this.state.participants, this.state.groupCount);
    this.mutate((state) => {
      state.phase = ROOM_PHASES.DRAWING;
      state.revealed = [];
      state.totalAssignments = this.fullAssignments.length;
      state.roundId = randomToken(8);
    });
    this.skipRequested = false;
    await this.sendState().catch(() => setConnectionStatus(app, "offline"));
    await wait(reducedMotion.matches ? 40 : 360);
    this.runDraw();
  }

  async runDraw() {
    if (this.isDrawing || this.state.phase !== ROOM_PHASES.DRAWING) return;
    this.isDrawing = true;
    const startIndex = this.state.revealed.length;

    for (let index = startIndex; index < this.fullAssignments.length; index += 1) {
      if (this.skipRequested) {
        this.mutate((state) => {
          state.revealed = this.fullAssignments.map((assignment) => ({ ...assignment }));
        });
        break;
      }

      const assignment = this.fullAssignments[index];
      const step = reducedMotion.matches ? 80 : drawStepDuration(this.fullAssignments.length, this.fastMode);
      updateStage(app, this.state, assignment, true);
      await wait(reducedMotion.matches ? 30 : Math.min(260, Math.round(step * 0.38)));

      this.mutate((state) => {
        state.revealed.push({ ...assignment });
      });
      updateStage(app, this.state, assignment, false);
      animateFlyingName(app, assignment);
      this.playSound(assignment.group);
      await this.sendState().catch(() => setConnectionStatus(app, "offline"));
      await wait(reducedMotion.matches ? 20 : Math.max(170, step - 260));
    }

    this.mutate((state) => {
      state.phase = ROOM_PHASES.COMPLETE;
      state.revealed = this.fullAssignments.map((assignment) => ({ ...assignment }));
    });
    await this.sendState().catch(() => setConnectionStatus(app, "offline"));
    this.isDrawing = false;
    this.skipRequested = false;
    showConfetti();
  }

  playSound(group) {
    if (!this.soundEnabled || !this.audioContext) return;
    const oscillator = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 360 + group * 36;
    gain.gain.setValueAtTime(0.0001, this.audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.09, this.audioContext.currentTime + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, this.audioContext.currentTime + 0.12);
    oscillator.connect(gain).connect(this.audioContext.destination);
    oscillator.start();
    oscillator.stop(this.audioContext.currentTime + 0.13);
  }

  async remix() {
    const confirmed = await confirmAction({
      title: "같은 명단을 다시 섞을까요?",
      message: "지금 결과는 바뀌고, 새로운 조 편성이 바로 시작됩니다.",
      confirmLabel: "다시 섞기",
    });
    if (!confirmed) return;
    this.fullAssignments = buildAssignments(this.state.participants, this.state.groupCount);
    this.mutate((state) => {
      state.phase = ROOM_PHASES.DRAWING;
      state.revealed = [];
      state.totalAssignments = this.fullAssignments.length;
      state.roundId = randomToken(8);
    });
    this.lastRenderedId = "";
    this.skipRequested = false;
    await this.sendState().catch(() => setConnectionStatus(app, "offline"));
    await wait(reducedMotion.matches ? 30 : 300);
    this.runDraw();
  }

  async createNewRoom() {
    const confirmed = await confirmAction({
      title: "새 방을 만들까요?",
      message: "현재 명단과 결과를 이 기기에서 지웁니다. 기존 QR은 더 이상 사용할 수 없어요.",
      confirmLabel: "지우고 새 방 만들기",
      danger: true,
    });
    if (!confirmed) return;
    if (this.state.phase !== ROOM_PHASES.CLOSED) {
      this.mutate((state) => {
        state.phase = ROOM_PHASES.CLOSED;
      });
      await this.sendState().catch(() => {});
    }
    this.relay.close();
    localStorage.removeItem(ADMIN_STORAGE_KEY);
    globalThis.location.reload();
  }
}

class ParticipantApp {
  constructor(config) {
    this.config = config;
    this.clientId = this.loadClientId();
    this.relay = new RoomRelay(roomTopic(config.roomId));
    this.roomKey = null;
    this.publicKey = null;
    this.state = null;
    this.status = "connecting";
    this.pending = null;
    this.retryTimer = null;
    this.editing = false;
    this.lastRevealCount = 0;
    this.celebratedRound = "";
  }

  loadClientId() {
    const key = `joy-team-client-${this.config.roomId}`;
    const saved = localStorage.getItem(key);
    if (saved && /^[A-Za-z0-9_-]{8,32}$/u.test(saved)) return saved;
    const created = randomToken(9);
    localStorage.setItem(key, created);
    return created;
  }

  async init() {
    [this.roomKey, this.publicKey] = await Promise.all([
      importRoomKey(this.config.roomKey),
      importSigningPublicKey(this.config.signingPublicKey),
    ]);
    this.renderShell();
    this.bindEvents();
    this.render();

    this.relay.addEventListener("status", (event) => {
      this.status = event.detail;
      setConnectionStatus(app, event.detail);
      this.renderConnectionDependentState();
      if (event.detail === "online") this.sendSync();
    });
    this.relay.addEventListener("message", (event) => this.handleRelayMessage(event.detail));
    this.relay.connect().catch(() => {
      this.status = "offline";
      setConnectionStatus(app, "offline");
      this.renderConnectionDependentState();
    });
  }

  renderShell() {
    app.innerHTML = `
      <div class="app-shell participant-shell">
        <header class="topbar">
          <div class="brand" aria-label="조이!">
            <span class="brand-mark" aria-hidden="true">JOY!</span>
            <span class="brand-word">조이! 랜덤 조 편성</span>
          </div>
          <div class="topbar-actions">
            <span class="role-pill">참가자 화면</span>
            <span class="connection-pill" data-connection data-status="connecting">
              <span class="connection-dot" aria-hidden="true"></span>
              <span data-connection-text>연결 중</span>
            </span>
          </div>
        </header>

        <main id="main-content">
          <section class="participant-hero" id="participant-hero">
            <p class="eyebrow">WELCOME TO THE DRAW</p>
            <h1>내 이름을 넣고<br><em>조이!</em> 하세요.</h1>
            <p class="participant-lead">이름 하나면 준비 끝. 관리자가 시작하면 배정 순간을 여기서 함께 볼 수 있어요.</p>
          </section>

          <section class="card join-card" id="join-card" aria-labelledby="join-title">
            <div class="panel-header">
              <div>
                <p class="step-label">YOUR NAME</p>
                <h2 id="join-title">추첨에 참가할 이름</h2>
                <p id="join-count">관리자와 연결하고 있어요.</p>
              </div>
              <span class="count-pill" id="participant-count-pill">— / ${MAX_PARTICIPANTS}명</span>
            </div>
            <form class="join-form" id="join-form">
              <label for="participant-name">이름 또는 알아보기 쉬운 별명</label>
              <input class="input" id="participant-name" name="name" maxlength="16" autocomplete="name" enterkeyhint="done" placeholder="예: 김민지" />
              <button class="button button-primary" id="join-button" type="submit">이 이름으로 참가</button>
            </form>
            <p class="field-error" id="join-error" aria-live="polite"></p>
          </section>

          <section class="card waiting-card" id="waiting-card" hidden>
            <div class="waiting-icon" aria-hidden="true">✓</div>
            <div>
              <h2>참가 완료!</h2>
              <p id="waiting-copy">관리자가 시작할 때까지 잠시만 기다려 주세요.</p>
            </div>
            <span class="submitted-name"><span aria-hidden="true">●</span><strong id="submitted-name"></strong></span>
            <button class="button button-ghost" id="edit-name-button" type="button">이름 수정</button>
          </section>

          <section class="participant-draw" id="participant-draw" hidden>
            <div class="draw-stage" aria-live="off">
              <div class="machine-core">
                <p class="machine-label">NOW DRAWING</p>
                <div class="current-name" data-current-name>준비 중…</div>
                <span class="destination-pill" data-destination>곧 시작해요</span>
              </div>
              <div class="progress-wrap">
                <div class="progress-meta"><span>배정 진행률</span><span data-progress-text>0 / 0</span></div>
                <div class="progress-track"><div class="progress-bar" data-progress></div></div>
              </div>
            </div>
            <div class="personal-alert" id="personal-alert" role="status" hidden></div>
            <details class="participant-groups">
              <summary><span>지금까지 배정된 조 보기</span><span aria-hidden="true">＋</span></summary>
              <div class="groups-grid" id="participant-groups"></div>
            </details>
          </section>

          <section class="card personal-result" id="personal-result" hidden>
            <p class="step-label">YOUR TEAM</p>
            <h2 id="personal-result-title">조 편성 완료!</h2>
            <div class="personal-group" id="personal-group"></div>
            <p id="personal-result-copy"></p>
          </section>

          <details class="participant-groups" id="complete-groups" hidden open>
            <summary><span>전체 조 편성 결과</span><span aria-hidden="true">＋</span></summary>
            <div class="groups-grid" id="complete-groups-grid"></div>
          </details>

          <section class="card closed-card" id="closed-card" hidden>
            <h1>이 방은 끝났어요</h1>
            <p>관리자가 새 방을 만들었습니다. 새 QR을 다시 찍어 주세요.</p>
          </section>
        </main>

        <footer class="footer">
          <p class="privacy-note"><strong>이름은 암호화되어 전달돼요.</strong> 이 QR을 받은 사람만 같은 방에 참여할 수 있습니다.</p>
          <span class="mini-badge">최대 ${MAX_PARTICIPANTS}명</span>
        </footer>
      </div>`;
  }

  bindEvents() {
    const form = app.querySelector("#join-form");
    const input = app.querySelector("#participant-name");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.submitName(input.value);
    });
    input.addEventListener("input", () => {
      app.querySelector("#join-error").textContent = "";
    });
    app.querySelector("#edit-name-button").addEventListener("click", () => {
      const person = this.findSelf();
      this.editing = true;
      this.render();
      input.value = person?.name ?? "";
      input.focus();
      input.select();
    });
  }

  renderConnectionDependentState() {
    const button = app.querySelector("#join-button");
    if (!button) return;
    button.disabled = this.status !== "online" || Boolean(this.pending);
    if (this.pending) button.textContent = "이름 보내는 중…";
    else if (this.status !== "online") button.textContent = "연결을 기다리는 중…";
    else button.textContent = this.findSelf() ? "이 이름으로 수정" : "이 이름으로 참가";
  }

  findSelf() {
    return this.state?.participants.find((person) => person.clientId === this.clientId) ?? null;
  }

  findOwnAssignment() {
    return this.state?.revealed.find((person) => person.clientId === this.clientId) ?? null;
  }

  render() {
    const state = this.state;
    const self = this.findSelf();
    const phase = state?.phase ?? ROOM_PHASES.OPEN;
    const isOpen = phase === ROOM_PHASES.OPEN;
    const isDrawing = phase === ROOM_PHASES.DRAWING;
    const isComplete = phase === ROOM_PHASES.COMPLETE;
    const isClosed = phase === ROOM_PHASES.CLOSED;

    app.querySelector("#participant-hero").hidden = isDrawing || isComplete || isClosed;
    app.querySelector("#join-card").hidden = !isOpen || (Boolean(self) && !this.editing);
    app.querySelector("#waiting-card").hidden = !isOpen || !self || this.editing;
    app.querySelector("#participant-draw").hidden = !isDrawing;
    app.querySelector("#personal-result").hidden = !isComplete;
    app.querySelector("#complete-groups").hidden = !isComplete;
    app.querySelector("#closed-card").hidden = !isClosed;

    const count = state?.participants.length;
    app.querySelector("#participant-count-pill").textContent =
      count === undefined ? `— / ${MAX_PARTICIPANTS}명` : `${count} / ${MAX_PARTICIPANTS}명`;
    app.querySelector("#join-count").textContent =
      count === undefined
        ? "관리자와 연결하고 있어요."
        : `지금 ${count}명이 기다리고 있어요.`;

    if (self) {
      app.querySelector("#submitted-name").textContent = self.name;
      app.querySelector("#waiting-copy").textContent = `지금 ${count}명이 함께 기다리고 있어요.`;
    }

    if (isDrawing) {
      const last = state.revealed.at(-1) ?? null;
      updateStage(app, state, last, false);
      renderGroups(app.querySelector("#participant-groups"), state, last?.clientId ?? "");
      const own = this.findOwnAssignment();
      const alert = app.querySelector("#personal-alert");
      alert.hidden = !own;
      if (own) alert.textContent = `🎉 ${own.name}님은 ${own.group}조에 배정됐어요!`;
    }

    if (isComplete) {
      const own = this.findOwnAssignment();
      app.querySelector("#personal-group").textContent = own ? `${own.group}조` : "완료!";
      app.querySelector("#personal-result-title").textContent = own
        ? `${own.name}님의 오늘의 조는`
        : "조 편성이 완료됐어요";
      app.querySelector("#personal-result-copy").textContent = own
        ? "아래에서 조원도 함께 확인해 보세요."
        : "전체 결과를 아래에서 확인할 수 있어요.";
      renderGroups(app.querySelector("#complete-groups-grid"), state);
    }

    this.renderConnectionDependentState();
  }

  async sendClientMessage(body) {
    const envelope = await sealMessage({ b: body }, this.roomKey, this.config.roomId);
    if (envelope.length > MAX_ENVELOPE_SIZE) throw new Error("메시지가 너무 커요.");
    await this.relay.publish(envelope);
  }

  sendSync() {
    const body = createMessage("sync", this.config.roomId, this.clientId);
    this.sendClientMessage(body).catch(() => setConnectionStatus(app, "offline"));
  }

  async submitName(rawName) {
    const error = app.querySelector("#join-error");
    const checked = validateName(rawName);
    error.textContent = checked.message;
    if (!checked.ok || this.pending) return;
    if (this.status !== "online") {
      error.textContent = "연결을 기다린 뒤 다시 눌러 주세요.";
      return;
    }

    const body = createMessage("join", this.config.roomId, this.clientId, {
      name: checked.name,
    });
    this.pending = { body, name: checked.name, attempt: 0 };
    this.editing = true;
    this.renderConnectionDependentState();
    await this.tryPendingRequest();
  }

  async tryPendingRequest() {
    if (!this.pending) return;
    const pending = this.pending;
    try {
      await this.sendClientMessage(pending.body);
    } catch {
      // A bounded retry below handles short network interruptions.
    }
    if (!this.pending || this.pending.body.m !== pending.body.m) return;
    pending.attempt += 1;
    if (pending.attempt >= 3) {
      this.pending = null;
      this.renderConnectionDependentState();
      app.querySelector("#join-error").textContent =
        "관리자 응답이 없어요. 잠시 후 다시 시도해 주세요.";
      return;
    }
    const delay = 3_500 * 2 ** (pending.attempt - 1) + Math.random() * 900;
    globalThis.clearTimeout(this.retryTimer);
    this.retryTimer = globalThis.setTimeout(() => this.tryPendingRequest(), delay);
  }

  async handleRelayMessage(envelope) {
    if (typeof envelope !== "string" || envelope.length > MAX_ENVELOPE_SIZE) return;
    try {
      const packet = await openMessage(envelope, this.roomKey, this.config.roomId);
      if (!packet?.s || !validMessage(packet?.b, this.config.roomId)) return;
      const authentic = await verifyPayload(packet.b, packet.s, this.publicKey);
      if (!authentic) return;
      if (packet.b.t === "state") this.acceptState(packet.b.d);
      if (packet.b.t === "reject") this.acceptRejection(packet.b.d);
    } catch {
      // Ignore malformed traffic on the public relay topic.
    }
  }

  acceptState(wireState) {
    const next = unpackState(wireState);
    if (!next || (this.state && next.revision < this.state.revision)) return;
    const previousRevealCount = this.state?.revealed.length ?? 0;
    const previousPhase = this.state?.phase;
    this.state = next;

    if (this.pending) {
      const person = this.findSelf();
      if (person && canonicalName(person.name) === canonicalName(this.pending.name)) {
        globalThis.clearTimeout(this.retryTimer);
        this.pending = null;
        this.editing = false;
        app.querySelector("#join-error").textContent = "";
        toast("참가 완료! 이름이 도착했어요.");
      }
    }

    this.render();
    if (next.revealed.length > previousRevealCount) {
      const latest = next.revealed.at(-1);
      updateStage(app, next, latest, false);
      animateFlyingName(app, latest);
      if (latest.clientId === this.clientId) {
        navigator.vibrate?.([80, 45, 120]);
      }
    }
    if (
      next.phase === ROOM_PHASES.COMPLETE &&
      previousPhase !== ROOM_PHASES.COMPLETE &&
      this.celebratedRound !== next.roundId
    ) {
      this.celebratedRound = next.roundId;
      showConfetti();
    }
  }

  acceptRejection(data) {
    if (!this.pending || data?.to !== this.clientId || data?.request !== this.pending.body.m) {
      return;
    }
    globalThis.clearTimeout(this.retryTimer);
    this.pending = null;
    this.renderConnectionDependentState();
    app.querySelector("#join-error").textContent =
      typeof data.message === "string" ? data.message : "이름을 등록하지 못했어요.";
  }
}

function renderInvalidLink() {
  app.innerHTML = `
    <div class="app-shell participant-shell">
      <header class="topbar">
        <div class="brand"><span class="brand-mark" aria-hidden="true">JOY!</span><span>조이! 랜덤 조 편성</span></div>
      </header>
      <main id="main-content">
        <section class="card invalid-card">
          <h1>유효하지 않은 참가 링크예요</h1>
          <p>관리자에게 최신 QR을 다시 보여 달라고 해 주세요.</p>
        </section>
      </main>
    </div>`;
}

async function loadOrCreateAdminSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(ADMIN_STORAGE_KEY));
    if (validSavedSession(saved)) return saved;
  } catch {
    // A corrupt or old local session is replaced with a fresh room.
  }
  localStorage.removeItem(ADMIN_STORAGE_KEY);
  const credentials = await createRoomCredentials();
  const session = {
    credentials,
    createdAt: Date.now(),
    state: newRoomState(),
    fullAssignments: [],
  };
  localStorage.setItem(ADMIN_STORAGE_KEY, JSON.stringify(session));
  return session;
}

async function start() {
  const rawHash = new URLSearchParams(globalThis.location.hash.replace(/^#/u, ""));
  const wantsToJoin = rawHash.has("join");
  const joinConfig = parseJoinHash();
  try {
    if (wantsToJoin) {
      if (!joinConfig) {
        renderInvalidLink();
        return;
      }
      await new ParticipantApp(joinConfig).init();
      return;
    }
    const session = await loadOrCreateAdminSession();
    await new AdminApp(session).init();
  } catch (error) {
    console.error(error);
    app.innerHTML = `
      <div class="app-shell participant-shell">
        <main id="main-content">
          <section class="card invalid-card">
            <h1>화면을 준비하지 못했어요</h1>
            <p>브라우저를 새로고침해 주세요. 계속되면 최신 Chrome, Safari 또는 Edge에서 다시 열어 주세요.</p>
          </section>
        </main>
      </div>`;
  }
}

start();
