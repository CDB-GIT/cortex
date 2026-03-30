import React, { useEffect, useState } from 'react';
import {
  getMemory,
  updateMemory,
  search,
  getMemoryChain,
  rollbackMemory,
  resolveDuplicatePreference,
  rollbackDuplicatePreferenceResolution,
  resolveTimelineUpdate,
  rollbackTimelineUpdateResolution,
  resolveConflictReview,
  rollbackConflictReviewResolution,
} from '../api/client.js';
import { useI18n } from '../i18n/index.js';
import { toLocal } from '../utils/time.js';

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
  superseded_by: string | null;
  metadata: string | null;
  agent_id?: string;
  source?: string;
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

interface AuditTimelineMeta {
  audit_kind?: 'timeline_update_candidate' | 'conflict_needs_review';
  audit_timeline_role?: 'current_candidate' | 'history_candidate';
  audit_current_candidate_id?: string;
  audit_history_candidate_id?: string;
  audit_conflict_with?: string[];
  audit_decision?: string;
  audit_decision_reason?: string;
}

interface TimelineResolutionMeta {
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

/** Parse metadata JSON safely */
function parseMeta(m: Memory): Record<string, any> | null {
  if (!m.metadata) return null;
  try { return JSON.parse(m.metadata); } catch { return null; }
}

/** Simple word-level diff for two strings */
function computeDiff(oldText: string, newText: string): { type: 'same' | 'add' | 'remove'; text: string }[] {
  const oldWords = oldText.split(/(\s+)/);
  const newWords = newText.split(/(\s+)/);
  const result: { type: 'same' | 'add' | 'remove'; text: string }[] = [];

  // Simple LCS-based diff
  const m = oldWords.length;
  const n = newWords.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = oldWords[i - 1] === newWords[j - 1]
        ? dp[i - 1]![j - 1]! + 1
        : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }

  let i = m, j = n;
  const ops: { type: 'same' | 'add' | 'remove'; text: string }[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
      ops.unshift({ type: 'same', text: oldWords[i - 1]! });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      ops.unshift({ type: 'add', text: newWords[j - 1]! });
      j--;
    } else {
      ops.unshift({ type: 'remove', text: oldWords[i - 1]! });
      i--;
    }
  }
  return ops;
}

