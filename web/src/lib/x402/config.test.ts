import { afterEach, describe, expect, it, vi } from "vitest";
import { readX402Config, resetConfigWarnings, type X402Env } from "./config";

const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const CDP = { CDP_API_KEY_ID: "key-id", CDP_API_KEY_SECRET: "c2VjcmV0LXZhbHVlLW5vdC1yZWFs" };
const PAY_TO = { X402_PAY_TO_SOLANA: SOL };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("production", () => {
  it("with CDP keys and a Solana address accepts USDC on Solana mainnet through CDP (п.8: лише Solana)", () => {
    const config = readX402Config({ ...CDP, ...PAY_TO }, "production");
    expect(config.enabled).toBe(true);
    if (!config.enabled) return;
    expect(config.mode).toBe("mainnet");
    expect(config.facilitator).toMatchObject({ kind: "cdp", url: "https://api.cdp.coinbase.com/platform/v2/x402" });
    expect(config.networks).toEqual([
      {
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        family: "svm",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        payTo: SOL,
        extra: {},
      },
    ]);
  });

  it("an X402_PAY_TO_EVM left over in the environment is ignored, not required and not offered", () => {
    const config = readX402Config({ ...CDP, ...PAY_TO, X402_PAY_TO_EVM: "0x1111111111111111111111111111111111111111" }, "production");
    expect(config.enabled).toBe(true);
    if (!config.enabled) return;
    expect(config.networks.map((n) => n.family)).toEqual(["svm"]);
  });

  it("keeps the CDP secret usable but out of JSON and logs", () => {
    const config = readX402Config({ ...CDP, ...PAY_TO }, "production");
    if (!config.enabled) throw new Error("expected enabled");
    expect(config.facilitator.auth).toEqual({ apiKeyId: "key-id", apiKeySecret: CDP.CDP_API_KEY_SECRET });
    expect(JSON.stringify(config)).not.toContain(CDP.CDP_API_KEY_SECRET);
  });

  it("without CDP keys turns x402 off and names what is missing", () => {
    const config = readX402Config({ ...PAY_TO }, "production");
    expect(config).toMatchObject({
      enabled: false,
      reason: "not configured: CDP_API_KEY_ID, CDP_API_KEY_SECRET",
      missing: ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET"],
      networks: [],
      facilitator: null,
    });
  });

  it("without CDP keys stays off even when the test network is chosen", () => {
    const config = readX402Config({ ...PAY_TO, X402_NETWORK: "testnet" }, "production");
    expect(config.enabled).toBe(false);
  });

  it("with only the key id reports the missing secret", () => {
    const config = readX402Config({ ...PAY_TO, CDP_API_KEY_ID: "key-id" }, "production");
    expect(config).toMatchObject({ enabled: false, reason: "not configured: CDP_API_KEY_SECRET" });
  });

  it("without a Solana pay-to address turns x402 off", () => {
    const config = readX402Config({ ...CDP }, "production");
    expect(config).toMatchObject({ enabled: false, reason: "not configured: X402_PAY_TO_SOLANA" });
  });

  it("rejects a malformed pay-to address instead of sending money to it", () => {
    const config = readX402Config({ ...CDP, X402_PAY_TO_SOLANA: "not-an-address" }, "production");
    expect(config).toMatchObject({ enabled: false, missing: ["X402_PAY_TO_SOLANA"] });
  });

  it("with CDP keys and X402_NETWORK=testnet uses the test network through CDP, and warns loudly once", () => {
    resetConfigWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    readX402Config({ ...CDP, ...PAY_TO, X402_NETWORK: "testnet" }, "production");
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toMatch(/production.*test network/i);
    const config = readX402Config({ ...CDP, ...PAY_TO, X402_NETWORK: "testnet" }, "production");
    expect(warn).toHaveBeenCalledOnce(); // раз на ізолят, не на кожен запит
    if (!config.enabled) throw new Error("expected enabled");
    expect(config.facilitator.kind).toBe("cdp");
    expect(config.networks.map((n) => n.network)).toEqual(["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"]);
  });
});

describe("development", () => {
  it("does not warn about test networks outside production", () => {
    resetConfigWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    readX402Config({ ...PAY_TO }, "development");
    expect(warn).not.toHaveBeenCalled();
  });

  it("without CDP keys uses the test network through x402.org", () => {
    const config = readX402Config({ ...PAY_TO }, "development");
    if (!config.enabled) throw new Error(`expected enabled, got ${config.reason}`);
    expect(config.mode).toBe("testnet");
    expect(config.facilitator).toEqual({ kind: "x402org", url: "https://x402.org/facilitator" });
    expect(config.facilitator.auth).toBeUndefined();
    expect(config.networks).toEqual([
      {
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        family: "svm",
        asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        payTo: SOL,
        extra: {},
      },
    ]);
  });

  it("refuses mainnet without CDP keys, because x402.org serves test networks only", () => {
    const config = readX402Config({ ...PAY_TO, X402_NETWORK: "mainnet" }, "development");
    expect(config).toMatchObject({ enabled: false, reason: "not configured: CDP_API_KEY_ID, CDP_API_KEY_SECRET" });
  });

  it("still needs a pay-to address", () => {
    const config = readX402Config({}, "development");
    expect(config).toMatchObject({ enabled: false, reason: "not configured: X402_PAY_TO_SOLANA" });
  });
});

describe("X402_NETWORK", () => {
  it.each<[string, "mainnet" | "testnet"]>([
    ["mainnet", "mainnet"],
    ["base", "mainnet"],
    ["solana", "mainnet"],
    [" Testnet ", "testnet"],
    ["base-sepolia", "testnet"],
    ["solana-devnet", "testnet"],
  ])("%s means %s", (value, mode) => {
    const env: X402Env = { ...CDP, ...PAY_TO, X402_NETWORK: value };
    const config = readX402Config(env, "production");
    expect(config.enabled && config.mode).toBe(mode);
  });

  it("an unknown value turns x402 off instead of guessing", () => {
    const config = readX402Config({ ...CDP, ...PAY_TO, X402_NETWORK: "sepolia" }, "production");
    expect(config).toMatchObject({ enabled: false, missing: ["X402_NETWORK"] });
  });
});
