import React, { useState } from 'react';
import {
  getConfig,
  updateConfig,
  exportFullConfig,
  triggerExport,
  triggerReindex,
  seedDuplicatePreferenceDemo,
  seedTimelineConflictDemo,
  seedConflictReviewDemo,
} from '../../../api/client.js';

interface DataManagementProps {
  config: any;
  setConfig: (config: any) => void;
  setToast: (toast: { message: string; type: 'success' | 'error' } | null) => void;
  t: (key: string, params?: any) => string;
}

function maskSensitive(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map(maskSensitive);
  if (typeof obj === 'object') {
    const result: any = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/^(token|apiKey|apikey|api_key|secret|password)$/i.test(k) && typeof v === 'string' && v.length > 0) {
        result[k] = v.slice(0, 4) + '••••' + v.slice(-4);
      } else {
        result[k] = maskSensitive(v);
      }
    }
    return result;
  }
  return obj;
}

export default function DataManagement({ config, setConfig, setToast, t }: DataManagementProps) {
  const [showConfig, setShowConfig] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [reindexStart, setReindexStart] = useState<number | null>(null);
  const [seedingDuplicateDemo, setSeedingDuplicateDemo] = useState(false);
  const [seedingTimelineDemo, setSeedingTimelineDemo] = useState(false);
  const [seedingConflictReviewDemo, setSeedingConflictReviewDemo] = useState(false);

  return (
    <>
      {/* ── Data Management ── */}
      <div className="card">
        <h3 style={{ marginBottom: 12 }}>{t('settings.dataManagement')}</h3>

        {/* Export */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>{t('settings.exportLabel')}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={async () => {
              try {
                const data = await triggerExport('json');
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a'); a.href = url; a.download = `cortex-export-${new Date().toISOString().slice(0, 10)}.json`; a.click();
                URL.revokeObjectURL(url);
                setToast({ message: t('settings.toastJsonExported'), type: 'success' });
              } catch (e: any) { setToast({ message: e.message, type: 'error' }); }
            }}>{t('settings.exportJson')}</button>
            <button className="btn" onClick={async () => {
              try {
                const data = await triggerExport('markdown');
                const blob = new Blob([data.content], { type: 'text/markdown' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a'); a.href = url; a.download = `cortex-export-${new Date().toISOString().slice(0, 10)}.md`; a.click();
                URL.revokeObjectURL(url);
                setToast({ message: t('settings.toastMarkdownExported'), type: 'success' });
              } catch (e: any) { setToast({ message: e.message, type: 'error' }); }
            }}>{t('settings.exportMarkdown')}</button>
          </div>
        </div>

        {/* Reindex */}
        <div>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>{t('settings.maintenance')}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn" disabled={reindexing} onClick={async () => {
              if (!confirm(t('settings.confirmReindex'))) return;
              try {
                setReindexing(true);
                setReindexStart(Date.now());
                const result = await triggerReindex();
                setReindexing(false);
                const elapsed = ((Date.now() - (reindexStart || Date.now())) / 1000).toFixed(1);
                setToast({ message: t('settings.toastReindexComplete', { indexed: result.indexed, total: result.total, errors: result.errors }) + ` (${elapsed}s)`, type: result.errors > 0 ? 'error' : 'success' });
              } catch (e: any) {
                setReindexing(false);
                setToast({ message: t('settings.toastReindexFailed', { message: e.message }), type: 'error' });
              }
            }}>{reindexing ? t('settings.reindexing') : t('settings.rebuildIndex')}</button>
            {reindexing && (
              <span style={{ fontSize: 12, color: 'var(--color-primary)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid var(--color-primary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                {t('settings.reindexingHint')}
              </span>
            )}
            {!reindexing && (
              <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{t('settings.rebuildHint')}</span>
            )}
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>{t('settings.devTools') || 'Dev Tools'}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn" disabled={seedingDuplicateDemo} onClick={async () => {
              try {
                setSeedingDuplicateDemo(true);
                const result = await seedDuplicatePreferenceDemo();
                setToast({
                  message: t('settings.toastSeedDuplicatePreferenceDemo', {
                    agent: result.agent_id,
                    count: result.duplicate_preference_ids?.length ?? 0,
                  }),
                  type: 'success',
                });
              } catch (e: any) {
                setToast({ message: t('settings.toastSeedDuplicatePreferenceDemoFailed', { message: e.message }), type: 'error' });
              } finally {
                setSeedingDuplicateDemo(false);
              }
            }}>
              {seedingDuplicateDemo ? (t('common.loading') || 'Loading...') : t('settings.seedDuplicatePreferenceDemo')}
            </button>
            <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              {t('settings.seedDuplicatePreferenceDemoHint')}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
            <button className="btn" disabled={seedingTimelineDemo} onClick={async () => {
              try {
                setSeedingTimelineDemo(true);
                const result = await seedTimelineConflictDemo();
                setToast({
                  message: t('settings.toastSeedTimelineConflictDemo', {
                    agent: result.agent_id,
                    current: result.current_candidate_id,
                    history: result.history_candidate_id,
                  }),
                  type: 'success',
                });
              } catch (e: any) {
                setToast({ message: t('settings.toastSeedTimelineConflictDemoFailed', { message: e.message }), type: 'error' });
              } finally {
                setSeedingTimelineDemo(false);
              }
            }}>
              {seedingTimelineDemo ? (t('common.loading') || 'Loading...') : t('settings.seedTimelineConflictDemo')}
            </button>
            <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              {t('settings.seedTimelineConflictDemoHint')}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
            <button className="btn" disabled={seedingConflictReviewDemo} onClick={async () => {
              try {
                setSeedingConflictReviewDemo(true);
                const result = await seedConflictReviewDemo();
                setToast({
                  message: t('settings.toastSeedConflictReviewDemo', {
                    agent: result.agent_id,
                    left: result.review_memory_ids?.[0] || '',
                    right: result.review_memory_ids?.[1] || '',
                  }),
                  type: 'success',
                });
              } catch (e: any) {
                setToast({ message: t('settings.toastSeedConflictReviewDemoFailed', { message: e.message }), type: 'error' });
              } finally {
                setSeedingConflictReviewDemo(false);
              }
            }}>
              {seedingConflictReviewDemo ? (t('common.loading') || 'Loading...') : t('settings.seedConflictReviewDemo')}
            </button>
            <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              {t('settings.seedConflictReviewDemoHint')}
            </span>
          </div>
        </div>
      </div>

      {/* ── Full Config JSON (collapsed by default) ── */}
      <div className="card">
        <div
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
          onClick={() => setShowConfig(!showConfig)}
        >
          <h3 style={{ margin: 0 }}>
            <span style={{ display: 'inline-block', transform: showConfig ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s', marginRight: 8 }}>▶</span>
            {t('settings.fullConfig')}
          </h3>
          {showConfig && (
            <div style={{ display: 'flex', gap: 8 }} onClick={e => e.stopPropagation()}>
              <button className="btn" onClick={() => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json';
                input.onchange = async (e: any) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    const text = await file.text();
                    const parsed = JSON.parse(text);
                    delete parsed.port;
                    delete parsed.host;
                    delete parsed.storage;
                    delete parsed.auth;
                    delete parsed.cors;
                    delete parsed.rateLimit;
                    delete parsed.vectorBackend;
                    for (const key of ['extraction', 'lifecycle']) {
                      if (parsed.llm?.[key]?.hasApiKey !== undefined) {
                        delete parsed.llm[key].hasApiKey;
                        if (!parsed.llm[key].apiKey) delete parsed.llm[key].apiKey;
                      }
                    }
                    if (parsed.embedding?.hasApiKey !== undefined) {
                      delete parsed.embedding.hasApiKey;
                      if (!parsed.embedding.apiKey) delete parsed.embedding.apiKey;
                    }
                    if (!confirm(t('settings.confirmImportConfig'))) return;
                    await updateConfig(parsed);
                    const refreshed = await getConfig();
                    setConfig(refreshed);
                    setToast({ message: t('settings.toastConfigImported'), type: 'success' });
                  } catch (e: any) {
                    setToast({ message: t('settings.toastConfigImportFailed', { message: e.message }), type: 'error' });
                  }
                };
                input.click();
              }}>{t('settings.importConfig')}</button>
              <button className="btn" onClick={async () => {
                if (!confirm(t('settings.confirmExportConfig'))) return;
                try {
                  const fullConfig = await exportFullConfig();
                  const blob = new Blob([JSON.stringify(fullConfig, null, 2)], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a'); a.href = url; a.download = `cortex-config-${new Date().toISOString().slice(0, 10)}.json`; a.click();
                  URL.revokeObjectURL(url);
                  setToast({ message: t('settings.toastConfigExported'), type: 'success' });
                } catch (e: any) { setToast({ message: e.message, type: 'error' }); }
              }}>{t('settings.exportConfig')}</button>
            </div>
          )}
        </div>
        {showConfig && (
          <pre className="json-debug" style={{ marginTop: 12 }}>{JSON.stringify(maskSensitive(config), null, 2)}</pre>
        )}
      </div>
    </>
  );
}
