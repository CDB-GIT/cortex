import React, { lazy, Suspense, useEffect, useState, useCallback, startTransition } from 'react';
import { listMemories, createMemory, updateMemory, deleteMemory, search, triggerImport, listAgents, submitMemoryFeedback } from '../api/client.js';
import { useI18n } from '../i18n/index.js';
import { toLocal } from '../utils/time.js';

const loadMemoryDetail = () => import('./MemoryDetail.js');
const MemoryDetail = lazy(loadMemoryDetail);

interface Memory {
  id: string;
  layer: string;
  category: string;
  content: string;
  importance: number;
  confidence: number;
  decay_score: number;
  access_count: number;
  created_at: string;
  updated_at: string;
  agent_id: string;
  source: string | null;
  superseded_by: string | null;
  metadata?: string | null;
  is_pinned?: number;
}

interface DuplicateResolutionMeta {
  resolution_id: string;
  resolution_type: 'manual_keep_one_supersede_others';
  role: 'keeper' | 'superseded';
  keeper_id: string;
  duplicate_group_ids: string[];
  superseded_ids: string[];
  resolved_at: string;
}

interface ConflictAuditMeta {
  audit_kind?: 'timeline_update_candidate' | 'conflict_needs_review';
  audit_timeline_role?: 'current_candidate' | 'history_candidate';
  audit_current_candidate_id?: string;
  audit_history_candidate_id?: string;
}