export default function MemoryDetail({ memoryId, onBack }: { memoryId: string; onBack: () => void }) {
  const [memory, setMemory] = useState<Memory | null>(null);
  const [chain, setChain] = useState<Memory[]>([]);
  const [similar, setSimilar] = useState<any[]>([]);
  const [loadingContext, setLoadingContext] = useState(false);
  const [duplicatePeers, setDuplicatePeers] = useState<Memory[]>([]);
  const [conflictPeers, setConflictPeers] = useState<Memory[]>([]);
  const [showDuplicateSuggestion, setShowDuplicateSuggestion] = useState(false);
  const [loadingDuplicatePeers, setLoadingDuplicatePeers] = useState(false);
  const [loadingConflictPeers, setLoadingConflictPeers] = useState(false);
  const [selectedDuplicateKeeperId, setSelectedDuplicateKeeperId] = useState('');
  const [resolvingDuplicate, setResolvingDuplicate] = useState(false);
  const [rollingBackDuplicateResolution, setRollingBackDuplicateResolution] = useState(false);
  const [resolvingTimelineUpdate, setResolvingTimelineUpdate] = useState(false);
  const [rollingBackTimelineUpdate, setRollingBackTimelineUpdate] = useState(false);
  const [resolvingConflictReview, setResolvingConflictReview] = useState(false);
  const [rollingBackConflictReview, setRollingBackConflictReview] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ content: string; category: string; importance: number; is_pinned: boolean }>({ content: '', category: '', importance: 0, is_pinned: false });
  const [diffPair, setDiffPair] = useState<[Memory, Memory] | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const { t } = useI18n();

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  useEffect(() => {
    loadMemoryData(memoryId);
  }, [memoryId]);

  useEffect(() => {
    if (!memory) {
      setDuplicatePeers([]);
      return;
    }

    const currentMeta = parseMeta(memory);
    const duplicateIds = Array.isArray(currentMeta?.preference_duplicate_with)
      ? currentMeta.preference_duplicate_with.filter((id: unknown) => typeof id === 'string' && id.trim())
      : [];

    if (duplicateIds.length === 0) {
      setDuplicatePeers([]);
      return;
    }

    let cancelled = false;
    setLoadingDuplicatePeers(true);
    Promise.all(duplicateIds.map((id: string) => getMemory(id).catch(() => null)))
      .then((items) => {
        if (cancelled) return;
        setDuplicatePeers(items.filter(Boolean));
      })
      .finally(() => {
        if (!cancelled) setLoadingDuplicatePeers(false);
      });

    return () => {
      cancelled = true;
    };
  }, [memory?.id, memory?.metadata]);

  useEffect(() => {
    if (!memory) {
      setConflictPeers([]);
      return;
    }

    const currentMeta = parseMeta(memory);
    const conflictIds = Array.isArray(currentMeta?.audit_conflict_with)
      ? currentMeta.audit_conflict_with.filter((id: unknown) => typeof id === 'string' && id.trim())
      : [];

    if (conflictIds.length === 0) {
      setConflictPeers([]);
      return;
    }

    let cancelled = false;
    setLoadingConflictPeers(true);
    Promise.all(conflictIds.map((id: string) => getMemory(id).catch(() => null)))
      .then((items) => {
        if (cancelled) return;
        setConflictPeers(items.filter(Boolean));
      })
      .finally(() => {
        if (!cancelled) setLoadingConflictPeers(false);
      });

    return () => {
      cancelled = true;
    };
  }, [memory?.id, memory?.metadata]);

  const loadMemoryData = async (id: string) => {
    setLoading(true);
    setLoadingContext(false);
    setChain([]);
    setSimilar([]);
    try {
      const mem = await getMemory(id);
      setMemory(mem);
      setDraft({ content: mem.content, category: mem.category, importance: mem.importance, is_pinned: !!mem.is_pinned });
      setLoading(false);
      setLoadingContext(true);

      void (async () => {
        try {
          const chainRes = await getMemoryChain(id);
          setChain(chainRes.chain || [mem]);
        } catch {
          setChain([mem]);
        }
      })();

      // Defer related-memory search until the detail shell is already visible.
      void (async () => {
        try {
          await new Promise((resolve) => setTimeout(resolve, 0));
          const snippet = mem.content.slice(0, 100);
          const res = await search({ query: snippet, limit: 6, debug: false });
          setSimilar((res.results || []).filter((r: any) => r.id !== id).slice(0, 5));
        } catch {
          setSimilar([]);
        } finally {
          setLoadingContext(false);
        }
      })();
    } catch (e: any) {
      console.error(e);
      setLoading(false);
      setLoadingContext(false);
      setChain([]);
      setSimilar([]);
    }
  };

  const handleSave = async () => {
    if (!memory) return;
    try {
      await updateMemory(memory.id, { ...draft, is_pinned: draft.is_pinned ? 1 : 0 });
      const updated = await getMemory(memory.id);
      setMemory(updated);
      setEditing(false);
      setToast({ message: t('memoryDetail.toastUpdated'), type: 'success' });
    } catch (e: any) {
      setToast({ message: t('memoryDetail.toastSaveFailed', { message: e.message }), type: 'error' });
    }
  };

  const handleRollback = async (targetId: string) => {
    if (!memory) return;
    if (!confirm(t('memoryDetail.rollbackConfirm'))) return;
    try {
      const res = await rollbackMemory(memory.id, targetId);
      if (res.ok) {
        setToast({ message: t('memoryDetail.rollbackSuccess'), type: 'success' });
        loadMemoryData(res.restored.id);
      }
    } catch (e: any) {
      setToast({ message: e.message, type: 'error' });
    }
  };

  if (loading) return <div className="empty">{t('common.loading')}</div>;
  if (!memory) return <div className="empty">{t('memoryDetail.notFound')}</div>;

  // Decay visualization — simulate decay curve
  const decayCurve: { day: number; score: number }[] = [];
  const lambda = 0.03;
  for (let d = 0; d <= 60; d += 2) {
    decayCurve.push({ day: d, score: Math.exp(-lambda * d) });
  }

  // Determine the latest version in the chain
  const latestInChain = chain.length > 0 ? chain[chain.length - 1] : null;
  const isLatest = latestInChain?.id === memory.id;
  const meta = parseMeta(memory);
  const sourceMemoryIds = Array.isArray(meta?.source_memories)
    ? meta.source_memories.filter((id: unknown) => typeof id === 'string' && id.trim())
    : [];
  const duplicatePreferenceIds = Array.isArray(meta?.preference_duplicate_with)
    ? meta.preference_duplicate_with.filter((id: unknown) => typeof id === 'string' && id.trim())
    : [];
  const auditFlag = typeof meta?.audit_flag === 'string' ? meta.audit_flag : null;
  const auditMeta = (meta || {}) as AuditTimelineMeta;
  const auditKind = typeof auditMeta.audit_kind === 'string' ? auditMeta.audit_kind : null;
  const auditTimelineRole = typeof auditMeta.audit_timeline_role === 'string' ? auditMeta.audit_timeline_role : null;
  const conflictIds = Array.isArray(auditMeta.audit_conflict_with)
    ? auditMeta.audit_conflict_with.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];
  const currentTimelineCandidateId = typeof auditMeta.audit_current_candidate_id === 'string' ? auditMeta.audit_current_candidate_id : null;
  const historyTimelineCandidateId = typeof auditMeta.audit_history_candidate_id === 'string' ? auditMeta.audit_history_candidate_id : null;
  const auditDecisionReason = typeof auditMeta.audit_decision_reason === 'string' ? auditMeta.audit_decision_reason : null;
  const timelineResolution = (() => {
    if (!meta?.timeline_resolution || typeof meta.timeline_resolution !== 'object') return null;
    const candidate = meta.timeline_resolution as Partial<TimelineResolutionMeta>;
    if (!candidate || (candidate.role !== 'current' && candidate.role !== 'history')) return null;
    if (typeof candidate.resolution_id !== 'string' || typeof candidate.current_id !== 'string' || typeof candidate.history_id !== 'string') {
      return null;
    }
    return {
      resolution_id: candidate.resolution_id,
      resolution_type: 'manual_timeline_confirm_current',
      role: candidate.role,
      current_id: candidate.current_id,
      history_id: candidate.history_id,
      resolved_at: typeof candidate.resolved_at === 'string' ? candidate.resolved_at : memory.updated_at,
    } satisfies TimelineResolutionMeta;
  })();
  const conflictResolution = (() => {
    if (!meta?.conflict_resolution || typeof meta.conflict_resolution !== 'object') return null;
    const candidate = meta.conflict_resolution as Partial<ConflictResolutionMeta>;
    if (!candidate || (candidate.role !== 'winner' && candidate.role !== 'superseded')) return null;
    if (typeof candidate.resolution_id !== 'string' || typeof candidate.winner_id !== 'string' || typeof candidate.superseded_id !== 'string') {
      return null;
    }
    return {
      resolution_id: candidate.resolution_id,
      resolution_type: 'manual_conflict_confirm_winner',
      role: candidate.role,
      winner_id: candidate.winner_id,
      superseded_id: candidate.superseded_id,
      resolved_at: typeof candidate.resolved_at === 'string' ? candidate.resolved_at : memory.updated_at,
    } satisfies ConflictResolutionMeta;
  })();
  const duplicateCandidates = [memory, ...duplicatePeers].filter(
    (candidate, index, list) => list.findIndex((item) => item.id === candidate.id) === index,
  );
  const getSourceCount = (candidate: Memory) => {
    const candidateMeta = parseMeta(candidate);
    return Array.isArray(candidateMeta?.source_memories)
      ? candidateMeta.source_memories.filter((id: unknown) => typeof id === 'string' && id.trim()).length
      : 0;
  };
  const sortedDuplicateCandidates = [...duplicateCandidates].sort((a, b) => {
    if (!!a.is_pinned !== !!b.is_pinned) return a.is_pinned ? -1 : 1;
    if ((b.confidence ?? 0) !== (a.confidence ?? 0)) return (b.confidence ?? 0) - (a.confidence ?? 0);
    if (getSourceCount(b) !== getSourceCount(a)) return getSourceCount(b) - getSourceCount(a);
    if (b.updated_at !== a.updated_at) return b.updated_at.localeCompare(a.updated_at);
    if ((b.importance ?? 0) !== (a.importance ?? 0)) return (b.importance ?? 0) - (a.importance ?? 0);
    return a.id.localeCompare(b.id);
  });
  const recommendedDuplicateKeeper = sortedDuplicateCandidates[0] ?? null;
  const duplicateSuggestionReason = recommendedDuplicateKeeper?.is_pinned
    ? t('memoryDetail.duplicateSuggestPinned')
    : recommendedDuplicateKeeper?.id === memory.id
      ? t('memoryDetail.duplicateSuggestCurrent')
      : t('memoryDetail.duplicateSuggestEvidence');
  const selectedDuplicateKeeper = sortedDuplicateCandidates.find((candidate) => candidate.id === selectedDuplicateKeeperId) || null;
  const selectedDuplicateSupersededCount = Math.max(0, sortedDuplicateCandidates.length - (selectedDuplicateKeeper ? 1 : 0));
  const duplicateResolution = (() => {
    if (!meta?.duplicate_resolution || typeof meta.duplicate_resolution !== 'object') return null;
    const candidate = meta.duplicate_resolution as Partial<DuplicateResolutionMeta>;
    if (
      !candidate
      || (candidate.role !== 'keeper' && candidate.role !== 'superseded')
      || typeof candidate.resolution_id !== 'string'
      || typeof candidate.keeper_id !== 'string'
    ) {
      return null;
    }
    return {
      resolution_id: candidate.resolution_id,
      resolution_type: 'manual_keep_one_supersede_others',
      role: candidate.role,
      keeper_id: candidate.keeper_id,
      duplicate_group_ids: Array.isArray(candidate.duplicate_group_ids) ? candidate.duplicate_group_ids.filter((id): id is string => typeof id === 'string') : [],
      superseded_ids: Array.isArray(candidate.superseded_ids) ? candidate.superseded_ids.filter((id): id is string => typeof id === 'string') : [],
      resolved_at: typeof candidate.resolved_at === 'string' ? candidate.resolved_at : memory.updated_at,
    } satisfies DuplicateResolutionMeta;
  })();

  const handleResolveDuplicate = async () => {
    if (!memory || !selectedDuplicateKeeperId) return;
    if (!confirm(t('memoryDetail.duplicateResolveConfirm'))) return;

    setResolvingDuplicate(true);
    try {
      const res = await resolveDuplicatePreference(memory.id, {
        keeper_id: selectedDuplicateKeeperId,
        memory_ids: sortedDuplicateCandidates.map((candidate) => candidate.id),
      });
      setShowDuplicateSuggestion(false);
      setToast({ message: t('memoryDetail.duplicateResolveSuccess'), type: 'success' });
      await loadMemoryData(res.keeper?.id || selectedDuplicateKeeperId);
      window.scrollTo(0, 0);
    } catch (e: any) {
      setToast({ message: t('memoryDetail.duplicateResolveFailed', { message: e.message }), type: 'error' });
    } finally {
      setResolvingDuplicate(false);
    }
  };

  const handleRollbackDuplicateResolution = async () => {
    if (!memory || !duplicateResolution || duplicateResolution.role !== 'keeper') return;
    if (!confirm(t('memoryDetail.duplicateRollbackConfirm'))) return;

    setRollingBackDuplicateResolution(true);
    try {
      await rollbackDuplicatePreferenceResolution(memory.id, {
        resolution_id: duplicateResolution.resolution_id,
      });
      setToast({ message: t('memoryDetail.duplicateRollbackSuccess'), type: 'success' });
      await loadMemoryData(memory.id);
    } catch (e: any) {
      setToast({ message: t('memoryDetail.duplicateResolveFailed', { message: e.message }), type: 'error' });
    } finally {
      setRollingBackDuplicateResolution(false);
    }
  };

  const handleResolveTimelineUpdate = async () => {
    if (!memory || !currentTimelineCandidateId || !historyTimelineCandidateId) return;
    if (!confirm(t('memoryDetail.timelineResolveConfirm'))) return;

    setResolvingTimelineUpdate(true);
    try {
      const res = await resolveTimelineUpdate(memory.id, {
        current_id: currentTimelineCandidateId,
        history_id: historyTimelineCandidateId,
      });
      setToast({ message: t('memoryDetail.timelineResolveSuccess'), type: 'success' });
      await loadMemoryData(res.current?.id || currentTimelineCandidateId);
      window.scrollTo(0, 0);
    } catch (e: any) {
      setToast({ message: t('memoryDetail.timelineResolveFailed', { message: e.message }), type: 'error' });
    } finally {
      setResolvingTimelineUpdate(false);
    }
  };

  const handleRollbackTimelineUpdate = async () => {
    if (!memory || !timelineResolution || timelineResolution.role !== 'current') return;
    if (!confirm(t('memoryDetail.timelineRollbackConfirm'))) return;

    setRollingBackTimelineUpdate(true);
    try {
      await rollbackTimelineUpdateResolution(memory.id, {
        resolution_id: timelineResolution.resolution_id,
      });
      setToast({ message: t('memoryDetail.timelineRollbackSuccess'), type: 'success' });
      await loadMemoryData(memory.id);
    } catch (e: any) {
      setToast({ message: t('memoryDetail.timelineResolveFailed', { message: e.message }), type: 'error' });
    } finally {
      setRollingBackTimelineUpdate(false);
    }
  };

  const getUserFacingAuditReason = () => {
    if (timelineResolution?.role === 'current') return t('memoryDetail.timelineReasonCurrentResolved');
    if (timelineResolution?.role === 'history') return t('memoryDetail.timelineReasonHistoryResolved');
    if (auditKind === 'timeline_update_candidate') {
      if (auditTimelineRole === 'current_candidate') return t('memoryDetail.timelineReasonCurrentCandidate');
      if (auditTimelineRole === 'history_candidate') return t('memoryDetail.timelineReasonHistoryCandidate');
    }
    if (auditFlag === 'possible_conflict') {
      return t('memoryDetail.conflictReasonNeedsReview');
    }
    return auditDecisionReason;
  };

  const userFacingAuditReason = getUserFacingAuditReason();
  const primaryConflictPeer = conflictPeers[0] || null;

  const openDuplicateSuggestion = () => {
    setSelectedDuplicateKeeperId(recommendedDuplicateKeeper?.id || memory.id);
    setShowDuplicateSuggestion(true);
  };

  const handleResolveConflictReview = async (winnerId: string, supersededId: string) => {
    if (!memory) return;
    if (!confirm(t('memoryDetail.conflictResolveConfirm'))) return;

    setResolvingConflictReview(true);
    try {
      const res = await resolveConflictReview(memory.id, {
        winner_id: winnerId,
        superseded_id: supersededId,
      });
      setToast({ message: t('memoryDetail.conflictResolveSuccess'), type: 'success' });
      await loadMemoryData(res.winner?.id || winnerId);
      window.scrollTo(0, 0);
    } catch (e: any) {
      setToast({ message: t('memoryDetail.conflictResolveFailed', { message: e.message }), type: 'error' });
    } finally {
      setResolvingConflictReview(false);
    }
  };

  const handleRollbackConflictReview = async () => {
    if (!memory || !conflictResolution || conflictResolution.role !== 'winner') return;
    if (!confirm(t('memoryDetail.conflictRollbackConfirm'))) return;

    setRollingBackConflictReview(true);
    try {
      await rollbackConflictReviewResolution(memory.id, {
        resolution_id: conflictResolution.resolution_id,
      });
      setToast({ message: t('memoryDetail.conflictRollbackSuccess'), type: 'success' });
      await loadMemoryData(memory.id);
    } catch (e: any) {
      setToast({ message: t('memoryDetail.conflictResolveFailed', { message: e.message }), type: 'error' });
    } finally {
      setRollingBackConflictReview(false);
    }
  };

  return (
    <div>
      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: 24, right: 24, zIndex: 200,
          padding: '12px 20px', borderRadius: 'var(--radius-md)',
          background: toast.type === 'success' ? 'var(--color-success)' : 'var(--color-danger)',
          color: '#fff', fontSize: 14, fontWeight: 500, boxShadow: 'var(--shadow-lg)',
        }}>
          {toast.message}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <button className="btn" onClick={onBack}>{t('common.back')}</button>
        <div style={{ display: 'flex', gap: 8 }}>
          {!isLatest && latestInChain && (
            <button className="btn" style={{ background: 'var(--color-success)', color: '#fff' }}
              onClick={() => { loadMemoryData(latestInChain.id); window.scrollTo(0, 0); }}>
              {t('memoryDetail.latestVersion')}
            </button>
          )}
          {!editing && <button className="btn primary" onClick={() => setEditing(true)}>{t('common.edit')}</button>}
        </div>
      </div>
      <h1 className="page-title">{t('memoryDetail.title')}</h1>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <span className={`badge ${memory.layer}`}>{memory.layer}</span>
          <span className="badge">{CATEGORY_LABELS[memory.category] || memory.category}</span>
          {memory.is_pinned ? <span className="badge" style={{ background: 'var(--color-warning-muted)', color: 'var(--color-warning)' }}>{t('memoryDetail.pinned')}</span> : null}
          {auditFlag === 'duplicate_preference' ? (
            <span className="badge" style={{ background: 'rgba(249,115,22,0.18)', color: '#c2410c' }}>{t('memoryDetail.duplicatePreference')}</span>
          ) : timelineResolution?.role === 'current' ? (
            <span className="badge" style={{ background: 'rgba(14,165,233,0.16)', color: '#0369a1' }}>
              {t('memoryDetail.timelineCurrentConfirmed')}
            </span>
          ) : timelineResolution?.role === 'history' ? (
            <span className="badge" style={{ background: 'rgba(148,163,184,0.18)', color: '#475569' }}>
              {t('memoryDetail.timelineHistoryResolved')}
            </span>
          ) : conflictResolution?.role === 'winner' ? (
            <span className="badge" style={{ background: 'rgba(244,114,182,0.18)', color: '#be185d' }}>
              {t('memoryDetail.conflictWinnerConfirmed')}
            </span>
          ) : conflictResolution?.role === 'superseded' ? (
            <span className="badge" style={{ background: 'rgba(148,163,184,0.18)', color: '#475569' }}>
              {t('memoryDetail.conflictSuperseded')}
            </span>
          ) : auditFlag === 'possible_conflict' && auditKind === 'timeline_update_candidate' ? (
            <span className="badge" style={{ background: 'rgba(14,165,233,0.16)', color: '#0369a1' }}>
              {auditTimelineRole === 'current_candidate'
                ? t('memoryDetail.timelineCurrentCandidate')
                : t('memoryDetail.timelineHistoryCandidate')}
            </span>
          ) : auditFlag === 'possible_conflict' ? (
            <span className="badge" style={{ background: 'rgba(244,114,182,0.18)', color: '#db2777' }}>
              {conflictResolution?.role === 'winner'
                ? t('memoryDetail.conflictWinnerConfirmed')
                : conflictResolution?.role === 'superseded'
                  ? t('memoryDetail.conflictSuperseded')
                  : t('memoryDetail.conflictNeedsReview')}
            </span>
          ) : null}
        </div>

        {editing ? (
          <>
            <div className="form-group">
              <label>{t('memoryDetail.category')}</label>
              <select value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value })}>
                {CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c] || c}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>{t('memoryDetail.content')}</label>
              <textarea rows={5} value={draft.content} onChange={e => setDraft({ ...draft, content: e.target.value })} />
            </div>
            <div className="form-group">
              <label>{t('memoryDetail.importance')} ({draft.importance.toFixed(2)})</label>
              <input type="range" min="0" max="1" step="0.05" value={draft.importance}
                onChange={e => setDraft({ ...draft, importance: parseFloat(e.target.value) })} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <label style={{ fontWeight: 500 }}>{t('memoryDetail.pinLabel')}</label>
              <div
                onClick={() => setDraft({ ...draft, is_pinned: !draft.is_pinned })}
                style={{
                  width: 40, height: 22, borderRadius: 11,
                  background: draft.is_pinned ? 'var(--color-primary)' : 'var(--color-border)',
                  position: 'relative', cursor: 'pointer', transition: 'background 0.2s',
                }}
              >
                <div style={{
                  width: 18, height: 18, borderRadius: '50%',
                  background: '#fff', position: 'absolute', top: 2,
                  left: draft.is_pinned ? 20 : 2, transition: 'left 0.2s',
                }} />
              </div>
              <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{t('memoryDetail.pinDesc')}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => { setEditing(false); setDraft({ content: memory.content, category: memory.category, importance: memory.importance, is_pinned: !!memory.is_pinned }); }}>{t('common.cancel')}</button>
              <button className="btn primary" onClick={handleSave}>{t('common.save')}</button>
            </div>
          </>
        ) : (
          <div style={{ marginBottom: 12 }}>
            <strong>{t('memoryDetail.contentLabel')}</strong>
            <div style={{ background: 'var(--color-base)', padding: 12, borderRadius: 8, marginTop: 4, whiteSpace: 'pre-wrap' }}>
              {memory.content}
            </div>
          </div>
        )}

        <table style={{ fontSize: 13 }}>
          <tbody>
            <tr><td style={{ color: 'var(--color-text-secondary)', paddingRight: 16 }}>{t('memoryDetail.id')}</td><td style={{ fontFamily: 'monospace', fontSize: 11 }}>{memory.id}</td></tr>
            <tr><td style={{ color: 'var(--color-text-secondary)' }}>{t('memoryDetail.importance')}</td><td>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {memory.importance?.toFixed(2)}
                <div style={{ flex: 1, maxWidth: 120, height: 6, background: 'var(--color-border)', borderRadius: 3 }}>
                  <div style={{ width: `${memory.importance * 100}%`, height: '100%', background: 'var(--color-primary)', borderRadius: 3 }} />
                </div>
              </div>
            </td></tr>
            <tr><td style={{ color: 'var(--color-text-secondary)' }}>{t('memoryDetail.confidence')}</td><td>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {memory.confidence?.toFixed(2)}
                <div style={{ flex: 1, maxWidth: 120, height: 6, background: 'var(--color-border)', borderRadius: 3 }}>
                  <div style={{ width: `${memory.confidence * 100}%`, height: '100%', background: 'var(--color-success)', borderRadius: 3 }} />
                </div>
              </div>
            </td></tr>
            <tr><td style={{ color: 'var(--color-text-secondary)' }}>{t('memoryDetail.decayScore')}</td><td>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {memory.decay_score?.toFixed(3)}
                <div style={{ flex: 1, maxWidth: 120, height: 6, background: 'var(--color-border)', borderRadius: 3 }}>
                  <div style={{ width: `${memory.decay_score * 100}%`, height: '100%', background: 'var(--color-warning)', borderRadius: 3 }} />
                </div>
              </div>
            </td></tr>
            <tr><td style={{ color: 'var(--color-text-secondary)' }}>{t('memoryDetail.accessCount')}</td><td>{memory.access_count}</td></tr>
            <tr><td style={{ color: 'var(--color-text-secondary)' }}>{t('memoryDetail.created')}</td><td>{toLocal(memory.created_at)}</td></tr>
            <tr><td style={{ color: 'var(--color-text-secondary)' }}>{t('memoryDetail.updated')}</td><td>{toLocal(memory.updated_at)}</td></tr>
            {memory.agent_id && <tr><td style={{ color: 'var(--color-text-secondary)' }}>{t('memoryDetail.agent')}</td><td>{memory.agent_id}</td></tr>}
            {memory.source && <tr><td style={{ color: 'var(--color-text-secondary)' }}>{t('memoryDetail.source')}</td><td>{memory.source}</td></tr>}
            {(sourceMemoryIds.length > 0 || memory.source === 'lifecycle:preference-extraction') && (
              <tr>
                <td style={{ color: 'var(--color-text-secondary)', verticalAlign: 'top' }}>{t('memoryDetail.sourceMemories')}</td>
                <td>
                  {sourceMemoryIds.length === 0 ? (
                    <span style={{ color: 'var(--color-text-secondary)' }}>{t('memoryDetail.sourceMemoryNone')}</span>
                  ) : (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {sourceMemoryIds.map((id: string) => (
                        <button
                          key={id}
                          className="btn"
                          style={{ fontSize: 11, padding: '2px 8px' }}
                          onClick={() => { loadMemoryData(id); window.scrollTo(0, 0); }}
                        >
                          {id}
                        </button>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            )}
            {(auditFlag === 'duplicate_preference' || duplicateResolution) && (
              <tr>
                <td style={{ color: 'var(--color-text-secondary)', verticalAlign: 'top' }}>{t('memoryDetail.duplicatePreference')}</td>
                <td>
                  {duplicateResolution?.role === 'keeper' ? (
                    <>
                      <div style={{ marginBottom: 8 }}>
                        {t('memoryDetail.duplicateResolutionKeeperDesc', {
                          count: duplicateResolution.superseded_ids.length,
                          resolvedAt: toLocal(duplicateResolution.resolved_at),
                        })}
                      </div>
                      {duplicateResolution.superseded_ids.length > 0 ? (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                          {duplicateResolution.superseded_ids.map((id: string) => (
                            <button
                              key={id}
                              className="btn"
                              style={{ fontSize: 11, padding: '2px 8px' }}
                              onClick={() => { loadMemoryData(id); window.scrollTo(0, 0); }}
                            >
                              {id}
                            </button>
                          ))}
                        </div>
                      ) : null}
                      <button
                        className="btn"
                        style={{ fontSize: 12 }}
                        disabled={rollingBackDuplicateResolution}
                        onClick={handleRollbackDuplicateResolution}
                      >
                        {rollingBackDuplicateResolution
                          ? (t('common.loading') || 'Loading...')
                          : t('memoryDetail.duplicateRollbackButton')}
                      </button>
                    </>
                  ) : duplicateResolution?.role === 'superseded' ? (
                    <>
                      <div style={{ marginBottom: 8 }}>
                        {t('memoryDetail.duplicateResolutionSupersededDesc', {
                          keeperId: duplicateResolution.keeper_id,
                          resolvedAt: toLocal(duplicateResolution.resolved_at),
                        })}
                      </div>
                      <button
                        className="btn"
                        style={{ fontSize: 12 }}
                        onClick={() => { loadMemoryData(duplicateResolution.keeper_id); window.scrollTo(0, 0); }}
                      >
                        {t('memoryDetail.duplicateResolutionViewKeeper')}
                      </button>
                    </>
                  ) : (
                    <>
                      <div style={{ marginBottom: duplicatePreferenceIds.length > 0 ? 6 : 0 }}>{t('memoryDetail.duplicatePreferenceDesc')}</div>
                      <button
                        className="btn"
                        style={{ fontSize: 12, marginBottom: 8 }}
                        onClick={openDuplicateSuggestion}
                      >
                        {t('memoryDetail.duplicateSuggestionButton')}
                      </button>
                      {duplicatePreferenceIds.length > 0 ? (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {duplicatePreferenceIds.map((id: string) => (
                            <button
                              key={id}
                              className="btn"
                              style={{ fontSize: 11, padding: '2px 8px' }}
                              onClick={() => { loadMemoryData(id); window.scrollTo(0, 0); }}
                            >
                              {id}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </>
                  )}
                </td>
              </tr>
            )}
            {(auditFlag === 'possible_conflict' || timelineResolution || conflictResolution) && (
              <tr>
                <td style={{ color: 'var(--color-text-secondary)', verticalAlign: 'top' }}>
                  {timelineResolution
                    ? t('memoryDetail.timelineUpdateCandidate')
                    : conflictResolution
                    ? t('memoryDetail.conflictNeedsReview')
                    : auditKind === 'timeline_update_candidate'
                    ? t('memoryDetail.timelineUpdateCandidate')
                    : t('memoryDetail.conflictNeedsReview')}
                </td>
                <td>
                  {timelineResolution?.role === 'current' ? (
                    <>
                      <div style={{ marginBottom: 8 }}>
                        {t('memoryDetail.timelineCurrentResolvedDesc', {
                          historyId: timelineResolution.history_id,
                          resolvedAt: toLocal(timelineResolution.resolved_at),
                        })}
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                        <button
                          className="btn"
                          style={{ fontSize: 11, padding: '2px 8px' }}
                          onClick={() => { loadMemoryData(timelineResolution.history_id); window.scrollTo(0, 0); }}
                        >
                          {t('memoryDetail.timelineViewHistory')}
                        </button>
                      </div>
                      <button
                        className="btn"
                        style={{ fontSize: 12 }}
                        disabled={rollingBackTimelineUpdate}
                        onClick={handleRollbackTimelineUpdate}
                      >
                        {rollingBackTimelineUpdate
                          ? (t('common.loading') || 'Loading...')
                          : t('memoryDetail.timelineRollbackButton')}
                      </button>
                    </>
                  ) : timelineResolution?.role === 'history' ? (
                    <>
                      <div style={{ marginBottom: 8 }}>
                        {t('memoryDetail.timelineHistoryResolvedDesc', {
                          currentId: timelineResolution.current_id,
                          resolvedAt: toLocal(timelineResolution.resolved_at),
                        })}
                      </div>
                      <button
                        className="btn"
                        style={{ fontSize: 12 }}
                        onClick={() => { loadMemoryData(timelineResolution.current_id); window.scrollTo(0, 0); }}
                      >
                        {t('memoryDetail.timelineViewCurrent')}
                      </button>
                    </>
                  ) : auditKind === 'timeline_update_candidate' ? (
                    <>
                      <div style={{ marginBottom: 8 }}>
                        {auditTimelineRole === 'current_candidate'
                          ? t('memoryDetail.timelineCurrentDesc')
                          : t('memoryDetail.timelineHistoryDesc')}
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: auditDecisionReason ? 8 : 0 }}>
                        {currentTimelineCandidateId ? (
                          <button
                            className="btn"
                            style={{ fontSize: 11, padding: '2px 8px' }}
                            onClick={() => { loadMemoryData(currentTimelineCandidateId); window.scrollTo(0, 0); }}
                          >
                            {t('memoryDetail.timelineViewCurrent')}
                          </button>
                        ) : null}
                        {historyTimelineCandidateId ? (
                          <button
                            className="btn"
                            style={{ fontSize: 11, padding: '2px 8px' }}
                            onClick={() => { loadMemoryData(historyTimelineCandidateId); window.scrollTo(0, 0); }}
                          >
                            {t('memoryDetail.timelineViewHistory')}
                          </button>
                        ) : null}
                      </div>
                      {auditTimelineRole === 'current_candidate' ? (
                        <button
                          className="btn primary"
                          style={{ fontSize: 12, marginBottom: auditDecisionReason ? 8 : 0 }}
                          disabled={resolvingTimelineUpdate}
                          onClick={handleResolveTimelineUpdate}
                        >
                          {resolvingTimelineUpdate
                            ? (t('common.loading') || 'Loading...')
                            : t('memoryDetail.timelineResolveButton')}
                        </button>
                      ) : null}
                    </>
                  ) : (
                    <>
                      {conflictResolution?.role === 'winner' ? (
                        <>
                          <div style={{ marginBottom: 8 }}>
                            {t('memoryDetail.conflictWinnerResolvedDesc', {
                              supersededId: conflictResolution.superseded_id,
                              resolvedAt: toLocal(conflictResolution.resolved_at),
                            })}
                          </div>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                            <button
                              className="btn"
                              style={{ fontSize: 11, padding: '2px 8px' }}
                              onClick={() => { loadMemoryData(conflictResolution.superseded_id); window.scrollTo(0, 0); }}
                            >
                              {t('memoryDetail.conflictViewSuperseded')}
                            </button>
                          </div>
                          <button
                            className="btn"
                            style={{ fontSize: 12 }}
                            disabled={rollingBackConflictReview}
                            onClick={handleRollbackConflictReview}
                          >
                            {rollingBackConflictReview
                              ? (t('common.loading') || 'Loading...')
                              : t('memoryDetail.conflictRollbackButton')}
                          </button>
                        </>
                      ) : conflictResolution?.role === 'superseded' ? (
                        <>
                          <div style={{ marginBottom: 8 }}>
                            {t('memoryDetail.conflictSupersededDesc', {
                              winnerId: conflictResolution.winner_id,
                              resolvedAt: toLocal(conflictResolution.resolved_at),
                            })}
                          </div>
                          <button
                            className="btn"
                            style={{ fontSize: 12 }}
                            onClick={() => { loadMemoryData(conflictResolution.winner_id); window.scrollTo(0, 0); }}
                          >
                            {t('memoryDetail.conflictViewWinner')}
                          </button>
                        </>
                      ) : (
                        <>
                          <div style={{ marginBottom: 8 }}>
                            {t('memoryDetail.conflictNeedsReviewDesc')}
                          </div>
                          <div style={{
                            marginBottom: 8,
                            padding: 12,
                            borderRadius: 'var(--radius-md)',
                            background: 'var(--color-info-muted)',
                            border: '1px solid var(--color-info-border)',
                            fontSize: 13,
                          }}>
                            {t('memoryDetail.conflictResolveEffect')}
                          </div>
                          {loadingConflictPeers ? (
                            <div className="empty">{t('common.loading')}</div>
                          ) : primaryConflictPeer ? (
                            <>
                              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                                <button
                                  className="btn"
                                  style={{ fontSize: 11, padding: '2px 8px' }}
                                  onClick={() => { loadMemoryData(primaryConflictPeer.id); window.scrollTo(0, 0); }}
                                >
                                  {t('memoryDetail.conflictViewOther')}
                                </button>
                              </div>
                              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                <button
                                  className="btn primary"
                                  style={{ fontSize: 12 }}
                                  disabled={resolvingConflictReview}
                                  onClick={() => handleResolveConflictReview(memory.id, primaryConflictPeer.id)}
                                >
                                  {resolvingConflictReview
                                    ? (t('common.loading') || 'Loading...')
                                    : t('memoryDetail.conflictKeepCurrentButton')}
                                </button>
                                <button
                                  className="btn"
                                  style={{ fontSize: 12 }}
                                  disabled={resolvingConflictReview}
                                  onClick={() => handleResolveConflictReview(primaryConflictPeer.id, memory.id)}
                                >
                                  {t('memoryDetail.conflictKeepOtherButton')}
                                </button>
                              </div>
                            </>
                          ) : conflictIds.length > 0 ? (
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              {conflictIds.map((id: string) => (
                                <button
                                  key={id}
                                  className="btn"
                                  style={{ fontSize: 11, padding: '2px 8px' }}
                                  onClick={() => { loadMemoryData(id); window.scrollTo(0, 0); }}
                                >
                                  {id}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </>
                      )}
                    </>
                  )}
                  {userFacingAuditReason ? (
                    <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                      {t('memoryDetail.timelineReason')}: {userFacingAuditReason}
                    </div>
                  ) : null}
                </td>
              </tr>
            )}
            {memory.metadata && (
              <tr><td style={{ color: 'var(--color-text-secondary)' }}>{t('memoryDetail.metadata')}</td><td><pre style={{ fontSize: 11, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxWidth: '100%' }}>{JSON.stringify(JSON.parse(memory.metadata), null, 2)}</pre></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Decay Curve */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 12 }}>{t('memoryDetail.decayCurve')}</h3>
        <div style={{ position: 'relative', height: 120, background: 'var(--color-base)', borderRadius: 'var(--radius-md)', padding: '10px 10px 24px 36px' }}>
          {/* Y axis labels */}
          <div style={{ position: 'absolute', left: 4, top: 8, fontSize: 10, color: 'var(--color-text-secondary)' }}>1.0</div>
          <div style={{ position: 'absolute', left: 4, bottom: 24, fontSize: 10, color: 'var(--color-text-secondary)' }}>0.0</div>
          {/* Curve via SVG */}
          <svg width="100%" height="100%" viewBox="0 0 400 80" preserveAspectRatio="none" style={{ overflow: 'visible' }}>
            {/* Grid */}
            <line x1="0" y1="0" x2="400" y2="0" stroke="rgba(255,255,255,0.05)" />
            <line x1="0" y1="40" x2="400" y2="40" stroke="rgba(255,255,255,0.05)" />
            <line x1="0" y1="80" x2="400" y2="80" stroke="rgba(255,255,255,0.05)" />
            {/* Decay curve */}
            <polyline
              fill="none"
              stroke="var(--color-warning)"
              strokeWidth="2"
              points={decayCurve.map(p => `${(p.day / 60) * 400},${(1 - p.score) * 80}`).join(' ')}
            />
            {/* Current position marker */}
            {(() => {
              const currentScore = memory.decay_score ?? 1;
              const dayEstimate = currentScore > 0 ? -Math.log(currentScore) / lambda : 60;
              const cx = Math.min((dayEstimate / 60) * 400, 400);
              const cy = (1 - currentScore) * 80;
              return <circle cx={cx} cy={cy} r="4" fill="var(--color-warning)" stroke="#fff" strokeWidth="1.5" />;
            })()}
          </svg>
          <div style={{ position: 'absolute', left: 36, bottom: 4, fontSize: 10, color: 'var(--color-text-secondary)' }}>0d</div>
          <div style={{ position: 'absolute', right: 10, bottom: 4, fontSize: 10, color: 'var(--color-text-secondary)' }}>60d</div>
        </div>
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 6 }}>
          {t('memoryDetail.currentDecay', { score: memory.decay_score?.toFixed(3), days: memory.decay_score > 0 ? Math.round(-Math.log(memory.decay_score) / lambda) : '60+' })}
        </p>
      </div>

      {/* Similar Memories */}
      {(loadingContext || similar.length > 0) && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 12 }}>{t('memoryDetail.relatedMemories')}</h3>
          {loadingContext && similar.length === 0 ? (
            <div className="empty">{t('common.loading')}</div>
          ) : similar.map((s: any) => (
            <div
              key={s.id}
              className="memory-card"
              style={{ cursor: 'pointer' }}
              onClick={() => { loadMemoryData(s.id); window.scrollTo(0, 0); }}
            >
              <div className="header">
                <span className={`badge ${s.layer}`}>{s.layer}</span>
                <span className="badge" style={{ background: 'var(--color-info-muted)', color: 'var(--color-info)' }}>{s.category}</span>
                {s.finalScore && (
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-text-secondary)' }}>
                    {t('memoryDetail.similarity')}: {(s.finalScore * 100).toFixed(1)}%
                  </span>
                )}
              </div>
              <div className="content" style={{ fontSize: 13 }}>{s.content?.slice(0, 200)}{s.content?.length > 200 ? '...' : ''}</div>
            </div>
          ))}
        </div>
      )}

      {/* Revision Chain */}
      {chain.length > 1 && (
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('memoryDetail.revisionChain', { count: chain.length })}</h3>
          <div style={{ position: 'relative' }}>
            {chain.map((m, i) => {
              const isCurrent = m.id === memory.id;
              const isLatestVersion = i === chain.length - 1;
              const meta = parseMeta(m);
              const updateType = meta?.smart_update_type as string | undefined;
              const updateReasoning = meta?.update_reasoning as string | undefined;

              // Determine highlight color
              let borderColor = 'var(--color-border)';
              let bgColor = 'var(--color-base)';
              if (isCurrent) { borderColor = 'var(--color-primary)'; bgColor = 'var(--color-primary-muted)'; }
              else if (isLatestVersion) { borderColor = 'var(--color-success)'; bgColor = 'var(--color-success-muted)'; }

              return (
                <div key={m.id} style={{ display: 'flex', marginBottom: 16, cursor: isCurrent ? 'default' : 'pointer' }}
                  onClick={() => { if (!isCurrent) { loadMemoryData(m.id); window.scrollTo(0, 0); } }}>
                  <div style={{ width: 40, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div style={{
                      width: 16, height: 16, borderRadius: '50%',
                      background: isCurrent ? 'var(--color-primary)' : isLatestVersion ? 'var(--color-success)' : 'var(--color-border)',
                      border: `2px solid ${isCurrent ? 'var(--color-primary)' : isLatestVersion ? 'var(--color-success)' : 'var(--color-border)'}`,
                      zIndex: 1,
                    }} />
                    {i < chain.length - 1 && <div style={{ width: 2, flex: 1, background: 'var(--color-border)' }} />}
                  </div>
                  <div style={{
                    flex: 1, padding: 12, borderRadius: 8,
                    background: bgColor,
                    border: `1px solid ${borderColor}`,
                  }}>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 6, fontSize: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span className={`badge ${m.layer}`}>{m.layer}</span>
                      {isCurrent && <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>{t('memoryDetail.current')}</span>}
                      {isLatestVersion && !isCurrent && <span style={{ color: 'var(--color-success)', fontWeight: 600 }}>{t('memoryDetail.latestVersion')}</span>}
                      {!isLatestVersion && !isCurrent && <span style={{ color: 'var(--color-text-secondary)' }}>{t('memoryDetail.superseded')}</span>}
                      {/* Smart update type badge */}
                      {updateType === 'merge' && (
                        <span style={{ background: 'var(--color-success-muted)', color: 'var(--color-success)', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
                          {t('memoryDetail.merged')}
                        </span>
                      )}
                      {updateType === 'replace' && (
                        <span style={{ background: 'var(--color-warning-muted)', color: 'var(--color-warning)', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
                          {t('memoryDetail.replaced')}
                        </span>
                      )}
                      <span style={{ color: 'var(--color-text-secondary)', marginLeft: 'auto' }}>{toLocal(m.created_at)}</span>
                    </div>
                    <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{m.content}</div>
                    {updateReasoning && (
                      <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 6, fontStyle: 'italic' }}>
                        {t('memoryDetail.updateReason')}: {updateReasoning}
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 4, fontFamily: 'monospace', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>{m.id}</span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {i > 0 && (
                          <button className="btn" style={{ fontSize: 10, padding: '2px 8px' }}
                            onClick={(e) => { e.stopPropagation(); setDiffPair([chain[i - 1]!, m]); }}>
                            {t('memoryDetail.diff')}
                          </button>
                        )}
                        {!isLatestVersion && (
                          <button className="btn" style={{ fontSize: 10, padding: '2px 8px', background: 'var(--color-warning-muted)', color: 'var(--color-warning)' }}
                            onClick={(e) => { e.stopPropagation(); handleRollback(m.id); }}>
                            {t('memoryDetail.rollback')}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Diff Modal */}
      {diffPair && (
        <div className="modal-overlay" onClick={() => setDiffPair(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 700, maxHeight: '80vh', overflow: 'auto' }}>
            <h3 style={{ marginBottom: 12 }}>{t('memoryDetail.diffTitle')}</h3>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, fontSize: 12, color: 'var(--color-text-secondary)' }}>
              <span>v{chain.indexOf(diffPair[0]) + 1} → v{chain.indexOf(diffPair[1]) + 1}</span>
            </div>
            <div style={{ background: 'var(--color-base)', padding: 12, borderRadius: 8, fontSize: 13, lineHeight: 1.8, whiteSpace: 'pre-wrap' }}>
              {computeDiff(diffPair[0].content, diffPair[1].content).map((part, i) => (
                <span key={i} style={{
                  background: part.type === 'add' ? 'var(--color-success-muted)' : part.type === 'remove' ? 'var(--color-danger-muted)' : 'transparent',
                  textDecoration: part.type === 'remove' ? 'line-through' : 'none',
                  color: part.type === 'add' ? 'var(--color-success)' : part.type === 'remove' ? '#f87171' : 'var(--color-text-primary)',
                }}>{part.text}</span>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="btn" onClick={() => setDiffPair(null)}>{t('common.close')}</button>
            </div>
          </div>
        </div>
      )}

      {showDuplicateSuggestion && (
        <div className="modal-overlay" onClick={() => setShowDuplicateSuggestion(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 760, maxHeight: '80vh', overflow: 'auto' }}>
            <h3 style={{ marginBottom: 12 }}>{t('memoryDetail.duplicateSuggestionTitle')}</h3>
            <div style={{ marginBottom: 12, color: 'var(--color-text-secondary)', fontSize: 13 }}>
              {t('memoryDetail.duplicateSuggestionDesc')}
            </div>
            {selectedDuplicateKeeper && (
              <div style={{
                marginBottom: 12,
                padding: 12,
                borderRadius: 'var(--radius-md)',
                background: 'var(--color-info-muted)',
                border: '1px solid var(--color-info-border)',
                fontSize: 13,
              }}>
                {t('memoryDetail.duplicateResolveEffect', {
                  keeperId: selectedDuplicateKeeper.id,
                  count: selectedDuplicateSupersededCount,
                })}
              </div>
            )}
            {recommendedDuplicateKeeper && (
              <div style={{
                marginBottom: 12,
                padding: 12,
                borderRadius: 'var(--radius-md)',
                background: 'var(--color-success-muted)',
                border: '1px solid var(--color-success-border)',
              }}>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 4 }}>{t('memoryDetail.duplicateSuggestionRecommended')}</div>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>{recommendedDuplicateKeeper.id}</div>
                <div style={{ fontSize: 13, marginBottom: 6, whiteSpace: 'pre-wrap' }}>{recommendedDuplicateKeeper.content}</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{duplicateSuggestionReason}</div>
              </div>
            )}
            {loadingDuplicatePeers ? (
              <div className="empty">{t('common.loading')}</div>
            ) : (
              <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                <table style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>{t('memoryDetail.duplicateSuggestionRecommended')}</th>
                      <th>{t('memoryDetail.id')}</th>
                      <th>{t('memoryDetail.content')}</th>
                      <th>{t('memoryDetail.confidence')}</th>
                      <th>{t('memoryDetail.sourceMemories')}</th>
                      <th>{t('memoryDetail.updated')}</th>
                      <th>{t('memoryDetail.duplicateRecommendation')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedDuplicateCandidates.map((candidate) => (
                      <tr
                        key={candidate.id}
                        onClick={() => setSelectedDuplicateKeeperId(candidate.id)}
                        style={{
                          cursor: 'pointer',
                          background: selectedDuplicateKeeperId === candidate.id ? 'var(--color-primary-muted)' : undefined,
                        }}
                      >
                        <td>
                          <input
                            type="radio"
                            name="duplicate-keeper"
                            checked={selectedDuplicateKeeperId === candidate.id}
                            onChange={() => setSelectedDuplicateKeeperId(candidate.id)}
                            style={{ width: 'auto' }}
                          />
                        </td>
                        <td style={{ whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: 11 }}>{candidate.id}</td>
                        <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{candidate.content}</td>
                        <td>{(candidate.confidence ?? 0).toFixed(2)}</td>
                        <td>{getSourceCount(candidate)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{toLocal(candidate.updated_at)}</td>
                        <td>
                          {recommendedDuplicateKeeper?.id === candidate.id
                            ? (t('memoryDetail.duplicateRecommendationKeep') || '建议保留')
                            : (t('memoryDetail.duplicateRecommendationSupersede') || '建议并入')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12, gap: 8 }}>
              <button
                className="btn primary"
                disabled={!selectedDuplicateKeeperId || resolvingDuplicate || sortedDuplicateCandidates.length < 2}
                onClick={handleResolveDuplicate}
              >
                {resolvingDuplicate
                  ? (t('common.loading') || 'Loading...')
                  : t('memoryDetail.duplicateResolveButton')}
              </button>
              <button className="btn" onClick={() => setShowDuplicateSuggestion(false)}>{t('common.close')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
