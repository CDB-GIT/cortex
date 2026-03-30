import React, { useEffect, useState } from 'react';
import { getConfig, updateConfig } from '../api/client.js';
import { useI18n } from '../i18n/index.js';

type PromptDraft = {
  contradictionAudit: string;
  preferenceExtraction: string;
  sieveExtractionSystem: string;
  smartUpdateSystem: string;
  flushHighlightsSystem: string;
  flushCoreItemsSystem: string;
};

type ExpandedState = {
  contradictionAudit: boolean;
  preferenceExtraction: boolean;
  sieveExtractionSystem: boolean;
  smartUpdateSystem: boolean;
  flushHighlightsSystem: boolean;
  flushCoreItemsSystem: boolean;
};

export default function Prompts() {
  const { t } = useI18n();
  const [config, setConfig] = useState<any>(null);
  const [draft, setDraft] = useState<PromptDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [expanded, setExpanded] = useState<ExpandedState>({
    contradictionAudit: true,
    preferenceExtraction: false,
    sieveExtractionSystem: true,
    smartUpdateSystem: false,
    flushHighlightsSystem: false,
    flushCoreItemsSystem: false,
  });

  useEffect(() => {
    getConfig().then((cfg: any) => {
      setConfig(cfg);
      setDraft({
        contradictionAudit: cfg.lifecycle?.prompts?.contradictionAudit ?? '',
        preferenceExtraction: cfg.lifecycle?.prompts?.preferenceExtraction ?? '',
        sieveExtractionSystem: cfg.sieve?.prompts?.extractionSystem ?? '',
        smartUpdateSystem: cfg.sieve?.prompts?.smartUpdateSystem ?? '',
        flushHighlightsSystem: cfg.flush?.prompts?.highlightsSystem ?? '',
        flushCoreItemsSystem: cfg.flush?.prompts?.coreItemsSystem ?? '',
      });
    }).catch((e: any) => {
      setToast({ message: e.message, type: 'error' });
    });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  if (!config || !draft) {
    return <div>{t('common.loading')}</div>;
  }

  const defaults = config.lifecycle?.promptDefaults ?? {};

  const save = async () => {
    setSaving(true);
    try {
      await updateConfig({
        lifecycle: {
          prompts: {
            ...(config.lifecycle?.prompts ?? {}),
            contradictionAudit: draft.contradictionAudit,
            preferenceExtraction: draft.preferenceExtraction,
          },
        },
        sieve: {
          prompts: {
            ...(config.sieve?.prompts ?? {}),
            extractionSystem: draft.sieveExtractionSystem,
            smartUpdateSystem: draft.smartUpdateSystem,
          },
        },
        flush: {
          prompts: {
            ...(config.flush?.prompts ?? {}),
            highlightsSystem: draft.flushHighlightsSystem,
            coreItemsSystem: draft.flushCoreItemsSystem,
          },
        },
      });
      const refreshed = await getConfig();
      setConfig(refreshed);
      setDraft({
        contradictionAudit: refreshed.lifecycle?.prompts?.contradictionAudit ?? '',
        preferenceExtraction: refreshed.lifecycle?.prompts?.preferenceExtraction ?? '',
        sieveExtractionSystem: refreshed.sieve?.prompts?.extractionSystem ?? '',
        smartUpdateSystem: refreshed.sieve?.prompts?.smartUpdateSystem ?? '',
        flushHighlightsSystem: refreshed.flush?.prompts?.highlightsSystem ?? '',
        flushCoreItemsSystem: refreshed.flush?.prompts?.coreItemsSystem ?? '',
      });
      setToast({ message: t('prompts.toastSaved'), type: 'success' });
    } catch (e: any) {
      setToast({ message: t('prompts.toastSaveFailed', { message: e.message }), type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const placeholders = [
    {
      token: '{{memory_a_content}}',
      title: t('prompts.placeholderMemoryATitle'),
      desc: t('prompts.placeholderMemoryAContentDesc'),
    },
    {
      token: '{{memory_b_content}}',
      title: t('prompts.placeholderMemoryBTitle'),
      desc: t('prompts.placeholderMemoryBContentDesc'),
    },
    {
      token: '{{memory_a_created_at}} / {{memory_b_created_at}}',
      title: t('prompts.placeholderCreatedAtTitle'),
      desc: t('prompts.placeholderCreatedAtDesc'),
    },
    {
      token: '{{memory_a_confidence}} / {{memory_b_confidence}}',
      title: t('prompts.placeholderConfidenceTitle'),
      desc: t('prompts.placeholderConfidenceDesc'),
    },
    {
      token: '{{existing_preferences}}',
      title: t('prompts.placeholderExistingPreferencesTitle'),
      desc: t('prompts.placeholderExistingPreferencesDesc'),
    },
    {
      token: '{{recent_memories}}',
      title: t('prompts.placeholderRecentMemoriesTitle'),
      desc: t('prompts.placeholderRecentMemoriesDesc'),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ marginBottom: 6 }}>{t('prompts.title')}</h1>
          <div style={{ color: 'var(--color-text-secondary)', fontSize: 13, lineHeight: 1.6 }}>
            {t('prompts.subtitle')}
          </div>
        </div>
        <button className="btn primary" onClick={save} disabled={saving}>
          {saving ? t('prompts.saving') : t('common.save')}
        </button>
      </div>

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

      <div
        className="card"
        style={{
          marginBottom: 16,
          padding: 0,
          overflow: 'hidden',
          borderColor: 'var(--color-primary-border)',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        <div
          style={{
            padding: '18px 20px 14px',
            background: 'linear-gradient(135deg, rgba(99,102,241,0.14) 0%, rgba(16,185,129,0.08) 55%, rgba(15,23,42,0) 100%)',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-primary-hover)', marginBottom: 8 }}>
            {t('prompts.guideEyebrow')}
          </div>
          <h3 style={{ margin: 0, marginBottom: 8 }}>{t('prompts.guideTitle')}</h3>
          <div style={{ color: 'var(--color-text-secondary)', fontSize: 14, lineHeight: 1.7, maxWidth: 860 }}>
            {t('prompts.guideIntro')}
          </div>
        </div>

        <div className="card-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12, margin: 0, padding: 16 }}>
          <div style={{ padding: 14, borderRadius: 'var(--radius-lg)', background: 'var(--color-base)', border: '1px solid var(--color-border)' }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{t('prompts.guideCardABTitle')}</div>
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.7 }}>
              {t('prompts.guideCardABDesc')}
            </div>
          </div>
          <div style={{ padding: 14, borderRadius: 'var(--radius-lg)', background: 'var(--color-base)', border: '1px solid var(--color-border)' }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{t('prompts.guideCardOrderTitle')}</div>
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.7 }}>
              {t('prompts.guideCardOrderDesc')}
            </div>
          </div>
          <div style={{ padding: 14, borderRadius: 'var(--radius-lg)', background: 'var(--color-base)', border: '1px solid var(--color-border)' }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{t('prompts.guideCardPreferenceTitle')}</div>
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.7 }}>
              {t('prompts.guideCardPreferenceDesc')}
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 14 }}>
          <h3 style={{ marginBottom: 8 }}>{t('prompts.lifecycleTitle')}</h3>
          <div style={{ color: 'var(--color-text-secondary)', fontSize: 13, lineHeight: 1.6 }}>
            {t('prompts.lifecycleDesc')}
          </div>
        </div>

        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', background: 'var(--color-base)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: 14, borderBottom: expanded.contradictionAudit ? '1px solid var(--color-border)' : 'none' }}>
              <div>
                <h3 style={{ margin: 0, marginBottom: 6 }}>{t('settings.contradictionAuditPrompt')}</h3>
                <div style={{ color: 'var(--color-text-secondary)', fontSize: 13, lineHeight: 1.6 }}>
                  {t('settings.contradictionAuditPromptDesc')}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                <button className="btn" onClick={() => setDraft((prev) => prev ? { ...prev, contradictionAudit: defaults.contradictionAudit ?? '' } : prev)}>
                  {t('common.restoreDefault')}
                </button>
                <button className="btn" onClick={() => setExpanded((prev) => ({ ...prev, contradictionAudit: !prev.contradictionAudit }))}>
                  {expanded.contradictionAudit ? t('settings.collapseSection') : t('settings.expandSection')}
                </button>
              </div>
            </div>
            {expanded.contradictionAudit && (
              <div style={{ padding: 14 }}>
                <textarea
                  value={draft.contradictionAudit}
                  rows={18}
                  onChange={(e) => setDraft((prev) => prev ? { ...prev, contradictionAudit: e.target.value } : prev)}
                  style={{ width: '100%', fontFamily: 'var(--font-mono)', resize: 'vertical' }}
                />
              </div>
            )}
          </div>

          <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', background: 'var(--color-base)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: 14, borderBottom: expanded.preferenceExtraction ? '1px solid var(--color-border)' : 'none' }}>
              <div>
                <h3 style={{ margin: 0, marginBottom: 6 }}>{t('settings.preferenceExtractionPrompt')}</h3>
                <div style={{ color: 'var(--color-text-secondary)', fontSize: 13, lineHeight: 1.6 }}>
                  {t('settings.preferenceExtractionPromptDesc')}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                <button className="btn" onClick={() => setDraft((prev) => prev ? { ...prev, preferenceExtraction: defaults.preferenceExtraction ?? '' } : prev)}>
                  {t('common.restoreDefault')}
                </button>
                <button className="btn" onClick={() => setExpanded((prev) => ({ ...prev, preferenceExtraction: !prev.preferenceExtraction }))}>
                  {expanded.preferenceExtraction ? t('settings.collapseSection') : t('settings.expandSection')}
                </button>
              </div>
            </div>
            {expanded.preferenceExtraction && (
              <div style={{ padding: 14 }}>
                <textarea
                  value={draft.preferenceExtraction}
                  rows={18}
                  onChange={(e) => setDraft((prev) => prev ? { ...prev, preferenceExtraction: e.target.value } : prev)}
                  style={{ width: '100%', fontFamily: 'var(--font-mono)', resize: 'vertical' }}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 14 }}>
          <h3 style={{ marginBottom: 8 }}>{t('prompts.extractionTitle')}</h3>
          <div style={{ color: 'var(--color-text-secondary)', fontSize: 13, lineHeight: 1.6 }}>
            {t('prompts.extractionDesc')}
          </div>
        </div>

        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', background: 'var(--color-base)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: 14, borderBottom: expanded.sieveExtractionSystem ? '1px solid var(--color-border)' : 'none' }}>
              <div>
                <h3 style={{ margin: 0, marginBottom: 6 }}>{t('prompts.sieveExtractionTitle')}</h3>
                <div style={{ color: 'var(--color-text-secondary)', fontSize: 13, lineHeight: 1.6 }}>
                  {t('prompts.sieveExtractionDesc')}
                </div>
                <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6, color: 'var(--color-primary-hover)' }}>
                  {t('prompts.whenUsedLabel')} {t('prompts.sieveExtractionWhen')}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                <button className="btn" onClick={() => setDraft((prev) => prev ? { ...prev, sieveExtractionSystem: config.sieve?.promptDefaults?.extractionSystem ?? '' } : prev)}>
                  {t('common.restoreDefault')}
                </button>
                <button className="btn" onClick={() => setExpanded((prev) => ({ ...prev, sieveExtractionSystem: !prev.sieveExtractionSystem }))}>
                  {expanded.sieveExtractionSystem ? t('settings.collapseSection') : t('settings.expandSection')}
                </button>
              </div>
            </div>
            {expanded.sieveExtractionSystem && (
              <div style={{ padding: 14 }}>
                <textarea
                  value={draft.sieveExtractionSystem}
                  rows={18}
                  onChange={(e) => setDraft((prev) => prev ? { ...prev, sieveExtractionSystem: e.target.value } : prev)}
                  style={{ width: '100%', fontFamily: 'var(--font-mono)', resize: 'vertical' }}
                />
              </div>
            )}
          </div>

          <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', background: 'var(--color-base)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: 14, borderBottom: expanded.smartUpdateSystem ? '1px solid var(--color-border)' : 'none' }}>
              <div>
                <h3 style={{ margin: 0, marginBottom: 6 }}>{t('prompts.smartUpdateTitle')}</h3>
                <div style={{ color: 'var(--color-text-secondary)', fontSize: 13, lineHeight: 1.6 }}>
                  {t('prompts.smartUpdateDesc')}
                </div>
                <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6, color: 'var(--color-primary-hover)' }}>
                  {t('prompts.whenUsedLabel')} {t('prompts.smartUpdateWhen')}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                <button className="btn" onClick={() => setDraft((prev) => prev ? { ...prev, smartUpdateSystem: config.sieve?.promptDefaults?.smartUpdateSystem ?? '' } : prev)}>
                  {t('common.restoreDefault')}
                </button>
                <button className="btn" onClick={() => setExpanded((prev) => ({ ...prev, smartUpdateSystem: !prev.smartUpdateSystem }))}>
                  {expanded.smartUpdateSystem ? t('settings.collapseSection') : t('settings.expandSection')}
                </button>
              </div>
            </div>
            {expanded.smartUpdateSystem && (
              <div style={{ padding: 14 }}>
                <textarea
                  value={draft.smartUpdateSystem}
                  rows={18}
                  onChange={(e) => setDraft((prev) => prev ? { ...prev, smartUpdateSystem: e.target.value } : prev)}
                  style={{ width: '100%', fontFamily: 'var(--font-mono)', resize: 'vertical' }}
                />
              </div>
            )}
          </div>

          <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', background: 'var(--color-base)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: 14, borderBottom: expanded.flushHighlightsSystem ? '1px solid var(--color-border)' : 'none' }}>
              <div>
                <h3 style={{ margin: 0, marginBottom: 6 }}>{t('prompts.flushHighlightsTitle')}</h3>
                <div style={{ color: 'var(--color-text-secondary)', fontSize: 13, lineHeight: 1.6 }}>
                  {t('prompts.flushHighlightsDesc')}
                </div>
                <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6, color: 'var(--color-primary-hover)' }}>
                  {t('prompts.whenUsedLabel')} {t('prompts.flushHighlightsWhen')}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                <button className="btn" onClick={() => setDraft((prev) => prev ? { ...prev, flushHighlightsSystem: config.flush?.promptDefaults?.highlightsSystem ?? '' } : prev)}>
                  {t('common.restoreDefault')}
                </button>
                <button className="btn" onClick={() => setExpanded((prev) => ({ ...prev, flushHighlightsSystem: !prev.flushHighlightsSystem }))}>
                  {expanded.flushHighlightsSystem ? t('settings.collapseSection') : t('settings.expandSection')}
                </button>
              </div>
            </div>
            {expanded.flushHighlightsSystem && (
              <div style={{ padding: 14 }}>
                <textarea
                  value={draft.flushHighlightsSystem}
                  rows={16}
                  onChange={(e) => setDraft((prev) => prev ? { ...prev, flushHighlightsSystem: e.target.value } : prev)}
                  style={{ width: '100%', fontFamily: 'var(--font-mono)', resize: 'vertical' }}
                />
              </div>
            )}
          </div>

          <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', background: 'var(--color-base)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: 14, borderBottom: expanded.flushCoreItemsSystem ? '1px solid var(--color-border)' : 'none' }}>
              <div>
                <h3 style={{ margin: 0, marginBottom: 6 }}>{t('prompts.flushCoreItemsTitle')}</h3>
                <div style={{ color: 'var(--color-text-secondary)', fontSize: 13, lineHeight: 1.6 }}>
                  {t('prompts.flushCoreItemsDesc')}
                </div>
                <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6, color: 'var(--color-primary-hover)' }}>
                  {t('prompts.whenUsedLabel')} {t('prompts.flushCoreItemsWhen')}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                <button className="btn" onClick={() => setDraft((prev) => prev ? { ...prev, flushCoreItemsSystem: config.flush?.promptDefaults?.coreItemsSystem ?? '' } : prev)}>
                  {t('common.restoreDefault')}
                </button>
                <button className="btn" onClick={() => setExpanded((prev) => ({ ...prev, flushCoreItemsSystem: !prev.flushCoreItemsSystem }))}>
                  {expanded.flushCoreItemsSystem ? t('settings.collapseSection') : t('settings.expandSection')}
                </button>
              </div>
            </div>
            {expanded.flushCoreItemsSystem && (
              <div style={{ padding: 14 }}>
                <textarea
                  value={draft.flushCoreItemsSystem}
                  rows={18}
                  onChange={(e) => setDraft((prev) => prev ? { ...prev, flushCoreItemsSystem: e.target.value } : prev)}
                  style={{ width: '100%', fontFamily: 'var(--font-mono)', resize: 'vertical' }}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 8 }}>{t('prompts.placeholdersTitle')}</h3>
        <div style={{ color: 'var(--color-text-secondary)', fontSize: 13, lineHeight: 1.7, marginBottom: 12 }}>
          {t('prompts.placeholdersDesc')}
        </div>
        <div className="card-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
          {placeholders.map((placeholder) => (
            <div key={placeholder.token} style={{
              padding: 12,
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-base)',
              border: '1px solid var(--color-border)',
              minHeight: 118,
            }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, color: 'var(--color-text-primary)' }}>{placeholder.title}</div>
              <div style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                padding: '6px 8px',
                borderRadius: 'var(--radius-sm)',
                background: 'rgba(99,102,241,0.08)',
                color: 'var(--color-primary-hover)',
                marginBottom: 8,
                wordBreak: 'break-all',
              }}>
                {placeholder.token}
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
                {placeholder.desc}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 8 }}>{t('prompts.extractionNextTitle')}</h3>
        <div style={{ color: 'var(--color-text-secondary)', fontSize: 13, lineHeight: 1.7 }}>
          {t('prompts.extractionNextDesc')}
        </div>
      </div>
    </div>
  );
}
