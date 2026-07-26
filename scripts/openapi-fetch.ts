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

const spec: unknown = await response.json();
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(spec, null, 2)}\n`);
process.stdout.write(`Saved OpenAPI spec to ${outputPath}\n`);
