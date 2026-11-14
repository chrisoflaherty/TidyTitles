// electron-builder afterPack hook.
//
// 1. Drop Electron's sample app, which comes along when packaging from a
//    local Electron distribution (electronDist).
// 2. On macOS, give the app an ad-hoc code signature. Builds without a
//    Developer ID certificate skip electron-builder's signing step, which
//    leaves the bundle with Electron's original linker signature that no
//    longer matches the repackaged contents. macOS reports such an app as
//    "damaged" once it has been downloaded, and Apple silicon will not run
//    it. An ad-hoc signature is valid for the bundle as packaged. When a
//    real identity is configured, electron-builder signs after this hook and
//    replaces the ad-hoc signature.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const mac = context.electronPlatformName === "darwin";
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resources = mac ? path.join(appPath, "Contents", "Resources") : path.join(context.appOutDir, "resources");
  fs.rmSync(path.join(resources, "default_app.asar"), { force: true });

  if (mac && process.platform === "darwin") {
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
  }
};
