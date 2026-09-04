import { Link } from "react-router-dom";
import { useApp } from "../../lib/state";
import { useI18n } from "../../lib/i18n";
import { Card } from "../../components/ui";
import { RequireField } from "./AppLayout";

/**
 * Existing voice-bot embed (Sarvam Farmer AI — see voicebot/).
 * The voice bot stays the voice engine; this page just embeds its UI for the
 * currently selected field. Hidden when VITE_VOICE_BOT_URL is not configured,
 * so default builds are unchanged. Typing fallback → /app/assistant.
 */
const VOICE_BOT_URL = (import.meta.env.VITE_VOICE_BOT_URL as string | undefined)?.trim() ?? "";

export default function VoicePage() {
  return (
    <RequireField>
      <VoiceInner />
    </RequireField>
  );
}

function VoiceInner() {
  const { activeField } = useApp();
  const { lang, t } = useI18n();
  const field = activeField!;

  if (!VOICE_BOT_URL) {
    return (
      <div className="page">
        <div className="page-head">
          <div>
            <div className="page-title">{t("voice.title")}</div>
            <div className="page-sub">{t("voice.unconfigured")}</div>
          </div>
        </div>
        <Card style={{ padding: 20 }}>
          <Link className="btn btn-primary" to="/app/assistant">
            {t("nav.assistant")}
          </Link>
        </Card>
      </div>
    );
  }

  const src = `${VOICE_BOT_URL}/?field=${encodeURIComponent(field.id)}&lang=${lang}`;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">
            {t("voice.title")} — {field.name}
          </div>
          <div className="page-sub">{t("voice.sub")}</div>
        </div>
      </div>
      <Card
        className="col"
        style={{ flex: 1, minHeight: 560, padding: 0, overflow: "hidden", display: "flex" }}
      >
        <iframe
          title="Farmer voice bot"
          src={src}
          allow="microphone; autoplay"
          style={{ width: "100%", height: "100%", border: 0, minHeight: 560 }}
        />
      </Card>
      <div className="row" style={{ gap: 8, marginTop: 10, alignItems: "center" }}>
        <span className="faint">{t("voice.typeInstead")}</span>
        <Link className="btn btn-ghost btn-sm" to="/app/assistant">
          {t("nav.assistant")}
        </Link>
      </div>
    </div>
  );
}
