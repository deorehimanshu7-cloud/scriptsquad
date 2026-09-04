import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { authApi, farmApi, getStoredUser, getToken, setStoredUser, setToken, streamEvents, systemApi } from "./api";
import type { FarmRecord, FieldRecord, ProviderMeta, SystemEvent, UserRecord } from "./types";

interface AppState {
  user: UserRecord | null;
  booting: boolean;
  farms: FarmRecord[];
  fields: FieldRecord[];
  activeFieldId: string | null;
  activeField: FieldRecord | null;
  providers: ProviderMeta[];
  events: SystemEvent[];
  live: boolean;
  setActiveField: (id: string | null) => void;
  refresh: () => void;
  refreshToken: number;
  login: (user: UserRecord, token: string) => void;
  logout: () => void;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserRecord | null>(getStoredUser());
  const [booting, setBooting] = useState(true);
  const [farms, setFarms] = useState<FarmRecord[]>([]);
  const [fields, setFields] = useState<FieldRecord[]>([]);
  const [activeFieldId, setActiveFieldId] = useState<string | null>(() => localStorage.getItem("agrifur_active_field"));
  const [providers, setProviders] = useState<ProviderMeta[]>([]);
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [refreshToken, setRefreshToken] = useState(0);
  const [live, setLive] = useState(false);
  const offRef = useRef<(() => void) | null>(null);

  const refresh = useCallback(() => setRefreshToken((t) => t + 1), []);

  const login = useCallback((u: UserRecord, token: string) => {
    setUser(u);
    setStoredUser(u);
    setToken(token);
    setRefreshToken((t) => t + 1);
  }, []);

  const logout = useCallback(() => {
    void authApi.logout().catch(() => undefined);
    setUser(null);
    setStoredUser(null);
    setToken(null);
    setActiveFieldId(null);
    localStorage.removeItem("agrifur_active_field");
  }, []);

  const setActiveField = useCallback((id: string | null) => {
    setActiveFieldId(id);
    if (id) localStorage.setItem("agrifur_active_field", id);
    else localStorage.removeItem("agrifur_active_field");
  }, []);

  // bootstrap: validate session, load farms/fields/providers
  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      if (!getToken()) {
        setBooting(false);
        return;
      }
      try {
        const [{ user: me }, farmsRes, fieldsRes, provRes] = await Promise.all([
          authApi.me(),
          farmApi.listFarms(),
          farmApi.listFields(),
          systemApi.providers(),
        ]);
        if (cancelled) return;
        setUser(me);
        setStoredUser(me);
        setFarms(farmsRes.farms);
        setFields(fieldsRes.fields);
        setProviders(provRes.providers);
      } catch {
        if (!cancelled) {
          setUser(null);
          setStoredUser(null);
          setToken(null);
        }
      } finally {
        if (!cancelled) setBooting(false);
      }
    };
    void boot();
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  // reload fields/farms/providers whenever refreshToken changes (after login/logout too)
  useEffect(() => {
    if (!getToken() || !user) return;
    let cancelled = false;
    void Promise.all([farmApi.listFarms(), farmApi.listFields(), systemApi.providers()])
      .then(([f, fl, p]) => {
        if (cancelled) return;
        setFarms(f.farms);
        setFields(fl.fields);
        setProviders(p.providers);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [refreshToken, user?.id]);

  const activeField = useMemo(() => fields.find((f) => f.id === activeFieldId) ?? null, [fields, activeFieldId]);

  // auto-select: once the user's fields are known, a stale/missing stored id
  // (previous user, deleted field, first login) must never leave the app stuck
  // on “select a field”. Fall back to the first owned field.
  useEffect(() => {
    if (booting || fields.length === 0) return;
    const valid = fields.some((f) => f.id === activeFieldId);
    if (!valid) setActiveField(fields[0].id);
  }, [booting, fields, activeFieldId, setActiveField]);

  // live SSE event stream (fetch-based, auth header supported). The stream is
  // created once per session (not per refresh) — sensor/heartbeat events bump
  // the refresh token so the open workspaces reload without a page refresh and
  // without re-subscribing the stream.
  useEffect(() => {
    if (!getToken() || !user) return;
    if (offRef.current) offRef.current();
    const off = streamEvents(
      (ev) => {
        setLive(true);
        setEvents((prev) => [ev, ...prev].slice(0, 200));
        if (
          ev.type === "PROVIDER_STATUS_CHANGED" ||
          ev.type === "SENSOR_TELEMETRY" ||
          ev.type === "DEVICE_HEARTBEAT" ||
          ev.type === "EVIDENCE_ADDED" ||
          ev.type === "WORLD_MODEL_UPDATED" ||
          ev.type === "RISK_UPDATED"
        ) {
          refresh();
        }
      },
      () => setLive(false),
    );
    offRef.current = off;
    return () => {
      off();
      offRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const value = useMemo<AppState>(
    () => ({
      user,
      booting,
      farms,
      fields,
      activeFieldId,
      activeField,
      providers,
      events,
      live,
      setActiveField,
      refresh,
      refreshToken,
      login,
      logout,
    }),
    [user, booting, farms, fields, activeFieldId, activeField, providers, events, live, setActiveField, refresh, refreshToken, login, logout],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}