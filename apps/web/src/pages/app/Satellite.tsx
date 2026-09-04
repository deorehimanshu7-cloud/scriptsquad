import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../../lib/state";
import { spaceApi, systemApi, toast } from "../../lib/api";
import { Badge, Card, EmptyState, Hint, ProviderBadge, Spinner, Stat } from "../../components/ui";
import { RequireField } from "./AppLayout";
import { fmtDate, fmtNum } from "../../lib/format";
import type { SatelliteProduct } from "../../lib/types";

export default function Satellite() {
  return (
    <RequireField>
      <SatelliteInner />
    </RequireField>
  );
}

function SatelliteInner() {
  const { activeField, refreshToken, refresh } = useApp();
  const field = activeField!;
  const [products, setProducts] = useState<SatelliteProduct[] | null>(null);
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof spaceApi.summary>>["summary"] | null>(null);
  const [running, setRunning] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [autoDiscovering, setAutoDiscovering] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);
  const autoRanFor = useRef<string | null>(null);

  const load = useCallback(() => {
    setAutoError(null);
    void spaceApi
      .products(field.id)
      .then((r) => {
        setProducts(r.products);
        // A field that has never been discovered shows an empty catalog even
        // though real acquisitions exist over its bbox. Auto-run one real,
        // idempotent STAC discovery per field visit (never fabricates — if the
        // provider truly has nothing, the empty state stays with the reason).
        if (r.products.length === 0 && autoRanFor.current !== field.id) {
          autoRanFor.current = field.id;
          setAutoDiscovering(true);
          void spaceApi
            .discover(field.id)
            .then(() => refresh())
            .catch(() => setAutoError("Automatic discovery could not reach the catalog — try Discover acquisitions."))
            .finally(() => setAutoDiscovering(false));
        }
      })
      .catch(() => setProducts([]));
    void spaceApi.summary(field.id).then((r) => setSummary(r.summary)).catch(() => undefined);
  }, [field.id, refresh]);

  useEffect(() => {
    setProducts(null);
    load();
  }, [load, refreshToken]);

  const discover = async () => {
    setRunning(true);
    try {
      const res = await spaceApi.discover(field.id);
      toast(`Discovery completed — ${res.total_products} product(s) recorded`);
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Discovery failed", "error");
    } finally {
      setRunning(false);
    }
  };

  const checkProvider = async () => {
    try {
      await systemApi.checkProviders();
      refresh();
      toast("Provider health checks completed");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Check failed", "error");
    }
  };

  if (!products) return <div className="page"><Spinner label="Querying satellite catalog…" /></div>;

  const provState = summary?.provider_status?.status ?? "NOT_CONFIGURED";

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">Satellite / Earth observation — {field.name}</div>
          <div className="page-sub">
            Real STAC discovery against provider catalogs. “Latest acquisition” means the newest product the provider
            actually has — not live imagery. Metadata is real; raster previews may require credentials.
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={checkProvider}>🔎 Check provider</button>
          <button className="btn btn-primary" onClick={discover} disabled={running || autoDiscovering}>
            {running || autoDiscovering ? <span className="spinner" /> : "🛰️"} Discover acquisitions
          </button>
        </div>
      </div>

      {autoDiscovering && <Hint warn>Running an automatic real catalog search over this field’s bbox — acquisitions may already exist but were never discovered for this field.</Hint>}
      {autoError && <Hint warn>{autoError}</Hint>}
      {summary?.note && <Hint warn>{summary.note}</Hint>}

      <div className="grid grid-4 mt-16">
        <Stat label="Total products" value={summary?.total ?? products.length} />
        <Stat label="Provider" value={<ProviderBadge state={provState} />} hint={summary?.provider_status?.auth_state ? `auth: ${summary.provider_status.auth_state}` : undefined} />
        <Stat label="Latest acquisition" value={summary?.latest_acquisition ? fmtDate(summary.latest_acquisition.acquired_at) : "none"} />
        <Stat label="Best qualified" value={summary?.best_qualified ? `${fmtNum(summary.best_qualified.cloud_cover ?? -1, 0)}% cloud` : "none"} hint={summary?.best_qualified?.satellite} />
      </div>

      <FusionSummary products={products} />

      {summary?.provider_status?.auth_state !== "configured" && (
        <Hint warn className="mt-16">
          <strong>Why are raster previews AUTH_REQUIRED?</strong> Sentinel product <em>metadata</em> (acquisition time,
          cloud cover, platform, product id, source URL) is real and free from the Copernicus STAC catalog. Downloading
          the actual <em>image rasters</em> goes through Copernicus Data Space OAuth. To unlock imagery on this field:
          register a free account at dataspace.copernicus.eu, create client credentials, then add{" "}
          <code>COPERNICUS_CLIENT_ID</code> and <code>COPERNICUS_CLIENT_SECRET</code> in Settings → Environment — no code
          change needed; previews activate automatically on the next discovery.
        </Hint>
      )}

      {products.length === 0 ? (
        <div className="mt-16">
          <EmptyState
            emoji="🛰️"
            title="No acquisitions discovered yet"
            body="Run discovery to search the Sentinel-2 catalog over this field's bbox for the last 30 days."
            action={<button className="btn btn-primary" onClick={discover} disabled={running}>Discover now</button>}
          />
        </div>
      ) : (
        <>
          <Card title={`Acquisition timeline (${products.length})`} className="mt-16">
            <div className="row" style={{ gap: 6, overflowX: "auto", paddingBottom: 6 }}>
              {products.map((p) => (
                <span
                  key={p.id}
                  title={`${p.satellite} · ${fmtDate(p.acquired_at)}${p.cloud_cover !== null ? ` · ${fmtNum(p.cloud_cover, 0)}% cloud` : ""}`}
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 7,
                    background: p.cloud_cover === null ? "var(--text-faint)" : p.cloud_cover < 20 ? "var(--accent)" : p.cloud_cover < 50 ? "var(--amber)" : "var(--red)",
                    opacity: 0.85,
                    flexShrink: 0,
                  }}
                />
              ))}
            </div>
            <div className="faint" style={{ fontSize: 11.5, marginTop: 4 }}>
              ▁ green &lt;20% cloud · amber 20–50% · red &gt;50% · gray unknown
            </div>
          </Card>

          <Card title="Discovered products" className="mt-16">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Satellite</th><th>Collection</th><th>Acquired</th><th>Cloud</th><th>Resolution</th><th>Level</th><th>State</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <ProductRows key={p.id} p={p} open={openId === p.id} onToggle={() => setOpenId(openId === p.id ? null : p.id)} />
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}

