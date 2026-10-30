/**
 * RulesView — the Rules section host.
 *
 * What used to be four separate sidebar destinations — Sources (with its bulk
 * import mode), Modules, Custom Rules, and the compiled-output browser — is
 * one workshop now: the corpus the protection is made of. The views are
 * mounted unchanged behind SectionTabs; the only wiring that changes is
 * navigation, which moves from `setCurrentView(string)` to routes.
 */

import React, { useEffect, useState } from 'react';
import { SectionTabs, panelId, tabId } from '../components/SectionTabs';
import { sectionById, type AppRoute } from '../routes';
import { SourcesView } from './SourcesView';
import { ModulesView } from './ModulesView';
import { CustomRulesView } from './CustomRulesView';
import { RuleBrowserView } from './RuleBrowserView';
import type { FilterSource } from '../types';

interface RulesViewProps {
  initialTab?: string;
  /**
   * One-shot deep link into SourcesView's bulk mode (the legacy 'bulkImport'
   * route). Armed only when 'bulk' — SourcesView flips to it, then the host
   * reports it consumed so a remount cannot resurrect it.
   */
  feedsInitialTab?: 'bulk' | null;
  onFeedsInitialTabConsumed?: () => void;
  sources: FilterSource[];
  saveSources: (
    updatedSources: FilterSource[],
    successMsg?: string,
  ) => Promise<void>;
  onTriggerCompile: () => void;
  navigate: (route: AppRoute) => void;
  setError: (error: string | null) => void;
  setSuccessMessage: (message: string | null) => void;
}

const TABS = sectionById('rules').tabs;

export const RulesView: React.FC<RulesViewProps> = ({
  initialTab,
  feedsInitialTab,
  onFeedsInitialTabConsumed,
  sources,
  saveSources,
  onTriggerCompile,
  navigate,
  setError,
  setSuccessMessage,
}) => {
  const valid = (id: string | undefined) =>
    TABS.some((t) => t.id === id) ? id! : TABS[0].id;
  const [tab, setTab] = useState<string>(() => valid(initialTab));

  // Re-drive the host when a deep link arrives while it is already mounted.
  useEffect(() => {
    if (initialTab) setTab(valid(initialTab));
  }, [initialTab]);

  // Tab clicks switch the panel AND keep the shell's route.tab in sync —
  // the header title and tab-* scroll classes are route-derived.
  const select = (id: string) => {
    setTab(id);
    navigate({ section: 'rules', tab: id });
  };

  // The bulk deep link is one-shot: SourcesView armed it, now disarm.
  useEffect(() => {
    if (feedsInitialTab === 'bulk') onFeedsInitialTabConsumed?.();
  }, [feedsInitialTab, onFeedsInitialTabConsumed]);

  return (
    <div className="section-host">
      <SectionTabs
        tabs={TABS}
        activeId={tab}
        onSelect={select}
        ariaLabel="Rules sections"
      />
      <div role="tabpanel" id={panelId(tab)} aria-labelledby={tabId(tab)}>
        {tab === 'feeds' && (
          <SourcesView
            sources={sources}
            saveSources={saveSources}
            setError={setError}
            setSuccessMessage={setSuccessMessage}
            initialTab={feedsInitialTab ?? undefined}
          />
        )}
        {tab === 'modules' && (
          <ModulesView
            sources={sources}
            saveSources={saveSources}
            onTriggerCompile={onTriggerCompile}
            onNavigateDeploy={() => navigate({ section: 'distribute', tab: null })}
            setError={setError}
            setSuccessMessage={setSuccessMessage}
          />
        )}
        {tab === 'custom' && (
          <CustomRulesView setError={setError} setSuccessMessage={setSuccessMessage} />
        )}
        {tab === 'output' && <RuleBrowserView onTriggerCompile={onTriggerCompile} />}
      </div>
    </div>
  );
};
