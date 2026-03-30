import type { FastifyInstance } from 'fastify';
import {
  listMemories,
  getMemoryById,
  insertMemory,
  updateMemory,
  deleteMemory,
  ensureAgent,
  getMemoryVersionChain,
  insertLifecycleLog,
  getDb,
  type Memory,
} from '../db/index.js';
import type { CortexApp } from '../app.js';
import { generateId } from '../utils/helpers.js';

interface DuplicatePreferenceResolutionMeta {
  resolution_id: string;
  resolution_type: 'manual_keep_one_supersede_others';
  role: 'keeper' | 'superseded';
  keeper_id: string;
  duplicate_group_ids: string[];
  superseded_ids: string[];
  resolved_at: string;
}

interface TimelineUpdateResolutionMeta {
  resolution_id: string;
  resolution_type: 'manual_timeline_confirm_current';
  role: 'current' | 'history';
  current_id: string;
  history_id: string;
  resolved_at: string;
}

interface ConflictResolutionMeta {
  resolution_id: string;
  resolution_type: 'manual_conflict_confirm_winner';
  role: 'winner' | 'superseded';
  winner_id: string;
  superseded_id: string;
  resolved_at: string;
}

function parseMetadata(memory: Pick<Memory, 'metadata'>): Record<string, any> {
  if (!memory.metadata) return {};
  try {
    const parsed = JSON.parse(memory.metadata);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizePreferenceContent(content: string): string {
  return content
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[。．.!?！？;；,:，]+$/g, '')
    .replace(/\s+/g, ' ');
}

function stripDuplicatePreferenceMetadata(meta: Record<string, any>): Record<string, any> {
  const next = { ...meta };
  delete next.audit_flag;
  delete next.audit_reason;
  delete next.preference_duplicate_with;
  delete next.preference_duplicate_count;
  delete next.preference_duplicate_audit_at;
  delete next.preference_duplicate_audit_version;
  delete next.duplicate_resolution;
  return next;
}

function stripConflictAuditMetadata(meta: Record<string, any>): Record<string, any> {
  const next = { ...meta };
  delete next.audit_flag;
  delete next.audit_reason;
  delete next.audit_kind;
  delete next.audit_conflict_with;
  delete next.audit_decision;
  delete next.audit_decision_reason;
  delete next.audit_at;
  delete next.audit_version;
  delete next.audit_current_candidate_id;
  delete next.audit_history_candidate_id;
  delete next.audit_timeline_role;
  delete next.timeline_resolution;
  return next;
}

function buildDuplicatePreferenceAuditMetadata(memory: Memory, groupIds: string[]): string {
  const next = stripDuplicatePreferenceMetadata(parseMetadata(memory));
  const peers = groupIds.filter((id) => id !== memory.id);
  return JSON.stringify({
    ...next,
    audit_flag: 'duplicate_preference',
    audit_reason: 'preference_duplicate_exact',
    preference_duplicate_with: peers,
    preference_duplicate_count: groupIds.length,
    preference_duplicate_audit_at: new Date().toISOString(),
    preference_duplicate_audit_version: 1,
  });
}

function buildDuplicatePreferenceResolvedMetadata(
  memory: Memory,
  resolution: DuplicatePreferenceResolutionMeta,
): string {
  const next = stripDuplicatePreferenceMetadata(parseMetadata(memory));
  return JSON.stringify({
    ...next,
    duplicate_resolution: resolution,
  });
}

function buildTimelineAuditMetadata(
  memory: Memory,
  timeline: { currentId: string; historyId: string },
  decision: string,
  reason: string,
): string {
  const next = stripConflictAuditMetadata(parseMetadata(memory));
  const currentConflicts = Array.isArray(next.audit_conflict_with) ? next.audit_conflict_with : [];
  const counterpartId = memory.id === timeline.currentId ? timeline.historyId : timeline.currentId;
  const mergedConflicts = Array.from(new Set([...currentConflicts, counterpartId]));
  return JSON.stringify({
    ...next,
    audit_flag: 'possible_conflict',
    audit_reason: 'contradiction_llm',
    audit_kind: 'timeline_update_candidate',
    audit_conflict_with: mergedConflicts,
    audit_decision: decision,
    audit_decision_reason: reason,
    audit_at: new Date().toISOString(),
    audit_version: 1,
    audit_current_candidate_id: timeline.currentId,
    audit_history_candidate_id: timeline.historyId,
    audit_timeline_role: memory.id === timeline.currentId ? 'current_candidate' : 'history_candidate',
  });
}

function buildTimelineResolvedMetadata(
  memory: Memory,
  resolution: TimelineUpdateResolutionMeta,
): string {
  const next = stripConflictAuditMetadata(parseMetadata(memory));
  return JSON.stringify({
    ...next,
    timeline_resolution: resolution,
  });
}

function buildConflictReviewAuditMetadata(
  memory: Memory,
  pair: { winnerId?: string; currentId: string; otherId: string },
  decision = 'needs_review',
  reason = 'manual review required',
): string {
  const next = stripConflictAuditMetadata(parseMetadata(memory));
  return JSON.stringify({
    ...next,
    audit_flag: 'possible_conflict',
    audit_reason: 'contradiction_llm',
    audit_kind: 'conflict_needs_review',
    audit_conflict_with: [memory.id === pair.currentId ? pair.otherId : pair.currentId],
    audit_decision: decision,
    audit_decision_reason: reason,
    audit_at: new Date().toISOString(),
    audit_version: 1,
  });
}

function buildConflictResolvedMetadata(
  memory: Memory,
  resolution: ConflictResolutionMeta,
): string {
  const next = stripConflictAuditMetadata(parseMetadata(memory));
  return JSON.stringify({
    ...next,
    conflict_resolution: resolution,
  });
}

function parseDuplicateResolution(memory: Memory): DuplicatePreferenceResolutionMeta | null {
  const meta = parseMetadata(memory);
  const resolution = meta.duplicate_resolution;
  if (!resolution || typeof resolution !== 'object') return null;
  if (resolution.resolution_type !== 'manual_keep_one_supersede_others') return null;
  if (resolution.role !== 'keeper' && resolution.role !== 'superseded') return null;
  if (typeof resolution.resolution_id !== 'string' || !resolution.resolution_id.trim()) return null;
  if (typeof resolution.keeper_id !== 'string' || !resolution.keeper_id.trim()) return null;
  const duplicateGroupIds = Array.isArray(resolution.duplicate_group_ids)
    ? resolution.duplicate_group_ids.filter((id: unknown) => typeof id === 'string' && id.trim())
    : [];
  const supersededIds = Array.isArray(resolution.superseded_ids)
    ? resolution.superseded_ids.filter((id: unknown) => typeof id === 'string' && id.trim())
    : [];
  if (duplicateGroupIds.length < 2) return null;

  return {
    resolution_id: resolution.resolution_id,
    resolution_type: 'manual_keep_one_supersede_others',
    role: resolution.role,
    keeper_id: resolution.keeper_id,
    duplicate_group_ids: duplicateGroupIds,
    superseded_ids: supersededIds,
    resolved_at: typeof resolution.resolved_at === 'string' ? resolution.resolved_at : new Date().toISOString(),
  };
}

function parseTimelineResolution(memory: Memory): TimelineUpdateResolutionMeta | null {
  const meta = parseMetadata(memory);
  const resolution = meta.timeline_resolution;
  if (!resolution || typeof resolution !== 'object') return null;
  if (resolution.resolution_type !== 'manual_timeline_confirm_current') return null;
  if (resolution.role !== 'current' && resolution.role !== 'history') return null;
  if (typeof resolution.resolution_id !== 'string' || !resolution.resolution_id.trim()) return null;
  if (typeof resolution.current_id !== 'string' || !resolution.current_id.trim()) return null;
  if (typeof resolution.history_id !== 'string' || !resolution.history_id.trim()) return null;
  return {
    resolution_id: resolution.resolution_id,
    resolution_type: 'manual_timeline_confirm_current',
    role: resolution.role,
    current_id: resolution.current_id,
    history_id: resolution.history_id,
    resolved_at: typeof resolution.resolved_at === 'string' ? resolution.resolved_at : new Date().toISOString(),
  };
}

function parseConflictResolution(memory: Memory): ConflictResolutionMeta | null {
  const meta = parseMetadata(memory);
  const resolution = meta.conflict_resolution;
  if (!resolution || typeof resolution !== 'object') return null;
  if (resolution.resolution_type !== 'manual_conflict_confirm_winner') return null;
  if (resolution.role !== 'winner' && resolution.role !== 'superseded') return null;
  if (typeof resolution.resolution_id !== 'string' || !resolution.resolution_id.trim()) return null;
  if (typeof resolution.winner_id !== 'string' || !resolution.winner_id.trim()) return null;
  if (typeof resolution.superseded_id !== 'string' || !resolution.superseded_id.trim()) return null;
  return {
    resolution_id: resolution.resolution_id,
    resolution_type: 'manual_conflict_confirm_winner',
    role: resolution.role,
    winner_id: resolution.winner_id,
    superseded_id: resolution.superseded_id,
    resolved_at: typeof resolution.resolved_at === 'string' ? resolution.resolved_at : new Date().toISOString(),
  };
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter((id) => typeof id === 'string' && id.trim())));
}

