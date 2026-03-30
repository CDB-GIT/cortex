import React from 'react';
import { SectionKey } from '../types.js';

interface LifecycleSectionProps {
  config: any;
  editing: boolean;
  sectionHeader: (title: string, section: SectionKey) => React.ReactNode;
  displayRow: (label: string, value: any, desc?: string) => React.ReactNode;
  renderSchedule: () => React.ReactNode;
  renderToggleField: (label: string, desc: string, path: string) => React.ReactNode;
  renderNumberField: (label: string, desc: string, path: string, min?: number, max?: number) => React.ReactNode;
  renderSelectField: (label: string, desc: string, path: string, options: Array<{ value: string; label: string }>) => React.ReactNode;
  renderTextareaField: (label: string, desc: string, path: string, rows?: number, action?: React.ReactNode) => React.ReactNode;
  renderSlider: (label: string, desc: string, path: string, min: number, max: number, step: number) => React.ReactNode;
  humanizeCron: (s: string) => string;
  updateDraft: (path: string, value: any) => void;
  t: (key: string, params?: any) => string;
}

export default function LifecycleSection({
  config, editing, sectionHeader, displayRow, renderSchedule, renderToggleField, renderNumberField, renderSelectField, renderTextareaField, renderSlider, humanizeCron, updateDraft, t,
}: LifecycleSectionProps) {
  const contradictionAuditDefault = config.lifecycle?.promptDefaults?.contradictionAudit ?? '';
  const preferenceExtractionDefault = config.lifecycle?.promptDefaults?.preferenceExtraction ?? '';

  return (
    <div className="card">
      {sectionHeader(t('settings.lifecycleTitle'), 'lifecycle')}
      {editing ? (
        <div style={{ padding: '4px 0' }}>
          {renderSchedule()}
          {renderToggleField(
            t('settings.contradictionAuditEnabled'),
            t('settings.contradictionAuditEnabledDesc'),
            'contradictionAudit.enabled',
          )}
          {renderNumberField(
            t('settings.contradictionAuditMaxLlmCalls'),
            t('settings.contradictionAuditMaxLlmCallsDesc'),
            'contradictionAudit.maxLLMCalls',
            1,
            100,
          )}
          {renderSlider(
            t('settings.contradictionAuditLowConfidenceThreshold'),
            t('settings.contradictionAuditLowConfidenceThresholdDesc'),
            'contradictionAudit.lowConfidenceThreshold', 0.05, 0.9, 0.05,
          )}
          {renderSelectField(
            t('settings.contradictionAuditMode'),
            t('settings.contradictionAuditModeDesc'),
            'contradictionAudit.mode',
            [
              { value: 'flag_only', label: t('settings.contradictionAuditModeFlagOnly') },
              { value: 'auto_timeline_supersede', label: t('settings.contradictionAuditModeAutoTimeline') },
            ],
          )}
          {renderSlider(
            t('settings.contradictionAuditAutoApplyMinConfidence'),
            t('settings.contradictionAuditAutoApplyMinConfidenceDesc'),
            'contradictionAudit.autoApplyMinConfidence', 0.1, 1, 0.05,
          )}
          {renderToggleField(
            t('settings.preferenceExtractionEnabled'),
            t('settings.preferenceExtractionEnabledDesc'),
            'preferenceExtraction.enabled',
          )}
          {renderNumberField(
            t('settings.preferenceExtractionMaxNew'),
            t('settings.preferenceExtractionMaxNewDesc'),
            'preferenceExtraction.maxNewPreferences',
            1,
            20,
          )}
          {renderToggleField(
            t('settings.preferenceDuplicateAuditEnabled'),
            t('settings.preferenceDuplicateAuditEnabledDesc'),
            'preferenceExtraction.duplicateAuditEnabled',
          )}
          {renderTextareaField(
            t('settings.contradictionAuditPrompt'),
            t('settings.contradictionAuditPromptDesc'),
            'prompts.contradictionAudit',
            14,
            <button className="btn" type="button" onClick={() => updateDraft('prompts.contradictionAudit', contradictionAuditDefault)}>
              {t('common.restoreDefault')}
            </button>,
          )}
          {renderTextareaField(
            t('settings.preferenceExtractionPrompt'),
            t('settings.preferenceExtractionPromptDesc'),
            'prompts.preferenceExtraction',
            14,
            <button className="btn" type="button" onClick={() => updateDraft('prompts.preferenceExtraction', preferenceExtractionDefault)}>
              {t('common.restoreDefault')}
            </button>,
          )}
          {renderSlider(
            t('settings.promotionThreshold'),
            t('settings.promotionThresholdDesc'),
            'promotionThreshold', 0, 1, 0.05,
          )}
          {renderSlider(
            t('settings.archiveThreshold'),
            t('settings.archiveThresholdDesc'),
            'archiveThreshold', 0, 1, 0.05,
          )}
          {renderSlider(
            t('settings.decayLambda'),
            t('settings.decayLambdaDesc'),
            'decayLambda', 0.001, 0.2, 0.001,
          )}
        </div>
      ) : (
        <table>
          <tbody>
            {displayRow(t('settings.scheduleLabel'), humanizeCron(config.lifecycle?.schedule), t('settings.scheduleDesc'))}
            {displayRow(t('settings.contradictionAuditEnabled'), config.lifecycle?.contradictionAudit?.enabled ? t('common.on') : t('common.off'), t('settings.contradictionAuditEnabledDesc'))}
            {displayRow(t('settings.contradictionAuditMaxLlmCalls'), config.lifecycle?.contradictionAudit?.maxLLMCalls ?? 20, t('settings.contradictionAuditMaxLlmCallsDesc'))}
            {displayRow(t('settings.contradictionAuditLowConfidenceThreshold'), (config.lifecycle?.contradictionAudit?.lowConfidenceThreshold ?? 0.4).toFixed(2), t('settings.contradictionAuditLowConfidenceThresholdDesc'))}
            {displayRow(
              t('settings.contradictionAuditMode'),
              config.lifecycle?.contradictionAudit?.mode === 'auto_timeline_supersede'
                ? t('settings.contradictionAuditModeAutoTimeline')
                : t('settings.contradictionAuditModeFlagOnly'),
              t('settings.contradictionAuditModeDesc'),
            )}
            {displayRow(
              t('settings.contradictionAuditAutoApplyMinConfidence'),
              (config.lifecycle?.contradictionAudit?.autoApplyMinConfidence ?? 0.75).toFixed(2),
              t('settings.contradictionAuditAutoApplyMinConfidenceDesc'),
            )}
            {displayRow(t('settings.preferenceExtractionEnabled'), config.lifecycle?.preferenceExtraction?.enabled ? t('common.on') : t('common.off'), t('settings.preferenceExtractionEnabledDesc'))}
            {displayRow(t('settings.preferenceExtractionMaxNew'), config.lifecycle?.preferenceExtraction?.maxNewPreferences ?? 5, t('settings.preferenceExtractionMaxNewDesc'))}
            {displayRow(t('settings.preferenceDuplicateAuditEnabled'), config.lifecycle?.preferenceExtraction?.duplicateAuditEnabled ? t('common.on') : t('common.off'), t('settings.preferenceDuplicateAuditEnabledDesc'))}
            {displayRow(
              t('settings.contradictionAuditPrompt'),
              `${(config.lifecycle?.prompts?.contradictionAudit ?? '').length} chars`,
              t('settings.contradictionAuditPromptDesc'),
            )}
            {displayRow(
              t('settings.preferenceExtractionPrompt'),
              `${(config.lifecycle?.prompts?.preferenceExtraction ?? '').length} chars`,
              t('settings.preferenceExtractionPromptDesc'),
            )}
            {displayRow(t('settings.promotionThreshold'), config.lifecycle?.promotionThreshold?.toFixed(2), t('settings.promotionThresholdDesc'))}
            {displayRow(t('settings.archiveThreshold'), config.lifecycle?.archiveThreshold?.toFixed(2), t('settings.archiveThresholdDesc'))}
            {displayRow(t('settings.decayLambda'), config.lifecycle?.decayLambda?.toFixed(3), t('settings.decayLambdaDesc'))}
          </tbody>
        </table>
      )}
    </div>
  );
}
