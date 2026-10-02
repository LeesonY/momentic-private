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

export const App: React.FC = () => {
  const { currentRoute, currentUser } = useApp();

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
