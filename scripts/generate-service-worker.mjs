import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptsDir, "..");
const outDir = join(projectRoot, "out");
const templatePath = join(scriptsDir, "service-worker-template.js");
const outputPath = join(outDir, "sw.js");

const EXCLUDED_FILES = new Set([
  ".nojekyll",
  "CNAME",
  "sw.js",
]);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = join(directory, entry.name);
      return entry.isDirectory() ? listFiles(absolutePath) : [absolutePath];
    }),
  );
  return nested.flat();
}

function normalizePath(filePath) {
  return relative(outDir, filePath).split(sep).join("/");
}

function urlFor(relativePath) {
  if (relativePath === "index.html") return "./";
  if (relativePath.endsWith("/index.html")) {
    return `./${relativePath.slice(0, -"index.html".length)}`;
  }
  return `./${relativePath}`;
}

function revisionFor(contents) {
  return createHash("sha256").update(contents).digest("hex").slice(0, 16);
}

const files = (await listFiles(outDir))
  .map((absolutePath) => ({ absolutePath, relativePath: normalizePath(absolutePath) }))
  .filter(({ relativePath }) => !EXCLUDED_FILES.has(relativePath))
  .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

const precacheEntries = await Promise.all(
  files.map(async ({ absolutePath, relativePath }) => {
    const contents = await readFile(absolutePath);
    return {
      url: urlFor(relativePath),
      revision: revisionFor(contents),
    };
  }),
);

const serializedManifest = JSON.stringify(precacheEntries);
const buildRevision = revisionFor(serializedManifest);
const formattedManifest = JSON.stringify(precacheEntries, null, 2);
const template = await readFile(templatePath, "utf8");
const generated = template
  .replace("__CYPHER_BUILD_REVISION__", buildRevision)
  .replace("/* __CYPHER_PRECACHE_MANIFEST__ */ []", formattedManifest);

if (generated.includes("__CYPHER_")) {
  throw new Error("Service worker generation left an unreplaced template marker");
}

await writeFile(outputPath, generated);
console.log(
  `Generated ${relative(projectRoot, outputPath)} with ${precacheEntries.length} assets (${buildRevision})`,
);
