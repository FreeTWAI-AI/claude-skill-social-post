import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { runPythonClaim } from "./comment_chrome_claim_bridge.mjs";


const execFileAsync = promisify(execFile);
const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const setupSource = String.raw`
from pathlib import Path
import json
import sys

from comment_test_browser_adapter import LocalFixtureCommentAdapter
from comment_test_browser_contract_support import (
    SESSION_ID, ingest_browser_scan, preflight_for, prepare_action, scan_envelope,
)
from comment_test_cli import draft_cli_fixture, prepare_cli_fixture, run_cli

root = Path(sys.argv[1])
script, _ = prepare_cli_fixture(root, live_browser_actuation_enabled=True)
adapter = LocalFixtureCommentAdapter("instagram")
comment = ingest_browser_scan(script, root, scan_envelope(adapter))
_, intent_id = draft_cli_fixture(script, root, comment)
run_cli(
    script, root, "approve", "--intent-id", intent_id,
    "--approval-mode", "batch_confirm", "--session-id", SESSION_ID, "--write",
)
action = prepare_action(script, root, intent_id)
adapter.fill_composer(action["reply_text"])
preparation = preflight_for(action, adapter)
print("CLAIM_FIXTURE " + json.dumps(
    {"action": action, "preparation": preparation}, ensure_ascii=False,
))
`;

const scratch = await mkdtemp(join(tmpdir(), "social-real-claim-"));
try {
  const setup = await execFileAsync("python", ["-c", setupSource, scratch], {
    cwd: scriptsRoot, encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024,
  });
  const line = setup.stdout.split(/\r?\n/u).find((value) => value.startsWith("CLAIM_FIXTURE "));
  assert.ok(line, `missing setup fixture: ${setup.stdout} ${setup.stderr}`);
  const { action, preparation } = JSON.parse(line.slice("CLAIM_FIXTURE ".length));
  const claimOptions = {
    root: scratch, intentId: action.intent_id, sessionId: action.session_id,
    preparation, timeoutMs: 10000,
  };
  const raced = await Promise.allSettled([
    runPythonClaim(claimOptions),
    runPythonClaim(claimOptions),
  ]);
  const fulfilled = raced.filter((result) => result.status === "fulfilled");
  const rejected = raced.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1, JSON.stringify(raced));
  assert.equal(rejected.length, 1, JSON.stringify(raced));
  assert.equal(fulfilled[0].value.decision, "WRITE_OK");
  assert.equal(fulfilled[0].value.action_id, action.action_id);
  assert.match(String(rejected[0].reason), /durable ledger claim failed/);

  const events = (await readFile(join(scratch, "data", "reply_events.jsonl"), "utf8"))
    .trim().split(/\r?\n/u).filter(Boolean).map((row) => JSON.parse(row));
  assert.equal(events.filter((event) => event.event_type === "send_started").length, 1);
  const validated = await execFileAsync(
    "python", [join(scriptsRoot, "comment_assistant.py"), "validate", "--root", scratch],
    { cwd: scriptsRoot, encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  assert.equal(JSON.parse(validated.stdout).valid, true);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

console.log("comment Chrome real Python claim integration test passed");
