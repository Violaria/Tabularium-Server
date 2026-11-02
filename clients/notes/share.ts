// Share calls from web notes, made with the browser's session (cookie and CSRF token) like the rest of the shell.
import { csrfToken } from "./api";
import type { ShareApi, ShareList, ShareView } from "@/features/tabularium/share/sharing";

async function call<T>(path: string, method = "GET", body?: unknown, binary?: Uint8Array): Promise<T> {
    const response = await window.fetch(`/api/v1/shares${path}`, {
        method,
        credentials: "same-origin",
        headers: { "content-type": binary ? "application/octet-stream" : "application/json", "x-csrf-token": csrfToken() },
        body: binary ? (binary as BlobPart as BodyInit) : body === undefined ? undefined : JSON.stringify(body),
    });
    const result = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    return result;
}
export const sessionShareApi: ShareApi = {
    list: () => call<ShareList>(""),
    create: (body) => call<ShareView>("", "POST", body),
    update: (id, body) => call<ShareView>(`/${id}`, "PATCH", body),
    upload: (id, bundle) => call<ShareView>(`/${id}/content`, "PUT", undefined, bundle),
    revoke: async (id) => {
        await call(`/${id}`, "DELETE");
    },
};
