import React from 'react';
import { useApp } from './state/AppContext.tsx';
import { AppHeader } from './components/layout/AppHeader.tsx';
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

export const App: React.FC = () => {
  const { currentRoute, currentUser, sessionLoading } = useApp();

  // While validating initial session (cookie-based auth), render minimal placeholder
  // to avoid flashing LoginPage and breaking browser automation scripts.
  if (sessionLoading) {
    return (
      <div
        data-testid="app-session-loading"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          color: 'var(--color-text-muted)',
          fontSize: '0.9rem',
        }}
      >
        正在验证会话凭据...
      </div>
    );
  }

  // If not logged in and not already on login route, show login
  if (!currentUser && currentRoute !== 'login') {
    return <LoginPage />;
  }

  switch (currentRoute) {
    case 'login':
      return <LoginPage />;
    case 'home':
      return (
        <div className="app-container">
          <AppHeader />
          <main className="main-content">
            <ProjectHomePage />
          </main>
        </div>
      );
    case 'workbench':
      return <WorkbenchPage />;
    case 'case-detail':
      return <CaseDetailPage />;
    case 'finding-detail':
      return <FindingDetailPage />;
    case 'saved-cases':
      return <SavedCasesPage />;
    case 'saved-case-detail':
      return <SavedCaseDetailPage />;
    case 'modules':
      return <ModulesPage />;
    case 'environments':
      return <EnvironmentsPage />;
    case 'knowledge':
      return <KnowledgePage />;
    case 'models':
      return <ModelsPage />;
    case 'members-ops':
      return <MembersOpsPage />;
    default:
      return (
        <div className="app-container">
          <AppHeader />
          <main className="main-content">
            <ProjectHomePage />
          </main>
        </div>
      );
  }
};
