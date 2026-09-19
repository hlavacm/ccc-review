// Loaded via --import for every test process (and inherited by the git
// subprocesses spawned by production code): never read the developer's
// global/system git configuration or global excludes file
// (core.excludesFile defaults to $XDG_CONFIG_HOME/git/ignore even when
// GIT_CONFIG_GLOBAL is overridden).
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "core.excludesFile";
process.env.GIT_CONFIG_VALUE_0 = "/dev/null";
