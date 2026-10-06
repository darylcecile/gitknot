import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { BookOpen, ChevronDown, FolderGit2, Home, Inbox, LogOut, Menu, Search, Settings, Users, Wallet, X } from "lucide-react";
import { useAuth } from "../auth.tsx";
import { useCollection } from "../api/hooks.ts";
import { endpoints } from "../api/endpoints.ts";
import { activeViewerRepository, apiUrl, setViewerGrant } from "../api/client.ts";
import type { Account } from "../api/types.ts";
import { Avatar, Button, ErrorNotice, Notice } from "./ui.tsx";
import { Popover } from "./popover.tsx";

const links = [
  { to: "/", label: "Overview", icon: Home, end: true },
  { to: "/repos", label: "Repositories", icon: FolderGit2 },
  { to: "/inbox", label: "Inbox", icon: Inbox },
];
const accountLinks = [
  { to: "/accounts", label: "Accounts & teams", icon: Users },
  { to: "/billing", label: "Billing & usage", icon: Wallet },
  { to: "/settings", label: "Settings", icon: Settings },
  { to: "/docs", label: "Documentation", icon: BookOpen },
];

export function AppLayout() {
  const { session, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebar, setSidebar] = useState(false);
  const [logoutError, setLogoutError] = useState<Error | null>(null);
  const accounts = useCollection<Account>(session ? endpoints.accounts : null);
  const mobile = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setSidebar(false);
    document.getElementById("main-content")?.focus({ preventScroll: true });
  }, [location.pathname]);
  useEffect(() => {
    if (sidebar && !mobile.current?.open) mobile.current?.showModal();
    else if (!sidebar) mobile.current?.close();
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
  const signOut = () => {
    void logout().then(() => navigate("/auth/login"))
      .catch(cause => setLogoutError(cause instanceof Error ? cause : new Error("Could not sign out. Try again.")));
  };
  const navigation = (className: string) => <nav aria-label="Main navigation" className={className}>
    {links.filter(link => session || link.to === "/repos").map(link => <NavLink key={link.to} to={link.to} end={link.end}>
      <link.icon size={16} aria-hidden="true" /><span>{link.label}</span>
    </NavLink>)}
  </nav>;
  return <div className="app">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="topbar">
      <Button className="mobile-menu" variant="ghost" aria-label="Open navigation" onClick={() => setSidebar(true)}><Menu size={20} aria-hidden="true" /></Button>
      <Link to="/" className="brand" aria-label="GitKnot home"><img src="/favicon.svg" alt="" width="26" height="26" /><span>GitKnot</span></Link>
      {navigation("top-navigation")}
      <form className="global-search" role="search" onSubmit={event => {
        event.preventDefault();
        navigate(`/search${searchRef.current?.value ? `?q=${encodeURIComponent(searchRef.current.value)}` : ""}`);
      }}>
        <Search size={16} aria-hidden="true" />
        <input ref={searchRef} name="q" aria-label="Search GitKnot" placeholder="Search GitKnot…" autoComplete="off" />
        <kbd aria-hidden="true">⌘ K</kbd>
      </form>
      {session ? <Popover label="Account menu" className="account-popover" trigger={<>
        <Avatar name={session.user.display_name || session.user.username} url={session.user.avatar_url} small decorative /><ChevronDown size={12} aria-hidden="true" />
      </>}>
        {close => <div className="account-menu">
          <div className="account-menu-heading"><strong>{session.user.display_name || session.user.username}</strong><span>@{session.user.username}</span></div>
          <Link to={`/users/${session.user.username}`} onClick={() => close(false)}>Your profile</Link>
          {accountLinks.map(link => <NavLink key={link.to} to={link.to} onClick={() => close(false)}><link.icon size={16} aria-hidden="true" />{link.label}</NavLink>)}
          {accounts.items.length > 0 && <div className="account-switch"><label htmlFor="workspace-select">Go to account</label>
            <select id="workspace-select" value="" onChange={event => { navigate(`/accounts/${encodeURIComponent(event.target.value)}`); close(false); }}>
              <option value="" disabled>Choose an account…</option>
              {accounts.items.map(account => <option key={account.id} value={account.id}>{account.name} (@{account.slug})</option>)}
            </select>
          </div>}
          <button type="button" className="sign-out" onClick={() => { signOut(); close(false); }}><LogOut size={16} aria-hidden="true" />Sign out</button>
        </div>}
      </Popover> : <Link className="button button-secondary" to="/auth/login">Sign in</Link>}
    </header>
    <dialog className="mobile-sidebar" aria-label="Workspace navigation" ref={mobile}
      onCancel={() => setSidebar(false)} onClose={() => setSidebar(false)}>
      <div className="drawer-heading"><Link to="/" className="brand"><img src="/favicon.svg" alt="" width="26" height="26" />GitKnot</Link>
        <Button variant="ghost" aria-label="Close navigation" onClick={() => setSidebar(false)}><X size={20} aria-hidden="true" /></Button></div>
      {navigation("main-navigation")}
      <nav aria-label="Account navigation" className="main-navigation secondary-navigation">
        {accountLinks.map(link => <NavLink key={link.to} to={link.to}><link.icon size={18} aria-hidden="true" />{link.label}</NavLink>)}
      </nav>
    </dialog>
    <div className="app-body">
      <main id="main-content" tabIndex={-1} className="main-content">
        <ErrorNotice error={logoutError} />
        {activeViewerRepository() && <Notice>Viewing with read-only access. <Button onClick={() => { setViewerGrant(null); window.location.reload(); }}>Leave viewer access</Button></Notice>}
        {session?.user.email_verified_at === null && <Notice>Verify your email to activate your account. <Link to="/auth/verify">Enter your verification code</Link>.</Notice>}
        <Outlet />
      </main>
      <footer className="app-footer"><span>GitKnot</span><Link to="/docs">Docs</Link><Link to="/support">Support</Link><Link to="/help">Keyboard shortcuts</Link><a href={apiUrl("/openapi.json")}>API</a></footer>
    </div>
  </div>;
}
