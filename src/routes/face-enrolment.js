/**
 * Real face enrolment — FRD §5, FR-ENR-001, BR-MST-19 as amended 3 Aug 2026.
 *
 * The worker comes to the controller in person. Both channels are legitimate:
 * a browser at the desk, or a senior's phone in the field. **What the rule
 * requires is presence and an accountable operator, not a particular device.**
 *
 * ⚠ CAMERA ONLY. BR-MST-19a. There is no code path here that accepts an image
 * file, and there must never be one. A photograph passes the face match (§15),
 * so a file picker would let anybody enrol from an image with nothing to catch
 * it. `source: 'camera'` is required and checked, which is a declaration rather
 * than a proof — the real control is that no upload UI exists.
 *
 * ⚠ NO IMAGE IS STORED. BR-ENR-2, BR-MST-19c. Frames arrive over TLS, are
 * passed to the embedder on stdin, and are never written to disk, never logged,
 * never echoed back in an error.
 *
 * ⚠ ALL THREE CAPTURES OR NOTHING. A worker with one usable capture is worse
 * than one who is not enrolled: they would be matched against a single lighting
 * condition and fail at the gate at dawn. BR-ENR-1 wants three, so three is
 * atomic here.
 */

import { randomUUID } from 'node:crypto';
import { EMPLOYEE_STATUS, EVENT_TYPE, ROLE } from '@pramaan/shared';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { appendEvent } from '../lib/chain.js';
import { subjectRefFor } from '../lib/refs.js';
import {
  embedCapture, embeddingAvailable, judgeStored, packEmbedding, qualityThresholds,
  unpackEmbedding,
} from '../lib/embed.js';
import { col, getClient, CHAIN_TXN_OPTIONS } from '../db/mongo.js';

/** FR-ENR-001 step 4: three captures, deliberately varied. */
const REQUIRED_CAPTURES = 3;

/**
 * What the operator is asked to vary, in order. Shown on screen so a supervisor
 * needs no training from us (BR-ENR-7), and returned by the API so the wording
 * lives in one place rather than being retyped in each client.
 */
export const CAPTURE_STEPS = [
  { index: 1, instruction: 'Face the camera in normal light', hint: 'Look straight ahead' },
  { index: 2, instruction: 'Now move to different light', hint: 'Face a window, or step away from it' },
  { index: 3, instruction: 'Wear your usual glasses, if you wear any', hint: 'Otherwise just look ahead again' },
];

