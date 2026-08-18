/**
 * Event ingest and chain access — FRD §8.5.
 *
 * A phone uploads a batch of things it already recorded. The server checks
 * that it is entitled to, that the submission is well-formed, then assigns
 * `seq`, links `prev_hash`, signs, and appends.
 *
 * Two rules shape everything here:
 *
 *   1. **Nothing is ever silently dropped or silently accepted** (BR-EVD-20).
 *      A submission that cannot be appended goes to quarantine with a reason.
 *      Those are the two failure modes that would each destroy trust in the
 *      record, for opposite reasons.
 *
 *   2. **Re-sending is always safe** (BR-EVD-19). A phone that loses signal
 *      mid-upload has no way to know what arrived, so it must be free to
 *      send everything again. Deduplication is on `event_id`.
 */

import { z } from 'zod';
import { ROLE } from '../lib/vocabulary.js';
import { requireAuth, requireAuthAllowingDrain, requireRole } from '../middleware/auth.js';
import {
  appendEvent, quarantine, chainHead, readRange, verifyChain, isKnownType,
  unreviewedQuarantine,
} from '../lib/chain.js';
import { publicKeyForVerifiers } from '../lib/signing.js';
import { publishHead, publishedHeadsFromFile, publishingPosture } from '../lib/heads.js';
import { subjectRefFor, locationRefFor, locationFor } from '../lib/refs.js';
import { col } from '../db/mongo.js';
import { config } from '../config.js';

const submission = z.object({
  event_id: z.string().uuid(),
  type: z.string().min(1).max(48),
  payload: z.record(z.any()).default({}),
  captured_at: z.string().datetime({ offset: true }).optional(),
  device_time: z.string().max(40).optional(),
  uptime_ms: z.number().int().nonnegative().optional(),
  // Raw coordinates arrive here and are turned into a location_ref before
  // anything is signed. They never enter the envelope — FRD NFR-17.
  location: z.object({
    lat: z.number(),
    lon: z.number(),
    accuracy_m: z.number().int().nonnegative().optional(),
    is_mock: z.boolean().optional(),
  }).optional(),
});

const batchSchema = z.object({
  events: z.array(submission).min(1),
});

