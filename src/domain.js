export const MAX_PARTICIPANTS = 25;
export const MAX_NAME_LENGTH = 16;
export const ROOM_PHASES = Object.freeze({
  OPEN: "open",
  DRAWING: "drawing",
  COMPLETE: "complete",
  CLOSED: "closed",
});

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const ALLOWED_NAME = /^[\p{L}\p{M}\p{N} .·・_'()-]+$/u;

export function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(CONTROL_CHARACTERS, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function validateName(value) {
  const name = normalizeName(value);
  if (!name) {
    return { ok: false, name, message: "이름을 입력해 주세요." };
  }
  if ([...name].length > MAX_NAME_LENGTH) {
    return {
      ok: false,
      name,
      message: `이름은 ${MAX_NAME_LENGTH}자 이내로 입력해 주세요.`,
    };
  }
  if (!ALLOWED_NAME.test(name)) {
    return {
      ok: false,
      name,
      message: "한글, 영문, 숫자와 간단한 기호만 사용할 수 있어요.",
    };
  }
  return { ok: true, name, message: "" };
}

export function canonicalName(value) {
  return normalizeName(value).toLocaleLowerCase("ko-KR");
}

export function clampGroupCount(groupCount, participantCount) {
  const people = Math.max(0, Number(participantCount) || 0);
  const maximum = Math.max(2, people);
  const count = Math.round(Number(groupCount) || 2);
  return Math.min(maximum, Math.max(2, count));
}

export function groupSizes(participantCount, groupCount) {
  const people = Math.max(0, Math.floor(Number(participantCount) || 0));
  const groups = Math.max(1, Math.floor(Number(groupCount) || 1));
  const base = Math.floor(people / groups);
  const extra = people % groups;
  return Array.from({ length: groups }, (_, index) =>
    index < extra ? base + 1 : base,
  );
}

export function fisherYates(items, random = secureRandomUnit) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const candidate = Math.floor(random() * (index + 1));
    const target = Math.max(0, Math.min(index, candidate));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

export function secureRandomUnit() {
  const values = new Uint32Array(1);
  globalThis.crypto.getRandomValues(values);
  return values[0] / 2 ** 32;
}

export function buildAssignments(participants, groupCount, random = secureRandomUnit) {
  if (!Array.isArray(participants) || participants.length < 2) {
    throw new Error("조 편성에는 두 명 이상이 필요합니다.");
  }

  const groups = clampGroupCount(groupCount, participants.length);
  const people = fisherYates(participants, random);
  const slots = fisherYates(
    people.map((_, index) => (index % groups) + 1),
    random,
  );

  return people.map((person, index) => ({
    clientId: person.clientId,
    name: person.name,
    group: slots[index],
    order: index,
  }));
}

export function groupAssignments(assignments, groupCount) {
  const groups = Array.from({ length: groupCount }, (_, index) => ({
    number: index + 1,
    members: [],
  }));
  for (const assignment of assignments ?? []) {
    const group = groups[assignment.group - 1];
    if (group) group.members.push(assignment);
  }
  return groups;
}

export function drawStepDuration(participantCount, fast = false) {
  if (fast) return 230;
  const people = Math.max(1, Number(participantCount) || 1);
  return Math.max(520, Math.min(880, Math.round(15_000 / people)));
}

export function resultText(assignments, groupCount) {
  const lines = groupAssignments(assignments, groupCount).map(
    (group) => `${group.number}조: ${group.members.map((member) => member.name).join(", ")}`,
  );
  return [`조이! 랜덤 조 편성 결과`, ...lines].join("\n");
}
