import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const correct = await readFile("roman.mjs", "utf8");
const mutants = [
  correct.replace("number < 1", "number < 0"),
  correct.replace("number > 3999", "number > 4000"),
  correct.replace('[900, "CM"]', '[900, "DCCCC"]'),
  correct.replace('[4, "IV"]', '[4, "IIII"]'),
  correct.replace("!Number.isInteger(number)", "!Number.isFinite(number)"),
];

function runCandidate(expectSuccess) {
  const run = spawnSync(process.execPath, ["test.mjs"], { encoding: "utf8", timeout: 10000 });
  if (expectSuccess) assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  else assert.notEqual(run.status, 0, "candidate tests did not reject a mutant");
}

try {
  runCandidate(true);
  for (const mutant of mutants) {
    await writeFile("roman.mjs", mutant, "utf8");
    runCandidate(false);
  }
} finally {
  await writeFile("roman.mjs", correct, "utf8");
}