export default function faceEnrolmentRoutes(app) {
  /** What the client needs to render the flow, and whether the server can do it at all. */
  app.get('/enrolment/capability', requireAuth, requireRole(ROLE.SENIOR), (req, res) => {
    res.json({
      available: embeddingAvailable(),
      captures_required: REQUIRED_CAPTURES,
      steps: CAPTURE_STEPS,
      // Stated to the client so a UI cannot quietly offer a file picker.
      camera_only: true,
      note: embeddingAvailable()
        ? null
        : 'The face reference is not installed on this server — see ml/README.md.',
    });
  });

  /**
   * POST /enrolment/check — measure ONE capture and say what to change.
   *
   * Called after each capture during enrolment, before the operator moves on.
   * BR-ENR-8: every rejection returns one specific, actionable instruction.
   *
   * ⚠ THIS DOES NOT STORE ANYTHING and computes no embedding. It exists so a
   * badly-lit capture is caught at the moment it can be retaken, rather than
   * after three captures and a submit — or worse, when the worker fails to match
   * at a gate at dawn. That is what happened with the first real enrolment: three
   * backlit captures, a genuine match score of 0.406 against an operating point
   * of 0.363, and nothing said so until afterwards.
   *
   * ⚠ The advice is NOT a gate. It never refuses. Refusing a real worker on an
   * uncalibrated number is worse than accepting a mediocre template — the
   * thresholds are provisional and O-4 is still open.
   */
  app.post('/enrolment/check', requireAuth, requireRole(ROLE.SENIOR), async (req, res) => {
    if (!embeddingAvailable()) {
      return res.status(503).json({ error: 'EMBEDDER_UNAVAILABLE', message: 'Unavailable.' });
    }
    const image = req.body?.image_base64;
    if (typeof image !== 'string' || image.length < 100) {
      return res.status(400).json({ error: 'EMPTY', message: 'No image data.' });
    }
    const result = await embedCapture(image, { checkOnly: true });
    // A rejection here is information, not an error: 200 with ok:false, so the
    // client renders an instruction rather than an error banner.
    return res.json(
      result.ok
        ? {
            ok: true,
            acceptable: result.acceptable,
            instruction: result.instruction,
            issues: result.issues ?? [],
            quality: result.quality ?? null,
            detector_score: result.detector_score,
          }
        : { ok: false, acceptable: false, instruction: result.detail, reason: result.reason },
    );
  });

  /**
   * POST /employees/:id/face-enrolment
   *
   * Body: { channel: 'WEB'|'PHONE', captures: [{ index, source: 'camera', image_base64 }] }
   *
   * SENIOR and above — the same authority as the rest of enrolment (FR-ENR-002).
   */
  app.post(
    '/employees/:id/face-enrolment',
    requireAuth,
    requireRole(ROLE.SENIOR),
    async (req, res) => {
      if (!embeddingAvailable()) {
        return res.status(503).json({
          error: 'EMBEDDER_UNAVAILABLE',
          message: 'This server cannot compute face templates. Enrolment is unavailable.',
        });
      }

      const employeeId = req.params.id;
      const channel = String(req.body?.channel ?? '').toUpperCase();
      if (channel !== 'WEB' && channel !== 'PHONE') {
        return res.status(400).json({
          error: 'BAD_CHANNEL',
          message: 'channel must be WEB or PHONE.',
        });
      }

      // ⚠ TWO SHAPES, ONE ENDPOINT, AND THE DIFFERENCE MATTERS.
      //
      //   WEB   sends FRAMES; the server embeds them with the normative Python
      //         (BR-MST-19b), because a browser must not compute an embedding.
      //   PHONE sends EMBEDDINGS; the app computed them in Kotlin, which is the
      //         ported implementation D-10 proves byte-identical to the Python.
      //
      // The phone cannot send frames: a face crossing the network from a worker's
      // handset would be an image in transit for no reason, when the device
      // already holds a proven implementation. And the browser cannot send
      // embeddings, because nothing in a browser is entitled to produce one.
      const captures = Array.isArray(req.body?.captures) ? req.body.captures : [];
      if (captures.length !== REQUIRED_CAPTURES) {
        return res.status(400).json({
          error: 'WRONG_CAPTURE_COUNT',
          message: `Enrolment needs exactly ${REQUIRED_CAPTURES} captures — ${captures.length} were sent.`,
        });
      }
      // BR-MST-19a. Refused rather than coerced: a client that omits this is a
      // client that may not be using a camera.
      if (captures.some((c) => c?.source !== 'camera')) {
        return res.status(400).json({
          error: 'CAMERA_ONLY',
          message: 'Enrolment captures must come from a live camera. Files are not accepted.',
        });
      }

      const employee = await col('employees').findOne({ _id: employeeId });
      if (!employee) {
        return res.status(404).json({ error: 'NOT_FOUND', message: 'No such employee.' });
      }
      if (employee.status === EMPLOYEE_STATUS.INACTIVE) {
        return res.status(409).json({
          error: 'INACTIVE',
          message: 'That employee is inactive. Reactivate them first.',
        });
      }

      // ── Embed every capture BEFORE writing anything.
      //
      // A partial enrolment is worse than none: a worker with one template is
      // matched against one lighting condition and fails at dawn. So every
      // capture is turned into an embedding first, and only then is anything
      // stored (BR-ENR-1).
      const results = [];
      if (channel === 'PHONE') {
        // The app already embedded these with the Kotlin implementation, which
        // D-10 proves reproduces the normative Python byte-for-byte. Re-embedding
        // here would require the frame, and there is no reason for a worker's face
        // to cross the network.
        for (const capture of captures) {
          const vector = Array.isArray(capture?.embedding) ? capture.embedding : null;
          if (!vector || vector.length < 64 || !vector.every((v) => Number.isFinite(v))) {
            results.push({
              index: capture?.index, ok: false, reason: 'BAD_EMBEDDING',
              detail: 'the capture did not produce a usable face template',
            });
            continue;
          }
          if (typeof capture.model !== 'string' || !capture.model.endsWith('.onnx')) {
            results.push({
              index: capture?.index, ok: false, reason: 'NO_MODEL_NAMED',
              detail: 'the app did not say which model produced this template',
            });
            continue;
          }
          results.push({
            index: capture.index,
            ok: true,
            model: capture.model,
            dimensions: vector.length,
            embedding: vector,
            // Measured on the device by QualityGates.kt, same fields as the
            // Python's so both channels are comparable.
            quality: capture.quality ?? null,
            detector_score: capture.quality?.detectorScore ?? null,
            issues: Array.isArray(capture.issues) ? capture.issues : [],
          });
        }
      } else {
        for (const capture of captures) {
          const image = capture?.image_base64;
          if (typeof image !== 'string' || image.length < 100) {
            results.push({ index: capture?.index, ok: false, reason: 'EMPTY', detail: 'no image data' });
            continue;
          }
          // eslint-disable-next-line no-await-in-loop -- sequential on purpose: three
          // concurrent model loads on a small server is a memory spike for no gain,
          // and enrolment is not latency-sensitive.
          const result = await embedCapture(image);
          results.push({ index: capture.index, ...result });
        }
      }

      const usable = results.filter((r) => r.ok);
      if (usable.length !== REQUIRED_CAPTURES) {
        return res.status(422).json({
          error: 'CAPTURE_REJECTED',
          message: 'Some captures could not be used. Retake them and try again.',
          // Per capture, with the specific instruction from the embedder —
          // BR-ENR-8: never a generic failure, never an error code alone.
          captures: results.map((r) => ({
            index: r.index,
            ok: Boolean(r.ok),
            reason: r.ok ? null : r.reason,
            instruction: r.ok ? null : r.detail,
          })),
        });
      }

      // Every embedding must come from the same model, or the template set is
      // internally incomparable and every later match is meaningless.
      const models = new Set(usable.map((r) => r.model));
      if (models.size !== 1) {
        return res.status(500).json({
          error: 'MODEL_MISMATCH',
          message: 'Captures were embedded by different models. Nothing was stored.',
        });
      }
      const model = usable[0].model;

      // ── Is the SET varied, or the same capture three times?
      //
      // ⚠ THIS EXISTS BECAUSE THE PER-CAPTURE ADVICE CAUSED A REGRESSION.
      //
      // MEASURED 3 Aug 2026. An enrolment where every capture passed the quality
      // check — brightness 94.8 / 95.0 / 85.3, off-centre 0.075 / 0.097 / 0.114 —
      // matched at 0.403-0.524. An earlier, unadvised enrolment of the same face
      // matched at 0.649-0.720.
      //
      // The advice scores each capture on its own, so an operator chasing three
      // green ticks converges on three IDENTICAL good captures. BR-ENR-1 keeps
      // three templates so that best-of-three spans different conditions; three
      // identical captures are effectively ONE template and generalise worse.
      //
      // So variety is now reported too. Advice, never a refusal — the operator is
      // told the set is narrow and decides.
      const brightnesses = usable
        .map((r) => r.quality?.face_brightness)
        .filter((v) => typeof v === 'number');
      const spread = brightnesses.length > 1
        ? Math.max(...brightnesses) - Math.min(...brightnesses)
        : null;
      // 15 grey levels is provisional, like every threshold here: it is roughly
      // the difference between "moved to a different window" and "did not move".
      const varied = spread === null ? null : spread >= 15;

      const session = getClient().startSession();
      try {
        session.startTransaction(CHAIN_TXN_OPTIONS);

        // Re-enrolment replaces the template set. The Enrolled events both
        // remain in the chain, so the history of who enrolled this person and
        // when is never lost — only the biometric material is superseded.
        await col('face_templates').deleteMany({ employee_id: employeeId }, { session });

        for (const r of usable) {
          // eslint-disable-next-line no-await-in-loop
          // The web channel reports snake_case from Python, the phone camelCase
          // from Kotlin. Normalised here rather than in either producer, so
          // neither has to know about the other.
          const raw = r.quality ?? {};
          const q = {
            face_pixels: raw.face_pixels ?? (raw.facePx ? [raw.facePx, raw.facePx] : null),
            face_brightness: raw.face_brightness ?? raw.faceBrightness ?? null,
            sharpness: raw.sharpness ?? null,
            off_centre: raw.off_centre ?? raw.offCentre ?? null,
          };
          await col('face_templates').insertOne({
            employee_id: employeeId,
            capture_index: Number(r.index),
            model,
            dimensions: Number(r.dimensions),
            // A Node Buffer → BSON binData, and back to a Buffer on read
            // because the client sets promoteBuffers:true. Without that flag
            // lib/embed.js reads .length as a method and builds Array(NaN).
            embedding: packEmbedding(r.embedding),
            channel,
            enrolled_by: req.employee.employee_id,
            // Kept so template quality can be correlated with match quality
            // later — that correlation IS O-4, and it was being discarded.
            face_px: Array.isArray(q.face_pixels) ? Math.min(...q.face_pixels) : null,
            face_brightness: q.face_brightness ?? null,
            sharpness: q.sharpness ?? null,
            off_centre: q.off_centre ?? null,
            detector_score: r.detector_score ?? null,
            // What the operator was told at the time. Empty string, not NULL,
            // when the check was clean: NULL would be indistinguishable from
            // "no check ran", and those mean different things.
            advised_issues: Array.isArray(r.issues) ? r.issues.join(',').slice(0, 255) : null,
            created_at: new Date(),
          }, { session });
        }

        // The chain event inside the same transaction as the templates: if
        // either fails, neither happened. A template set with no event would be
        // a biometric nobody authorised.
        const { event } = await appendEvent(
          {
            event_id: randomUUID(),
            type: EVENT_TYPE.ENROLLED,
            subject_ref: await subjectRefFor(employeeId),
            session_ref: req.session.session_id,
            payload: {
              method: 'FACE_CAPTURE',
              channel,
              templates: usable.length,
              model,
              dimensions: Number(usable[0].dimensions),
              // NOT the embedding. The chain is public to a verifier and an
              // embedding is biometric data — NFR-17 keeps personal data out of
              // the envelope, and an embedding is the most personal thing here.
              // Erasure is then a DELETE from face_templates and the chain still
              // verifies.
              actor_ref: await subjectRefFor(req.employee.employee_id),
              actor_role: req.employee.role,
            },
            captured_at: new Date().toISOString(),
          },
          session,
        );

        await col('employees').updateOne(
          { _id: employeeId },
          { $set: { status: EMPLOYEE_STATUS.ENROLLED, updated_at: new Date() } },
          { session },
        );

        await session.commitTransaction();

        return res.status(201).json({
          employee_id: employeeId,
          status: EMPLOYEE_STATUS.ENROLLED,
          templates: usable.length,
          model,
          channel,
          event: { seq: event.seq, hash: event.hash },
          // Quality per capture, returned so an operator can see WHY a template
          // set turned out weak instead of discovering it at the gate. These are
          // measurements, not gates — the real §6.3 gates live next to a live
          // preview and are Phase 4.
          captures: usable.map((r) => ({
            index: r.index,
            ok: true,
            detector_score: r.detector_score,
            quality: r.quality ?? null,
          })),
          // Reported so the operator sees it immediately, not at a gate.
          set_variety: {
            brightness_spread: spread === null ? null : Math.round(spread * 10) / 10,
            varied,
            advice: varied === false
              ? 'All three captures were in the same light. Best-of-three only helps if '
                + 'the three differ — re-enrol with one capture near a window and one away '
                + 'from it for a set that generalises better.'
              : null,
          },
        });
      } catch (err) {
        await session.abortTransaction().catch(() => {});
        throw err;
      } finally {
        await session.endSession();
      }
    },
  );

  /**
   * GET /me/face-templates — the caller's OWN templates, for on-device matching.
   *
   * ⚠ THERE IS NO WAY TO ASK FOR SOMEBODY ELSE'S. BR-ENR-3 and BR-ENR-4: a device
   * holds exactly one template set, its owner's. The employee id comes from the
   * session, never from a parameter — a `:id` here would be one typo away from
   * provisioning a worker's face to a colleague's handset, and there would be no
   * error to notice.
   *
   * ⚠ This is the one endpoint that returns embeddings, and it is why the rest do
   * not. A worker's own device needs them to match offline (the phone matches
   * on-device, always). Nothing else has any business reading one.
   *
   * BR-MST-19d: a worker enrolled at the controller's desk has no app yet, so this
   * is how the template reaches their phone at first sign-in.
   */
  app.get('/me/face-templates', requireAuth, async (req, res) => {
    const employeeId = req.employee.employee_id;
    const rows = await col('face_templates')
      .find({ employee_id: employeeId })
      .sort({ capture_index: 1 })
      .toArray();
    if (rows.length === 0) {
      return res.json({ employee_id: employeeId, templates: 0, model: null, vectors: [] });
    }
    const models = new Set(rows.map((r) => r.model));
    if (models.size !== 1) {
      // Comparing across models is meaningless, and a mixed set would produce
      // scores that look plausible and mean nothing.
      return res.status(500).json({
        error: 'MODEL_MISMATCH',
        message: 'This template set was built by more than one model. Re-enrol.',
      });
    }
    return res.json({
      employee_id: employeeId,
      templates: rows.length,
      model: rows[0].model,
      dimensions: rows[0].dimensions,
      vectors: rows.map((r) => unpackEmbedding(r.embedding)),
    });
  });

  /**
   * GET /employees/:id/face-enrolment — is there a template set, and from what?
   *
   * Deliberately never returns an embedding. Nothing outside the matcher has any
   * business reading one, and an endpoint that hands them out would make a
   * database breach into a biometric breach.
   */
  app.get(
    '/employees/:id/face-enrolment',
    requireAuth,
    requireRole(ROLE.SENIOR),
    async (req, res) => {
      const rows = await col('face_templates')
        .find({ employee_id: req.params.id }, { projection: { embedding: 0 } })
        .sort({ capture_index: 1 })
        .toArray();

      // A weak template set is otherwise invisible until somebody is turned away
      // at a gate. Surfaced here so a controller can re-enrol them first.
      // Re-judged against CURRENT thresholds. `advised_issues` stays as the
      // historical record of what the operator was told; this is what we would
      // say today. They differ whenever a threshold has been corrected — and one
      // has: face_dark went 80 -> 40 on measured evidence.
      const thresholds = await qualityThresholds();
      const rejudged = rows.map((r) => judgeStored(r, thresholds));
      const flagged = rejudged.filter((issues) => issues && issues.length > 0);

      // ⚠ VARIETY IS THE STRONGER PREDICTOR — measured over four enrolments.
      //
      //   spread  9.7 grey levels -> match separation +0.279
      //   spread 45.9 grey levels -> match separation +0.692
      //
      // The narrow set passed every per-capture check; the varied one was
      // ADVISED_AGAINST and matched far better. So a narrow set is now reported
      // in its own right, because "every capture looked good" was exactly the
      // reassurance that preceded the worst template set.
      const brightness = rows
        .map((r) => (r.face_brightness === null ? null : Number(r.face_brightness)))
        .filter((v) => v !== null);
      const spread = brightness.length > 1
        ? Math.max(...brightness) - Math.min(...brightness)
        : null;
      const narrow = spread !== null && spread < 15;
      // ⚠ UNMEASURED IS NOT CLEAN. Templates enrolled before quality was recorded
      // have NULL here, and the first version of this reported them as CLEAN —
      // false reassurance about captures nobody ever checked. `advised_issues` is
      // an empty string when a check ran and found nothing, and NULL when no
      // check ran at all; those mean different things and must read differently.
      const unmeasured = rows.filter((r) => r.face_brightness === null).length;

      let verdict = 'CLEAN';
      if (rows.length === 0) verdict = 'NONE';
      else if (unmeasured === rows.length) verdict = 'UNKNOWN';
      // NARROW outranks ADVISED_AGAINST deliberately: on the evidence a narrow
      // set is the worse problem, and a varied set that trips a per-capture
      // brightness hint is usually the better enrolment.
      else if (narrow) verdict = 'NARROW';
      else if (flagged.length > 0) verdict = 'ADVISED_AGAINST';
      else if (unmeasured > 0) verdict = 'PARTLY_UNKNOWN';

      res.json({
        employee_id: req.params.id,
        templates: rows.length,
        // Deliberately a WORD, not a score: these thresholds are provisional
        // (O-4 open) and a number here would be read as a measurement.
        enrolment_quality: verdict,
        advised_against: flagged.length,
        unmeasured,
        brightness_spread: spread === null ? null : Math.round(spread * 10) / 10,
        narrow,
        captures: rows.map((r, i) => ({
          ...r,
          // What we would say now, beside what was said then.
          current_issues: rejudged[i] === null ? null : rejudged[i].join(',') ,
        })),
      });
    },
  );
}
