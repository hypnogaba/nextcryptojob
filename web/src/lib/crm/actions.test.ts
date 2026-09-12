import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ACTIONS, getAction } from "./actions";
import { can } from "./permissions";

/**
 * Паритет реєстру дій з договором API (docs/api/mcp-tools.md, розділ 5):
 * назви, REST (метод, шлях, операція), ціни x402, поля входу, анотації MCP.
 * Реєстр один на інтерфейс, REST і MCP, тож розійтися з договором він може
 * лише тут, і тест це ловить.
 */

const root = new URL("../../../../docs/api/", import.meta.url);
const openapi = parse(readFileSync(new URL("openapi.yaml", root), "utf8")) as OpenApi;
const mcpTools = readFileSync(new URL("mcp-tools.md", root), "utf8");

type Schema = {
  $ref?: string;
  allOf?: Schema[];
  properties?: Record<string, unknown>;
  required?: string[];
};
type Parameter = { $ref?: string; name: string; in: string; required?: boolean };
type Operation = {
  operationId: string;
  "x-mcp-tool"?: string;
  "x-x402-price-usd"?: string;
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content: { "application/json": { schema: Schema } } };
  responses: Record<string, unknown>;
};
type OpenApi = {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema>; parameters: Record<string, Parameter> };
};

function deref<T>(node: T & { $ref?: string }): T {
  if (!node.$ref) return node;
  const [, , section, name] = node.$ref.split("/");
  return (openapi.components as unknown as Record<string, Record<string, T>>)[section][name];
}

/** Властивості й обов'язкові поля схеми з урахуванням $ref і allOf. */
function flatten(schema: Schema): { properties: Set<string>; required: Set<string> } {
  const s = deref(schema);
  const properties = new Set(Object.keys(s.properties ?? {}));
  const required = new Set(s.required ?? []);
  for (const part of s.allOf ?? []) {
    const f = flatten(part);
    f.properties.forEach((p) => properties.add(p));
    f.required.forEach((r) => required.add(r));
  }
  return { properties, required };
}

interface Op {
  method: string;
  path: string;
  op: Operation;
}

const operations: Op[] = Object.entries(openapi.paths).flatMap(([path, methods]) =>
  Object.entries(methods)
    .filter(([m]) => ["get", "post", "put", "patch", "delete"].includes(m))
    .map(([m, op]) => ({ method: m.toUpperCase(), path, op })),
);
const byTool = new Map(operations.map((o) => [o.op["x-mcp-tool"], o]));

/** Інструменти з розділу 4 mcp-tools.md з їхнім REST (метод + шлях з {} замість назв параметрів). */
function mdTools(): Map<string, string> {
  const section = mcpTools.slice(mcpTools.indexOf("## 4."), mcpTools.indexOf("## 5."));
  const out = new Map<string, string>();
  const norm = (path: string) => path.replace(/\{[^}]+\}/g, "{}");
  for (const m of section.matchAll(/^\| `([a-z_]+)` \| `(GET|POST|PUT|PATCH|DELETE) ([^`]+)` \|/gm)) out.set(m[1], `${m[2]} ${norm(m[3])}`);
  for (const m of section.matchAll(/\*\*`([a-z_]+)`\*\* → `(GET|POST|PUT|PATCH|DELETE) ([^`]+)`/g)) out.set(m[1], `${m[2]} ${norm(m[3])}`);
  return out;
}

const names = ACTIONS.map((a) => a.name);

