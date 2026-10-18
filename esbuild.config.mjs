import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({});
// "external": keep maps on disk only; package.json `files` excludes them.
await esbuild.build({ ...presets.esbuild.worker, sourcemap: "external" });
await esbuild.build({ ...presets.esbuild.manifest, sourcemap: "external" });
