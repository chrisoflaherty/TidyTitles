// electron-builder afterPack hook: drop Electron's sample app, which comes
// along when packaging from a local Electron distribution (electronDist).
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const resources =
    context.electronPlatformName === "darwin"
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(context.appOutDir, "resources");
  fs.rmSync(path.join(resources, "default_app.asar"), { force: true });
};
