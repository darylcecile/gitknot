import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import {
  ArrowUpRight,
  Bell,
  BookOpen,
  ChevronDown,
  CircleHelp,
  FolderGit2,
  Home,
  Inbox,
  LogOut,
  Menu,
  Search,
  Settings,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { useAuth } from "../auth.tsx";
import { useCollection } from "../api/hooks.ts";
import { endpoints } from "../api/endpoints.ts";
import {
  activeViewerRepository,
  apiUrl,
  setViewerGrant,
} from "../api/client.ts";
import { type Account, type Repository } from "../api/types.ts";
import { Avatar, Button, ErrorNotice, Notice } from "./ui.tsx";

const links = [
  { to: "/", label: "Overview", icon: Home, end: true },
  { to: "/inbox", label: "Inbox", icon: Inbox },
  { to: "/repos", label: "Repositories", icon: FolderGit2 },
  { to: "/search", label: "Search", icon: Search },
];
const manage = [
  { to: "/accounts", label: "Accounts & teams", icon: Users },
  { to: "/billing", label: "Billing & usage", icon: Wallet },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function AppLayout() {
  const { session, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebar, setSidebar] = useState(false);
  const [logoutError, setLogoutError] = useState<Error | null>(null);
  const accounts = useCollection<Account>(session ? endpoints.accounts : null);
  const repos = useCollection<Repository>(
    session ? `${endpoints.repos}?limit=6` : null,
  );
  const mobile = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setSidebar(false);
    document.getElementById("main-content")?.focus({ preventScroll: true });
  }, [location.pathname]);
  useEffect(() => {
    if (sidebar) mobile.current?.showModal();
    else mobile.current?.close();
  }, [sidebar]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const navigation = (mobileView = false) => (
    <>
      <Link to="/" className="brand">
        <img src="/favicon.svg" alt="" />
        GitKnot
        <span className="brand-dot" />
      </Link>
      <div className="workspace-switch">
        <label htmlFor={mobileView ? "mobile-workspace" : "workspace-select"}>
          Workspace
        </label>
        <div>
          <Users size={16} />
          <select
            id={mobileView ? "mobile-workspace" : "workspace-select"}
            value=""
            onChange={(event) => {
              if (event.target.value)
                navigate(`/accounts/${encodeURIComponent(event.target.value)}`);
            }}
          >
            <option value="" disabled>
              Choose a workspace
            </option>
            {accounts.items.map((account) => (
              <option key={account.id} value={account.id}>
                {account.type === "organization" ? "Organization" : "Personal"}{" "}
                · {account.name} (@{account.slug})
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </div>
      </div>
      <nav aria-label="Main navigation" className="main-navigation">
        {links.map((link) => (
          <NavLink key={link.to} to={link.to} end={link.end}>
            <link.icon size={18} />
            <span>{link.label}</span>
          </NavLink>
        ))}
        <p className="nav-group">Manage</p>
        {manage.map((link) => (
          <NavLink key={link.to} to={link.to}>
            <link.icon size={18} />
            <span>{link.label}</span>
          </NavLink>
        ))}
      </nav>
      {repos.items.length > 0 && (
        <div className="sidebar-repos">
          <div className="nav-group">
            Your repositories
            <Link to="/repos" aria-label="All repositories">
              <ArrowUpRight size={14} />
            </Link>
          </div>
          {repos.items.map((repo) => (
            <NavLink key={repo.id} to={`/repos/${repo.id}`}>
              <span className="repo-letter" aria-hidden="true">
                {repo.name.slice(0, 1).toUpperCase()}
              </span>
              <span>{repo.name}</span>
            </NavLink>
          ))}
        </div>
      )}
      <div className="sidebar-bottom">
        <Link to="/docs">
          <BookOpen size={16} />
          Documentation
        </Link>
        <Link to="/help">
          <CircleHelp size={16} />
          Help & keyboard shortcuts
        </Link>
        {session ? (
          <div className="current-user">
            <Avatar
              name={session.user.display_name || session.user.username}
              url={session.user.avatar_url}
              small
              decorative
            />
            <Link to={`/users/${session.user.username}`}>
              <strong>
                {session.user.display_name || session.user.username}
              </strong>
              <span>@{session.user.username}</span>
            </Link>
            <Button
              variant="ghost"
              aria-label="Sign out"
              onClick={() => {
                void logout()
                  .then(() => navigate("/auth/login"))
                  .catch((cause) => setLogoutError(cause));
              }}
            >
              <LogOut size={15} />
            </Button>
          </div>
        ) : (
          <Link className="button button-primary" to="/auth/login">
            Sign in
          </Link>
        )}
      </div>
    </>
  );
  return (
    <div className="app">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">{navigation()}</aside>
      <dialog
        className="mobile-sidebar"
        aria-label="Workspace navigation"
        ref={mobile}
        onCancel={() => setSidebar(false)}
        onClose={() => setSidebar(false)}
      >
        <Button
          className="mobile-sidebar-close"
          variant="ghost"
          aria-label="Close navigation"
          onClick={() => setSidebar(false)}
        >
          <X size={20} />
        </Button>
        {sidebar && navigation(true)}
      </dialog>
      <div className="app-body">
        <header className="topbar">
          <Button
            className="mobile-menu"
            variant="ghost"
            aria-label="Open navigation"
            onClick={() => setSidebar(true)}
          >
            <Menu size={20} />
          </Button>
          <div className="topbar-context">
            <BookOpen size={16} />
            <span>
              {location.pathname.startsWith("/repos/")
                ? "Repository workspace"
                : location.pathname.startsWith("/docs") ||
                    location.pathname === "/support"
                  ? "Documentation & support"
                  : "Your workspace"}
            </span>
          </div>
          <form
            className="global-search"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              const value = searchRef.current?.value;
              navigate(
                `/search${value ? `?q=${encodeURIComponent(value)}` : ""}`,
              );
            }}
          >
            <Search size={16} />
            <input
              ref={searchRef}
              name="q"
              aria-label="Search GitKnot"
              placeholder="Search anything…"
            />
            <kbd>⌘ K</kbd>
          </form>
          <Link to="/inbox" className="icon-link" aria-label="Open inbox">
            <Bell size={19} />
          </Link>
          {session && (
            <Link
              to={`/users/${session.user.username}`}
              aria-label="Your profile"
            >
              <Avatar
                name={session.user.username}
                url={session.user.avatar_url}
                small
                decorative
              />
            </Link>
          )}
        </header>
        <main id="main-content" tabIndex={-1} className="main-content">
          <ErrorNotice error={logoutError} />
          {activeViewerRepository() && (
            <Notice>
              Viewing with a scoped, read-only grant.{" "}
              <Button
                onClick={() => {
                  setViewerGrant(null);
                  window.location.reload();
                }}
              >
                Leave viewer access
              </Button>
            </Notice>
          )}
          {session?.user.email_verified_at === null && (
            <Notice>
              Verify your email to finish activating your account.{" "}
              <Link to="/auth/verify">Enter your verification code</Link>.
            </Notice>
          )}
          <Outlet />
        </main>
        <footer className="app-footer">
          <span>GitKnot</span>
          <Link to="/help">Help</Link>
          <Link to="/docs">Docs</Link>
          <Link to="/support">Support</Link>
          <a href={apiUrl("/openapi.json")}>API reference</a>
          <span className="footer-tagline">Keep the work connected.</span>
        </footer>
      </div>
    </div>
  );
}