interface TimelineResolutionMeta {
  resolution_id: string;
  resolution_type: 'manual_timeline_confirm_current' | 'auto_timeline_keep_current';
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

type SortField = 'created_at' | 'importance' | 'decay_score' | 'access_count' | 'confidence';
type SortDir = 'desc' | 'asc';

const CATEGORIES = ['identity', 'preference', 'decision', 'fact', 'entity', 'correction', 'todo', 'context', 'summary', 'skill', 'relationship', 'goal', 'insight', 'project_state', 'constraint', 'policy', 'agent_self_improvement', 'agent_user_habit', 'agent_relationship', 'agent_persona'];

const CATEGORY_LABELS: Record<string, string> = {
  identity: '\u8eab\u4efd\u4fe1\u606f',
  preference: '\u504f\u597d\u4e60\u60ef',
  decision: '\u5173\u952e\u51b3\u7b56',
  fact: '\u4e8b\u5b9e',
  entity: '\u5b9e\u4f53',
  correction: '\u7ea0\u6b63',
  todo: '\u5f85\u529e/\u63d0\u9192',
  context: '\u4e0a\u4e0b\u6587',
  summary: '\u5386\u53f2\u6458\u8981',
  skill: '\u6280\u80fd',
  relationship: '\u5173\u7cfb',
  goal: '\u76ee\u6807\u8ba1\u5212',
  insight: '\u6d1e\u5bdf\u5fc3\u5f97',
  project_state: '\u9879\u76ee\u72b6\u6001',
  constraint: '\u7ea6\u675f',
  policy: '\u7b56\u7565',
  agent_self_improvement: 'Agent \u81ea\u6211\u6539\u8fdb',
  agent_user_habit: 'Agent \u7528\u6237\u89c2\u5bdf',
  agent_relationship: 'Agent \u5173\u7cfb\u52a8\u6001',
  agent_persona: 'Agent \u4eba\u8bbe\u98ce\u683c',
};

export default function MemoryBrowser() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [total, setTotal] = useState(0);
  const [layer, setLayer] = useState('');
  const [category, setCategory] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [auditFilter, setAuditFilter] = useState('');
  const [agents, setAgents] = useState<any[]>([]);
  const [versionFilter, setVersionFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [sortField, setSortField] = useState<SortField>('created_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<Memory | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState('');
  const [importFormat, setImportFormat] = useState('json');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState('');
  const [bulkCategory, setBulkCategory] = useState('fact');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [newMem, setNewMem] = useState({ layer: 'core', category: 'fact', content: '', importance: 0.5 });
  const [scoreMap, setScoreMap] = useState<Record<string, number>>({});
  const [searchLimit, setSearchLimit] = useState(50);
  const [feedbackSent, setFeedbackSent] = useState<Record<string, string>>({});
  const limit = 20;
  const { t } = useI18n();

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const load = useCallback(() => {
    if (isSearchMode && searchQuery.trim()) {
      search({ query: searchQuery, limit: searchLimit, debug: false, agent_id: agentFilter || undefined }).then((r: any) => {
        let results = (r.results || []) as any[];
        // Build score map
        const scores: Record<string, number> = {};
        for (const m of results) scores[m.id] = m.finalScore ?? 0;
        setScoreMap(scores);
        // Apply client-side filters
        if (layer) results = results.filter(m => m.layer === layer);
        if (category) results = results.filter(m => m.category === category);
        if (agentFilter) results = results.filter(m => m.agent_id === agentFilter);
        if (auditFilter) {
          results = results.filter((m: any) => {
            try {
              const meta = m.metadata ? JSON.parse(m.metadata) : {};
              return meta.audit_flag === auditFilter;
            } catch { return false; }
          });
        }
        // Default sort by score (desc) in search mode, unless user picked a different sort
        if (sortField === 'created_at' && sortDir === 'desc') {
          results.sort((a: any, b: any) => (b.finalScore ?? 0) - (a.finalScore ?? 0));
        } else {
          results.sort((a: any, b: any) => {
            const va = a[sortField] ?? 0;
            const vb = b[sortField] ?? 0;
            if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
            return sortDir === 'asc' ? va - vb : vb - va;
          });
        }
        setMemories(results.slice(page * limit, (page + 1) * limit));
        setTotal(results.length);
      });
    } else {
      const params: Record<string, string> = { limit: String(limit), offset: String(page * limit) };
      if (layer) params.layer = layer;
      if (category) params.category = category;
      if (agentFilter) params.agent_id = agentFilter;
      if (auditFilter) params.audit_flag = auditFilter;
      if (versionFilter === 'has_versions') {
        params.has_versions = 'true';
        params.include_superseded = 'true';
      } else if (versionFilter === 'superseded') {
        params.include_superseded = 'true';
      }
      listMemories(params).then((r: any) => {
        let items = r.items as Memory[];
        if (sortField !== 'created_at' || sortDir !== 'desc') {
          items = [...items].sort((a: any, b: any) => {
            const va = a[sortField] ?? 0;
            const vb = b[sortField] ?? 0;
            if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
            return sortDir === 'asc' ? va - vb : vb - va;
          });
        }
        setMemories(items);
        setTotal(r.total);
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer, category, agentFilter, auditFilter, versionFilter, page, searchQuery, isSearchMode, sortField, sortDir]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { listAgents().then((res: any) => setAgents(res.agents || [])).catch(() => {}); }, []);

  const handleSearch = () => {
    if (searchQuery.trim()) {
      setIsSearchMode(true);
      setPage(0);
    } else {
      setIsSearchMode(false);
    }
  };

  const clearSearch = () => {
    setSearchQuery('');
    setIsSearchMode(false);
    setScoreMap({});
    setPage(0);
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t('memories.confirmDelete'))) return;
    try {
      await deleteMemory(id);
      setSelected(prev => { const n = new Set(prev); n.delete(id); return n; });
      setToast({ message: t('memories.toastDeleted', { count: 1 }), type: 'success' });
      load();
    } catch (e: any) {
      setToast({ message: e.message || 'Delete failed', type: 'error' });
    }
  };

  const handleSaveEdit = async () => {
    if (!editing) return;
    await updateMemory(editing.id, {
      content: editing.content,
      category: editing.category,
      importance: editing.importance,
    });
    setEditing(null);
    load();
  };

  const handleCreate = async () => {
    await createMemory(newMem);
    setCreating(false);
    setNewMem({ layer: 'core', category: 'fact', content: '', importance: 0.5 });
    load();
  };

  const handleImport = async () => {
    try {
      let data: any;
      if (importFormat === 'json') {
        const parsed = JSON.parse(importText);
        data = { format: 'json', memories: Array.isArray(parsed) ? parsed : parsed.memories || [parsed] };
      } else {
        data = { format: 'memory_md', content: importText };
      }
      const result = await triggerImport(data);
      setToast({ message: t('memories.toastImported', { imported: result.imported, skipped: result.skipped }), type: 'success' });
      setImporting(false);
      setImportText('');
      load();
    } catch (e: any) {
      setToast({ message: t('memories.toastImportFailed', { message: e.message }), type: 'error' });
    }
  };

  // Bulk operations
  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === memories.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(memories.map(m => m.id)));
    }
  };

