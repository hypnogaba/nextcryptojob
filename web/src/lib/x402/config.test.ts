import { describe, expect, it } from "vitest";
import { readX402Config, type X402Env } from "./config";

const EVM = "0x1111111111111111111111111111111111111111";
const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const CDP = { CDP_API_KEY_ID: "key-id", CDP_API_KEY_SECRET: "c2VjcmV0LXZhbHVlLW5vdC1yZWFs" };
const PAY_TO = { X402_PAY_TO_EVM: EVM, X402_PAY_TO_SOLANA: SOL };

describe("production", () => {
  it("with CDP keys and both addresses accepts USDC on Base and Solana mainnet through CDP", () => {
    const config = readX402Config({ ...CDP, ...PAY_TO }, "production");
    expect(config.enabled).toBe(true);
    if (!config.enabled) return;
    expect(config.mode).toBe("mainnet");
    expect(config.facilitator).toMatchObject({ kind: "cdp", url: "https://api.cdp.coinbase.com/platform/v2/x402" });
    expect(config.networks).toEqual([
      {
        network: "eip155:8453",
        family: "evm",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: EVM,
        extra: { name: "USD Coin", version: "2" },
      },
      {
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        family: "svm",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        payTo: SOL,
        extra: {},
      },
    ]);
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

  it("without a pay-to address turns x402 off", () => {
    const config = readX402Config({ ...CDP, X402_PAY_TO_EVM: EVM }, "production");
    expect(config).toMatchObject({ enabled: false, reason: "not configured: X402_PAY_TO_SOLANA" });
  });

  it("rejects a malformed pay-to address instead of sending money to it", () => {
    const config = readX402Config({ ...CDP, X402_PAY_TO_EVM: "0x1234", X402_PAY_TO_SOLANA: SOL }, "production");
    expect(config).toMatchObject({ enabled: false, missing: ["X402_PAY_TO_EVM"] });
  });

  it("with CDP keys and X402_NETWORK=testnet uses the test networks through CDP", () => {
    const config = readX402Config({ ...CDP, ...PAY_TO, X402_NETWORK: "testnet" }, "production");
    if (!config.enabled) throw new Error("expected enabled");
    expect(config.facilitator.kind).toBe("cdp");
    expect(config.networks.map((n) => n.network)).toEqual(["eip155:84532", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"]);
  });
});

describe("development", () => {
  it("without CDP keys uses the test networks through x402.org", () => {
    const config = readX402Config({ ...PAY_TO }, "development");
    if (!config.enabled) throw new Error(`expected enabled, got ${config.reason}`);
    expect(config.mode).toBe("testnet");
    expect(config.facilitator).toEqual({ kind: "x402org", url: "https://x402.org/facilitator" });
    expect(config.facilitator.auth).toBeUndefined();
    expect(config.networks).toEqual([
      {
        network: "eip155:84532",
        family: "evm",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: EVM,
        extra: { name: "USDC", version: "2" },
      },
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

  it("still needs pay-to addresses", () => {
    const config = readX402Config({}, "development");
    expect(config).toMatchObject({ enabled: false, reason: "not configured: X402_PAY_TO_EVM, X402_PAY_TO_SOLANA" });
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