function FusionSummary({ products }: { products: SatelliteProduct[] }) {
  const byPlatform = new Map<string, number>();
  let optical = 0;
  let sar = 0;
  let cloudSum = 0;
  let cloudN = 0;
  for (const p of products) {
    const key = p.platform ?? p.satellite ?? "unknown";
    byPlatform.set(key, (byPlatform.get(key) ?? 0) + 1);
    const isSar = p.polarization && p.polarization.length > 0;
    if (isSar) sar++;
    else optical++;
    if (p.cloud_cover !== null && !isSar) {
      cloudSum += p.cloud_cover;
      cloudN++;
    }
  }
  const platforms = [...byPlatform.entries()]
    .map(([k, n]) => `${k}: ${n}`)
    .join("  ·  ");
  const meanCloud = cloudN > 0 ? Math.round((cloudSum / cloudN) * 10) / 10 : null;
  return (
    <Card title="Fused acquisition overview (real metadata)" className="mt-16">
      <div className="row" style={{ gap: 14, flexWrap: "wrap" }}>
        <span className="faint" style={{ fontSize: 12.5 }}>
          platforms: <strong style={{ color: "var(--text)" }}>{platforms || "—"}</strong>
        </span>
        <span className="faint" style={{ fontSize: 12.5 }}>
          optical: <strong style={{ color: "var(--text)" }}>{optical}</strong> · SAR (VV/VH):{" "}
          <strong style={{ color: "var(--text)" }}>{sar}</strong>
        </span>
        <span className="faint" style={{ fontSize: 12.5 }}>
          mean cloud cover (optical):{" "}
          <strong style={{ color: "var(--text)" }}>{meanCloud === null ? "—" : `${meanCloud}%`}</strong>
        </span>
      </div>
      <div className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>
        Fused across every provider catalog searched over this field — each row below keeps its own satellite, platform,
        acquisition time, cloud cover and source URL. Nothing here is simulated imagery.
      </div>
    </Card>
  );
}