  const handleBulkAction = async () => {
    if (selected.size === 0) return;
    const ids = [...selected];

    if (bulkAction === 'delete') {
      if (!confirm(t('memories.confirmBulkDelete', { count: ids.length }))) return;
      let deleted = 0;
      for (const id of ids) {
        try { await deleteMemory(id); deleted++; } catch {}
      }
      if (deleted > 0) {
        setToast({ message: t('memories.toastDeleted', { count: deleted }), type: 'success' });
      } else {
        setToast({ message: t('memories.toastDeleteFailed'), type: 'error' });
      }
    } else if (bulkAction === 'category') {
      let updated = 0;
      for (const id of ids) {
        try { await updateMemory(id, { category: bulkCategory }); updated++; } catch {}
      }
      if (updated > 0) {
        setToast({ message: t('memories.toastCategoryUpdated', { count: updated, category: bulkCategory }), type: 'success' });
      } else {
        setToast({ message: t('memories.toastUpdateFailed'), type: 'error' });
      }
    }

    setSelected(new Set());
    setBulkAction('');
    load();
  };

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  const handleFeedback = async (memoryId: string, signal: 'helpful' | 'not_helpful' | 'outdated' | 'wrong') => {
    try {
      await submitMemoryFeedback(memoryId, { signal, source: 'explicit' });
      setFeedbackSent(prev => ({ ...prev, [memoryId]: signal }));
      setToast({ message: t('memories.feedbackSent'), type: 'success' });
    } catch (e: any) {
      setToast({ message: t('memories.feedbackFailed', { message: e.message }), type: 'error' });
    }
  };

  const sortIcon = (field: SortField) => {
    if (sortField !== field) return ' ↕';
    return sortDir === 'desc' ? ' ↓' : ' ↑';
  };

  const sortLabel = (field: SortField) => {
    if (field === 'created_at') return t('memories.date');
    if (field === 'access_count') return t('memories.access');
    if (field === 'importance') return t('memories.importance');
    if (field === 'decay_score') return t('memories.decayScore');
    return field;
  };

  const parseMeta = (memory: Memory): Record<string, any> | null => {
    try {
      return memory.metadata ? JSON.parse(memory.metadata) : null;
    } catch {
      return null;
    }
  };

  const getAuditFlag = (memory: Memory): string | null => {
    const meta = parseMeta(memory);
    return typeof meta?.audit_flag === 'string' ? meta.audit_flag : null;
  };

  const getDuplicateResolution = (memory: Memory): DuplicateResolutionMeta | null => {
    const meta = parseMeta(memory);
    const candidate = meta?.duplicate_resolution;
    if (!candidate || typeof candidate !== 'object') return null;
    if (candidate.role !== 'keeper' && candidate.role !== 'superseded') return null;
    if (typeof candidate.keeper_id !== 'string' || typeof candidate.resolution_id !== 'string') return null;
    return {
      resolution_id: candidate.resolution_id,
      resolution_type: 'manual_keep_one_supersede_others',
      role: candidate.role,
      keeper_id: candidate.keeper_id,
      duplicate_group_ids: Array.isArray(candidate.duplicate_group_ids) ? candidate.duplicate_group_ids.filter((id: unknown): id is string => typeof id === 'string') : [],
      superseded_ids: Array.isArray(candidate.superseded_ids) ? candidate.superseded_ids.filter((id: unknown): id is string => typeof id === 'string') : [],
      resolved_at: typeof candidate.resolved_at === 'string' ? candidate.resolved_at : memory.updated_at,
    };
  };

  const getConflictAuditMeta = (memory: Memory): ConflictAuditMeta | null => {
    const meta = parseMeta(memory);
    if (!meta || meta.audit_flag !== 'possible_conflict') return null;
    return meta as ConflictAuditMeta;
  };

