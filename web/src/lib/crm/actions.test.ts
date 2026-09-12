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
  [key: string]: unknown;
};
type Parameter = { $ref?: string; name: string; in: string; required?: boolean };
type Operation = {
  operationId: string;
  "x-mcp-tool"?: string;
  "x-x402-price-usd"?: string;
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content: { "application/json": { schema: Schema } } };
  responses: Record<string, { $ref?: string; content?: { "application/json"?: { schema: Schema } } }>;
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

// ---------------------------------------------------------------------------
// Смислове порівняння схем: типи, переліки, межі, обов'язковість, вкладені об'єкти.
//
// Обидві сторони (z.toJSONSchema і розгорнута схема договору) зводяться до
// канонічної форми. Не порівнюємо лише те, чого JSON Schema з zod не виражає або
// що не змінює смислу: описи, приклади, типові значення, discriminator; pattern
// поруч з format (zod додає свій regex до uuid і date-time); межі безпечного
// цілого, які zod ставить до .int(); uniqueItems і minProperties (у zod це
// refine, їх перевіряють поведінкові тести). additionalProperties: false
// порівнюємо лише для входу (вихід zod завжди закритий).

type Json = Record<string, unknown>;
type Canon = Json;
const SAFE = Number.MAX_SAFE_INTEGER;

function canon(node: unknown, resolve: (ref: string) => unknown, input: boolean): Canon {
  let s = node as Json;
  if (s && typeof s.$ref === "string") return canon(resolve(s.$ref), resolve, input);
  if (Array.isArray(s.allOf)) {
    const merged: Json = { type: "object", properties: {}, required: [] };
    for (const part of s.allOf as Json[]) {
      const p = (part.$ref ? resolve(part.$ref as string) : part) as Json;
      const flat = p.allOf ? mergeAllOf(p, resolve) : p;
      Object.assign(merged.properties as Json, flat.properties ?? {});
      (merged.required as string[]).push(...((flat.required as string[]) ?? []));
      if (flat.additionalProperties !== undefined) merged.additionalProperties = flat.additionalProperties;
    }
    s = merged;
  }

  const out: Canon = {};
  let nullable = false;
  const branches = (s.anyOf ?? s.oneOf) as Json[] | undefined;
  if (branches) {
    const real = branches.filter((b) => !(b.type === "null" || (Array.isArray(b.type) && b.type.length === 1 && b.type[0] === "null")));
    nullable = real.length !== branches.length;
    const consts = real.every((b) => "const" in b || (Array.isArray(b.enum) && b.enum.length === 1));
    if (consts && real.length > 0) {
      s = { enum: real.map((b) => ("const" in b ? b.const : (b.enum as unknown[])[0])) };
    } else if (real.length === 1) {
      const inner = canon(real[0], resolve, input);
      return nullable ? { ...inner, nullable: true } : inner;
    } else {
      const list = real.map((b) => canon(b, resolve, input)).sort((a, b) => (stable(a) < stable(b) ? -1 : 1));
      return nullable ? { anyOf: list, nullable: true } : { anyOf: list };
    }
  }

  let types = s.type === undefined ? [] : Array.isArray(s.type) ? [...(s.type as string[])] : [s.type as string];
  if (types.includes("null")) nullable = true;
  types = types.filter((t) => t !== "null");

  let values: unknown[] | undefined = "const" in s ? [s.const] : (s.enum as unknown[] | undefined);
  if (values) {
    if (values.includes(null)) nullable = true;
    values = values.filter((v) => v !== null);
    types = values.every((v) => typeof v === "string") ? ["string"] : values.every((v) => Number.isInteger(v)) ? ["integer"] : types;
    out.enum = [...values].sort();
  }
  if (types.length) out.type = types.sort().join("|");
  if (nullable) out.nullable = true;

  for (const k of ["minimum", "maximum"]) {
    const v = s[k] as number | undefined;
    if (v !== undefined && Math.abs(v) < SAFE) out[k] = v;
  }
  for (const k of ["minLength", "maxLength", "minItems", "maxItems", "format"]) if (s[k] !== undefined) out[k] = s[k];
  if (s.pattern !== undefined && s.format === undefined) out.pattern = s.pattern;
  if (s.items) out.items = canon(s.items, resolve, input);
  if (s.properties) {
    out.properties = Object.fromEntries(
      Object.entries(s.properties as Json).map(([k, v]) => [k, canon(v, resolve, input)]).sort(([a], [b]) => (a < b ? -1 : 1)),
    );
    out.required = [...((s.required as string[]) ?? [])].sort();
  }
  const addl = s.additionalProperties;
  if (addl && typeof addl === "object" && Object.keys(addl).length > 0) out.additionalProperties = canon(addl, resolve, input);
  if (input && addl === false) out.closed = true;
  return out;
}

