import { build } from "esbuild";
import { readFile, mkdir, cp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { writeNotices } from "./notices.mjs";
const require = createRequire(import.meta.url);
await mkdir("lib", { recursive: true });
const host = await build({
  entryPoints: ["src/index.ts"],
  outfile: "lib/index.js",
  platform: "node",
  format: "esm",
  target: "node24",
  bundle: true,
  external: ["@deepseek-ai/*", "ws", "zod", "cpu-features", "*.node"],
  banner: {
    js: 'import {createRequire as __rwRequire} from "node:module";import {fileURLToPath as __rwFileURL} from "node:url";const require=__rwRequire(import.meta.url);const __dirname=__rwFileURL(new URL(".",import.meta.url));',
  },
  sourcemap: true,
  metafile: true,
});
const client = await build({
  entryPoints: ["src/client/index.tsx"],
  outfile: "lib/client.js",
  platform: "browser",
  format: "cjs",
  target: "es2022",
  bundle: true,
  sourcemap: true,
  minify: true,
  metafile: true,
  banner: {
    js: 'window.__ModuleLoader__.load({id:"dsh-remote-workbench",factory:(require)=>{var module={exports:{}};var exports=module.exports;',
  },
  footer: { js: "return module.exports;}});" },
  external: ["react", "react-dom", "react/jsx-runtime", "@deepseek-ai/*"],
  plugins: [
    {
      name: "inline-raw-assets",
      setup(bundler) {
        bundler.onResolve({ filter: /\?raw$/ }, (args) => ({
          path: require.resolve(args.path.slice(0, -4)),
          namespace: "rw-raw",
        }));
        bundler.onLoad(
          { filter: /.*/, namespace: "rw-raw" },
          async ({ path }) => ({
            contents: await readFile(path, "utf8"),
            loader: "text",
          }),
        );
      },
    },
    {
      name: "inline-plugin-css",
      setup(bundler) {
        bundler.onLoad({ filter: /\.css$/ }, async ({ path }) => {
          const css = await readFile(path, "utf8");
          const id =
            "rw-style-" +
            createHash("sha256").update(path).digest("hex").slice(0, 10);
          return {
            contents: `if(!document.getElementById(${JSON.stringify(id)})){const s=document.createElement('style');s.id=${JSON.stringify(id)};s.setAttribute('data-plugin','dsh-remote-workbench');s.textContent=${JSON.stringify(css)};document.head.appendChild(s)}`,
            loader: "js",
          };
        });
      },
    },
  ],
});
console.log("Built Host + Client plugin → lib/");
for (const directory of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  await cp(`node_modules/pdfjs-dist/${directory}`, `lib/pdfjs/${directory}`, {
    recursive: true,
  });
}
await writeNotices([
  ...Object.keys(host.metafile.inputs),
  ...Object.keys(client.metafile.inputs),
  "node_modules/pdfjs-dist/package.json",
]);
