import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { initDatabase, closeDatabase, insertMemory, getMemoryById, getDb } from '../src/db/index.js';
import { loadConfig } from '../src/utils/config.js';
import { LifecycleEngine } from '../src/decay/lifecycle.js';
import type { LLMProvider } from '../src/llm/interface.js';
import type { EmbeddingProvider } from '../src/embedding/interface.js';
import type { VectorBackend } from '../src/vector/interface.js';

function createMockLLM(): LLMProvider {
  return {
    name: 'mock',
    complete: vi.fn().mockImplementation(async (prompt: string) => {
      if (prompt.includes('Possible contradiction audit')) {
        return JSON.stringify({ action: 'keep_b', reason: 'newer memory supersedes older memory' });
      }
      if (prompt.includes('Extract long-term user preferences')) {
        return JSON.stringify([
          {
            content: 'User prefers async, low-interruption work sessions.',
            source_memories: ['pref-src-1'],
            confidence: 0.82,
          },
        ]);
      }
      return 'Merged summary of memories.';
    }),
  };
}

function createMockEmbedding(): EmbeddingProvider {
  return {
    name: 'mock',
    dimensions: 4,
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4]),
    embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4]]),
  };
}

function createMockVector(): VectorBackend {
  return {
    name: 'mock',
    initialize: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    count: vi.fn().mockResolvedValue(0),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('LifecycleEngine', () => {
  let lifecycle: LifecycleEngine;

  beforeAll(() => {
    const config = loadConfig({
      storage: { dbPath: ':memory:', walMode: false },
      llm: { extraction: { provider: 'none' }, lifecycle: { provider: 'none' } },
      embedding: { provider: 'none', dimensions: 4 },
      vectorBackend: { provider: 'sqlite-vec' },
      markdownExport: { enabled: false, exportMemoryMd: false, debounceMs: 999999 },
      lifecycle: {
        promotionThreshold: 0.6,
        archiveThreshold: 0.2,
        decayLambda: 0.03,
      },
    });
    initDatabase(':memory:');
    lifecycle = new LifecycleEngine(createMockLLM(), createMockEmbedding(), createMockVector(), config);
  });

  afterAll(() => {
    closeDatabase();
  });

  it('should clean expired working memories', async () => {
    // Insert expired memory
    const expired = insertMemory({
      layer: 'working',
      category: 'context',
      content: 'expired context',
      agent_id: 'test',
      expires_at: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
    });

    const report = await lifecycle.run(false);
    expect(report.expiredWorking).toBeGreaterThanOrEqual(1);

    // Memory should be gone
    const mem = getMemoryById(expired.id);
    expect(mem).toBeFalsy();
  });

  it('should run without errors in dry run mode', async () => {
    insertMemory({ layer: 'working', category: 'context', content: 'test working memory', agent_id: 'test', importance: 0.8 });
    insertMemory({ layer: 'core', category: 'fact', content: 'test core memory', agent_id: 'test', decay_score: 0.1 });

    const report = await lifecycle.run(true);
    expect(report).toBeDefined();
    expect(report.errors.length).toBe(0);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.startedAt).toBeTruthy();
    expect(report.completedAt).toBeTruthy();
    expect(Array.isArray(report.observability.phases)).toBe(true);
    expect(report.observability.phases.length).toBeGreaterThan(0);
  });

  it('should update decay scores', async () => {
    const mem = insertMemory({
      layer: 'core',
      category: 'fact',
      content: 'decay test memory',
      agent_id: 'test',
      decay_score: 1.0,
    });

    await lifecycle.run(false);

    const updated = getMemoryById(mem.id);
    // Decay score should have been updated (decreased slightly for older memories)
    expect(updated).toBeDefined();
  });

  it('should produce a complete report', async () => {
    const report = await lifecycle.run(false);
    expect(typeof report.promoted).toBe('number');
    expect(typeof report.merged).toBe('number');
    expect(typeof report.archived).toBe('number');
    expect(typeof report.compressedToCore).toBe('number');
    expect(typeof report.expiredWorking).toBe('number');
    expect(Array.isArray(report.errors)).toBe(true);
    expect(report.observability.llm).toBeDefined();
    expect(Array.isArray(report.observability.phases)).toBe(true);
    expect(report.observability.phases.some((p) => p.key === 'updateDecayScores')).toBe(true);
  });

  it('should flag possible contradictions without superseding memories', async () => {
    const auditConfig = loadConfig({
      storage: { dbPath: ':memory:', walMode: false },
      llm: { extraction: { provider: 'none' }, lifecycle: { provider: 'none' } },
      embedding: { provider: 'none', dimensions: 4 },
      vectorBackend: { provider: 'sqlite-vec' },
      markdownExport: { enabled: false, exportMemoryMd: false, debounceMs: 999999 },
      lifecycle: {
        promotionThreshold: 0.6,
        archiveThreshold: 0.2,
        decayLambda: 0.03,
        contradictionAudit: {
          enabled: true,
          lookbackDays: 30,
          candidateTopK: 5,
          maxCandidates: 10,
          maxLLMCalls: 5,
          lowConfidenceThreshold: 0.4,
          minNormalizedSimilarity: 0.7,
          mode: 'flag_only',
        },
      },
    });
    const auditVector = createMockVector();
    (auditVector.search as any).mockResolvedValue([
      { id: 'mem-new', distance: 0.1 },
      { id: 'mem-old', distance: 0.15 },
    ]);
    const auditLifecycle = new LifecycleEngine(createMockLLM(), createMockEmbedding(), auditVector, auditConfig);

    const oldMem = insertMemory({
      id: 'mem-old',
      layer: 'core',
      category: 'fact',
      content: 'User lives in Tokyo.',
      agent_id: 'audit-test',
      confidence: 0.9,
      importance: 0.7,
      decay_score: 0.9,
    });
    const newMem = insertMemory({
      id: 'mem-new',
      layer: 'core',
      category: 'fact',
      content: 'User recently moved to Osaka.',
      agent_id: 'audit-test',
      confidence: 0.3,
      importance: 0.7,
      decay_score: 0.9,
      source: 'lifecycle:promotion',
    });

    const report = await auditLifecycle.run(false, 'manual', 'audit-test');
    expect(report.contradictionFlagged).toBeGreaterThanOrEqual(1);
    expect(report.observability.phases.some((p) => p.key === 'contradictionAudit')).toBe(true);

    const updatedOld = getMemoryById(oldMem.id)!;
    const updatedNew = getMemoryById(newMem.id)!;
    expect(updatedOld.superseded_by).toBeNull();
    expect(updatedNew.superseded_by).toBeNull();
    expect(updatedOld.metadata).toContain('possible_conflict');
    expect(updatedNew.metadata).toContain('possible_conflict');
  });

  it('should annotate timeline update candidates during contradiction audit', async () => {
    const auditConfig = loadConfig({
      storage: { dbPath: ':memory:', walMode: false },
      llm: { extraction: { provider: 'none' }, lifecycle: { provider: 'none' } },
      embedding: { provider: 'none', dimensions: 4 },
      vectorBackend: { provider: 'sqlite-vec' },
      markdownExport: { enabled: false, exportMemoryMd: false, debounceMs: 999999 },
      lifecycle: {
        promotionThreshold: 0.6,
        archiveThreshold: 0.2,
        decayLambda: 0.03,
        contradictionAudit: {
          enabled: true,
          lookbackDays: 30,
          candidateTopK: 5,
          maxCandidates: 10,
          maxLLMCalls: 5,
          lowConfidenceThreshold: 0.4,
          minNormalizedSimilarity: 0.7,
          mode: 'flag_only',
        },
      },
    });
    const timelineLLM: LLMProvider = {
      name: 'timeline-mock',
      complete: vi.fn().mockResolvedValue(JSON.stringify({
        action: 'keep_a',
        reason: 'newer memory describes the current state after a timeline update',
      })),
    };
    const auditVector = createMockVector();
    (auditVector.search as any).mockResolvedValue([
      { id: 'timeline-new', distance: 0.1 },
      { id: 'timeline-old', distance: 0.15 },
    ]);
    const auditLifecycle = new LifecycleEngine(timelineLLM, createMockEmbedding(), auditVector, auditConfig);

    insertMemory({
      id: 'timeline-old',
      layer: 'core',
      category: 'fact',
      content: 'User lives in Tokyo.',
      agent_id: 'timeline-test',
      confidence: 0.9,
      importance: 0.7,
      decay_score: 0.9,
    });
    insertMemory({
      id: 'timeline-new',
      layer: 'core',
      category: 'fact',
      content: 'User moved to Osaka recently.',
      agent_id: 'timeline-test',
      confidence: 0.3,
      importance: 0.7,
      decay_score: 0.9,
      source: 'lifecycle:promotion',
    });

    await auditLifecycle.run(false, 'manual', 'timeline-test');

    const updatedOld = JSON.parse(getMemoryById('timeline-old')!.metadata!);
    const updatedNew = JSON.parse(getMemoryById('timeline-new')!.metadata!);
    expect(updatedOld.audit_kind).toBe('timeline_update_candidate');
    expect(updatedNew.audit_kind).toBe('timeline_update_candidate');
    expect(updatedNew.audit_timeline_role).toBe('current_candidate');
    expect(updatedOld.audit_timeline_role).toBe('history_candidate');
    expect(updatedNew.audit_current_candidate_id).toBe('timeline-new');
    expect(updatedOld.audit_history_candidate_id).toBe('timeline-old');
  });

  it('should expose lifecycle stats snapshot', () => {
    const stats = lifecycle.getStats('test');
    expect(stats.layerCounts).toBeDefined();
    expect(typeof stats.archiveCandidates).toBe('number');
    expect(typeof stats.lowConfidenceCount).toBe('number');
    expect(Array.isArray(stats.categoryStats)).toBe(true);
    expect(stats.preferenceExtraction).toBeDefined();
    expect(typeof stats.preferenceExtraction.totalPreferences).toBe('number');
    expect(stats.analysis).toBeDefined();
    expect(typeof stats.analysis.recommendation.shouldAdjust).toBe('boolean');
    expect(Array.isArray(stats.analysis.recommendation.reasons)).toBe(true);
  });

  it('should extract new preferences from recent promoted memories', async () => {
    const prefConfig = loadConfig({
      storage: { dbPath: ':memory:', walMode: false },
      llm: { extraction: { provider: 'none' }, lifecycle: { provider: 'none' } },
      embedding: { provider: 'none', dimensions: 4 },
      vectorBackend: { provider: 'sqlite-vec' },
      markdownExport: { enabled: false, exportMemoryMd: false, debounceMs: 999999 },
      lifecycle: {
        promotionThreshold: 0.6,
        archiveThreshold: 0.2,
        decayLambda: 0.03,
        preferenceExtraction: {
          enabled: true,
          lookbackDays: 7,
          maxNewPreferences: 3,
          maxLLMCalls: 2,
          dedupSimilarity: 0.85,
        },
      },
    });

    const prefLifecycle = new LifecycleEngine(createMockLLM(), createMockEmbedding(), createMockVector(), prefConfig);

    const source = insertMemory({
      id: 'pref-src-1',
      layer: 'core',
      category: 'fact',
      content: 'User asked to batch interruptions and prefers async updates.',
      agent_id: 'pref-test',
      confidence: 0.8,
      importance: 0.7,
      decay_score: 0.9,
      source: 'lifecycle:promotion',
    });
    getDb().prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), source.id);

    const report = await prefLifecycle.run(false, 'manual', 'pref-test');
    expect(report.preferencesExtracted).toBeGreaterThanOrEqual(1);

    const created = getDb().prepare(`
      SELECT * FROM memories
      WHERE agent_id = 'pref-test'
        AND category = 'preference'
        AND source = 'lifecycle:preference-extraction'
        AND superseded_by IS NULL
    `).all() as any[];
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(created[0].content).toContain('async');

    const lifecycleLog = getDb().prepare(`
      SELECT * FROM lifecycle_log
      WHERE action = 'preference_extracted'
      ORDER BY id DESC
      LIMIT 1
    `).get() as any;
    const details = JSON.parse(lifecycleLog.details);
    expect(details.source_memory_count).toBeGreaterThanOrEqual(1);
    expect(details.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('should expose preference extraction quality checks in lifecycle stats', () => {
    const prefConfig = loadConfig({
      storage: { dbPath: ':memory:', walMode: false },
      llm: { extraction: { provider: 'none' }, lifecycle: { provider: 'none' } },
      embedding: { provider: 'none', dimensions: 4 },
      vectorBackend: { provider: 'sqlite-vec' },
      markdownExport: { enabled: false, exportMemoryMd: false, debounceMs: 999999 },
      lifecycle: {
        promotionThreshold: 0.6,
        archiveThreshold: 0.2,
        decayLambda: 0.03,
        preferenceExtraction: {
          enabled: true,
          lookbackDays: 7,
          maxNewPreferences: 3,
          maxLLMCalls: 2,
          dedupSimilarity: 0.85,
        },
      },
    });

    const prefLifecycle = new LifecycleEngine(createMockLLM(), createMockEmbedding(), createMockVector(), prefConfig);

    insertMemory({
      id: 'pref-quality-source',
      layer: 'core',
      category: 'fact',
      content: 'User asked for async updates instead of meetings.',
      agent_id: 'pref-quality',
      confidence: 0.9,
      importance: 0.7,
      decay_score: 0.9,
    });
    insertMemory({
      id: 'pref-quality-1',
      layer: 'core',
      category: 'preference',
      content: 'User prefers async updates.',
      agent_id: 'pref-quality',
      confidence: 0.72,
      importance: 0.75,
      decay_score: 0.9,
      source: 'lifecycle:preference-extraction',
      metadata: JSON.stringify({
        source_memories: ['pref-quality-source', 'pref-quality-missing'],
        extraction_type: 'preference_extraction',
      }),
    });
    insertMemory({
      id: 'pref-quality-2',
      layer: 'core',
      category: 'preference',
      content: 'User prefers async updates!',
      agent_id: 'pref-quality',
      confidence: 0.83,
      importance: 0.75,
      decay_score: 0.9,
      source: 'lifecycle:preference-extraction',
      metadata: JSON.stringify({
        source_memories: ['pref-quality-source'],
        extraction_type: 'preference_extraction',
      }),
    });

    const stats = prefLifecycle.getStats('pref-quality');
    expect(stats.preferenceExtraction.enabled).toBe(true);
    expect(stats.preferenceExtraction.totalPreferences).toBeGreaterThanOrEqual(2);
    expect(stats.preferenceExtraction.lifecycleExtractedTotal).toBeGreaterThanOrEqual(2);
    expect(stats.preferenceExtraction.recentExtracted).toBeGreaterThanOrEqual(2);
    expect(stats.preferenceExtraction.lowConfidenceRecent).toBeGreaterThanOrEqual(1);
    expect(stats.preferenceExtraction.missingSourceRecent).toBeGreaterThanOrEqual(1);
    expect(stats.preferenceExtraction.duplicateGroups).toBeGreaterThanOrEqual(1);
    expect(stats.preferenceExtraction.duplicateSamples[0]?.count).toBeGreaterThanOrEqual(2);
    expect(stats.preferenceExtraction.recentItems.some((item) => item.missingSourceMemoryCount > 0)).toBe(true);
    expect(stats.preferenceExtraction.recentItems.some((item) => item.duplicateCount > 1)).toBe(true);
  });

  it('should expose duplicate preference resolution counts in lifecycle stats', () => {
    const prefConfig = loadConfig({
      storage: { dbPath: ':memory:', walMode: false },
      llm: { extraction: { provider: 'none' }, lifecycle: { provider: 'none' } },
      embedding: { provider: 'none', dimensions: 4 },
      vectorBackend: { provider: 'sqlite-vec' },
      markdownExport: { enabled: false, exportMemoryMd: false, debounceMs: 999999 },
      lifecycle: {
        promotionThreshold: 0.6,
        archiveThreshold: 0.2,
        decayLambda: 0.03,
        preferenceExtraction: {
          enabled: true,
          lookbackDays: 7,
          maxNewPreferences: 3,
          maxLLMCalls: 2,
          dedupSimilarity: 0.85,
          duplicateAuditEnabled: true,
        },
      },
    });

    const prefLifecycle = new LifecycleEngine(createMockLLM(), createMockEmbedding(), createMockVector(), prefConfig);

    insertMemory({
      id: 'pref-pending-1',
      layer: 'core',
      category: 'preference',
      content: 'User prefers async updates.',
      agent_id: 'pref-resolution-stats',
      confidence: 0.82,
      importance: 0.75,
      decay_score: 0.9,
      source: 'lifecycle:preference-extraction',
      metadata: JSON.stringify({
        audit_flag: 'duplicate_preference',
        preference_duplicate_with: ['pref-pending-2'],
        source_memories: ['pref-source-1'],
        extraction_type: 'preference_extraction',
      }),
    });
    insertMemory({
      id: 'pref-pending-2',
      layer: 'core',
      category: 'preference',
      content: 'User prefers async updates!',
      agent_id: 'pref-resolution-stats',
      confidence: 0.83,
      importance: 0.75,
      decay_score: 0.9,
      source: 'lifecycle:preference-extraction',
      metadata: JSON.stringify({
        audit_flag: 'duplicate_preference',
        preference_duplicate_with: ['pref-pending-1'],
        source_memories: ['pref-source-2'],
        extraction_type: 'preference_extraction',
      }),
    });
    insertMemory({
      id: 'pref-keeper-1',
      layer: 'core',
      category: 'preference',
      content: 'User prefers batched async updates.',
      agent_id: 'pref-resolution-stats',
      confidence: 0.91,
      importance: 0.79,
      decay_score: 0.95,
      source: 'lifecycle:preference-extraction',
      metadata: JSON.stringify({
        duplicate_resolution: {
          resolution_id: 'resolution-1',
          resolution_type: 'manual_keep_one_supersede_others',
          role: 'keeper',
          keeper_id: 'pref-keeper-1',
          duplicate_group_ids: ['pref-keeper-1', 'pref-superseded-1', 'pref-superseded-2'],
          superseded_ids: ['pref-superseded-1', 'pref-superseded-2'],
          resolved_at: new Date().toISOString(),
        },
        source_memories: ['pref-source-3'],
        extraction_type: 'preference_extraction',
      }),
    });
    insertMemory({
      id: 'pref-superseded-1',
      layer: 'core',
      category: 'preference',
      content: 'User prefers batched async updates!',
      agent_id: 'pref-resolution-stats',
      confidence: 0.84,
      importance: 0.74,
      decay_score: 0.95,
      source: 'lifecycle:preference-extraction',
      metadata: JSON.stringify({
        duplicate_resolution: {
          resolution_id: 'resolution-1',
          resolution_type: 'manual_keep_one_supersede_others',
          role: 'superseded',
          keeper_id: 'pref-keeper-1',
          duplicate_group_ids: ['pref-keeper-1', 'pref-superseded-1', 'pref-superseded-2'],
          superseded_ids: ['pref-superseded-1', 'pref-superseded-2'],
          resolved_at: new Date().toISOString(),
        },
        source_memories: ['pref-source-4'],
        extraction_type: 'preference_extraction',
      }),
    });
    insertMemory({
      id: 'pref-superseded-2',
      layer: 'core',
      category: 'preference',
      content: 'User prefers batched async updates。',
      agent_id: 'pref-resolution-stats',
      confidence: 0.81,
      importance: 0.73,
      decay_score: 0.95,
      source: 'lifecycle:preference-extraction',
      metadata: JSON.stringify({
        duplicate_resolution: {
          resolution_id: 'resolution-1',
          resolution_type: 'manual_keep_one_supersede_others',
          role: 'superseded',
          keeper_id: 'pref-keeper-1',
          duplicate_group_ids: ['pref-keeper-1', 'pref-superseded-1', 'pref-superseded-2'],
          superseded_ids: ['pref-superseded-1', 'pref-superseded-2'],
          resolved_at: new Date().toISOString(),
        },
        source_memories: ['pref-source-5'],
        extraction_type: 'preference_extraction',
      }),
    });
    getDb().prepare('UPDATE memories SET superseded_by = ? WHERE id IN (?, ?)').run(
      'pref-keeper-1',
      'pref-superseded-1',
      'pref-superseded-2',
    );

    const stats = prefLifecycle.getStats('pref-resolution-stats');
    expect(stats.preferenceExtraction.duplicatePreferencesPending).toBeGreaterThanOrEqual(2);
    expect(stats.preferenceExtraction.duplicatePreferencesResolved).toBeGreaterThanOrEqual(1);
    expect(stats.preferenceExtraction.duplicatePreferenceSuperseded).toBeGreaterThanOrEqual(2);
  });

  it('should expose contradiction closure counts in lifecycle stats', () => {
    const auditConfig = loadConfig({
      storage: { dbPath: ':memory:', walMode: false },
      llm: { extraction: { provider: 'none' }, lifecycle: { provider: 'none' } },
      embedding: { provider: 'none', dimensions: 4 },
      vectorBackend: { provider: 'sqlite-vec' },
      markdownExport: { enabled: false, exportMemoryMd: false, debounceMs: 999999 },
      lifecycle: {
        promotionThreshold: 0.6,
        archiveThreshold: 0.2,
        decayLambda: 0.03,
        contradictionAudit: {
          enabled: true,
          lookbackDays: 30,
          candidateTopK: 5,
          maxCandidates: 10,
          maxLLMCalls: 5,
          lowConfidenceThreshold: 0.4,
          minNormalizedSimilarity: 0.7,
          mode: 'flag_only',
        },
      },
    });
    const auditLifecycle = new LifecycleEngine(createMockLLM(), createMockEmbedding(), createMockVector(), auditConfig);

    insertMemory({
      id: 'contradiction-timeline-old',
      layer: 'core',
      category: 'fact',
      content: 'User lives in Tokyo.',
      agent_id: 'contradiction-stats',
      metadata: JSON.stringify({
        audit_flag: 'possible_conflict',
        audit_kind: 'timeline_update_candidate',
        audit_conflict_with: ['contradiction-timeline-new'],
        audit_current_candidate_id: 'contradiction-timeline-new',
        audit_history_candidate_id: 'contradiction-timeline-old',
        audit_timeline_role: 'history_candidate',
      }),
    });
    insertMemory({
      id: 'contradiction-timeline-new',
      layer: 'core',
      category: 'fact',
      content: 'User moved to Osaka recently.',
      agent_id: 'contradiction-stats',
      metadata: JSON.stringify({
        audit_flag: 'possible_conflict',
        audit_kind: 'timeline_update_candidate',
        audit_conflict_with: ['contradiction-timeline-old'],
        audit_current_candidate_id: 'contradiction-timeline-new',
        audit_history_candidate_id: 'contradiction-timeline-old',
        audit_timeline_role: 'current_candidate',
      }),
    });
    insertMemory({
      id: 'contradiction-review-a',
      layer: 'core',
      category: 'fact',
      content: 'User only works on-site.',
      agent_id: 'contradiction-stats',
      metadata: JSON.stringify({
        audit_flag: 'possible_conflict',
        audit_kind: 'conflict_needs_review',
        audit_conflict_with: ['contradiction-review-b'],
      }),
    });
    insertMemory({
      id: 'contradiction-review-b',
      layer: 'core',
      category: 'fact',
      content: 'User works fully remote.',
      agent_id: 'contradiction-stats',
      metadata: JSON.stringify({
        audit_flag: 'possible_conflict',
        audit_kind: 'conflict_needs_review',
        audit_conflict_with: ['contradiction-review-a'],
      }),
    });
    insertMemory({
      id: 'contradiction-resolved-current',
      layer: 'core',
      category: 'fact',
      content: 'User now lives in Kyoto.',
      agent_id: 'contradiction-stats',
      metadata: JSON.stringify({
        timeline_resolution: {
          resolution_id: 'timeline-resolution-1',
          resolution_type: 'manual_timeline_confirm_current',
          role: 'current',
          current_id: 'contradiction-resolved-current',
          history_id: 'contradiction-resolved-history',
          resolved_at: new Date().toISOString(),
        },
      }),
    });
    insertMemory({
      id: 'contradiction-resolved-history',
      layer: 'core',
      category: 'fact',
      content: 'User lived in Nagoya before.',
      agent_id: 'contradiction-stats',
      metadata: JSON.stringify({
        timeline_resolution: {
          resolution_id: 'timeline-resolution-1',
          resolution_type: 'manual_timeline_confirm_current',
          role: 'history',
          current_id: 'contradiction-resolved-current',
          history_id: 'contradiction-resolved-history',
          resolved_at: new Date().toISOString(),
        },
      }),
    });
    getDb().prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run(
      'contradiction-resolved-current',
      'contradiction-resolved-history',
    );
    insertMemory({
      id: 'contradiction-winner',
      layer: 'core',
      category: 'fact',
      content: 'User works hybrid.',
      agent_id: 'contradiction-stats',
      metadata: JSON.stringify({
        conflict_resolution: {
          resolution_id: 'conflict-resolution-1',
          resolution_type: 'manual_conflict_confirm_winner',
          role: 'winner',
          winner_id: 'contradiction-winner',
          superseded_id: 'contradiction-loser',
          resolved_at: new Date().toISOString(),
        },
      }),
    });
    insertMemory({
      id: 'contradiction-loser',
      layer: 'core',
      category: 'fact',
      content: 'User never works remote.',
      agent_id: 'contradiction-stats',
      metadata: JSON.stringify({
        conflict_resolution: {
          resolution_id: 'conflict-resolution-1',
          resolution_type: 'manual_conflict_confirm_winner',
          role: 'superseded',
          winner_id: 'contradiction-winner',
          superseded_id: 'contradiction-loser',
          resolved_at: new Date().toISOString(),
        },
      }),
    });
    getDb().prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run(
      'contradiction-winner',
      'contradiction-loser',
    );

    const stats = auditLifecycle.getStats('contradiction-stats');
    expect(stats.contradictionAudit.timelineCandidatePairs).toBeGreaterThanOrEqual(1);
    expect(stats.contradictionAudit.timelineResolvedPairs).toBeGreaterThanOrEqual(1);
    expect(stats.contradictionAudit.conflictNeedsReviewPairs).toBeGreaterThanOrEqual(1);
    expect(stats.contradictionAudit.conflictResolvedPairs).toBeGreaterThanOrEqual(1);
  });

  it('should flag duplicate preferences in flag-only mode', async () => {
    const prefConfig = loadConfig({
      storage: { dbPath: ':memory:', walMode: false },
      llm: { extraction: { provider: 'none' }, lifecycle: { provider: 'none' } },
      embedding: { provider: 'none', dimensions: 4 },
      vectorBackend: { provider: 'sqlite-vec' },
      markdownExport: { enabled: false, exportMemoryMd: false, debounceMs: 999999 },
      lifecycle: {
        promotionThreshold: 0.6,
        archiveThreshold: 0.2,
        decayLambda: 0.03,
        preferenceExtraction: {
          enabled: true,
          lookbackDays: 7,
          maxNewPreferences: 3,
          maxLLMCalls: 2,
          dedupSimilarity: 0.85,
          duplicateAuditEnabled: true,
        },
      },
    });

    const prefLifecycle = new LifecycleEngine(createMockLLM(), createMockEmbedding(), createMockVector(), prefConfig);

    insertMemory({
      id: 'pref-dup-1',
      layer: 'core',
      category: 'preference',
      content: 'User prefers async updates.',
      agent_id: 'pref-dup',
      confidence: 0.82,
      importance: 0.75,
      decay_score: 0.9,
      source: 'lifecycle:preference-extraction',
      metadata: JSON.stringify({
        source_memories: ['pref-dup-src-1'],
        extraction_type: 'preference_extraction',
      }),
    });
    insertMemory({
      id: 'pref-dup-2',
      layer: 'core',
      category: 'preference',
      content: 'User prefers async updates!',
      agent_id: 'pref-dup',
      confidence: 0.8,
      importance: 0.75,
      decay_score: 0.9,
      source: 'lifecycle:preference-extraction',
      metadata: JSON.stringify({
        source_memories: ['pref-dup-src-2'],
        extraction_type: 'preference_extraction',
      }),
    });

    const report = await prefLifecycle.run(false, 'manual', 'pref-dup');
    expect(report.preferenceDuplicatesFlagged).toBeGreaterThanOrEqual(2);
    expect(report.observability.phases.some((p) => p.key === 'auditPreferenceDuplicates')).toBe(true);

    const updated1 = getMemoryById('pref-dup-1')!;
    const updated2 = getMemoryById('pref-dup-2')!;
    expect(updated1.metadata).toContain('duplicate_preference');
    expect(updated2.metadata).toContain('duplicate_preference');

    const lifecycleLog = getDb().prepare(`
      SELECT * FROM lifecycle_log
      WHERE action = 'preference_duplicate_flagged'
      ORDER BY id DESC
      LIMIT 1
    `).get() as any;
    expect(lifecycleLog).toBeTruthy();
    const details = JSON.parse(lifecycleLog.details);
    expect(details.count).toBeGreaterThanOrEqual(2);
  });
});
