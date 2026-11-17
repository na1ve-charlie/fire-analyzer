"use strict";

export const MANUAL_SNAPSHOT_ADAPTER_VERSION = "manual-snapshot.v0.1.0";

function requireString(value, field, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${field} 必须是非空字符串`);
    return "";
  }
  return value.trim();
}

function normalizeDataPoint(point, index, errors) {
  const metricId = requireString(point.metricId, `metrics[${index}].metricId`, errors);
  const sourceId = requireString(point.sourceId, `metrics[${index}].sourceId`, errors);
  const sourceUrl = requireString(point.sourceUrl, `metrics[${index}].sourceUrl`, errors);
  const date = requireString(point.date, `metrics[${index}].date`, errors);
  const fetchedAt = requireString(point.fetchedAt, `metrics[${index}].fetchedAt`, errors);
  const unit = requireString(point.unit, `metrics[${index}].unit`, errors);
  const value = Number(point.value);

  if (!Number.isFinite(value)) {
    errors.push(`metrics[${index}].value 必须是有限数字`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    errors.push(`metrics[${index}].date 必须使用 YYYY-MM-DD 格式`);
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(fetchedAt) && !/^\d{4}-\d{2}-\d{2}$/.test(fetchedAt)) {
    errors.push(`metrics[${index}].fetchedAt 必须是 ISO 日期或日期时间`);
  }

  return {
    metricId,
    sourceId,
    sourceUrl,
    date,
    publishedAt: point.publishedAt || null,
    fetchedAt,
    value,
    unit,
    currency: point.currency || null,
    frequency: point.frequency || "manual",
    revision: Number.isFinite(Number(point.revision)) ? Number(point.revision) : 1,
    license: point.license || "需确认原始来源授权",
    staleAfter: point.staleAfter || null,
    qualityFlags: Array.isArray(point.qualityFlags) ? [...point.qualityFlags] : ["manual"],
    adapterVersion: MANUAL_SNAPSHOT_ADAPTER_VERSION
  };
}

export function normalizeManualSnapshot(rawSnapshot = {}) {
  const errors = [];
  const name = requireString(rawSnapshot.name, "name", errors);
  const points = Array.isArray(rawSnapshot.metrics)
    ? rawSnapshot.metrics.map((point, index) => normalizeDataPoint(point, index, errors))
    : [];

  if (!Array.isArray(rawSnapshot.metrics) || rawSnapshot.metrics.length === 0) {
    errors.push("metrics 必须是非空数组");
  }

  return {
    valid: errors.length === 0,
    errors,
    adapterVersion: MANUAL_SNAPSHOT_ADAPTER_VERSION,
    snapshot: {
      name,
      metrics: points
    }
  };
}

export function buildMetricIndex(snapshot) {
  const index = new Map();
  for (const point of snapshot.metrics) {
    index.set(point.metricId, point);
  }
  return index;
}
