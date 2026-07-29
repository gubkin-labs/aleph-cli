import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(root, "openapi", "openapi.json");
const apiUrl = (process.env.ALEPH_API_URL ?? "http://localhost:3000").replace(
  /\/$/,
  ""
);

const response = await fetch(`${apiUrl}/doc`);
if (!response.ok) {
  throw new Error(
    `Failed to fetch ${apiUrl}/doc: ${response.status} ${response.statusText}`
  );
}

const collectSchemaRefs = (
  value: unknown,
  refs = new Set<string>()
): Set<string> => {
  if (typeof value === "string" && value.startsWith("#/components/schemas/")) {
    refs.add(value.replace("#/components/schemas/", ""));
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collectSchemaRefs(item, refs);
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectSchemaRefs(item, refs);
    }
  }
  return refs;
};

const rawSpec = (await response.json()) as Record<string, unknown>;
const components =
  rawSpec.components && typeof rawSpec.components === "object"
    ? (rawSpec.components as Record<string, unknown>)
    : {};
const existingSchemas =
  components.schemas && typeof components.schemas === "object"
    ? (components.schemas as Record<string, unknown>)
    : {};
const schemas = { ...existingSchemas };
for (const name of collectSchemaRefs(rawSpec)) {
  schemas[name] ??= { additionalProperties: true, type: "object" };
}
const spec = { ...rawSpec, components: { ...components, schemas } };
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(spec, null, 2)}\n`);
process.stdout.write(`Saved OpenAPI spec to ${outputPath}\n`);
