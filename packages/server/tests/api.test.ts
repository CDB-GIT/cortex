import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { loadConfig } from '../src/utils/config.js';
import { initDatabase, closeDatabase, insertMemory, getDb } from '../src/db/index.js';
import { CortexApp } from '../src/app.js';
import { registerAllRoutes } from '../src/api/router.js';

describe('API Integration', () => {
  let app: FastifyInstance;
  let cortex: CortexApp;

  beforeAll(async () => {
    const config = loadConfig({
      storage: { dbPath: ':memory:', walMode: false },
      llm: { extraction: { provider: 'none' }, lifecycle: { provider: 'none' } },
      embedding: { provider: 'none', dimensions: 4 },
      vectorBackend: { provider: 'sqlite-vec' },
      markdownExport: { enabled: false, exportMemoryMd: false, debounceMs: 999999 },
    });
    initDatabase(':memory:');

    cortex = new CortexApp(config);
    await cortex.initialize();

    app = Fastify();
    await app.register(cors, { origin: true });
    registerAllRoutes(app, cortex);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await cortex.shutdown();
    closeDatabase();
  });

  describe('GET /api/v1/health', () => {
    it('should return health status', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.status).toBe('ok');
    });
  });

  describe('GET /api/v1/stats', () => {
    it('should return stats', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/stats' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(typeof body.total_memories).toBe('number');
    });
  });

  describe('POST /api/v1/memories', () => {
    it('should create a memory', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/memories',
        payload: { layer: 'core', category: 'fact', content: 'API test memory' },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.id).toBeTruthy();
      expect(body.content).toBe('API test memory');
    });
  });

  describe('GET /api/v1/memories', () => {
    it('should list memories', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/memories' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.items).toBeDefined();
      expect(body.total).toBeGreaterThanOrEqual(1);
    });

    it('should filter by layer', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/memories?layer=core' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      body.items.forEach((m: any) => expect(m.layer).toBe('core'));
    });

    it('should resolve and roll back duplicate preferences manually', async () => {
      insertMemory({
        id: 'api-dup-pref-1',
        layer: 'core',
        category: 'preference',
        content: 'User prefers async updates.',
        agent_id: 'api-dup',
        confidence: 0.8,
        importance: 0.7,
        metadata: JSON.stringify({
          audit_flag: 'duplicate_preference',
          preference_duplicate_with: ['api-dup-pref-2', 'api-dup-pref-3'],
        }),
      });
      insertMemory({
        id: 'api-dup-pref-2',
        layer: 'core',
        category: 'preference',
        content: 'User prefers async updates!',
        agent_id: 'api-dup',
        confidence: 0.92,
        importance: 0.7,
        metadata: JSON.stringify({
          audit_flag: 'duplicate_preference',
          preference_duplicate_with: ['api-dup-pref-1', 'api-dup-pref-3'],
        }),
      });
      insertMemory({
        id: 'api-dup-pref-3',
        layer: 'core',
        category: 'preference',
        content: 'User prefers async updates。',
        agent_id: 'api-dup',
        confidence: 0.75,
        importance: 0.7,
        metadata: JSON.stringify({
          audit_flag: 'duplicate_preference',
          preference_duplicate_with: ['api-dup-pref-1', 'api-dup-pref-2'],
        }),
      });

      const resolveRes = await app.inject({
        method: 'POST',
        url: '/api/v1/memories/api-dup-pref-1/duplicate-preference/resolve',
        payload: {
          keeper_id: 'api-dup-pref-2',
          memory_ids: ['api-dup-pref-1', 'api-dup-pref-2', 'api-dup-pref-3'],
        },
      });
      expect(resolveRes.statusCode).toBe(200);
      const resolveBody = JSON.parse(resolveRes.payload);
      expect(resolveBody.ok).toBe(true);
      expect(resolveBody.resolution.keeper_id).toBe('api-dup-pref-2');

      const keeperRes = await app.inject({ method: 'GET', url: '/api/v1/memories/api-dup-pref-2' });
      const supersededRes = await app.inject({ method: 'GET', url: '/api/v1/memories/api-dup-pref-1' });
      const keeper = JSON.parse(keeperRes.payload);
      const superseded = JSON.parse(supersededRes.payload);
      expect(keeper.superseded_by).toBeNull();
      expect(JSON.parse(keeper.metadata).duplicate_resolution.role).toBe('keeper');
      expect(JSON.parse(keeper.metadata).audit_flag).toBeUndefined();
      expect(superseded.superseded_by).toBe('api-dup-pref-2');
      expect(JSON.parse(superseded.metadata).duplicate_resolution.role).toBe('superseded');

      const logRes = await app.inject({ method: 'GET', url: '/api/v1/lifecycle/log?limit=20' });
      const logBody = JSON.parse(logRes.payload);
      expect(logBody.items.some((item: any) => item.action === 'preference_duplicate_resolved')).toBe(true);

      const rollbackRes = await app.inject({
        method: 'POST',
        url: '/api/v1/memories/api-dup-pref-2/duplicate-preference/rollback',
        payload: {
          resolution_id: resolveBody.resolution.resolution_id,
        },
      });
      expect(rollbackRes.statusCode).toBe(200);
      const rollbackBody = JSON.parse(rollbackRes.payload);
      expect(rollbackBody.ok).toBe(true);

      const restored1 = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/memories/api-dup-pref-1' })).payload);
      const restored2 = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/memories/api-dup-pref-2' })).payload);
      const restored3 = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/memories/api-dup-pref-3' })).payload);
      expect(restored1.superseded_by).toBeNull();
      expect(restored2.superseded_by).toBeNull();
      expect(restored3.superseded_by).toBeNull();
      expect(JSON.parse(restored1.metadata).audit_flag).toBe('duplicate_preference');
      expect(JSON.parse(restored2.metadata).audit_flag).toBe('duplicate_preference');
      expect(JSON.parse(restored3.metadata).audit_flag).toBe('duplicate_preference');

      const rollbackLogRes = await app.inject({ method: 'GET', url: '/api/v1/lifecycle/log?limit=20' });
      const rollbackLogBody = JSON.parse(rollbackLogRes.payload);
      expect(rollbackLogBody.items.some((item: any) => item.action === 'preference_duplicate_resolution_rolled_back')).toBe(true);
    });

    it('should resolve and roll back a timeline update candidate manually', async () => {
      insertMemory({
        id: 'api-timeline-old',
        layer: 'core',
        category: 'fact',
        content: 'User lives in Tokyo.',
        agent_id: 'api-timeline',
        confidence: 0.88,
        importance: 0.7,
        metadata: JSON.stringify({
          audit_flag: 'possible_conflict',
          audit_reason: 'contradiction_llm',
          audit_kind: 'timeline_update_candidate',
          audit_conflict_with: ['api-timeline-new'],
          audit_decision: 'keep_b',
          audit_decision_reason: 'newer memory reflects the latest state',
          audit_current_candidate_id: 'api-timeline-new',
          audit_history_candidate_id: 'api-timeline-old',
          audit_timeline_role: 'history_candidate',
        }),
      });
      insertMemory({
        id: 'api-timeline-new',
        layer: 'core',
        category: 'fact',
        content: 'User moved to Osaka recently.',
        agent_id: 'api-timeline',
        confidence: 0.82,
        importance: 0.72,
        metadata: JSON.stringify({
          audit_flag: 'possible_conflict',
          audit_reason: 'contradiction_llm',
          audit_kind: 'timeline_update_candidate',
          audit_conflict_with: ['api-timeline-old'],
          audit_decision: 'keep_b',
          audit_decision_reason: 'newer memory reflects the latest state',
          audit_current_candidate_id: 'api-timeline-new',
          audit_history_candidate_id: 'api-timeline-old',
          audit_timeline_role: 'current_candidate',
        }),
      });

      const resolveRes = await app.inject({
        method: 'POST',
        url: '/api/v1/memories/api-timeline-new/timeline-update/resolve',
        payload: {
          current_id: 'api-timeline-new',
          history_id: 'api-timeline-old',
        },
      });
      expect(resolveRes.statusCode).toBe(200);
      const resolveBody = JSON.parse(resolveRes.payload);
      expect(resolveBody.ok).toBe(true);

      const current = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/memories/api-timeline-new' })).payload);
      const history = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/memories/api-timeline-old' })).payload);
      expect(current.superseded_by).toBeNull();
      expect(history.superseded_by).toBe('api-timeline-new');
      expect(JSON.parse(current.metadata).timeline_resolution.role).toBe('current');
      expect(JSON.parse(history.metadata).timeline_resolution.role).toBe('history');

      const logRes = await app.inject({ method: 'GET', url: '/api/v1/lifecycle/log?limit=20' });
      const logBody = JSON.parse(logRes.payload);
      expect(logBody.items.some((item: any) => item.action === 'timeline_update_resolved')).toBe(true);

      const rollbackRes = await app.inject({
        method: 'POST',
        url: '/api/v1/memories/api-timeline-new/timeline-update/rollback',
        payload: {
          resolution_id: resolveBody.resolution.resolution_id,
        },
      });
      expect(rollbackRes.statusCode).toBe(200);
      const rollbackCurrent = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/memories/api-timeline-new' })).payload);
      const rollbackHistory = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/memories/api-timeline-old' })).payload);
      expect(rollbackCurrent.superseded_by).toBeNull();
      expect(rollbackHistory.superseded_by).toBeNull();
      expect(JSON.parse(rollbackCurrent.metadata).audit_kind).toBe('timeline_update_candidate');
      expect(JSON.parse(rollbackHistory.metadata).audit_kind).toBe('timeline_update_candidate');

      const rollbackLogRes = await app.inject({ method: 'GET', url: '/api/v1/lifecycle/log?limit=20' });
      const rollbackLogBody = JSON.parse(rollbackLogRes.payload);
      expect(rollbackLogBody.items.some((item: any) => item.action === 'timeline_update_resolution_rolled_back')).toBe(true);
    });

    it('should roll back an auto-resolved timeline update pair', async () => {
      insertMemory({
        id: 'api-timeline-auto-old',
        layer: 'core',
        category: 'fact',
        content: 'User lives in Tokyo.',
        agent_id: 'api-timeline-auto',
        confidence: 0.88,
        importance: 0.7,
        superseded_by: 'api-timeline-auto-new' as any,
        metadata: JSON.stringify({
          timeline_resolution: {
            resolution_id: 'auto-resolution-1',
            resolution_type: 'auto_timeline_keep_current',
            role: 'history',
            current_id: 'api-timeline-auto-new',
            history_id: 'api-timeline-auto-old',
            resolved_at: new Date().toISOString(),
            resolved_by: 'lifecycle',
          },
        }),
      });
      insertMemory({
        id: 'api-timeline-auto-new',
        layer: 'core',
        category: 'fact',
        content: 'User moved to Osaka recently.',
        agent_id: 'api-timeline-auto',
        confidence: 0.84,
        importance: 0.72,
        metadata: JSON.stringify({
          timeline_resolution: {
            resolution_id: 'auto-resolution-1',
            resolution_type: 'auto_timeline_keep_current',
            role: 'current',
            current_id: 'api-timeline-auto-new',
            history_id: 'api-timeline-auto-old',
            resolved_at: new Date().toISOString(),
            resolved_by: 'lifecycle',
          },
        }),
      });
      getDb().prepare("UPDATE memories SET superseded_by = ? WHERE id = ?").run('api-timeline-auto-new', 'api-timeline-auto-old');

      const rollbackRes = await app.inject({
        method: 'POST',
        url: '/api/v1/memories/api-timeline-auto-new/timeline-update/rollback',
        payload: {
          resolution_id: 'auto-resolution-1',
        },
      });
      expect(rollbackRes.statusCode).toBe(200);

      const rollbackCurrent = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/memories/api-timeline-auto-new' })).payload);
      const rollbackHistory = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/memories/api-timeline-auto-old' })).payload);
      expect(rollbackCurrent.superseded_by).toBeNull();
      expect(rollbackHistory.superseded_by).toBeNull();
      expect(JSON.parse(rollbackCurrent.metadata).audit_kind).toBe('timeline_update_candidate');
      expect(JSON.parse(rollbackHistory.metadata).audit_kind).toBe('timeline_update_candidate');
    });

    it('should resolve and roll back a conflict review pair manually', async () => {
      insertMemory({
        id: 'api-conflict-left',
        layer: 'core',
        category: 'fact',
        content: 'User only works on-site and never accepts remote work.',
        agent_id: 'api-conflict',
        confidence: 0.82,
        importance: 0.72,
        metadata: JSON.stringify({
          audit_flag: 'possible_conflict',
          audit_reason: 'contradiction_llm',
          audit_kind: 'conflict_needs_review',
          audit_conflict_with: ['api-conflict-right'],
          audit_decision: 'needs_review',
          audit_decision_reason: 'claims conflict directly and need manual confirmation',
        }),
      });
      insertMemory({
        id: 'api-conflict-right',
        layer: 'core',
        category: 'fact',
        content: 'User works fully remote and does not go on-site.',
        agent_id: 'api-conflict',
        confidence: 0.8,
        importance: 0.72,
        metadata: JSON.stringify({
          audit_flag: 'possible_conflict',
          audit_reason: 'contradiction_llm',
          audit_kind: 'conflict_needs_review',
          audit_conflict_with: ['api-conflict-left'],
          audit_decision: 'needs_review',
          audit_decision_reason: 'claims conflict directly and need manual confirmation',
        }),
      });

      const resolveRes = await app.inject({
        method: 'POST',
        url: '/api/v1/memories/api-conflict-left/conflict-review/resolve',
        payload: {
          winner_id: 'api-conflict-right',
          superseded_id: 'api-conflict-left',
        },
      });
      expect(resolveRes.statusCode).toBe(200);
      const resolveBody = JSON.parse(resolveRes.payload);
      expect(resolveBody.ok).toBe(true);

      const winner = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/memories/api-conflict-right' })).payload);
      const superseded = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/memories/api-conflict-left' })).payload);
      expect(winner.superseded_by).toBeNull();
      expect(superseded.superseded_by).toBe('api-conflict-right');
      expect(JSON.parse(winner.metadata).conflict_resolution.role).toBe('winner');
      expect(JSON.parse(superseded.metadata).conflict_resolution.role).toBe('superseded');

      const logRes = await app.inject({ method: 'GET', url: '/api/v1/lifecycle/log?limit=20' });
      const logBody = JSON.parse(logRes.payload);
      expect(logBody.items.some((item: any) => item.action === 'conflict_review_resolved')).toBe(true);

      const rollbackRes = await app.inject({
        method: 'POST',
        url: '/api/v1/memories/api-conflict-right/conflict-review/rollback',
        payload: {
          resolution_id: resolveBody.resolution.resolution_id,
        },
      });
      expect(rollbackRes.statusCode).toBe(200);
      const rollbackWinner = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/memories/api-conflict-right' })).payload);
      const rollbackSuperseded = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/memories/api-conflict-left' })).payload);
      expect(rollbackWinner.superseded_by).toBeNull();
      expect(rollbackSuperseded.superseded_by).toBeNull();
      expect(JSON.parse(rollbackWinner.metadata).audit_kind).toBe('conflict_needs_review');
      expect(JSON.parse(rollbackSuperseded.metadata).audit_kind).toBe('conflict_needs_review');

      const rollbackLogRes = await app.inject({ method: 'GET', url: '/api/v1/lifecycle/log?limit=20' });
      const rollbackLogBody = JSON.parse(rollbackLogRes.payload);
      expect(rollbackLogBody.items.some((item: any) => item.action === 'conflict_review_resolution_rolled_back')).toBe(true);
    });
  });

  describe('POST /api/v1/ingest', () => {
    it('should ingest a conversation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/ingest',
        payload: {
          user_message: '我叫Harry，我住在东京',
          assistant_message: '你好Harry！东京是个好地方。',
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.high_signals).toBeDefined();
    });
  });

  describe('POST /api/v1/recall', () => {
    it('should recall memories', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/recall',
        payload: { query: 'Harry Tokyo' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.meta).toBeDefined();
    });

    it('should skip small talk', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/recall',
        payload: { query: 'hi' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.meta.skipped).toBe(true);
    });
  });

  describe('POST /api/v1/search', () => {
    it('should search memories', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/search',
        payload: { query: 'test', debug: true },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.results).toBeDefined();
    });
  });

  describe('POST /api/v1/relations', () => {
    it('should create a relation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/relations',
        payload: { subject: 'Harry', predicate: 'lives_in', object: 'Tokyo', confidence: 0.9 },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.id).toBeTruthy();
    });
  });

  describe('GET /api/v1/relations', () => {
    it('should list relations', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/relations' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
    });
  });

  describe('POST /api/v1/lifecycle/run', () => {
    it('should run lifecycle (dry run)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/lifecycle/run',
        payload: { dry_run: true },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(typeof body.promoted).toBe('number');
      expect(Array.isArray(body.observability?.phases)).toBe(true);
    });
  });

  describe('GET /api/v1/lifecycle/stats', () => {
    it('should return lifecycle stats snapshot', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/lifecycle/stats',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.layerCounts).toBeDefined();
      expect(typeof body.archiveCandidates).toBe('number');
      expect(Array.isArray(body.categoryStats)).toBe(true);
      expect(body.analysis).toBeDefined();
      expect(typeof body.analysis.recommendation.shouldAdjust).toBe('boolean');
    });
  });

  describe('GET /api/v1/config', () => {
    it('should return config', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/config' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.port).toBeDefined();
    });
  });
});