function ProductRows({ p, open, onToggle }: { p: SatelliteProduct; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: "pointer" }}>
        <td className="mono">{p.satellite}</td>
        <td className="mono" style={{ fontSize: 12 }}>{p.collection ?? "—"}</td>
        <td className="nowrap">{fmtDate(p.acquired_at)}</td>
        <td>
          {p.cloud_cover !== null ? (
            <span className="row" style={{ gap: 5 }}>
              <span style={{ width: 8, height: 8, borderRadius: 50, background: p.cloud_cover < 20 ? "var(--accent)" : p.cloud_cover < 50 ? "var(--amber)" : "var(--red)", display: "inline-block" }} />
              {fmtNum(p.cloud_cover, 0)}%
            </span>
          ) : (
            <span className="faint">—</span>
          )}
        </td>
        <td>{p.resolution_m ? `${fmtNum(p.resolution_m, 0)} m` : "—"}</td>
        <td className="mono" style={{ fontSize: 12 }}>{p.processing_level ?? "—"}</td>
        <td><Badge className={`ps-${p.state === "OBSERVED" ? "AVAILABLE" : p.state}`}>{p.state}</Badge></td>
        <td><Badge className={`ps-${p.status === "auth_required" ? "AUTH_REQUIRED" : p.status === "failed" ? "PROVIDER_ERROR" : "AVAILABLE"}`}>{p.status}</Badge></td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8} style={{ background: "rgba(141,199,161,0.03)" }}>
            <div className="prov-line mb-8">product_id: {p.product_id}</div>
            <dl className="kv" style={{ gridTemplateColumns: "140px 1fr" }}>
              <dt>source URL</dt>
              <dd className="mono" style={{ fontSize: 11.5, wordBreak: "break-all" }}>{p.source_url ?? "—"}</dd>
              <dt>assets</dt>
              <dd>
                {p.assets.length === 0 ? (
                  <span className="faint">none accessible — raster access requires Copernicus OAuth (AUTH_REQUIRED)</span>
                ) : (
                  <div className="col" style={{ gap: 3 }}>
                    {p.assets.map((a, i) => (
                      <div key={i} className="prov-line">
                        {a.title} — <span style={{ wordBreak: "break-all" }}>{a.href}</span>
                        {a.credential_gated && " · requires OAuth"}
                      </div>
                    ))}
                  </div>
                )}
              </dd>
              <dt>platform / product type</dt>
              <dd className="mono" style={{ fontSize: 11.5 }}>{p.platform ?? "—"} · {p.product_type ?? "—"}{p.polarization ? ` · ${p.polarization}` : ""}</dd>
              <dt>footprint</dt>
              <dd className="mono" style={{ fontSize: 11.5 }}>{JSON.stringify(p.geometry ?? null).slice(0, 200)}</dd>
              <dt>field intersection</dt>
              <dd>{p.field_intersection_pct != null ? `${fmtNum(p.field_intersection_pct, 0)}% of footprint covers the field` : "—"}</dd>
              <dt>recorded</dt><dd>{fmtDate(p.created_at)}</dd>
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}