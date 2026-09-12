import { describe, expect, it } from "vitest";
import { classifyWallet, MAX_WALLETS, parseWallets } from "./wallets";

const EVM = "0xE6b532E63F228087e26a5897131f2e1D043e27f2";
const SOL = "BGjMfx5Bc9647ydxh2WJ1ow5pWZEjanMugTe5snXKY1z";

describe("classifyWallet", () => {
  it("reads an EVM address and lowercases it", () => {
    expect(classifyWallet(EVM)).toEqual({ kind: "evm", value: EVM.toLowerCase() });
  });

  it("keeps a Solana address as it is", () => {
    expect(classifyWallet(SOL)).toEqual({ kind: "solana", value: SOL });
  });

  it("asks for the address instead of an ENS or SNS name", () => {
    expect(classifyWallet("vitalik.eth")).toEqual({
      input: "vitalik.eth",
      error: "Paste the address, not the .eth/.sol name.",
    });
    expect(classifyWallet("toly.SOL")).toMatchObject({ error: "Paste the address, not the .eth/.sol name." });
  });

  it.each([
    "0x1234",
    "0xZZb532E63F228087e26a5897131f2e1D043e27f2",
    "BGjMfx5Bc9647ydxh2WJ1ow5pWZEjanMugTe5snXKY1l0", // l і 0 не входять у base58
    "hello",
  ])("rejects %j", (input) => {
    expect(classifyWallet(input)).toHaveProperty("error");
  });
});

describe("parseWallets", () => {
  it("splits on spaces, commas, semicolons and new lines", () => {
    const { wallets, errors } = parseWallets(`${EVM},${SOL}\n  0x${"a".repeat(40)} ;`);
    expect(errors).toEqual([]);
    expect(wallets).toEqual([
      { kind: "evm", value: EVM.toLowerCase() },
      { kind: "solana", value: SOL },
      { kind: "evm", value: `0x${"a".repeat(40)}` },
    ]);
  });

  it("keeps each address once, whatever its letter case", () => {
    const { wallets } = parseWallets(`${EVM} ${EVM.toLowerCase()} ${SOL} ${SOL}`);
    expect(wallets).toHaveLength(2);
  });

  it("reports bad entries next to the good ones", () => {
    const { wallets, errors } = parseWallets(`${EVM} vitalik.eth nonsense`);
    expect(wallets).toHaveLength(1);
    expect(errors.map((e) => e.input)).toEqual(["vitalik.eth", "nonsense"]);
  });

  it("accepts at most the limit and flags the rest", () => {
    const many = Array.from({ length: MAX_WALLETS + 2 }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`);
    const { wallets, errors } = parseWallets(many.join(" "));
    expect(wallets).toHaveLength(MAX_WALLETS);
    expect(errors).toHaveLength(2);
    expect(errors[0].error).toMatch(/up to/);
  });

  it("returns nothing for an empty field", () => {
    expect(parseWallets("  \n ")).toEqual({ wallets: [], errors: [] });
  });
});