export default function eventRoutes(app) {
  /**
   * POST /events — upload a batch.
   *
   * Allowed on a DRAIN_ONLY session, and ONLY here. That is the whole point
   * of the state: a phone displaced by a newer sign-in may still be holding
   * punches captured offline, which exist nowhere else. Refusing them would
   * silently destroy a day's attendance.
   */
  app.post('/events', requireAuthAllowingDrain, async (req, res) => {
    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'BAD_BATCH',
        message: 'That upload could not be read.',
        detail: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }

    const { events } = parsed.data;
    if (events.length > config.chain.maxBatch) {
      return res.status(413).json({
        error: 'BATCH_TOO_LARGE',
        message: `Send at most ${config.chain.maxBatch} events at a time.`,
      });
    }

    const subjectRef = await subjectRefFor(req.employee.employee_id);
    const results = [];

    // Sequentially, not in parallel: the chain is ordered, and a phone's
    // events must land in the order it recorded them.
    for (const e of events) {
      if (!isKnownType(e.type)) {
        await quarantine({
          eventId: e.event_id,
          reason: 'UNKNOWN_TYPE',
          detail: `"${e.type}" is not in the frozen event list`,
          submission: e,
          sessionRef: req.session.session_id,
        }, null, req.log);
        results.push({ event_id: e.event_id, status: 'quarantined', reason: 'UNKNOWN_TYPE' });
        continue;
      }

      try {
        const locationRef = await locationRefFor(e.location);
        const { status, event } = await appendEvent({
          event_id: e.event_id,
          type: e.type,
          subject_ref: subjectRef,
          device_ref: req.session.device_id ?? null,
          session_ref: req.session.session_id,
          location_ref: locationRef,
          payload: e.payload,
          captured_at: e.captured_at,
          device_time: e.device_time,
          uptime_ms: e.uptime_ms,
        });
        results.push({ event_id: e.event_id, status, seq: event.seq, hash: event.hash });
      } catch (err) {
        // Held, not dropped. An event we could not append is evidence that
        // something is wrong, and throwing it away destroys the evidence.
        await quarantine({
          eventId: e.event_id,
          reason: 'APPEND_FAILED',
          detail: err.message,
          submission: e,
          sessionRef: req.session.session_id,
        }, null, req.log);
        results.push({ event_id: e.event_id, status: 'quarantined', reason: 'APPEND_FAILED' });
      }
    }

    const head = await chainHead();
    return res.status(200).json({
      // The phone marks an event CONFIRMED only on seeing it here — the
      // third of SAVED → SENT → CONFIRMED (BR-EVD-16).
      results,
      accepted: results.filter((r) => r.status === 'appended').length,
      duplicates: results.filter((r) => r.status === 'duplicate').length,
      quarantined: results.filter((r) => r.status === 'quarantined').length,
      head,
    });
  });

  /** GET /chain/head — where the chain currently ends. Public to any signed-in user. */
  app.get('/chain/head', requireAuth, async (_req, res) => {
    res.json({
      head: await chainHead(),
      key: publicKeyForVerifiers(),
      publishing: publishingPosture(),
    });
  });

  /**
   * GET /chain/export — the chain, as a verifier receives it.
   *
   * Deliberately contains NO personal data: `subject_ref` and `location_ref`
   * only. Somebody can verify the entire chain is intact without learning
   * who anybody is or where they were (NFR-17). Naming people is a separate,
   * authorised step.
   */
  app.get('/chain/export', requireAuth, requireRole(ROLE.ADMIN), async (req, res) => {
    const from = Number(req.query.from ?? 1);
    const limit = Math.min(Number(req.query.limit ?? 5000), 50000);
    const events = await readRange(from, limit);

    res.json({
      canon_note:
        'Canonicalise each event as {canon_v,seq,event_id,type,subject_ref,device_ref,' +
        'session_ref,location_ref,payload,captured_at,received_at,device_time,uptime_ms,' +
        'prev_hash} — keys sorted, nulls omitted, no whitespace — then SHA-256 and verify.',
      key: publicKeyForVerifiers(),
      head: await chainHead(),
      // From the FILE, not the database. A verifier must never be handed
      // heads by the same store that holds the chain — that is the one
      // comparison the whole scheme depends on.
      published_heads: await publishedHeadsFromFile(),
      publishing: publishingPosture(),
      count: events.length,
      events,
    });
  });

  /** GET /chain/verify — the server checking its own chain. */
  app.get('/chain/verify', requireAuth, requireRole(ROLE.ADMIN), async (req, res) => {
    res.json(await verifyChain({ fromSeq: Number(req.query.from ?? 1) }));
  });

  /**
   * POST /chain/publish — hand out the current head. FRD BR-EVD-21.
   *
   * This is not bookkeeping. Server-side signing protects the chain against
   * everyone EXCEPT whoever runs the server, which is us. A head already in
   * the contractor's possession is the only thing that makes a later
   * rewrite detectable. Skip this and the signatures are decorative.
   */
  app.post('/chain/publish', requireAuth, requireRole(ROLE.ADMIN), async (req, res) => {
    const destination = String(req.body?.destination ?? '').trim();
    if (!destination) {
      return res.status(400).json({
        error: 'DESTINATION_REQUIRED',
        message: 'Say where this head is being published — it is the whole record of who holds it.',
      });
    }

    const head = await chainHead();
    if (head.seq === 0) {
      return res.status(409).json({
        error: 'EMPTY_CHAIN',
        message: 'There is nothing to publish yet.',
      });
    }

    const published = await publishHead(head, destination);

    // The response says plainly whether this was evidence or bookkeeping.
    return res.status(201).json({
      ...published,
      posture: publishingPosture(),
    });
  });

  /**
   * GET /events/mine — an employee's own records, resolved to real values.
   *
   * The resolution happens HERE, at read time, by joining the deletable
   * mapping tables. If those rows are gone the events remain and simply
   * cannot be attributed — which is exactly what erasure is meant to do.
   */
  app.get('/events/mine', requireAuth, async (req, res) => {
    // Two round trips where MySQL used a correlated subquery. A person with no
    // mapping yet has no events, so an absent ref is an empty list, never a
    // query for `subject_ref: null` — which would match every event that has
    // no subject and hand this employee somebody else's records.
    const mapping = await col('subject_refs').findOne({ employee_id: req.employee.employee_id });
    const rows = mapping
      ? await col('events').find({ subject_ref: mapping._id }).sort({ seq: -1 }).limit(100).toArray()
      : [];

    const events = await Promise.all(rows.map(async (r) => ({
      seq: Number(r.seq),
      type: r.type,
      captured_at: r.captured_at,
      received_at: r.received_at,
      location: await locationFor(r.location_ref),
      payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
    })));

    res.json({ events });
  });

  /** GET /quarantine — what could not be appended, and why. Admin only. */
  app.get('/quarantine', requireAuth, requireRole(ROLE.ADMIN), async (_req, res) => {
    res.json({
      items: await col('quarantine')
        .find({}, { projection: { submission: 0 } })
        .sort({ received_at: -1 })
        .limit(200)
        .toArray(),
    });
  });
}
