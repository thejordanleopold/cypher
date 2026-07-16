import type { NextConfig } from "next";
import { getBasePath } from "./src/base-path";

const basePath = getBasePath();

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  basePath,
};

export default nextConfig;
