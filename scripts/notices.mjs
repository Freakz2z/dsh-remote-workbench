import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";

/** Produce notices from the actual esbuild input graph, including PDF assets. */
export async function writeNotices(inputs) {
  const packages = new Map();
  for (const input of inputs) {
    if (!input.includes("node_modules/")) continue;
    const file = input.replace(/^rw-raw:/, "");
    let directory = dirname(resolve(file));
    while (dirname(directory) !== directory) {
      try {
        const metadata = JSON.parse(
          await readFile(join(directory, "package.json"), "utf8"),
        );
        if (metadata.name && metadata.version) {
          packages.set(metadata.name, { directory, metadata });
          break;
        }
      } catch {}
      directory = dirname(directory);
    }
  }
  const licenseName = /^(?:licen[sc]e|copying|notice|copyright)(?:[._-]|$)/i;
  let result =
    "# Third-party notices\n\nThese packages are bundled into the Host, browser artifact, or local PDF assets. External runtime dependencies are distributed by npm with their own licenses. Generated from the build input graph.\n";
  for (const [name, { directory, metadata }] of [...packages].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    result += `\n## ${name} ${metadata.version}\n\nLicense: ${typeof metadata.license === "string" ? metadata.license : JSON.stringify(metadata.license ?? "see source notices")}\n`;
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter((file) => file.isFile() && licenseName.test(file.name))
      .map((file) => file.name);
    if (name === "pdfjs-dist") {
      for (const folder of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
        for (const file of await readdir(join(directory, folder), {
          withFileTypes: true,
        })) {
          if (file.isFile() && licenseName.test(file.name))
            files.push(folder + "/" + file.name);
        }
      }
    }
    for (const file of files.sort())
      result += `\n### ${file}\n\n${(await readFile(join(directory, file), "utf8")).trim()}\n`;
    if (!files.length)
      result +=
        "\nThe package declares the license above; consult its distributed source for copyright notices.\n";
  }
  await writeFile("THIRD_PARTY_NOTICES.md", result);
}
