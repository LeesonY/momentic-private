import React, {
  createContext,
  useCallback,
  useContext,
  useState,
  useEffect,
} from 'react';
import type { User, Project } from '@localqa/contracts';
import { defaultApiClient, isUsingMock, setUseMock } from '../api/index.ts';
import { nextProjectAfterRemoval } from '../utils/projectAdmin.ts';

export type AppRoute =
  | 'home'
  | 'sessions'
  | 'workbench'
  | 'case-detail'
  | 'finding-detail'
  | 'saved-cases'
  | 'schedules'
  | 'saved-case-detail'
  | 'modules'
  | 'environments'
  | 'knowledge'
  | 'models'
  | 'projects'
  | 'members-ops'
  | 'login';

interface AppContextValue {
  currentUser: User | null;
  projects: Project[];
  currentProject: Project | null;
  currentRoute: AppRoute;
  routeParams: Record<string, string>;
  isMock: boolean;
  sessionLoading: boolean;
  setRoute: (route: AppRoute, params?: Record<string, string>) => void;
  setCurrentProject: (project: Project) => void;
  replaceProject: (project: Project) => void;
  removeProject: (projectId: string) => void;
  createProject: (name: string) => Promise<Project>;
  /** Re-read the project list (admin pages act on projects outside the shell). */
  refreshProjects: () => Promise<Project[]>;
  toggleMock: (enabled: boolean) => void;
  logout: () => Promise<void>;
  login: (username: string, password?: string) => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

import { mockCurrentUser, mockProject } from '../mocks/data.ts';

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [isMock] = useState(isUsingMock());
  const [currentUser, setCurrentUser] = useState<User | null>(
    isUsingMock() ? mockCurrentUser : null,
  );
  const [sessionLoading, setSessionLoading] = useState<boolean>(!isUsingMock());
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

  const createProject = async (name: string): Promise<Project> => {
    if (!currentUser || currentUser.globalRole !== 'admin') {
      throw new Error('仅平台管理员可以创建项目');
    }
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 120) {
      throw new Error('项目名称长度必须为 1–120 个字符');
    }
    const created = await defaultApiClient.createProject({ name: trimmed });
    setProjects((previous) => [
      created,
      ...previous.filter((p) => p.id !== created.id),
    ]);
    setCurrentProject(created);
    setRoute('home');
    return created;
  };

  const replaceProject = (project: Project) => {
    setProjects((previous) =>
      previous.map((p) => (p.id === project.id ? project : p)),
    );
    setCurrentProject((previous) =>
      previous?.id === project.id ? project : previous,
    );
  };

  /** Update the client selection only after a confirmed 204 deletion. */
  const removeProject = (projectId: string) => {
    const deletingCurrent = currentProject?.id === projectId;
    // Shared rule with the projects page: first active project, then anything
    // left, then the empty state.
    const next = nextProjectAfterRemoval(projects, projectId);
    setProjects(projects.filter((project) => project.id !== projectId));
    // The route stays where the user is: the page that deletes a project keeps
    // showing the list it just changed.
    if (deletingCurrent) setCurrentProject(next);
  };

  // Stable identity: pages list it as an effect dependency.
  const refreshProjects = useCallback(async (): Promise<Project[]> => {
    const page = await defaultApiClient.listProjects();
    // Archived projects stay listed: the page manages them too.
    const items = page.items;
    setProjects(items);
    setCurrentProject((previous) => {
      const stillThere = previous
        ? items.find((project) => project.id === previous.id)
        : undefined;
      // The project disappeared while we were away: same rule as after a
      // deletion, excluding the id that is gone.
      return stillThere ?? nextProjectAfterRemoval(items, previous?.id ?? '');
    });
    return items;
  }, []);

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
      } finally {
        setSessionLoading(false);
      }
    }
    init();
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      (
        window as unknown as {
          __LOCALQA_CURRENT_PROJECT__?: Project | null;
        }
      ).__LOCALQA_CURRENT_PROJECT__ = currentProject;
    }
  }, [currentProject]);

  const login = async (username: string, password = '') => {
    const res = await defaultApiClient.login({
      email: username,
      password,
    });
    setCurrentUser(res.user);
    try {
      const projRes = await defaultApiClient.listProjects();
      setProjects(projRes.items);
      if (projRes.items.length > 0) {
        setCurrentProject(projRes.items[0]);
      }
    } catch {
      // ignore
    }
    setRoute('home');
  };

  const logout = async () => {
    try {
      await defaultApiClient.logout();
    } catch {
      // ignore
    }
    setCurrentUser(null);
    setCurrentProject(null);
    setProjects([]);
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
        sessionLoading,
        setRoute,
        setCurrentProject,
        replaceProject,
        removeProject,
        createProject,
        refreshProjects,
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
