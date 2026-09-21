import { runCli } from "./cli";

export async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2));
}

if (import.meta.main) {
  main();
}
