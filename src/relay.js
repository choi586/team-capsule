const DEFAULT_RELAY = "https://ntfy.sh";

export class RoomRelay extends EventTarget {
  constructor(topic, options = {}) {
    super();
    this.topic = topic;
    this.baseUrl = (options.baseUrl ?? DEFAULT_RELAY).replace(/\/$/u, "");
    this.socket = null;
    this.closed = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.retryFloor = 0;
  }

  get isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
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
      const response = await fetch(`${this.baseUrl}/${encodeURIComponent(this.topic)}`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=UTF-8",
          "X-Firebase": "no",
        },
        body: message,
        mode: "cors",
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get("Retry-After"));
          this.retryFloor = Number.isFinite(retryAfter) ? retryAfter * 1_000 : 5_000;
        }
        throw new Error(`메시지를 보내지 못했어요. (${response.status})`);
      }
    } catch (error) {
      this.dispatchEvent(new CustomEvent("status", { detail: "offline" }));
      this.socket?.close();
      throw error;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  close() {
    this.closed = true;
    globalThis.clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "room closed");
  }

  #openSocket() {
    if (this.closed) return;
    this.socket?.close();
    const socketBase = this.baseUrl.replace(/^http/u, "ws");
    const url = `${socketBase}/${encodeURIComponent(this.topic)}/ws?since=latest`;
    const socket = new WebSocket(url);
    this.socket = socket;
    this.dispatchEvent(new CustomEvent("status", { detail: "connecting" }));

    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.retryFloor = 0;
      this.dispatchEvent(new CustomEvent("status", { detail: "online" }));
    });

    socket.addEventListener("message", (event) => {
      try {
        const packet = JSON.parse(event.data);
        if (packet.event === "message" && typeof packet.message === "string") {
          this.dispatchEvent(new CustomEvent("message", { detail: packet.message }));
        }
      } catch {
        // Ignore relay housekeeping frames and malformed third-party traffic.
      }
    });

    socket.addEventListener("close", () => this.#scheduleReconnect());
    socket.addEventListener("error", () => {
      this.dispatchEvent(new CustomEvent("status", { detail: "offline" }));
    });
  }

  #scheduleReconnect() {
    if (this.closed) return;
    this.dispatchEvent(new CustomEvent("status", { detail: "offline" }));
    const delay = Math.max(
      this.retryFloor,
      Math.min(10_000, 750 * 2 ** this.reconnectAttempt),
    );
    this.reconnectAttempt += 1;
    globalThis.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = globalThis.setTimeout(() => this.#openSocket(), delay);
  }
}

export function roomTopic(roomId) {
  return `joy-team-${roomId}`;
}