  const getTimelineResolution = (memory: Memory): TimelineResolutionMeta | null => {
    const meta = parseMeta(memory);
    const candidate = meta?.timeline_resolution;
    if (!candidate || typeof candidate !== 'object') return null;
    if (candidate.resolution_type !== 'manual_timeline_confirm_current' && candidate.resolution_type !== 'auto_timeline_keep_current') return null;
    if (candidate.role !== 'current' && candidate.role !== 'history') return null;
    if (typeof candidate.resolution_id !== 'string' || typeof candidate.current_id !== 'string' || typeof candidate.history_id !== 'string') return null;
    return {
      resolution_id: candidate.resolution_id,
      resolution_type: candidate.resolution_type,
      role: candidate.role,
      current_id: candidate.current_id,
      history_id: candidate.history_id,
      resolved_at: typeof candidate.resolved_at === 'string' ? candidate.resolved_at : memory.updated_at,
    };
  };

  const getConflictResolution = (memory: Memory): ConflictResolutionMeta | null => {
    const meta = parseMeta(memory);
    const candidate = meta?.conflict_resolution;
    if (!candidate || typeof candidate !== 'object') return null;
    if (candidate.role !== 'winner' && candidate.role !== 'superseded') return null;
    if (typeof candidate.resolution_id !== 'string' || typeof candidate.winner_id !== 'string' || typeof candidate.superseded_id !== 'string') return null;
    return {
      resolution_id: candidate.resolution_id,
      resolution_type: 'manual_conflict_confirm_winner',
      role: candidate.role,
      winner_id: candidate.winner_id,
      superseded_id: candidate.superseded_id,
      resolved_at: typeof candidate.resolved_at === 'string' ? candidate.resolved_at : memory.updated_at,
    };
  };

  const getDuplicateResolutionState = (memory: Memory): 'pending' | 'keeper' | 'superseded' | null => {
    const resolution = getDuplicateResolution(memory);
    if (resolution?.role === 'keeper') return 'keeper';
    if (resolution?.role === 'superseded') return 'superseded';
    if (getAuditFlag(memory) === 'duplicate_preference') return 'pending';
    return null;
  };

  const getConflictState = (memory: Memory): 'timeline_current' | 'timeline_history' | 'timeline_current_resolved' | 'timeline_history_resolved' | 'needs_review' | null => {
    const conflictResolution = getConflictResolution(memory);
    if (conflictResolution?.role === 'winner') return 'timeline_current_resolved';
    if (conflictResolution?.role === 'superseded') return 'timeline_history_resolved';
    const resolution = getTimelineResolution(memory);
    if (resolution?.role === 'current') return 'timeline_current_resolved';
    if (resolution?.role === 'history') return 'timeline_history_resolved';
    const conflictMeta = getConflictAuditMeta(memory);
    if (!conflictMeta) return null;
    if (conflictMeta.audit_kind === 'timeline_update_candidate') {
      return conflictMeta.audit_timeline_role === 'current_candidate'
        ? 'timeline_current'
        : 'timeline_history';
    }
    return 'needs_review';
  };

  const getDuplicateResolutionLabel = (state: 'pending' | 'keeper' | 'superseded' | null): string | null => {
    if (state === 'pending') return t('memories.duplicatePending');
    if (state === 'keeper') return t('memories.duplicateKeeper');
    if (state === 'superseded') return t('memories.duplicateSuperseded');
    return null;
  };

  const getConflictLabel = (state: 'timeline_current' | 'timeline_history' | 'timeline_current_resolved' | 'timeline_history_resolved' | 'needs_review' | null): string | null => {
    const resolutionAwareState = state;
    if (state === 'timeline_current') return t('memories.timelineCurrentCandidate');
    if (state === 'timeline_history') return t('memories.timelineHistoryCandidate');
    if (resolutionAwareState === 'timeline_current_resolved') return t('memories.conflictWinnerConfirmed');
    if (resolutionAwareState === 'timeline_history_resolved') return t('memories.conflictSuperseded');
    if (state === 'needs_review') return t('memories.conflictNeedsReview');
    return null;
  };

  const getDuplicateResolutionHint = (memory: Memory): string | null => {
    const state = getDuplicateResolutionState(memory);
    const resolution = getDuplicateResolution(memory);
    if (state === 'pending') {
      return t('memories.duplicatePendingHint');
    }
    if (state === 'keeper') {
      return t('memories.duplicateKeeperHint', {
        count: resolution?.superseded_ids.length ?? 0,
      });
    }
    if (state === 'superseded') {
      return t('memories.duplicateSupersededHint', {
        keeperId: resolution?.keeper_id || memory.superseded_by || '',
      });
    }
    return null;
  };

