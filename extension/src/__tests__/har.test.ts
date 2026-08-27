import { describe, expect, it } from "vitest";
import { extractSessionFromHar } from "../lib/har.js";

const SAMPLE_HAR = JSON.stringify({
  log: {
    version: "1.2",
    creator: { name: "Chrome", version: "120" },
    entries: [
      {
        request: {
          url: "https://admin-panel-api.codec.com.tr/api/Menu3525/GetCustomersToBeCharged",
          headers: [
            { name: "appid", value: "9398192ec61d422a8331529989959242" },
            { name: "sessionid", value: "7bf829b4-d757-4e4b-9912-7dfcbc5c7c58" },
            { name: "accept", value: "application/json" },
          ],
        },
      },
      {
        request: {
          url: "https://example.com/other",
          headers: [{ name: "sessionid", value: "not-a-uuid" }],
        },
      },
    ],
  },
});

describe("extractSessionFromHar", () => {
  it("finds the first UUID-shaped sessionid header", () => {
    expect(extractSessionFromHar(SAMPLE_HAR)).toBe(
      "7bf829b4-d757-4e4b-9912-7dfcbc5c7c58",
    );
  });

  it("returns undefined when the file is not JSON", () => {
    expect(extractSessionFromHar("not json")).toBeUndefined();
  });

  it("returns undefined when entries are missing", () => {
    expect(extractSessionFromHar(JSON.stringify({ log: {} }))).toBeUndefined();
  });

  it("skips sessionid values that are not UUIDs", () => {
    const har = JSON.stringify({
      log: {
        entries: [
          {
            request: {
              headers: [{ name: "sessionid", value: "garbage" }],
            },
          },
        ],
      },
    });
    expect(extractSessionFromHar(har)).toBeUndefined();
  });

  it("is case-insensitive for the header name", () => {
    const har = JSON.stringify({
      log: {
        entries: [
          {
            request: {
              headers: [
                { name: "SessionId", value: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE" },
              ],
            },
          },
        ],
      },
    });
    expect(extractSessionFromHar(har)).toBe(
      "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    );
  });

  it("returns undefined for empty HAR", () => {
    expect(extractSessionFromHar(JSON.stringify({ log: { entries: [] } }))).toBeUndefined();
  });
});
