import { useId } from "react";
import { NavLink, useNavigate } from "react-router";

export type SettingsGroup = { title: string; items: readonly (readonly [string, string])[] };

export function SettingsNavigation({ label, base, section, groups }: {
  label: string; base: string; section: string; groups: SettingsGroup[];
}) {
  const id = useId();
  const navigate = useNavigate();
  return <nav className="settings-navigation" aria-label={label}>
    <label htmlFor={id} className="sr-only">{label} section</label>
    <select className="settings-section-select" id={id} value={section} onChange={event => navigate(`${base}/${event.target.value}`)}>
      {groups.map(group => <optgroup key={group.title} label={group.title}>
        {group.items.map(([path, title]) => <option key={path} value={path}>{title}</option>)}
      </optgroup>)}
    </select>
    <div className="settings-nav-groups">{groups.map(group => <div className="settings-nav-group" key={group.title}>
      <span>{group.title}</span>{group.items.map(([path, title]) => <NavLink key={path} end to={`${base}/${path}`}
        className={path === section ? "active" : ""} aria-current={path === section ? "page" : undefined}>{title}</NavLink>)}
    </div>)}</div>
  </nav>;
}
