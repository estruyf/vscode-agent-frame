import { appendFile, readFile, writeFile } from "fs/promises";
import { join, resolve } from "path";

const runId = process.argv[process.argv.length - 1];

const packageContents = await readFile("package.json", "utf8");
const packageJson = JSON.parse(packageContents);
const version = packageJson.version.split(".");

packageJson.version = `${version[0]}.${version[1]}.${runId.substring(0, 9)}`;

await writeFile(
  join(resolve("."), "package.json"),
  JSON.stringify(packageJson, null, 2) + "\n",
);

if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `## Version info\n\nVersion: ${packageJson.version}\n`,
  );
}

console.log(`Version: ${packageJson.version}`);
