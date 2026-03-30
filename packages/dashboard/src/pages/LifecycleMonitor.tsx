import React, { useEffect, useState, useRef } from 'react';
import { getLifecycleLogs, runLifecycle, previewLifecycle, getConfig, getLifecycleStats, listAgents } from '../api/client.js';
import { useI18n } from '../i18n/index.js';
import { toLocal } from '../utils/time.js';

/** Live elapsed timer shown during preview/run */
function ElapsedTimer() {
  const [elapsed, setElapsed] = useState(0);
  const start = useRef(Date.now());
  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - start.current), 100);
    return () => clearInterval(id);
  }, []);
  const secs = (elapsed / 1000).toFixed(1);
  return (
    <div style={{
      padding: '8px 16px', marginTop: 8, borderRadius: 'var(--radius-sm)',
      background: 'var(--color-primary-muted)',
      display: 'inline-flex', alignItems: 'center', gap: 8,
      fontSize: 13, color: 'var(--color-text-secondary)', animation: 'pulse 1.5s ease-in-out infinite',
    }}>
      <span className="spinner" /> 运行中... {secs}s
    </div>
  );
}

interface PreviewDetail {
  promoted: number;
  merged: number;
  archived: number;
  compressedToCore: number;
  expiredWorking: number;
}

export default function LifecycleMonitor() {
  const [logs, setLogs] = useState<any[]>([]);
  const [logTotal, setLogTotal] = useState(0);
  const [logPage, setLogPage] = useState(0);
  const logLimit = 20;
  const [preview, setPreview] = useState<PreviewDetail | null>(null);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<any>(null);
  const [config, setConfig] = useState<any>(null);
  const [layerStats, setLayerStats] = useState<{ working: number; core: number; archive: number }>({ working: 0, core: 0, archive: 0 });
  const [lifecycleStats, setLifecycleStats] = useState<any>(null);
  const [affectedMemories, setAffectedMemories] = useState<any[]>([]);
  const [showAffected, setShowAffected] = useState(false);
  const [agents, setAgents] = useState<any[]>([]);
  const [agentId, setAgentId] = useState('');
  const { t } = useI18n();

  useEffect(() => {
    getConfig().then(setConfig).catch(() => {});
    listAgents().then((res: any) => setAgents(res.agents || res || [])).catch(() => {});
  }, []);

  // Reload logs + layer stats when agent changes
  const refreshData = () => {
    getLifecycleLogs(logLimit, agentId || undefined, logPage * logLimit).then((res: any) => {
      setLogs(res.items || res);
      setLogTotal(res.total || 0);
    });
    getLifecycleStats(agentId || undefined).then((stats: any) => {
      setLifecycleStats(stats);
      setLayerStats(stats.layerCounts || { working: 0, core: 0, archive: 0 });
    }).catch(() => {});
  };

  useEffect(() => {
    refreshData();
  }, [agentId, logPage]);

  const [previewing, setPreviewing] = useState(false);

  const handlePreview = async () => {
    setPreviewing(true);
    try {
      const result = await previewLifecycle(agentId || undefined);
      setPreview(result);
      setAffectedMemories(result.affectedMemories || []);
    } catch (e: any) {
      alert(e.message);
    }
    setPreviewing(false);
  };

  const handleRun = async () => {
    if (!confirm(t('lifecycle.confirmRun'))) return;
    setRunning(true);
    try {
      const result = await runLifecycle(false, agentId || undefined);
      setRunResult(result);
      refreshData();
    } catch (e: any) {
      alert(e.message);
    }
    setRunning(false);
  };

  // Parse cron for human-readable schedule
  const parseCron = (cron: string) => {
    if (!cron) return t('lifecycle.cronNotConfigured');
    const parts = cron.split(' ');
    if (parts.length !== 5) return cron;
    const [min, hour, dom, mon, dow] = parts;
    const dayMap: Record<string, string> = { '0': 'Sun', '1': 'Mon', '2': 'Tue', '3': 'Wed', '4': 'Thu', '5': 'Fri', '6': 'Sat' };

    let desc = '';
    if (min === '0' && hour !== '*' && dom === '*' && mon === '*' && dow === '*') {
      desc = t('lifecycle.cronDailyAt', { time: `${hour!.padStart(2, '0')}:00` });
    } else if (min !== '*' && hour !== '*' && dom === '*' && mon === '*' && dow !== '*') {
      const days = dow!.split(',').map(d => dayMap[d] || d).join(', ');
      desc = `${days} at ${hour!.padStart(2, '0')}:${min!.padStart(2, '0')}`;
    } else if (min === '*' && hour === '*') {
      desc = t('lifecycle.cronEveryMinute');
    } else {
      desc = cron;
    }
    return desc;
  };

  // Lifecycle action history stats
  const actionCounts: Record<string, number> = {};
  logs.forEach(l => {
    const action = l.action || 'unknown';
    actionCounts[action] = (actionCounts[action] || 0) + 1;
  });

  // ─── Display helpers ─────────────────────────────────────────────────────
  const actionLabel = (action: string) => {
    const map: Record<string, string> = {
      'lifecycle_run': t('lifecycle.runLabel') || '🔄 运行',
      'promote': t('lifecycle.promoteLabel') || '⬆️ 升级',
      'expire_working': t('lifecycle.expireLabel') || '🗑️ 过期清理',
      'archive': t('lifecycle.archiveLabel') || '📦 归档',
      'merge': t('lifecycle.mergeLabel') || '🔗 合并',
      'compress': t('lifecycle.compressLabel') || '📐 压缩',
      'contradiction_audit_flagged': t('lifecycle.auditLabel') || '⚑ 审计打标',
    };
    return map[action] || action;
  };

  const actionColor = (action: string) => {
    const map: Record<string, string> = {
      'lifecycle_run': 'rgba(99,102,241,0.7)',
      'promote': 'rgba(74,222,128,0.7)',
      'expire_working': 'rgba(239,68,68,0.6)',
      'archive': 'rgba(251,191,36,0.7)',
      'merge': 'rgba(56,189,248,0.7)',
      'compress': 'rgba(168,85,247,0.7)',
      'contradiction_audit_flagged': 'rgba(244,114,182,0.75)',
    };
    return map[action] || 'rgba(99,102,241,0.3)';
  };

  const formatMemoryIds = (raw: string) => {
    if (!raw || raw === '[]') return '\u2014';
    try {
      const ids = JSON.parse(raw);
      if (Array.isArray(ids) && ids.length === 0) return '\u2014';
      if (Array.isArray(ids)) return `${ids.length} 条`;
      return raw;
    } catch { return raw; }
  };

  const formatDetails = (action: string, raw: string) => {
    if (!raw) return '\u2014';
    try {
      const d = JSON.parse(raw);
      if (action === 'lifecycle_run') {
        const triggerLabel = d.trigger === 'scheduled' ? '⏰' : d.trigger === 'manual' ? '👆' : '';
        const parts: string[] = [];
        if (triggerLabel) parts.push(triggerLabel);
        if (d.promoted) parts.push(`升级 ${d.promoted}`);
        if (d.merged) parts.push(`合并 ${d.merged}`);
        if (d.archived) parts.push(`归档 ${d.archived}`);
        if (d.expiredWorking) parts.push(`清理 ${d.expiredWorking}`);
        if (d.compressedToCore) parts.push(`压缩 ${d.compressedToCore}`);
        if (parts.length <= 1) {
          if (d.errors?.length > 0) return `${triggerLabel} ❌ ${d.errors[0]}`;
          return `${triggerLabel} 无变更`;
        }
        return parts.join(' · ');
      }
      if (d.score) return `分数 ${Number(d.score).toFixed(2)}`;
      if (d.decay_score) return `衰减 ${Number(d.decay_score).toFixed(2)}`;
      if (d.distance) return `距离 ${Number(d.distance).toFixed(3)}`;
      if (d.compressed_count) return `压缩 ${d.compressed_count} 条 → ${d.groups} 组`;
      if (d.decision) return `审计 ${d.decision}`;
      if (d.similarity) return `相似度 ${Number(d.similarity).toFixed(3)}`;
      if (d.reason) return d.reason;
      // Hide agent_id-only details
      const keys = Object.keys(d).filter(k => k !== 'agent_id');
      if (keys.length === 0) return '\u2014';
      return raw.length > 60 ? raw.slice(0, 60) + '…' : raw;
    } catch { return raw.length > 60 ? raw.slice(0, 60) + '…' : raw; }
  };

  const totalOps = preview
    ? (preview.promoted + preview.merged + preview.archived + preview.compressedToCore + preview.expiredWorking)
    : 0;

  const phaseLabel = (key: string) => {
    const map: Record<string, string> = {
      cleanExpiredWorking: t('lifecycle.phaseCleanExpired') || '清理过期 Working',
      promoteToCore: t('lifecycle.phasePromote') || '晋升到 Core',
      deduplicateCore: t('lifecycle.phaseDeduplicate') || 'Core 去重',
      archiveStale: t('lifecycle.phaseArchive') || '归档陈旧记忆',
      compressArchive: t('lifecycle.phaseCompress') || 'Archive 压缩回流',
      updateDecayScores: t('lifecycle.phaseDecay') || '更新衰减分数',
      updateRelationDecay: t('lifecycle.phaseRelationDecay') || '关系边衰减',
      adjustImportanceFromFeedback: t('lifecycle.phaseFeedback') || '反馈调权',
      synthesizeProfiles: t('lifecycle.phaseProfile') || '画像合成',
      cleanAccessLogs: t('lifecycle.phaseAccessLogs') || '清理访问日志',
      contradictionAudit: t('lifecycle.phaseContradictionAudit') || '增量矛盾审计',
    };
    return map[key] || key;
  };

  const categoryStats = (lifecycleStats?.categoryStats || []).slice(0, 8);
  const recommendation = lifecycleStats?.analysis?.recommendation;
  const topAffectedCategories = recommendation?.topAffectedCategories || [];

  return (
    <div>
      <h1 className="page-title">{t('lifecycle.title')}</h1>

      {/* Schedule & Config Info */}
      {config && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 12 }}>{t('lifecycle.scheduleConfig')}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            <div style={{ padding: 12, background: 'var(--color-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>{t('lifecycle.schedule')}</div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>{parseCron(config.lifecycle?.schedule)}</div>
              <code style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{config.lifecycle?.schedule}</code>
            </div>
            <div style={{ padding: 12, background: 'var(--color-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>{t('lifecycle.promotionThreshold')}</div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>{config.lifecycle?.promotionThreshold}</div>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{t('lifecycle.promotionDesc')}</div>
            </div>
            <div style={{ padding: 12, background: 'var(--color-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>{t('lifecycle.archiveThreshold')}</div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>{config.lifecycle?.archiveThreshold}</div>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{t('lifecycle.archiveDesc')}</div>
            </div>
            <div style={{ padding: 12, background: 'var(--color-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>{t('lifecycle.decayLambda')}</div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>{config.lifecycle?.decayLambda}</div>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{t('lifecycle.decayDesc')}</div>
            </div>
          </div>
        </div>
      )}

      {/* Layer Distribution (before/after) */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 12 }}>{t('lifecycle.currentDistribution')}</h3>
        <div style={{ display: 'flex', height: 32, borderRadius: 'var(--radius-md)', overflow: 'hidden', marginBottom: 8 }}>
          {[
            { label: t('lifecycle.working'), value: layerStats.working, color: 'var(--color-success)' },
            { label: t('lifecycle.core'), value: layerStats.core, color: 'var(--color-primary-hover)' },
            { label: t('lifecycle.archive'), value: layerStats.archive, color: '#a1a1aa' },
          ].map((seg, i) => {
            const total = layerStats.working + layerStats.core + layerStats.archive;
            return (
              <div key={i} style={{
                width: total > 0 ? `${(seg.value / total) * 100}%` : '33.3%',
                background: seg.color, display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12, fontWeight: 600, color: '#fff', minWidth: seg.value > 0 ? 32 : 0,
              }}>
                {seg.value > 0 && `${seg.label}: ${seg.value}`}
              </div>
            );
          })}
        </div>
      </div>

      {lifecycleStats && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 12 }}>{t('lifecycle.observabilityTitle') || '运行观测'}</h3>
          <div className="card-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', marginBottom: 12 }}>
            <div className="stat-card" style={{ background: 'var(--color-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
              <div className="label">{t('lifecycle.workingCandidates') || '待晋升 Working'}</div>
              <div className="value">{lifecycleStats.workingPromotionCandidates ?? 0}</div>
            </div>
            <div className="stat-card" style={{ background: 'var(--color-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
              <div className="label">{t('lifecycle.archiveCandidates') || '待归档 Core'}</div>
              <div className="value">{lifecycleStats.archiveCandidates ?? 0}</div>
            </div>
            <div className="stat-card" style={{ background: 'var(--color-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
              <div className="label">{t('lifecycle.lowConfidence') || '低置信度记忆'}</div>
              <div className="value">{lifecycleStats.lowConfidenceCount ?? 0}</div>
            </div>
            <div className="stat-card" style={{ background: 'var(--color-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
              <div className="label">{t('lifecycle.lowConfidenceThreshold') || '低置信度阈值'}</div>
              <div className="value">{lifecycleStats.thresholds?.lowConfidenceThreshold ?? 0.4}</div>
            </div>
          </div>
          {categoryStats.length > 0 && (
            <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
              <table style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>{t('lifecycle.categoryCol') || '分类'}</th>
                    <th>{t('lifecycle.totalMemories') || '总数'}</th>
                    <th>{t('lifecycle.archiveCandidates') || '待归档'}</th>
                    <th>{t('lifecycle.lowConfidence') || '低置信度'}</th>
                    <th>{t('lifecycle.avgDecay') || '平均衰减'}</th>
                  </tr>
                </thead>
                <tbody>
                  {categoryStats.map((row: any) => (
                    <tr key={row.category}>
                      <td style={{ whiteSpace: 'nowrap' }}>{row.category}</td>
                      <td>{row.total}</td>
                      <td>{row.archiveCandidates}</td>
                      <td>{row.lowConfidence}</td>
                      <td>{(row.avgDecayScore ?? 0).toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {lifecycleStats?.analysis && (
        <div className="card" style={{ marginBottom: 16, borderColor: recommendation?.shouldAdjust ? 'var(--color-warning)' : 'var(--color-success)' }}>
          <h3 style={{ marginBottom: 12 }}>{t('lifecycle.tuningTitle') || '参数建议'}</h3>
          <div className="card-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', marginBottom: 12 }}>
            <div className="stat-card" style={{ background: 'var(--color-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
              <div className="label">{t('lifecycle.currentScenario') || '当前配置'}</div>
              <div className="value">{lifecycleStats.analysis.current.archiveCandidates}</div>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                archiveThreshold={lifecycleStats.analysis.current.archiveThreshold}, lambda={lifecycleStats.analysis.current.decayLambda}
              </div>
            </div>
            <div className="stat-card" style={{ background: 'var(--color-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
              <div className="label">{t('lifecycle.suggestedScenario') || '建议配置'}</div>
              <div className="value">{lifecycleStats.analysis.suggested.archiveCandidates}</div>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                archiveThreshold={lifecycleStats.analysis.suggested.archiveThreshold}, lambda={lifecycleStats.analysis.suggested.decayLambda}
              </div>
            </div>
            <div className="stat-card" style={{ background: 'var(--color-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
              <div className="label">{t('lifecycle.currentArchiveRate') || '当前归档率'}</div>
              <div className="value">{((lifecycleStats.analysis.current.archiveRate ?? 0) * 100).toFixed(1)}%</div>
            </div>
            <div className="stat-card" style={{ background: 'var(--color-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
              <div className="label">{t('lifecycle.recommendationDecision') || '建议结论'}</div>
              <div className="value" style={{ color: recommendation?.shouldAdjust ? 'var(--color-warning)' : 'var(--color-success)', fontSize: 18 }}>
                {recommendation?.shouldAdjust
                  ? (t('lifecycle.adjustRecommended') || '建议调整')
                  : (t('lifecycle.keepCurrent') || '保持当前')}
              </div>
            </div>
          </div>

          {recommendation?.reasons?.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              {recommendation.reasons.map((reason: string, idx: number) => (
                <div key={idx} style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 6 }}>
                  {reason}
                </div>
              ))}
            </div>
          )}

          {topAffectedCategories.length > 0 && (
            <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
              <table style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>{t('lifecycle.categoryCol') || '分类'}</th>
                    <th>{t('lifecycle.currentScenario') || '当前配置'}</th>
                    <th>{t('lifecycle.suggestedScenario') || '建议配置'}</th>
                    <th>{t('lifecycle.improvementCol') || '改善'}</th>
                  </tr>
                </thead>
                <tbody>
                  {topAffectedCategories.map((row: any) => (
                    <tr key={row.category}>
                      <td style={{ whiteSpace: 'nowrap' }}>{row.category}</td>
                      <td>{row.currentArchiveCandidates}</td>
                      <td>{row.projectedArchiveCandidates}</td>
                      <td>{row.improvement > 0 ? `-${row.improvement}` : row.improvement}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Agent selector + Actions */}
      <div className="toolbar" style={{ flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 13, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>Agent</label>
          <select value={agentId} onChange={e => { setAgentId(e.target.value); setLogPage(0); setPreview(null); setRunResult(null); setLogs([]); setLayerStats({ working: 0, core: 0, archive: 0 }); setShowAffected(false); }} style={{ fontSize: 13, padding: '4px 8px' }}>
            <option value="">{t('lifecycle.allAgents') || '全部 Agent'}</option>
            {agents.map((a: any) => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn" onClick={handlePreview} disabled={previewing || running}>
          {previewing ? <><span className="spinner" /> {t('lifecycle.preview')}...</> : t('lifecycle.preview')}
        </button>
        <button className="btn primary" onClick={handleRun} disabled={running || previewing}>
          {running ? <><span className="spinner" /> {t('common.running')}...</> : t('lifecycle.runNow')}
        </button>
        </div>
      </div>
      {(previewing || running) && <ElapsedTimer />}

      {/* Preview result */}
      {preview && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 12 }}>{t('lifecycle.previewTitle', { count: totalOps })}</h3>
          {totalOps === 0 ? (
            <div style={{ padding: '16px 0', color: 'var(--color-text-secondary)', textAlign: 'center' }}>
              ✅ {t('lifecycle.previewAllGood') || '当前没有需要处理的记忆。所有工作层记忆不足 24 小时或未达到升级条件。'}
            </div>
          ) : (
            <>
              <div className="card-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))' }}>
                {preview.promoted > 0 && (
                  <div className="stat-card" style={{ background: 'var(--color-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
                    <div className="label">{t('lifecycle.wouldPromote')}</div>
                    <div className="value" style={{ color: 'var(--color-success)' }}>{preview.promoted}</div>
                  </div>
                )}
                {preview.merged > 0 && (
                  <div className="stat-card" style={{ background: 'var(--color-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
                    <div className="label">{t('lifecycle.wouldMerge')}</div>
                    <div className="value" style={{ color: 'var(--color-info)' }}>{preview.merged}</div>
                  </div>
                )}
                {preview.archived > 0 && (
                  <div className="stat-card" style={{ background: 'var(--color-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
                    <div className="label">{t('lifecycle.wouldArchive')}</div>
                    <div className="value" style={{ color: 'var(--color-warning)' }}>{preview.archived}</div>
                  </div>
                )}
                {preview.compressedToCore > 0 && (
                  <div className="stat-card" style={{ background: 'var(--color-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
                    <div className="label">{t('lifecycle.wouldCompress')}</div>
                    <div className="value" style={{ color: 'var(--color-danger)' }}>{preview.compressedToCore}</div>
                  </div>
                )}
                {preview.expiredWorking > 0 && (
                  <div className="stat-card" style={{ background: 'var(--color-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
                    <div className="label">{t('lifecycle.expiredWorking')}</div>
                    <div className="value">{preview.expiredWorking}</div>
                  </div>
                )}
              </div>

          {/* Show affected memories from backend dry run */}
          {affectedMemories.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <button className="btn" onClick={() => setShowAffected(!showAffected)} style={{ fontSize: 12 }}>
                {showAffected
                  ? t('lifecycle.hideAffected', { count: affectedMemories.length }) || `隐藏受影响记忆 (${affectedMemories.length})`
                  : t('lifecycle.showAffected', { count: affectedMemories.length }) || `查看受影响记忆 (${affectedMemories.length})`
                }
              </button>
              {showAffected && (
                <div style={{ marginTop: 12, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                  <table style={{ fontSize: 12 }}>
                    <thead>
                      <tr>
                        <th>{t('lifecycle.contentCol')}</th>
                        <th>{t('lifecycle.categoryCol') || '分类'}</th>
                        <th>{t('lifecycle.importanceCol')}</th>
                        <th>{t('lifecycle.scoreCol') || '分数'}</th>
                        <th>{t('lifecycle.likelyAction')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {affectedMemories.map((m: any) => {
                        const actionMap: Record<string, { label: string; color: string }> = {
                          promote: { label: '⬆️ ' + t('lifecycle.promote'), color: 'var(--color-success)' },
                          expire: { label: '🗑️ ' + t('lifecycle.expire'), color: 'var(--color-danger)' },
                          archive: { label: '📦 ' + (t('lifecycle.archiveAction') || '归档'), color: 'var(--color-warning)' },
                          merge: { label: '🔗 ' + (t('lifecycle.mergeAction') || '合并'), color: 'var(--color-info)' },
                          compress: { label: '📐 ' + (t('lifecycle.compressAction') || '压缩'), color: 'var(--color-info)' },
                        };
                        const display = actionMap[m.action] || { label: m.action, color: 'var(--color-text-secondary)' };
                        return (
                          <tr key={m.id}>
                            <td style={{ maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.content}</td>
                            <td style={{ whiteSpace: 'nowrap' }}>{m.category}</td>
                            <td>{(m.importance ?? 0).toFixed(2)}</td>
                            <td>{m.score != null ? m.score.toFixed(2) : '\u2014'}</td>
                            <td style={{ color: display.color, fontWeight: 600, whiteSpace: 'nowrap' }}>{display.label}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
            </>
          )}
        </div>
      )}

      {/* Run result */}
      {runResult && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'var(--color-success)' }}>
          <h3 style={{ marginBottom: 12 }}>{t('lifecycle.lastRunResult')}</h3>
          <div className="card-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))' }}>
            <div className="stat-card" style={{ background: 'var(--color-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}><div className="label">{t('lifecycle.promoted')}</div><div className="value">{runResult.promoted}</div></div>
            <div className="stat-card" style={{ background: 'var(--color-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}><div className="label">{t('lifecycle.merged')}</div><div className="value">{runResult.merged}</div></div>
            <div className="stat-card" style={{ background: 'var(--color-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}><div className="label">{t('lifecycle.archived')}</div><div className="value">{runResult.archived}</div></div>
            <div className="stat-card" style={{ background: 'var(--color-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}><div className="label">{t('lifecycle.compressed')}</div><div className="value">{runResult.compressedToCore}</div></div>
            <div className="stat-card" style={{ background: 'var(--color-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}><div className="label">{t('lifecycle.auditFlagged') || '审计打标'}</div><div className="value">{runResult.contradictionFlagged ?? 0}</div></div>
            <div className="stat-card" style={{ background: 'var(--color-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}><div className="label">{t('lifecycle.llmCalls') || 'LLM 调用'}</div><div className="value">{runResult.observability?.llm?.totalCalls ?? 0}</div></div>
            <div className="stat-card" style={{ background: 'var(--color-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}><div className="label">{t('lifecycle.duration')}</div><div className="value">{runResult.durationMs}ms</div></div>
          </div>
          {runResult.observability?.phases?.length > 0 && (
            <div style={{ marginTop: 12, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
              <table style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>{t('lifecycle.phaseCol') || '阶段'}</th>
                    <th>{t('lifecycle.processedCol') || '处理数'}</th>
                    <th>{t('lifecycle.duration')} </th>
                    <th>{t('lifecycle.details') || '详情'}</th>
                  </tr>
                </thead>
                <tbody>
                  {runResult.observability.phases.map((phase: any) => (
                    <tr key={phase.key}>
                      <td style={{ whiteSpace: 'nowrap' }}>{phaseLabel(phase.key)}</td>
                      <td>{phase.skipped ? '—' : phase.processed}</td>
                      <td>{phase.durationMs}ms</td>
                      <td style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {phase.skipped
                          ? (phase.details?.reason || 'skipped')
                          : phase.details
                            ? JSON.stringify(phase.details)
                            : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {runResult.errors?.length > 0 && (
            <div style={{ marginTop: 12, color: 'var(--color-danger)' }}>
              {t('lifecycle.errors')}: {runResult.errors.join(', ')}
            </div>
          )}
        </div>
      )}

      {/* History action summary */}
      {Object.keys(actionCounts).length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 12 }}>{t('lifecycle.actionSummary', { count: logs.length })}</h3>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {Object.entries(actionCounts).map(([action, count]) => (
              <div key={action} className="stat-card" style={{ padding: 12, minWidth: 100, background: 'var(--color-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
                <div className="label">{actionLabel(action)}</div>
                <div className="value" style={{ fontSize: 20 }}>{count}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* History */}
      <div className="card">
        <h3 style={{ marginBottom: 12 }}>{t('lifecycle.historyTitle')}</h3>
        {logs.length === 0 ? (
          <div className="empty">{t('lifecycle.noEvents')}</div>
        ) : (
          <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <table>
            <thead>
              <tr>
                <th>{t('lifecycle.action')}</th>
                <th>{t('lifecycle.memoryIds')}</th>
                <th>{t('lifecycle.details')}</th>
                <th style={{ whiteSpace: 'nowrap' }}>{t('lifecycle.time')}</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log: any) => (
                <tr key={log.id}>
                  <td><span className="badge" style={{ background: actionColor(log.action), color: '#fff', whiteSpace: 'nowrap', fontSize: 11 }}>{actionLabel(log.action)}</span></td>
                  <td style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>{formatMemoryIds(log.memory_ids)}</td>
                  <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>{formatDetails(log.action, log.details)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{toLocal(log.executed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        {logTotal > logLimit && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', marginTop: 12, gap: 8 }}>
            <button className="btn" disabled={logPage === 0} onClick={() => setLogPage(p => p - 1)}>{t('common.prev')}</button>
            <span style={{ padding: '8px 16px', color: 'var(--color-text-secondary)', fontSize: 13 }}>{t('common.page', { current: logPage + 1, total: Math.ceil(logTotal / logLimit) })}</span>
            <button className="btn" disabled={(logPage + 1) * logLimit >= logTotal} onClick={() => setLogPage(p => p + 1)}>{t('common.next')}</button>
          </div>
        )}
      </div>
    </div>
  );
}
