import { useEffect, useState } from "react";
import { useApp } from "../../lib/state";
import { intelApi, toast } from "../../lib/api";
import { Spinner } from "../../components/ui";
import { RequireField } from "./AppLayout";
import { Investigations } from "./Intel";
import type { Investigation } from "../../lib/types";

export default function InvestigationsPage() {
  return (
    <RequireField>
      <Inner />
    </RequireField>
  );
}

function Inner() {
  const { activeField, refreshToken } = useApp();
  const field = activeField!;
  const [investigations, setInvestigations] = useState<Investigation[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLoaded(false);
    void intelApi
      .listInvestigations(field.id)
      .then((r) => setInvestigations(r.investigations))
      .catch(() => setInvestigations([]))
      .finally(() => setLoaded(true));
  }, [field.id, refreshToken]);

  const auto = async () => {
    try {
      const res = await intelApi.autoInvestigate(field.id);
      setInvestigations((prev) => [res.investigation, ...(prev ?? [])]);
      toast("Investigation opened from the most severe signal");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">Investigations — {field.name}</div>
          <div className="page-sub">
            Trigger → question → evidence collection → hypotheses → next best observation → conclusion → action →
            verification. Everything is grounded in this field's recorded evidence.
          </div>
        </div>
        <button className="btn btn-primary" onClick={auto} type="button">🔍 Auto-investigate</button>
      </div>

      {!loaded ? (
        <Spinner label="Loading investigations…" />
      ) : (
        <Investigations fieldId={field.id} investigations={investigations} setInvestigations={setInvestigations} />
      )}
    </div>
  );
}