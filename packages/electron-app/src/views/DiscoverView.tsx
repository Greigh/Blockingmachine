/**
 * DiscoverView — the Discover section host.
 *
 * The investigation workbench: Radar finds candidate offenders, the AI engine
 * configuration that powers it sits one tab over, and Inspect answers "why
 * is/isn't this domain covered?". Radar's old cross-app jump to the inspector
 * is a tab switch now that carries the domain with it.
 */

import React, { useEffect, useState } from 'react';
import { SectionTabs, panelId, tabId } from '../components/SectionTabs';
import { sectionById, type AppRoute } from '../routes';
import { AIRadarView } from './AIRadarView';
import { AiEnginePane } from '../components/AiEnginePane';
import { RuleInspectorView } from './RuleInspectorView';
import type { LiveRadarSession } from '../types/';

interface DiscoverViewProps {
  initialTab?: string;
  liveRadarSession?: LiveRadarSession | null;
  onTriggerCompile: () => void;
  navigate: (route: AppRoute) => void;
  setError: (error: string | null) => void;
  setSuccessMessage: (message: string | null) => void;
}

const TABS = sectionById('discover').tabs;

export const DiscoverView: React.FC<DiscoverViewProps> = ({
  initialTab,
  liveRadarSession,
  onTriggerCompile,
  navigate,
  setError,
  setSuccessMessage,
}) => {
  const valid = (id: string | undefined) =>
    TABS.some((t) => t.id === id) ? id! : TABS[0].id;
  const [tab, setTab] = useState<string>(() => valid(initialTab));
  const [domain, setDomain] = useState<string | undefined>();

  // Re-drive the host when a deep link arrives while it is already mounted
  // (the app shell can re-render with a new route.tab rather than remounting).
  useEffect(() => {
    if (initialTab) setTab(valid(initialTab));
  }, [initialTab]);

  // Tab clicks switch the panel AND keep the shell's route.tab in sync —
  // the header title and tab-* scroll classes are route-derived.
  const select = (id: string) => {
    setTab(id);
    navigate({ section: 'discover', tab: id });
  };

  return (
    <div className="section-host">
      <SectionTabs
        tabs={TABS}
        activeId={tab}
        onSelect={select}
        ariaLabel="Discover sections"
      />
      <div role="tabpanel" id={panelId(tab)} aria-labelledby={tabId(tab)}>
        {tab === 'radar' && (
          <AIRadarView
            liveRadarSession={liveRadarSession}
            onTriggerCompile={onTriggerCompile}
            onNavigateDeploy={() => navigate({ section: 'distribute', tab: null })}
            onNavigateInspector={(d) => {
              if (d) setDomain(d);
              select('inspect');
            }}
            onNavigateSettings={() => select('engine')}
            setError={setError}
            setSuccessMessage={setSuccessMessage}
          />
        )}
        {tab === 'engine' && <AiEnginePane />}
        {tab === 'inspect' && (
          <RuleInspectorView
            initialDomain={domain}
            onNavigateCustomRules={() => navigate({ section: 'rules', tab: 'custom' })}
          />
        )}
      </div>
    </div>
  );
};
