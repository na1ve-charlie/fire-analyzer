"use strict";

export const SNAPSHOT_SCHEMA = "fire-planner.snapshot";
export const SNAPSHOT_SCHEMA_VERSION = 1;

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createSnapshotPayload({ state, result, risk, exportedAt } = {}) {
  if (!state) throw new Error("createSnapshotPayload 需要 state");
  if (!result) throw new Error("createSnapshotPayload 需要 result");
  if (!risk) throw new Error("createSnapshotPayload 需要 risk");

  return {
    schema: SNAPSHOT_SCHEMA,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    exportedAt: exportedAt || new Date().toISOString(),
    engineVersions: {
      fire: result.engineVersion,
      risk: risk.riskEngineVersion
    },
    state: cloneValue(state),
    result: cloneValue(result),
    risk: cloneValue(risk)
  };
}

export function parseSnapshotPayload(text) {
  const errors = [];
  let parsed = null;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { valid: false, errors: ["JSON 解析失败，请检查文件内容。"], value: null };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { valid: false, errors: ["快照必须是 JSON 对象。"], value: null };
  }
  if (parsed.schema !== SNAPSHOT_SCHEMA) {
    errors.push(`schema 必须是 ${SNAPSHOT_SCHEMA}。`);
  }
  if (parsed.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    errors.push(`schemaVersion 必须是 ${SNAPSHOT_SCHEMA_VERSION}。`);
  }
  if (!parsed.state || typeof parsed.state !== "object" || Array.isArray(parsed.state)) {
    errors.push("缺少有效的 state。");
  }
  if (!parsed.result || typeof parsed.result !== "object" || Array.isArray(parsed.result)) {
    errors.push("缺少有效的 result。");
  }
  if (!parsed.risk || typeof parsed.risk !== "object" || Array.isArray(parsed.risk)) {
    errors.push("缺少有效的 risk。");
  }
  if (!parsed.engineVersions || typeof parsed.engineVersions !== "object") {
    errors.push("缺少 engineVersions。");
  }

  if (errors.length > 0) {
    return { valid: false, errors, value: null };
  }

  return { valid: true, errors: [], value: cloneValue(parsed) };
}
