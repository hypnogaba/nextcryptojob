import { describe, expect, it } from "vitest";
import { normalizeGithub, normalizeSherlock, normalizeSite, normalizeX, normalizeYoutube } from "./normalize";

const value = (r: ReturnType<typeof normalizeX>) => (r.ok ? r.value : `ERR ${r.error}`);

describe("normalizeX", () => {
  it.each([
    ["zerocool", "zerocool"],
    ["@ZeroCool", "zerocool"],
    ["  @ada_lovelace ", "ada_lovelace"],
    ["https://x.com/ZeroCool", "zerocool"],
    ["x.com/zerocool?s=20", "zerocool"],
    ["https://twitter.com/zerocool/status/1", "zerocool"],
    ["www.twitter.com/Ada", "ada"],
  ])("%j → %j", (input, expected) => {
    expect(value(normalizeX(input))).toBe(expected);
  });

  it.each(["", "@", "has space", "way_too_long_handle_here", "ada!", "https://example.com/ada"])(
    "rejects %j",
    (input) => {
      expect(normalizeX(input).ok).toBe(false);
    },
  );
});

describe("normalizeGithub", () => {
  it.each([
    ["zerocool", "zerocool"],
    ["ZeroCool", "zerocool"],
    ["@ada-l", "ada-l"],
    ["https://github.com/Zerocool", "zerocool"],
    ["github.com/zerocool/some-repo", "zerocool"],
  ])("%j → %j", (input, expected) => {
    expect(value(normalizeGithub(input))).toBe(expected);
  });

  it.each(["", "-ada", "ada-", "a--b", "a_b", "https://gitlab.com/ada"])("rejects %j", (input) => {
    expect(normalizeGithub(input).ok).toBe(false);
  });
});

describe("normalizeYoutube", () => {
  it.each([
    ["@MyChannel", "@mychannel"],
    ["mychannel", "@mychannel"],
    ["https://www.youtube.com/@MyChannel", "@mychannel"],
    ["youtube.com/@my.channel/videos", "@my.channel"],
    ["https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw", "UC_x5XG1OV2P6uZZ5FSM9Ttw"],
    ["UC_x5XG1OV2P6uZZ5FSM9Ttw", "UC_x5XG1OV2P6uZZ5FSM9Ttw"],
  ])("%j → %j", (input, expected) => {
    expect(value(normalizeYoutube(input))).toBe(expected);
  });

  it.each(["", "@ab", "https://www.youtube.com/c/Legacy", "https://youtube.com/user/old", "https://vimeo.com/x"])(
    "rejects %j",
    (input) => {
      expect(normalizeYoutube(input).ok).toBe(false);
    },
  );
});

describe("normalizeSite", () => {
  it.each([
    ["https://zerocool.com", "https://zerocool.com"],
    ["https://ZeroCool.com/", "https://zerocool.com"],
    ["zerocool.com", "https://zerocool.com"],
    ["https://blog.example.org/Posts/", "https://blog.example.org/Posts"],
    ["https://example.org/a?utm=1#top", "https://example.org/a"],
  ])("%j → %j", (input, expected) => {
    expect(value(normalizeSite(input))).toBe(expected);
  });

  it.each([
    "",
    "http://zerocool.com",
    "ftp://example.org",
    "javascript:alert(1)",
    "https://localhost",
    "https://127.0.0.1",
    "https://intranet",
    "https://printer.local",
    "https://user:pass@example.org",
    "https://example.org:8443",
  ])("rejects %j", (input) => {
    expect(normalizeSite(input).ok).toBe(false);
  });
});

describe("normalizeSherlock", () => {
  it.each([
    ["Pashov", "pashov"],
    ["@0x52", "0x52"],
    ["https://audits.sherlock.xyz/watson/Pashov", "pashov"],
  ])("%j → %j", (input, expected) => {
    expect(value(normalizeSherlock(input))).toBe(expected);
  });

  it.each(["", "a b", "-x", "x!"])("rejects %j", (input) => {
    expect(normalizeSherlock(input).ok).toBe(false);
  });
});