export function registerMemoriesRoutes(app: FastifyInstance, cortex: CortexApp): void {
  // List memories
  app.get('/api/v1/memories', async (req) => {
    const q = req.query as any;
    return listMemories({
      layer: q.layer,
      category: q.category,
      agent_id: q.agent_id,
      audit_flag: q.audit_flag,
      limit: q.limit ? parseInt(q.limit) : undefined,
      offset: q.offset ? parseInt(q.offset) : undefined,
      orderBy: q.order_by,
      orderDir: q.order_dir,
      include_superseded: q.include_superseded === 'true',
      has_versions: q.has_versions === 'true',
    });
  });

  // Get memory by ID
  app.get('/api/v1/memories/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const mem = getMemoryById(id);
    if (!mem) { reply.code(404); return { error: 'Memory not found' }; }
    return mem;
  });

  // Get memory version chain
  app.get('/api/v1/memories/:id/chain', async (req, reply) => {
    const { id } = req.params as { id: string };
    const mem = getMemoryById(id);
    if (!mem) { reply.code(404); return { error: 'Memory not found' }; }
    const chain = getMemoryVersionChain(id);
    return { chain, current_id: id };
  });

  // Create memory
  app.post('/api/v1/memories', {
    schema: {
      body: {
        type: 'object',
        required: ['layer', 'category', 'content'],
        properties: {
          layer: { type: 'string', enum: ['working', 'core', 'archive'] },
          category: {
            type: 'string',
            enum: [
              'identity', 'preference', 'decision', 'fact', 'entity',
              'correction', 'todo', 'context', 'summary',
              'skill', 'relationship', 'goal', 'insight', 'project_state',
              'constraint', 'policy',
              'agent_self_improvement', 'agent_user_habit', 'agent_relationship', 'agent_persona',
            ],
          },
          content: { type: 'string' },
          agent_id: { type: 'string' },
          importance: { type: 'number' },
          confidence: { type: 'number' },
          source: { type: 'string' },
          expires_at: { type: 'string' },
          metadata: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const body = req.body as any;
    if (body.agent_id) ensureAgent(body.agent_id);
    const mem = insertMemory(body);

    // Index vector
    try {
      const embedding = await cortex.embeddingProvider.embed(body.content);
      if (embedding.length > 0) {
        await cortex.vectorBackend.upsert(mem.id, embedding);
      }
    } catch { /* best effort */ }

    reply.code(201);
    return mem;
  });

  // Update memory
  app.patch('/api/v1/memories/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as any;
    const mem = updateMemory(id, body);
    if (!mem) { reply.code(404); return { error: 'Memory not found' }; }

    // Re-index vector if content changed
    if (body.content) {
      try {
        const embedding = await cortex.embeddingProvider.embed(mem.content);
        if (embedding.length > 0) {
          await cortex.vectorBackend.upsert(mem.id, embedding);
        }
      } catch { /* best effort */ }
    }

    return mem;
  });

  // Rollback memory to a previous version
  app.post('/api/v1/memories/:id/rollback', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { target_id } = req.body as { target_id: string };

    // target_id = the old version we want to restore
    const target = getMemoryById(target_id);
    if (!target) { reply.code(404); return { error: 'Target version not found' }; }

    // Find the current active version in this chain
    const chain = getMemoryVersionChain(id);
    const current = chain.find(m => !m.superseded_by);
    if (!current) { reply.code(404); return { error: 'No active version found in chain' }; }

    // Update the current active version's content to match the target
    const restored = updateMemory(current.id, {
      content: target.content,
      category: target.category,
      importance: target.importance,
      confidence: target.confidence,
    });
    if (!restored) { reply.code(500); return { error: 'Failed to update memory' }; }

    // Re-index vector
    try {
      const embedding = await cortex.embeddingProvider.embed(restored.content);
      if (embedding.length > 0) {
        await cortex.vectorBackend.upsert(restored.id, embedding);
      }
    } catch { /* best effort */ }

    return { ok: true, restored: restored };
  });

  // Resolve duplicate preference group manually by keeping one memory active.
  app.post('/api/v1/memories/:id/duplicate-preference/resolve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body as {
      keeper_id?: string;
      memory_ids?: string[];
    } | undefined) || {};

    const anchor = getMemoryById(id);
    if (!anchor) { reply.code(404); return { error: 'Memory not found' }; }

    const keeperId = typeof body.keeper_id === 'string' ? body.keeper_id.trim() : '';
    if (!keeperId) { reply.code(400); return { error: 'keeper_id is required' }; }

    const requestedIds = Array.isArray(body.memory_ids) ? body.memory_ids : [];
    const groupIds = uniqueIds(requestedIds.length > 0 ? requestedIds : [
      id,
      ...((parseMetadata(anchor).preference_duplicate_with as string[] | undefined) || []),
    ]);

    if (!groupIds.includes(id)) {
      reply.code(400);
      return { error: 'memory_ids must include the route memory id' };
    }
    if (!groupIds.includes(keeperId)) {
      reply.code(400);
      return { error: 'keeper_id must be included in memory_ids' };
    }
    if (groupIds.length < 2) {
      reply.code(400);
      return { error: 'At least two memories are required to resolve duplicates' };
    }

    const memories = groupIds.map((memoryId) => getMemoryById(memoryId));
    if (memories.some((memory) => !memory)) {
      reply.code(404);
      return { error: 'One or more memories were not found' };
    }

    const resolvedGroup = memories as Memory[];
    const keeper = resolvedGroup.find((memory) => memory.id === keeperId)!;
    if (keeper.superseded_by) {
      reply.code(409);
      return { error: 'keeper_id must reference an active memory' };
    }

    const invalidMemory = resolvedGroup.find((memory) =>
      memory.layer !== 'core'
      || memory.category !== 'preference'
      || !!memory.superseded_by
    );
    if (invalidMemory) {
      reply.code(409);
      return { error: 'All memories must be active core preference memories' };
    }

    const agentIds = new Set(resolvedGroup.map((memory) => memory.agent_id));
    if (agentIds.size > 1) {
      reply.code(409);
      return { error: 'All memories in a duplicate resolution must belong to the same agent' };
    }

    const normalizedContents = new Set(resolvedGroup.map((memory) => normalizePreferenceContent(memory.content)));
    if (normalizedContents.size !== 1) {
      reply.code(409);
      return { error: 'All memories must belong to the same exact-normalized duplicate group' };
    }

    const alreadyResolved = resolvedGroup.find((memory) => parseDuplicateResolution(memory));
    if (alreadyResolved) {
      reply.code(409);
      return { error: 'One or more memories already belong to an active duplicate resolution' };
    }

    const supersededIds = groupIds.filter((memoryId) => memoryId !== keeperId);
    const resolutionId = generateId();
    const resolvedAt = new Date().toISOString();
    const db = getDb();
    const tx = db.transaction(() => {
      for (const memory of resolvedGroup) {
        const resolution: DuplicatePreferenceResolutionMeta = {
          resolution_id: resolutionId,
          resolution_type: 'manual_keep_one_supersede_others',
          role: memory.id === keeperId ? 'keeper' : 'superseded',
          keeper_id: keeperId,
          duplicate_group_ids: groupIds,
          superseded_ids: supersededIds,
          resolved_at: resolvedAt,
        };

        updateMemory(memory.id, {
          superseded_by: memory.id === keeperId ? null : keeperId,
          metadata: buildDuplicatePreferenceResolvedMetadata(memory, resolution),
        });
      }

      insertLifecycleLog('preference_duplicate_resolved', groupIds, {
        resolution_id: resolutionId,
        resolution_type: 'manual_keep_one_supersede_others',
        keeper_id: keeperId,
        superseded_ids: supersededIds,
        count: groupIds.length,
        agent_id: keeper.agent_id,
      });
    });
    tx();

    return {
      ok: true,
      keeper: getMemoryById(keeperId),
      resolution: {
        resolution_id: resolutionId,
        resolution_type: 'manual_keep_one_supersede_others',
        keeper_id: keeperId,
        superseded_ids: supersededIds,
        memory_ids: groupIds,
        resolved_at: resolvedAt,
      },
    };
  });

  // Roll back a previous manual duplicate preference resolution.
  app.post('/api/v1/memories/:id/duplicate-preference/rollback', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body as { resolution_id?: string } | undefined) || {};
    const keeper = getMemoryById(id);
    if (!keeper) { reply.code(404); return { error: 'Memory not found' }; }
    if (keeper.superseded_by) {
      reply.code(409);
      return { error: 'Only the active keeper memory can roll back a duplicate resolution' };
    }

    const resolution = parseDuplicateResolution(keeper);
    if (!resolution || resolution.role !== 'keeper') {
      reply.code(409);
      return { error: 'This memory does not have a rollbackable duplicate resolution' };
    }
    if (body.resolution_id && body.resolution_id !== resolution.resolution_id) {
      reply.code(409);
      return { error: 'resolution_id does not match the active duplicate resolution' };
    }

    const groupIds = uniqueIds(resolution.duplicate_group_ids);
    const group = groupIds.map((memoryId) => getMemoryById(memoryId));
    if (group.some((memory) => !memory)) {
      reply.code(409);
      return { error: 'Rollback requires every memory in the duplicate group to still exist' };
    }

    const memories = group as Memory[];
    const keeperMemory = memories.find((memory) => memory.id === id);
    if (!keeperMemory) {
      reply.code(409);
      return { error: 'Keeper memory is missing from the duplicate group' };
    }

    const staleSuperseded = memories.find((memory) =>
      memory.id !== id
      && memory.superseded_by !== id
    );
    if (staleSuperseded) {
      reply.code(409);
      return { error: 'Rollback aborted because one superseded memory was changed after resolution' };
    }

    const db = getDb();
    const tx = db.transaction(() => {
      for (const memory of memories) {
        updateMemory(memory.id, {
          superseded_by: memory.id === id ? null : null,
          metadata: buildDuplicatePreferenceAuditMetadata(memory, groupIds),
        });
      }

      insertLifecycleLog('preference_duplicate_resolution_rolled_back', groupIds, {
        resolution_id: resolution.resolution_id,
        keeper_id: id,
        restored_ids: groupIds.filter((memoryId) => memoryId !== id),
        count: groupIds.length,
        agent_id: keeper.agent_id,
      });
    });
    tx();

    return {
      ok: true,
      keeper: getMemoryById(id),
      restored_ids: groupIds.filter((memoryId) => memoryId !== id),
      resolution_id: resolution.resolution_id,
    };
  });

  // Confirm a timeline update candidate by keeping the newer state active and preserving the older state as history.
  app.post('/api/v1/memories/:id/timeline-update/resolve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body as { current_id?: string; history_id?: string } | undefined) || {};
    const anchor = getMemoryById(id);
    if (!anchor) { reply.code(404); return { error: 'Memory not found' }; }

    const anchorMeta = parseMetadata(anchor);
    const currentId = typeof body.current_id === 'string' && body.current_id.trim()
      ? body.current_id.trim()
      : typeof anchorMeta.audit_current_candidate_id === 'string' ? anchorMeta.audit_current_candidate_id : '';
    const historyId = typeof body.history_id === 'string' && body.history_id.trim()
      ? body.history_id.trim()
      : typeof anchorMeta.audit_history_candidate_id === 'string' ? anchorMeta.audit_history_candidate_id : '';

    if (!currentId || !historyId || currentId === historyId) {
      reply.code(400);
      return { error: 'current_id and history_id are required and must be different' };
    }
    if (id !== currentId && id !== historyId) {
      reply.code(400);
      return { error: 'Route memory must belong to the timeline candidate pair' };
    }

    const current = getMemoryById(currentId);
    const history = getMemoryById(historyId);
    if (!current || !history) {
      reply.code(404);
      return { error: 'Timeline candidate memory not found' };
    }
    if (current.superseded_by) {
      reply.code(409);
      return { error: 'Current candidate must still be active' };
    }
    if (history.superseded_by) {
      reply.code(409);
      return { error: 'History candidate must still be active before confirmation' };
    }
    if (current.agent_id !== history.agent_id) {
      reply.code(409);
      return { error: 'Timeline candidates must belong to the same agent' };
    }
    if (current.category !== history.category) {
      reply.code(409);
      return { error: 'Timeline candidates must belong to the same category' };
    }

    const currentMeta = parseMetadata(current);
    const historyMeta = parseMetadata(history);
    const currentIsTimelineCandidate = currentMeta.audit_flag === 'possible_conflict'
      && currentMeta.audit_kind === 'timeline_update_candidate'
      && currentMeta.audit_current_candidate_id === currentId
      && currentMeta.audit_history_candidate_id === historyId;
    const historyIsTimelineCandidate = historyMeta.audit_flag === 'possible_conflict'
      && historyMeta.audit_kind === 'timeline_update_candidate'
      && historyMeta.audit_current_candidate_id === currentId
      && historyMeta.audit_history_candidate_id === historyId;
    if (!currentIsTimelineCandidate || !historyIsTimelineCandidate) {
      reply.code(409);
      return { error: 'Both memories must still belong to the same unresolved timeline update candidate pair' };
    }
    if (parseTimelineResolution(current) || parseTimelineResolution(history)) {
      reply.code(409);
      return { error: 'This timeline update pair has already been resolved' };
    }

    const resolutionId = generateId();
    const resolvedAt = new Date().toISOString();
    const db = getDb();
    const tx = db.transaction(() => {
      updateMemory(current.id, {
        superseded_by: null,
        metadata: buildTimelineResolvedMetadata(current, {
          resolution_id: resolutionId,
          resolution_type: 'manual_timeline_confirm_current',
          role: 'current',
          current_id: current.id,
          history_id: history.id,
          resolved_at: resolvedAt,
        }),
      });
      updateMemory(history.id, {
        superseded_by: current.id,
        metadata: buildTimelineResolvedMetadata(history, {
          resolution_id: resolutionId,
          resolution_type: 'manual_timeline_confirm_current',
          role: 'history',
          current_id: current.id,
          history_id: history.id,
          resolved_at: resolvedAt,
        }),
      });
      insertLifecycleLog('timeline_update_resolved', [current.id, history.id], {
        resolution_id: resolutionId,
        current_id: current.id,
        history_id: history.id,
        agent_id: current.agent_id,
      });
    });
    tx();

    return {
      ok: true,
      current: getMemoryById(current.id),
      history: getMemoryById(history.id),
      resolution: {
        resolution_id: resolutionId,
        current_id: current.id,
        history_id: history.id,
        resolved_at: resolvedAt,
      },
    };
  });

  // Roll back a confirmed timeline update pair.
  app.post('/api/v1/memories/:id/timeline-update/rollback', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body as { resolution_id?: string } | undefined) || {};
    const current = getMemoryById(id);
    if (!current) { reply.code(404); return { error: 'Memory not found' }; }
    if (current.superseded_by) {
      reply.code(409);
      return { error: 'Only the active current-state memory can roll back a timeline update' };
    }

    const resolution = parseTimelineResolution(current);
    if (!resolution || resolution.role !== 'current') {
      reply.code(409);
      return { error: 'This memory does not have a rollbackable timeline update resolution' };
    }
    if (body.resolution_id && body.resolution_id !== resolution.resolution_id) {
      reply.code(409);
      return { error: 'resolution_id does not match the active timeline update resolution' };
    }

    const history = getMemoryById(resolution.history_id);
    if (!history) {
      reply.code(409);
      return { error: 'Rollback requires the history memory to still exist' };
    }
    if (history.superseded_by !== current.id) {
      reply.code(409);
      return { error: 'Rollback aborted because the history memory changed after resolution' };
    }

    const currentMeta = parseMetadata(current);
    const historyMeta = parseMetadata(history);
    const decision = typeof currentMeta.audit_decision === 'string' ? currentMeta.audit_decision : 'keep_a';
    const reason = typeof currentMeta.audit_decision_reason === 'string'
      ? currentMeta.audit_decision_reason
      : 'timeline_update_candidate';
    const db = getDb();
    const tx = db.transaction(() => {
      updateMemory(current.id, {
        superseded_by: null,
        metadata: buildTimelineAuditMetadata(current, {
          currentId: current.id,
          historyId: history.id,
        }, decision, reason),
      });
      updateMemory(history.id, {
        superseded_by: null,
        metadata: buildTimelineAuditMetadata(history, {
          currentId: current.id,
          historyId: history.id,
        }, decision, reason),
      });
      insertLifecycleLog('timeline_update_resolution_rolled_back', [current.id, history.id], {
        resolution_id: resolution.resolution_id,
        current_id: current.id,
        history_id: history.id,
        agent_id: current.agent_id,
      });
    });
    tx();

    return {
      ok: true,
      current: getMemoryById(current.id),
      history: getMemoryById(history.id),
      resolution_id: resolution.resolution_id,
    };
  });

  // Manually confirm which side of a true conflict should remain active.
  app.post('/api/v1/memories/:id/conflict-review/resolve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body as { winner_id?: string; superseded_id?: string } | undefined) || {};
    const anchor = getMemoryById(id);
    if (!anchor) { reply.code(404); return { error: 'Memory not found' }; }

    const winnerId = typeof body.winner_id === 'string' ? body.winner_id.trim() : '';
    const supersededId = typeof body.superseded_id === 'string' ? body.superseded_id.trim() : '';
    if (!winnerId || !supersededId || winnerId === supersededId) {
      reply.code(400);
      return { error: 'winner_id and superseded_id are required and must be different' };
    }
    if (id !== winnerId && id !== supersededId) {
      reply.code(400);
      return { error: 'Route memory must belong to the conflict pair' };
    }

    const winner = getMemoryById(winnerId);
    const superseded = getMemoryById(supersededId);
    if (!winner || !superseded) {
      reply.code(404);
      return { error: 'Conflict memory not found' };
    }
    if (winner.superseded_by || superseded.superseded_by) {
      reply.code(409);
      return { error: 'Both conflict memories must still be active before manual confirmation' };
    }
    if (winner.agent_id !== superseded.agent_id) {
      reply.code(409);
      return { error: 'Conflict memories must belong to the same agent' };
    }
    if (winner.category !== superseded.category) {
      reply.code(409);
      return { error: 'Conflict memories must belong to the same category' };
    }

    const winnerMeta = parseMetadata(winner);
    const supersededMeta = parseMetadata(superseded);
    const winnerInReview = winnerMeta.audit_flag === 'possible_conflict'
      && winnerMeta.audit_kind === 'conflict_needs_review'
      && Array.isArray(winnerMeta.audit_conflict_with)
      && winnerMeta.audit_conflict_with.includes(supersededId);
    const supersededInReview = supersededMeta.audit_flag === 'possible_conflict'
      && supersededMeta.audit_kind === 'conflict_needs_review'
      && Array.isArray(supersededMeta.audit_conflict_with)
      && supersededMeta.audit_conflict_with.includes(winnerId);
    if (!winnerInReview || !supersededInReview) {
      reply.code(409);
      return { error: 'Both memories must still belong to the same unresolved conflict review pair' };
    }
    if (parseConflictResolution(winner) || parseConflictResolution(superseded)) {
      reply.code(409);
      return { error: 'This conflict pair has already been resolved' };
    }

    const resolutionId = generateId();
    const resolvedAt = new Date().toISOString();
    const db = getDb();
    const tx = db.transaction(() => {
      updateMemory(winner.id, {
        superseded_by: null,
        metadata: buildConflictResolvedMetadata(winner, {
          resolution_id: resolutionId,
          resolution_type: 'manual_conflict_confirm_winner',
          role: 'winner',
          winner_id: winner.id,
          superseded_id: superseded.id,
          resolved_at: resolvedAt,
        }),
      });
      updateMemory(superseded.id, {
        superseded_by: winner.id,
        metadata: buildConflictResolvedMetadata(superseded, {
          resolution_id: resolutionId,
          resolution_type: 'manual_conflict_confirm_winner',
          role: 'superseded',
          winner_id: winner.id,
          superseded_id: superseded.id,
          resolved_at: resolvedAt,
        }),
      });
      insertLifecycleLog('conflict_review_resolved', [winner.id, superseded.id], {
        resolution_id: resolutionId,
        winner_id: winner.id,
        superseded_id: superseded.id,
        agent_id: winner.agent_id,
      });
    });
    tx();

    return {
      ok: true,
      winner: getMemoryById(winner.id),
      superseded: getMemoryById(superseded.id),
      resolution: {
        resolution_id: resolutionId,
        winner_id: winner.id,
        superseded_id: superseded.id,
        resolved_at: resolvedAt,
      },
    };
  });

  // Roll back a manual conflict confirmation.
  app.post('/api/v1/memories/:id/conflict-review/rollback', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body as { resolution_id?: string } | undefined) || {};
    const winner = getMemoryById(id);
    if (!winner) { reply.code(404); return { error: 'Memory not found' }; }
    if (winner.superseded_by) {
      reply.code(409);
      return { error: 'Only the active kept memory can roll back a conflict confirmation' };
    }

    const resolution = parseConflictResolution(winner);
    if (!resolution || resolution.role !== 'winner') {
      reply.code(409);
      return { error: 'This memory does not have a rollbackable conflict confirmation' };
    }
    if (body.resolution_id && body.resolution_id !== resolution.resolution_id) {
      reply.code(409);
      return { error: 'resolution_id does not match the active conflict confirmation' };
    }

    const superseded = getMemoryById(resolution.superseded_id);
    if (!superseded) {
      reply.code(409);
      return { error: 'Rollback requires the superseded memory to still exist' };
    }
    if (superseded.superseded_by !== winner.id) {
      reply.code(409);
      return { error: 'Rollback aborted because the superseded memory changed after confirmation' };
    }

    const db = getDb();
    const tx = db.transaction(() => {
      updateMemory(winner.id, {
        superseded_by: null,
        metadata: buildConflictReviewAuditMetadata(winner, {
          currentId: winner.id,
          otherId: superseded.id,
        }, 'needs_review', 'manual rollback restored conflict review'),
      });
      updateMemory(superseded.id, {
        superseded_by: null,
        metadata: buildConflictReviewAuditMetadata(superseded, {
          currentId: superseded.id,
          otherId: winner.id,
        }, 'needs_review', 'manual rollback restored conflict review'),
      });
      insertLifecycleLog('conflict_review_resolution_rolled_back', [winner.id, superseded.id], {
        resolution_id: resolution.resolution_id,
        winner_id: winner.id,
        superseded_id: superseded.id,
        agent_id: winner.agent_id,
      });
    });
    tx();

    return {
      ok: true,
      winner: getMemoryById(winner.id),
      superseded: getMemoryById(superseded.id),
      resolution_id: resolution.resolution_id,
    };
  });

  // Delete memory
  app.delete('/api/v1/memories/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = getMemoryById(id);
    if (!existing) { reply.code(404); return { error: 'Memory not found' }; }

    deleteMemory(id);
    try { await cortex.vectorBackend.delete([id]); } catch { /* best effort */ }
    return { ok: true, id };
  });
}
