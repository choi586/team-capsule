import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAssignments,
  canonicalName,
  clampGroupCount,
  groupSizes,
  normalizeName,
  resultText,
  validateName,
} from "../src/domain.js";

function sequenceRandom(values) {
  let index = 0;
  return () => values[index++ % values.length];
}

test("이름을 정규화하고 위험한 문자를 거부한다", () => {
  assert.equal(normalizeName("  김   민지\n"), "김 민지");
  assert.equal(validateName("김민지").ok, true);
  assert.equal(validateName("<img src=x>").ok, false);
  assert.equal(validateName("가".repeat(17)).ok, false);
  assert.equal(canonicalName(" MINJI "), "minji");
});

test("조 수는 참가자 수를 넘지 않도록 보정한다", () => {
  assert.equal(clampGroupCount(8, 5), 5);
  assert.equal(clampGroupCount(1, 12), 2);
  assert.equal(clampGroupCount(4, 0), 2);
});

test("조별 인원 차이는 항상 한 명 이하다", () => {
  const participants = Array.from({ length: 25 }, (_, index) => ({
    clientId: `p-${index}`,
    name: `참가자 ${index + 1}`,
  }));
  const assignments = buildAssignments(
    participants,
    6,
    sequenceRandom([0.91, 0.12, 0.67, 0.34, 0.78, 0.03]),
  );
  const counts = Array.from({ length: 6 }, (_, index) =>
    assignments.filter((person) => person.group === index + 1).length,
  );
  assert.equal(new Set(assignments.map((person) => person.clientId)).size, 25);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
  assert.deepEqual([...counts].sort((a, b) => b - a), [5, 4, 4, 4, 4, 4]);
});

test("예상 인원과 복사용 결과를 만든다", () => {
  assert.deepEqual(groupSizes(11, 3), [4, 4, 3]);
  const output = resultText(
    [
      { name: "민지", group: 1 },
      { name: "준호", group: 2 },
      { name: "수아", group: 1 },
    ],
    2,
  );
  assert.match(output, /1조: 민지, 수아/u);
  assert.match(output, /2조: 준호/u);
});