  const getConflictHint = (memory: Memory): string | null => {
    const state = getConflictState(memory);
    const meta = getConflictAuditMeta(memory);
    const resolution = getTimelineResolution(memory);
    const conflictResolution = getConflictResolution(memory);
    if (state === 'timeline_current') {
      return t('memories.timelineCurrentHint');
    }
    if (state === 'timeline_history') {
      return t('memories.timelineHistoryHint', {
        currentId: meta?.audit_current_candidate_id || '',
      });
    }
    if (state === 'timeline_current_resolved') {
      return conflictResolution?.role === 'winner'
        ? t('memories.conflictWinnerResolvedHint', {
          supersededId: conflictResolution.superseded_id || '',
        })
        : t('memories.timelineCurrentResolvedHint', {
          historyId: resolution?.history_id || '',
        });
    }
    if (state === 'timeline_history_resolved') {
      return conflictResolution?.role === 'superseded'
        ? t('memories.conflictSupersededResolvedHint', {
          winnerId: conflictResolution.winner_id || '',
        })
        : t('memories.timelineHistoryResolvedHint', {
          currentId: resolution?.current_id || '',
        });
    }
    if (state === 'needs_review') {
      return t('memories.conflictNeedsReviewHint');
    }
    return null;
  };

  return (
    <div>
      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: 24, right: 24, zIndex: 200,
          padding: '12px 20px', borderRadius: 'var(--radius-lg)',
          background: toast.type === 'success' ? 'var(--color-success)' : 'var(--color-danger)',
          color: '#fff', fontSize: 14, fontWeight: 500, boxShadow: 'var(--shadow-lg)',
        }}>
          {toast.message}
        </div>
      )}

      {detailId ? (
        <Suspense fallback={<div className="empty">{t('common.loading')}</div>}>
          <MemoryDetail memoryId={detailId} onBack={() => { startTransition(() => setDetailId(null)); load(); }} />
        </Suspense>
      ) : (
      <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>{t('memories.title')}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => setImporting(true)}>{t('common.import')}</button>
          <button className="btn primary" onClick={() => setCreating(true)}>{t('memories.newMemory')}</button>
        </div>
      </div>

      {/* Search Bar */}
      <div className="search-bar" style={{ marginBottom: 8 }}>
        <input
          placeholder={t('memories.searchPlaceholder')}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
        />
        {isSearchMode && (
          <button className="btn" onClick={clearSearch}>{t('common.clear')}</button>
        )}
        <button className="btn primary" onClick={handleSearch}>{t('common.search')}</button>
      </div>

      {/* Filters + Sort */}
      <div className="toolbar">
        <select value={layer} onChange={e => { setLayer(e.target.value); setPage(0); }}>
          <option value="">{t('memories.allLayers')}</option>
          <option value="core">Core</option>
          <option value="working">Working</option>
          <option value="archive">Archive</option>
        </select>
        <select value={category} onChange={e => { setCategory(e.target.value); setPage(0); }}>
          <option value="">{t('memories.allCategories')}</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c] || c}</option>)}
        </select>
        <select value={agentFilter} onChange={e => { setAgentFilter(e.target.value); setPage(0); }}>
          <option value="">{t('memories.allAgents')}</option>
          {agents.map((a: any) => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
        </select>
        <select value={auditFilter} onChange={e => { setAuditFilter(e.target.value); setPage(0); }}>
          <option value="">{t('memories.allAuditStates') || '全部审计状态'}</option>
          <option value="possible_conflict">{t('memories.auditPossibleConflict') || '可能冲突'}</option>
          <option value="duplicate_preference">{t('memories.auditDuplicatePreference') || '重复偏好'}</option>
        </select>
        <select value={versionFilter} onChange={e => { setVersionFilter(e.target.value); setPage(0); }}>
          <option value="">{t('memories.allMemories')}</option>
          <option value="has_versions">{t('memories.hasVersions')}</option>
          <option value="superseded">{t('memories.includeSuperseded')}</option>
        </select>
        <div style={{ display: 'flex', gap: 4, marginLeft: 8 }}>
          {(['created_at', 'importance', 'decay_score', 'access_count'] as SortField[]).map(f => (
            <button
              key={f}
              className="btn"
              style={{
                fontSize: 11, padding: '4px 8px',
                background: sortField === f ? 'var(--color-primary)' : undefined,
                borderColor: sortField === f ? 'var(--color-primary)' : undefined,
              }}
              onClick={() => toggleSort(f)}
            >
              {sortLabel(f)}{sortIcon(f)}
            </button>
          ))}
        </div>
        <span style={{ color: 'var(--color-text-secondary)', fontSize: 13, marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          {isSearchMode && t('memories.searchPrefix')}{t('common.total', { count: total })}
          {isSearchMode && (
            <>
              <span style={{ color: 'var(--color-text-tertiary)' }}>/</span>
              <input
                type="number"
                value={searchLimit}
                onChange={e => setSearchLimit(Math.max(1, Math.min(200, parseInt(e.target.value) || 50)))}
                style={{ width: 52, padding: '2px 4px', fontSize: 12, textAlign: 'center' }}
                min={1} max={200}
                title={t('memories.searchLimitTip') || 'Max results'}
              />
            </>
          )}
        </span>
      </div>

      {/* Bulk Actions */}
      {selected.size > 0 && (
        <div className="card" style={{ padding: '10px 16px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12, borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{t('common.selected', { count: selected.size })}</span>
          <select value={bulkAction} onChange={e => setBulkAction(e.target.value)} style={{ width: 'auto' }}>
            <option value="">{t('memories.bulkAction')}</option>
            <option value="delete">{t('memories.deleteSelected')}</option>
            <option value="category">{t('memories.changeCategory')}</option>
          </select>
          {bulkAction === 'category' && (
            <select value={bulkCategory} onChange={e => setBulkCategory(e.target.value)} style={{ width: 'auto' }}>
              {CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c] || c}</option>)}
            </select>
          )}
          {bulkAction && (
            <button className="btn primary" style={{ fontSize: 12, padding: '4px 12px' }} onClick={handleBulkAction}>{t('common.apply')}</button>
          )}
          <button className="btn" style={{ fontSize: 12, padding: '4px 12px' }} onClick={() => setSelected(new Set())}>{t('common.clear')}</button>
        </div>
      )}

      {/* Memory List */}
      {memories.length === 0 ? (
        <div className="empty">{t('memories.noMemories')}</div>
      ) : (
        <>
          {/* Select all */}
          <div style={{ padding: '4px 0 8px', fontSize: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--color-text-secondary)' }}>
              <input type="checkbox" checked={selected.size === memories.length && memories.length > 0} onChange={toggleSelectAll} style={{ width: 'auto' }} />
              {t('memories.selectAll')}
            </label>
          </div>
          {memories.map(m => (
            <div key={m.id} className="memory-card" data-layer={m.layer} style={{ borderColor: selected.has(m.id) ? 'var(--color-primary)' : undefined }}>
              {(() => {
                const auditFlag = getAuditFlag(m);
                const duplicateState = getDuplicateResolutionState(m);
                const duplicateLabel = getDuplicateResolutionLabel(duplicateState);
                const conflictState = getConflictState(m);
                const conflictLabel = getConflictLabel(conflictState);
                return (
              <div className="header">
                <input
                  type="checkbox"
                  checked={selected.has(m.id)}
                  onChange={() => toggleSelect(m.id)}
                  style={{ width: 'auto', marginRight: 4 }}
                />
                <span className={`badge ${m.layer}`}>{m.layer}</span>
                <span className="badge" style={{ background: 'var(--color-info-muted)', color: '#60a5fa' }}>{m.category}</span>
                {m.is_pinned ? <span className="badge" style={{ background: 'rgba(255,170,0,0.2)', color: '#b8860b' }}>{t('memoryDetail.pinned')}</span> : null}
                {auditFlag === 'possible_conflict' || conflictState === 'timeline_current_resolved' || conflictState === 'timeline_history_resolved' ? (
                  conflictState === 'timeline_current' || conflictState === 'timeline_current_resolved' ? (
                    <span className="badge" style={{ background: 'rgba(14,165,233,0.16)', color: '#0369a1' }}>
                      {conflictLabel}
                    </span>
                  ) : conflictState === 'timeline_history' || conflictState === 'timeline_history_resolved' ? (
                    <span className="badge" style={{ background: 'rgba(148,163,184,0.18)', color: '#475569' }}>
                      {conflictLabel}
                    </span>
                  ) : (
                    <span className="badge" style={{ background: 'rgba(244,114,182,0.18)', color: '#db2777' }}>
                      {conflictLabel || t('memories.auditPossibleConflict') || '可能冲突'}
                    </span>
                  )
                ) : null}
                {auditFlag === 'duplicate_preference' && duplicateState === null ? (
                  <span className="badge" style={{ background: 'rgba(249,115,22,0.18)', color: '#c2410c' }}>
                    {t('memories.auditDuplicatePreference') || '重复偏好'}
                  </span>
                ) : null}
                {duplicateState === 'keeper' ? (
                  <span className="badge" style={{ background: 'rgba(34,197,94,0.16)', color: '#15803d' }}>
                    {duplicateLabel}
                  </span>
                ) : null}
                {duplicateState === 'superseded' ? (
                  <span className="badge" style={{ background: 'rgba(100,116,139,0.16)', color: '#475569' }}>
                    {duplicateLabel}
                  </span>
                ) : null}
                {duplicateState === 'pending' ? (
                  <span className="badge" style={{ background: 'rgba(249,115,22,0.18)', color: '#c2410c' }}>
                    {duplicateLabel}
                  </span>
                ) : null}
                {isSearchMode && scoreMap[m.id] !== undefined && (
                  <span className={`score-pill ${scoreMap[m.id]! > 0.3 ? 'high' : scoreMap[m.id]! > 0.1 ? 'medium' : 'low'}`}>
                    {scoreMap[m.id]!.toFixed(3)}
                  </span>
                )}
                <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--color-text-tertiary)' }}>{toLocal(m.created_at, 'short')}</span>
              </div>
                );
              })()}
              <div className="content">{m.content}</div>
              {(() => {
                const hint = getDuplicateResolutionHint(m) || getConflictHint(m);
                if (!hint) return null;
                return (
                  <div style={{
                    marginTop: 8,
                    marginBottom: 6,
                    padding: '8px 10px',
                    borderRadius: 8,
                    background: 'var(--color-base)',
                    color: 'var(--color-text-secondary)',
                    fontSize: 12,
                  }}>
                    {hint}
                  </div>
                );
              })()}
              <div className="meta">
                <span>{t('memories.imp')}: {m.importance?.toFixed(2)}</span>
                <span>{t('memories.decay')}: {m.decay_score?.toFixed(2)}</span>
                <span>{t('memories.access')}: {m.access_count}</span>
                <span>{t('memories.agent')}: {m.agent_id}</span>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                  <div style={{ display: 'flex', gap: 2, marginRight: 4 }} role="group" aria-label={t('memories.feedbackLabel')}>
                    {([
                      { signal: 'helpful' as const, icon: '👍', label: t('memories.feedbackHelpful') },
                      { signal: 'not_helpful' as const, icon: '😐', label: t('memories.feedbackNeutral') },
                      { signal: 'wrong' as const, icon: '👎', label: t('memories.feedbackWrong') },
                    ]).map(fb => (
                      <button
                        key={fb.signal}
                        className="btn"
                        title={fb.label}
                        aria-label={fb.label}
                        onClick={() => handleFeedback(m.id, fb.signal)}
                        disabled={!!feedbackSent[m.id]}
                        style={{
                          fontSize: 14, padding: '2px 6px', minWidth: 28,
                          opacity: feedbackSent[m.id] && feedbackSent[m.id] !== fb.signal ? 0.3 : 1,
                          background: feedbackSent[m.id] === fb.signal ? 'var(--color-primary-muted)' : undefined,
                          borderColor: feedbackSent[m.id] === fb.signal ? 'var(--color-primary)' : undefined,
                        }}
                      >
                        {fb.icon}
                      </button>
                    ))}
                  </div>
                  <button
                    className="btn"
                    onMouseEnter={() => { void loadMemoryDetail(); }}
                    onFocus={() => { void loadMemoryDetail(); }}
                    onClick={() => startTransition(() => setDetailId(m.id))}
                    style={{ fontSize: 12 }}
                  >
                    {t('common.view')}
                  </button>
                  <button className="btn" onClick={() => setEditing({ ...m })}>{t('common.edit')}</button>
                  <button className="btn danger" onClick={() => handleDelete(m.id)}>{t('common.delete')}</button>
                </div>
              </div>
            </div>
          ))}
        </>
      )}

      {/* Pagination */}
      {total > limit && (
        <div style={{
          display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center', marginTop: 20,
          padding: '12px 0',
        }}>
          <button className="btn" disabled={page === 0} onClick={() => setPage(p => p - 1)}>{t('common.prev')}</button>
          <span style={{
            padding: '6px 16px', color: 'var(--color-text-secondary)',
            background: 'var(--color-elevated)', borderRadius: 'var(--radius-md)',
            fontSize: 13, fontWeight: 500, boxShadow: 'var(--shadow-sm)',
          }}>{t('common.page', { current: page + 1, total: Math.ceil(total / limit) })}</span>
          <button className="btn" disabled={(page + 1) * limit >= total} onClick={() => setPage(p => p + 1)}>{t('common.next')}</button>
        </div>
      )}

      {/* Edit Modal */}
      {editing && (
        <div className="modal-overlay" onClick={() => setEditing(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>{t('memories.editMemory')}</h2>
            <div className="form-group">
              <label>{t('memories.category')}</label>
              <select value={editing.category} onChange={e => setEditing({ ...editing, category: e.target.value })}>
                {CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c] || c}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>{t('memories.content')}</label>
              <textarea rows={4} value={editing.content} onChange={e => setEditing({ ...editing, content: e.target.value })} />
            </div>
            <div className="form-group">
              <label>{t('memories.importanceLabel')} ({editing.importance?.toFixed(2)})</label>
              <input type="range" min="0" max="1" step="0.05" value={editing.importance}
                onChange={e => setEditing({ ...editing, importance: parseFloat(e.target.value) })} />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
              <button className="btn primary" onClick={handleSaveEdit}>{t('common.save')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Create Modal */}
      {creating && (
        <div className="modal-overlay" onClick={() => setCreating(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>{t('memories.newMemoryTitle')}</h2>
            <div className="form-group">
              <label>{t('memories.layer')}</label>
              <select value={newMem.layer} onChange={e => setNewMem({ ...newMem, layer: e.target.value })}>
                <option value="core">Core</option>
                <option value="working">Working</option>
              </select>
            </div>
            <div className="form-group">
              <label>{t('memories.category')}</label>
              <select value={newMem.category} onChange={e => setNewMem({ ...newMem, category: e.target.value })}>
                {CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c] || c}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>{t('memories.content')}</label>
              <textarea rows={4} value={newMem.content} onChange={e => setNewMem({ ...newMem, content: e.target.value })} />
            </div>
            <div className="form-group">
              <label>{t('memories.importanceLabel')} ({newMem.importance.toFixed(2)})</label>
              <input type="range" min="0" max="1" step="0.05" value={newMem.importance}
                onChange={e => setNewMem({ ...newMem, importance: parseFloat(e.target.value) })} />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setCreating(false)}>{t('common.cancel')}</button>
              <button className="btn primary" onClick={handleCreate} disabled={!newMem.content.trim()}>{t('common.create')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Import Modal */}
      {importing && (
        <div className="modal-overlay" onClick={() => setImporting(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>{t('memories.importMemories')}</h2>
            <div className="form-group">
              <label>{t('memories.format')}</label>
              <select value={importFormat} onChange={e => setImportFormat(e.target.value)}>
                <option value="json">{t('memories.jsonFormat')}</option>
                <option value="memory_md">{t('memories.markdownFormat')}</option>
              </select>
            </div>
            <div className="form-group">
              <label>{importFormat === 'json' ? t('memories.jsonPlaceholderLabel') : t('memories.mdPlaceholderLabel')}</label>
              <textarea
                rows={10}
                value={importText}
                onChange={e => setImportText(e.target.value)}
                placeholder={importFormat === 'json'
                  ? '[{"layer":"core","category":"fact","content":"...","importance":0.7}]'
                  : '## Facts\n- User prefers dark mode\n- User lives in Tokyo\n\n## Preferences\n- Likes Japanese food'}
                style={{ fontFamily: 'monospace', fontSize: 12 }}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setImporting(false)}>{t('common.cancel')}</button>
              <button className="btn primary" onClick={handleImport} disabled={!importText.trim()}>{t('common.import')}</button>
            </div>
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
}
