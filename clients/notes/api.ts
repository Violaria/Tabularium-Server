// Management API through the console's browser session (HttpOnly cookie plus CSRF token).

export interface User {
    id: string;
    username: string;
    role: string;
    mustChangePassword: boolean;
}
export interface Vault {
    id: string;
    name: string;
    state: string;
}
export interface IssuedDevice {
    id: string;
    username: string;
    password: string;
    expiresAt: number;
}

export class ApiError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message);
    }
}

let csrf = "";
/** The session's CSRF token, for calls made outside this module (shares). */
export const csrfToken = () => csrf;

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await window.fetch(`/api/v1${path}`, {
        method,
        credentials: "same-origin",
        headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new ApiError(response.status, data.error ?? `HTTP ${response.status}`);
    return data;
}

/** Restores the browser session; undefined when not logged in. */
export async function restoreSession() {
    try {
        const session = await api<{ user: User; csrf: string }>("/web-session");
        csrf = session.csrf;
        return session.user;
    } catch (error) {
        if (error instanceof ApiError && error.status === 401) return undefined;
        throw error;
    }
}
export async function login(username: string, password: string) {
    const session = await api<{ user: User; csrf: string }>("/web-session", "POST", { username, password });
    csrf = session.csrf;
    return session.user;
}
export async function logout() {
    await api("/web-session", "DELETE");
    csrf = "";
}
export const listVaults = () => api<Vault[]>("/vaults");
export const issueDevice = (vaultId: string, name: string) => api<IssuedDevice>(`/vaults/${vaultId}/devices`, "POST", { name });
/** Basic authorization with a device's sync credentials, for the gateway's device routes. */
export const basicAuth = (username: string, password: string) => `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${username}:${password}`)))}`;
/** Restarts the device's expiry; the secret stays the same. */
export async function renewDevice(authorization: string) {
    const response = await window.fetch("/api/v1/devices/current/renew", { method: "POST", headers: { authorization } });
    const data = (await response.json().catch(() => ({}))) as { expiresAt?: number; error?: string };
    if (!response.ok) throw new ApiError(response.status, data.error ?? `HTTP ${response.status}`);
    return data.expiresAt;
}
export const revokeDevice = (vaultId: string, deviceId: string) => api(`/vaults/${vaultId}/devices/${deviceId}`, "DELETE");
