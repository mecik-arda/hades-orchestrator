import assert from "node:assert/strict";
import test from "node:test";
import { defaultSloPolicy, normalizeSloPolicy, summarizeSlo } from "../subagent-bridge/src/services/slo-service.js";

const now = Date.parse("2026-09-13T12:00:00.000Z");

function runRecord(minutesAgo, outcomeStatus = "completed", durationMs = 1000) {
  return {
    recordedAt: new Date(now - minutesAgo * 60000).toISOString(),
    outcomeStatus,
    usage: { durationMs }
  };
}

function policy(overrides = {}) {
  return { windowDays: 1, minimumRuns: 5, availabilityTarget: 0.8, latencyP95Ms: 5000, ...overrides };
}

test("SLO-01: politika varsayilanlari ve gecersiz deger reddi", () => {
  assert.deepEqual(normalizeSloPolicy(undefined), defaultSloPolicy);
  assert.throws(() => normalizeSloPolicy({ windowDays: 0 }), /invalid SLO policy/);
  assert.throws(() => normalizeSloPolicy({ availabilityTarget: 1.5 }), /invalid SLO policy/);
  assert.throws(() => normalizeSloPolicy({ minimumRuns: -1 }), /invalid SLO policy/);
});

test("SLO-02: minimum run altinda yalnizca butce tukenmediyse insufficient_data doner", () => {
  const summary = summarizeSlo([runRecord(1), runRecord(2), runRecord(3), runRecord(4)], policy(), now);
  assert.equal(summary.observedRuns, 4);
  assert.equal(summary.minimumRunsMet, false);
  assert.equal(summary.errorBudget.state, "insufficient_data");
  assert.equal(summary.availabilityRate, 1);
  const exhausted = summarizeSlo([runRecord(1), runRecord(2, "failed"), runRecord(3), runRecord(4)], policy(), now);
  assert.equal(exhausted.errorBudget.state, "exhausted");
  const empty = summarizeSlo([], policy(), now);
  assert.equal(empty.errorBudget.state, "insufficient_data");
  assert.equal(empty.latencyTargetMet, null);
});

test("SLO-03: error budget saglik, uyari ve tukenme durumlarini hesaplar", () => {
  const healthy = summarizeSlo(Array.from({ length: 10 }, (_, index) => runRecord(index + 1)), policy(), now);
  assert.equal(healthy.errorBudget.allowedFailures, 2);
  assert.equal(healthy.errorBudget.consumedFailures, 0);
  assert.equal(healthy.errorBudget.remainingFailures, 2);
  assert.equal(healthy.errorBudget.state, "healthy");

  const warningRuns = [...Array.from({ length: 8 }, (_, index) => runRecord(index + 1)), runRecord(9, "failed"), runRecord(10, "failed")];
  const warning = summarizeSlo(warningRuns, policy(), now);
  assert.equal(warning.errorBudget.consumedRatio, 1);
  assert.equal(warning.errorBudget.state, "warning");

  const exhaustedRuns = [...Array.from({ length: 7 }, (_, index) => runRecord(index + 1)), runRecord(8, "failed"), runRecord(9, "failed"), runRecord(10, "failed")];
  const exhausted = summarizeSlo(exhaustedRuns, policy(), now);
  assert.equal(exhausted.errorBudget.remainingFailures, 0);
  assert.equal(exhausted.errorBudget.state, "exhausted");
});

test("SLO-04: pencere disi ve yapisal kayitlar haric tutulur, p95 hesaplanir", () => {
  const records = [
    runRecord(1, "completed", 1000),
    runRecord(2, "completed", 2000),
    runRecord(3, "completed", 3000),
    runRecord(4, "completed", 4000),
    runRecord(5, "completed", 10000),
    runRecord(60 * 30),
    runRecord(-60, "failed"),
    { recordType: "health_snapshot", recordedAt: new Date(now - 60000).toISOString(), outcomeStatus: "completed" }
  ];
  const summary = summarizeSlo(records, policy(), now);
  assert.equal(summary.observedRuns, 5);
  assert.equal(summary.p95DurationMs, 10000);
  assert.equal(summary.latencyTargetMet, false);
  assert.equal(summarizeSlo(records, policy({ latencyP95Ms: 10000 }), now).latencyTargetMet, true);
});