function mergeAllOf(s: Json, resolve: (ref: string) => unknown): Json {
  const merged: Json = { properties: {}, required: [] };
  for (const part of s.allOf as Json[]) {
    const p = (part.$ref ? resolve(part.$ref as string) : part) as Json;
    const flat = p.allOf ? mergeAllOf(p, resolve) : p;
    Object.assign(merged.properties as Json, flat.properties ?? {});
    (merged.required as string[]).push(...((flat.required as string[]) ?? []));
  }
  return merged;
}

/** JSON з відсортованими ключами: порядок ключів смислу не має. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Json).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Json)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
}

/** Розбіжності двох канонічних схем як список «шлях: код → договір» (порожній = збіг). */
function diffs(actual: unknown, expected: unknown, path = ""): string[] {
  if (stable(actual) === stable(expected)) return [];
  const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
  if (isObj(actual) && isObj(expected)) {
    const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort();
    return keys.flatMap((k) => diffs(actual[k], expected[k], `${path}.${k}`));
  }
  if (Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length) {
    return actual.flatMap((v, i) => diffs(v, expected[i], `${path}[${i}]`));
  }
  return [`${path || "."}: ${stable(actual)} → ${stable(expected)}`];
}

const openapiRef = (ref: string) => {
  const [, , section, name] = ref.split("/");
  return (openapi.components as unknown as Record<string, Record<string, unknown>>)[section][name];
};

function zodCanon(schema: z.ZodType, io: "input" | "output"): Canon {
  const json = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as Json;
  return canon(json, () => {
    throw new Error("zod schemas are inlined");
  }, io === "input");
}

/** Вхід операції REST як одна (сира) схема: параметри шляху й запиту + поля тіла. */
function openapiInput(o: Op): Json {
  const params = (o.op.parameters ?? []).map((p) => deref<Parameter & { schema: Json }>(p as Parameter & { schema: Json }));
  const body = o.op.requestBody?.content["application/json"].schema;
  const resolved = body ? (body.$ref ? openapiRef(body.$ref) : body) : null;
  const flat = (resolved ? ((resolved as Json).allOf ? mergeAllOf(resolved as Json, openapiRef) : resolved) : {}) as {
    properties?: Json;
    required?: string[];
  };
  return {
    type: "object",
    properties: {
      ...Object.fromEntries(params.map((p) => [p.name, p.schema])),
      ...(flat.properties ?? {}),
    },
    required: [
      ...params.filter((p) => p.required).map((p) => p.name),
      ...(o.op.requestBody?.required ? (flat.required ?? []) : []),
    ],
    additionalProperties: false,
  };
}

/** Схема успішної відповіді (перший 2xx з тілом); null для 204. */
function openapiOutput(o: Op): Json | null {
  for (const [code, res] of Object.entries(o.op.responses)) {
    if (!/^2\d\d$/.test(code)) continue;
    const r = (res.$ref ? openapiRef(res.$ref) : res) as { content?: { "application/json"?: { schema: Schema } } };
    const schema = r.content?.["application/json"]?.schema;
    if (schema) return schema;
  }
  return null;
}

