import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const probeSource = source.slice(source.indexOf("async function checkOnce("), source.indexOf("// The kill-switch state"));
const servicesSource = source.slice(source.indexOf("const SERVICES ="), source.indexOf("const STATE_URL"));

function probe(fetch) {
  const context = vm.createContext({ fetch, Date, AbortSignal, TIMEOUT_MS: 8_000 });
  vm.runInContext(`${servicesSource}\n${probeSource}\nglobalThis.check = checkOnce; globalThis.services = SERVICES;`, context);
  return context;
}

const health = (storage = "operational") => ({ services: [
  { id: "app", status: "operational" },
  { id: "storage", status: storage },
] });

test("4dots probes its public status endpoint and accepts healthy app and storage", async () => {
  const ctx = probe(async (url, init) => {
    assert.equal(url, "https://4dots.app/api/status");
    assert.equal(init.redirect, "manual");
    return Response.json(health());
  });
  const svc = ctx.services.find((s) => s.id === "4dots");
  assert.equal(svc.gate, undefined);
  assert.equal((await ctx.check({}, svc)).ok, true);
});

for (const [name, body] of [
  ["storage down", health("down")],
  ["storage degraded", health("degraded")],
  ["app down", { services: [{ id: "app", status: "down" }, { id: "storage", status: "operational" }] }],
  ["storage missing", { services: [{ id: "app", status: "operational" }] }],
  ["invalid schema", { services: {} }],
]) {
  test(`4dots rejects HTTP 200 with ${name}`, async () => {
    const ctx = probe(async () => Response.json(body));
    const result = await ctx.check({}, ctx.services.find((s) => s.id === "4dots"));
    assert.equal(result.ok, false);
    assert.equal(result.code, 200);
  });
}

for (const [name, fetch] of [
  ["invalid JSON", async () => new Response("not JSON")],
  ["HTTP failure", async () => new Response("Unavailable", { status: 503 })],
  ["redirect", async () => new Response(null, { status: 302 })],
  ["network failure", async () => { throw new TypeError("Network error"); }],
]) {
  test(`4dots rejects ${name}`, async () => {
    const ctx = probe(fetch);
    assert.equal((await ctx.check({}, ctx.services.find((s) => s.id === "4dots"))).ok, false);
  });
}

test("existing probes still accept HTTP 200 and ping their database", async () => {
  let reads = 0;
  const ctx = probe(async () => new Response("healthy"));
  const env = { MAIL_DB: { prepare(sql) {
    assert.equal(sql, "SELECT 1");
    return { async first() { reads++; } };
  } } };
  assert.equal((await ctx.check(env, ctx.services.find((s) => s.id === "mail"))).ok, true);
  assert.equal(reads, 1);
  assert.equal((await ctx.check({}, ctx.services.find((s) => s.id === "loopwright"))).ok, true);
});
