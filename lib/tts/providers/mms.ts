/**
 * Meta MMS (facebook/mms-tts-mon) via a local Python subprocess.
 *
 * Insurance, not a first choice: zero cost, no account, no network, so it keeps
 * working after the Azure subscription is cancelled. Runs the model in-process
 * on CPU through transformers + torch.
 *
 * TWO CAVEATS, both recorded in CLAUDE.md:
 *   - Licensed CC-BY-NC 4.0. Non-commercial only. That is a licensing decision
 *     for this project, not a technical one.
 *   - Mongolian dialect quality is UNVERIFIED. MMS covers 1,100+ languages from
 *     religious-recording corpora, and the register may not match how a
 *     Ulaanbaatar bus passenger expects a stop name to sound.
 *
 * Requires, once:
 *   python3 -m venv .venv-tts && .venv-tts/bin/pip install torch transformers scipy
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import type { TtsProvider } from "../provider";

const execFileAsync = promisify(execFile);

const SCRIPT = "scripts/mms_tts.py";

export function createMmsProvider(env: NodeJS.ProcessEnv): TtsProvider {
  const python = env.MMS_PYTHON ?? (existsSync(".venv-tts/bin/python") ? ".venv-tts/bin/python" : "python3");
  const model = env.MMS_MODEL ?? "facebook/mms-tts-mon";

  const provider: TtsProvider = {
    name: "mms",
    voice: model,
    outputFormat: "wav",
    // The model tokenizer is character-based over Cyrillic; digits and Latin
    // are not in its vocabulary, so text needs the same rewriting Chimege does.
    accepts: /^[Ѐ-ӿ ?!.\-'":,]+$/,
    // Local CPU inference. The limit is the machine, not a quota.
    ratePerSecond: 2,
    charsUsed: 0,

    async synthesize(text: string): Promise<Buffer> {
      if (!existsSync(SCRIPT)) {
        throw new Error(`${SCRIPT} is missing — MMS provider needs it to run the model.`);
      }
      const out = join(tmpdir(), `mms-${randomUUID()}.wav`);
      try {
        await execFileAsync(python, [SCRIPT, "--model", model, "--out", out, "--text", text], {
          maxBuffer: 32 * 1024 * 1024,
        });
        const buf = await readFile(out);
        if (buf.subarray(0, 4).toString("ascii") !== "RIFF") {
          throw new Error("MMS did not produce a WAV");
        }
        provider.charsUsed = (provider.charsUsed ?? 0) + text.length;
        return buf;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/No module named|ModuleNotFoundError/.test(msg)) {
          throw new Error(
            `MMS dependencies missing. Once: python3 -m venv .venv-tts && .venv-tts/bin/pip install torch transformers scipy\n${msg}`,
          );
        }
        throw e;
      } finally {
        await unlink(out).catch(() => {});
      }
    },
  };

  return provider;
}
