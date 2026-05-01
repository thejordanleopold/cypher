import type { NextConfig } from "next";

// Toggleable for local dev: GitHub Pages serves at /cypher/, but
// `pnpm dev` and Vercel serve at /. Set GH_PAGES=1 only in CI.
const isPages = process.env.GH_PAGES === "1";
const basePath = isPages ? "/cypher" : "";

const nextConfig: NextConfig = {
  output: "export",
  basePath: basePath || undefined,
  // GitHub Pages can't run Next.js' image optimizer (no server). Disable so
  // <Image> falls back to plain <img>. We don't actually use <Image> yet,
  // but this future-proofs static export.
  images: { unoptimized: true },
  // Trailing slash makes /foo serve from /foo/index.html, which avoids 404s
  // when GitHub Pages canonicalizes URLs.
  trailingSlash: true,
  // Expose basePath to client code so we can prefix manifest/sw URLs.
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

export default nextConfig;
