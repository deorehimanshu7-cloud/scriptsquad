import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { authApi } from "../lib/api";
import { useApp } from "../lib/state";
import { ApiError } from "../lib/api";
import { LangSwitch, useI18n } from "../lib/i18n";

export default function Auth() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { login } = useApp();
  const { t } = useI18n();
  const [mode, setMode] = useState<"login" | "register">(params.get("mode") === "register" ? "register" : "login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Development-only demo account: the backend tells us whether it is seeded
  // in THIS database. Hidden in production / when absent — never a bypass.
  const [demoAvailable, setDemoAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authApi
      .demo()
      .then((d) => {
        if (!cancelled) setDemoAvailable(d.available);
      })
      .catch(() => {
        if (!cancelled) setDemoAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res =
        mode === "register" ? await authApi.register(name, email, password) : await authApi.login(email, password);
      login(res.user, res.token);
      const returnTo = params.get("returnTo");
      navigate(returnTo && returnTo.startsWith("/app") ? returnTo : "/app");
    } catch (err) {
      // Backend messages are user-safe (never SQL/stack/paths) — show them.
      setError(err instanceof ApiError ? err.message : t("auth.err"));
    } finally {
      setBusy(false);
    }
  };

  const useDemo = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await authApi.login("demo@agrifur.dev", "agrifur-demo");
      login(res.user, res.token);
      navigate("/app");
    } catch (err) {
      // No bypass: the demo button is a REAL login. If it fails, say why.
      setError(err instanceof ApiError ? err.message : t("auth.demoErr"));
    } finally {
      setBusy(false);
    }
  };

  const busyLabel = busy ? (mode === "register" ? t("auth.creating") : t("auth.signingIn")) : mode === "register" ? t("auth.createAccount") : t("auth.signIn");

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="row" style={{ gap: 10, marginBottom: 18 }}>
          <span style={{ width: 34, height: 34, borderRadius: 9, background: "linear-gradient(135deg,#2a9d5b,#3fd97c)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 17 }}>🌾</span>
          <div>
            <div style={{ fontWeight: 750, letterSpacing: "-0.02em" }}>AGRIFUR<span style={{ color: "var(--accent)" }}>2</span></div>
            <div className="faint" style={{ fontSize: 12 }}>{t("auth.sub")}</div>
          </div>
        </div>

        <div className="row" style={{ justifyContent: "flex-end", marginBottom: 8 }}>
          <LangSwitch compact />
        </div>

        <div className="tabs" style={{ borderBottom: "none", marginBottom: 16 }}>
          <button className={`tab ${mode === "login" ? "active" : ""}`} onClick={() => { setMode("login"); setError(null); }} type="button">{t("auth.signIn")}</button>
          <button className={`tab ${mode === "register" ? "active" : ""}`} onClick={() => { setMode("register"); setError(null); }} type="button">{t("auth.createAccount")}</button>
        </div>

        <form onSubmit={submit}>
          {mode === "register" && (
            <div className="field">
              <label htmlFor="name">{t("auth.fullName")}</label>
              <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("auth.namePh")} required minLength={2} maxLength={120} autoComplete="name" />
            </div>
          )}
          <div className="field">
            <label htmlFor="email">{t("auth.email")}</label>
            <input id="email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("auth.emailPh")} required maxLength={254} autoComplete="email" />
          </div>
          <div className="field">
            <label htmlFor="password">{t("auth.password")}</label>
            <input id="password" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === "register" ? t("auth.passPhReg") : t("auth.passPhLogin")} required minLength={mode === "register" ? 8 : 1} maxLength={200} autoComplete={mode === "register" ? "new-password" : "current-password"} />
          </div>
          {error && <div className="hint hint-warn mb-16">{error}</div>}
          <button className="btn btn-primary" style={{ width: "100%", padding: "11px" }} disabled={busy}>
            {busyLabel}
          </button>
        </form>

        {demoAvailable && (
          <div className="row" style={{ marginTop: 14, justifyContent: "center" }}>
            <button className="btn btn-ghost btn-sm" onClick={useDemo} disabled={busy} type="button">
              {busy ? t("auth.working") : t("auth.useDemo")}
            </button>
          </div>
        )}

        <div className="faint" style={{ fontSize: 11.5, marginTop: 16, textAlign: "center", lineHeight: 1.5 }}>
          {t("auth.footer")}
        </div>
        <div style={{ textAlign: "center", marginTop: 14 }}>
          <Link to="/" className="faint" style={{ fontSize: 12.5 }}>{t("auth.back")}</Link>
        </div>
      </div>
    </div>
  );
}