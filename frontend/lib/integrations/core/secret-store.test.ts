import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  decryptSecret,
  encryptSecret,
  parseSecretKey,
  resolveSecretStoreKind,
  secretName,
} from "./secret-store";

const KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const KEY_HEX = Buffer.alloc(32, 9).toString("hex");

test("parseSecretKey: accepts base64 and hex 32-byte keys, rejects the rest", () => {
  assert.equal(parseSecretKey(KEY_B64).length, 32);
  assert.equal(parseSecretKey(KEY_HEX).length, 32);
  assert.throws(() => parseSecretKey(undefined));
  assert.throws(() => parseSecretKey("short"));
  assert.throws(() => parseSecretKey(Buffer.alloc(16, 1).toString("base64")));
});

test("encrypt/decrypt round-trips and binds the ciphertext to (slug, kind)", () => {
  const key = parseSecretKey(KEY_B64);
  const doc = { client_id: "abc", client_secret: "s3cret", nested: { n: 1 } };
  const enc = encryptSecret(key, "personio", "credentials", doc);
  assert.notEqual(enc.ciphertext, JSON.stringify(doc));
  assert.deepEqual(decryptSecret(key, "personio", "credentials", enc), doc);
  // Same ciphertext under another row or key must fail authentication.
  assert.throws(() => decryptSecret(key, "awork", "credentials", enc));
  assert.throws(() => decryptSecret(key, "personio", "tokens", enc));
  assert.throws(() => decryptSecret(parseSecretKey(KEY_HEX), "personio", "credentials", enc));
  // Fresh IV per call.
  assert.notEqual(encryptSecret(key, "personio", "credentials", doc).iv, enc.iv);
});

test("secretName: legacy names for the original integrations, prefix for new ones", () => {
  const prev = process.env.DANTE_ENV;
  process.env.DANTE_ENV = "prod";
  try {
    assert.equal(secretName("personio", "credentials"), "dante/prod/personio");
    assert.equal(secretName("awork", "credentials"), "dante/prod/awork/client");
    assert.equal(secretName("awork", "tokens"), "dante/prod/awork/tokens");
    assert.equal(secretName("personio", "tokens"), "dante/prod/integration/personio/tokens");
    assert.equal(secretName("hubspot", "credentials"), "dante/prod/integration/hubspot/credentials");
  } finally {
    if (prev === undefined) delete process.env.DANTE_ENV;
    else process.env.DANTE_ENV = prev;
  }
});

test("resolveSecretStoreKind: explicit > secrets manager flag > key > env", () => {
  const saved = {
    s: process.env.DANTE_SECRET_STORE,
    m: process.env.DANTE_USE_SECRETS_MANAGER,
    k: process.env.DANTE_SECRET_KEY,
  };
  try {
    delete process.env.DANTE_SECRET_STORE;
    delete process.env.DANTE_USE_SECRETS_MANAGER;
    delete process.env.DANTE_SECRET_KEY;
    assert.equal(resolveSecretStoreKind(), "env");
    process.env.DANTE_SECRET_KEY = KEY_B64;
    assert.equal(resolveSecretStoreKind(), "db");
    process.env.DANTE_USE_SECRETS_MANAGER = "1";
    assert.equal(resolveSecretStoreKind(), "secretsmanager");
    process.env.DANTE_SECRET_STORE = "env";
    assert.equal(resolveSecretStoreKind(), "env");
  } finally {
    for (const [k, v] of [
      ["DANTE_SECRET_STORE", saved.s],
      ["DANTE_USE_SECRETS_MANAGER", saved.m],
      ["DANTE_SECRET_KEY", saved.k],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
