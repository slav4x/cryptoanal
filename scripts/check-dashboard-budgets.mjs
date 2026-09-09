import console from "node:console";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import process from "node:process";

const dashboardDist = path.resolve("apps/dashboard/dist");
const assetsDirectory = path.join(dashboardDist, "assets");

if (!existsSync(assetsDirectory)) {
  throw new Error("Dashboard build not found. Run `pnpm build` first.");
}

const indexHtml = readFileSync(path.join(dashboardDist, "index.html"), "utf8");
const entryMatch = indexHtml.match(/<script[^>]+src="([^"]+\.js)"/);
if (!entryMatch?.[1]) throw new Error("Dashboard entry chunk was not found in dist/index.html.");

const assets = readdirSync(assetsDirectory);
const javascript = assets.filter((name) => name.endsWith(".js"));
const styles = assets.filter((name) => name.endsWith(".css"));
const routeChunks = javascript.filter((name) => /Page-[^.]+\.js$/.test(name));
const chartChunks = javascript.filter((name) => name.startsWith("vendor-lightweight-charts-"));
const radixChunks = javascript.filter((name) => name.startsWith("vendor-radix-ui-"));
const entryName = path.basename(entryMatch[1]);

const kib = (bytes) => bytes / 1024;
const gzipSize = (name) => gzipSync(readFileSync(path.join(assetsDirectory, name))).byteLength;
const totalGzip = (names) => names.reduce((total, name) => total + gzipSize(name), 0);
const largest = (names) =>
  names
    .map((name) => ({ name, bytes: gzipSize(name) }))
    .sort((left, right) => right.bytes - left.bytes)[0];

const measurements = [
  { label: "entry JS", bytes: gzipSize(entryName), limit: 100 },
  { label: "all JS", bytes: totalGzip(javascript), limit: 340 },
  { label: "all CSS", bytes: totalGzip(styles), limit: 12 },
  { label: "largest route", ...largest(routeChunks), limit: 12 },
  { label: "chart vendor", ...largest(chartChunks), limit: 70 },
  { label: "Radix UI vendor", ...largest(radixChunks), limit: 40 },
];

let failed = false;
for (const measurement of measurements) {
  const actual = kib(measurement.bytes);
  const suffix = measurement.name ? ` (${measurement.name})` : "";
  const passed = actual <= measurement.limit;
  failed ||= !passed;
  console.log(
    `${passed ? "PASS" : "FAIL"} ${measurement.label}${suffix}: ${actual.toFixed(2)} KiB gzip / ${measurement.limit} KiB`,
  );
}

if (failed) process.exitCode = 1;
