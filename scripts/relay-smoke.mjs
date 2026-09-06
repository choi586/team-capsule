import assert from "node:assert/strict";
import { randomToken } from "../src/crypto.js";

const topic = `joy-team-smoke-${randomToken(12)}`;
const payload = `relay-check-${randomToken(8)}`;
const socket = new WebSocket(`wss://ntfy.sh/${topic}/ws?since=latest`);

function withTimeout(promise, milliseconds, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(message)), milliseconds),
    ),
  ]);
}

await withTimeout(
  new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket 연결 실패")), {
      once: true,
    });
  }),
  10_000,
  "WebSocket 연결 시간 초과",
);

const received = withTimeout(
  new Promise((resolve) => {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.event === "message" && message.message === payload) resolve(message);
    });
  }),
  10_000,
  "게시한 메시지 수신 시간 초과",
);

const response = await fetch(`https://ntfy.sh/${topic}`, {
  method: "POST",
  headers: {
    "Content-Type": "text/plain;charset=UTF-8",
    "X-Firebase": "no",
  },
  body: payload,
});
assert.equal(response.ok, true, `HTTP 게시 실패: ${response.status}`);
const message = await received;
assert.equal(message.topic, topic);
socket.close();

console.log("실시간 릴레이 송수신 확인 완료");
