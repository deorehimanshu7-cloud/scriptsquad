import type { ReactNode } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useApp } from "../../lib/state";
import { EmptyState } from "../../components/ui";
import { LangSwitch, useI18n } from "../../lib/i18n";

const VOICE_BOT_URL = (import.meta.env.VITE_VOICE_BOT_URL as string | undefined)?.trim() ?? "";

const NAV: { to?: string; labelKey?: string; icon?: string; end?: boolean; sectionKey?: string }[] = [
  { to: "/app", labelKey: "nav.world", icon: "🗺️", end: true },
  { to: "/app/twin", labelKey: "nav.twin", icon: "🧊" },
  { to: "/app/evidence", labelKey: "nav.evidence", icon: "🧬" },
  { sectionKey: "sec.layers" },
  { to: "/app/weather", labelKey: "nav.weather", icon: "🌦️" },
  { to: "/app/water", labelKey: "nav.water", icon: "🌊" },
  { to: "/app/soil", labelKey: "nav.soil", icon: "🟫" },
  { to: "/app/terrain", labelKey: "nav.terrain", icon: "⛰️" },
  { to: "/app/crop", labelKey: "nav.crop", icon: "🌱" },
  { sectionKey: "sec.intel" },
  { to: "/app/intelligence", labelKey: "nav.intelligence", icon: "🧠" },
  { to: "/app/investigations", labelKey: "nav.investigations", icon: "🔬" },
  { to: "/app/satellite", labelKey: "nav.satellite", icon: "🛰️" },
  { to: "/app/sensors", labelKey: "nav.sensors", icon: "📡" },
  { to: "/app/simulation", labelKey: "nav.simulation", icon: "🧪" },
  { to: "/app/history", labelKey: "nav.history", icon: "🕰️" },
  { to: "/app/assistant", labelKey: "nav.assistant", icon: "💬" },
  { to: "/app/voice", labelKey: "nav.voice", icon: "🎙️" },
  { to: "/app/system", labelKey: "nav.system", icon: "⚙️" },
  { to: "/app/fields", labelKey: "nav.fields", icon: "🏡" },
];

export default function AppLayout() {
  const { user, fields, activeFieldId, activeField, setActiveField, live, logout, booting, events } = useApp();
  const { t } = useI18n();
  const navigate = useNavigate();

  if (booting) {
    return (
      <div className="loading-block" style={{ height: "100vh" }}>
        <span className="spinner" /> {t("shell.loading")}
      </div>
    );
  }

  const fieldSelector = (
    <div className="field" style={{ marginBottom: 12 }}>
      <label htmlFor="field-switch">{t("shell.activeField")}</label>
      <select
        id="field-switch"
        className="select"
        value={activeFieldId ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          if (v) {
            setActiveField(v);
            navigate("/app");
          }
        }}
      >
        <option value="" disabled>
          {fields.length === 0 ? t("shell.noFields") : t("shell.selectField")}
        </option>
        {fields.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      {activeField && (
        <div className="faint" style={{ fontSize: 11.5, lineHeight: 1.5, marginTop: 6 }}>
          {activeField.crop_name ? `${t("nav.crop")}: ${activeField.crop_name} · ` : ""}
          {activeField.farm_name ?? "—"}
          <br />
          {activeField.area_m2 ? `${(activeField.area_m2 / 10_000).toFixed(1)} ha` : "—"} ·{" "}
          {activeField.centroid_lat.toFixed(3)}, {activeField.centroid_lon.toFixed(3)}
        </div>
      )}
    </div>
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="row" style={{ gap: 10, padding: "2px 6px 14px" }}>
          <span style={{ width: 30, height: 30, borderRadius: 8, background: "linear-gradient(135deg,#2a9d5b,#3fd97c)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}>🌾</span>
          <div>
            <div style={{ fontWeight: 750, letterSpacing: "-0.02em", lineHeight: 1.1 }}>AGRIFUR<span style={{ color: "var(--accent)" }}>2</span></div>
            <div className="faint" style={{ fontSize: 10.5 }}>{t("shell.farmModel")}</div>
          </div>
        </div>

        {fieldSelector}

        <nav className="col" style={{ gap: 2, marginTop: 4 }}>
          {NAV.filter((n) => n.to !== "/app/voice" || VOICE_BOT_URL !== "").map((n) =>
            n.sectionKey ? (
              <div key={n.sectionKey} className="section-label" style={{ margin: "10px 10px 2px" }}>
                {t(n.sectionKey)}
              </div>
            ) : (
              <NavLink key={n.to} to={n.to!} end={n.end} className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
                <span className="nav-ico">{n.icon}</span>
                {t(n.labelKey!)}
              </NavLink>
            ),
          )}
        </nav>

        <div className="grow" />

        {fields.length === 0 && (
          <Link to="/app/fields" className="btn btn-primary btn-sm" style={{ width: "100%", marginBottom: 8 }}>
            {t("shell.createField")}
          </Link>
        )}
        <div className="row" style={{ padding: "10px 6px 0", borderTop: "1px solid var(--border)" }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {user?.name}
            </div>
            <div className="faint" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {user?.email}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => { logout(); navigate("/"); }} type="button" title={t("shell.signOut")}>
            ⎋
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div className="row" style={{ gap: 10 }}>
            <span className={`pulse ${live ? "" : ""}`} style={live ? undefined : { background: "var(--text-faint)", animation: "none" }} />
            <span className="faint" style={{ fontSize: 12 }}>
              {live ? t("shell.live") : t("shell.reconnecting")}
            </span>
          </div>
          <div className="grow" />
          <LangSwitch compact />
          <span className="faint" style={{ fontSize: 12, marginLeft: 8 }}>{events.length > 0 ? t("shell.recentEvents", { n: events.length }) : ""}</span>
          {activeField && (
            <span className="badge ts-OBSERVED badge-lg" title="Field locked to the active selection; switching fields clears downstream state">
              {t("shell.fieldBadge", { name: activeField.name })}
            </span>
          )}
        </div>
        <Outlet />
      </main>
    </div>
  );
}

export function RequireField({ children }: { children: ReactNode }) {
  const { fields, activeField } = useApp();
  const { t } = useI18n();
  if (fields.length === 0) {
    return (
      <div className="page">
        <EmptyState
          emoji="🧭"
          title={t("shell.noFieldsTitle")}
          body={t("shell.noFieldsBody")}
          action={<Link to="/app/fields" className="btn btn-primary">{t("shell.createFieldBtn")}</Link>}
        />
      </div>
    );
  }
  if (!activeField) {
    return (
      <div className="page">
        <EmptyState
          emoji="🗺️"
          title={t("shell.selectTitle")}
          body={t("shell.selectBody")}
        />
      </div>
    );
  }
  return <>{children}</>;
}