import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  builtinMemoryConsumptionProfiles,
  memoryConsumptionProfileNames,
  memoryProfileCeilings,
  resolveMemoryConsumptionProfile
} from "../subagent-bridge/src/services/memory-profile.js";
import { createMemoryHook, memoryHookMaxContextChars, memoryHookMaxResults } from "../subagent-bridge/src/services/memory-hook.js";
import { validateConfiguration } from "../subagent-bridge/src/config.js";

function withoutEnvironmentProfile(callback) {
  const previous = process.env.SUBAGENT_MEMORY_PROFILE;
  delete process.env.SUBAGENT_MEMORY_PROFILE;
  try {
    return callback();
  } finally {
    if (previous === undefined) delete process.env.SUBAGENT_MEMORY_PROFILE;
    else process.env.SUBAGENT_MEMORY_PROFILE = previous;
  }
}

test("PROF-01: yerleşik tüketim profilleri ve tavanlar sabittir", () => {
  assert.deepEqual(memoryConsumptionProfileNames, ["normal", "economic", "manual"]);
  assert.deepEqual(memoryProfileCeilings, { maxResults: 5, maxContextChars: 1200 });
  assert.equal(memoryHookMaxResults, 5);
  assert.equal(memoryHookMaxContextChars, 1200);
  assert.deepEqual(builtinMemoryConsumptionProfiles.normal, {
    autoRetrieval: true,
    maxResults: 5,
    maxContextChars: 1200,
    healthCheckIntervalMinutes: 60
  });
  assert.deepEqual(builtinMemoryConsumptionProfiles.economic, {
    autoRetrieval: true,
    maxResults: 2,
    maxContextChars: 600,
    healthCheckIntervalMinutes: 240
  });
  assert.deepEqual(builtinMemoryConsumptionProfiles.manual, {
    autoRetrieval: false,
    maxResults: 5,
    maxContextChars: 1200,
    healthCheckIntervalMinutes: 1440
  });
  assert.equal(Object.isFrozen(builtinMemoryConsumptionProfiles.manual), true);
});

test("PROF-02: öncelik sırası zorunlu politika, kullanıcı tercihi, istemci varsayılanıdır", () => {
  withoutEnvironmentProfile(() => {
    const policyWins = resolveMemoryConsumptionProfile({
      configuration: { memory: { activeProfile: "economic" } },
      userPreference: "manual",
      clientDefault: "normal"
    });
    assert.equal(policyWins.name, "economic");
    assert.equal(policyWins.source, "policy");
    const userWins = resolveMemoryConsumptionProfile({ configuration: { memory: {} }, userPreference: "manual", clientDefault: "normal" });
    assert.equal(userWins.name, "manual");
    assert.equal(userWins.source, "user");
    process.env.SUBAGENT_MEMORY_PROFILE = "economic";
    const environmentWins = resolveMemoryConsumptionProfile({ configuration: { memory: {} } });
    assert.equal(environmentWins.name, "economic");
    assert.equal(environmentWins.source, "environment");
    delete process.env.SUBAGENT_MEMORY_PROFILE;
    const clientWins = resolveMemoryConsumptionProfile({ configuration: { memory: {} }, clientDefault: "economic" });
    assert.equal(clientWins.name, "economic");
    assert.equal(clientWins.source, "client");
    const fallback = resolveMemoryConsumptionProfile({ configuration: { memory: {} } });
    assert.equal(fallback.name, "normal");
    assert.equal(fallback.source, "default");
  });
});

test("PROF-03: geçersiz profil ve güvenlik alanı geçersiz kılma fail-closed olur", () => {
  withoutEnvironmentProfile(() => {
    assert.throws(
      () => resolveMemoryConsumptionProfile({ configuration: { memory: { activeProfile: "aggressive" } } }),
      /Unknown memory consumption profile/
    );
    assert.throws(
      () => resolveMemoryConsumptionProfile({
        configuration: { memory: { consumptionProfiles: { normal: { allowedWriteFolders: ["00_Inbox"] } } } }
      }),
      /cannot override security field/
    );
  });
  const raw = JSON.parse(fs.readFileSync("config/policy.json", "utf8"));
  assert.equal(validateConfiguration(raw).success, true);
  const invalidProfile = structuredClone(raw);
  invalidProfile.memory.activeProfile = "aggressive";
  assert.equal(validateConfiguration(invalidProfile).success, false);
  const securityOverride = structuredClone(raw);
  securityOverride.memory.consumptionProfiles.normal.allowedWriteFolders = ["00_Inbox"];
  assert.equal(validateConfiguration(securityOverride).success, false);
  const overCeiling = structuredClone(raw);
  overCeiling.memory.consumptionProfiles.normal.maxResults = 100;
  assert.equal(validateConfiguration(overCeiling).success, false);
  const overBudget = structuredClone(raw);
  overBudget.memory.consumptionProfiles.economic.maxContextChars = 5000;
  assert.equal(validateConfiguration(overBudget).success, false);
});

test("PROF-04: profil tavanı aşamaz ve retrieval güvenlik invariantları değişmez", async () => {
  const limited = resolveMemoryConsumptionProfile({
    configuration: { memory: { consumptionProfiles: { normal: { maxResults: 100, maxContextChars: 99999 } } } }
  });
  assert.equal(limited.maxResults, 5);
  assert.equal(limited.maxContextChars, 1200);
  const calls = [];
  const search = (configuration, request) => {
    calls.push(request);
    return { matches: [] };
  };
  for (const profileName of ["normal", "economic", "manual"]) {
    const hook = createMemoryHook({ configurationLoader: () => ({ memory: {} }), search, userPreference: profileName });
    await hook({ query: "ikinci beyin" });
  }
  assert.equal(calls.length, 2);
  for (const request of calls) {
    assert.equal(request.includeDrafts, false);
    assert.equal(request.includeExpired, false);
    assert.ok(request.limit <= 5);
  }
  assert.deepEqual(calls.map((request) => request.limit), [5, 2]);
});

test("PROF-05: hook manuel profilde boş döner ve aramayı çağırmaz", async () => {
  const calls = [];
  const search = (configuration, request) => {
    calls.push(request);
    return { matches: [{ relativePath: "01_Projects/not.md", excerpt: "içerik" }] };
  };
  const manualHook = createMemoryHook({ configurationLoader: () => ({ memory: {} }), search, userPreference: "manual" });
  assert.equal(await manualHook({ query: "ikinci beyin" }), "");
  assert.equal(calls.length, 0);
  const economicHook = createMemoryHook({ configurationLoader: () => ({ memory: {} }), search, userPreference: "economic" });
  const context = await economicHook({ query: "ikinci beyin" });
  assert.ok(context.length > 0);
  assert.ok(context.length <= 600);
  assert.deepEqual(calls.map((request) => request.limit), [2]);
});

test("PROF-06: manual profil override ile otomatik retrieval açamaz", () => {
  const overridden = resolveMemoryConsumptionProfile({
    configuration: { memory: { consumptionProfiles: { manual: { autoRetrieval: true, maxResults: 1 } } } },
    userPreference: "manual"
  });
  assert.equal(overridden.autoRetrieval, false);
  assert.equal(overridden.maxResults, 1);
  const raw = JSON.parse(fs.readFileSync("config/policy.json", "utf8"));
  const schemaValid = structuredClone(raw);
  schemaValid.memory.consumptionProfiles.manual.autoRetrieval = true;
  assert.equal(validateConfiguration(schemaValid).success, true);
});
