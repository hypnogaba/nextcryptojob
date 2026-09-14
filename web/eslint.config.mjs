import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// База вакансій (JOBS_DB) належить сканеру engine: сайт лише читає, і лише
// через src/lib/jobs-db.ts, який пропускає одну інструкцію SELECT/WITH.
const JOBS_DB_MESSAGE =
  "Use jobsDb() from @/lib/jobs-db: JOBS_DB is read-only and only that module may touch it.";
const JOBS_DB_RULE = [
  "error",
  { selector: "MemberExpression[property.name='JOBS_DB']", message: JOBS_DB_MESSAGE },
  { selector: "MemberExpression[property.value='JOBS_DB']", message: JOBS_DB_MESSAGE },
  { selector: "Property[key.name='JOBS_DB']", message: JOBS_DB_MESSAGE },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    ".open-next/**",
    ".wrangler/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "cloudflare-env.d.ts",
  ]),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
      "no-restricted-syntax": JOBS_DB_RULE,
    },
  },
  {
    files: ["src/lib/jobs-db.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
]);

export default eslintConfig;
