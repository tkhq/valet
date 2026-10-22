import { createHash, randomUUID } from "node:crypto";
import { and, eq, lte, sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { tagDimensionState, tagJobs, tagKeys, tagLabels, tagSubjects } from "../schema/index.js";
import { capSubjectText, normalizeKey, validKey, type Dimension, type SubjectRef, type TagSubject } from "./dimension.js";
import { classifierPrompt, parseClassification, type Classify } from "./classifier.js";
import { dimensionWhere, promoteKeys, readRegistry, resolveKey, seedRegistry, TagRegistry } from "./registry.js";

export const TAG_BATCH_SIZE = 50;
const LEASE_MS = 120_000;
export type SubjectRenderer = (refs: readonly SubjectRef[]) => Promise<TagSubject[]>;
const subjectWhere = (orgId: string, dimension: string, subject: SubjectRef) => and(eq(tagSubjects.orgId, orgId), eq(tagSubjects.dimension, dimension), eq(tagSubjects.subjectType, subject.type), eq(tagSubjects.subjectId, subject.id));
const labelWhere = (orgId: string, dimension: string, subject: SubjectRef) => and(eq(tagLabels.orgId, orgId), eq(tagLabels.dimension, dimension), eq(tagLabels.subjectType, subject.type), eq(tagLabels.subjectId, subject.id));
const stateWhere = (orgId: string, dimension: string) => and(eq(tagDimensionState.orgId, orgId), eq(tagDimensionState.dimension, dimension));
const jobWhere = (orgId: string, dimension: string, subject: SubjectRef) => and(eq(tagJobs.orgId, orgId), eq(tagJobs.dimension, dimension), eq(tagJobs.subjectType, subject.type), eq(tagJobs.subjectId, subject.id));
const hashInput = (dimension: string, subject: TagSubject) => createHash("sha256").update(JSON.stringify([dimension, subject.text, subject.command ?? null])).digest("hex");

/** Durable refs only. The caller owns rendering and the confidentiality of text. */
export async function enqueueTagging(db: AppDb, orgId: string, dimension: string, refs: readonly SubjectRef[], force = false): Promise<void> {
  const unique = [...new Map(refs.map(ref => [`${ref.type}:${ref.id}`, ref])).values()];
  for (let offset = 0; offset < unique.length; offset += TAG_BATCH_SIZE) {
    await db.insert(tagJobs).values(unique.slice(offset, offset + TAG_BATCH_SIZE).map(ref => ({ orgId, dimension, subjectType: ref.type, subjectId: ref.id, nextAttemptAt: Date.now(), force })))
      .onConflictDoUpdate({ target: [tagJobs.orgId, tagJobs.dimension, tagJobs.subjectType, tagJobs.subjectId],
        set: { version: sql`${tagJobs.version} + 1`, attempts: 0, nextAttemptAt: Date.now(), force: sql`${tagJobs.force} OR ${force}` } });
  }
}

export class Tagger {
  readonly registry: TagRegistry;
  private readonly dimensions: Map<string, Dimension>;
  constructor(private readonly deps: { db: AppDb; orgId: string; dimensions: readonly Dimension[]; classify: Classify; renderers: ReadonlyMap<string, SubjectRenderer> }) {
    this.dimensions = new Map(deps.dimensions.map(dimension => [dimension.id, dimension]));
    if (this.dimensions.size !== deps.dimensions.length) throw new Error("Duplicate tag dimension. Register each dimension once.");
    this.registry = new TagRegistry(deps.db, deps.orgId);
  }
  private dimension(id: string): Dimension {
    const dimension = this.dimensions.get(id);
    if (!dimension) throw new Error("Unknown tag dimension. Register it before tagging subjects.");
    return dimension;
  }
  async initialize(id: string): Promise<void> {
    const dimension = this.dimension(id);
    await seedRegistry(this.deps.db, this.deps.orgId, dimension);
    await this.deps.db.insert(tagDimensionState).values({ orgId: this.deps.orgId, dimension: id }).onConflictDoNothing();
  }
  enqueueTagging(id: string, refs: readonly SubjectRef[]) {
    const dimension = this.dimension(id);
    if (refs.some(ref => !dimension.subjectTypes.includes(ref.type))) throw new Error("Unsupported tag subject. Register its renderer and dimension subject type first.");
    return enqueueTagging(this.deps.db, this.deps.orgId, id, refs);
  }
  async labelsFor(subjectType: string, subjectId: string) {
    const rows = await this.deps.db.select().from(tagLabels).where(and(eq(tagLabels.orgId, this.deps.orgId), eq(tagLabels.subjectType, subjectType), eq(tagLabels.subjectId, subjectId)));
    const registries = new Map(await Promise.all([...new Set(rows.map(row => row.dimension))].map(async dimension => [dimension, await this.registry.list(dimension)] as const)));
    const resolved = rows.map(row => ({ ...row, originalKey: row.key, key: resolveKey(registries.get(row.dimension) ?? [], row.key) }));
    return [...new Map(resolved.map(row => [`${row.dimension}:${row.key}`, row])).values()];
  }
  async aggregate(dimension: string, filters: { subjectType?: string; startMs?: number; endMs?: number } = {}) {
    this.dimension(dimension);
    const rows = await this.deps.db.execute(sql`SELECT key, count(*)::int AS calls FROM tag_resolved_labels
      WHERE org_id = ${this.deps.orgId} AND dimension = ${dimension}
      ${filters.subjectType ? sql`AND subject_type = ${filters.subjectType}` : sql``}
      ${filters.startMs !== undefined ? sql`AND classified_at >= ${filters.startMs}` : sql``}
      ${filters.endMs !== undefined ? sql`AND classified_at < ${filters.endMs}` : sql``} GROUP BY key ORDER BY calls DESC, key`) as { rows: { key: string; calls: unknown }[] };
    return rows.rows.map(row => ({ key: String(row.key), calls: Number(row.calls) }));
  }

  async tag(id: string, subjects: readonly TagSubject[], force = false): Promise<boolean> {
    if (!subjects.length) return true;
    if (subjects.length > TAG_BATCH_SIZE) throw new Error("Tag batch exceeds 50 subjects. Split it into bounded batches.");
    await this.initialize(id);
    return this.withLease(id, token => this.classifyBatch(this.dimension(id), subjects, force, token));
  }

  private async withLease(id: string, work: (token: string) => Promise<void>): Promise<boolean> {
    const { db, orgId } = this.deps;
    const token = randomUUID();
    const claimed = await db.update(tagDimensionState).set({ leaseToken: token, leaseUntil: Date.now() + LEASE_MS })
      .where(and(stateWhere(orgId, id), lte(tagDimensionState.leaseUntil, Date.now()))).returning();
    if (!claimed.length) return false;
    try {
      await work(token);
      return true;
    } finally {
      await db.update(tagDimensionState).set({ leaseUntil: 0, leaseToken: null }).where(and(stateWhere(orgId, id), eq(tagDimensionState.leaseToken, token)));
    }
  }

  private async classifyBatch(dimension: Dimension, provided: readonly TagSubject[], force: boolean, token: string): Promise<void> {
    const { db, orgId } = this.deps;
    const subjects: TagSubject[] = [];
    for (const source of new Map(provided.map(subject => [`${subject.type}:${subject.id}`, subject])).values()) {
      if (!dimension.subjectTypes.includes(source.type)) throw new Error("Unsupported tag subject. Register its subject type first.");
      const subject = { ...source, text: capSubjectText(source.text) };
      const [old] = await db.select().from(tagSubjects).where(subjectWhere(orgId, dimension.id, subject));
      if (!force && old?.inputHash === hashInput(dimension.id, subject)) continue;
      subjects.push(subject);
    }
    if (!subjects.length) return;
    const keys = await readRegistry(db, orgId, dimension.id);
    const rules = new Map(subjects.map(subject => [subject, dimension.rules?.(subject)]));
    // Blank subjects without a deterministic rule stay unlabeled, not other.
    const modelSubjects = subjects.filter(subject => !rules.get(subject) && subject.text.trim());
    const response = modelSubjects.length ? await this.deps.classify({ dimension: dimension.id, subjects: modelSubjects,
      prompt: classifierPrompt(dimension, keys, modelSubjects), signal: AbortSignal.timeout(30_000) }) : { text: "{}", model: "rule" };
    const parsed = parseClassification(response.text);
    const predictions = modelSubjects.map((_subject, index) => {
      const matches = parsed.subjects.filter(row => row.index === index);
      return matches.length === 1 ? matches[0]?.labels ?? [] : [];
    });
    await db.transaction(async tx => {
      // Expired workers cannot publish labels over a newer owner's batch.
      const lock = await tx.execute(sql`SELECT lease_until FROM tag_dimension_state WHERE org_id = ${orgId} AND dimension = ${dimension.id} AND lease_token = ${token} FOR UPDATE`) as { rows: { lease_until: unknown }[] };
      if (Number(lock.rows[0]?.lease_until ?? 0) <= Date.now()) throw new Error("Tagging lease expired. Retry the batch.");
      let created = false;
      const existing = new Set(keys.map(key => key.key));
      for (const proposal of dimension.open ? parsed.newKeys : []) {
        const key = normalizeKey(proposal.key);
        if (!validKey(key) || existing.has(key)) continue;
        const examples = modelSubjects.filter((_subject, index) => predictions[index]?.some(label => normalizeKey(label.key) === key)).map(subject => subject.text).slice(0, 3);
        if (!examples.length) continue;
        if (keys.filter(row => row.status !== "merged").length >= dimension.maxActiveKeys) {
          await tx.update(tagDimensionState).set({ consolidationDue: true }).where(stateWhere(orgId, dimension.id));
          continue;
        }
        const [inserted] = await tx.insert(tagKeys).values({ orgId, dimension: dimension.id, key, label: proposal.label, definition: proposal.definition,
          examples, origin: "classifier", status: "provisional", createdAt: Date.now(), updatedAt: Date.now() }).onConflictDoNothing().returning();
        if (inserted) { keys.push({ ...inserted, assignments: 0, users: 0 }); existing.add(key); created = true; }
      }
      const assignedExamples = new Map<string, Set<string>>();
      for (const subject of subjects) {
        const rule = rules.get(subject);
        const prediction = predictions[modelSubjects.indexOf(subject)] ?? [];
        const candidates = rule ? [{ key: rule, confidence: 1 }] : prediction;
        const selected = candidates.flatMap(label => {
          const key = normalizeKey(label.key);
          if (!existing.has(key)) return [];
          return [{ key: resolveKey(keys, key), confidence: label.confidence }];
        });
        const unique = [...new Map(selected.map(label => [label.key, label])).values()];
        const labels = dimension.mode === "single" && (subject.text.trim() || rule)
          ? unique.length === 1 && candidates.length === 1 ? unique : [{ key: "other", confidence: 0 }] : unique;
        if (subject.text.trim()) for (const label of labels) {
          const examples = assignedExamples.get(label.key) ?? new Set<string>();
          examples.add(subject.text); assignedExamples.set(label.key, examples);
        }
        const inputHash = hashInput(dimension.id, subject);
        await tx.insert(tagSubjects).values({ orgId, dimension: dimension.id, subjectType: subject.type, subjectId: subject.id, userId: subject.userId, inputHash })
          .onConflictDoUpdate({ target: [tagSubjects.orgId, tagSubjects.dimension, tagSubjects.subjectType, tagSubjects.subjectId], set: { inputHash, userId: subject.userId } });
        await tx.delete(tagLabels).where(labelWhere(orgId, dimension.id, subject));
        if (labels.length) await tx.insert(tagLabels).values(labels.map(label => ({ ...label, orgId, dimension: dimension.id, mode: dimension.mode,
          subjectType: subject.type, subjectId: subject.id, inputHash, model: rule ? "rule" : response.model, classifiedAt: Date.now() })));
      }
      for (const key of keys.filter(key => key.origin === "classifier" && key.status !== "merged")) {
        const examples = new Set([...key.examples, ...assignedExamples.get(key.key) ?? []]);
        await tx.update(tagKeys).set({ examples: [...examples].slice(0, 3) }).where(and(dimensionWhere(orgId, dimension.id), eq(tagKeys.key, key.key)));
      }
      await promoteKeys(tx, orgId, dimension.id);
      if (created) {
        const retry = await tx.select({ type: tagSubjects.subjectType, id: tagSubjects.subjectId }).from(tagSubjects)
          .innerJoin(tagLabels, and(eq(tagLabels.orgId, tagSubjects.orgId), eq(tagLabels.dimension, tagSubjects.dimension), eq(tagLabels.subjectType, tagSubjects.subjectType), eq(tagLabels.subjectId, tagSubjects.subjectId)))
          .where(and(eq(tagSubjects.orgId, orgId), eq(tagSubjects.dimension, dimension.id), eq(tagSubjects.otherRetried, false), eq(tagLabels.key, "other"))).limit(TAG_BATCH_SIZE);
        for (const ref of retry) {
          await tx.update(tagSubjects).set({ otherRetried: true }).where(subjectWhere(orgId, dimension.id, ref));
          await tx.insert(tagJobs).values({ orgId, dimension: dimension.id, subjectType: ref.type, subjectId: ref.id, force: true, nextAttemptAt: Date.now() })
            .onConflictDoUpdate({ target: [tagJobs.orgId, tagJobs.dimension, tagJobs.subjectType, tagJobs.subjectId], set: { force: true, version: sql`${tagJobs.version} + 1`, attempts: 0, nextAttemptAt: Date.now() } });
        }
      }
    });
  }

  /** One run handles at most 50 refs. The existing event dispatcher owns retry ticks. */
  async drain(id: string): Promise<number> {
    await this.initialize(id);
    let processed = 0;
    await this.withLease(id, async token => {
      const { db, orgId } = this.deps;
      const jobs = await db.select().from(tagJobs).where(and(eq(tagJobs.orgId, orgId), eq(tagJobs.dimension, id), lte(tagJobs.nextAttemptAt, Date.now()), sql`${tagJobs.attempts} < 5`)).orderBy(tagJobs.nextAttemptAt, tagJobs.subjectId).limit(TAG_BATCH_SIZE);
      if (!jobs.length) return;
      try {
        const subjects: TagSubject[] = [];
        for (const type of new Set(jobs.map(job => job.subjectType))) {
          const renderer = this.deps.renderers.get(type);
          if (!renderer) throw new Error("Missing tag renderer. Register the subject renderer before draining jobs.");
          const refs = jobs.filter(job => job.subjectType === type).map(job => ({ type, id: job.subjectId }));
          const rendered = await renderer(refs);
          subjects.push(...rendered.filter(subject => refs.some(ref => ref.type === subject.type && ref.id === subject.id)));
        }
        await this.classifyBatch(this.dimension(id), subjects, jobs.some(job => job.force), token);
        for (const job of jobs) await db.delete(tagJobs).where(and(jobWhere(orgId, id, { type: job.subjectType, id: job.subjectId }), eq(tagJobs.version, job.version)));
        processed = jobs.length;
      } catch (error) {
        for (const job of jobs) await db.update(tagJobs).set({ attempts: job.attempts + 1, nextAttemptAt: Date.now() + 30_000 * 2 ** job.attempts })
          .where(and(jobWhere(orgId, id, { type: job.subjectType, id: job.subjectId }), eq(tagJobs.version, job.version)));
        throw error;
      }
    });
    return processed;
  }
}
