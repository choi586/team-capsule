import test from "node:test";
import assert from "node:assert/strict";
import {
  createJoinHash,
  createRoomCredentials,
  importRoomKey,
  importSigningPrivateKey,
  importSigningPublicKey,
  openMessage,
  parseJoinHash,
  sealMessage,
  signPayload,
  verifyPayload,
} from "../src/crypto.js";

test("참가 링크 조각을 만들고 다시 읽는다", async () => {
  const credentials = await createRoomCredentials();
  const parsed = parseJoinHash(createJoinHash(credentials));
  assert.equal(parsed.roomId, credentials.roomId);
  assert.equal(parsed.roomKey, credentials.roomKey);
  assert.equal(parsed.signingPublicKey, credentials.signingPublicKey);
});

test("방 메시지는 암호화되고 같은 방에서만 열린다", async () => {
  const credentials = await createRoomCredentials();
  const key = await importRoomKey(credentials.roomKey);
  const payload = { type: "join", name: "민지" };
  const envelope = await sealMessage(payload, key, credentials.roomId);
  assert.equal(envelope.includes("민지"), false);
  assert.deepEqual(await openMessage(envelope, key, credentials.roomId), payload);
  await assert.rejects(openMessage(envelope, key, "another-room"));
});

test("관리자 서명은 변조를 검출한다", async () => {
  const credentials = await createRoomCredentials();
  const [privateKey, publicKey] = await Promise.all([
    importSigningPrivateKey(credentials.signingPrivateJwk),
    importSigningPublicKey(credentials.signingPublicKey),
  ]);
  const payload = { type: "state", revision: 3 };
  const signature = await signPayload(payload, privateKey);
  assert.equal(await verifyPayload(payload, signature, publicKey), true);
  assert.equal(
    await verifyPayload({ ...payload, revision: 4 }, signature, publicKey),
    false,
  );
});

test("25명의 최종 상태도 실시간 릴레이 메시지 한도 안에 든다", async () => {
  const credentials = await createRoomCredentials();
  const [roomKey, privateKey] = await Promise.all([
    importRoomKey(credentials.roomKey),
    importSigningPrivateKey(credentials.signingPrivateJwk),
  ]);
  const names = Array.from({ length: 25 }, (_, index) => [
    `person-${String(index).padStart(2, "0")}`,
    `가나다라마바사아자차카타파하${index}`.slice(0, 16),
  ]);
  const body = {
    v: 1,
    t: "state",
    r: credentials.roomId,
    s: "admin",
    m: "message-id-01",
    x: Date.now(),
    d: {
      v: 52,
      p: "complete",
      g: 6,
      n: names,
      a: names.map(([clientId], index) => [clientId, (index % 6) + 1, index]),
      z: 25,
      q: "round-id",
    },
  };
  const signature = await signPayload(body, privateKey);
  const envelope = await sealMessage({ b: body, s: signature }, roomKey, credentials.roomId);
  assert.ok(envelope.length <= 4_096, `메시지 길이: ${envelope.length}`);
});
