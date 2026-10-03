const { withDangerousMod } = require("expo/config-plugins");

module.exports = function withBusinessOsBundle(config) {
  for (const platform of ["android", "ios"]) {
    config = withDangerousMod(config, [
      platform,
      async (next) => {
        const { prepareMobileBusinessOsBundle } =
          await import("../../../scripts/prepare-mobile-business-os-bundle.mjs");
        await prepareMobileBusinessOsBundle({ projectRoot: next.modRequest.projectRoot, platform });
        return next;
      },
    ]);
  }
  return config;
};
