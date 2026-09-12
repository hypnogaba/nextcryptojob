import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// Без цього getCloudflareContext() кидає в `next dev`. У проді це no-op:
// прив'язки D1 і env дає сам Worker.
initOpenNextCloudflareForDev();

const nextConfig: NextConfig = {
  output: "standalone",

  // Заголовки безпеки. CSP без nonce: App Router вбудовує скрипти гідрації
  // inline, тож script-src мусить їх пускати. Шрифти next/font віддає з
  // власного домену, тому зовнішніх джерел тут немає.
  headers() {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "upgrade-insecure-requests",
    ].join("; ");
    return Promise.resolve([{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: csp },
        { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      ],
    }]);
  },
};

export default nextConfig;
