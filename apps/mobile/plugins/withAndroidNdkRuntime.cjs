const NDK_VERSION = "29.0.14206865";
const MARKER = 'apply plugin: "expo-root-project"';

function configureNdk(contents) {
  const setting = `ext.ndkVersion = "${NDK_VERSION}"`;
  if (contents.includes(setting)) return contents;
  if (contents.split(MARKER).length !== 2) {
    throw new Error("Cannot pin the Android NDK: expected one expo-root-project plugin.");
  }
  // Set before Expo fills its default (27). RN 0.85's fbjni needs the NDK 29
  // libc++ export __cxa_init_primary_exception; the NDK 27 runtime cannot load it.
  return contents.replace(MARKER, `${setting}\n${MARKER}`);
}

module.exports = function withAndroidNdkRuntime(config) {
  const { withProjectBuildGradle } = require("expo/config-plugins");
  return withProjectBuildGradle(config, (next) => {
    next.modResults.contents = configureNdk(next.modResults.contents);
    return next;
  });
};
module.exports.configureNdk = configureNdk;
