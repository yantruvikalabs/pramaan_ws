/**
 * Turning an enrolment capture into an embedding — BR-MST-19b.
 *
 * ⚠ WHY A SUBPROCESS AND NOT A NODE IMPLEMENTATION
 *
 * The obvious thing is onnxruntime-node plus a JavaScript port of the alignment
 * warp. That would be a THIRD implementation of alignment, alongside the
 * normative Python (`ml/pramaan_ml/align.py`) and the Kotlin port on the phone.
 *
 * D-9 and D-10 exist because of exactly that risk:
 *
 *   > A one-pixel difference in the warp changes the embedding. The threshold
 *   > calibrated in Python is then subtly wrong, match rates are inexplicably
 *   > bad, and three weeks go into suspecting the model, the camera and the
 *   > lighting — when it was a rounding mode in an interpolation.
 *
 * Two implementations are already proven byte-identical (aligned crop SHA-256,
 * embedding cosine 1.0000000). A third triples that surface, and the parity test
 * would have to be extended and kept green forever.
 *
 * So the server calls the NORMATIVE implementation itself. Enrolment happens
 * once per worker in their life — a subprocess at that frequency costs nothing,
 * and buys exact agreement with the reference by construction rather than by
 * test.
 *
 * ⚠ NO IMAGE TOUCHES DISK. The capture goes to the child's stdin and is never
 * written to a temporary file. A temp file is the obvious shortcut here and it
 * would break BR-ENR-2 and BR-MST-19c — a crashed process leaves the face on
 * the filesystem.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = resolve(API_ROOT, '..', '..');

const ML_DIR = process.env.PRAMAAN_ML_DIR ?? resolve(REPO_ROOT, 'ml');
const ML_PYTHON = process.env.PRAMAAN_ML_PYTHON ?? resolve(ML_DIR, '.venv', 'bin', 'python');
const SCRIPT = resolve(ML_DIR, 'scripts', 'embed_capture.py');

/** How long one capture may take before we give up. A cold model load on a
 *  small server is a second or two; thirty is generous and bounded. */
const TIMEOUT_MS = Number(process.env.PRAMAAN_EMBED_TIMEOUT_MS ?? 30_000);

export function embeddingAvailable() {
  return existsSync(ML_PYTHON) && existsSync(SCRIPT);
}

export function embeddingRequirements() {
  return { python: ML_PYTHON, script: SCRIPT, ok: embeddingAvailable() };
}

/**
 * @param {string} base64Image one camera frame, base64 (a `data:` prefix is fine)
 * @param {{recogniser?: string, checkOnly?: boolean}} [options]
 * @returns {Promise<{ok: boolean, reason?: string, detail?: string,
 *                    model?: string, dimensions?: number, embedding?: number[],
 *                    detector_score?: number}>}
 */
export function embedCapture(base64Image, options = {}) {
  if (!embeddingAvailable()) {
    return Promise.resolve({
      ok: false,
      reason: 'EMBEDDER_UNAVAILABLE',
      detail: `the face reference is not installed at ${ML_DIR}`,
    });
  }

  return new Promise((resolvePromise) => {
    const args = [SCRIPT];
    if (options.recogniser) args.push('--recogniser', options.recogniser);
    // Skips loading the 38 MB recogniser, so a per-capture check answers fast
    // enough to feel immediate to somebody standing at a desk.
    if (options.checkOnly) args.push('--check-only');

    const child = spawn(ML_PYTHON, args, {
      cwd: ML_DIR,
      // PRAMAAN_ENV is forwarded so the child refuses its --file affordance in
      // production even though we never pass it.
      env: { ...process.env, PRAMAAN_ENV: process.env.NODE_ENV ?? 'development' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, reason: 'TIMEOUT', detail: `no answer in ${TIMEOUT_MS}ms` });
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { out += chunk; });
    // stderr is captured but NEVER echoed to a client or a log line: a Python
    // traceback can quote its input, and the input here is somebody's face.
    child.stderr.on('data', (chunk) => { err += chunk.slice(0, 2000); });

    child.on('error', (error) => {
      finish({ ok: false, reason: 'EMBEDDER_FAILED', detail: error.code ?? 'spawn failed' });
    });

    child.on('close', (code) => {
      const trimmed = out.trim();
      if (!trimmed) {
        return finish({
          ok: false,
          reason: 'EMBEDDER_FAILED',
          // The exit code, not the stderr text. See the note above.
          detail: `no output, exit ${code}`,
        });
      }
      try {
        // The script prints exactly one JSON object and nothing else, so the
        // last line is the answer even if a library warns first.
        const line = trimmed.split('\n').pop();
        return finish(JSON.parse(line));
      } catch {
        return finish({ ok: false, reason: 'EMBEDDER_FAILED', detail: 'unparseable output' });
      }
    });

    child.stdin.on('error', () => { /* killed before it read; `close` reports it */ });
    child.stdin.end(base64Image);
    // `base64Image` goes out of scope with the request. Nothing retains it, and
    // nothing writes it anywhere.
    void err;
  });
}

/**
 * The quality thresholds, read FROM the Python rather than copied into here.
 *
 * The API needs them to re-judge stored captures when a threshold changes — and
 * one did: `face_dark` was 80, which flagged the captures that produced the best
 * template set of four. Keeping a second copy of these numbers in JavaScript
 * would mean the two drift apart, and a threshold that disagrees with itself is
 * worse than a wrong one.
 *
 * Cached: they change when somebody edits the Python, not per request.
 */
let cachedThresholds = null;

export async function qualityThresholds() {
  if (cachedThresholds) return cachedThresholds;
  if (!embeddingAvailable()) return null;
  const result = await new Promise((res) => {
    const child = spawn(ML_PYTHON, [SCRIPT, '--thresholds'], { cwd: ML_DIR });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', () => res(null));
    child.on('close', () => {
      try { res(JSON.parse(out.trim().split('\n').pop()).thresholds); } catch { res(null); }
    });
  });
  cachedThresholds = result;
  return result;
}

/**
 * Re-judge one stored capture against the CURRENT thresholds.
 *
 * `advised_issues` in the database is what the operator was told at the time and
 * is never rewritten — that is the historical record. This is the separate
 * question of what we would say about the same capture today.
 */
export function judgeStored(row, thresholds) {
  if (!thresholds || row.face_brightness === null) return null;
  const issues = [];
  const px = row.face_px === null ? null : Number(row.face_px);
  const brightness = Number(row.face_brightness);
  const sharpness = row.sharpness === null ? null : Number(row.sharpness);
  const off = row.off_centre === null ? null : Number(row.off_centre);

  if (px !== null && px < thresholds.min_face_px) issues.push('FACE_SMALL');
  if (brightness < thresholds.face_dark) issues.push('TOO_DARK');
  if (brightness > thresholds.face_bright) issues.push('TOO_BRIGHT');
  if (sharpness !== null && sharpness < thresholds.soft) issues.push('BLURRED');
  if (off !== null && off > thresholds.off_centre) issues.push('OFF_CENTRE');
  return issues;
}

/** Little-endian float64 vector, for the BLOB column. */
export function packEmbedding(values) {
  const buffer = Buffer.allocUnsafe(values.length * 8);
  values.forEach((v, i) => buffer.writeDoubleLE(v, i * 8));
  return buffer;
}

export function unpackEmbedding(buffer) {
  const out = new Array(buffer.length / 8);
  for (let i = 0; i < out.length; i += 1) out[i] = buffer.readDoubleLE(i * 8);
  return out;
}
