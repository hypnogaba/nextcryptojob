// Відомі пари «компанія → монета CoinGecko», задані руками (jobs-tokens, src/jobs/tokens.ts). Пара звідси
// переважує пошук: її не треба підтверджувати доменом (у Jupiter сайт монети порожній, Offchain Labs і
// Arbitrum мають різні домени). `coingeckoId: null` = у компанії токена немає (акція чи нічого), пошук її
// не зіставляє ніколи. Кожен id перевірено живим запитом /coins/{id} 14.09.2026; jobs-tokens щотижня
// перевіряє їх знову пакетом /coins/markets і пише в журнал ті, яких CoinGecko більше не знає.
//
// Ключі: `names` у формі companyKey (src/digest/clean.ts: нижній регістр, без розділових знаків і
// «Inc/Ltd»), `domains` як companies.domain. Досить одного збігу.

export interface TokenOverride {
  names: readonly string[];
  domains?: readonly string[];
  coingeckoId: string | null;
  /** Тікер для рядка «$ARB …»; null разом з coingeckoId. */
  symbol: string | null;
  /** Чому так (для людини, що читає файл). */
  note?: string;
}

export const TOKEN_OVERRIDES: readonly TokenOverride[] = [
  { names: ["aave", "aave labs", "avara"], domains: ["aave.com"], coingeckoId: "aave", symbol: "AAVE" },
  { names: ["uniswap", "uniswap labs", "uniswap foundation"], domains: ["uniswap.org"], coingeckoId: "uniswap", symbol: "UNI" },
  { names: ["arbitrum", "arbitrum foundation", "offchain labs"], domains: ["arbitrum.io", "arbitrum.foundation", "offchainlabs.com"],
    coingeckoId: "arbitrum", symbol: "ARB", note: "Offchain Labs builds Arbitrum" },
  { names: ["solana", "solana foundation", "solana labs"], domains: ["solana.com", "solana.org", "solanalabs.com"], coingeckoId: "solana", symbol: "SOL" },
  { names: ["jupiter", "jupiter exchange", "jupiter labs"], domains: ["jup.ag"], coingeckoId: "jupiter-exchange-solana", symbol: "JUP",
    note: "the coin page lists no homepage, so a domain match is impossible" },
  { names: ["chainlink", "chainlink labs", "chainlink foundation"], domains: ["chain.link", "chainlinklabs.com"], coingeckoId: "chainlink", symbol: "LINK" },
  { names: ["optimism", "optimism foundation", "op labs"], domains: ["optimism.io", "oplabs.co"], coingeckoId: "optimism", symbol: "OP" },
  { names: ["polygon", "polygon labs", "polygon foundation"], domains: ["polygon.technology"], coingeckoId: "polygon-ecosystem-token", symbol: "POL",
    note: "POL replaced MATIC (matic-network)" },
  { names: ["okx"], domains: ["okx.com"], coingeckoId: "okb", symbol: "OKB" },
  { names: ["binance"], domains: ["binance.com"], coingeckoId: "binancecoin", symbol: "BNB" },
  { names: ["coinbase"], domains: ["coinbase.com"], coingeckoId: null, symbol: null,
    note: "no token: COIN is a stock; coinbase-wrapped-* coins are wrapped assets, not the company's token" },
  { names: ["kraken", "payward"], domains: ["kraken.com"], coingeckoId: null, symbol: null, note: "no token" },
  { names: ["lido", "lido finance", "lido dao"], domains: ["lido.fi"], coingeckoId: "lido-dao", symbol: "LDO" },
  { names: ["eigenlayer", "eigen labs", "eigencloud", "eigen foundation"], domains: ["eigenlayer.xyz", "eigencloud.xyz", "eigenfoundation.org"],
    coingeckoId: "eigenlayer", symbol: "EIGEN" },
  { names: ["wormhole", "wormhole labs", "wormhole foundation"], domains: ["wormhole.com", "wormholelabs.xyz"], coingeckoId: "wormhole", symbol: "W" },
  { names: ["jito", "jito labs", "jito foundation"], domains: ["jito.network", "jito.wtf"], coingeckoId: "jito-governance-token", symbol: "JTO" },
  { names: ["pyth", "pyth network", "douro labs", "pyth data association"], domains: ["pyth.network", "dourolabs.xyz", "dourolabs.app"],
    coingeckoId: "pyth-network", symbol: "PYTH", note: "Douro Labs builds Pyth" },
];