/** JSON-блоки розділу 4 mcp-tools.md: $defs і схеми входу окремих інструментів. */
function mdSchemas(): { defs: Json; tools: Record<string, Json> } {
  const section = mcpTools.slice(mcpTools.indexOf("## 4."), mcpTools.indexOf("## 5."));
  const blocks = [...section.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => ({ at: m.index!, json: JSON.parse(m[1]) as Json }));
  const defs = (blocks[0].json.$defs ?? {}) as Json;
  const tools: Record<string, Json> = {};
  for (const b of blocks.slice(1)) {
    const heads = [...section.slice(0, b.at).matchAll(/\*\*`([a-z_]+)`\*\*/g)];
    tools[heads.at(-1)![1]] = b.json;
  }
  return { defs, tools };
}

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

  it("inputs have the same types, enums, bounds and required fields as openapi.yaml", () => {
    const bad = ACTIONS.flatMap((a) =>
      diffs(zodCanon(a.input, "input"), canon(openapiInput(byTool.get(a.name)!), openapiRef, true)).map((d) => `${a.name}${d}`),
    );
    expect(bad).toEqual([]);
  });

  it("outputs have the same types, enums, bounds and required fields as openapi.yaml", () => {
    const bad: string[] = [];
    for (const a of ACTIONS) {
      const schema = openapiOutput(byTool.get(a.name)!);
      if (!schema) {
        expect({ tool: a.name, status: a.rest.status }).toEqual({ tool: a.name, status: 204 });
        continue;
      }
      bad.push(...diffs(zodCanon(a.output, "output"), canon(schema, openapiRef, false)).map((d) => `${a.name}${d}`));
    }
    expect(bad).toEqual([]);
  });

  it("inputs match the JSON schemas written in mcp-tools.md", () => {
    const { defs, tools } = mdSchemas();
    const mdRef = (ref: string) => defs[ref.replace("#/$defs/", "")];
    expect(Object.keys(tools).sort()).toEqual(["get_candidate", "request_intro", "search_candidates", "search_jobs"]);
    const bad = Object.entries(tools).flatMap(([tool, schema]) =>
      diffs(zodCanon(getAction(tool)!.input, "input"), canon(schema, mdRef, true)).map((d) => `${tool}${d}`),
    );
    expect(bad).toEqual([]);
    // Спільні шматки: фільтри, теги, поля вакансії.
    const search = getAction("search_candidates")!.input as unknown as z.ZodObject<{ filters: z.ZodOptional<z.ZodType> }>;
    expect(zodCanon(search.shape.filters.unwrap(), "input")).toEqual(canon(defs.filters, mdRef, true));
    const add = getAction("add_to_pipeline")!.input as unknown as z.ZodObject<{ tags: z.ZodOptional<z.ZodType> }>;
    expect(zodCanon(add.shape.tags.unwrap(), "input")).toEqual(canon(defs.tags, mdRef, true));
    const job = zodCanon(getAction("post_job")!.input, "input") as { properties: Json };
    const { status: _status, ...jobFields } = job.properties;
    expect(jobFields).toEqual((canon(defs.job_fields, mdRef, true) as { properties: Json }).properties);
  });

  it("enforces in code what the JSON schema from zod cannot say: unique items, at least one field", () => {
    const rejects = (tool: string, input: unknown) => expect(getAction(tool)!.input.safeParse(input).success).toBe(false);
    const id = crypto.randomUUID();
    rejects("search_candidates", { filters: { chains: ["base", "base"] } });
    rejects("post_job", { title: "Solidity dev", roles: ["engineer", "engineer"], work_mode: ["remote"] });
    rejects("update_stage", { candidate_id: id });
    rejects("update_job", { job_id: `job_${"a".repeat(20)}` });
    rejects("update_saved_search", { saved_search_id: `ss_${"a".repeat(20)}` });
    rejects("set_webhook", {});
    expect(getAction("update_stage")!.input.safeParse({ candidate_id: id, stage: "found" }).success).toBe(true);
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
