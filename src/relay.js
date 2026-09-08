const DEFAULT_RELAY = "https://ntfy.sh";

export class RoomRelay extends EventTarget {
  constructor(topic, options = {}) {
    super();
    this.topic = topic;
    this.baseUrl = (options.baseUrl ?? DEFAULT_RELAY).replace(/\/$/u, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
    this.socket = null;
    this.closed = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.retryFloor = 0;
    this.lastMessageId = "";
    this.seenMessageIds = new Set();
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? Number.POSITIVE_INFINITY;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 750;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 10_000;
  }

  get isOpen() {
    return this.socket?.readyState === (this.WebSocketImpl?.OPEN ?? 1);
  }

  get retryAfterMs() {
    return this.retryFloor;
  }

  connect() {
    this.closed = false;
    return new Promise((resolve, reject) => {
      const onStatus = (event) => {
        if (event.detail === "online") {
          globalThis.clearTimeout(timeout);
          this.removeEventListener("status", onStatus);
          resolve();
        }
      };
      const timeout = globalThis.setTimeout(() => {
        this.removeEventListener("status", onStatus);
        reject(new Error("연결 시간이 오래 걸리고 있어요."));
      }, 10_000);
      this.addEventListener("status", onStatus);
      this.#openSocket();
    });
  }

  async publish(message) {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), 6_000);
    try {
      const publishUrl = `${this.baseUrl}/${encodeURIComponent(this.topic)}?firebase=no`;
      const response = await this.fetchImpl(publishUrl, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=UTF-8",
        },
        body: message,
        mode: "cors",
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 429) {
          const retryAfterHeader = response.headers.get("Retry-After");
          const retryAfter = Number(retryAfterHeader);
          this.retryFloor =
            retryAfterHeader && Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1_000
              : 5_000;
        }
        const error = new Error(`메시지를 보내지 못했어요. (${response.status})`);
        error.status = response.status;
        error.retryAfterMs = this.retryFloor;
        throw error;
      }
      this.retryFloor = 0;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  close() {
    this.closed = true;
    globalThis.clearTimeout(this.reconnectTimer);
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "room closed");
  }

  #openSocket() {
    if (this.closed) return;
    const previous = this.socket;
    this.socket = null;
    previous?.close();
    const socketBase = this.baseUrl.replace(/^http/u, "ws");
    const since = this.lastMessageId || "latest";
    const url = `${socketBase}/${encodeURIComponent(this.topic)}/ws?since=${encodeURIComponent(since)}`;
    const socket = new this.WebSocketImpl(url);
    this.socket = socket;
    this.dispatchEvent(new CustomEvent("status", { detail: "connecting" }));

    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.dispatchEvent(new CustomEvent("status", { detail: "online" }));
    });

    socket.addEventListener("message", (event) => {
      try {
        const packet = JSON.parse(event.data);
        if (packet.event === "message" && typeof packet.message === "string") {
          if (typeof packet.id === "string") {
            if (this.seenMessageIds.has(packet.id)) return;
            this.lastMessageId = packet.id;
            this.seenMessageIds.add(packet.id);
            if (this.seenMessageIds.size > 256) {
              this.seenMessageIds.delete(this.seenMessageIds.values().next().value);
            }
          }
          this.dispatchEvent(new CustomEvent("message", { detail: packet.message }));
        }
      } catch {
        // Ignore relay housekeeping frames and malformed third-party traffic.
      }
    });

    socket.addEventListener("close", () => {
      if (this.socket === socket) this.#scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      if (this.socket === socket) {
        this.dispatchEvent(new CustomEvent("status", { detail: "offline" }));
      }
    });
  }

  #scheduleReconnect() {
    if (this.closed) return;
    this.dispatchEvent(new CustomEvent("status", { detail: "offline" }));
    if (this.reconnectAttempt >= this.maxReconnectAttempts) return;
    const delay = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * 2 ** this.reconnectAttempt,
    );
    this.reconnectAttempt += 1;
    globalThis.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = globalThis.setTimeout(() => this.#openSocket(), delay);
  }
}

export function roomTopic(roomId) {
  return `joy-team-${roomId}`;
}
