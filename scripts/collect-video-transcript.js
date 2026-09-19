import fs from "node:fs";
import path from "node:path";
import { classifyCollectionError, collectVideoTranscript } from "../subagent-bridge/src/services/video-transcript.js";

const args = process.argv.slice(2);
const urlArgument = args.find((argument) => argument.startsWith("--url="));
const outputArgument = args.find((argument) => argument.startsWith("--out="));

if (!urlArgument) {
  console.log(JSON.stringify({ error: "missing_url", usage: "npm run video:collect -- --url=<youtube-watch-url> [--out=<transcript file>]" }, null, 2));
  process.exitCode = 1;
} else {
  try {
    const result = await collectVideoTranscript({ url: urlArgument.slice("--url=".length) });
    if (outputArgument) {
      const outputPath = path.resolve(outputArgument.slice("--out=".length));
      fs.writeFileSync(outputPath, result.transcript, "utf8");
    }
    console.log(JSON.stringify({ ...result.envelope, transcriptWritten: Boolean(outputArgument) }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ error: "collection_failed", reason: classifyCollectionError(error) }, null, 2));
    process.exitCode = 1;
  }
}
