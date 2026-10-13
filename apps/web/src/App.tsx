import React from 'react';
import { useApp, type AppRoute } from './state/AppContext.tsx';
import { AppShell } from './components/layout/AppShell.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { ProjectHomePage } from './pages/ProjectHomePage.tsx';
import { WorkbenchPage } from './pages/WorkbenchPage.tsx';
import { CaseDetailPage } from './pages/CaseDetailPage.tsx';
import { FindingDetailPage } from './pages/FindingDetailPage.tsx';
import { EnvironmentsPage } from './pages/EnvironmentsPage.tsx';
import { KnowledgePage } from './pages/KnowledgePage.tsx';
import { ModelsPage } from './pages/ModelsPage.tsx';
import { MembersOpsPage } from './pages/MembersOpsPage.tsx';
import { SavedCasesPage } from './pages/SavedCasesPage.tsx';
import { SavedCaseDetailPage } from './pages/SavedCaseDetailPage.tsx';
import { ModulesPage } from './pages/ModulesPage.tsx';
import { SchedulesPage } from './pages/SchedulesPage.tsx';
import { SessionsPage } from './pages/SessionsPage.tsx';

const pages: Record<Exclude<AppRoute, 'login'>, React.FC> = {
  home: ProjectHomePage,
  sessions: SessionsPage,
  workbench: WorkbenchPage,
  'case-detail': CaseDetailPage,
  'finding-detail': FindingDetailPage,
  'saved-cases': SavedCasesPage,
  schedules: SchedulesPage,
  'saved-case-detail': SavedCaseDetailPage,
  modules: ModulesPage,
  environments: EnvironmentsPage,
  knowledge: KnowledgePage,
  models: ModelsPage,
  'members-ops': MembersOpsPage,
};

export const App: React.FC = () => {
  const { currentRoute, currentUser, sessionLoading } = useApp();

  // While validating the initial cookie session, render a placeholder to avoid
  // flashing the login page and breaking browser automation scripts.
  if (sessionLoading) {
    return (
      <div className="lqa-session-loading" data-testid="app-session-loading">
        正在验证会话凭据...
      </div>
    );
  }

  if (!currentUser || currentRoute === 'login') return <LoginPage />;

  const CurrentPage = pages[currentRoute] ?? ProjectHomePage;
  return (
    <AppShell>
      <CurrentPage />
    </AppShell>
  );
};
