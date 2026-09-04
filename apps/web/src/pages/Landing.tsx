import { Link } from "react-router-dom";
import { LangSwitch, useI18n } from "../lib/i18n";

const LAYERS_KEYS = ["land.layer1", "land.layer2", "land.layer3", "land.layer4", "land.layer5", "land.layer6", "land.layer7", "land.layer8"];

export default function Landing() {
  const { t } = useI18n();

  const pillars = [
    { icon: "🧭", titleKey: "land.pillar1t", bodyKey: "land.pillar1b" },
    { icon: "🧬", titleKey: "land.pillar2t", bodyKey: "land.pillar2b" },
    { icon: "🛰️", titleKey: "land.pillar3t", bodyKey: "land.pillar3b" },
    { icon: "🌊", titleKey: "land.pillar4t", bodyKey: "land.pillar4b" },
    { icon: "⚙️", titleKey: "land.pillar5t", bodyKey: "land.pillar5b" },
    { icon: "🧠", titleKey: "land.pillar6t", bodyKey: "land.pillar6b" },
  ];

  return (
    <div className="landing">
      <header className="row spread" style={{ padding: "18px 26px", borderBottom: "1px solid var(--border)" }}>
        <div className="row" style={{ gap: 10 }}>
          <span style={{ width: 30, height: 30, borderRadius: 8, background: "linear-gradient(135deg,#2a9d5b,#3fd97c)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>🌾</span>
          <strong style={{ letterSpacing: "-0.02em" }}>AGRIFUR<span style={{ color: "var(--accent)" }}>2</span></strong>
        </div>
        <div className="row" style={{ gap: 14 }}>
          <LangSwitch compact />
          <Link to="/auth" className="btn btn-ghost">{t("land.signIn")}</Link>
          <Link to="/auth?mode=register" className="btn btn-primary">{t("land.enterField")}</Link>
        </div>
      </header>

      <div className="landing-hero">
        <div className="pill-row">
          <span className="static-pill">{t("land.pill1")}</span>
          <span className="static-pill">{t("land.pill2")}</span>
          <span className="static-pill">{t("land.pill3")}</span>
          <span className="static-pill">{t("land.pill4")}</span>
        </div>
        <h1 className="hero-title mt-16">
          {t("land.titleA")} <span className="hero-grad">{t("land.titleGrad")}</span>
          <br />
          {t("land.titleB")}
        </h1>
        <p className="hero-sub">{t("land.sub")}</p>
        <div className="hero-cta">
          <Link to="/auth?mode=register" className="btn btn-primary" style={{ padding: "12px 22px", fontSize: 15 }}>{t("land.ctaBuild")}</Link>
          <Link to="/auth" className="btn" style={{ padding: "12px 22px", fontSize: 15 }}>{t("land.ctaExplore")}</Link>
        </div>
        <div className="pill-row" style={{ marginTop: 20 }}>
          <span className="static-pill mono">Sentinel-2 · Sentinel-1 (Copernicus STAC)</span>
          <span className="static-pill mono">Open-Meteo</span>
          <span className="static-pill mono">ISRIC SoilGrids</span>
          <span className="static-pill mono">India-WRIS / CGWB (credential-gated)</span>
        </div>
      </div>

      <div className="landing-section">
        <h2>{t("land.sec1Title")}</h2>
        <p className="muted mb-16" style={{ maxWidth: 760 }}>
          {t("land.sec1Body")}
        </p>
        <div className="grid grid-3">
          {pillars.map((p) => (
            <div className="card" key={p.titleKey}>
              <div style={{ fontSize: 22 }}>{p.icon}</div>
              <h3 className="mt-8" style={{ fontSize: 15 }}>{t(p.titleKey)}</h3>
              <p className="muted" style={{ fontSize: 13, margin: "6px 0 0" }}>{t(p.bodyKey)}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="landing-section">
        <div className="grid grid-2" style={{ alignItems: "start" }}>
          <div className="card">
            <div className="card-title"><span className="dot" />{t("land.pipeTitle")}</div>
            <div className="col" style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--text-dim)", gap: 7 }}>
              <span>REAL FIELD</span>
              <span style={{ color: "var(--text-faint)" }}>↓</span>
              <span>GEO-ANCHORING → 8-LAYER EVIDENCE STACK</span>
              <span style={{ color: "var(--text-faint)" }}>↓</span>
              <span>QUALITY VALIDATION → NORMALIZATION → FUSION</span>
              <span style={{ color: "var(--text-faint)" }}>↓</span>
              <span style={{ color: "var(--accent)" }}>FARM WORLD MODEL</span>
              <span style={{ color: "var(--text-faint)" }}>↓</span>
              <span>ANOMALY · RISK · UNCERTAINTY · CONTRADICTION</span>
              <span style={{ color: "var(--text-faint)" }}>↓</span>
              <span>INVESTIGATION · HYPOTHESIS · INFORMATION-GAIN</span>
              <span style={{ color: "var(--text-faint)" }}>↓</span>
              <span>ADVISORY → VERIFICATION → WORLD MODEL UPDATE</span>
              <span style={{ color: "var(--text-faint)" }}>↓</span>
              <span>FARM MEMORY</span>
            </div>
          </div>
          <div className="card">
            <div className="card-title"><span className="dot" />{t("land.layersTitle")}</div>
            <div className="col" style={{ gap: 5 }}>
              {LAYERS_KEYS.map((k) => (
                <div key={k} className="row" style={{ padding: "6px 10px", background: "rgba(141,199,161,0.05)", borderRadius: 8, border: "1px solid var(--border)", fontFamily: "var(--mono)", fontSize: 12.5 }}>
                  <span className="faint">■</span> {t(k)}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="landing-section" style={{ textAlign: "center", paddingBottom: 80 }}>
        <h2>{t("land.sec2Title")}</h2>
        <p className="muted" style={{ maxWidth: 640, margin: "10px auto 22px" }}>
          {t("land.sec2Body")}
        </p>
        <Link to="/auth?mode=register" className="btn btn-primary" style={{ padding: "12px 26px", fontSize: 15 }}>{t("land.ctaCreate")}</Link>
      </div>

      <footer className="landing-footer">
        {t("land.footer")} <span className="mono">scriptsquad</span>
      </footer>
    </div>
  );
}