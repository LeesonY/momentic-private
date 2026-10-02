import React, { createContext, useContext, useState, useEffect } from 'react';
import type { User, Project } from '@localqa/contracts';
import { defaultApiClient, isUsingMock, setUseMock } from '../api/index.ts';

export type AppRoute =
  | 'home'
  | 'workbench'
  | 'case-detail'
  | 'finding-detail'
  | 'environments'
  | 'knowledge'
  | 'models'
  | 'members-ops'
  | 'login';

interface AppContextValue {
  currentUser: User | null;
  projects: Project[];
  currentProject: Project | null;
  currentRoute: AppRoute;
  routeParams: Record<string, string>;
  isMock: boolean;
  setRoute: (route: AppRoute, params?: Record<string, string>) => void;
  setCurrentProject: (project: Project) => void;
  toggleMock: (enabled: boolean) => void;
  logout: () => Promise<void>;
  login: (username: string) => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

import { mockCurrentUser, mockProject } from '../mocks/data.ts';

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [isMock] = useState(isUsingMock());
  const [currentUser, setCurrentUser] = useState<User | null>(
    isUsingMock() ? mockCurrentUser : null,
  );
  const [projects, setProjects] = useState<Project[]>(
    isUsingMock() ? [mockProject] : [],
  );
  const [currentProject, setCurrentProject] = useState<Project | null>(
    isUsingMock() ? mockProject : null,
  );
  const [currentRoute, setCurrentRouteState] = useState<AppRoute>('home');
  const [routeParams, setRouteParams] = useState<Record<string, string>>({});

  // Parse location hash on load to restore page location & params after refresh!
  useEffect(() => {
    function parseHash() {
      const hash = window.location.hash.replace(/^#\/?/, '');
      if (!hash) {
        setCurrentRouteState('home');
        setRouteParams({});
        return;
      }

      const [routePart, queryPart] = hash.split('?');
      const params: Record<string, string> = {};
      if (queryPart) {
        new URLSearchParams(queryPart).forEach((val, key) => {
          params[key] = val;
        });
      }

      setCurrentRouteState((routePart as AppRoute) || 'home');
      setRouteParams(params);
    }

    parseHash();
    window.addEventListener('hashchange', parseHash);
    return () => window.removeEventListener('hashchange', parseHash);
  }, []);

  // Update hash when route changes
  const setRoute = (route: AppRoute, params: Record<string, string> = {}) => {
    setCurrentRouteState(route);
    setRouteParams(params);

    const query = new URLSearchParams(params).toString();
    const hash = query ? `#/${route}?${query}` : `#/${route}`;
    window.location.hash = hash;
  };

  // Initial user & project load
  useEffect(() => {
    async function init() {
      try {
        const user = await defaultApiClient.currentUser();
        setCurrentUser(user);

        const projRes = await defaultApiClient.listProjects();
        setProjects(projRes.items);
        if (projRes.items.length > 0) {
          setCurrentProject(projRes.items[0]);
        }
      } catch (err) {
        console.warn('Initial session fetch failed:', err);
      }
    }
    init();
  }, []);

  const login = async (username: string) => {
    const res = await defaultApiClient.login({ username });
    setCurrentUser(res.user);
    setRoute('home');
  };

  const logout = async () => {
    await defaultApiClient.logout();
    setCurrentUser(null);
    setRoute('login');
  };

  return (
    <AppContext.Provider
      value={{
        currentUser,
        projects,
        currentProject,
        currentRoute,
        routeParams,
        isMock,
        setRoute,
        setCurrentProject,
        toggleMock: setUseMock,
        logout,
        login,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within an AppProvider');
  return ctx;
}

export const useAppContext = useApp;
