import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadEvaluationSuite } from "../src/index.js";

describe("evaluation suite identity", () => {
  it("changes the dataset digest when a fixture or hidden verifier changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vartma-suite-digest-"));
    const fixture = join(directory, "fixture");
    await mkdir(fixture);
    const suitePath = join(directory, "suite.yaml");
    const verifierPath = join(directory, "verifier.mjs");
    await writeFile(join(fixture, "value.txt"), "one\n", "utf8");
    await writeFile(verifierPath, "process.exit(1);\n", "utf8");
    await writeFile(
      suitePath,
      `dataset: digest-test
datasetVersion: "1"
promptTemplateVersion: coding-agent-v1
timeoutMs: 10000
tasks:
  - id: digest-task
    taskClass: small_edit
    fixture: fixture
    prompt: Repair the fixture.
    verificationFiles:
      - source: verifier.mjs
        destination: .hidden/verifier.mjs
    verify:
      - command: node
        args: [.hidden/verifier.mjs]
`,
      "utf8",
    );

    const original = await loadEvaluationSuite(suitePath);
    expect(original.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    await writeFile(join(fixture, "value.txt"), "two\n", "utf8");
    const fixtureChanged = await loadEvaluationSuite(suitePath);
    expect(fixtureChanged.digest).not.toBe(original.digest);
    await writeFile(join(fixture, "value.txt"), "one\n", "utf8");
    await writeFile(verifierPath, "process.exit(0);\n", "utf8");
    const verifierChanged = await loadEvaluationSuite(suitePath);
    expect(verifierChanged.digest).not.toBe(original.digest);
  });
});
