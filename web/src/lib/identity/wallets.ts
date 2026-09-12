// Гаманці з одного поля: одна чи кілька адрес через пробіли, коми чи рядки.
// Тип визначаємо самі (docs/contracts.md, §2): 0x + 40 hex → evm (нижній
// регістр), base58 32–44 → solana (як є). ENS і SNS у релізі 1 не розвʼязуємо.

export const MAX_WALLETS = 10;

export type WalletKind = "evm" | "solana";
export type Wallet = { kind: WalletKind; value: string };
export type WalletError = { input: string; error: string };
export type ParsedWallets = { wallets: Wallet[]; errors: WalletError[] };

const EVM = /^0x[0-9a-fA-F]{40}$/;
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NAME = /\.(eth|sol)$/i;

/** Одна адреса: тип і нормалізоване значення або причина. */
export function classifyWallet(token: string): Wallet | WalletError {
  const input = token.trim();
  if (EVM.test(input)) return { kind: "evm", value: input.toLowerCase() };
  if (SOLANA.test(input)) return { kind: "solana", value: input };
  if (NAME.test(input)) return { input, error: "Paste the address, not the .eth/.sol name." };
  if (/^0x/i.test(input)) return { input, error: "An EVM address is 0x and 40 hex characters." };
  return { input, error: "This is not an EVM or Solana address." };
}

/**
 * Розбирає вставлений текст. Повтори (зокрема та сама EVM-адреса в різному
 * регістрі) лишаються один раз. Понад MAX_WALLETS адрес дає помилку на зайві.
 */
export function parseWallets(text: string): ParsedWallets {
  const wallets: Wallet[] = [];
  const errors: WalletError[] = [];
  const seen = new Set<string>();
  for (const token of (text ?? "").split(/[\s,;]+/).filter(Boolean)) {
    const result = classifyWallet(token);
    if ("error" in result) {
      errors.push(result);
      continue;
    }
    const key = `${result.kind}:${result.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (wallets.length >= MAX_WALLETS) {
      errors.push({ input: token, error: `You can add up to ${MAX_WALLETS} addresses.` });
      continue;
    }
    wallets.push(result);
  }
  return { wallets, errors };
}

/** Коротко для показу: 0x1234…abcd. */
export function shortAddress(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}
