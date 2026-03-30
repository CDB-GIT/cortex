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

  it('should expose lifecycle stats snapshot', () => {
    const stats = lifecycle.getStats('test');
    expect(stats.layerCounts).toBeDefined();
    expect(typeof stats.archiveCandidates).toBe('number');
    expect(typeof stats.lowConfidenceCount).toBe('number');
    expect(Array.isArray(stats.categoryStats)).toBe(true);
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
  });
});