describe("action registry parity with the API contract", () => {
  it("has exactly the 28 operations of openapi.yaml and the 28 tools of mcp-tools.md", () => {
    const openapiTools = operations.map((o) => o.op["x-mcp-tool"]);
    expect(names).toHaveLength(28);
    expect(new Set(names).size).toBe(28);
    expect([...names].sort()).toEqual([...openapiTools].sort());
    expect([...names].sort()).toEqual([...mdTools().keys()].sort());
    for (const a of ACTIONS) expect(a.mcp.tool).toBe(a.name);
  });

  it("uses the same REST method, path and operationId", () => {
    const md = mdTools();
    for (const a of ACTIONS) {
      const o = byTool.get(a.name)!;
      expect({ tool: a.name, method: a.rest.method, path: a.rest.path, operationId: a.rest.operationId }).toEqual({
        tool: a.name,
        method: o.method,
        path: o.path,
        operationId: o.op.operationId,
      });
      expect(md.get(a.name)).toBe(`${a.rest.method} ${a.rest.path.replace(/\{[^}]+\}/g, "{}")}`);
      const success = Object.keys(o.op.responses).filter((c) => /^2\d\d$/.test(c));
      expect(success).toContain(String(a.rest.status));
    }
  });

  it("charges the x402 prices of openapi.yaml, and nothing else is paid", () => {
    for (const a of ACTIONS) {
      const price = "price" in a && a.price ? a.price.usd : undefined;
      expect({ tool: a.name, price }).toEqual({ tool: a.name, price: byTool.get(a.name)!.op["x-x402-price-usd"] });
    }
  });

  it("takes as input the path parameters, query parameters and body fields of the operation, merged", () => {
    for (const a of ACTIONS) {
      const o = byTool.get(a.name)!;
      const params = (o.op.parameters ?? []).map((p) => deref<Parameter>(p));
      const body = o.op.requestBody ? flatten(o.op.requestBody.content["application/json"].schema) : null;
      const expected = {
        properties: [...params.map((p) => p.name), ...(body?.properties ?? [])].sort(),
        required: [
          ...params.filter((p) => p.required).map((p) => p.name),
          ...(o.op.requestBody?.required ? (body?.required ?? []) : []),
        ].sort(),
      };
      const json = z.toJSONSchema(a.input, { io: "input" }) as { properties?: object; required?: string[] };
      const actual = { properties: Object.keys(json.properties ?? {}).sort(), required: [...(json.required ?? [])].sort() };
      expect({ tool: a.name, ...actual }).toEqual({ tool: a.name, ...expected });
    }
  });

  it("marks MCP tools as mcp-tools.md section 3 says", () => {
    const flagged = (key: "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint") =>
      ACTIONS.filter((a) => (a.mcp.annotations as Record<string, boolean | undefined>)[key]).map((a) => a.name).sort();
    expect(flagged("destructiveHint")).toEqual(["cancel_intro", "close_job", "delete_saved_search", "remove_from_pipeline"]);
    expect(flagged("idempotentHint")).toEqual(["add_to_pipeline", "set_webhook"]);
    expect(flagged("openWorldHint")).toEqual(["request_intro"]);
    // Читання = GET, плюс пошук (POST лише заради тіла запиту).
    const reads = ACTIONS.filter((a) => a.rest.method === "GET" || a.name === "search_candidates").map((a) => a.name).sort();
    expect(flagged("readOnlyHint")).toEqual(reads);
  });

  it("without a key only search_jobs (free) and search_candidates (x402) are available", () => {
    const open = ACTIONS.filter((a) => a.permission === "public" || can("x402_guest", a.permission)).map((a) => a.name);
    expect(open.sort()).toEqual(["search_candidates", "search_jobs"]);
  });

  it("every action on a candidate writes the audit log", () => {
    for (const a of ACTIONS) {
      if ("touchesCandidate" in a && a.touchesCandidate) expect({ tool: a.name, audit: a.audit }).toMatchObject({ audit: expect.any(String) });
    }
    // Спершу за 5.1: пошук, профіль, воронка, знайомства.
    const touching = ACTIONS.filter((a) => "touchesCandidate" in a && a.touchesCandidate).map((a) => a.name).sort();
    expect(touching).toEqual(
      ["add_note", "add_to_pipeline", "cancel_intro", "get_candidate", "remove_from_pipeline", "request_intro", "search_candidates", "update_stage"],
    );
  });

  it("looks actions up by name", () => {
    expect(getAction("search_candidates")?.rest.path).toBe("/candidates/search");
    expect(getAction("nope")).toBeUndefined();
  });
});
