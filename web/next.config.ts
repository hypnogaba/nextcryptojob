import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import { securityHeaders } from "./src/lib/csp";

// Без цього getCloudflareContext() кидає в `next dev`. У проді це no-op:
// прив'язки D1 і env дає сам Worker.
initOpenNextCloudflareForDev();

const nextConfig: NextConfig = {
  poweredByHeader: false,

  // Інакше `next dev`, помітивши агента, сам створює AGENTS.md і CLAUDE.md у
  // web/: незакомічені файли з довгим тире, яке ламає тест no-em-dash.
  agentRules: false,

  // Заголовки безпеки й CSP живуть у src/lib/csp.ts (там же, як додати джерело).
  headers() {
    return Promise.resolve([{ source: "/:path*", headers: securityHeaders() }]);
  },
};

export default nextConfig;
