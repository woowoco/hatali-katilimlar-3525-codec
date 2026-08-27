import { beforeEach, describe, expect, it } from "vitest";
import {
  appendAudit,
  clearAudit,
  clearSession,
  EMPTY_SESSION,
  loadAudit,
  loadSession,
  loadSettings,
  saveSession,
  saveSettings,
} from "../lib/store.js";
import { DEFAULT_SETTINGS } from "../types.js";
import { createChromeStorage, installChromeMock } from "./chrome-mock.js";

describe("extension storage", () => {
  beforeEach(() => {
    installChromeMock().__clear();
  });

  it("loadSettings returns defaults when nothing is stored", async () => {
    const s = await loadSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it("saveSettings + loadSettings round-trip", async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, sessionId: "abc123", model: "abc-m3" });
    const s = await loadSettings();
    expect(s.sessionId).toBe("abc123");
    expect(s.model).toBe("abc-m3");
  });

  it("loadSession returns EMPTY_SESSION when nothing is stored", async () => {
    const s = await loadSession();
    expect(s).toEqual(EMPTY_SESSION);
  });

  it("saveSession + loadSession round-trip", async () => {
    const session = {
      ...EMPTY_SESSION,
      customers: [{ name: "A", acntEuId: "a-uuid" }],
      items: [{ transactionId: 1 } as never],
      chargedIds: [1, 2, 3],
      firmOverrides: {
        iptal: { accountEuId: "a-uuid", accountName: "A" },
      },
    };
    await saveSession(session);
    const re = await loadSession();
    expect(re.customers[0].acntEuId).toBe("a-uuid");
    expect(re.chargedIds).toEqual([1, 2, 3]);
    expect(re.firmOverrides.iptal.accountEuId).toBe("a-uuid");
  });

  it("clearSession clears only the session key, not settings or audit", async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, sessionId: "x" });
    await saveSession({ ...EMPTY_SESSION, chargedIds: [9] });
    await appendAudit({
      transactionId: 9,
      accountEuId: "a",
      accountName: "A",
      transactionIds: [9],
      status: "success",
      resultCode: 0,
      resultDetails: "ok",
      sentAt: new Date().toISOString(),
    });
    await clearSession();
    expect((await loadSession()).chargedIds).toEqual([]);
    expect((await loadSettings()).sessionId).toBe("x");
    expect((await loadAudit()).length).toBe(1);
  });

  it("appendAudit appends and trims to 5000 entries", async () => {
    for (let i = 0; i < 5005; i++) {
      await appendAudit({
        transactionId: i,
        accountEuId: "a",
        accountName: null,
        transactionIds: [i],
        status: "success",
        resultCode: 0,
        resultDetails: "",
        sentAt: new Date().toISOString(),
      });
    }
    const log = await loadAudit();
    expect(log.length).toBe(5000);
    expect(log[0].transactionId).toBe(5);
    expect(log[log.length - 1].transactionId).toBe(5004);
  });

  it("clearAudit wipes the log", async () => {
    await appendAudit({
      transactionId: 1,
      accountEuId: "a",
      accountName: null,
      transactionIds: [1],
      status: "success",
      resultCode: 0,
      resultDetails: "",
      sentAt: new Date().toISOString(),
    });
    await clearAudit();
    expect(await loadAudit()).toEqual([]);
  });
});

describe("storage internals", () => {
  it("createChromeStorage get/set/remove behaviour", async () => {
    const s = createChromeStorage();
    await s.set({ foo: 1, bar: "x" });
    expect(await s.get(["foo"])).toEqual({ foo: 1 });
    expect(await s.get(["foo", "bar"])).toEqual({ foo: 1, bar: "x" });
    expect(await s.get(["missing"])).toEqual({});
    await s.remove("foo");
    expect(await s.get(["foo", "bar"])).toEqual({ bar: "x" });
  });
});
