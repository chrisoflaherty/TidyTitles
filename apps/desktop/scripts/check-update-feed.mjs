// Checks electron-builder's output before a release uploads it: the
// update-info file electron-updater will ask for exists, describes this
// version, and lists files that are present with matching sha512 and size;
// the installers and block maps are there too.
//
// Usage:
//   node scripts/check-update-feed.mjs --platform mac|win|linux [--dir release]
//        [--version 0.2.0-beta.3] [--arch arm64,x64] [--list]
//
// --list prints the files to upload (installers, update zips, update-info
// files, block maps), one per line, and nothing else on stdout.
//
// Which file the updater asks for (electron-updater 6, GitHubProvider and
// Provider.getChannelFilePrefix): "<channel><suffix>.yml", where the channel
// is the version's prerelease name ("beta") or "latest", and the suffix is
// "-mac" on macOS, "" on Windows, "-linux" on Linux x64. electron-builder.yml
// publishes with `channel: ${channel}` to write exactly that file.

import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import yaml from "js-yaml";

const { values } = parseArgs({
  options: {
    platform: { type: "string" },
    dir: { type: "string", default: path.resolve(import.meta.dirname, "..", "release") },
    version: { type: "string" },
    arch: { type: "string" },
    list: { type: "boolean", default: false },
  },
});

const problems = [];
const log = (...args) => {
  if (!values.list) console.log(...args);
};

const platform = values.platform;
if (!["mac", "win", "linux"].includes(platform ?? "")) {
  console.error("check-update-feed: --platform must be mac, win, or linux");
  process.exit(2);
}
const dir = path.resolve(values.dir);
const version =
  values.version ?? JSON.parse(readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8")).version;
const semver = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+)(?:\.[0-9A-Za-z.-]+)?)?$/.exec(version);
if (!semver) {
  console.error(`check-update-feed: "${version}" is not a version`);
  process.exit(2);
}
const channel = semver[4] ?? "latest";
if (!["latest", "beta", "alpha"].includes(channel)) {
  // electron-updater's GitHub provider skips other prerelease names
  // ("rc", ...) unless the running app is on the same one.
  problems.push(`prerelease "${channel}" is not offered to beta testers; use -beta.N (or -alpha.N)`);
}
const suffix = { mac: "-mac", win: "", linux: "-linux" }[platform];
const feedName = `${channel}${suffix}.yml`;
const archs = (values.arch ?? (platform === "mac" ? "arm64,x64" : "x64")).split(",").filter(Boolean);

function sha512(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha512");
    createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("base64")));
  });
}

if (!existsSync(dir)) {
  console.error(`check-update-feed: ${dir} does not exist`);
  process.exit(1);
}
const present = new Set(readdirSync(dir).filter((name) => statSync(path.join(dir, name)).isFile()));
const upload = new Set();

// Only the update-info file this version needs: a stray one (a stable file in
// a beta build, say) would be uploaded under a name another release owns.
for (const name of present) {
  if (/^(latest|beta|alpha)(-mac|-linux[-a-z0-9]*)?\.yml$/.test(name) && name !== feedName) {
    problems.push(`unexpected update-info file ${name} (this version needs ${feedName})`);
  }
}

if (!present.has(feedName)) {
  problems.push(`missing ${feedName}, the file electron-updater asks for`);
} else {
  upload.add(feedName);
  const info = yaml.load(readFileSync(path.join(dir, feedName), "utf8"));
  if (info?.version !== version) problems.push(`${feedName} is for version ${info?.version}, not ${version}`);
  const files = Array.isArray(info?.files) ? info.files : [];
  if (files.length === 0) problems.push(`${feedName} lists no files`);
  const seen = new Set();
  for (const entry of files) {
    const url = String(entry?.url ?? "");
    if (!url || url.includes("/") || url.includes("\\") || seen.has(url)) {
      problems.push(`${feedName}: bad or repeated url "${url}"`);
      continue;
    }
    seen.add(url);
    if (!url.includes(version)) problems.push(`${feedName}: ${url} does not carry the version ${version}`);
    if (!present.has(url)) {
      problems.push(`${feedName} lists ${url}, which is not in ${dir}`);
      continue;
    }
    const full = path.join(dir, url);
    const size = statSync(full).size;
    if (entry.size !== size) problems.push(`${url}: size ${size} does not match ${feedName} (${entry.size})`);
    const digest = await sha512(full);
    if (entry.sha512 !== digest) problems.push(`${url}: sha512 does not match ${feedName}`);
    upload.add(url);
    if (present.has(`${url}.blockmap`)) upload.add(`${url}.blockmap`);
  }
  // Older electron-updater fields: they must describe the first file.
  if (files[0] && (info.path !== files[0].url || info.sha512 !== files[0].sha512)) {
    problems.push(`${feedName}: path/sha512 do not describe ${files[0].url}`);
  }

  const urls = [...seen];
  const need = (pattern, what) => {
    if (!urls.some((u) => pattern.test(u))) problems.push(`${feedName} has no ${what}`);
  };
  if (platform === "mac") {
    for (const arch of archs) {
      // MacUpdater.filterFilesForArch picks by "arm64" in the name; x64 files must not contain it.
      need(new RegExp(`-macos-${arch}\\.zip$`), `${arch} zip (what the Mac updater downloads)`);
      need(new RegExp(`-macos-${arch}\\.dmg$`), `${arch} DMG`);
      for (const ext of ["zip", "dmg"]) {
        const name = `TidyTitles-${version}-macos-${arch}.${ext}`;
        if (!present.has(`${name}.blockmap`)) problems.push(`missing ${name}.blockmap (differential download)`);
      }
    }
  } else if (platform === "win") {
    need(/-windows-setup\.exe$/, "Windows installer");
    const exe = urls.find((u) => u.endsWith(".exe"));
    if (exe && !present.has(`${exe}.blockmap`)) problems.push(`missing ${exe}.blockmap (differential download)`);
  } else {
    need(/\.AppImage$/, "AppImage");
  }
}

// Every installer in the folder is uploaded too (a DMG is listed in the feed,
// but upload it even if it were not).
for (const name of present) {
  if (/\.(dmg|zip|exe|AppImage)$/.test(name) && name.includes(version)) {
    upload.add(name);
    if (present.has(`${name}.blockmap`)) upload.add(`${name}.blockmap`);
  }
}

if (problems.length > 0) {
  console.error(`check-update-feed (${platform} ${version}): the update feed is not consistent:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}

if (values.list) {
  for (const name of [...upload].sort()) console.log(name);
} else {
  log(`check-update-feed: ${feedName} for ${version} matches ${upload.size - 1} files in ${dir}:`);
  for (const name of [...upload].sort()) log(`  ${name}`);
}
