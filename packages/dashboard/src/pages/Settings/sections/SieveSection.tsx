import React from 'react';
import { SectionKey } from '../types.js';

interface SieveSectionProps {
  config: any;
  editing: boolean;
  sectionHeader: (title: string, section: SectionKey) => React.ReactNode;
  displayRow: (label: string, value: any, desc?: string) => React.ReactNode;
  renderToggleField: (label: string, desc: string, path: string) => React.ReactNode;
  renderNumberField: (label: string, desc: string, path: string, min?: number, max?: number) => React.ReactNode;
  renderSlider: (label: string, desc: string, path: string, min: number, max: number, step: number) => React.ReactNode;
  t: (key: string, params?: any) => string;
}

export default function SieveSection({
  config, editing, sectionHeader, displayRow, renderToggleField, renderNumberField, renderSlider, t,
}: SieveSectionProps) {
  return (
    <div className="card">
      {sectionHeader(t('settings.sieveTitle') || 'Sieve', 'sieve')}
      {editing ? (
        <div style={{ padding: '4px 0' }}>
          {renderToggleField(t('settings.fastChannelEnabled'), t('settings.fastChannelEnabledDesc'), 'fastChannelEnabled')}
          {renderToggleField(t('settings.highSignalImmediate'), t('settings.highSignalImmediateDesc'), 'highSignalImmediate')}
          {renderToggleField(t('settings.parallelChannels'), t('settings.parallelChannelsDesc'), 'parallelChannels')}
          {renderToggleField(t('settings.profileInjection'), t('settings.profileInjectionDesc'), 'profileInjection')}
          {renderToggleField(t('settings.extractionLogging'), t('settings.extractionLoggingDesc'), 'extractionLogging')}
          {renderNumberField(t('settings.contextMessages'), t('settings.contextMessagesDesc'), 'contextMessages', 2, 20)}
          {renderNumberField(t('settings.maxConversationChars'), t('settings.maxConversationCharsDesc'), 'maxConversationChars', 2000, 16000)}
          {renderNumberField(t('settings.maxExtractionTokens'), t('settings.maxExtractionTokensDesc'), 'maxExtractionTokens', 100, 4000)}
          {renderSlider(t('settings.minImportance'), t('settings.minImportanceDesc'), 'minImportance', 0.1, 1.0, 0.05)}
          {renderToggleField(t('settings.smartUpdate'), t('settings.smartUpdateDesc'), 'smartUpdate')}
          {renderSlider(t('settings.similarityThreshold'), t('settings.similarityThresholdDesc'), 'similarityThreshold', 0.1, 0.8, 0.01)}
          {renderSlider(t('settings.exactDupThreshold'), t('settings.exactDupThresholdDesc'), 'exactDupThreshold', 0.01, 0.2, 0.01)}
          {renderToggleField(t('settings.relationExtraction'), t('settings.relationExtractionDesc'), 'relationExtraction')}
          {renderNumberField(t('settings.logPreviewPerMsg'), t('settings.logPreviewPerMsgDesc'), 'extractionLogPreviewCharsPerMessage', 0, 2000)}
          {renderNumberField(t('settings.logPreviewMax'), t('settings.logPreviewMaxDesc'), 'extractionLogPreviewMaxChars', 0, 10000)}
        </div>
      ) : (
        <table>
          <tbody>
            {displayRow(t('settings.fastChannelEnabled'), (config.sieve?.fastChannelEnabled ?? true) ? t('common.on') : t('common.off'), t('settings.fastChannelEnabledDesc'))}
            {displayRow(t('settings.highSignalImmediate'), (config.sieve?.highSignalImmediate ?? true) ? t('common.on') : t('common.off'), t('settings.highSignalImmediateDesc'))}
            {displayRow(t('settings.parallelChannels'), (config.sieve?.parallelChannels ?? true) ? t('common.on') : t('common.off'), t('settings.parallelChannelsDesc'))}
            {displayRow(t('settings.profileInjection'), (config.sieve?.profileInjection ?? true) ? t('common.on') : t('common.off'), t('settings.profileInjectionDesc'))}
            {displayRow(t('settings.extractionLogging'), (config.sieve?.extractionLogging ?? true) ? t('common.on') : t('common.off'), t('settings.extractionLoggingDesc'))}
            {displayRow(t('settings.contextMessages'), config.sieve?.contextMessages ?? 4, t('settings.contextMessagesDesc'))}
            {displayRow(t('settings.maxConversationChars'), config.sieve?.maxConversationChars ?? 4000, t('settings.maxConversationCharsDesc'))}
            {displayRow(t('settings.maxExtractionTokens'), config.sieve?.maxExtractionTokens ?? 1000, t('settings.maxExtractionTokensDesc'))}
            {displayRow(t('settings.minImportance'), (config.sieve?.minImportance ?? 0.3).toFixed(2), t('settings.minImportanceDesc'))}
            {displayRow(t('settings.smartUpdate'), (config.sieve?.smartUpdate ?? true) ? t('common.on') : t('common.off'), t('settings.smartUpdateDesc'))}
            {displayRow(t('settings.similarityThreshold'), (config.sieve?.similarityThreshold ?? 0.35).toFixed(2), t('settings.similarityThresholdDesc'))}
            {displayRow(t('settings.exactDupThreshold'), (config.sieve?.exactDupThreshold ?? 0.08).toFixed(2), t('settings.exactDupThresholdDesc'))}
            {displayRow(t('settings.relationExtraction'), (config.sieve?.relationExtraction ?? true) ? t('common.on') : t('common.off'), t('settings.relationExtractionDesc'))}
            {displayRow(t('settings.logPreviewPerMsg'), config.sieve?.extractionLogPreviewCharsPerMessage ?? 60, t('settings.logPreviewPerMsgDesc'))}
            {displayRow(t('settings.logPreviewMax'), config.sieve?.extractionLogPreviewMaxChars ?? 300, t('settings.logPreviewMaxDesc'))}
          </tbody>
        </table>
      )}
    </div>
  );
}
