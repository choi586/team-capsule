import test from "node:test";
import assert from "node:assert/strict";
import { RoomRelay } from "../src/relay.js";

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.closeCalls = 0;
    FakeSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState === FakeSocket.CLOSED) return;
      this.readyState = FakeSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  receive(packet) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(packet) }),
    );
  }

  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.closeCalls += 1;
    this.readyState = FakeSocket.CLOSED;
    queueMicrotask(() => this.dispatchEvent(new Event("close")));
  }
}

function resetSockets() {
  FakeSocket.instances.length = 0;
}

test("25명 참가 전송은 연결이나 사전 요청 없이 25번의 POST만 사용한다", async () => {
  resetSockets();
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return new Response("", { status: 200 });
  };

  await Promise.all(
    Array.from({ length: 25 }, (_, index) =>
      new RoomRelay("shared-room", { fetchImpl, WebSocketImpl: FakeSocket }).publish(
        `encrypted-name-${index}`,
      ),
    ),
  );

  assert.equal(requests.length, 25);
  assert.equal(FakeSocket.instances.length, 0);
  for (const request of requests) {
    assert.equal(request.options.method, "POST");
    assert.equal(request.options.headers["X-Firebase"], undefined);
    assert.match(request.url, /\?firebase=no$/u);
  }
});

test("게시 실패가 열려 있는 관리자 수신 연결을 끊지 않는다", async () => {
  resetSockets();
  const relay = new RoomRelay("room", {
    fetchImpl: async () =>
      new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "2" },
      }),
    WebSocketImpl: FakeSocket,
  });
  await relay.connect();
  const socket = FakeSocket.instances[0];

  await assert.rejects(
    relay.publish("encrypted-name"),
    (error) => error.status === 429 && error.retryAfterMs === 2_000,
  );
  assert.equal(socket.closeCalls, 0);
  assert.equal(relay.isOpen, true);
  relay.close();
});

test("429 응답에 대기 시간이 없으면 안전한 기본값을 안내한다", async () => {
  const relay = new RoomRelay("room", {
    fetchImpl: async () => new Response("rate limited", { status: 429 }),
    WebSocketImpl: FakeSocket,
  });

  await assert.rejects(
    relay.publish("encrypted-name"),
    (error) => error.status === 429 && error.retryAfterMs === 5_000,
  );
});

test("재연결은 마지막 수신 메시지 다음부터 이어 받고 중복을 무시한다", async () => {
  resetSockets();
  const relay = new RoomRelay("room", {
    fetchImpl: async () => new Response("", { status: 200 }),
    WebSocketImpl: FakeSocket,
    reconnectBaseMs: 1,
    reconnectMaxMs: 1,
  });
  const received = [];
  relay.addEventListener("message", (event) => received.push(event.detail));
  await relay.connect();

  const first = FakeSocket.instances[0];
  first.receive({ event: "message", id: "message-01", message: "one" });
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const second = FakeSocket.instances[1];
  assert.ok(second, "재연결 소켓이 만들어져야 합니다.");
  assert.match(second.url, /since=message-01$/u);
  second.receive({ event: "message", id: "message-01", message: "one" });
  second.receive({ event: "message", id: "message-02", message: "two" });
  assert.deepEqual(received, ["one", "two"]);
  relay.close();
});
